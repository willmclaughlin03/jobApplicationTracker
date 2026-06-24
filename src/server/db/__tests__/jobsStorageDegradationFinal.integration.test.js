/**
 * Suite H - Final paid-to-free storage degradation integration tests.
 *
 * Purpose: Verify the complete final-state database and service boundary after
 * all storage degradation migrations are installed, including edge cases that
 * can be missed when individual chunk suites run against historical RPC shapes.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  ABSOLUTE_RETAINED_JOB_LIMIT,
  FREE_ACTIVE_JOB_LIMIT,
  JOB_STORAGE_LOCK_POLICY_VERSION,
  JOB_STORAGE_LOCK_REASONS,
  JOB_STORAGE_QUERY_STATES,
  JOB_STORAGE_STATES,
  LOCKED_BULK_DELETE_ROW_LIMIT,
} from '../../../shared/constants/storage.js';
import { STORAGE_CREATE_ERROR_CODES, STORAGE_STATUSES } from '../../../shared/constants/billing.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const FINAL_STORAGE_MIGRATION_FILES = Object.freeze([
  '016_jobs_storage_state_boundary.sql',
  '017_jobs_atomic_create_quota.sql',
  '018_jobs_overflow_locking.sql',
  '019_jobs_premium_restore.sql',
  '020_jobs_locked_bulk_delete.sql',
]);

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
    'Refusing to run Suite H: NEXT_PUBLIC_SUPABASE_URL must match SUPABASE_TEST_PROJECT_REF.'
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
 * Normalize JSON returned by Supabase RPC calls.
 *
 * @param {unknown} data Raw RPC payload.
 * @returns {object|null} Parsed object payload.
 */
