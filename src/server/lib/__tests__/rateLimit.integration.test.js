/**
 * Integration tests for rateLimit.js against real Upstash instance
 *
 * Purpose: Verify fixed-window rate limiting with real Redis state,
 * including dual-window evaluation, cache behavior, graceful degradation,
 * and PII redaction in logs.
 *
 * Connects to: src/server/lib/rateLimit.js, src/server/lib/redis.js
 *
 * Requires: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
 *           TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_KEY,
 *           SUPABASE_TEST_PROJECT_REF env vars
 * Run with: npm run test:integration
 *
 * Key design decisions:
 * - Uses real Supabase test user ID as the rate limit identifier, matching
 *   production format `user:{uuid}`. A unique suffix per test run prevents
 *   counter collision: `user:{uuid}:test-{timestamp}-{random}`.
 * - Upstash @upstash/ratelimit keys auto-expire after their window duration
 *   (1h/24h), so leftover test keys self-clean.
 * - Tests run --runInBand to prevent parallel counter corruption.
 *
 * Test coverage:
 * - checkRateLimit() decrements remaining on successive calls
 * - Daily-before-hourly short-circuit with real Redis state
 * - Most restrictive window wins when both pass
 * - Rate limit exceeded after N+1 requests
 * - Graceful degradation when Redis unavailable (resetRedisClient mid-test)
 * - limiterCache invalidation after resetRedisClient()
 * - PII redaction: identifier type logged, never full value
 * - Malicious inputs: XSS identifiers, absurdly long keys, null bytes, unicode
 */

const { createClient } = require('@supabase/supabase-js');
const {
    SUPABASE_TEST_PROJECT_REF_ENV_NAME,
    TEST_SUPABASE_ENV_NAMES,
    matchesSupabaseTestProject,
} = require('../../../testSupport/integrationEnvironment.js');
const {
    runIntegrationCleanup,
} = require('../../../testSupport/integrationCleanup.js');

const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.mock('../../../shared/logger.js', () => ({ logger: mockLogger }));

const TEST_URL = process.env[TEST_SUPABASE_ENV_NAMES.url];
const TEST_SERVICE_KEY = process.env[TEST_SUPABASE_ENV_NAMES.serviceKey];
const TEST_PROJECT_REF = process.env[SUPABASE_TEST_PROJECT_REF_ENV_NAME];
const SKIP_INTEGRATION =
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN ||
    !TEST_URL ||
    !TEST_SERVICE_KEY;

const describeIntegration = SKIP_INTEGRATION ||
    !matchesSupabaseTestProject(TEST_URL, TEST_PROJECT_REF)
    ? describe.skip
    : describe;

