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

    // Read current app_metadata before writing.
    //
    // Why: supabaseAdmin.auth.admin.updateUserById performs a *shallow merge*
    // into app_metadata — it does NOT replace the object. Passing only { role }
    // preserves all existing keys (e.g. Supabase-managed `provider`, `providers`).
    // Reading first lets us explicitly reconstruct the full object, making the
    // intent clear and protecting against future developers adding fields who may
    // not realise the merge behaviour.
    //
    // Tradeoff: this adds one round-trip and a narrow TOCTOU window — if another
    // concurrent admin action updates app_metadata between our fetch and write,
    // we could overwrite it. Acceptable for this app's admin volume; a Postgres
    // function would be needed for true atomicity.
    const { data: currentUserData, error: fetchError } = await supabaseAdmin.auth.admin.getUserById(targetId);

    if (fetchError) {
        req.log.error({ err: fetchError, targetId }, 'Admin: failed to fetch user before role update');
        logAdminAction(req, {
            action: 'set_role',
            targetUserId: targetId,
            result: 'error',
            meta: { role, reason: 'fetch_failed_before_update' },
        });

        if (fetchError.status === 404) {
            return sendError(res, 404, 'ADMIN_USER_NOT_FOUND', ERROR_MESSAGES.ADMIN_USER_NOT_FOUND);
        }
        return sendError(res, 503, 'ADMIN_ROLE_UPDATE_FAILED', ERROR_MESSAGES.ADMIN_ROLE_UPDATE_FAILED);
    }

    // Preserve all existing app_metadata fields (provider, providers, etc.)
    // and override only `role`. This makes the write explicit rather than
    // relying on Supabase's implicit merge.
    const updatedMetadata = {
        ...currentUserData.user.app_metadata,
        role,
    };

    const { error } = await supabaseAdmin.auth.admin.updateUserById(targetId, {
        app_metadata: updatedMetadata,
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
