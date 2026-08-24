/**
 * GET /api/auth/session
 *
 * Purpose: Returns the current authenticated user from httpOnly cookies.
 * Replaces client-side supabase.auth.getSession() which required non-httpOnly
 * cookies readable by JavaScript.
 *
 * Connects to:
 * - createApiRouteClient for cookie-based session management
 * - withRateLimit middleware with the shared ceiling and generic AUTH quota
 *
 * Security:
 * - Returns only safe user fields (id, email, application role) — never tokens
 * - Sets Cache-Control: private, no-store before middleware or handler work
 * - Shared atomic ceiling runs before cookies, Supabase, or handler work
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
 * Evaluates the v1 route against the shared temporary session allowance.
 *
 * Purpose: consume the Redis-backed v1/future-v2 allowance before legacy
 * identity, cookies, Supabase, or handler work.
 *
 * @param {import('next').NextApiRequest} req - Session request with scoped logger.
 * @returns {Promise<object>} Response-neutral allow, bounded 429, or fail-closed 503 decision.
 */
async function evaluateTemporarySessionRequest(req) {
  return temporarySessionCeiling.evaluate(req, {
    routeVersion: 'v1',
    logger: req.log,
  });
}

/**
 * Writes the legacy v1 response for a temporary-ceiling rejection.
 *
 * Purpose: keep CHUNK-1 response-neutral decisions from introducing a future
 * v2 envelope. Only the exact bounded exhaustion decision receives a retry
 * delay; every other result remains a retry-free legacy 503.
 *
 * @param {import('next').NextApiRequest} _req - Unused middleware callback request.
 * @param {import('next').NextApiResponse} res - Session response.
 * @param {object} decision - Validated response-neutral ceiling decision.
 * @returns {object} Next.js response chain.
 */
function writeTemporarySessionCeilingResponse(_req, res, decision) {
  const retryAfterSeconds = decision?.retryAfterSeconds;
  if (decision?.statusCode === 429
    && decision?.reason === 'limit_exceeded'
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

  res.removeHeader('Retry-After');
  return sendError(
    res,
    503,
    'SERVICE_UNAVAILABLE',
    ERROR_MESSAGES.SERVICE_UNAVAILABLE
  );
}

async function handler(req, res) {
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
  cacheControl: 'private, no-store',
  preRateLimitGuard: evaluateTemporarySessionRequest,
  writePreRateLimitGuardResponse: writeTemporarySessionCeilingResponse,
});
