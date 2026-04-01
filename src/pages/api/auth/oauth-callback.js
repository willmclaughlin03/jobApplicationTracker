/**
 * POST /api/auth/oauth-callback
 *
 * Purpose: Server-side leg of the Google OAuth PKCE exchange. Receives the
 * authorization code from the client-side callback page, exchanges it for a
 * Supabase session, and sets the CSRF cookie so the user can immediately make
 * authenticated requests after redirect.
 *
 * Connects to:
 * - createApiRouteClient for cookie-based PKCE exchange and session management
 * - generateCsrfToken / setCsrfCookie from server/lib/csrf.js
 * - withRateLimit middleware with IP-based rate limiting
 * - Client-side /auth/callback page which POSTs { code, next } here
 *
 * requireAuth: false — user has no session yet when this runs; the exchange
 *                      itself is what creates the session
 * csrfProtect: false — same reason; no session = no CSRF token yet; the token
 *                      is issued inline at the end of this handler
 *
 * Security:
 * - Code value is never logged
 * - next parameter is validated against open-redirect rules before use
 * - Session cookies are set httpOnly by createApiRouteClient's setAll callback
 * - CSRF token is issued immediately so the first dashboard action succeeds
 */
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { createApiRouteClient } from '../../../server/lib/supabaseApiRoute.js';
import { generateCsrfToken, setCsrfCookie } from '../../../server/lib/csrf.js';
import { sendSuccess, sendError } from '../../../shared/response.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';

async function handler(req, res) {
  const { code, next: rawNext } = req.body;

  // Validate code presence and length
  if (!code || typeof code !== 'string' || code.trim() === '') {
    return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
  }
  if (code.length > 2048) {
    return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
  }

  // Validate next against open-redirect rules; fall back to '/'
  let validatedNext = '/';
  if (
    typeof rawNext === 'string' &&
    rawNext.startsWith('/') &&
    !rawNext.startsWith('//') &&
    !rawNext.includes('\\')
  ) {
    validatedNext = rawNext;
  }

  req.log.info('OAuth code exchange initiated');

  const supabase = createApiRouteClient(req, res);

  let data, error;
  try {
    ({ data, error } = await supabase.auth.exchangeCodeForSession(code));
  } catch (err) {
    req.log.error({ err }, 'Unexpected error during OAuth code exchange');
    return sendError(res, 500, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }

  if (error || !data?.user) {
    req.log.error({ err: error }, 'OAuth code exchange failed');
    return sendError(res, 400, 'SIGN_IN_FAILED', ERROR_MESSAGES.SIGN_IN_FAILED);
  }

  const token = generateCsrfToken(data.user.id);
  setCsrfCookie(res, token);

  return sendSuccess(res, 200, { next: validatedNext }, 'Authentication successful');
}

export default withRateLimit(handler, {
  requireAuth: false,
  csrfProtect: false,
  operation: OPERATIONS.AUTH,
  allowedMethods: ['POST'],
});
