import { AUTH_ERROR_CODES, getUserFromRequest } from '../lib/supabaseServer.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { validateCsrfToken } from '../lib/csrf.js';
import { METHOD_TO_OPERATIONS, OPERATIONS } from '../../shared/constants/tiers.js';
import { PRIVATE_NO_STORE } from '../../shared/constants/authV2.js';
import { resolveRateLimitTier } from '../lib/userTier.js';
import {
    resolveTemporarySessionSource,
    resolveTemporarySessionSourceMode,
    serializeTemporarySessionLegacySource,
} from '../lib/temporarySessionSource.js';

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



const AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;
const REQUEST_DURATION_EVENT = 'api_request_duration';
const REQUEST_DURATION_LOG_ALL_VALUES = new Set(['1', 'true', 'yes', 'on']);
const REQUEST_DURATION_PRODUCTION_SAMPLE_RATE = 0.01;
const SLOW_REQUEST_DURATION_MS = 1000;
const MAX_PRE_RATE_LIMIT_GUARD_REASON_LENGTH = 64;
const PRE_RATE_LIMIT_GUARD_REASON_PATTERN = /^[a-z0-9_]+$/;
const PRE_RATE_LIMIT_GUARD_FAILURE_EVENT = 'pre_rate_limit_guard_failure';
const PRE_RATE_LIMIT_GUARD_FAILURE_REASONS = Object.freeze({
    INVALID_CONFIGURATION: 'invalid_configuration',
    GUARD_ERROR: 'guard_error',
    INVALID_DECISION: 'invalid_decision',
    WRITER_INCOMPLETE: 'writer_incomplete',
    WRITER_ERROR: 'writer_error',
});

/**
 * Returns the current monotonic-enough timestamp for request duration logs.
 *
 * Purpose: keep timing reads behind one helper so tests can control elapsed
 * time without touching route behavior. Date.now() is sufficient because this
 * chunk only needs coarse API latency evidence.
 *
 * @returns {number} Timestamp in milliseconds.
 */
function getRequestTimingNowMs() {
    return Date.now();
}

/**
 * Checks whether request-duration logging should bypass production sampling.
 *
 * Purpose: deployed pre-production environments may still run with
 * NODE_ENV=production, so an explicit non-secret flag lets those environments
 * emit every duration event without changing production defaults.
 *
 * @returns {boolean} True when every request-duration event should be logged.
 */
function shouldLogAllRequestDurations() {
    if (process.env.NODE_ENV !== 'production') return true;
    const logAllValue = process.env.REQUEST_DURATION_LOG_ALL;
    return REQUEST_DURATION_LOG_ALL_VALUES.has(String(logAllValue || '').trim().toLowerCase());
}

/**
 * Decides whether this request is in the production sampling cohort.
 *
 * Purpose: production duration logs need head-based sampling to control Axiom
 * ingest volume, while non-production requests log every timing event.
 *
 * @returns {boolean} True when this request should be sampled.
 */
function shouldSampleRequestDuration() {
    if (shouldLogAllRequestDurations()) return true;
    return Math.random() < REQUEST_DURATION_PRODUCTION_SAMPLE_RATE;
}

/**
 * Reads the response status code once the middleware path has settled.
 *
 * Purpose: Next.js responses expose statusCode directly, but tests and partial
 * mocks may not. Returning null keeps timing logs honest instead of inventing
 * a status when the response object cannot provide one.
 *
 * @param {import('next').NextApiResponse} res - Next.js response object.
 * @returns {number|null} Final response status when available.
 */
function getResponseStatusCode(res) {
    return Number.isInteger(res?.statusCode) ? res.statusCode : null;
}

/**
 * Determines whether a request-duration event should be emitted.
 *
 * Purpose: log all timing evidence outside production, but keep production
 * volume bounded while preserving slow requests and 5xx responses.
 *
 * @param {object} details - Timing decision inputs.
 * @param {number|null} details.statusCode - Final response status, if known.
 * @param {number} details.durationMs - Measured request duration.
 * @param {boolean} details.sampled - Head-based sampling decision.
 * @returns {boolean} True when the duration event should be logged.
 */
