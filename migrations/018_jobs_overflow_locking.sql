-- Add idempotent downgrade overflow locking.
--
-- Purpose:
--   - preserve exactly the Free active-job allowance after a confirmed terminal
--     downgrade without deleting user data
--   - keep lock selection deterministic and status-aware
--   - serialize with the existing create quota RPC for the same user so
--     concurrent creates and downgrade repair cannot race the active count

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'public.jobs must exist before applying overflow locking migration'
      USING ERRCODE = '42P01';
  END IF;

  IF pg_catalog.to_regclass('public.billing_customers') IS NULL
     OR pg_catalog.to_regclass('public.billing_subscriptions') IS NULL THEN
    RAISE EXCEPTION 'billing tables must exist before applying overflow locking migration'
      USING ERRCODE = '42P01';
  END IF;
END;
$$;

-- lock_billing_storage_transition()
--
-- Purpose:
--   - serialize canonical billing writes with storage create/lock decisions for
--     the same user
--   - let storage RPCs recheck billing while holding a lock that billing table
--     inserts, updates, and deletes must also acquire
CREATE OR REPLACE FUNCTION public.lock_billing_storage_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
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

DROP TRIGGER IF EXISTS lock_billing_customers_storage_transition
  ON public.billing_customers;
CREATE TRIGGER lock_billing_customers_storage_transition
BEFORE INSERT OR UPDATE OR DELETE ON public.billing_customers
FOR EACH ROW
EXECUTE FUNCTION public.lock_billing_storage_transition();

DROP TRIGGER IF EXISTS lock_billing_subscriptions_storage_transition
  ON public.billing_subscriptions;
CREATE TRIGGER lock_billing_subscriptions_storage_transition
BEFORE INSERT OR UPDATE OR DELETE ON public.billing_subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.lock_billing_storage_transition();

REVOKE ALL ON FUNCTION public.lock_billing_storage_transition()
  FROM PUBLIC, anon, authenticated;

-- resolve_canonical_storage_status_for_user(...)
--
-- Purpose:
--   - reproduce the database-observable portion of the server storage-status
--     classifier while holding the shared billing/storage advisory lock
--   - reject stale caller status strings when billing changed after the service
--     read but before a jobs mutation began
CREATE OR REPLACE FUNCTION public.resolve_canonical_storage_status_for_user(
  p_user_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
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

REVOKE ALL ON FUNCTION public.resolve_canonical_storage_status_for_user(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_canonical_storage_status_for_user(uuid)
  TO service_role;

-- upsert_billing_subscription_authoritative(payload)
--
-- Purpose:
--   - preserve ordinary authoritative Stripe refresh behavior
--   - optionally compare the caller's local subscription id and updated_at
--     snapshot before writing so an old cancellation fetch cannot replace a
--     newer subscription or re-entitlement
CREATE OR REPLACE FUNCTION public.upsert_billing_subscription_authoritative(
  payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  incoming_user_id uuid;
  expected_subscription_id text;
  expected_subscription_updated_at timestamptz;
  has_expected_snapshot boolean;
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

  has_expected_snapshot :=
    payload ? '_expected_stripe_subscription_id'
    OR payload ? '_expected_subscription_updated_at';

  IF has_expected_snapshot
     AND (
       NOT (payload ? '_expected_stripe_subscription_id')
       OR NOT (payload ? '_expected_subscription_updated_at')
     ) THEN
    RAISE EXCEPTION 'complete expected billing snapshot is required'
      USING ERRCODE = '22023';
  END IF;

  IF has_expected_snapshot THEN
    expected_subscription_id :=
      NULLIF(pg_catalog.btrim(payload->>'_expected_stripe_subscription_id'), '');
    expected_subscription_updated_at :=
      NULLIF(pg_catalog.btrim(payload->>'_expected_subscription_updated_at'), '')::timestamptz;

    IF expected_subscription_id IS NULL
       OR expected_subscription_updated_at IS NULL THEN
      RAISE EXCEPTION 'expected billing snapshot is invalid'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(incoming_user_id::text),
    hashtext('billing_storage_transition')
  );

  IF has_expected_snapshot THEN
    SELECT *
    INTO current_subscription
    FROM public.billing_subscriptions
    WHERE user_id = incoming_user_id;

    IF NOT FOUND
       OR current_subscription.stripe_subscription_id IS DISTINCT FROM expected_subscription_id
       OR current_subscription.updated_at IS DISTINCT FROM expected_subscription_updated_at THEN
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
    FROM incoming
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
$$;

REVOKE ALL ON FUNCTION public.upsert_billing_subscription_authoritative(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_billing_subscription_authoritative(jsonb)
  TO service_role;

-- create_job_with_storage_quota(...)
--
-- Purpose:
--   - preserve Chunk 4's atomic count-and-insert behavior
--   - recheck canonical billing under the shared billing/storage lock before
--     taking the jobs quota lock, preventing stale Premium or Free creates
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

REVOKE ALL ON FUNCTION public.create_job_with_storage_quota(uuid, jsonb, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_job_with_storage_quota(uuid, jsonb, text, integer, integer)
  TO service_role;

CREATE INDEX IF NOT EXISTS jobs_active_overflow_lock_selection_idx
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
  WHERE storage_state = 'active';

-- lock_overflow_jobs_for_terminal_free_user(...)
--
-- Ordering semantics:
--   - takes the same per-user advisory transaction lock as create quota checks
--     before reading or mutating active rows
--   - ranks currently active rows by status priority, then created_at DESC,
--     id DESC, and locks rows ranked after the Free active limit
--   - updates only rows that are still active at update time, making repeated
--     runs and concurrent lock attempts idempotent
--
-- Permission model:
--   - SECURITY INVOKER with a pinned search_path
--   - execute revoked from PUBLIC, anon, and authenticated
--   - execute granted only to service_role
CREATE OR REPLACE FUNCTION public.lock_overflow_jobs_for_terminal_free_user(
  p_user_id uuid,
  p_storage_status text,
  p_active_job_limit integer,
  p_locked_reason text,
  p_locked_policy_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
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

REVOKE ALL ON FUNCTION public.lock_overflow_jobs_for_terminal_free_user(uuid, text, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_overflow_jobs_for_terminal_free_user(uuid, text, integer, text, text)
  TO service_role;
