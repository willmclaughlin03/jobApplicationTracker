import { sendError, sendSuccess } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';
import { billingCheckoutSchema } from '../../../shared/validations/billingSchema.js';
import {
  canStartCheckout,
  getOrCreateStripeCustomer,
  hashUserIdForIdempotency,
  loadBillingStatusOrThrow,
} from '../../../server/lib/billingService.js';
import { buildAppUrl, getPriceIdForPlan, stripe } from '../../../server/lib/stripe.js';

async function handler(req, res) {
  const validationResult = billingCheckoutSchema.safeParse(req.body);

  if (!validationResult.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
  }

  try {
    const billingStatus = await loadBillingStatusOrThrow(
      req._rateLimitUser.id,
      req._supabaseClient,
      req.log
    );

    if (!canStartCheckout(billingStatus)) {
      return sendError(res, 409, 'CHECKOUT_SESSION_FAILED', ERROR_MESSAGES.CHECKOUT_SESSION_FAILED);
    }

    const { stripeCustomerId } = await getOrCreateStripeCustomer(
      req._rateLimitUser.id,
      req._rateLimitUser.email,
      req.log
    );
    const userHash = hashUserIdForIdempotency(req._rateLimitUser.id);
    const { checkoutAttemptNonce, plan } = validationResult.data;
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      client_reference_id: req._rateLimitUser.id,
      line_items: [
        {
          price: getPriceIdForPlan(plan),
          quantity: 1,
        },
      ],
      success_url: buildAppUrl('/billing/success?session_id={CHECKOUT_SESSION_ID}'),
      cancel_url: buildAppUrl('/billing/cancel'),
    }, {
      idempotencyKey: `billing_checkout_${userHash.slice(0, 24)}_${plan}_${checkoutAttemptNonce}`,
    });

    if (!checkoutSession?.url) {
      throw new Error('Stripe checkout session did not include a URL');
    }

    return sendSuccess(res, 200, { url: checkoutSession.url }, 'Checkout session created');
  } catch (error) {
    if (error?.code === 'BILLING_STATUS_UNAVAILABLE') {
      req.log.error({ err: error }, 'Failed to start checkout due to local billing read failure');
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    }

    req.log.error({ err: error }, 'Failed to create Stripe checkout session');
    return sendError(res, 503, 'CHECKOUT_SESSION_FAILED', ERROR_MESSAGES.CHECKOUT_SESSION_FAILED);
  }
}

export default withRateLimit(handler, {
  requireAuth: true,
  operation: OPERATIONS.BILLING_WRITE,
  allowedMethods: ['POST'],
});
