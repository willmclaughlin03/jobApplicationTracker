-- Add ordered-read indexes for jobs dashboard list paths.
--
-- Purpose:
--   - let the active dashboard list use an owner-scoped index that already
--     matches the application sort order
--   - keep this separate from lock-selection, restore, and bulk-delete indexes
--     because those paths have different predicates or ordering semantics

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'public.jobs must exist before applying ordered reads migration'
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
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.jobs'::regclass
      AND attname = 'storage_state'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'public.jobs must include user_id, created_at, id, and storage_state before applying ordered reads migration'
      USING ERRCODE = '42703';
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS jobs_active_list_idx
  ON public.jobs (user_id, created_at DESC, id DESC)
  WHERE storage_state = 'active';
