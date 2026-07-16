/**
 * Suite E - Jobs downgrade overflow locking integration tests
 *
 * Purpose: Verify Chunk 6's database RPC locks over-cap terminal-Free active
 * jobs idempotently and deterministically without mutating ambiguous states.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  ABSOLUTE_RETAINED_JOB_LIMIT,
  FREE_ACTIVE_JOB_LIMIT,
  JOB_STORAGE_LOCK_POLICY_VERSION,
  JOB_STORAGE_LOCK_REASONS,
  JOB_STORAGE_STATES,
} from '../../../shared/constants/storage.js';
import { STORAGE_STATUSES } from '../../../shared/constants/billing.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const JOBS_STORAGE_MIGRATION_FILE = '016_jobs_storage_state_boundary.sql';
const JOBS_ATOMIC_CREATE_MIGRATION_FILE = '017_jobs_atomic_create_quota.sql';
const JOBS_OVERFLOW_LOCKING_MIGRATION_FILE = '018_jobs_overflow_locking.sql';
const AUTHORITATIVE_SNAPSHOT_MIGRATION_FILE = '026_require_authoritative_billing_snapshot.sql';

const {
  TEST_SUPABASE_ENV_NAMES,
  resolveDescribeOrSkip,
} = require('../../../testSupport/integrationEnvironment.js');

const TEST_URL = process.env[TEST_SUPABASE_ENV_NAMES.url];
const TEST_SERVICE_KEY = process.env[TEST_SUPABASE_ENV_NAMES.serviceKey];
const { describeOrSkip } = resolveDescribeOrSkip(process.env, {
  suiteName: 'Suite E',
  requiredNames: [
    TEST_SUPABASE_ENV_NAMES.url,
    TEST_SUPABASE_ENV_NAMES.serviceKey,
  ],
}, describe);

const JOBS_SEED_BATCH_SIZE = 500;

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
 * @param {object | null | undefined} error Supabase error object.
 * @returns {string} Combined non-sensitive error text.
 */
function buildPermissionMessage(error) {
  return `${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''} ${error?.code ?? ''}`.trim();
}

/**
 * Detect PostgREST schema-cache misses after installing SQL objects.
 *
 * @param {object | null | undefined} error Supabase error object.
 * @returns {boolean} True when retrying may allow schema cache propagation.
 */
function isRpcSchemaCacheError(error) {
  return /schema cache|could not find the function|PGRST/i.test(buildPermissionMessage(error));
}

/**
 * Detect a missing exec_sql helper in the integration database.
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
 * @param {number} milliseconds Delay duration.
 * @returns {Promise<void>} Resolves after the delay.
 */
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Normalize JSON returned by the overflow lock RPC.
 *
 * @param {unknown} data Raw RPC payload.
 * @returns {object|null} Parsed object payload.
 */
function normalizeLockRpcData(data) {
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
 * Build an insertable jobs row for overflow locking tests.
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
    company: `Overflow ${uniqueSuffix}`,
    position: 'Downgrade Engineer',
    status: 'applied',
    notes: '',
    salary_min: null,
    salary_max: null,
    status_date: now,
    storage_state: JOB_STORAGE_STATES.ACTIVE,
    ...overrides,
  };
}

jest.setTimeout(60_000);

