import { Ratelimit } from '@upstash/ratelimit'
import { OPERATIONS, TIER_LIMITS, TIERS } from '../../shared/constants/tiers';
import { getRedisClient, logRedisDownOnce, setLastCallStatus } from './redis';
import { logger } from '../../shared/logger';


// Throttle: at most one logger.warn per 60s for repeated failures,
// so distinct error types surface without flooding Axiom.
let lastWarnTime = 0;
const WARN_THROTTLE_MS = 60_000;


/** @type {Map<string, {limiter: Ratelimit, redis: import('@upstash/redis').Redis}>} Cached limiter instances keyed by tier:operation:window */
const limiterCache = new Map()

/**
 * Detects Upstash Ratelimit's availability timeout response.
 *
 * Purpose: the library's built-in timeout is fail-open by default, returning
 * success with `reason: "timeout"`. This app treats that as untrusted Redis
 * availability and fails closed instead.
 *
 * @param {object | null | undefined} result - Raw limiter result
 * @returns {boolean} True when the limiter timed out before Redis answered
 */
function isLimiterTimeoutResult(result) {
    return result?.reason === 'timeout';
}

/**
 * Resolve or create the cached Upstash limiter for one tier/operation/window.
 *
 * Purpose: avoid rebuilding limiter objects on every request while still
 * invalidating the cache if the underlying Redis client instance changes after
 * reconnect or reconfiguration.
 *
 * @param {string} tier
 * @param {string} operation
 * @param {'hourly' | 'daily'} windowType
 * @param {import('@upstash/redis').Redis} redis request-pinned client
 * @returns {Ratelimit | null}
 */
function getOrCreateLimiter(tier, operation, windowType, redis){
    const key = `${tier}:${operation}:${windowType}`

    // if redis client changed, cached limiter holds a stale connection, so rebuild
    const cached = limiterCache.get(key)
    if (cached && cached.redis === redis){
        return cached.limiter
    }

    const limit = TIER_LIMITS[tier]?.[operation]?.[windowType]

    if(limit === null || limit === undefined){
        return null
    }

    const duration = windowType === 'hourly' ? '1 h' : '24 h'

    const limiter = new Ratelimit({
        redis : redis,
        limiter : Ratelimit.fixedWindow(limit,duration),
        prefix: `rl:${key}`,
        timeout: 0
    })

    limiterCache.set(key, { limiter, redis })

    return limiter
}


/**
 * Checks rate limit for a given identifier, tier, and operation
 *
 * Validates inputs, checks Redis availability, then evaluates both hourly
 * and daily windows. Returns the most restrictive result and fails closed to
 * `unavailable` when Redis or limiter evaluation is not trustworthy.
 *
 * Connects to:
 * - getOrCreateLimiter() for cached Ratelimit instances
 * - Redis via Upstash for actual limit evaluation
 *
 * Tradeoff:
 * - the daily window is checked first so a request that is already over the
 *   broader quota does not spend the narrower hourly token too
 *
 * @param {string} identifier - Rate limit key (e.g. 'user:uuid' or 'ip:1.2.3.4')
 * @param {string} tier - User tier from TIERS constant
 * @param {string} operation - Operation type from OPERATIONS constant
 * @returns {Promise<Object>} Rate limit result with success, limit, remaining, reset, window
 */
export async function checkRateLimit(identifier, tier, operation){
    if(!identifier || typeof identifier !== 'string'){
        logger.error({ tier, operation }, 'checkRateLimit called with invalid identifier');
        return { success: false, unavailable: true }
    }

    if(!Object.values(TIERS).includes(tier)){
        logger.error({ tier, operation }, 'checkRateLimit called with invalid tier');
        return { success: false, unavailable: true }
    }

    if(!Object.values(OPERATIONS).includes(operation)){
        logger.error({ tier, operation }, 'checkRateLimit called with invalid operation');
        return { success: false, unavailable: true }
    }

    const redis = await getRedisClient()

    if (!redis) {
        logRedisDownOnce({ reason: 'no_client' });
        setLastCallStatus(false);
        return { success: false, unavailable: true }
    }

    try{
        // Pin both windows to one immutable client identity for this request.
        const hourlyLimiter = getOrCreateLimiter(tier, operation, 'hourly', redis);
        const dailyLimiter = getOrCreateLimiter(tier, operation, 'daily', redis);

        if (!hourlyLimiter && !dailyLimiter){
            setLastCallStatus(true);
            return { success : true, limit : null, remaining : null, reset : null, window: null}
        }

        let mostRestrictive = null;

        // Check daily (broader) window FIRST to avoid draining the smaller hourly bucket
        if (dailyLimiter) {
            const daily = await dailyLimiter.limit(identifier);
            if (isLimiterTimeoutResult(daily)) {
                logRedisDownOnce({ reason: 'timeout' });
                setLastCallStatus(false);
                return { success: false, unavailable: true };
            }
            if (!daily.success) {
                setLastCallStatus(true);
                return { success: false, limit: daily.limit, remaining: 0, reset: daily.reset, window: 'daily' };
        }
            mostRestrictive = { ...daily, window: 'daily' };
        }

        if (hourlyLimiter) {
            const hourly = await hourlyLimiter.limit(identifier);
            if (isLimiterTimeoutResult(hourly)) {
                logRedisDownOnce({ reason: 'timeout' });
                setLastCallStatus(false);
                return { success: false, unavailable: true };
            }
            if (!hourly.success) {
                setLastCallStatus(true);
                return { success: false, limit: hourly.limit, remaining: 0, reset: hourly.reset, window: 'hourly' };
        }
            if (!mostRestrictive || hourly.remaining <= mostRestrictive.remaining) {
                mostRestrictive = { ...hourly, window: 'hourly' };
        }
    }

        setLastCallStatus(true);
        return {
            success: true,
            limit: mostRestrictive.limit,
            remaining: mostRestrictive.remaining,
            reset: mostRestrictive.reset,
            window: mostRestrictive.window
        }


    }catch(error){
        logRedisDownOnce({ reason: 'call_failed' });
        setLastCallStatus(false);

        const now = Date.now();
        if (now - lastWarnTime >= WARN_THROTTLE_MS) {
            logger.warn({ err: error, identifierType: identifier?.split(':')[0] || 'unknown', tier, operation }, 'Rate limit check failed');
            lastWarnTime = now;
        }

        return { success: false, unavailable : true}
    }
}
