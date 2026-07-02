-- Add versioned salary range invariant for jobs.
--
-- Purpose:
--   - make the route-documented salary_min/salary_max safety net real and
--     replayable from migrations
--   - reject concurrent partial updates or direct service-role writes that
--     would store salary_max below salary_min

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'public.jobs must exist before applying salary range migration'
      USING ERRCODE = '42P01';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'jobs_salary_range_check'
      AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_salary_range_check
      CHECK (
        salary_min IS NULL
        OR salary_max IS NULL
        OR salary_max >= salary_min
      );
  END IF;
END;
$$;
