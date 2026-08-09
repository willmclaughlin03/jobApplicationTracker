/**
 * CHUNK-0 regression tests for narrow, safer v1 sign-out compatibility.
 *
 * Purpose: Preserve the legacy request/response shape while demonstrating the
 * local-scope, bounded-cleanup, and cache adaptations required during overlap.
 * Connects to: src/pages/api/auth/signout.js and future isolated v2 tests.
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
  MAX_AUTH_COOKIE_CHUNKS,
  signoutResponseSchema,
} = require('../../../../testSupport/authV2ContractFixtures.js');

const noopLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

/**
 * Creates a legacy v1 sign-out request double without the future v2 intent.
 *
 * @param {object} overrides - Request fields to replace for rejection cases.
 * @returns {object} Next.js API request double.
 */
function createMockReq(overrides = {}) {
  return {
    method: 'POST',
    body: {},
    cookies: {},
    headers: {},
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

describe('/api/auth/signout v1 compatibility contract', () => {
  it('uses explicit local Supabase scope without requiring a v2 intent header', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('preserves the legacy v1 success body instead of returning a v2 result', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const responseBody = res.json.mock.calls[0][0];
    expect(responseBody).toEqual({
      data: null,
      error: null,
      message: 'Signed out successfully',
    });
    expect(signoutResponseSchema.safeParse(responseBody).success).toBe(false);
  });

  it('clears the exact derived cookie allowlist once without accepting suffix lookalikes', async () => {
    mockSignOut.mockResolvedValue({ error: new Error('sanitized remote failure') });
    const hasDerivedChunkCap = Number.isInteger(MAX_AUTH_COOKIE_CHUNKS)
      && MAX_AUTH_COOKIE_CHUNKS > 0;
    const firstRejectedSuffix = hasDerivedChunkCap ? MAX_AUTH_COOKIE_CHUNKS : 999999;
    const req = createMockReq({
      cookies: {
        [`${AUTH_COOKIE_STORAGE_KEY}`]: null,
        [`${AUTH_COOKIE_STORAGE_KEY}.0`]: null,
        [`${AUTH_COOKIE_STORAGE_KEY}.${firstRejectedSuffix}`]: null,
        [`${AUTH_COOKIE_STORAGE_KEY}.01`]: null,
        [`${AUTH_COOKIE_STORAGE_KEY}.x`]: null,
        'sb-attacker-auth-token': null,
        'sb-attacker-auth-token.999999': null,
      },
    });
    const res = createMockRes();

    await handler(req, res);

    const setCookie = res.getHeader('Set-Cookie') ?? [];
    const setCookieValues = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    const serialized = setCookieValues.join('\n');

    expect(serialized).toContain(`${AUTH_COOKIE_STORAGE_KEY}=`);
    expect(serialized).toContain(`${AUTH_COOKIE_STORAGE_KEY}.0=`);
    expect(serialized).not.toContain(`${AUTH_COOKIE_STORAGE_KEY}.${firstRejectedSuffix}=`);
    expect(serialized).not.toContain(`${AUTH_COOKIE_STORAGE_KEY}.01=`);
    expect(serialized).not.toContain(`${AUTH_COOKIE_STORAGE_KEY}.x=`);
    expect(serialized).not.toContain('sb-attacker-auth-token=');
    expect(serialized).not.toContain('sb-attacker-auth-token.999999=');

    if (hasDerivedChunkCap) {
      const allowedCookieNames = [
        AUTH_COOKIE_STORAGE_KEY,
        ...Array.from(
          { length: MAX_AUTH_COOKIE_CHUNKS },
          (_unused, index) => `${AUTH_COOKIE_STORAGE_KEY}.${index}`
        ),
      ];

      allowedCookieNames.forEach((cookieName) => {
        expect(setCookieValues.filter(
          (cookieValue) => cookieValue.startsWith(`${cookieName}=`)
        )).toHaveLength(1);
      });
      expect(setCookieValues).toHaveLength(allowedCookieNames.length);
    }

    expect(hasDerivedChunkCap).toBe(true);
  });

  it('issues bounded auth and CSRF cleanup after a sanitized Supabase failure', async () => {
    mockSignOut.mockResolvedValue({ error: new Error('sanitized remote failure') });
    const req = createMockReq({
      cookies: { [AUTH_COOKIE_STORAGE_KEY]: null },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.getHeader('Set-Cookie')).toBeDefined();
    expect(mockClearCsrfCookie).toHaveBeenCalledTimes(1);
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
    expect(res.json).toHaveBeenCalledWith({
      data: null,
      error: null,
      message: 'Signed out successfully',
    });
  });

  it('sets private no-store before accepted v1 work can return', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.setHeader.mock.invocationCallOrder[0]).toBeLessThan(
      res.status.mock.invocationCallOrder[0]
    );
  });
});
