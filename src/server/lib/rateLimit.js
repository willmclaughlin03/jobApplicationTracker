import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { OPERATIONS, TIER_LIMITS, TIERS } from '../../shared/constants/tiers';
import { getRedisClient, isRedisHealthy } from './redis';
import { logger } from '../../shared/logger';


const redis = getRedisClient()

const cacheKey = new Map()

function getOrCreateLimiter(tier, operation, windowType){
    const key = `${tier}:${operation}:${windowType}`

    if (cacheKey.has(key)){
        return cacheKey.get(key)
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

    cacheKey.set(key, limiter)

    return limiter
}


