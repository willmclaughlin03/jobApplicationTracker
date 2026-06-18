import { ERROR_MESSAGES } from '../../shared/errors.js';
import { jobSchema, getQuerySchema } from '../../shared/validations/jobSchema.js';
import { sendSuccess, sendError } from '../../shared/response.js';
import { getJobsByUserId, createJob } from '../../server/services/jobService.js';
import { getStorageSummaryForUser } from '../../server/services/storageSummaryService.js';
import { reconcileStorageTransitionsForUser } from '../../server/services/storageTransitionService.js';
import { withRateLimit } from '../../server/middleware/withRateLimit.js';
import { STORAGE_CREATE_ERROR_CODES } from '../../shared/constants/billing.js';

const STORAGE_CREATE_RETRY_AFTER_SECONDS = 5;

/**
 * Attach retry guidance for retryable storage-create failures.
 *
 * Purpose: billing-unavailable and reconciliation-pending create responses are
 * temporary service states, not confirmed-Free quota decisions.
 *
 * @param {import('next').NextApiResponse} res - API response object.
 * @returns {void}
 */
function setStorageCreateRetryAfter(res) {
  res.setHeader('Retry-After', STORAGE_CREATE_RETRY_AFTER_SECONDS);
}

/**
 * Send the public API response for a failed createJob call.
 *
 * Purpose: preserve stable billing/storage error codes while keeping internal
 * quota details and billing read failures out of client-visible messages.
 *
 * @param {import('next').NextApiResponse} res - API response object.
 * @param {Error|object|string|null|undefined} error - Service-layer error.
 * @returns {object} Next.js response chain.
 */
function sendCreateJobError(res, error) {
  switch (error?.code) {
    case STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED:
      return sendError(
        res,
        409,
        STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED,
        ERROR_MESSAGES.STORAGE_LIMIT_EXCEEDED
      );

    case STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE:
      setStorageCreateRetryAfter(res);
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);

    case STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING:
      setStorageCreateRetryAfter(res);
      return sendError(
        res,
        503,
        STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING,
        ERROR_MESSAGES.BILLING_RECONCILIATION_PENDING
      );

    case STORAGE_CREATE_ERROR_CODES.PAYMENT_METHOD_UPDATE_REQUIRED:
      return sendError(
        res,
        402,
        STORAGE_CREATE_ERROR_CODES.PAYMENT_METHOD_UPDATE_REQUIRED,
        ERROR_MESSAGES.PAYMENT_METHOD_UPDATE_REQUIRED
      );

    case STORAGE_CREATE_ERROR_CODES.BILLING_SYNC_PENDING:
      return sendError(
        res,
        409,
        STORAGE_CREATE_ERROR_CODES.BILLING_SYNC_PENDING,
        ERROR_MESSAGES.BILLING_SYNC_PENDING
      );

    case STORAGE_CREATE_ERROR_CODES.BILLING_STATE_REVIEW_REQUIRED:
      return sendError(
        res,
        409,
        STORAGE_CREATE_ERROR_CODES.BILLING_STATE_REVIEW_REQUIRED,
        ERROR_MESSAGES.BILLING_STATE_REVIEW_REQUIRED
      );

    default: {
      const statusCode = Number.isInteger(error?.statusCode)
        ? error.statusCode
        : error?.status;

      return sendError(
        res,
        Number.isInteger(statusCode) ? statusCode : 500,
        'ADD_FAILED',
        ERROR_MESSAGES.ADD_FAILED
      );
    }
  }
}

/**
 * Send the public API response for list access failures.
 *
 * Purpose: locked archive access can depend on confirmed billing state, so
 * retryable ambiguity should return service-state responses instead of Free
 * downgrade or generic fetch copy.
 *
 * @param {import('next').NextApiResponse} res - API response object.
 * @param {Error|object|string|null|undefined} error - Service-layer error.
 * @returns {object} Next.js response chain.
 */
function sendGetJobsError(res, error) {
  switch (error?.code) {
    case STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE:
      setStorageCreateRetryAfter(res);
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);

    case STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING:
      setStorageCreateRetryAfter(res);
      return sendError(
        res,
        503,
        STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING,
        ERROR_MESSAGES.BILLING_RECONCILIATION_PENDING
      );

    default:
      return sendError(res, 503, 'FETCH_FAILED', ERROR_MESSAGES.FETCH_FAILED);
  }
}

