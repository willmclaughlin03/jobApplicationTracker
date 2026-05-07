import { sendError, sendSuccess } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';
import { billingCheckoutStatusSchema } from '../../../shared/validations/billingSchema.js';
import {
  assertStripeLivemode,
  BILLING_SYNC_MODES,
  BILLING_WRITE_OUTCOMES,
  formatStripeIdForLog,
  loadBillingStatusOrThrow,
  mapCheckoutStatus,
  syncSubscriptionFromStripe,
} from '../../../server/lib/billingService.js';
import { stripe } from '../../../server/lib/stripe.js';

const RETRYABLE_CHECKOUT_STATUS_ERROR_TYPES = new Set([
  'StripeAPIError',
  'StripeConnectionError',
  'StripeRateLimitError',
]);
const RETRYABLE_CHECKOUT_STATUS_ERROR_CODES = new Set([
  'BILLING_STATUS_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
]);
const TERMINAL_CHECKOUT_STATUS_ERROR_CODES = new Set([
  'BILLING_CUSTOMER_ID_MISSING',
  'BILLING_INVALID_INPUT',
  'BILLING_LIVEMODE_MISMATCH',
  'BILLING_OWNERSHIP_MISMATCH',
  'BILLING_RPC_INVALID_RESPONSE',
]);

/**
 * Resolve the Stripe customer id from a Checkout Session's mixed customer
 * shapes.
 *
 * Purpose: ownership verification and reconcile guards must handle the string
 * and expanded-object forms Stripe may return without trusting malformed
 * session payloads.
 *
 * @param {unknown} customer
 * @returns {string | null}
 */
function extractCheckoutSessionCustomerId(customer) {
  if (typeof customer === 'string') {
    return customer.trim() || null;
  }

  if (customer && typeof customer === 'object' && typeof customer.id === 'string') {
    return customer.id.trim() || null;
  }

  return null;
}

/**
 * Resolve the Stripe subscription id from a Checkout Session's mixed
 * subscription shapes.
 *
 * Purpose: authoritative reconcile only runs when Stripe returned a usable
 * subscription identifier, so this helper keeps that shape handling local to
 * the route.
 *
 * @param {unknown} subscription
 * @returns {string | null}
 */
function extractStripeSubscriptionId(subscription) {
  if (typeof subscription === 'string') {
    return subscription.trim() || null;
  }

  if (subscription && typeof subscription === 'object' && typeof subscription.id === 'string') {
    return subscription.id.trim() || null;
  }

  return null;
}

/**
 * Decide whether a completed Checkout Session has enough confirmed ownership
 * information to safely run an authoritative local reconcile.
 *
 * Purpose: completed checkout polling must fail closed when the route cannot
 * prove that the Stripe session customer still belongs to the authenticated
 * local billing record.
 *
 * @param {string | null} checkoutSessionCustomerId
 * @param {string | null | undefined} localStripeCustomerId
 * @returns {boolean}
 */
function hasConfirmedCheckoutCustomerOwnership(checkoutSessionCustomerId, localStripeCustomerId) {
  return Boolean(
    checkoutSessionCustomerId
    && localStripeCustomerId
    && checkoutSessionCustomerId === localStripeCustomerId
  );
}

/**
 * Decide whether a non-throwing reconcile outcome should stop checkout polling
 * with a terminal error state.
 *
 * Purpose: some reconcile outcomes reflect invariant or data-integrity issues,
 * not temporary lag, so the success-page contract should not keep polling them
 * as if entitlement is merely catching up.
 *
 * @param {string | null | undefined} outcome
 * @returns {boolean}
 */
function isTerminalReconcileOutcome(outcome) {
  return [
    BILLING_WRITE_OUTCOMES.CUSTOMER_NOT_FOUND,
    BILLING_WRITE_OUTCOMES.UNSUPPORTED_STATUS_IGNORED,
  ].includes(outcome);
}

/**
 * Classify caught reconcile failures into retryable service failures versus
 * terminal checkout-state errors.
 *
 * Purpose: the success page should reserve `503 SERVICE_UNAVAILABLE` for
 * transport/configuration-style issues, while invariant or invalid-request
 * failures stop polling in-band with a terminal `error` state.
 *
 * Maintenance note: this allowlist must be kept current as Stripe and local
 * billing error types evolve so new invariant failures do not silently become
 * retryable.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableCheckoutStatusError(error) {
  if (error?.type === 'StripeInvalidRequestError' || TERMINAL_CHECKOUT_STATUS_ERROR_CODES.has(error?.code)) {
    return false;
  }

  if (RETRYABLE_CHECKOUT_STATUS_ERROR_TYPES.has(error?.type)) {
    return true;
  }

  if (typeof error?.statusCode === 'number') {
    return error.statusCode >= 500;
  }

  if (typeof error?.status === 'number') {
    return error.status >= 500;
  }

  return RETRYABLE_CHECKOUT_STATUS_ERROR_CODES.has(error?.code);
}

/**
 * Resolve the authenticated caller's checkout-session poll state.
 *
 * Purpose: the billing success page uses this route to verify Stripe checkout
 * ownership, fail closed when local billing cannot be confirmed, and perform
 * at most one authoritative reconcile before returning the next UI state.
 *
 * @param {import('next').NextApiRequest & { body: { sessionId?: string }, _rateLimitUser: { id: string }, _supabaseClient: object, log: object }} req
 * @param {import('next').NextApiResponse} res
 * @returns {Promise<void>}
 */
