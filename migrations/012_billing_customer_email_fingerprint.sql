-- Add a best-effort Stripe email-sync fingerprint to billing_customers.
--
-- Purpose:
--   - lets mapped-customer billing flows skip no-op Stripe email updates
--   - remains advisory only; entitlement and customer ownership stay anchored
--     to the existing canonical billing tables

ALTER TABLE public.billing_customers
  ADD COLUMN last_synced_stripe_email_fingerprint text NULL;

ALTER TABLE public.billing_customers
  ADD CONSTRAINT billing_customers_last_synced_stripe_email_fingerprint_format_check
  CHECK (
    last_synced_stripe_email_fingerprint IS NULL
    OR last_synced_stripe_email_fingerprint ~ '^[0-9a-f]{64}$'
  );
