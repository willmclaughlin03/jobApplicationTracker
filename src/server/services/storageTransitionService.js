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

  return {
    data: {
      ...downgradeResult.data,
      restoreResult: restoreResult.data,
    },
    error: null,
  };
}
