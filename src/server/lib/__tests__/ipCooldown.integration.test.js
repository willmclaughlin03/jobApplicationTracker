/**
 * Integration tests for ipCooldown.js against real Upstash Redis.
 *
 * Purpose: Verify cooldown helper assumptions that mocks cannot prove:
 * live TTL behavior, INCR/EXPIRE state, and SET NX EX atomicity.
 *
 * Connects to:
 * - src/server/lib/ipCooldown.js
 * - src/server/lib/redis.js
 *
 * Requires: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, and either
 * IP_COOLDOWN_HASH_SECRET or CSRF_SECRET with at least 32 characters.
 * Run with: npm run test:integration
 */

jest.setTimeout(15_000);

const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.mock('../../../shared/logger.js', () => ({ logger: mockLogger }));

const hasUsableHashSecret = [
    process.env.IP_COOLDOWN_HASH_SECRET,
    process.env.CSRF_SECRET,
].some(secret => typeof secret === 'string' && secret.length >= 32);

const SKIP_INTEGRATION =
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN ||
    !hasUsableHashSecret;

const describeIntegration = SKIP_INTEGRATION ? describe.skip : describe;

describeIntegration('ipCooldown.js - integration (real Upstash)', () => {
    let checkIpCooldown;
    let recordIpCooldownViolation;
    let redis;
    let identifierCounter;

    const shortPolicy = {
        cooldownSeconds: 2,
        violationWindowSeconds: 5,
        violationThreshold: 1,
    };

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        redis = require('../redis.js');
        ({ checkIpCooldown, recordIpCooldownViolation } = require('../ipCooldown.js'));
        identifierCounter = 0;
    });

    afterEach(() => {
        redis.resetRedisClient();
    });

    /**
     * Builds a unique documentation-range IP identifier for one test case.
     *
     * Purpose: prevent cross-test key collisions while keeping identifiers in
     * production-shaped `ip:{address}` form.
     *
     * @returns {string} Unique IP cooldown identifier
     */
    function testIdentifier() {
        identifierCounter += 1;
        const timeGroup = (Date.now() % 0xffff).toString(16);
        const randomGroup = Math.floor(Math.random() * 0xffff).toString(16);
        const counterGroup = identifierCounter.toString(16);
        return `ip:2001:db8:${timeGroup}:${randomGroup}::${counterGroup}`;
    }

    /**
     * Waits for Redis TTL expiry with a small buffer for second-granular TTLs.
     *
     * @param {number} milliseconds - Duration to wait
     * @returns {Promise<void>}
     */
    function wait(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    /**
     * Live TTL flow: record starts cooldown, active check sees it, then expiry clears it.
     */
    it('starts an active cooldown and observes live expiry', async () => {
        const identifier = testIdentifier();

        const recordResult = await recordIpCooldownViolation(identifier, 'auth', shortPolicy);
        expect(recordResult).toEqual(expect.objectContaining({
            cooldownStarted: true,
            cooldownSeconds: shortPolicy.cooldownSeconds,
        }));

        const activeResult = await checkIpCooldown(identifier, 'auth', shortPolicy);
        expect(activeResult.active).toBe(true);
        expect(activeResult.retryAfterSeconds).toBeGreaterThan(0);

        await wait(3_000);

        const expiredResult = await checkIpCooldown(identifier, 'auth', shortPolicy);
        expect(expiredResult).toEqual({ active: false });
    });

    /**
     * Live atomicity flow: SET NX EX lets only one concurrent caller start the episode.
     */
    it('starts only one cooldown episode for concurrent threshold crossings', async () => {
        const identifier = testIdentifier();

        const results = await Promise.all([
            recordIpCooldownViolation(identifier, 'auth', shortPolicy),
            recordIpCooldownViolation(identifier, 'auth', shortPolicy),
        ]);

        const startedCount = results.filter(result => result.cooldownStarted === true).length;
        expect(startedCount).toBe(1);

        const activeResult = await checkIpCooldown(identifier, 'auth', shortPolicy);
        expect(activeResult.active).toBe(true);
    });
});
