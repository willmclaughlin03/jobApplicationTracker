-- Add ordered-read index for retained jobs dashboard list paths.
--
-- Purpose:
--   - let Premium normal dashboard lists use an owner-scoped index that matches
--     the application sort order without relying on the active-only partial index
--   - keep this additive so active, lock-selection, restore, and bulk-delete
--     indexes remain available for their narrower predicates

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'public.jobs must exist before applying retained list index migration'
      USING ERRCODE = '42P01';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.jobs'::regclass
      AND attname = 'user_id'
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.jobs'::regclass
      AND attname = 'created_at'
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.jobs'::regclass
      AND attname = 'id'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'public.jobs must include user_id, created_at, and id before applying retained list index migration'
      USING ERRCODE = '42703';
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS jobs_retained_list_idx
  ON public.jobs (user_id, created_at DESC, id DESC);