function shouldLogRequestDuration({ statusCode, durationMs, sampled }) {
    if (shouldLogAllRequestDurations()) return true;
    if (sampled) return true;
    if (Number.isInteger(statusCode) && statusCode >= 500) return true;
    return durationMs > SLOW_REQUEST_DURATION_MS;
}

/**
 * Emits the structured request-duration event for the middleware wrapper.
 *
 * Purpose: provide low-cost route/middleware timing evidence through the
 * request-scoped logger without logging bodies, cookies, auth headers, or raw
 * error objects.
 *
 * @param {import('next').NextApiRequest & { log?: object }} req - Request with scoped logger.
 * @param {import('next').NextApiResponse} res - Next.js response object.
 * @param {object} details - Request timing context.
 * @param {string} details.requestId - Request correlation id.
 * @param {number} details.startedAtMs - Start timestamp in milliseconds.
 * @param {string|null} details.operation - Rate-limit operation for this route.
 * @param {object|undefined} details.rateLimitResult - Rate-limit result envelope, if available.
 * @param {boolean} details.sampled - Head-based sampling decision.
 * @returns {void}
 */
function logRequestDuration(req, res, { requestId, startedAtMs, operation, rateLimitResult, sampled }) {
    const durationMs = Math.max(0, Math.round(getRequestTimingNowMs() - startedAtMs));
    const statusCode = getResponseStatusCode(res);

    if (!shouldLogRequestDuration({ statusCode, durationMs, sampled })) {
        return;
    }

    req.log.info(
        {
            event: REQUEST_DURATION_EVENT,
            requestId,
            method: req.method,
            operation: operation || null,
            statusCode,
            durationMs,
            rateLimitWindow: rateLimitResult?.window ?? null,
            rateLimitSkipped: rateLimitResult?.skipped === true,
        },
        'API request duration'
    );
}

/**
 * Validates the response-neutral decision returned by a pre-rate-limit guard.
 *
 * Purpose: keep route-specific guards behind one strict boundary so malformed
 * results cannot bypass identity, authentication, Redis, or handler work.
 *
 * @param {unknown} decision - Candidate guard result.
 * @returns {boolean} True when the decision is a supported allow or rejection.
 */
function isValidPreRateLimitGuardDecision(decision) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
        return false;
    }

    if (decision.allowed === true) {
        return true;
    }

    const reasonIsBounded = typeof decision.reason === 'string'
        && decision.reason.length >= 1
        && decision.reason.length <= MAX_PRE_RATE_LIMIT_GUARD_REASON_LENGTH
        && PRE_RATE_LIMIT_GUARD_REASON_PATTERN.test(decision.reason);
    if (decision.allowed !== false
        || !reasonIsBounded
        || ![429, 503].includes(decision.statusCode)) {
        return false;
    }

    if (decision.statusCode === 429) {
        return Number.isSafeInteger(decision.retryAfterSeconds)
            && decision.retryAfterSeconds > 0;
    }

    return true;
}

/**
 * Reports whether a guard response has begun or already finished.
 *
 * Purpose: failed route writers must not trigger a second JSON response after
 * headers or body bytes have been committed.
 *
 * @param {import('next').NextApiResponse} res - Next.js response object.
 * @returns {boolean} True when the response cannot be safely replaced.
 */
function hasPreRateLimitGuardResponseStarted(res) {
    return res?.headersSent === true || res?.writableEnded === true || res?.finished === true;
}

/**
 * Closes a failed guard boundary with the legacy unavailable contract.
 *
 * Purpose: guard, decision, configuration, and writer failures all remain
 * fail-closed. A partially started response is ended instead of being written
 * twice; a replaceable response has speculative retry metadata removed.
 *
 * @param {import('next').NextApiResponse} res - Next.js response object.
 * @returns {object|undefined} Next.js response chain when a JSON response is possible.
 */
