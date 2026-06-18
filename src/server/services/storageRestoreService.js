/**
 * Storage Restore Service - Premium re-entitlement archive restoration.
 *
 * Purpose: Unlock preserved downgrade overflow rows only after canonical
 * Premium storage entitlement returns. Connects to:
 * - billingService typed storage-status vocabulary
 * - supabaseAdmin service-role RPCs for server-owned jobs policy transitions
 * - shared storage constants for the absolute retained cap
 */
import { STORAGE_STATUSES } from '../../shared/constants/billing.js';
import {
  ABSOLUTE_RETAINED_JOB_LIMIT,
} from '../../shared/constants/storage.js';
import { logger as defaultLogger } from '../../shared/logger.js';
import { getEntitledPriceIdAllowlist } from '../lib/billingService.js';
import { supabaseAdmin } from '../lib/supabaseServer.js';

const PREMIUM_RESTORE_RPC = 'restore_locked_jobs_for_premium_user';

/**
 * Read the storage-status string from the typed status result.
 *
 * Purpose: restore helpers consume the same storage-status object returned by
 * billingService while still tolerating raw string inputs in focused tests.
 *
 * @param {string|object|null|undefined} storageStatusResult
 * @returns {string|null}
 */
function getStorageStatusValue(storageStatusResult) {
  if (typeof storageStatusResult === 'object' && storageStatusResult !== null) {
    return storageStatusResult.status ?? null;
  }

  return typeof storageStatusResult === 'string' ? storageStatusResult : null;
}

/**
 * Normalize integer-like count fields from database RPC payloads.
 *
 * Purpose: restore responses feed logs and tests, so malformed count payloads
 * should collapse to zero instead of becoming NaN.
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeCount(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Resolve configured Premium price ids for the restore RPC.
 *
 * Purpose: the database restore boundary must enforce the same price allowlist
 * as canonical JS entitlement checks instead of trusting active status alone.
 *
 * @returns {string[]} Non-empty, trimmed Premium price ids.
 */
function getEntitledPriceIdsForRestore() {
  return [...getEntitledPriceIdAllowlist()]
    .map((priceId) => (typeof priceId === 'string' ? priceId.trim() : ''))
    .filter(Boolean);
}

/**
 * Build the fail-closed restore configuration error.
 *
 * Purpose: if a Premium caller reaches restore without a configured price
 * allowlist, storage state must remain untouched and API callers should retry
 * or surface service-unavailable behavior instead of restoring optimistically.
 *
 * @returns {Error}
 */
function createPremiumRestoreConfigError() {
  const error = new Error('Premium restore price allowlist is not configured');
  error.code = 'PREMIUM_RESTORE_PRICE_ALLOWLIST_MISSING';
  return error;
}

/**
 * Parse JSON returned by the Premium restore RPC.
 *
 * Purpose: Supabase RPC calls can surface JSON functions as objects or strings
 * depending on environment; callers need one validated object shape.
 *
 * @param {unknown} data
 * @returns {object|null}
 */
function normalizePremiumRestoreRpcData(data) {
  if (!data) {
    return null;
  }

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  return typeof data === 'object' && !Array.isArray(data) ? data : null;
}

/**
 * Determine whether a storage status may restore locked overflow rows.
 *
 * Purpose: restoration is intentionally limited to canonical Premium states;
 * billing ambiguity, terminal Free, dunning, sync-pending, and review states
 * must never clear lock metadata.
 *
 * @param {string|null} storageStatus
 * @returns {boolean}
 */
function isPremiumRestoreEligible(storageStatus) {
  return storageStatus === STORAGE_STATUSES.PREMIUM_ACTIVE
    || storageStatus === STORAGE_STATUSES.PREMIUM_CANCELING;
}

/**
 * Build a non-mutating restore result.
 *
 * Purpose: skipped states should be explicit so logs and tests distinguish
 * safe non-restores from successful zero-row restore passes.
 *
 * @param {{ storageStatus?: string|null, storageStatusResult?: object|string|null, reason: string, canonicalStorageStatus?: string|null, canonicalEntitlementReason?: string|null }} params
 * @returns {{data: object, error: null}}
 */
function buildSkippedResult({
  storageStatus = null,
  storageStatusResult = null,
  reason,
  canonicalStorageStatus = null,
  canonicalEntitlementReason = null,
}) {
  const data = {
    outcome: 'skipped',
    reason,
    storageStatus,
    storageStatusResult,
    restoredCount: 0,
  };

  if (canonicalStorageStatus) {
    data.canonicalStorageStatus = canonicalStorageStatus;
  }

  if (canonicalEntitlementReason) {
    data.canonicalEntitlementReason = canonicalEntitlementReason;
  }

  return {
    data,
    error: null,
  };
}

