import { ERROR_MESSAGES } from '../../shared/errors.js';
import { getUserFromRequest } from '../../server/lib/supabaseServer.js';
import { jobSchema, jobUpdateSchema } from '../../shared/validations/jobSchema.js';
import { sendSuccess, sendError } from '../../shared/response.js';
import { getJobsByUserId, createJob, updateJob, deleteJob } from '../../server/services/jobService.js';

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
 * Handles PUT requests - updates an existing job application
 *
 * Purpose: Update job application details (status, notes, etc.)
 * Connects to: jobService.updateJob() for database operations
 * Validation: Uses jobUpdateSchema to validate request body
 * Security: jobService validates user ownership of the job
 */
async function handlePut(req, res, user) {
  const { id, ...bodyWithoutId } = req.body;

  if (!id) {
    return sendError(res, 400, ERROR_MESSAGES.NOT_FOUND, 'ID not found');
  }

  const updateResult = jobUpdateSchema.safeParse(bodyWithoutId);

  if (!updateResult.success) {
    return sendError(res, 400, ERROR_MESSAGES.UPDATE_FAILED, 'Update failed');
  }

  const updatedData = updateResult.data;
  const { data, error } = await updateJob(id, updatedData, user.id);

  if (error) {
    return sendError(res, 400, ERROR_MESSAGES.UPDATE_FAILED, 'Failed to update job data');
  }

  return sendSuccess(res, 200, data, 'Successfully updated job details');
}

/**
 * Handles DELETE requests - removes an existing job application
 *
 * Purpose: Delete job application from user's tracking list
 * Connects to: jobService.deleteJob() for database operations
 * Security: jobService validates user ownership of the job
 */
async function handleDelete(req, res, user) {
  const { id } = req.body;

  if (!id) {
    return sendError(res, 400, ERROR_MESSAGES.NOT_FOUND, 'ID not found');
  }

  const { data, error } = await deleteJob(id, user.id);

  if (error) {
    return sendError(res, 400, ERROR_MESSAGES.DELETE_FAILED, 'Failed to delete job');
  }

  return sendSuccess(res, 200, data, 'Successfully deleted job');
}

/**
 * Main request handler with authentication and routing
 *
 * Purpose: Entry point for /api/jobs endpoint
 * Connects to:
 * - getUserFromRequest() for authentication
 * - handleGet/handlePost/handlePut for specific operations
 *
 * Security: Validates user authentication before processing requests
 */
export default async function handler(req, res) {
  let user = null;

  try {
    const authResult = await getUserFromRequest(req);
    user = authResult.user;

    if (!user) {
      return sendError(res, 401, ERROR_MESSAGES.UNAUTHORIZED, 'Unauthorized');
    }
  } catch (error) {
    return sendError(res, 401, ERROR_MESSAGES.UNAUTHORIZED, 'Unauthorized');
  }

  switch (req.method) {
    case 'GET':
      return await handleGet(req, res, user);

    case 'POST':
      return await handlePost(req, res, user);

    case 'PUT':
      return await handlePut(req, res, user);

    case 'DELETE':
      return await handleDelete(req, res, user);

    default:
      return sendError(res, 405, ERROR_MESSAGES.METHOD_NOT_ALLOWED, 'Method not allowed');
  }
}
