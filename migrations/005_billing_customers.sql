-- Session-only migration draft for Phase 2 billing schema review.
-- This file is intentionally kept under the gitignored repo-root migrations/ folder.
--
-- ON DELETE RESTRICT on auth.users(id):
--   Deleting an auth.users row will ERROR while any billing_customers or
--   billing_subscriptions row references it. This is intentional — billing
--   teardown must be deliberate.
--
--   Required service-role teardown order before deleting an auth user:
--     1. DELETE FROM public.billing_subscriptions WHERE user_id = $1;
--     2. DELETE FROM public.billing_customers     WHERE user_id = $1;
--     3. auth.admin.deleteUser($1);
--
--   A later phase must also ensure the Stripe-side customer/subscription is
--   canceled or archived before step 3; this DB constraint does not enforce
--   that.

CREATE FUNCTION public.touch_billing_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

CREATE TABLE public.billing_customers (
  user_id uuid PRIMARY KEY
    REFERENCES auth.users (id)
    ON DELETE RESTRICT,
  stripe_customer_id text NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT billing_customers_stripe_customer_id_format_check
    CHECK (
      stripe_customer_id IS NULL
      OR stripe_customer_id ~ '^cus_[^[:space:]]+$'
    )
);

CREATE UNIQUE INDEX billing_customers_stripe_customer_id_unique_idx
  ON public.billing_customers (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE TRIGGER set_billing_customers_updated_at
BEFORE UPDATE ON public.billing_customers
FOR EACH ROW
EXECUTE FUNCTION public.touch_billing_updated_at();

ALTER TABLE public.billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_customers FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_customers_select_own
  ON public.billing_customers
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.billing_customers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.billing_customers TO authenticated;
