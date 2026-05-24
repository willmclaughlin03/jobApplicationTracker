-- Additive billing follow-up migration.
-- Removes `trialing` from the allowed local subscription status set now that
-- the product does not offer trial subscriptions.
--
-- Existing environments must normalize any lingering `trialing` rows before
-- applying this migration or the replacement constraint will fail validation.

ALTER TABLE public.billing_subscriptions
  DROP CONSTRAINT IF EXISTS billing_subscriptions_status_check;

ALTER TABLE public.billing_subscriptions
  ADD CONSTRAINT billing_subscriptions_status_check
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
  );