function failClosedPreRateLimitGuard(res) {
    if (hasPreRateLimitGuardResponseStarted(res)) {
        if (res?.writableEnded !== true && typeof res?.end === 'function') {
            try {
                res.end();
            } catch {
                // The response is already committed; no safe replacement remains.
            }
        }
        return undefined;
    }

    try {
        if (typeof res?.removeHeader === 'function') {
            res.removeHeader('Retry-After');
        }
        return sendError(
            res,
            503,
            'SERVICE_UNAVAILABLE',
            ERROR_MESSAGES.SERVICE_UNAVAILABLE
        );
    } catch {
        if (typeof res?.end === 'function') {
            try {
                res.end();
            } catch {
                // Nothing else can be written safely when the response API fails.
            }
        }
        return undefined;
    }
}

/**
 * Emits one identifier-free diagnostic for a failed guard boundary.
 *
 * Purpose: make fail-closed integration defects observable using only fixed
 * categories while ensuring logger failures cannot change enforcement.
 *
 * @param {import('next').NextApiRequest & { log: object }} req - Request with scoped logger.
 * @param {string} failureReason - Fixed internal guard failure category.
 * @returns {void}
 */
function logPreRateLimitGuardFailure(req, failureReason) {
    try {
        req.log.error({
            event: PRE_RATE_LIMIT_GUARD_FAILURE_EVENT,
            reason: failureReason,
        }, 'Pre-rate-limit guard failed closed');
    } catch {
        // Observability is best-effort and must not change fail-closed behavior.
    }
}

/**
 * Runs an optional route-owned guard and response writer before rate limiting.
 *
 * Purpose: centralize the fail-closed integration seam while preserving the
 * existing middleware pipeline byte-for-byte when neither option is present.
 * The returned handled flag prevents any rejected or malformed guard path from
 * reaching identity, auth, cookie, CSRF, skip, Redis, or handler work.
 *
 * @param {import('next').NextApiRequest} req - Next.js request object.
 * @param {import('next').NextApiResponse} res - Next.js response object.
 * @param {Function|undefined} preRateLimitGuard - Route guard callback.
 * @param {Function|undefined} writePreRateLimitGuardResponse - Route response writer.
 * @returns {Promise<{handled: boolean, response?: object}>} Guard pipeline outcome.
 */
async function runPreRateLimitGuard(
    req,
    res,
    preRateLimitGuard,
    writePreRateLimitGuardResponse
) {
    const guardIsConfigured = preRateLimitGuard !== undefined
        || writePreRateLimitGuardResponse !== undefined;
    if (!guardIsConfigured) {
        return { handled: false };
    }

    if (typeof preRateLimitGuard !== 'function'
        || typeof writePreRateLimitGuardResponse !== 'function') {
        logPreRateLimitGuardFailure(
            req,
            PRE_RATE_LIMIT_GUARD_FAILURE_REASONS.INVALID_CONFIGURATION
        );
        return { handled: true, response: failClosedPreRateLimitGuard(res) };
    }

    let decision;
    try {
        decision = await preRateLimitGuard(req);
        if (!isValidPreRateLimitGuardDecision(decision)) {
            logPreRateLimitGuardFailure(
                req,
                PRE_RATE_LIMIT_GUARD_FAILURE_REASONS.INVALID_DECISION
            );
            return { handled: true, response: failClosedPreRateLimitGuard(res) };
        }
    } catch {
        logPreRateLimitGuardFailure(req, PRE_RATE_LIMIT_GUARD_FAILURE_REASONS.GUARD_ERROR);
        return { handled: true, response: failClosedPreRateLimitGuard(res) };
    }

    if (decision.allowed === true) {
        return { handled: false };
    }

    try {
        const response = await writePreRateLimitGuardResponse(req, res, decision);
        if (!hasPreRateLimitGuardResponseStarted(res)) {
            logPreRateLimitGuardFailure(
                req,
                PRE_RATE_LIMIT_GUARD_FAILURE_REASONS.WRITER_INCOMPLETE
            );
            return { handled: true, response: failClosedPreRateLimitGuard(res) };
        }
        return { handled: true, response };
    } catch {
        logPreRateLimitGuardFailure(req, PRE_RATE_LIMIT_GUARD_FAILURE_REASONS.WRITER_ERROR);
        return { handled: true, response: failClosedPreRateLimitGuard(res) };
    }
}

