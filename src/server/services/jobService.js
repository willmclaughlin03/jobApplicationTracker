/**
 * Job Service - Database operations for jobs
 *
 * Purpose: Encapsulate all job-related database operations with error handling
 * Connects to:
 * - supabaseAdmin for privileged operations (storage limit count — bypasses RLS)
 * - supabaseClient (per-request SSR client) for user-scoped queries (respects RLS)
 * - logger for structured error logging
 *
 * Security: All operations validate user ownership via user_id matching (app layer)
 * and are further enforced by RLS policies on the jobs table (database layer).
 */
import { supabaseAdmin } from '../lib/supabaseServer.js';
import { logger } from '../../shared/logger.js';
import { getStorargeLimitForTier, TIERS } from '../../shared/constants/tiers.js';
import { ERROR_MESSAGES } from '../../shared/errors.js';

/**
 * Retrieves jobs for a specific user with optional pagination and filtering
 *
 * @param {string} userId - The user's ID
 * @param {Object} options - Optional query parameters
 * @param {number} options.from - Start index for pagination
 * @param {number} options.to - End index for pagination
 * @param {string} options.status - Filter by job status
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient - Per-request SSR client (respects RLS)
 * @returns {Promise<{data: Array|null, count: number, error: Error|null}>}
 *
 * Security: Only returns jobs where user_id matches the authenticated user (app + RLS)
 */
export async function getJobsByUserId(userId, options = {}, supabaseClient) {
  try {
    const { from, to, status } = options;

    let query = supabaseClient
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
      logger.error({ err: error, operation: 'getJobsByUserId', userId }, 'Database query failed');
      return { data: null, count: 0, error };
    }

    return { data, count: count || 0, error: null };
  } catch (error) {
    logger.error({ err: error, operation: 'getJobsByUserId', userId }, 'Unexpected error in getJobsByUserId');
    return { data: null, count: 0, error };
  }
}

/**
 * Retrieves a single job by ID for a specific user
 *
 * Purpose: Fetch a specific job application by its UUID
 * Connects to: supabaseClient for database queries (respects RLS)
 *
 * @param {string} jobId - The job's UUID
 * @param {string} userId - The user's ID
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient - Per-request SSR client (respects RLS)
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Enforces user ownership by requiring user_id match (app + RLS)
 * - Returns null if job doesn't exist OR user doesn't own it (prevents enumeration)
 */
export async function getJobById(jobId, userId, supabaseClient) {
  try {
    const { data, error } = await supabaseClient
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();

    if (error) {
      // PGRST116 = "No rows found" - treat as not found, not as error
      if (error.code === 'PGRST116') {
        return { data: null, error: new Error('Job not found or unauthorized') };
      }

      logger.error({ err: error, operation: 'getJobById', userId, jobId }, 'Database query failed');
      return { data: null, error };
    }

    return { data, error: null };
  } catch (error) {
    logger.error({ err: error, operation: 'getJobById', userId, jobId }, 'Unexpected error in getJobById');
    return { data: null, error };
  }
}

/**
 * Creates a new job for a user
 *
 * Purpose: Insert a new job application, enforcing the per-user storage limit
 * Connects to:
 * - supabaseAdmin for count query (bypasses RLS — tamper-proof storage limit check)
 * - supabaseClient for insert (respects RLS)
 * - getStorargeLimitForTier to retrieve the maxJobs limit for the user's tier
 *
 * @param {Object} jobData - The job data to insert (validated by jobSchema)
 * @param {string} userId - The user's ID
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient - Per-request SSR client (respects RLS)
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Associates job with user_id to enforce ownership (app + RLS)
 * Storage: Rejects insert if user is at or over their tier's maxJobs limit
 */
