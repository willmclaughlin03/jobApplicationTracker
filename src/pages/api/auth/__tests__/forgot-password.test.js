/**
 * Tests for /api/auth/forgot-password endpoint handler
 *
 * Purpose: Verify the forgot-password endpoint validates input, validates
 * redirectTo against allowed origins, prevents email enumeration, and
 * enforces timing-safe responses.
 *
 * Connects to: src/pages/api/auth/forgot-password.js
 *
 * Note: withRateLimit is mocked as passthrough — auth and rate limiting are
 * tested in withRateLimit.test.js. These tests focus on handler logic only.
 *
 * Test coverage:
 * - Always returns 200 success (prevents email enumeration)
 * - Calls resetPasswordForEmail with valid email
 * - Passes redirectTo when valid
 * - Rejects redirectTo with disallowed origins (open redirect prevention)
 * - Returns 400 for invalid email format
 * - Returns 405 for non-POST methods
 * - Still returns 200 when Supabase errors (enumeration prevention)
 * - Enforces minimum response time (timing-safe)
 */

jest.mock('../../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
}));

const mockResetPasswordForEmail = jest.fn();
jest.mock('../../../../server/lib/supabaseServer.js', () => ({
  supabaseAdmin: {
    auth: {
      resetPasswordForEmail: mockResetPasswordForEmail,
    },
  },
}));

