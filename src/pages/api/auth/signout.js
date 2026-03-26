/**
 * POST /api/auth/signout
 *
 * Purpose: Server-side sign-out — revokes the current session's refresh token
 * (current device only) and clears httpOnly auth cookies. Client-side JS cannot
 * clear httpOnly cookies, so this endpoint is required.
 *
 * Fallback: If the session is already expired and signOut() errors, auth cookies
 * are cleared directly by pattern match so users with stale tokens can never get
 * stuck in a signed-out-but-cookies-still-present state.
 *
 * requireAuth: false — must remain reachable with an expired or missing session
 * so the fallback clearing always runs.
 *
 * Connects to:
 * - createApiRouteClient for cookie-based session management
 * - withRateLimit middleware with IP-based rate limiting (public route)
 */
import { createApiRouteClient } from '../../../server/lib/supabaseApiRoute.js';
import { sendSuccess } from '../../../shared/response.js';

import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';
import { serialize } from 'cookie';
import { clearCsrfCookie } from '../../../server/lib/csrf.js';

const AUTH_COOKIE_PATTERN = /^sb-.+-auth-token/;

const EXPIRED_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 0
};

/**
 * Manually expires all auth cookies matching the Supabase naming pattern.
 * Called when signOut() errors (e.g. expired session) so the SSR client's
 * setAll callback never fires to do its own cleanup.
 *
 * @param {import('next').NextApiRequest} req
 * @param {import('next').NextApiResponse} res
 */
function clearAuthCookies(req, res) {
  const cookiesToClear = Object.keys(req.cookies).filter(name =>
    AUTH_COOKIE_PATTERN.test(name)
  );

  if (cookiesToClear.length === 0) return;

  const cleared = cookiesToClear.map(name =>
    serialize(name, '', EXPIRED_COOKIE_OPTIONS)
  );

  const existing = res.getHeader('Set-Cookie') ?? [];
  res.setHeader(
    'Set-Cookie',
    [...(Array.isArray(existing) ? existing : [existing]), ...cleared]
  );
}

async function handler(req, res) {
  const ssrClient = createApiRouteClient(req, res);

  try {
    const { error } = await ssrClient.auth.signOut();

    if (error) {
      // Session is likely already expired — the SSR client may not have fired
      // setAll to clear cookies, so do it manually.
      req.log.warn({ err: error }, 'signOut returned error, clearing cookies manually');
      clearAuthCookies(req, res);
    }
  } catch (err) {
    req.log.error({ err }, 'Unexpected error during sign-out, clearing cookies manually');
    clearAuthCookies(req, res);
  }

  // Clear CSRF cookie on every signout path (success and fallback)
  clearCsrfCookie(res);

  // Always return 200 — the goal (no valid session, no auth cookies) is achieved
  // regardless of whether signOut() succeeded or the fallback ran.
  return sendSuccess(res, 200, null, 'Signed out successfully');
}

export default withRateLimit(handler, {
  requireAuth: false,
  operation: OPERATIONS.AUTH,
  allowedMethods: ['POST']
});