describeOrSkip('Suite E - Jobs downgrade overflow locking integration', () => {
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
          'Jobs overflow locking integration tests require a service-role-only '
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
   * Apply prerequisite and Chunk 6 jobs migrations.
   *
   * @returns {Promise<void>}
   */
  async function ensureJobsOverflowLockingMigrationsApplied() {
    const tableRows = await execSql(`
      SELECT pg_catalog.to_regclass('public.jobs')::text AS jobs_table
    `);

    if (!tableRows[0]?.jobs_table) {
      throw new Error(
        'public.jobs is missing in the integration environment; '
        + 'apply or restore the base jobs schema before running Chunk 6 evidence.'
      );
    }

    for (const migrationFile of [
      JOBS_STORAGE_MIGRATION_FILE,
      JOBS_ATOMIC_CREATE_MIGRATION_FILE,
      JOBS_OVERFLOW_LOCKING_MIGRATION_FILE,
      AUTHORITATIVE_SNAPSHOT_MIGRATION_FILE,
    ]) {
      const migrationSql = readFileSync(join(MIGRATIONS_DIR, migrationFile), 'utf8');
      const { error } = await serviceClient.rpc('exec_sql', { query: migrationSql });
      expect(error).toBeNull();
    }

    await reloadPostgrestSchema();
  }

  /**
   * Create a temporary confirmed auth user for integration tests.
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
   * Seed generated active jobs for one user.
   *
   * @param {string} userId Owner auth user id.
   * @param {number} activeCount Number of active rows to insert.
   * @returns {Promise<void>}
   */
  async function seedGeneratedActiveJobs(userId, activeCount) {
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const baseTime = Date.parse('2026-06-01T00:00:00.000Z');
    const rows = Array.from({ length: activeCount }, (_, index) => buildJobRow(userId, {
      company: `Overflow Active ${uniqueSuffix}-${index + 1}`,
      created_at: new Date(baseTime + index * 1000).toISOString(),
    }));

    for (let index = 0; index < rows.length; index += JOBS_SEED_BATCH_SIZE) {
      const { error } = await serviceClient.from('jobs').insert(
        rows.slice(index, index + JOBS_SEED_BATCH_SIZE)
      );

      if (error) throw error;
    }
  }

  /**
   * Seed explicit active jobs for deterministic selection tests.
   *
   * @param {string} userId Owner auth user id.
   * @param {object[]} rows Row overrides to insert.
   * @returns {Promise<void>}
   */
  async function seedExplicitActiveJobs(userId, rows) {
    const { error } = await serviceClient.from('jobs').insert(
      rows.map((row) => buildJobRow(userId, row))
    );

    if (error) throw error;
  }

  /**
   * Call the overflow lock RPC with supplied status and limit.
   *
   * @param {string} userId Owner auth user id.
   * @param {object} options RPC options.
   * @param {string} options.storageStatus Storage policy status.
   * @param {number} options.activeLimit Active rows to leave unlocked.
   * @returns {Promise<object>} Normalized RPC response payload.
   */
  async function callOverflowLockRpc(
    userId,
    {
      storageStatus = STORAGE_STATUSES.TERMINAL_FREE,
      activeLimit = FREE_ACTIVE_JOB_LIMIT,
    } = {}
  ) {
    let lastError = null;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { data, error } = await serviceClient.rpc('lock_overflow_jobs_for_terminal_free_user', {
        p_user_id: userId,
        p_storage_status: storageStatus,
        p_active_job_limit: activeLimit,
        p_locked_reason: JOB_STORAGE_LOCK_REASONS.PREMIUM_TO_FREE_OVER_PLAN_LIMIT,
        p_locked_policy_version: JOB_STORAGE_LOCK_POLICY_VERSION,
      });

      if (!error) {
        return normalizeLockRpcData(data);
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
   * Call the atomic create RPC used by the create-versus-lock race test.
   *
   * @param {string} userId Owner auth user id.
   * @param {string} storageStatus Caller-observed storage status.
   * @returns {Promise<object>} Normalized RPC response payload.
   */
  async function callCreateJobRpc(
    userId,
    storageStatus = STORAGE_STATUSES.TERMINAL_FREE
  ) {
    const { data, error } = await serviceClient.rpc('create_job_with_storage_quota', {
      p_user_id: userId,
      p_job_data: buildJobRow(userId, {
        company: `Concurrent create ${Date.now()}`,
      }),
      p_storage_status: storageStatus,
      p_active_job_limit: FREE_ACTIVE_JOB_LIMIT,
      p_absolute_retained_job_limit: ABSOLUTE_RETAINED_JOB_LIMIT,
    });

    if (error) throw error;
    return normalizeLockRpcData(data);
  }

  /**
   * Seed canonical local billing rows for one integration user.
   *
   * @param {string} userId Owner auth user id.
   * @param {object} overrides Subscription-column overrides.
   * @returns {Promise<object>} Persisted billing subscription row.
   */
  async function seedBillingSubscription(userId, overrides = {}) {
    const uniqueSuffix = userId.replace(/-/g, '').slice(0, 20);
    const stripeCustomerId = `cus_overflow_${uniqueSuffix}`;
    const stripeSubscriptionId = `sub_overflow_${uniqueSuffix}`;
    const customerResult = await serviceClient.from('billing_customers').upsert({
      user_id: userId,
      stripe_customer_id: stripeCustomerId,
    });

    if (customerResult.error) throw customerResult.error;

    const subscriptionResult = await serviceClient
      .from('billing_subscriptions')
      .upsert({
        user_id: userId,
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: stripeCustomerId,
        price_id: 'price_premium_monthly',
        status: 'active',
        current_period_end: '2026-07-01T00:00:00.000Z',
        cancel_at_period_end: false,
        ...overrides,
      })
      .select('*')
      .single();

    if (subscriptionResult.error) throw subscriptionResult.error;
    return subscriptionResult.data;
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

    await ensureJobsOverflowLockingMigrationsApplied();
  });

  afterAll(async () => {
    if (!serviceClient) return;

    const userIds = [...cleanupUserIds];

    if (userIds.length > 0) {
      const { error: jobsError } = await serviceClient.from('jobs').delete().in('user_id', userIds);
      if (jobsError) throw jobsError;

      const { error: subscriptionsError } = await serviceClient
        .from('billing_subscriptions')
        .delete()
        .in('user_id', userIds);
      if (subscriptionsError) throw subscriptionsError;

      const { error: customersError } = await serviceClient
        .from('billing_customers')
        .delete()
        .in('user_id', userIds);
      if (customersError) throw customersError;
    }

    for (const userId of userIds) {
      const { error: deleteUserError } = await serviceClient.auth.admin.deleteUser(userId);
      if (deleteUserError) throw deleteUserError;
    }
  });

  test('E1: overflow locking migration file exists', () => {
    expect(existsSync(join(MIGRATIONS_DIR, JOBS_OVERFLOW_LOCKING_MIGRATION_FILE))).toBe(true);
    expect(existsSync(join(MIGRATIONS_DIR, AUTHORITATIVE_SNAPSHOT_MIGRATION_FILE))).toBe(true);
  });

  test('E2: exactly 301 active jobs locks one row and a second run is a no-op', async () => {
    const user = await createTempUser('jobs-overflow-301');
    await seedGeneratedActiveJobs(user.id, FREE_ACTIVE_JOB_LIMIT + 1);

    const firstResult = await callOverflowLockRpc(user.id);
    const secondResult = await callOverflowLockRpc(user.id);

    expect(firstResult).toEqual(expect.objectContaining({
      applied: true,
      lockedCount: 1,
      activeCountAfterLock: FREE_ACTIVE_JOB_LIMIT,
    }));
    expect(secondResult).toEqual(expect.objectContaining({
      applied: true,
      lockedCount: 0,
      activeCountBeforeLock: FREE_ACTIVE_JOB_LIMIT,
      activeCountAfterLock: FREE_ACTIVE_JOB_LIMIT,
    }));
    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: FREE_ACTIVE_JOB_LIMIT,
      locked_count: 1,
      retained_total_count: FREE_ACTIVE_JOB_LIMIT + 1,
    });
  });

  test('E3: exactly 300 active jobs locks none', async () => {
    const user = await createTempUser('jobs-overflow-300');
    await seedGeneratedActiveJobs(user.id, FREE_ACTIVE_JOB_LIMIT);

    const result = await callOverflowLockRpc(user.id);

    expect(result).toEqual(expect.objectContaining({
      applied: true,
      lockedCount: 0,
      activeCountBeforeLock: FREE_ACTIVE_JOB_LIMIT,
      activeCountAfterLock: FREE_ACTIVE_JOB_LIMIT,
    }));
    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: FREE_ACTIVE_JOB_LIMIT,
      locked_count: 0,
      retained_total_count: FREE_ACTIVE_JOB_LIMIT,
    });
  });

  test('E4: non-terminal storage status never locks rows', async () => {
    const user = await createTempUser('jobs-overflow-non-terminal');
    await seedGeneratedActiveJobs(user.id, FREE_ACTIVE_JOB_LIMIT + 1);

    const result = await callOverflowLockRpc(user.id, {
      storageStatus: STORAGE_STATUSES.BILLING_UNAVAILABLE,
    });

    expect(result).toEqual(expect.objectContaining({
      applied: false,
      reason: 'storage_status_not_lock_eligible',
      lockedCount: 0,
    }));
    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: FREE_ACTIVE_JOB_LIMIT + 1,
      locked_count: 0,
      retained_total_count: FREE_ACTIVE_JOB_LIMIT + 1,
    });
  });

  test('E5: deterministic selection keeps status-priority rows before terminal rows', async () => {
    const user = await createTempUser('jobs-overflow-ordering');
    await seedExplicitActiveJobs(user.id, [
      {
        company: 'Keep Offered Old',
        status: 'offered',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        company: 'Keep Interviewing Old',
        status: 'interviewing',
        created_at: '2026-01-02T00:00:00.000Z',
      },
      {
        company: 'Keep Applied New',
        status: 'applied',
        created_at: '2026-01-05T00:00:00.000Z',
      },
      {
        company: 'Lock Applied Old',
        status: 'applied',
        created_at: '2026-01-03T00:00:00.000Z',
      },
      {
        company: 'Lock Rejected Newest',
        status: 'rejected',
        created_at: '2026-01-06T00:00:00.000Z',
      },
    ]);

    const result = await callOverflowLockRpc(user.id, { activeLimit: 3 });
    const { data, error } = await serviceClient
      .from('jobs')
      .select('company, storage_state')
      .eq('user_id', user.id)
      .order('company', { ascending: true });

    if (error) throw error;

    const activeCompanies = data
      .filter((row) => row.storage_state === JOB_STORAGE_STATES.ACTIVE)
      .map((row) => row.company);
    const lockedCompanies = data
      .filter((row) => row.storage_state === JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT)
      .map((row) => row.company);

    expect(result.lockedCount).toBe(2);
    expect(activeCompanies).toEqual([
      'Keep Applied New',
      'Keep Interviewing Old',
      'Keep Offered Old',
    ]);
    expect(lockedCompanies).toEqual([
      'Lock Applied Old',
      'Lock Rejected Newest',
    ]);
  });

  test('E6: concurrent lock calls produce one stable final state', async () => {
    const user = await createTempUser('jobs-overflow-concurrent');
    await seedGeneratedActiveJobs(user.id, FREE_ACTIVE_JOB_LIMIT + 2);

    const [firstResult, secondResult] = await Promise.all([
      callOverflowLockRpc(user.id),
      callOverflowLockRpc(user.id),
    ]);

    expect((firstResult.lockedCount ?? 0) + (secondResult.lockedCount ?? 0)).toBe(2);
    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: FREE_ACTIVE_JOB_LIMIT,
      locked_count: 2,
      retained_total_count: FREE_ACTIVE_JOB_LIMIT + 2,
    });
  });

  test('E7: canonical Premium billing rejects a stale terminal-Free lock request', async () => {
    const user = await createTempUser('jobs-overflow-stale-terminal');
    await seedGeneratedActiveJobs(user.id, FREE_ACTIVE_JOB_LIMIT + 1);
    await seedBillingSubscription(user.id);

    const result = await callOverflowLockRpc(user.id);

    expect(result).toEqual(expect.objectContaining({
      applied: false,
      reason: 'canonical_billing_not_terminal_free',
      canonicalStorageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
      lockedCount: 0,
    }));
    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: FREE_ACTIVE_JOB_LIMIT + 1,
      locked_count: 0,
      retained_total_count: FREE_ACTIVE_JOB_LIMIT + 1,
    });
  });

  test('E8: guarded authoritative reconcile cannot replace a newer subscription', async () => {
    const user = await createTempUser('jobs-overflow-authoritative-cas');
    const originalSubscription = await seedBillingSubscription(user.id, {
      status: 'canceled',
      current_period_end: '2026-06-01T00:00:00.000Z',
    });
    const newerSubscriptionId = `${originalSubscription.stripe_subscription_id}_new`;

    let newerResult;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) {
        await wait(250);
      }

      newerResult = await serviceClient
        .from('billing_subscriptions')
        .update({
          stripe_subscription_id: newerSubscriptionId,
          status: 'active',
          current_period_end: '2026-07-01T00:00:00.000Z',
          cancel_at_period_end: false,
        })
        .eq('user_id', user.id)
        .select('*')
        .single();

      if (newerResult.error) throw newerResult.error;
      if (newerResult.data?.snapshot_version !== originalSubscription.snapshot_version) break;
    }

    expect(newerResult.data?.snapshot_version).toBeGreaterThan(
      originalSubscription.snapshot_version
    );

    const { data, error } = await serviceClient.rpc(
      'upsert_billing_subscription_authoritative',
      {
        payload: {
          user_id: user.id,
          stripe_subscription_id: originalSubscription.stripe_subscription_id,
          stripe_customer_id: originalSubscription.stripe_customer_id,
          price_id: originalSubscription.price_id,
          status: 'canceled',
          current_period_end: originalSubscription.current_period_end,
          cancel_at_period_end: false,
          _expected_subscription_exists: true,
          _expected_stripe_subscription_id: originalSubscription.stripe_subscription_id,
          _expected_subscription_snapshot_version: originalSubscription.snapshot_version,
          _authoritative_sync_purpose: 'reconcile_current',
        },
      }
    );

    if (error) throw error;

    expect(normalizeLockRpcData(data)).toEqual(expect.objectContaining({
      applied: false,
      reason: 'billing_snapshot_changed',
      subscription: expect.objectContaining({
        stripe_subscription_id: newerSubscriptionId,
        status: 'active',
      }),
    }));
  });

  test('E9: concurrent terminal-Free create and lock leave exactly the Free active cap', async () => {
    const user = await createTempUser('jobs-overflow-create-lock');
    await seedGeneratedActiveJobs(user.id, FREE_ACTIVE_JOB_LIMIT + 1);

    const [createResult, lockResult] = await Promise.all([
      callCreateJobRpc(user.id),
      callOverflowLockRpc(user.id),
    ]);

    expect(createResult).toEqual(expect.objectContaining({
      created: false,
      code: 'STORAGE_LIMIT_EXCEEDED',
    }));
    expect(lockResult.applied).toBe(true);
    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: FREE_ACTIVE_JOB_LIMIT,
      locked_count: 1,
      retained_total_count: FREE_ACTIVE_JOB_LIMIT + 1,
    });
  });

  test('E10: stale Premium create is rejected after canonical billing becomes terminal Free', async () => {
    const user = await createTempUser('jobs-overflow-stale-premium-create');
    await seedBillingSubscription(user.id, {
      status: 'canceled',
      current_period_end: '2026-06-01T00:00:00.000Z',
      cancel_at_period_end: false,
    });

    const result = await callCreateJobRpc(user.id, STORAGE_STATUSES.PREMIUM_ACTIVE);

    expect(result).toEqual(expect.objectContaining({
      created: false,
      code: 'BILLING_STATUS_UNAVAILABLE',
      reason: 'billing_status_changed',
      canonicalStorageStatus: STORAGE_STATUSES.TERMINAL_FREE,
    }));
    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: 0,
      locked_count: 0,
      retained_total_count: 0,
    });
  });
});
