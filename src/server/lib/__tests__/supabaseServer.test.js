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

const { getUserFromRequest, withAuth } = require('../supabaseServer.js');

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

  describe('withAuth', () => {
    /**
     * Test: Unauthenticated request
     * Expected: Returns 401 response without calling handler
     */
    it('should return 401 when user is not authenticated', async () => {
      const mockHandler = jest.fn();
      const wrappedHandler = withAuth(mockHandler);

      const req = { headers: {} };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await wrappedHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Missing Authorization header',
        code: 'UNAUTHORIZED',
      });
      expect(mockHandler).not.toHaveBeenCalled();
    });

    /**
     * Test: Authenticated request
     * Expected: Calls handler with req, res, and user
     */
    it('should call handler with user when authenticated', async () => {
      const mockUser = { id: 'user-456', email: 'auth@example.com' };
      mockGetUser.mockResolvedValue({
        data: { user: mockUser },
        error: null,
      });

      const mockHandler = jest.fn().mockResolvedValue(undefined);
      const wrappedHandler = withAuth(mockHandler);

      const req = {
        headers: {
          authorization: 'Bearer valid-token',
        },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await wrappedHandler(req, res);

      expect(mockHandler).toHaveBeenCalledWith(req, res, mockUser);
      expect(res.status).not.toHaveBeenCalled();
    });

    /**
     * Test: Handler receives correct user object
     * Expected: User object passed to handler matches authenticated user
     */
    it('should pass the correct user object to the handler', async () => {
      const mockUser = {
        id: 'user-789',
        email: 'specific@example.com',
        user_metadata: { name: 'Test User' },
      };

      mockGetUser.mockResolvedValue({
        data: { user: mockUser },
        error: null,
      });

      let receivedUser = null;
      const mockHandler = jest.fn((req, res, user) => {
        receivedUser = user;
      });

      const wrappedHandler = withAuth(mockHandler);

      const req = {
        headers: {
          authorization: 'Bearer token',
        },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await wrappedHandler(req, res);

      expect(receivedUser).toEqual(mockUser);
      expect(receivedUser.id).toBe('user-789');
      expect(receivedUser.email).toBe('specific@example.com');
    });

    /**
     * Test: Handler return value is propagated
     * Expected: withAuth returns whatever the handler returns
     */
    it('should return the handler result', async () => {
      const mockUser = { id: 'user-123' };
      mockGetUser.mockResolvedValue({
        data: { user: mockUser },
        error: null,
      });

      const expectedResult = { success: true, data: 'test' };
      const mockHandler = jest.fn().mockResolvedValue(expectedResult);
      const wrappedHandler = withAuth(mockHandler);

      const req = {
        headers: {
          authorization: 'Bearer valid-token',
        },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      const result = await wrappedHandler(req, res);

      expect(result).toEqual(expectedResult);
    });

    /**
     * Test: 401 response includes error code
     * Expected: Response includes UNAUTHORIZED code for client handling
     */
    it('should include UNAUTHORIZED code in 401 response', async () => {
      const wrappedHandler = withAuth(jest.fn());

      const req = {
        headers: {
          authorization: 'Bearer ',
        },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await wrappedHandler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'UNAUTHORIZED',
        })
      );
    });
  });
});
