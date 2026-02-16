import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { OPERATIONS, TIER_LIMITS, TIERS } from '../../shared/constants/tiers';
import { getRedisClient, isRedisHealthy } from './redis';
import { logger } from '../../shared/logger';





/** @type {Map<string, {limiter: Ratelimit, redis: Redis}>} Cached limiter instances keyed by tier:operation:window */
const limiterCache = new Map()

function getOrCreateLimiter(tier, operation, windowType){
    const key = `${tier}:${operation}:${windowType}`
    const redis = getRedisClient()

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
        prefix: `rl:${key}`
    })

    limiterCache.set(key, { limiter, redis })

    return limiter
}


/**
 * Checks rate limit for a given identifier, tier, and operation
 *
 * Validates inputs, checks Redis health, then evaluates both hourly
 * and daily windows. Returns the most restrictive result.
 *
 * Connects to:
 * - getOrCreateLimiter() for cached Ratelimit instances
 * - Redis via Upstash for actual limit evaluation
 *
 * @param {string} identifier - Rate limit key (e.g. 'user:uuid' or 'ip:1.2.3.4')
 * @param {string} tier - User tier from TIERS constant
 * @param {string} operation - Operation type from OPERATIONS constant
 * @returns {Promise<Object>} Rate limit result with success, limit, remaining, reset, window
 */
export async function checkRateLimit(identifier, tier, operation){
    if(!identifier || typeof identifier !== 'string'){
        logger.error('checkRateLimit called with invalid identifier', { tier, operation });
        return { success: false, unavailable: true }
    }

    if(!Object.values(TIERS).includes(tier)){
        logger.error('checkRateLimit called with invalid tier', { tier, operation });
        return { success: false, unavailable: true }
    }

    if(!Object.values(OPERATIONS).includes(operation)){
        logger.error('checkRateLimit called with invalid operation', { tier, operation });
        return { success: false, unavailable: true }
    }

    const redis = getRedisClient()

    try{
        // left to right check, if !redis true, never ping redis
        if (!redis || !(await isRedisHealthy())){
            logger.warn('Rate limiting is unavailable - Redis not healthy', {
                hasClient: !!redis,
                operation
            });
            return { success: false, unavailable: true}
        }
        const hourlyLimiter = getOrCreateLimiter(tier, operation, 'hourly');
        const dailyLimiter = getOrCreateLimiter(tier, operation, 'daily');

        if (!hourlyLimiter && !dailyLimiter){
            return { success : true, limit : null, remaining : null, reset : null, window: null}
        }

        let mostRestrictive = null;

        // Check daily (broader) window FIRST to avoid draining the smaller hourly bucket
        if (dailyLimiter) {
            const daily = await dailyLimiter.limit(identifier);
            if (!daily.success) {
                return { success: false, limit: daily.limit, remaining: 0, reset: daily.reset, window: 'daily' };
        }
            mostRestrictive = { ...daily, window: 'daily' };
        }

        if (hourlyLimiter) {
            const hourly = await hourlyLimiter.limit(identifier);
            if (!hourly.success) {
                return { success: false, limit: hourly.limit, remaining: 0, reset: hourly.reset, window: 'hourly' };
        }
            if (!mostRestrictive || hourly.remaining <= mostRestrictive.remaining) {
                mostRestrictive = { ...hourly, window: 'hourly' };
        }
    }

        return {
            success: true,
            limit: mostRestrictive.limit,
            remaining: mostRestrictive.remaining,
            reset: mostRestrictive.reset,
            window: mostRestrictive.window
        }


    }catch(error){
        logger.error('Rate limit check failed', {
            error: error.message,
            stack: error.stack,
            identifierType: identifier?.split(':')[0] || 'unknown',
            tier,
            operation
        });
        return { success: false, unavailable : true}
    }
}