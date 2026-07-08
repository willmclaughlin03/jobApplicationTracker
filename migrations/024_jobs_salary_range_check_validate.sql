-- Validate the versioned salary range invariant for jobs.
--
-- Purpose:
--   - keep the table scan for jobs_salary_range_check out of migration 023's
--     ADD CONSTRAINT transaction
--   - defensively repair inverted ranges that could have landed before
--     migration 023 acquired the table lock

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'public.jobs must exist before validating salary range migration'
      USING ERRCODE = '42P01';
  END IF;
END;
$$;

UPDATE public.jobs
SET salary_max = salary_min
WHERE salary_min IS NOT NULL
  AND salary_max IS NOT NULL
  AND salary_max < salary_min;

ALTER TABLE public.jobs
  VALIDATE CONSTRAINT jobs_salary_range_check;
