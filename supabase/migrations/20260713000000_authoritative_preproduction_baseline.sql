-- Canonical pre-production Supabase schema baseline.
--
-- Sources:
--   - read-only public-schema catalog dump captured 2026-07-13
--   - reviewed final effects of repository migrations 005-027
--   - recovered historical jobs index evidence
--
-- This baseline intentionally contains schema only. It excludes auth users,
-- application data, environment identifiers, public.exec_sql(text), and the
-- stale three-argument Premium restore overload.

BEGIN;

SET LOCAL check_function_bodies = false;
SET LOCAL row_security = off;

CREATE EXTENSION IF NOT EXISTS "moddatetime" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";

CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



-- advance_billing_subscription_snapshot_version(...)
--
-- Purpose:
--   Maintains the database-owned compare-and-swap version on every billing subscription write.
CREATE OR REPLACE FUNCTION "public"."advance_billing_subscription_snapshot_version"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.snapshot_version := 1;
    RETURN NEW;
  END IF;

  IF OLD.snapshot_version = 9223372036854775807 THEN
    RAISE EXCEPTION 'billing subscription snapshot version exhausted'
      USING ERRCODE = '22003';
  END IF;

  NEW.snapshot_version := OLD.snapshot_version + 1;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."advance_billing_subscription_snapshot_version"() OWNER TO "postgres";


-- claim_billing_checkout_session(...)
--
-- Purpose:
--   Serializes checkout claims and reuses or retires existing active checkout-session rows.
CREATE OR REPLACE FUNCTION "public"."claim_billing_checkout_session"("p_user_id" "uuid", "p_plan" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  current_session public.billing_checkout_sessions%ROWTYPE;
  normalized_plan text;
BEGIN
  normalized_plan := btrim(p_plan);

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required'
      USING ERRCODE = '23502';
  END IF;

  IF normalized_plan IS NULL OR normalized_plan = '' THEN
    RAISE EXCEPTION 'plan is required'
      USING ERRCODE = '23502';
  END IF;

  IF normalized_plan NOT IN ('premium_monthly') THEN
    RAISE EXCEPTION 'unsupported billing plan: %', normalized_plan
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(normalized_plan));

  UPDATE public.billing_checkout_sessions
  SET status = 'expired'
  WHERE user_id = p_user_id
    AND plan = normalized_plan
    AND status = 'open'
    AND expires_at <= pg_catalog.now();

  UPDATE public.billing_checkout_sessions
  SET status = 'failed'
  WHERE user_id = p_user_id
    AND plan = normalized_plan
    AND status = 'creating'
    AND updated_at < pg_catalog.now() - interval '5 minutes';

  SELECT *
  INTO current_session
  FROM public.billing_checkout_sessions
  WHERE user_id = p_user_id
    AND plan = normalized_plan
    AND status IN ('creating', 'open')
  ORDER BY created_at DESC, id DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF current_session.status = 'open' THEN
      RETURN jsonb_build_object(
        'action', 'reused',
        'session', to_jsonb(current_session)
      );
    END IF;

    RETURN jsonb_build_object(
      'action', 'creating',
      'session', to_jsonb(current_session)
    );
  END IF;

  INSERT INTO public.billing_checkout_sessions (
    user_id,
    plan,
    status
  )
  VALUES (
    p_user_id,
    normalized_plan,
    'creating'
  )
  RETURNING * INTO current_session;

  RETURN jsonb_build_object(
    'action', 'claimed',
    'session', to_jsonb(current_session)
  );
END;
$$;


ALTER FUNCTION "public"."claim_billing_checkout_session"("p_user_id" "uuid", "p_plan" "text") OWNER TO "postgres";


-- create_job_with_storage_quota(...)
--
-- Purpose:
--   Creates a job only after canonical billing status and active/retained storage limits are rechecked.
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
     OR normalized_storage_status NOT IN ('premium_active', 'premium_canceling', 'terminal_free') THEN
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
    WHEN normalized_storage_status = 'terminal_free'
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


ALTER FUNCTION "public"."create_job_with_storage_quota"("p_user_id" "uuid", "p_job_data" "jsonb", "p_storage_status" "text", "p_active_job_limit" integer, "p_absolute_retained_job_limit" integer) OWNER TO "postgres";


