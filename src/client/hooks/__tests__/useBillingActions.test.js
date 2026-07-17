/**
 * Tests for shared Checkout and Billing Portal action orchestration.
 *
 * @jest-environment jsdom
 */

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { ERROR_MESSAGES } = require('../../../shared/errors.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockApiPost = jest.fn();
const mockNavigate = jest.fn();
const mockRandomUUID = jest.fn();

jest.mock('../../lib/api.js', () => ({
  api: {
    post: (...args) => mockApiPost(...args),
  },
}));

let useBillingActions;
let BILLING_ACTION_RESULT_STATUSES;
let latestHook;
let container;
let root;
const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

const UUID_ONE = '01234567-89ab-cdef-0123-456789abcdef';
const UUID_TWO = 'fedcba98-7654-3210-fedc-ba9876543210';
const NONCE_ONE = '0123456789abcdef0123456789abcdef';
const NONCE_TWO = 'fedcba9876543210fedcba9876543210';

/**
 * Store the latest hook result so tests can invoke actions directly.
 *
 * @param {{ navigate?: Function }} props - Optional navigation dependency.
 * @returns {React.ReactElement} Minimal rendered state marker.
 */
function HookHarness({ navigate = mockNavigate }) {
  latestHook = useBillingActions({ navigate });

  return React.createElement(
    'div',
    null,
    `${latestHook.actionLoading || 'idle'}:${latestHook.retryAfterSeconds ?? 'ready'}`
  );
}

/**
 * Render the hook in the repository's dependency-free React test harness.
 *
 * @param {Function} [navigate] - Optional navigation implementation.
 * @returns {Promise<void>}
 */
async function renderHook(navigate = mockNavigate) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(HookHarness, { navigate }));
  });
}

/**
 * Invoke one async hook method and flush its React state updates.
 *
 * @param {string} method - Public hook method name.
 * @param  {...unknown} args - Method arguments.
 * @returns {Promise<object>} Typed action result.
 */
async function callHook(method, ...args) {
  let result;

  await act(async () => {
    result = await latestHook[method](...args);
  });

  return result;
}

/**
 * Build a successful server redirect response.
 *
 * @param {string} url - Allowlisted Stripe redirect URL.
 * @returns {object} Shared-client result fixture.
 */
function buildRedirectSuccess(url = 'https://checkout.stripe.com/session_123') {
  return {
    data: { data: { url }, error: null },
    error: null,
    meta: { status: 200, retryAfterSeconds: null },
  };
}

/**
 * Build one standardized API error response.
 *
 * @param {string} code - Server response error code.
 * @param {number} status - HTTP response status.
 * @param {number|null} [retryAfterSeconds] - Optional Retry-After value.
 * @returns {object} Shared-client result fixture.
 */
function buildApiError(code, status, retryAfterSeconds = null) {
  return {
    data: { error: code, message: 'raw response payload' },
    error: null,
    meta: { status, retryAfterSeconds },
  };
}

/**
 * Create a controllable promise for synchronous duplicate-action tests.
 *
 * @returns {{ promise: Promise<object>, resolve: Function }} Deferred handle.
 */
function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Remove the active hook root and restore test globals. */
function cleanup() {
  if (root) {
    act(() => root.unmount());
  }
  if (container?.parentNode) {
    document.body.removeChild(container);
  }
  root = null;
  container = null;
  latestHook = null;
}

