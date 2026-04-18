/**
 * Provider-specific webhook verification must be wired in by the consuming
 * route or replaced in tests. This default fails closed so unsigned webhook
 * traffic is never accepted by mistake.
 *
 * @returns {Promise<never>}
 */
export async function verifyWebhookSignature() {
  const error = new Error('Webhook signature verifier is not configured');
  error.code = 'WEBHOOK_VERIFIER_NOT_CONFIGURED';
  throw error;
}
