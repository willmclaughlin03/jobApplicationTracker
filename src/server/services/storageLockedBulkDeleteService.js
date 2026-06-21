/**
 * Storage Locked Bulk Delete Service - confirmed archive deletion.
 *
 * Purpose: Delete locked overflow jobs only after terminal-Free storage status
 * is positively confirmed, while returning count-only results to route callers.
 * Connects to:
 * - billingService.resolveStorageStatusPrivileged() for strict billing state
 * - delete_locked_jobs_for_terminal_free_user RPC for bounded database deletes
 * - shared storage constants for row caps and public error codes
 */
import {
  STORAGE_CREATE_ERROR_CODES,
  STORAGE_STATUSES,
} from '../../shared/constants/billing.js';
import {
  JOB_STORAGE_ERRORS,
  LOCKED_BULK_DELETE_ROW_LIMIT,
} from '../../shared/constants/storage.js';
import { logger as defaultLogger } from '../../shared/logger.js';
import { supabaseAdmin } from '../lib/supabaseServer.js';
import {
  isStorageStatusRetryable,
  resolveStorageStatusPrivileged,
} from '../lib/billingService.js';

const LOCKED_BULK_DELETE_RPC = 'delete_locked_jobs_for_terminal_free_user';
const MAX_LOCKED_BULK_DELETE_RPC_ATTEMPTS = 10;
const STORAGE_BULK_DELETE_RETRYABLE_STATUS_CODES = new Map([
  [
    STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
    STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING,
  ],
  [
    STORAGE_STATUSES.BILLING_UNAVAILABLE,
    STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
  ],
]);

export class LockedBulkDeleteNotAllowedError extends Error {
  /**
   * Builds the public error for non-terminal-Free bulk delete attempts.
   *
   * @param {{ reason?: string|null, storageStatus?: string|null, canonicalStorageStatus?: string|null }} params
   */
  constructor({ reason = null, storageStatus = null, canonicalStorageStatus = null } = {}) {
    super('Locked archive deletion is not allowed for the current storage status');
    this.name = 'LockedBulkDeleteNotAllowedError';
    this.code = JOB_STORAGE_ERRORS.LOCKED_BULK_DELETE_NOT_ALLOWED;
    this.statusCode = 409;
    this.reason = reason;
    this.storageStatus = storageStatus;
    this.canonicalStorageStatus = canonicalStorageStatus;
  }
}

export class LockedBulkDeleteUnavailableError extends Error {
  /**
   * Builds a retryable bulk-delete error for ambiguous billing state.
   *
   * @param {{ code?: string, storageStatus?: string|null, reason?: string|null }} params
   */
  constructor({ code = STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE, storageStatus = null, reason = null } = {}) {
    super('Locked archive deletion requires a confirmed billing status');
    this.name = 'LockedBulkDeleteUnavailableError';
    this.code = code;
    this.statusCode = 503;
    this.retryable = true;
    this.storageStatus = storageStatus;
    this.reason = reason;
  }
}

/**
 * Reads the storage-status string from a typed result or raw value.
 *
 * Purpose: the service accepts the same typed storage result used by prior
 * chunks while allowing focused tests to pass a raw status string.
 *
 * @param {string|object|null|undefined} storageStatusResult - Status fixture or typed result.
 * @returns {string|null} Normalized storage status.
 */
function getStorageStatusValue(storageStatusResult) {
  if (typeof storageStatusResult === 'object' && storageStatusResult !== null) {
    return storageStatusResult.status ?? null;
  }

  return typeof storageStatusResult === 'string' ? storageStatusResult : null;
}

/**
 * Checks whether a raw RPC count is a usable non-negative integer.
 *
 * Purpose: required database count fields must not silently collapse to zero
 * when an unexpected RPC payload is missing or malformed.
 *
 * @param {unknown} value - Raw count value from the RPC payload.
 * @returns {boolean} True when the value can safely represent a count.
 */
function isValidRpcCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return false;
  }

  if (typeof value === 'string' && value.trim() === '') {
    return false;
  }

  const numericValue = Number(value);
  return Number.isSafeInteger(numericValue) && numericValue >= 0;
}

/**
 * Normalizes integer-like count fields from RPC payloads.
 *
 * Purpose: route responses should never expose NaN or malformed count values if
 * an unexpected database payload reaches the service boundary.
 *
 * @param {unknown} value - Raw count value.
 * @returns {number} Safe non-negative integer.
 */
function normalizeCount(value) {
  const numericValue = Number(value);
  return isValidRpcCount(value) && numericValue > 0 ? numericValue : 0;
}

/**
 * Parses JSON returned by the locked bulk-delete RPC.
 *
 * Purpose: Supabase can surface jsonb RPC returns as objects or strings across
 * environments, while callers need one validated object shape.
 *
 * @param {unknown} data - Raw Supabase RPC data.
 * @returns {object|null} Normalized object payload.
 */
function normalizeLockedBulkDeleteRpcData(data) {
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
 * Builds the correct route-mappable error for a storage status.
 *
 * Purpose: retryable billing states must return service-unavailable style
 * responses, while all non-terminal states remain non-mutating not-allowed
 * responses.
 *
 * @param {string|null} storageStatus - Normalized storage status.
 * @returns {Error} Route-mappable status error.
 */
function createStorageStatusError(storageStatus) {
  if (!storageStatus || isStorageStatusRetryable(storageStatus)) {
    return new LockedBulkDeleteUnavailableError({
      code: STORAGE_BULK_DELETE_RETRYABLE_STATUS_CODES.get(storageStatus)
        ?? STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
      storageStatus,
    });
  }

  return new LockedBulkDeleteNotAllowedError({
    reason: 'storage_status_not_delete_eligible',
    storageStatus,
  });
}

/**
 * Resolves storage status for a bulk-delete attempt.
 *
 * Purpose: tests can inject a status result, but production calls must use the
 * strict privileged billing read so fail-closed Free fallbacks cannot delete.
 *
 * @param {string} userId - Authenticated owner id.
 * @param {object} log - Request-scoped logger.
 * @param {{ storageStatusResult?: object|string|null, now?: Date }} options - Optional injected status/clock.
 * @returns {Promise<object|string|null>} Typed storage status result.
 */
async function resolveBulkDeleteStorageStatus(userId, log, options = {}) {
  if (options.storageStatusResult !== undefined) {
    return options.storageStatusResult;
  }

  return resolveStorageStatusPrivileged(
    userId,
    log,
    options.now instanceof Date ? { now: options.now } : {}
  );
}

/**
 * Calls the service-role locked bulk-delete RPC.
 *
 * Purpose: keep the row cap and status echo in one place so route handlers do
 * not directly compose mutating database calls.
 *
 * @param {{ userId: string, storageStatus: string }} params - RPC parameters.
 * @returns {Promise<object>} Normalized RPC payload.
 */
async function callLockedBulkDeleteRpc({ userId, storageStatus }) {
  const { data, error } = await supabaseAdmin.rpc(LOCKED_BULK_DELETE_RPC, {
    p_user_id: userId,
    p_storage_status: storageStatus,
    p_locked_delete_limit: LOCKED_BULK_DELETE_ROW_LIMIT,
  });

  if (error) {
    throw error;
  }

  const normalizedData = normalizeLockedBulkDeleteRpcData(data);

  if (!normalizedData || typeof normalizedData.applied !== 'boolean') {
    throw new LockedBulkDeleteUnavailableError({ reason: 'invalid_rpc_payload' });
  }

  if (normalizedData.applied) {
    for (const fieldName of ['deletedCount', 'lockedCountAfterDelete']) {
      if (!isValidRpcCount(normalizedData[fieldName])) {
        throw new LockedBulkDeleteUnavailableError({ reason: `invalid_${fieldName}` });
      }
    }
  }

  return normalizedData;
}

/**
 * Deletes all currently locked overflow jobs for a confirmed terminal-Free user.
 *
 * Purpose: expose Chunk 10's explicit user-initiated deletion path while
 * preserving locked-row privacy and preventing Premium, ambiguous billing, or
 * non-terminal states from running a destructive action.
 *
 * @param {string} userId - Authenticated owner id from middleware context.
 * @param {object} log - Request-scoped logger.
 * @param {{ storageStatusResult?: object|string|null, now?: Date }} options - Optional test/status controls.
 * @returns {Promise<{data: object|null, error: Error|object|null}>} Count-only result.
 */
export async function deleteLockedJobsForTerminalFreeUser(
  userId,
  log = defaultLogger,
  options = {}
) {
  let storageStatusResult;

  try {
    storageStatusResult = await resolveBulkDeleteStorageStatus(userId, log, options);
  } catch (error) {
    log.error(
      { err: error, operation: 'deleteLockedJobsForTerminalFreeUser.resolveStatus', userId },
      'Failed to resolve storage status before locked bulk delete'
    );
    return { data: null, error: new LockedBulkDeleteUnavailableError() };
  }

  const storageStatus = getStorageStatusValue(storageStatusResult);

  if (storageStatus !== STORAGE_STATUSES.TERMINAL_FREE) {
    return { data: null, error: createStorageStatusError(storageStatus) };
  }

  try {
    let totalDeletedCount = 0;
    let lockedCountBeforeDelete = null;
    let lockedCountAfterDelete = null;
    let lockedDeleteLimit = LOCKED_BULK_DELETE_ROW_LIMIT;

    for (let attempt = 0; attempt < MAX_LOCKED_BULK_DELETE_RPC_ATTEMPTS; attempt += 1) {
      const deleteResult = await callLockedBulkDeleteRpc({ userId, storageStatus });

      if (!deleteResult.applied) {
        return {
          data: null,
          error: new LockedBulkDeleteNotAllowedError({
            reason: deleteResult.reason ?? 'locked_bulk_delete_not_applied',
            storageStatus: deleteResult.storageStatus ?? storageStatus,
            canonicalStorageStatus: deleteResult.canonicalStorageStatus ?? null,
          }),
        };
      }

      const deletedCount = normalizeCount(deleteResult.deletedCount);
      totalDeletedCount += deletedCount;
      if (lockedCountBeforeDelete === null) {
        lockedCountBeforeDelete = normalizeCount(deleteResult.lockedCountBeforeDelete);
      }
      lockedCountAfterDelete = normalizeCount(deleteResult.lockedCountAfterDelete);
      lockedDeleteLimit = normalizeCount(deleteResult.lockedDeleteLimit) || lockedDeleteLimit;

      if (lockedCountAfterDelete === 0) {
        log.info(
          {
            operation: 'deleteLockedJobsForTerminalFreeUser',
            userId,
            deletedCount: totalDeletedCount,
            rpcAttempts: attempt + 1,
          },
          'Locked archive bulk delete completed'
        );

        return {
          data: {
            outcome: totalDeletedCount > 0 ? 'deleted' : 'already_empty',
            deletedCount: totalDeletedCount,
            lockedCountBeforeDelete: lockedCountBeforeDelete ?? 0,
            lockedCountAfterDelete,
            lockedDeleteLimit,
          },
          error: null,
        };
      }

      if (deletedCount === 0) {
        break;
      }
    }

    const incompleteDeleteError = new Error(
      'Locked bulk delete did not finish within bounded attempts'
    );
    incompleteDeleteError.code = 'LOCKED_BULK_DELETE_INCOMPLETE';
    incompleteDeleteError.deletedCount = totalDeletedCount;
    incompleteDeleteError.lockedCountAfterDelete = lockedCountAfterDelete;
    throw incompleteDeleteError;
  } catch (error) {
    log.error(
      { err: error, operation: 'deleteLockedJobsForTerminalFreeUser', userId, storageStatus },
      'Failed to bulk delete locked archive rows'
    );
    return { data: null, error };
  }
}
