import { sendSuccess } from '../../../shared/response.js';
import { withWebhookAuth } from '../../../server/middleware/withWebhookAuth.js';
import { processBillingWebhookEvent } from '../../../server/lib/billingWebhookDispatcher.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Handle verified Stripe billing webhook deliveries.
 *
 * Purpose: keep the public route thin; signature verification, raw-body
 * buffering, and method gating live in withWebhookAuth, while billing event
 * orchestration lives in billingWebhookDispatcher.
 *
 * @param {import('next').NextApiRequest & { webhookEvent?: object, log: object }} req
 * @param {import('next').NextApiResponse} res
 * @returns {Promise<void>}
 */
async function handler(req, res) {
  const result = await processBillingWebhookEvent(req.webhookEvent, req.log);

  return sendSuccess(
    res,
    200,
    {
      received: true,
      receiptResult: result.receiptResult,
      duplicate: result.duplicate,
    },
    'Webhook processed'
  );
}

export default withWebhookAuth(handler, {
  allowedMethods: ['POST'],
});
