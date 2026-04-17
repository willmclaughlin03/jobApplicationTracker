import { ERROR_MESSAGES } from '../../shared/errors.js';
import { sendError } from '../../shared/response.js';
import { attachRequestLogger } from '../../shared/logger.js';

/**
 * Webhook middleware wrapper for Next.js API handlers.
 *
 * Purpose: Preserve request correlation, fail-closed method guarding, and
 * centralized error handling for webhook endpoints without pulling in the app's
 * normal auth, CSRF, IP, or Redis-backed rate-limit pipeline.
 *
 * WARNING:
 * - Consuming routes must set `export const config = { api: { bodyParser: false } }`.
 * - Consuming routes must reject oversized `Content-Length` values.
 * - Consuming routes must enforce a hard raw-body read cap while buffering.
 * - Webhook routes must never log `req.body` or any raw body buffer.
 *
 * @param {Function} handler - Next.js API handler (req, res) => Promise
 * @param {Object} [options]
 * @param {string[] | null} [options.allowedMethods=null] - Explicitly allowed methods.
 * @returns {Function} Wrapped handler
 */
export function withWebhookAuth(handler, options = {}) {
  const { allowedMethods = null } = options;

  return async (req, res) => {
    const requestId = attachRequestLogger(req);
    res.setHeader('x-request-id', requestId);

    // Same-origin app only. Reject preflight-style requests instead of
    // silently succeeding and bypassing the route's explicit method contract.
    if (req.method === 'OPTIONS') {
      return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
    }

    if (!allowedMethods || !allowedMethods.includes(req.method)) {
      return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
    }

    try {
      // WARNING: webhook routes must never log req.body or the raw request body.
      return await handler(req, res);
    } catch (handlerError) {
      req.log.error({ err: handlerError, method: req.method }, 'Unhandled webhook handler error');

      if (res.headersSent) {
        res.end();
        return;
      }

      return sendError(res, 500, 'INTERNAL_SERVER_ERROR', ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
    }
  };
}
