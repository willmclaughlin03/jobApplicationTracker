-- Session-only migration draft for Phase 2 billing schema review.
-- This file is intentionally kept under the gitignored repo-root migrations/ folder.
--
-- event_type length cap:
--   The 255-character limit is an operational sanity guardrail, not a primary
--   security boundary. Widen it if Stripe introduces longer valid event types.

CREATE TABLE public.stripe_event_receipts (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  livemode boolean NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  stripe_event_created timestamptz NOT NULL,
  result text NOT NULL,
  CONSTRAINT stripe_event_receipts_event_id_format_check
    CHECK (event_id ~ '^evt_[^[:space:]]+$'),
  CONSTRAINT stripe_event_receipts_result_check
    CHECK (
      result IN (
        'processed',
        'duplicate_ignored',
        'stale_ignored',
        'failed'
      )
    ),
  CONSTRAINT stripe_event_receipts_event_type_length_check
    CHECK (char_length(event_type) <= 255)
);

CREATE INDEX stripe_event_receipts_processed_at_idx
  ON public.stripe_event_receipts (processed_at);

ALTER TABLE public.stripe_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_event_receipts FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.stripe_event_receipts FROM PUBLIC, anon, authenticated;
