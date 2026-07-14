-- WARNING: RECONSTRUCTED HISTORICAL MIGRATION.
-- The original SQL is unavailable. This functional equivalent was reconstructed
-- from authoritative PostgreSQL catalogs captured on 2026-07-13. Its formatting
-- and statement order are not original history. The active deployable migration
-- chain remains the timestamped baseline under supabase/migrations/.

CREATE TABLE public.tailor_cache (
  hash text PRIMARY KEY,
  user_id uuid NOT NULL
    REFERENCES auth.users (id)
    ON DELETE CASCADE,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX tailor_cache_created_at_idx
  ON public.tailor_cache (created_at);

ALTER TABLE public.tailor_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own cache entries"
  ON public.tailor_cache
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can select own cache entries"
  ON public.tailor_cache
  FOR SELECT
  USING (auth.uid() = user_id);

GRANT ALL ON TABLE public.tailor_cache TO anon;
GRANT ALL ON TABLE public.tailor_cache TO authenticated;
GRANT ALL ON TABLE public.tailor_cache TO service_role;
