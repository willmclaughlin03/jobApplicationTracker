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
    it('configures a per-request timeout signal for Upstash Redis HTTP calls', () => {
        const redis = require('../redis.js');

        const client = redis.getRedisClient();

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
});
