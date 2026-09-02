/**
 * Tests for rateLimit.js
 *
 * Purpose: Verify rate limit checking with input validation,
 * limiter caching, PII redaction, and Redis availability handling
 *
 * Connects to: server/lib/rateLimit.js
 *
 * Test coverage:
 * - Input validation: invalid identifier, tier, operation
 * - Limiter cache: wrapper object pattern, stale Redis detection
 * - PII redaction: identifier not logged in error cases
 * - Redis availability: null client, call failures, status tracking
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
const mockLogRedisDownOnce = jest.fn();
const mockSetLastCallStatus = jest.fn();

jest.mock('../redis', () => ({
    getRedisClient: mockGetRedisClient,
    logRedisDownOnce: mockLogRedisDownOnce,
    setLastCallStatus: mockSetLastCallStatus,
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
    // Bounded failure diagnostics
    // =========================================================================
    describe('bounded failure diagnostics', () => {
        let warningTestNow = Date.now();
        let dateNowSpy;

        /**
         * Advances beyond the module's warn-throttle window before each test.
         */
        beforeEach(() => {
            warningTestNow += 120_000;
            dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(warningTestNow);
        });

        /**
         * Restores the real clock so the shared test stub cannot leak.
         */
        afterEach(() => {
            dateNowSpy.mockRestore();
        });

        /**
         * Test: provider errors and complete identifiers never enter warning data.
         *
         * Why: Error messages, stacks, URLs, tokens, and enumerable provider
         * metadata may all contain secrets or reversible limiter identities.
         */
        it('emits only fixed fields when a provider error contains sensitive sentinels', async () => {
            const userIdentifier = 'user:sensitive-user-id-123';
            const sourceIdentifier = 'source:v1:f4:wAACew';
            const secretToken = 'provider-token-never-log';
            const secretUrl = 'https://sensitive-provider.example.test/private';
            const longErrorName = `ProviderFailure${'X'.repeat(80)}`;
            const providerError = new Error(
                `Provider failed for ${sourceIdentifier} at ${secretUrl} with ${secretToken}`
            );
            Object.defineProperty(providerError, 'constructor', {
                value: { name: longErrorName },
            });
            providerError.stack = `Synthetic stack containing ${secretToken}`;
            providerError.details = {
                identifier: sourceIdentifier,
                token: secretToken,
                url: secretUrl,
            };
            mockLimit.mockRejectedValue(providerError);

            const result = await checkRateLimit(userIdentifier, 'free', 'read');

            const warnCalls = mockLogger.warn.mock.calls;
            const rateLimitWarnCall = warnCalls.find(
                call => call[1] === 'Rate limit check failed'
            );

            expect(rateLimitWarnCall).toBeDefined();
            expect(rateLimitWarnCall[0]).toEqual({
                reason: 'limiter_call_failed',
                errorName: longErrorName.slice(0, 64),
                identifierClass: 'user',
                tier: 'free',
                operation: 'read',
            });
            expect(rateLimitWarnCall[0].errorName).toHaveLength(64);
            expect(rateLimitWarnCall[0]).not.toHaveProperty('err');
            expect(result).toEqual({ success: false, unavailable: true });
            expect(mockLogRedisDownOnce).toHaveBeenCalledWith({ reason: 'call_failed' });
            expect(mockSetLastCallStatus).toHaveBeenCalledWith(false);

            const serializedLogs = JSON.stringify(mockLogger.warn.mock.calls);
            for (const sentinel of [userIdentifier, sourceIdentifier, secretToken, secretUrl]) {
                expect(serializedLogs).not.toContain(sentinel);
            }
        });

        /**
         * Test: the new versioned generic source maps to one fixed class.
         */
        it('classifies a canonical source without logging its value', async () => {
            const sourceIdentifier = 'source:v1:f4:wAACCg';
            mockLimit.mockRejectedValue(new Error('Synthetic provider failure'));

            await checkRateLimit(sourceIdentifier, 'free', 'read');

            const warnCalls = mockLogger.warn.mock.calls;
            const rateLimitWarnCall = warnCalls.find(
                call => call[1] === 'Rate limit check failed'
            );

            expect(rateLimitWarnCall).toBeDefined();
            const logData = rateLimitWarnCall[0];
            expect(logData.identifierClass).toBe('source');
            expect(logData).not.toHaveProperty('err');
            expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(sourceIdentifier);
        });

        /**
         * Test: an unexpected prefix cannot create a new log-cardinality value.
         */
        it('collapses unexpected identifier prefixes to unknown', async () => {
            const unexpectedIdentifier = 'attacker-shaped-prefix:private-value';
            mockLimit.mockRejectedValue(new Error('Synthetic provider failure'));

            await checkRateLimit(unexpectedIdentifier, 'free', 'read');

            const rateLimitWarnCall = mockLogger.warn.mock.calls.find(
                call => call[1] === 'Rate limit check failed'
            );
            expect(rateLimitWarnCall[0].identifierClass).toBe('unknown');
            expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(
                unexpectedIdentifier
            );
        });
    });

    // =========================================================================
    // Redis availability handling
    // =========================================================================
    describe('Redis availability', () => {
        /**
         * Test: Returns unavailable and logs once when Redis client is null
         */
        it('should return unavailable when no Redis client', async () => {
            mockGetRedisClient.mockReturnValue(null);

            const result = await checkRateLimit('user:abc', 'free', 'read');

            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
            expect(mockLogRedisDownOnce).toHaveBeenCalledWith({ reason: 'no_client' });
            expect(mockSetLastCallStatus).toHaveBeenCalledWith(false);
        });

        /**
         * Test: Returns unavailable and logs once when limiter call throws
         */
        it('should return unavailable when limiter call throws', async () => {
            mockLimit.mockRejectedValue(new Error('Network error'));

            const result = await checkRateLimit('user:abc', 'free', 'read');

            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
            expect(mockLogRedisDownOnce).toHaveBeenCalledWith({ reason: 'call_failed' });
            expect(mockSetLastCallStatus).toHaveBeenCalledWith(false);
        });

        /**
         * Test: Upstash Ratelimit timeout responses fail closed
         *
         * Why: Upstash's built-in limiter timeout is fail-open and returns
         * success with reason "timeout". The app must treat that as Redis
         * unavailable rather than a trustworthy quota pass.
         */
        it('should return unavailable when limiter returns a timeout reason', async () => {
            mockLimit.mockResolvedValue({
                success: true,
                limit: 0,
                remaining: 0,
                reset: 0,
                reason: 'timeout',
            });

            const result = await checkRateLimit('user:abc', 'free', 'read');

            expect(result.success).toBe(false);
            expect(result.unavailable).toBe(true);
            expect(mockLogRedisDownOnce).toHaveBeenCalledWith({ reason: 'timeout' });
            expect(mockSetLastCallStatus).toHaveBeenCalledWith(false);
        });

        /**
         * Test: Successful check calls setLastCallStatus(true)
         */
        it('should record success status on successful check', async () => {
            const result = await checkRateLimit('user:abc', 'free', 'read');

            expect(result.success).toBe(true);
            expect(mockSetLastCallStatus).toHaveBeenCalledWith(true);
            expect(mockLogRedisDownOnce).not.toHaveBeenCalled();
        });

        /**
         * Test: Rate limit exceeded still records success status (Redis itself worked)
         */
        it('should record success status even when rate limit exceeded', async () => {
            mockLimit.mockResolvedValue({
                success: false,
                limit: 20,
                remaining: 0,
                reset: Date.now() + 1000,
            });

            const result = await checkRateLimit('user:abc', 'free', 'read');

            expect(result.success).toBe(false);
            expect(mockSetLastCallStatus).toHaveBeenCalledWith(true);
            expect(mockLogRedisDownOnce).not.toHaveBeenCalled();
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
                logRedisDownOnce: jest.fn(),
                setLastCallStatus: jest.fn(),
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
         * One request pins daily and hourly limiters to one Redis generation.
         */
        it('should acquire Redis once for both limiter windows', async () => {
            const redis = require('../redis');
            await freshCheckRateLimit('user:abc', 'free', 'auth');

            expect(redis.getRedisClient).toHaveBeenCalledTimes(1);
            expect(freshRatelimit).toHaveBeenCalledTimes(2);
            expect(freshRatelimit.mock.calls[0][0].redis).toBe(
                freshRatelimit.mock.calls[1][0].redis
            );
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

        /**
         * Test: Upstash Ratelimit's fail-open timeout is disabled.
         *
         * Why: timeout: 0 prevents the library from returning success when Redis
         * is slow; the Redis HTTP client timeout owns latency control instead.
         */
        it('should disable the Upstash Ratelimit fail-open timeout', async () => {
            await freshCheckRateLimit('user:abc', 'free', 'insert');

            expect(freshRatelimit).toHaveBeenCalledTimes(2);
            for (const [config] of freshRatelimit.mock.calls) {
                expect(config).toEqual(expect.objectContaining({ timeout: 0 }));
            }
        });
    });

    // =========================================================================
    // Both-limiters-null path
    // =========================================================================
    describe('both limiters null', () => {
        /**
         * Test: tier/operation combo with no configured limits returns pass-through
         *
         * Why: FREE tier has no admin_read / admin_write entries in TIER_LIMITS.
         * When both hourly and daily limits resolve to undefined, checkRateLimit
         * must short-circuit to a successful no-op result rather than crash on
         * an undefined limiter. This is the defensive path that keeps the
         * service available if a future operation is added without limits.
         */
        it('should return success with null fields when both limiters are absent', async () => {
            const result = await checkRateLimit('user:abc', 'free', 'admin_read');

            expect(result.success).toBe(true);
            expect(result.limit).toBeNull();
            expect(result.remaining).toBeNull();
            expect(result.reset).toBeNull();
            expect(result.window).toBeNull();
            expect(mockSetLastCallStatus).toHaveBeenCalledWith(true);
            // No Ratelimit.limit() should have been invoked
            expect(mockLimit).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Warn log throttling
    // =========================================================================
    describe('warn throttling on repeated failures', () => {
        /**
         * Test: Two failures within the 60s window produce exactly one warn
         *
         * Why: Axiom would be flooded if every failing request emitted a warn.
         * error() fires only once per outage via logRedisDownOnce; warn()
         * emits fixed-cardinality context without per-request spam or raw errors.
         *
         * NOTE: module-level throttle state persists across tests. This test
         * uses jest.resetModules() to guarantee a fresh state and fake timers
         * to control the 60s window deterministically.
         */
        it('emits one warn for rapid successive failures, then another after the window', async () => {
            jest.resetModules();

            jest.doMock('@upstash/ratelimit', () => {
                const limitFn = jest.fn().mockRejectedValue(
                    new Error('throttled-provider-sentinel-never-log')
                );
                const RatelimitClass = jest.fn().mockImplementation(() => ({
                    limit: limitFn,
                }));
                RatelimitClass.fixedWindow = jest.fn().mockReturnValue('fixedWindowConfig');
                return { Ratelimit: RatelimitClass };
            });

            const throttleLogger = {
                info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(),
            };
            jest.doMock('../../../shared/logger', () => ({ logger: throttleLogger }));

            jest.doMock('../redis', () => ({
                getRedisClient: jest.fn().mockReturnValue({ id: 'stub-client' }),
                logRedisDownOnce: jest.fn(),
                setLastCallStatus: jest.fn(),
            }));

            const { checkRateLimit: throttledCheck } = require('../rateLimit');

            jest.useFakeTimers();
            try {
                jest.setSystemTime(new Date('2026-04-07T00:00:00Z'));

                // First failure → should warn
                await throttledCheck('user:abc', 'free', 'read');
                expect(throttleLogger.warn).toHaveBeenCalledTimes(1);

                // Second failure 30s later → still within window, must be throttled
                jest.setSystemTime(new Date('2026-04-07T00:00:30Z'));
                await throttledCheck('user:abc', 'free', 'read');
                expect(throttleLogger.warn).toHaveBeenCalledTimes(1);

                // Third failure past 60s → window elapsed, warn again
                jest.setSystemTime(new Date('2026-04-07T00:01:05Z'));
                await throttledCheck('user:abc', 'free', 'read');
                expect(throttleLogger.warn).toHaveBeenCalledTimes(2);
                for (const [logData, message] of throttleLogger.warn.mock.calls) {
                    expect(logData).toEqual({
                        reason: 'limiter_call_failed',
                        errorName: 'Error',
                        identifierClass: 'user',
                        tier: 'free',
                        operation: 'read',
                    });
                    expect(logData).not.toHaveProperty('err');
                    expect(message).toBe('Rate limit check failed');
                }
                expect(JSON.stringify(throttleLogger.warn.mock.calls)).not.toContain(
                    'throttled-provider-sentinel-never-log'
                );
            } finally {
                jest.useRealTimers();
            }
        });
    });
});
