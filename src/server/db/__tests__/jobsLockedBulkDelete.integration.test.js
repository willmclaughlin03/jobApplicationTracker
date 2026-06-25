/**
 * Suite G - Jobs locked bulk delete integration tests
 *
 * Purpose: Verify Chunk 10's database RPC deletes only locked overflow rows,
 * stays terminal-Free-only after canonical billing recheck, and honors the
 * bounded row limit.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  JOB_STORAGE_LOCK_POLICY_VERSION,
  JOB_STORAGE_LOCK_REASONS,
  JOB_STORAGE_STATES,
  LOCKED_BULK_DELETE_ROW_LIMIT,
} from '../../../shared/constants/storage.js';
import { STORAGE_STATUSES } from '../../../shared/constants/billing.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const JOBS_STORAGE_MIGRATION_FILE = '016_jobs_storage_state_boundary.sql';
const JOBS_ATOMIC_CREATE_MIGRATION_FILE = '017_jobs_atomic_create_quota.sql';
const JOBS_OVERFLOW_LOCKING_MIGRATION_FILE = '018_jobs_overflow_locking.sql';
const JOBS_PREMIUM_RESTORE_MIGRATION_FILE = '019_jobs_premium_restore.sql';
const JOBS_LOCKED_BULK_DELETE_MIGRATION_FILE = '020_jobs_locked_bulk_delete.sql';

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
    'Refusing to run Suite G: NEXT_PUBLIC_SUPABASE_URL must match SUPABASE_TEST_PROJECT_REF.'
  );
}

/**
 * Normalize exec_sql RPC data into a row array.
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
 * Build a searchable permission/error message from Supabase errors.
 *
 * @param {object|null|undefined} error Supabase error object.
 * @returns {string} Combined non-sensitive error text.
 */
function buildPermissionMessage(error) {
  return `${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''} ${error?.code ?? ''}`.trim();
}

/**
 * Detect PostgREST schema-cache misses after installing SQL objects.
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
 * @param {number} milliseconds Delay duration.
 * @returns {Promise<void>} Resolves after the delay.
 */
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Normalize JSON returned by the locked bulk-delete RPC.
 *
 * @param {unknown} data Raw RPC payload.
 * @returns {object|null} Parsed object payload.
 */
