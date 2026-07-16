/**
 * Integration tests for withRateLimit middleware
 *
 * Purpose: Verify cross-module contracts between auth, CSRF, and rate limiting
 * by using real getUserFromRequest and validateCsrfToken implementations.
 * Mocks only at the HTTP boundary (Supabase Auth API, Upstash Redis).
 *
 * Connects to: src/server/middleware/withRateLimit.js
 *
 * Mock boundary (external HTTP dependencies only):
 * - createApiRouteClient (supabaseApiRoute.js) — Supabase Auth HTTP calls
 * - checkRateLimit (rateLimit.js) — Upstash Redis HTTP calls
 * - logger — suppress output
 *
 * Real modules exercised:
 * - getUserFromRequest (supabaseServer.js) — real destructuring, req assignment
 * - validateCsrfToken / generateCsrfToken (csrf.js) — real HMAC-SHA256
 * - withRateLimit (withRateLimit.js) — full middleware pipeline
 * - CSRF_COOKIE_NAME / CSRF_MAX_AGE_SECONDS (constants/csrf.js)
 * - sendError / ERROR_MESSAGES (shared)
 *
 * Test coverage:
 * - Auth → CSRF → rate limit → handler full pipeline (POST happy path)
 * - CSRF token bound to wrong user rejected (userId HMAC binding)
 * - Tampered CSRF signature rejected (HMAC integrity)
 * - Expired CSRF token rejected (timestamp expiry via fake timers)
 * - Unauthenticated request short-circuits before CSRF/rate limit
 * - req._supabaseClient propagated from auth to handler (reference equality)
 * - Cookie/header mismatch rejected (double-submit check)
 * - Missing cookie or header rejected
 */

const {
    TEST_CSRF_FALLBACK,
    TEST_SUPABASE_BOOTSTRAP_SERVICE_ROLE_KEY,
    TEST_SUPABASE_BOOTSTRAP_URL,
    resolveTestCsrfSecret,
    restoreEnvironmentVariable,
} = require('../../../testSupport/integrationEnvironment.js');

const originalCsrfSecret = process.env.CSRF_SECRET;
const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalSupabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Install test-only HMAC configuration before csrf.js validates at import time.
process.env.CSRF_SECRET = resolveTestCsrfSecret(process.env, TEST_CSRF_FALLBACK);

// Fixed fake application values support mocked module imports without reading
// live application or test-database credentials.
process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_SUPABASE_BOOTSTRAP_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SUPABASE_BOOTSTRAP_SERVICE_ROLE_KEY;

// ---------------------------------------------------------------------------
// Mocks — HTTP boundary only
// ---------------------------------------------------------------------------

const mockCreateApiRouteClient = jest.fn();
jest.mock('../../lib/supabaseApiRoute.js', () => ({
    createApiRouteClient: mockCreateApiRouteClient,
}));

