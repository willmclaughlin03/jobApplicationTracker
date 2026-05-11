import { ERROR_MESSAGES } from '../../shared/errors.js';
import { sendError } from '../../shared/response.js';
import { logger, attachRequestLogger } from '../../shared/logger.js';
import { verifyWebhookSignature } from '../lib/webhookSignature.js';
import { MAX_WEBHOOK_RAW_BODY_BYTES } from '../lib/readRawBody.js';

const WEBHOOK_VERIFIER_CONFIG_ERROR_CODES = new Set([
  'WEBHOOK_VERIFIER_NOT_CONFIGURED',
  'STRIPE_CONFIG_INVALID',
]);

/**
 * Normalize a trusted single-value header and fail closed on repeated values.
 *
 * Purpose: webhook verification should not silently pick one header entry from
 * an unexpected array shape when upstream infrastructure duplicates a header.
 *
 * @param {string | string[] | undefined} value
 * @returns {string | null}
 */
function getSingleHeaderValue(value) {
  return typeof value === 'string' ? value : null;
}

/**
 * Parse the Content-Length header when it is a simple non-negative integer.
 *
 * Purpose: this is only an early rejection hint for oversized webhook
 * requests; raw-body buffering still enforces the hard byte cap independently.
 *
 * @param {string | string[] | undefined} value
 * @returns {number | null}
 */
function getContentLength(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();

  if (!/^\d+$/.test(trimmedValue)) {
    return null;
  }

  return Number(trimmedValue);
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
 * - Consuming routes must enforce a hard raw-body read cap while buffering.
 * - Webhook routes must never log `req.body` or any raw body buffer.
 * - Content-Length is treated as advisory only; the buffering helper is still
 *   the real fail-closed size guard.
 *
 * Side effects:
 * - attaches a request-scoped logger via attachRequestLogger()
 * - stores the verified provider event on `req.webhookEvent`
 *
 * @param {Function} handler - Next.js API handler (req, res) => Promise
 * @param {Object} [options]
 * @param {string[] | null} [options.allowedMethods=null] - Explicitly allowed methods.
 * @param {string} [options.signatureHeader='stripe-signature'] - Header carrying the provider signature.
 * @param {Function} [options.verifySignature=verifyWebhookSignature] - Signature verification function.
 * @param {number} [options.maxBodyBytes=MAX_WEBHOOK_RAW_BODY_BYTES] - Hard raw-body cap.
 * @returns {Function} Wrapped handler
 */
export function withWebhookAuth(handler, options = {}) {
  const {
    allowedMethods = null,
    signatureHeader = 'stripe-signature',
    verifySignature = verifyWebhookSignature,
    maxBodyBytes = MAX_WEBHOOK_RAW_BODY_BYTES,
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

      const contentLength = getContentLength(getSingleHeaderValue(req.headers?.['content-length']));
      if (contentLength !== null && contentLength > maxBodyBytes) {
        (req.log || logger).warn(
          { method: req.method, contentLength, maxBodyBytes },
          'Webhook request exceeded the maximum allowed size'
        );
        return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Webhook payload too large.');
      }

      try {
        req.webhookEvent = await verifySignature(req, {
          signature,
          signatureHeader,
          maxBodyBytes,
        });
      } catch (verificationError) {
        const verificationLog = {
          method: req.method,
          errorName: verificationError?.name,
          errorCode: verificationError?.code,
          errorMessage: verificationError?.message,
        };

        if (WEBHOOK_VERIFIER_CONFIG_ERROR_CODES.has(verificationError?.code)) {
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

        if (verificationError?.code === 'RAW_BODY_TOO_LARGE') {
          (req.log || logger).warn(
            {
              method: req.method,
              maxBytes: verificationError?.maxBytes,
              receivedBytes: verificationError?.receivedBytes,
            },
            'Webhook request exceeded the maximum allowed size while buffering'
          );
          return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Webhook payload too large.');
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
