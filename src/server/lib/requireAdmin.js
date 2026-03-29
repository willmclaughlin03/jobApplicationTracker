import { sendError } from '../../shared/response.js';
import { ERROR_MESSAGES } from '../../shared/errors.js';

/**
 * Asserts the authenticated user holds the admin role
 *
 * Purpose: Centralized admin authorization check for all admin API handlers
 * Connects to: withRateLimit middleware, which authenticates the user and
 *              attaches them to req._rateLimitUser before this is called
 *
 * Design: Intentionally does NOT re-authenticate. withRateLimit already
 * validates the session and sets req._rateLimitUser. This function only
 * inspects app_metadata.role, which is server-writable only (Supabase
 * service role key required), preventing client-side privilege escalation.
 *
 * @param {object} user - Authenticated user from req._rateLimitUser
 * @param {object} res - Next.js response object
 * @returns {boolean} true if admin, false if not (response already sent)
 */
export function requireAdmin(user, res) {
    if (!user || user.app_metadata?.role !== 'admin') {
        sendError(res, 403, 'ADMIN_FORBIDDEN', ERROR_MESSAGES.ADMIN_FORBIDDEN);
        return false;
    }
    return true;
}

/**
 * Guards against an admin acting on their own account via the API
 *
 * Purpose: Prevents accidental self-demotion or self-deletion, which could
 *          leave the system with no admin and require Supabase dashboard recovery
 *
 * @param {string} actorId - The authenticated admin's user ID
 * @param {string} targetId - The target user ID from the route param
 * @param {object} res - Next.js response object
 * @returns {boolean} true if safe to proceed, false if self-action (response already sent)
 */
export function preventSelfAction(actorId, targetId, res) {
    if (actorId === targetId) {
        sendError(res, 403, 'ADMIN_SELF_ACTION', ERROR_MESSAGES.ADMIN_SELF_ACTION);
        return false;
    }
    return true;
}
