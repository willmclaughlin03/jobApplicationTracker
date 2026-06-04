/**
 * GET /api/auth/session
 *
 * Purpose: Returns the current authenticated user from httpOnly cookies.
 * Replaces client-side supabase.auth.getSession() which required non-httpOnly
 * cookies readable by JavaScript.
 *
 * Connects to:
 * - createApiRouteClient for cookie-based session management
 * - withRateLimit middleware with IP-based rate limiting
 *
 * Security:
 * - Returns only safe user fields (id, email) — never tokens
 * - Sets Cache-Control: no-store to prevent caching of user data
 * - Rate-limited to prevent abuse
 */
import { createApiRouteClient } from '../../../server/lib/supabaseApiRoute.js';
import { sendSuccess, sendError } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';
import { AUTH_ERROR_CODES, classifyAuthError } from '../../../server/lib/authErrorClassifier.js';

import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { IP_COOLDOWN_POLICIES } from '../../../server/lib/ipCooldown.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';

const AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const supabase = createApiRouteClient(req, res);
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error) {
      const errorCode = classifyAuthError(error);

      if (errorCode === AUTH_ERROR_CODES.AUTH_UNAVAILABLE) {
        req.log.error(
          { authErrorName: error?.name, authErrorStatus: error?.status, authErrorCode: error?.code },
          'Session auth check unavailable'
        );
        res.setHeader('Retry-After', AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS);
        return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
      }

      return sendSuccess(res, 200, { user: null });
    }

    if (!user) {
      return sendSuccess(res, 200, { user: null });
    }

    return sendSuccess(res, 200, {
      user: { id: user.id, email: user.email, role: user.app_metadata?.role ?? 'user' }
    });
  } catch (err) {
    req.log.error({ err }, 'Session check failed');
    res.setHeader('Retry-After', AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS);
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }
}

export default withRateLimit(handler, {
  requireAuth: false,
  operation: OPERATIONS.AUTH,
  allowedMethods: ['GET'],
  ipCooldown: IP_COOLDOWN_POLICIES.AUTH_SESSION
});