-- delete_locked_jobs_for_terminal_free_user(...)
--
-- Purpose:
--   Deletes a bounded oldest-first batch of locked jobs after terminal-free entitlement is revalidated.
CREATE OR REPLACE FUNCTION "public"."delete_locked_jobs_for_terminal_free_user"("p_user_id" "uuid", "p_storage_status" "text", "p_locked_delete_limit" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
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


ALTER FUNCTION "public"."delete_locked_jobs_for_terminal_free_user"("p_user_id" "uuid", "p_storage_status" "text", "p_locked_delete_limit" integer) OWNER TO "postgres";





-- get_job_storage_counts_for_user(...)
--
-- Purpose:
--   Returns active, locked, and retained job counts behind the service-role storage boundary.
CREATE OR REPLACE FUNCTION "public"."get_job_storage_counts_for_user"("p_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
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


ALTER FUNCTION "public"."get_job_storage_counts_for_user"("p_user_id" "uuid") OWNER TO "postgres";


-- lock_billing_storage_transition(...)
--
-- Purpose:
--   Serializes billing mutations with job storage-state transitions for the same user.
CREATE OR REPLACE FUNCTION "public"."lock_billing_storage_transition"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  affected_user_id uuid;
BEGIN
  affected_user_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.user_id
    ELSE NEW.user_id
  END;

  PERFORM pg_advisory_xact_lock(
    hashtext(affected_user_id::text),
    hashtext('billing_storage_transition')
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."lock_billing_storage_transition"() OWNER TO "postgres";


-- lock_overflow_jobs_for_terminal_free_user(...)
--
-- Purpose:
--   Locks deterministic overflow jobs after terminal-free entitlement and quota state are revalidated.
CREATE OR REPLACE FUNCTION "public"."lock_overflow_jobs_for_terminal_free_user"("p_user_id" "uuid", "p_storage_status" "text", "p_active_job_limit" integer, "p_locked_reason" "text", "p_locked_policy_version" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  normalized_storage_status text;
  normalized_locked_reason text;
  normalized_locked_policy_version text;
  active_count_before integer;
  active_count_after integer;
  locked_count integer;
  canonical_storage_status text;
BEGIN
  normalized_storage_status := pg_catalog.btrim(p_storage_status);
  normalized_locked_reason := pg_catalog.btrim(p_locked_reason);
  normalized_locked_policy_version := pg_catalog.btrim(p_locked_policy_version);

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required'
      USING ERRCODE = '23502';
  END IF;

  IF p_active_job_limit IS NULL OR p_active_job_limit <= 0 THEN
    RAISE EXCEPTION 'active job limit must be positive'
      USING ERRCODE = '22023';
  END IF;

  IF normalized_locked_reason IS NULL
     OR normalized_locked_reason <> 'premium_to_free_over_plan_limit' THEN
    RAISE EXCEPTION 'locked reason is not allowed'
      USING ERRCODE = '22023';
  END IF;

  IF normalized_locked_policy_version IS NULL
     OR normalized_locked_policy_version = ''
     OR char_length(normalized_locked_policy_version) > 120 THEN
    RAISE EXCEPTION 'locked policy version is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF normalized_storage_status IS NULL
     OR normalized_storage_status <> 'terminal_free' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'storage_status_not_lock_eligible',
      'storageStatus', normalized_storage_status,
      'lockedCount', 0
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
      'lockedCount', 0
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext('jobs_create_quota'));

  SELECT COUNT(*)::integer
  INTO active_count_before
  FROM public.jobs
  WHERE user_id = p_user_id
    AND storage_state = 'active';

  IF active_count_before <= p_active_job_limit THEN
    RETURN jsonb_build_object(
      'applied', true,
      'lockedCount', 0,
      'activeCountBeforeLock', active_count_before,
      'activeCountAfterLock', active_count_before,
      'activeLimit', p_active_job_limit
    );
  END IF;

  WITH ranked_active AS (
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
      ) AS active_rank
    FROM public.jobs
    WHERE user_id = p_user_id
      AND storage_state = 'active'
  ),
  overflow_rows AS (
    SELECT id
    FROM ranked_active
    WHERE active_rank > p_active_job_limit
  ),
  locked_rows AS (
    UPDATE public.jobs AS jobs
    SET
      storage_state = 'locked_over_plan_limit',
      locked_at = statement_timestamp(),
      locked_reason = normalized_locked_reason,
      locked_policy_version = normalized_locked_policy_version
    FROM overflow_rows
    WHERE jobs.id = overflow_rows.id
      AND jobs.user_id = p_user_id
      AND jobs.storage_state = 'active'
    RETURNING jobs.id
  )
  SELECT COUNT(*)::integer
  INTO locked_count
  FROM locked_rows;

  SELECT COUNT(*)::integer
  INTO active_count_after
  FROM public.jobs
  WHERE user_id = p_user_id
    AND storage_state = 'active';

  RETURN jsonb_build_object(
    'applied', true,
    'lockedCount', locked_count,
    'activeCountBeforeLock', active_count_before,
    'activeCountAfterLock', active_count_after,
    'activeLimit', p_active_job_limit
  );
END;
$$;


ALTER FUNCTION "public"."lock_overflow_jobs_for_terminal_free_user"("p_user_id" "uuid", "p_storage_status" "text", "p_active_job_limit" integer, "p_locked_reason" "text", "p_locked_policy_version" "text") OWNER TO "postgres";


-- merge_stripe_event_receipt(...)
--
-- Purpose:
--   Atomically records, reclaims, or finalizes idempotent Stripe webhook receipt state.
CREATE OR REPLACE FUNCTION "public"."merge_stripe_event_receipt"("p_event_id" "text", "p_event_type" "text", "p_livemode" boolean, "p_stripe_event_created" timestamp with time zone, "p_result" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  existing_receipt public.stripe_event_receipts%ROWTYPE;
  final_receipt public.stripe_event_receipts%ROWTYPE;
  outcome text;
BEGIN
  IF p_result NOT IN ('processing', 'processed', 'stale_ignored', 'failed') THEN
    RAISE EXCEPTION 'unsupported stripe_event_receipts result: %', p_result
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.stripe_event_receipts (
    event_id,
    event_type,
    livemode,
    stripe_event_created,
    result
  )
  VALUES (
    p_event_id,
    p_event_type,
    p_livemode,
    p_stripe_event_created,
    p_result
  )
  ON CONFLICT (event_id) DO NOTHING
  RETURNING * INTO final_receipt;

  IF FOUND THEN
    outcome := 'recorded';
    RETURN jsonb_build_object(
      'outcome', outcome,
      'receipt', to_jsonb(final_receipt)
    );
  END IF;

  SELECT *
  INTO existing_receipt
  FROM public.stripe_event_receipts
  WHERE event_id = p_event_id
  FOR UPDATE;

  IF p_event_type IS DISTINCT FROM existing_receipt.event_type
    OR p_livemode IS DISTINCT FROM existing_receipt.livemode
    OR p_stripe_event_created IS DISTINCT FROM existing_receipt.stripe_event_created THEN
    RAISE EXCEPTION 'stripe_event_receipts envelope mismatch';
  END IF;

  IF existing_receipt.result IN ('processed', 'stale_ignored')
    AND p_result IS DISTINCT FROM existing_receipt.result THEN
    outcome := 'preserved_existing';
    final_receipt := existing_receipt;
  ELSIF existing_receipt.result = p_result THEN
    IF p_result = 'processing'
      AND existing_receipt.processed_at < pg_catalog.now() - interval '5 minutes' THEN
      UPDATE public.stripe_event_receipts
      SET processed_at = pg_catalog.now()
      WHERE event_id = p_event_id
      RETURNING * INTO final_receipt;

      outcome := 'reclaimed_processing';
    ELSIF p_result = 'processing' THEN
      outcome := 'processing_active';
      final_receipt := existing_receipt;
    ELSE
      outcome := 'already_recorded';
      final_receipt := existing_receipt;
    END IF;
  ELSE
    UPDATE public.stripe_event_receipts
    SET
      result = p_result,
      processed_at = pg_catalog.now()
    WHERE event_id = p_event_id
    RETURNING * INTO final_receipt;

    outcome := 'updated';
  END IF;

  RETURN jsonb_build_object(
    'outcome', outcome,
    'receipt', to_jsonb(final_receipt)
  );
END;
$$;


ALTER FUNCTION "public"."merge_stripe_event_receipt"("p_event_id" "text", "p_event_type" "text", "p_livemode" boolean, "p_stripe_event_created" timestamp with time zone, "p_result" "text") OWNER TO "postgres";


-- resolve_canonical_storage_status_for_user(...)
--
-- Purpose:
--   Maps authoritative local billing rows to the canonical storage entitlement state.
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
      WHEN has_customer_mapping THEN 'sync_pending'
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

  IF subscription_status = 'canceled' THEN
    RETURN 'terminal_free';
  END IF;

  RETURN 'non_entitled_non_terminal';
END;
$$;


ALTER FUNCTION "public"."resolve_canonical_storage_status_for_user"("p_user_id" "uuid") OWNER TO "postgres";


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

ALTER FUNCTION public.restore_locked_jobs_for_premium_user(uuid, text, integer, text[]) OWNER TO postgres;



-- touch_billing_status_changed_at(...)
--
-- Purpose:
--   Advances status_changed_at only when a subscription status actually changes.
CREATE OR REPLACE FUNCTION "public"."touch_billing_status_changed_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := pg_catalog.now();
  ELSE
    NEW.status_changed_at := OLD.status_changed_at;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."touch_billing_status_changed_at"() OWNER TO "postgres";


-- touch_billing_updated_at(...)
--
-- Purpose:
--   Maintains updated_at for billing rows changed by any write path.
CREATE OR REPLACE FUNCTION "public"."touch_billing_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."touch_billing_updated_at"() OWNER TO "postgres";


-- upsert_billing_subscription_authoritative(...)
--
-- Purpose:
--   Applies direct Stripe reconciliation only when the caller proves the exact observed local snapshot.
CREATE OR REPLACE FUNCTION "public"."upsert_billing_subscription_authoritative"("payload" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $_$
DECLARE
  incoming_user_id uuid;
  target_subscription_id text;
  expected_subscription_exists boolean;
  expected_subscription_id text;
  expected_subscription_snapshot_version bigint;
  authoritative_sync_purpose text;
  current_subscription public.billing_subscriptions%ROWTYPE;
  subscription jsonb;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'payload must be a json object'
      USING ERRCODE = '22023';
  END IF;

  incoming_user_id := NULLIF(pg_catalog.btrim(payload->>'user_id'), '')::uuid;

  IF incoming_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required'
      USING ERRCODE = '23502';
  END IF;

  IF NOT (payload ? '_expected_subscription_exists')
     OR jsonb_typeof(payload->'_expected_subscription_exists') <> 'boolean' THEN
    RAISE EXCEPTION 'expected subscription existence marker must be a boolean'
      USING ERRCODE = '22023';
  END IF;

  expected_subscription_exists :=
    (payload->>'_expected_subscription_exists')::boolean;

  IF NOT (payload ? '_authoritative_sync_purpose')
     OR jsonb_typeof(payload->'_authoritative_sync_purpose') <> 'string' THEN
    RAISE EXCEPTION 'authoritative sync purpose is required'
      USING ERRCODE = '22023';
  END IF;

  authoritative_sync_purpose :=
    NULLIF(pg_catalog.btrim(payload->>'_authoritative_sync_purpose'), '');

  IF authoritative_sync_purpose IS NULL
     OR authoritative_sync_purpose NOT IN ('reconcile_current', 'checkout_completion') THEN
    RAISE EXCEPTION 'authoritative sync purpose is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF expected_subscription_exists THEN
    IF NOT (payload ? '_expected_stripe_subscription_id')
       OR NOT (payload ? '_expected_subscription_snapshot_version')
       OR jsonb_typeof(payload->'_expected_stripe_subscription_id') <> 'string'
       OR jsonb_typeof(payload->'_expected_subscription_snapshot_version') <> 'number'
       OR (payload->>'_expected_subscription_snapshot_version') !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'complete valid expected billing snapshot is required'
        USING ERRCODE = '22023';
    END IF;

    expected_subscription_id :=
      NULLIF(pg_catalog.btrim(payload->>'_expected_stripe_subscription_id'), '');
    expected_subscription_snapshot_version :=
      (payload->>'_expected_subscription_snapshot_version')::bigint;

    IF expected_subscription_id IS NULL THEN
      RAISE EXCEPTION 'expected billing snapshot is invalid'
        USING ERRCODE = '22023';
    END IF;
  ELSIF payload ? '_expected_stripe_subscription_id'
     OR payload ? '_expected_subscription_snapshot_version' THEN
    RAISE EXCEPTION 'absent billing snapshot cannot include row fields'
      USING ERRCODE = '22023';
  END IF;

  IF payload ? 'stripe_subscription_id' THEN
    IF jsonb_typeof(payload->'stripe_subscription_id') <> 'string' THEN
      RAISE EXCEPTION 'stripe_subscription_id must be a string when present'
        USING ERRCODE = '22023';
    END IF;

    target_subscription_id :=
      NULLIF(pg_catalog.btrim(payload->>'stripe_subscription_id'), '');

    IF target_subscription_id IS NULL THEN
      RAISE EXCEPTION 'stripe_subscription_id must not be empty'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF authoritative_sync_purpose = 'reconcile_current' THEN
    IF NOT expected_subscription_exists THEN
      RAISE EXCEPTION 'reconcile_current requires an existing subscription snapshot'
        USING ERRCODE = '22023';
    END IF;

    IF target_subscription_id IS NOT NULL
       AND target_subscription_id IS DISTINCT FROM expected_subscription_id THEN
      RAISE EXCEPTION 'reconcile_current cannot target a different subscription'
        USING ERRCODE = '22023';
    END IF;

    target_subscription_id := expected_subscription_id;
  ELSIF target_subscription_id IS NULL THEN
    RAISE EXCEPTION 'checkout_completion requires stripe_subscription_id'
      USING ERRCODE = '23502';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(incoming_user_id::text),
    hashtext('billing_storage_transition')
  );

  SELECT *
  INTO current_subscription
  FROM public.billing_subscriptions
  WHERE user_id = incoming_user_id;

  IF expected_subscription_exists THEN
    IF NOT FOUND
       OR current_subscription.stripe_subscription_id IS DISTINCT FROM expected_subscription_id
       OR current_subscription.snapshot_version IS DISTINCT FROM expected_subscription_snapshot_version THEN
      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'billing_snapshot_changed',
        'subscription',
          CASE
            WHEN current_subscription.user_id IS NULL THEN NULL
            ELSE to_jsonb(current_subscription)
          END
      );
    END IF;
  ELSIF FOUND THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'billing_snapshot_changed',
      'subscription', to_jsonb(current_subscription)
    );
  END IF;

  IF current_subscription.user_id IS NOT NULL
     AND current_subscription.stripe_subscription_id IS DISTINCT FROM target_subscription_id
     AND (
       authoritative_sync_purpose <> 'checkout_completion'
       OR current_subscription.status NOT IN ('canceled', 'incomplete_expired')
     ) THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'subscription_replacement_blocked',
      'subscription', to_jsonb(current_subscription)
    );
  END IF;

  WITH incoming AS (
    SELECT *
    FROM jsonb_to_record(payload) AS incoming(
      user_id uuid,
      stripe_subscription_id text,
      stripe_customer_id text,
      price_id text,
      status text,
      current_period_end timestamptz,
      cancel_at_period_end boolean,
      last_stripe_event_created timestamptz
    )
  ),
  effective AS (
    SELECT
      incoming_user_id AS user_id,
      target_subscription_id AS stripe_subscription_id,
      CASE
        WHEN payload ? 'stripe_customer_id' THEN incoming.stripe_customer_id
        ELSE current_subscription.stripe_customer_id
      END AS stripe_customer_id,
      CASE
        WHEN payload ? 'price_id' THEN incoming.price_id
        ELSE current_subscription.price_id
      END AS price_id,
      CASE
        WHEN payload ? 'status' THEN incoming.status
        ELSE current_subscription.status
      END AS status,
      CASE
        WHEN payload ? 'current_period_end' THEN incoming.current_period_end
        ELSE current_subscription.current_period_end
      END AS current_period_end,
      CASE
        WHEN payload ? 'cancel_at_period_end' THEN incoming.cancel_at_period_end
        ELSE current_subscription.cancel_at_period_end
      END AS cancel_at_period_end,
      CASE
        WHEN payload ? 'last_stripe_event_created'
         AND payload->'last_stripe_event_created' <> 'null'::jsonb
          THEN incoming.last_stripe_event_created
        ELSE current_subscription.last_stripe_event_created
      END AS last_stripe_event_created
    FROM incoming
  ),
  upserted AS (
    INSERT INTO public.billing_subscriptions AS billing_subscriptions (
      user_id,
      stripe_subscription_id,
      stripe_customer_id,
      price_id,
      status,
      current_period_end,
      cancel_at_period_end,
      last_stripe_event_created
    )
    SELECT
      user_id,
      stripe_subscription_id,
      stripe_customer_id,
      price_id,
      status,
      current_period_end,
      cancel_at_period_end,
      last_stripe_event_created
    FROM effective
    ON CONFLICT (user_id) DO UPDATE
    SET
      stripe_subscription_id = CASE
        WHEN payload ? 'stripe_subscription_id'
          THEN excluded.stripe_subscription_id
        ELSE billing_subscriptions.stripe_subscription_id
      END,
      stripe_customer_id = CASE
        WHEN payload ? 'stripe_customer_id'
          THEN excluded.stripe_customer_id
        ELSE billing_subscriptions.stripe_customer_id
      END,
      price_id = CASE
        WHEN payload ? 'price_id'
          THEN excluded.price_id
        ELSE billing_subscriptions.price_id
      END,
      status = CASE
        WHEN payload ? 'status'
          THEN excluded.status
        ELSE billing_subscriptions.status
      END,
      current_period_end = CASE
        WHEN payload ? 'current_period_end'
          THEN excluded.current_period_end
        ELSE billing_subscriptions.current_period_end
      END,
      cancel_at_period_end = CASE
        WHEN payload ? 'cancel_at_period_end'
          THEN excluded.cancel_at_period_end
        ELSE billing_subscriptions.cancel_at_period_end
      END,
      last_stripe_event_created = CASE
        WHEN payload ? 'last_stripe_event_created'
         AND payload->'last_stripe_event_created' <> 'null'::jsonb
          THEN excluded.last_stripe_event_created
        ELSE billing_subscriptions.last_stripe_event_created
      END
    RETURNING to_jsonb(billing_subscriptions) AS subscription
  )
  SELECT upserted.subscription
  INTO subscription
  FROM upserted;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'applied',
    'subscription', subscription
  );
