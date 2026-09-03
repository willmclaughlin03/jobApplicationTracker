import { sendError, sendSuccess } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';
import { loadBillingStatusOrThrow } from '../../../server/lib/billingService.js';

/**
 * Apply no-store headers to authenticated billing-status responses.
 *
 * Purpose: billing state is user-scoped and can change immediately after
 * checkout or portal activity, so caches must not reuse one user's billing
 * snapshot for another request.
 *
 * @param {import('next').NextApiResponse} res
 * @returns {void}
 */
function setBillingStatusCacheHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Cookie');
}

/**
 * Return the canonical local billing snapshot for the authenticated caller.
 *
 * Purpose: the billing page consumes this route as its page-facing source of
 * truth, so local billing reads fail closed and only expose portal capability
 * when a real Stripe customer id exists.
 *
 * @param {import('next').NextApiRequest & { _rateLimitUser: { id: string }, _supabaseClient: object, log: object }} req
 * @param {import('next').NextApiResponse} res
 * @returns {Promise<void>}
 */
async function handler(req, res) {
  setBillingStatusCacheHeaders(res);

  try {
    const billingStatus = await loadBillingStatusOrThrow(
      req._rateLimitUser.id,
      req._supabaseClient,
      req.log
    );

    return sendSuccess(res, 200, {
      entitled: billingStatus.entitled,
      entitlement: billingStatus.entitlement,
      status: billingStatus.status,
      currentPeriodEnd: billingStatus.currentPeriodEnd,
      cancelAtPeriodEnd: billingStatus.cancelAtPeriodEnd,
      hasCustomerMapping: billingStatus.hasCustomerMapping,
      hasPortalCustomer: Boolean(billingStatus.stripeCustomerId),
      hasSubscription: billingStatus.hasSubscription,
    }, 'Billing status retrieved successfully');
  } catch (error) {
    req.log.error({ err: error }, 'Failed to read local billing status');
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }
}

export default withRateLimit(handler, {
  requireAuth: true,
  operation: OPERATIONS.BILLING_READ,
  allowedMethods: ['GET'],
});
