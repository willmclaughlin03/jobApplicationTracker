/**
 * Shared billing vocabulary used across billing services, routes, and tests.
 *
 * Purpose: Keep plan identifiers, entitlements, and Stripe subscription
 * statuses consistent before any schema or route work begins.
 */
export const BILLING_PLANS = {
  PREMIUM_MONTHLY: 'premium_monthly',
};

/**
 * Stripe price ids stay server-configured. The env var mapping is shared so
 * entitlement checks and Stripe runtime setup reference the same allowlist.
 */
export const BILLING_PLAN_PRICE_ENV_VARS = {
  [BILLING_PLANS.PREMIUM_MONTHLY]: 'STRIPE_PRICE_PREMIUM_MONTHLY',
};

export const BILLING_ENTITLEMENTS = {
  PREMIUM: 'premium',
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

export const STORAGE_STATUSES = {
  PREMIUM_ACTIVE: 'premium_active',
  PREMIUM_CANCELING: 'premium_canceling',
  BILLING_RECONCILIATION_PENDING: 'billing_reconciliation_pending',
  TERMINAL_FREE: 'terminal_free',
  PAYMENT_RECOVERY: 'payment_recovery',
  SYNC_PENDING: 'sync_pending',
  NON_ENTITLED_NON_TERMINAL: 'non_entitled_non_terminal',
  BILLING_UNAVAILABLE: 'billing_unavailable',
};

export const STORAGE_CREATE_ACTIONS = {
  APPLY_PREMIUM_LIMIT: 'apply_premium_limit',
  APPLY_FREE_LIMIT: 'apply_free_limit',
  BLOCK_RETRYABLE: 'block_retryable',
  BLOCK_PAYMENT_RECOVERY: 'block_payment_recovery',
  BLOCK_SYNC_PENDING: 'block_sync_pending',
  BLOCK_BILLING_STATE_REVIEW: 'block_billing_state_review',
};

export const STORAGE_CREATE_ERROR_CODES = {
  BILLING_STATUS_UNAVAILABLE: 'BILLING_STATUS_UNAVAILABLE',
  BILLING_RECONCILIATION_PENDING: 'BILLING_RECONCILIATION_PENDING',
  PAYMENT_METHOD_UPDATE_REQUIRED: 'PAYMENT_METHOD_UPDATE_REQUIRED',
  BILLING_SYNC_PENDING: 'BILLING_SYNC_PENDING',
  BILLING_STATE_REVIEW_REQUIRED: 'BILLING_STATE_REVIEW_REQUIRED',
  STORAGE_LIMIT_EXCEEDED: 'STORAGE_LIMIT_EXCEEDED',
};