describe('useBillingActions', () => {
  beforeAll(() => {
    ({ useBillingActions, BILLING_ACTION_RESULT_STATUSES } = require('../useBillingActions.js'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRandomUUID.mockReturnValue(UUID_ONE);
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: mockRandomUUID },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  afterAll(() => {
    if (originalCryptoDescriptor) {
      Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    } else {
      delete globalThis.crypto;
    }
  });

  it('does not POST when secure nonce generation is unavailable', async () => {
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    await renderHook();

    const result = await callHook('startCheckout', 'premium_monthly');

    expect(result).toEqual({
      status: BILLING_ACTION_RESULT_STATUSES.ERROR,
      error: {
        code: 'CHECKOUT_NONCE_UNAVAILABLE',
        message: ERROR_MESSAGES.CHECKOUT_SESSION_FAILED,
        httpStatus: null,
        retryAfterSeconds: null,
      },
    });
    expect(mockApiPost).not.toHaveBeenCalled();
    expect(latestHook.actionLoading).toBe('');
  });

  it('ignores rapid duplicate Checkout calls before the first await settles', async () => {
    const deferred = createDeferred();
    mockApiPost.mockReturnValue(deferred.promise);
    await renderHook();

    let firstPromise;
    let duplicatePromise;
    act(() => {
      firstPromise = latestHook.startCheckout('premium_monthly');
      duplicatePromise = latestHook.startCheckout('premium_monthly');
    });

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith('/api/billing/checkout', {
      plan: 'premium_monthly',
      checkoutAttemptNonce: NONCE_ONE,
    });
    await expect(duplicatePromise).resolves.toEqual({
      status: BILLING_ACTION_RESULT_STATUSES.IGNORED,
      error: null,
    });

    await act(async () => {
      deferred.resolve(buildRedirectSuccess());
      await firstPromise;
    });
  });

  it.each([
    ['Checkout then portal', 'startCheckout', ['premium_monthly'], 'openPortal', []],
    ['portal then Checkout', 'openPortal', [], 'startCheckout', ['premium_monthly']],
  ])('shares one synchronous latch for %s', async (_label, firstMethod, firstArgs, secondMethod, secondArgs) => {
    const deferred = createDeferred();
    mockApiPost.mockReturnValue(deferred.promise);
    await renderHook();

    let firstPromise;
    let secondPromise;
    act(() => {
      firstPromise = latestHook[firstMethod](...firstArgs);
      secondPromise = latestHook[secondMethod](...secondArgs);
    });

    await expect(secondPromise).resolves.toEqual({
      status: BILLING_ACTION_RESULT_STATUSES.IGNORED,
      error: null,
    });
    expect(mockApiPost).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve(buildRedirectSuccess(
        firstMethod === 'openPortal'
          ? 'https://billing.stripe.com/session_123'
          : 'https://checkout.stripe.com/session_123'
      ));
      await firstPromise;
    });
  });

  it('releases a failed action and generates a fresh nonce for retry', async () => {
    mockRandomUUID
      .mockReturnValueOnce(UUID_ONE)
      .mockReturnValueOnce(UUID_TWO);
    mockApiPost
      .mockResolvedValueOnce({
        data: null,
        error: ERROR_MESSAGES.FETCH_FAILED,
        meta: { status: null, retryAfterSeconds: null },
      })
      .mockResolvedValueOnce(buildRedirectSuccess());
    await renderHook();

    expect((await callHook('startCheckout', 'premium_monthly')).status)
      .toBe(BILLING_ACTION_RESULT_STATUSES.ERROR);
    expect((await callHook('startCheckout', 'premium_monthly')).status)
      .toBe(BILLING_ACTION_RESULT_STATUSES.REDIRECTING);

    expect(mockApiPost).toHaveBeenNthCalledWith(1, '/api/billing/checkout', {
      plan: 'premium_monthly',
      checkoutAttemptNonce: NONCE_ONE,
    });
    expect(mockApiPost).toHaveBeenNthCalledWith(2, '/api/billing/checkout', {
      plan: 'premium_monthly',
      checkoutAttemptNonce: NONCE_TWO,
    });
  });

  it('keeps the latch set after successful navigation handoff', async () => {
    mockApiPost.mockResolvedValue(buildRedirectSuccess());
    await renderHook();

    expect((await callHook('startCheckout', 'premium_monthly')).status)
      .toBe(BILLING_ACTION_RESULT_STATUSES.REDIRECTING);
    act(() => latestHook.resetActionState());
    expect(await callHook('openPortal')).toEqual({
      status: BILLING_ACTION_RESULT_STATUSES.IGNORED,
      error: null,
    });
    expect(latestHook.actionLoading).toBe('checkout');
    expect(mockApiPost).toHaveBeenCalledTimes(1);
  });

  it('does not navigate when an in-flight request resolves after unmount', async () => {
    const deferred = createDeferred();
    mockApiPost.mockReturnValue(deferred.promise);
    await renderHook();

    let actionPromise;
    act(() => {
      actionPromise = latestHook.startCheckout('premium_monthly');
    });

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    cleanup();
    deferred.resolve(buildRedirectSuccess());

    await expect(actionPromise).resolves.toEqual({
      status: BILLING_ACTION_RESULT_STATUSES.IGNORED,
      error: null,
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it.each([
    ['unauthorized', {
      data: null,
      error: ERROR_MESSAGES.UNAUTHORIZED,
      meta: { status: 401, retryAfterSeconds: null },
    }, 'UNAUTHORIZED', ERROR_MESSAGES.UNAUTHORIZED, 401],
    ['csrf', buildApiError('CSRF_VALIDATION_FAILED', 403), 'CSRF_VALIDATION_FAILED', ERROR_MESSAGES.CSRF_VALIDATION_FAILED, 403],
    ['changed billing state', buildApiError('CHECKOUT_SESSION_FAILED', 409), 'CHECKOUT_SESSION_FAILED', 'Your billing status changed. Review billing before continuing.', 409],
    ['disabled Checkout', buildApiError('BILLING_CHECKOUT_DISABLED', 503), 'BILLING_CHECKOUT_DISABLED', ERROR_MESSAGES.BILLING_CHECKOUT_DISABLED, 503],
    ['service unavailable', buildApiError('SERVICE_UNAVAILABLE', 503), 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE, 503],
    ['generic Checkout failure', buildApiError('CHECKOUT_SESSION_FAILED', 503), 'CHECKOUT_SESSION_FAILED', ERROR_MESSAGES.CHECKOUT_SESSION_FAILED, 503],
    ['unsafe URL', buildRedirectSuccess('https://evil.example.test/session_123'), null, 'Checkout did not return a redirect URL.', 200],
  ])('returns the expected structured outcome for %s', async (_label, response, code, message, httpStatus) => {
    mockApiPost.mockResolvedValue(response);
    await renderHook();

    const result = await callHook('startCheckout', 'premium_monthly');

    expect(result).toEqual({
      status: BILLING_ACTION_RESULT_STATUSES.ERROR,
      error: { code, message, httpStatus, retryAfterSeconds: null },
    });
    expect(latestHook.actionError).toEqual(result.error);
    expect(latestHook.actionLoading).toBe('');
  });

  it.each([
    ['unauthorized', {
      data: null,
      error: ERROR_MESSAGES.UNAUTHORIZED,
      meta: { status: 401, retryAfterSeconds: null },
    }, 'UNAUTHORIZED', ERROR_MESSAGES.UNAUTHORIZED, 401, null],
    [
      'generic portal failure',
      buildApiError('PORTAL_SESSION_FAILED', 503),
      'PORTAL_SESSION_FAILED',
      ERROR_MESSAGES.PORTAL_SESSION_FAILED,
      503,
      null,
    ],
    [
      'rate limit',
      buildApiError('RATE_LIMIT_EXCEEDED', 429, 5),
      'RATE_LIMIT_EXCEEDED',
      ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
      429,
      5,
    ],
    [
      'unsafe URL',
      buildRedirectSuccess('https://evil.example.test/session_123'),
      null,
      'Billing portal did not return a redirect URL.',
      200,
      null,
    ],
  ])('returns the expected portal outcome for %s', async (
    _label,
    response,
    code,
    message,
    httpStatus,
    retryAfterSeconds
  ) => {
    mockApiPost.mockResolvedValue(response);
    await renderHook();

    const result = await callHook('openPortal');

    expect(result).toEqual({
      status: BILLING_ACTION_RESULT_STATUSES.ERROR,
      error: { code, message, httpStatus, retryAfterSeconds },
    });
    expect(latestHook.actionError).toEqual(result.error);
    expect(latestHook.actionLoading).toBe('');
    expect(latestHook.retryAfterSeconds).toBe(retryAfterSeconds);
    expect(mockApiPost).toHaveBeenCalledWith('/api/billing/portal', {});
  });

  it('returns portal-specific copy when portal navigation fails', async () => {
    mockApiPost.mockResolvedValue(buildRedirectSuccess(
      'https://billing.stripe.com/session_123'
    ));
    await renderHook(() => {
      throw new Error('raw navigation failure');
    });

    const result = await callHook('openPortal');

    expect(result.error).toEqual({
      code: null,
      message: 'Billing portal redirect failed. Please try again.',
      httpStatus: 200,
      retryAfterSeconds: null,
    });
    expect(latestHook.actionLoading).toBe('');
    expect((await callHook('openPortal')).status)
      .toBe(BILLING_ACTION_RESULT_STATUSES.ERROR);
    expect(mockApiPost).toHaveBeenCalledTimes(2);
  });

  it('returns a structured navigation failure and releases the latch', async () => {
    mockApiPost.mockResolvedValue(buildRedirectSuccess());
    await renderHook(() => {
      throw new Error('raw navigation failure');
    });

    const result = await callHook('startCheckout', 'premium_monthly');

    expect(result.error).toEqual({
      code: null,
      message: 'Checkout redirect failed. Please try again.',
      httpStatus: 200,
      retryAfterSeconds: null,
    });
    expect(latestHook.actionLoading).toBe('');
    expect((await callHook('startCheckout', 'premium_monthly')).status)
      .toBe(BILLING_ACTION_RESULT_STATUSES.ERROR);
    expect(mockApiPost).toHaveBeenCalledTimes(2);
  });

  it('preserves and counts down a live 429 cooldown across reset with timer cleanup', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-17T12:00:00.000Z'));
    mockApiPost
      .mockResolvedValueOnce(buildApiError('RATE_LIMIT_EXCEEDED', 429, 3))
      .mockResolvedValueOnce(buildRedirectSuccess());
    await renderHook();

    const rateLimited = await callHook('startCheckout', 'premium_monthly');
    expect(rateLimited.error).toEqual({
      code: 'RATE_LIMIT_EXCEEDED',
      message: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
      httpStatus: 429,
      retryAfterSeconds: 3,
    });
    expect(latestHook.retryAfterSeconds).toBe(3);

    act(() => latestHook.resetActionState());
    expect(latestHook.actionError).toBeNull();
    expect(latestHook.retryAfterSeconds).toBe(3);
    expect((await callHook('openPortal')).status).toBe(BILLING_ACTION_RESULT_STATUSES.IGNORED);

    await act(async () => {
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(latestHook.retryAfterSeconds).toBe(1);

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(latestHook.retryAfterSeconds).toBeNull();
    expect((await callHook('startCheckout', 'premium_monthly')).status)
      .toBe(BILLING_ACTION_RESULT_STATUSES.REDIRECTING);

    cleanup();
    expect(jest.getTimerCount()).toBe(0);
  });
});