async function handler(req, res) {
  const validationResult = billingCheckoutStatusSchema.safeParse(req.body);

  if (!validationResult.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
  }

  let checkoutSession;

  try {
    checkoutSession = await stripe.checkout.sessions.retrieve(validationResult.data.sessionId);
  } catch (error) {
    if (error?.type === 'StripeInvalidRequestError' || error?.statusCode === 404) {
      return sendError(
        res,
        403,
        'CHECKOUT_SESSION_OWNERSHIP_INVALID',
        ERROR_MESSAGES.CHECKOUT_SESSION_OWNERSHIP_INVALID
      );
    }

    req.log.error({ err: error }, 'Failed to retrieve Stripe checkout session');
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }

  if (checkoutSession?.client_reference_id !== req._rateLimitUser.id) {
    return sendError(
      res,
      403,
      'CHECKOUT_SESSION_OWNERSHIP_INVALID',
      ERROR_MESSAGES.CHECKOUT_SESSION_OWNERSHIP_INVALID
    );
  }

  try {
    assertStripeLivemode(checkoutSession?.livemode, {
      operation: 'checkoutStatus',
      log: req.log,
    });
  } catch (error) {
    return sendSuccess(res, 200, { state: 'error' }, 'Checkout session failed');
  }

  let billingStatus;

  try {
    billingStatus = await loadBillingStatusOrThrow(
      req._rateLimitUser.id,
      req._supabaseClient,
      req.log
    );
  } catch (error) {
    req.log.error({ err: error }, 'Failed to read local billing state during checkout polling');
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }

  const checkoutSessionCustomerId = extractCheckoutSessionCustomerId(checkoutSession?.customer);
  if (
    checkoutSessionCustomerId
    && billingStatus.stripeCustomerId
    && !hasConfirmedCheckoutCustomerOwnership(checkoutSessionCustomerId, billingStatus.stripeCustomerId)
  ) {
    req.log.warn(
      {
        checkoutSessionCustomerId: formatStripeIdForLog(checkoutSessionCustomerId, 'warn'),
        localStripeCustomerId: formatStripeIdForLog(billingStatus.stripeCustomerId, 'warn'),
      },
      'Rejected checkout polling because Stripe customer ownership did not match local billing state'
    );
    return sendError(
      res,
      403,
      'CHECKOUT_SESSION_OWNERSHIP_INVALID',
      ERROR_MESSAGES.CHECKOUT_SESSION_OWNERSHIP_INVALID
    );
  }

  if (checkoutSession?.status === 'complete' && !billingStatus.entitled) {
    if (!hasConfirmedCheckoutCustomerOwnership(checkoutSessionCustomerId, billingStatus.stripeCustomerId)) {
      return sendError(
        res,
        403,
        'CHECKOUT_SESSION_OWNERSHIP_INVALID',
        ERROR_MESSAGES.CHECKOUT_SESSION_OWNERSHIP_INVALID
      );
    }

    const stripeSubscriptionId = extractStripeSubscriptionId(checkoutSession.subscription);

    if (!stripeSubscriptionId) {
      return sendSuccess(res, 200, { state: 'error' }, 'Checkout session could not be reconciled');
    }

    try {
      const syncResult = await syncSubscriptionFromStripe(
        stripeSubscriptionId,
        {
          mode: BILLING_SYNC_MODES.AUTHORITATIVE,
          expectedUserId: req._rateLimitUser.id,
        },
        req.log
      );

      if (syncResult?.userId && syncResult.userId !== req._rateLimitUser.id) {
        return sendError(
          res,
          403,
          'CHECKOUT_SESSION_OWNERSHIP_INVALID',
          ERROR_MESSAGES.CHECKOUT_SESSION_OWNERSHIP_INVALID
        );
      }

      if (isTerminalReconcileOutcome(syncResult?.outcome)) {
        return sendSuccess(res, 200, { state: 'error' }, 'Checkout session could not be reconciled');
      }

      billingStatus = await loadBillingStatusOrThrow(
        req._rateLimitUser.id,
        req._supabaseClient,
        req.log
      );
    } catch (error) {
      if (error?.code === 'BILLING_OWNERSHIP_MISMATCH') {
        return sendError(
          res,
          403,
          'CHECKOUT_SESSION_OWNERSHIP_INVALID',
          ERROR_MESSAGES.CHECKOUT_SESSION_OWNERSHIP_INVALID
        );
      }

      if (isRetryableCheckoutStatusError(error)) {
        req.log.error({ err: error }, 'Failed to reconcile local billing state from Stripe during checkout polling');
        return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
      }

      return sendSuccess(res, 200, { state: 'error' }, 'Checkout session failed');
    }
  }

  return sendSuccess(res, 200, {
    state: mapCheckoutStatus({
      billingStatus,
      checkoutSessionStatus: checkoutSession?.status,
    }),
  }, 'Checkout status retrieved successfully');
}

export default withRateLimit(handler, {
  requireAuth: true,
  operation: OPERATIONS.BILLING_WRITE,
  allowedMethods: ['POST'],
});
