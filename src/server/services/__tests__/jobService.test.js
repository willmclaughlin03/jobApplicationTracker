/**
 * Tests for jobService - database operations for jobs
 *
 * Purpose: Verify correct behaviour of all jobService functions including
 * ownership enforcement, storage limit, and server-owned job access.
 *
 * Connects to: server/services/jobService.js
 *
 * Architecture note after the storage-state boundary:
 * - supabaseAdmin (mockFrom) is used for all job table reads/writes, with
 *   explicit user_id filters on owner-scoped operations.
 * - The injected supabaseClient (mockClientFrom) remains accepted for route
 *   compatibility but must not be used for job rows.
 *
 * Test coverage:
 * createJob:
 * - Allows insert when under limit (0, 299 entries)
 * - Blocks insert at limit (300 entries) with STORAGE_LIMIT_EXCEEDED
 * - Blocks insert over limit (301 entries)
 * - Returns generic error if count query fails
 * - Treats null count as 0, allows insert
 * - Returns insert error when DB insert fails after limit check passes (edge case 1)
 * - Strips server-controlled fields before admin inserts
 * - Enforces limit dynamically from tier config, not a hardcoded value (edge case 2)
 * - Fails closed when maxJobs is undefined or null (edge case 3)
 * - Catches unexpected throw from getStorageLimitForTier (edge case 4)
 * - supabaseAdmin queries keep owner filters after direct table access is narrowed
 *
 * getJobsByUserId:
 * - Returns jobs for valid user via injected client
 * - Returns error on DB failure
 *
 * getJobById:
 * - Returns job for valid user+id via injected client
 * - Returns not-found error for PGRST116
 * - Returns error on other DB failures
 *
 * updateJob:
 * - Returns updated job via injected client
 * - Returns not-found error when no rows affected
 *
 * deleteJob:
 * - Returns deleted job via injected client
 * - Returns not-found error when no rows affected
 *
 * Owner-filter behaviour:
 * - Missing owner-scoped rows return empty data or generic not-found responses
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFrom = jest.fn(); // supabaseAdmin - server-owned jobs boundary

jest.mock('../../lib/supabaseServer.js', () => ({
  supabaseAdmin: {
    from: mockFrom,
  },
}));

jest.mock('../../../shared/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../shared/constants/tiers.js', () => ({
  getStorageLimitForTier: jest.fn().mockReturnValue({ maxJobs: 300 }),
  TIERS: { FREE: 'free', PAID: 'paid' },
}));

const {
  createJob,
  getJobsByUserId,
  getJobById,
  updateJob,
  deleteJob,
  StorageLimitExceededError,
} = require('../jobService.js');

const { getStorageLimitForTier: mockGetStorageLimitForTier } = require('../../../shared/constants/tiers.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockClientFrom = jest.fn();

/** Per-request SSR client mock, retained for route-compatible signatures. */
const mockSupabaseClient = { from: mockClientFrom };

/**
 * Creates a Proxy-based fake that mirrors Supabase's fluent query API.
 *
 * Every chained method (select, eq, order, range, insert, update, delete, …)
 * returns the same proxy so calls can be chained in any order. Terminal
 * methods (single, await/then) resolve with `resolvedValue`.
 *
 * All calls are recorded in `chain._calls` so tests can assert which
 * methods were invoked and with what arguments, catching query-building
 * bugs that the old hand-wired chain mocks silently ignored.
 *
 * @param {Object} resolvedValue - The value the query resolves to (e.g. { data, error })
 * @returns {Proxy} A chainable, thenable fake with a `_calls` property
 */
function fakeQuery(resolvedValue) {
  const _calls = {};

  const chain = new Proxy({}, {
    get(_, prop) {
      // Expose recorded calls for assertions
      if (prop === '_calls') return _calls;

      // Make the chain thenable — triggered by `await query`
      if (prop === 'then') {
        return (resolve, reject) =>
          Promise.resolve(resolvedValue).then(resolve, reject);
      }

      // Every other property returns a function that records the call
      return (...args) => {
        _calls[prop] = _calls[prop] || [];
        _calls[prop].push(args);

        // .single() is a terminal — returns a plain Promise, not the chain
        if (prop === 'single') {
          return Promise.resolve(resolvedValue);
        }

        return chain;
      };
    },
  });

  return chain;
}

