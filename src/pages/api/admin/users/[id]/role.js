import { supabaseAdmin } from '../../../../../server/lib/supabaseServer.js';
import { withRateLimit } from '../../../../../server/middleware/withRateLimit.js';
import { requireAdmin, preventSelfAction } from '../../../../../server/lib/requireAdmin.js';
import { logAdminAction } from '../../../../../server/lib/adminAuditLog.js';
import { userIdParamSchema, setRoleSchema } from '../../../../../shared/validations/adminSchemas.js';
import { sendSuccess, sendError } from '../../../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../../../shared/errors.js';
import { OPERATIONS } from '../../../../../shared/constants/tiers.js';

/**
 * Handles PUT /api/admin/users/[id]/role — assign or revoke admin role
 *
 * Purpose: Allow admins to promote a user to admin or demote them back to user
 * Connects to: supabaseAdmin.auth.admin.updateUserById() (service role)
 *
 * Security:
 *   - Role is written to app_metadata (server-writable only — not user_metadata)
 *   - Self-action guard prevents an admin demoting their own account via this endpoint
 *   - Only the 'admin' and 'user' roles are accepted (validated by setRoleSchema)
 *
 * @param {import('next').NextApiRequest} req
 * @param {import('next').NextApiResponse} res
 */
async function handlePut(req, res) {
    const paramResult = userIdParamSchema.safeParse(req.query);

    if (!paramResult.success) {
        return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
    }

    const bodyResult = setRoleSchema.safeParse(req.body);

    if (!bodyResult.success) {
        return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
    }

    const targetId = paramResult.data.id;
    const { role } = bodyResult.data;
    const actorId = req._rateLimitUser.id;

    if (!preventSelfAction(actorId, targetId, res)) return;

    const { error } = await supabaseAdmin.auth.admin.updateUserById(targetId, {
        app_metadata: { role },
    });

    if (error) {
        req.log.error({ err: error, targetId, role }, 'Admin: failed to update user role');
        logAdminAction(req, {
            action: 'set_role',
            targetUserId: targetId,
            result: 'error',
            meta: { role, reason: error.message },
        });

        if (error.status === 404) {
            return sendError(res, 404, 'ADMIN_USER_NOT_FOUND', ERROR_MESSAGES.ADMIN_USER_NOT_FOUND);
        }
        return sendError(res, 503, 'ADMIN_ROLE_UPDATE_FAILED', ERROR_MESSAGES.ADMIN_ROLE_UPDATE_FAILED);
    }

    logAdminAction(req, { action: 'set_role', targetUserId: targetId, result: 'success', meta: { role } });

    return sendSuccess(res, 200, { id: targetId, role }, 'User role updated successfully');
}

async function handler(req, res) {
    if (!requireAdmin(req._rateLimitUser, res)) return;

    return handlePut(req, res);
}

export default withRateLimit(handler, {
    requireAuth: true,
    allowedMethods: ['PUT'],
    operation: OPERATIONS.ADMIN_WRITE,
});
