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
 * - Sets Cache-Control: private, no-store before middleware or handler work
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
 * Evaluates the v1 route against the shared temporary session allowance.
 *
 * Purpose: consume the process-local v1/future-v2 allowance before identity,
 * cookies, Redis, Supabase, or handler work while preserving a synchronous
 * count/check/increment decision inside the ceiling primitive.
 *
 * @param {import('next').NextApiRequest} req - Session request with scoped logger.
 * @returns {object} Response-neutral allow, bounded 429, or fail-closed 503 decision.
 */
function evaluateTemporarySessionRequest(req) {
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
 * @param {import('next').NextApiRequest} req - Session request with scoped logger.
 * @param {import('next').NextApiResponse} res - Session response.
 * @param {object} decision - Validated response-neutral ceiling decision.
 * @returns {object} Next.js response chain.
 */
function writeTemporarySessionCeilingResponse(req, res, decision) {
  req.log.warn({
    event: 'temporary_session_ceiling_response',
    reason: decision.reason,
    statusCode: decision.statusCode,
  }, 'Temporary session ceiling rejected request');

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
