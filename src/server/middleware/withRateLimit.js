import { getUserFromRequest } from '../lib/supabaseServer.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { METHOD_TO_OPERATIONS, TIERS } from '../../shared/constants/tiers.js';
import { ERROR_MESSAGES } from '../../shared/errors.js';
import { sendError } from '../../shared/response.js';
import { logger } from '../../shared/logger.js';



/**
 * IPv4 and IPv6 format patterns for basic validation
 * Purpose: Reject obviously invalid strings before using as rate limit keys
 */
const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_REGEX = /^[0-9a-fA-F:]{2,45}$/;
const MAX_IP_LENGTH = 45;

/**
 * Validates and normalizes an IP address string
 *
 * Strips IPv4-mapped IPv6 prefix and validates basic format.
 * Rejects strings that don't look like valid IP addresses to prevent
 * spoofed headers from creating arbitrary rate limit keys.
 *
 * @param {string} ip - Raw IP string from request headers or socket
 * @returns {string|null} Normalized IP or null if invalid
 */
function normalizeIp(ip){
    if(!ip || typeof ip !== 'string' || ip.length > MAX_IP_LENGTH){
        return null;
    }

    let normalized = ip.trim();

    if(normalized.startsWith('::ffff:')){
        normalized = normalized.slice(7);
    }

    if(IPV4_REGEX.test(normalized) || IPV6_REGEX.test(normalized)){
        return normalized;
    }

    return null;
}


/**
 * Extracts IP-based rate limit identifier from request
 *
 * Purpose: Provides IP identifier for public/unauthenticated routes
 * Connects to: normalizeIp() for IP validation
 *
 * @param {import('next').NextApiRequest} req - Next.js API request
 * @returns {string|null} 'ip:{address}' or null if no valid IP
 */
function extractIpIdentifier(req){
    const IS_VERCEL = !!process.env.VERCEL;

    const rawIp = IS_VERCEL ? req.headers['x-real-ip'] ||
    req.socket?.remoteAddress : req.socket?.remoteAddress;

    const ip = rawIp ? normalizeIp(rawIp) : null;

    if(!ip){
        logger.warn('Rate limit: no valid IP identifier available', {
            hasRealIp: !!req.headers['x-real-ip'],
            hasSocketAddr: !!req.socket?.remoteAddress
        });
        return null;
    }

    return `ip:${ip}`;
}


/**
 * Set rate limit headers on the res obj
 *
 * @param {import('next').NextApiResponse} res - Next.js res obj
 * @param {object} rateLimitResult - result from checkRateLimit
 */
function setRateLimitHeaders(res, rateLimitResult){
    if(rateLimitResult.limit !== null && rateLimitResult.limit !== undefined){
        res.setHeader('X-RateLimit-Limit', rateLimitResult.limit)
    }
    if(rateLimitResult.remaining !== null && rateLimitResult.remaining !== undefined){
        res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining)
    }
    if(rateLimitResult.reset){
        res.setHeader('X-RateLimit-Reset', rateLimitResult.reset)
    }
    if(rateLimitResult.window){
        res.setHeader('X-RateLimit-Window', rateLimitResult.window)
    }
}

/**
 * Rate limiting middleware wrapper for Next.js API handlers
 *
 * Applies per-user or per-IP rate limiting before handler execution.
 * Supports two modes:
 * - Protected routes (requireAuth=true): Auth failure blocks request with 401
 * - Public routes (requireAuth=false): IP-based rate limiting, no auth required
 *
 * Connects to:
 * - getUserFromRequest() for user authentication (protected routes)
 * - extractIpIdentifier() for IP identification (public routes)
 * - checkRateLimit() from rateLimit.js for limit evaluation
 * - METHOD_TO_OPERATIONS from tiers.js for HTTP method mapping
 * - sendError() from response.js for error responses
 *
 * @param {Function} handler - Next.js API handler (req, res) => Promise
 * @param {Object} [options] - Configuration options
 * @param {boolean} [options.requireAuth=true] - If true, block when auth fails (protected routes).
 *                                               If false, use IP-based rate limiting (public routes).
 * @param {string} [options.operation] - Override operation type. If not set, derived from HTTP method.
 * @returns {Function} Wrapped handler with rate limiting applied
 */
export function withRateLimit(handler, options = {}){
    const {
        requireAuth = true,
        operation: operationOverride = null
    } = options;

    return async(req, res) => {
        const operation = operationOverride || METHOD_TO_OPERATIONS[req.method];

        //unmapped methods skip rate limits
        if(!operation){
            return handler(req,res);
        }

        let identifier;
        let rateLimitResult;

        try {
            if(requireAuth){
                // PROTECTED ROUTE: Auth is mandatory, no IP fallback
                try{
                    const { user, error } = await getUserFromRequest(req);
                    if(!user){
                        logger.warn('Auth required but failed on protected route', {
                            error: error || 'Unknown auth failure',
                            method: req.method
                        });
                        return sendError(
                            res,
                            401,
                            'UNAUTHORIZED',
                            ERROR_MESSAGES.UNAUTHORIZED
                        );
                    }
                    req._rateLimitUser = user;
                    identifier = `user:${user.id}`;
                }catch(error){
                    logger.error('Auth service error on protected route', {
                        error: error.message,
                        method: req.method
                    });
                    return sendError(
                        res,
                        401,
                        'UNAUTHORIZED',
                        ERROR_MESSAGES.UNAUTHORIZED
                    );
                }
            }else{
                // PUBLIC ROUTE: IP-based rate limiting, no auth needed
                identifier = extractIpIdentifier(req);
                if(!identifier){
                    return sendError(
                        res,
                        403,
                        'UNIDENTIFIABLE_CLIENT',
                        'Unable to identify client. Please try again.'
                    );
                }
            }

            const tier = TIERS.FREE;
            rateLimitResult = await checkRateLimit(identifier, tier, operation);
        }catch(error){
            logger.error('Rate limit check threw unexpected error', {
                error: error.message,
                stack: error.stack,
                method: req.method,
                operation
            });

            return sendError(
                res,
                503,
                'SERVICE_UNAVAILABLE',
                ERROR_MESSAGES.SERVICE_UNAVAILABLE
            );
        }


        // block req on redis down
        if(rateLimitResult.unavailable){
            logger.warn('Rate limiting unavailable, req denied', {
                operation,
                method: req.method
            });
            return sendError(
                res,
                503,
                'SERVICE_UNAVAILABLE',
                ERROR_MESSAGES.SERVICE_UNAVAILABLE
            );
        }
        // set limit headers on all res
        setRateLimitHeaders(res, rateLimitResult);

        // rate limit exceeded
        if(!rateLimitResult.success){
            const retryAfterSeconds = rateLimitResult.reset
            ? Math.max(0, Math.ceil((rateLimitResult.reset - Date.now()) / 1000)) : 60;

            res.setHeader('Retry-After', retryAfterSeconds);

            logger.warn('Rate Limit exceeded', {
                operation,
                window: rateLimitResult.window,
                limit: rateLimitResult.limit,
                retryAfterSeconds
            });

            return sendError(
                res,
                429,
                'RATE_LIMIT_EXCEEDED',
                ERROR_MESSAGES.RATE_LIMIT_EXCEEDED
            );
        }

        return handler(req,res);
    }

}
