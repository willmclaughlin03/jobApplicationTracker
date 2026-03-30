import { supabaseAdmin } from '../../../../server/lib/supabaseServer.js';
import { withRateLimit } from '../../../../server/middleware/withRateLimit.js';
import { requireAdmin, preventSelfAction } from '../../../../server/lib/requireAdmin.js';
import { logAdminAction } from '../../../../server/lib/adminAuditLog.js';
import { userIdParamSchema } from '../../../../shared/validations/adminSchemas.js';
import { sendSuccess, sendError } from '../../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../../shared/errors.js';
import { OPERATIONS } from '../../../../shared/constants/tiers.js';

/**
 * Handles GET /api/admin/users/[id] — single user profile and account activity
 *
 * Purpose: Allow admins to inspect a specific user's account details and job activity
 * Connects to:
 *   - supabaseAdmin.auth.admin.getUserById() for account details
 *   - supabaseAdmin jobs query (service role) for activity summary
 * Returns: account info + job counts by status + last_sign_in_at
 *
 * @param {import('next').NextApiRequest} req
 * @param {import('next').NextApiResponse} res
 * @param {string} targetId - Validated user UUID
 */
async function handleGet(req, res, targetId) {
    const [authResult, jobsResult] = await Promise.all([
        supabaseAdmin.auth.admin.getUserById(targetId),
        supabaseAdmin
            .from('jobs')
            .select('status')
            .eq('user_id', targetId),
    ]);

    if (authResult.error) {
        req.log.error({ err: authResult.error, targetId }, 'Admin: failed to fetch user');
        logAdminAction(req, { action: 'get_user', targetUserId: targetId, result: 'error', meta: { reason: authResult.error.message } });

        if (authResult.error.status === 404) {
            return sendError(res, 404, 'ADMIN_USER_NOT_FOUND', ERROR_MESSAGES.ADMIN_USER_NOT_FOUND);
        }
        return sendError(res, 503, 'ADMIN_FETCH_FAILED', ERROR_MESSAGES.ADMIN_FETCH_FAILED);
    }

    const { id, email, app_metadata, created_at, last_sign_in_at, email_confirmed_at } = authResult.data.user;

    // Summarise job activity — counts per status
    const activityByStatus = {};
    if (!jobsResult.error && jobsResult.data) {
        for (const { status } of jobsResult.data) {
            activityByStatus[status] = (activityByStatus[status] ?? 0) + 1;
        }
    }

    if (jobsResult.error) {
        req.log.error({ err: jobsResult.error, targetId }, 'Admin: failed to fetch job activity for user');
    }

    logAdminAction(req, { action: 'get_user', targetUserId: targetId, result: 'success' });

    return sendSuccess(res, 200, {
        user: {
            id,
            email,
            role: app_metadata?.role ?? 'user',
            created_at,
            last_sign_in_at,
            email_confirmed_at,
        },
        activity: {
            available: !jobsResult.error,
            totalJobs: jobsResult.error ? 0 : (jobsResult.data?.length ?? 0),
            byStatus: activityByStatus,
        },
    }, 'User retrieved successfully');
}

/**
 * Handles DELETE /api/admin/users/[id] — permanently delete a user account
 *
 * Purpose: Allow admins to remove a user and all associated data
 * Connects to:
 *   - supabaseAdmin jobs delete (service role) — explicit delete before user removal
 *   - supabaseAdmin.auth.admin.deleteUser() — removes the auth record
 *
 * Order matters: jobs are deleted first. If user deletion subsequently fails,
 * the handler returns 500 and logs a partial failure for manual recovery.
 * Jobs belonging to other users are never touched (eq user_id filter).
 *
 * @param {import('next').NextApiRequest} req
 * @param {import('next').NextApiResponse} res
 * @param {string} targetId - Validated user UUID
 * @param {string} actorId - The admin's own user ID (for self-action guard)
 */
async function handleDelete(req, res, targetId, actorId) {
    if (!preventSelfAction(actorId, targetId, res)) return;

    // Step 1: delete the user's jobs (explicit, no reliance on DB cascade)
    const { error: jobsDeleteError } = await supabaseAdmin
        .from('jobs')
        .delete()
        .eq('user_id', targetId);

    if (jobsDeleteError) {
        req.log.error({ err: jobsDeleteError, targetId }, 'Admin: failed to delete user jobs before account deletion');
        logAdminAction(req, { action: 'delete_user', targetUserId: targetId, result: 'error', meta: { reason: 'jobs_delete_failed' } });
        return sendError(res, 503, 'ADMIN_DELETE_FAILED', ERROR_MESSAGES.ADMIN_DELETE_FAILED);
    }

    // Step 2: delete the auth user
    const { error: userDeleteError } = await supabaseAdmin.auth.admin.deleteUser(targetId);

    if (userDeleteError) {
        // Jobs already deleted — log partial failure for manual recovery
        req.log.error({ err: userDeleteError, targetId }, 'Admin: jobs deleted but user auth record deletion failed — partial failure');
        logAdminAction(req, { action: 'delete_user', targetUserId: targetId, result: 'error', meta: { reason: 'auth_delete_failed_after_jobs_deleted' } });
        return sendError(res, 503, 'ADMIN_DELETE_FAILED', ERROR_MESSAGES.ADMIN_DELETE_FAILED);
    }

    logAdminAction(req, { action: 'delete_user', targetUserId: targetId, result: 'success' });

    return sendSuccess(res, 200, null, 'User account deleted successfully');
}

async function handler(req, res) {
    if (!requireAdmin(req._rateLimitUser, res)) return;

    const paramResult = userIdParamSchema.safeParse(req.query);

    if (!paramResult.success) {
        return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
    }

    const targetId = paramResult.data.id;
    const actorId = req._rateLimitUser.id;

    switch (req.method) {
        case 'GET':
            return handleGet(req, res, targetId);
        case 'DELETE':
            return handleDelete(req, res, targetId, actorId);
        default:
            return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
    }
}

export default withRateLimit(handler, {
    requireAuth: true,
    allowedMethods: ['GET', 'DELETE'],
    operationByMethod: {
        GET: OPERATIONS.ADMIN_READ,
        DELETE: OPERATIONS.ADMIN_WRITE,
    },
});