export async function createJob(jobData, userId, supabaseClient) {
  try {
    // Check storage limit before inserting
    const { maxJobs } = getStorargeLimitForTier(TIERS.FREE);

    // Fail closed: if the tier config is broken, deny the insert rather than
    // silently allowing unlimited entries ((count ?? 0) >= undefined is false)
    if (typeof maxJobs !== 'number' || maxJobs <= 0) {
      logger.error({ operation: 'createJob', userId, maxJobs }, 'Storage limit configuration is invalid');
      return { data: null, error: new Error('Storage limit configuration is invalid') };
    }

    // TOCTOU note: There is a race window between the count check and the insert below.
    // Concurrent requests could both pass the check and exceed the 300-job limit by a few rows.
    // Accepted risk: the 30 req/hour rate limit makes concurrent exploitation extremely unlikely,
    // and the cap is a storage hygiene limit, not a billing or security boundary. Any overshoot
    // is self-correcting — subsequent requests will see the true count and block further inserts.
    // If this ever guards a financial or security-critical limit, replace with a Supabase RPC
    // (stored procedure) that performs the count + insert atomically in a single transaction.
    //
    // supabaseAdmin is used here intentionally — it bypasses RLS so the count reflects the
    // true row count regardless of the user's session state. This prevents a user from
    // manipulating their session to circumvent the storage limit.
    const { count, error: countError } = await supabaseAdmin
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (countError) {
      logger.error({ err: countError, operation: 'createJob', userId }, 'Failed to check job count before insert');
      return { data: null, error: countError };
    }

    if ((count ?? 0) >= maxJobs) {
      logger.warn({ operation: 'createJob', userId, count, maxJobs }, 'Storage limit reached');
      const limitError = Object.assign(
        new Error(ERROR_MESSAGES.STORAGE_LIMIT_EXCEEDED),
        { code: 'STORAGE_LIMIT_EXCEEDED' }
      );
      return { data: null, error: limitError };
    }

    const { data, error } = await supabaseClient
      .from('jobs')
      .insert({ ...jobData, user_id: userId })
      .select();

    if (error) {
      logger.error({ err: error, operation: 'createJob', userId }, 'Failed to create job');
      return { data: null, error };
    }

    logger.info({ operation: 'createJob', userId, jobId: data?.[0]?.id }, 'Job created successfully');

    return { data, error: null };
  } catch (error) {
    logger.error({ err: error, operation: 'createJob', userId }, 'Unexpected error in createJob');
    return { data: null, error };
  }
}

/**
 * Updates an existing job
 *
 * @param {string} jobId - The job ID to update
 * @param {Object} updateData - The fields to update (validated by jobUpdateSchema)
 * @param {string} userId - The user's ID
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient - Per-request SSR client (respects RLS)
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Enforces user ownership by requiring user_id match (app + RLS)
 * - This prevents users from updating jobs they don't own
 */
export async function updateJob(jobId, updateData, userId, supabaseClient) {
  try {
    const { data, error } = await supabaseClient
      .from('jobs')
      .update(updateData)
      .eq('id', jobId)
      .eq('user_id', userId)
      .select('*');

    if (error) {
      logger.error({ err: error, operation: 'updateJob', userId, jobId }, 'Failed to update job');
      return { data: null, error };
    }

    // Check if no rows were updated (job doesn't exist or user doesn't own it)
    if (!data || data.length === 0) {
      logger.warn({ operation: 'updateJob', userId, jobId }, 'Update failed - job not found or unauthorized');
      return { data: null, error: new Error('Job not found or unauthorized') };
    }

    return { data, error: null };
  } catch (error) {
    logger.error({ err: error, operation: 'updateJob', userId, jobId }, 'Unexpected error in updateJob');
    return { data: null, error };
  }
}

/**
 * Deletes an existing job
 *
 * @param {string} jobId - The job ID to delete
 * @param {string} userId - The user's ID
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient - Per-request SSR client (respects RLS)
 * @returns {Promise<{data: Object|null, error: Error|null}>}
 *
 * Security: Enforces user ownership by requiring user_id match (app + RLS)
 * - This prevents users from deleting jobs they don't own
 */
export async function deleteJob(jobId, userId, supabaseClient) {
  try {
    const { data, error } = await supabaseClient
      .from('jobs')
      .delete()
      .eq('id', jobId)
      .eq('user_id', userId)
      .select();

    if (error) {
      logger.error({ err: error, operation: 'deleteJob', userId, jobId }, 'Failed to delete job');
      return { data: null, error };
    }

    if (!data || data.length === 0) {
      logger.warn({ operation: 'deleteJob', userId, jobId }, 'Delete failed - job not found or unauthorized');
      return { data: null, error: new Error('Job not found or unauthorized') };
    }

    return { data: data[0], error: null };
  } catch (error) {
    logger.error({ err: error, operation: 'deleteJob', userId, jobId }, 'Unexpected error in deleteJob');
    return { data: null, error };
  }
}
