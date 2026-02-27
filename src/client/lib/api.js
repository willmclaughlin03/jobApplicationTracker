import { supabase } from './supabase.js'
import { ERROR_MESSAGES } from '../../shared/errors.js'

const MAX_CLIENT_RETRIES = 2;
const CLIENT_RETRY_DELAY_MS = 500;

/**
 * Makes an authenticated API request using the current Supabase session
 *
 * Purpose: Core function for all authenticated API calls
 * Connects to:
 * - Supabase auth for session/token retrieval
 * - External API endpoints via fetch
 *
 * @param {string} endpoint - The API endpoint URL
 * @param {Object} options - Fetch options (method, body, headers, etc.)
 * @returns {Promise<{data: any, error: string|null}>}
 */
export async function apiRequest(endpoint, options = {}) {
    try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession()

        if (sessionError || !session) {
            await supabase.auth.signOut(); // clears stale local state, triggers onAuthStateChange → SIGNED_OUT
            return { data: null, error: ERROR_MESSAGES.UNAUTHORIZED }
        }

        const fetchOptions = {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`,
                ...options.headers
            }
        }

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

        // Return parsed body as data so callers can inspect response?.error and response?.message
        return { data, error: null }

    } catch (error) {
        return { data: null, error: ERROR_MESSAGES.FETCH_FAILED }
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
}