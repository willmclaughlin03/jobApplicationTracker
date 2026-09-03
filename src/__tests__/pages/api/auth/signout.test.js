/**
 * Route-level sign-out cache and cookie-clearing tests.
 *
 * Purpose: keep sign-out publicly reachable while requiring the shared wrapper
 * to apply private/no-store before all pre-handler and handler outcomes.
 */

let mockCapturedRateLimitOptions;
const mockSignOut = jest.fn();
const mockCreateApiRouteClient = jest.fn();
const mockClearCsrfCookie = jest.fn();

jest.mock('../../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: (handler, options) => {
    mockCapturedRateLimitOptions = options;
    return handler;
  },
}));

jest.mock('../../../../server/lib/supabaseApiRoute.js', () => ({
  createApiRouteClient: (...args) => mockCreateApiRouteClient(...args),
}));

jest.mock('../../../../server/lib/csrf.js', () => ({
  clearCsrfCookie: (...args) => mockClearCsrfCookie(...args),
}));

const handler = require('../../../../pages/api/auth/signout.js').default;

/**
 * Builds a chainable API response that retains response header values.
 *
 * @returns {object} Minimal NextApiResponse-compatible mock.
 */
function createMockResponse() {
  const headers = {};
  return {
    getHeader: jest.fn((name) => headers[name]),
    setHeader: jest.fn((name, value) => {
      headers[name] = value;
    }),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    headers,
  };
}

describe('/api/auth/signout route invariants', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignOut.mockResolvedValue({ error: null });
    mockCreateApiRouteClient.mockReturnValue({
      auth: { signOut: mockSignOut },
    });
  });

  it('remains a public POST route with explicit private no-store', () => {
    expect(mockCapturedRateLimitOptions).toEqual({
      requireAuth: false,
      operation: 'auth',
      allowedMethods: ['POST'],
      cacheControl: 'private, no-store',
    });
    expect(mockCapturedRateLimitOptions).not.toHaveProperty('skipRateLimitWhen');
    expect(mockCapturedRateLimitOptions).not.toHaveProperty('preRateLimitGuard');
  });

  it('preserves successful sign-out and CSRF clearing behavior', async () => {
    const req = { cookies: {}, log: { warn: jest.fn(), error: jest.fn() } };
    const res = createMockResponse();

    await handler(req, res);

    expect(mockCreateApiRouteClient).toHaveBeenCalledWith(req, res);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockClearCsrfCookie).toHaveBeenCalledWith(res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: null,
      message: 'Signed out successfully',
    }));
  });

  it('manually expires only Supabase auth cookies after a sign-out error', async () => {
    mockSignOut.mockResolvedValue({ error: new Error('session expired') });
    const req = {
      cookies: {
        'sb-project-auth-token.0': 'first',
        'sb-project-auth-token.1': 'second',
        unrelated: 'keep',
      },
      log: { warn: jest.fn(), error: jest.fn() },
    };
    const res = createMockResponse();

    await handler(req, res);

    expect(res.headers['Set-Cookie']).toHaveLength(2);
    expect(res.headers['Set-Cookie'][0]).toContain('sb-project-auth-token.0=');
    expect(res.headers['Set-Cookie'][0]).toContain('Max-Age=0');
    expect(res.headers['Set-Cookie'][1]).toContain('sb-project-auth-token.1=');
    expect(res.headers['Set-Cookie'].join(';')).not.toContain('unrelated=');
    expect(mockClearCsrfCookie).toHaveBeenCalledWith(res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('preserves existing Set-Cookie values when thrown sign-out uses fallback deletion', async () => {
    mockSignOut.mockRejectedValue(new Error('sign-out unavailable'));
    const req = {
      cookies: { 'sb-project-auth-token': 'stale' },
      log: { warn: jest.fn(), error: jest.fn() },
    };
    const res = createMockResponse();
    res.headers['Set-Cookie'] = 'existing-cookie=value';

    await handler(req, res);

    expect(res.headers['Set-Cookie']).toHaveLength(2);
    expect(res.headers['Set-Cookie'][0]).toBe('existing-cookie=value');
    expect(res.headers['Set-Cookie'][1]).toContain('sb-project-auth-token=');
    expect(res.headers['Set-Cookie'][1]).toContain('Max-Age=0');
    expect(mockClearCsrfCookie).toHaveBeenCalledWith(res);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
