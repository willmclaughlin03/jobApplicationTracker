import { ERROR_MESSAGES } from '../../shared/errors.js';
import { getUserFromRequest } from '../../server/lib/supabaseServer.js';
import { jobUpdateSchema, uuidSchema } from '../../shared/validations/jobSchema.js';
import { sendSuccess, sendError } from '../../shared/response.js';
import { getJobById, updateJob, deleteJob } from '../../server/services/jobService.js';
import { logger } from '../../shared/logger.js';

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
  const { data, error } = await getJobById(jobId, user.id);

  if (error || !data) {
    return sendError(res, 404, ERROR_MESSAGES.NOT_FOUND, 'Job not found');
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
    return sendError(
      res,
      400,
      ERROR_MESSAGES.UPDATE_FAILED,
      updateResult.error.issues.map((i) => i.message).join(', ')
    );
  }

  const updatedData = updateResult.data;
  const { data, error } = await updateJob(jobId, updatedData, user.id);

  if (error || !data) {
    return sendError(res, 404, ERROR_MESSAGES.NOT_FOUND, 'Job not found');
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
  const { data, error } = await deleteJob(jobId, user.id);

  if (error || !data) {
    return sendError(res, 404, ERROR_MESSAGES.NOT_FOUND, 'Job not found');
  }

  return sendSuccess(res, 200, data, 'Successfully deleted job');
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
export default async function handler(req, res) {
  const { id } = req.query;

  // Validate UUID format FIRST (before auth to reject malformed IDs early)
  if (!id || !validateUUID(id)) {
    logger.warn('Invalid job ID format attempted', {
      operation: 'handler',
      id: id || 'empty',
      method: req.method,
    });
    return sendError(res, 400, ERROR_MESSAGES.INVALID_ID, 'Invalid job ID format');
  }

  // Authenticate user via JWT
  let user = null;
  try {
    const authResult = await getUserFromRequest(req);
    user = authResult.user;

    if (!user) {
      return sendError(res, 401, ERROR_MESSAGES.UNAUTHORIZED, 'Unauthorized');
    }
  } catch (error) {
    logger.error('Authentication error', {
      operation: 'handler',
      error: error.message,
    });
    return sendError(res, 401, ERROR_MESSAGES.UNAUTHORIZED, 'Unauthorized');
  }

  // Route to appropriate handler based on HTTP method
  switch (req.method) {
    case 'GET':
      return await handleGet(req, res, user, id);

    case 'PUT':
      return await handlePut(req, res, user, id);

    case 'DELETE':
      return await handleDelete(req, res, user, id);

    default:
      return sendError(res, 405, ERROR_MESSAGES.METHOD_NOT_ALLOWED, 'Method not allowed');
  }
}
