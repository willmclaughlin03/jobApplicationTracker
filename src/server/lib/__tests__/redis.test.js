/**
 * Tests for redis.js
 *
 * Purpose: Verify Redis client configuration that can be tested without a live
 * Upstash instance.
 *
 * Connects to: src/server/lib/redis.js
 */

const mockRedisConstructor = jest.fn();

jest.mock('@upstash/redis', () => ({
    Redis: mockRedisConstructor,
}));

const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.mock('../../../shared/logger.js', () => ({
    logger: mockLogger,
}));

describe('redis.js', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
        mockRedisConstructor.mockImplementation(function MockRedis(config) {
            this.config = config;
            this.ping = jest.fn();
        });
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    /**
     * Test: Redis client receives a request-scoped abort signal factory.
     *
     * Why: Upstash Ratelimit's own timeout is fail-open, so network latency must
     * be bounded at the Redis HTTP client layer where aborts throw and preserve
     * the app's fail-closed rate-limit contract.
     */
    it('configures a per-request timeout signal for Upstash Redis HTTP calls', async () => {
        const redis = require('../redis.js');

        const client = await redis.getRedisClient();

        expect(client).not.toBeNull();
        expect(mockRedisConstructor).toHaveBeenCalledWith(
            expect.objectContaining({
                url: 'https://example.upstash.io',
                token: 'test-token',
                signal: expect.any(Function),
            })
        );

        const signalFactory = mockRedisConstructor.mock.calls[0][0].signal;
        const signal = signalFactory();
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal.aborted).toBe(false);
    });

    /**
     * A validated runtime pair pins and rotates the Redis client by pair identity.
     */
    it('reuses one client per immutable runtime pair and swaps after refresh', async () => {
        const redis = require('../redis.js');
        const firstPair = Object.freeze({
            redis: Object.freeze({
                url: 'https://first-synthetic.upstash.io',
                token: 'synthetic-token-one',
            }),
            cacheIdentity: Object.freeze({}),
        });
        const secondPair = Object.freeze({
            redis: Object.freeze({
                url: 'https://second-synthetic.upstash.io',
                token: 'synthetic-token-two',
            }),
            cacheIdentity: Object.freeze({}),
        });

        const first = await redis.getRedisClient(firstPair);
        expect(await redis.getRedisClient(firstPair)).toBe(first);
        const second = await redis.getRedisClient(secondPair);
        expect(second).not.toBe(first);
        expect(mockRedisConstructor).toHaveBeenCalledTimes(2);
    });

    /**
     * Deployed Secrets Manager mode may not fall back to explicit environment credentials.
     */
    it('does not use environment credentials after deployed secret acquisition fails', async () => {
        process.env.NODE_ENV = 'production';
        process.env.TEMPORARY_SESSION_CEILING_SECRET_MODE = 'aws-secrets-manager';
        delete process.env.TEMPORARY_SESSION_CEILING_HMAC_SECRET_ID;
        delete process.env.TEMPORARY_SESSION_CEILING_REDIS_SECRET_ID;
        const redis = require('../redis.js');

        await expect(redis.getRedisClient()).resolves.toBeNull();
        expect(mockRedisConstructor).not.toHaveBeenCalled();
    });
});
