/**
 * Shared billing vocabulary used across billing services, routes, and tests.
 *
 * Purpose: Keep plan identifiers, entitlements, and Stripe subscription
 * statuses consistent before any schema or route work begins.
 */
export const BILLING_PLANS = {
  RESUME_TAILOR_MONTHLY: 'resume_tailor_monthly',
};

/**
 * Stripe price ids stay server-configured. The env var mapping is shared so
 * entitlement checks and Stripe runtime setup reference the same allowlist.
 */
export const BILLING_PLAN_PRICE_ENV_VARS = {
  [BILLING_PLANS.RESUME_TAILOR_MONTHLY]: 'STRIPE_PRICE_RESUME_TAILOR_MONTHLY',
};

export const BILLING_ENTITLEMENTS = {
  AI_TAILOR: 'ai_tailor',
};

export const BILLING_SUBSCRIPTION_STATUSES = {
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  UNPAID: 'unpaid',
  CANCELED: 'canceled',
  PAUSED: 'paused',
  INCOMPLETE: 'incomplete',
  INCOMPLETE_EXPIRED: 'incomplete_expired',
};

export const ENTITLED_BILLING_STATUSES = [
  BILLING_SUBSCRIPTION_STATUSES.ACTIVE,
];

export const PAYMENT_RECOVERY_BILLING_STATUSES = [
  BILLING_SUBSCRIPTION_STATUSES.PAST_DUE,
  BILLING_SUBSCRIPTION_STATUSES.UNPAID,
];
