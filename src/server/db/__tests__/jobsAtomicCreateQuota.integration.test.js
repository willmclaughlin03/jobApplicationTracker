/**
 * Suite D - Jobs atomic create quota integration tests
 *
 * Purpose: Verify Chunk 4's database RPC serializes concurrent job creation
 * and enforces both the Free active cap and absolute retained cap.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  ABSOLUTE_RETAINED_JOB_LIMIT,
  FREE_ACTIVE_JOB_LIMIT,
  JOB_STORAGE_STATES,
} from '../../../shared/constants/storage.js';
import {
  STORAGE_STATUSES,
} from '../../../shared/constants/billing.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const JOBS_STORAGE_MIGRATION_FILE = '016_jobs_storage_state_boundary.sql';
const JOBS_ATOMIC_CREATE_MIGRATION_FILE = '017_jobs_atomic_create_quota.sql';

const {
  TEST_SUPABASE_ENV_NAMES,
  resolveDescribeOrSkip,
} = require('../../../testSupport/integrationEnvironment.js');

const {
  runIntegrationCleanup,
} = require('../../../testSupport/integrationCleanup.js');
const TEST_URL = process.env[TEST_SUPABASE_ENV_NAMES.url];
const TEST_SERVICE_KEY = process.env[TEST_SUPABASE_ENV_NAMES.serviceKey];
const { describeOrSkip } = resolveDescribeOrSkip(process.env, {
  suiteName: 'Suite D',
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
 * Build an RPC job payload with unique visible fields.
 *
 * @param {string} label Test label included in the company name.
 * @returns {object} Job payload accepted by create_job_with_storage_quota().
 */
function buildJobPayload(label) {
  return {
    company: `Atomic ${label} ${Date.now()}`,
    position: 'Quota Engineer',
    status: 'applied',
    notes: '',
    salary_min: null,
    salary_max: null,
    status_date: new Date().toISOString(),
  };
}

jest.setTimeout(60_000);

