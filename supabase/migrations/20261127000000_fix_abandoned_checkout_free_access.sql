-- Allow baseline Free usage while an initial upgrade is unfinished or abandoned.
-- Apply this migration before deploying the matching application policy. Older
-- application instances can temporarily deny creation; no Premium is granted.
-- CREATE OR REPLACE retains ownership and existing grants. Explicit ACLs below
-- also keep these two RPCs service-only without requiring the separate ACL repair.
-- No customer, subscription, checkout, or job data is rewritten.
-- Rollback: restore both prior function definitions and the prior app policy
-- together during a maintenance window; never delete billing records to revert.
BEGIN;

-- Map trusted local billing rows to storage state under the per-user billing
-- lock. A customer without a subscription permits Free creation but cannot
-- authorize archive transitions. Initial payment expiry also stays Free without
-- passing the canonical terminal_free checks in the overflow-lock and delete RPCs.
CREATE OR REPLACE FUNCTION "public"."resolve_canonical_storage_status_for_user"("p_user_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  has_customer_mapping boolean;
  subscription_status text;
  subscription_current_period_end timestamptz;
  subscription_cancel_at_period_end boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required'
      USING ERRCODE = '23502';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(p_user_id::text),
    hashtext('billing_storage_transition')
  );

  SELECT EXISTS (
    SELECT 1
    FROM public.billing_customers
    WHERE user_id = p_user_id
  )
  INTO has_customer_mapping;

  SELECT
    status,
    current_period_end,
    cancel_at_period_end
  INTO
    subscription_status,
    subscription_current_period_end,
    subscription_cancel_at_period_end
  FROM public.billing_subscriptions
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN CASE
      WHEN has_customer_mapping THEN 'free_unsubscribed'
      ELSE 'terminal_free'
    END;
  END IF;

  IF subscription_status = 'active' THEN
    IF subscription_cancel_at_period_end THEN
      RETURN CASE
        WHEN subscription_current_period_end IS NOT NULL
         AND subscription_current_period_end > statement_timestamp()
          THEN 'premium_canceling'
        ELSE 'billing_reconciliation_pending'
      END;
    END IF;

    RETURN 'premium_active';
  END IF;

  IF subscription_status IN ('past_due', 'unpaid') THEN
    RETURN 'payment_recovery';
  END IF;

  IF subscription_status = 'incomplete' THEN
    RETURN 'sync_pending';
  END IF;

  IF subscription_status = 'incomplete_expired' THEN
    RETURN 'free_unsubscribed';
  END IF;

  IF subscription_status = 'canceled' THEN
    RETURN 'terminal_free';
  END IF;

  RETURN 'non_entitled_non_terminal';
END;
$$;

-- Insert one user's job only after canonical billing and both storage quotas
-- are checked. Keep the billing lock before the quota lock so subscription
-- writes and concurrent creates cannot bypass the Free or retained limits.
CREATE OR REPLACE FUNCTION "public"."create_job_with_storage_quota"("p_user_id" "uuid", "p_job_data" "jsonb", "p_storage_status" "text", "p_active_job_limit" integer, "p_absolute_retained_job_limit" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  active_count integer;
  retained_count integer;
  effective_active_limit integer;
  created_job public.jobs%ROWTYPE;
  normalized_storage_status text;
  canonical_storage_status text;
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
     OR normalized_storage_status NOT IN (
       'premium_active', 'premium_canceling', 'terminal_free',
       'free_unsubscribed', 'sync_pending'
     ) THEN
    RETURN jsonb_build_object(
      'created', false,
      'code', 'STORAGE_CREATE_STATUS_NOT_ALLOWED',
      'reason', 'storage_status_not_allowed',
      'storageStatus', normalized_storage_status
    );
  END IF;

  canonical_storage_status :=
    public.resolve_canonical_storage_status_for_user(p_user_id);

  IF canonical_storage_status IS DISTINCT FROM normalized_storage_status THEN
    RETURN jsonb_build_object(
      'created', false,
      'code', 'BILLING_STATUS_UNAVAILABLE',
      'reason', 'billing_status_changed',
      'storageStatus', normalized_storage_status,
      'canonicalStorageStatus', canonical_storage_status
    );
  END IF;

  effective_active_limit := CASE
    WHEN normalized_storage_status IN ('terminal_free', 'free_unsubscribed', 'sync_pending')
      THEN p_active_job_limit
    ELSE p_absolute_retained_job_limit
  END;

  PERFORM pg_advisory_xact_lock(
    hashtext(p_user_id::text),
    hashtext('jobs_create_quota')
  );

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

REVOKE ALL ON FUNCTION public.resolve_canonical_storage_status_for_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_canonical_storage_status_for_user(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.create_job_with_storage_quota(uuid, jsonb, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_job_with_storage_quota(uuid, jsonb, text, integer, integer) TO service_role;

COMMIT;
