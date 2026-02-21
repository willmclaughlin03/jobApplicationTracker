import { supabaseAdmin } from '../../../server/lib/supabaseServer.js';
import { signInSchema, getFirstErrorMessage } from '../../../shared/validations/authSchema.js';
import { sendSuccess, sendError } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';
import { logger } from '../../../shared/logger.js';
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
        const { data, error } = await supabaseAdmin.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            logger.warn('Sign-in failed', {
                errorMessage: error.message
            });
            return sendError(res, 401, 'SIGN_IN_FAILED', ERROR_MESSAGES.SIGN_IN_FAILED);
        }

        return sendSuccess(res, 200, {
            user: data.user,
            session: data.session
        }, 'Signed in successfully');
    } catch (error) {
        logger.error('Sign-in service error', {
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
