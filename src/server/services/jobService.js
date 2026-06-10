/**
 * Job Service - Database operations for jobs
 *
 * Purpose: Encapsulate all job-related database operations with error handling
 * Connects to:
 * - supabaseAdmin for server-owned job reads/writes after direct table access
 *   is narrowed at the database layer
 * - supabaseClient remains accepted for route compatibility and future
 *   request-scoped dependencies
 * - Per-request logger (req.log) for structured error logging with requestId correlation;
 *   falls back to module-level logger singleton if callers omit the log argument
 *
 * Security: All operations validate user ownership via user_id matching and
 * must keep server-derived owner filters because service-role access bypasses
 * direct authenticated table permissions.
 */
import { supabaseAdmin } from '../lib/supabaseServer.js';
import { logger as defaultLogger } from '../../shared/logger.js';
import { classifyStorageCreateFlow } from '../lib/billingService.js';
import {
  STORAGE_CREATE_ACTIONS,
  STORAGE_CREATE_ERROR_CODES,
} from '../../shared/constants/billing.js';
import {
  ABSOLUTE_RETAINED_JOB_LIMIT,
  FREE_ACTIVE_JOB_LIMIT,
} from '../../shared/constants/storage.js';

const SERVER_CONTROLLED_JOB_FIELDS = new Set([
  'id',
  'user_id',
  'storage_state',
  'locked_at',
  'locked_reason',
  'locked_policy_version',
]);

export class StorageLimitExceededError extends Error {
  constructor(maxJobs) {
    const message = `You have reached the maximum of ${maxJobs} job entries. Please delete some entries to add more.`;
    super(message);
    this.name = 'StorageLimitExceededError';
    this.code = 'STORAGE_LIMIT_EXCEEDED';
    this.statusCode = 409;
  }
}

/**
 * Error type for storage create decisions that are not quota-overage errors.
 *
 * Purpose: keep billing-unavailable, reconciliation, payment-recovery, and
 * sync-pending create failures on stable codes for route-level response mapping.
 */
