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
import { supabaseAdmin } from '../lib/supabaseServer.js';
import { resolveStorageStatus } from '../lib/billingService.js';
import { logger as defaultLogger } from '../../shared/logger.js';
import { STORAGE_STATUSES } from '../../shared/constants/billing.js';
import {
  ABSOLUTE_RETAINED_JOB_LIMIT,
  FREE_ACTIVE_JOB_LIMIT,
  JOB_STORAGE_STATES,
} from '../../shared/constants/storage.js';

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
  const activeResult = await getActiveJobCount(userId, log);
  if (activeResult.error) return { data: null, error: activeResult.error };

  const lockedResult = await getLockedJobCount(userId, log);
  if (lockedResult.error) return { data: null, error: lockedResult.error };

  const retainedResult = await getRetainedTotalJobCount(userId, log);
  if (retainedResult.error) return { data: null, error: retainedResult.error };

  return {
    data: {
      activeCount: activeResult.count,
      lockedCount: lockedResult.count,
      retainedTotalCount: retainedResult.count,
    },
    error: null,
  };
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
 * @param {{ now?: Date }} [options] - Optional clock override for tests.
 * @returns {Promise<{data: object|null, error: Error|object|null}>}
 */
export async function getStorageSummaryForUser(
  userId,
  supabaseClient,
  log = defaultLogger,
  options = {}
) {
  try {
    const storageStatusResult = await resolveStorageStatus(userId, supabaseClient, log, options);
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
