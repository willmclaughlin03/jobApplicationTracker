import { createApiRouteClient } from '../../../server/lib/supabaseApiRoute.js';
import { signInSchema, getFirstErrorMessage } from '../../../shared/validations/authSchema.js';
import { sendSuccess, sendError } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';

import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';

/**
 * POST /api/auth/signin
 *
 * 
 * Connects to:
 * - Supabase Auth for credential validation
 * - withRateLimit middleware with IP-based rate limiting (public route)
 * - signInSchema for input validation
 *
 * Security: Rate-limited by IP to prevent brute force attacks
 */
async function handler(req, res) {
    if (req.method !== 'POST') {
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
    }

    const validation = signInSchema.safeParse(req.body);
    if (!validation.success) {
        return sendError(res, 400, 'VALIDATION_ERROR',
            getFirstErrorMessage(validation.error));
    }

    const { email, password } = validation.data;

    try {
        const ssrClient = createApiRouteClient(req, res);

        const { data, error } = await ssrClient.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            req.log.warn({ err: error }, 'Sign-in failed');
            return sendError(res, 401, 'SIGN_IN_FAILED', ERROR_MESSAGES.SIGN_IN_FAILED);
        }

        const { error: sessionError } = await ssrClient.auth.setSession({
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token
        });

        if (sessionError) {
            req.log.error({ err: sessionError }, 'Failed to set session cookies after sign-in');
            return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
        }

        return sendSuccess(res, 200, {
            user: { id: data.user.id, email: data.user.email, role: data.user.app_metadata?.role ?? 'user' }
        }, 'Signed in successfully');
    } catch (error) {
        req.log.error({ err: error }, 'Sign-in service error');
        return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    }
}

export default withRateLimit(handler, {
    requireAuth: false,
    operation: OPERATIONS.AUTH,
    allowedMethods: ['POST']
});
