/**
 * Suite K - Complete jobs list pagination integration tests.
 *
 * Purpose: prove service-role dashboard reads assemble the full 1000-row
 * product limit through bounded keyset pages and fail closed for a 1001st row,
 * while CSV export preserves over-limit data portability.
 */

import { STORAGE_STATUSES } from '../../../shared/constants/billing.js';
import {
  ABSOLUTE_RETAINED_JOB_LIMIT,
  JOB_STORAGE_STATES,
} from '../../../shared/constants/storage.js';

const {
  TEST_SUPABASE_ENV_NAMES,
  resolveDescribeOrSkip,
} = require('../../../testSupport/integrationEnvironment.js');

const TEST_URL = process.env[TEST_SUPABASE_ENV_NAMES.url];
const TEST_SERVICE_KEY = process.env[TEST_SUPABASE_ENV_NAMES.serviceKey];
const { describeOrSkip } = resolveDescribeOrSkip(process.env, {
  suiteName: 'Suite K',
  requiredNames: [
    TEST_SUPABASE_ENV_NAMES.url,
    TEST_SUPABASE_ENV_NAMES.serviceKey,
  ],
}, describe);

jest.setTimeout(120_000);

describeOrSkip('Suite K - Complete jobs list pagination', () => {
  let createClient;
  let getJobsByUserId;
  let getJobsCsvExportForUser;
  let serviceClient;
  const cleanupUserIds = new Set();
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  /**
   * Creates one isolated confirmed auth user for owner-scoped list evidence.
   *
   * Uses `unique` to build a collision-resistant `email`, then requires the
   * returned `userId`. Side effect: registers that id in `cleanupUserIds` so
   * `afterAll` removes the user's job rows and auth account.
   *
   * @returns {Promise<{id: string, email: string}>} Created user identity.
   */
  async function createTempUser() {
    const unique = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const email = 'complete-list-' + unique + '@example.test';
    const { data, error } = await serviceClient.auth.admin.createUser({
      email,
      password: 'Test-' + Date.now() + '!',
      email_confirm: true,
    });

    if (error) throw error;

    const userId = data?.user?.id;
    if (!userId) {
      throw new Error('Complete-list createUser returned no id');
    }

    cleanupUserIds.add(userId);
    return { id: userId, email };
  }

  /**
   * Inserts deterministic active jobs in bounded service-role batches.
   *
   * Purpose: exercise real PostgREST list paging without invoking the
   * application create quota for every fixture row.
   *
   * @param {string} userId - Temporary owner id.
   * @param {number} count - Number of jobs to insert.
   * @param {number} offset - Global ordering offset.
   * @returns {Promise<void>}
   */
  async function seedJobs(userId, count, offset = 0) {
    const batchSize = 100;

    for (let start = 0; start < count; start += batchSize) {
      const batchCount = Math.min(batchSize, count - start);
      const rows = Array.from({ length: batchCount }, (_, index) => {
        const rowNumber = offset + start + index + 1;
        const createdAt = new Date(
          Date.UTC(2026, 6, 11) - rowNumber * 1000
        ).toISOString();

        return {
          user_id: userId,
          company: 'Complete List ' + rowNumber,
          position: 'Pagination Engineer',
          status: 'applied',
          notes: '',
          salary_min: null,
          salary_max: null,
          status_date: createdAt,
          created_at: createdAt,
          storage_state: JOB_STORAGE_STATES.ACTIVE,
        };
      });
      const { error } = await serviceClient.from('jobs').insert(rows);

      if (error) throw error;
    }
  }

  /**
   * Loads the services under test and creates the non-persistent admin client.
   *
   * Depends on the validated test URL and service key. This initializes shared
   * references only; it does not create auth users or database rows.
   */
  beforeAll(async () => {
    ({ createClient } = await import('@supabase/supabase-js'));
    ({ getJobsByUserId } = await import('../../services/jobService.js'));
    ({ getJobsCsvExportForUser } = await import('../../services/jobExportService.js'));

    serviceClient = createClient(TEST_URL, TEST_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  });

  /**
   * Deletes every registered fixture owner's jobs, then its auth account.
   *
   * Depends on `serviceClient` and `cleanupUserIds`; it is a no-op when client
   * setup did not complete. Each cleanup attempt is isolated, and collected
   * database or auth errors are reported after all registered users are tried.
   */
  afterAll(async () => {
    if (!serviceClient) return;

    const cleanupErrors = [];

    for (const userId of cleanupUserIds) {
      try {
        const { error: jobsError } = await serviceClient
          .from('jobs')
          .delete()
          .eq('user_id', userId);
        if (jobsError) cleanupErrors.push(jobsError);
      } catch (error) {
        cleanupErrors.push(error);
      }

      try {
        const { error: userError } = await serviceClient.auth.admin.deleteUser(userId);
        if (userError) cleanupErrors.push(userError);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Suite K fixture cleanup failed');
    }
  });

  /**
   * Proves dashboard limit handling and over-limit CSV data portability.
   *
   * Creates a confirmed auth fixture and writes retained-limit plus overflow
   * job rows; `createTempUser` registers the owner for `afterAll` teardown.
   */
  test('K1: dashboard returns exactly 1000 rows, then fails closed while export retains row 1001', async () => {
    const user = await createTempUser();
    await seedJobs(user.id, ABSOLUTE_RETAINED_JOB_LIMIT);

    const listResult = await getJobsByUserId(
      user.id,
      {},
      undefined,
      log,
      { status: STORAGE_STATUSES.PREMIUM_ACTIVE }
    );

    expect(listResult.error).toBeNull();
    expect(listResult.data).toHaveLength(ABSOLUTE_RETAINED_JOB_LIMIT);
    expect(listResult.count).toBe(ABSOLUTE_RETAINED_JOB_LIMIT);
    expect(new Set(listResult.data.map((job) => job.id)).size).toBe(
      ABSOLUTE_RETAINED_JOB_LIMIT
    );

    await seedJobs(user.id, 1, ABSOLUTE_RETAINED_JOB_LIMIT);

    const overLimitResult = await getJobsByUserId(
      user.id,
      {},
      undefined,
      log,
      { status: STORAGE_STATUSES.PREMIUM_ACTIVE }
    );

    expect(overLimitResult.data).toBeNull();
    expect(overLimitResult.count).toBe(0);
    expect(overLimitResult.error).toMatchObject({
      code: 'JOB_LIST_RETAINED_LIMIT_INVARIANT',
      statusCode: 503,
    });

    const exportResult = await getJobsCsvExportForUser(user.id, log);
    const expectedExportCount = ABSOLUTE_RETAINED_JOB_LIMIT + 1;
    const expectedCompanies = Array.from(
      { length: expectedExportCount },
      (_, index) => 'Complete List ' + (index + 1)
    );

    expect(exportResult.error).toBeNull();
    expect(exportResult.data).toEqual(
      expect.objectContaining({ csv: expect.any(String) })
    );

    const exportedCompanies = exportResult.data.csv
      .split(String.fromCharCode(10))
      .slice(1, -1)
      .map((row) => row.split(',')[0].slice(1, -1));

    expect(exportResult.data.rowCount).toBe(expectedExportCount);
    expect(exportedCompanies).toHaveLength(expectedExportCount);
    expect(new Set(exportedCompanies).size).toBe(expectedExportCount);
    expect(new Set(exportedCompanies)).toEqual(new Set(expectedCompanies));
    expect(exportedCompanies).toContain('Complete List ' + expectedExportCount);
  });
});
