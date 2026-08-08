/**
 * CHUNK-0 regression tests for the authentication provider state machine.
 *
 * Purpose: Demonstrate false-anonymous outcomes, stale session commits,
 * missing cancellation, and ambiguous logout handling in the legacy provider.
 * Connects to: src/client/contexts/AuthContext.js and the frozen v2 fixtures.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { act } = require('react');
const { createRoot } = require('react-dom/client');

const {
  SESSION_RESPONSE_FIXTURES,
  SIGNOUT_RESPONSE_FIXTURES,
} = require('../../../testSupport/authV2ContractFixtures.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../../lib/supabaseBrowser.js', () => ({
  supabaseBrowser: {
    auth: {
      signInWithOAuth: jest.fn(),
    },
  },
}));

const { AuthProvider, useAuth } = require('../AuthContext.js');

let container;
let root;
let latestAuth;

/**
 * Creates a manually controlled promise for request-order regression tests.
 *
 * @returns {{promise: Promise, resolve: Function, reject: Function}} Deferred controls.
 */
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

/**
 * Builds the minimal Fetch response surface consumed by AuthContext.
 *
 * @param {object} body - Parsed JSON body returned by the response.
 * @param {number} status - HTTP status exposed to the caller.
 * @returns {object} Fetch-compatible response double.
 */
function createJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

/**
 * Mocks both legacy and future session URLs while controlling the logout result.
 *
 * Purpose: Keep sign-out assertions focused on logout behavior during the v1
 * to v2 migration instead of failing because an unrelated CSRF prime consumed
 * a sequential mock.
 *
 * @param {Function} signoutRequest - Factory returning the sign-out fetch result.
 * @returns {void}
 */
function mockAuthenticatedSessionFlow(signoutRequest) {
  global.fetch.mockImplementation((url) => {
    if (url === '/api/auth/v2/signout' || url === '/api/auth/signout') {
      return signoutRequest();
    }
    if (url === '/api/auth/csrf') {
      return Promise.resolve(createJsonResponse({ data: null }));
    }
    if (url === '/api/auth/v2/session') {
      return Promise.resolve(createJsonResponse({
        ...SESSION_RESPONSE_FIXTURES.authenticated.body,
        user: {
          ...SESSION_RESPONSE_FIXTURES.authenticated.body.user,
          id: '00000000-0000-4000-8000-000000000002',
        },
      }));
    }

    return Promise.resolve(createJsonResponse({
      data: { user: { id: 'active-subject', email: null, role: 'user' } },
    }));
  });
}

/**
 * Starts authenticated on either session URL, then delegates the visibility
 * refresh to a caller-controlled outage response.
 *
 * Purpose: Let the same regression exercise the legacy endpoint today and the
 * strict v2 endpoint later without accepting a mixed legacy/v2 body.
 *
 * @param {Function} backgroundRequest - Factory for the second session check.
 * @returns {void}
 */
function mockAuthenticatedThenBackgroundRequest(backgroundRequest) {
  let sessionRequestCount = 0;

  global.fetch.mockImplementation((url) => {
    if (url === '/api/auth/csrf') {
      return Promise.resolve(createJsonResponse({ data: null }));
    }

    if (url === '/api/auth/session' || url === '/api/auth/v2/session') {
      sessionRequestCount += 1;
      if (sessionRequestCount > 1) {
        return backgroundRequest();
      }

      if (url === '/api/auth/v2/session') {
        return Promise.resolve(createJsonResponse(
          SESSION_RESPONSE_FIXTURES.authenticated.body,
          SESSION_RESPONSE_FIXTURES.authenticated.httpStatus
        ));
      }

      return Promise.resolve(createJsonResponse({
        data: { user: { id: 'active-subject', email: null, role: 'user' } },
      }));
    }

    return Promise.resolve(createJsonResponse({ data: null }));
  });
}

/**
 * Captures the live context value without adding application behavior.
 *
 * @returns {JSX.Element} Non-sensitive state marker.
 */
