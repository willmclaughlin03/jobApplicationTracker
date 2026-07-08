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
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabaseServer.js';
import { logger as defaultLogger } from '../../shared/logger.js';
import {
  classifyStorageCreateFlow,
  isStorageStatusRetryable,
} from '../lib/billingService.js';
import {
  STORAGE_CREATE_ACTIONS,
  STORAGE_CREATE_ERROR_CODES,
  STORAGE_STATUSES,
} from '../../shared/constants/billing.js';
import {
  ABSOLUTE_RETAINED_JOB_LIMIT,
  FREE_ACTIVE_JOB_LIMIT,
  JOB_STORAGE_ERRORS,
  JOB_STORAGE_QUERY_STATES,
  JOB_STORAGE_STATES,
} from '../../shared/constants/storage.js';

const SERVER_CONTROLLED_JOB_FIELDS = new Set([
  'id',
  'user_id',
  'storage_state',
  'locked_at',
  'locked_reason',
  'locked_policy_version',
]);

const FULL_JOB_SELECT = '*';
const JOB_STORAGE_ACCESS_SELECT = 'id, storage_state, locked_at, locked_reason, locked_policy_version';
const LOCKED_JOB_TEASER_SELECT = 'id, created_at, locked_at, locked_reason, locked_policy_version';
const STORAGE_ACCESS_RETRYABLE_STATUS_CODES = new Map([
  [
    STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
    STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING,
  ],
  [
    STORAGE_STATUSES.BILLING_UNAVAILABLE,
    STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
  ],
]);
const LOCKED_JOB_DELETE_AMBIGUOUS_STATUSES = new Set([
  STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
  STORAGE_STATUSES.BILLING_UNAVAILABLE,
  STORAGE_STATUSES.PAYMENT_RECOVERY,
  STORAGE_STATUSES.SYNC_PENDING,
]);
const jobReadOptionsSchema = z.object({
  from: z.number({ error: 'from must be a number' })
    .int('from must be an integer')
    .min(0, 'from must be >= 0')
    .optional(),
  to: z.number({ error: 'to must be a number' })
    .int('to must be an integer')
    .min(0, 'to must be >= 0')
    .optional(),
  status: z.string().optional(),
  storage_state: z.string().optional(),
}).passthrough()
  .refine(
    (options) => (options.from === undefined) === (options.to === undefined),
    { message: 'from and to must both be provided together for pagination' }
  )
  .refine(
    (options) => (
      options.from === undefined
      || options.to === undefined
      || options.to >= options.from
    ),
    { message: 'to must be greater than or equal to from' }
  );

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

export class JobLockedByPlanError extends Error {
  /**
   * Builds the stable locked-row error returned by plan-gated APIs.
   */
  constructor() {
    super('Job is locked by the current storage plan');
    this.name = 'JobLockedByPlanError';
    this.code = JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN;
    this.statusCode = 423;
  }
}

export class StorageAccessUnavailableError extends Error {
  /**
   * Builds a retryable Error for storage access decisions that need billing.
   *
   * @param {{ code?: string, message?: string }} params
   */
  constructor({ code = STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE, message = 'Storage access unavailable' } = {}) {
    super(message);
    this.name = 'StorageAccessUnavailableError';
    this.code = code;
    this.statusCode = 503;
    this.retryable = true;
  }
}