const mockCheckRateLimit = jest.fn();
jest.mock('../../lib/rateLimit.js', () => ({
    checkRateLimit: mockCheckRateLimit,
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

// ---------------------------------------------------------------------------
// Real modules under test
// ---------------------------------------------------------------------------

const { withRateLimit } = require('../withRateLimit.js');
const { generateCsrfToken } = require('../../lib/csrf.js');
const { CSRF_COOKIE_NAME, CSRF_MAX_AGE_SECONDS } = require('../../../shared/constants/csrf.js');

describe('withRateLimit — integration', () => {
    const TEST_USER_ID = 'user-integration-test';
    let mockSupabaseClient;

    // -- Factories ----------------------------------------------------------

    /**
     * Creates a mock Supabase client whose auth.getUser() resolves to the
     * given user. This same object becomes req._supabaseClient in the real
     * getUserFromRequest flow.
     */
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

    /**
     * Creates a mock Supabase client whose auth.getUser() resolves to an
     * auth error (no user).
     */
    function createAuthErrorClient(errorMessage) {
        return {
            auth: {
                getUser: jest.fn().mockResolvedValue({
                    data: { user: null },
                    error: { message: errorMessage, status: 401 },
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
        return {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
            setHeader: jest.fn(),
            getHeader: jest.fn().mockReturnValue([]),
            end: jest.fn().mockReturnThis(),
        };
    }

    /**
     * Generates a real CSRF token for userId and attaches it as both
     * cookie and x-csrf-token header (double-submit pattern).
     */
    function attachCsrfToken(req, userId) {
        const token = generateCsrfToken(userId);
        req.cookies[CSRF_COOKIE_NAME] = token;
        req.headers['x-csrf-token'] = token;
        return token;
    }

    // -- Lifecycle ----------------------------------------------------------

    beforeEach(() => {
        jest.clearAllMocks();

        mockSupabaseClient = createMockSupabaseClient({
            id: TEST_USER_ID,
            email: 'test@example.com',
        });
        mockCreateApiRouteClient.mockReturnValue(mockSupabaseClient);

        mockCheckRateLimit.mockResolvedValue({
            success: true,
            limit: 100,
            remaining: 99,
            reset: Date.now() + 3600000,
            window: 'hourly',
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    afterAll(() => {
        restoreEnvironmentVariable(process.env, 'CSRF_SECRET', originalCsrfSecret);
        restoreEnvironmentVariable(process.env, 'NEXT_PUBLIC_SUPABASE_URL', originalSupabaseUrl);
        restoreEnvironmentVariable(
            process.env,
            'SUPABASE_SERVICE_ROLE_KEY',
            originalSupabaseServiceRoleKey
        );
    });

    // =======================================================================
    // Test 1: Full pipeline happy path
    // =======================================================================

    /**
     * Proves userId flows correctly through the full chain:
     * Supabase getUser() → getUserFromRequest → req._rateLimitUser →
     * validateCsrfToken HMAC input → handler
     */
    it('auth → CSRF → rate limit → handler (POST happy path)', async () => {
        const req = createMockRequest('POST');
        const res = createMockResponse();
        const handler = jest.fn();
        attachCsrfToken(req, TEST_USER_ID);

        await withRateLimit(handler, {
            requireAuth: true,
            allowedMethods: ['POST'],
        })(req, res);

        expect(handler).toHaveBeenCalledWith(req, res);
        expect(req._rateLimitUser.id).toBe(TEST_USER_ID);
        expect(res.status).not.toHaveBeenCalledWith(401);
        expect(res.status).not.toHaveBeenCalledWith(403);
    });

    // =======================================================================
    // Test 2: CSRF token bound to wrong user
    // =======================================================================

    /**
     * HMAC(nonce.user-other.timestamp) !== HMAC(nonce.user-integration-test.timestamp).
     * Proves tokens are non-transferable between users — a mock returning
     * true whenever a token is present would miss this.
     */
    it('rejects CSRF token generated for a different user (403)', async () => {
        const req = createMockRequest('POST');
        const res = createMockResponse();
        const handler = jest.fn();
        attachCsrfToken(req, 'user-other');

        await withRateLimit(handler, {
            requireAuth: true,
            allowedMethods: ['POST'],
        })(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ error: 'CSRF_VALIDATION_FAILED' })
        );
        expect(handler).not.toHaveBeenCalled();
        expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    // =======================================================================
    // Test 3: Tampered CSRF signature
    // =======================================================================

    /**
     * Proves crypto.timingSafeEqual rejects modified signatures and that
     * the full HMAC recomputation path works end-to-end.
     */
    it('rejects CSRF token with tampered signature (403)', async () => {
        const req = createMockRequest('POST');
        const res = createMockResponse();
        const handler = jest.fn();

        const token = generateCsrfToken(TEST_USER_ID);
        const parts = token.split('.');
        const sig = parts[2];
        const lastChar = sig[sig.length - 1];
        const flipped = lastChar === 'a' ? 'b' : 'a';
        const tamperedToken = `${parts[0]}.${parts[1]}.${sig.slice(0, -1)}${flipped}`;

        req.cookies[CSRF_COOKIE_NAME] = tamperedToken;
        req.headers['x-csrf-token'] = tamperedToken;

        await withRateLimit(handler, {
            requireAuth: true,
            allowedMethods: ['POST'],
        })(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(handler).not.toHaveBeenCalled();
    });

    // =======================================================================
    // Test 4: Expired CSRF token
    // =======================================================================

    /**
     * Proves the 4-hour expiry window works with real token timestamps.
     * Uses fake timers for Date.now() only — checkRateLimit returns success
     * so the retry setTimeout is never entered.
     */
    it('rejects expired CSRF token (403)', async () => {
        jest.useFakeTimers();

        const req = createMockRequest('POST');
        const res = createMockResponse();
        const handler = jest.fn();

        // Generate token at current (fake) time
        attachCsrfToken(req, TEST_USER_ID);

        // Advance past the 4-hour expiry window
        jest.advanceTimersByTime((CSRF_MAX_AGE_SECONDS + 1) * 1000);

        await withRateLimit(handler, {
            requireAuth: true,
            allowedMethods: ['POST'],
        })(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(handler).not.toHaveBeenCalled();
    });

    // =======================================================================
    // Test 5: Unauthenticated request is throttled before 401
    // =======================================================================

    /**
     * Confirms ordering guarantee — auth failure applies IP auth throttling before
     * returning 401. CSRF and handler logic never run on
     * unauthenticated requests.
     */
    it('returns 401 on auth failure after IP auth-bucket throttling', async () => {
        mockCreateApiRouteClient.mockReturnValue(
            createAuthErrorClient('Invalid JWT')
        );

        const req = createMockRequest('POST');
        const res = createMockResponse();
        const handler = jest.fn();

        await withRateLimit(handler, {
            requireAuth: true,
            allowedMethods: ['POST'],
        })(req, res);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(mockCheckRateLimit).toHaveBeenCalledWith(
            'ip:127.0.0.1',
            'free',
            'auth'
        );
        expect(handler).not.toHaveBeenCalled();
    });

    // =======================================================================
    // Test 6: req._supabaseClient propagation
    // =======================================================================

    /**
     * The mock Supabase client returned by createApiRouteClient must be the
     * exact same reference that ends up on req._supabaseClient. This catches
     * the gap present in route test files where req._supabaseClient is
     * undefined because the passthrough mock never sets it.
     */
    it('propagates the Supabase client to handler as req._supabaseClient', async () => {
        const req = createMockRequest('POST');
        const res = createMockResponse();
        const handler = jest.fn();
        attachCsrfToken(req, TEST_USER_ID);

        await withRateLimit(handler, {
            requireAuth: true,
            allowedMethods: ['POST'],
        })(req, res);

        expect(handler).toHaveBeenCalled();
        // Reference equality — same object, not a copy
        expect(req._supabaseClient).toBe(mockSupabaseClient);
    });

    // =======================================================================
    // Test 7: Double-submit cookie/header mismatch
    // =======================================================================

    /**
     * Exercises the crypto.timingSafeEqual comparison between cookie and
     * header values — a distinct path from signature tampering (Test 3).
     * Two independently generated tokens for the same user will have
     * different nonces and thus different signatures.
     */
    it('rejects when cookie and header tokens differ (403)', async () => {
        const req = createMockRequest('POST');
        const res = createMockResponse();
        const handler = jest.fn();

        const cookieToken = generateCsrfToken(TEST_USER_ID);
        const headerToken = generateCsrfToken(TEST_USER_ID);

        req.cookies[CSRF_COOKIE_NAME] = cookieToken;
        req.headers['x-csrf-token'] = headerToken;

        await withRateLimit(handler, {
            requireAuth: true,
            allowedMethods: ['POST'],
        })(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(handler).not.toHaveBeenCalled();
        expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    // =======================================================================
    // Test 8: Missing cookie or header
    // =======================================================================

    /**
     * Exercises the early guard in validateCsrfToken that rejects requests
     * when either the cookie or the header is absent.
     */
    it.each([
        ['cookie missing', { setCookie: false, setHeader: true }],
        ['header missing', { setCookie: true, setHeader: false }],
    ])('rejects when %s (403)', async (_label, { setCookie, setHeader }) => {
        const req = createMockRequest('POST');
        const res = createMockResponse();
        const handler = jest.fn();

        const token = generateCsrfToken(TEST_USER_ID);
        if (setCookie) req.cookies[CSRF_COOKIE_NAME] = token;
        if (setHeader) req.headers['x-csrf-token'] = token;

        await withRateLimit(handler, {
            requireAuth: true,
            allowedMethods: ['POST'],
        })(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(handler).not.toHaveBeenCalled();
    });
});
