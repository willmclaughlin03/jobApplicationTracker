import { Redis } from '@upstash/redis';
import { logger } from '../../shared/logger.js';

/**
 * Upstash Redis client singleton
 *
 * Provides lazy-initialized Redis REST client.
 * No persistent connection — each call is an independent HTTPS request,
 * so transient Upstash outages recover automatically on the next call.
 *
 * Used by rateLimit.js and tierService.js
 */

let redisClient = null;
let initializationAttempted = false;
let initializationInProgress = false;

// One-time logging flag: logs once per outage window.
// Cleared by setLastCallStatus(true) so the next distinct outage gets its own log.
let redisDownLogged = false;

// Last rate-limit call outcome — fed by rateLimit.js via setLastCallStatus().
// null means "no calls yet" (cold start), not "unknown health."
let lastCallSucceeded = null;
let lastCallTime = null;


/**
 * Validates the Redis REST URL
 *
 * Ensures the URL is properly formatted with HTTPS
 *
 * @param {string} url - URL to validate
 * @returns {{ valid: boolean, error?: string }} Validation result
 */
function validateRedisUrl(url) {
    if (!url || typeof url !== 'string') {
        return { valid: false, error: 'URL required' };
    }

    try {
        const parsedUrl = new URL(url);

        // Require HTTPS
        if (parsedUrl.protocol !== 'https:') {
            return {
                valid: false,
                error: 'Redis URL must be HTTPS'
            };
        }

        // Warn if not Upstash domain
        const allowedDomains = ['upstash.io', 'upstash.com'];
        const hostname = parsedUrl.hostname;
        const isAllowedDomain = allowedDomains.some(
            domain => hostname === domain || hostname.endsWith('.' + domain)
        );

        if (!isAllowedDomain) {
            logger.warn({ hostname, allowedDomains }, 'Redis URL domain not in allowed list');
        }

        return { valid: true };
    } catch (error) {
        return { valid: false, error: 'Invalid URL format' };
    }
}


/**
 * Gets or creates Redis client instance (singleton pattern)
 *
 * Purpose: Provides lazy initialization of Redis connection
 * Connects to: Upstash Redis via REST API
 *
 * @returns {Redis|null} Redis client or null if not configured/failed
 */
export function getRedisClient() {
    // Return existing client if available
    if (redisClient) {
        return redisClient;
    }

    // Return null if already attempted and failed
    if (initializationAttempted) {
        return null;
    }

    // Prevent race condition during concurrent initialization
    if (initializationInProgress) {
        return null;
    }

    initializationInProgress = true;
    initializationAttempted = true;

    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
        logger.warn({ hasUrl: !!url, hasToken: !!token }, 'Upstash Redis not configured - rate limiting unavailable');
        initializationInProgress = false;
        return null;
    }

    // Validate URL security
    const urlValidation = validateRedisUrl(url);
    if (!urlValidation.valid) {
        logger.error({ validationError: urlValidation.error }, 'Invalid Redis URL configuration');
        initializationInProgress = false;
        return null;
    }

    try {
        redisClient = new Redis({
            url,
            token
        });

        logger.debug('Upstash Redis client initialized');

        initializationInProgress = false;
        return redisClient;
    } catch (error) {
        logger.error({ err: error }, 'Failed to initialize Redis client');
        initializationInProgress = false;
        return null;
    }
}


/**
 * Logs a Redis-down error exactly once per outage window.
 *
 * Subsequent calls are silenced until setLastCallStatus(true) clears the flag,
 * so each distinct outage produces one log entry — not one per request.
 *
 * @param {Object} context - Additional structured context (e.g. { reason: 'no_client' })
 */
export function logRedisDownOnce(context = {}) {
    if (redisDownLogged) {
        return;
    }
    redisDownLogged = true;
    logger.error(context, 'Redis is unavailable — requests will be denied (fail-closed)');
}


/**
 * Records the outcome of the most recent rate-limit call.
 *
 * Called by rateLimit.js after each checkRateLimit() attempt.
 * When success is true and a previous outage was logged, implicitly
 * clears the one-time-log flag so the next outage gets its own entry.
 *
 * @param {boolean} success - Whether the rate-limit call succeeded
 */
export function setLastCallStatus(success) {
    lastCallSucceeded = success;
    lastCallTime = new Date().toISOString();

    if (success && redisDownLogged) {
        redisDownLogged = false;
        logger.info('Redis connectivity restored');
    }
}


/**
 * Get current Redis status info
 *
 * lastCallSucceeded/lastCallTime are derived from actual rate-limit traffic,
 * not background pings. null means "no calls yet" (cold start), not "unknown."
 *
 * @returns {Object} Status information
 */
export function getRedisStatus() {
    return {
        initialized: initializationAttempted,
        connected: redisClient !== null,
        lastCallSucceeded,
        lastCallTime,
    };
}


/**
 * Resets the Redis client and all state (useful for testing)
 *
 * Purpose: Allows re-initialization after failure or for testing
 */
export function resetRedisClient() {
    redisClient = null;
    initializationAttempted = false;
    initializationInProgress = false;
    redisDownLogged = false;
    lastCallSucceeded = null;
    lastCallTime = null;
}
