import { sendError, sendSuccess } from '../../../shared/response.js';
import { ERROR_MESSAGES } from '../../../shared/errors.js';
import { withRateLimit } from '../../../server/middleware/withRateLimit.js';
import { OPERATIONS } from '../../../shared/constants/tiers.js';
import { getStorageSummaryForUser } from '../../../server/services/storageSummaryService.js';

/**
 * Apply no-store headers to authenticated storage-status responses.
 *
 * Purpose: storage summary combines user-owned counts and billing timing, both
 * of which can change immediately after job or billing activity.
 *
 * @param {import('next').NextApiResponse} res - API response object.
 * @returns {void}
 */
function setStorageStatusCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Cookie');
}

/**
 * Return count-only storage summary metadata for the authenticated caller.
 *
 * Purpose: billing/settings surfaces need storage state and limits without
 * loading dashboard jobs or exposing locked job details.
 *
 * @param {import('next').NextApiRequest & { _rateLimitUser: { id: string }, _supabaseClient: object, log: object }} req - Authenticated request.
 * @param {import('next').NextApiResponse} res - API response object.
 * @returns {Promise<void>}
 */
async function handler(req, res) {
  setStorageStatusCacheHeaders(res);

  const storageSummaryResult = await getStorageSummaryForUser(
    req._rateLimitUser.id,
    req._supabaseClient,
    req.log
  );

  if (storageSummaryResult.error) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }

  return sendSuccess(
    res,
    200,
    storageSummaryResult.data,
    'Storage status retrieved successfully'
  );
}

export default withRateLimit(handler, {
  requireAuth: true,
  operation: OPERATIONS.BILLING_READ,
  allowedMethods: ['GET'],
});
