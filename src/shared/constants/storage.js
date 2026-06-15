/**
 * Storage policy constants for job retention and downgrade summaries.
 *
 * Purpose: Keep the paid-to-free storage degradation limits and storage-state
 * names in one shared module so API routes, services, and tests do not drift.
 */
export const FREE_ACTIVE_JOB_LIMIT = 300;

export const ABSOLUTE_RETAINED_JOB_LIMIT = 3000;

export const LOCKED_BULK_DELETE_ROW_LIMIT = ABSOLUTE_RETAINED_JOB_LIMIT - FREE_ACTIVE_JOB_LIMIT;

export const JOB_STORAGE_STATES = {
  ACTIVE: 'active',
  LOCKED_OVER_PLAN_LIMIT: 'locked_over_plan_limit',
};

export const JOB_STORAGE_LOCK_REASONS = {
  PREMIUM_TO_FREE_OVER_PLAN_LIMIT: 'premium_to_free_over_plan_limit',
};

export const JOB_STORAGE_LOCK_POLICY_VERSION = 'v1';

export const JOB_STORAGE_QUERY_STATES = {
  LOCKED: 'locked',
};

export const JOB_STORAGE_ERRORS = {
  JOB_LOCKED_BY_PLAN: 'JOB_LOCKED_BY_PLAN',
};
