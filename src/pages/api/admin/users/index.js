import { supabaseAdmin } from '../../../../server/lib/supabaseServer.js';
import { withRateLimit } from '../../../../server/middleware/withRateLimit.js';
import { requireAdmin } from '../../../../server/lib/requireAdmin.js';
import { logAdminAction } from '../../../../server/lib/adminAuditLog.js';
import { listUsersQuerySchema } from '../../../../shared/validations/adminSchemas.js';
import { sendSuccess, sendError } from '../../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../../shared/errors.js';
import { OPERATIONS } from '../../../../shared/constants/tiers.js';

/**
 * Handles GET /api/admin/users — paginated list of all user accounts
 *
 * Purpose: Allow admins to browse all registered users
 * Connects to: supabaseAdmin.auth.admin.listUsers() (service role, bypasses RLS)
 * Returns: id, email, role, created_at, last_sign_in_at per user — no tokens or secrets
 *
 * @param {import('next').NextApiRequest} req
 * @param {import('next').NextApiResponse} res
 */
async function handleGet(req, res) {
    const queryResult = listUsersQuerySchema.safeParse(req.query);

    if (!queryResult.success) {
        return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
    }

    const { page, pageSize } = queryResult.data;

    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage: pageSize,
    });

    if (error) {
        req.log.error({ err: error }, 'Admin: failed to list users');
        logAdminAction(req, { action: 'list_users', result: 'error', meta: { reason: error.message } });
        return sendError(res, 503, 'ADMIN_FETCH_FAILED', ERROR_MESSAGES.ADMIN_FETCH_FAILED);
    }

    const users = data.users.map(({ id, email, app_metadata, created_at, last_sign_in_at }) => ({
        id,
        email,
        role: app_metadata?.role ?? 'user',
        created_at,
        last_sign_in_at,
    }));

    logAdminAction(req, { action: 'list_users', result: 'success', meta: { count: users.length, page } });

    return sendSuccess(res, 200, { users, page, pageSize }, 'Users retrieved successfully');
}

async function handler(req, res) {
    if (!requireAdmin(req._rateLimitUser, res)) return;

    return handleGet(req, res);
}

export default withRateLimit(handler, {
    requireAuth: true,
    allowedMethods: ['GET'],
    operation: OPERATIONS.ADMIN_READ,
});
