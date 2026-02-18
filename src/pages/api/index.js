import { ERROR_MESSAGES } from '../../shared/errors.js';
import { jobSchema } from '../../shared/validations/jobSchema.js';
import { sendSuccess, sendError } from '../../shared/response.js';
import { getJobsByUserId, createJob } from '../../server/services/jobService.js';
import { withRateLimit } from '../../server/middleware/withRateLimit.js';

/**
 * Handles GET requests - retrieves jobs for authenticated user
 *
 * Purpose: Fetch user's job application history with optional pagination/filtering
 * Connects to: jobService.getJobsByUserId() for database operations
 * Query params: from, to (pagination), status (filter)
 */
async function handleGet(req, res, user) {
  const { from, to, status } = req.query;

  const options = {};

  if (from !== undefined && to !== undefined) {
    options.from = parseInt(from, 10);
    options.to = parseInt(to, 10);
  }

  if (status) {
    options.status = status;
  }

  const { data, count, error } = await getJobsByUserId(user.id, options);

  if (error) {
    return sendError(res, 503, ERROR_MESSAGES.FETCH_FAILED, 'Server unavailable');
  }

  return sendSuccess(res, 200, { data, count }, 'Jobs retrieved successfully');
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
    return sendError(
      res,
      400,
      ERROR_MESSAGES.VALIDATION_ERROR || 'VALIDATION_ERROR',
      createResult.error.issues.map((i) => i.message).join(', ')
    );
  }

  const finalizedData = createResult.data;
  const { data, error } = await createJob(finalizedData, user.id);

  if (error) {
    return sendError(res, 400, ERROR_MESSAGES.ADD_FAILED, 'Failed to add job data');
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
      return sendError(res, 405, ERROR_MESSAGES.METHOD_NOT_ALLOWED, 'Method not allowed')
  }

}

export default withRateLimit(handler, { requireAuth: true})
