/**
 * Suite J - Jobs ordered-read index integration tests.
 *
 * Purpose: Verify the dashboard active-list ordered-read index installs without
 * replacing the existing storage-state indexes used by other jobs workflows.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const JOBS_STORAGE_MIGRATION_FILE = '016_jobs_storage_state_boundary.sql';
const JOBS_ORDERED_READS_MIGRATION_FILE = '022_jobs_ordered_reads_indexes.sql';

const TEST_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const TEST_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUN_DESTRUCTIVE_DB_INTEGRATION = process.env.RUN_DESTRUCTIVE_DB_INTEGRATION === 'true';
const SUPABASE_TEST_PROJECT_REF = process.env.SUPABASE_TEST_PROJECT_REF;
const EXPECTED_TEST_URL_PREFIX = SUPABASE_TEST_PROJECT_REF
  ? `https://${SUPABASE_TEST_PROJECT_REF}.supabase.co`
  : '';

const isExpectedSupabaseTarget = Boolean(
  TEST_URL
  && EXPECTED_TEST_URL_PREFIX
  && (
    TEST_URL === EXPECTED_TEST_URL_PREFIX
    || TEST_URL.startsWith(`${EXPECTED_TEST_URL_PREFIX}/`)
  )
);

const hasInfra = Boolean(
  RUN_DESTRUCTIVE_DB_INTEGRATION
  && isExpectedSupabaseTarget
  && TEST_URL
  && TEST_SERVICE_KEY
);
const describeOrSkip = hasInfra ? describe : describe.skip;

if (RUN_DESTRUCTIVE_DB_INTEGRATION && !isExpectedSupabaseTarget) {
  throw new Error(
    'Refusing to run Suite J: NEXT_PUBLIC_SUPABASE_URL must match SUPABASE_TEST_PROJECT_REF.'
  );
}

/**
 * Normalize exec_sql RPC data into a row array.
 *
 * Purpose: Supabase RPC helpers can return catalog rows as arrays, JSON
 * strings, or scalar wrappers, so assertions need a stable representation.
 *
 * @param {unknown} data Raw public.exec_sql RPC response data.
 * @returns {object[]} Normalized row array.
 */
function normalizeExecSqlRows(data) {
  if (Array.isArray(data)) return data;

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return normalizeExecSqlRows(parsed);
    } catch {
      return [];
    }
  }

  if (data && Array.isArray(data.rows)) {
    return data.rows;
  }

  return data && typeof data === 'object' ? [data] : [];
}

/**
 * Build a searchable permission/error message from Supabase errors.
 *
 * Purpose: migration harness failures can land in different PostgREST fields,
 * so tests inspect one combined non-sensitive string.
 *
 * @param {object|null|undefined} error Supabase error object.
 * @returns {string} Combined message, details, hint, and code.
 */
function buildPermissionMessage(error) {
  return `${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''} ${error?.code ?? ''}`.trim();
}

/**
 * Detect PostgREST schema-cache misses after installing SQL objects.
 *
 * Purpose: catalog/RPC metadata can lag immediately after migrations, and the
 * harness should retry those transient misses before failing.
 *
 * @param {object|null|undefined} error Supabase error object.
 * @returns {boolean} True when retrying may allow schema cache propagation.
 */
function isRpcSchemaCacheError(error) {
  return /schema cache|could not find the function|PGRST/i.test(buildPermissionMessage(error));
}

/**
 * Detect a missing exec_sql helper in the integration database.
 *
 * Purpose: migration evidence depends on privileged SQL execution, so missing
 * helper setup should fail with guidance instead of as a migration bug.
 *
 * @param {object|null|undefined} error Supabase error object.
 * @returns {boolean} True when public.exec_sql is unavailable.
 */
function isExecSqlHelperMissingError(error) {
  return /exec_sql/i.test(buildPermissionMessage(error))
    && isRpcSchemaCacheError(error);
}

/**
 * Wait for asynchronous PostgREST schema reload propagation.
 *
 * Purpose: notify pgrst reload is asynchronous; a short pause keeps follow-up
 * catalog assertions from racing the schema cache.
 *
 * @param {number} milliseconds Delay duration.
 * @returns {Promise<void>} Resolves after the delay.
 */
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

jest.setTimeout(30_000);

