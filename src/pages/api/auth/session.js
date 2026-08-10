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
 * - Returns only safe user fields (id, email, application role) — never tokens
 * - Sets Cache-Control: no-store to prevent caching of user data
 * - Rate-limited to prevent abuse
 */
import { createApiRouteClient } from '../../../server/lib/supabaseApiRoute.js';
import { sendSuccess, sendError } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';

import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import {
  TEMPORARY_SESSION_CEILING_WINDOW_SECONDS,
  temporarySessionCeiling,
} from '../../../server/lib/temporarySessionCeiling.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';

/**
 * Evaluates the v1 route against the shared temporary session ceiling.
 *
 * Why: v1 and the future v2 route must consume the same per-instance/IP
 * allowance before either route can bypass or call the Redis-backed limiter.
 *
 * @param {import('next').NextApiRequest} req - Session request.
 * @returns {object} Response-neutral ceiling decision.
 */
function evaluateTemporarySessionRequest(req) {
  return temporarySessionCeiling.evaluate(req, { routeVersion: 'v1' });
}

/**
 * Writes the legacy v1 envelope for temporary-ceiling failures.
 *
 * Why: CHUNK-1 must not leak the future v2 response contract into the current
 * endpoint. Invalid guard results fail closed as ordinary v1 503 responses.
 *
 * @param {import('next').NextApiRequest} _req - Session request.
 * @param {import('next').NextApiResponse} res - Session response.
 * @param {object} result - Response-neutral ceiling decision.
 * @returns {object} Next.js response chain.
 */
function writeTemporarySessionCeilingResponse(_req, res, result) {
  const retryAfterSeconds = result?.retryAfterSeconds;
  if (result?.statusCode === 429
    && Number.isSafeInteger(retryAfterSeconds)
    && retryAfterSeconds >= 1
    && retryAfterSeconds <= TEMPORARY_SESSION_CEILING_WINDOW_SECONDS) {
    res.setHeader('Retry-After', retryAfterSeconds);
    return sendError(
      res,
      429,
      'RATE_LIMIT_EXCEEDED',
      ERROR_MESSAGES.RATE_LIMIT_EXCEEDED
    );
  }

  return sendError(
    res,
    503,
    'SERVICE_UNAVAILABLE',
    ERROR_MESSAGES.SERVICE_UNAVAILABLE
  );
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  try {
    const supabase = createApiRouteClient(req, res);
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
      return sendSuccess(res, 200, { user: null });
    }

    return sendSuccess(res, 200, {
      user: { id: user.id, email: user.email, role: user.app_metadata?.role ?? 'user' }
    });
  } catch (err) {
    req.log.error({ err }, 'Session check failed');
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }
}

export default withRateLimit(handler, {
  requireAuth: false,
  operation: OPERATIONS.AUTH,
  allowedMethods: ['GET'],
  preRateLimitGuard: evaluateTemporarySessionRequest,
  writePreRateLimitGuardResponse: writeTemporarySessionCeilingResponse,
});
