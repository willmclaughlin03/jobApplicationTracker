/**
 * GET /api/auth/csrf
 *
 * Purpose: Issues a CSRF token bound to the authenticated user's ID.
 * Sets a non-httpOnly cookie that the client reads and sends as x-csrf-token
 * on all subsequent state-changing requests (POST/PUT/DELETE/PATCH).
 *
 * requireAuth: true  — token must be bound to an authenticated user
 * csrfProtect: false — avoids the circular dependency of needing a CSRF
 *                      token to obtain a CSRF token
 *
 * Connects to:
 * - withRateLimit for auth + rate limiting
 * - generateCsrfToken / setCsrfCookie from server/lib/csrf.js
 * - AuthContext.js which fetches this on sign-in and mount
 */
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { generateCsrfToken, setCsrfCookie } from '../../../server/lib/csrf.js';
import { sendSuccess, sendError } from '../../../shared/response.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';

async function handler(req, res) {
  const userId = req._rateLimitUser?.id;

  // Defense-in-depth: requireAuth: true guarantees this, but guard anyway
  if (!userId) {
    return sendError(res, 401, 'UNAUTHORIZED', ERROR_MESSAGES.UNAUTHORIZED);
  }

  const token = generateCsrfToken(userId);
  setCsrfCookie(res, token);

  return sendSuccess(res, 200, null, 'CSRF token set');
}

export default withRateLimit(handler, {
  requireAuth: true,
  csrfProtect: false,
  operation: OPERATIONS.READ,
  allowedMethods: ['GET'],
});