/**
 * Call the service-role Premium restore RPC.
 *
 * Purpose: keep the database boundary call in one place so the retained cap
 * and caller-observed storage status cannot drift between restore triggers.
 *
 * @param {{ userId: string, storageStatus: string, entitledPriceIds: string[] }} params
 * @returns {Promise<object>}
 */
async function callPremiumRestoreRpc({ userId, storageStatus, entitledPriceIds }) {
  const { data, error } = await supabaseAdmin.rpc(PREMIUM_RESTORE_RPC, {
    p_user_id: userId,
    p_storage_status: storageStatus,
    p_absolute_retained_job_limit: ABSOLUTE_RETAINED_JOB_LIMIT,
    p_entitled_price_ids: entitledPriceIds,
  });

  if (error) {
    throw error;
  }

  const normalizedData = normalizePremiumRestoreRpcData(data);

  if (!normalizedData || typeof normalizedData.applied !== 'boolean') {
    throw new Error('Premium restore RPC returned an unexpected payload');
  }

  return normalizedData;
}

/**
 * Log when a Premium restore leaves retained rows over the cap.
 *
 * Purpose: over-cap retained totals should not block safe restoration, but they
 * are rollout evidence that creates will remain blocked until rows are deleted.
 *
 * @param {object} restoreResult
 * @param {{ userId: string, storageStatus: string, log: object }} context
 * @returns {void}
 */
function logOverCapRestoreIfNeeded(restoreResult, { userId, storageStatus, log }) {
  if (!restoreResult.retainedOverLimit) {
    return;
  }

  log.warn(
    {
      event: 'premium_restore_retained_total_over_limit',
      operation: 'restoreLockedJobsForPremiumUser',
      userId,
      storageStatus,
      retainedTotalCount: normalizeCount(restoreResult.retainedTotalCount),
      absoluteRetainedLimit: normalizeCount(restoreResult.absoluteRetainedLimit)
        || ABSOLUTE_RETAINED_JOB_LIMIT,
      restoredCount: normalizeCount(restoreResult.restoredCount),
      lockedCountAfterRestore: normalizeCount(restoreResult.lockedCountAfterRestore),
    },
    'Premium restore left retained rows over the absolute storage cap'
  );
}

/**
 * Restore locked overflow rows for a confirmed Premium user.
 *
 * Purpose: expose the idempotent restore operation behind the Chunk 1 Premium
 * status contract so retryable billing states and non-entitled states cannot
 * clear locked archive metadata.
 *
 * @param {string} userId
 * @param {object|string|null} storageStatusResult
 * @param {object} log
 * @returns {Promise<{data: object|null, error: Error|object|null}>}
 */
export async function restoreLockedJobsForPremiumUser(
  userId,
  storageStatusResult,
  log = defaultLogger
) {
  const storageStatus = getStorageStatusValue(storageStatusResult);

  if (!isPremiumRestoreEligible(storageStatus)) {
    return buildSkippedResult({
      storageStatus,
      storageStatusResult,
      reason: 'storage_status_not_restore_eligible',
    });
  }

  try {
    const entitledPriceIds = getEntitledPriceIdsForRestore();

    if (entitledPriceIds.length <= 0) {
      throw createPremiumRestoreConfigError();
    }

    const restoreResult = await callPremiumRestoreRpc({
      userId,
      storageStatus,
      entitledPriceIds,
    });

    if (!restoreResult.applied) {
      return buildSkippedResult({
        storageStatus,
        storageStatusResult,
        reason: restoreResult.reason ?? 'restore_rpc_not_applied',
        canonicalStorageStatus: restoreResult.canonicalStorageStatus ?? null,
        canonicalEntitlementReason: restoreResult.canonicalEntitlementReason ?? null,
      });
    }

    logOverCapRestoreIfNeeded(restoreResult, { userId, storageStatus, log });

    const restoredCount = normalizeCount(restoreResult.restoredCount);

    return {
      data: {
        outcome: restoredCount > 0 ? 'restored' : 'already_restored',
        reason: null,
        storageStatus,
        storageStatusResult,
        restoredCount,
        activeCountBeforeRestore: normalizeCount(restoreResult.activeCountBeforeRestore),
        activeCountAfterRestore: normalizeCount(restoreResult.activeCountAfterRestore),
        lockedCountBeforeRestore: normalizeCount(restoreResult.lockedCountBeforeRestore),
        lockedCountAfterRestore: normalizeCount(restoreResult.lockedCountAfterRestore),
        retainedTotalCount: normalizeCount(restoreResult.retainedTotalCount),
        absoluteRetainedLimit: normalizeCount(restoreResult.absoluteRetainedLimit)
          || ABSOLUTE_RETAINED_JOB_LIMIT,
        retainedOverLimit: Boolean(restoreResult.retainedOverLimit),
      },
      error: null,
    };
  } catch (error) {
    log.error(
      { err: error, operation: 'restoreLockedJobsForPremiumUser', userId, storageStatus },
      'Failed to restore Premium storage archive'
    );
    return { data: null, error };
  }
}
