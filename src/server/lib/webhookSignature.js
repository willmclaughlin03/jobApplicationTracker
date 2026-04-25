import { stripe, getActiveStripeWebhookSecret } from './stripe.js';
import { readRawBody } from './readRawBody.js';

function normalizeSignature(signature) {
  return typeof signature === 'string' ? signature.trim() : '';
}

/**
 * Verify a Stripe webhook request against the raw request body.
 *
 * Purpose: centralize fail-closed signature verification so webhook routes
 * never accidentally verify against parsed JSON or partial payloads.
 *
 * @param {import('http').IncomingMessage & { rawBody?: Buffer | string }} req
 * @param {{ signature?: string }} [options]
 * @returns {Promise<import('stripe').Stripe.Event>}
 */
export async function verifyWebhookSignature(req, options = {}) {
  const signature = normalizeSignature(options.signature);

  if (!signature) {
    const error = new Error('Stripe signature header missing');
    error.code = 'WEBHOOK_SIGNATURE_INVALID';
    throw error;
  }

  const webhookSecret = getActiveStripeWebhookSecret();
  const rawBody = await readRawBody(req);

  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}
