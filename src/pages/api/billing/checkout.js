import { z } from 'zod';
import { sendError, sendSuccess } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';
import { billingCheckoutSchema } from '../../../shared/validations/billingSchema.js';
import {
  canStartCheckout,
  claimPendingCheckoutSession,
  failPendingCheckoutSession,
  finalizePendingCheckoutSession,
  getOrCreateStripeCustomer,
  hashUserIdForIdempotency,
  loadBillingStatusOrThrow,
  PENDING_CHECKOUT_SESSION_OUTCOMES,
  waitForPendingCheckoutSessionOpen,
} from '../../../server/lib/billingService.js';

const authenticatedBillingEmailSchema = z.string().trim().email().max(320);
const BILLING_CHECKOUT_DISABLED_ENV_VAR = 'BILLING_CHECKOUT_DISABLED';

/**
 * Decide whether new Checkout Session creation is emergency-disabled.
 *
 * Purpose: operators need a deploy/env-level halt that short-circuits before
 * body validation, local billing reads, pending-session claims, customer
 * creation, Checkout price resolution, or Stripe Checkout API calls.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function isBillingCheckoutDisabled(env = process.env) {
  return typeof env?.[BILLING_CHECKOUT_DISABLED_ENV_VAR] === 'string'
    && env[BILLING_CHECKOUT_DISABLED_ENV_VAR].trim().toLowerCase() === 'true';
}

/**
 * Normalize Stripe's Checkout Session expiry into the local timestamptz shape.
 *
 * Purpose: pending-session reuse must be bounded by Stripe's actual expiry, so
 * the route persists a validated ISO timestamp alongside the local checkout URL.
 *
 * @param {unknown} expiresAt
 * @returns {string}
 */
function normalizeCheckoutSessionExpiresAt(expiresAt) {
  if (expiresAt === null || expiresAt === undefined) {
    throw new Error('Stripe checkout session did not include a valid expiry');
  }

  if (typeof expiresAt === 'string' && expiresAt.trim() === '') {
    throw new Error('Stripe checkout session did not include a valid expiry');
  }

  if (
    typeof expiresAt !== 'number'
    && typeof expiresAt !== 'string'
    && !(expiresAt instanceof Date)
  ) {
    throw new Error('Stripe checkout session did not include a valid expiry');
  }

  if (typeof expiresAt === 'number' && !Number.isFinite(expiresAt)) {
    throw new Error('Stripe checkout session did not include a valid expiry');
  }

  const expiresAtDate = typeof expiresAt === 'number'
    ? new Date(expiresAt * 1000)
    : new Date(expiresAt);

  if (!Number.isFinite(expiresAtDate.getTime())) {
    throw new Error('Stripe checkout session did not include a valid expiry');
  }

  return expiresAtDate.toISOString();
}

/**
 * Resolve the authenticated account email required for Stripe receipts.
 *
 * Purpose: Checkout-created Stripe Customers must be tied to the OAuth-backed
 * account email; Checkout-entered emails or webhook payload emails are not
 * local ownership signals.
 *
 * @param {{ email?: string | null } | null | undefined} user
 * @returns {string | null}
 */
function getAuthenticatedBillingEmail(user) {
  const parsedEmail = authenticatedBillingEmailSchema.safeParse(user?.email);
  return parsedEmail.success ? parsedEmail.data : null;
}

/**
 * Best-effort release for a pending checkout claim after route failure.
 *
 * Purpose: if Stripe creation or local finalize fails after this request owns a
 * creating row, later checkout attempts should not be blocked by that claim.
 *
 * @param {string | number | null | undefined} pendingSessionId
 * @param {string | null | undefined} userId
 * @param {object} log
 * @returns {Promise<void>}
 */
async function failPendingClaimQuietly(pendingSessionId, userId, log) {
  if (!pendingSessionId || !userId) {
    return;
  }

  try {
    await failPendingCheckoutSession({ userId, id: pendingSessionId }, log);
  } catch (error) {
    log.warn(
      { err: error, operation: 'checkoutRoutePendingClaimRelease' },
      'Failed to release pending checkout claim after checkout route failure'
    );
  }
}

/**
 * Load Checkout creation-only dependencies after halt and claim guards pass.
 *
 * Purpose: the emergency Checkout halt must be able to return before
 * Checkout-only price, app URL, or Stripe client modules are loaded. Keeping
 * these literal dynamic imports in one helper preserves a narrow boundary while
 * still letting the enabled creation path fail closed on bad config.
 *
 * @returns {Promise<{ buildAppUrl: Function, getPriceIdForPlan: Function, getStripeClient: Function }>}
 */
async function loadCheckoutCreationDependencies() {
  const [
    appUrlModule,
    checkoutConfigModule,
    stripeRuntimeModule,
  ] = await Promise.all([
    import('../../../server/lib/appUrl.js'),
    import('../../../server/lib/stripeCheckoutConfig.js'),
    import('../../../server/lib/stripeRuntime.js'),
  ]);

  return {
    buildAppUrl: appUrlModule.buildAppUrl,
    getPriceIdForPlan: checkoutConfigModule.getPriceIdForPlan,
    getStripeClient: stripeRuntimeModule.getStripeClient,
  };
}

