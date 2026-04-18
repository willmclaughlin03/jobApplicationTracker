import { ENTITLED_BILLING_STATUSES } from '../../shared/constants/billing.js';
import { OPERATIONS, TIERS } from '../../shared/constants/tiers.js';

const BILLING_OPERATIONS = new Set([OPERATIONS.BILLING_READ, OPERATIONS.BILLING_WRITE]);

function getFirstDefinedValue(values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return null;
}

/**
 * Billing entitlements may come from multiple auth payload shapes.
 * Fail closed unless one of the explicit paid signals is present.
 *
 * @param {object | null | undefined} user
 * @returns {boolean}
 */
export function hasBillingEntitlement(user) {
  const subscribedFlag = getFirstDefinedValue([
    user?.subscribed,
    user?.billing?.subscribed,
    user?.app_metadata?.billing?.subscribed,
  ]);

  if (typeof subscribedFlag === 'boolean') {
    return subscribedFlag;
  }

  const subscriptionStatus = getFirstDefinedValue([
    user?.subscription_status,
    user?.subscriptionStatus,
    user?.billing?.subscription_status,
    user?.billing?.subscriptionStatus,
    user?.app_metadata?.billing?.subscription_status,
    user?.app_metadata?.billing?.subscriptionStatus,
  ]);

  return typeof subscriptionStatus === 'string'
    && ENTITLED_BILLING_STATUSES.includes(subscriptionStatus);
}

/**
 * Resolve the effective rate-limit tier for a specific operation.
 *
 * @param {object | null | undefined} user
 * @param {string} operation
 * @returns {string}
 */
export function resolveRateLimitTier(user, operation) {
  const isAdminOperation = operation === OPERATIONS.ADMIN_READ || operation === OPERATIONS.ADMIN_WRITE;
  const isAdminUser = user?.app_metadata?.role === 'admin';

  if (isAdminUser && isAdminOperation) {
    return TIERS.ADMIN;
  }

  if (BILLING_OPERATIONS.has(operation) && hasBillingEntitlement(user)) {
    return TIERS.PAID;
  }

  return TIERS.FREE;
}

/**
 * Resolve the storage tier for job-cap enforcement.
 *
 * @param {object | null | undefined} user
 * @returns {string}
 */
export function resolveStorageTier(user) {
  return hasBillingEntitlement(user) ? TIERS.PAID : TIERS.FREE;
}
