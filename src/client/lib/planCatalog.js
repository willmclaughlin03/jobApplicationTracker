import { BILLING_PLANS } from '../../shared/constants/billing.js';
import { getStorageLimitForTier, TIERS } from '../../shared/constants/tiers.js';

const PREMIUM_DISPLAY_NAME = 'Premium';
const PREMIUM_FEATURES_TITLE = 'Premium Features';
const CHECKOUT_HELPER_TEXT = "You'll review pricing and payment details in Stripe Checkout before confirming.";
const STORAGE_LIMIT_FORMATTER = new Intl.NumberFormat('en-US');

/**
 * Read one required storage limit for customer-facing plan copy.
 *
 * Purpose: plan benefits must come from canonical tier configuration while
 * failing before render if a tier is absent or contains an unusable maxJobs
 * value. This prevents undefined or misleading capacity text from reaching the
 * upgrade card.
 *
 * @param {string} tier - Canonical tier whose storage limit is required.
 * @returns {number} Positive configured maximum active-job count.
 * @throws {Error} When the tier has no valid positive integer maxJobs value.
 */
function getRequiredStorageMaxJobs(tier) {
  const maxJobs = getStorageLimitForTier(tier)?.maxJobs;

  if (!Number.isSafeInteger(maxJobs) || maxJobs <= 0) {
    throw new Error(`Missing valid storage maxJobs configuration for the "${tier}" tier.`);
  }

  return maxJobs;
}

const paidStorageLimit = getRequiredStorageMaxJobs(TIERS.PAID);
const freeStorageLimit = getRequiredStorageMaxJobs(TIERS.FREE);
const premiumMonthlyPlan = Object.freeze({
  planId: BILLING_PLANS.PREMIUM_MONTHLY,
  displayName: PREMIUM_DISPLAY_NAME,
  title: PREMIUM_FEATURES_TITLE,
  checkoutHelperText: CHECKOUT_HELPER_TEXT,
  benefits: Object.freeze([
    `Up to ${STORAGE_LIMIT_FORMATTER.format(paidStorageLimit)} active applications, compared with ${STORAGE_LIMIT_FORMATTER.format(freeStorageLimit)} on Free.`,
  ]),
});

export const PLAN_CATALOG = Object.freeze({
  [BILLING_PLANS.PREMIUM_MONTHLY]: premiumMonthlyPlan,
});