function normalizeRpcData(data) {
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
 * Build searchable non-sensitive text from a Supabase error.
 *
 * @param {object|null|undefined} error Supabase error object.
 * @returns {string} Combined error text.
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
 * Detect a permission-shaped RPC denial for direct anon/authenticated calls.
 *
 * @param {object|null|undefined} error Supabase error object.
 * @returns {boolean} True when the direct call was denied before mutation.
 */
function isDirectRpcDeniedError(error) {
  return /permission|not have permission|not found|schema cache|could not find the function|PGRST|42501|401|403/i
    .test(buildPermissionMessage(error));
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
 * Build a minimally valid jobs row for final-state storage tests.
 *
 * @param {string} userId Owner auth user id.
 * @param {object} overrides Column overrides for a specific row.
 * @returns {object} Insertable jobs row.
 */
function buildJobRow(userId, overrides = {}) {
  const now = new Date().toISOString();
  const uniqueSuffix = randomUUID().slice(0, 8);

  return {
    user_id: userId,
    company: `Final Storage ${uniqueSuffix}`,
    position: 'Storage Evidence Engineer',
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
 * Build a valid locked overflow jobs row.
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

/**
 * Build the JSON payload accepted by create_job_with_storage_quota().
 *
 * @param {string} company Company name for the created job.
 * @returns {object} Insertable RPC payload.
 */
function buildCreateJobPayload(company = `Final Create ${randomUUID().slice(0, 8)}`) {
  return {
    company,
    position: 'Final Create Engineer',
    status: 'applied',
    notes: '',
    salary_min: null,
    salary_max: null,
    status_date: new Date().toISOString(),
  };
}

/**
 * Build two deterministic UUIDs where the second sorts after the first.
 *
 * @returns {{ lowId: string, highId: string }} Ordered UUID pair.
 */
function buildOrderedUuidPair() {
  const [segmentA, segmentB, segmentC, segmentD] = randomUUID().split('-');

  return {
    lowId: `${segmentA}-${segmentB}-${segmentC}-${segmentD}-000000000001`,
    highId: `${segmentA}-${segmentB}-${segmentC}-${segmentD}-000000000002`,
  };
}

/**
 * Build a quiet logger for service-level integration calls.
 *
 * @returns {{ info: Function, warn: Function, error: Function }} Jest logger mock.
 */
function buildTestLog() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

jest.setTimeout(90_000);

describeOrSkip('Suite H - Final paid-to-free storage degradation integration', () => {
  let serviceClient;
  let anonClient;
  let createClient;
  let getJobsByUserId;
  let getJobById;
  let updateJob;
  let deleteJob;
  let getJobsCsvExportForUser;
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
          'Final storage degradation integration tests require a service-role-only '
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
   * Notify PostgREST to reload SQL function metadata before RPC calls.
   *
   * @returns {Promise<void>}
   */
  async function reloadPostgrestSchema() {
    await execSql(`notify pgrst, 'reload schema';`);
    await wait(500);
  }

  /**
   * Apply the complete jobs storage degradation migration stack.
   *
   * @returns {Promise<void>}
   */
  async function ensureFinalStorageMigrationsApplied() {
    const requiredTables = await execSql(`
      SELECT
        pg_catalog.to_regclass('public.jobs')::text AS jobs_table,
        pg_catalog.to_regclass('public.billing_customers')::text AS billing_customers_table,
        pg_catalog.to_regclass('public.billing_subscriptions')::text AS billing_subscriptions_table
    `);

    if (
      !requiredTables[0]?.jobs_table
      || !requiredTables[0]?.billing_customers_table
      || !requiredTables[0]?.billing_subscriptions_table
    ) {
      throw new Error(
        'Final storage degradation integration tests require existing jobs and billing tables; '
        + 'apply or restore the base app and billing schema before running Chunk 11 evidence.'
      );
    }

    for (const migrationFile of FINAL_STORAGE_MIGRATION_FILES) {
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
   * @param {string} prefix Email/local-part prefix.
   * @returns {Promise<{id: string, email: string}>} Created user identity.
   */
  async function createTempUser(prefix) {
    const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const { data, error } = await serviceClient.auth.admin.createUser({
      email,
      password: `Test-${randomUUID()}!`,
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
   * Seed canonical local billing rows for one user.
   *
   * @param {string} userId Owner auth user id.
   * @param {object} overrides Subscription-column overrides.
   * @returns {Promise<object>} Persisted billing subscription row.
   */
  async function seedBillingSubscription(userId, overrides = {}) {
    const uniqueSuffix = userId.replace(/-/g, '').slice(0, 20);
    const stripeCustomerId = `cus_final_${uniqueSuffix}`;
    const stripeSubscriptionId = `sub_final_${uniqueSuffix}_${randomUUID().slice(0, 8)}`;
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
        current_period_end: '2099-01-01T00:00:00.000Z',
        cancel_at_period_end: false,
        ...overrides,
      })
      .select('*')
      .single();

    if (subscriptionResult.error) throw subscriptionResult.error;
    return subscriptionResult.data;
  }

  /**
   * Seed only a billing customer mapping without a subscription.
   *
   * @param {string} userId Owner auth user id.
   * @returns {Promise<void>}
   */
  async function seedBillingCustomerOnly(userId) {
    const uniqueSuffix = userId.replace(/-/g, '').slice(0, 20);
    const { error } = await serviceClient.from('billing_customers').upsert({
      user_id: userId,
      stripe_customer_id: `cus_final_${uniqueSuffix}`,
    });

    if (error) throw error;
  }

  /**
   * Seed active and locked jobs for one user.
   *
   * @param {string} userId Owner auth user id.
   * @param {{ activeRows?: object[], lockedRows?: object[] }} params Rows to seed.
   * @returns {Promise<object[]>} Inserted job rows.
   */
  async function seedJobs(userId, { activeRows = [], lockedRows = [] } = {}) {
    const rows = [
      ...activeRows.map((overrides) => buildJobRow(userId, overrides)),
      ...lockedRows.map((overrides) => buildLockedJobRow(userId, overrides)),
    ];

    if (rows.length === 0) {
      return [];
    }

    const { data, error } = await serviceClient
      .from('jobs')
      .insert(rows)
      .select('*');

    if (error) throw error;
    return data;
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

  /**
   * Resolve canonical database storage status for one user.
   *
   * @param {string} userId Owner auth user id.
   * @returns {Promise<string>} Storage status returned by the SQL resolver.
   */
  async function resolveCanonicalStorageStatus(userId) {
    const { data, error } = await serviceClient.rpc('resolve_canonical_storage_status_for_user', {
      p_user_id: userId,
    });

    if (error) throw error;
    return data;
  }

  /**
   * Call the final atomic create RPC with configurable limits.
   *
   * @param {string} userId Owner auth user id.
   * @param {object} options RPC options.
   * @returns {Promise<object>} Normalized RPC response.
   */
  async function callCreateJobRpc(userId, options = {}) {
    const {
      storageStatus = STORAGE_STATUSES.TERMINAL_FREE,
      activeLimit = FREE_ACTIVE_JOB_LIMIT,
      retainedLimit = ABSOLUTE_RETAINED_JOB_LIMIT,
      company = undefined,
    } = options;
    const { data, error } = await serviceClient.rpc('create_job_with_storage_quota', {
      p_user_id: userId,
      p_job_data: buildCreateJobPayload(company),
      p_storage_status: storageStatus,
      p_active_job_limit: activeLimit,
      p_absolute_retained_job_limit: retainedLimit,
    });

    if (error) throw error;
    return normalizeRpcData(data);
  }

  /**
   * Call the final overflow lock RPC.
   *
   * @param {string} userId Owner auth user id.
   * @param {object} options RPC options.
   * @returns {Promise<object>} Normalized RPC response.
   */
  async function callOverflowLockRpc(userId, options = {}) {
    const {
      storageStatus = STORAGE_STATUSES.TERMINAL_FREE,
      activeLimit = FREE_ACTIVE_JOB_LIMIT,
    } = options;
    const { data, error } = await serviceClient.rpc('lock_overflow_jobs_for_terminal_free_user', {
      p_user_id: userId,
      p_storage_status: storageStatus,
      p_active_job_limit: activeLimit,
      p_locked_reason: JOB_STORAGE_LOCK_REASONS.PREMIUM_TO_FREE_OVER_PLAN_LIMIT,
      p_locked_policy_version: JOB_STORAGE_LOCK_POLICY_VERSION,
    });

    if (error) throw error;
    return normalizeRpcData(data);
  }

  /**
   * Call the final Premium restore RPC.
   *
   * @param {string} userId Owner auth user id.
   * @param {object} options RPC options.
   * @returns {Promise<object>} Normalized RPC response.
   */
  async function callPremiumRestoreRpc(userId, options = {}) {
    const {
      storageStatus = STORAGE_STATUSES.PREMIUM_ACTIVE,
      retainedLimit = ABSOLUTE_RETAINED_JOB_LIMIT,
    } = options;
    const { data, error } = await serviceClient.rpc('restore_locked_jobs_for_premium_user', {
      p_user_id: userId,
      p_storage_status: storageStatus,
      p_absolute_retained_job_limit: retainedLimit,
    });

    if (error) throw error;
    return normalizeRpcData(data);
  }

  /**
   * Call the final locked bulk-delete RPC.
   *
   * @param {string} userId Owner auth user id.
   * @param {object} options RPC options.
   * @returns {Promise<object>} Normalized RPC response.
   */
  async function callLockedBulkDeleteRpc(userId, options = {}) {
    const {
      storageStatus = STORAGE_STATUSES.TERMINAL_FREE,
      deleteLimit = LOCKED_BULK_DELETE_ROW_LIMIT,
    } = options;
    const { data, error } = await serviceClient.rpc('delete_locked_jobs_for_terminal_free_user', {
      p_user_id: userId,
      p_storage_status: storageStatus,
      p_locked_delete_limit: deleteLimit,
    });

    if (error) throw error;
    return normalizeRpcData(data);
  }

  beforeAll(async () => {
    ({ createClient } = await import('@supabase/supabase-js'));

    serviceClient = createClient(TEST_URL, TEST_SERVICE_KEY, {
      auth: { persistSession: false },
    });
    anonClient = createClient(TEST_URL, TEST_ANON_KEY, {
      auth: { persistSession: false },
    });

    await ensureFinalStorageMigrationsApplied();

    ({
      getJobsByUserId,
      getJobById,
      updateJob,
      deleteJob,
    } = await import('../../services/jobService.js'));
    ({ getJobsCsvExportForUser } = await import('../../services/jobExportService.js'));
  });

  afterAll(async () => {
    if (!serviceClient) return;

    const userIds = [...cleanupUserIds];

    if (userIds.length > 0) {
      const jobsResult = await serviceClient.from('jobs').delete().in('user_id', userIds);
      if (jobsResult.error) throw jobsResult.error;

      const subscriptionsResult = await serviceClient
        .from('billing_subscriptions')
        .delete()
        .in('user_id', userIds);
      if (subscriptionsResult.error) throw subscriptionsResult.error;

      const customersResult = await serviceClient
        .from('billing_customers')
        .delete()
        .in('user_id', userIds);
      if (customersResult.error) throw customersResult.error;
    }

    for (const userId of userIds) {
      const { error } = await serviceClient.auth.admin.deleteUser(userId);
      if (error) throw error;
    }
  });

  test('H1: final jobs storage migration fixtures exist', () => {
    for (const migrationFile of FINAL_STORAGE_MIGRATION_FILES) {
      expect(existsSync(join(MIGRATIONS_DIR, migrationFile))).toBe(true);
    }
  });

  test('H2: final atomic create RPC enforces active, retained, and stale-billing gates', async () => {
    const activeCapUser = await createTempUser('final-create-active');
    await seedJobs(activeCapUser.id, {
      activeRows: [{ company: 'Already Active Cap' }],
    });

    const activeCapResult = await callCreateJobRpc(activeCapUser.id, {
      storageStatus: STORAGE_STATUSES.TERMINAL_FREE,
      activeLimit: 1,
      retainedLimit: 5,
      company: 'Should Not Create Active',
    });

    expect(activeCapResult).toEqual(expect.objectContaining({
      created: false,
      code: STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED,
      reason: 'active_limit_exceeded',
      activeLimit: 1,
    }));
    await expect(getStorageCounts(activeCapUser.id)).resolves.toEqual({
      active_count: 1,
      locked_count: 0,
      retained_total_count: 1,
    });

    const retainedCapUser = await createTempUser('final-create-retained');
    await seedJobs(retainedCapUser.id, {
      lockedRows: [
        { company: 'Retained Locked 1' },
        { company: 'Retained Locked 2' },
        { company: 'Retained Locked 3' },
      ],
    });

    const retainedCapResult = await callCreateJobRpc(retainedCapUser.id, {
      storageStatus: STORAGE_STATUSES.TERMINAL_FREE,
      activeLimit: 2,
      retainedLimit: 3,
      company: 'Should Not Create Retained',
    });

    expect(retainedCapResult).toEqual(expect.objectContaining({
      created: false,
      code: STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED,
      reason: 'retained_limit_exceeded',
      absoluteRetainedLimit: 3,
    }));
    await expect(getStorageCounts(retainedCapUser.id)).resolves.toEqual({
      active_count: 0,
      locked_count: 3,
      retained_total_count: 3,
    });

    const staleBillingUser = await createTempUser('final-create-stale');
    await seedBillingSubscription(staleBillingUser.id, {
      status: 'canceled',
      current_period_end: '2000-01-01T00:00:00.000Z',
      cancel_at_period_end: false,
    });

    const staleBillingResult = await callCreateJobRpc(staleBillingUser.id, {
      storageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
      activeLimit: 2,
      retainedLimit: 5,
      company: 'Should Not Create Stale Billing',
    });

    expect(staleBillingResult).toEqual(expect.objectContaining({
      created: false,
      code: STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
      reason: 'billing_status_changed',
      storageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
      canonicalStorageStatus: STORAGE_STATUSES.TERMINAL_FREE,
    }));
    await expect(getStorageCounts(staleBillingUser.id)).resolves.toEqual({
      active_count: 0,
      locked_count: 0,
      retained_total_count: 0,
    });
  });

  test('H3: canonical SQL storage resolver covers every database-observable storage status', async () => {
    const cases = [
      {
        label: 'premium-active',
        expected: STORAGE_STATUSES.PREMIUM_ACTIVE,
        setup: async (userId) => seedBillingSubscription(userId),
      },
      {
        label: 'premium-canceling',
        expected: STORAGE_STATUSES.PREMIUM_CANCELING,
        setup: async (userId) => seedBillingSubscription(userId, {
          status: 'active',
          current_period_end: '2099-01-01T00:00:00.000Z',
          cancel_at_period_end: true,
        }),
      },
      {
        label: 'reconciliation-pending',
        expected: STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
        setup: async (userId) => seedBillingSubscription(userId, {
          status: 'active',
          current_period_end: '2000-01-01T00:00:00.000Z',
          cancel_at_period_end: true,
        }),
      },
      {
        label: 'terminal-free-no-billing',
        expected: STORAGE_STATUSES.TERMINAL_FREE,
        setup: async () => {},
      },
      {
        label: 'terminal-free-canceled',
        expected: STORAGE_STATUSES.TERMINAL_FREE,
        setup: async (userId) => seedBillingSubscription(userId, {
          status: 'canceled',
          current_period_end: '2000-01-01T00:00:00.000Z',
          cancel_at_period_end: false,
        }),
      },
      {
        label: 'payment-recovery-past-due',
        expected: STORAGE_STATUSES.PAYMENT_RECOVERY,
        setup: async (userId) => seedBillingSubscription(userId, {
          status: 'past_due',
          current_period_end: '2099-01-01T00:00:00.000Z',
          cancel_at_period_end: false,
        }),
      },
      {
        label: 'payment-recovery-unpaid',
        expected: STORAGE_STATUSES.PAYMENT_RECOVERY,
        setup: async (userId) => seedBillingSubscription(userId, {
          status: 'unpaid',
          current_period_end: '2099-01-01T00:00:00.000Z',
          cancel_at_period_end: false,
        }),
      },
      {
        label: 'sync-pending-customer-only',
        expected: STORAGE_STATUSES.SYNC_PENDING,
        setup: async (userId) => seedBillingCustomerOnly(userId),
      },
      {
        label: 'sync-pending-incomplete',
        expected: STORAGE_STATUSES.SYNC_PENDING,
        setup: async (userId) => seedBillingSubscription(userId, {
          status: 'incomplete',
          current_period_end: null,
          cancel_at_period_end: false,
        }),
      },
      {
        label: 'non-entitled-non-terminal',
        expected: STORAGE_STATUSES.NON_ENTITLED_NON_TERMINAL,
        setup: async (userId) => seedBillingSubscription(userId, {
          status: 'paused',
          current_period_end: '2099-01-01T00:00:00.000Z',
          cancel_at_period_end: false,
        }),
      },
    ];

    for (const testCase of cases) {
      const user = await createTempUser(`final-status-${testCase.label}`);
      await testCase.setup(user.id);
      await expect(resolveCanonicalStorageStatus(user.id)).resolves.toBe(testCase.expected);
    }
  });

  test('H4: ambiguous and non-entitled statuses do not mutate archive state through final RPCs', async () => {
    const nonMutatingStatuses = [
      STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
      STORAGE_STATUSES.PAYMENT_RECOVERY,
      STORAGE_STATUSES.SYNC_PENDING,
      STORAGE_STATUSES.NON_ENTITLED_NON_TERMINAL,
      STORAGE_STATUSES.BILLING_UNAVAILABLE,
    ];

    for (const storageStatus of nonMutatingStatuses) {
      const user = await createTempUser(`final-non-mutating-${storageStatus.replace(/_/g, '-')}`);
      await seedJobs(user.id, {
        activeRows: [
          { company: `${storageStatus} Active 1` },
          { company: `${storageStatus} Active 2` },
        ],
        lockedRows: [
          { company: `${storageStatus} Locked 1` },
          { company: `${storageStatus} Locked 2` },
        ],
      });

      const beforeCounts = await getStorageCounts(user.id);
      const lockResult = await callOverflowLockRpc(user.id, {
        storageStatus,
        activeLimit: 1,
      });
      const restoreResult = await callPremiumRestoreRpc(user.id, {
        storageStatus,
        retainedLimit: 10,
      });
      const deleteResult = await callLockedBulkDeleteRpc(user.id, {
        storageStatus,
        deleteLimit: 10,
      });

      expect(lockResult).toEqual(expect.objectContaining({
        applied: false,
        reason: 'storage_status_not_lock_eligible',
        lockedCount: 0,
      }));
      expect(restoreResult).toEqual(expect.objectContaining({
        applied: false,
        reason: 'storage_status_not_restore_eligible',
        restoredCount: 0,
      }));
      expect(deleteResult).toEqual(expect.objectContaining({
        applied: false,
        reason: 'storage_status_not_delete_eligible',
        deletedCount: 0,
      }));
      await expect(getStorageCounts(user.id)).resolves.toEqual(beforeCounts);
    }
  });

  test('H5: storage RPC execute privileges stay service-role only', async () => {
    const privilegeRows = await execSql(`
      SELECT
        has_function_privilege('authenticated', 'public.resolve_canonical_storage_status_for_user(uuid)', 'EXECUTE') AS authenticated_resolve,
        has_function_privilege('anon', 'public.resolve_canonical_storage_status_for_user(uuid)', 'EXECUTE') AS anon_resolve,
        has_function_privilege('service_role', 'public.resolve_canonical_storage_status_for_user(uuid)', 'EXECUTE') AS service_resolve,
        has_function_privilege('authenticated', 'public.create_job_with_storage_quota(uuid,jsonb,text,integer,integer)', 'EXECUTE') AS authenticated_create,
        has_function_privilege('anon', 'public.create_job_with_storage_quota(uuid,jsonb,text,integer,integer)', 'EXECUTE') AS anon_create,
        has_function_privilege('service_role', 'public.create_job_with_storage_quota(uuid,jsonb,text,integer,integer)', 'EXECUTE') AS service_create,
        has_function_privilege('authenticated', 'public.lock_overflow_jobs_for_terminal_free_user(uuid,text,integer,text,text)', 'EXECUTE') AS authenticated_lock,
        has_function_privilege('anon', 'public.lock_overflow_jobs_for_terminal_free_user(uuid,text,integer,text,text)', 'EXECUTE') AS anon_lock,
        has_function_privilege('service_role', 'public.lock_overflow_jobs_for_terminal_free_user(uuid,text,integer,text,text)', 'EXECUTE') AS service_lock,
        has_function_privilege('authenticated', 'public.restore_locked_jobs_for_premium_user(uuid,text,integer)', 'EXECUTE') AS authenticated_restore,
        has_function_privilege('anon', 'public.restore_locked_jobs_for_premium_user(uuid,text,integer)', 'EXECUTE') AS anon_restore,
        has_function_privilege('service_role', 'public.restore_locked_jobs_for_premium_user(uuid,text,integer)', 'EXECUTE') AS service_restore,
        has_function_privilege('authenticated', 'public.delete_locked_jobs_for_terminal_free_user(uuid,text,integer)', 'EXECUTE') AS authenticated_delete,
        has_function_privilege('anon', 'public.delete_locked_jobs_for_terminal_free_user(uuid,text,integer)', 'EXECUTE') AS anon_delete,
        has_function_privilege('service_role', 'public.delete_locked_jobs_for_terminal_free_user(uuid,text,integer)', 'EXECUTE') AS service_delete
    `);

    expect(privilegeRows[0]).toEqual({
      authenticated_resolve: false,
      anon_resolve: false,
      service_resolve: true,
      authenticated_create: false,
      anon_create: false,
      service_create: true,
      authenticated_lock: false,
      anon_lock: false,
      service_lock: true,
      authenticated_restore: false,
      anon_restore: false,
      service_restore: true,
      authenticated_delete: false,
      anon_delete: false,
      service_delete: true,
    });

    const user = await createTempUser('final-rpc-denial');
    const authenticatedClient = await signInAsUser(user.email);
    const directRpcCalls = [
      authenticatedClient.rpc('resolve_canonical_storage_status_for_user', { p_user_id: user.id }),
      authenticatedClient.rpc('create_job_with_storage_quota', {
        p_user_id: user.id,
        p_job_data: buildCreateJobPayload('Direct Create Denied'),
        p_storage_status: STORAGE_STATUSES.TERMINAL_FREE,
        p_active_job_limit: 1,
        p_absolute_retained_job_limit: 1,
      }),
      authenticatedClient.rpc('lock_overflow_jobs_for_terminal_free_user', {
        p_user_id: user.id,
        p_storage_status: STORAGE_STATUSES.TERMINAL_FREE,
        p_active_job_limit: 1,
        p_locked_reason: JOB_STORAGE_LOCK_REASONS.PREMIUM_TO_FREE_OVER_PLAN_LIMIT,
        p_locked_policy_version: JOB_STORAGE_LOCK_POLICY_VERSION,
      }),
      authenticatedClient.rpc('restore_locked_jobs_for_premium_user', {
        p_user_id: user.id,
        p_storage_status: STORAGE_STATUSES.PREMIUM_ACTIVE,
        p_absolute_retained_job_limit: 1,
      }),
      authenticatedClient.rpc('delete_locked_jobs_for_terminal_free_user', {
        p_user_id: user.id,
        p_storage_status: STORAGE_STATUSES.TERMINAL_FREE,
        p_locked_delete_limit: 1,
      }),
      anonClient.rpc('delete_locked_jobs_for_terminal_free_user', {
        p_user_id: user.id,
        p_storage_status: STORAGE_STATUSES.TERMINAL_FREE,
        p_locked_delete_limit: 1,
      }),
    ];
    const directResults = await Promise.all(directRpcCalls);

    for (const result of directResults) {
      expect(result.error).toBeTruthy();
      expect(isDirectRpcDeniedError(result.error)).toBe(true);
      expect(result.data ?? null).toBeNull();
    }
  });

  test('H6: real service projections protect locked rows while CSV export includes owned locked data', async () => {
    const owner = await createTempUser('final-service-owner');
    const otherOwner = await createTempUser('final-service-other');
    const [activeJob, lockedDetailJob, lockedDeleteJob, lockedExportJob] = await seedJobs(owner.id, {
      activeRows: [
        {
          company: 'Visible Active Corp',
          position: 'Visible Role',
          notes: 'Visible active notes',
        },
      ],
      lockedRows: [
        {
          company: 'Hidden Detail Corp',
          position: 'Hidden Detail Role',
          notes: 'Sensitive detail notes',
        },
        {
          company: 'Hidden Delete Corp',
          position: 'Hidden Delete Role',
          notes: 'Sensitive delete notes',
        },
        {
          company: 'Hidden Export Corp',
          position: 'Hidden Export Role',
          notes: 'Sensitive export notes',
        },
      ],
    });
    await seedJobs(otherOwner.id, {
      lockedRows: [
        {
          company: 'Other Owner Hidden Corp',
          position: 'Cross-user hidden role',
          notes: 'Cross-user hidden notes',
        },
      ],
    });

    const terminalFreeStatus = { status: STORAGE_STATUSES.TERMINAL_FREE };
    const testLog = buildTestLog();
    const lockedListResult = await getJobsByUserId(
      owner.id,
      { storage_state: JOB_STORAGE_QUERY_STATES.LOCKED },
      serviceClient,
      testLog,
      terminalFreeStatus
    );

    expect(lockedListResult.error).toBeNull();
    expect(lockedListResult.count).toBe(3);
    expect(lockedListResult.data).toHaveLength(3);

    for (const row of lockedListResult.data) {
      expect(row).toEqual(expect.objectContaining({
        id: expect.any(String),
        created_at: expect.any(String),
        locked_at: expect.any(String),
        locked_reason: JOB_STORAGE_LOCK_REASONS.PREMIUM_TO_FREE_OVER_PLAN_LIMIT,
        locked_policy_version: JOB_STORAGE_LOCK_POLICY_VERSION,
      }));
      expect(row.company).toBeUndefined();
      expect(row.position).toBeUndefined();
      expect(row.status).toBeUndefined();
      expect(row.notes).toBeUndefined();
      expect(row.salary_min).toBeUndefined();
      expect(row.salary_max).toBeUndefined();
    }

    const lockedDetailResult = await getJobById(
      lockedDetailJob.id,
      owner.id,
      serviceClient,
      testLog,
      terminalFreeStatus
    );
    expect(lockedDetailResult.data).toBeNull();
    expect(lockedDetailResult.error?.code).toBe('JOB_LOCKED_BY_PLAN');

    const lockedUpdateResult = await updateJob(
      lockedDetailJob.id,
      { status: 'interviewing', notes: 'Should not persist' },
      owner.id,
      serviceClient,
      testLog,
      terminalFreeStatus
    );
    expect(lockedUpdateResult.data).toBeNull();
    expect(lockedUpdateResult.error?.code).toBe('JOB_LOCKED_BY_PLAN');

    const deleteResult = await deleteJob(lockedDeleteJob.id, owner.id, serviceClient, testLog);
    expect(deleteResult.error).toBeNull();
    expect(deleteResult.data).toEqual({ id: lockedDeleteJob.id });
    expect(JSON.stringify(deleteResult.data)).not.toContain('Hidden Delete Corp');

    const exportResult = await getJobsCsvExportForUser(owner.id, testLog);
    expect(exportResult.error).toBeNull();
    expect(exportResult.data.rowCount).toBe(3);
    expect(exportResult.data.csv).toContain('Visible Active Corp');
    expect(exportResult.data.csv).toContain('Hidden Detail Corp');
    expect(exportResult.data.csv).toContain('Hidden Export Corp');
    expect(exportResult.data.csv).not.toContain('Hidden Delete Corp');
    expect(exportResult.data.csv).not.toContain('Other Owner Hidden Corp');

    const { data: activeAfter, error: activeAfterError } = await serviceClient
      .from('jobs')
      .select('id, company, storage_state')
      .eq('id', activeJob.id)
      .single();
    if (activeAfterError) throw activeAfterError;
    expect(activeAfter).toEqual(expect.objectContaining({
      company: 'Visible Active Corp',
      storage_state: JOB_STORAGE_STATES.ACTIVE,
    }));
  });

  test('H7: final lock and restore ordering use id DESC when status and timestamp tie', async () => {
    const lockUser = await createTempUser('final-lock-tie');
    const lockPair = buildOrderedUuidPair();
    const tiedTimestamp = '2026-01-01T00:00:00.000Z';
    await seedJobs(lockUser.id, {
      activeRows: [
        {
          id: lockPair.lowId,
          company: 'Lock Tie Low Id',
          status: 'applied',
          created_at: tiedTimestamp,
        },
        {
          id: lockPair.highId,
          company: 'Lock Tie High Id',
          status: 'applied',
          created_at: tiedTimestamp,
        },
      ],
    });

    const lockResult = await callOverflowLockRpc(lockUser.id, {
      storageStatus: STORAGE_STATUSES.TERMINAL_FREE,
      activeLimit: 1,
    });
    const { data: lockRows, error: lockRowsError } = await serviceClient
      .from('jobs')
      .select('id, company, storage_state')
      .eq('user_id', lockUser.id)
      .order('id', { ascending: true });

    if (lockRowsError) throw lockRowsError;
    expect(lockResult.lockedCount).toBe(1);
    expect(lockRows).toEqual([
      expect.objectContaining({
        id: lockPair.lowId,
        company: 'Lock Tie Low Id',
        storage_state: JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT,
      }),
      expect.objectContaining({
        id: lockPair.highId,
        company: 'Lock Tie High Id',
        storage_state: JOB_STORAGE_STATES.ACTIVE,
      }),
    ]);

    const restoreUser = await createTempUser('final-restore-tie');
    await seedBillingSubscription(restoreUser.id);
    const restorePair = buildOrderedUuidPair();
    await seedJobs(restoreUser.id, {
      activeRows: [
        { company: 'Restore Tie Active Baseline' },
      ],
      lockedRows: [
        {
          id: restorePair.lowId,
          company: 'Restore Tie Low Id',
          status: 'applied',
          created_at: tiedTimestamp,
        },
        {
          id: restorePair.highId,
          company: 'Restore Tie High Id',
          status: 'applied',
          created_at: tiedTimestamp,
        },
      ],
    });

    const restoreResult = await callPremiumRestoreRpc(restoreUser.id, {
      storageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
      retainedLimit: 2,
    });
    const { data: restoreRows, error: restoreRowsError } = await serviceClient
      .from('jobs')
      .select('id, company, storage_state')
      .eq('user_id', restoreUser.id)
      .in('id', [restorePair.lowId, restorePair.highId])
      .order('id', { ascending: true });

    if (restoreRowsError) throw restoreRowsError;
    expect(restoreResult.restoredCount).toBe(1);
    expect(restoreRows).toEqual([
      expect.objectContaining({
        id: restorePair.lowId,
        company: 'Restore Tie Low Id',
        storage_state: JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT,
      }),
      expect.objectContaining({
        id: restorePair.highId,
        company: 'Restore Tie High Id',
        storage_state: JOB_STORAGE_STATES.ACTIVE,
      }),
    ]);
  });
});
