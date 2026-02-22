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

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 300;

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
 * Security: On deployed Vercel (production/preview), only x-real-ip is trusted.
 * socket.remoteAddress on Vercel is always the internal load balancer IP, not
 * the client — falling back to it would bucket all traffic under one key,
 * defeating per-client rate limiting. Returns null (→ 403) when x-real-ip is
 * absent so misconfiguration is visible rather than silently bypassed.
 *
 * In local Vercel dev (VERCEL_ENV=development), socket.remoteAddress is
 * the real client, so the fallback is safe.
 *
 * @param {import('next').NextApiRequest} req - Next.js API request
 * @returns {string|null} 'ip:{address}' or null if no valid IP
 */
function extractIpIdentifier(req){
    const IS_VERCEL_DEPLOYED = process.env.VERCEL && process.env.VERCEL_ENV !== 'development';

    const rawIp = IS_VERCEL_DEPLOYED
        ? req.headers['x-real-ip'] ?? null
        : req.socket?.remoteAddress;

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
 * Method guard (allowedMethods):
 * - Fails closed: if allowedMethods is omitted, all requests return 405
 * - Quota is only consumed for methods explicitly listed in allowedMethods
 * - Prevents malicious scanners from draining quota with junk method calls on
 *   mapped methods (e.g. DELETE /api/jobs counting against delete quota before
 *   the route handler rejects it)
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
 * @param {string[]} [options.allowedMethods=null] - HTTP methods this route accepts (e.g. ['GET', 'POST']).
 *                                                   If omitted, all requests return 405 (fail-closed).
 * @returns {Function} Wrapped handler with rate limiting applied
 */
export function withRateLimit(handler, options = {}){
    const {
        requireAuth = true,
        operation: operationOverride = null,
        allowedMethods = null
    } = options;

    return async(req, res) => {
        // OPTIONS: allow CORS preflight before any method, quota, or auth checks
        if(req.method === 'OPTIONS'){
            return res.status(204).end();
        }

        // Fail-closed: 405 if allowedMethods not declared or method not in list.
        // Prevents quota drain from mis-routed or scanner requests on mapped methods.
        if(!allowedMethods || !allowedMethods.includes(req.method)){
            return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
        }

        const operation = operationOverride || METHOD_TO_OPERATIONS[req.method];

        // Safety net: allowed method with no operation mapping and no override
        if(!operation){
            return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
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

            // Initial attempt — convert thrown exceptions into unavailable state
            try {
                rateLimitResult = await checkRateLimit(identifier, tier, operation);
            } catch(initialError) {
                logger.warn('Rate limit initial check failed', { error: initialError.message, operation });
                rateLimitResult = { success: false, unavailable: true };
            }

            // Retry up to 2 times if Redis unavailable (handles cold start / Upstash resume latency)
            for (let attempt = 0; attempt < MAX_RETRIES && rateLimitResult.unavailable; attempt++) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                try {
                    rateLimitResult = await checkRateLimit(identifier, tier, operation);
                } catch(retryError) {
                    logger.warn('Rate limit retry failed', { attempt: attempt + 1, error: retryError.message, operation });
                    rateLimitResult = { success: false, unavailable: true };
                }
            }
        } catch(error) {
            // Safety net for unexpected errors outside checkRateLimit (e.g. auth layer)
            logger.error('Unexpected middleware error', { error: error.message, method: req.method, operation });
            return sendError(
                res,
                503,
                'SERVICE_UNAVAILABLE',
                ERROR_MESSAGES.SERVICE_UNAVAILABLE
            );
        }

        // block req on redis down after all retries exhausted
        if(rateLimitResult.unavailable){
            logger.warn('Rate limiting unavailable after retries, req denied', {
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
