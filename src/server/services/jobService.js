/**
 * Job Service - Database operations for jobs
 *
 * Purpose: Encapsulate all job-related database operations with error handling
 * Connects to:
 * - supabaseAdmin for database queries
 * - logger for structured error logging
 *
 * Security: All operations validate user ownership via user_id matching
 */
import { supabaseAdmin } from '../lib/supabaseServer.js';
import { logger } from '../../shared/logger.js';

/**
 * Retrieves jobs for a specific user with optional pagination and filtering
 *
 * @param {string} userId - The user's ID
 * @param {Object} options - Optional query parameters
 * @param {number} options.from - Start index for pagination
 * @param {number} options.to - End index for pagination
 * @param {string} options.status - Filter by job status
 * @returns {Promise<{data: Array|null, count: number, error: Error|null}>}
 *
 * Security: Only returns jobs where user_id matches the authenticated user
 */
export async function getJobsByUserId(userId, options = {}) {
  try {
    const { from, to, status } = options;

    let query = supabaseAdmin
      .from('jobs')
      .select('*', { count: 'exact' })
      .eq('user_id', userId);

    if (status) {
      query = query.eq('status', status);
    }

    query = query.order('created_at', { ascending: false });

    if (from !== undefined && to !== undefined) {
      query = query.range(from, to);
    }

    const { data, error, count } = await query;

    if (error) {
      logger.error('Database query failed', {
        operation: 'getJobsByUserId',
        userId,
        error: error.message,
      });
      return { data: null, count: 0, error };
    }

    logger.debug('Jobs retrieved successfully', {
      operation: 'getJobsByUserId',
      userId,
      count: data?.length || 0,
      totalCount: count,
    });

    return { data, count: count || 0, error: null };
  } catch (error) {
    logger.error('Unexpected error in getJobsByUserId', {
      operation: 'getJobsByUserId',
      userId,
      error: error.message,
      stack: error.stack,
    });
    return { data: null, count: 0, error };
  }
}

/**
 * Retrieves a single job by ID for a specific user
 *
 * Purpose: Fetch a specific job application by its UUID
 * Connects to: supabaseAdmin for database queries
 *
 * @param {string} jobId - The job's UUID
 * @param {string} userId - The user's ID
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Enforces user ownership by requiring user_id match
 * - Returns null if job doesn't exist OR user doesn't own it (prevents enumeration)
 */
export async function getJobById(jobId, userId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();

    if (error) {
      // PGRST116 = "No rows found" - treat as not found, not as error
      if (error.code === 'PGRST116') {
        logger.debug('Job not found or unauthorized', {
          operation: 'getJobById',
          userId,
          jobId,
        });
        return { data: null, error: new Error('Job not found or unauthorized') };
      }

      logger.error('Database query failed', {
        operation: 'getJobById',
        userId,
        jobId,
        error: error.message,
      });
      return { data: null, error };
    }

    logger.debug('Job retrieved successfully', {
      operation: 'getJobById',
      userId,
      jobId,
    });

    return { data, error: null };
  } catch (error) {
    logger.error('Unexpected error in getJobById', {
      operation: 'getJobById',
      userId,
      jobId,
      error: error.message,
      stack: error.stack,
    });
    return { data: null, error };
  }
}

/**
 * Creates a new job for a user
 *
 * @param {Object} jobData - The job data to insert (validated by jobSchema)
 * @param {string} userId - The user's ID
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Associates job with user_id to enforce ownership
 */
export async function createJob(jobData, userId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .insert({ ...jobData, user_id: userId })
      .select();

    if (error) {
      logger.error('Failed to create job', {
        operation: 'createJob',
        userId,
        error: error.message,
      });
      return { data: null, error };
    }

    logger.info('Job created successfully', {
      operation: 'createJob',
      userId,
      jobId: data?.[0]?.id,
    });

    return { data, error: null };
  } catch (error) {
    logger.error('Unexpected error in createJob', {
      operation: 'createJob',
      userId,
      error: error.message,
      stack: error.stack,
    });
    return { data: null, error };
  }
}

/**
 * Updates an existing job
 *
 * @param {string} jobId - The job ID to update
 * @param {Object} updateData - The fields to update (validated by jobUpdateSchema)
 * @param {string} userId - The user's ID
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Enforces user ownership by requiring user_id match
 * - This prevents users from updating jobs they don't own
 */
export async function updateJob(jobId, updateData, userId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .update(updateData)
      .eq('id', jobId)
      .eq('user_id', userId)
      .select('*');

    if (error) {
      logger.error('Failed to update job', {
        operation: 'updateJob',
        userId,
        jobId,
        error: error.message,
      });
      return { data: null, error };
    }

    // Check if no rows were updated (job doesn't exist or user doesn't own it)
    if (!data || data.length === 0) {
      logger.warn('Update failed - job not found or unauthorized', {
        operation: 'updateJob',
        userId,
        jobId,
      });
      return { data: null, error: new Error('Job not found or unauthorized') };
    }

    logger.info('Job updated successfully', {
      operation: 'updateJob',
      userId,
      jobId,
    });

    return { data, error: null };
  } catch (error) {
    logger.error('Unexpected error in updateJob', {
      operation: 'updateJob',
      userId,
      jobId,
      error: error.message,
      stack: error.stack,
    });
    return { data: null, error };
  }
}

/**
 * Deletes an existing job
 *
 * @param {string} jobId - The job ID to delete
 * @param {string} userId - The user's ID
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Enforces user ownership by requiring user_id match
 * - This prevents users from deleting jobs they don't own
 */
export async function deleteJob(jobId, userId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .delete()
      .eq('id', jobId)
      .eq('user_id', userId)
      .select();

    if (error) {
      logger.error('Failed to delete job', {
        operation: 'deleteJob',
        userId,
        jobId,
        error: error.message,
      });
      return { data: null, error };
    }

    if (!data || data.length === 0) {
      logger.warn('Delete failed - job not found or unauthorized', {
        operation: 'deleteJob',
        userId,
        jobId,
      });
      return { data: null, error: new Error('Job not found or unauthorized') };
    }

    logger.info('Job deleted successfully', {
      operation: 'deleteJob',
      userId,
      jobId,
    });

    return { data: data[0], error: null };
  } catch (error) {
    logger.error('Unexpected error in deleteJob', {
      operation: 'deleteJob',
      userId,
      jobId,
      error: error.message,
      stack: error.stack,
    });
    return { data: null, error };
  }
}
