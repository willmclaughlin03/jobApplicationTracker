/**
 * Tests for /api/auth/session endpoint handler
 *
 * Purpose: Verify the session endpoint returns user data from httpOnly cookies
 * and handles unauthenticated/error states correctly.
 *
 * Connects to: src/pages/api/auth/session.js
 *
 * Note: withRateLimit is mocked as passthrough — auth and rate limiting are
 * tested in withRateLimit.test.js. These tests focus on handler logic only.
 *
 * Test coverage:
 * - Returns 200 with user {id, email, role} when authenticated
 * - Returns 200 with {user: null} when not authenticated
 * - Returns 200 with {user: null} when getUser returns a known invalid-session error
 * - Returns 503 when getUser returns an ambiguous or retryable auth error
 * - Sets Cache-Control: no-store header
 * - Returns 503 when Supabase client throws
 * - Never leaks tokens or full user object in response
 */

const mockWithRateLimit = jest.fn((handler) => handler);
jest.mock('../../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: mockWithRateLimit,
}));

const mockGetUser = jest.fn();
jest.mock('../../../../server/lib/supabaseApiRoute.js', () => ({
  createApiRouteClient: () => ({
    auth: { getUser: mockGetUser },
  }),
}));

jest.mock('../../../../shared/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

const handler = require('../session.js').default;
const wrappedSessionOptions = mockWithRateLimit.mock.calls[0]?.[1];

describe('/api/auth/session handler', () => {
  const noopLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  const mockUser = {
    id: 'user-session-123',
    email: 'test@example.com',
    app_metadata: { provider: 'email' },
    user_metadata: { name: 'Test' },
    aud: 'authenticated',
    role: 'authenticated',
  };

  function createMockReq() {
    return { method: 'GET', cookies: {}, log: noopLog };
  }

  function createMockRes() {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    };
    return res;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Route wiring: session is the only public auth route opted into IP cooldown.
   */
  it('wraps the session route with the auth-session IP cooldown policy', () => {
    expect(wrappedSessionOptions).toEqual(expect.objectContaining({
      requireAuth: false,
      operation: 'auth',
      allowedMethods: ['GET'],
      ipCooldown: expect.objectContaining({
        cooldownSeconds: 1800,
        violationWindowSeconds: 600,
        violationThreshold: 3,
      }),
    }));
  });

  /**
   * Happy path: authenticated user gets their id, email, and client role
   */
  it('returns 200 with user id, email, and role when authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { user: { id: 'user-session-123', email: 'test@example.com', role: 'user' } },
        error: null,
      })
    );
  });

  /**
   * Unauthenticated: no user in cookies
   */
  it('returns 200 with user: null when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { user: null } })
    );
  });

  /**
   * Supabase returns a known invalid-session error (e.g. expired token, invalid JWT)
   */
  it('returns 200 with user: null when getUser returns a realistic invalid-session error', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'invalid JWT', status: 401 },
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { user: null } })
    );
  });

  /**
   * Ambiguous auth errors fail closed so temporary provider failures do not
   * become confirmed signed-out client state.
   */
  it('returns 503 when getUser returns an ambiguous auth error shape', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'unexpected auth failure' },
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 5);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'SERVICE_UNAVAILABLE' })
    );
  });

  /**
   * Supabase retryable fetch errors indicate provider/network unavailability.
   */
  it('returns 503 when getUser returns a retryable auth fetch error', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthRetryableFetchError', message: 'Auth service unavailable', status: 503 },
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'SERVICE_UNAVAILABLE' })
    );
  });

  /**
   * Cache-Control must be no-store to prevent caching user data
   */
  it('sets Cache-Control: no-store header', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  /**
   * Supabase client throws (network error, service down)
   */
  it('returns 503 when Supabase client throws', async () => {
    mockGetUser.mockRejectedValue(new Error('Connection refused'));
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'SERVICE_UNAVAILABLE' })
    );
  });

  /**
   * Security: response must never contain tokens, metadata, or full user object
   */
  it('never leaks tokens or full user object in response', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    const responseBody = res.json.mock.calls[0][0];
    const serialized = JSON.stringify(responseBody);

    // Must not contain sensitive metadata or tokens
    expect(serialized).not.toContain('app_metadata');
    expect(serialized).not.toContain('user_metadata');
    expect(serialized).not.toContain('aud');
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');

    // Must only contain the client-facing session fields
    expect(responseBody.data.user).toEqual({
      id: 'user-session-123',
      email: 'test@example.com',
      role: 'user',
    });
  });
});