/**
 * Evaluates an optional rate-limit skip as an exact boolean decision.
 *
 * Purpose: public routes may skip before legacy identity extraction, while
 * protected routes retain auth and CSRF ordering. Callback exceptions and
 * malformed results become one bounded invalid result without exposing errors.
 *
 * @param {Function|undefined} skipRateLimitWhen route-owned skip callback
 * @param {import('next').NextApiRequest} req request supplied to existing callbacks
 * @returns {Promise<{valid: boolean, skipped: boolean, cause?: string, err?: unknown}>} bounded skip decision
 */
async function evaluateRateLimitSkip(skipRateLimitWhen, req) {
    if (skipRateLimitWhen === undefined) return { valid: true, skipped: false };
    if (typeof skipRateLimitWhen !== 'function') {
        return { valid: false, skipped: false, cause: 'callback_not_function' };
    }

    try {
        const result = await skipRateLimitWhen(req);
        return typeof result === 'boolean'
            ? { valid: true, skipped: result }
            : { valid: false, skipped: false, cause: 'result_not_boolean' };
    } catch (err) {
        return { valid: false, skipped: false, cause: 'callback_error', err };
    }
}

/**
 * Applies one bounded skip decision or fails closed with 503.
 *
 * Purpose: public and protected routes must report an invalid skip callback
 * identically. Returns the fail-closed response when the decision is invalid.
 *
 * @param {object} decision bounded result from evaluateRateLimitSkip
 * @param {import('next').NextApiRequest} req request with scoped logger
 * @param {import('next').NextApiResponse} res response
 * @param {string|null} operation resolved operation label
 * @returns {{handled: boolean, response?: unknown}} bounded outcome
 */
