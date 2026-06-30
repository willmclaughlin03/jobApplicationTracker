/**
 * Suite I - Jobs storage-count RPC integration tests.
 *
 * Purpose: Verify the consolidated storage-count RPC returns active, locked,
 * and retained counts for one owner while staying service-role only.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  JOB_STORAGE_LOCK_POLICY_VERSION,
  JOB_STORAGE_LOCK_REASONS,
  JOB_STORAGE_STATES,
} from '../../../shared/constants/storage.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const JOBS_STORAGE_MIGRATION_FILE = '016_jobs_storage_state_boundary.sql';
const JOBS_STORAGE_COUNTS_MIGRATION_FILE = '021_jobs_storage_counts_rpc.sql';

const TEST_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const TEST_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
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
  && TEST_ANON_KEY
);
const describeOrSkip = hasInfra ? describe : describe.skip;

if (RUN_DESTRUCTIVE_DB_INTEGRATION && !isExpectedSupabaseTarget) {
  throw new Error(
    'Refusing to run Suite I: NEXT_PUBLIC_SUPABASE_URL must match SUPABASE_TEST_PROJECT_REF.'
  );
}

/**
 * Normalize exec_sql RPC data into a row array.
 *
 * Purpose: Supabase RPC responses can return JSON strings, arrays, or scalar
 * wrappers depending on helper implementation; tests need catalog rows.
 *
 * @param {unknown} data Raw public.exec_sql RPC response data.
 * @returns {object[]} Normalized row array.
 */
function normalizeExecSqlRows(data) {
  if (Array.isArray(data)) return data;

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  return data && typeof data === 'object' ? [data] : [];
}

/**
 * Normalize JSON returned by the storage-count RPC.
 *
 * Purpose: PostgREST can surface jsonb function returns as objects or JSON
 * strings depending on environment.
 *
 * @param {unknown} data Raw RPC payload.
 * @returns {object|null} Parsed object payload.
 */
function normalizeCountsRpcData(data) {
  if (!data) return null;

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  return typeof data === 'object' && !Array.isArray(data) ? data : null;
}

/**
 * Build a searchable permission/error message from Supabase errors.
 *
 * Purpose: ACL failures can land in different PostgREST fields, so assertions
 * inspect a combined non-sensitive string.
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
 * Purpose: integration tests retry brief schema-cache lag before treating RPC
 * metadata misses as real failures.
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
 * Detect a permission-shaped RPC denial for direct anon/authenticated calls.
 *
 * Purpose: revoked function execute privileges may appear as permission,
 * not-found, or schema-cache-shaped denials through PostgREST.
 *
 * @param {object|null|undefined} error Supabase error object.
 * @returns {boolean} True when the direct call was denied.
 */
function isDirectRpcDeniedError(error) {
  return /permission|not have permission|not found|schema cache|could not find the function|PGRST|42501|401|403/i
    .test(buildPermissionMessage(error));
}

/**
 * Wait for asynchronous PostgREST schema reload propagation.
 *
 * Purpose: notify pgrst reload is asynchronous; a short pause keeps follow-up
 * table queries from racing the schema cache.
 *
 * @param {number} milliseconds Delay duration.
 * @returns {Promise<void>} Resolves after the delay.
 */
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Build a minimally valid active jobs row for storage-count tests.
 *
 * Purpose: the repo lacks the base jobs migration, so inserts use the current
 * application-facing fields known from job creation routes.
 *
 * @param {string} userId Owner auth user id.
 * @param {object} overrides Column overrides for a specific row.
 * @returns {object} Insertable jobs row.
 */
function buildJobRow(userId, overrides = {}) {
  const now = new Date().toISOString();
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    user_id: userId,
    company: `Counts ${uniqueSuffix}`,
    position: 'Storage Counts Engineer',
    status: 'applied',
    notes: '',
    salary_min: null,
    salary_max: null,
    status_date: now,
    storage_state: JOB_STORAGE_STATES.ACTIVE,
    ...overrides,
  };
}

