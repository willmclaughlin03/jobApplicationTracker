/**
 * Tests for supabaseServer.js
 *
 * Purpose: Verify authentication utilities work correctly
 * Connects to: lib/supabaseServer.js
 *
 * Auth model: cookie-based SSR via createApiRouteClient (not Bearer headers).
 * getUserFromRequest(req, res) creates a per-request Supabase client that reads
 * session cookies and calls getUser() with no arguments.
 */

// Create a shared mock instance that will be used by the module
const mockGetUser = jest.fn();

const mockSupabaseRouteClient = {
  auth: {
    getUser: mockGetUser,
  },
};

// Mock createApiRouteClient — this is what getUserFromRequest calls
jest.mock('../supabaseApiRoute.js', () => ({
  createApiRouteClient: jest.fn(() => mockSupabaseRouteClient),
}));

// Mock @supabase/supabase-js for supabaseAdmin only
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: { getUser: jest.fn() },
  })),
}));

// Mock logger to verify structured logging
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};
jest.mock('../../../shared/logger.js', () => ({
  logger: mockLogger,
}));

const { getUserFromRequest } = require('../supabaseServer.js');

describe('supabaseServer', () => {
  const createMockRes = () => ({
    getHeader: jest.fn(),
    setHeader: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getUserFromRequest', () => {
    /**
     * Test: Valid cookie session with successful user lookup
     * Expected: Returns user object, no error, and supabaseClient
     */
    it('should return user when cookie session is valid', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
      };

      mockGetUser.mockResolvedValue({
        data: { user: mockUser },
        error: null,
      });

      const req = { headers: {}, cookies: {} };
      const res = createMockRes();

      const result = await getUserFromRequest(req, res);

      expect(result).toEqual({
        user: mockUser,
        error: null,
        supabaseClient: mockSupabaseRouteClient,
      });
      expect(mockGetUser).toHaveBeenCalledWith();
    });

    /**
     * Test: getUser() is called with no arguments (cookie-based, not token-based)
     * Verifies: Auth reads from cookies automatically, no token is extracted
     */
    it('should call getUser with no arguments', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: '123' } },
        error: null,
      });

      const req = { headers: {}, cookies: {} };
      const res = createMockRes();

      await getUserFromRequest(req, res);

      expect(mockGetUser).toHaveBeenCalledWith();
      expect(mockGetUser).toHaveBeenCalledTimes(1);
    });

    /**
     * Test: Supabase returns an auth error (e.g., expired/invalid cookie)
     * Expected: Returns generic error message (not exposing internal details)
     * Verifies: logger.error called with Pino-style (context, message) order
     */
    it('should return error when Supabase auth fails', async () => {
      const authError = { message: 'Token expired', status: 401 };
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: authError,
      });

      const req = { headers: {}, cookies: {} };
      const res = createMockRes();

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await getUserFromRequest(req, res);

      expect(result).toEqual({
        user: null,
        error: 'Invalid or expired token',
        supabaseClient: null,
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: authError, status: 401 },
        'Token validation failed'
      );
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    /**
     * Test: No user returned from Supabase (no error, but user is null)
     * Expected: Returns user not found error
     */
    it('should return error when user is not found', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: null,
      });

      const req = { headers: {}, cookies: {} };
      const res = createMockRes();

      const result = await getUserFromRequest(req, res);

      expect(result).toEqual({
        user: null,
        error: 'User not found',
        supabaseClient: null,
      });
    });

    /**
     * Test: Supabase throws an unexpected exception
     * Expected: Returns service unavailable error
     * Verifies: logger.error called with { err } context in Pino order
     */
    it('should return error when Supabase throws an exception', async () => {
      const networkError = new Error('Network error');
      mockGetUser.mockRejectedValue(networkError);

      const req = { headers: {}, cookies: {} };
      const res = createMockRes();

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await getUserFromRequest(req, res);

      expect(result).toEqual({
        user: null,
        error: 'Authentication service unavailable',
        supabaseClient: null,
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: networkError },
        'Unexpected authentication error'
      );
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    /**
     * Test: No cookies present (unauthenticated request)
     * Expected: createApiRouteClient still called, getUser returns error
     */
    it('should handle missing cookies gracefully', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'No session found', status: 401 },
      });

      const req = { headers: {} };
      const res = createMockRes();

      const result = await getUserFromRequest(req, res);

      expect(result.user).toBeNull();
      expect(result.error).toBe('Invalid or expired token');
      expect(result.supabaseClient).toBeNull();
    });

    /**
     * Test: createApiRouteClient throws (e.g., missing env vars)
     * Expected: Returns service unavailable error, not an unhandled exception
     */
    it('should return error when createApiRouteClient throws', async () => {
      const { createApiRouteClient } = require('../supabaseApiRoute.js');
      createApiRouteClient.mockImplementationOnce(() => {
        throw new Error('Missing SUPABASE_URL');
      });

      const req = { headers: {}, cookies: {} };
      const res = createMockRes();

      const result = await getUserFromRequest(req, res);

      expect(result).toEqual({
        user: null,
        error: 'Authentication service unavailable',
        supabaseClient: null,
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Unexpected authentication error'
      );
    });

    /**
     * Test: supabaseClient is null on auth failure
     * Verifies: Client not leaked when auth fails
     */
    it('should return null supabaseClient on auth error', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid token', status: 401 },
      });

      const req = { headers: {}, cookies: {} };
      const res = createMockRes();

      const result = await getUserFromRequest(req, res);

      expect(result.supabaseClient).toBeNull();
    });
  });
});
