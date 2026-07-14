-- WARNING: RECONSTRUCTED HISTORICAL MIGRATION.
-- The original SQL is unavailable. This functional equivalent was reconstructed
-- from authoritative PostgreSQL catalogs captured on 2026-07-13. Its formatting
-- and statement order are not original history. The active deployable migration
-- chain remains the timestamped baseline under supabase/migrations/.

CREATE TABLE public.daily_spend (
  date date PRIMARY KEY,
  total_cost_cents bigint NOT NULL DEFAULT 0
);

ALTER TABLE public.daily_spend ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.daily_spend TO anon;
GRANT ALL ON TABLE public.daily_spend TO authenticated;
GRANT ALL ON TABLE public.daily_spend TO service_role;
