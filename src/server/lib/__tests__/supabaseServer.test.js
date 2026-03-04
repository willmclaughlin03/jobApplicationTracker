/**
 * Tests for supabaseServer.js
 *
 * Purpose: Verify authentication utilities work correctly
 * Connects to: lib/supabaseServer.js
 */

// Create a shared mock instance that will be used by the module
const mockGetUser = jest.fn();

const mockSupabaseClient = {
  auth: {
    getUser: mockGetUser,
  },
};

// Mock @supabase/supabase-js before importing the module under test
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}));

// Mock logger to verify structured logging (replaces console.error usage)
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
  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();
  });

  describe('getUserFromRequest', () => {
    /**
     * Test: Missing Authorization header
     * Expected: Returns error indicating missing header
     */
    it('should return error when Authorization header is missing', async () => {
      const req = { headers: {} };

      const result = await getUserFromRequest(req);

      expect(result).toEqual({
        user: null,
        error: 'Missing Authorization header',
      });
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    /**
     * Test: Invalid Authorization header format (no Bearer prefix)
     * Expected: Returns error about invalid format
     */
    it('should return error when Authorization header does not start with Bearer', async () => {
      const req = {
        headers: {
          authorization: 'Basic some-token',
        },
      };

      const result = await getUserFromRequest(req);

      expect(result).toEqual({
        user: null,
        error: 'Invalid Authorization header format',
      });
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    /**
     * Test: Empty token after Bearer prefix
     * Expected: Returns error about empty token
     */
    it('should return error when token is empty after Bearer', async () => {
      const req = {
        headers: {
          authorization: 'Bearer ',
        },
      };

      const result = await getUserFromRequest(req);

      expect(result).toEqual({
        user: null,
        error: 'Empty token provided',
      });
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    /**
     * Test: Valid token with successful user lookup
     * Expected: Returns user object with no error
     */
    it('should return user when token is valid', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
      };

      mockGetUser.mockResolvedValue({
        data: { user: mockUser },
        error: null,
      });

      const req = {
        headers: {
          authorization: 'Bearer valid-token-123',
        },
      };

      const result = await getUserFromRequest(req);

      expect(result).toEqual({
        user: mockUser,
        error: null,
      });
      expect(mockGetUser).toHaveBeenCalledWith('valid-token-123');
    });

    /**
     * Test: Valid token but Supabase returns an error
     * Expected: Returns generic error message (not exposing internal details)
     * Verifies: logger.error called with structured context, console.error NOT called
     */
    it('should return error when Supabase auth fails', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'Token expired', status: 401 },
      });

      const req = {
        headers: {
          authorization: 'Bearer expired-token',
        },
      };

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await getUserFromRequest(req);

      expect(result).toEqual({
        user: null,
        error: 'Invalid or expired token',
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Token validation failed',
        expect.objectContaining({
          message: 'Token expired',
          status: 401,
          timestamp: expect.any(String),
        })
      );
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    /**
     * Test: Valid token but no user returned from Supabase
     * Expected: Returns user not found error
     */
    it('should return error when user is not found', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: null,
      });

      const req = {
        headers: {
          authorization: 'Bearer valid-but-no-user-token',
        },
      };

      const result = await getUserFromRequest(req);

      expect(result).toEqual({
        user: null,
        error: 'User not found',
      });
    });

    /**
     * Test: Supabase throws an unexpected exception
     * Expected: Returns service unavailable error
     * Verifies: logger.error called with structured context, console.error NOT called
     */
    it('should return error when Supabase throws an exception', async () => {
      mockGetUser.mockRejectedValue(new Error('Network error'));

      const req = {
        headers: {
          authorization: 'Bearer some-token',
        },
      };

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await getUserFromRequest(req);

      expect(result).toEqual({
        user: null,
        error: 'Authentication service unavailable',
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Unexpected authentication error',
        expect.objectContaining({
          message: 'Network error',
          stack: expect.any(String),
          timestamp: expect.any(String),
        })
      );
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    /**
     * Test: Token extraction is correct
     * Expected: Token after "Bearer " is passed to getUser
     */
    it('should correctly extract token from Bearer header', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: '123' } },
        error: null,
      });

      const req = {
        headers: {
          authorization: 'Bearer my-super-secret-jwt-token',
        },
      };

      await getUserFromRequest(req);

      expect(mockGetUser).toHaveBeenCalledWith('my-super-secret-jwt-token');
    });
  });

});
