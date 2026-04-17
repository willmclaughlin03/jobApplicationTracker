/**
 * Shared billing vocabulary used across billing services, routes, and tests.
 *
 * Purpose: Keep plan identifiers, entitlements, and Stripe subscription
 * statuses consistent before any schema or route work begins.
 */
export const BILLING_PLANS = {
  RESUME_TAILOR_MONTHLY: 'resume_tailor_monthly',
};

export const BILLING_ENTITLEMENTS = {
  AI_TAILOR: 'ai_tailor',
};

export const BILLING_SUBSCRIPTION_STATUSES = {
  ACTIVE: 'active',
  TRIALING: 'trialing',
  PAST_DUE: 'past_due',
  UNPAID: 'unpaid',
  CANCELED: 'canceled',
  PAUSED: 'paused',
  INCOMPLETE: 'incomplete',
  INCOMPLETE_EXPIRED: 'incomplete_expired',
};

export const ENTITLED_BILLING_STATUSES = [
  BILLING_SUBSCRIPTION_STATUSES.ACTIVE,
  BILLING_SUBSCRIPTION_STATUSES.TRIALING,
];

export const PAYMENT_RECOVERY_BILLING_STATUSES = [
  BILLING_SUBSCRIPTION_STATUSES.PAST_DUE,
  BILLING_SUBSCRIPTION_STATUSES.UNPAID,
];
