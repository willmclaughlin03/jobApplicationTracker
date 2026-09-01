/**
 * Tests for redis.js
 *
 * Purpose: Verify Redis client configuration that can be tested without a live
 * Upstash instance.
 *
 * Connects to: src/server/lib/redis.js
 */

const mockRedisConstructor = jest.fn();
const TEST_HMAC_KEY = Buffer.alloc(32, 7).toString('base64url');

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
     * Invalid Redis tokens fail with a fixed validation reason.
     *
     * Why: credential diagnostics must distinguish bounded token failures
     * without placing any part of the secret token into application logs.
     */
    it.each([
        ['missing', undefined, 'token_missing'],
        ['non-string', { secret: 'non-string-secret' }, 'token_not_string'],
        ['empty', '', 'token_empty'],
        ['oversized', `oversized-secret-${'x'.repeat(2_048)}`, 'token_too_long'],
    ])('rejects a %s Redis token without logging its value', async (_caseName, token, validationError) => {
        const redis = require('../redis.js');
        const runtimePair = Object.freeze({
            redis: Object.freeze({
                url: process.env.UPSTASH_REDIS_REST_URL,
                token,
            }),
            cacheIdentity: Object.freeze({}),
        });

        await expect(redis.getRedisClient(runtimePair)).resolves.toBeNull();
        expect(mockRedisConstructor).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalledWith(
            { validationError },
            'Invalid Redis token configuration'
        );
        expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('secret');
    });

    /**
     * Invalid URLs retain the existing validation log when the token is invalid too.
     *
     * Why: token validation must not replace the established URL diagnostic or
     * expose token-derived data when both credential fields fail validation.
     */
    it('preserves Redis URL validation logging ahead of token validation', async () => {
        const redis = require('../redis.js');
        const runtimePair = Object.freeze({
            redis: Object.freeze({
                url: 'http://example.upstash.io',
                token: { secret: 'non-string-secret' },
            }),
            cacheIdentity: Object.freeze({}),
        });

        await expect(redis.getRedisClient(runtimePair)).resolves.toBeNull();
        expect(mockRedisConstructor).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalledWith(
            { validationError: 'Redis URL must be HTTPS' },
            'Invalid Redis URL configuration'
        );
        expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('secret');
    });

    /**
     * Alternating immutable credential identities reuse their retained clients.
     *
     * Why: the temporary-session ceiling and generic rate limiter can alternate
     * identities even when both credential paths remain active in one process.
     */
    it('reuses clients when runtime-pair and generic-local callers alternate', async () => {
        process.env.NODE_ENV = 'test';
        process.env.TEMPORARY_SESSION_CEILING_SECRET_MODE = 'local';
        const redis = require('../redis.js');
        const runtimePair = Object.freeze({
            redis: Object.freeze({
                url: process.env.UPSTASH_REDIS_REST_URL,
                token: process.env.UPSTASH_REDIS_REST_TOKEN,
            }),
            cacheIdentity: Object.freeze({}),
        });

        const runtimeClient = await redis.getRedisClient(runtimePair);
        const genericClient = await redis.getRedisClient();

        expect(genericClient).not.toBe(runtimeClient);
        expect(await redis.getRedisClient(runtimePair)).toBe(runtimeClient);
        expect(await redis.getRedisClient()).toBe(genericClient);
        expect(mockRedisConstructor).toHaveBeenCalledTimes(2);
    });

    /**
     * The identity cache evicts the least-recently-used client at its fixed cap.
     *
     * Why: credential refreshes must not allow retired Redis clients to grow
     * without bound over the lifetime of a server process.
     */
    it('bounds retained Redis clients and evicts the least-recently-used identity', async () => {
        const redis = require('../redis.js');
        const pairs = ['first', 'second', 'third'].map((name) => Object.freeze({
            redis: Object.freeze({
                url: `https://${name}-synthetic.upstash.io`,
                token: `synthetic-token-${name}`,
            }),
            cacheIdentity: Object.freeze({}),
        }));

        const first = await redis.getRedisClient(pairs[0]);
        const second = await redis.getRedisClient(pairs[1]);
        expect(await redis.getRedisClient(pairs[0])).toBe(first);
        await redis.getRedisClient(pairs[2]);

        expect(await redis.getRedisClient(pairs[0])).toBe(first);
        expect(await redis.getRedisClient(pairs[1])).not.toBe(second);
        expect(mockRedisConstructor).toHaveBeenCalledTimes(4);
    });

    /**
     * Deployed Vercel mode may not fall back to standalone Redis credentials.
     */
    it('does not use standalone credentials after deployed configuration fails', async () => {
        process.env.NODE_ENV = 'production';
        process.env.VERCEL = '1';
        process.env.TEMPORARY_SESSION_CEILING_SECRET_MODE = 'vercel';
        delete process.env.TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON;
        delete process.env.TEMPORARY_SESSION_CEILING_UPSTASH_JSON;
        const redis = require('../redis.js');

        await expect(redis.getRedisClient()).resolves.toBeNull();
        expect(mockRedisConstructor).not.toHaveBeenCalled();
    });

    /**
     * Generic consumers retain the same immutable Vercel runtime credentials.
     *
     * Why: environment mutation must not split the generic limiter from the
     * temporary-session ceiling during one deployment instance.
     */
    it('uses the memoized Vercel runtime pair for generic consumers', async () => {
        process.env.NODE_ENV = 'production';
        process.env.VERCEL = '1';
        process.env.TEMPORARY_SESSION_CEILING_SECRET_MODE = 'vercel';
        process.env.TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON = JSON.stringify({
            schemaVersion: 1,
            active: { generation: 1, keyId: 'gate1-key-1', key: TEST_HMAC_KEY },
            previous: null,
        });
        process.env.TEMPORARY_SESSION_CEILING_UPSTASH_JSON = JSON.stringify({
            schemaVersion: 1,
            url: 'https://deployed-synthetic.upstash.io',
            token: 'deployed-token-one',
        });
        const redis = require('../redis.js');

        await redis.getRedisClient();
        process.env.TEMPORARY_SESSION_CEILING_UPSTASH_JSON = JSON.stringify({
            schemaVersion: 1,
            url: 'https://changed-synthetic.upstash.io',
            token: 'deployed-token-two',
        });
        redis.resetRedisClient();
        await redis.getRedisClient();

        expect(mockRedisConstructor).toHaveBeenCalledTimes(2);
        expect(mockRedisConstructor.mock.calls[0][0]).toMatchObject({
            url: 'https://deployed-synthetic.upstash.io',
            token: 'deployed-token-one',
        });
        expect(mockRedisConstructor.mock.calls[1][0]).toMatchObject({
            url: 'https://deployed-synthetic.upstash.io',
            token: 'deployed-token-one',
        });
    });
});
