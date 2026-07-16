-- WARNING: RECONSTRUCTED HISTORICAL MIGRATION.
-- The original SQL is unavailable. This functional equivalent was reconstructed
-- from authoritative PostgreSQL catalogs captured on 2026-07-13. Its formatting
-- and statement order are not original history. The active deployable migration
-- chain remains the timestamped baseline under supabase/migrations/.

CREATE EXTENSION IF NOT EXISTS moddatetime WITH SCHEMA extensions;

CREATE TABLE public.user_profiles (
  user_id uuid PRIMARY KEY
    REFERENCES auth.users (id)
    ON DELETE CASCADE,
  summary text NULL,
  experience jsonb NULL,
  skills_technical text[] NULL,
  skills_soft text[] NULL,
  education jsonb NULL,
  certifications jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE TRIGGER handle_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION extensions.moddatetime('updated_at');

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own profile"
  ON public.user_profiles
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile"
  ON public.user_profiles
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON public.user_profiles
  FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own profile"
  ON public.user_profiles
  FOR DELETE
  USING (auth.uid() = user_id);

GRANT ALL ON TABLE public.user_profiles TO anon;
GRANT ALL ON TABLE public.user_profiles TO authenticated;
GRANT ALL ON TABLE public.user_profiles TO service_role;
