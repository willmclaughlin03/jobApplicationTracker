/**
 * Suite C - Jobs storage-state migration + boundary integration tests
 *
 * Purpose: Verify Chunk 2 storage-state columns, constraints, indexes, and the
 * direct-access boundary against a real Supabase integration environment.
 *
 * Notes:
 *   1. This suite requires the live/pre-prod schema to already contain
 *      public.jobs because the historical base jobs migration is not
 *      replayable from the current repo state.
 *   2. Migration 016 is additive and may be applied by this suite when the
 *      target integration database has the base jobs table.
 *   3. The suite uses the same service-role-only public.exec_sql(query text)
 *      RPC helper assumed by the existing migration integration harness.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const JOBS_STORAGE_MIGRATION_FILE = '016_jobs_storage_state_boundary.sql';
const JOBS_SALARY_RANGE_MIGRATION_FILE = '023_jobs_salary_range_check.sql';
const JOBS_SALARY_RANGE_VALIDATE_MIGRATION_FILE = '024_jobs_salary_range_check_validate.sql';

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
    'Refusing to run Suite C: NEXT_PUBLIC_SUPABASE_URL must match SUPABASE_TEST_PROJECT_REF.'
  );
}

/**
 * Normalize exec_sql RPC data into a row array.
 *
 * Purpose: Supabase RPC responses can return JSON strings, arrays, or scalar
 * wrappers depending on helper implementation; tests need one catalog-row
 * representation.
 *
 * @param {unknown} data Raw public.exec_sql RPC response data.
 * @returns {object[]} Normalized row array.
 */
function normalizeExecSqlRows(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  if (data && typeof data === 'object') {
    return [data];
  }

  return [];
}

/**
 * Build a searchable permission/error message from Supabase errors.
 *
 * Purpose: ACL and RLS failures can land in different fields depending on the
 * PostgREST path, so assertions inspect a combined non-sensitive string.
 *
 * @param {object | null | undefined} error Supabase error object.
 * @returns {string} Combined message, details, hint, and code.
 */
function buildPermissionMessage(error) {
  return `${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''} ${error?.code ?? ''}`.trim();
}

/**
 * Assert a direct client operation failed with a permission-like error.
 *
 * Purpose: direct jobs table access may fail through SQL privileges or RLS; both
 * are acceptable direct-access denials for the Chunk 2 boundary.
 *
 * @param {object | null | undefined} error Supabase error object.
 * @returns {void}
 */
function expectPermissionError(error) {
  expect(error).toBeTruthy();
  expect(buildPermissionMessage(error)).toMatch(/permission|forbidden|not allowed|insufficient|42501/i);
}

/**
 * Assert a direct select returned no rows or failed with permission.
 *
 * Purpose: PostgREST may surface narrowed table access as either a denied
 * request or an empty RLS-filtered result depending on grants and policies.
 *
 * @param {{data?: unknown, error?: object | null}} result Supabase query result.
 * @returns {void}
 */
function expectZeroRowsOrPermission(result) {
  if (result.error) {
    expectPermissionError(result.error);
    return;
  }

  expect(Array.isArray(result.data)).toBe(true);
  expect(result.data).toHaveLength(0);
}

/**
 * Assert a direct mutation returned no data or failed with permission.
 *
 * Purpose: update/delete attempts against narrowed jobs access must not mutate
 * rows even if PostgREST reports a zero-row result instead of a hard error.
 *
 * @param {{data?: unknown, error?: object | null}} result Supabase query result.
 * @returns {void}
 */
function expectPermissionOrNullData(result) {
  if (result.error) {
    expectPermissionError(result.error);
    return;
  }

  expect(result.data === null || (Array.isArray(result.data) && result.data.length === 0)).toBe(true);
}

/**
 * Detect PostgREST schema-cache misses after installing SQL objects.
 *
 * Purpose: integration tests may need to retry or reload after migration RPCs
 * before newly changed table columns are visible through PostgREST.
 *
 * @param {object | null | undefined} error Supabase error object.
 * @returns {boolean} True when the error looks like schema cache lag.
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
 * @param {object | null | undefined} error Supabase error object.
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
 * table queries from racing the schema cache.
 *
 * @param {number} milliseconds Delay duration.
 * @returns {Promise<void>} Resolves after the delay.
 */
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Sign in an integration test user with a Supabase magic-link token.
 *
 * Purpose: direct-access boundary checks need real anon clients authenticated
 * as seeded users while setup still uses admin auth to mint login links.
 *
 * @param {Function} createClient Supabase client factory.
 * @param {object} adminClient Service-role client with auth.admin access.
 * @param {string} email Test user email.
 * @returns {Promise<object>} Authenticated anon Supabase client.
 */
