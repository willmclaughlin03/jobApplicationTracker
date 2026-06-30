-- Consolidate jobs storage summary counts into one service-role RPC.
--
-- Purpose:
--   - replace three sequential count-only jobs queries with one owner-scoped
--     aggregate for dashboard and storage-status metadata
--   - keep locked rows count-only so this path never exposes hidden job fields
--   - preserve the service-role-only database boundary used by storage RPCs

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'public.jobs must exist before applying storage counts migration'
      USING ERRCODE = '42P01';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.jobs'::regclass
      AND attname = 'user_id'
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.jobs'::regclass
      AND attname = 'storage_state'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'public.jobs must include user_id and storage_state before applying storage counts migration'
      USING ERRCODE = '42703';
  END IF;
END;
$$;

-- get_job_storage_counts_for_user(...)
--
-- Permission model:
--   - SECURITY INVOKER with a pinned search_path
--   - execute revoked from PUBLIC, anon, and authenticated
--   - execute granted only to service_role
CREATE OR REPLACE FUNCTION public.get_job_storage_counts_for_user(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_count integer;
  locked_count integer;
  retained_total_count integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required'
      USING ERRCODE = '23502';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE storage_state = 'active')::integer,
    COUNT(*) FILTER (WHERE storage_state = 'locked_over_plan_limit')::integer,
    COUNT(*)::integer
  INTO active_count, locked_count, retained_total_count
  FROM public.jobs
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'activeCount', active_count,
    'lockedCount', locked_count,
    'retainedTotalCount', retained_total_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_job_storage_counts_for_user(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_job_storage_counts_for_user(uuid)
  TO service_role;