function normalizeDeleteRpcData(data) {
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
 * Build an insertable jobs row for locked bulk-delete tests.
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
    company: `Bulk Delete ${uniqueSuffix}`,
    position: 'Archive Cleanup Engineer',
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
 * Build a valid locked overflow row for locked bulk-delete tests.
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

jest.setTimeout(60_000);

describeOrSkip('Suite G - Jobs locked bulk delete integration', () => {
  let serviceClient;
  const cleanupUserIds = new Set();

  /**
   * Execute privileged SQL through the test-only exec_sql RPC.
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
          'Jobs locked bulk delete integration tests require a service-role-only '
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
   * @returns {Promise<void>}
   */
  async function reloadPostgrestSchema() {
    await execSql(`notify pgrst, 'reload schema';`);
    await wait(500);
  }

  /**
   * Apply prerequisite and Chunk 10 jobs migrations.
   *
   * @returns {Promise<void>}
   */
  async function ensureJobsLockedBulkDeleteMigrationsApplied() {
    const tableRows = await execSql(`
      SELECT pg_catalog.to_regclass('public.jobs')::text AS jobs_table
    `);

    if (!tableRows[0]?.jobs_table) {
      throw new Error(
        'public.jobs is missing in the integration environment; '
        + 'apply or restore the base jobs schema before running Chunk 10 evidence.'
      );
    }

    for (const migrationFile of [
      JOBS_STORAGE_MIGRATION_FILE,
      JOBS_ATOMIC_CREATE_MIGRATION_FILE,
      JOBS_OVERFLOW_LOCKING_MIGRATION_FILE,
      JOBS_PREMIUM_RESTORE_MIGRATION_FILE,
      JOBS_LOCKED_BULK_DELETE_MIGRATION_FILE,
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
   * @returns {Promise<string>} Created auth user id.
   */
  async function createTestUser() {
    const email = `locked-bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const { data, error } = await serviceClient.auth.admin.createUser({
      email,
      password: 'TestPassword123!',
      email_confirm: true,
    });

    if (error) throw error;
    const userId = data.user.id;
    cleanupUserIds.add(userId);
    return userId;
  }

  /**
   * Seed canonical active Premium billing rows for one integration user.
   *
   * @param {string} userId Owner auth user id.
   * @returns {Promise<void>}
   */
  async function seedActivePremiumBilling(userId) {
    const suffix = userId.replace(/-/g, '').slice(0, 20);
    const stripeCustomerId = `cus_bulk_delete_${suffix}`;
    const stripeSubscriptionId = `sub_bulk_delete_${suffix}`;

    const customerResult = await serviceClient.from('billing_customers').upsert({
      user_id: userId,
      stripe_customer_id: stripeCustomerId,
    });
    if (customerResult.error) throw customerResult.error;

    const subscriptionResult = await serviceClient.from('billing_subscriptions').upsert({
      user_id: userId,
      stripe_subscription_id: stripeSubscriptionId,
      stripe_customer_id: stripeCustomerId,
      price_id: 'price_premium_monthly',
      status: 'active',
      current_period_end: '2026-07-01T00:00:00.000Z',
      cancel_at_period_end: false,
    });
    if (subscriptionResult.error) throw subscriptionResult.error;
  }

  /**
   * Call the locked bulk-delete RPC with retry for schema propagation.
   *
   * @param {string} userId Owner auth user id.
   * @param {object} options RPC options.
   * @returns {Promise<object>} Normalized RPC response payload.
   */
  async function callLockedBulkDeleteRpc(
    userId,
    {
      storageStatus = STORAGE_STATUSES.TERMINAL_FREE,
      lockedDeleteLimit = LOCKED_BULK_DELETE_ROW_LIMIT,
    } = {}
  ) {
    let lastError = null;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { data, error } = await serviceClient.rpc('delete_locked_jobs_for_terminal_free_user', {
        p_user_id: userId,
        p_storage_status: storageStatus,
        p_locked_delete_limit: lockedDeleteLimit,
      });

      if (!error) {
        return normalizeDeleteRpcData(data);
      }

      lastError = error;

      if (!isRpcSchemaCacheError(error)) {
        throw error;
      }

      await wait(250);
    }

    throw lastError;
  }

  /**
   * Load active, locked, and retained job counts for one user.
   *
   * @param {string} userId Owner auth user id.
   * @returns {Promise<object>} Count row.
   */
  async function getStorageCounts(userId) {
    const [activeResult, lockedResult, retainedResult] = await Promise.all([
      serviceClient
        .from('jobs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('storage_state', JOB_STORAGE_STATES.ACTIVE),
      serviceClient
        .from('jobs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('storage_state', JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT),
      serviceClient
        .from('jobs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId),
    ]);

    for (const result of [activeResult, lockedResult, retainedResult]) {
      if (result.error) throw result.error;
    }

    return {
      active_count: activeResult.count ?? 0,
      locked_count: lockedResult.count ?? 0,
      retained_total_count: retainedResult.count ?? 0,
    };
  }

  beforeAll(async () => {
    const { createClient } = await import('@supabase/supabase-js');

    serviceClient = createClient(TEST_URL, TEST_SERVICE_KEY, {
      auth: { persistSession: false },
    });

    await ensureJobsLockedBulkDeleteMigrationsApplied();
  });

  afterAll(async () => {
    if (!serviceClient) return;

    const userIds = [...cleanupUserIds];
    if (userIds.length > 0) {
      await serviceClient.from('jobs').delete().in('user_id', userIds);
      await serviceClient.from('billing_subscriptions').delete().in('user_id', userIds);
      await serviceClient.from('billing_customers').delete().in('user_id', userIds);

      await Promise.allSettled(
        userIds.map((userId) => serviceClient.auth.admin.deleteUser(userId))
      );
    }
  });

  it('deletes locked rows only and preserves active rows for terminal-Free users', async () => {
    const userId = await createTestUser();
    const rows = [
      buildJobRow(userId, { company: 'Active One' }),
      buildJobRow(userId, { company: 'Active Two' }),
      buildLockedJobRow(userId, { company: 'Locked One' }),
      buildLockedJobRow(userId, { company: 'Locked Two' }),
      buildLockedJobRow(userId, { company: 'Locked Three' }),
    ];

    const insertResult = await serviceClient.from('jobs').insert(rows);
    if (insertResult.error) throw insertResult.error;

    const result = await callLockedBulkDeleteRpc(userId);
    const counts = await getStorageCounts(userId);

    expect(result).toEqual(expect.objectContaining({
      applied: true,
      deletedCount: 3,
      lockedCountBeforeDelete: 3,
      lockedCountAfterDelete: 0,
    }));
    expect(counts).toEqual({
      active_count: 2,
      locked_count: 0,
      retained_total_count: 2,
    });
  });

  it('honors the per-call row limit and remains idempotent on retry', async () => {
    const userId = await createTestUser();
    const insertResult = await serviceClient.from('jobs').insert([
      buildLockedJobRow(userId, { company: 'Limit Locked One' }),
      buildLockedJobRow(userId, { company: 'Limit Locked Two' }),
      buildLockedJobRow(userId, { company: 'Limit Locked Three' }),
    ]);
    if (insertResult.error) throw insertResult.error;

    const firstResult = await callLockedBulkDeleteRpc(userId, { lockedDeleteLimit: 2 });
    const afterFirstCounts = await getStorageCounts(userId);
    const secondResult = await callLockedBulkDeleteRpc(userId, { lockedDeleteLimit: 2 });
    const afterSecondCounts = await getStorageCounts(userId);

    expect(firstResult.deletedCount).toBe(2);
    expect(afterFirstCounts.locked_count).toBe(1);
    expect(secondResult.deletedCount).toBe(1);
    expect(afterSecondCounts.locked_count).toBe(0);
  });

  it('serializes concurrent bulk-delete calls without double-counting locked rows', async () => {
    const userId = await createTestUser();
    const insertResult = await serviceClient.from('jobs').insert([
      buildLockedJobRow(userId, { company: 'Concurrent Locked One' }),
      buildLockedJobRow(userId, { company: 'Concurrent Locked Two' }),
      buildLockedJobRow(userId, { company: 'Concurrent Locked Three' }),
    ]);
    if (insertResult.error) throw insertResult.error;

    const results = await Promise.all([
      callLockedBulkDeleteRpc(userId, { lockedDeleteLimit: 2 }),
      callLockedBulkDeleteRpc(userId, { lockedDeleteLimit: 2 }),
    ]);
    const deletedCounts = results
      .map((result) => result.deletedCount)
      .sort((left, right) => left - right);

    expect(deletedCounts).toEqual([1, 2]);
    await expect(getStorageCounts(userId)).resolves.toEqual({
      active_count: 0,
      locked_count: 0,
      retained_total_count: 0,
    });
  });

  it('does not delete when caller status is not terminal Free', async () => {
    const userId = await createTestUser();
    const insertResult = await serviceClient.from('jobs').insert([
      buildLockedJobRow(userId, { company: 'Wrong Status Locked' }),
    ]);
    if (insertResult.error) throw insertResult.error;

    const result = await callLockedBulkDeleteRpc(userId, {
      storageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
    });
    const counts = await getStorageCounts(userId);

    expect(result).toEqual(expect.objectContaining({
      applied: false,
      reason: 'storage_status_not_delete_eligible',
      deletedCount: 0,
    }));
    expect(counts.locked_count).toBe(1);
  });

  it('does not delete when canonical billing recheck is no longer terminal Free', async () => {
    const userId = await createTestUser();
    await seedActivePremiumBilling(userId);

    const insertResult = await serviceClient.from('jobs').insert([
      buildLockedJobRow(userId, { company: 'Premium Locked' }),
    ]);
    if (insertResult.error) throw insertResult.error;

    const result = await callLockedBulkDeleteRpc(userId, {
      storageStatus: STORAGE_STATUSES.TERMINAL_FREE,
    });
    const counts = await getStorageCounts(userId);

    expect(result).toEqual(expect.objectContaining({
      applied: false,
      reason: 'canonical_billing_not_terminal_free',
      canonicalStorageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
      deletedCount: 0,
    }));
    expect(counts.locked_count).toBe(1);
  });
});
