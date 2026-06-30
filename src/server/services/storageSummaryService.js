/**
 * Storage Summary Service - count-only storage metadata for job limits.
 *
 * Purpose: Build the paid-to-free downgrade summary shape without exposing
 * locked job rows through ordinary metadata endpoints.
 * Connects to:
 * - supabaseAdmin for service-owned count-only jobs queries
 * - billingService.resolveStorageStatus() for typed storage status semantics
 * - shared storage constants for active and retained limits
 */
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabaseServer.js';
import { resolveStorageStatus } from '../lib/billingService.js';
import { logger as defaultLogger } from '../../shared/logger.js';
import { STORAGE_STATUSES } from '../../shared/constants/billing.js';
import {
  ABSOLUTE_RETAINED_JOB_LIMIT,
  FREE_ACTIVE_JOB_LIMIT,
  JOB_STORAGE_STATES,
} from '../../shared/constants/storage.js';

const STORAGE_COUNTS_RPC = 'get_job_storage_counts_for_user';
const STORAGE_COUNT_FIELD_NAMES = Object.freeze([
  'activeCount',
  'lockedCount',
  'retainedTotalCount',
]);
const storageCountsUserIdSchema = z.string().uuid({ error: 'Invalid user id format' });

/**
 * Error type for invalid owner ids at the storage-count service boundary.
 *
 * Purpose: keep direct service callers on the same typed validation contract as
 * API routes instead of leaking malformed ids into the admin RPC layer.
 */
export class InvalidJobStorageCountsUserIdError extends Error {
  /**
   * Builds the stable invalid-user-id error for storage-count callers.
   */
  constructor() {
    super('Authenticated user id is required for storage counts');
    this.name = 'InvalidJobStorageCountsUserIdError';
    this.code = 'JOB_STORAGE_COUNTS_INVALID_USER_ID';
    this.statusCode = 400;
  }
}

/**
 * Normalizes Supabase count values into a non-negative integer.
 *
 * Purpose: PostgREST count responses can be null when no rows are found or
 * when count metadata is unavailable; summaries should fail closed to zero
 * only after the query itself has succeeded.
 *
 * @param {number|null|undefined} count - Supabase count metadata.
 * @returns {number} Safe non-negative count.
 */
