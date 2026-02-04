import { Redis } from '@upstash/redis';
import logger from '../../shared/logger.js'

/**
 * Upstash Redis client singleton
 *
 * Connects to Upstash Redis lazily on first use
 * Used with rateLimit.js and tierService.js
 */

let redisClient = null
let initializationAttempted = false

/**
 * Gets or creates Redis client instance (singleton pattern)
 *
 * Purpose: Provides lazy initialization of Redis connection
 * Connects to: Upstash Redis via REST API
 *
 * @returns {Redis|null} Redis client or null if not configured/failed
 */
export function getRedisClient() {
    
    if (redisClient) {
        return redisClient
    }
    if (initializationAttempted) {
        return null
    }

    initializationAttempted = true

    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN

    if (!url || !token) {
        logger.warn('Upstash Redis not configured - rate limiting unavailable', {
            hasUrl: !!url,
            hasToken: !!token
        })
        return null
    }

    try {
        redisClient = new Redis({
            url,
            token
        })

        logger.info('Upstash Redis client initialized')
        return redisClient
    } catch (error) {
        logger.error('Failed to initialize Redis client', {
            error: error.message
        })
        return null
    }
}

/**
 * Checks if Redis is available for requests
 *
 * Purpose: Health check for Redis connectivity
 * Connects to: Redis via getRedisClient()
 *
 * @returns {Promise<boolean>} True if Redis is responsive, false otherwise
 */
export async function isRedisUp() {
    const client = getRedisClient()
    if (!client) {
        return false
    }

    try {
        await client.ping()
        return true
    } catch (error) {
        logger.error('Redis health check failed', {
            error: error.message
        })
        return false
    }
}

/**
 * Resets the Redis client (useful for testing or reconnection)
 *
 * Purpose: Allows re-initialization after failure or for testing
 */
export function resetRedisClient() {
    redisClient = null
    initializationAttempted = false
}
