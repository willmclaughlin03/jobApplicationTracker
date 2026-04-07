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
 * - allowedMethods guard: fail-closed default, quota protection
 */

const mockGetUserFromRequest = jest.fn();
jest.mock('../../lib/supabaseServer.js', () => ({
    getUserFromRequest: mockGetUserFromRequest,
}));

const mockCheckRateLimit = jest.fn();
jest.mock('../../lib/rateLimit.js', () => ({
    checkRateLimit: mockCheckRateLimit,
}));

// Stub out csrf.js so the module-level CSRF_SECRET check doesn't throw.
// CSRF behaviour is tested separately in withRateLimit.csrf.test.js.
jest.mock('../../lib/csrf.js', () => ({
    validateCsrfToken: jest.fn().mockReturnValue(true),
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../shared/logger.js', () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        child: jest.fn(() => mockLog),
    },
    attachRequestLogger: jest.fn((req) => {
        req.log = mockLog;
        return 'test-request-id';
    }),
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
            end: jest.fn().mockReturnThis(),
        };
        return res;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetUserFromRequest.mockResolvedValue({ user: mockUser, error: null, supabaseClient: { auth: { getUser: jest.fn() } } });
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
    describe('IP validation and normalization (requireAuth: false)', () => {
        /**
         * Test: Valid IPv4 addresses pass through normalizeIp
         * Edge case: Verifies the regex accepts standard dotted-quad format
         * Note: IP path only reachable with requireAuth: false (public routes)
         */
        it('should accept valid IPv4 addresses', async () => {
            const req = createMockRequest('GET', {}, { remoteAddress: '10.0.0.1' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

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
            const req = createMockRequest('GET', {}, { remoteAddress: '::ffff:192.168.1.1' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

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
            const req = createMockRequest('GET', { 'x-real-ip': '2001:db8::1' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

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
            const req = createMockRequest(
                'GET',
                { 'x-real-ip': "'; DROP TABLE users;--" },
                { remoteAddress: undefined }
            );
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

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
            const longString = 'a'.repeat(46);
            const req = createMockRequest(
                'GET',
                { 'x-real-ip': longString },
                { remoteAddress: undefined }
            );
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(handler).not.toHaveBeenCalled();
        });

        /**
         * Test: Empty strings are rejected
         * Edge case: Header present but empty value
         */
        it('should reject empty string IPs', async () => {
            const req = createMockRequest(
                'GET',
                { 'x-real-ip': '' },
                { remoteAddress: undefined }
            );
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

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

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

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

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            expect(req._rateLimitUser).toEqual(mockUser);
            expect(req._supabaseClient).toBeDefined();
        });

        /**
         * Test: Public routes use IP-based identifier
         * Verifies: ip:{address} format used with requireAuth: false
         */
        it('should use IP for public routes (requireAuth: false)', async () => {
            const req = createMockRequest('GET', {}, { remoteAddress: '10.0.0.5' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'ip:10.0.0.5',
                expect.any(String),
                expect.any(String)
            );
        });

        /**
         * Test: No valid identifier returns 403 on public routes (finding c)
         * Prevents: Shared 'anonymous' bucket that rate-limits all unidentified users
         */
        it('should return 403 when no valid IP on public route', async () => {
            const req = createMockRequest(
                'GET',
                {},
                { remoteAddress: undefined }
            );
            delete req.headers['x-real-ip'];
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

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
            const req = createMockRequest(
                'GET',
                { 'x-real-ip': '203.0.113.1' },
                { remoteAddress: '10.0.0.1' }
            );
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'ip:203.0.113.1',
                expect.any(String),
                expect.any(String)
            );
            delete process.env.VERCEL;
        });
    });

    // =========================================================================
    // Vercel IP extraction security (IS_VERCEL_DEPLOYED guard)
    // =========================================================================
    describe('Vercel IP extraction security', () => {
        afterEach(() => {
            delete process.env.VERCEL;
            delete process.env.VERCEL_ENV;
        });

        /**
         * Test: Vercel production — missing x-real-ip returns 403, no socket fallback
         * Security: socket.remoteAddress on Vercel is the internal load balancer IP.
         * Falling back would bucket every client under the same key, bypassing rate limiting.
         */
        it('should return 403 on Vercel production when x-real-ip is absent', async () => {
            process.env.VERCEL = '1';
            process.env.VERCEL_ENV = 'production';
            const req = createMockRequest(
                'GET',
                {},
                { remoteAddress: '10.10.10.1' } // Vercel internal IP — must NOT be used
            );
            delete req.headers['x-real-ip'];
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'UNIDENTIFIABLE_CLIENT' })
            );
            expect(mockCheckRateLimit).not.toHaveBeenCalled();
            expect(handler).not.toHaveBeenCalled();
        });

        /**
         * Test: Vercel preview — same strict behaviour as production
         * Security: Preview deployments go through the same Vercel load balancer;
         * socket.remoteAddress is equally unreliable.
         */
        it('should return 403 on Vercel preview when x-real-ip is absent', async () => {
            process.env.VERCEL = '1';
            process.env.VERCEL_ENV = 'preview';
            const req = createMockRequest(
                'GET',
                {},
                { remoteAddress: '10.10.10.1' }
            );
            delete req.headers['x-real-ip'];
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(mockCheckRateLimit).not.toHaveBeenCalled();
        });

        /**
         * Test: Vercel dev — socket.remoteAddress fallback is allowed
         * Context: `vercel dev` sets VERCEL=1 but does not go through the load
         * balancer, so socket.remoteAddress is the real client IP and is safe.
         */
        it('should use socket.remoteAddress on Vercel dev when x-real-ip is absent', async () => {
            process.env.VERCEL = '1';
            process.env.VERCEL_ENV = 'development';
            const req = createMockRequest(
                'GET',
                {},
                { remoteAddress: '127.0.0.1' }
            );
            delete req.headers['x-real-ip'];
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'ip:127.0.0.1',
                expect.any(String),
                expect.any(String)
            );
            expect(handler).toHaveBeenCalled();
        });

        /**
         * Test: Vercel production — x-real-ip present → used correctly, no 403
         * Verifies: The happy path still works after narrowing the guard.
         */
        it('should use x-real-ip on Vercel production when header is present', async () => {
            process.env.VERCEL = '1';
            process.env.VERCEL_ENV = 'production';
            const req = createMockRequest(
                'GET',
                { 'x-real-ip': '203.0.113.42' },
                { remoteAddress: '10.10.10.1' }
            );
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'ip:203.0.113.42',
                expect.any(String),
                expect.any(String)
            );
            expect(handler).toHaveBeenCalled();
        });

        /**
         * Test: VERCEL=1 with VERCEL_ENV unset → treated as deployed, returns 403 not socket fallback
         * Edge case (gap 6a): When VERCEL_ENV is undefined, `undefined !== 'development'` is true,
         * so IS_VERCEL_DEPLOYED is truthy. The guard must NOT silently fall back to
         * socket.remoteAddress in this ambiguous state — 403 is the safe response.
         */
        it('should return 403 when VERCEL=1 and VERCEL_ENV is unset and x-real-ip is absent', async () => {
            process.env.VERCEL = '1';
            // VERCEL_ENV deliberately not set — undefined !== 'development' → IS_VERCEL_DEPLOYED truthy
            const req = createMockRequest(
                'GET',
                {},
                { remoteAddress: '10.10.10.1' } // internal Vercel address — must NOT be used
            );
            delete req.headers['x-real-ip'];
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'UNIDENTIFIABLE_CLIENT' })
            );
            expect(mockCheckRateLimit).not.toHaveBeenCalled();
            expect(handler).not.toHaveBeenCalled();
        });

        /**
         * Test: x-real-ip header is ignored when VERCEL is not set (gap 6b)
         * Security: Other deployment platforms (e.g. Render, Fly.io) can also set
         * x-real-ip. Trusting it unconditionally would let a different proxy's header
         * override the real socket address, breaking per-client isolation.
         * Verifies: IS_VERCEL_DEPLOYED gate means x-real-ip is ONLY trusted on Vercel.
         */
        it('should ignore x-real-ip and use socket.remoteAddress when VERCEL is not set', async () => {
            delete process.env.VERCEL; // guarantee non-Vercel environment
            const req = createMockRequest(
                'GET',
                { 'x-real-ip': '203.0.113.99' }, // present but must be ignored
                { remoteAddress: '10.0.0.7' }     // this is the authoritative source
            );
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'ip:10.0.0.7',
                expect.any(String),
                expect.any(String)
            );
            // x-real-ip value must NOT appear as the identifier
            expect(mockCheckRateLimit).not.toHaveBeenCalledWith(
                'ip:203.0.113.99',
                expect.any(String),
                expect.any(String)
            );
            expect(handler).toHaveBeenCalled();
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

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

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

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

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

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

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

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

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

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

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
         * Test: OPTIONS returns 405 without rate limiting or calling handler
         * Edge case: OPTIONS is not in allowedMethods, so it is rejected
         * before any auth or rate-limit work is performed
         */
        it('should return 405 for OPTIONS without rate limiting', async () => {
            const req = createMockRequest('OPTIONS');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(mockCheckRateLimit).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(405);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'METHOD_NOT_ALLOWED' }));
            expect(handler).not.toHaveBeenCalled();
        });

        /**
         * Test: HEAD with no allowedMethods returns 405 (fail-closed default)
         * Verifies: Unmapped or undeclared methods are rejected before quota
         */
        it('should return 405 for other unmapped methods', async () => {
            const req = createMockRequest('HEAD');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.status).toHaveBeenCalledWith(405);
            expect(handler).not.toHaveBeenCalled();
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

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

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

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

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

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

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

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            expect(handler).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // requireAuth: true (protected routes) — auth failure behavior
    // =========================================================================
    describe('requireAuth: true (protected routes)', () => {
        /**
         * Test: Auth failure returns 401, does NOT fall back to IP
         * Verifies: Protected routes block unauthenticated requests entirely
         */
        it('should return 401 when auth fails on protected route', async () => {
            mockGetUserFromRequest.mockResolvedValue({ user: null, error: 'No auth' });
            const req = createMockRequest('GET', {}, { remoteAddress: '10.0.0.1' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            expect(res.status).toHaveBeenCalledWith(401);
            expect(mockCheckRateLimit).not.toHaveBeenCalled();
            expect(handler).not.toHaveBeenCalled();
        });

        /**
         * Test: Auth service crash returns 401, does NOT fall back to IP
         * Verifies: Even when auth throws, protected routes don't degrade to IP
         */
        it('should return 401 when getUserFromRequest throws on protected route', async () => {
            mockGetUserFromRequest.mockRejectedValue(new Error('Auth service down'));
            const req = createMockRequest('GET', {}, { remoteAddress: '10.0.0.99' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            expect(res.status).toHaveBeenCalledWith(401);
            expect(mockCheckRateLimit).not.toHaveBeenCalled();
            expect(handler).not.toHaveBeenCalled();
        });

        /**
         * Test: _rateLimitUser is NOT set when auth fails on protected route
         * Verifies: No stale user data leaks into the request
         */
        it('should not set _rateLimitUser when auth fails', async () => {
            mockGetUserFromRequest.mockResolvedValue({ user: null, error: 'No auth' });
            const req = createMockRequest('GET', {}, { remoteAddress: '10.0.0.1' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

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

            await withRateLimit(handler, { allowedMethods: [method] })(req, res);

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

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

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

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 0);
        });
    });

    // =========================================================================
    // Handler throws — error propagation behavior
    // =========================================================================
    describe('handler error propagation', () => {
        /**
         * Test: When the wrapped async handler rejects, middleware catches it
         * and returns 500 INTERNAL_SERVER_ERROR (not leaked to Next.js)
         */
        it('should return 500 when handler throws an Error', async () => {
            const error = new Error('Handler exploded');
            const handler = jest.fn().mockRejectedValue(error);
            const req = createMockRequest('GET');
            const res = createMockResponse();

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            expect(handler).toHaveBeenCalledWith(req, res);
            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'INTERNAL_SERVER_ERROR' })
            );
        });

        /**
         * Test: Non-Error throws (e.g. string) are also caught
         */
        it('should return 500 when handler throws a non-Error value', async () => {
            const handler = jest.fn().mockRejectedValue('string error');
            const req = createMockRequest('GET');
            const res = createMockResponse();

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'INTERNAL_SERVER_ERROR' })
            );
        });

        /**
         * Test: Handler error is logged with context for observability
         */
        it('should log handler errors with method and operation context', async () => {
            const error = new Error('Handler exploded');
            const handler = jest.fn().mockRejectedValue(error);
            const req = createMockRequest('GET');
            const res = createMockResponse();

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            expect(mockLog.error).toHaveBeenCalledWith(
                expect.objectContaining({ err: error, method: 'GET' }),
                'Unhandled handler error'
            );
        });

        /**
         * Test: If handler partially sent response before throwing,
         * middleware does not attempt to send again (avoids ERR_HTTP_HEADERS_SENT)
         */
        it('should not send error response when headers already sent', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('Mid-stream crash'));
            const req = createMockRequest('GET');
            const res = createMockResponse();
            res.headersSent = true;

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            // Should NOT attempt to send a response
            expect(res.status).not.toHaveBeenCalled();
            // Should close the connection cleanly
            expect(res.end).toHaveBeenCalled();
        });

        /**
         * Test: Handler rejecting with undefined is still caught and returns 500
         */
        it('should return 500 when handler rejects with undefined', async () => {
            const handler = jest.fn().mockRejectedValue(undefined);
            const req = createMockRequest('GET');
            const res = createMockResponse();

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'INTERNAL_SERVER_ERROR' })
            );
        });

        /**
         * Test: Handler error response does not leak internal details
         */
        it('should not include stack traces in handler error responses', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('Secret internal detail'));
            const req = createMockRequest('GET');
            const res = createMockResponse();

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            const responseBody = res.json.mock.calls[0][0];
            const serialized = JSON.stringify(responseBody);
            expect(serialized).not.toContain('Secret internal detail');
            expect(serialized).not.toContain('at ');
            expect(serialized).not.toContain('.js:');
        });

        /**
         * Test: Middleware-level errors (Redis) still return 503 and log correctly
         */
        it('should not include stack traces in middleware error responses', async () => {
            mockCheckRateLimit.mockRejectedValue(new Error('Redis connection failed'));
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            const responseBody = res.json.mock.calls[0][0];
            const serialized = JSON.stringify(responseBody);
            expect(serialized).not.toContain('Redis connection failed');
            expect(serialized).not.toContain('at ');
            expect(serialized).not.toContain('.js:');
        });

        /**
         * Test: checkRateLimit throw is caught and results in 503 (fail-closed)
         * One-time logging happens in redis.js, not in the middleware.
         */
        it('should return 503 when checkRateLimit throws', async () => {
            mockCheckRateLimit.mockRejectedValue(new Error('Redis connection failed'));
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            expect(res.status).toHaveBeenCalledWith(503);
            expect(handler).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // IP whitespace trimming
    // =========================================================================
    describe('IP normalization edge cases (requireAuth: false)', () => {
        /**
         * Test: Leading/trailing whitespace in IP is trimmed
         * Edge case: Some proxies may pad IP with whitespace
         */
        it('should trim whitespace from IP addresses', async () => {
            const req = createMockRequest('GET', {}, { remoteAddress: '  10.0.0.1  ' });
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { requireAuth: false, allowedMethods: ['GET'] })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'ip:10.0.0.1',
                expect.any(String),
                expect.any(String)
            );
        });
    });

    // =========================================================================
    // allowedMethods guard (fail-closed behaviour)
    // =========================================================================
    describe('allowedMethods guard (fail-closed)', () => {
        /**
         * Test: allowedMethods omitted → 405 for any mapped method, no auth, no quota
         * Verifies: Fail-closed default — developers must explicitly declare what
         * methods a route accepts, preventing silent quota drain on mis-routed requests
         */
        it('should return 405 and skip auth and quota when allowedMethods is not provided', async () => {
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler)(req, res);

            expect(res.status).toHaveBeenCalledWith(405);
            expect(mockGetUserFromRequest).not.toHaveBeenCalled();
            expect(mockCheckRateLimit).not.toHaveBeenCalled();
            expect(handler).not.toHaveBeenCalled();
        });

        /**
         * Test: Empty allowedMethods array → 405
         * Edge case: Explicit empty array is still fail-closed
         */
        it('should return 405 when allowedMethods is an empty array', async () => {
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { allowedMethods: [] })(req, res);

            expect(res.status).toHaveBeenCalledWith(405);
            expect(mockCheckRateLimit).not.toHaveBeenCalled();
            expect(handler).not.toHaveBeenCalled();
        });

        /**
         * Test: Method not in allowedMethods → 405, no quota consumed, no auth
         * Core fix: Prevents quota drain from mis-routed mapped methods
         * (e.g. DELETE /api/jobs draining delete quota before route returns 405)
         */
        it('should return 405 and skip quota when method is not in allowedMethods', async () => {
            const req = createMockRequest('DELETE');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { allowedMethods: ['GET', 'POST'] })(req, res);

            expect(res.status).toHaveBeenCalledWith(405);
            expect(mockCheckRateLimit).not.toHaveBeenCalled();
            expect(mockGetUserFromRequest).not.toHaveBeenCalled();
            expect(handler).not.toHaveBeenCalled();
        });

        /**
         * Test: Method in allowedMethods → proceeds through auth, quota, and handler
         * Verifies: Happy path still works with allowedMethods declared
         */
        it('should proceed when method is in allowedMethods', async () => {
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalled();
            expect(handler).toHaveBeenCalledWith(req, res);
        });

        /**
         * Test: Only methods listed in allowedMethods are permitted
         * Verifies: Method-level granularity — POST allowed, GET rejected on same config
         */
        it('should only permit methods listed in allowedMethods', async () => {
            const handler = jest.fn();

            const postReq = createMockRequest('POST');
            const postRes = createMockResponse();
            await withRateLimit(handler, { allowedMethods: ['POST'] })(postReq, postRes);

            const getReq = createMockRequest('GET');
            const getRes = createMockResponse();
            await withRateLimit(handler, { allowedMethods: ['POST'] })(getReq, getRes);

            expect(handler).toHaveBeenCalledTimes(1);
            expect(getRes.status).toHaveBeenCalledWith(405);
            expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
        });
    });

    // =========================================================================
    // Admin tier selection + non-admin probing fallback
    // =========================================================================
    describe('admin tier selection', () => {
        /**
         * Test: Admin user + admin operation → uses ADMIN tier
         * Why: Admin quotas must apply only when both the user role and the
         *      requested operation are admin-scoped.
         */
        it('should use admin tier when admin user calls an admin operation', async () => {
            mockGetUserFromRequest.mockResolvedValue({
                user: { id: 'admin-1', app_metadata: { role: 'admin' } },
                error: null,
                supabaseClient: { auth: { getUser: jest.fn() } },
            });
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                allowedMethods: ['GET'],
                operation: 'admin_read',
            })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'user:admin-1',
                'admin',
                'admin_read'
            );
        });

        /**
         * Test: Admin user + non-admin operation → still uses FREE tier
         * Prevents: Admins implicitly getting inflated quotas on normal CRUD
         */
        it('should use free tier when admin user calls a non-admin operation', async () => {
            mockGetUserFromRequest.mockResolvedValue({
                user: { id: 'admin-2', app_metadata: { role: 'admin' } },
                error: null,
                supabaseClient: { auth: { getUser: jest.fn() } },
            });
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'user:admin-2',
                'free',
                'read'
            );
        });

        /**
         * Test: Non-admin user + admin operation → falls back to AUTH quota
         * Security: Repeated probing of admin endpoints by non-admins is throttled
         *           under the FREE:auth bucket. The route-level 403 still blocks
         *           access; rate limiting prevents enumeration abuse.
         */
        it('should fall back to free:auth when non-admin probes an admin operation', async () => {
            mockGetUserFromRequest.mockResolvedValue({
                user: { id: 'user-1', app_metadata: { role: 'user' } },
                error: null,
                supabaseClient: { auth: { getUser: jest.fn() } },
            });
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                allowedMethods: ['GET'],
                operation: 'admin_write',
            })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'user:user-1',
                'free',
                'auth'
            );
        });

        /**
         * Test: User with no app_metadata.role is treated as non-admin
         * Edge case: Missing/undefined metadata must not leak admin access
         */
        it('should treat user with no role metadata as non-admin when probing admin op', async () => {
            mockGetUserFromRequest.mockResolvedValue({
                user: { id: 'user-2' }, // no app_metadata
                error: null,
                supabaseClient: { auth: { getUser: jest.fn() } },
            });
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                allowedMethods: ['GET'],
                operation: 'admin_read',
            })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                'user:user-2',
                'free',
                'auth'
            );
        });
    });

    // =========================================================================
    // operationByMethod per-method mapping
    // =========================================================================
    describe('operationByMethod mapping', () => {
        /**
         * Test: operationByMethod overrides the derived METHOD_TO_OPERATIONS
         * Use case: A route that accepts both GET and POST but wants both treated
         *           as a single operation category (e.g. 'auth').
         */
        it('should use operationByMethod entry for the request method', async () => {
            const req = createMockRequest('POST');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                allowedMethods: ['GET', 'POST'],
                operationByMethod: { GET: 'read', POST: 'auth' },
            })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                expect.any(String),
                'free',
                'auth'
            );
        });

        /**
         * Test: operationByMethod takes precedence over operation override
         * Verifies the precedence chain:
         *   operationByMethod > operationOverride > METHOD_TO_OPERATIONS
         */
        it('should prefer operationByMethod over operation override', async () => {
            const req = createMockRequest('POST');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                allowedMethods: ['POST'],
                operation: 'insert',
                operationByMethod: { POST: 'auth' },
            })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                expect.any(String),
                'free',
                'auth'
            );
        });

        /**
         * Test: operationByMethod miss falls through to operation override
         * Edge case: A partial operationByMethod map does not clobber fallbacks
         */
        it('should fall through to operation override when method not in operationByMethod', async () => {
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                allowedMethods: ['GET', 'POST'],
                operation: 'auth',
                operationByMethod: { POST: 'insert' },
            })(req, res);

            expect(mockCheckRateLimit).toHaveBeenCalledWith(
                expect.any(String),
                'free',
                'auth'
            );
        });
    });
});
