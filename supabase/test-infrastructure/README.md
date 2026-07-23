# Restricted Integration-Test SQL Helper

`exec_sql.sql` installs the test-only `public.exec_sql(text)` helper used by
trusted migration suites. It is deliberately outside `supabase/migrations` so
the deployable application chain never creates an arbitrary-SQL endpoint.

The helper is `SECURITY DEFINER`, owned by `postgres`, fixed to the
`pg_catalog` search path, and executable only by `service_role`. It must exist
only in disposable local databases and the dedicated integration-test project.

## Required installation order

Never install the helper before the canonical migrations. The reconciliation
migration intentionally drops `public.exec_sql(text)`.

1. Reset or migrate from the canonical files in `supabase/migrations`.
2. Run `supabase/tests/authoritative_baseline.test.sql` while the helper is
   absent.
3. Run error-level database lint and confirm the public-schema diff is empty.
4. Install `exec_sql.sql`.
5. Run `exec_sql.test.sql`.
6. For local verification, reset again and prove the deployable chain leaves
   the helper absent.

For the repo-local Supabase stack, install the helper after steps 1-3:

```powershell
Get-Content -Raw supabase/test-infrastructure/exec_sql.sql |
  docker exec -i supabase_db_job-application-tracker `
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres

npx supabase test db --local supabase/test-infrastructure/exec_sql.test.sql
```

For the dedicated remote project, apply `exec_sql.sql` through its SQL editor
only after the reviewed canonical `db push`, authoritative pgTAP, lint, and
schema-diff checks pass. Do not install it in staging or production projects.
