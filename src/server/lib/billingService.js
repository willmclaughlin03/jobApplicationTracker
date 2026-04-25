import { logger as defaultLogger } from '../../shared/logger.js';
import {
  BILLING_PLAN_PRICE_ENV_VARS,
  ENTITLED_BILLING_STATUSES,
} from '../../shared/constants/billing.js';
import { TIERS } from '../../shared/constants/tiers.js';

function normalizePriceId(priceId) {
  return typeof priceId === 'string' ? priceId.trim() : '';
}

/**
 * Resolve the configured Stripe price-id allowlist for premium entitlements.
 *
 * Missing env vars are ignored here so entitlement checks fail closed to FREE
 * until Stripe runtime validation is added in the later billing chunks.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Set<string>}
 */
export function getEntitledPriceIdAllowlist(env = process.env) {
  return new Set(
    Object.values(BILLING_PLAN_PRICE_ENV_VARS)
      .map((envVarName) => normalizePriceId(env?.[envVarName]))
      .filter(Boolean)
  );
}

/**
 * Canonical local billing entitlement rule for premium features.
 *
 * Premium storage is an intentional product behavior, not a generic auth-tier
 * side effect. Authorization must come from trusted local billing state.
 *
 * @param {{ price_id?: string | null, status?: string | null } | null | undefined} subscription
 * @param {Set<string>} entitledPriceIds
 * @returns {boolean}
 */
export function hasCanonicalBillingEntitlement(
  subscription,
  entitledPriceIds = getEntitledPriceIdAllowlist()
) {
  const normalizedPriceId = normalizePriceId(subscription?.price_id);
  const subscriptionStatus =
    typeof subscription?.status === 'string' ? subscription.status : null;

  if (!normalizedPriceId || !ENTITLED_BILLING_STATUSES.includes(subscriptionStatus)) {
    return false;
  }

  return entitledPriceIds.has(normalizedPriceId);
}

/**
 * Resolve the canonical storage tier from local billing state for a user.
 *
 * This is intentionally server-side and database-backed. Auth metadata is not
 * authoritative for premium storage decisions.
 *
 * @param {string} userId
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {object} log
 * @returns {Promise<string>}
 */
export async function resolveStorageEntitlement(userId, supabaseClient, log = defaultLogger) {
  if (!userId || !supabaseClient?.from) {
    log.error(
      {
        operation: 'resolveStorageEntitlement',
        hasUserId: !!userId,
        hasSupabaseClient: !!supabaseClient,
      },
      'Billing entitlement resolver is missing required inputs'
    );
    return TIERS.FREE;
  }

  try {
    const { data, error } = await supabaseClient
      .from('billing_subscriptions')
      .select('price_id, status')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      log.error(
        { err: error, operation: 'resolveStorageEntitlement', userId },
        'Failed to load local billing subscription'
      );
      return TIERS.FREE;
    }

    return hasCanonicalBillingEntitlement(data) ? TIERS.PAID : TIERS.FREE;
  } catch (error) {
    log.error(
      { err: error, operation: 'resolveStorageEntitlement', userId },
      'Unexpected error resolving storage entitlement'
    );
    return TIERS.FREE;
  }
}