function AuthProbe() {
  latestAuth = useAuth();
  return React.createElement('div', {
    'data-testid': 'auth-state',
    'data-status': latestAuth.authStatus,
    'data-user': latestAuth.user?.id ?? '',
  });
}

/**
 * Mounts AuthProvider and its probe into an isolated jsdom root.
 *
 * @returns {void}
 */
function renderProvider() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root.render(React.createElement(AuthProvider, null, React.createElement(AuthProbe)));
  });
}

/**
 * Flushes already-settled promise callbacks through React state updates.
 *
 * @returns {Promise<void>} Promise resolved after queued microtasks.
 */
async function flushAsyncState() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Removes the mounted provider and restores per-test browser state.
 *
 * @returns {void}
 */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  latestAuth = undefined;
}

beforeEach(() => {
  global.fetch = jest.fn();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('AuthProvider v2 session outcomes', () => {
  it.each([
    ['route 429', SESSION_RESPONSE_FIXTURES.rateLimited],
    ['service 503', SESSION_RESPONSE_FIXTURES.unavailable],
  ])('keeps %s as unavailable instead of false anonymity', async (_name, fixture) => {
    global.fetch.mockResolvedValue(createJsonResponse(fixture.body, fixture.httpStatus));

    renderProvider();
    await flushAsyncState();

    expect(global.fetch).toHaveBeenCalledWith('/api/auth/v2/session', expect.objectContaining({
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    }));
    expect(latestAuth.authStatus).toBe('unavailable');
    expect(latestAuth.user).toBeNull();
    expect(latestAuth.loading).toBe(false);
  });

  it('treats invalid JSON as unavailable instead of anonymous', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockRejectedValue(new SyntaxError('invalid JSON')),
    });

    renderProvider();
    await flushAsyncState();

    expect(latestAuth.authStatus).toBe('unavailable');
    expect(latestAuth.user).toBeNull();
  });

  it('treats network rejection as unavailable instead of anonymous', async () => {
    global.fetch.mockRejectedValue(new TypeError('network unavailable'));

    renderProvider();
    await flushAsyncState();

    expect(latestAuth.authStatus).toBe('unavailable');
    expect(latestAuth.user).toBeNull();
  });

  it('rejects a legacy session envelope at the v2 client boundary', async () => {
    global.fetch.mockResolvedValue(createJsonResponse({
      data: { user: null },
      error: null,
    }));

    renderProvider();
    await flushAsyncState();

    expect(latestAuth.authStatus).toBe('unavailable');
  });

  it('exposes the approved terminal state without treating it as sign-in-ready anonymity', async () => {
    const fixture = SESSION_RESPONSE_FIXTURES.terminalUserBanned;
    global.fetch.mockResolvedValue(createJsonResponse(fixture.body, fixture.httpStatus));

    renderProvider();
    await flushAsyncState();

    expect(latestAuth.authStatus).toBe('terminal_unauthenticated');
    expect(latestAuth.isAuthenticated).toBe(false);
    expect(latestAuth.canPerformUserWork).toBe(false);
  });
});

