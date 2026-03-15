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
import { logger } from '../../../shared/logger.js';
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const supabase = createApiRouteClient(req, res);
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
      return sendSuccess(res, 200, { user: null });
    }

    return sendSuccess(res, 200, {
      user: { id: user.id, email: user.email }
    });
  } catch (err) {
    logger.error({ err }, 'Session check failed');
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }
}

export default withRateLimit(handler, {
  requireAuth: false,
  operation: OPERATIONS.AUTH,
  allowedMethods: ['GET']
});
