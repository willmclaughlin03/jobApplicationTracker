-- Additive Phase 2 follow-up migration.
-- Enforces that every billing_subscriptions row belongs to an existing
-- billing_customers row for the same user_id.
--
-- Existing environments must backfill any orphaned subscription rows before
-- applying this migration.

ALTER TABLE public.billing_subscriptions
  ADD CONSTRAINT billing_subscriptions_billing_customers_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES public.billing_customers (user_id)
  ON DELETE RESTRICT;
