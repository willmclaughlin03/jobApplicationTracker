import { z } from 'zod';
import { sendError, sendSuccess } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';
import { STORAGE_CREATE_ERROR_CODES } from '../../../shared/constants/billing.js';
import { JOB_STORAGE_ERRORS } from '../../../shared/constants/storage.js';
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { deleteLockedJobsForTerminalFreeUser } from '../../../server/services/storageLockedBulkDeleteService.js';

const LOCKED_BULK_DELETE_RETRY_AFTER_SECONDS = 5;
const LOCKED_BULK_DELETE_CONFIRMATION = 'permanently_delete_locked_jobs';

/**
 * Validates query parameters for DELETE /api/storage/locked-jobs.
 *
 * Purpose: reject client-controlled filters or user ids because ownership and
 * delete scope come only from authenticated middleware context.
 */
const lockedBulkDeleteQuerySchema = z.object({}).strict();

/**
 * Validates the destructive locked archive confirmation body.
 *
 * Purpose: require an explicit confirmation token before invoking the service
 * while rejecting client-supplied user ids or delete filters.
 */
const lockedBulkDeleteBodySchema = z.object({
  confirmation: z.literal(LOCKED_BULK_DELETE_CONFIRMATION),
}).strict();

/**
 * Applies no-store headers to locked bulk-delete responses.
 *
 * Purpose: deletion responses contain account-specific archive counts and must
 * not be cached by browsers, intermediaries, or CDN layers.
 *
 * @param {import('next').NextApiResponse} res - API response object.
 * @returns {void}
 */
function setLockedBulkDeleteCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Cookie');
}

/**
 * Attaches retry guidance for temporary storage-status ambiguity.
 *
 * Purpose: billing-unavailable and reconciliation-pending states should use
 * retryable response semantics rather than confirmed-Free archive copy.
 *
 * @param {import('next').NextApiResponse} res - API response object.
 * @returns {void}
 */
function setLockedBulkDeleteRetryAfter(res) {
  res.setHeader('Retry-After', LOCKED_BULK_DELETE_RETRY_AFTER_SECONDS);
}

/**
 * Checks whether unsupported query parameters were supplied.
 *
 * Purpose: client-supplied user ids, filters, or row ids must not influence the
 * authenticated user's locked archive deletion scope.
 *
 * @param {object|null|undefined} query - Next.js parsed query object.
 * @returns {boolean} True when the query is invalid.
 */
function hasInvalidQuery(query) {
  return !lockedBulkDeleteQuerySchema.safeParse(query || {}).success;
}

/**
 * Validates the destructive confirmation body.
 *
 * Purpose: keep route handling explicit and fail closed before any service call
 * if the required confirmation phrase is missing, wrong, or mixed with extra
 * client-controlled fields.
 *
 * @param {object|null|undefined} body - Parsed request body.
 * @returns {boolean} True when the confirmation body is valid.
 */
function hasValidConfirmationBody(body) {
  return lockedBulkDeleteBodySchema.safeParse(body || {}).success;
}

/**
 * Sends a public API response for locked bulk-delete failures.
 *
 * Purpose: map storage-status ambiguity and not-allowed states to stable public
 * codes while hiding internal database details from clients.
 *
 * @param {import('next').NextApiResponse} res - API response object.
 * @param {Error|object|string|null|undefined} error - Service-layer error.
 * @returns {object} Next.js response chain.
 */
function sendLockedBulkDeleteError(res, error) {
  switch (error?.code) {
    case STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE:
      setLockedBulkDeleteRetryAfter(res);
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);

    case STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING:
      setLockedBulkDeleteRetryAfter(res);
      return sendError(
        res,
        503,
        STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING,
        ERROR_MESSAGES.BILLING_RECONCILIATION_PENDING
      );

    case JOB_STORAGE_ERRORS.LOCKED_BULK_DELETE_NOT_ALLOWED:
      return sendError(
        res,
        409,
        JOB_STORAGE_ERRORS.LOCKED_BULK_DELETE_NOT_ALLOWED,
        ERROR_MESSAGES.LOCKED_BULK_DELETE_NOT_ALLOWED
      );

    default:
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }
}

/**
 * Deletes the authenticated user's locked overflow archive after confirmation.
 *
 * Purpose: provide the Chunk 10 convenience action without accepting a user id,
 * returning locked row fields, or allowing non-terminal billing states to run a
 * destructive storage operation.
 *
 * @param {import('next').NextApiRequest & { _rateLimitUser: { id: string }, log: object }} req - Authenticated request.
 * @param {import('next').NextApiResponse} res - API response object.
 * @returns {Promise<object|void>} API response chain.
 */
async function handler(req, res) {
  setLockedBulkDeleteCacheHeaders(res);

  if (hasInvalidQuery(req.query)) {
    return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
  }

  if (!hasValidConfirmationBody(req.body)) {
    return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
  }

  const deleteResult = await deleteLockedJobsForTerminalFreeUser(
    req._rateLimitUser.id,
    req.log
  );

  if (deleteResult.error || !deleteResult.data) {
    return sendLockedBulkDeleteError(res, deleteResult.error);
  }

  return sendSuccess(
    res,
    200,
    { deletedCount: deleteResult.data.deletedCount },
    'Locked archive deleted successfully'
  );
}

export default withRateLimit(handler, {
  requireAuth: true,
  operation: OPERATIONS.BULK_DELETE_LOCKED_JOBS,
  allowedMethods: ['DELETE'],
});
