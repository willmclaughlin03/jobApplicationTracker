-- Fix billing subscription event RPC ambiguity.
--
-- Purpose:
--   - repair upsert_billing_subscription_if_newer_or_equal(jsonb) on databases
--     where the 011 function body can fail with SQLSTATE 42702 because PL/pgSQL
--     variables share names with CTE output columns
--   - keep the event-ordering contract unchanged so webhooks can stamp
--     last_stripe_event_created without weakening stale-event protection

CREATE OR REPLACE FUNCTION public.upsert_billing_subscription_if_newer_or_equal(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_applied boolean;
  v_subscription jsonb;
  v_reason text;
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
      true AS result_applied,
      to_jsonb(billing_subscriptions) AS result_subscription,
      'applied'::text AS result_reason
  ),
  final_result AS (
    SELECT
      attempted.result_applied,
      attempted.result_subscription,
      attempted.result_reason
    FROM attempted

    UNION ALL

    SELECT
      false AS result_applied,
      to_jsonb(billing_subscriptions) AS result_subscription,
      CASE
        WHEN incoming.last_stripe_event_created < billing_subscriptions.last_stripe_event_created
          THEN 'stale_ignored'
        WHEN billing_subscriptions.stripe_subscription_id IS NOT NULL
          AND incoming.stripe_subscription_id IS DISTINCT FROM billing_subscriptions.stripe_subscription_id
          AND billing_subscriptions.status NOT IN ('canceled', 'incomplete_expired')
          THEN 'non_current_ignored'
        ELSE 'not_applied'
      END AS result_reason
    FROM public.billing_subscriptions
    JOIN incoming
      ON incoming.user_id = billing_subscriptions.user_id
    WHERE NOT EXISTS (SELECT 1 FROM attempted)
  )
  SELECT
    final_result.result_applied,
    final_result.result_subscription,
    final_result.result_reason
  INTO v_applied, v_subscription, v_reason
  FROM final_result;

  RETURN jsonb_build_object(
    'applied', v_applied,
    'subscription', v_subscription,
    'reason', v_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_billing_subscription_if_newer_or_equal(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_billing_subscription_if_newer_or_equal(jsonb)
  TO service_role;
