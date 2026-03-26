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
  const noopLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  const validTokens = {
    access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    refresh_token: 'dGhpcyBpcyBhIHJlZnJlc2g.dG9rZW4gZm9yIHRlc3Rpbmc.c2lnbmF0dXJl',
  };

  const mockUser = {
    id: 'user-exchange-123',
    email: 'test@example.com',
    app_metadata: {},
  };

  function createMockReq(body = validTokens, method = 'POST') {
    return { method, body, cookies: {}, log: noopLog };
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
   * Input validation: tokens without valid 3-segment JWT structure are rejected
   */
  it('returns 400 for dot-only tokens missing segment content', async () => {
    const req = createMockReq({
      access_token: '...',
      refresh_token: 'header.payload.signature',
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it('returns 400 for tokens with only one segment (no dots)', async () => {
    const req = createMockReq({
      access_token: 'nodots',
      refresh_token: 'header.payload.signature',
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  /**
   * Input validation: tokens containing control characters are rejected
   * JWT allowlist regex rejects anything outside base64url + dots
   */
  it('returns 400 for tokens with null bytes', async () => {
    const req = createMockReq({
      access_token: 'valid-token\x00injected',
      refresh_token: 'valid-token',
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it('returns 400 for tokens with newlines', async () => {
    const req = createMockReq({
      access_token: 'token\nwith\tnewlines',
      refresh_token: 'valid-token',
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  /**
   * Input validation: whitespace-only tokens rejected by JWT allowlist
   */
  it('returns 400 for whitespace-only tokens', async () => {
    const req = createMockReq({
      access_token: '   ',
      refresh_token: '   ',
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  /**
   * Input validation: tokens with leading/trailing whitespace rejected
   * JWT allowlist does not permit spaces
   */
  it('returns 400 for tokens with leading/trailing whitespace', async () => {
    const req = createMockReq({
      access_token: '  eyJhbGciOiJIUzI1NiJ9.valid  ',
      refresh_token: '  refresh-abc  ',
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  /**
   * Input validation: tokens with HTML/script tags rejected
   */
  it('returns 400 for tokens containing angle brackets', async () => {
    const req = createMockReq({
      access_token: '<script>alert(1)</script>',
      refresh_token: 'valid-token',
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSession).not.toHaveBeenCalled();
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
    expect(serialized).not.toContain('dGhpcyBpcyBhIHJlZnJlc2g');
    expect(serialized).not.toContain('app_metadata');
  });
});
