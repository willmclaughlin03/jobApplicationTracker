/**
 * Suite F - Jobs Premium restore integration tests
 *
 * Purpose: Verify Chunk 7's database RPC restores locked overflow jobs only
 * for canonical Premium entitlement and keeps historical over-cap rows bounded.
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
const JOBS_PREMIUM_RESTORE_MIGRATION_FILE = '019_jobs_premium_restore.sql';

const TEST_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const TEST_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const hasInfra = Boolean(TEST_URL && TEST_SERVICE_KEY);
const describeOrSkip = hasInfra ? describe : describe.skip;
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
 * Normalize JSON returned by the restore RPC.
 *
 * @param {unknown} data Raw RPC payload.
 * @returns {object|null} Parsed object payload.
 */
function normalizeRestoreRpcData(data) {
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
 * Build an insertable jobs row for Premium restore tests.
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
    company: `Restore ${uniqueSuffix}`,
    position: 'Premium Restore Engineer',
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
 * Build a valid locked overflow row for Premium restore tests.
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

describeOrSkip('Suite F - Jobs Premium restore integration', () => {
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
          'Jobs Premium restore integration tests require a service-role-only '
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
   * Apply prerequisite and Chunk 7 jobs migrations.
   *
   * @returns {Promise<void>}
   */
  async function ensureJobsPremiumRestoreMigrationsApplied() {
    const tableRows = await execSql(`
      SELECT pg_catalog.to_regclass('public.jobs')::text AS jobs_table
    `);

    if (!tableRows[0]?.jobs_table) {
      throw new Error(
        'public.jobs is missing in the integration environment; '
        + 'apply or restore the base jobs schema before running Chunk 7 evidence.'
      );
    }

    for (const migrationFile of [
      JOBS_STORAGE_MIGRATION_FILE,
      JOBS_ATOMIC_CREATE_MIGRATION_FILE,
      JOBS_OVERFLOW_LOCKING_MIGRATION_FILE,
      JOBS_PREMIUM_RESTORE_MIGRATION_FILE,
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
   * Seed generated active and locked jobs for one user.
   *
   * @param {string} userId Owner auth user id.
   * @param {{ activeCount?: number, lockedCount?: number }} counts Row counts to seed.
   * @returns {Promise<void>}
   */
  async function seedGeneratedJobs(userId, { activeCount = 0, lockedCount = 0 }) {
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const baseTime = Date.parse('2026-06-01T00:00:00.000Z');

    if (activeCount > 0) {
      const activeRows = Array.from({ length: activeCount }, (_, index) => buildJobRow(userId, {
        company: `Restore Active ${uniqueSuffix}-${index + 1}`,
        created_at: new Date(baseTime + index * 1000).toISOString(),
      }));

      for (let index = 0; index < activeRows.length; index += JOBS_SEED_BATCH_SIZE) {
        const { error } = await serviceClient.from('jobs').insert(
          activeRows.slice(index, index + JOBS_SEED_BATCH_SIZE)
        );

        if (error) throw error;
      }
    }

    if (lockedCount > 0) {
      const lockedRows = Array.from({ length: lockedCount }, (_, index) => buildLockedJobRow(userId, {
        company: `Restore Locked ${uniqueSuffix}-${index + 1}`,
        created_at: new Date(baseTime + (activeCount + index) * 1000).toISOString(),
      }));

      for (let index = 0; index < lockedRows.length; index += JOBS_SEED_BATCH_SIZE) {
        const { error } = await serviceClient.from('jobs').insert(
          lockedRows.slice(index, index + JOBS_SEED_BATCH_SIZE)
        );

        if (error) throw error;
      }
    }
  }

  /**
   * Seed explicit locked jobs for deterministic restore tests.
   *
   * @param {string} userId Owner auth user id.
   * @param {object[]} rows Row overrides to insert.
   * @returns {Promise<void>}
   */
  async function seedExplicitLockedJobs(userId, rows) {
    const { error } = await serviceClient.from('jobs').insert(
      rows.map((row) => buildLockedJobRow(userId, row))
    );

    if (error) throw error;
  }

  /**
   * Seed canonical local Premium billing rows for one integration user.
   *
   * @param {string} userId Owner auth user id.
   * @param {object} overrides Subscription-column overrides.
   * @returns {Promise<object>} Persisted billing subscription row.
   */
  async function seedBillingSubscription(userId, overrides = {}) {
    const uniqueSuffix = userId.replace(/-/g, '').slice(0, 20);
    const stripeCustomerId = `cus_restore_${uniqueSuffix}`;
    const stripeSubscriptionId = `sub_restore_${uniqueSuffix}`;
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
   * Call the Premium restore RPC with supplied status and limit.
   *
   * @param {string} userId Owner auth user id.
   * @param {object} options RPC options.
   * @param {string} options.storageStatus Caller-observed storage status.
   * @param {number} options.retainedLimit Absolute retained row cap.
   * @param {string[]} options.entitledPriceIds Server-configured Premium price allowlist.
   * @returns {Promise<object>} Normalized RPC response payload.
   */
  async function callPremiumRestoreRpc(
    userId,
    {
      storageStatus = STORAGE_STATUSES.PREMIUM_ACTIVE,
      retainedLimit = ABSOLUTE_RETAINED_JOB_LIMIT,
      entitledPriceIds = ['price_premium_monthly'],
    } = {}
  ) {
    let lastError = null;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { data, error } = await serviceClient.rpc('restore_locked_jobs_for_premium_user', {
        p_user_id: userId,
        p_storage_status: storageStatus,
        p_absolute_retained_job_limit: retainedLimit,
        p_entitled_price_ids: entitledPriceIds,
      });

      if (!error) {
        return normalizeRestoreRpcData(data);
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
   * Call the atomic create RPC used by the over-cap create-block test.
   *
   * @param {string} userId Owner auth user id.
   * @returns {Promise<object>} Normalized RPC response payload.
   */
  async function callCreateJobRpc(userId) {
    const { data, error } = await serviceClient.rpc('create_job_with_storage_quota', {
      p_user_id: userId,
      p_job_data: buildJobRow(userId, {
        company: `Restore create ${Date.now()}`,
      }),
      p_storage_status: STORAGE_STATUSES.PREMIUM_ACTIVE,
      p_active_job_limit: FREE_ACTIVE_JOB_LIMIT,
      p_absolute_retained_job_limit: ABSOLUTE_RETAINED_JOB_LIMIT,
    });

    if (error) throw error;
    return normalizeRestoreRpcData(data);
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

    await ensureJobsPremiumRestoreMigrationsApplied();
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

  test('F1: Premium restore migration file exists and RPC remains service-role only', async () => {
    expect(existsSync(join(MIGRATIONS_DIR, JOBS_PREMIUM_RESTORE_MIGRATION_FILE))).toBe(true);

    const privilegeRows = await execSql(`
      SELECT
        has_function_privilege(
          'authenticated',
          'public.restore_locked_jobs_for_premium_user(uuid,text,integer,text[])',
          'EXECUTE'
        ) AS authenticated_can_execute,
        has_function_privilege(
          'service_role',
          'public.restore_locked_jobs_for_premium_user(uuid,text,integer,text[])',
          'EXECUTE'
        ) AS service_role_can_execute
    `);

    expect(privilegeRows[0]).toEqual(expect.objectContaining({
      authenticated_can_execute: false,
      service_role_can_execute: true,
    }));
  });

  test('F2: ordinary Premium restore unlocks locked rows and a second run is a no-op', async () => {
    const user = await createTempUser('jobs-restore-ordinary');
    await seedBillingSubscription(user.id);
    await seedGeneratedJobs(user.id, { activeCount: FREE_ACTIVE_JOB_LIMIT, lockedCount: 12 });

    const firstResult = await callPremiumRestoreRpc(user.id);
    const secondResult = await callPremiumRestoreRpc(user.id);

    expect(firstResult).toEqual(expect.objectContaining({
      applied: true,
      restoredCount: 12,
      activeCountAfterRestore: FREE_ACTIVE_JOB_LIMIT + 12,
      lockedCountAfterRestore: 0,
    }));
    expect(secondResult).toEqual(expect.objectContaining({
      applied: true,
      restoredCount: 0,
      activeCountAfterRestore: FREE_ACTIVE_JOB_LIMIT + 12,
      lockedCountAfterRestore: 0,
    }));
    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: FREE_ACTIVE_JOB_LIMIT + 12,
      locked_count: 0,
      retained_total_count: FREE_ACTIVE_JOB_LIMIT + 12,
    });
  });

  test('F3: non-Premium and billing-unavailable caller statuses never restore rows', async () => {
    const user = await createTempUser('jobs-restore-non-premium');
    await seedBillingSubscription(user.id);
    await seedGeneratedJobs(user.id, { activeCount: 1, lockedCount: 2 });

    const terminalFreeResult = await callPremiumRestoreRpc(user.id, {
      storageStatus: STORAGE_STATUSES.TERMINAL_FREE,
    });
    const billingUnavailableResult = await callPremiumRestoreRpc(user.id, {
      storageStatus: STORAGE_STATUSES.BILLING_UNAVAILABLE,
    });

    expect(terminalFreeResult).toEqual(expect.objectContaining({
      applied: false,
      reason: 'storage_status_not_restore_eligible',
      restoredCount: 0,
    }));
    expect(billingUnavailableResult).toEqual(expect.objectContaining({
      applied: false,
      reason: 'storage_status_not_restore_eligible',
      restoredCount: 0,
    }));
    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: 1,
      locked_count: 2,
      retained_total_count: 3,
    });
  });

  test('F4: canonical terminal Free rejects a stale Premium restore request', async () => {
    const user = await createTempUser('jobs-restore-stale-premium');
    await seedGeneratedJobs(user.id, { activeCount: 1, lockedCount: 2 });

    const result = await callPremiumRestoreRpc(user.id, {
      storageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
    });

    expect(result).toEqual(expect.objectContaining({
      applied: false,
      reason: 'canonical_billing_not_premium',
      canonicalStorageStatus: STORAGE_STATUSES.TERMINAL_FREE,
      restoredCount: 0,
    }));
    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: 1,
      locked_count: 2,
      retained_total_count: 3,
    });
  });

  test('F5: active non-allowlisted price rejects a stale Premium restore request', async () => {
    const user = await createTempUser('jobs-restore-wrong-price');
    await seedBillingSubscription(user.id, { price_id: 'price_other_monthly' });
    await seedGeneratedJobs(user.id, { activeCount: 1, lockedCount: 2 });

    const result = await callPremiumRestoreRpc(user.id, {
      storageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
      entitledPriceIds: ['price_premium_monthly'],
    });

    expect(result).toEqual(expect.objectContaining({
      applied: false,
      reason: 'canonical_billing_not_premium',
      canonicalStorageStatus: STORAGE_STATUSES.NON_ENTITLED_NON_TERMINAL,
      canonicalEntitlementReason: 'price_id_not_allowlisted',
      restoredCount: 0,
    }));
    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: 1,
      locked_count: 2,
      retained_total_count: 3,
    });
  });

  test('F6: over-cap historical rows restore only up to the Premium cap and still block creates', async () => {
    const user = await createTempUser('jobs-restore-over-cap');
    await seedBillingSubscription(user.id);
    await seedGeneratedJobs(user.id, {
      activeCount: FREE_ACTIVE_JOB_LIMIT,
      lockedCount: ABSOLUTE_RETAINED_JOB_LIMIT - FREE_ACTIVE_JOB_LIMIT + 200,
    });

    const restoreResult = await callPremiumRestoreRpc(user.id);
    const createResult = await callCreateJobRpc(user.id);

    expect(restoreResult).toEqual(expect.objectContaining({
      applied: true,
      restoredCount: ABSOLUTE_RETAINED_JOB_LIMIT - FREE_ACTIVE_JOB_LIMIT,
      activeCountAfterRestore: ABSOLUTE_RETAINED_JOB_LIMIT,
      lockedCountAfterRestore: 200,
      retainedTotalCount: ABSOLUTE_RETAINED_JOB_LIMIT + 200,
      retainedOverLimit: true,
    }));
    expect(createResult).toEqual(expect.objectContaining({
      created: false,
      code: 'STORAGE_LIMIT_EXCEEDED',
    }));
    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: ABSOLUTE_RETAINED_JOB_LIMIT,
      locked_count: 200,
      retained_total_count: ABSOLUTE_RETAINED_JOB_LIMIT + 200,
    });
  });

  test('F7: deterministic restore ordering keeps status-priority rows first', async () => {
    const user = await createTempUser('jobs-restore-ordering');
    await seedBillingSubscription(user.id);
    const activeSeedResult = await serviceClient.from('jobs').insert(
      buildJobRow(user.id, {
        company: 'Existing Active Baseline',
      })
    );

    if (activeSeedResult.error) throw activeSeedResult.error;

    await seedExplicitLockedJobs(user.id, [
      {
        company: 'Restore Offered Old',
        status: 'offered',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        company: 'Restore Interviewing Old',
        status: 'interviewing',
        created_at: '2026-01-02T00:00:00.000Z',
      },
      {
        company: 'Leave Applied New',
        status: 'applied',
        created_at: '2026-01-05T00:00:00.000Z',
      },
      {
        company: 'Leave Rejected Newest',
        status: 'rejected',
        created_at: '2026-01-06T00:00:00.000Z',
      },
    ]);

    const result = await callPremiumRestoreRpc(user.id, { retainedLimit: 3 });
    const { data, error } = await serviceClient
      .from('jobs')
      .select('company, storage_state')
      .eq('user_id', user.id)
      .order('company', { ascending: true });

    if (error) throw error;

    const restoredCompanies = data
      .filter((row) => row.storage_state === JOB_STORAGE_STATES.ACTIVE)
      .map((row) => row.company)
      .filter((company) => company.startsWith('Restore '));
    const lockedCompanies = data
      .filter((row) => row.storage_state === JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT)
      .map((row) => row.company);

    expect(result.restoredCount).toBe(2);
    expect(restoredCompanies).toEqual([
      'Restore Interviewing Old',
      'Restore Offered Old',
    ]);
    expect(lockedCompanies).toEqual([
      'Leave Applied New',
      'Leave Rejected Newest',
    ]);
  });
});