describe('AuthProvider request ordering and cancellation', () => {
  it.each([
    ['route 429', () => Promise.resolve(createJsonResponse(
      SESSION_RESPONSE_FIXTURES.rateLimited.body,
      SESSION_RESPONSE_FIXTURES.rateLimited.httpStatus
    ))],
    ['service 503', () => Promise.resolve(createJsonResponse(
      SESSION_RESPONSE_FIXTURES.unavailable.body,
      SESSION_RESPONSE_FIXTURES.unavailable.httpStatus
    ))],
    ['invalid JSON', () => Promise.resolve({
      ok: true,
      status: 200,
      json: jest.fn().mockRejectedValue(new SyntaxError('invalid JSON')),
    })],
    ['network rejection', () => Promise.reject(new TypeError('network unavailable'))],
  ])('contains background %s as unavailable after authentication', async (_name, request) => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(60_000);
    mockAuthenticatedThenBackgroundRequest(request);

    renderProvider();
    await flushAsyncState();

    nowSpy.mockReturnValue(90_001);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flushAsyncState();

    expect(latestAuth.authStatus).toBe('unavailable');
    expect(latestAuth.canPerformUserWork).toBe(false);
    expect(latestAuth.user).toBeNull();
  });

  it('allows only the newest overlapping session generation to commit', async () => {
    const older = createDeferred();
    const newer = createDeferred();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(60_000);

    global.fetch
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
      .mockResolvedValue(createJsonResponse({ data: null }));

    renderProvider();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    newer.resolve(createJsonResponse({
      data: { user: { id: 'newer-subject', email: null, role: 'user' } },
    }));
    await flushAsyncState();

    older.resolve(createJsonResponse({
      data: { user: { id: 'older-subject', email: null, role: 'user' } },
    }));
    await flushAsyncState();

    expect(latestAuth.user?.id).toBe('newer-subject');
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);

    nowSpy.mockRestore();
  });

  it('aborts an in-flight session request when the provider unmounts', () => {
    const request = createDeferred();
    global.fetch.mockReturnValue(request.promise);

    renderProvider();
    const requestSignal = global.fetch.mock.calls[0][1].signal;
    cleanup();

    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal.aborted).toBe(true);
  });

  it('removes the visibility listener when the provider unmounts', () => {
    const addSpy = jest.spyOn(document, 'addEventListener');
    const removeSpy = jest.spyOn(document, 'removeEventListener');
    global.fetch.mockResolvedValue(createJsonResponse({ data: { user: null } }));

    renderProvider();
    const visibilityRegistration = addSpy.mock.calls.find(([name]) => (
      name === 'visibilitychange'
    ));
    cleanup();

    expect(visibilityRegistration).toBeDefined();
    expect(removeSpy).toHaveBeenCalledWith(
      'visibilitychange',
      visibilityRegistration[1]
    );
  });
});

describe('AuthProvider truthful sign-out outcomes', () => {
  it('enters logout_unconfirmed and preserves retry after a network-ambiguous sign-out', async () => {
    mockAuthenticatedSessionFlow(() => Promise.reject(new TypeError('network unavailable')));

    renderProvider();
    await flushAsyncState();

    let result;
    await act(async () => {
      result = await latestAuth.signOut();
    });

    expect(global.fetch).toHaveBeenLastCalledWith('/api/auth/v2/signout', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: expect.objectContaining({ 'X-Logout-Intent': '1' }),
    }));
    expect(result.status).toBe('logout_unconfirmed');
    expect(latestAuth.authStatus).toBe('logout_unconfirmed');
    expect(latestAuth.canRetryLogout).toBe(true);
  });

  it.each([
    ['complete', SIGNOUT_RESPONSE_FIXTURES.completeConfirmed],
    ['local-only', SIGNOUT_RESPONSE_FIXTURES.localOnly],
  ])('enters signed_out_local after a schema-valid %s response', async (_name, fixture) => {
    mockAuthenticatedSessionFlow(() => Promise.resolve(
      createJsonResponse(fixture.body, fixture.httpStatus)
    ));

    renderProvider();
    await flushAsyncState();

    await act(async () => {
      await latestAuth.signOut();
    });

    expect(latestAuth.authStatus).toBe('signed_out_local');
    expect(latestAuth.user).toBeNull();
  });

  it('keeps duplicate logout actions to one in-flight request', async () => {
    const logoutRequest = createDeferred();
    mockAuthenticatedSessionFlow(() => logoutRequest.promise);

    renderProvider();
    await flushAsyncState();

    let first;
    let second;
    act(() => {
      first = latestAuth.signOut();
      second = latestAuth.signOut();
    });

    logoutRequest.resolve(createJsonResponse(SIGNOUT_RESPONSE_FIXTURES.completeNotNeeded.body));
    await act(async () => Promise.all([first, second]));

    const signoutCalls = global.fetch.mock.calls.filter(([url]) => (
      url === '/api/auth/v2/signout' || url === '/api/auth/signout'
    ));

    expect(first).toBe(second);
    expect(signoutCalls).toHaveLength(1);
  });
});
