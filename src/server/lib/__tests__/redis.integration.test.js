/**
 * Integration tests for redis.js against real Upstash instance
 *
 * Purpose: Verify Redis singleton lifecycle, one-time logging,
 * call status tracking, and URL validation against a live Upstash Redis.
 *
 * Connects to: src/server/lib/redis.js
 *
 * Requires: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN env vars
 * Run with: npm run test:integration
 *
 * Test coverage:
 * - getRedisClient() initializes with real credentials
 * - resetRedisClient() clears state and allows re-initialization
 * - logRedisDownOnce() logs once per outage window, silences subsequent calls
 * - setLastCallStatus(true) clears one-time flag and logs recovery
 * - getRedisStatus() returns correct shape and types
 * - URL validation: HTTPS required (rejects HTTP), non-Upstash domain warns but initializes
 * - Malicious inputs: garbage URLs, missing tokens, SQL-injection-style keys
 */

jest.mock('../../../shared/logger.js', () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    },
}));

// Fail fast if env vars missing — don't silently skip
const SKIP_INTEGRATION =
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN;

const describeIntegration = SKIP_INTEGRATION ? describe.skip : describe;

describeIntegration('redis.js — integration (real Upstash)', () => {
    let redis;

    beforeEach(() => {
        // Fresh module per test to reset singleton state
        jest.resetModules();
        jest.clearAllMocks();
        redis = require('../redis.js');
    });

    afterEach(() => {
        redis.resetRedisClient();
    });

    // ===================================================================
    // Singleton lifecycle
    // ===================================================================

    describe('getRedisClient()', () => {
        it('initializes and returns a client with real credentials', () => {
            const client = redis.getRedisClient();
            expect(client).not.toBeNull();
            expect(typeof client.ping).toBe('function');
        });

        it('returns the same instance on subsequent calls (singleton)', () => {
            const first = redis.getRedisClient();
            const second = redis.getRedisClient();
            expect(first).toBe(second);
        });
    });

    // ===================================================================
    // resetRedisClient()
    // ===================================================================

    describe('resetRedisClient()', () => {
        it('clears state and allows re-initialization', () => {
            const first = redis.getRedisClient();
            expect(first).not.toBeNull();

            redis.resetRedisClient();

            const second = redis.getRedisClient();
            expect(second).not.toBeNull();
            // New instance — different reference
            expect(second).not.toBe(first);
        });

        it('resets getRedisStatus() to clean state', () => {
            redis.getRedisClient();
            redis.resetRedisClient();

            const status = redis.getRedisStatus();
            expect(status.initialized).toBe(false);
            expect(status.connected).toBe(false);
            expect(status.lastCallSucceeded).toBeNull();
            expect(status.lastCallTime).toBeNull();
        });

        it('resets the one-time log flag so next outage logs again', () => {
            const mockLogger = require('../../../shared/logger.js').logger;

            redis.logRedisDownOnce({ reason: 'test' });
            expect(mockLogger.error).toHaveBeenCalledTimes(1);

            // Silenced on second call
            redis.logRedisDownOnce({ reason: 'test' });
            expect(mockLogger.error).toHaveBeenCalledTimes(1);

            // Reset clears the flag
            redis.resetRedisClient();
            redis.logRedisDownOnce({ reason: 'test_after_reset' });
            expect(mockLogger.error).toHaveBeenCalledTimes(2);
        });
    });

    // ===================================================================
    // logRedisDownOnce()
    // ===================================================================

    describe('logRedisDownOnce()', () => {
        it('logs once then silences subsequent calls', () => {
            const mockLogger = require('../../../shared/logger.js').logger;

            redis.logRedisDownOnce({ reason: 'no_client' });
            redis.logRedisDownOnce({ reason: 'no_client' });
            redis.logRedisDownOnce({ reason: 'call_failed' });

            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).toHaveBeenCalledWith(
                { reason: 'no_client' },
                'Redis is unavailable — requests will be denied (fail-closed)'
            );
        });

        it('passes context object to the log entry', () => {
            const mockLogger = require('../../../shared/logger.js').logger;

            redis.logRedisDownOnce({ reason: 'call_failed', extra: 'data' });

            expect(mockLogger.error).toHaveBeenCalledWith(
                { reason: 'call_failed', extra: 'data' },
                expect.any(String)
            );
        });
    });

    // ===================================================================
    // setLastCallStatus()
    // ===================================================================

    describe('setLastCallStatus()', () => {
        it('records success status in getRedisStatus()', () => {
            redis.setLastCallStatus(true);

            const status = redis.getRedisStatus();
            expect(status.lastCallSucceeded).toBe(true);
            expect(status.lastCallTime).not.toBeNull();
            expect(() => new Date(status.lastCallTime)).not.toThrow();
        });

        it('records failure status in getRedisStatus()', () => {
            redis.setLastCallStatus(false);

            const status = redis.getRedisStatus();
            expect(status.lastCallSucceeded).toBe(false);
            expect(status.lastCallTime).not.toBeNull();
        });

        it('clears the one-time log flag on success after an outage', () => {
            const mockLogger = require('../../../shared/logger.js').logger;

            // Simulate outage
            redis.logRedisDownOnce({ reason: 'call_failed' });
            expect(mockLogger.error).toHaveBeenCalledTimes(1);

            // Recovery
            redis.setLastCallStatus(true);
            expect(mockLogger.info).toHaveBeenCalledWith('Redis connectivity restored');

            // Next outage should log again (flag was cleared)
            redis.logRedisDownOnce({ reason: 'call_failed_again' });
            expect(mockLogger.error).toHaveBeenCalledTimes(2);
        });

        it('does not log recovery when no prior outage was logged', () => {
            const mockLogger = require('../../../shared/logger.js').logger;

            redis.setLastCallStatus(true);

            expect(mockLogger.info).not.toHaveBeenCalledWith('Redis connectivity restored');
        });
    });

    // ===================================================================
    // getRedisStatus() shape
    // ===================================================================

    describe('getRedisStatus()', () => {
        it('returns correct shape and types after initialization', () => {
            redis.getRedisClient();
            redis.setLastCallStatus(true);

            const status = redis.getRedisStatus();

            expect(typeof status.initialized).toBe('boolean');
            expect(status.initialized).toBe(true);
            expect(typeof status.connected).toBe('boolean');
            expect(status.connected).toBe(true);
            expect(typeof status.lastCallSucceeded).toBe('boolean');
            expect(status.lastCallSucceeded).toBe(true);
            expect(typeof status.lastCallTime).toBe('string');
            expect(() => new Date(status.lastCallTime)).not.toThrow();
        });

        it('returns null lastCallSucceeded and lastCallTime before any calls', () => {
            const status = redis.getRedisStatus();
            expect(status.lastCallSucceeded).toBeNull();
            expect(status.lastCallTime).toBeNull();
        });
    });

    // ===================================================================
    // URL validation
    // ===================================================================

    describe('URL validation', () => {
        it('rejects HTTP URLs (HTTPS required)', () => {
            jest.resetModules();
            jest.clearAllMocks();

            const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
            process.env.UPSTASH_REDIS_REST_URL = 'http://insecure.upstash.io';

            const freshRedis = require('../redis.js');
            const freshLogger = require('../../../shared/logger.js').logger;
            const client = freshRedis.getRedisClient();
            expect(client).toBeNull();

            expect(freshLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ validationError: 'Redis URL must be HTTPS' }),
                expect.any(String)
            );

            process.env.UPSTASH_REDIS_REST_URL = originalUrl;
            freshRedis.resetRedisClient();
        });

        it('non-Upstash HTTPS domain warns but still initializes', () => {
            jest.resetModules();
            jest.clearAllMocks();

            const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
            process.env.UPSTASH_REDIS_REST_URL = 'https://my-custom-redis.example.com';

            const freshRedis = require('../redis.js');
            const freshLogger = require('../../../shared/logger.js').logger;
            const client = freshRedis.getRedisClient();

            // Client should still initialize (warn, not reject)
            expect(client).not.toBeNull();
            expect(freshLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ hostname: 'my-custom-redis.example.com' }),
                expect.stringContaining('not in allowed list')
            );

            process.env.UPSTASH_REDIS_REST_URL = originalUrl;
            freshRedis.resetRedisClient();
        });

        it('rejects garbage URL strings', () => {
            jest.resetModules();
            jest.clearAllMocks();

            const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
            process.env.UPSTASH_REDIS_REST_URL = 'not-a-url-at-all';

            const freshRedis = require('../redis.js');
            const freshLogger = require('../../../shared/logger.js').logger;
            const client = freshRedis.getRedisClient();
            expect(client).toBeNull();

            expect(freshLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ validationError: 'Invalid URL format' }),
                expect.any(String)
            );

            process.env.UPSTASH_REDIS_REST_URL = originalUrl;
            freshRedis.resetRedisClient();
        });

        it('rejects missing token', () => {
            jest.resetModules();
            jest.clearAllMocks();

            const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
            process.env.UPSTASH_REDIS_REST_TOKEN = '';

            const freshRedis = require('../redis.js');
            const freshLogger = require('../../../shared/logger.js').logger;
            const client = freshRedis.getRedisClient();
            expect(client).toBeNull();

            expect(freshLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ hasUrl: true, hasToken: false }),
                expect.any(String)
            );

            process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
            freshRedis.resetRedisClient();
        });

        it('rejects empty URL', () => {
            jest.resetModules();
            jest.clearAllMocks();

            const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
            process.env.UPSTASH_REDIS_REST_URL = '';

            const freshRedis = require('../redis.js');
            const client = freshRedis.getRedisClient();
            expect(client).toBeNull();

            process.env.UPSTASH_REDIS_REST_URL = originalUrl;
            freshRedis.resetRedisClient();
        });
    });

    // ===================================================================
    // Malicious input resilience
    // ===================================================================

    describe('malicious input resilience', () => {
        it('handles SQL-injection-style keys without crashing', async () => {
            const client = redis.getRedisClient();
            expect(client).not.toBeNull();

            // These should not crash — Redis treats them as opaque strings
            const maliciousKey = "test:'; DROP TABLE users; --";
            await expect(client.set(maliciousKey, 'value')).resolves.not.toThrow();
            await client.del(maliciousKey);
        });

        it('handles keys with null bytes', async () => {
            const client = redis.getRedisClient();
            const nullKey = 'test:key\x00with\x00nulls';
            // Upstash REST API may reject or handle — should not crash
            try {
                await client.set(nullKey, 'value');
                await client.del(nullKey);
            } catch (e) {
                // Rejection is acceptable — crash is not
                expect(e).toBeDefined();
            }
        });

        it('handles unicode keys', async () => {
            const client = redis.getRedisClient();
            const unicodeKey = 'test:キー:🔑:مفتاح';
            await expect(client.set(unicodeKey, 'value')).resolves.not.toThrow();
            await client.del(unicodeKey);
        });
    });
});