/**
 * Run storage transition repair before collection reads or creates.
 *
 * Purpose: lazy request-time repair catches missed cancellation webhooks and
 * Premium re-entitlement restores while preserving fail-closed behavior when a
 * required storage transition fails.
 *
 * @param {import('next').NextApiRequest & { log: object }} req - API request with logger.
 * @param {{ id: string }} user - Authenticated user.
 * @returns {Promise<{data: object|null, error: Error|object|null}>}
 */
async function repairStorageTransitionsForRequest(req, user) {
  const repairResult = await reconcileStorageTransitionsForUser(
    user.id,
    req.log
  );

  return {
    data: repairResult.data ?? null,
    error: repairResult.error ?? null,
  };
}

/**
 * Handles GET requests - retrieves jobs and storage summary for authenticated user
 *
 * Purpose: Fetch user's job application history with optional pagination/filtering
 * Connects to:
 * - jobService.getJobsByUserId() for database operations
 * - storageSummaryService.getStorageSummaryForUser() for count-only metadata
 * Query params: from, to (pagination), status (filter)
 */
async function handleGet(req, res, user) {
  const queryResult = getQuerySchema.safeParse(req.query);

  if (!queryResult.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
  }

  const { from, to, status, storage_state } = queryResult.data;

  const options = {};

  if (from !== undefined && to !== undefined) {
    options.from = from;
    options.to = to;
  }

  if (status) {
    options.status = status;
  }

  if (storage_state) {
    options.storage_state = storage_state;
  }

  const repairResult = await repairStorageTransitionsForRequest(req, user);
  const storageStatusResult = repairResult.data?.storageStatusResult;

  if (repairResult.error || !storageStatusResult) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }

  const storageSummaryResult = await getStorageSummaryForUser(
    user.id,
    req._supabaseClient,
    req.log,
    {
      storageStatusResult,
    }
  );

  if (storageSummaryResult.error) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }

  const { data, count, error } = await getJobsByUserId(
    user.id,
    options,
    req._supabaseClient,
    req.log,
    storageSummaryResult.data
  );

  if (error) {
    return sendGetJobsError(res, error);
  }

  return sendSuccess(
    res,
    200,
    { data, count, storageSummary: storageSummaryResult.data },
    'Jobs retrieved successfully'
  );
}

/**
 * Handles POST requests - creates a new job application
 *
 * Purpose: Add new job application to user's tracking list
 * Connects to: jobService.createJob() for database operations
 * Validation: Uses jobSchema to validate request body
 */
async function handlePost(req, res, user) {
  const createResult = jobSchema.safeParse(req.body);

  if (!createResult.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
  }

  const finalizedData = createResult.data;
  finalizedData.status_date = new Date().toISOString();
  const repairResult = await repairStorageTransitionsForRequest(req, user);

  if (repairResult.error) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }

  const storageStatusResult = repairResult.data?.storageStatusResult;

  if (!storageStatusResult) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }

  const { data, error } = await createJob(
    finalizedData,
    user.id,
    req._supabaseClient,
    req.log,
    storageStatusResult
  );

  if (error) {
    return sendCreateJobError(res, error);
  }

  return sendSuccess(res, 201, data, 'Successfully added job');
}

/**
 * Main request handler with authentication and routing
 *
 * Purpose: Entry point for /api/jobs endpoint (collection operations)
 * Connects to:
 * - getUserFromRequest() for authentication
 * - handleGet for listing jobs
 * - handlePost for creating jobs
 *
 * Note: Single job operations (GET/PUT/DELETE by ID) are handled by [id].js
 *
 * Security: Validates user authentication before processing requests
 */
async function handler(req, res) {
  const user = req._rateLimitUser

  switch(req.method){
    case 'GET':
      return await handleGet(req,res,user)

    case 'POST':
      return await handlePost(req,res,user)
    
    default:
      //PUT DELETE and other methods use [id] endpoint
      return sendError(res, 405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.METHOD_NOT_ALLOWED)
  }

}

export default withRateLimit(handler, { requireAuth: true, allowedMethods: ['GET', 'POST'] })
