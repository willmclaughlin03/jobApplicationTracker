import { ERROR_MESSAGES } from '../../shared/errors.js';
import { CSRF_COOKIE_NAME } from '../../shared/constants/csrf.js';

const MAX_CLIENT_RETRIES = 2;
const BASE_CLIENT_RETRY_DELAY_MS = 500;
const MAX_CLIENT_RETRY_DELAY_MS = 8000;
const CLIENT_RETRY_JITTER_RATIO = 0.25;
const EMPTY_API_RESPONSE_META = Object.freeze({
    status: null,
    retryAfterSeconds: null,
});

/**
 * Reads a cookie value by name from document.cookie.
 *
 * @param {string} name - Cookie name
 * @returns {string|null} Decoded cookie value or null if not found
 */
function getCookie(name) {
    const match = document.cookie.match(
        new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)')
    );
    return match ? decodeURIComponent(match[1]) : null;
}

/** Dedup promise so concurrent CSRF failures share one refresh request */
let csrfRefreshPromise = null;

/**
 * Fetches a fresh CSRF token from the server (sets the cookie as a side effect).
 * Concurrent calls share the same in-flight request via the dedup promise.
 *
 * @returns {Promise<void>}
 */
async function refreshCsrfToken() {
    if (csrfRefreshPromise) return csrfRefreshPromise;
    csrfRefreshPromise = fetch('/api/auth/csrf', { credentials: 'same-origin' })
        .then(res => { if (!res.ok) throw new Error('CSRF refresh failed'); })
        .finally(() => { csrfRefreshPromise = null; });
    return csrfRefreshPromise;
}

/**
 * Parse an HTTP Retry-After header into a non-negative second count.
 *
 * @param {string|null} headerValue
 * @returns {number|null}
 */
function parseRetryAfterSeconds(headerValue) {
    if (typeof headerValue !== 'string') {
        return null;
    }

    const trimmedValue = headerValue.trim();

    if (!trimmedValue) {
        return null;
    }

    const numericSeconds = Number.parseInt(trimmedValue, 10);

    if (Number.isFinite(numericSeconds)) {
        return Math.max(0, numericSeconds);
    }

    const retryAtMs = Date.parse(trimmedValue);

    if (Number.isNaN(retryAtMs)) {
        return null;
    }

    return Math.max(0, Math.ceil((retryAtMs - Date.now()) / 1000));
}

/**
 * Extract additive response metadata that callers can use without changing
 * the established `{ data, error }` result contract.
 *
 * @param {Response|null|undefined} response
 * @returns {{ status: number|null, retryAfterSeconds: number|null }}
 */
function buildApiResponseMeta(response) {
    if (!response) {
        return EMPTY_API_RESPONSE_META;
    }

    return {
        status: typeof response.status === 'number' ? response.status : null,
        retryAfterSeconds: parseRetryAfterSeconds(response.headers?.get?.('Retry-After') ?? null),
    };
}

/**
 * Sleeps before the next client-side retry attempt.
 *
 * Purpose: keep retry scheduling isolated so executeWithRetry() can focus on
 * request/response handling while tests can drive the timeout with fake timers.
 *
 * @param {number} milliseconds - Non-negative delay before retrying.
 * @returns {Promise<void>}
 */
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Adds bounded jitter to a client-generated retry delay.
 *
 * Purpose: avoid synchronized retry bursts when the server did not provide
 * explicit Retry-After guidance.
 *
 * @param {number} milliseconds - Base delay before jitter.
 * @returns {number} Delay with jitter applied and capped for UI responsiveness.
 */
function addBoundedJitter(milliseconds) {
    const cappedDelay = Math.min(MAX_CLIENT_RETRY_DELAY_MS, Math.max(0, milliseconds));
    const jitterRange = Math.floor(cappedDelay * CLIENT_RETRY_JITTER_RATIO);

    if (jitterRange <= 0) {
        return cappedDelay;
    }

    const offset = Math.floor(Math.random() * ((jitterRange * 2) + 1)) - jitterRange;
    return Math.min(MAX_CLIENT_RETRY_DELAY_MS, Math.max(0, cappedDelay + offset));
}

/**
 * Adds additive-only jitter to server-provided retry guidance.
 *
 * Purpose: keep clients from retrying before Retry-After while still avoiding
 * synchronized retries immediately after the server's cooldown window.
 *
 * @param {number} milliseconds - Server-guided base delay before jitter.
 * @returns {number} Delay with additive jitter applied and capped.
 */
function addAdditiveBoundedJitter(milliseconds) {
    const cappedDelay = Math.min(MAX_CLIENT_RETRY_DELAY_MS, Math.max(0, milliseconds));
    const jitterRange = Math.floor(cappedDelay * CLIENT_RETRY_JITTER_RATIO);

    if (jitterRange <= 0) {
        return cappedDelay;
    }

    const offset = Math.floor(Math.random() * (jitterRange + 1));
    return Math.min(MAX_CLIENT_RETRY_DELAY_MS, cappedDelay + offset);
}