END;
$_$;


ALTER FUNCTION "public"."upsert_billing_subscription_authoritative"("payload" "jsonb") OWNER TO "postgres";


-- upsert_billing_subscription_if_newer_or_equal(...)
--
-- Purpose:
--   Orders event-driven Stripe snapshots and resolves equal-timestamp conflicts deterministically.
CREATE OR REPLACE FUNCTION "public"."upsert_billing_subscription_if_newer_or_equal"("payload" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  incoming_user_id uuid;
  incoming_subscription_id text;
  incoming_customer_id text;
  incoming_price_id text;
  incoming_status text;
  incoming_period_end timestamptz;
  incoming_cancel_at_period_end boolean;
  incoming_event_created timestamptz;
  current_subscription public.billing_subscriptions%ROWTYPE;
  result_subscription jsonb;
  result_applied boolean := false;
  result_reason text;
  should_apply boolean := false;
  subscription_matches boolean;
  canonical_snapshot_matches boolean;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'payload must be a json object'
      USING ERRCODE = '22023';
  END IF;

  IF NOT payload ?& ARRAY[
    'user_id',
    'stripe_subscription_id',
    'stripe_customer_id',
    'price_id',
    'status',
    'current_period_end',
    'cancel_at_period_end',
    'last_stripe_event_created'
  ] THEN
    RAISE EXCEPTION 'complete event-driven billing snapshot is required'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(payload->'user_id') <> 'string'
     OR jsonb_typeof(payload->'stripe_subscription_id') <> 'string'
     OR jsonb_typeof(payload->'status') <> 'string'
     OR jsonb_typeof(payload->'cancel_at_period_end') <> 'boolean'
     OR jsonb_typeof(payload->'last_stripe_event_created') <> 'string'
     OR jsonb_typeof(payload->'stripe_customer_id') NOT IN ('string', 'null')
     OR jsonb_typeof(payload->'price_id') NOT IN ('string', 'null')
     OR jsonb_typeof(payload->'current_period_end') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'event-driven billing snapshot has invalid field types'
      USING ERRCODE = '22023';
  END IF;

  incoming_user_id := NULLIF(pg_catalog.btrim(payload->>'user_id'), '')::uuid;
  incoming_subscription_id :=
    NULLIF(pg_catalog.btrim(payload->>'stripe_subscription_id'), '');
  incoming_customer_id := NULLIF(pg_catalog.btrim(payload->>'stripe_customer_id'), '');
  incoming_price_id := NULLIF(pg_catalog.btrim(payload->>'price_id'), '');
  incoming_status := NULLIF(pg_catalog.btrim(payload->>'status'), '');
  incoming_period_end := (payload->>'current_period_end')::timestamptz;
  incoming_cancel_at_period_end := (payload->>'cancel_at_period_end')::boolean;
  incoming_event_created :=
    NULLIF(pg_catalog.btrim(payload->>'last_stripe_event_created'), '')::timestamptz;

  IF incoming_user_id IS NULL
     OR incoming_subscription_id IS NULL
     OR incoming_status IS NULL
     OR incoming_event_created IS NULL THEN
    RAISE EXCEPTION 'event-driven billing snapshot is missing required values'
      USING ERRCODE = '23502';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(incoming_user_id::text),
    hashtext('billing_storage_transition')
  );

  SELECT *
  INTO current_subscription
  FROM public.billing_subscriptions
  WHERE user_id = incoming_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.billing_subscriptions (
      user_id,
      stripe_subscription_id,
      stripe_customer_id,
      price_id,
      status,
      current_period_end,
      cancel_at_period_end,
      last_stripe_event_created
    )
    VALUES (
      incoming_user_id,
      incoming_subscription_id,
      incoming_customer_id,
      incoming_price_id,
      incoming_status,
      incoming_period_end,
      incoming_cancel_at_period_end,
      incoming_event_created
    )
    RETURNING to_jsonb(billing_subscriptions)
    INTO result_subscription;

    RETURN jsonb_build_object(
      'applied', true,
      'subscription', result_subscription,
      'reason', 'applied'
    );
  END IF;

  subscription_matches :=
    incoming_subscription_id IS NOT DISTINCT FROM
      current_subscription.stripe_subscription_id;
  canonical_snapshot_matches :=
    subscription_matches
    AND incoming_customer_id IS NOT DISTINCT FROM
      current_subscription.stripe_customer_id
    AND incoming_price_id IS NOT DISTINCT FROM current_subscription.price_id
    AND incoming_status IS NOT DISTINCT FROM current_subscription.status
    AND incoming_period_end IS NOT DISTINCT FROM
      current_subscription.current_period_end
    AND incoming_cancel_at_period_end IS NOT DISTINCT FROM
      current_subscription.cancel_at_period_end;

  IF current_subscription.last_stripe_event_created IS NOT NULL
     AND incoming_event_created < current_subscription.last_stripe_event_created THEN
    result_reason := 'stale_ignored';
  ELSIF current_subscription.last_stripe_event_created IS NULL
     OR incoming_event_created > current_subscription.last_stripe_event_created THEN
    IF subscription_matches
       OR current_subscription.status IN ('canceled', 'incomplete_expired') THEN
      should_apply := true;
    ELSE
      result_reason := 'non_current_ignored';
    END IF;
  ELSIF NOT subscription_matches THEN
    result_reason := 'equal_cross_subscription_conflict';
  ELSIF canonical_snapshot_matches THEN
    result_reason := 'idempotent_equal';
  ELSIF incoming_status IN ('canceled', 'incomplete_expired')
     AND current_subscription.status NOT IN ('canceled', 'incomplete_expired') THEN
    should_apply := true;
  ELSIF current_subscription.status IN ('canceled', 'incomplete_expired')
     AND incoming_status NOT IN ('canceled', 'incomplete_expired') THEN
    result_reason := 'terminal_preserved';
  ELSE
    result_reason := 'equal_timestamp_conflict';
  END IF;

  IF should_apply THEN
    UPDATE public.billing_subscriptions
    SET
      stripe_subscription_id = incoming_subscription_id,
      stripe_customer_id = incoming_customer_id,
      price_id = incoming_price_id,
      status = incoming_status,
      current_period_end = incoming_period_end,
      cancel_at_period_end = incoming_cancel_at_period_end,
      last_stripe_event_created = incoming_event_created
    WHERE user_id = incoming_user_id
    RETURNING to_jsonb(billing_subscriptions)
    INTO result_subscription;

    result_applied := true;
    result_reason := 'applied';
  ELSE
    result_subscription := to_jsonb(current_subscription);
  END IF;

  RETURN jsonb_build_object(
    'applied', result_applied,
    'subscription', result_subscription,
    'reason', result_reason
  );
