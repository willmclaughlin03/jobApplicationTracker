import { supabase } from './supabase.js'
import { ERROR_MESSAGES } from './errors.js'

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

        const response = await fetch(endpoint, fetchOptions)

        if (!response.ok) {
            return { data: null, error: ERROR_MESSAGES.FETCH_FAILED }
        }

        const data = await response.json()
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

    delete: (endpoint) => apiRequest(endpoint, { method: 'DELETE' })
}