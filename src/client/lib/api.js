import { ERROR_MESSAGES } from '../../shared/errors.js';
import { CSRF_COOKIE_NAME } from '../../shared/constants/csrf.js';

const MAX_CLIENT_RETRIES = 2;
const CLIENT_RETRY_DELAY_MS = 500;

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
 * @returns {Promise<{data: any, error: string|null}>}
 */
export async function apiRequest(endpoint, options = {}) {
    const isStateChanging = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method);

    /**
     * Inner: execute one fetch with the SERVICE_UNAVAILABLE retry loop.
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

        for (let attempt = 0; attempt <= MAX_CLIENT_RETRIES; attempt++) {
            if (attempt > 0) {
                await new Promise(resolve => setTimeout(resolve, CLIENT_RETRY_DELAY_MS));
            }
            response = await fetch(endpoint, fetchOptions);
            data = await response.json().catch(() => null);

            // Only retry on SERVICE_UNAVAILABLE (Redis cold start), not on other errors
            const isServiceUnavailable = !response.ok && data?.error === 'SERVICE_UNAVAILABLE';
            if (!isServiceUnavailable || attempt === MAX_CLIENT_RETRIES) break;
        }

        if (response.status === 401) {
            return { data: null, error: ERROR_MESSAGES.UNAUTHORIZED };
        }

        // Return parsed body as data so callers can inspect response?.error and response?.message
        return { data, error: null };
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
        return { data: null, error: ERROR_MESSAGES.FETCH_FAILED };
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
