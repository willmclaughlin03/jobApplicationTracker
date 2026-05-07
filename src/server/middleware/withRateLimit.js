import { getUserFromRequest } from '../lib/supabaseServer.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { validateCsrfToken } from '../lib/csrf.js';
import { METHOD_TO_OPERATIONS, OPERATIONS } from '../../shared/constants/tiers.js';
import { resolveRateLimitTier } from '../lib/userTier.js';

/**
 * Operations where 429 responses are logged at debug instead of warn.
 * Health checks are polled frequently by uptime monitors — warn-level
 * 429 logs would create noise and inflate Axiom ingest costs without
 * actionable signal.
 */
const QUIET_429_OPERATIONS = new Set([OPERATIONS.HEALTH]);
import { ERROR_MESSAGES } from '../../shared/errors.js';
import { sendError } from '../../shared/response.js';
import { logger, attachRequestLogger } from '../../shared/logger.js';



/**
 * IPv4 and IPv6 format patterns for basic validation
 * Purpose: Reject obviously invalid strings before using as rate limit keys
 */
const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_REGEX = /^[0-9a-fA-F:]{2,45}$/;
const MAX_IP_LENGTH = 45;

/**
 * Normalizes a header expected to have a single string value.
 *
 * Returns null for arrays so malformed/repeated trusted headers fail closed
 * instead of throwing or silently choosing an arbitrary entry.
 *
 * @param {string | string[] | undefined} value
 * @returns {string|null}
 */
function getSingleHeaderValue(value) {
    return typeof value === 'string' ? value : null;
}

/**
 * Normalizes X-Forwarded-For into a single comma-separated string.
 *
 * Multiple header lines are semantically equivalent to one comma-joined value,
 * and extractIpIdentifier() still applies trusted-position rules afterward.
 *
 * @param {string | string[] | undefined} value
 * @returns {string|null}
 */
function getForwardedForHeaderValue(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length > 0) {
        return value.join(',');
    }
    return null;
}

/**
 * Format the user-facing Retry-After message for a throttled request.
 *
 * Purpose: keep 429 responses human-readable without exposing implementation
 * details from the underlying Upstash limiter payload.
 *
 * @param {number} seconds - Seconds until the rate limit window resets
 * @returns {string} User-facing message indicating when to retry
 */