const validJobData = { company: 'Acme', position: 'Engineer', status: 'applied' };
const userId = 'user-123';
const jobId = 'job-abc';
const mockCreatedJob = { id: jobId, ...validJobData, user_id: userId };

// ---------------------------------------------------------------------------
// createJob — storage limit enforcement
// ---------------------------------------------------------------------------

describe('createJob - storage limit enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetStorageLimitForTier.mockReturnValue({ maxJobs: 300 });
  });

  describe('when user is under the limit', () => {
    it('allows insert when user has 0 existing entries', async () => {
      const countQ = fakeQuery({ count: 0, error: null });
      const insertQ = fakeQuery({ data: [mockCreatedJob], error: null });
      mockFrom.mockReturnValueOnce(countQ);
      mockFrom.mockReturnValueOnce(insertQ);

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.error).toBeNull();
      expect(result.data).toEqual([mockCreatedJob]);
      expect(mockGetStorageLimitForTier).toHaveBeenCalledWith('free');
      expect(mockFrom).toHaveBeenCalledTimes(2);
      expect(mockClientFrom).not.toHaveBeenCalled();

      // Verify the count query was built correctly
      expect(countQ._calls.select).toEqual([['*', { count: 'exact', head: true }]]);
      expect(countQ._calls.eq).toEqual([['user_id', userId]]);

      // Verify the insert passed correct data
      expect(insertQ._calls.insert).toEqual([[{ ...validJobData, user_id: userId }]]);
      expect(insertQ._calls.select).toHaveLength(1);
    });

    it('allows insert when user has 299 existing entries', async () => {
      mockFrom.mockReturnValueOnce(fakeQuery({ count: 299, error: null }));
      mockFrom.mockReturnValueOnce(fakeQuery({ data: [mockCreatedJob], error: null }));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.error).toBeNull();
      expect(result.data).toEqual([mockCreatedJob]);
      expect(mockGetStorageLimitForTier).toHaveBeenCalledWith('free');
      expect(mockFrom).toHaveBeenCalledTimes(2);
      expect(mockClientFrom).not.toHaveBeenCalled();
    });
  });

  describe('when user is at or over the limit', () => {
    it('blocks insert and returns STORAGE_LIMIT_EXCEEDED error at exactly 300 entries', async () => {
      mockFrom.mockReturnValueOnce(fakeQuery({ count: 300, error: null }));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.data).toBeNull();
      expect(result.error).toBeInstanceOf(StorageLimitExceededError);
      expect(result.error.name).toBe('StorageLimitExceededError');
      expect(result.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(result.error.statusCode).toBe(409);
      expect(result.error.message).toContain('300');
      expect(mockFrom).toHaveBeenCalledTimes(1);
      expect(mockClientFrom).not.toHaveBeenCalled(); // insert must NOT run
    });

    it('blocks insert when user has 301 entries', async () => {
      mockFrom.mockReturnValueOnce(fakeQuery({ count: 301, error: null }));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.data).toBeNull();
      expect(result.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(mockClientFrom).not.toHaveBeenCalled();
    });
  });

  describe('when the count query fails', () => {
    it('returns the count error without attempting an insert', async () => {
      const dbError = new Error('Connection timeout');
      mockFrom.mockReturnValueOnce(fakeQuery({ count: null, error: dbError }));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.data).toBeNull();
      expect(result.error).toBe(dbError);
      expect(mockClientFrom).not.toHaveBeenCalled();
    });
  });

  describe('when the count is null (no rows in DB)', () => {
    it('treats null count as 0 and allows insert', async () => {
      mockFrom.mockReturnValueOnce(fakeQuery({ count: null, error: null }));
      mockFrom.mockReturnValueOnce(fakeQuery({ data: [mockCreatedJob], error: null }));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.error).toBeNull();
      expect(result.data).toEqual([mockCreatedJob]);
    });
  });

  describe('when the insert query fails after passing the limit check', () => {
    it('returns the insert error and does not return data', async () => {
      const insertError = new Error('DB constraint violation');
      mockFrom.mockReturnValueOnce(fakeQuery({ count: 0, error: null }));
      mockFrom.mockReturnValueOnce(fakeQuery({ data: null, error: insertError }));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.data).toBeNull();
      expect(result.error).toBe(insertError);
    });
  });

  describe('server-controlled field sanitization', () => {
    it('strips server-controlled fields before inserting through the admin client', async () => {
      const countQ = fakeQuery({ count: 0, error: null });
      const insertQ = fakeQuery({ data: [mockCreatedJob], error: null });
      mockFrom.mockReturnValueOnce(countQ);
      mockFrom.mockReturnValueOnce(insertQ);

      const result = await createJob(
        {
          ...validJobData,
          id: 'attacker-job',
          user_id: 'attacker-user',
          storage_state: 'locked_over_plan_limit',
          locked_at: '2026-06-08T00:00:00.000Z',
          locked_reason: 'premium_to_free_over_plan_limit',
          locked_policy_version: 'v1',
        },
        userId,
        mockSupabaseClient
      );

      expect(result.error).toBeNull();
      expect(insertQ._calls.insert).toEqual([[{ ...validJobData, user_id: userId }]]);
      expect(mockClientFrom).not.toHaveBeenCalled();
    });
  });

  describe('when the tier config supplies a non-default maxJobs', () => {
    it('blocks insert at the custom limit rather than the default 300', async () => {
      mockGetStorageLimitForTier.mockReturnValueOnce({ maxJobs: 5 });
      mockFrom.mockReturnValueOnce(fakeQuery({ count: 5, error: null }));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.data).toBeNull();
      expect(result.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(result.error.message).toContain('5');
      expect(mockClientFrom).not.toHaveBeenCalled();
    });

    it('allows insert when count is below the custom limit', async () => {
      mockGetStorageLimitForTier.mockReturnValueOnce({ maxJobs: 5 });
      mockFrom.mockReturnValueOnce(fakeQuery({ count: 4, error: null }));
      mockFrom.mockReturnValueOnce(fakeQuery({ data: [mockCreatedJob], error: null }));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.error).toBeNull();
      expect(result.data).toEqual([mockCreatedJob]);
    });

    it('uses the provided paid tier when resolving the storage limit', async () => {
      mockGetStorageLimitForTier.mockReturnValueOnce({ maxJobs: 3000 });
      mockFrom.mockReturnValueOnce(fakeQuery({ count: 2999, error: null }));
      mockFrom.mockReturnValueOnce(fakeQuery({ data: [mockCreatedJob], error: null }));

      const result = await createJob(validJobData, userId, mockSupabaseClient, undefined, 'paid');

      expect(result.error).toBeNull();
      expect(result.data).toEqual([mockCreatedJob]);
      expect(mockGetStorageLimitForTier).toHaveBeenCalledWith('paid');
    });

    it('includes the premium storage limit in the error message when paid users hit the cap', async () => {
      mockGetStorageLimitForTier.mockReturnValueOnce({ maxJobs: 3000 });
      mockFrom.mockReturnValueOnce(fakeQuery({ count: 3000, error: null }));

      const result = await createJob(validJobData, userId, mockSupabaseClient, undefined, 'paid');

      expect(result.data).toBeNull();
      expect(result.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(result.error.message).toContain('3000');
      expect(mockClientFrom).not.toHaveBeenCalled();
    });
  });

  describe('when the tier config returns an invalid maxJobs (fail-closed)', () => {
    it('returns a config error and does not run the count or insert query when maxJobs is undefined', async () => {
      mockGetStorageLimitForTier.mockReturnValueOnce({ maxJobs: undefined });

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.data).toBeNull();
      expect(result.error).not.toBeNull();
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockClientFrom).not.toHaveBeenCalled();
    });

    it('returns a config error and does not run the count or insert query when maxJobs is null', async () => {
      mockGetStorageLimitForTier.mockReturnValueOnce({ maxJobs: null });

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.data).toBeNull();
      expect(result.error).not.toBeNull();
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockClientFrom).not.toHaveBeenCalled();
    });
  });

  describe('when getStorageLimitForTier throws unexpectedly', () => {
    it('catches the exception and returns an error without calling the database', async () => {
      mockGetStorageLimitForTier.mockImplementationOnce(() => {
        throw new Error('Config module failure');
      });

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.data).toBeNull();
      expect(result.error.message).toBe('Config module failure');
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockClientFrom).not.toHaveBeenCalled();
    });
  });

  describe('storage boundary - supabaseAdmin owns job writes', () => {
    it('count and insert both use supabaseAdmin so direct table grants can be narrowed', async () => {
      const countQ = fakeQuery({ count: 0, error: null });
      const insertQ = fakeQuery({ data: [mockCreatedJob], error: null });
      mockFrom.mockReturnValueOnce(countQ);
      mockFrom.mockReturnValueOnce(insertQ);

      await createJob(validJobData, userId, mockSupabaseClient);

      expect(mockFrom).toHaveBeenCalledTimes(2);
      expect(mockFrom).toHaveBeenNthCalledWith(1, 'jobs');
      expect(mockFrom).toHaveBeenNthCalledWith(2, 'jobs');
      expect(mockClientFrom).not.toHaveBeenCalled();

      // Verify count query uses head: true (count-only, no row data)
      expect(countQ._calls.select).toEqual([['*', { count: 'exact', head: true }]]);
      expect(insertQ._calls.insert).toEqual([[{ ...validJobData, user_id: userId }]]);
    });
  });
});