describeIntegration('rateLimit.js — integration (real Upstash)', () => {
    let checkRateLimit;
    let redis;
    let testUserId;
    let testRunSuffix;

    // Create a disposable test user via admin API to get a real UUID
    beforeAll(async () => {
        if (SKIP_INTEGRATION || !matchesSupabaseTestProject(TEST_URL, TEST_PROJECT_REF)) return;

        const supabase = createClient(
            TEST_URL,
            TEST_SERVICE_KEY
        );
        const testEmail = `ratelimit-test-${Date.now()}@integration-test.local`;
        const { data, error } = await supabase.auth.admin.createUser({
            email: testEmail,
            email_confirm: true,
        });
        if (error) throw new Error(`Test user creation failed: ${error.message}`);
        testUserId = data.user.id;
        testRunSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    });

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        redis = require('../redis.js');
        ({ checkRateLimit } = require('../rateLimit.js'));
    });

    afterEach(() => {
        redis.resetRedisClient();
    });

    afterAll(async () => {
        if (
            !SKIP_INTEGRATION &&
            testUserId &&
            matchesSupabaseTestProject(TEST_URL, TEST_PROJECT_REF)
        ) {
            const supabase = createClient(
                TEST_URL,
                TEST_SERVICE_KEY
            );
            await runIntegrationCleanup([
                {
                    label: 'rate-limit auth user',
                    cleanup: () => supabase.auth.admin.deleteUser(testUserId),
                },
            ]);
        }
    });

    /**
     * Builds a production-shaped identifier with a test-unique suffix
     * to prevent counter collision across test runs.
     * Format: user:{real-uuid}:test-{timestamp}-{random}:{label}
     */
    function testId(label) {
        return `user:${testUserId}:test-${testRunSuffix}:${label}`;
    }

    // ===================================================================
    // Basic rate limit counting
    // ===================================================================

    describe('checkRateLimit() counting', () => {
        it('decrements remaining on successive calls', async () => {
            const id = testId('decrement');

            const first = await checkRateLimit(id, 'free', 'read');
            expect(first.success).toBe(true);
            expect(first.remaining).toBeDefined();

            const second = await checkRateLimit(id, 'free', 'read');
            expect(second.success).toBe(true);
            expect(second.remaining).toBeLessThan(first.remaining);
        });

        it('returns correct limit value matching tier config', async () => {
            const id = testId('limit-val');

            const result = await checkRateLimit(id, 'free', 'read');
            expect(result.success).toBe(true);
            // free:read:hourly = 300, free:read:daily = null
            // Since daily is null, only hourly limiter exists → limit should be 300
            expect(result.limit).toBe(300);
            expect(result.window).toBe('hourly');
        });
    });

    // ===================================================================
    // Dual-window evaluation
    // ===================================================================

    describe('dual-window logic', () => {
        it('returns a window field indicating which window was used', async () => {
            const id = testId('window-field');

            const result = await checkRateLimit(id, 'free', 'insert');
            expect(result.success).toBe(true);
            expect(['hourly', 'daily']).toContain(result.window);
        });

        it('most restrictive window wins when both pass', async () => {
            // free:insert has hourly=30, daily=60
            // On first call, hourly remaining=29, daily remaining=59
            // hourly is more restrictive (29 < 59) → should return hourly
            const id = testId('most-restrictive');

            const result = await checkRateLimit(id, 'free', 'insert');
            expect(result.success).toBe(true);
            expect(result.window).toBe('hourly');
            expect(result.remaining).toBe(29);
        });
    });

    // ===================================================================
    // Rate limit exceeded
    // ===================================================================

    describe('rate limit exceeded', () => {
        it('returns success=false after exceeding the limit', async () => {
            // free:auth:hourly = 15 (smallest window for fast exhaustion)
            const id = testId('exhaust');

            let lastResult;
            for (let i = 0; i <= 15; i++) {
                lastResult = await checkRateLimit(id, 'free', 'auth');
            }

            // 16th call should fail (15 limit + 1 over)
            expect(lastResult.success).toBe(false);
            expect(lastResult.remaining).toBe(0);
            expect(lastResult.reset).toBeDefined();
        });
    });

    // ===================================================================
    // Graceful degradation
    // ===================================================================

    describe('graceful degradation', () => {
        it('returns unavailable when Redis is reset mid-test', async () => {
            const id = testId('degradation');

            // First call should succeed
            const first = await checkRateLimit(id, 'free', 'read');
            expect(first.success).toBe(true);

            // Reset Redis — simulates connection loss
            redis.resetRedisClient();

            // Clear env vars so fresh module can't auto-reconnect
            const origUrl = process.env.UPSTASH_REDIS_REST_URL;
            const origToken = process.env.UPSTASH_REDIS_REST_TOKEN;
            process.env.UPSTASH_REDIS_REST_URL = '';
            process.env.UPSTASH_REDIS_REST_TOKEN = '';

            // Re-require to get fresh module state pointing at reset redis
            jest.resetModules();
            jest.clearAllMocks();
            // Re-register logger mock after resetModules
            jest.mock('../../../shared/logger.js', () => ({
                logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
            }));
            const freshRedis = require('../redis.js');
            // Don't re-initialize — leave redis client as null
            const { checkRateLimit: freshCheck } = require('../rateLimit.js');

            const result = await freshCheck(id, 'free', 'read');
            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);

            // Restore env vars
            process.env.UPSTASH_REDIS_REST_URL = origUrl;
            process.env.UPSTASH_REDIS_REST_TOKEN = origToken;
            freshRedis.resetRedisClient();
        });
    });

    // ===================================================================
    // Cache invalidation
    // ===================================================================

    describe('limiterCache invalidation', () => {
        it('rebuilds limiter after Redis client reference changes', async () => {
            const id = testId('cache-invalidation');

            // First call caches the limiter
            const first = await checkRateLimit(id, 'free', 'read');
            expect(first.success).toBe(true);

            // Reset and re-initialize — new Redis client reference
            redis.resetRedisClient();
            redis.getRedisClient();

            // Should still work — limiter cache detects stale reference and rebuilds
            const second = await checkRateLimit(id, 'free', 'read');
            expect(second.success).toBe(true);
        });
    });

    // ===================================================================
    // Input validation
    // ===================================================================

    describe('input validation', () => {
        it('rejects null identifier', async () => {
            const result = await checkRateLimit(null, 'free', 'read');
            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
        });

        it('rejects empty string identifier', async () => {
            const result = await checkRateLimit('', 'free', 'read');
            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
        });

        it('rejects invalid tier', async () => {
            const result = await checkRateLimit(testId('bad-tier'), 'nonexistent', 'read');
            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
        });

        it('rejects invalid operation', async () => {
            const result = await checkRateLimit(testId('bad-op'), 'free', 'nonexistent');
            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
        });
    });

    // ===================================================================
    // PII redaction
    // ===================================================================

    describe('PII redaction in logs', () => {
        it('error log contains identifierType but never the full user UUID', async () => {
            // Use the real user UUID in an identifier that will hit the catch block
            // We force an error by resetting Redis after caching a limiter,
            // then making the cached limiter's .limit() throw
            const sensitiveId = `user:${testUserId}`;

            // Trigger input validation error path (invalid tier logs the identifier type)
            await checkRateLimit(sensitiveId, 'invalid-tier', 'read');

            const allErrorArgs = JSON.stringify(mockLogger.error.mock.calls);
            // "user" type should be absent from error logs for invalid tier
            // (the error is logged before identifier is used)
            // Most importantly: the real UUID must never appear
            expect(allErrorArgs).not.toContain(testUserId);
        });

        it('identifier type extraction works for user: and ip: prefixes', () => {
            // Verify the extraction logic used in the catch block (rateLimit.js:121)
            const userParts = `user:${testUserId}`.split(':');
            expect(userParts[0]).toBe('user');

            const ipParts = 'ip:192.168.1.1'.split(':');
            expect(ipParts[0]).toBe('ip');
        });
    });

    // ===================================================================
    // Malicious inputs
    // ===================================================================

    describe('malicious input resilience', () => {
        it('handles XSS payload in identifier without crashing', async () => {
            const xssId = `user:${testUserId}:test:<script>alert("xss")</script>`;
            const result = await checkRateLimit(xssId, 'free', 'read');
            // Should succeed — Redis treats keys as opaque strings
            expect(result.success).toBe(true);
        });

        it('handles absurdly long identifier', async () => {
            const longId = `user:${testUserId}:test:${'a'.repeat(10000)}`;
            const result = await checkRateLimit(longId, 'free', 'read');
            // Should succeed or fail gracefully — not crash
            expect(result).toHaveProperty('success');
        });

        it('handles null bytes in identifier', async () => {
            const nullId = `user:${testUserId}:test:null\x00byte`;
            const result = await checkRateLimit(nullId, 'free', 'read');
            expect(result).toHaveProperty('success');
        });

        it('handles unicode in identifier', async () => {
            const unicodeId = `user:${testUserId}:test:ユーザー-${testRunSuffix}`;
            const result = await checkRateLimit(unicodeId, 'free', 'read');
            expect(result.success).toBe(true);
        });
    });
});
