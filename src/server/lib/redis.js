import { Redis } from '@upstash/redis';
import { logger } from '../../shared/logger.js';

/**
 * Upstash Redis client singleton with health monitoring
 *
 * Provides Redis connection with health state tracking
 * Used by rateLimit.js and tierService.js
 */

let redisClient = null;
let initializationAttempted = false;
let initializationInProgress = false;  // Lock to prevent race condition
let lastHealthCheck = null;
let isHealthy = false;

// Backoff state for reconnection
let lastReconnectAttempt = null;
let reconnectAttempts = 0;

const CONFIG = {
    healthCheckIntervalMs: 60000,   // 60 seconds between health checks
    healthCheckTimeoutMs: 2000,     // 2 second timeout for each check
    unhealthyThreshold: 2,
    maxStateListeners: 100,
    reconnectBaseDelayMs: 1000,
    reconnectMaxDelayMs: 30000,
    reconnectMaxAttempts: 10
};

// State listeners
const stateChangeListeners = [];
let consecutiveFailures = 0;
let healthCheckInterval = null;
let healthCheckPromise = null;  // Shared promise so concurrent callers await the same check


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
 * Registers a listener for state change
 *
 * @param {Function} listener - callback function (isHealthy: boolean)
 * @returns {Function} Unsubscribe function
 */
export function onRedisStateChange(listener) {
    if (typeof listener !== 'function') {
        throw new Error('Listener must be a function');
    }

    if (stateChangeListeners.length >= CONFIG.maxStateListeners) {
        logger.error({ current: stateChangeListeners.length, max: CONFIG.maxStateListeners }, 'Max redis state listeners reached');
        throw new Error(
            `Maximum listener limit (${CONFIG.maxStateListeners}) reached. ` +
            'Ensure listeners are unsubscribed correctly'
        );
    }

    stateChangeListeners.push(listener);

    logger.debug({ totalListeners: stateChangeListeners.length }, 'Redis state listener registered');

    return () => {
        const index = stateChangeListeners.indexOf(listener);
        if (index > -1) {
            stateChangeListeners.splice(index, 1);
            logger.debug({ totalListeners: stateChangeListeners.length }, 'Redis state listener unregistered');
        }
    };
}


/**
 * Notify listeners of state changes
 *
 * @param {boolean} newState - new state of health
 */
function notifyStateChange(newState) {
    for (const listener of stateChangeListeners) {
        try {
            listener(newState);
        } catch (error) {
            logger.error({ err: error }, 'Redis state change listener error');
        }
    }
}

/**
 * Update health state and notify if changed
 *
 * @param {boolean} newState - new health state
 */
function setHealthState(newState) {
    const previousState = isHealthy;
    isHealthy = newState;
    lastHealthCheck = Date.now();

    if (previousState !== newState) {
        logger.info({ previousState, newState, consecutiveFailures }, 'Redis health state changed');
        notifyStateChange(newState);
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
        setHealthState(false);
        initializationInProgress = false;
        return null;
    }

    // Validate URL security
    const urlValidation = validateRedisUrl(url);
    if (!urlValidation.valid) {
        logger.error({ validationError: urlValidation.error }, 'Invalid Redis URL configuration');
        setHealthState(false);
        initializationInProgress = false;
        return null;
    }

    try {
        redisClient = new Redis({
            url,
            token
        });

        logger.info('Upstash Redis client initialized');

        // Initialize monitoring
        startHealthMonitoring();

        initializationInProgress = false;
        return redisClient;
    } catch (error) {
        logger.error({ err: error }, 'Failed to initialize Redis client');
        setHealthState(false);
        initializationInProgress = false;
        return null;
    }
}


/**
 * Perform health check on Redis connection
 *
 * @returns {Promise<boolean>} True if healthy
 */
async function performHealthCheck() {
    // If a check is already in progress, all callers await the same result
    if (healthCheckPromise) {
        return healthCheckPromise;
    }

    healthCheckPromise = (async () => {
        try {
            const client = redisClient;

            if (!client) {
                consecutiveFailures++;
                if (consecutiveFailures >= CONFIG.unhealthyThreshold) {
                    setHealthState(false);
                }
                return false;
            }

            // Timeout to prevent hanging
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(
                    () => reject(new Error('Health check timeout')),
                    CONFIG.healthCheckTimeoutMs
                );
            });

            await Promise.race([client.ping(), timeoutPromise]);

            consecutiveFailures = 0;
            setHealthState(true);
            return true;
        } catch (error) {
            consecutiveFailures++;

            logger.warn({ err: error, consecutiveFailures, threshold: CONFIG.unhealthyThreshold }, 'Redis health check failed');

            if (consecutiveFailures >= CONFIG.unhealthyThreshold) {
                setHealthState(false);
            }
            return false;
        }
    })();

    try {
        return await healthCheckPromise;
    } finally {
        healthCheckPromise = null;
    }
}


