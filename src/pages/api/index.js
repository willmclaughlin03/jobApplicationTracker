import { ERROR_MESSAGES } from '../../shared/errors.js';
import { jobSchema, getQuerySchema } from '../../shared/validations/jobSchema.js';
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
  const queryResult = getQuerySchema.safeParse(req.query);

  if (!queryResult.success) {
    return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
  }

  const { from, to, status } = queryResult.data;

  const options = {};

  if (from !== undefined && to !== undefined) {
    options.from = from;
    options.to = to;
  }

  if (status) {
    options.status = status;
  }

  const { data, count, error } = await getJobsByUserId(user.id, options, req._supabaseClient);

  if (error) {
    return sendError(res, 503, 'FETCH_FAILED', ERROR_MESSAGES.FETCH_FAILED);
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
    return sendError(res, 400, 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
  }

  const finalizedData = createResult.data;
  finalizedData.status_date = new Date().toISOString();
  const { data, error } = await createJob(finalizedData, user.id, req._supabaseClient);

  if (error) {
    if (error.code === 'STORAGE_LIMIT_EXCEEDED') {
      return sendError(res, 409, 'STORAGE_LIMIT_EXCEEDED', ERROR_MESSAGES.STORAGE_LIMIT_EXCEEDED);
    }
    return sendError(res, 400, 'ADD_FAILED', ERROR_MESSAGES.ADD_FAILED);
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
