/**
 * CHUNK-0 regression tests for truthful, bounded v2 sign-out behavior.
 *
 * Purpose: Demonstrate missing same-origin acceptance, explicit local scope,
 * bounded cookie cleanup, strict result bodies, and cache isolation.
 * Connects to: src/pages/api/auth/signout.js and the frozen v2 fixtures.
 */

const mockSignOut = jest.fn();
const mockClearCsrfCookie = jest.fn();
let mockRateLimitUnavailable = false;

/**
 * Wraps the route with a controllable pre-handler limiter failure.
 *
 * Purpose: Prove an accepted logout cannot lose local cleanup merely because
 * the current outer middleware returns before the route coordinator runs.
 *
 * @param {Function} handler - Sign-out handler supplied by the page module.
 * @param {object} options - Middleware options, including an emergency skip.
 * @returns {Function} Request handler with the simulated limiter boundary.
 */
function mockWithRateLimit(handler, options = {}) {
  /**
   * Applies the test-owned limiter outcome before delegating to sign-out.
   *
   * @param {object} req - Next.js API request double.
   * @param {object} res - Next.js API response double.
   * @returns {Promise<unknown>} Middleware or route result.
   */
  return async function controllableRateLimitWrapper(req, res) {
    if (mockRateLimitUnavailable) {
      const shouldSkip = typeof options.skipRateLimitWhen === 'function'
        && await options.skipRateLimitWhen(req);

      if (!shouldSkip) {
        return res.status(503).json({ error: 'SERVICE_UNAVAILABLE' });
      }
    }

    return handler(req, res);
  };
}

jest.mock('../../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: mockWithRateLimit,
}));

jest.mock('../../../../server/lib/supabaseApiRoute.js', () => ({
  createApiRouteClient: () => ({
    auth: { signOut: mockSignOut },
  }),
}));

jest.mock('../../../../server/lib/csrf.js', () => ({
  clearCsrfCookie: mockClearCsrfCookie,
}));

const handler = require('../../../../pages/api/auth/signout.js').default;
const {
  AUTH_COOKIE_STORAGE_KEY,
  LOGOUT_INTENT_HEADER,
  LOGOUT_INTENT_VALUE,
  SIGNOUT_RESPONSE_FIXTURES,
  TRUSTED_LOCAL_APP_ORIGIN,
} = require('../../../../testSupport/authV2ContractFixtures.js');

const noopLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

/**
 * Creates a locally accepted v2 sign-out request double.
 *
 * @param {object} overrides - Request fields to replace for rejection cases.
 * @returns {object} Next.js API request double.
 */
function createMockReq(overrides = {}) {
  return {
    method: 'POST',
    body: {},
    cookies: {},
    headers: {
      [LOGOUT_INTENT_HEADER.toLowerCase()]: LOGOUT_INTENT_VALUE,
      'sec-fetch-site': 'same-origin',
      origin: TRUSTED_LOCAL_APP_ORIGIN,
    },
    log: noopLog,
    ...overrides,
  };
}

/**
 * Creates a response double that retains headers for cleanup-bound assertions.
 *
 * @returns {object} Next.js API response double.
 */
function createMockRes() {
  const headers = new Map();
  const res = {
    statusCode: 200,
    status: jest.fn((statusCode) => {
      res.statusCode = statusCode;
      return res;
    }),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn((name, value) => {
      headers.set(name.toLowerCase(), value);
      return res;
    }),
    getHeader: jest.fn((name) => headers.get(name.toLowerCase())),
  };

  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRateLimitUnavailable = false;
  mockSignOut.mockResolvedValue({ error: null });
});

