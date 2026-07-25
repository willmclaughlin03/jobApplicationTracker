BEGIN;

-- Executes trusted test migration SQL while returning catalog reads as JSON.
-- This helper is intentionally excluded from the deployable migration chain.
CREATE OR REPLACE FUNCTION public.exec_sql(query text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  normalized_query text :=
    pg_catalog.regexp_replace(query, '^[[:space:]]+', '');
  result_rows jsonb := '[]'::jsonb;
BEGIN
  IF query IS NULL OR normalized_query = '' THEN
    RAISE EXCEPTION 'query must be non-empty'
      USING ERRCODE = '22023';
  END IF;

  IF normalized_query ~* '^(select|with|values|table)([[:space:]]|$)' THEN
    normalized_query :=
      pg_catalog.regexp_replace(
        normalized_query,
        ';[[:space:]]*$',
        ''
      );

    EXECUTE pg_catalog.format(
      'SELECT COALESCE(
         pg_catalog.jsonb_agg(pg_catalog.to_jsonb(exec_row)),
         ''[]''::jsonb
       )
       FROM (%s) AS exec_row',
      normalized_query
    )
    INTO result_rows;
  ELSE
    EXECUTE query;
  END IF;

  RETURN result_rows;
END;
$function$;

ALTER FUNCTION public.exec_sql(text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.exec_sql(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.exec_sql(text) FROM anon;
REVOKE ALL ON FUNCTION public.exec_sql(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