export class InvalidJobReadOptionsError extends Error {
  /**
   * Builds the stable invalid-options error for owner-scoped job list reads.
   *
   * @param {string} message - Validation failure returned from the options schema.
   */
  constructor(message) {
    super(message);
    this.name = 'InvalidJobReadOptionsError';
    this.code = 'JOB_READ_OPTIONS_INVALID';
    this.statusCode = 400;
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
 * Reads the storage-status string from a typed result or raw status.
 *
 * Purpose: job access helpers accept the same storage-status result shape used
 * by createJob(), while tests and defensive callers may pass a raw string.
 *
 * @param {string|object|null|undefined} storageStatusResult - Typed storage status or raw status.
 * @returns {string|null} Normalized storage status value.
 */
function getStorageStatusValue(storageStatusResult) {
  if (typeof storageStatusResult === 'object' && storageStatusResult !== null) {
    return storageStatusResult.status ?? null;
  }

  return typeof storageStatusResult === 'string' ? storageStatusResult : null;
}

/**
 * Determines whether storage policy permits full locked-row access.
 *
 * Purpose: Premium and canceling Premium users keep full access, while Free
 * and non-entitled states must not receive hidden locked-job fields.
 *
 * @param {string|null} storageStatus - Normalized storage status.
 * @returns {boolean} True when full locked-row access is allowed.
 */
function isPremiumStorageStatus(storageStatus) {
  return storageStatus === STORAGE_STATUSES.PREMIUM_ACTIVE
    || storageStatus === STORAGE_STATUSES.PREMIUM_CANCELING;
}

/**
 * Checks whether a minimal job row represents a locked overflow record.
 *
 * Purpose: centralize the v1 locked-state comparison so list, detail, update,
 * and delete paths agree on which rows require plan-gated handling.
 *
 * @param {object|null|undefined} jobRecord - Minimal or full job row.
 * @returns {boolean} True when the row is locked over the plan limit.
 */
function isLockedJobRecord(jobRecord) {
  return jobRecord?.storage_state === JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT;
}

/**
 * Builds the retryable error for ambiguous locked-row access decisions.
 *
 * Purpose: billing_unavailable and reconciliation-pending are not confirmed
 * Free states, so locked-row reads/edits should retry instead of returning
 * downgrade copy or revealing locked data.
 *
 * @param {string|null} storageStatus - Normalized storage status.
 * @returns {StorageAccessUnavailableError} Route-mappable retryable error.
 */
function createStorageAccessUnavailableError(storageStatus) {
  return new StorageAccessUnavailableError({
    code: STORAGE_ACCESS_RETRYABLE_STATUS_CODES.get(storageStatus)
      ?? STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
    message: 'Storage access requires a confirmed billing status',
  });
}

/**
 * Returns the access error for a locked row, if full access is not allowed.
 *
 * Purpose: route handlers need a single service-layer decision for 423 locked
 * responses versus retryable 503 billing-state responses.
 *
 * @param {string|null} storageStatus - Normalized storage status.
 * @returns {Error|null} Error when full locked access must be denied.
 */
function getLockedJobAccessError(storageStatus) {
  if (isPremiumStorageStatus(storageStatus)) {
    return null;
  }

  if (!storageStatus || isStorageStatusRetryable(storageStatus)) {
    return createStorageAccessUnavailableError(storageStatus);
  }

  return new JobLockedByPlanError();
}

/**
 * Returns the delete policy error for a locked row, if deletion must stop.
 *
 * Purpose: confirmed terminal-Free users may delete their locked archive one
 * row at a time, while Premium users may delete restored/locked rows normally.
 * Ambiguous billing states block destructive deletion until status is settled.
 *
 * @param {string|null} storageStatus - Normalized storage status.
 * @returns {Error|null} Error when locked-row deletion is not currently allowed.
 */
function getLockedJobDeleteError(storageStatus) {
  if (isPremiumStorageStatus(storageStatus) || storageStatus === STORAGE_STATUSES.TERMINAL_FREE) {
    return null;
  }

  if (!storageStatus || LOCKED_JOB_DELETE_AMBIGUOUS_STATUSES.has(storageStatus)) {
    return createStorageAccessUnavailableError(storageStatus);
  }

  return new JobLockedByPlanError();
}

/**
 * Builds the row projection and filters for owner-scoped job list queries.
 *
 * Purpose: normal non-Premium lists return active full rows only, while the
 * explicit locked archive query returns teaser rows with hidden fields omitted.
 *
 * @param {object} options - Validated list options from the route.
 * @param {string|null} storageStatus - Normalized storage status.
 * @returns {{select: string, storageStateFilter: string|null, error: Error|null}}
 */
function getJobListPolicy(options = {}, storageStatus = null) {
  if (options.storage_state === JOB_STORAGE_QUERY_STATES.LOCKED) {
    if (!storageStatus || isStorageStatusRetryable(storageStatus)) {
      return {
        select: LOCKED_JOB_TEASER_SELECT,
        storageStateFilter: JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT,
        error: createStorageAccessUnavailableError(storageStatus),
      };
    }

    return {
      select: LOCKED_JOB_TEASER_SELECT,
      storageStateFilter: JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT,
      error: null,
    };
  }

  return {
    select: FULL_JOB_SELECT,
    storageStateFilter: isPremiumStorageStatus(storageStatus)
      ? null
      : JOB_STORAGE_STATES.ACTIVE,
    error: null,
  };
}

/**
 * Validates owner-scoped job list options at the service boundary.
 *
 * Purpose: direct service callers should get the same fail-closed pagination
 * contract as API routes instead of accidentally triggering an unbounded read.
 *
 * @param {unknown} options - Caller-provided list options.
 * @returns {{ from?: number, to?: number, status?: string, storage_state?: string }} Validated options.
 * @throws {InvalidJobReadOptionsError} When pagination bounds are malformed.
 */
function validateJobReadOptions(options) {
  const parsedOptions = jobReadOptionsSchema.safeParse(options);

  if (!parsedOptions.success) {
    throw new InvalidJobReadOptionsError(
      parsedOptions.error.issues[0]?.message ?? 'Invalid job list options'
    );
  }

  return parsedOptions.data;
}

/**
 * Fetches only storage-policy fields for an owned job row.
 *
 * Purpose: detail, update, and delete operations must know lock state before
 * any path fetches or returns full sensitive job fields.
 *
 * @param {string} jobId - Job id to inspect.
 * @param {string} userId - Authenticated owner id.
 * @param {object} log - Request-scoped logger.
 * @returns {Promise<{data: object|null, error: Error|object|null}>}
 */
async function getJobStorageAccessRecord(jobId, userId, log = defaultLogger) {
  try {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .select(JOB_STORAGE_ACCESS_SELECT)
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return { data: null, error: new Error('Job not found or unauthorized') };
      }

      log.error({ err: error, operation: 'getJobStorageAccessRecord', userId, jobId }, 'Database query failed');
      return { data: null, error };
    }

    return { data, error: null };
  } catch (error) {
    log.error({ err: error, operation: 'getJobStorageAccessRecord', userId, jobId }, 'Unexpected error in getJobStorageAccessRecord');
    return { data: null, error };
  }
}