function formatRateLimitMessage(seconds) {
    if (seconds <= 0) return 'Rate limit exceeded. Please try again.';
    if (seconds < 60) return `Rate limit exceeded. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
    const minutes = Math.ceil(seconds / 60);
    return `Rate limit exceeded. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

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
 * Extracts the public-route IP identifier used for rate limiting.
 *
 * Purpose: provide a fail-closed identifier for unauthenticated routes without
 * trusting spoofable client-controlled headers more than necessary.
 *
 * Deployed on AWS Amplify behind CloudFront:
 * 1. CloudFront-Viewer-Address — set by CloudFront, cannot be spoofed by clients.
 *    Contains "ip:port", so the port suffix is stripped before use.
 * 2. x-forwarded-for — CloudFront appends the viewer IP as the rightmost entry.
 *    Earlier entries may be spoofed by the client, so only the last is trusted.
 * 3. req.socket.remoteAddress — only meaningful in local dev where no proxy exists.
 *
 * Returns null (`->` 403) when no valid IP can be extracted, so proxy
 * misconfiguration is visible rather than silently bypassing throttling.
 *
 * @param {import('next').NextApiRequest} req - Next.js API request
 * @returns {string|null} 'ip:{address}' or null if no valid IP
 */
function extractIpIdentifier(req){
    const IS_DEPLOYED = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

    let rawIp = null;

    if(IS_DEPLOYED){
        // Prefer CloudFront-Viewer-Address (trusted, set by CloudFront)
        const viewerAddr = getSingleHeaderValue(req.headers['cloudfront-viewer-address']);
        if(viewerAddr){
            // Format is "ip:port". For IPv4: "1.2.3.4:54321"
            // For IPv6: "2001:db8::1:54321" — port is always the last colon-segment
            // when the address contains multiple colons (IPv6), split on last colon
            // only if the part after it is purely numeric (the port).
            const lastColon = viewerAddr.lastIndexOf(':');
            const afterColon = viewerAddr.slice(lastColon + 1);
            if(lastColon > 0 && /^\d+$/.test(afterColon)){
                rawIp = viewerAddr.slice(0, lastColon);
            }else{
                rawIp = viewerAddr;
            }
        }

        // Fallback: rightmost x-forwarded-for entry (appended by CloudFront)
        if(!rawIp){
            const xff = getForwardedForHeaderValue(req.headers['x-forwarded-for']);
            if(xff){
                const parts = xff.split(',');
                rawIp = parts[parts.length - 1].trim();
            }
        }
    }else{
        // Local dev — no proxy, socket address is the real client
        rawIp = req.socket?.remoteAddress;
    }

    const ip = rawIp ? normalizeIp(rawIp) : null;

    if(!ip){
        (req.log || logger).warn({ hasViewerAddr: !!req.headers['cloudfront-viewer-address'], hasXff: !!req.headers['x-forwarded-for'], hasSocketAddr: !!req.socket?.remoteAddress }, 'Rate limit: no valid IP identifier available');
        return null;
    }

    return `ip:${ip}`;
}


/**
 * Apply the normalized rate-limit headers returned by checkRateLimit().
 *
 * Purpose: keep header emission in one helper so protected and public routes
 * expose the same rate-limit metadata regardless of which path identified the
 * caller.
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
 * Side effects:
 * - attaches a request-scoped logger via attachRequestLogger()
 * - stores req._rateLimitUser and req._supabaseClient on protected-route passes
 *
 * @param {Function} handler - Next.js API handler (req, res) => Promise
 * @param {Object} [options] - Configuration options
 * @param {boolean} [options.requireAuth=true] - If true, block when auth fails (protected routes).
 *                                               If false, use IP-based rate limiting (public routes).
 * @param {string} [options.operation] - Override operation type. If not set, derived from HTTP method.
 * @param {Record<string, string> | null} [options.operationByMethod=null] - Optional per-method operation map.
 * @param {string[]} [options.allowedMethods=null] - HTTP methods this route accepts (e.g. ['GET', 'POST']).
 *                                                   If omitted, all requests return 405 (fail-closed).
 * @param {boolean} [options.csrfProtect] - Override the default CSRF behavior for protected routes.
 * @returns {Function} Wrapped handler with rate limiting applied
 */
export function withRateLimit(handler, options = {}){
    const {
        requireAuth = true,
        operation: operationOverride = null,
        operationByMethod = null,
        allowedMethods = null,
        csrfProtect,
    } = options;

    // Default: protected routes (requireAuth: true) get CSRF protection.
    // Pass csrfProtect: false explicitly to opt out (e.g., the csrf.js endpoint itself).
    const shouldCsrfProtect = csrfProtect !== undefined ? csrfProtect : requireAuth;

    return async(req, res) => {
        // Attach a child logger with requestId for request-scoped correlation
        const requestId = attachRequestLogger(req);
        res.setHeader('x-request-id', requestId);

        // Same-origin app — no CORS headers are served, so OPTIONS has no purpose.
        // Reject with 405 rather than silently succeeding with an empty 204.
        if(req.method === 'OPTIONS'){
            return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
        }

        // Fail-closed: 405 if allowedMethods not declared or method not in list.
        // Prevents quota drain from mis-routed or scanner requests on mapped methods.
        if(!allowedMethods || !allowedMethods.includes(req.method)){
            return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
        }

        const operation = operationByMethod?.[req.method] ?? operationOverride ?? METHOD_TO_OPERATIONS[req.method];

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
                    const { user, error, supabaseClient } = await getUserFromRequest(req, res);
                    if(!user){
                        req.log.warn({ authError: error || 'Unknown auth failure', method: req.method }, 'Auth required but failed on protected route');
                        return sendError(
                            res,
                            401,
                            'UNAUTHORIZED',
                            ERROR_MESSAGES.UNAUTHORIZED
                        );
                    }
                    req._rateLimitUser = user;
                    req._supabaseClient = supabaseClient;
                    identifier = `user:${user.id}`;
                }catch(error){
                    req.log.error({ err: error, method: req.method }, 'Auth service error on protected route');
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

            // CSRF validation — runs after auth (userId available), before rate limit
            // so forged tokens don't consume quota
            if (shouldCsrfProtect && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
                const userId = req._rateLimitUser?.id;
                if (!userId || !validateCsrfToken(req, userId)) {
                    req.log.warn({ method: req.method, hasUser: !!userId }, 'CSRF validation failed');
                    return sendError(res, 403, 'CSRF_VALIDATION_FAILED', ERROR_MESSAGES.CSRF_VALIDATION_FAILED);
                }
            }

            const isAdminOperation = operation === OPERATIONS.ADMIN_READ || operation === OPERATIONS.ADMIN_WRITE;
            const isAdminUser = req._rateLimitUser?.app_metadata?.role === 'admin';
            const tier = resolveRateLimitTier(req._rateLimitUser, operation);

            // Non-admin probing an admin route: fall back to AUTH quota so repeated probing
            // is throttled (FREE tier has no admin_read/admin_write limits).
            // The 403 from requireAdmin() still blocks access — this adds rate-limit teeth.
            const effectiveOperation = (isAdminOperation && !isAdminUser) ? OPERATIONS.AUTH : operation;

            try {
                rateLimitResult = await checkRateLimit(identifier, tier, effectiveOperation);
            } catch(error) {
                rateLimitResult = { success: false, unavailable: true };
            }
        } catch(error) {
            // Safety net for unexpected errors outside checkRateLimit (e.g. auth layer)
            req.log.error({ err: error, method: req.method, operation }, 'Unexpected middleware error');
            return sendError(
                res,
                503,
                'SERVICE_UNAVAILABLE',
                ERROR_MESSAGES.SERVICE_UNAVAILABLE
            );
        }

        // block req on redis down — one-time log already fired in redis.js
        if(rateLimitResult.unavailable){
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

            const rateLimitLogData = { operation, window: rateLimitResult.window, limit: rateLimitResult.limit, retryAfterSeconds };
            if (QUIET_429_OPERATIONS.has(operation)) {
                req.log.debug(rateLimitLogData, 'Rate limit exceeded (quiet operation)');
            } else {
                req.log.warn(rateLimitLogData, 'Rate limit exceeded');
            }

            return sendError(
                res,
                429,
                'RATE_LIMIT_EXCEEDED',
                formatRateLimitMessage(retryAfterSeconds)
            );
        }

        try {
            return await handler(req, res);
        } catch(handlerError) {
            req.log.error({ err: handlerError, method: req.method, operation }, 'Unhandled handler error');
            if (res.headersSent) {
                res.end();
                return;
            }
            return sendError(res, 500, 'INTERNAL_SERVER_ERROR', ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
    }

}
