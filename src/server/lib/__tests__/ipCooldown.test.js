/**
 * Tests for IP cooldown helper
 *
 * Purpose: Verify Redis-backed public-route cooldown checks, hashed key
 * construction, fail-closed Redis handling, and atomic cooldown episode start.
 *
 * Connects to:
 * - src/server/lib/ipCooldown.js
 * - src/server/lib/redis.js
 */

const mockRedis = {
    ttl: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    set: jest.fn(),
};

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

const {
    IP_COOLDOWN_POLICIES,
    checkIpCooldown,
    recordIpCooldownViolation,
} = require('../ipCooldown');

describe('ipCooldown helper', () => {
    const originalIpSecret = process.env.IP_COOLDOWN_HASH_SECRET;
    const originalCsrfSecret = process.env.CSRF_SECRET;
    const policy = IP_COOLDOWN_POLICIES.AUTH_SESSION;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.IP_COOLDOWN_HASH_SECRET = 'x'.repeat(32);
        delete process.env.CSRF_SECRET;
        mockGetRedisClient.mockReturnValue(mockRedis);
        mockRedis.ttl.mockResolvedValue(-2);
        mockRedis.incr.mockResolvedValue(1);
        mockRedis.expire.mockResolvedValue(1);
        mockRedis.set.mockResolvedValue(null);
    });

    afterAll(() => {
        if (originalIpSecret === undefined) {
            delete process.env.IP_COOLDOWN_HASH_SECRET;
        } else {
            process.env.IP_COOLDOWN_HASH_SECRET = originalIpSecret;
        }

        if (originalCsrfSecret === undefined) {
            delete process.env.CSRF_SECRET;
        } else {
            process.env.CSRF_SECRET = originalCsrfSecret;
        }
    });

    /**
     * Active cooldown path: positive Redis TTL blocks request with retry timing.
     */
    it('returns active cooldown with Retry-After seconds when TTL is positive', async () => {
        mockRedis.ttl.mockResolvedValue(120);

        const result = await checkIpCooldown('ip:192.0.2.10', 'auth', policy);

        expect(result).toEqual({ active: true, retryAfterSeconds: 120 });
        expect(mockSetLastCallStatus).toHaveBeenCalledWith(true);
    });

    /**
     * Inactive path: missing cooldown key allows normal rate-limit evaluation.
     */
    it('returns inactive when cooldown key is absent', async () => {
        mockRedis.ttl.mockResolvedValue(-2);

        const result = await checkIpCooldown('ip:192.0.2.10', 'auth', policy);

        expect(result).toEqual({ active: false });
        expect(mockSetLastCallStatus).toHaveBeenCalledWith(true);
    });

    /**
     * Privacy: Redis keys must not include the raw IP address.
     */
    it('does not include raw IP addresses in Redis cooldown keys', async () => {
        await checkIpCooldown('ip:192.0.2.10', 'auth', policy);

        expect(mockRedis.ttl).toHaveBeenCalledTimes(1);
        const [cooldownKey] = mockRedis.ttl.mock.calls[0];
        expect(cooldownKey).toContain('rl:cooldown:auth:');
        expect(cooldownKey).not.toContain('192.0.2.10');
    });

    /**
     * Config failure: missing hash secret is treated as unavailable.
     */
    it('fails closed when no usable hash secret is configured', async () => {
        delete process.env.IP_COOLDOWN_HASH_SECRET;
        delete process.env.CSRF_SECRET;

        const result = await checkIpCooldown('ip:192.0.2.10', 'auth', policy);

        expect(result).toEqual({ active: false, unavailable: true });
        expect(mockRedis.ttl).not.toHaveBeenCalled();
        expect(mockSetLastCallStatus).toHaveBeenCalledWith(false);
    });

    /**
     * Redis unavailable path: null client fails closed.
     */
    it('fails closed when Redis client is unavailable', async () => {
        mockGetRedisClient.mockReturnValue(null);

        const result = await checkIpCooldown('ip:192.0.2.10', 'auth', policy);

        expect(result).toEqual({ active: false, unavailable: true });
        expect(mockLogRedisDownOnce).toHaveBeenCalledWith({ reason: 'ip_cooldown_no_client' });
        expect(mockSetLastCallStatus).toHaveBeenCalledWith(false);
    });

    /**
     * Violation path: below threshold records count and sets the TTL window.
     */
    it('records below-threshold violations without starting cooldown', async () => {
        mockRedis.incr.mockResolvedValue(1);
        mockRedis.ttl.mockResolvedValue(-1);

        const result = await recordIpCooldownViolation('ip:192.0.2.10', 'auth', policy);

        expect(result).toEqual({ violationCount: 1, cooldownStarted: false });
        expect(mockRedis.expire).toHaveBeenCalledWith(expect.stringContaining('rl:violations:auth:'), policy.violationWindowSeconds);
        expect(mockRedis.set).not.toHaveBeenCalled();
        expect(mockSetLastCallStatus).toHaveBeenCalledWith(true);
    });

    /**
     * Threshold path: reaching threshold starts one cooldown episode.
     */
    it('starts cooldown when violation threshold is reached', async () => {
        mockRedis.incr.mockResolvedValue(policy.violationThreshold);
        mockRedis.ttl.mockResolvedValue(300);
        mockRedis.set.mockResolvedValue('OK');

        const result = await recordIpCooldownViolation('ip:192.0.2.10', 'auth', policy);

        expect(result).toEqual({
            violationCount: policy.violationThreshold,
            cooldownStarted: true,
            cooldownSeconds: policy.cooldownSeconds,
        });
        expect(mockRedis.set).toHaveBeenCalledWith(
            expect.stringContaining('rl:cooldown:auth:'),
            '1',
            { ex: policy.cooldownSeconds, nx: true }
        );
    });

    /**
     * Atomicity: SET NX means only the winning request starts the episode.
     */
    it('uses SET NX semantics so concurrent threshold crossings do not both start cooldown', async () => {
        mockRedis.incr
            .mockResolvedValueOnce(policy.violationThreshold)
            .mockResolvedValueOnce(policy.violationThreshold + 1);
        mockRedis.ttl.mockResolvedValue(300);
        mockRedis.set
            .mockResolvedValueOnce('OK')
            .mockResolvedValueOnce(null);

        const first = await recordIpCooldownViolation('ip:192.0.2.10', 'auth', policy);
        const second = await recordIpCooldownViolation('ip:192.0.2.10', 'auth', policy);

        expect(first.cooldownStarted).toBe(true);
        expect(second.cooldownStarted).toBe(false);
        expect(mockRedis.set).toHaveBeenCalledTimes(2);
        for (const call of mockRedis.set.mock.calls) {
            expect(call[2]).toEqual({ ex: policy.cooldownSeconds, nx: true });
        }
    });

    /**
     * Redis failure path: command failures fail closed and avoid raw IP logging.
     */
    it('fails closed when violation recording throws', async () => {
        mockRedis.incr.mockRejectedValue(new Error('redis down'));

        const result = await recordIpCooldownViolation('ip:192.0.2.10', 'auth', policy);

        expect(result).toEqual({ unavailable: true });
        expect(mockLogRedisDownOnce).toHaveBeenCalledWith({ reason: 'ip_cooldown_record_failed' });
        expect(mockSetLastCallStatus).toHaveBeenCalledWith(false);
        expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('192.0.2.10');
    });
});