END;
$$;


ALTER FUNCTION "public"."upsert_billing_subscription_if_newer_or_equal"("payload" "jsonb") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."abuse_counters" (
    "user_id" "uuid" NOT NULL,
    "strike_type" "text" NOT NULL,
    "count" integer DEFAULT 0 NOT NULL,
    "window_start" timestamp with time zone DEFAULT "now"() NOT NULL,
    "disabled_at" timestamp with time zone
);


ALTER TABLE "public"."abuse_counters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_checkout_sessions" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "plan" "text" NOT NULL,
    "stripe_checkout_session_id" "text",
    "checkout_url" "text",
    "status" "text" NOT NULL,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "billing_checkout_sessions_open_fields_check" CHECK ((("status" <> 'open'::"text") OR (("stripe_checkout_session_id" IS NOT NULL) AND ("checkout_url" IS NOT NULL) AND ("expires_at" IS NOT NULL)))),
    CONSTRAINT "billing_checkout_sessions_plan_allowed_check" CHECK (("plan" = 'premium_monthly'::"text")),
    CONSTRAINT "billing_checkout_sessions_plan_format_check" CHECK ((("char_length"("btrim"("plan")) > 0) AND ("char_length"("plan") <= 120))),
    CONSTRAINT "billing_checkout_sessions_status_check" CHECK (("status" = ANY (ARRAY['creating'::"text", 'open'::"text", 'complete'::"text", 'expired'::"text", 'failed'::"text"]))),
    CONSTRAINT "billing_checkout_sessions_stripe_session_id_format_check" CHECK ((("stripe_checkout_session_id" IS NULL) OR ("stripe_checkout_session_id" ~ '^cs_(test|live)_[^[:space:]]+$'::"text")))
);

