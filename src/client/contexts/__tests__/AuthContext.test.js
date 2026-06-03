/**
 * @jest-environment jsdom
 */

/**
 * Tests for AuthContext
 *
 * Purpose: Verify session refresh behavior around temporary /api/auth/session
 * failures so rate-limit or Redis unavailability responses do not look like a
 * confirmed sign-out in the client.
 *
 * Connects to:
 * - src/client/contexts/AuthContext.js
 */

import React, { useEffect, act } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth } from '../AuthContext';

jest.mock('../../lib/supabaseBrowser.js', () => ({
  supabaseBrowser: {
    auth: {
      signInWithOAuth: jest.fn(),
    },
  },
}));

/**
 * Test component that reports the current auth context value.
 *
 * Purpose: expose AuthProvider state transitions without adding test-only
 * exports to the production context module.
 *
 * @param {object} props
 * @param {(value: object) => void} props.onValue - Receives each context value
 * @returns {JSX.Element}
 */
function AuthHarness({ onValue }) {
  const value = useAuth();

  useEffect(() => {
    onValue(value);
  }, [onValue, value]);

  return (
    <div
      data-user={value.user?.id || ''}
      data-loading={String(value.loading)}
      data-session-error={value.sessionError?.code || ''}
    />
  );
}

/**
 * Builds a mock fetch Response-like object for AuthContext tests.
 *
 * Purpose: keep fetch mocks compact while preserving the fields that
 * fetchSessionUser() depends on.
 *
 * @param {number} status - HTTP status
 * @param {object} body - JSON body
 * @param {object} headers - Response headers keyed by name
 * @returns {object} Minimal response object
 */
function mockJsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: jest.fn((name) => headers[name] ?? headers[name?.toLowerCase?.()] ?? null),
    },
    json: jest.fn().mockResolvedValue(body),
  };
}

/**
 * Creates a manually resolvable promise for ordering-sensitive tests.
 *
 * Purpose: allow tests to prove stale session responses cannot overwrite newer
 * auth state without adding test-only exports to AuthContext.
 *
 * @returns {{ promise: Promise, resolve: Function }}
 */
function createDeferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('AuthContext', () => {
  let container;
  let root;
  let now;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.restoreAllMocks();
    jest.useRealTimers();
    delete global.fetch;
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  /**
   * Background session failures should preserve a previously known user.
   */
  it.each([
    [429, 'RATE_LIMIT_EXCEEDED'],
    [503, 'SERVICE_UNAVAILABLE'],
  ])('preserves the current user when session refresh returns %s', async (status, errorCode) => {
    const values = [];
    const sessionResponses = [
      mockJsonResponse(200, {
        data: { user: { id: 'user-1', email: 'test@example.com' } },
        error: null,
      }),
      mockJsonResponse(status, {
        data: null,
        error: errorCode,
      }),
    ];

    global.fetch = jest.fn((url) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(sessionResponses.shift());
      }

      return Promise.resolve(mockJsonResponse(200, { data: null, error: null }));
    });

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthHarness onValue={(value) => values.push(value)} />
        </AuthProvider>
      );
    });

    expect(values.at(-1).user).toEqual({ id: 'user-1', email: 'test@example.com' });
    expect(values.at(-1).loading).toBe(false);

    now += 31_000;

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/auth/session', { credentials: 'same-origin' });
    expect(values.at(-1).user).toEqual({ id: 'user-1', email: 'test@example.com' });
    expect(values.at(-1).loading).toBe(false);
  });

  /**
   * Initial unknown session state should not publish a confirmed sign-out.
   */
  it('keeps auth loading when the initial session check is temporarily unavailable', async () => {
    const values = [];

    global.fetch = jest.fn((url) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(mockJsonResponse(503, {
          data: null,
          error: 'SERVICE_UNAVAILABLE',
        }));
      }

      return Promise.resolve(mockJsonResponse(200, { data: null, error: null }));
    });

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthHarness onValue={(value) => values.push(value)} />
        </AuthProvider>
      );
    });

    expect(values.at(-1).user).toBeNull();
    expect(values.at(-1).loading).toBe(true);
    expect(values.at(-1).sessionError).toBeNull();
  });

  /**
   * Recovery from an initial unknown state should clear the loading gate.
   */
  it('clears auth loading when visibility recovery returns a user after initial 429', async () => {
    const values = [];
    const sessionResponses = [
      mockJsonResponse(429, {
        data: null,
        error: 'RATE_LIMIT_EXCEEDED',
      }, { 'Retry-After': '1800' }),
      mockJsonResponse(200, {
        data: { user: { id: 'user-recovered', email: 'recovered@example.com' } },
        error: null,
      }),
    ];

    global.fetch = jest.fn((url) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(sessionResponses.shift());
      }

      return Promise.resolve(mockJsonResponse(200, { data: null, error: null }));
    });

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthHarness onValue={(value) => values.push(value)} />
        </AuthProvider>
      );
    });

    expect(values.at(-1).user).toBeNull();
    expect(values.at(-1).loading).toBe(true);

    now += 31_000;

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(values.at(-1).user).toEqual({ id: 'user-recovered', email: 'recovered@example.com' });
    expect(values.at(-1).loading).toBe(false);
  });

  /**
   * A confirmed null session is also a terminal known state after recovery.
   */
  it('clears auth loading when visibility recovery returns no user', async () => {
    const values = [];
    const sessionResponses = [
      mockJsonResponse(429, { data: null, error: 'RATE_LIMIT_EXCEEDED' }),
      mockJsonResponse(200, { data: { user: null }, error: null }),
    ];

    global.fetch = jest.fn((url) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(sessionResponses.shift());
      }

      return Promise.resolve(mockJsonResponse(200, { data: null, error: null }));
    });

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthHarness onValue={(value) => values.push(value)} />
        </AuthProvider>
      );
    });

    now += 31_000;

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(values.at(-1).user).toBeNull();
    expect(values.at(-1).loading).toBe(false);
  });

  /**
   * Initial 503s may retry briefly because they do not represent active cooldown.
   */
  it('retries an initial 503 once and clears loading when retry succeeds', async () => {
    jest.useFakeTimers({ doNotFake: ['Date'] });
    const values = [];
    const sessionResponses = [
      mockJsonResponse(503, {
        data: null,
        error: 'SERVICE_UNAVAILABLE',
      }),
      mockJsonResponse(200, {
        data: { user: { id: 'user-retry', email: 'retry@example.com' } },
        error: null,
      }),
    ];

    global.fetch = jest.fn((url) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(sessionResponses.shift());
      }

      return Promise.resolve(mockJsonResponse(200, { data: null, error: null }));
    });

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthHarness onValue={(value) => values.push(value)} />
        </AuthProvider>
      );
    });

    expect(values.at(-1).loading).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    await act(async () => {});

    const sessionFetchCount = global.fetch.mock.calls.filter(([url]) => url === '/api/auth/session').length;
    expect(sessionFetchCount).toBe(2);
    expect(values.at(-1).user).toEqual({ id: 'user-retry', email: 'retry@example.com' });
    expect(values.at(-1).loading).toBe(false);
  });

  /**
   * 429 cooldown responses should not be retried automatically.
   */
  it('does not automatically retry an initial 429 session response', async () => {
    jest.useFakeTimers({ doNotFake: ['Date'] });
    const values = [];

    global.fetch = jest.fn((url) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(mockJsonResponse(429, {
          data: null,
          error: 'RATE_LIMIT_EXCEEDED',
        }, { 'Retry-After': '1800' }));
      }

      return Promise.resolve(mockJsonResponse(200, { data: null, error: null }));
    });

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthHarness onValue={(value) => values.push(value)} />
        </AuthProvider>
      );
    });

    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });

    const sessionFetchCount = global.fetch.mock.calls.filter(([url]) => url === '/api/auth/session').length;
    expect(sessionFetchCount).toBe(1);
    expect(values.at(-1).loading).toBe(true);
    expect(values.at(-1).sessionError).toEqual({
      code: 'SESSION_RATE_LIMITED',
      status: 429,
      retryAfterSeconds: 1800,
    });
  });

  /**
   * Persistent 503s should stop at a terminal, retryable unavailable state.
   */
  it('publishes a terminal session error after bounded initial 503 retries exhaust', async () => {
    jest.useFakeTimers({ doNotFake: ['Date'] });
    const values = [];

    global.fetch = jest.fn((url) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(mockJsonResponse(503, {
          data: null,
          error: 'SERVICE_UNAVAILABLE',
        }));
      }

      return Promise.resolve(mockJsonResponse(200, { data: null, error: null }));
    });

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthHarness onValue={(value) => values.push(value)} />
        </AuthProvider>
      );
    });

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    await act(async () => {});

    await act(async () => {
      jest.advanceTimersByTime(2_500);
    });
    await act(async () => {});

    const sessionFetchCount = global.fetch.mock.calls.filter(([url]) => url === '/api/auth/session').length;
    expect(sessionFetchCount).toBe(3);
    expect(values.at(-1).loading).toBe(true);
    expect(values.at(-1).sessionError).toEqual({
      code: 'SESSION_UNAVAILABLE',
      status: 503,
      retryAfterSeconds: null,
    });
  });

  /**
   * Manual retry clears the terminal error and applies a later known session.
   */
  it('manual retry recovers from a terminal session error', async () => {
    const values = [];
    const sessionResponses = [
      mockJsonResponse(429, {
        data: null,
        error: 'RATE_LIMIT_EXCEEDED',
      }, { 'Retry-After': '1800' }),
      mockJsonResponse(200, {
        data: { user: { id: 'manual-retry-user', email: 'manual@example.com' } },
        error: null,
      }),
    ];

    global.fetch = jest.fn((url) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(sessionResponses.shift());
      }

      return Promise.resolve(mockJsonResponse(200, { data: null, error: null }));
    });

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthHarness onValue={(value) => values.push(value)} />
        </AuthProvider>
      );
    });

    expect(values.at(-1).sessionError?.code).toBe('SESSION_RATE_LIMITED');

    await act(async () => {
      values.at(-1).retrySessionCheck();
    });
    await act(async () => {});

    expect(values.at(-1).user).toEqual({ id: 'manual-retry-user', email: 'manual@example.com' });
    expect(values.at(-1).loading).toBe(false);
    expect(values.at(-1).sessionError).toBeNull();
  });

  /**
   * Latest session check wins when overlapping requests resolve out of order.
   */
  it('ignores stale session responses when a newer check has already resolved', async () => {
    const values = [];
    const firstSession = createDeferred();
    const secondSession = createDeferred();
    let sessionFetchCount = 0;

    global.fetch = jest.fn((url) => {
      if (url === '/api/auth/session') {
        sessionFetchCount += 1;
        return sessionFetchCount === 1 ? firstSession.promise : secondSession.promise;
      }

      return Promise.resolve(mockJsonResponse(200, { data: null, error: null }));
    });

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthHarness onValue={(value) => values.push(value)} />
        </AuthProvider>
      );
    });

    now += 31_000;

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await act(async () => {
      secondSession.resolve(mockJsonResponse(200, {
        data: { user: { id: 'new-user', email: 'new@example.com' } },
        error: null,
      }));
      await secondSession.promise;
    });

    expect(values.at(-1).user).toEqual({ id: 'new-user', email: 'new@example.com' });
    expect(values.at(-1).loading).toBe(false);

    await act(async () => {
      firstSession.resolve(mockJsonResponse(200, {
        data: { user: null },
        error: null,
      }));
      await firstSession.promise;
    });

    expect(values.at(-1).user).toEqual({ id: 'new-user', email: 'new@example.com' });
    expect(values.at(-1).loading).toBe(false);
  });
});
