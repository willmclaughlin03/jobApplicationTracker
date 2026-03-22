/**
 * Tests for rateLimit.js
 *
 * Purpose: Verify rate limit checking with input validation,
 * limiter caching, PII redaction, and Redis health handling
 *
 * Connects to: server/lib/rateLimit.js
 *
 * Test coverage:
 * - Input validation: invalid identifier, tier, operation (finding d)
 * - Limiter cache: wrapper object pattern, stale Redis detection (findings g, h)
 * - PII redaction: identifier not logged in error cases (finding k)
 * - Redis health: unavailable returns, error handling
 */

const mockLimit = jest.fn();
const mockFixedWindow = jest.fn().mockReturnValue('fixedWindowConfig');

jest.mock('@upstash/ratelimit', () => ({
    Ratelimit: jest.fn().mockImplementation(() => ({
        limit: mockLimit,
    })),
}));

// Access the mocked constructor to set static method
const { Ratelimit } = require('@upstash/ratelimit');
Ratelimit.fixedWindow = mockFixedWindow;

const mockGetRedisClient = jest.fn();
const mockIsRedisHealthy = jest.fn();

jest.mock('../redis', () => ({
    getRedisClient: mockGetRedisClient,
    isRedisHealthy: mockIsRedisHealthy,
}));

const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.mock('../../../shared/logger', () => ({
    logger: mockLogger,
}));

const { checkRateLimit } = require('../rateLimit');

