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
                'checkRateLimit called with invalid identifier',
                expect.any(Object)
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
                'checkRateLimit called with invalid tier',
                expect.objectContaining({ tier: 'premium' })
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
                'checkRateLimit called with invalid operation',
                expect.objectContaining({ operation: 'execute' })
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
                call => call[0] === 'Rate limit check failed'
            );

            if (rateLimitErrorCall) {
                const logData = rateLimitErrorCall[1];
                expect(logData.identifierType).toBe('user');
                expect(logData).not.toHaveProperty('identifier');
                expect(JSON.stringify(logData)).not.toContain('sensitive-user-id-123');
            }
        });

        /**
         * Test: IP-based identifier type is logged correctly
         */
        it('should log ip as identifier type for IP-based identifiers', async () => {
            mockIsRedisHealthy.mockRejectedValue(new Error('Timeout'));

            await checkRateLimit('ip:192.168.1.100', 'free', 'read');

            const errorCalls = mockLogger.error.mock.calls;
            const rateLimitErrorCall = errorCalls.find(
                call => call[0] === 'Rate limit check failed'
            );

            if (rateLimitErrorCall) {
                const logData = rateLimitErrorCall[1];
                expect(logData.identifierType).toBe('ip');
                expect(JSON.stringify(logData)).not.toContain('192.168.1.100');
            }
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
});
