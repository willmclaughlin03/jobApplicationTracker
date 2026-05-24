-- Add server-owned pending Checkout Session dedupe.
--
-- Purpose:
--   - serialize checkout claims for one user and plan inside Postgres
--   - let authenticated billing routes reuse an existing unexpired Stripe
--     Checkout Session instead of minting multiple active sessions
--   - keep pending checkout rows service-role controlled; they do not grant
--     entitlement and are only an audit/dedupe boundary

CREATE TABLE public.billing_checkout_sessions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL
    REFERENCES auth.users (id)
    ON DELETE RESTRICT,
  plan text NOT NULL,
  stripe_checkout_session_id text NULL,
  checkout_url text NULL,
  status text NOT NULL,
  expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT billing_checkout_sessions_plan_format_check
    CHECK (char_length(btrim(plan)) > 0 AND char_length(plan) <= 120),
  CONSTRAINT billing_checkout_sessions_plan_allowed_check
    CHECK (plan IN ('resume_tailor_monthly')),
  CONSTRAINT billing_checkout_sessions_status_check
    CHECK (
      status IN (
        'creating',
        'open',
        'complete',
        'expired',
        'failed'
      )
    ),
  CONSTRAINT billing_checkout_sessions_stripe_session_id_format_check
    CHECK (
      stripe_checkout_session_id IS NULL
      OR stripe_checkout_session_id ~ '^cs_(test|live)_[^[:space:]]+$'
    ),
  CONSTRAINT billing_checkout_sessions_open_fields_check
    CHECK (
      status <> 'open'
      OR (
        stripe_checkout_session_id IS NOT NULL
        AND checkout_url IS NOT NULL
        AND expires_at IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX billing_checkout_sessions_active_user_plan_idx
  ON public.billing_checkout_sessions (user_id, plan)
  WHERE status IN ('creating', 'open');

CREATE UNIQUE INDEX billing_checkout_sessions_stripe_session_id_unique_idx
  ON public.billing_checkout_sessions (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE INDEX billing_checkout_sessions_user_session_idx
  ON public.billing_checkout_sessions (user_id, stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE TRIGGER set_billing_checkout_sessions_updated_at
BEFORE UPDATE ON public.billing_checkout_sessions
FOR EACH ROW
EXECUTE FUNCTION public.touch_billing_updated_at();

ALTER TABLE public.billing_checkout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_checkout_sessions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.billing_checkout_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.billing_checkout_sessions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.billing_checkout_sessions_id_seq TO service_role;

-- claim_billing_checkout_session(p_user_id, p_plan)
--
-- Ordering semantics:
--   - takes an advisory transaction lock scoped to the user and plan
--   - expires stale open rows before looking for a reusable session
--   - releases old creating rows so a crashed serverless invocation cannot
--     permanently block checkout
--   - inserts exactly one creating row when no active pending row remains
--
-- Permission model:
--   - SECURITY INVOKER with a pinned search_path
--   - execute revoked from PUBLIC, anon, and authenticated
--   - execute granted only to service_role
CREATE FUNCTION public.claim_billing_checkout_session(
  p_user_id uuid,
  p_plan text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
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

  IF normalized_plan NOT IN ('resume_tailor_monthly') THEN
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

REVOKE ALL ON FUNCTION public.claim_billing_checkout_session(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_billing_checkout_session(uuid, text)
  TO service_role;