async function signInAsUser(createClient, adminClient, email) {
  const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
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
 * Build a minimally valid jobs row for storage-boundary tests.
 *
 * Purpose: the repo lacks the base jobs migration, so test inserts use the
 * current application-facing fields known from job creation routes.
 *
 * @param {string} userId Owner auth user id.
 * @param {object} [overrides={}] Column overrides for specific scenarios.
 * @returns {object} Insertable jobs row.
 */
function buildJobRow(userId, overrides = {}) {
  const now = new Date().toISOString();
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    user_id: userId,
    company: `Storage Co ${uniqueSuffix}`,
    position: 'Storage Boundary Engineer',
    status: 'applied',
    notes: '',
    salary_min: null,
    salary_max: null,
    status_date: now,
    ...overrides,
  };
}

jest.setTimeout(30_000);

describeOrSkip('Suite C - Jobs storage-state migration + boundary integration', () => {
  let serviceClient;
  let anonClient;
  let clientA;
  let clientB;
  let userAId;
  let userBId;

  const cleanupUserIds = new Set();

  /**
   * Execute privileged SQL through the test-only exec_sql RPC.
   *
   * Purpose: migration setup and schema assertions need service-role SQL access
   * while retrying brief PostgREST schema-cache lag.
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
          'Jobs storage-state integration tests require a service-role-only '
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
   * Purpose: newly added jobs columns and grant changes should be visible before
   * Supabase client assertions run.
   *
   * @returns {Promise<void>}
   */
  async function reloadPostgrestSchema() {
    await execSql(`notify pgrst, 'reload schema';`);
    await wait(500);
  }

  /**
   * Create a temporary confirmed auth user for integration tests.
   *
   * Purpose: direct-access assertions need isolated owners and cleanup must
   * remove test users after their jobs are deleted.
   *
   * @param {string} prefix Email/local-part prefix.
   * @returns {Promise<{id: string, email: string}>} Created user identity.
   */
  async function createTempUser(prefix) {
    const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const { data, error } = await serviceClient.auth.admin.createUser({
      email,
      email_confirm: true,
    });

    if (error) throw error;

    const id = data?.user?.id;
    if (!id) {
      throw new Error(`createUser returned no id for ${email}`);
    }

    cleanupUserIds.add(id);
    return { id, email };
  }

  /**
   * Apply migration 016 against a live schema with public.jobs.
   *
   * Purpose: Chunk 2 needs live-schema evidence because the base jobs table
   * migration is absent from repo state.
   *
   * @returns {Promise<void>}
   */
  async function ensureJobsStorageMigrationApplied() {
    const tableRows = await execSql(`
      SELECT pg_catalog.to_regclass('public.jobs')::text AS jobs_table
    `);

    if (!tableRows[0]?.jobs_table) {
      throw new Error(
        'public.jobs is missing in the integration environment; '
        + 'apply or restore the base jobs schema before running Chunk 2 evidence.'
      );
    }

    for (const migrationFile of [
      JOBS_STORAGE_MIGRATION_FILE,
      JOBS_SALARY_RANGE_MIGRATION_FILE,
      JOBS_SALARY_RANGE_VALIDATE_MIGRATION_FILE,
    ]) {
      const migrationSql = readFileSync(
        join(MIGRATIONS_DIR, migrationFile),
        'utf8'
      );

      const { error } = await serviceClient.rpc('exec_sql', { query: migrationSql });
      expect(error).toBeNull();
    }
    await reloadPostgrestSchema();
  }

  /**
   * Inspect installed jobs storage-state schema objects.
   *
   * Purpose: catalog assertions verify the migration installed columns,
   * constraints, indexes, RLS flags, and table privileges.
   *
   * @returns {Promise<object>} Installed jobs shape.
   */
  async function getInstalledJobsStorageShape() {
    const [columnRows, constraintRows, indexRows, rlsRows, privilegeRows] = await Promise.all([
      execSql(`
        SELECT
          column_name,
          is_nullable,
          column_default,
          data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'jobs'
          AND column_name IN (
            'storage_state',
            'locked_at',
            'locked_reason',
            'locked_policy_version'
          )
      `),
      execSql(`
        SELECT
          con.conname AS constraint_name,
          pg_catalog.pg_get_constraintdef(con.oid, true) AS constraint_definition,
          con.convalidated AS constraint_validated
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class cls
          ON cls.oid = con.conrelid
        JOIN pg_catalog.pg_namespace ns
          ON ns.oid = cls.relnamespace
        WHERE ns.nspname = 'public'
          AND cls.relname = 'jobs'
          AND con.conname IN (
            'jobs_storage_state_allowed_check',
            'jobs_locked_reason_allowed_check',
            'jobs_locked_policy_version_format_check',
            'jobs_locked_metadata_consistency_check',
            'jobs_salary_range_check'
          )
      `),
      execSql(`
        SELECT indexname, indexdef
        FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'jobs'
          AND indexname IN (
            'jobs_user_retained_count_idx',
            'jobs_active_count_idx',
            'jobs_locked_count_idx',
            'jobs_active_lock_selection_idx',
            'jobs_locked_bulk_delete_idx'
          )
      `),
      execSql(`
        SELECT relrowsecurity, relforcerowsecurity
        FROM pg_catalog.pg_class
        WHERE oid = 'public.jobs'::pg_catalog.regclass
      `),
      execSql(`
        SELECT grantee, privilege_type
        FROM information_schema.table_privileges
        WHERE table_schema = 'public'
          AND table_name = 'jobs'
          AND grantee IN ('anon', 'authenticated', 'service_role')
      `),
    ]);

    const privilegesByGrantee = new Map();
    for (const row of privilegeRows) {
      if (!privilegesByGrantee.has(row.grantee)) {
        privilegesByGrantee.set(row.grantee, new Set());
      }
      privilegesByGrantee.get(row.grantee).add(row.privilege_type);
    }

    return {
      columns: new Map(columnRows.map((row) => [row.column_name, row])),
      constraints: new Map(
        constraintRows.map((row) => [row.constraint_name, row.constraint_definition || ''])
      ),
      constraintValidation: new Map(
        constraintRows.map((row) => [row.constraint_name, row.constraint_validated])
      ),
      indexes: new Map(indexRows.map((row) => [row.indexname, row.indexdef || ''])),
      rls: rlsRows[0] ?? {},
      privilegesByGrantee,
    };
  }

  /**
   * Seed a jobs row through the service-role client and track cleanup.
   *
   * Purpose: boundary tests need active and locked rows owned by different users
   * while cleanup removes rows before auth users are deleted.
   *
   * @param {string} userId Owner auth user id.
   * @param {object} [overrides={}] Column overrides for this row.
   * @returns {Promise<object>} Seeded row subset.
   */
  async function seedJob(userId, overrides = {}) {
    const { data, error } = await serviceClient
      .from('jobs')
      .insert(buildJobRow(userId, overrides))
      .select('id, user_id, storage_state, locked_at, locked_reason, locked_policy_version')
      .single();

    expect(error).toBeNull();
    return data;
  }

  beforeAll(async () => {
    const { createClient } = await import('@supabase/supabase-js');

    serviceClient = createClient(TEST_URL, TEST_SERVICE_KEY, {
      auth: { persistSession: false },
    });

    anonClient = createClient(TEST_URL, TEST_ANON_KEY, {
      auth: { persistSession: false },
    });

    await ensureJobsStorageMigrationApplied();

    const userA = await createTempUser('jobs-storage-a');
    const userB = await createTempUser('jobs-storage-b');

    userAId = userA.id;
    userBId = userB.id;
    clientA = await signInAsUser(createClient, serviceClient, userA.email);
    clientB = await signInAsUser(createClient, serviceClient, userB.email);
  });

  afterAll(async () => {
    if (!serviceClient) return;

    const userIds = [...cleanupUserIds];

    if (userIds.length > 0) {
      await serviceClient.from('jobs').delete().in('user_id', userIds);
    }

    for (const userId of userIds) {
      await serviceClient.auth.admin.deleteUser(userId);
    }
  });

  test('C1: jobs storage-state migration file exists', () => {
    expect(existsSync(join(MIGRATIONS_DIR, JOBS_STORAGE_MIGRATION_FILE))).toBe(true);
    expect(existsSync(join(MIGRATIONS_DIR, JOBS_SALARY_RANGE_MIGRATION_FILE))).toBe(true);
    expect(existsSync(join(MIGRATIONS_DIR, JOBS_SALARY_RANGE_VALIDATE_MIGRATION_FILE))).toBe(true);
  });

  test('C2: migration installs columns, constraints, indexes, RLS flags, and grants', async () => {
    const shape = await getInstalledJobsStorageShape();

    expect(shape.columns.get('storage_state')).toEqual(
      expect.objectContaining({
        data_type: 'text',
        is_nullable: 'NO',
      })
    );
    expect(shape.columns.get('storage_state')?.column_default).toContain('active');

    for (const columnName of ['locked_at', 'locked_reason', 'locked_policy_version']) {
      expect(shape.columns.has(columnName)).toBe(true);
    }

    expect(shape.constraints.get('jobs_storage_state_allowed_check')).toContain('locked_over_plan_limit');
    expect(shape.constraints.get('jobs_locked_reason_allowed_check')).toContain('premium_to_free_over_plan_limit');
    expect(shape.constraints.get('jobs_locked_policy_version_format_check')).toContain('btrim');
    expect(shape.constraints.get('jobs_locked_metadata_consistency_check')).toContain('locked_at IS NOT NULL');
    expect(shape.constraints.get('jobs_salary_range_check')).toContain('salary_max >= salary_min');
    expect(shape.constraintValidation.get('jobs_salary_range_check')).toBe(true);

    for (const indexName of [
      'jobs_user_retained_count_idx',
      'jobs_active_count_idx',
      'jobs_locked_count_idx',
      'jobs_active_lock_selection_idx',
      'jobs_locked_bulk_delete_idx',
    ]) {
      expect(shape.indexes.has(indexName)).toBe(true);
    }

    expect(shape.indexes.get('jobs_active_lock_selection_idx')).toContain('offered');
    expect(shape.indexes.get('jobs_locked_bulk_delete_idx')).toContain('locked_over_plan_limit');
    expect(shape.rls.relrowsecurity).toBe(true);
    expect(shape.rls.relforcerowsecurity).toBe(true);

    const authenticatedPrivileges = shape.privilegesByGrantee.get('authenticated') ?? new Set();
    const anonPrivileges = shape.privilegesByGrantee.get('anon') ?? new Set();
    const serviceRolePrivileges = shape.privilegesByGrantee.get('service_role') ?? new Set();

    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(authenticatedPrivileges.has(privilege)).toBe(false);
      expect(anonPrivileges.has(privilege)).toBe(false);
      expect(serviceRolePrivileges.has(privilege)).toBe(true);
    }
  });

  test('C3: constraints reject malformed storage states and metadata', async () => {
    const activeInsert = await serviceClient
      .from('jobs')
      .insert(buildJobRow(userAId))
      .select('id, storage_state')
      .single();

    expect(activeInsert.error).toBeNull();
    expect(activeInsert.data.storage_state).toBe('active');

    const validLockedInsert = await serviceClient
      .from('jobs')
      .insert(buildJobRow(userAId, {
        storage_state: 'locked_over_plan_limit',
        locked_at: new Date().toISOString(),
        locked_reason: 'premium_to_free_over_plan_limit',
        locked_policy_version: 'v1',
      }))
      .select('id, storage_state')
      .single();

    expect(validLockedInsert.error).toBeNull();
    expect(validLockedInsert.data.storage_state).toBe('locked_over_plan_limit');

    const invalidState = await serviceClient
      .from('jobs')
      .insert(buildJobRow(userAId, { storage_state: 'archived' }));

    expect(invalidState.error).toBeTruthy();
    expect(buildPermissionMessage(invalidState.error)).toMatch(/check|constraint|23514/i);

    const lockedMissingMetadata = await serviceClient
      .from('jobs')
      .insert(buildJobRow(userAId, { storage_state: 'locked_over_plan_limit' }));

    expect(lockedMissingMetadata.error).toBeTruthy();
    expect(buildPermissionMessage(lockedMissingMetadata.error)).toMatch(/check|constraint|23514/i);

    const activeWithMetadata = await serviceClient
      .from('jobs')
      .insert(buildJobRow(userAId, {
        storage_state: 'active',
        locked_at: new Date().toISOString(),
        locked_reason: 'premium_to_free_over_plan_limit',
        locked_policy_version: 'v1',
      }));

    expect(activeWithMetadata.error).toBeTruthy();
    expect(buildPermissionMessage(activeWithMetadata.error)).toMatch(/check|constraint|23514/i);

    const unknownReason = await serviceClient
      .from('jobs')
      .insert(buildJobRow(userAId, {
        storage_state: 'locked_over_plan_limit',
        locked_at: new Date().toISOString(),
        locked_reason: 'manual_lock',
        locked_policy_version: 'v1',
      }));

    expect(unknownReason.error).toBeTruthy();
    expect(buildPermissionMessage(unknownReason.error)).toMatch(/check|constraint|23514/i);

    const blankPolicyVersion = await serviceClient
      .from('jobs')
      .insert(buildJobRow(userAId, {
        storage_state: 'locked_over_plan_limit',
        locked_at: new Date().toISOString(),
        locked_reason: 'premium_to_free_over_plan_limit',
        locked_policy_version: '   ',
      }));

    expect(blankPolicyVersion.error).toBeTruthy();
    expect(buildPermissionMessage(blankPolicyVersion.error)).toMatch(/check|constraint|23514/i);
  });

  test('C3b: salary range constraint rejects inverted salary bounds', async () => {
    const invalidSalaryRange = await serviceClient
      .from('jobs')
      .insert(buildJobRow(userAId, {
        salary_min: 900000,
        salary_max: 100,
      }));

    expect(invalidSalaryRange.error).toBeTruthy();
    expect(buildPermissionMessage(invalidSalaryRange.error)).toMatch(/jobs_salary_range_check|check|constraint|23514/i);

    const partiallySpecifiedSalary = await serviceClient
      .from('jobs')
      .insert(buildJobRow(userAId, {
        salary_min: 900000,
        salary_max: null,
      }))
      .select('id, salary_min, salary_max')
      .single();

    expect(partiallySpecifiedSalary.error).toBeNull();
    expect(partiallySpecifiedSalary.data.salary_min).toBe(900000);
    expect(partiallySpecifiedSalary.data.salary_max).toBeNull();
  });
  test('C4: authenticated and anon clients cannot directly bypass jobs storage policy', async () => {
    const activeA = await seedJob(userAId);
    const lockedA = await seedJob(userAId, {
      storage_state: 'locked_over_plan_limit',
      locked_at: new Date().toISOString(),
      locked_reason: 'premium_to_free_over_plan_limit',
      locked_policy_version: 'v1',
    });
    const activeB = await seedJob(userBId);

    expectZeroRowsOrPermission(
      await clientA.from('jobs').select('*').eq('id', lockedA.id)
    );

    expectZeroRowsOrPermission(
      await clientA.from('jobs').select('*').eq('id', activeB.id)
    );

    expectZeroRowsOrPermission(
      await anonClient.from('jobs').select('*').eq('id', activeA.id)
    );

    const clearLockAttempt = await clientA
      .from('jobs')
      .update({
        storage_state: 'active',
        locked_at: null,
        locked_reason: null,
        locked_policy_version: null,
      })
      .eq('id', lockedA.id);

    expectPermissionOrNullData(clearLockAttempt);

    const deleteAttempt = await clientA
      .from('jobs')
      .delete()
      .eq('id', lockedA.id);

    expectPermissionOrNullData(deleteAttempt);

    const { data: lockedAfterAttempts, error: lockedAfterError } = await serviceClient
      .from('jobs')
      .select('id, storage_state, locked_at, locked_reason, locked_policy_version')
      .eq('id', lockedA.id)
      .single();

    expect(lockedAfterError).toBeNull();
    expect(lockedAfterAttempts).toEqual(
      expect.objectContaining({
        storage_state: 'locked_over_plan_limit',
        locked_reason: 'premium_to_free_over_plan_limit',
        locked_policy_version: 'v1',
      })
    );
    expect(lockedAfterAttempts.locked_at).toBeTruthy();
  });

  test('C5: service-owned jobs access remains owner-scoped through explicit filters', async () => {
    const userAJob = await seedJob(userAId);
    const userBJob = await seedJob(userBId);

    const ownerScopedRead = await serviceClient
      .from('jobs')
      .select('id')
      .eq('id', userAJob.id)
      .eq('user_id', userAId)
      .single();

    expect(ownerScopedRead.error).toBeNull();
    expect(ownerScopedRead.data.id).toBe(userAJob.id);

    const crossOwnerRead = await serviceClient
      .from('jobs')
      .select('id')
      .eq('id', userBJob.id)
      .eq('user_id', userAId);

    expect(crossOwnerRead.error).toBeNull();
    expect(crossOwnerRead.data).toHaveLength(0);
  });
});
