/**
 * POST /api/auth/exchange-token
 *
 * Purpose: Receives access_token and refresh_token from the client-side
 * callback page and writes them as httpOnly cookies via setSession().
 * Then validates the tokens by calling getUser().
 *
 * This exists because Supabase sends password recovery tokens as URL hash
 * fragments which never reach the server. The callback page reads the hash
 * and POSTs the tokens here for secure server-side session establishment.
 *
 * Connects to:
 * - createApiRouteClient for cookie-based session management
 * - withRateLimit middleware with IP-based rate limiting
 *
 * Security:
 * - Rate-limited by IP (pre-auth endpoint, no CSRF possible)
 * - Validates tokens via getUser() after setSession()
 * - Supabase recovery tokens are single-use
 */
import { createApiRouteClient } from '../../../server/lib/supabaseApiRoute.js';
import { sendSuccess, sendError } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';

import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';

async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
  }

  const { access_token, refresh_token } = req.body || {};

  // JWTs are strictly base64url + dots; reject anything else early
  const JWT_SAFE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

  if (
    typeof access_token !== 'string' || access_token.length === 0 || access_token.length > 8000 ||
    !JWT_SAFE.test(access_token) ||
    typeof refresh_token !== 'string' || refresh_token.length === 0 || refresh_token.length > 8000 ||
    !JWT_SAFE.test(refresh_token)
  ) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid or missing tokens.');
  }

  try {
    const supabase = createApiRouteClient(req, res);

    const { error: sessionError } = await supabase.auth.setSession({
      access_token,
      refresh_token
    });

    if (sessionError) {
      req.log.warn({ err: sessionError }, 'Token exchange failed: setSession error');
      return sendError(res, 401, 'TOKEN_EXCHANGE_FAILED', 'Invalid or expired token. Please request a new link.');
    }

    // Verify the session is actually valid
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError || !user) {
      req.log.warn({ err: userError }, 'Token exchange failed: getUser verification failed');
      return sendError(res, 401, 'TOKEN_EXCHANGE_FAILED', 'Invalid or expired token. Please request a new link.');
    }

    return sendSuccess(res, 200, { user: { id: user.id, email: user.email } }, 'Session established');
  } catch (err) {
    req.log.error({ err }, 'Token exchange service error');
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }
}

export default withRateLimit(handler, {
  requireAuth: false,
  operation: OPERATIONS.AUTH,
  allowedMethods: ['POST']
});
