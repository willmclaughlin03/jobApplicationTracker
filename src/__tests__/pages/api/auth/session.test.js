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

const handler = require('../../../../pages/api/auth/session.js').default;
const {
  AuthApiError,
  AuthSessionMissingError,
} = require('@supabase/auth-js');
const {
  SESSION_RESPONSE_FIXTURES,
} = require('../../../../testSupport/authV2ContractFixtures.js');

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
   * Happy path: authenticated user gets their id, email, and application role
   */
  it('returns 200 with user id and email when authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          user: {
            id: 'user-session-123',
            email: 'test@example.com',
            role: 'user',
          },
        },
        error: null,
      })
    );
  });

  /**
   * Safe role contract: application role comes from trusted app metadata.
   */
  it('returns the application role from app metadata', async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          ...mockUser,
          app_metadata: { ...mockUser.app_metadata, role: 'admin' },
        },
      },
      error: null,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.json.mock.calls[0][0].data.user).toEqual({
      id: 'user-session-123',
      email: 'test@example.com',
      role: 'admin',
    });
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
   * Unknown session errors must remain unavailable until their exact deployed
   * class/code/status tuple has been approved.
   */
  it('does not turn an unapproved Supabase error into false anonymity', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError('sanitized session failure', 400, 'bad_jwt'),
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(SESSION_RESPONSE_FIXTURES.unavailable.httpStatus);
    expect(res.json).toHaveBeenCalledWith(SESSION_RESPONSE_FIXTURES.unavailable.body);
  });

  /**
   * Authenticated v2 responses use the literal-version body directly and do
   * not inherit the shared legacy success envelope.
   */
  it('returns the exact v2 authenticated body', async () => {
    const expected = SESSION_RESPONSE_FIXTURES.authenticated;
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: expected.body.user.id,
          email: null,
          app_metadata: {},
        },
      },
      error: null,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(expected.httpStatus);
    expect(res.json).toHaveBeenCalledWith(expected.body);
  });

  /**
   * The locally verified missing-session class is the only repository-backed
   * Supabase error tuple currently allowed to become ordinary anonymity.
   */
  it('maps only the verified AuthSessionMissingError tuple to exact v2 anonymity', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: new AuthSessionMissingError(),
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(SESSION_RESPONSE_FIXTURES.anonymous.httpStatus);
    expect(res.json).toHaveBeenCalledWith(SESSION_RESPONSE_FIXTURES.anonymous.body);
  });

  /**
   * A no-user/no-error authority result is malformed, not evidence of logout.
   */
  it('maps a no-user and no-error authority result to unavailable', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(SESSION_RESPONSE_FIXTURES.unavailable.httpStatus);
    expect(res.json).toHaveBeenCalledWith(SESSION_RESPONSE_FIXTURES.unavailable.body);
  });

  /**
   * Explicit roles outside the exact safe allowlist fail closed as unavailable.
   */
  it('rejects an invalid explicit application role without normalizing it', async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          ...mockUser,
          app_metadata: { role: 'Admin' },
        },
      },
      error: null,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(SESSION_RESPONSE_FIXTURES.unavailable.httpStatus);
    expect(res.json).toHaveBeenCalledWith(SESSION_RESPONSE_FIXTURES.unavailable.body);
  });

  /**
   * Cache-Control must be no-store to prevent caching user data
   */
  it('sets Cache-Control: no-store header', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
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
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');

    // Must only contain the safe session fields.
    expect(responseBody.data.user).toEqual({
      id: 'user-session-123',
      email: 'test@example.com',
      role: 'user',
    });
  });
});