describeOrSkip('Suite J - Jobs ordered-read index integration', () => {
  let serviceClient;

  /**
   * Execute privileged SQL through the test-only exec_sql RPC.
   *
   * Purpose: migration setup and catalog assertions need service-role SQL
   * access while retrying brief PostgREST schema-cache lag.
   *
   * @param {string} query SQL statement or migration body to run.
   * @returns {Promise<object[]>} Normalized row array.
   */
  async function execSql(query) {
    let lastError = null;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { data, error } = await serviceClient.rpc('exec_sql', {
        query: query.trim(),
      });

      if (!error) {
        return normalizeExecSqlRows(data);
      }

      lastError = error;

      if (isExecSqlHelperMissingError(error)) {
        throw new Error(
          'Jobs ordered-read index integration tests require a service-role-only '
          + 'public.exec_sql(query text) RPC helper in the target test database.'
        );
      }

      if (!isRpcSchemaCacheError(error)) {
        throw error;
      }

      await wait(250);
    }

    throw lastError;
  }

  /**
   * Reload PostgREST schema after applying migration SQL.
   *
   * Purpose: newly installed indexes should be visible before catalog
   * assertions run through the Supabase client.
   *
   * @returns {Promise<void>}
   */
  async function reloadPostgrestSchema() {
    await execSql(`notify pgrst, 'reload schema';`);
    await wait(500);
  }

  /**
   * Apply prerequisite and ordered-read migrations.
   *
   * Purpose: the ordered-read index depends on the storage_state boundary and
   * the existing public.jobs schema.
   *
   * @returns {Promise<void>}
   */
  async function ensureJobsOrderedReadsMigrationsApplied() {
    const tableRows = await execSql(`
      SELECT pg_catalog.to_regclass('public.jobs')::text AS jobs_table
    `);

    if (!tableRows[0]?.jobs_table) {
      throw new Error(
        'public.jobs is missing in the integration environment; '
        + 'apply or restore the base jobs schema before running ordered-read index evidence.'
      );
    }

    for (const migrationFile of [
      JOBS_STORAGE_MIGRATION_FILE,
      JOBS_ORDERED_READS_MIGRATION_FILE,
    ]) {
      const migrationPath = join(MIGRATIONS_DIR, migrationFile);

      if (!existsSync(migrationPath)) {
        throw new Error(`Missing migration fixture ${migrationFile}`);
      }

      await execSql(readFileSync(migrationPath, 'utf8'));
    }

    await reloadPostgrestSchema();
  }

  /**
   * Read the jobs index definitions touched by the ordered-read migration.
   *
   * Purpose: catalog assertions verify the new active-list index and confirm
   * existing storage-state indexes remain installed.
   *
   * @returns {Promise<Map<string, string>>} Index definitions by index name.
   */
  async function getJobsIndexDefinitions() {
    const rows = await execSql(`
      SELECT indexname, indexdef
      FROM pg_catalog.pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'jobs'
        AND indexname IN (
          'jobs_active_list_idx',
          'jobs_active_count_idx',
          'jobs_active_lock_selection_idx',
          'jobs_locked_bulk_delete_idx'
        )
    `);

    return new Map(rows.map((row) => [row.indexname, row.indexdef || '']));
  }

  beforeAll(async () => {
    const { createClient } = await import('@supabase/supabase-js');

    serviceClient = createClient(TEST_URL, TEST_SERVICE_KEY, {
      auth: { persistSession: false },
    });

    await ensureJobsOrderedReadsMigrationsApplied();
  });

  test('J1: ordered-read migration file exists', () => {
    expect(existsSync(join(MIGRATIONS_DIR, JOBS_ORDERED_READS_MIGRATION_FILE))).toBe(true);
  });

  test('J2: migration installs active-list index without replacing storage indexes', async () => {
    const indexes = await getJobsIndexDefinitions();
    const activeListIndex = indexes.get('jobs_active_list_idx') ?? '';

    expect(activeListIndex).toContain('jobs_active_list_idx');
    expect(activeListIndex).toContain('user_id');
    expect(activeListIndex).toContain('created_at DESC');
    expect(activeListIndex).toContain('id DESC');
    expect(activeListIndex).toContain("storage_state = 'active'");

    for (const indexName of [
      'jobs_active_count_idx',
      'jobs_active_lock_selection_idx',
      'jobs_locked_bulk_delete_idx',
    ]) {
      expect(indexes.has(indexName)).toBe(true);
    }
  });
});
