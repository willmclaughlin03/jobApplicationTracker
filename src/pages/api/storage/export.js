import { z } from 'zod';
import { sendError } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { getJobsCsvExportForUser } from '../../../server/services/jobExportService.js';

const EXPORT_FILENAME = 'job-applications-export.csv';

/**
 * Validates query parameters for GET /api/storage/export.
 *
 * Purpose: reject all client-controlled query params because export ownership
 * and scope come only from authenticated middleware context.
 */
const storageExportQuerySchema = z.object({}).strict();

/**
 * Applies no-store headers to storage export responses.
 *
 * Purpose: exports contain user-entered job data and should never be cached by
 * browsers, intermediaries, or CDN layers.
 *
 * @param {import('next').NextApiResponse} res - API response object.
 * @returns {void}
 */
function setStorageExportCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Cookie');
}

/**
 * Applies CSV download headers for successful export responses.
 *
 * Purpose: tell browsers to save the response as a CSV file instead of trying
 * to render the content inline as ordinary text.
 *
 * @param {import('next').NextApiResponse} res - API response object.
 * @returns {void}
 */
function setCsvDownloadHeaders(res) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${EXPORT_FILENAME}"`
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/**
 * Checks whether the export route received unsupported query parameters.
 *
 * Purpose: the endpoint derives ownership only from authenticated middleware
 * context, so client-supplied user ids or filters are rejected at the boundary.
 *
 * @param {object|null|undefined} query - Next.js parsed query object.
 * @returns {boolean} True when any query key was supplied.
 */
function hasUnexpectedQueryParams(query) {
  return !storageExportQuerySchema.safeParse(query || {}).success;
}

/**
 * Sends the CSV payload as a file download.
 *
 * Purpose: keep the route handler's success response explicit because this
 * endpoint intentionally does not use the standard JSON response envelope.
 *
 * @param {import('next').NextApiResponse} res - API response object.
 * @param {string} csv - Serialized CSV content.
 * @returns {object} Next.js response chain.
 */
function sendCsvExport(res, csv) {
  setCsvDownloadHeaders(res);
  return res.status(200).send(csv);
}

/**
 * Returns a CSV export for all jobs owned by the authenticated user.
 *
 * Purpose: provide the explicit data-portability path for active and locked
 * jobs without exposing hidden locked fields through ordinary list/detail APIs.
 *
 * @param {import('next').NextApiRequest & { _rateLimitUser: { id: string }, log: object }} req - Authenticated request.
 * @param {import('next').NextApiResponse} res - API response object.
 * @returns {Promise<object|void>} API response chain.
 */
async function handler(req, res) {
  setStorageExportCacheHeaders(res);

  if (hasUnexpectedQueryParams(req.query)) {
    return sendError(
      res,
      400,
      'VALIDATION_ERROR',
      ERROR_MESSAGES.VALIDATION_ERROR
    );
  }

  const exportResult = await getJobsCsvExportForUser(
    req._rateLimitUser.id,
    req.log
  );

  const csv = exportResult?.data?.csv;

  if (exportResult?.error || typeof csv !== 'string') {
    return sendError(
      res,
      503,
      'EXPORT_FAILED',
      ERROR_MESSAGES.EXPORT_FAILED
    );
  }

  return sendCsvExport(res, csv);
}

export default withRateLimit(handler, {
  requireAuth: true,
  operation: OPERATIONS.STORAGE_EXPORT,
  allowedMethods: ['GET'],
});
