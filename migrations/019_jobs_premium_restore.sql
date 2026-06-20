-- Add idempotent Premium restore for locked overflow jobs.
--
-- Purpose:
--   - restore preserved overflow rows when canonical Premium entitlement returns
--   - keep restore decisions behind the same service-role jobs boundary as lock
--     and create quota decisions
--   - serialize with job creates and downgrade locking so active counts cannot
--     race the Premium retained cap

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'public.jobs must exist before applying premium restore migration'
      USING ERRCODE = '42P01';
  END IF;

  IF pg_catalog.to_regprocedure('public.resolve_canonical_storage_status_for_user(uuid)') IS NULL THEN
    RAISE EXCEPTION 'resolve_canonical_storage_status_for_user(uuid) must exist before applying premium restore migration'
      USING ERRCODE = '42883';
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS jobs_locked_restore_selection_idx
  ON public.jobs (
    user_id,
    (
      CASE
        WHEN status = 'offered' THEN 0
        WHEN status = 'interviewing' THEN 1
        WHEN status = 'applied' THEN 2
        ELSE 3
      END
    ),
    created_at DESC,
    id DESC
  )
  WHERE storage_state = 'locked_over_plan_limit';

-- restore_locked_jobs_for_premium_user(...)
--
-- Ordering semantics:
--   - rechecks canonical local billing while holding the shared billing/storage
--     advisory lock inside resolve_canonical_storage_status_for_user()
--   - verifies the local subscription price_id against the server-provided
--     Premium price allowlist before treating a billing row as entitled
--   - takes the same per-user jobs_create_quota advisory lock as create and
--     downgrade locking before reading or mutating jobs
--   - restores locked rows by status priority, then created_at DESC, id DESC
--   - if historical retained rows exceed the Premium cap, restores only enough
--     rows to keep active rows at or below the absolute retained limit
--
-- Permission model:
--   - SECURITY INVOKER with a pinned search_path
--   - execute revoked from PUBLIC, anon, and authenticated
--   - execute granted only to service_role
CREATE OR REPLACE FUNCTION public.restore_locked_jobs_for_premium_user(
  p_user_id uuid,
  p_storage_status text,
  p_absolute_retained_job_limit integer,
  p_entitled_price_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  normalized_storage_status text;
  canonical_storage_status text;
  active_count_before integer;
  active_count_after integer;
  locked_count_before integer;
  locked_count_after integer;
  retained_total_count integer;
  restore_slots integer;
  restored_count integer;
  retained_over_limit boolean;
  subscription_price_id text;
  normalized_entitled_price_ids text[];
BEGIN
  normalized_storage_status := pg_catalog.btrim(p_storage_status);

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required'
      USING ERRCODE = '23502';
  END IF;

  IF p_absolute_retained_job_limit IS NULL OR p_absolute_retained_job_limit <= 0 THEN
    RAISE EXCEPTION 'absolute retained job limit must be positive'
      USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT allowed_price.normalized_price_id
    FROM (
      SELECT pg_catalog.btrim(price_id) AS normalized_price_id
      FROM pg_catalog.unnest(p_entitled_price_ids) AS allowed_price_id(price_id)
    ) AS allowed_price
    WHERE allowed_price.normalized_price_id <> ''
  )
  INTO normalized_entitled_price_ids;

  IF normalized_storage_status IS NULL
     OR normalized_storage_status NOT IN ('premium_active', 'premium_canceling') THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'storage_status_not_restore_eligible',
      'storageStatus', normalized_storage_status,
      'restoredCount', 0
    );
  END IF;

  IF normalized_entitled_price_ids IS NULL
     OR pg_catalog.array_length(normalized_entitled_price_ids, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'premium_price_allowlist_missing',
      'storageStatus', normalized_storage_status,
      'restoredCount', 0
    );
  END IF;

  canonical_storage_status :=
    public.resolve_canonical_storage_status_for_user(p_user_id);

  IF canonical_storage_status NOT IN ('premium_active', 'premium_canceling') THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'canonical_billing_not_premium',
      'storageStatus', normalized_storage_status,
      'canonicalStorageStatus', canonical_storage_status,
      'restoredCount', 0
    );
  END IF;

  SELECT pg_catalog.btrim(price_id)
  INTO subscription_price_id
  FROM public.billing_subscriptions
  WHERE user_id = p_user_id;

  IF subscription_price_id IS NULL
     OR subscription_price_id <> ALL(normalized_entitled_price_ids) THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'canonical_billing_not_premium',
      'storageStatus', normalized_storage_status,
      'canonicalStorageStatus', 'non_entitled_non_terminal',
      'canonicalEntitlementReason', 'price_id_not_allowlisted',
      'restoredCount', 0
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext('jobs_create_quota'));

  SELECT COUNT(*)::integer
  INTO active_count_before
  FROM public.jobs
  WHERE user_id = p_user_id
    AND storage_state = 'active';

  SELECT COUNT(*)::integer
  INTO locked_count_before
  FROM public.jobs
  WHERE user_id = p_user_id
    AND storage_state = 'locked_over_plan_limit';

  SELECT COUNT(*)::integer
  INTO retained_total_count
  FROM public.jobs
  WHERE user_id = p_user_id;

  retained_over_limit := retained_total_count > p_absolute_retained_job_limit;
  restore_slots := GREATEST(0, p_absolute_retained_job_limit - active_count_before);

  IF locked_count_before <= 0 OR restore_slots <= 0 THEN
    SELECT COUNT(*)::integer
    INTO active_count_after
    FROM public.jobs
    WHERE user_id = p_user_id
      AND storage_state = 'active';

    SELECT COUNT(*)::integer
    INTO locked_count_after
    FROM public.jobs
    WHERE user_id = p_user_id
      AND storage_state = 'locked_over_plan_limit';

    RETURN jsonb_build_object(
      'applied', true,
      'restoredCount', 0,
      'activeCountBeforeRestore', active_count_before,
      'activeCountAfterRestore', active_count_after,
      'lockedCountBeforeRestore', locked_count_before,
      'lockedCountAfterRestore', locked_count_after,
      'retainedTotalCount', retained_total_count,
      'absoluteRetainedLimit', p_absolute_retained_job_limit,
      'retainedOverLimit', retained_over_limit
    );
  END IF;

  WITH ranked_locked AS (
    SELECT
      id,
      row_number() OVER (
        ORDER BY
          CASE
            WHEN status = 'offered' THEN 0
            WHEN status = 'interviewing' THEN 1
            WHEN status = 'applied' THEN 2
            ELSE 3
          END,
          created_at DESC,
          id DESC
      ) AS locked_rank
    FROM public.jobs
    WHERE user_id = p_user_id
      AND storage_state = 'locked_over_plan_limit'
  ),
  rows_to_restore AS (
    SELECT id
    FROM ranked_locked
    WHERE locked_rank <= restore_slots
  ),
  restored_rows AS (
    UPDATE public.jobs AS jobs
    SET
      storage_state = 'active',
      locked_at = NULL,
      locked_reason = NULL,
      locked_policy_version = NULL
    FROM rows_to_restore
    WHERE jobs.id = rows_to_restore.id
      AND jobs.user_id = p_user_id
      AND jobs.storage_state = 'locked_over_plan_limit'
    RETURNING jobs.id
  )
  SELECT COUNT(*)::integer
  INTO restored_count
  FROM restored_rows;

  SELECT COUNT(*)::integer
  INTO active_count_after
  FROM public.jobs
  WHERE user_id = p_user_id
    AND storage_state = 'active';

  SELECT COUNT(*)::integer
  INTO locked_count_after
  FROM public.jobs
  WHERE user_id = p_user_id
    AND storage_state = 'locked_over_plan_limit';

  RETURN jsonb_build_object(
    'applied', true,
    'restoredCount', restored_count,
    'activeCountBeforeRestore', active_count_before,
    'activeCountAfterRestore', active_count_after,
    'lockedCountBeforeRestore', locked_count_before,
    'lockedCountAfterRestore', locked_count_after,
    'retainedTotalCount', retained_total_count,
    'absoluteRetainedLimit', p_absolute_retained_job_limit,
    'retainedOverLimit', retained_over_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.restore_locked_jobs_for_premium_user(uuid, text, integer, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_locked_jobs_for_premium_user(uuid, text, integer, text[])
  TO service_role;
