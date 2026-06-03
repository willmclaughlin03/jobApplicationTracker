import crypto from 'crypto';
import { OPERATIONS } from '../../shared/constants/tiers';
import { logger } from '../../shared/logger';
import { getRedisClient, logRedisDownOnce, setLastCallStatus } from './redis';

const HASH_SECRET_MIN_LENGTH = 32;

export const IP_COOLDOWN_POLICIES = {
    AUTH_SESSION: {
        cooldownSeconds: 30 * 60,
        violationWindowSeconds: 10 * 60,
        violationThreshold: 3,
    },
};

/**
 * Resolves the server-only secret used to HMAC IP identifiers.
 *
 * Purpose: avoid writing raw IP addresses into new cooldown Redis keys while
 * keeping the implementation deployable with the existing CSRF secret until a
 * dedicated IP cooldown secret is configured.
 *
 * @returns {string|null} Secret used for keyed hashing, or null when unavailable
 */
function getIpHashSecret() {
    return process.env.IP_COOLDOWN_HASH_SECRET || process.env.CSRF_SECRET || null;
}

/**
 * Builds a privacy-preserving hash for a normalized IP rate-limit identifier.
 *
 * Purpose: map `ip:{address}` identifiers to stable Redis key fragments without
 * logging or storing the raw address in the cooldown keys.
 *
 * @param {string} identifier - Rate-limit identifier in `ip:{address}` form
 * @returns {{ hash: string|null, unavailable?: boolean }} Hash result
 */
function hashIpIdentifier(identifier) {
    const secret = getIpHashSecret();

    if (!secret || secret.length < HASH_SECRET_MIN_LENGTH) {
        logger.error(
            { hasDedicatedSecret: !!process.env.IP_COOLDOWN_HASH_SECRET, hasCsrfSecret: !!process.env.CSRF_SECRET },
            'IP cooldown hash secret is unavailable'
        );
        return { hash: null, unavailable: true };
    }

    return {
        hash: crypto
            .createHmac('sha256', secret)
            .update(identifier)
            .digest('hex'),
    };
}

/**
 * Builds Redis keys for one operation/IP cooldown state.
 *
 * Purpose: centralize key formatting so cooldown checks and violation recording
 * use the same hashed identifier and TTL-managed key namespace.
 *
 * @param {string} identifier - Rate-limit identifier in `ip:{address}` form
 * @param {string} operation - Operation from OPERATIONS
 * @returns {{ cooldownKey?: string, violationsKey?: string, unavailable?: boolean }}
 */
function buildCooldownKeys(identifier, operation) {
    if (!identifier || typeof identifier !== 'string' || !identifier.startsWith('ip:')) {
        logger.error({ identifierType: identifier?.split?.(':')?.[0] || 'unknown', operation }, 'Invalid IP cooldown identifier');
        return { unavailable: true };
    }

    if (!Object.values(OPERATIONS).includes(operation)) {
        logger.error({ operation }, 'Invalid IP cooldown operation');
        return { unavailable: true };
    }

    const { hash, unavailable } = hashIpIdentifier(identifier);
    if (unavailable) {
        return { unavailable: true };
    }

    return {
        cooldownKey: `rl:cooldown:${operation}:${hash}`,
        violationsKey: `rl:violations:${operation}:${hash}`,
    };
}

/**
 * Returns the Redis client or a fail-closed unavailable sentinel.
 *
 * Purpose: keep cooldown Redis dependency failures aligned with the existing
 * fail-closed rate-limit behavior and one-time Redis outage logging.
 *
 * @param {string} reason - Structured outage reason for logRedisDownOnce()
 * @returns {{ redis?: object, unavailable?: boolean }}
 */
function getRedisOrUnavailable(reason) {
    const redis = getRedisClient();

    if (!redis) {
        logRedisDownOnce({ reason });
        setLastCallStatus(false);
        return { unavailable: true };
    }

    return { redis };
}

/**
 * Checks whether an IP currently has an active cooldown.
 *
 * Purpose: allow middleware to reject cooled-down public requests before
 * spending the normal fixed-window limiter or route handler work.
 *
 * @param {string} identifier - Rate-limit identifier in `ip:{address}` form
 * @param {string} operation - Operation from OPERATIONS
 * @param {object} policy - Cooldown policy with TTL settings
 * @returns {Promise<{ active: boolean, retryAfterSeconds?: number, unavailable?: boolean }>}
 */
export async function checkIpCooldown(identifier, operation, policy = IP_COOLDOWN_POLICIES.AUTH_SESSION) {
    const { redis, unavailable: redisUnavailable } = getRedisOrUnavailable('ip_cooldown_no_client');
    if (redisUnavailable) {
        return { active: false, unavailable: true };
    }

    const { cooldownKey, unavailable: keyUnavailable } = buildCooldownKeys(identifier, operation);
    if (keyUnavailable) {
        setLastCallStatus(false);
        return { active: false, unavailable: true };
    }

    try {
        const ttl = await redis.ttl(cooldownKey);
        setLastCallStatus(true);

        if (ttl > 0) {
            return { active: true, retryAfterSeconds: ttl };
        }

        if (ttl === -1) {
            return {
                active: true,
                retryAfterSeconds: policy.cooldownSeconds,
            };
        }

        return { active: false };
    } catch (error) {
        logRedisDownOnce({ reason: 'ip_cooldown_check_failed' });
        setLastCallStatus(false);
        logger.warn({ err: error, identifierType: 'ip', operation }, 'IP cooldown check failed');
        return { active: false, unavailable: true };
    }
}

/**
 * Records an over-limit public request and starts cooldown when threshold hits.
 *
 * Purpose: turn repeated over-limit behavior into a temporary cooldown while
 * using Redis atomic `SET NX EX` semantics so concurrent requests cannot start
 * multiple cooldown episodes.
 *
 * @param {string} identifier - Rate-limit identifier in `ip:{address}` form
 * @param {string} operation - Operation from OPERATIONS
 * @param {object} policy - Cooldown policy with threshold and TTL settings
 * @returns {Promise<{ violationCount?: number, cooldownStarted?: boolean, cooldownSeconds?: number, unavailable?: boolean }>}
 */
export async function recordIpCooldownViolation(identifier, operation, policy = IP_COOLDOWN_POLICIES.AUTH_SESSION) {
    const { redis, unavailable: redisUnavailable } = getRedisOrUnavailable('ip_cooldown_no_client');
    if (redisUnavailable) {
        return { unavailable: true };
    }

    const { cooldownKey, violationsKey, unavailable: keyUnavailable } = buildCooldownKeys(identifier, operation);
    if (keyUnavailable) {
        setLastCallStatus(false);
        return { unavailable: true };
    }

    try {
        const violationCount = await redis.incr(violationsKey);
        const violationTtl = await redis.ttl(violationsKey);

        if (violationTtl < 0) {
            await redis.expire(violationsKey, policy.violationWindowSeconds);
        }

        if (violationCount < policy.violationThreshold) {
            setLastCallStatus(true);
            return {
                violationCount,
                cooldownStarted: false,
            };
        }

        const setResult = await redis.set(cooldownKey, '1', {
            ex: policy.cooldownSeconds,
            nx: true,
        });

        setLastCallStatus(true);

        return {
            violationCount,
            cooldownStarted: setResult === 'OK',
            cooldownSeconds: policy.cooldownSeconds,
        };
    } catch (error) {
        logRedisDownOnce({ reason: 'ip_cooldown_record_failed' });
        setLastCallStatus(false);
        logger.warn({ err: error, identifierType: 'ip', operation }, 'IP cooldown violation recording failed');
        return { unavailable: true };
    }
}