function normalizeStorageCount(count) {
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * Checks whether an RPC count field is a valid non-negative integer.
 *
 * Purpose: storage-count RPC payloads must fail closed when a required count
 * is missing, fractional, negative, or coerced into an unexpected type.
 *
 * @param {unknown} count - Raw count field from the RPC payload.
 * @returns {boolean} True when the count can be trusted.
 */
function isValidStorageCountsRpcCount(count) {
  return Number.isSafeInteger(count) && count >= 0;
}

/**
 * Parses JSON returned by the storage-count RPC.
 *
 * Purpose: Supabase RPC calls may return jsonb as an object or JSON string,
 * but callers need exactly the three count fields and no partial fallback.
 *
 * @param {unknown} data - Raw Supabase RPC response payload.
 * @returns {object|null} Validated storage counts, or null when malformed.
 */
function normalizeStorageCountsRpcData(data) {
  if (!data) {
    return null;
  }

  let payload = data;

  if (typeof data === 'string') {
    try {
      payload = JSON.parse(data);
    } catch {
      return null;
    }
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const payloadKeys = Object.keys(payload);
  if (
    payloadKeys.length !== STORAGE_COUNT_FIELD_NAMES.length
    || !STORAGE_COUNT_FIELD_NAMES.every((fieldName) => (
      Object.prototype.hasOwnProperty.call(payload, fieldName)
    ))
  ) {
    return null;
  }

  if (!STORAGE_COUNT_FIELD_NAMES.every((fieldName) => (
    isValidStorageCountsRpcCount(payload[fieldName])
  ))) {
    return null;
  }

  return {
    activeCount: payload.activeCount,
    lockedCount: payload.lockedCount,
    retainedTotalCount: payload.retainedTotalCount,
  };
}

/**
 * Builds the fail-closed error for invalid storage-count RPC payloads.
 *
 * Purpose: route handlers need a concrete error so malformed count metadata
 * returns service-unavailable behavior instead of silently becoming zeros.
 *
 * @returns {Error} Stable malformed-payload error.
 */
function createInvalidStorageCountsRpcPayloadError() {
  const error = new Error('Storage counts RPC returned an unexpected payload');
  error.code = 'INVALID_STORAGE_COUNTS_RPC_PAYLOAD';
  return error;
}

/**
 * Calls the service-role storage-count RPC and validates its count payload.
 *
 * Purpose: keep the database round trip and strict parsing in one boundary so
 * storage summaries never fall back to partial or row-returning count queries.
 *
 * @param {string} userId - Authenticated owner id.
 * @param {object} log - Request-scoped logger.
 * @returns {Promise<{data: object|null, error: Error|object|null}>}
 */
async function callJobStorageCountsRpc(userId, log = defaultLogger) {
  try {
    const { data, error } = await supabaseAdmin.rpc(STORAGE_COUNTS_RPC, {
      p_user_id: userId,
    });

    if (error) {
      log.error(
        { err: error, operation: 'getJobStorageCounts', userId },
        'Failed to load job storage counts'
      );
      return { data: null, error };
    }

    const counts = normalizeStorageCountsRpcData(data);

    if (!counts) {
      const payloadError = createInvalidStorageCountsRpcPayloadError();
      log.error(
        { err: payloadError, operation: 'getJobStorageCounts', userId },
        'Job storage counts RPC payload was invalid'
      );
      return { data: null, error: payloadError };
    }

    return { data: counts, error: null };
  } catch (error) {
    log.error(
      { err: error, operation: 'getJobStorageCounts', userId },
      'Unexpected error while loading job storage counts'
    );
    return { data: null, error };
  }
}

/**
 * Counts jobs for one authenticated owner using service-role access.
 *
 * Purpose: Centralize count-only jobs queries so active, locked, and retained
 * totals use the Chunk 2 server-controlled boundary and never return row data.
 *
 * @param {string} userId - Authenticated owner id.
 * @param {{ storageState?: string|null, operation: string }} options - Count filter and log operation name.
 * @param {object} log - Request-scoped logger.
 * @returns {Promise<{count: number, error: Error|object|null}>}
 */
async function countJobsForUser(userId, options, log = defaultLogger) {
  const { storageState = null, operation } = options;

  try {
    let query = supabaseAdmin
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (storageState) {
      query = query.eq('storage_state', storageState);
    }

    const { count, error } = await query;

    if (error) {
      log.error({ err: error, operation, userId, storageState }, 'Failed to count job storage rows');
      return { count: 0, error };
    }

    return { count: normalizeStorageCount(count), error: null };
  } catch (error) {
    log.error({ err: error, operation, userId, storageState }, 'Unexpected error while counting job storage rows');
    return { count: 0, error };
  }
}

/**
 * Counts active jobs for a user.
 *
 * Purpose: Active counts drive the Free active cap, projected overflow, and
 * later lock-selection decisions without reading full job records.
 *
 * @param {string} userId - Authenticated owner id.
 * @param {object} log - Request-scoped logger.
 * @returns {Promise<{count: number, error: Error|object|null}>}
 */
export async function getActiveJobCount(userId, log = defaultLogger) {
  return countJobsForUser(
    userId,
    {
      storageState: JOB_STORAGE_STATES.ACTIVE,
      operation: 'getActiveJobCount',
    },
    log
  );
}

/**
 * Counts locked overflow jobs for a user.
 *
 * Purpose: Locked counts let summary endpoints report archive size without
 * returning hidden locked job fields.
 *
 * @param {string} userId - Authenticated owner id.
 * @param {object} log - Request-scoped logger.
 * @returns {Promise<{count: number, error: Error|object|null}>}
 */
export async function getLockedJobCount(userId, log = defaultLogger) {
  return countJobsForUser(
    userId,
    {
      storageState: JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT,
      operation: 'getLockedJobCount',
    },
    log
  );
}

/**
 * Counts all retained jobs for a user, active plus locked.
 *
 * Purpose: Retained totals support the absolute preservation cap while keeping
 * the query count-only and owner-scoped.
 *
 * @param {string} userId - Authenticated owner id.
 * @param {object} log - Request-scoped logger.
 * @returns {Promise<{count: number, error: Error|object|null}>}
 */
export async function getRetainedTotalJobCount(userId, log = defaultLogger) {
  return countJobsForUser(
    userId,
    {
      storageState: null,
      operation: 'getRetainedTotalJobCount',
    },
    log
  );
}

/**
 * Computes the number of currently active rows that would overflow Free.
 *
 * Purpose: Warnings and summaries need a deterministic projection based on
 * active rows only; already locked rows are counted separately.
 *
 * @param {number} activeCount - Current active job count.
 * @param {number} activeLimit - Free active job limit.
 * @returns {number} Positive overflow count, or zero.
 */
export function getProjectedOverflowCount(activeCount, activeLimit = FREE_ACTIVE_JOB_LIMIT) {
  return Math.max(0, normalizeStorageCount(activeCount) - activeLimit);
}

/**
 * Collects all storage counts used by the summary payload.
 *
 * Purpose: Keep active, locked, and retained count failures explicit so routes
 * can return unavailable responses instead of partial or misleading metadata.
 *
 * @param {string} userId - Authenticated owner id.
 * @param {object} log - Request-scoped logger.
 * @returns {Promise<{data: object|null, error: Error|object|null}>}
 */
export async function getJobStorageCounts(userId, log = defaultLogger) {
  const parsedUserId = storageCountsUserIdSchema.safeParse(userId);

  if (!parsedUserId.success) {
    return {
      data: null,
      error: new InvalidJobStorageCountsUserIdError(),
    };
  }

  return callJobStorageCountsRpc(parsedUserId.data, log);
}

/**
 * Builds the API-facing storage summary from typed status and counts.
 *
 * Purpose: Preserve billing_unavailable and reconciliation-pending as their
 * own states while exposing only limits, counts, and cancellation timing.
 *
 * @param {object} storageStatusResult - Result from resolveStorageStatus().
 * @param {object} counts - Active, locked, and retained count fields.
 * @returns {object} Storage summary metadata safe for API responses.
 */
export function buildStorageSummary(storageStatusResult = {}, counts = {}) {
  const billingStatus = storageStatusResult?.billingStatus ?? null;
  const activeCount = normalizeStorageCount(counts.activeCount);

  return {
    status: storageStatusResult?.status ?? STORAGE_STATUSES.BILLING_UNAVAILABLE,
    activeLimit: FREE_ACTIVE_JOB_LIMIT,
    absoluteRetainedLimit: ABSOLUTE_RETAINED_JOB_LIMIT,
    activeCount,
    lockedCount: normalizeStorageCount(counts.lockedCount),
    retainedTotalCount: normalizeStorageCount(counts.retainedTotalCount),
    projectedOverflowCount: getProjectedOverflowCount(activeCount),
    cancelAtPeriodEnd: Boolean(billingStatus?.cancelAtPeriodEnd),
    currentPeriodEnd: billingStatus?.currentPeriodEnd ?? null,
  };
}

/**
 * Resolves the complete storage summary for a user.
 *
 * Purpose: Combine strict billing-aware storage status with count-only jobs
 * metadata so routes can expose summary state without returning locked rows.
 *
 * @param {string} userId - Authenticated owner id.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient - Request-scoped client for strict billing reads.
 * @param {object} log - Request-scoped logger.
 * @param {{ now?: Date, storageStatusResult?: object|string|null }} [options] - Optional clock override or already-resolved storage status.
 * @returns {Promise<{data: object|null, error: Error|object|null}>}
 */
export async function getStorageSummaryForUser(
  userId,
  supabaseClient,
  log = defaultLogger,
  options = {}
) {
  try {
    const providedStorageStatusResult = options.storageStatusResult;
    const storageStatusResult = typeof providedStorageStatusResult === 'string'
      ? { status: providedStorageStatusResult, billingStatus: null }
      : (
        providedStorageStatusResult
        ?? await resolveStorageStatus(userId, supabaseClient, log, options)
      );
    const countsResult = await getJobStorageCounts(userId, log);

    if (countsResult.error) {
      return { data: null, error: countsResult.error };
    }

    return {
      data: buildStorageSummary(storageStatusResult, countsResult.data),
      error: null,
    };
  } catch (error) {
    log.error({ err: error, operation: 'getStorageSummaryForUser', userId }, 'Failed to build storage summary');
    return { data: null, error };
  }
}