jest.mock('../../../../shared/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock authSchema to avoid isomorphic-dompurify transform issues in test env
jest.mock('../../../../shared/validations/authSchema.js', () => {
  const z = require('zod');
  const forgotPasswordSchema = z.object({
    email: z.string().min(1).email(),
  });
  return {
    forgotPasswordSchema,
    getFirstErrorMessage: (zodError) =>
      zodError?.issues?.[0]?.message || 'Validation failed',
  };
});

// Set NEXT_PUBLIC_SITE_URL for redirectTo validation
const originalEnv = process.env;
beforeAll(() => {
  process.env = {
    ...originalEnv,
    NEXT_PUBLIC_SITE_URL: 'https://myapp.com',
  };
});
afterAll(() => {
  process.env = originalEnv;
});

const handler = require('../forgot-password.js').default;

describe('/api/auth/forgot-password handler', () => {
  function createMockReq(body = { email: 'user@example.com' }, method = 'POST') {
    return { method, body };
  }

  function createMockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockResetPasswordForEmail.mockResolvedValue({ error: null });
  });

  /**
   * Always returns success to prevent email enumeration
   */
  it('returns 200 success for valid email', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: null })
    );
  });

  /**
   * Calls Supabase with the provided email
   */
  it('calls resetPasswordForEmail with the email', async () => {
    const req = createMockReq({ email: 'user@example.com' });
    const res = createMockRes();

    await handler(req, res);

    expect(mockResetPasswordForEmail).toHaveBeenCalledWith(
      'user@example.com',
      expect.objectContaining({ redirectTo: undefined })
    );
  });

  /**
   * Passes valid redirectTo to Supabase
   */
  it('passes valid redirectTo to resetPasswordForEmail', async () => {
    const redirectTo = 'https://myapp.com/auth/callback?next=/reset-password';
    const req = createMockReq({ email: 'user@example.com', redirectTo });
    const res = createMockRes();

    await handler(req, res);

    expect(mockResetPasswordForEmail).toHaveBeenCalledWith(
      'user@example.com',
      expect.objectContaining({ redirectTo })
    );
  });

  /**
   * Also allows localhost for development
   */
  it('passes localhost redirectTo for development', async () => {
    const redirectTo = 'http://localhost:3000/auth/callback?next=/reset-password';
    const req = createMockReq({ email: 'user@example.com', redirectTo });
    const res = createMockRes();

    await handler(req, res);

    expect(mockResetPasswordForEmail).toHaveBeenCalledWith(
      'user@example.com',
      expect.objectContaining({ redirectTo })
    );
  });

  /**
   * Security: rejects redirectTo with disallowed origin (open redirect prevention)
   */
  it('returns 400 when redirectTo points to a disallowed origin', async () => {
    const req = createMockReq({
      email: 'user@example.com',
      redirectTo: 'https://evil.com/steal-tokens',
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
  });

  /**
   * Security: rejects prefix attack (e.g. https://myapp.com.evil.com)
   */
  it('returns 400 when redirectTo uses a prefix attack on allowed origin', async () => {
    const req = createMockReq({
      email: 'user@example.com',
      redirectTo: 'https://myapp.com.evil.com/steal-tokens',
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
  });

  /**
   * Security: rejects non-string redirectTo values
   */
  it('returns 400 when redirectTo is not a string', async () => {
    const req = createMockReq({
      email: 'user@example.com',
      redirectTo: { url: 'https://evil.com' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
  });

  /**
   * Security: rejects malformed redirectTo URLs
   */
  it('returns 400 when redirectTo is a malformed URL', async () => {
    const req = createMockReq({
      email: 'user@example.com',
      redirectTo: 'not-a-valid-url',
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
  });

  /**
   * Input validation: invalid email format
   */
  it('returns 400 for invalid email format', async () => {
    const req = createMockReq({ email: 'not-an-email' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
  });

  /**
   * Method not allowed
   */
  it('returns 405 for GET requests', async () => {
    const req = createMockReq({ email: 'user@example.com' }, 'GET');
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
  });

  /**
   * Timing-safe: enforces minimum response time (MIN_RESPONSE_MS = 300)
   */
  it('enforces minimum response time for fast Supabase responses', async () => {
    // Mock Date.now to control timing
    const realDateNow = Date.now;
    let now = 1000000;
    Date.now = jest.fn(() => now);

    // Supabase resolves instantly (simulated 0ms)
    mockResetPasswordForEmail.mockImplementation(async () => {
      // Simulate fast response — don't advance time
      return { error: null };
    });

    const req = createMockReq();
    const res = createMockRes();

    // Track setTimeout calls to verify the delay
    const realSetTimeout = global.setTimeout;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn, delay) => {
      // Advance time by the delay amount so the handler completes
      now += delay;
      return realSetTimeout(fn, 0);
    });

    await handler(req, res);

    // Should have called setTimeout with at least 300ms delay
    const delayCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay >= 300);
    expect(delayCall).toBeTruthy();

    setTimeoutSpy.mockRestore();
    Date.now = realDateNow;
  });

  it('returns same response shape for existing and non-existing emails', async () => {
    const res1 = createMockRes();
    const res2 = createMockRes();

    // Existing email — Supabase succeeds
    mockResetPasswordForEmail.mockResolvedValueOnce({ error: null });
    await handler(createMockReq({ email: 'exists@example.com' }), res1);

    // Non-existing email — Supabase errors
    mockResetPasswordForEmail.mockResolvedValueOnce({
      error: { message: 'User not found' },
    });
    await handler(createMockReq({ email: 'doesnotexist@example.com' }), res2);

    // Both should return identical status and response shape
    expect(res1.status).toHaveBeenCalledWith(200);
    expect(res2.status).toHaveBeenCalledWith(200);

    const body1 = res1.json.mock.calls[0][0];
    const body2 = res2.json.mock.calls[0][0];
    expect(Object.keys(body1).sort()).toEqual(Object.keys(body2).sort());
    expect(body1.error).toEqual(body2.error);
  });

  /**
   * Enumeration prevention: still returns 200 when Supabase errors
   */
  it('returns 200 even when Supabase returns an error', async () => {
    mockResetPasswordForEmail.mockResolvedValue({
      error: { message: 'User not found' },
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: null })
    );
  });

  /**
   * Enumeration prevention: still returns 200 when Supabase throws
   */
  it('returns 200 even when Supabase throws', async () => {
    mockResetPasswordForEmail.mockRejectedValue(new Error('Service down'));
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});
