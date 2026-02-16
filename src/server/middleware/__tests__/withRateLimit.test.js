/**
 * Tests for withRateLimit middleware
 *
 * Purpose: Verify rate limiting middleware correctly identifies clients,
 * validates IPs, handles edge cases, and returns proper error responses
 *
 * Connects to: server/middleware/withRateLimit.js
 *
 * Test coverage:
 * - normalizeIp: IPv4/IPv6 validation, format rejection, length caps
 * - extractIdentifier: Auth user extraction, IP fallback, null on invalid
 * - withRateLimit: Header setting, 429/503/403 responses, error codes
 * - Double auth prevention: req._rateLimitUser caching
 */

const mockGetUserFromRequest = jest.fn();
jest.mock('../../lib/supabaseServer.js', () => ({
    getUserFromRequest: mockGetUserFromRequest,
}));

const mockCheckRateLimit = jest.fn();
jest.mock('../../lib/rateLimit.js', () => ({
    checkRateLimit: mockCheckRateLimit,
}));

jest.mock('../../../shared/logger.js', () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    },
}));

const { withRateLimit } = require('../withRateLimit.js');

describe('withRateLimit middleware', () => {
    const mockUser = { id: 'user-abc-123', email: 'test@example.com' };

    const createMockRequest = (method, headers = {}, socket = {}) => ({
        method,
        headers: {
            authorization: 'Bearer valid-token',
            ...headers,
        },
        socket: {
            remoteAddress: '192.168.1.1',
            ...socket,
        },
    });

    const createMockResponse = () => {
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
            setHeader: jest.fn(),
        };
        return res;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetUserFromRequest.mockResolvedValue({ user: mockUser, error: null });
        mockCheckRateLimit.mockResolvedValue({
            success: true,
            limit: 20,
            remaining: 19,
            reset: Date.now() + 3600000,
            window: 'hourly',
        });
    });

    // =========================================================================
    // normalizeIp validation (findings a + e)
    // =========================================================================
    describe('IP validation and normalization', () => {
        /**
         * Test: Valid IPv4 addresses pass through normalizeIp
         * Edge case: Verifies the regex accepts standard dotted-quad format
         */
        it('should accept valid IPv4 addresses', async () => {
            mockGetUserFromRequest.mockResolvedValue({ user: null, error: 'No auth' });
            const req = createMockRequest('GET', {}, { remoteAddress: '10.0.0.1' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'ip:10.0.0.1',
                expect.any(String),
                expect.any(String)
            );
        });

        /**
         * Test: IPv4-mapped IPv6 addresses get prefix stripped
         * Edge case: Node.js often reports IPv4 connections as ::ffff:x.x.x.x
         */
        it('should strip ::ffff: prefix from IPv4-mapped IPv6', async () => {
            mockGetUserFromRequest.mockResolvedValue({ user: null, error: 'No auth' });
            const req = createMockRequest('GET', {}, { remoteAddress: '::ffff:192.168.1.1' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'ip:192.168.1.1',
                expect.any(String),
                expect.any(String)
            );
        });

        /**
         * Test: Valid IPv6 addresses are accepted
         * Edge case: Full hex colon-notation must pass the regex
         * Note: x-real-ip only read when process.env.VERCEL is set
         */
        it('should accept valid IPv6 addresses', async () => {
            process.env.VERCEL = '1';
            mockGetUserFromRequest.mockResolvedValue({ user: null, error: 'No auth' });
            const req = createMockRequest('GET', { 'x-real-ip': '2001:db8::1' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'ip:2001:db8::1',
                expect.any(String),
                expect.any(String)
            );
            delete process.env.VERCEL;
        });

        /**
         * Test: Arbitrary strings in x-real-ip are rejected
         * Security: Prevents spoofed headers from creating arbitrary rate limit keys
         */
        it('should reject non-IP strings from x-real-ip header', async () => {
            mockGetUserFromRequest.mockResolvedValue({ user: null, error: 'No auth' });
            const req = createMockRequest(
                'GET',
                { 'x-real-ip': "'; DROP TABLE users;--" },
                { remoteAddress: undefined }
            );
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: 'UNIDENTIFIABLE_CLIENT',
                })
            );
            expect(handler).not.toHaveBeenCalled();
        });

        /**
         * Test: Extremely long strings are rejected
         * Security: Prevents memory abuse via oversized rate limit keys
         */
        it('should reject IPs longer than 45 characters', async () => {
            mockGetUserFromRequest.mockResolvedValue({ user: null, error: 'No auth' });
            const longString = 'a'.repeat(46);
            const req = createMockRequest(
                'GET',
                { 'x-real-ip': longString },
                { remoteAddress: undefined }
            );
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(handler).not.toHaveBeenCalled();
        });

        /**
         * Test: Empty strings are rejected
         * Edge case: Header present but empty value
         */
        it('should reject empty string IPs', async () => {
            mockGetUserFromRequest.mockResolvedValue({ user: null, error: 'No auth' });
            const req = createMockRequest(
                'GET',
                { 'x-real-ip': '' },
                { remoteAddress: undefined }
            );
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(handler).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // extractIdentifier and double auth (findings b + c)
    // =========================================================================
    describe('identifier extraction', () => {
        /**
         * Test: Authenticated users get user-based identifier
         * Verifies: user:{id} format used for auth users
         */
        it('should use user ID for authenticated requests', async () => {
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                `user:${mockUser.id}`,
                expect.any(String),
                expect.any(String)
            );
        });

        /**
         * Test: Auth result cached on req._rateLimitUser (finding b)
         * Prevents: Double auth call when handler also needs user object
         */
        it('should attach authenticated user to req._rateLimitUser', async () => {
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(req._rateLimitUser).toEqual(mockUser);
        });

        /**
         * Test: Unauthenticated requests fall back to IP
         * Verifies: ip:{address} format used when no auth
         */
        it('should fall back to IP for unauthenticated requests', async () => {
            mockGetUserFromRequest.mockResolvedValue({ user: null, error: 'No auth' });
            const req = createMockRequest('GET', {}, { remoteAddress: '10.0.0.5' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'ip:10.0.0.5',
                expect.any(String),
                expect.any(String)
            );
        });

        /**
         * Test: No valid identifier returns 403 (finding c)
         * Prevents: Shared 'anonymous' bucket that rate-limits all unidentified users
         */
        it('should return 403 when no valid identifier is available', async () => {
            mockGetUserFromRequest.mockResolvedValue({ user: null, error: 'No auth' });
            const req = createMockRequest(
                'GET',
                {},
                { remoteAddress: undefined }
            );
            delete req.headers['x-real-ip'];
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: 'UNIDENTIFIABLE_CLIENT',
                })
            );
            expect(handler).not.toHaveBeenCalled();
        });

        /**
         * Test: x-real-ip takes priority over socket.remoteAddress
         * Verifies: Header is checked first (Vercel sets this)
         * Note: x-real-ip only read when process.env.VERCEL is set
         */
        it('should prefer x-real-ip over socket.remoteAddress', async () => {
            process.env.VERCEL = '1';
            mockGetUserFromRequest.mockResolvedValue({ user: null, error: 'No auth' });
            const req = createMockRequest(
                'GET',
                { 'x-real-ip': '203.0.113.1' },
                { remoteAddress: '10.0.0.1' }
            );
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'ip:203.0.113.1',
                expect.any(String),
                expect.any(String)
            );
            delete process.env.VERCEL;
        });
    });

    // =========================================================================
    // Error codes and response format (finding f)
    // =========================================================================
    describe('error response format', () => {
        /**
         * Test: 429 response uses short error code, not full message
         * Fixes: Clients can programmatically distinguish error types
         */
        it('should return short error code for rate limit exceeded', async () => {
            mockCheckRateLimit.mockResolvedValue({
                success: false,
                limit: 20,
                remaining: 0,
                reset: Date.now() + 1000,
                window: 'hourly',
            });
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.status).toHaveBeenCalledWith(429);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: 'RATE_LIMIT_EXCEEDED',
                })
            );
        });

        /**
         * Test: 503 response uses short error code
         */
        it('should return short error code for service unavailable', async () => {
            mockCheckRateLimit.mockResolvedValue({
                success: false,
                unavailable: true,
            });
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: 'SERVICE_UNAVAILABLE',
                })
            );
        });

        /**
         * Test: Unexpected errors return 503 with short code
         */
        it('should return SERVICE_UNAVAILABLE on unexpected errors', async () => {
            mockCheckRateLimit.mockRejectedValue(new Error('Redis connection failed'));
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: 'SERVICE_UNAVAILABLE',
                })
            );
        });
    });

    // =========================================================================
    // Rate limit headers and passthrough
    // =========================================================================
    describe('rate limit headers', () => {
        /**
         * Test: Rate limit headers are set on successful responses
         */
        it('should set rate limit headers on response', async () => {
            const resetTime = Date.now() + 3600000;
            mockCheckRateLimit.mockResolvedValue({
                success: true,
                limit: 20,
                remaining: 19,
                reset: resetTime,
                window: 'hourly',
            });
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 20);
            expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 19);
            expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', resetTime);
            expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Window', 'hourly');
        });

        /**
         * Test: Retry-After header set on 429 responses
         */
        it('should set Retry-After header when rate limited', async () => {
            mockCheckRateLimit.mockResolvedValue({
                success: false,
                limit: 20,
                remaining: 0,
                reset: Date.now() + 30000,
                window: 'hourly',
            });
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.setHeader).toHaveBeenCalledWith(
                'Retry-After',
                expect.any(Number)
            );
        });
    });

    // =========================================================================
    // Method handling
    // =========================================================================
    describe('unmapped methods', () => {
        /**
         * Test: Unmapped HTTP methods skip rate limiting entirely
         * Edge case: OPTIONS, HEAD, etc. should pass through
         */
        it('should skip rate limiting for unmapped methods', async () => {
            const req = createMockRequest('OPTIONS');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(mockCheckRateLimit).not.toHaveBeenCalled();
            expect(handler).toHaveBeenCalledWith(req, res);
        });
    });

    // =========================================================================
    // Retry-After edge cases
    // =========================================================================
    describe('Retry-After calculation', () => {
        /**
         * Test: Retry-After defaults to 60s when reset is null
         * Edge case: checkRateLimit may return null reset on certain failures
         */
        it('should default Retry-After to 60 when reset is null', async () => {
            mockCheckRateLimit.mockResolvedValue({
                success: false,
                limit: 20,
                remaining: 0,
                reset: null,
                window: 'hourly',
            });
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 60);
            expect(res.status).toHaveBeenCalledWith(429);
        });

        /**
         * Test: Retry-After clamps to 0 when reset is in the past
         * Edge case: Math.max(0, ...) prevents negative Retry-After values
         */
        it('should clamp Retry-After to 0 when reset is in the past', async () => {
            mockCheckRateLimit.mockResolvedValue({
                success: false,
                limit: 20,
                remaining: 0,
                reset: Date.now() - 10000,
                window: 'hourly',
            });
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 0);
        });
    });

    // =========================================================================
    // Handler passthrough on success
    // =========================================================================
    describe('successful passthrough', () => {
        /**
         * Test: Handler receives original req and res on success
         * Verifies: Middleware doesn't swallow the request
         */
        it('should call handler with req and res when rate limit passes', async () => {
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(handler).toHaveBeenCalledWith(req, res);
            expect(handler).toHaveBeenCalledTimes(1);
        });

        /**
         * Test: Handler is NOT called when rate limited
         * Verifies: 429 response short-circuits the request
         */
        it('should not call handler when rate limited', async () => {
            mockCheckRateLimit.mockResolvedValue({
                success: false,
                limit: 20,
                remaining: 0,
                reset: Date.now() + 1000,
                window: 'hourly',
            });
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(handler).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Auth extraction failure fallback
    // =========================================================================
    describe('auth extraction errors', () => {
        /**
         * Test: getUserFromRequest throwing falls back to IP
         * Edge case: Auth service crash should not block requests
         */
        it('should fall back to IP when getUserFromRequest throws', async () => {
            mockGetUserFromRequest.mockRejectedValue(new Error('Auth service down'));
            const req = createMockRequest('GET', {}, { remoteAddress: '10.0.0.99' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'ip:10.0.0.99',
                expect.any(String),
                expect.any(String)
            );
            expect(handler).toHaveBeenCalled();
        });

        /**
         * Test: _rateLimitUser is NOT set when auth fails
         * Verifies: No stale user data leaks into the request
         */
        it('should not set _rateLimitUser for unauthenticated requests', async () => {
            mockGetUserFromRequest.mockResolvedValue({ user: null, error: 'No auth' });
            const req = createMockRequest('GET', {}, { remoteAddress: '10.0.0.1' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(req._rateLimitUser).toBeUndefined();
        });
    });

    // =========================================================================
    // HTTP method → operation mapping
    // =========================================================================
    describe('HTTP method mapping', () => {
        /**
         * Test: All mapped methods trigger rate limiting with correct operation
         * Verifies: POST→insert, PUT→update, PATCH→update, DELETE→delete
         */
        it.each([
            ['POST', 'insert'],
            ['PUT', 'update'],
            ['PATCH', 'update'],
            ['DELETE', 'delete'],
            ['GET', 'read'],
        ])('should map %s to %s operation', async (method, operation) => {
            const req = createMockRequest(method);
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                `user:${mockUser.id}`,
                'free',
                operation
            );
        });
    });

    // =========================================================================
    // setRateLimitHeaders edge cases
    // =========================================================================
    describe('rate limit header edge cases', () => {
        /**
         * Test: remaining=0 still sets the header (falsy but valid)
         * Edge case: 0 is falsy in JS but is a meaningful value
         */
        it('should set X-RateLimit-Remaining when remaining is 0', async () => {
            mockCheckRateLimit.mockResolvedValue({
                success: true,
                limit: 20,
                remaining: 0,
                reset: Date.now() + 1000,
                window: 'hourly',
            });
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 0);
        });

        /**
         * Test: limit=0 still sets the header (falsy but valid)
         * Edge case: A tier could theoretically have a 0 limit
         */
        it('should set X-RateLimit-Limit when limit is 0', async () => {
            mockCheckRateLimit.mockResolvedValue({
                success: true,
                limit: 0,
                remaining: 0,
                reset: Date.now() + 1000,
                window: 'hourly',
            });
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 0);
        });
    });

    // =========================================================================
    // IP whitespace trimming
    // =========================================================================
    describe('IP normalization edge cases', () => {
        /**
         * Test: Leading/trailing whitespace in IP is trimmed
         * Edge case: Some proxies may pad IP with whitespace
         */
        it('should trim whitespace from IP addresses', async () => {
            mockGetUserFromRequest.mockResolvedValue({ user: null, error: 'No auth' });
            const req = createMockRequest('GET', {}, { remoteAddress: '  10.0.0.1  ' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'ip:10.0.0.1',
                expect.any(String),
                expect.any(String)
            );
        });
    });
});
