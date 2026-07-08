import { ERROR_MESSAGES } from '../../shared/errors.js';
import { jobUpdateSchema, uuidSchema } from '../../shared/validations/jobSchema.js';
import { sendSuccess, sendError } from '../../shared/response.js';
import { getJobById, updateJob, deleteJob } from '../../server/services/jobService.js';
import { reconcileStorageTransitionsForUser } from '../../server/services/storageTransitionService.js';
import { STORAGE_CREATE_ERROR_CODES } from '../../shared/constants/billing.js';
import { JOB_STORAGE_ERRORS } from '../../shared/constants/storage.js';

import { withRateLimit } from '../../server/middleware/withRateLimit.js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '16kb',
    },
  },
};

const STORAGE_ACCESS_RETRY_AFTER_SECONDS = 5;

/**
 * Validates UUID format using Zod schema
 *
 * Purpose: Early rejection of malformed IDs before database calls
 * Connects to: uuidSchema from jobSchema.js
 *
 * @param {string} id - The ID to validate
 * @returns {boolean} True if valid UUID format, false otherwise
 */
function validateUUID(id) {
  const result = uuidSchema.safeParse(id);
  return result.success;
}

/**
 * Attach retry guidance for temporary storage access failures.
 *
 * Purpose: locked-row access can require confirmed billing state; retryable
 * ambiguity should use the same client retry path as service unavailability.
 *
 * @param {import('next').NextApiResponse} res - API response object.
 * @returns {void}
 */
function setStorageAccessRetryAfter(res) {
  res.setHeader('Retry-After', STORAGE_ACCESS_RETRY_AFTER_SECONDS);
}

/**
 * Maps job access errors to public API responses.
 *
 * Purpose: locked-row detail and update requests need stable 423 responses,
 * while billing ambiguity needs retryable 503 responses without downgrade copy.
 *
 * @param {import('next').NextApiResponse} res - API response object.
 * @param {Error|object|string|null|undefined} error - Service-layer error.
 * @returns {object} Next.js response chain.
 */
function sendJobAccessError(res, error) {
  switch (error?.code) {
    case JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN:
      return sendError(
        res,
        423,
        JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN,
        ERROR_MESSAGES.JOB_LOCKED_BY_PLAN
      );

    case STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE:
      setStorageAccessRetryAfter(res);
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);

    case STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING:
      setStorageAccessRetryAfter(res);
      return sendError(
        res,
        503,
        STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING,
        ERROR_MESSAGES.BILLING_RECONCILIATION_PENDING
      );

    default:
      return sendError(res, 404, 'NOT_FOUND', ERROR_MESSAGES.NOT_FOUND);
  }
}

/**
 * Repair missed storage transitions before reading or updating one job.
 *
 * Purpose: direct-by-id routes must not expose an overflow row that remained
 * active only because a terminal cancellation webhook was missed, and Premium
 * re-entitlement should restore locked rows before access policy runs. The
 * returned typed status is reused for locked-row access policy.
 *
 * @param {import('next').NextApiRequest & { log: object }} req - API request with logger.
 * @param {{ id: string }} user - Authenticated user.
 * @returns {Promise<{data: object|null, error: Error|object|null}>}
 */
async function repairStorageTransitionsForJobRequest(req, user) {
  try {
    const repairResult = await reconcileStorageTransitionsForUser(user.id, req.log);

    return {
      data: repairResult.data ?? null,
      error: repairResult.error ?? null,
    };
  } catch (error) {
    req.log.error(
      {
        err: error,
        operation: 'repairStorageTransitionsForJobRequest',
        userId: user.id,
      },
      'Storage transition repair failed'
    );
    return { data: null, error };
  }
}

/**
 * Send the public API response for a successful deleteJob call.
 *
 * Purpose: keep delete responses on the shared success envelope while returning
 * only the minimal deleted identifier payload from the service layer.
 *
 * @param {import('next').NextApiResponse} res - API response object.
 * @param {object} data - Minimal deleted job payload, currently `{ id }`.
 * @returns {object} Next.js response chain.
 */
function sendDeleteJobSuccess(res, data) {
  return sendSuccess(res, 200, data, 'Successfully deleted job');
}

/**
 * Handles GET requests - retrieves a single job by ID
 *
 * Purpose: Fetch a specific job application for the authenticated user
 * Connects to: jobService.getJobById() for database operations
 *
 * @param {Object} req - Next.js request object
 * @param {Object} res - Next.js response object
 * @param {Object} user - Authenticated user object
 * @param {string} jobId - The job's UUID from URL path
 */
async function handleGet(req, res, user, jobId) {
  const repairResult = await repairStorageTransitionsForJobRequest(req, user);
  const storageStatusResult = repairResult.data?.storageStatusResult;

  if (repairResult.error || !storageStatusResult) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }

  const { data, error } = await getJobById(
    jobId,
    user.id,
    req._supabaseClient,
    req.log,
    storageStatusResult
  );

  if (error || !data) {
    return sendJobAccessError(res, error);
  }

  return sendSuccess(res, 200, data, 'Job retrieved successfully');
}

