-- Resolve equal-timestamp Stripe subscription event conflicts deterministically.
--
-- Purpose:
--   - prevent a delayed nonterminal snapshot from restoring entitlement after
--     an equal-time terminal snapshot for the same subscription
--   - keep ambiguous equal-time business snapshots retryable instead of
--     acknowledging them as stale
--   - require verified Checkout completion, not timestamp equality alone, to
--     replace a different terminal subscription at the same event timestamp

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.billing_subscriptions') IS NULL THEN
    RAISE EXCEPTION 'public.billing_subscriptions must exist before applying equal-time event ordering'
      USING ERRCODE = '42P01';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.billing_subscriptions'::regclass
      AND attname = 'snapshot_version'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'migration 026 snapshot guards must exist before applying equal-time event ordering'
      USING ERRCODE = '42703';
  END IF;
END;
$$;

-- upsert_billing_subscription_if_newer_or_equal(payload)
--
-- Purpose:
--   - retain the existing RPC name while replacing blanket >= ordering with a
--     locked, field-aware equal-timestamp decision
--   - return stable no-op/conflict reasons so application instances can keep
--     unresolved receipts failed and retryable
CREATE OR REPLACE FUNCTION public.upsert_billing_subscription_if_newer_or_equal(
  payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
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

REVOKE ALL ON FUNCTION public.upsert_billing_subscription_if_newer_or_equal(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_billing_subscription_if_newer_or_equal(jsonb)
  TO service_role;
