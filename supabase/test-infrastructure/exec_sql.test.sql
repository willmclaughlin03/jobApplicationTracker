BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions, pg_catalog;

SELECT plan(19);

SELECT isnt(
  to_regprocedure('public.exec_sql(text)'),
  NULL::regprocedure,
  '1: exec_sql(text) exists'
);

SELECT is(
  (
    SELECT owner_role.rolname
    FROM pg_proc AS function_catalog
    JOIN pg_roles AS owner_role ON owner_role.oid = function_catalog.proowner
    WHERE function_catalog.oid = 'public.exec_sql(text)'::regprocedure
  ),
  'postgres',
  '2: exec_sql is owned by postgres'
);

SELECT is(
  (
    SELECT language_catalog.lanname
    FROM pg_proc AS function_catalog
    JOIN pg_language AS language_catalog
      ON language_catalog.oid = function_catalog.prolang
    WHERE function_catalog.oid = 'public.exec_sql(text)'::regprocedure
  ),
  'plpgsql',
  '3: exec_sql uses PL/pgSQL'
);

SELECT is(
  (
    SELECT function_catalog.prorettype::regtype::text
    FROM pg_proc AS function_catalog
    WHERE function_catalog.oid = 'public.exec_sql(text)'::regprocedure
  ),
  'jsonb',
  '4: exec_sql returns jsonb'
);

SELECT ok(
  (
    SELECT function_catalog.prosecdef
    FROM pg_proc AS function_catalog
    WHERE function_catalog.oid = 'public.exec_sql(text)'::regprocedure
  ),
  '5: exec_sql is security definer'
);

SELECT is(
  (
    SELECT function_catalog.proconfig
    FROM pg_proc AS function_catalog
    WHERE function_catalog.oid = 'public.exec_sql(text)'::regprocedure
  ),
  ARRAY['search_path=pg_catalog']::text[],
  '6: exec_sql has a fixed pg_catalog search path'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc AS function_catalog
    CROSS JOIN LATERAL aclexplode(function_catalog.proacl) AS function_acl
    WHERE function_catalog.oid = 'public.exec_sql(text)'::regprocedure
      AND function_acl.grantee = 0
  ),
  '7: PUBLIC has no exec_sql privileges'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.exec_sql(text)', 'EXECUTE'),
  '8: anon cannot execute exec_sql'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.exec_sql(text)',
    'EXECUTE'
  ),
  '9: authenticated cannot execute exec_sql'
);

SELECT ok(
  has_function_privilege('service_role', 'public.exec_sql(text)', 'EXECUTE'),
  '10: service_role can execute exec_sql'
);

SELECT throws_ok(
  $sql$SELECT public.exec_sql(NULL)$sql$,
  '22023'::character(5),
  NULL,
  '11: null SQL is rejected'
);

SELECT throws_ok(
  $sql$SELECT public.exec_sql('')$sql$,
  '22023'::character(5),
  NULL,
  '12: empty SQL is rejected'
);

SELECT throws_ok(
  $sql$SELECT public.exec_sql(E' \n\t ')$sql$,
  '22023'::character(5),
  NULL,
  '13: whitespace-only SQL is rejected'
);

SELECT is(
  public.exec_sql('CREATE TEMP TABLE exec_sql_probe (value integer)'),
  '[]'::jsonb,
  '14: DDL executes and returns an empty array'
);

SELECT is(
  public.exec_sql(
    'INSERT INTO pg_temp.exec_sql_probe (value) VALUES (7)'
  ),
  '[]'::jsonb,
  '15: non-query statements execute and return an empty array'
);

SELECT is(
  public.exec_sql(
    'SELECT value FROM pg_temp.exec_sql_probe'
  ),
  '[{"value": 7}]'::jsonb,
  '16: SELECT returns a JSON array'
);

SELECT is(
  public.exec_sql(
    'WITH selected AS (SELECT 8 AS value) SELECT value FROM selected'
  ),
  '[{"value": 8}]'::jsonb,
  '17: WITH returns a JSON array'
);

SELECT is(
  public.exec_sql(
    'VALUES (9)'
  ),
  '[{"column1": 9}]'::jsonb,
  '18: VALUES returns a JSON array'
);

SELECT is(
  public.exec_sql(
    'TABLE pg_temp.exec_sql_probe'
  ),
  '[{"value": 7}]'::jsonb,
  '19: TABLE returns a JSON array'
);

SELECT * FROM finish();
ROLLBACK;
