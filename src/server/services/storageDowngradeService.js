/**
 * Storage Downgrade Service - authoritative paid-to-free overflow locking.
 *
 * Purpose: Reconcile stale cancellation state when possible and lock active
 * jobs above the Free cap only after storage status is confirmed terminal Free.
 * Connects to:
 * - billingService strict storage-status helpers and Stripe reconciliation
 * - supabaseAdmin service-role RPCs for server-owned jobs policy transitions
 * - shared storage constants for lock metadata and active limits
 */
import { logger as defaultLogger } from '../../shared/logger.js';
import { STORAGE_STATUSES } from '../../shared/constants/billing.js';
import {
  FREE_ACTIVE_JOB_LIMIT,
  JOB_STORAGE_LOCK_POLICY_VERSION,
  JOB_STORAGE_LOCK_REASONS,
} from '../../shared/constants/storage.js';
import { supabaseAdmin } from '../lib/supabaseServer.js';
import {
  BILLING_SYNC_MODES,
  isAutomaticOverflowLockEligible,
  resolveStorageStatusPrivileged,
  syncSubscriptionFromStripe,
} from '../lib/billingService.js';

const OVERFLOW_LOCK_RPC = 'lock_overflow_jobs_for_terminal_free_user';

/**
 * Read the storage-status string from the typed status result.
 *
 * Purpose: service helpers accept the same storage-status result shape returned
 * by billingService while still handling defensive raw string inputs in tests.
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
 * Purpose: PostgREST can surface JSON numbers directly, but defensive parsing
 * keeps malformed payloads from becoming NaN in API logs or responses.
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeCount(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Parse JSON returned by the overflow lock RPC.
 *
 * Purpose: Supabase RPC calls may return JSON functions as objects or strings
 * depending on environment; callers need one validated object shape.
 *
 * @param {unknown} data
 * @returns {object|null}
 */
