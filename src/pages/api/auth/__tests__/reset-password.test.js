/**
 * Tests for /api/auth/reset-password endpoint handler
 *
 * Purpose: Verify the reset-password endpoint validates password strength,
 * requires authentication, and handles errors correctly.
 *
 * Connects to: src/pages/api/auth/reset-password.js
 *
 * Note: withRateLimit is mocked as passthrough — auth and rate limiting are
 * tested in withRateLimit.test.js. These tests focus on handler logic only.
 *
 * Test coverage:
 * - Returns 200 on successful password update
 * - Returns 401 when user is not authenticated
 * - Returns 400 for weak passwords (validation)
 * - Returns 400 when updateUser fails
 * - Returns 405 for non-POST methods
 * - Returns 503 when Supabase client throws
 */

jest.mock('../../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
}));

const mockGetUser = jest.fn();
const mockUpdateUser = jest.fn();
jest.mock('../../../../server/lib/supabaseApiRoute.js', () => ({
  createApiRouteClient: () => ({
    auth: {
      getUser: mockGetUser,
      updateUser: mockUpdateUser,
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

// Mock authSchema to avoid isomorphic-dompurify transform issues in test env.
// The schema validates password strength (min 12, upper, lower, number, special).
jest.mock('../../../../shared/validations/authSchema.js', () => {
  const z = require('zod');
  const resetPasswordServerSchema = z.object({
    password: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .regex(/[A-Z]/, 'Must contain uppercase')
      .regex(/[a-z]/, 'Must contain lowercase')
      .regex(/[0-9]/, 'Must contain number')
      .regex(/[^A-Za-z0-9]/, 'Must contain special character'),
  });
  return {
    resetPasswordServerSchema,
    getFirstErrorMessage: (zodError) =>
      zodError?.issues?.[0]?.message || 'Validation failed',
  };
});

const handler = require('../reset-password.js').default;

describe('/api/auth/reset-password handler', () => {
  const noopLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  const mockUser = { id: 'user-reset-123', email: 'test@example.com' };
  // Meets all password strength requirements
  const strongPassword = 'MyStr0ng!Pass#2024';

  function createMockReq(body = { password: strongPassword }, method = 'POST') {
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
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    mockUpdateUser.mockResolvedValue({ data: { user: mockUser }, error: null });
  });

  /**
   * Happy path: password updated successfully
   */
  it('returns 200 on successful password update', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockUpdateUser).toHaveBeenCalledWith({ password: strongPassword });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: null })
    );
  });

  /**
   * Unauthenticated: getUser returns no user
   */
  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  /**
   * Unauthenticated: getUser returns an error
   */
  it('returns 401 when getUser returns an error', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'invalid JWT' },
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  /**
   * Validation: password too short
   */
  it('returns 400 for password that is too short', async () => {
    const req = createMockReq({ password: 'Ab1!' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  /**
   * Validation: password missing special character
   */
  it('returns 400 for password without special character', async () => {
    const req = createMockReq({ password: 'MyStr0ngPassword2024' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  /**
   * Validation: missing password field
   */
  it('returns 400 when password is missing', async () => {
    const req = createMockReq({});
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  /**
   * Supabase updateUser fails
   */
  it('returns 400 when updateUser fails', async () => {
    mockUpdateUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Password too weak' },
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'PASSWORD_UPDATE_FAILED' })
    );
  });

  /**
   * Method not allowed
   */
  it('returns 405 for GET requests', async () => {
    const req = createMockReq({ password: strongPassword }, 'GET');
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
  });

  /**
   * Supabase client throws (network/service error)
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
});