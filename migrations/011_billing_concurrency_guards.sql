-- Additive billing hardening migration.
-- Introduces service-role-only RPCs so race-sensitive billing writes happen
-- atomically inside Postgres instead of as JS read-check-write sequences.

-- upsert_billing_subscription_if_newer_or_equal(payload jsonb)
--
-- Ordering semantics:
--   - event-driven writes must provide a non-null last_stripe_event_created
--   - incoming events win when their timestamp is newer or equal
--   - older events preserve the existing row and return applied = false
--
-- Null-handling semantics:
--   - missing/null last_stripe_event_created is rejected because event-mode
--     writes must not weaken stale-event ordering
--   - other fields use the payload values directly because event-mode writes
--     are authoritative snapshots from the winning event
--
-- Permission model:
--   - SECURITY INVOKER with a pinned search_path
--   - execute revoked from PUBLIC, anon, and authenticated
--   - execute granted only to service_role
CREATE FUNCTION public.upsert_billing_subscription_if_newer_or_equal(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  applied boolean;
  subscription jsonb;
  reason text;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'payload must be a json object'
      USING ERRCODE = '22023';
  END IF;

  IF NOT (payload ? 'last_stripe_event_created')
     OR payload->'last_stripe_event_created' = 'null'::jsonb THEN
    RAISE EXCEPTION 'last_stripe_event_created is required for event-driven billing writes'
      USING ERRCODE = '23502';
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
  attempted AS (
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
      stripe_subscription_id = excluded.stripe_subscription_id,
      stripe_customer_id = excluded.stripe_customer_id,
      price_id = excluded.price_id,
      status = excluded.status,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end,
      last_stripe_event_created = excluded.last_stripe_event_created
    WHERE (
        billing_subscriptions.last_stripe_event_created IS NULL
        OR excluded.last_stripe_event_created >= billing_subscriptions.last_stripe_event_created
      )
      AND (
        billing_subscriptions.stripe_subscription_id IS NULL
        OR excluded.stripe_subscription_id IS NOT DISTINCT FROM billing_subscriptions.stripe_subscription_id
        OR billing_subscriptions.status IN ('canceled', 'incomplete_expired')
      )
    RETURNING
      true AS applied,
      to_jsonb(billing_subscriptions) AS subscription,
      'applied'::text AS reason
  ),
  final_result AS (
    SELECT applied, subscription, reason
    FROM attempted

    UNION ALL

    SELECT
      false AS applied,
      to_jsonb(billing_subscriptions) AS subscription,
      CASE
        WHEN incoming.last_stripe_event_created < billing_subscriptions.last_stripe_event_created
          THEN 'stale_ignored'
        WHEN billing_subscriptions.stripe_subscription_id IS NOT NULL
          AND incoming.stripe_subscription_id IS DISTINCT FROM billing_subscriptions.stripe_subscription_id
          AND billing_subscriptions.status NOT IN ('canceled', 'incomplete_expired')
          THEN 'non_current_ignored'
        ELSE 'not_applied'
      END AS reason
    FROM public.billing_subscriptions
    JOIN incoming
      ON incoming.user_id = billing_subscriptions.user_id
    WHERE NOT EXISTS (SELECT 1 FROM attempted)
  )
  SELECT final_result.applied, final_result.subscription, final_result.reason
  INTO applied, subscription, reason
  FROM final_result;

  RETURN jsonb_build_object(
    'applied', applied,
    'subscription', subscription,
    'reason', reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_billing_subscription_if_newer_or_equal(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_billing_subscription_if_newer_or_equal(jsonb)
  TO service_role;

-- upsert_billing_subscription_authoritative(payload jsonb)
--
-- Ordering semantics:
--   - non-event reconcile writes always apply
--   - business fields update only when their keys are present in the JSON
--
-- Null-handling semantics:
--   - present business-field keys with JSON null write SQL NULL
--   - omitted business-field keys leave the existing column untouched
--   - last_stripe_event_created is intentionally different: omitted or JSON
--     null preserves the existing staleness key so authoritative reconciles do
--     not erase event-ordering state
--
-- Permission model:
--   - SECURITY INVOKER with a pinned search_path
--   - execute revoked from PUBLIC, anon, and authenticated
--   - execute granted only to service_role
CREATE FUNCTION public.upsert_billing_subscription_authoritative(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  subscription jsonb;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'payload must be a json object'
      USING ERRCODE = '22023';
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

  RETURN jsonb_build_object('subscription', subscription);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_billing_subscription_authoritative(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_billing_subscription_authoritative(jsonb)
  TO service_role;

-- Replace the original receipt result check from 007 without editing that
-- already-reviewed migration. This keeps fresh and partially-applied
-- environments on the same Chunk 6 receipt contract after 011 runs.
ALTER TABLE public.stripe_event_receipts
  DROP CONSTRAINT IF EXISTS stripe_event_receipts_result_check;

ALTER TABLE public.stripe_event_receipts
  ADD CONSTRAINT stripe_event_receipts_result_check
    CHECK (
      result IN (
        'processing',
        'processed',
        'stale_ignored',
        'failed'
      )
    );

-- merge_stripe_event_receipt(...)
--
-- Ordering semantics:
--   - inserts a new receipt when absent
--   - preserves already-terminal successful receipts instead of downgrading
--     them to failed or another non-terminal result
--   - transitions failed receipts back to processing for retries
--   - returns processing_active for same-envelope in-flight work
--   - reclaims processing receipts older than five minutes
--
-- Null-handling semantics:
--   - SQL/table constraints remain the primary validation boundary here
--   - processed_at doubles as the processing claim timestamp until a separate
--     receipt timing model exists
--   - processed_at refreshes on processing claims/reclaims and terminal writes
--
-- Permission model:
--   - SECURITY INVOKER with a pinned search_path
--   - execute revoked from PUBLIC, anon, and authenticated
--   - execute granted only to service_role
CREATE FUNCTION public.merge_stripe_event_receipt(
  p_event_id text,
  p_event_type text,
  p_livemode boolean,
  p_stripe_event_created timestamptz,
  p_result text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
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

REVOKE ALL ON FUNCTION public.merge_stripe_event_receipt(text, text, boolean, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_stripe_event_receipt(text, text, boolean, timestamptz, text)
  TO service_role;