/**
 * Handles PUT requests - updates an existing job by ID
 *
 * Purpose: Update job application details (status, notes, etc.)
 * Connects to: jobService.updateJob() for database operations
 * Validation: Uses jobUpdateSchema to validate request body
 *
 * @param {Object} req - Next.js request object
 * @param {Object} res - Next.js response object
 * @param {Object} user - Authenticated user object
 * @param {string} jobId - The job's UUID from URL path
 */
async function handlePut(req, res, user, jobId) {
  const updateResult = jobUpdateSchema.safeParse(req.body);

  if (!updateResult.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
  }

  const repairResult = await repairStorageTransitionsForJobRequest(req, user);
  const storageStatusResult = repairResult.data?.storageStatusResult;

  if (repairResult.error || !storageStatusResult) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }

  const updatedData = updateResult.data;

  // Server-side only: auto-set status_date when status is being changed.
  // status_date is never accepted from the client — it's injected here to
  // ensure timestamp integrity.
  if (updatedData.status !== undefined) {
    updatedData.status_date = new Date().toISOString();
  }

  // Cross-field salary validation on partial updates:
  // When only one salary field is sent, fetch the current job to validate
  // the range against the stored counterpart. DB CHECK constraint is the
  // final safety net, but we fail early here with a clear error message.
  const hasMin = updatedData.salary_min != null;
  const hasMax = updatedData.salary_max != null;
  if (hasMin !== hasMax) {
    const { data: currentJob, error: fetchError } = await getJobById(
      jobId,
      user.id,
      req._supabaseClient,
      req.log,
      storageStatusResult
    );
    if (fetchError || !currentJob) {
      return sendJobAccessError(res, fetchError);
    }
    const effectiveMin = hasMin ? updatedData.salary_min : currentJob.salary_min;
    const effectiveMax = hasMax ? updatedData.salary_max : currentJob.salary_max;
    if (effectiveMin != null && effectiveMax != null && effectiveMax < effectiveMin) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Max salary must be greater than or equal to min salary');
    }
  }

  const { data, error } = await updateJob(
    jobId,
    updatedData,
    user.id,
    req._supabaseClient,
    req.log,
    storageStatusResult
  );

  if (error || !data) {
    return sendJobAccessError(res, error);
  }

  return sendSuccess(res, 200, data, 'Successfully updated job details');
}

/**
 * Handles DELETE requests - removes an existing job by ID
 *
 * Purpose: Delete job application from user's tracking list
 * Connects to: jobService.deleteJob() for database operations
 *
 * @param {Object} req - Next.js request object
 * @param {Object} res - Next.js response object
 * @param {Object} user - Authenticated user object
 * @param {string} jobId - The job's UUID from URL path
 */
async function handleDelete(req, res, user, jobId) {
  const repairResult = await repairStorageTransitionsForJobRequest(req, user);
  const storageStatusResult = repairResult.data?.storageStatusResult;

  if (repairResult.error || !storageStatusResult) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }

  const { data, error } = await deleteJob(
    jobId,
    user.id,
    req._supabaseClient,
    req.log,
    storageStatusResult
  );

  if (error || !data) {
    return sendJobAccessError(res, error);
  }

  return sendDeleteJobSuccess(res, data);
}
/**
 * Main request handler for /api/jobs/[id] endpoint
 *
 * Purpose: RESTful endpoint for single job operations (GET, PUT, DELETE)
 * Connects to:
 * - getUserFromRequest() for JWT authentication
 * - uuidSchema for ID validation
 * - handleGet/handlePut/handleDelete for specific operations
 *
 * Security:
 * - Validates UUID format before any database operations
 * - Authenticates user via JWT token
 * - Ownership verified at service layer (defense in depth)
 * - Returns 404 for both "not found" and "not owned" (prevents enumeration)
 */
async function handler(req, res) {
  const { id } = req.query;

  // Validate UUID format before database work; auth already ran in withRateLimit.
  if (!id || !validateUUID(id)) {
    req.log.warn({ operation: 'handler', id: id || 'empty', method: req.method }, 'Invalid job ID format attempted');
    return sendError(res, 400, 'INVALID_ID', ERROR_MESSAGES.INVALID_ID);
  }

  // Authenticate user via JWT
  const user = req._rateLimitUser

  // Route to appropriate handler based on HTTP method
  switch (req.method) {
    case 'GET':
      return await handleGet(req, res, user, id);

    case 'PUT':
      return await handlePut(req, res, user, id);

    case 'DELETE':
      return await handleDelete(req, res, user, id);

    default:
      return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED);
  }
}


export default withRateLimit(handler, { requireAuth: true, allowedMethods: ['GET', 'PUT', 'DELETE'] })
