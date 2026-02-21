import { supabaseAdmin } from '../../../server/lib/supabaseServer.js';
import { signUpSchema, getFirstErrorMessage } from '../../../shared/validations/authSchema.js';
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

    const validation = signUpSchema.safeParse(req.body);
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
            logger.warn('Sign-up failed', {
                errorMessage: error.message
            });
            return sendError(res, 400, 'SIGN_UP_FAILED', ERROR_MESSAGES.SIGN_UP_FAILED);
        }

        return sendSuccess(res, 201, {
            user: data.user,
            session: data.session
        }, 'Account created successfully');
    } catch (error) {
        logger.error('Sign-up service error', {
            error: error.message,
            stack: error.stack
        });
        return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    }
}

export default withRateLimit(handler, {
    requireAuth: false,
    operation: OPERATIONS.AUTH,
    allowedMethods: ['POST']
});