ALTER TABLE ONLY "public"."billing_checkout_sessions" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing_checkout_sessions" OWNER TO "postgres";


ALTER TABLE "public"."billing_checkout_sessions" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."billing_checkout_sessions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."billing_customers" (
    "user_id" "uuid" NOT NULL,
    "stripe_customer_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_synced_stripe_email_fingerprint" "text",
    CONSTRAINT "billing_customers_last_synced_stripe_email_fingerprint_format_c" CHECK ((("last_synced_stripe_email_fingerprint" IS NULL) OR ("last_synced_stripe_email_fingerprint" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "billing_customers_stripe_customer_id_format_check" CHECK ((("stripe_customer_id" IS NULL) OR ("stripe_customer_id" ~ '^cus_[^[:space:]]+$'::"text")))
);

ALTER TABLE ONLY "public"."billing_customers" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing_customers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_subscriptions" (
    "user_id" "uuid" NOT NULL,
    "stripe_subscription_id" "text" NOT NULL,
    "stripe_customer_id" "text",
    "price_id" "text",
    "status" "text" NOT NULL,
    "current_period_end" timestamp with time zone,
    "cancel_at_period_end" boolean DEFAULT false NOT NULL,
    "last_stripe_event_created" timestamp with time zone,
    "status_changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "snapshot_version" bigint DEFAULT 1 NOT NULL,
    CONSTRAINT "billing_subscriptions_snapshot_version_check" CHECK (("snapshot_version" > 0)),
    CONSTRAINT "billing_subscriptions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'past_due'::"text", 'unpaid'::"text", 'canceled'::"text", 'paused'::"text", 'incomplete'::"text", 'incomplete_expired'::"text"]))),
    CONSTRAINT "billing_subscriptions_stripe_customer_id_format_check" CHECK ((("stripe_customer_id" IS NULL) OR ("stripe_customer_id" ~ '^cus_[^[:space:]]+$'::"text"))),
    CONSTRAINT "billing_subscriptions_stripe_subscription_id_format_check" CHECK (("stripe_subscription_id" ~ '^sub_[^[:space:]]+$'::"text"))
);

ALTER TABLE ONLY "public"."billing_subscriptions" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing_subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_spend" (
    "date" "date" NOT NULL,
    "total_cost_cents" bigint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."daily_spend" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."jobs" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "company" "text" NOT NULL,
    "position" "text" NOT NULL,
    "status" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "status_date" timestamp with time zone DEFAULT "now"(),
    "salary_min" integer,
    "salary_max" integer,
    "storage_state" "text" DEFAULT 'active'::"text" NOT NULL,
    "locked_at" timestamp with time zone,
    "locked_reason" "text",
    "locked_policy_version" "text",
    CONSTRAINT "jobs_locked_metadata_consistency_check" CHECK (((("storage_state" = 'active'::"text") AND ("locked_at" IS NULL) AND ("locked_reason" IS NULL) AND ("locked_policy_version" IS NULL)) OR (("storage_state" = 'locked_over_plan_limit'::"text") AND ("locked_at" IS NOT NULL) AND ("locked_reason" IS NOT NULL) AND ("locked_policy_version" IS NOT NULL)))),
    CONSTRAINT "jobs_locked_policy_version_format_check" CHECK ((("locked_policy_version" IS NULL) OR (("char_length"("btrim"("locked_policy_version")) > 0) AND ("char_length"("locked_policy_version") <= 120)))),
    CONSTRAINT "jobs_locked_reason_allowed_check" CHECK ((("locked_reason" IS NULL) OR ("locked_reason" = 'premium_to_free_over_plan_limit'::"text"))),
    CONSTRAINT "jobs_salary_max_check" CHECK ((("salary_max" >= 0) AND ("salary_max" <= 10000000))),
    CONSTRAINT "jobs_salary_min_check" CHECK ((("salary_min" >= 0) AND ("salary_min" <= 10000000))),
    CONSTRAINT "jobs_salary_range_check" CHECK ((("salary_min" IS NULL) OR ("salary_max" IS NULL) OR ("salary_max" >= "salary_min"))),
    CONSTRAINT "jobs_storage_state_allowed_check" CHECK (("storage_state" = ANY (ARRAY['active'::"text", 'locked_over_plan_limit'::"text"]))),
    CONSTRAINT "salary_range_valid" CHECK ((("salary_max" >= "salary_min") OR ("salary_min" IS NULL) OR ("salary_max" IS NULL)))
);

