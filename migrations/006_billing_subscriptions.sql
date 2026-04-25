-- Session-only migration draft for Phase 2 billing schema review.
-- This file is intentionally kept under the repo-root tracked migrations/ folder.
-- Requires 005_billing_customers.sql to run first so the shared trigger helper exists.
--
-- ON DELETE RESTRICT mirrors billing_customers. See 005 header for the
-- required service-role teardown order before deleting an auth.users row.

CREATE TABLE public.billing_subscriptions (
  user_id uuid PRIMARY KEY
    REFERENCES auth.users (id)
    ON DELETE RESTRICT,
  stripe_subscription_id text NOT NULL UNIQUE,
  stripe_customer_id text NULL,
  price_id text NULL,
  status text NOT NULL,
  current_period_end timestamptz NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  last_stripe_event_created timestamptz NULL,
  status_changed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT billing_subscriptions_status_check
    CHECK (
      status IN (
        'active',
        'past_due',
        'unpaid',
        'canceled',
        'paused',
        'incomplete',
        'incomplete_expired'
      )
    ),
  CONSTRAINT billing_subscriptions_stripe_subscription_id_format_check
    CHECK (stripe_subscription_id ~ '^sub_[^[:space:]]+$'),
  CONSTRAINT billing_subscriptions_stripe_customer_id_format_check
    CHECK (
      stripe_customer_id IS NULL
      OR stripe_customer_id ~ '^cus_[^[:space:]]+$'
    )
);

CREATE TRIGGER set_billing_subscriptions_updated_at
BEFORE UPDATE ON public.billing_subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.touch_billing_updated_at();

ALTER TABLE public.billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_subscriptions FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_subscriptions_select_own
  ON public.billing_subscriptions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.billing_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.billing_subscriptions TO authenticated;

-- Deferred indexes (not added in this phase):
--   * billing_subscriptions(stripe_customer_id)
--       — useful for webhook handlers that arrive with customer id only.
--   * billing_subscriptions(status, current_period_end)
--       — useful for the reconciliation cron that sweeps active
--         rows near period end.
-- Add these alongside the phase that introduces the corresponding query
-- paths, not speculatively here.
