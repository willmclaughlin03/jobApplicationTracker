import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { OPERATIONS, TIER_LIMITS, TIERS } from '../../shared/constants/tiers';
import { getRedisClient, isRedisHealthy } from './redis';
import { logger } from '../../shared/logger';
import { success } from 'zod';




const cacheKey = new Map()

function getOrCreateLimiter(tier, operation, windowType){
    const key = `${tier}:${operation}:${windowType}`
    const redis = getRedisClient()

    // if redis changed, cached limit holds a null ref, so we clear with this
    const cached = cacheKey.get(key)
    if (cached && cached._redis === redis){
        return cached
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

    limiter._redis = redis

    cacheKey.set(key, limiter)

    return limiter
}


export async function checkRateLimit(identifier, tier, operation){

    const redis = getRedisClient()

    try{
        // left to right check, if !redis true, never ping redis
        if (!redis || !(await isRedisHealthy())){
            logger.warn('Rate limiting is unavaliable - Redis not healthy', {
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

        if (hourlyLimiter) {
            const hourly = await hourlyLimiter.limit(identifier);
            if (!hourly.success) {
                return { success: false, limit: hourly.limit, remaining: 0, reset: hourly.reset, window: 'hourly' };
            }
            mostRestrictive = { ...hourly, window: 'hourly' };
        }

        if (dailyLimiter) {
            const daily = await dailyLimiter.limit(identifier);
            if (!daily.success) {
                return { success: false, limit: daily.limit, remaining: 0, reset: daily.reset, window: 'daily' };
            }
            if (!mostRestrictive || daily.remaining <= mostRestrictive.remaining) {
                mostRestrictive = { ...daily, window: 'daily' };
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
            identifier,
            tier,
            operation
        });
        return { success: false, unavailable : true}
    }
}