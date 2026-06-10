-- Add server-owned storage state fields and narrow direct jobs table access.
--
-- Purpose:
--   - preserve premium overflow rows in place before later chunks lock them
--   - make lock metadata database-validated instead of client-controlled
--   - establish the Chunk 2 enforcement boundary: normal application routes
--     use server-owned service-role access, while authenticated clients cannot
--     directly read or mutate full jobs rows through the table
--
-- Prerequisite:
--   public.jobs must already exist in the target live schema. The historical
--   base jobs migration is not replayable from the current repo state.

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'public.jobs must exist before applying jobs storage-state migration'
      USING ERRCODE = '42P01';
  END IF;
END;
$$;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS storage_state text;

ALTER TABLE public.jobs
  ALTER COLUMN storage_state SET DEFAULT 'active';

UPDATE public.jobs
SET storage_state = 'active'
WHERE storage_state IS NULL;

ALTER TABLE public.jobs
  ALTER COLUMN storage_state SET NOT NULL;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_reason text,
  ADD COLUMN IF NOT EXISTS locked_policy_version text;

ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_storage_state_allowed_check,
  DROP CONSTRAINT IF EXISTS jobs_locked_reason_allowed_check,
  DROP CONSTRAINT IF EXISTS jobs_locked_policy_version_format_check,
  DROP CONSTRAINT IF EXISTS jobs_locked_metadata_consistency_check;

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_storage_state_allowed_check
    CHECK (storage_state IN ('active', 'locked_over_plan_limit')),
  ADD CONSTRAINT jobs_locked_reason_allowed_check
    CHECK (
      locked_reason IS NULL
      OR locked_reason IN ('premium_to_free_over_plan_limit')
    ),
  ADD CONSTRAINT jobs_locked_policy_version_format_check
    CHECK (
      locked_policy_version IS NULL
      OR (
        char_length(pg_catalog.btrim(locked_policy_version)) > 0
        AND char_length(locked_policy_version) <= 120
      )
    ),
  ADD CONSTRAINT jobs_locked_metadata_consistency_check
    CHECK (
      (
        storage_state = 'active'
        AND locked_at IS NULL
        AND locked_reason IS NULL
        AND locked_policy_version IS NULL
      )
      OR (
        storage_state = 'locked_over_plan_limit'
        AND locked_at IS NOT NULL
        AND locked_reason IS NOT NULL
        AND locked_policy_version IS NOT NULL
      )
    );

CREATE INDEX IF NOT EXISTS jobs_user_retained_count_idx
  ON public.jobs (user_id);

CREATE INDEX IF NOT EXISTS jobs_active_count_idx
  ON public.jobs (user_id)
  WHERE storage_state = 'active';

CREATE INDEX IF NOT EXISTS jobs_locked_count_idx
  ON public.jobs (user_id)
  WHERE storage_state = 'locked_over_plan_limit';

CREATE INDEX IF NOT EXISTS jobs_active_lock_selection_idx
  ON public.jobs (
    user_id,
    (
      CASE
        WHEN status IN ('offered', 'interviewing', 'applied') THEN 0
        ELSE 1
      END
    ),
    created_at DESC,
    id DESC
  )
  WHERE storage_state = 'active';

CREATE INDEX IF NOT EXISTS jobs_locked_bulk_delete_idx
  ON public.jobs (user_id, created_at, id)
  WHERE storage_state = 'locked_over_plan_limit';

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jobs TO service_role;
