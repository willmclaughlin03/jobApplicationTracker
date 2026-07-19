/**
 * Always-on contract tests for migration 028.
 *
 * Purpose: keep the forward reconciliation SQL aligned with migration 019's
 * hardened function body even when destructive database integration is not
 * enabled in ordinary CI.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const PREMIUM_RESTORE_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  '019_jobs_premium_restore.sql'
);
const PREMIUM_RESTORE_RECONCILIATION_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  '028_reconcile_premium_restore_rpc.sql'
);
const RESTORE_FUNCTION_START =
  'CREATE OR REPLACE FUNCTION public.restore_locked_jobs_for_premium_user(';
const RESTORE_PERMISSION_START =
  'REVOKE ALL ON FUNCTION public.restore_locked_jobs_for_premium_user';

/**
 * Extract and normalize the Premium restore function definition from SQL.
 *
 * Purpose: migration 028 intentionally repeats the reviewed migration 019
 * implementation so an existing database receives the same hardened body.
 *
 * @param {string} migrationSql Complete migration SQL.
 * @returns {string} Normalized function definition through its closing body.
 */
function extractRestoreFunctionDefinition(migrationSql) {
  const normalizedSql = migrationSql.replace(/\r\n/g, '\n');
  const startIndex = normalizedSql.indexOf(RESTORE_FUNCTION_START);
  const endIndex = normalizedSql.indexOf(RESTORE_PERMISSION_START, startIndex);

  if (startIndex < 0 || endIndex < 0) {
    throw new Error('Premium restore function definition markers are missing');
  }

  return normalizedSql.slice(startIndex, endIndex).trim();
}

describe('Premium restore reconciliation migration contract', () => {
  const premiumRestoreSql = readFileSync(PREMIUM_RESTORE_MIGRATION_PATH, 'utf8');
  const reconciliationSql = readFileSync(
    PREMIUM_RESTORE_RECONCILIATION_MIGRATION_PATH,
    'utf8'
  );
  const compactReconciliationSql = reconciliationSql.replace(/\s+/g, ' ').trim();

  test('repeats the exact hardened four-argument function from migration 019', () => {
    expect(extractRestoreFunctionDefinition(reconciliationSql)).toBe(
      extractRestoreFunctionDefinition(premiumRestoreSql)
    );
  });

  test('removes only the stale overload and reasserts service-role-only execution', () => {
    expect(compactReconciliationSql.indexOf(RESTORE_FUNCTION_START)).toBeLessThan(
      compactReconciliationSql.indexOf(
        'DROP FUNCTION IF EXISTS public.restore_locked_jobs_for_premium_user(uuid, text, integer);'
      )
    );
    expect(compactReconciliationSql).toContain(
      'DROP FUNCTION IF EXISTS public.restore_locked_jobs_for_premium_user(uuid, text, integer);'
    );
    expect(compactReconciliationSql).not.toMatch(
      /DROP FUNCTION IF EXISTS public\.restore_locked_jobs_for_premium_user\(uuid, text, integer\) CASCADE/i
    );
    expect(compactReconciliationSql).toContain(
      'REVOKE ALL ON FUNCTION public.restore_locked_jobs_for_premium_user(uuid, text, integer, text[]) FROM PUBLIC, anon, authenticated;'
    );
    expect(compactReconciliationSql).toContain(
      'GRANT EXECUTE ON FUNCTION public.restore_locked_jobs_for_premium_user(uuid, text, integer, text[]) TO service_role;'
    );
  });

  test('verifies the final signatures and requests a PostgREST schema reload', () => {
    expect(compactReconciliationSql).toContain(
      "pg_catalog.to_regprocedure( 'public.restore_locked_jobs_for_premium_user(uuid,text,integer,text[])' ) IS NULL"
    );
    expect(compactReconciliationSql).toContain(
      "pg_catalog.to_regprocedure( 'public.restore_locked_jobs_for_premium_user(uuid,text,integer)' ) IS NOT NULL"
    );
    expect(compactReconciliationSql).toContain("NOTIFY pgrst, 'reload schema';");
  });
});