describe('checkRateLimit', () => {
    const mockRedisClient = { ping: jest.fn() };

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetRedisClient.mockReturnValue(mockRedisClient);
        mockIsRedisHealthy.mockResolvedValue(true);
        mockLimit.mockResolvedValue({
            success: true,
            limit: 20,
            remaining: 19,
            reset: Date.now() + 3600000,
        });
    });

    // =========================================================================
    // Input validation (finding d)
    // =========================================================================
    describe('input validation', () => {
        /**
         * Test: Null identifier is rejected
         * Prevents: Undefined behavior when identifier is missing
         */
        it('should reject null identifier', async () => {
            const result = await checkRateLimit(null, 'free', 'read');

            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.any(Object),
                'checkRateLimit called with invalid identifier'
            );
        });

        /**
         * Test: Empty string identifier is rejected
         */
        it('should reject empty string identifier', async () => {
            const result = await checkRateLimit('', 'free', 'read');

            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
        });

        /**
         * Test: Non-string identifier is rejected
         */
        it('should reject non-string identifier', async () => {
            const result = await checkRateLimit(123, 'free', 'read');

            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
        });

        /**
         * Test: Invalid tier is rejected
         * Prevents: Garbage entries in limiter cache from unknown tiers
         */
        it('should reject invalid tier', async () => {
            const result = await checkRateLimit('user:abc', 'premium', 'read');

            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ tier: 'premium' }),
                'checkRateLimit called with invalid tier'
            );
        });

        /**
         * Test: Invalid operation is rejected
         * Prevents: Arbitrary operation strings creating unbounded cache entries
         */
        it('should reject invalid operation', async () => {
            const result = await checkRateLimit('user:abc', 'free', 'execute');

            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ operation: 'execute' }),
                'checkRateLimit called with invalid operation'
            );
        });

        /**
         * Test: Valid inputs pass validation and reach Redis
         */
        it('should accept valid identifier, tier, and operation', async () => {
            const result = await checkRateLimit('user:abc-123', 'free', 'read');

            expect(result.success).toBe(true);
            expect(mockLogger.error).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // PII redaction in logs (finding k)
    // =========================================================================
    describe('PII redaction', () => {
        /**
         * Test: Full identifier (containing user ID or IP) is not logged on error
         * GDPR: Only the identifier type (user/ip) should appear in logs
         */
        it('should log only identifier type, not full value, on error', async () => {
            mockIsRedisHealthy.mockRejectedValue(new Error('Connection refused'));

            await checkRateLimit('user:sensitive-user-id-123', 'free', 'read');

            const errorCalls = mockLogger.error.mock.calls;
            const rateLimitErrorCall = errorCalls.find(
                call => call[1] === 'Rate limit check failed'
            );

            expect(rateLimitErrorCall).toBeDefined();
            const logData = rateLimitErrorCall[0];
            expect(logData.identifierType).toBe('user');
            expect(logData).not.toHaveProperty('identifier');
            expect(JSON.stringify(logData)).not.toContain('sensitive-user-id-123');
        });

        /**
         * Test: IP-based identifier type is logged correctly
         */
        it('should log ip as identifier type for IP-based identifiers', async () => {
            mockIsRedisHealthy.mockRejectedValue(new Error('Timeout'));

            await checkRateLimit('ip:192.168.1.100', 'free', 'read');

            const errorCalls = mockLogger.error.mock.calls;
            const rateLimitErrorCall = errorCalls.find(
                call => call[1] === 'Rate limit check failed'
            );

            expect(rateLimitErrorCall).toBeDefined();
            const logData = rateLimitErrorCall[0];
            expect(logData.identifierType).toBe('ip');
            expect(JSON.stringify(logData)).not.toContain('192.168.1.100');
        });
    });

    // =========================================================================
    // Redis health handling
    // =========================================================================
    describe('Redis health', () => {
        /**
         * Test: Returns unavailable when Redis client is null
         */
        it('should return unavailable when no Redis client', async () => {
            mockGetRedisClient.mockReturnValue(null);

            const result = await checkRateLimit('user:abc', 'free', 'read');

            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
        });

        /**
         * Test: Returns unavailable when Redis is unhealthy
         */
        it('should return unavailable when Redis is unhealthy', async () => {
            mockIsRedisHealthy.mockResolvedValue(false);

            const result = await checkRateLimit('user:abc', 'free', 'read');

            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
        });
    });

    // =========================================================================
    // Rate limit results
    // =========================================================================
    describe('rate limit evaluation', () => {
        /**
         * Test: Successful rate limit check returns proper structure
         */
        it('should return success with limit details', async () => {
            const result = await checkRateLimit('user:abc', 'free', 'read');

            expect(result.success).toBe(true);
            expect(result).toHaveProperty('limit');
            expect(result).toHaveProperty('remaining');
            expect(result).toHaveProperty('reset');
            expect(result).toHaveProperty('window');
        });

        /**
         * Test: Rate limit exceeded returns success: false
         */
        it('should return failure when limit exceeded', async () => {
            mockLimit.mockResolvedValue({
                success: false,
                limit: 20,
                remaining: 0,
                reset: Date.now() + 1000,
            });

            const result = await checkRateLimit('user:abc', 'free', 'read');

            expect(result.success).toBe(false);
            expect(result.remaining).toBe(0);
        });
    });

    // =========================================================================
    // Dual-window evaluation logic
    // =========================================================================
    describe('dual-window evaluation', () => {
        /**
         * Reset mockLimit before each dual-window test.
         *
         * jest.clearAllMocks() only clears call history — it does NOT flush
         * mockResolvedValueOnce queues. Any unconsumed "once" values from a
         * prior test would leak into the next test and produce incorrect results.
         * mockReset() flushes the queue completely; we then restore the default.
         */
        beforeEach(() => {
            mockLimit.mockReset();
            mockLimit.mockResolvedValue({
                success: true,
                limit: 20,
                remaining: 19,
                reset: Date.now() + 3600000,
            });
        });

        /**
         * Test: Daily fails → returns daily failure (hourly not checked)
         * Verifies short-circuit: if daily bucket is exhausted, hourly
         * is never consumed, preserving the smaller bucket.
         */
        it('should return daily failure without checking hourly when daily fails', async () => {
            // insert has both hourly (30) and daily (60) limits
            mockLimit.mockResolvedValueOnce({
                // daily limiter checked first
                success: false,
                limit: 60,
                remaining: 0,
                reset: Date.now() + 86400000,
            });

            const result = await checkRateLimit('user:abc', 'free', 'insert');

            expect(result.success).toBe(false);
            expect(result.window).toBe('daily');
            expect(result.remaining).toBe(0);
            // Only 1 call means hourly was never checked
            expect(mockLimit).toHaveBeenCalledTimes(1);
        });

        /**
         * Test: Daily passes, hourly fails → returns hourly failure
         */
        it('should return hourly failure when daily passes but hourly fails', async () => {
            mockLimit
                .mockResolvedValueOnce({
                    // daily passes
                    success: true,
                    limit: 60,
                    remaining: 40,
                    reset: Date.now() + 86400000,
                })
                .mockResolvedValueOnce({
                    // hourly fails
                    success: false,
                    limit: 30,
                    remaining: 0,
                    reset: Date.now() + 3600000,
                });

            const result = await checkRateLimit('user:abc', 'free', 'insert');

            expect(result.success).toBe(false);
            expect(result.window).toBe('hourly');
            expect(result.remaining).toBe(0);
        });

        /**
         * Test: Both pass, hourly more restrictive (lower remaining) → returns hourly
         */
        it('should return hourly when both pass and hourly has lower remaining', async () => {
            mockLimit
                .mockResolvedValueOnce({
                    // daily passes with plenty remaining
                    success: true,
                    limit: 60,
                    remaining: 50,
                    reset: Date.now() + 86400000,
                })
                .mockResolvedValueOnce({
                    // hourly passes but nearly exhausted
                    success: true,
                    limit: 30,
                    remaining: 2,
                    reset: Date.now() + 3600000,
                });

            const result = await checkRateLimit('user:abc', 'free', 'insert');

            expect(result.success).toBe(true);
            expect(result.window).toBe('hourly');
            expect(result.remaining).toBe(2);
        });

        /**
         * Test: Both pass, daily more restrictive (lower remaining) → returns daily
         */
        it('should return daily when both pass and daily has lower remaining', async () => {
            mockLimit
                .mockResolvedValueOnce({
                    // daily passes but nearly exhausted
                    success: true,
                    limit: 60,
                    remaining: 1,
                    reset: Date.now() + 86400000,
                })
                .mockResolvedValueOnce({
                    // hourly passes with plenty remaining
                    success: true,
                    limit: 30,
                    remaining: 20,
                    reset: Date.now() + 3600000,
                });

            const result = await checkRateLimit('user:abc', 'free', 'insert');

            expect(result.success).toBe(true);
            expect(result.window).toBe('daily');
            expect(result.remaining).toBe(1);
        });

        /**
         * Test: Read operation (daily limit is null) → only hourly checked
         * read tier has daily: null, so only the hourly limiter is created.
         */
        it('should only check hourly when daily limit is null (read operation)', async () => {
            mockLimit.mockResolvedValueOnce({
                success: true,
                limit: 300,
                remaining: 290,
                reset: Date.now() + 3600000,
            });

            const result = await checkRateLimit('user:abc', 'free', 'read');

            expect(result.success).toBe(true);
            expect(result.window).toBe('hourly');
            expect(result.remaining).toBe(290);
            // Only 1 call because daily limiter is null
            expect(mockLimit).toHaveBeenCalledTimes(1);
        });
    });

    // =========================================================================
    // Limiter cache invalidation
    // =========================================================================
    describe('limiter cache invalidation', () => {
        /**
         * Uses jest.resetModules() to get a fresh limiterCache per test.
         * This ensures cache behavior is isolated.
         */
        let freshCheckRateLimit;
        let freshRatelimit;

        beforeEach(() => {
            jest.resetModules();

            // Re-apply mocks on fresh module registry
            jest.doMock('@upstash/ratelimit', () => {
                const limitFn = jest.fn().mockResolvedValue({
                    success: true,
                    limit: 300,
                    remaining: 299,
                    reset: Date.now() + 3600000,
                });
                const RatelimitClass = jest.fn().mockImplementation(() => ({
                    limit: limitFn,
                }));
                RatelimitClass.fixedWindow = jest.fn().mockReturnValue('fixedWindowConfig');
                return { Ratelimit: RatelimitClass };
            });

            jest.doMock('../redis', () => ({
                getRedisClient: jest.fn(),
                isRedisHealthy: jest.fn().mockResolvedValue(true),
            }));

            jest.doMock('../../../shared/logger', () => ({
                logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
            }));

            freshRatelimit = require('@upstash/ratelimit').Ratelimit;
            const redis = require('../redis');
            // Start with a stable mock client
            const mockClient = { id: 'client-1' };
            redis.getRedisClient.mockReturnValue(mockClient);

            freshCheckRateLimit = require('../rateLimit').checkRateLimit;
        });

        /**
         * Test: Same Redis client → limiter is reused from cache
         */
        it('should reuse cached limiter when Redis client is unchanged', async () => {
            await freshCheckRateLimit('user:abc', 'free', 'read');
            const callsAfterFirst = freshRatelimit.mock.calls.length;

            await freshCheckRateLimit('user:abc', 'free', 'read');
            const callsAfterSecond = freshRatelimit.mock.calls.length;

            // No new Ratelimit constructor calls on second invocation
            expect(callsAfterSecond).toBe(callsAfterFirst);
        });

        /**
         * Test: Redis client reference changes → limiter is rebuilt
         */
        it('should rebuild limiter when Redis client reference changes', async () => {
            await freshCheckRateLimit('user:abc', 'free', 'read');
            const callsAfterFirst = freshRatelimit.mock.calls.length;

            // Simulate Redis reconnection → new client object
            const redis = require('../redis');
            redis.getRedisClient.mockReturnValue({ id: 'client-2' });

            await freshCheckRateLimit('user:abc', 'free', 'read');
            const callsAfterSecond = freshRatelimit.mock.calls.length;

            // Should have created a new Ratelimit instance
            expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
        });
    });
});