/**
 * Build a valid locked overflow jobs row for storage-count tests.
 *
 * Purpose: locked rows require metadata that satisfies the storage-state CHECK
 * constraints installed by migration 016.
 *
 * @param {string} userId Owner auth user id.
 * @param {object} overrides Column overrides for a specific row.
 * @returns {object} Insertable locked jobs row.
 */
function buildLockedJobRow(userId, overrides = {}) {
  return buildJobRow(userId, {
    storage_state: JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT,
    locked_at: new Date().toISOString(),
    locked_reason: JOB_STORAGE_LOCK_REASONS.PREMIUM_TO_FREE_OVER_PLAN_LIMIT,
    locked_policy_version: JOB_STORAGE_LOCK_POLICY_VERSION,
    ...overrides,
  });
}

jest.setTimeout(45_000);

describeOrSkip('Suite I - Jobs storage-count RPC integration', () => {
  let serviceClient;
  let anonClient;
  let createClient;
  const cleanupUserIds = new Set();

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
      const { data, error } = await serviceClient.rpc('exec_sql', { query });

      if (!error) {
        return normalizeExecSqlRows(data);
      }

      lastError = error;

      if (isExecSqlHelperMissingError(error)) {
        throw new Error(
          'Jobs storage-count integration tests require a service-role-only '
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
   * Purpose: newly added functions and grant changes should be visible before
   * Supabase RPC assertions run.
   *
   * @returns {Promise<void>}
   */
  async function reloadPostgrestSchema() {
    await execSql(`notify pgrst, 'reload schema';`);
    await wait(500);
  }

  /**
   * Apply prerequisite and storage-count migrations.
   *
   * Purpose: the count RPC depends on the existing jobs storage-state boundary
   * and its active/locked states.
   *
   * @returns {Promise<void>}
   */
  async function ensureJobsStorageCountsMigrationsApplied() {
    const tableRows = await execSql(`
      SELECT pg_catalog.to_regclass('public.jobs')::text AS jobs_table
    `);

    if (!tableRows[0]?.jobs_table) {
      throw new Error(
        'public.jobs is missing in the integration environment; '
        + 'apply or restore the base jobs schema before running storage-count evidence.'
      );
    }

    for (const migrationFile of [
      JOBS_STORAGE_MIGRATION_FILE,
      JOBS_STORAGE_COUNTS_MIGRATION_FILE,
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
   * Create a temporary confirmed auth user for integration tests.
   *
   * Purpose: owner-scoped count assertions need isolated users and cleanup
   * must remove test users after their jobs are deleted.
   *
   * @param {string} prefix Email/local-part prefix.
   * @returns {Promise<{id: string, email: string}>} Created user identity.
   */
  async function createTempUser(prefix) {
    const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const { data, error } = await serviceClient.auth.admin.createUser({
      email,
      password: `Test-${Date.now()}!`,
      email_confirm: true,
    });

    if (error) throw error;

    const userId = data?.user?.id;
    if (!userId) {
      throw new Error(`createUser returned no id for ${email}`);
    }

    cleanupUserIds.add(userId);
    return { id: userId, email };
  }

  /**
   * Sign in an integration test user with a Supabase magic-link token.
   *
   * Purpose: direct RPC-denial checks need a real authenticated anon client
   * while setup still uses admin auth to mint login links.
   *
   * @param {string} email Test user email.
   * @returns {Promise<object>} Authenticated anon Supabase client.
   */
  async function signInAsUser(email) {
    const { data: linkData, error: linkError } = await serviceClient.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    if (linkError) throw linkError;

    const tokenHash = linkData?.properties?.hashed_token;
    if (!tokenHash) {
      throw new Error(`generateLink returned no hashed_token for ${email}`);
    }

    const userClient = createClient(TEST_URL, TEST_ANON_KEY, {
      auth: { persistSession: false },
    });

    const { error: verifyError } = await userClient.auth.verifyOtp({
      type: 'magiclink',
      token_hash: tokenHash,
    });
    if (verifyError) throw verifyError;

    return userClient;
  }

  /**
   * Call the storage-count RPC through the service-role client.
   *
   * Purpose: tests should normalize jsonb transport differences without
   * weakening the service's stricter unit-level parser.
   *
   * @param {string} userId Owner auth user id.
   * @returns {Promise<object>} Normalized RPC count payload.
   */
  async function callStorageCountsRpc(userId) {
    const { data, error } = await serviceClient.rpc('get_job_storage_counts_for_user', {
      p_user_id: userId,
    });

    if (error) throw error;
    return normalizeCountsRpcData(data);
  }

  beforeAll(async () => {
    ({ createClient } = await import('@supabase/supabase-js'));

    serviceClient = createClient(TEST_URL, TEST_SERVICE_KEY, {
      auth: { persistSession: false },
    });
    anonClient = createClient(TEST_URL, TEST_ANON_KEY, {
      auth: { persistSession: false },
    });

    await ensureJobsStorageCountsMigrationsApplied();
  });

  afterAll(async () => {
    if (!serviceClient) return;

    const userIds = [...cleanupUserIds];
    if (userIds.length > 0) {
      const { error: jobsError } = await serviceClient.from('jobs').delete().in('user_id', userIds);
      if (jobsError) throw jobsError;

      for (const userId of userIds) {
        const { error: deleteUserError } = await serviceClient.auth.admin.deleteUser(userId);
        if (deleteUserError) throw deleteUserError;
      }
    }
  });

  test('I1: storage-count migration file exists and RPC remains service-role only', async () => {
    expect(existsSync(join(MIGRATIONS_DIR, JOBS_STORAGE_COUNTS_MIGRATION_FILE))).toBe(true);

    const privilegeRows = await execSql(`
      SELECT
        has_function_privilege(
          'authenticated',
          'public.get_job_storage_counts_for_user(uuid)',
          'EXECUTE'
        ) AS authenticated_can_execute,
        has_function_privilege(
          'anon',
          'public.get_job_storage_counts_for_user(uuid)',
          'EXECUTE'
        ) AS anon_can_execute,
        has_function_privilege(
          'service_role',
          'public.get_job_storage_counts_for_user(uuid)',
          'EXECUTE'
        ) AS service_role_can_execute
    `);

    expect(privilegeRows[0]).toEqual({
      authenticated_can_execute: false,
      anon_can_execute: false,
      service_role_can_execute: true,
    });
  });

  test('I2: RPC returns mixed active, locked, and retained counts for one owner', async () => {
    const owner = await createTempUser('jobs-counts-owner');
    const otherOwner = await createTempUser('jobs-counts-other');

    const { error: insertError } = await serviceClient.from('jobs').insert([
      buildJobRow(owner.id, { company: 'Counts Active One' }),
      buildJobRow(owner.id, { company: 'Counts Active Two' }),
      buildLockedJobRow(owner.id, { company: 'Counts Locked One' }),
      buildJobRow(otherOwner.id, { company: 'Other Active One' }),
      buildLockedJobRow(otherOwner.id, { company: 'Other Locked One' }),
    ]);
    if (insertError) throw insertError;

    await expect(callStorageCountsRpc(owner.id)).resolves.toEqual({
      activeCount: 2,
      lockedCount: 1,
      retainedTotalCount: 3,
    });
  });

  test('I3: RPC rejects null user ids', async () => {
    const { data, error } = await serviceClient.rpc('get_job_storage_counts_for_user', {
      p_user_id: null,
    });

    expect(data).toBeNull();
    expect(error).toBeTruthy();
    expect(buildPermissionMessage(error)).toMatch(/user_id is required|23502/i);
  });

  test('I4: anon and authenticated clients cannot execute the count RPC', async () => {
    const user = await createTempUser('jobs-counts-rpc-denial');
    const authenticatedClient = await signInAsUser(user.email);
    const directResults = await Promise.all([
      anonClient.rpc('get_job_storage_counts_for_user', { p_user_id: user.id }),
      authenticatedClient.rpc('get_job_storage_counts_for_user', { p_user_id: user.id }),
    ]);

    for (const result of directResults) {
      expect(result.error).toBeTruthy();
      expect(isDirectRpcDeniedError(result.error)).toBe(true);
      expect(result.data ?? null).toBeNull();
    }
  });
});
