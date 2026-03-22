/**
 * Tests for /api/auth/exchange-token endpoint handler
 *
 * Purpose: Verify the token exchange endpoint correctly validates input,
 * establishes sessions via setSession, verifies via getUser, and handles errors.
 *
 * Connects to: src/pages/api/auth/exchange-token.js
 *
 * Note: withRateLimit is mocked as passthrough — auth and rate limiting are
 * tested in withRateLimit.test.js. These tests focus on handler logic only.
 *
 * Test coverage:
 * - Returns 200 with user {id, email} on valid token exchange
 * - Returns 400 for missing access_token
 * - Returns 400 for missing refresh_token
 * - Returns 400 for non-string tokens
 * - Returns 400 for empty string tokens
 * - Returns 400 for tokens exceeding 8000 chars
 * - Returns 401 when setSession fails
 * - Returns 401 when getUser verification fails after setSession
 * - Returns 503 when Supabase client throws
 * - Returns 405 for non-POST methods
 * - Never leaks tokens in response
 */

jest.mock('../../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
}));

const mockSetSession = jest.fn();
const mockGetUser = jest.fn();
jest.mock('../../../../server/lib/supabaseApiRoute.js', () => ({
  createApiRouteClient: () => ({
    auth: {
      setSession: mockSetSession,
      getUser: mockGetUser,
    },
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

const handler = require('../exchange-token.js').default;

describe('/api/auth/exchange-token handler', () => {
  const validTokens = {
    access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.valid',
    refresh_token: 'refresh-token-abc123',
  };

  const mockUser = {
    id: 'user-exchange-123',
    email: 'test@example.com',
    app_metadata: {},
  };

  function createMockReq(body = validTokens, method = 'POST') {
    return { method, body, cookies: {} };
  }

  function createMockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockSetSession.mockResolvedValue({ data: { session: {} }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
  });

  /**
   * Happy path: valid tokens are exchanged for httpOnly session cookies
   */
  it('returns 200 with user on valid token exchange', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSetSession).toHaveBeenCalledWith(validTokens);
    expect(mockGetUser).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { user: { id: 'user-exchange-123', email: 'test@example.com' } },
        error: null,
      })
    );
  });

  /**
   * Input validation: missing access_token
   */
  it('returns 400 when access_token is missing', async () => {
    const req = createMockReq({ refresh_token: 'valid' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  /**
   * Input validation: missing refresh_token
   */
  it('returns 400 when refresh_token is missing', async () => {
    const req = createMockReq({ access_token: 'valid' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  /**
   * Input validation: non-string tokens
   */
  it('returns 400 when tokens are not strings', async () => {
    const req = createMockReq({ access_token: 123, refresh_token: true });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  /**
   * Input validation: empty strings
   */
  it('returns 400 when tokens are empty strings', async () => {
    const req = createMockReq({ access_token: '', refresh_token: '' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  /**
   * Input validation: tokens exceeding max length (8000 chars)
   */
  it('returns 400 when tokens exceed 8000 characters', async () => {
    const req = createMockReq({
      access_token: 'a'.repeat(8001),
      refresh_token: 'valid',
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  /**
   * Input validation: null body
   */
  it('returns 400 when body is null', async () => {
    const req = createMockReq(null);
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  /**
   * Input validation: tokens containing control characters (null bytes, newlines, tabs)
   *
   * GAP: These pass current validation (typeof string, non-empty, <8000) and reach
   * setSession. In production, Supabase would reject them as invalid JWTs (→ 401).
   * In tests the mock returns success, so they get 200.
   *
   * Potential hardening: reject tokens matching /[\x00-\x1f]/ before calling setSession.
   */
  it('does not crash on tokens with null bytes (passes to Supabase)', async () => {
    const req = createMockReq({
      access_token: 'valid-token\x00injected',
      refresh_token: 'valid-token',
    });
    const res = createMockRes();

    await handler(req, res);

    // Token passes string validation — reaches setSession without crashing
    expect(res.status).toHaveBeenCalled();
    // Response must not echo the malformed token back
    const body = JSON.stringify(res.json.mock.calls[0]?.[0] || {});
    expect(body).not.toContain('\x00');
    expect(body).not.toContain('valid-token');
  });

  it('does not crash on tokens with newlines and tabs (passes to Supabase)', async () => {
    const req = createMockReq({
      access_token: 'token\nwith\tnewlines',
      refresh_token: 'valid-token',
    });
    const res = createMockRes();

    await handler(req, res);

    // Does not crash — token reaches setSession
    expect(res.status).toHaveBeenCalled();
    const body = JSON.stringify(res.json.mock.calls[0]?.[0] || {});
    expect(body).not.toContain('token\n');
  });

  /**
   * Input validation: whitespace-only tokens
   *
   * GAP: '   ' passes current validation (typeof string, length > 0, < 8000).
   * Potential hardening: reject tokens where .trim().length === 0.
   */
  it('does not crash on whitespace-only tokens (passes to Supabase)', async () => {
    const req = createMockReq({
      access_token: '   ',
      refresh_token: '   ',
    });
    const res = createMockRes();

    await handler(req, res);

    // Does not crash — whitespace passes current validation
    expect(res.status).toHaveBeenCalled();
    // Response must not echo tokens
    const body = JSON.stringify(res.json.mock.calls[0]?.[0] || {});
    expect(body).not.toContain('   ');
  });

  /**
   * Input validation: tokens with leading/trailing whitespace
   * No .trim() is applied — these pass validation as-is
   */
  it('handles tokens with leading/trailing whitespace without crashing', async () => {
    const req = createMockReq({
      access_token: '  eyJhbGciOiJIUzI1NiJ9.valid  ',
      refresh_token: '  refresh-abc  ',
    });
    const res = createMockRes();

    await handler(req, res);

    // Tokens pass validation (string, non-empty, < 8000) — does not crash
    expect(res.status).toHaveBeenCalled();
  });

  /**
   * setSession fails (invalid/expired tokens)
   */
  it('returns 401 when setSession fails', async () => {
    mockSetSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid token' },
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'TOKEN_EXCHANGE_FAILED' })
    );
  });

  /**
   * getUser verification fails after setSession succeeds
   */
  it('returns 401 when getUser verification fails', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'User not found' },
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'TOKEN_EXCHANGE_FAILED' })
    );
  });

  /**
   * Supabase client throws (network/service error)
   */
  it('returns 503 when Supabase client throws', async () => {
    mockSetSession.mockRejectedValue(new Error('Connection refused'));
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'SERVICE_UNAVAILABLE' })
    );
  });

  /**
   * Method not allowed
   */
  it('returns 405 for GET requests', async () => {
    const req = createMockReq(validTokens, 'GET');
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
  });

  /**
   * Security: response must never contain tokens
   */
  it('never leaks tokens in response body', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    const responseBody = res.json.mock.calls[0][0];
    const serialized = JSON.stringify(responseBody);

    expect(serialized).not.toContain('eyJhbGci');
    expect(serialized).not.toContain('refresh-token-abc123');
    expect(serialized).not.toContain('app_metadata');
  });
});