function normalizeOverflowLockRpcData(data) {
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
 * Build a non-mutating downgrade repair result.
 *
 * Purpose: skipped states must be explicit in tests and logs so billing
 * ambiguity is visibly different from a successful no-overflow lock pass.
 *
 * @param {{ storageStatus?: string|null, storageStatusResult?: object|string|null, reason: string, initialStorageStatus?: string|null, syncOutcome?: string|null }} params
 * @returns {{data: object, error: null}}
 */
function buildSkippedResult({
  storageStatus = null,
  storageStatusResult = null,
  reason,
  initialStorageStatus = storageStatus,
  syncOutcome = null,
}) {
  return {
    data: {
      outcome: 'skipped',
      reason,
      initialStorageStatus,
      storageStatus,
      storageStatusResult,
      syncOutcome,
      lockedCount: 0,
    },
    error: null,
  };
}

/**
 * Decide whether a typed storage-status result can invoke the lock RPC.
 *
 * Purpose: automatic overflow locking is intentionally narrower than ordinary
 * Free-tier behavior; fail-closed Free fallbacks and retryable states must not
 * reach the mutating database boundary.
 *
 * @param {string|object|null|undefined} storageStatusResult
 * @returns {boolean}
 */
function isStorageResultLockEligible(storageStatusResult) {
  if (
    typeof storageStatusResult === 'object'
    && storageStatusResult !== null
    && storageStatusResult.lockEligible === false
  ) {
    return false;
  }

  return isAutomaticOverflowLockEligible(storageStatusResult);
}

/**
 * Call the service-role overflow lock RPC.
 *
 * Purpose: keep the database boundary call in one place so limits, lock reason,
 * policy version, and storage status cannot drift between callers.
 *
 * @param {{ userId: string, storageStatus: string }} params
 * @returns {Promise<object>}
 */
async function callOverflowLockRpc({ userId, storageStatus }) {
  const { data, error } = await supabaseAdmin.rpc(OVERFLOW_LOCK_RPC, {
    p_user_id: userId,
    p_storage_status: storageStatus,
    p_active_job_limit: FREE_ACTIVE_JOB_LIMIT,
    p_locked_reason: JOB_STORAGE_LOCK_REASONS.PREMIUM_TO_FREE_OVER_PLAN_LIMIT,
    p_locked_policy_version: JOB_STORAGE_LOCK_POLICY_VERSION,
  });

  if (error) {
    throw error;
  }

  const normalizedData = normalizeOverflowLockRpcData(data);

  if (!normalizedData || typeof normalizedData.applied !== 'boolean') {
    throw new Error('Overflow lock RPC returned an unexpected payload');
  }

  return normalizedData;
}

/**
 * Lock active overflow rows for a confirmed terminal-Free user.
 *
 * Purpose: expose the idempotent lock operation behind the Chunk 1 eligibility
 * contract so only positively confirmed terminal-Free storage status can mutate
 * jobs into the locked archive.
 *
 * @param {string} userId
 * @param {object|string|null} storageStatusResult
 * @param {object} log
 * @returns {Promise<{data: object|null, error: Error|object|null}>}
 */
export async function lockOverflowJobsForTerminalFreeUser(
  userId,
  storageStatusResult,
  log = defaultLogger
) {
  const storageStatus = getStorageStatusValue(storageStatusResult);

  if (
    storageStatus !== STORAGE_STATUSES.TERMINAL_FREE
    || !isStorageResultLockEligible(storageStatusResult)
  ) {
    return buildSkippedResult({
      storageStatus,
      storageStatusResult,
      reason: 'storage_status_not_lock_eligible',
    });
  }

  try {
    const lockResult = await callOverflowLockRpc({ userId, storageStatus });

    if (!lockResult.applied) {
      return buildSkippedResult({
        storageStatus,
        storageStatusResult,
        reason: lockResult.reason ?? 'lock_rpc_not_applied',
      });
    }

    const lockedCount = normalizeCount(lockResult.lockedCount);

    return {
      data: {
        outcome: lockedCount > 0 ? 'locked' : 'already_within_limit',
        reason: null,
        initialStorageStatus: storageStatus,
        storageStatus,
        storageStatusResult,
        syncOutcome: null,
        lockedCount,
        activeCountBeforeLock: normalizeCount(lockResult.activeCountBeforeLock),
        activeCountAfterLock: normalizeCount(lockResult.activeCountAfterLock),
        activeLimit: normalizeCount(lockResult.activeLimit) || FREE_ACTIVE_JOB_LIMIT,
      },
      error: null,
    };
  } catch (error) {
    log.error(
      { err: error, operation: 'lockOverflowJobsForTerminalFreeUser', userId, storageStatus },
      'Failed to lock downgrade overflow jobs'
    );
    return { data: null, error };
  }
}

/**
 * Resolve the Stripe subscription id needed for stale cancellation repair.
 *
 * Purpose: authoritative Stripe reconciliation can only run when the trusted
 * local billing snapshot names a subscription; missing ids must remain
 * non-mutating instead of guessing from client or webhook input.
 *
 * @param {object|null|undefined} storageStatusResult
 * @returns {string|null}
 */
function getStripeSubscriptionIdForReconcile(storageStatusResult) {
  const subscriptionId = storageStatusResult?.billingStatus?.stripeSubscriptionId;
  return typeof subscriptionId === 'string' && subscriptionId.trim()
    ? subscriptionId.trim()
    : null;
}

/**
 * Read the trusted local subscription version used for guarded reconciliation.
 *
 * Purpose: downgrade repair must prove that the local subscription row did not
 * change while Stripe was being fetched, otherwise an old cancellation
 * snapshot could overwrite a newer subscription or re-entitlement.
 *
 * @param {object|null|undefined} storageStatusResult
 * @returns {{subscriptionId: string, updatedAt: string}|null}
 */
function getExpectedSubscriptionSnapshot(storageStatusResult) {
  const subscriptionId = getStripeSubscriptionIdForReconcile(storageStatusResult);
  const subscription = storageStatusResult?.billingStatus?.subscription;
  const updatedAt = typeof subscription?.updated_at === 'string'
    ? subscription.updated_at.trim()
    : '';

  if (!subscriptionId || !updatedAt) {
    return null;
  }

  return { subscriptionId, updatedAt };
}

/**
 * Attempt authoritative reconciliation for stale cancel-at-period-end state.
 *
 * Purpose: `billing_reconciliation_pending` cannot lock rows by itself; this
 * helper asks Stripe for the canonical subscription before any terminal-Free
 * lock decision is reconsidered.
 *
 * @param {string} userId
 * @param {object} storageStatusResult
 * @param {object} log
 * @returns {Promise<{reconciled: boolean, syncOutcome: string|null, reason: string|null}>}
 */
async function reconcilePendingBillingStatus(userId, storageStatusResult, log) {
  const expectedSnapshot = getExpectedSubscriptionSnapshot(storageStatusResult);

  if (!expectedSnapshot) {
    return {
      reconciled: false,
      syncOutcome: null,
      reason: 'reconciliation_snapshot_missing',
    };
  }

  try {
    const syncResult = await syncSubscriptionFromStripe(
      expectedSnapshot.subscriptionId,
      {
        mode: BILLING_SYNC_MODES.AUTHORITATIVE,
        expectedUserId: userId,
        expectedSubscriptionId: expectedSnapshot.subscriptionId,
        expectedSubscriptionUpdatedAt: expectedSnapshot.updatedAt,
      },
      log
    );

    return {
      reconciled: true,
      syncOutcome: syncResult?.outcome ?? null,
      reason: null,
    };
  } catch (error) {
    log.warn(
      { err: error, operation: 'reconcilePendingBillingStatus', userId },
      'Failed to reconcile stale downgrade billing state before storage repair'
    );
    return {
      reconciled: false,
      syncOutcome: null,
      reason: 'authoritative_reconcile_failed',
    };
  }
}

/**
 * Resolve storage status through the privileged strict billing reader.
 *
 * Purpose: background and lazy repair callers must never use fail-closed Free
 * entitlement helpers when deciding whether to mutate locked storage state.
 *
 * @param {string} userId
 * @param {object} log
 * @param {{ now?: Date }} options
 * @returns {Promise<object>}
 */
async function resolveRepairStorageStatus(userId, log, options = {}) {
  return resolveStorageStatusPrivileged(
    userId,
    log,
    options.now instanceof Date ? { now: options.now } : {}
  );
}

/**
 * Reconcile stale downgrade billing state and lock overflow when eligible.
 *
 * Purpose: provide one safe entry point for webhooks and lazy request-time
 * repair. It only locks after the current privileged storage status is terminal
 * Free, and it treats reconciliation failures as non-mutating pending states.
 *
 * @param {string} userId
 * @param {object} log
 * @param {{ storageStatusResult?: object|string|null, now?: Date }} options
 * @returns {Promise<{data: object|null, error: Error|object|null}>}
 */
export async function reconcileAndLockDowngradedStorageForUser(
  userId,
  log = defaultLogger,
  options = {}
) {
  try {
    const initialStorageStatusResult = options.storageStatusResult
      ?? await resolveRepairStorageStatus(userId, log, options);
    const initialStorageStatus = getStorageStatusValue(initialStorageStatusResult);
    let currentStorageStatusResult = initialStorageStatusResult;
    let syncOutcome = null;

    if (initialStorageStatus === STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING) {
      const reconcileResult = await reconcilePendingBillingStatus(
        userId,
        initialStorageStatusResult,
        log
      );
      syncOutcome = reconcileResult.syncOutcome;

      if (!reconcileResult.reconciled) {
        return buildSkippedResult({
          initialStorageStatus,
          storageStatus: initialStorageStatus,
          storageStatusResult: initialStorageStatusResult,
          syncOutcome,
          reason: reconcileResult.reason,
        });
      }

      currentStorageStatusResult = await resolveRepairStorageStatus(userId, log, options);
    }

    const lockResult = await lockOverflowJobsForTerminalFreeUser(
      userId,
      currentStorageStatusResult,
      log
    );

    if (lockResult.error) {
      return lockResult;
    }

    if (lockResult.data?.reason === 'canonical_billing_not_terminal_free') {
      currentStorageStatusResult = await resolveRepairStorageStatus(userId, log, options);
    }

    return {
      data: {
        ...lockResult.data,
        initialStorageStatus,
        storageStatus: getStorageStatusValue(currentStorageStatusResult),
        storageStatusResult: currentStorageStatusResult,
        syncOutcome,
      },
      error: null,
    };
  } catch (error) {
    log.error(
      { err: error, operation: 'reconcileAndLockDowngradedStorageForUser', userId },
      'Failed to repair downgraded storage state'
    );
    return { data: null, error };
  }
}