/**
 * Start health monitoring interval
 */
function startHealthMonitoring() {
    if (healthCheckInterval) {
        return;
    }

    healthCheckInterval = setInterval(() => {
        performHealthCheck();
    }, CONFIG.healthCheckIntervalMs);

    // Prevent interval from blocking process exit
    if (healthCheckInterval.unref) {
        healthCheckInterval.unref();
    }

    logger.debug({ intervalMs: CONFIG.healthCheckIntervalMs }, 'Redis health monitoring started');
}

/**
 * Stop health monitoring interval
 */
function stopHealthMonitoring() {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
    }
}



/**
 * Checks if Redis is healthy using cached state
 *
 * Uses cached state from previous checks for performance
 *
 * @returns {Promise<boolean>} True if Redis is responsive
 */
export async function isRedisHealthy() {
    // Use cached state if recent check exists
    if (lastHealthCheck && (Date.now() - lastHealthCheck) < CONFIG.healthCheckIntervalMs) {
        return isHealthy;
    }
    return performHealthCheck();
}

/**
 * Checks if Redis is available with actual ping
 *
 * Use isRedisHealthy() for cached checks
 *
 * @returns {Promise<boolean>} True if Redis is responsive, false otherwise
 */
export async function isRedisUp() {
    return performHealthCheck();
}

/**
 * Get current Redis status info
 *
 * @returns {Object} Status information
 */
export function getRedisStatus() {
    return {
        initialized: initializationAttempted,
        connected: redisClient !== null,
        healthy: isHealthy,
        lastHealthCheck: lastHealthCheck ? new Date(lastHealthCheck).toISOString() : null,
        consecutiveFailures,
        reconnectAttempts
    };
}

/**
 * Resets client connection state only (preserves backoff counters)
 *
 * Used internally by reconnect() so successive attempts still respect
 * exponential backoff. resetRedisClient() calls this plus clears backoff.
 */
function resetClientConnection() {
    stopHealthMonitoring();
    redisClient = null;
    initializationAttempted = false;
    initializationInProgress = false;
    lastHealthCheck = null;
    isHealthy = false;
    consecutiveFailures = 0;
    healthCheckPromise = null;
}

/**
 * Resets the Redis client (useful for testing or reconnection)
 *
 * Purpose: Allows re-initialization after failure or for testing
 */
export function resetRedisClient() {
    resetClientConnection();

    // Reset backoff state
    lastReconnectAttempt = null;
    reconnectAttempts = 0;
}

/**
 * Calculate exponential backoff delay with jitter
 * 
 * will be useful someday lol
 *
 * @param {number} attempt - current attempt number
 * @returns {number} delay in milliseconds
 */
function calculateBackoffDelay(attempt) {
    const delay = Math.min(
        CONFIG.reconnectBaseDelayMs * Math.pow(2, attempt),
        CONFIG.reconnectMaxDelayMs
    );

    const jitter = Math.random() * delay * 0.25;
    return Math.floor(delay + jitter);
}





/**
 * Force a reconnection attempt
 *
 * @param {boolean} [force=false] - Force reconnection even if max attempts exceeded
 * @returns {Promise<boolean>} True if reconnect successful
 */
export async function reconnect(force = false) {
    // Validate input
    if (typeof force !== 'boolean') {
        force = Boolean(force);
    }

    // Check if max attempts exceeded
    if (reconnectAttempts >= CONFIG.reconnectMaxAttempts && !force) {
        logger.error({ attempts: reconnectAttempts, maxAttempts: CONFIG.reconnectMaxAttempts }, 'Max reconnection attempts exceeded');
        return false;
    }

    // Apply backoff delay if not forcing
    if (!force && lastReconnectAttempt) {
        const delay = calculateBackoffDelay(reconnectAttempts);
        const timeSinceLastAttempt = Date.now() - lastReconnectAttempt;

        if (timeSinceLastAttempt < delay) {
            const waitTime = delay - timeSinceLastAttempt;
            logger.debug({ waitTimeMs: waitTime, attempt: reconnectAttempts + 1 }, 'Reconnection attempt delayed due to backoff');

            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    logger.info({ attempt: reconnectAttempts + 1, maxAttempts: CONFIG.reconnectMaxAttempts }, 'Attempting reconnection');

    lastReconnectAttempt = Date.now();
    reconnectAttempts++;

    resetClientConnection();

    const client = getRedisClient();
    if (!client) {
        return false;
    }

    const healthy = await performHealthCheck();

    if (healthy) {
        reconnectAttempts = 0;
        logger.info('Redis reconnection successful');
    }

    return healthy;
}
