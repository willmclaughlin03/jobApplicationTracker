import { supabaseAdmin } from '../../../server/lib/supabaseServer.js';
import { forgotPasswordSchema, getFirstErrorMessage } from '../../../shared/validations/authSchema.js';
import { sendSuccess, sendError } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';
import { logger } from '../../../shared/logger.js';
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';

/**
 * Minimum response time in ms to prevent email enumeration via timing
 */
const MIN_RESPONSE_MS = 300;

/**
 * POST /api/auth/forgot-password
 *
 * Purpose: Sends a password reset email via Supabase Auth
 * Connects to:
 * - Supabase Auth for resetPasswordForEmail
 * - withRateLimit middleware with IP-based rate limiting (public route)
 * - forgotPasswordSchema for input validation
 *
 * Security:
 * - Rate-limited by IP to prevent email spam
 * - Always returns generic success to prevent email enumeration
 * - Minimum response delay to prevent timing-based enumeration
 */
async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
  }

  const validation = forgotPasswordSchema.safeParse(req.body);
  if (!validation.success) {
    return sendError(res, 400, 'VALIDATION_ERROR',
      getFirstErrorMessage(validation.error));
  }

  const { email } = validation.data;
  const start = Date.now();

  try {
    const redirectTo = req.body.redirectTo;

    // Validate redirectTo is same-origin to prevent open redirect.
    // Uses URL parsing instead of startsWith to prevent prefix attacks
    // (e.g. https://myapp.com.evil.com would pass a startsWith check).
    if (redirectTo) {
      if (typeof redirectTo !== 'string') {
        return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
      }

      const allowedOrigins = [
        process.env.NEXT_PUBLIC_SITE_URL,
        'http://localhost:3000',
      ].filter(Boolean);

      let parsedOrigin;
      try {
        parsedOrigin = new URL(redirectTo).origin;
      } catch {
        logger.warn('Rejected malformed redirect URL in forgot-password', { redirectTo });
        return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
      }

      const isAllowed = allowedOrigins.some(origin => parsedOrigin === origin);
      if (!isAllowed) {
        logger.warn('Rejected redirect URL in forgot-password', { redirectTo });
        return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
      }
    }

    const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
      redirectTo: redirectTo || undefined,
    });

    if (error) {
      logger.warn({ err: error }, 'Password reset email failed');
    }
  } catch (error) {
    logger.error({ err: error }, 'Forgot-password service error');
  }

  // Enforce minimum response time to prevent timing-based email enumeration
  const elapsed = Date.now() - start;
  if (elapsed < MIN_RESPONSE_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_RESPONSE_MS - elapsed));
  }

  // Always return success to prevent email enumeration
  return sendSuccess(res, 200, null, ERROR_MESSAGES.PASSWORD_RESET_SENT);
}

export default withRateLimit(handler, {
  requireAuth: false,
  operation: OPERATIONS.AUTH,
  allowedMethods: ['POST']
});