function applyRateLimitSkipDecision(decision, req, res, operation) {
    if (decision.valid) return { handled: false };
    req.log.error(
        {
            event: 'rate_limit_skip_invalid',
            method: req.method,
            operation,
            cause: decision.cause,
            ...(decision.err === undefined ? {} : { err: decision.err }),
        },
        'Rate limit skip evaluation failed'
    );
    return {
        handled: true,
        response: sendError(
            res,
            503,
            'SERVICE_UNAVAILABLE',
            ERROR_MESSAGES.SERVICE_UNAVAILABLE
        ),
    };
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
 * Extracts the public-route source identifier used for rate limiting.
 *
 * Purpose: reuse the temporary-session trust boundary and canonical bytes so
 * public and protected-auth-failure paths cannot drift into provider fallbacks.
 *
 * @param {import('next').NextApiRequest} req - Next.js API request
 * @returns {string|null} versioned canonical source or null if unavailable
 */
function extractSourceIdentifier(req){
    const mode = resolveTemporarySessionSourceMode();
    const source = mode ? resolveTemporarySessionSource(req, mode) : null;
    const identifier = serializeTemporarySessionLegacySource(source);

    if(!identifier){
        (req.log || logger).warn(
            {
                sourceModeValid: mode !== null,
                rawHeadersAvailable: Array.isArray(req.rawHeaders),
                socketAddressAvailable: typeof req.socket?.remoteAddress === 'string',
            },
            'Rate limit: no valid source identifier available'
        );
        return null;
    }
    return identifier;
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
 * Performs the rate-limit lookup for the resolved request identity.
 *
 * Purpose: keep admin-route probing fallback close to the limiter call while
 * preserving route-level authorization checks such as requireAdmin().
 *
 * @param {import('next').NextApiRequest} req - Request carrying _rateLimitUser when authenticated
 * @param {string} identifier - User or canonical source rate-limit key
 * @param {string} operation - Normalized route operation
 * @returns {Promise<object>} checkRateLimit() result or fail-closed unavailable sentinel
 */
async function performRateLimitCheck(req, identifier, operation) {
    const isAdminOperation = operation === OPERATIONS.ADMIN_READ || operation === OPERATIONS.ADMIN_WRITE;
    const isAdminUser = req._rateLimitUser?.app_metadata?.role === 'admin';
    const tier = resolveRateLimitTier(req._rateLimitUser, operation);

    // Non-admin probing an admin route: fall back to AUTH quota so repeated probing
    // is throttled (FREE tier has no admin_read/admin_write limits).
    // The 403 from requireAdmin() still blocks access; this adds rate-limit teeth.
    const effectiveOperation = (isAdminOperation && !isAdminUser) ? OPERATIONS.AUTH : operation;

    try {
        return await checkRateLimit(identifier, tier, effectiveOperation);
    } catch(error) {
        return { success: false, unavailable: true };
    }
}

/**
 * Sends the shared 429 response for a failed rate-limit check.
 *
 * Purpose: protected auth-failure throttling should match ordinary route throttle
 * responses for retry headers, user-facing copy, and low-noise logging rules.
 *
 * @param {import('next').NextApiRequest & { log: object }} req - Request with scoped logger.
 * @param {import('next').NextApiResponse} res - Next.js response object.
 * @param {object} rateLimitResult - Failed limiter result from checkRateLimit().
 * @param {string} operation - Operation bucket that was checked.
 * @returns {object} Next.js response chain.
 */
function sendRateLimitExceeded(req, res, rateLimitResult, operation) {
    setRateLimitHeaders(res, rateLimitResult);

    const retryAfterSeconds = rateLimitResult.reset
        ? Math.max(0, Math.ceil((rateLimitResult.reset - Date.now()) / 1000))
        : 60;

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

/**
 * Applies a trusted-source auth bucket before returning protected-route 401s.
 *
 * Purpose: invalid or missing sessions should not bypass Redis entirely and
 * increase Supabase Auth calls without a local throttle. Successful checks fall
 * through to the existing 401 response; exhausted checks return 429.
 *
 * @param {import('next').NextApiRequest & { log: object }} req - Request with auth failure.
 * @param {import('next').NextApiResponse} res - Next.js response object.
 * @returns {Promise<{handled: boolean, response?: object, rateLimitResult?: object}>}
 */
async function limitFailedProtectedAuth(req, res) {
    const authFailureIdentifier = extractSourceIdentifier(req);

    if (!authFailureIdentifier) {
        return {
            handled: true,
            response: sendError(
                res,
                403,
                'UNIDENTIFIABLE_CLIENT',
                'Unable to identify client. Please try again.'
            ),
        };
    }

    const authFailureRateLimitResult = await performRateLimitCheck(
        req,
        authFailureIdentifier,
        OPERATIONS.AUTH
    );

    if (authFailureRateLimitResult.unavailable) {
        return {
            handled: true,
            rateLimitResult: authFailureRateLimitResult,
            response: sendError(
                res,
                503,
                'SERVICE_UNAVAILABLE',
                ERROR_MESSAGES.SERVICE_UNAVAILABLE
            ),
        };
    }

    if (!authFailureRateLimitResult.success) {
        return {
            handled: true,
            rateLimitResult: authFailureRateLimitResult,
            response: sendRateLimitExceeded(req, res, authFailureRateLimitResult, OPERATIONS.AUTH),
        };
    }

    setRateLimitHeaders(res, authFailureRateLimitResult);
    return { handled: false, rateLimitResult: authFailureRateLimitResult };
}
/**
 * Rate limiting middleware wrapper for Next.js API handlers
 *
 * Applies per-user or trusted-source rate limiting before handler execution.
 * Supports two modes:
 * - Protected routes (requireAuth=true): Auth failure blocks request with 401
 * - Public routes (requireAuth=false): trusted-source rate limiting, no auth required
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
 * - extractSourceIdentifier() for canonical trusted-source identification
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
 *                                               If false, use trusted-source rate limiting (public routes).
 * @param {string} [options.operation] - Override operation type. If not set, derived from HTTP method.
 * @param {Record<string, string> | null} [options.operationByMethod=null] - Optional per-method operation map.
 * @param {string[]} [options.allowedMethods=null] - HTTP methods this route accepts (e.g. ['GET', 'POST']).
 *                                                   If omitted, all requests return 405 (fail-closed).
 * @param {boolean} [options.csrfProtect] - Override the default CSRF behavior for protected routes.
 * @param {string|null} [options.cacheControl=null] - Optional route-owned Cache-Control value applied
 *                                                    before any middleware or handler response path.
 * @param {(req: import('next').NextApiRequest) => object | Promise<object>} [options.preRateLimitGuard]
 *        Optional guard that runs after method and operation validation and
 *        before identity, auth, cookies, CSRF, skip logic, or Redis.
 * @param {(req: import('next').NextApiRequest, res: import('next').NextApiResponse, decision: object) => object | Promise<object>} [options.writePreRateLimitGuardResponse]
 *        Required route-specific response writer when a guard is configured.
 * @param {(req: import('next').NextApiRequest) => boolean | Promise<boolean>} [options.skipRateLimitWhen]
 *        Optional route predicate. Public routes evaluate it before legacy
 *        identity; protected routes retain auth, CSRF, identity, then skip.
 * @returns {Function} Wrapped handler with rate limiting applied
 */
export function withRateLimit(handler, options = {}){
    const {
        requireAuth = true,
        operation: operationOverride = null,
        operationByMethod = null,
        allowedMethods = null,
        csrfProtect,
        cacheControl = null,
        preRateLimitGuard,
        writePreRateLimitGuardResponse,
        skipRateLimitWhen,
    } = options;
    const effectiveCacheControl = requireAuth ? PRIVATE_NO_STORE : cacheControl;

    // Default: protected routes (requireAuth: true) get CSRF protection.
    // Pass csrfProtect: false explicitly to opt out (e.g., the csrf.js endpoint itself).
    const shouldCsrfProtect = csrfProtect !== undefined ? csrfProtect : requireAuth;

    return async(req, res) => {
        if (effectiveCacheControl !== null
            && res.headersSent !== true
            && res.writableEnded !== true
            && res.finished !== true) {
            res.setHeader('Cache-Control', effectiveCacheControl);
        }

        // Attach a child logger with requestId for request-scoped correlation
        const requestId = attachRequestLogger(req);
        res.setHeader('x-request-id', requestId);
        const startedAtMs = getRequestTimingNowMs();
        const sampled = shouldSampleRequestDuration();
        const operation = operationByMethod?.[req.method] ?? operationOverride ?? METHOD_TO_OPERATIONS[req.method] ?? null;
        let identifier;
        let rateLimitResult;

        try {
            // Same-origin app - no CORS headers are served, so OPTIONS has no purpose.
            // Reject with 405 rather than silently succeeding with an empty 204.
            if(req.method === 'OPTIONS'){
                return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
            }

            // Fail-closed: 405 if allowedMethods not declared or method not in list.
            // Prevents quota drain from mis-routed or scanner requests on mapped methods.
            if(!allowedMethods || !allowedMethods.includes(req.method)){
                return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
            }

            // Safety net: allowed method with no operation mapping and no override
            if(!operation){
                return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
            }

            const guardOutcome = await runPreRateLimitGuard(
                req,
                res,
                preRateLimitGuard,
                writePreRateLimitGuardResponse
            );
            if (guardOutcome.handled) {
                return guardOutcome.response;
            }

            try {
                if(requireAuth){
                    // PROTECTED ROUTE: Auth is mandatory; failed auth is source-throttled before 401
                    try{
                        const { user, error, errorCode, supabaseClient } = await getUserFromRequest(req, res);
                        if(!user){
                            if (errorCode === AUTH_ERROR_CODES.AUTH_UNAVAILABLE) {
                                req.log.error(
                                    { event: 'auth_backend_unavailable', method: req.method },
                                    'Auth backend unavailable on protected route'
                                );
                                res.setHeader('Retry-After', AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS);
                                return sendError(
                                    res,
                                    503,
                                    'SERVICE_UNAVAILABLE',
                                    ERROR_MESSAGES.SERVICE_UNAVAILABLE
                                );
                            }

                            const authFailureLimit = await limitFailedProtectedAuth(req, res);
                            rateLimitResult = authFailureLimit.rateLimitResult;
                            if (authFailureLimit.handled) {
                                return authFailureLimit.response;
                            }

                            req.log.warn({ authError: error || 'Unknown auth failure', authErrorCode: errorCode || null, method: req.method }, 'Auth required but failed on protected route');
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
                        req.log.error(
                            { event: 'auth_backend_unavailable', method: req.method },
                            'Auth service error on protected route'
                        );
                        res.setHeader('Retry-After', AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS);
                        return sendError(
                            res,
                            503,
                            'SERVICE_UNAVAILABLE',
                            ERROR_MESSAGES.SERVICE_UNAVAILABLE
                        );
                    }
                }else{
                    // PUBLIC ROUTE: route-owned skip runs before legacy identity/Redis.
                    const publicSkip = await evaluateRateLimitSkip(skipRateLimitWhen, req);
                    const publicSkipOutcome = applyRateLimitSkipDecision(
                        publicSkip,
                        req,
                        res,
                        operation
                    );
                    if (publicSkipOutcome.handled) {
                        return publicSkipOutcome.response;
                    }
                    if (publicSkip.skipped) {
                        rateLimitResult = { success: true, skipped: true };
                    } else {
                        identifier = extractSourceIdentifier(req);
                        if(!identifier){
                            return sendError(
                                res,
                                403,
                                'UNIDENTIFIABLE_CLIENT',
                                'Unable to identify client. Please try again.'
                            );
                        }
                    }
                }

                // CSRF validation - runs after auth (userId available), before rate limit
                // so forged tokens don't consume quota
                if (shouldCsrfProtect && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
                    const userId = req._rateLimitUser?.id;
                    if (!userId || !validateCsrfToken(req, userId)) {
                        req.log.warn({ method: req.method, hasUser: !!userId }, 'CSRF validation failed');
                        return sendError(res, 403, 'CSRF_VALIDATION_FAILED', ERROR_MESSAGES.CSRF_VALIDATION_FAILED);
                    }
                }

                if (requireAuth) {
                    const protectedSkip = await evaluateRateLimitSkip(skipRateLimitWhen, req);
                    const protectedSkipOutcome = applyRateLimitSkipDecision(
                        protectedSkip,
                        req,
                        res,
                        operation
                    );
                    if (protectedSkipOutcome.handled) {
                        return protectedSkipOutcome.response;
                    }
                    if (protectedSkip.skipped) {
                        rateLimitResult = { success: true, skipped: true };
                    }
                }

                if (!rateLimitResult?.skipped) {
                    rateLimitResult = await performRateLimitCheck(req, identifier, operation);
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

            // block req on redis down - one-time log already fired in redis.js
            if(rateLimitResult?.skipped){
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

            if(rateLimitResult.unavailable){
                return sendError(
                    res,
                    503,
                    'SERVICE_UNAVAILABLE',
                    ERROR_MESSAGES.SERVICE_UNAVAILABLE
                );
            }
            // rate limit exceeded
            if(!rateLimitResult.success){
                return sendRateLimitExceeded(req, res, rateLimitResult, operation);
            }

            // set limit headers on all successful rate-limited responses
            setRateLimitHeaders(res, rateLimitResult);

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
        } finally {
            logRequestDuration(req, res, {
                requestId,
                startedAtMs,
                operation,
                rateLimitResult,
                sampled,
            });
        }
    }

}
