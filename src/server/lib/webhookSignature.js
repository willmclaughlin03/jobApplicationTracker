import { getActiveStripeWebhookSecret, getStripeClient } from './stripeRuntime.js';
import { readRawBody } from './readRawBody.js';

function normalizeSignature(signature) {
  return typeof signature === 'string' ? signature.trim() : '';
}

class WebhookSignatureError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'WebhookSignatureError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Verify a Stripe webhook request against the raw request body.
 *
 * Purpose: centralize fail-closed signature verification so webhook routes
 * never accidentally verify against parsed JSON or partial payloads.
 *
 * @param {import('http').IncomingMessage & { rawBody?: Buffer | string }} req
 * @param {{ signature?: string, maxBodyBytes?: number }} [options]
 * @returns {Promise<import('stripe').Stripe.Event>}
 */
export async function verifyWebhookSignature(req, options = {}) {
  const signature = normalizeSignature(options.signature);

  if (!signature) {
    throw new WebhookSignatureError(
      'Stripe signature header missing',
      'WEBHOOK_SIGNATURE_INVALID',
      400
    );
  }

  const webhookSecret = getActiveStripeWebhookSecret();
  const rawBody = await readRawBody(req, { maxBytes: options.maxBodyBytes });

  return getStripeClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
}