async function handler(req, res) {
  if (isBillingCheckoutDisabled()) {
    return sendError(
      res,
      503,
      'BILLING_CHECKOUT_DISABLED',
      ERROR_MESSAGES.BILLING_CHECKOUT_DISABLED
    );
  }

  const validationResult = billingCheckoutSchema.safeParse(req.body);

  if (!validationResult.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
  }

  let claimedPendingSessionId = null;
  let claimedPendingSessionUserId = null;

  try {
    const { checkoutAttemptNonce, plan } = validationResult.data;
    const authenticatedBillingEmail = getAuthenticatedBillingEmail(req._rateLimitUser);

    if (!authenticatedBillingEmail) {
      return sendError(res, 409, 'CHECKOUT_SESSION_FAILED', ERROR_MESSAGES.CHECKOUT_SESSION_FAILED);
    }

    const billingStatus = await loadBillingStatusOrThrow(
      req._rateLimitUser.id,
      req._supabaseClient,
      req.log
    );

    if (!canStartCheckout(billingStatus)) {
      return sendError(res, 409, 'CHECKOUT_SESSION_FAILED', ERROR_MESSAGES.CHECKOUT_SESSION_FAILED);
    }

    const pendingCheckoutClaim = await claimPendingCheckoutSession(
      {
        userId: req._rateLimitUser.id,
        plan,
        checkoutAttemptNonce,
      },
      req.log
    );

    if (pendingCheckoutClaim.outcome === PENDING_CHECKOUT_SESSION_OUTCOMES.REUSED) {
      if (!pendingCheckoutClaim.session.checkoutUrl) {
        throw new Error('Pending checkout session did not include a URL');
      }

      return sendSuccess(
        res,
        200,
        { url: pendingCheckoutClaim.session.checkoutUrl },
        'Checkout session reused'
      );
    }

    if (pendingCheckoutClaim.outcome === PENDING_CHECKOUT_SESSION_OUTCOMES.CREATING) {
      const openPendingSession = await waitForPendingCheckoutSessionOpen(
        {
          userId: req._rateLimitUser.id,
          plan,
        },
        req.log
      );

      if (openPendingSession?.checkoutUrl) {
        return sendSuccess(
          res,
          200,
          { url: openPendingSession.checkoutUrl },
          'Checkout session reused'
        );
      }

      return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    }

    if (pendingCheckoutClaim.outcome !== PENDING_CHECKOUT_SESSION_OUTCOMES.CLAIMED) {
      throw new Error('Pending checkout session claim returned an unsupported outcome');
    }

    claimedPendingSessionId = pendingCheckoutClaim.session.id;
    claimedPendingSessionUserId = req._rateLimitUser.id;

    const {
      buildAppUrl,
      getPriceIdForPlan,
      getStripeClient,
    } = await loadCheckoutCreationDependencies();
    const priceId = getPriceIdForPlan(plan);
    const successUrl = buildAppUrl('/billing/success?session_id={CHECKOUT_SESSION_ID}');
    const cancelUrl = buildAppUrl('/billing/cancel');
    const stripeClient = getStripeClient();

    const { stripeCustomerId } = await getOrCreateStripeCustomer(
      req._rateLimitUser.id,
      authenticatedBillingEmail,
      req.log
    );
    const userHash = hashUserIdForIdempotency(req._rateLimitUser.id);
    const checkoutSession = await stripeClient.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      client_reference_id: req._rateLimitUser.id,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
    }, {
      idempotencyKey: `billing_checkout_${userHash.slice(0, 24)}_${plan}_${checkoutAttemptNonce}`,
    });

    if (!checkoutSession?.id || !checkoutSession?.url) {
      throw new Error('Stripe checkout session did not include an id and URL');
    }

    // If finalizing below fails, the Stripe Session may remain in Stripe, but
    // returning an unpersisted URL would bypass the local ownership/reuse guard.
    const finalizedPendingSession = await finalizePendingCheckoutSession(
      {
        userId: claimedPendingSessionUserId,
        id: claimedPendingSessionId,
        stripeCheckoutSessionId: checkoutSession.id,
        checkoutUrl: checkoutSession.url,
        expiresAt: normalizeCheckoutSessionExpiresAt(checkoutSession.expires_at),
      },
      req.log
    );

    claimedPendingSessionId = null;
    claimedPendingSessionUserId = null;

    return sendSuccess(
      res,
      200,
      { url: finalizedPendingSession.checkoutUrl },
      'Checkout session created'
    );
  } catch (error) {
    await failPendingClaimQuietly(claimedPendingSessionId, claimedPendingSessionUserId, req.log);

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
  skipRateLimitWhen: () => isBillingCheckoutDisabled(),
});
