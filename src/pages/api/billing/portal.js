import { sendError, sendSuccess } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';
import { loadBillingStatusOrThrow } from '../../../server/lib/billingService.js';
import { buildAppUrl } from '../../../server/lib/appUrl.js';
import { getBillingPortalConfigurationId } from '../../../server/lib/stripePortalConfig.js';
import { getStripeClient } from '../../../server/lib/stripeRuntime.js';

async function handler(req, res) {
  try {
    const billingStatus = await loadBillingStatusOrThrow(
      req._rateLimitUser.id,
      req._supabaseClient,
      req.log
    );

    if (!billingStatus.stripeCustomerId) {
      return sendError(res, 409, 'PORTAL_SESSION_FAILED', ERROR_MESSAGES.PORTAL_SESSION_FAILED);
    }

    const portalSession = await getStripeClient().billingPortal.sessions.create({
      customer: billingStatus.stripeCustomerId,
      configuration: getBillingPortalConfigurationId(),
      return_url: buildAppUrl('/billing'),
    });

    if (!portalSession?.url) {
      throw new Error('Stripe billing portal session did not include a URL');
    }

    return sendSuccess(res, 200, { url: portalSession.url }, 'Billing portal session created');
  } catch (error) {
    if (error?.code === 'BILLING_STATUS_UNAVAILABLE') {
      req.log.error({ err: error }, 'Failed to open billing portal due to local billing read failure');
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
    }

    req.log.error({ err: error }, 'Failed to create Stripe billing portal session');
    return sendError(res, 503, 'PORTAL_SESSION_FAILED', ERROR_MESSAGES.PORTAL_SESSION_FAILED);
  }
}

export default withRateLimit(handler, {
  requireAuth: true,
  operation: OPERATIONS.BILLING_WRITE,
  allowedMethods: ['POST'],
});
