/**
 * Structured audit logging for admin actions
 *
 * Purpose: Produce a tamper-evident, searchable trail of every admin mutation
 *          so compromised admin accounts can be investigated and damage assessed
 * Connects to: Pino logger via req.log (attached by withRateLimit middleware)
 *              Ships to Axiom in production via the existing Pino transport
 *
 * Log shape:
 *   { type: 'admin_audit', actor, action, target, result, requestId, ...meta }
 *
 * Actions:
 *   'list_users'    - Admin listed all users
 *   'get_user'      - Admin viewed a single user's profile and activity
 *   'delete_user'   - Admin deleted a user account (and their jobs)
 *   'set_role'      - Admin changed a user's role
 */

/**
 * Logs an admin action to the structured request-scoped logger
 *
 * @param {import('next').NextApiRequest} req - Request object with req.log attached
 * @param {object} params
 * @param {'list_users'|'get_user'|'delete_user'|'set_role'} params.action - The action performed
 * @param {string} [params.targetUserId] - ID of the user being acted upon (omit for list_users)
 * @param {'success'|'error'} params.result - Outcome of the action
 * @param {object} [params.meta] - Additional context (e.g. new role value, error reason)
 */
// Read-only audit actions are demoted to debug: they fire on every admin page
// view and are not compliance-critical. Mutations stay at info so they ship to
// Axiom and remain investigable for privilege/deletion incidents.
const LOW_VALUE_ACTIONS = new Set(['list_users', 'get_user']);

export function logAdminAction(req, { action, targetUserId, result, meta = {} }) {
    const actor = req._rateLimitUser?.id;
    const level = LOW_VALUE_ACTIONS.has(action) && result === 'success' ? 'debug' : 'info';

    req.log[level]({
        type: 'admin_audit',
        actor,
        action,
        target: targetUserId ?? null,
        result,
        ...meta,
    }, `Admin action: ${action} [${result}]`);
}
