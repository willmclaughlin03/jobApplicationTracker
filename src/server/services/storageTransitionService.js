/**
 * Storage Transition Service - repair downgrade locks and Premium restores.
 *
 * Purpose: Give routes and webhook handling one storage-policy transition entry
 * point after billing changes. Connects to:
 * - storageDowngradeService for terminal-Free overflow locking
 * - storageRestoreService for Premium re-entitlement restoration
 */
import { logger as defaultLogger } from '../../shared/logger.js';
import { reconcileAndLockDowngradedStorageForUser } from './storageDowngradeService.js';
import { restoreLockedJobsForPremiumUser } from './storageRestoreService.js';

/**
 * Decide whether a restore skip means the caller's Premium status is stale.
 *
 * Purpose: when the restore RPC rechecks canonical billing and rejects the
 * earlier Premium status, routes must not keep using that stale status for
 * locked-row visibility or full-list access decisions.
 *
 * @param {{data?: object|null}|null|undefined} restoreResult
 * @returns {boolean}
 */
function shouldRefreshAfterRestoreMismatch(restoreResult) {
  return restoreResult?.data?.reason === 'canonical_billing_not_premium';
}

/**
 * Remove caller-provided storage status before a refresh repair pass.
 *
 * Purpose: stale Premium status can be the thing being repaired, so the second
 * downgrade/status pass must resolve billing from the privileged source again
 * while preserving safe options such as the test clock.
 *
 * @param {{ storageStatusResult?: object|string|null, now?: Date }} options
 * @returns {{ now?: Date }}
 */
function buildFreshRepairOptions(options = {}) {
  return options.now instanceof Date ? { now: options.now } : {};
}

/**
 * Reconcile all storage transitions for one user.
 *
 * Purpose: existing request and webhook paths need downgrade repair before
 * access decisions, and Chunk 7 adds the matching Premium restore transition
 * without forcing each caller to understand both state machines.
 *
 * @param {string} userId
 * @param {object} log
 * @param {{ storageStatusResult?: object|string|null, now?: Date }} options
 * @returns {Promise<{data: object|null, error: Error|object|null}>}
 */
export async function reconcileStorageTransitionsForUser(
  userId,
  log = defaultLogger,
  options = {}
) {
  const downgradeResult = await reconcileAndLockDowngradedStorageForUser(
    userId,
    log,
    options
  );

  if (downgradeResult.error) {
    return downgradeResult;
  }

  const storageStatusResult = downgradeResult.data?.storageStatusResult ?? null;
  const restoreResult = await restoreLockedJobsForPremiumUser(
    userId,
    storageStatusResult,
    log
  );

  if (restoreResult.error) {
    return restoreResult;
  }

  if (shouldRefreshAfterRestoreMismatch(restoreResult)) {
    const refreshedDowngradeResult = await reconcileAndLockDowngradedStorageForUser(
      userId,
      log,
      buildFreshRepairOptions(options)
    );

    if (refreshedDowngradeResult.error) {
      return refreshedDowngradeResult;
    }

    return {
      data: {
        ...refreshedDowngradeResult.data,
        restoreResult: restoreResult.data,
      },
      error: null,
    };
  }

  return {
    data: {
      ...downgradeResult.data,
      restoreResult: restoreResult.data,
    },
    error: null,
  };
}
