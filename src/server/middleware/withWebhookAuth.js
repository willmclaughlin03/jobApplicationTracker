import { ERROR_MESSAGES } from '../../shared/errors.js';
import { sendError } from '../../shared/response.js';
import { logger, attachRequestLogger } from '../../shared/logger.js';
import { verifyWebhookSignature } from '../lib/webhookSignature.js';

function getSingleHeaderValue(value) {
  return typeof value === 'string' ? value : null;
}

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
 * @param {string} [options.signatureHeader='stripe-signature'] - Header carrying the provider signature.
 * @param {Function} [options.verifySignature=verifyWebhookSignature] - Signature verification function.
 * @returns {Function} Wrapped handler
 */
export function withWebhookAuth(handler, options = {}) {
  const {
    allowedMethods = null,
    signatureHeader = 'stripe-signature',
    verifySignature = verifyWebhookSignature,
  } = options;

  return async (req, res) => {
    try {
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

      const signature = getSingleHeaderValue(req.headers?.[signatureHeader]);
      if (!signature || !signature.trim()) {
        (req.log || logger).warn(
          { method: req.method, signatureHeader },
          'Webhook signature header missing'
        );
        return sendError(
          res,
          400,
          'WEBHOOK_SIGNATURE_INVALID',
          ERROR_MESSAGES.WEBHOOK_SIGNATURE_INVALID
        );
      }

      try {
        req.webhookEvent = await verifySignature(req, { signature, signatureHeader });
      } catch (verificationError) {
        const verificationLog = {
          method: req.method,
          errorName: verificationError?.name,
          errorCode: verificationError?.code,
          errorMessage: verificationError?.message,
        };

        if (verificationError?.code === 'WEBHOOK_VERIFIER_NOT_CONFIGURED') {
          (req.log || logger).error(
            verificationLog,
            'Webhook signature verifier is not configured'
          );
          return sendError(
            res,
            503,
            'SERVICE_UNAVAILABLE',
            ERROR_MESSAGES.SERVICE_UNAVAILABLE
          );
        }

        (req.log || logger).warn(verificationLog, 'Webhook signature verification failed');
        return sendError(
          res,
          400,
          'WEBHOOK_SIGNATURE_INVALID',
          ERROR_MESSAGES.WEBHOOK_SIGNATURE_INVALID
        );
      }

      // WARNING: webhook routes must never log req.body or the raw request body.
      return await handler(req, res);
    } catch (handlerError) {
      (req.log || logger).error(
        { err: handlerError, method: req.method },
        'Unhandled webhook handler error'
      );

      if (res.headersSent) {
        res.end();
        return;
      }

      return sendError(res, 500, 'INTERNAL_SERVER_ERROR', ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
    }
  };
}