/**
 * Computes the delay before the next SERVICE_UNAVAILABLE retry.
 *
 * Purpose: use server Retry-After guidance as the capped base delay when
 * present without retrying early, otherwise use capped exponential backoff.
 * Both paths add bounded jitter so clients do not retry in lockstep.
 *
 * @param {number} attempt - Zero-based failed attempt number.
 * @param {{ retryAfterSeconds: number|null }} meta - Response metadata.
 * @returns {number} Delay in milliseconds before the next retry.
 */
function getClientRetryDelayMs(attempt, meta) {
    if (Number.isFinite(meta?.retryAfterSeconds)) {
        const cappedRetryAfter = Math.min(
            MAX_CLIENT_RETRY_DELAY_MS,
            Math.max(0, meta.retryAfterSeconds * 1000)
        );

        return addAdditiveBoundedJitter(cappedRetryAfter);
    }

    const exponentialDelay = BASE_CLIENT_RETRY_DELAY_MS * (2 ** attempt);
    return addBoundedJitter(exponentialDelay);
}

/**
 * Makes an authenticated API request using the current Supabase session.
 * For state-changing methods (POST/PUT/DELETE/PATCH), reads the CSRF token
 * from the non-httpOnly cookie and sends it as x-csrf-token.
 * On CSRF_VALIDATION_FAILED (403), refreshes the token and retries once.
 *
 * Purpose: Core function for all authenticated API calls
 * Connects to:
 * - Supabase auth for session/token retrieval
 * - External API endpoints via fetch
 * - /api/auth/csrf for CSRF token refresh on 403
 *
 * @param {string} endpoint - The API endpoint URL
 * @param {Object} options - Fetch options (method, body, headers, etc.)
 * @returns {Promise<{data: any, error: string|null, meta: { status: number|null, retryAfterSeconds: number|null }}>}
 */
export async function apiRequest(endpoint, options = {}) {
    const isStateChanging = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method);

    /**
     * Inner: execute one fetch sequence with a per-execution
     * SERVICE_UNAVAILABLE retry budget.
     *
     * @param {string|null} csrfToken
     */
    async function executeWithRetry(csrfToken) {
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers,
        };

        if (isStateChanging && csrfToken) {
            headers['x-csrf-token'] = csrfToken;
        }

        const fetchOptions = { ...options, credentials: 'same-origin', headers };

        let response;
        let data;
        let meta = EMPTY_API_RESPONSE_META;

        for (let attempt = 0; attempt <= MAX_CLIENT_RETRIES; attempt++) {
            response = await fetch(endpoint, fetchOptions);
            data = await response.json().catch(() => null);
            meta = buildApiResponseMeta(response);

            // Only retry on SERVICE_UNAVAILABLE (Redis cold start), not on other errors
            const isServiceUnavailable = !response.ok && data?.error === 'SERVICE_UNAVAILABLE';
            if (!isServiceUnavailable || attempt === MAX_CLIENT_RETRIES) break;

            await sleep(getClientRetryDelayMs(attempt, meta));
        }

        if (response.status === 401) {
            return { data: null, error: ERROR_MESSAGES.UNAUTHORIZED, meta };
        }

        // Return parsed body as data so callers can inspect response?.error and response?.message
        return { data, error: null, meta };
    }

    try {
        const csrfToken = isStateChanging ? getCookie(CSRF_COOKIE_NAME) : null;
        const result = await executeWithRetry(csrfToken);

        // CSRF retry: token was rejected — refresh and retry once
        if (isStateChanging && result.data?.error === 'CSRF_VALIDATION_FAILED') {
            try {
                await refreshCsrfToken();
                const newToken = getCookie(CSRF_COOKIE_NAME);
                return await executeWithRetry(newToken);
            } catch {
                // Refresh failed — return the original 403, not the refresh error
                return result;
            }
        }

        return result;
    } catch (error) {
        return { data: null, error: ERROR_MESSAGES.FETCH_FAILED, meta: EMPTY_API_RESPONSE_META };
    }
}

/**
 * Convenience methods for common HTTP operations
 * All methods return { data, error } format
 */
export const api = {
    get: (endpoint) => apiRequest(endpoint, { method: 'GET' }),

    post: (endpoint, body) => apiRequest(endpoint, {
        method: 'POST',
        body: JSON.stringify(body)
    }),

    put: (endpoint, body) => apiRequest(endpoint, {
        method: 'PUT',
        body: JSON.stringify(body)
    }),

    delete: (endpoint, body) => apiRequest(endpoint, {
        method: 'DELETE',
        body: body ? JSON.stringify(body) : undefined
    })
};
