/**
 * User subscription tiers and their associated limits
 * 
 * Rate limits use fixed window algorithm via Upstash Redis
 * Storage limits enforced at database layer
 */

export const TIERS = {
    FREE: 'free',
    ADMIN: 'admin',
    // PAID: 'paid'
};

export const TIER_LIMITS = {
    [TIERS.FREE]: {
        insert: {
            hourly: 30,
            daily: 60
        },
        update: {
            hourly: 100,
            daily: 150
        },
        read: {
            hourly: 300,
            daily: null
        },
        delete : {
            hourly: 100,
            daily: 150
        },
        auth : {
            hourly: 15,
            daily: 30
        },
        health: {
            hourly: 60,
            daily: null
        },
        storage: {
            maxJobs: 300,
            // Potential autoDelete
            autoDeleteOldest: false
        },
    },

    [TIERS.ADMIN]: {
        admin_read: {
            hourly: 200,
            daily: 300
        },
        admin_write: {
            hourly: 200,    // generous for active admin work; write ops are now reads-excluded
            daily: null
        },
    },

    // [TIERS.PAID] : {
    //     insert: {
    //         hourly: null,
    //         daily: 1000
    //     },
    //     update : {
    //         hourly: null,
    //         daily: 10000
    //     },
    //     read: {
    //         hourly: null,
    //         daily: 50000
    //     },
    //     delete: {
    //         hourly: null,
    //         daily: null
    //     },
    //     storage: {
    //         maxJobs: 3000,
            
    //         autoDeleteOldest: false,
    //     },
    // },

}

/**
 * Window duration in seconds for rate limiting
 * 
 */

export const WINDOWS = {
    HOURLY: 60 * 60,
    DAILY: 60 * 60 * 24
};

/**
 * Operations subject to rate limiting
 */

export const OPERATIONS = {
    INSERT: 'insert',
    UPDATE: 'update',
    READ: 'read',
    DELETE: 'delete',
    AUTH: 'auth',
    HEALTH: 'health',
    ADMIN_READ: 'admin_read',
    ADMIN_WRITE: 'admin_write',
};


/**
 * Map HTTP methods to operations for detection
 */

export const METHOD_TO_OPERATIONS ={
    GET: OPERATIONS.READ,
    POST: OPERATIONS.INSERT,
    PUT: OPERATIONS.UPDATE,
    PATCH: OPERATIONS.UPDATE,
    DELETE: OPERATIONS.DELETE
};


/**
 * Gets limits for specific tiers and operations performed 
 * @param {string} tier - User Tier {free/paid}
 * @param {string} operation - Operation type 
 * @returns {object} { Hourly: number|null, daily: number|null}
 * 
 */

export function getLimitsForOperations(tier, operation) {
    const DENY_ACCESS = { hourly : 0, daily : 0};

    if(!Object.values(OPERATIONS).includes(operation)){
        return DENY_ACCESS;
    }

    const tierLimits = TIER_LIMITS[tier];

    if (!tierLimits) return DENY_ACCESS;

    return tierLimits[operation] || DENY_ACCESS
}



/**
 * Gets storage limits for tiers
 * @param {string} tier - User Tier
 * @returns {Object} { maxJobs: number, autoDeleteOldest : Boolean}
 */

/**
 * Gets storage limits for a tier. Returns undefined for unknown tiers (fail-closed).
 * @param {string} tier - User Tier
 * @returns {{ maxJobs: number, autoDeleteOldest: boolean } | undefined}
 */
export function getStorageLimitForTier(tier) {
    return TIER_LIMITS[tier]?.storage;
}

/** @deprecated Typo in name — use getStorageLimitForTier instead */
export function getStorargeLimitForTier(tier) {
    return getStorageLimitForTier(tier);
}