describeOrSkip('Suite D - Jobs atomic create quota integration', () => {
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
          'Jobs atomic create integration tests require a service-role-only '
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
   * Apply prerequisite and Chunk 4 jobs migrations.
   *
   * @returns {Promise<void>}
   */
  async function ensureJobsAtomicCreateMigrationsApplied() {
    const tableRows = await execSql(`
      SELECT pg_catalog.to_regclass('public.jobs')::text AS jobs_table
    `);

    if (!tableRows[0]?.jobs_table) {
      throw new Error(
        'public.jobs is missing in the integration environment; '
        + 'apply or restore the base jobs schema before running Chunk 4 evidence.'
      );
    }

    for (const migrationFile of [JOBS_STORAGE_MIGRATION_FILE, JOBS_ATOMIC_CREATE_MIGRATION_FILE]) {
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
   * Seed generated active or locked jobs for one user.
   *
   * @param {string} userId Owner auth user id.
   * @param {{ activeCount?: number, lockedCount?: number }} counts Row counts to seed.
   * @returns {Promise<void>}
   */
  async function seedGeneratedJobs(userId, { activeCount = 0, lockedCount = 0 }) {
    if (activeCount > 0) {
      const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const activeRows = Array.from({ length: activeCount }, (_, index) => ({
        user_id: userId,
        company: `Atomic Active ${uniqueSuffix}-${index + 1}`,
        position: 'Quota Engineer',
        status: 'applied',
        notes: '',
        salary_min: null,
        salary_max: null,
        status_date: new Date().toISOString(),
        storage_state: JOB_STORAGE_STATES.ACTIVE,
      }));

      for (let index = 0; index < activeRows.length; index += JOBS_SEED_BATCH_SIZE) {
        const { error } = await serviceClient.from('jobs').insert(
          activeRows.slice(index, index + JOBS_SEED_BATCH_SIZE)
        );

        if (error) throw error;
      }
    }

    if (lockedCount > 0) {
      const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const lockedRows = Array.from({ length: lockedCount }, (_, index) => ({
        user_id: userId,
        company: `Atomic Locked ${uniqueSuffix}-${index + 1}`,
        position: 'Quota Engineer',
        status: 'applied',
        notes: '',
        salary_min: null,
        salary_max: null,
        status_date: new Date().toISOString(),
        storage_state: JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT,
        locked_at: new Date().toISOString(),
        locked_reason: 'premium_to_free_over_plan_limit',
        locked_policy_version: 'v1',
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
   * Call the atomic create RPC with the Chunk 4 named limits.
   *
   * @param {string} userId Owner auth user id.
   * @param {object} jobData Valid job payload.
   * @returns {Promise<object>} RPC response payload.
   */
  async function callCreateJobRpc(userId, jobData) {
    let lastError = null;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { data, error } = await serviceClient.rpc('create_job_with_storage_quota', {
        p_user_id: userId,
        p_job_data: jobData,
        p_storage_status: STORAGE_STATUSES.TERMINAL_FREE,
        p_active_job_limit: FREE_ACTIVE_JOB_LIMIT,
        p_absolute_retained_job_limit: ABSOLUTE_RETAINED_JOB_LIMIT,
      });

      if (!error) return data;

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

    await ensureJobsAtomicCreateMigrationsApplied();
  });

  afterAll(async () => {
    if (!serviceClient) return;

    const userIds = [...cleanupUserIds];
    await runIntegrationCleanup([
      ...(userIds.length > 0
        ? [{
            label: 'jobs rows',
            cleanup: () => serviceClient.from('jobs').delete().in('user_id', userIds),
          }]
        : []),
      ...userIds.map((userId) => ({
        label: 'temporary auth users',
        cleanup: () => serviceClient.auth.admin.deleteUser(userId),
      })),
    ]);
  });

  test('D1: atomic create quota migration file exists', () => {
    expect(existsSync(join(MIGRATIONS_DIR, JOBS_ATOMIC_CREATE_MIGRATION_FILE))).toBe(true);
  });

  test('D2: concurrent creates at 299 active jobs allow exactly one active insert', async () => {
    const user = await createTempUser('jobs-atomic-active');
    await seedGeneratedJobs(user.id, { activeCount: FREE_ACTIVE_JOB_LIMIT - 1 });

    const [firstResult, secondResult] = await Promise.all([
      callCreateJobRpc(user.id, buildJobPayload('Active Race A')),
      callCreateJobRpc(user.id, buildJobPayload('Active Race B')),
    ]);

    const results = [firstResult, secondResult];
    expect(results.filter((result) => result.created === true)).toHaveLength(1);
    expect(results.filter((result) => result.created === false)).toHaveLength(1);
    expect(results.find((result) => result.created === false)).toEqual(
      expect.objectContaining({
        code: 'STORAGE_LIMIT_EXCEEDED',
        reason: 'active_limit_exceeded',
      })
    );

    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: FREE_ACTIVE_JOB_LIMIT,
      locked_count: 0,
      retained_total_count: FREE_ACTIVE_JOB_LIMIT,
    });
  });

  test('D3: concurrent creates at 2999 retained jobs allow exactly one retained insert', async () => {
    const user = await createTempUser('jobs-atomic-retained');
    await seedGeneratedJobs(user.id, { lockedCount: ABSOLUTE_RETAINED_JOB_LIMIT - 1 });

    const [firstResult, secondResult] = await Promise.all([
      callCreateJobRpc(user.id, buildJobPayload('Retained Race A')),
      callCreateJobRpc(user.id, buildJobPayload('Retained Race B')),
    ]);

    const results = [firstResult, secondResult];
    expect(results.filter((result) => result.created === true)).toHaveLength(1);
    expect(results.filter((result) => result.created === false)).toHaveLength(1);
    expect(results.find((result) => result.created === false)).toEqual(
      expect.objectContaining({
        code: 'STORAGE_LIMIT_EXCEEDED',
        reason: 'retained_limit_exceeded',
      })
    );

    await expect(getStorageCounts(user.id)).resolves.toEqual({
      active_count: 1,
      locked_count: ABSOLUTE_RETAINED_JOB_LIMIT - 1,
      retained_total_count: ABSOLUTE_RETAINED_JOB_LIMIT,
    });
  });
});