// ---------------------------------------------------------------------------
// updateJob — empty update payload
// ---------------------------------------------------------------------------

describe('updateJob - empty update payload', () => {
  beforeEach(() => jest.clearAllMocks());

  /**
   * Test: updateJob with an empty object {} sends an empty update to Supabase
   * Verifies: Does not crash, returns whatever Supabase returns
   */
  it('sends empty update to Supabase without crashing', async () => {
    const query = fakeQuery({ data: [mockCreatedJob], error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await updateJob(jobId, {}, userId, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([mockCreatedJob]);
    expect(mockClientFrom).not.toHaveBeenCalled();

    // Verify an empty object was passed to .update()
    expect(query._calls.update).toEqual([[{}]]);
    expect(query._calls.eq).toEqual([['id', jobId], ['user_id', userId]]);
  });

  /**
   * Test: Empty update returning no rows still produces not-found error
   */
  it('returns not-found when empty update matches no rows', async () => {
    mockFrom.mockReturnValueOnce(fakeQuery({ data: [], error: null }));

    const result = await updateJob(jobId, {}, userId, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error.message).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// getJobsByUserId
// ---------------------------------------------------------------------------

describe('getJobsByUserId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns jobs for a valid user', async () => {
    const jobs = [mockCreatedJob];
    const query = fakeQuery({ data: jobs, count: 1, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getJobsByUserId(userId, {}, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual(jobs);
    expect(mockFrom).toHaveBeenCalledWith('jobs');
    expect(mockClientFrom).not.toHaveBeenCalled();

    // Verify query was built correctly
    expect(query._calls.select).toEqual([['*', { count: 'exact' }]]);
    expect(query._calls.eq).toEqual([['user_id', userId]]);
    expect(query._calls.order).toEqual([['created_at', { ascending: false }]]);
  });

  it('returns error on DB failure', async () => {
    const dbError = new Error('DB down');
    mockFrom.mockReturnValueOnce(fakeQuery({ data: null, count: 0, error: dbError }));

    const result = await getJobsByUserId(userId, {}, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error).toBe(dbError);
  });

  it('applies status filter when provided', async () => {
    const query = fakeQuery({ data: [], count: 0, error: null });
    mockFrom.mockReturnValueOnce(query);

    await getJobsByUserId(userId, { status: 'applied' }, mockSupabaseClient);

    // Should have two .eq() calls: user_id and status
    expect(query._calls.eq).toEqual([
      ['user_id', userId],
      ['status', 'applied'],
    ]);
  });

  it('applies pagination range when from/to are provided', async () => {
    const query = fakeQuery({ data: [], count: 0, error: null });
    mockFrom.mockReturnValueOnce(query);

    await getJobsByUserId(userId, { from: 0, to: 9 }, mockSupabaseClient);

    expect(query._calls.range).toEqual([[0, 9]]);
  });
});

// ---------------------------------------------------------------------------
// getJobById
// ---------------------------------------------------------------------------

describe('getJobById', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the job for a valid user+id', async () => {
    const query = fakeQuery({ data: mockCreatedJob, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getJobById(jobId, userId, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual(mockCreatedJob);
    expect(mockFrom).toHaveBeenCalledWith('jobs');
    expect(mockClientFrom).not.toHaveBeenCalled();

    // Verify the query filters by both id and user_id, then calls .single()
    expect(query._calls.select).toEqual([['*']]);
    expect(query._calls.eq).toEqual([['id', jobId], ['user_id', userId]]);
    expect(query._calls.single).toHaveLength(1);
  });

  it('returns not-found error for PGRST116 (no rows)', async () => {
    mockFrom.mockReturnValueOnce(
      fakeQuery({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    );

    const result = await getJobById(jobId, userId, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error.message).toMatch(/not found/i);
  });

  it('returns error on other DB failures', async () => {
    const dbError = { code: 'PGRST500', message: 'internal error' };
    mockFrom.mockReturnValueOnce(fakeQuery({ data: null, error: dbError }));

    const result = await getJobById(jobId, userId, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error).toBe(dbError);
  });
});

// ---------------------------------------------------------------------------
// updateJob
// ---------------------------------------------------------------------------

describe('updateJob', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns updated job on success', async () => {
    const updated = { ...mockCreatedJob, status: 'interviewing' };
    const query = fakeQuery({ data: [updated], error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await updateJob(jobId, { status: 'interviewing' }, userId, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([updated]);
    expect(mockFrom).toHaveBeenCalledWith('jobs');
    expect(mockClientFrom).not.toHaveBeenCalled();

    // Verify correct update payload and ownership filters
    expect(query._calls.update).toEqual([[{ status: 'interviewing' }]]);
    expect(query._calls.eq).toEqual([['id', jobId], ['user_id', userId]]);
    expect(query._calls.select).toEqual([['*']]);
  });

  it('returns not-found error when no rows were affected', async () => {
    mockFrom.mockReturnValueOnce(fakeQuery({ data: [], error: null }));

    const result = await updateJob(jobId, { status: 'interviewing' }, userId, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error.message).toMatch(/not found/i);
  });

  it('strips server-controlled fields before updating through the admin client', async () => {
    const query = fakeQuery({ data: [{ ...mockCreatedJob, status: 'interviewing' }], error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await updateJob(
      jobId,
      {
        status: 'interviewing',
        user_id: 'attacker-user',
        storage_state: 'active',
        locked_at: null,
        locked_reason: null,
        locked_policy_version: null,
      },
      userId,
      mockSupabaseClient
    );

    expect(result.error).toBeNull();
    expect(query._calls.update).toEqual([[{ status: 'interviewing' }]]);
    expect(query._calls.eq).toEqual([['id', jobId], ['user_id', userId]]);
  });
});

// ---------------------------------------------------------------------------
// deleteJob
// ---------------------------------------------------------------------------

describe('deleteJob', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns deleted job on success', async () => {
    const query = fakeQuery({ data: [mockCreatedJob], error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await deleteJob(jobId, userId, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual(mockCreatedJob);
    expect(mockFrom).toHaveBeenCalledWith('jobs');
    expect(mockClientFrom).not.toHaveBeenCalled();

    // Verify delete filters by both id and user_id
    expect(query._calls.delete).toHaveLength(1);
    expect(query._calls.eq).toEqual([['id', jobId], ['user_id', userId]]);
    expect(query._calls.select).toHaveLength(1);
  });

  it('returns not-found error when no rows were affected', async () => {
    mockFrom.mockReturnValueOnce(fakeQuery({ data: [], error: null }));

    const result = await deleteJob(jobId, userId, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error.message).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Owner filter behaviour - no matching rows
// ---------------------------------------------------------------------------

describe('owner filter behaviour - no matching rows', () => {
  beforeEach(() => jest.clearAllMocks());

  it('getJobsByUserId returns empty data when the owner filter matches no rows', async () => {
    mockFrom.mockReturnValueOnce(fakeQuery({ data: [], count: 0, error: null }));

    const result = await getJobsByUserId(userId, {}, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('getJobById returns not-found error (PGRST116) when the owner filter matches no row', async () => {
    mockFrom.mockReturnValueOnce(
      fakeQuery({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    );

    const result = await getJobById(jobId, userId, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error.message).toMatch(/not found/i);
  });
});
