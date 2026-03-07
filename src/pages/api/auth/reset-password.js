import { createApiRouteClient } from '../../../server/lib/supabaseApiRoute.js';
import { resetPasswordServerSchema, getFirstErrorMessage } from '../../../shared/validations/authSchema.js';
import { sendSuccess, sendError } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';
import { logger } from '../../../shared/logger.js';
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';

/**
 * POST /api/auth/reset-password
 *
 * Purpose: Updates user password after email verification
 * Connects to:
 * - Supabase Auth for updateUser (password change)
 * - withRateLimit middleware with user-based rate limiting (authenticated route)
 * - resetPasswordServerSchema for password strength validation
 *
 * Security:
 * - Requires authenticated session (user clicked email link which set session)
 * - Server-side password strength validation prevents bypassing client Zod schema
 * - Rate-limited to prevent brute force
 */
async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
  }

  const validation = resetPasswordServerSchema.safeParse(req.body);
  if (!validation.success) {
    return sendError(res, 400, 'VALIDATION_ERROR',
      getFirstErrorMessage(validation.error));
  }

  const { password } = validation.data;

  try {
    const ssrClient = createApiRouteClient(req, res);

    const { data: { user }, error: getUserError } = await ssrClient.auth.getUser();
    if (getUserError || !user) {
      return sendError(res, 401, 'UNAUTHORIZED', ERROR_MESSAGES.UNAUTHORIZED);
    }

    const { error } = await ssrClient.auth.updateUser({ password });

    if (error) {
      logger.warn('Password update failed', { errorMessage: error.message });
      return sendError(res, 400, 'PASSWORD_UPDATE_FAILED', ERROR_MESSAGES.PASSWORD_UPDATE_FAILED);
    }

    return sendSuccess(res, 200, null, ERROR_MESSAGES.PASSWORD_UPDATE_SUCCESS);
  } catch (error) {
    logger.error('Reset-password service error', {
      error: error.message,
      ...(process.env.NODE_ENV !== 'production' && { stack: error.stack })
    });
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }
}

export default withRateLimit(handler, {
  requireAuth: true,
  operation: OPERATIONS.AUTH,
  allowedMethods: ['POST']
});