/**
 * Fetches the full owned job row after storage access has been authorized.
 *
 * Purpose: keep full job selection isolated behind the minimal lock-state
 * precheck used by getJobById() and salary validation paths.
 *
 * @param {string} jobId - Job id to fetch.
 * @param {string} userId - Authenticated owner id.
 * @param {object} log - Request-scoped logger.
 * @returns {Promise<{data: object|null, error: Error|object|null}>}
 */
async function getFullJobById(jobId, userId, log = defaultLogger) {
  try {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .select(FULL_JOB_SELECT)
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return { data: null, error: new Error('Job not found or unauthorized') };
      }

      log.error({ err: error, operation: 'getFullJobById', userId, jobId }, 'Database query failed');
      return { data: null, error };
    }

    return { data, error: null };
  } catch (error) {
    log.error({ err: error, operation: 'getFullJobById', userId, jobId }, 'Unexpected error in getFullJobById');
    return { data: null, error };
  }
}

/**
 * Applies the pre-read storage lock decision for full row operations.
 *
 * Purpose: avoid repeating the same locked-row denial logic in detail and
 * update paths while allowing Premium statuses to proceed.
 *
 * @param {object|null} accessRecord - Minimal storage access record.
 * @param {string|null} storageStatus - Normalized storage status.
 * @returns {Error|null} Error when full access is denied.
 */
