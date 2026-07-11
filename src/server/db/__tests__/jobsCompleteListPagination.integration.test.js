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

const TEST_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const TEST_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUN_DESTRUCTIVE_DB_INTEGRATION = process.env.RUN_DESTRUCTIVE_DB_INTEGRATION === 'true';
const SUPABASE_TEST_PROJECT_REF = process.env.SUPABASE_TEST_PROJECT_REF;
const EXPECTED_TEST_URL_PREFIX = SUPABASE_TEST_PROJECT_REF
  ? 'https://' + SUPABASE_TEST_PROJECT_REF + '.supabase.co'
  : '';

const isExpectedSupabaseTarget = Boolean(
  TEST_URL
  && EXPECTED_TEST_URL_PREFIX
  && (
    TEST_URL === EXPECTED_TEST_URL_PREFIX
    || TEST_URL.startsWith(EXPECTED_TEST_URL_PREFIX + '/')
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
    'Refusing to run Suite K: NEXT_PUBLIC_SUPABASE_URL must match SUPABASE_TEST_PROJECT_REF.'
  );
}

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

  beforeAll(async () => {
    ({ createClient } = await import('@supabase/supabase-js'));
    ({ getJobsByUserId } = await import('../../services/jobService.js'));
    ({ getJobsCsvExportForUser } = await import('../../services/jobExportService.js'));

    serviceClient = createClient(TEST_URL, TEST_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  });

  afterAll(async () => {
    if (!serviceClient) return;

    for (const userId of cleanupUserIds) {
      const { error: jobsError } = await serviceClient
        .from('jobs')
        .delete()
        .eq('user_id', userId);
      if (jobsError) throw jobsError;

      const { error: userError } = await serviceClient.auth.admin.deleteUser(userId);
      if (userError) throw userError;
    }
  });

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

    expect(exportResult.error).toBeNull();
    expect(exportResult.data.rowCount).toBe(ABSOLUTE_RETAINED_JOB_LIMIT + 1);
  });
});
