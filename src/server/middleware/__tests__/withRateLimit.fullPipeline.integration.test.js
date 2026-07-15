/**
 * Full-pipeline integration tests for withRateLimit middleware
 *
 * Purpose: Exercise the complete middleware composition — auth + CSRF + real
 * rate limiting against live Upstash Redis. The existing withRateLimit
 * integration test mocks checkRateLimit; this file does not.
 *
 * Connects to:
 * - src/server/middleware/withRateLimit.js (full pipeline)
 * - src/server/lib/csrf.js (real HMAC)
 * - src/server/lib/rateLimit.js (real Upstash)
 * - src/server/lib/redis.js (real Upstash)
 * - src/server/lib/supabaseServer.js (mock at Supabase HTTP boundary only)
 *
 * Requires: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
 *           TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_KEY,
 *           TEST_CSRF env vars
 * Run with: npm run test:integration
 *
 * Mock boundary (external HTTP only):
 * - createApiRouteClient (supabaseApiRoute.js) — Supabase Auth HTTP calls
 * - logger — suppress output, enable spy assertions
 *
 * Real modules exercised:
 * - withRateLimit — full middleware wrapper
 * - getUserFromRequest — real destructuring, req assignment
 * - generateCsrfToken / validateCsrfToken — real HMAC-SHA256
 * - checkRateLimit — real Upstash Redis
 * - getRedisClient / logRedisDownOnce / setLastCallStatus — real Upstash Redis
 *
 * Test coverage:
 * - Full pipeline: auth → CSRF → real rate limit → handler (happy path)
 * - Rate limit headers on real response (X-RateLimit-*)
 * - 429 + Retry-After after exhausting real rate limit
 * - 503 fail-closed when Redis unavailable (no retry)
 * - IP extraction for public routes (IPv4, IPv6, ::ffff: strip, 45-char max)
 * - GET skips CSRF but still rate limits
 */

const {
    TEST_SUPABASE_ENV_NAMES,
    resolveTestCsrfSecret,
    restoreEnvironmentVariable,
} = require('../../../testSupport/integrationEnvironment.js');

const originalCsrfSecret = process.env.CSRF_SECRET;
const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalSupabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_CSRF_FALLBACK = 'integration-test-secret-that-is-at-least-32-chars-long!!';
const TEST_URL = process.env[TEST_SUPABASE_ENV_NAMES.url];
const TEST_SERVICE_KEY = process.env[TEST_SUPABASE_ENV_NAMES.serviceKey];

// Install test-only HMAC configuration before csrf.js validates at import time.
process.env.CSRF_SECRET = resolveTestCsrfSecret(process.env, TEST_CSRF_FALLBACK);

// These fixed fake values satisfy product-module import validation only. Live
// Supabase setup below uses TEST_SUPABASE_* and never these application names.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test-module-bootstrap.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-module-bootstrap-service-role-key';

const SKIP_INTEGRATION =
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN ||
    !TEST_URL ||
    !TEST_SERVICE_KEY;

const describeIntegration = SKIP_INTEGRATION ? describe.skip : describe;

afterAll(() => {
    restoreEnvironmentVariable(process.env, 'CSRF_SECRET', originalCsrfSecret);
    restoreEnvironmentVariable(process.env, 'NEXT_PUBLIC_SUPABASE_URL', originalSupabaseUrl);
    restoreEnvironmentVariable(
        process.env,
        'SUPABASE_SERVICE_ROLE_KEY',
        originalSupabaseServiceRoleKey
    );
});

// ---------------------------------------------------------------------------
// Mocks — HTTP boundary only (Supabase Auth)
// ---------------------------------------------------------------------------

