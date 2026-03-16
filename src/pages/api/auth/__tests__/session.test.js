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
 * - Returns 200 with user {id, email} when authenticated
 * - Returns 200 with {user: null} when not authenticated
 * - Returns 200 with {user: null} when getUser returns an error
 * - Sets Cache-Control: no-store header
 * - Returns 503 when Supabase client throws
 * - Never leaks tokens or full user object in response
 */

jest.mock('../../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
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

describe('/api/auth/session handler', () => {
  const mockUser = {
    id: 'user-session-123',
    email: 'test@example.com',
    app_metadata: { provider: 'email' },
    user_metadata: { name: 'Test' },
    aud: 'authenticated',
    role: 'authenticated',
  };

  function createMockReq() {
    return { method: 'GET', cookies: {} };
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
   * Happy path: authenticated user gets their id and email
   */
  it('returns 200 with user id and email when authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { user: { id: 'user-session-123', email: 'test@example.com' } },
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
   * Supabase returns an error (e.g. expired token, invalid JWT)
   */
  it('returns 200 with user: null when getUser returns an error', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'invalid JWT' },
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

    // Must not contain sensitive fields
    expect(serialized).not.toContain('app_metadata');
    expect(serialized).not.toContain('user_metadata');
    expect(serialized).not.toContain('aud');
    expect(serialized).not.toContain('role');
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');

    // Must only contain id and email
    expect(responseBody.data.user).toEqual({
      id: 'user-session-123',
      email: 'test@example.com',
    });
  });
});
