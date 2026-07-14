-- WARNING: RECONSTRUCTED HISTORICAL MIGRATION.
-- The original SQL is unavailable. This functional equivalent was reconstructed
-- from authoritative PostgreSQL catalogs captured on 2026-07-13. Its formatting
-- and statement order are not original history. The active deployable migration
-- chain remains the timestamped baseline under supabase/migrations/.

CREATE TABLE public.abuse_counters (
  user_id uuid NOT NULL
    REFERENCES auth.users (id)
    ON DELETE CASCADE,
  strike_type text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT pg_catalog.now(),
  disabled_at timestamptz NULL,
  PRIMARY KEY (user_id, strike_type)
);

ALTER TABLE public.abuse_counters ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.abuse_counters TO anon;
GRANT ALL ON TABLE public.abuse_counters TO authenticated;
GRANT ALL ON TABLE public.abuse_counters TO service_role;