const mockCreateApiRouteClient = jest.fn();
jest.mock('../../lib/supabaseApiRoute.js', () => ({
    createApiRouteClient: mockCreateApiRouteClient,
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => mockLog),
};
jest.mock('../../../shared/logger.js', () => ({
    logger: mockLogger,
    attachRequestLogger: jest.fn((req) => {
        req.log = mockLog;
        return 'test-request-id';
    }),
}));

// ---------------------------------------------------------------------------
// Real modules under test
// ---------------------------------------------------------------------------

const { CSRF_COOKIE_NAME } = require('../../../shared/constants/csrf.js');
let createClient;
let withRateLimit;
let generateCsrfToken;
let redis;

describeIntegration('withRateLimit — full pipeline integration (real Upstash)', () => {
    let testUserId;
    let testRunSuffix;
    let mockSupabaseClient;

    // Load fail-fast application modules only after Jest elects to run this
    // infrastructure-backed suite, so missing service env produces a skip.
    beforeAll(() => {
        ({ createClient } = require('@supabase/supabase-js'));
        ({ withRateLimit } = require('../withRateLimit.js'));
        ({ generateCsrfToken } = require('../../lib/csrf.js'));
        redis = require('../../lib/redis.js');
    });

    beforeAll(async () => {
        const supabase = createClient(
            TEST_URL,
            TEST_SERVICE_KEY
        );
        const testEmail = `pipeline-test-${Date.now()}@integration-test.local`;
        const { data, error } = await supabase.auth.admin.createUser({
            email: testEmail,
            email_confirm: true,
        });
        if (error) throw new Error(`Test user creation failed: ${error.message}`);
        testUserId = data.user.id;
        testRunSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    });

    // -- Factories -------------------------------------------------------

    function createMockSupabaseClient(user) {
        return {
            auth: {
                getUser: jest.fn().mockResolvedValue({
                    data: { user },
                    error: null,
                }),
            },
            from: jest.fn(),
        };
    }

    function createMockRequest(method) {
        return {
            method,
            headers: {},
            cookies: {},
            socket: { remoteAddress: '127.0.0.1' },
        };
    }

    function createMockResponse() {
        const headers = {};
        return {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
            setHeader: jest.fn((name, value) => { headers[name] = value; }),
            getHeader: jest.fn(name => headers[name] ?? []),
            end: jest.fn().mockReturnThis(),
            headersSent: false,
            _headers: headers,
        };
    }

    function attachCsrfToken(req, userId) {
        const token = generateCsrfToken(userId);
        req.cookies[CSRF_COOKIE_NAME] = token;
        req.headers['x-csrf-token'] = token;
        return token;
    }

    // -- Lifecycle -------------------------------------------------------

    beforeEach(() => {
        jest.clearAllMocks();

        mockSupabaseClient = createMockSupabaseClient({
            id: testUserId,
            email: 'test@integration-test.local',
        });
        mockCreateApiRouteClient.mockReturnValue(mockSupabaseClient);
    });

    afterAll(async () => {
        if (!SKIP_INTEGRATION && testUserId) {
            const supabase = createClient(
                TEST_URL,
                TEST_SERVICE_KEY
            );
            await supabase.auth.admin.deleteUser(testUserId);
        }
        redis.resetRedisClient();
    });

    // ===================================================================
    // Full pipeline: auth → CSRF → real rate limit → handler
    // ===================================================================

    describe('full pipeline happy path', () => {
        it('POST: auth → CSRF → rate limit → handler succeeds', async () => {
            const req = createMockRequest('POST');
            const res = createMockResponse();
            const handler = jest.fn();
            attachCsrfToken(req, testUserId);

            await withRateLimit(handler, {
                requireAuth: true,
                allowedMethods: ['POST'],
            })(req, res);

            expect(handler).toHaveBeenCalledWith(req, res);
            expect(req._rateLimitUser.id).toBe(testUserId);
            expect(res.status).not.toHaveBeenCalledWith(401);
            expect(res.status).not.toHaveBeenCalledWith(403);
            expect(res.status).not.toHaveBeenCalledWith(429);
        });

        it('GET: skips CSRF but still rate limits', async () => {
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();
            // No CSRF token needed for GET

            await withRateLimit(handler, {
                requireAuth: true,
                allowedMethods: ['GET'],
            })(req, res);

            expect(handler).toHaveBeenCalledWith(req, res);
            expect(res.status).not.toHaveBeenCalledWith(403);
        });
    });

    // ===================================================================
    // Rate limit headers on real response
    // ===================================================================

    describe('rate limit headers', () => {
        it('sets X-RateLimit-* headers from real Upstash response', async () => {
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                requireAuth: true,
                allowedMethods: ['GET'],
            })(req, res);

            expect(handler).toHaveBeenCalled();

            // Verify rate limit headers were set
            const setHeaderCalls = res.setHeader.mock.calls;
            const headerNames = setHeaderCalls.map(([name]) => name);

            expect(headerNames).toContain('X-RateLimit-Limit');
            expect(headerNames).toContain('X-RateLimit-Remaining');
            expect(headerNames).toContain('X-RateLimit-Reset');
            expect(headerNames).toContain('X-RateLimit-Window');

            // Verify values are sensible
            const limitCall = setHeaderCalls.find(([n]) => n === 'X-RateLimit-Limit');
            const remainingCall = setHeaderCalls.find(([n]) => n === 'X-RateLimit-Remaining');
            const windowCall = setHeaderCalls.find(([n]) => n === 'X-RateLimit-Window');

            expect(limitCall[1]).toBeGreaterThan(0);
            expect(remainingCall[1]).toBeGreaterThanOrEqual(0);
            expect(['hourly', 'daily']).toContain(windowCall[1]);
        });
    });

    // ===================================================================
    // 429 + Retry-After after exhausting real rate limit
    // ===================================================================

    describe('429 after rate limit exhaustion', () => {
        it('returns 429 with Retry-After after exceeding auth operation limit', async () => {
            // free:auth:hourly = 15 — use auth operation for fast exhaustion
            // Each test run uses a unique user ID suffix to avoid cross-test pollution
            const uniqueUserId = `${testUserId}:pipeline-exhaust-${testRunSuffix}`;

            const exhaustClient = createMockSupabaseClient({
                id: uniqueUserId,
                email: 'exhaust@test.com',
            });

            let lastRes;
            // 16 calls to exhaust (15 limit + 1 over)
            for (let i = 0; i <= 15; i++) {
                mockCreateApiRouteClient.mockReturnValue(exhaustClient);
                const req = createMockRequest('POST');
                lastRes = createMockResponse();
                attachCsrfToken(req, uniqueUserId);

                await withRateLimit(jest.fn(), {
                    requireAuth: true,
                    allowedMethods: ['POST'],
                    operation: 'auth',
                })(req, lastRes);
            }

            // Last call should be 429
            expect(lastRes.status).toHaveBeenCalledWith(429);
            expect(lastRes.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'RATE_LIMIT_EXCEEDED' })
            );

            // Retry-After header should be set
            const retryAfterCall = lastRes.setHeader.mock.calls.find(
                ([name]) => name === 'Retry-After'
            );
            expect(retryAfterCall).toBeDefined();
            expect(retryAfterCall[1]).toBeGreaterThanOrEqual(0);
        });
    });

    // ===================================================================
    // IP extraction for public routes
    // ===================================================================

    describe('public route IP extraction', () => {
        it('extracts IPv4 from socket.remoteAddress for local dev', async () => {
            // Ensure VERCEL env is not set (local dev mode)
            const originalVercel = process.env.VERCEL;
            delete process.env.VERCEL;

            const req = createMockRequest('GET');
            req.socket.remoteAddress = '192.168.1.100';
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                requireAuth: false,
                allowedMethods: ['GET'],
            })(req, res);

            expect(handler).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalledWith(403);

            if (originalVercel !== undefined) {
                process.env.VERCEL = originalVercel;
            }
        });

        it('strips ::ffff: prefix from IPv4-mapped IPv6', async () => {
            const originalVercel = process.env.VERCEL;
            delete process.env.VERCEL;

            const req = createMockRequest('GET');
            req.socket.remoteAddress = '::ffff:10.0.0.1';
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                requireAuth: false,
                allowedMethods: ['GET'],
            })(req, res);

            expect(handler).toHaveBeenCalled();

            if (originalVercel !== undefined) {
                process.env.VERCEL = originalVercel;
            }
        });

        it('rejects IP longer than 45 characters', async () => {
            const originalVercel = process.env.VERCEL;
            delete process.env.VERCEL;

            const req = createMockRequest('GET');
            req.socket.remoteAddress = 'a'.repeat(46);
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                requireAuth: false,
                allowedMethods: ['GET'],
            })(req, res);

            // Should fail with 403 — unidentifiable client
            expect(res.status).toHaveBeenCalledWith(403);
            expect(handler).not.toHaveBeenCalled();

            if (originalVercel !== undefined) {
                process.env.VERCEL = originalVercel;
            }
        });

        it('rejects non-IP strings in remoteAddress', async () => {
            const originalVercel = process.env.VERCEL;
            delete process.env.VERCEL;

            const req = createMockRequest('GET');
            req.socket.remoteAddress = 'not-an-ip-address';
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                requireAuth: false,
                allowedMethods: ['GET'],
            })(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(handler).not.toHaveBeenCalled();

            if (originalVercel !== undefined) {
                process.env.VERCEL = originalVercel;
            }
        });

        it('accepts valid IPv6 address', async () => {
            const originalVercel = process.env.VERCEL;
            delete process.env.VERCEL;

            const req = createMockRequest('GET');
            req.socket.remoteAddress = '2001:db8::1';
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                requireAuth: false,
                allowedMethods: ['GET'],
            })(req, res);

            expect(handler).toHaveBeenCalled();

            if (originalVercel !== undefined) {
                process.env.VERCEL = originalVercel;
            }
        });
    });

    // ===================================================================
    // Redis unavailable → 503 fail-closed (real modules)
    // ===================================================================

    describe('Redis unavailable fail-closed', () => {
        /**
         * Test: Full real pipeline — when Redis REST credentials are wiped
         * and the singleton is reset, the middleware must return 503 instead
         * of falling back to no-limit passthrough.
         *
         * This catches the regression where the retry loop was removed: if
         * anyone re-introduces a silent failure path, this test will catch it.
         */
        it('returns 503 SERVICE_UNAVAILABLE when Redis client is unavailable', async () => {
            const origUrl = process.env.UPSTASH_REDIS_REST_URL;
            const origToken = process.env.UPSTASH_REDIS_REST_TOKEN;

            // Wipe creds and reset the singleton so the next getRedisClient() returns null
            redis.resetRedisClient();
            process.env.UPSTASH_REDIS_REST_URL = '';
            process.env.UPSTASH_REDIS_REST_TOKEN = '';

            try {
                const req = createMockRequest('GET');
                const res = createMockResponse();
                const handler = jest.fn();

                await withRateLimit(handler, {
                    requireAuth: true,
                    allowedMethods: ['GET'],
                })(req, res);

                expect(res.status).toHaveBeenCalledWith(503);
                expect(res.json).toHaveBeenCalledWith(
                    expect.objectContaining({ error: 'SERVICE_UNAVAILABLE' })
                );
                expect(handler).not.toHaveBeenCalled();
            } finally {
                process.env.UPSTASH_REDIS_REST_URL = origUrl;
                process.env.UPSTASH_REDIS_REST_TOKEN = origToken;
                redis.resetRedisClient();
            }
        });
    });

    // ===================================================================
    // Method validation
    // ===================================================================

    describe('method validation', () => {
        it('rejects OPTIONS with 405', async () => {
            const req = createMockRequest('OPTIONS');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                requireAuth: true,
                allowedMethods: ['GET', 'POST'],
            })(req, res);

            expect(res.status).toHaveBeenCalledWith(405);
            expect(handler).not.toHaveBeenCalled();
        });

        it('rejects methods not in allowedMethods with 405', async () => {
            const req = createMockRequest('DELETE');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                requireAuth: true,
                allowedMethods: ['GET', 'POST'],
            })(req, res);

            expect(res.status).toHaveBeenCalledWith(405);
            expect(handler).not.toHaveBeenCalled();
        });
    });
});