ALTER TABLE ONLY "public"."jobs" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stripe_event_receipts" (
    "event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "livemode" boolean NOT NULL,
    "processed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "stripe_event_created" timestamp with time zone NOT NULL,
    "result" "text" NOT NULL,
    CONSTRAINT "stripe_event_receipts_event_id_format_check" CHECK (("event_id" ~ '^evt_[^[:space:]]+$'::"text")),
    CONSTRAINT "stripe_event_receipts_event_type_length_check" CHECK (("char_length"("event_type") <= 255)),
    CONSTRAINT "stripe_event_receipts_result_check" CHECK (("result" = ANY (ARRAY['processing'::"text", 'processed'::"text", 'stale_ignored'::"text", 'failed'::"text"])))
);

ALTER TABLE ONLY "public"."stripe_event_receipts" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."stripe_event_receipts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tailor_cache" (
    "hash" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "response" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tailor_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_profiles" (
    "user_id" "uuid" NOT NULL,
    "summary" "text",
    "experience" "jsonb",
    "skills_technical" "text"[],
    "skills_soft" "text"[],
    "education" "jsonb",
    "certifications" "jsonb",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_profiles" OWNER TO "postgres";


ALTER TABLE ONLY "public"."abuse_counters"
    ADD CONSTRAINT "abuse_counters_pkey" PRIMARY KEY ("user_id", "strike_type");



ALTER TABLE ONLY "public"."billing_checkout_sessions"
    ADD CONSTRAINT "billing_checkout_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing_customers"
    ADD CONSTRAINT "billing_customers_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."billing_subscriptions"
    ADD CONSTRAINT "billing_subscriptions_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."billing_subscriptions"
    ADD CONSTRAINT "billing_subscriptions_stripe_subscription_id_key" UNIQUE ("stripe_subscription_id");



ALTER TABLE ONLY "public"."daily_spend"
    ADD CONSTRAINT "daily_spend_pkey" PRIMARY KEY ("date");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_event_receipts"
    ADD CONSTRAINT "stripe_event_receipts_pkey" PRIMARY KEY ("event_id");



ALTER TABLE ONLY "public"."tailor_cache"
    ADD CONSTRAINT "tailor_cache_pkey" PRIMARY KEY ("hash");



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id");



CREATE UNIQUE INDEX "billing_checkout_sessions_active_user_plan_idx" ON "public"."billing_checkout_sessions" USING "btree" ("user_id", "plan") WHERE ("status" = ANY (ARRAY['creating'::"text", 'open'::"text"]));



CREATE UNIQUE INDEX "billing_checkout_sessions_stripe_session_id_unique_idx" ON "public"."billing_checkout_sessions" USING "btree" ("stripe_checkout_session_id") WHERE ("stripe_checkout_session_id" IS NOT NULL);



CREATE INDEX "billing_checkout_sessions_user_session_idx" ON "public"."billing_checkout_sessions" USING "btree" ("user_id", "stripe_checkout_session_id") WHERE ("stripe_checkout_session_id" IS NOT NULL);



CREATE UNIQUE INDEX "billing_customers_stripe_customer_id_unique_idx" ON "public"."billing_customers" USING "btree" ("stripe_customer_id") WHERE ("stripe_customer_id" IS NOT NULL);



CREATE INDEX "jobs_active_count_idx" ON "public"."jobs" USING "btree" ("user_id") WHERE ("storage_state" = 'active'::"text");



CREATE INDEX "jobs_active_list_idx" ON "public"."jobs" USING "btree" ("user_id", "created_at" DESC, "id" DESC) WHERE ("storage_state" = 'active'::"text");



CREATE INDEX "jobs_active_lock_selection_idx" ON "public"."jobs" USING "btree" ("user_id", (
CASE
    WHEN ("status" = ANY (ARRAY['offered'::"text", 'interviewing'::"text", 'applied'::"text"])) THEN 0
    ELSE 1
END), "created_at" DESC, "id" DESC) WHERE ("storage_state" = 'active'::"text");



CREATE INDEX "jobs_active_overflow_lock_selection_idx" ON "public"."jobs" USING "btree" ("user_id", (
CASE
    WHEN ("status" = 'offered'::"text") THEN 0
    WHEN ("status" = 'interviewing'::"text") THEN 1
    WHEN ("status" = 'applied'::"text") THEN 2
    ELSE 3
END), "created_at" DESC, "id" DESC) WHERE ("storage_state" = 'active'::"text");



CREATE INDEX "jobs_locked_bulk_delete_idx" ON "public"."jobs" USING "btree" ("user_id", "created_at", "id") WHERE ("storage_state" = 'locked_over_plan_limit'::"text");



CREATE INDEX "jobs_locked_count_idx" ON "public"."jobs" USING "btree" ("user_id") WHERE ("storage_state" = 'locked_over_plan_limit'::"text");



CREATE INDEX "jobs_locked_restore_selection_idx" ON "public"."jobs" USING "btree" ("user_id", (
CASE
    WHEN ("status" = 'offered'::"text") THEN 0
    WHEN ("status" = 'interviewing'::"text") THEN 1
    WHEN ("status" = 'applied'::"text") THEN 2
    ELSE 3
END), "created_at" DESC, "id" DESC) WHERE ("storage_state" = 'locked_over_plan_limit'::"text");



CREATE INDEX "jobs_retained_list_idx" ON "public"."jobs" USING "btree" ("user_id", "created_at" DESC, "id" DESC);



CREATE INDEX "jobs_user_id_created_at_idx" ON "public"."jobs" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "jobs_user_retained_count_idx" ON "public"."jobs" USING "btree" ("user_id");



CREATE INDEX "stripe_event_receipts_processed_at_idx" ON "public"."stripe_event_receipts" USING "btree" ("processed_at");



CREATE INDEX "tailor_cache_created_at_idx" ON "public"."tailor_cache" USING "btree" ("created_at");



CREATE OR REPLACE TRIGGER "advance_billing_subscription_snapshot_version" BEFORE INSERT OR UPDATE ON "public"."billing_subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."advance_billing_subscription_snapshot_version"();



CREATE OR REPLACE TRIGGER "handle_updated_at" BEFORE UPDATE ON "public"."user_profiles" FOR EACH ROW EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');



CREATE OR REPLACE TRIGGER "lock_billing_customers_storage_transition" BEFORE INSERT OR DELETE OR UPDATE ON "public"."billing_customers" FOR EACH ROW EXECUTE FUNCTION "public"."lock_billing_storage_transition"();



CREATE OR REPLACE TRIGGER "lock_billing_subscriptions_storage_transition" BEFORE INSERT OR DELETE OR UPDATE ON "public"."billing_subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."lock_billing_storage_transition"();



CREATE OR REPLACE TRIGGER "set_billing_checkout_sessions_updated_at" BEFORE UPDATE ON "public"."billing_checkout_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."touch_billing_updated_at"();



CREATE OR REPLACE TRIGGER "set_billing_customers_updated_at" BEFORE UPDATE ON "public"."billing_customers" FOR EACH ROW EXECUTE FUNCTION "public"."touch_billing_updated_at"();



CREATE OR REPLACE TRIGGER "set_billing_subscriptions_status_changed_at" BEFORE UPDATE ON "public"."billing_subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."touch_billing_status_changed_at"();



CREATE OR REPLACE TRIGGER "set_billing_subscriptions_updated_at" BEFORE UPDATE ON "public"."billing_subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."touch_billing_updated_at"();



ALTER TABLE ONLY "public"."abuse_counters"
    ADD CONSTRAINT "abuse_counters_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billing_checkout_sessions"
    ADD CONSTRAINT "billing_checkout_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."billing_customers"
    ADD CONSTRAINT "billing_customers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."billing_subscriptions"
    ADD CONSTRAINT "billing_subscriptions_billing_customers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."billing_customers"("user_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."billing_subscriptions"
    ADD CONSTRAINT "billing_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tailor_cache"
    ADD CONSTRAINT "tailor_cache_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Users can delete own jobs" ON "public"."jobs" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own profile" ON "public"."user_profiles" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own cache entries" ON "public"."tailor_cache" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own jobs" ON "public"."jobs" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own profile" ON "public"."user_profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can select own cache entries" ON "public"."tailor_cache" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can select own profile" ON "public"."user_profiles" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own jobs" ON "public"."jobs" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own profile" ON "public"."user_profiles" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own jobs" ON "public"."jobs" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."abuse_counters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing_checkout_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing_customers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "billing_customers_select_own" ON "public"."billing_customers" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."billing_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "billing_subscriptions_select_own" ON "public"."billing_subscriptions" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."daily_spend" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stripe_event_receipts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tailor_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_profiles" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



-- Supabase seeds broad default table privileges before project migrations run.
-- Reassert the final service-owned boundaries recorded by migrations 005-027;
-- otherwise non-DML privileges such as TRUNCATE survive a plain pg_dump replay.
REVOKE ALL ON TABLE "public"."billing_checkout_sessions"
  FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON TABLE "public"."billing_customers"
  FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON TABLE "public"."billing_subscriptions"
  FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON TABLE "public"."jobs"
  FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON TABLE "public"."stripe_event_receipts"
  FROM PUBLIC, "anon", "authenticated";



REVOKE ALL ON FUNCTION "public"."advance_billing_subscription_snapshot_version"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."advance_billing_subscription_snapshot_version"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_billing_checkout_session"("p_user_id" "uuid", "p_plan" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_billing_checkout_session"("p_user_id" "uuid", "p_plan" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_job_with_storage_quota"("p_user_id" "uuid", "p_job_data" "jsonb", "p_storage_status" "text", "p_active_job_limit" integer, "p_absolute_retained_job_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_job_with_storage_quota"("p_user_id" "uuid", "p_job_data" "jsonb", "p_storage_status" "text", "p_active_job_limit" integer, "p_absolute_retained_job_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_locked_jobs_for_terminal_free_user"("p_user_id" "uuid", "p_storage_status" "text", "p_locked_delete_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_locked_jobs_for_terminal_free_user"("p_user_id" "uuid", "p_storage_status" "text", "p_locked_delete_limit" integer) TO "service_role";







REVOKE ALL ON FUNCTION "public"."get_job_storage_counts_for_user"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_job_storage_counts_for_user"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."lock_billing_storage_transition"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."lock_billing_storage_transition"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."lock_overflow_jobs_for_terminal_free_user"("p_user_id" "uuid", "p_storage_status" "text", "p_active_job_limit" integer, "p_locked_reason" "text", "p_locked_policy_version" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."lock_overflow_jobs_for_terminal_free_user"("p_user_id" "uuid", "p_storage_status" "text", "p_active_job_limit" integer, "p_locked_reason" "text", "p_locked_policy_version" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."merge_stripe_event_receipt"("p_event_id" "text", "p_event_type" "text", "p_livemode" boolean, "p_stripe_event_created" timestamp with time zone, "p_result" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."merge_stripe_event_receipt"("p_event_id" "text", "p_event_type" "text", "p_livemode" boolean, "p_stripe_event_created" timestamp with time zone, "p_result" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."resolve_canonical_storage_status_for_user"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_canonical_storage_status_for_user"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION public.restore_locked_jobs_for_premium_user(uuid, text, integer, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_locked_jobs_for_premium_user(uuid, text, integer, text[])
  TO service_role;



GRANT ALL ON FUNCTION "public"."touch_billing_status_changed_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_billing_status_changed_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_billing_status_changed_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_billing_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_billing_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_billing_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_billing_subscription_authoritative"("payload" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_billing_subscription_authoritative"("payload" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_billing_subscription_if_newer_or_equal"("payload" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_billing_subscription_if_newer_or_equal"("payload" "jsonb") TO "service_role";



GRANT ALL ON TABLE "public"."abuse_counters" TO "anon";
GRANT ALL ON TABLE "public"."abuse_counters" TO "authenticated";
GRANT ALL ON TABLE "public"."abuse_counters" TO "service_role";



GRANT ALL ON TABLE "public"."billing_checkout_sessions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."billing_checkout_sessions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."billing_checkout_sessions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."billing_checkout_sessions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."billing_customers" TO "service_role";
GRANT SELECT ON TABLE "public"."billing_customers" TO "authenticated";



GRANT ALL ON TABLE "public"."billing_subscriptions" TO "service_role";
GRANT SELECT ON TABLE "public"."billing_subscriptions" TO "authenticated";



GRANT ALL ON TABLE "public"."daily_spend" TO "anon";
GRANT ALL ON TABLE "public"."daily_spend" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_spend" TO "service_role";



GRANT ALL ON TABLE "public"."jobs" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_event_receipts" TO "service_role";



GRANT ALL ON TABLE "public"."tailor_cache" TO "anon";
GRANT ALL ON TABLE "public"."tailor_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."tailor_cache" TO "service_role";



GRANT ALL ON TABLE "public"."user_profiles" TO "anon";
GRANT ALL ON TABLE "public"."user_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_profiles" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM PUBLIC, "anon", "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON FUNCTIONS FROM PUBLIC, "anon", "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM PUBLIC, "anon", "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";

COMMIT;
