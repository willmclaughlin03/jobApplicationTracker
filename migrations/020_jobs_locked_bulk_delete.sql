-- Add idempotent bulk deletion for locked overflow jobs.
--
-- Purpose:
--   - let confirmed terminal-Free users intentionally remove their locked
--     archive without exposing locked job fields through API responses
--   - keep the delete bounded by the v1 retained-overflow maximum
--   - re-check canonical billing state inside the database before mutating rows

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'public.jobs must exist before applying locked bulk delete migration'
      USING ERRCODE = '42P01';
  END IF;

  IF pg_catalog.to_regprocedure('public.resolve_canonical_storage_status_for_user(uuid)') IS NULL THEN
    RAISE EXCEPTION 'resolve_canonical_storage_status_for_user(uuid) must exist before applying locked bulk delete migration'
      USING ERRCODE = '42883';
  END IF;
END;
$$;

-- delete_locked_jobs_for_terminal_free_user(...)
--
-- Ordering semantics:
--   - rechecks canonical local billing while holding the shared billing/storage
--     advisory lock inside resolve_canonical_storage_status_for_user()
--   - takes the same per-user jobs_create_quota advisory lock as create,
--     downgrade locking, and Premium restore before deleting locked rows
--   - deletes only rows already marked locked_over_plan_limit
--   - limits one call to p_locked_delete_limit rows using the locked bulk
--     delete index order, making retries idempotent and active-row safe
--
-- Permission model:
--   - SECURITY INVOKER with a pinned search_path
--   - execute revoked from PUBLIC, anon, and authenticated
--   - execute granted only to service_role
CREATE OR REPLACE FUNCTION public.delete_locked_jobs_for_terminal_free_user(
  p_user_id uuid,
  p_storage_status text,
  p_locked_delete_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  normalized_storage_status text;
  canonical_storage_status text;
  locked_count_before integer;
  locked_count_after integer;
  deleted_count integer;
BEGIN
  normalized_storage_status := NULLIF(pg_catalog.btrim(p_storage_status), '');

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required'
      USING ERRCODE = '23502';
  END IF;

  IF p_locked_delete_limit IS NULL OR p_locked_delete_limit <= 0 THEN
    RAISE EXCEPTION 'locked delete limit must be positive'
      USING ERRCODE = '22023';
  END IF;

  IF normalized_storage_status IS NULL
     OR normalized_storage_status <> 'terminal_free' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'storage_status_not_delete_eligible',
      'storageStatus', normalized_storage_status,
      'deletedCount', 0
    );
  END IF;

  canonical_storage_status :=
    public.resolve_canonical_storage_status_for_user(p_user_id);

  IF canonical_storage_status IS DISTINCT FROM normalized_storage_status THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'canonical_billing_not_terminal_free',
      'storageStatus', normalized_storage_status,
      'canonicalStorageStatus', canonical_storage_status,
      'deletedCount', 0
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext('jobs_create_quota'));

  SELECT COUNT(*)::integer
  INTO locked_count_before
  FROM public.jobs
  WHERE user_id = p_user_id
    AND storage_state = 'locked_over_plan_limit';

  WITH rows_to_delete AS (
    SELECT id
    FROM public.jobs
    WHERE user_id = p_user_id
      AND storage_state = 'locked_over_plan_limit'
    ORDER BY created_at ASC, id ASC
    LIMIT p_locked_delete_limit
  ),
  deleted_rows AS (
    DELETE FROM public.jobs AS jobs
    USING rows_to_delete
    WHERE jobs.id = rows_to_delete.id
      AND jobs.user_id = p_user_id
      AND jobs.storage_state = 'locked_over_plan_limit'
    RETURNING jobs.id
  )
  SELECT COUNT(*)::integer
  INTO deleted_count
  FROM deleted_rows;

  SELECT COUNT(*)::integer
  INTO locked_count_after
  FROM public.jobs
  WHERE user_id = p_user_id
    AND storage_state = 'locked_over_plan_limit';

  RETURN jsonb_build_object(
    'applied', true,
    'deletedCount', deleted_count,
    'lockedCountBeforeDelete', locked_count_before,
    'lockedCountAfterDelete', locked_count_after,
    'lockedDeleteLimit', p_locked_delete_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_locked_jobs_for_terminal_free_user(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_locked_jobs_for_terminal_free_user(uuid, text, integer)
  TO service_role;
