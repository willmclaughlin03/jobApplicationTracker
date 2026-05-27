import { BILLING_SUBSCRIPTION_STATUSES } from '../../shared/constants/billing.js';

export const BILLING_PAGE_LOAD_STATES = Object.freeze({
  LOADING: 'loading',
  READY: 'ready',
  ERROR: 'error',
});

/**
 * Build the billing-page summary copy from the current local billing snapshot
 * and page load state.
 *
 * Purpose: keep loading, error, and ready-state copy centralized so the page
 * does not accidentally treat a failed billing read as if local state were
 * still loading or safe to act on.
 *
 * @param {{ billingStatus?: object | null, loadState?: 'loading' | 'ready' | 'error' }} input
 * @returns {{ title: string, description: string }}
 */
export function getBillingStatusSummary(input = {}) {
  const loadState = input?.loadState ?? BILLING_PAGE_LOAD_STATES.LOADING;
  const billingStatus = input?.billingStatus ?? null;
  const hasPortalCustomer = Boolean(billingStatus?.hasPortalCustomer);

  if (loadState === BILLING_PAGE_LOAD_STATES.ERROR || (loadState === BILLING_PAGE_LOAD_STATES.READY && !billingStatus)) {
    return {
      title: 'Billing status unavailable',
      description: 'We could not verify your local billing state right now. Refresh this page before starting checkout or opening the billing portal.',
    };
  }

  if (loadState !== BILLING_PAGE_LOAD_STATES.READY) {
    return {
      title: 'Loading billing status',
      description: 'Checking your local billing state.',
    };
  }

  if (billingStatus?.entitled) {
    return {
      title: 'Premium access is active',
      description: billingStatus.cancelAtPeriodEnd
        ? 'Your premium access stays active until the end of the current billing period.'
        : 'Your premium features are active from the canonical local billing record.',
    };
  }

  if (!billingStatus?.hasSubscription) {
    return {
      title: 'No active subscription',
      description: 'Start checkout to enable premium access for resume tailoring.',
    };
  }

  switch (billingStatus.status) {
    case BILLING_SUBSCRIPTION_STATUSES.CANCELED:
      return {
        title: 'Subscription canceled',
        description: 'You can start a new checkout session whenever you are ready.',
      };
    case BILLING_SUBSCRIPTION_STATUSES.INCOMPLETE_EXPIRED:
      return {
        title: 'Previous checkout expired',
        description: 'The last checkout attempt did not complete in time. You can try again.',
      };
    case BILLING_SUBSCRIPTION_STATUSES.PAST_DUE:
    case BILLING_SUBSCRIPTION_STATUSES.UNPAID:
    case BILLING_SUBSCRIPTION_STATUSES.PAUSED:
    case BILLING_SUBSCRIPTION_STATUSES.INCOMPLETE:
      return {
        title: 'Billing needs attention',
        description: hasPortalCustomer
          ? 'Open the billing portal to update payment details or review the subscription state.'
          : 'Refresh this page to re-check your local billing state before taking billing action.',
      };
    default:
      return {
        title: 'Billing status needs review',
        description: hasPortalCustomer
          ? 'Refresh this page or open the billing portal to review the subscription state.'
          : 'Refresh this page to re-check your local billing state before taking billing action.',
      };
  }
}

/**
 * Decide whether the billing page should render the checkout CTA from the
 * current local billing snapshot.
 *
 * Purpose: unknown or failed page states must fail closed so the UI does not
 * invite checkout when the canonical local status could not be confirmed.
 *
 * @param {{ billingStatus?: object | null, loadState?: 'loading' | 'ready' | 'error' }} input
 * @returns {boolean}
 */
export function canStartCheckoutFromLocalStatus(input = {}) {
  const loadState = input?.loadState ?? BILLING_PAGE_LOAD_STATES.LOADING;
  const billingStatus = input?.billingStatus ?? null;

  if (loadState !== BILLING_PAGE_LOAD_STATES.READY || !billingStatus) {
    return false;
  }

  if (!billingStatus.hasSubscription) {
    return true;
  }

  return [
    BILLING_SUBSCRIPTION_STATUSES.CANCELED,
    BILLING_SUBSCRIPTION_STATUSES.INCOMPLETE_EXPIRED,
  ].includes(billingStatus.status);
}

/**
 * Decide whether the billing page should render the portal CTA from the
 * current local billing snapshot.
 *
 * Purpose: portal entry must stay disabled until the page has a confirmed
 * portal-capable Stripe customer id to avoid presenting portal actions from
 * unknown/error state or placeholder customer rows.
 *
 * @param {{ billingStatus?: object | null, loadState?: 'loading' | 'ready' | 'error' }} input
 * @returns {boolean}
 */
export function canOpenPortalFromLocalStatus(input = {}) {
  const loadState = input?.loadState ?? BILLING_PAGE_LOAD_STATES.LOADING;
  return loadState === BILLING_PAGE_LOAD_STATES.READY && Boolean(input?.billingStatus?.hasPortalCustomer);
}
