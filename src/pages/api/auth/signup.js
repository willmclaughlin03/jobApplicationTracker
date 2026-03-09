import { supabaseAdmin } from '../../../server/lib/supabaseServer.js';
import { createApiRouteClient } from '../../../server/lib/supabaseApiRoute.js';
import { signUpServerSchema, getFirstErrorMessage } from '../../../shared/validations/authSchema.js';
import { sendSuccess, sendError } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';
import { logger } from '../../../shared/logger.js';
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';

/**
 * POST /api/auth/signup
 *
 * Purpose: Server-side sign-up proxy to Supabase Auth
 * Connects to:
 * - Supabase Auth for account creation
 * - withRateLimit middleware with IP-based rate limiting (public route)
 * - signUpSchema for input validation (password strength, confirmation)
 *
 * Security: Rate-limited by IP, validates password strength server-side
 */
async function handler(req, res) {
    if (req.method !== 'POST') {
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
    }

    const validation = signUpServerSchema.safeParse(req.body);
    if (!validation.success) {
        return sendError(res, 400, 'VALIDATION_ERROR',
            getFirstErrorMessage(validation.error));
    }

    const { email, password } = validation.data;

    try {
        const { data, error } = await supabaseAdmin.auth.signUp({
            email,
            password
        });

        if (error) {
            logger.warn({ err: error }, 'Sign-up failed');
            return sendError(res, 400, 'SIGN_UP_FAILED', ERROR_MESSAGES.SIGN_UP_FAILED);
        }

        // data.session is null when email confirmation is required
        if (data.session) {
            const ssrClient = createApiRouteClient(req, res);
            const { error: sessionError } = await ssrClient.auth.setSession({
                access_token: data.session.access_token,
                refresh_token: data.session.refresh_token
            });

            if (sessionError) {
                logger.error({ err: sessionError }, 'Failed to set session cookies after sign-up');
                return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
            }
        }

        const message = data.session
            ? 'Account created successfully'
            : 'Account created. Please check your email to confirm your account.';

        return sendSuccess(res, 201, { user: data.user }, message);
    } catch (error) {
        logger.error({ err: error }, 'Sign-up service error');
        return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    }
}

export default withRateLimit(handler, {
    requireAuth: false,
    operation: OPERATIONS.AUTH,
    allowedMethods: ['POST']
});
