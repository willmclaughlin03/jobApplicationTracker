-- Add atomic job creation quota enforcement.
--
-- Purpose:
--   - replace route/service count-then-insert job creation with one
--     transaction-scoped database operation
--   - enforce active and retained caps against the server-owned jobs boundary
--   - serialize concurrent creates for one user so double-clicks and retries
--     cannot overshoot Free active or absolute retained limits

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'public.jobs must exist before applying atomic jobs create quota migration'
      USING ERRCODE = '42P01';
  END IF;
END;
$$;

-- create_job_with_storage_quota(...)
--
-- Ordering semantics:
--   - takes an advisory transaction lock scoped to the user and jobs-create
--     operation before reading counts
--   - counts active and retained rows inside the same transaction before insert
--   - inserts the new active row only when the storage status and both limits
--     allow creation
--
-- Permission model:
--   - SECURITY INVOKER with a pinned search_path
--   - execute revoked from PUBLIC, anon, and authenticated
--   - execute granted only to service_role
CREATE OR REPLACE FUNCTION public.create_job_with_storage_quota(
  p_user_id uuid,
  p_job_data jsonb,
  p_storage_status text,
  p_active_job_limit integer,
  p_absolute_retained_job_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_count integer;
  retained_count integer;
  effective_active_limit integer;
  created_job public.jobs%ROWTYPE;
  normalized_storage_status text;
BEGIN
  normalized_storage_status := pg_catalog.btrim(p_storage_status);

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required'
      USING ERRCODE = '23502';
  END IF;

  IF p_job_data IS NULL OR jsonb_typeof(p_job_data) <> 'object' THEN
    RAISE EXCEPTION 'job_data must be a json object'
      USING ERRCODE = '22023';
  END IF;

  IF p_active_job_limit IS NULL OR p_active_job_limit <= 0 THEN
    RAISE EXCEPTION 'active job limit must be positive'
      USING ERRCODE = '22023';
  END IF;

  IF p_absolute_retained_job_limit IS NULL OR p_absolute_retained_job_limit <= 0 THEN
    RAISE EXCEPTION 'absolute retained job limit must be positive'
      USING ERRCODE = '22023';
  END IF;

  IF p_active_job_limit > p_absolute_retained_job_limit THEN
    RAISE EXCEPTION 'active job limit cannot exceed retained job limit'
      USING ERRCODE = '22023';
  END IF;

  IF normalized_storage_status IS NULL
     OR normalized_storage_status = ''
     OR normalized_storage_status NOT IN ('premium_active', 'premium_canceling', 'terminal_free') THEN
    RETURN jsonb_build_object(
      'created', false,
      'code', 'STORAGE_CREATE_STATUS_NOT_ALLOWED',
      'reason', 'storage_status_not_allowed',
      'storageStatus', normalized_storage_status
    );
  END IF;

  effective_active_limit := CASE
    WHEN normalized_storage_status = 'terminal_free'
      THEN p_active_job_limit
    ELSE p_absolute_retained_job_limit
  END;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext('jobs_create_quota'));

  SELECT COUNT(*)::integer
  INTO active_count
  FROM public.jobs
  WHERE user_id = p_user_id
    AND storage_state = 'active';

  SELECT COUNT(*)::integer
  INTO retained_count
  FROM public.jobs
  WHERE user_id = p_user_id;

  IF active_count >= effective_active_limit THEN
    RETURN jsonb_build_object(
      'created', false,
      'code', 'STORAGE_LIMIT_EXCEEDED',
      'reason', 'active_limit_exceeded',
      'activeCount', active_count,
      'retainedTotalCount', retained_count,
      'activeLimit', effective_active_limit,
      'absoluteRetainedLimit', p_absolute_retained_job_limit
    );
  END IF;

  IF retained_count >= p_absolute_retained_job_limit THEN
    RETURN jsonb_build_object(
      'created', false,
      'code', 'STORAGE_LIMIT_EXCEEDED',
      'reason', 'retained_limit_exceeded',
      'activeCount', active_count,
      'retainedTotalCount', retained_count,
      'activeLimit', effective_active_limit,
      'absoluteRetainedLimit', p_absolute_retained_job_limit
    );
  END IF;

  WITH incoming AS (
    SELECT *
    FROM jsonb_to_record(p_job_data) AS incoming(
      company text,
      position text,
      status text,
      notes text,
      salary_min integer,
      salary_max integer,
      status_date timestamptz
    )
  )
  INSERT INTO public.jobs (
    user_id,
    company,
    position,
    status,
    notes,
    salary_min,
    salary_max,
    status_date,
    storage_state
  )
  SELECT
    p_user_id,
    incoming.company,
    incoming.position,
    incoming.status,
    incoming.notes,
    incoming.salary_min,
    incoming.salary_max,
    incoming.status_date,
    'active'
  FROM incoming
  RETURNING * INTO created_job;

  RETURN jsonb_build_object(
    'created', true,
    'job', to_jsonb(created_job),
    'activeCountBeforeCreate', active_count,
    'retainedTotalCountBeforeCreate', retained_count,
    'activeLimit', effective_active_limit,
    'absoluteRetainedLimit', p_absolute_retained_job_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_job_with_storage_quota(uuid, jsonb, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_job_with_storage_quota(uuid, jsonb, text, integer, integer)
  TO service_role;