function getFullJobAccessError(accessRecord, storageStatus) {
  return isLockedJobRecord(accessRecord)
    ? getLockedJobAccessError(storageStatus)
    : null;
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
 * @param {string} options.storage_state - Optional locked archive query state
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient - Accepted for route compatibility; jobs are queried through supabaseAdmin.
 * @param {object} log - Request-scoped logger.
 * @param {object|string|null} storageStatusResult - Typed storage status used for locked-row policy.
 * @returns {Promise<{data: Array|null, count: number, truncated: boolean, error: Error|null}>}
 *
 * Security: Only returns jobs where user_id matches the authenticated user.
 */
export async function getJobsByUserId(
  userId,
  options = {},
  supabaseClient,
  log = defaultLogger,
  storageStatusResult = null
) {
  try {
    const validatedOptions = validateJobReadOptions(options);
    const { from, to, status } = validatedOptions;
    const isPaginatedRead = from !== undefined;
    const storageStatus = getStorageStatusValue(storageStatusResult);
    const listPolicy = getJobListPolicy(validatedOptions, storageStatus);

    if (listPolicy.error) {
      return { data: null, count: 0, truncated: false, error: listPolicy.error };
    }

    let query = supabaseAdmin
      .from('jobs')
      .select(listPolicy.select, { count: 'exact' });

    query = query.eq('user_id', userId);

    if (listPolicy.storageStateFilter) {
      query = query.eq('storage_state', listPolicy.storageStateFilter);
    }

    if (status && validatedOptions.storage_state !== JOB_STORAGE_QUERY_STATES.LOCKED) {
      query = query.eq('status', status);
    }

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });

    if (isPaginatedRead) {
      query = query.range(from, to);
    } else {
      query = query.limit(ABSOLUTE_RETAINED_JOB_LIMIT);
    }

    const { data, error, count } = await query;

    if (error) {
      log.error({ err: error, operation: 'getJobsByUserId', userId }, 'Database query failed');
      return { data: null, count: 0, truncated: false, error };
    }

    const returnedCount = Array.isArray(data) ? data.length : 0;
    const matchingCount = Array.isArray(data) && Number.isSafeInteger(count) && count >= 0
      ? count
      : returnedCount;
    const truncated = !isPaginatedRead
      && returnedCount === ABSOLUTE_RETAINED_JOB_LIMIT
      && matchingCount > returnedCount;

    if (truncated) {
      log.warn(
        {
          operation: 'getJobsByUserId',
          userId,
          returnedCount,
          matchingCount,
          limit: ABSOLUTE_RETAINED_JOB_LIMIT,
        },
        'Job list truncated at absolute retained job limit'
      );
    }

    return { data, count: matchingCount, truncated, error: null };
  } catch (error) {
    if (error instanceof InvalidJobReadOptionsError) {
      return { data: null, count: 0, truncated: false, error };
    }

    log.error({ err: error, operation: 'getJobsByUserId', userId }, 'Unexpected error in getJobsByUserId');
    return { data: null, count: 0, truncated: false, error };
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
 * @param {object} log - Request-scoped logger.
 * @param {object|string|null} storageStatusResult - Typed storage status used for locked-row policy.
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Enforces user ownership by requiring user_id match.
 * - Returns null if job doesn't exist OR user doesn't own it (prevents enumeration)
 */
export async function getJobById(
  jobId,
  userId,
  supabaseClient,
  log = defaultLogger,
  storageStatusResult = null
) {
  try {
    const accessResult = await getJobStorageAccessRecord(jobId, userId, log);

    if (accessResult.error || !accessResult.data) {
      return { data: null, error: accessResult.error };
    }

    const accessError = getFullJobAccessError(
      accessResult.data,
      getStorageStatusValue(storageStatusResult)
    );

    if (accessError) {
      return { data: null, error: accessError };
    }

    return await getFullJobById(jobId, userId, log);
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

      if (createResult.code === STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE) {
        log.warn(
          {
            operation: 'createJob',
            userId,
            storageStatus,
            canonicalStorageStatus: createResult.canonicalStorageStatus ?? null,
          },
          'Billing status changed before atomic job create'
        );
        return {
          data: null,
          error: createStorageCreateFlowError({
            code: STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
          }),
        };
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
 * @param {object} log - Request-scoped logger.
 * @param {object|string|null} storageStatusResult - Typed storage status used for locked-row policy.
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Enforces user ownership by requiring user_id match.
 * - This prevents users from updating jobs they don't own
 */
export async function updateJob(
  jobId,
  updateData,
  userId,
  supabaseClient,
  log = defaultLogger,
  storageStatusResult = null
) {
  try {
    const sanitizedUpdateData = stripServerControlledJobFields(updateData);
    const accessResult = await getJobStorageAccessRecord(jobId, userId, log);

    if (accessResult.error || !accessResult.data) {
      return { data: null, error: accessResult.error };
    }

    const accessError = getFullJobAccessError(
      accessResult.data,
      getStorageStatusValue(storageStatusResult)
    );

    if (accessError) {
      return { data: null, error: accessError };
    }

    let query = supabaseAdmin
      .from('jobs')
      .update(sanitizedUpdateData)
      .eq('id', jobId)
      .eq('user_id', userId);

    if (accessResult.data.storage_state) {
      query = query.eq('storage_state', accessResult.data.storage_state);
    }

    const { data, error } = await query.select(FULL_JOB_SELECT);

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
 * @param {object} log - Request-scoped logger.
 * @param {object|string|null} storageStatusResult - Typed storage status used for locked-row delete policy.
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Enforces user ownership by requiring user_id match.
 * - This prevents users from deleting jobs they don't own
 */
export async function deleteJob(jobId, userId, supabaseClient, log = defaultLogger, storageStatusResult = null) {
  try {
    const accessResult = await getJobStorageAccessRecord(jobId, userId, log);

    if (accessResult.error || !accessResult.data) {
      return { data: null, error: accessResult.error };
    }

    const deleteAccessError = isLockedJobRecord(accessResult.data)
      ? getLockedJobDeleteError(getStorageStatusValue(storageStatusResult))
      : null;

    if (deleteAccessError) {
      return { data: null, error: deleteAccessError };
    }

    let query = supabaseAdmin
      .from('jobs')
      .delete()
      .eq('id', jobId)
      .eq('user_id', userId);

    if (accessResult.data.storage_state) {
      query = query.eq('storage_state', accessResult.data.storage_state);
    }

    const { data, error } = await query.select('id');

    if (error) {
      log.error({ err: error, operation: 'deleteJob', userId, jobId }, 'Failed to delete job');
      return { data: null, error };
    }

    if (!data || data.length === 0) {
      log.warn({ operation: 'deleteJob', userId, jobId }, 'Delete failed - job not found or unauthorized');
      return { data: null, error: new Error('Job not found or unauthorized') };
    }

    return {
      data: { id: data[0]?.id ?? accessResult.data.id },
      error: null,
    };
  } catch (error) {
    log.error({ err: error, operation: 'deleteJob', userId, jobId }, 'Unexpected error in deleteJob');
    return { data: null, error };
  }
}
