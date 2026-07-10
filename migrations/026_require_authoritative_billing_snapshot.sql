-- Require monotonic snapshot guards for authoritative Stripe reconciliation.
--
-- Purpose:
--   - replace optional timestamp-based authoritative guards with a mandatory,
--     exact-absence or exact-id/version compare-and-swap contract
--   - keep Checkout replacement authority distinct from same-subscription
--     reconciliation and enforce that distinction inside PostgreSQL
--   - make every subscription mutation advance a collision-free local version

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.billing_subscriptions') IS NULL THEN
    RAISE EXCEPTION 'public.billing_subscriptions must exist before applying authoritative snapshot guards'
      USING ERRCODE = '42P01';
  END IF;
END;
$$;

ALTER TABLE public.billing_subscriptions
  ADD COLUMN IF NOT EXISTS snapshot_version bigint NOT NULL DEFAULT 1;

UPDATE public.billing_subscriptions
SET snapshot_version = 1
WHERE snapshot_version IS NULL;

ALTER TABLE public.billing_subscriptions
  ALTER COLUMN snapshot_version SET DEFAULT 1,
  ALTER COLUMN snapshot_version SET NOT NULL;

ALTER TABLE public.billing_subscriptions
  DROP CONSTRAINT IF EXISTS billing_subscriptions_snapshot_version_check;
ALTER TABLE public.billing_subscriptions
  ADD CONSTRAINT billing_subscriptions_snapshot_version_check
  CHECK (snapshot_version > 0);

-- advance_billing_subscription_snapshot_version()
--
-- Purpose:
--   - make snapshot_version an enforced database-owned mutation counter
--   - ignore caller-supplied versions so direct service-role writes cannot
--     accidentally reuse a prior compare-and-swap token
CREATE OR REPLACE FUNCTION public.advance_billing_subscription_snapshot_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
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

DROP TRIGGER IF EXISTS advance_billing_subscription_snapshot_version
  ON public.billing_subscriptions;
CREATE TRIGGER advance_billing_subscription_snapshot_version
BEFORE INSERT OR UPDATE ON public.billing_subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.advance_billing_subscription_snapshot_version();

REVOKE ALL ON FUNCTION public.advance_billing_subscription_snapshot_version()
  FROM PUBLIC, anon, authenticated;

-- upsert_billing_subscription_authoritative(payload)
--
-- Purpose:
--   - require every direct Stripe refresh to prove the exact local row version
--     or exact row absence observed before the provider fetch
--   - permit different-subscription replacement only for verified Checkout
--     completion and only over a locked terminal-replaceable row
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

  IF authoritative_sync_purpose NOT IN ('reconcile_current', 'checkout_completion') THEN
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
$$;

REVOKE ALL ON FUNCTION public.upsert_billing_subscription_authoritative(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_billing_subscription_authoritative(jsonb)
  TO service_role;
