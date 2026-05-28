-- Forward the pending Checkout Session plan allowlist to premium_monthly.
--
-- Purpose:
--   - update already-applied Chunk 7 databases after the app-level billing
--     contract moved from resume-tailor-specific naming to generic premium
--     access
--   - keep the database RPC and table constraint aligned with the route/body
--     validation allowlist
--   - release active legacy pending rows before renaming historical rows so a
--     new premium_monthly checkout claim can proceed without unique-index
--     collisions

ALTER TABLE public.billing_checkout_sessions
  DROP CONSTRAINT IF EXISTS billing_checkout_sessions_plan_allowed_check;

UPDATE public.billing_checkout_sessions
SET status = CASE
    WHEN status = 'creating' THEN 'failed'
    WHEN status = 'open' THEN 'expired'
    ELSE status
  END
WHERE plan = 'resume_tailor_monthly'
  AND status IN ('creating', 'open');

UPDATE public.billing_checkout_sessions
SET plan = 'premium_monthly'
WHERE plan = 'resume_tailor_monthly';

ALTER TABLE public.billing_checkout_sessions
  ADD CONSTRAINT billing_checkout_sessions_plan_allowed_check
    CHECK (plan IN ('premium_monthly'));

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
CREATE OR REPLACE FUNCTION public.claim_billing_checkout_session(
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

REVOKE ALL ON FUNCTION public.claim_billing_checkout_session(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_billing_checkout_session(uuid, text)
  TO service_role;