describe('/api/auth/signout CHUNK-0 contract', () => {
  it('uses explicit local Supabase scope for an accepted request', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it.each([
    ['missing intent', { headers: { 'sec-fetch-site': 'same-origin' } }, 403],
    ['missing source proof', {
      headers: { [LOGOUT_INTENT_HEADER.toLowerCase()]: LOGOUT_INTENT_VALUE },
    }, 403],
    ['cross-site metadata', {
      headers: {
        [LOGOUT_INTENT_HEADER.toLowerCase()]: LOGOUT_INTENT_VALUE,
        'sec-fetch-site': 'cross-site',
      },
    }, 403],
    ['contradictory origin', {
      headers: {
        [LOGOUT_INTENT_HEADER.toLowerCase()]: LOGOUT_INTENT_VALUE,
        'sec-fetch-site': 'same-origin',
        origin: 'https://untrusted.invalid',
      },
    }, 403],
    ['unexpected body field', { body: { unexpected: true } }, 400],
    ['wrong method', { method: 'GET' }, 405],
  ])('rejects %s before remote work or cleanup', async (_name, overrides, statusCode) => {
    const req = createMockReq(overrides);
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(statusCode);
    expect(res.json).toHaveBeenCalledWith(
      SIGNOUT_RESPONSE_FIXTURES.rejectedForbidden.body
    );
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(res.getHeader('Set-Cookie')).toBeUndefined();
  });

  it('does not trust Host as the application origin', async () => {
    const req = createMockReq({
      headers: {
        [LOGOUT_INTENT_HEADER.toLowerCase()]: LOGOUT_INTENT_VALUE,
        host: 'localhost:3000',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('does not clear attacker-selected Supabase-like cookie names', async () => {
    mockSignOut.mockResolvedValue({ error: new Error('sanitized remote failure') });
    const req = createMockReq({
      cookies: {
        [`${AUTH_COOKIE_STORAGE_KEY}`]: null,
        [`${AUTH_COOKIE_STORAGE_KEY}.0`]: null,
        'sb-attacker-auth-token': null,
        'sb-attacker-auth-token.999999': null,
      },
    });
    const res = createMockRes();

    await handler(req, res);

    const setCookie = res.getHeader('Set-Cookie') ?? [];
    const serialized = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);

    expect(serialized).toContain(`${AUTH_COOKIE_STORAGE_KEY}=`);
    expect(serialized).not.toContain('sb-attacker-auth-token=');
    expect(serialized).not.toContain('sb-attacker-auth-token.999999=');
  });

  it('returns local_only when remote termination cannot be observed', async () => {
    mockSignOut.mockResolvedValue({ error: null });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(SIGNOUT_RESPONSE_FIXTURES.localOnly.httpStatus);
    expect(res.json).toHaveBeenCalledWith(SIGNOUT_RESPONSE_FIXTURES.localOnly.body);
  });

  it('returns local_only after a sanitized Supabase failure while still issuing cleanup', async () => {
    mockSignOut.mockResolvedValue({ error: new Error('sanitized remote failure') });
    const req = createMockReq({
      cookies: { [AUTH_COOKIE_STORAGE_KEY]: null },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(SIGNOUT_RESPONSE_FIXTURES.localOnly.httpStatus);
    expect(res.json).toHaveBeenCalledWith(SIGNOUT_RESPONSE_FIXTURES.localOnly.body);
    expect(res.getHeader('Set-Cookie')).toBeDefined();
  });

  it('does not let limiter or Redis unavailability bypass accepted local cleanup', async () => {
    mockRateLimitUnavailable = true;
    const req = createMockReq({
      cookies: { [AUTH_COOKIE_STORAGE_KEY]: null },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(mockClearCsrfCookie).toHaveBeenCalledTimes(1);
    expect(res.getHeader('Set-Cookie')).toEqual(expect.arrayContaining([
      expect.stringContaining(`${AUTH_COOKIE_STORAGE_KEY}=`),
    ]));
    expect(res.json).toHaveBeenCalledWith(SIGNOUT_RESPONSE_FIXTURES.localOnly.body);
  });

  it('sets private no-store before accepted or rejected work can return', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.setHeader.mock.invocationCallOrder[0]).toBeLessThan(
      res.status.mock.invocationCallOrder[0]
    );
  });
});