export class StorageCreateBlockedError extends Error {
  /**
   * Builds a route-mappable storage create error.
   *
   * @param {{ code: string, message: string, statusCode?: number, retryable?: boolean }} params
   */
  constructor({ code, message, statusCode = 409, retryable = false }) {
    super(message);
    this.name = 'StorageCreateBlockedError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

/**
 * createStorageLimitExceededError constructs a user-facing Error for callers
 * when a user reaches the configured job storage limit.
 *
 * @param {number} maxJobs - Maximum number of job entries the user may store.
 * @returns {StorageLimitExceededError} Error for API-level handling.
 */
function createStorageLimitExceededError(maxJobs) {
  return new StorageLimitExceededError(maxJobs);
}

/**
 * Builds a stable Error for non-insertable storage create-flow states.
 *
 * Purpose: billing state gates should fail before the atomic jobs RPC and must
 * not be flattened into confirmed-Free quota copy.
 *
 * @param {object} createFlow - Result from classifyStorageCreateFlow().
 * @returns {StorageCreateBlockedError} Route-mappable create failure.
 */
function createStorageCreateFlowError(createFlow = {}) {
  const code = createFlow.code ?? STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE;

  switch (code) {
    case STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING:
      return new StorageCreateBlockedError({
        code,
        message: 'Billing reconciliation is pending',
        statusCode: 503,
        retryable: true,
      });

    case STORAGE_CREATE_ERROR_CODES.PAYMENT_METHOD_UPDATE_REQUIRED:
      return new StorageCreateBlockedError({
        code,
        message: 'Payment method update required',
        statusCode: 402,
        retryable: false,
      });

    case STORAGE_CREATE_ERROR_CODES.BILLING_SYNC_PENDING:
      return new StorageCreateBlockedError({
        code,
        message: 'Billing sync pending',
        statusCode: 409,
        retryable: false,
      });

    case STORAGE_CREATE_ERROR_CODES.BILLING_STATE_REVIEW_REQUIRED:
      return new StorageCreateBlockedError({
        code,
        message: 'Billing state review required',
        statusCode: 409,
        retryable: false,
      });

    case STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE:
    default:
      return new StorageCreateBlockedError({
        code: STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
        message: 'Billing status unavailable',
        statusCode: 503,
        retryable: true,
      });
  }
}

/**
 * Removes server-owned fields from ordinary job write payloads.
 *
 * Purpose: after job CRUD moves behind service-role access, route validation
 * should not be the only guard preventing ownership or storage-policy field
 * mutation through createJob() or updateJob().
 *
 * @param {Object} jobData - Validated or caller-provided job write fields.
 * @returns {Object} Job payload with server-controlled fields removed.
 */
function stripServerControlledJobFields(jobData) {
  const sanitizedJobData = {};

  for (const [key, value] of Object.entries(jobData || {})) {
    if (!SERVER_CONTROLLED_JOB_FIELDS.has(key)) {
      sanitizedJobData[key] = value;
    }
  }

  return sanitizedJobData;
}

/**
 * Normalizes JSON returned by Supabase RPC calls.
 *
 * Purpose: PostgREST may return JSON function payloads as objects or strings
 * depending on environment; the service should validate one trusted shape.
 *
 * @param {unknown} data - Raw Supabase RPC response payload.
 * @returns {object|null} Parsed RPC payload object.
 */
function normalizeStorageCreateRpcData(data) {
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
 * Calls the database-side atomic job create quota boundary.
 *
 * Purpose: active and retained create eligibility must be checked in the same
 * transaction as the insert so concurrent creates cannot overshoot the caps.
 *
 * @param {{ userId: string, jobData: object, storageStatus: string }} params
 * @returns {Promise<object>} Normalized RPC result.
 */
async function callCreateJobWithStorageQuotaRpc({ userId, jobData, storageStatus }) {
  const { data, error } = await supabaseAdmin.rpc(
    'create_job_with_storage_quota',
    {
      p_user_id: userId,
      p_job_data: jobData,
      p_storage_status: storageStatus,
      p_active_job_limit: FREE_ACTIVE_JOB_LIMIT,
      p_absolute_retained_job_limit: ABSOLUTE_RETAINED_JOB_LIMIT,
    }
  );

  if (error) {
    throw error;
  }

  const normalizedData = normalizeStorageCreateRpcData(data);

  if (!normalizedData || typeof normalizedData.created !== 'boolean') {
    throw new Error('Atomic job create RPC returned an unexpected payload');
  }

  return normalizedData;
}

/**
 * Resolves the create-flow policy from a storage-status result.
 *
 * Purpose: service callers should pass the typed storage-status object from
 * resolveStorageStatus(), while tests and defensive paths still normalize the
 * same contract if only a status string is supplied.
 *
 * @param {string|object|null|undefined} storageStatusResult
 * @returns {{ status: string|null, createFlow: object }}
 */
function getStorageCreatePolicy(storageStatusResult) {
  const status = typeof storageStatusResult === 'object'
    ? storageStatusResult?.status
    : storageStatusResult;
  const createFlow = typeof storageStatusResult === 'object' && storageStatusResult?.createFlow
    ? storageStatusResult.createFlow
    : classifyStorageCreateFlow(storageStatusResult);

  return {
    status: status ?? null,
    createFlow,
  };
}

/**
 * Retrieves jobs for a specific user with optional pagination and filtering
 *
 * @param {string} userId - The user's ID
 * @param {Object} options - Optional query parameters
 * @param {number} options.from - Start index for pagination
 * @param {number} options.to - End index for pagination
 * @param {string} options.status - Filter by job status
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient - Accepted for route compatibility; jobs are queried through supabaseAdmin.
 * @returns {Promise<{data: Array|null, count: number, error: Error|null}>}
 *
 * Security: Only returns jobs where user_id matches the authenticated user.
 */
export async function getJobsByUserId(userId, options = {}, supabaseClient, log = defaultLogger) {
  try {
    const { from, to, status } = options;

    let query = supabaseAdmin
      .from('jobs')
      .select('*', { count: 'exact' })
      .eq('user_id', userId);

    if (status) {
      query = query.eq('status', status);
    }

    query = query.order('created_at', { ascending: false });

    if (from !== undefined && to !== undefined) {
      query = query.range(from, to);
    }

    const { data, error, count } = await query;

    if (error) {
      log.error({ err: error, operation: 'getJobsByUserId', userId }, 'Database query failed');
      return { data: null, count: 0, error };
    }

    return { data, count: count || 0, error: null };
  } catch (error) {
    log.error({ err: error, operation: 'getJobsByUserId', userId }, 'Unexpected error in getJobsByUserId');
    return { data: null, count: 0, error };
  }
}

/**
 * Retrieves a single job by ID for a specific user
 *
 * Purpose: Fetch a specific job application by its UUID
 * Connects to: supabaseAdmin for server-owned database queries.
 *
 * @param {string} jobId - The job's UUID
 * @param {string} userId - The user's ID
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient - Accepted for route compatibility; jobs are queried through supabaseAdmin.
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Enforces user ownership by requiring user_id match.
 * - Returns null if job doesn't exist OR user doesn't own it (prevents enumeration)
 */
export async function getJobById(jobId, userId, supabaseClient, log = defaultLogger) {
  try {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();

    if (error) {
      // PGRST116 = "No rows found" - treat as not found, not as error
      if (error.code === 'PGRST116') {
        return { data: null, error: new Error('Job not found or unauthorized') };
      }

      log.error({ err: error, operation: 'getJobById', userId, jobId }, 'Database query failed');
      return { data: null, error };
    }

    return { data, error: null };
  } catch (error) {
    log.error({ err: error, operation: 'getJobById', userId, jobId }, 'Unexpected error in getJobById');
    return { data: null, error };
  }
}

/**
 * Creates a new job for a user.
 *
 * Purpose: Insert a new job application with typed, atomic storage quota checks.
 * Connects to:
 * - billingService.classifyStorageCreateFlow for status-aware create policy
 * - create_job_with_storage_quota RPC for the transaction-scoped count/insert
 * - supabaseAdmin service role for the server-owned job boundary
 *
 * @param {Object} jobData - The job data to insert (validated by jobSchema).
 * @param {string} userId - The user's ID.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient - Accepted for route compatibility; jobs are inserted through supabaseAdmin RPC.
 * @param {object} log - Request-scoped logger.
 * @param {object|string} storageStatusResult - Typed storage status from resolveStorageStatus().
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Associates job with server-derived user_id to enforce ownership.
 * Storage: Rejects creates from ambiguous billing states and uses the database
 * transaction boundary for active and retained quota enforcement.
 */
export async function createJob(jobData, userId, supabaseClient, log = defaultLogger, storageStatusResult = null) {
  try {
    const sanitizedJobData = stripServerControlledJobFields(jobData);
    const { status: storageStatus, createFlow } = getStorageCreatePolicy(storageStatusResult);

    if (
      createFlow.action !== STORAGE_CREATE_ACTIONS.APPLY_FREE_LIMIT
      && createFlow.action !== STORAGE_CREATE_ACTIONS.APPLY_PREMIUM_LIMIT
    ) {
      return { data: null, error: createStorageCreateFlowError(createFlow) };
    }

    if (!storageStatus) {
      log.error({ operation: 'createJob', userId }, 'Storage status is missing for create');
      return {
        data: null,
        error: createStorageCreateFlowError({
          code: STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
        }),
      };
    }

    const createResult = await callCreateJobWithStorageQuotaRpc({
      userId,
      jobData: sanitizedJobData,
      storageStatus,
    });

    if (!createResult.created) {
      if (createResult.code === STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED) {
        const maxJobs = createResult.reason === 'active_limit_exceeded'
          ? createResult.activeLimit
          : createResult.absoluteRetainedLimit;

        log.warn(
          {
            operation: 'createJob',
            userId,
            storageStatus,
            reason: createResult.reason,
            activeCount: createResult.activeCount,
            retainedTotalCount: createResult.retainedTotalCount,
            activeLimit: createResult.activeLimit,
            absoluteRetainedLimit: createResult.absoluteRetainedLimit,
          },
          'Storage limit reached'
        );

        return { data: null, error: createStorageLimitExceededError(maxJobs) };
      }

      log.error(
        { operation: 'createJob', userId, storageStatus, createResult },
        'Atomic job create RPC denied create with an unexpected result'
      );
      return { data: null, error: new Error('Job create was not allowed') };
    }

    if (!createResult.job || typeof createResult.job !== 'object') {
      log.error({ operation: 'createJob', userId, storageStatus }, 'Atomic job create RPC returned no job');
      return { data: null, error: new Error('Failed to create job') };
    }

    log.info({ operation: 'createJob', userId, jobId: createResult.job?.id }, 'Job created successfully');

    return { data: [createResult.job], error: null };

  } catch (error) {
    log.error({ err: error, operation: 'createJob', userId }, 'Unexpected error in createJob');
    return { data: null, error };
  }
}

/**
 * Updates an existing job
 *
 * @param {string} jobId - The job ID to update
 * @param {Object} updateData - The fields to update (validated by jobUpdateSchema)
 * @param {string} userId - The user's ID
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient - Accepted for route compatibility; jobs are updated through supabaseAdmin.
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Enforces user ownership by requiring user_id match.
 * - This prevents users from updating jobs they don't own
 */
export async function updateJob(jobId, updateData, userId, supabaseClient, log = defaultLogger) {
  try {
    const sanitizedUpdateData = stripServerControlledJobFields(updateData);

    const { data, error } = await supabaseAdmin
      .from('jobs')
      .update(sanitizedUpdateData)
      .eq('id', jobId)
      .eq('user_id', userId)
      .select('*');

    if (error) {
      log.error({ err: error, operation: 'updateJob', userId, jobId }, 'Failed to update job');
      return { data: null, error };
    }

    // Check if no rows were updated (job doesn't exist or user doesn't own it)
    if (!data || data.length === 0) {
      log.warn({ operation: 'updateJob', userId, jobId }, 'Update failed - job not found or unauthorized');
      return { data: null, error: new Error('Job not found or unauthorized') };
    }

    return { data, error: null };
  } catch (error) {
    log.error({ err: error, operation: 'updateJob', userId, jobId }, 'Unexpected error in updateJob');
    return { data: null, error };
  }
}

/**
 * Deletes an existing job
 *
 * @param {string} jobId - The job ID to delete
 * @param {string} userId - The user's ID
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient - Accepted for route compatibility; jobs are deleted through supabaseAdmin.
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Enforces user ownership by requiring user_id match.
 * - This prevents users from deleting jobs they don't own
 */
export async function deleteJob(jobId, userId, supabaseClient, log = defaultLogger) {
  try {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .delete()
      .eq('id', jobId)
      .eq('user_id', userId)
      .select();

    if (error) {
      log.error({ err: error, operation: 'deleteJob', userId, jobId }, 'Failed to delete job');
      return { data: null, error };
    }

    if (!data || data.length === 0) {
      log.warn({ operation: 'deleteJob', userId, jobId }, 'Delete failed - job not found or unauthorized');
      return { data: null, error: new Error('Job not found or unauthorized') };
    }

    return { data: data[0], error: null };
  } catch (error) {
    log.error({ err: error, operation: 'deleteJob', userId, jobId }, 'Unexpected error in deleteJob');
    return { data: null, error };
  }
}
