/**
 * Tests for jobService - database operations for jobs
 *
 * Purpose: Verify correct behaviour of all jobService functions including
 * ownership enforcement, storage limit, and RLS-compatible client injection.
 *
 * Connects to: server/services/jobService.js
 *
 * Architecture note after RLS refactor:
 * - supabaseAdmin (mockFrom) is only used inside createJob for the COUNT query
 *   (bypasses RLS — tamper-proof storage limit check)
 * - All other queries use the injected supabaseClient (mockClientFrom)
 *   (respects RLS — user-scoped)
 *
 * Test coverage:
 * createJob:
 * - Allows insert when under limit (0, 299 entries)
 * - Blocks insert at limit (300 entries) with STORAGE_LIMIT_EXCEEDED
 * - Blocks insert over limit (301 entries)
 * - Returns generic error if count query fails
 * - Treats null count as 0, allows insert
 * - Returns insert error when DB insert fails after limit check passes (edge case 1)
 * - Enforces limit dynamically from tier config, not a hardcoded value (edge case 2)
 * - Fails closed when maxJobs is undefined or null (edge case 3)
 * - Catches unexpected throw from getStorargeLimitForTier (edge case 4)
 * - supabaseAdmin count query works regardless of user session (bypasses RLS)
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
 * RLS behaviour:
 * - Unauthenticated/expired-session client returns empty data, not an info-leaking error
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFrom = jest.fn(); // supabaseAdmin — used only for createJob count

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
  getStorargeLimitForTier: jest.fn().mockReturnValue({ maxJobs: 300 }),
  TIERS: { FREE: 'free' },
}));

const {
  createJob,
  getJobsByUserId,
  getJobById,
  updateJob,
  deleteJob,
} = require('../jobService.js');

const { getStorargeLimitForTier: mockGetStorageLimitForTier } = require('../../../shared/constants/tiers.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockClientFrom = jest.fn();

/** Per-request SSR client mock (respects RLS in production) */
const mockSupabaseClient = { from: mockClientFrom };

/**
 * Builds mock chain for the count-only query (supabaseAdmin):
 *   supabaseAdmin.from('jobs').select('*', { count: 'exact', head: true }).eq('user_id', userId)
 */
function makeCountChain(count, error = null) {
  const eq = jest.fn().mockResolvedValue({ count, error });
  const select = jest.fn().mockReturnValue({ eq });
  return { select };
}

/**
 * Builds mock chain for insert (supabaseClient):
 *   supabaseClient.from('jobs').insert({...}).select()
 */
function makeInsertChain(data, error = null) {
  const select = jest.fn().mockResolvedValue({ data, error });
  const insert = jest.fn().mockReturnValue({ select });
  return { insert };
}

/**
 * Builds mock chain for a select-many query (supabaseClient):
 *   supabaseClient.from('jobs').select('*', { count: 'exact' }).eq(...)[.eq(...)].order(...)[.range(...)]
 */
function makeSelectManyChain(data, count = 0, error = null) {
  const resolvedValue = { data, count, error };
  // Thenable terminal — supports both direct await and .range()
  const terminal = {
    then: (resolve, reject) => Promise.resolve(resolvedValue).then(resolve, reject),
    range: jest.fn().mockResolvedValue(resolvedValue),
  };
  // .order() returns terminal
  const withOrder = { order: jest.fn().mockReturnValue(terminal) };
  // second optional .eq() (status filter) returns withOrder
  const withEqStatus = { eq: jest.fn().mockReturnValue(withOrder), ...withOrder };
  // first .eq() returns chain with optional second eq and order
  const eq = jest.fn().mockReturnValue(withEqStatus);
  const select = jest.fn().mockReturnValue({ eq });
  return { select };
}

/**
 * Builds mock chain for a select-single query (supabaseClient):
 *   supabaseClient.from('jobs').select('*').eq('id', ...).eq('user_id', ...).single()
 */
function makeSelectSingleChain(data, error = null) {
  const single = jest.fn().mockResolvedValue({ data, error });
  const eq2 = jest.fn().mockReturnValue({ single });
  const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
  const select = jest.fn().mockReturnValue({ eq: eq1 });
  return { select };
}

/**
 * Builds mock chain for update (supabaseClient):
 *   supabaseClient.from('jobs').update({...}).eq('id',...).eq('user_id',...).select('*')
 */
function makeUpdateChain(data, error = null) {
  const select = jest.fn().mockResolvedValue({ data, error });
  const eq2 = jest.fn().mockReturnValue({ select });
  const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
  const update = jest.fn().mockReturnValue({ eq: eq1 });
  return { update };
}

/**
 * Builds mock chain for delete (supabaseClient):
 *   supabaseClient.from('jobs').delete().eq('id',...).eq('user_id',...).select()
 */
function makeDeleteChain(data, error = null) {
  const select = jest.fn().mockResolvedValue({ data, error });
  const eq2 = jest.fn().mockReturnValue({ select });
  const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
  const del = jest.fn().mockReturnValue({ eq: eq1 });
  return { delete: del };
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
      mockFrom.mockReturnValueOnce(makeCountChain(0));
      mockClientFrom.mockReturnValueOnce(makeInsertChain([mockCreatedJob]));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.error).toBeNull();
      expect(result.data).toEqual([mockCreatedJob]);
      expect(mockFrom).toHaveBeenCalledTimes(1);   // supabaseAdmin count only
      expect(mockClientFrom).toHaveBeenCalledTimes(1); // client insert
    });

    it('allows insert when user has 299 existing entries', async () => {
      mockFrom.mockReturnValueOnce(makeCountChain(299));
      mockClientFrom.mockReturnValueOnce(makeInsertChain([mockCreatedJob]));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.error).toBeNull();
      expect(result.data).toEqual([mockCreatedJob]);
      expect(mockFrom).toHaveBeenCalledTimes(1);
      expect(mockClientFrom).toHaveBeenCalledTimes(1);
    });
  });

  describe('when user is at or over the limit', () => {
    it('blocks insert and returns STORAGE_LIMIT_EXCEEDED error at exactly 300 entries', async () => {
      mockFrom.mockReturnValueOnce(makeCountChain(300));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.data).toBeNull();
      expect(result.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(result.error.message).toContain('300');
      expect(mockFrom).toHaveBeenCalledTimes(1);
      expect(mockClientFrom).not.toHaveBeenCalled(); // insert must NOT run
    });

    it('blocks insert when user has 301 entries', async () => {
      mockFrom.mockReturnValueOnce(makeCountChain(301));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.data).toBeNull();
      expect(result.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(mockClientFrom).not.toHaveBeenCalled();
    });
  });

  describe('when the count query fails', () => {
    it('returns the count error without attempting an insert', async () => {
      const dbError = new Error('Connection timeout');
      mockFrom.mockReturnValueOnce(makeCountChain(null, dbError));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.data).toBeNull();
      expect(result.error).toBe(dbError);
      expect(mockClientFrom).not.toHaveBeenCalled();
    });
  });

  describe('when the count is null (no rows in DB)', () => {
    it('treats null count as 0 and allows insert', async () => {
      mockFrom.mockReturnValueOnce(makeCountChain(null));
      mockClientFrom.mockReturnValueOnce(makeInsertChain([mockCreatedJob]));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.error).toBeNull();
      expect(result.data).toEqual([mockCreatedJob]);
    });
  });

  describe('when the insert query fails after passing the limit check', () => {
    it('returns the insert error and does not return data', async () => {
      const insertError = new Error('DB constraint violation');
      mockFrom.mockReturnValueOnce(makeCountChain(0));
      mockClientFrom.mockReturnValueOnce(makeInsertChain(null, insertError));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.data).toBeNull();
      expect(result.error).toBe(insertError);
    });
  });

  describe('when the tier config supplies a non-default maxJobs', () => {
    it('blocks insert at the custom limit rather than the default 300', async () => {
      mockGetStorageLimitForTier.mockReturnValueOnce({ maxJobs: 5 });
      mockFrom.mockReturnValueOnce(makeCountChain(5));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.data).toBeNull();
      expect(result.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(mockClientFrom).not.toHaveBeenCalled();
    });

    it('allows insert when count is below the custom limit', async () => {
      mockGetStorageLimitForTier.mockReturnValueOnce({ maxJobs: 5 });
      mockFrom.mockReturnValueOnce(makeCountChain(4));
      mockClientFrom.mockReturnValueOnce(makeInsertChain([mockCreatedJob]));

      const result = await createJob(validJobData, userId, mockSupabaseClient);

      expect(result.error).toBeNull();
      expect(result.data).toEqual([mockCreatedJob]);
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

  describe('when getStorargeLimitForTier throws unexpectedly', () => {
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

  describe('RLS — supabaseAdmin count bypasses RLS', () => {
    it('count query uses supabaseAdmin (not the client) so RLS cannot suppress it', async () => {
      mockFrom.mockReturnValueOnce(makeCountChain(0));
      mockClientFrom.mockReturnValueOnce(makeInsertChain([mockCreatedJob]));

      await createJob(validJobData, userId, mockSupabaseClient);

      // supabaseAdmin.from() called for count; client.from() called for insert
      expect(mockFrom).toHaveBeenCalledWith('jobs');
      expect(mockClientFrom).toHaveBeenCalledWith('jobs');
    });
  });
});

// ---------------------------------------------------------------------------
// getJobsByUserId
// ---------------------------------------------------------------------------

describe('getJobsByUserId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns jobs for a valid user', async () => {
    const jobs = [mockCreatedJob];
    mockClientFrom.mockReturnValueOnce(makeSelectManyChain(jobs, 1));

    const result = await getJobsByUserId(userId, {}, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual(jobs);
    expect(mockClientFrom).toHaveBeenCalledWith('jobs');
    expect(mockFrom).not.toHaveBeenCalled(); // supabaseAdmin must not be used
  });

  it('returns error on DB failure', async () => {
    const dbError = new Error('DB down');
    mockClientFrom.mockReturnValueOnce(makeSelectManyChain(null, 0, dbError));

    const result = await getJobsByUserId(userId, {}, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error).toBe(dbError);
  });
});

// ---------------------------------------------------------------------------
// getJobById
// ---------------------------------------------------------------------------

describe('getJobById', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the job for a valid user+id', async () => {
    mockClientFrom.mockReturnValueOnce(makeSelectSingleChain(mockCreatedJob));

    const result = await getJobById(jobId, userId, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual(mockCreatedJob);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns not-found error for PGRST116 (no rows)', async () => {
    mockClientFrom.mockReturnValueOnce(makeSelectSingleChain(null, { code: 'PGRST116', message: 'no rows' }));

    const result = await getJobById(jobId, userId, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error.message).toMatch(/not found/i);
  });

  it('returns error on other DB failures', async () => {
    const dbError = { code: 'PGRST500', message: 'internal error' };
    mockClientFrom.mockReturnValueOnce(makeSelectSingleChain(null, dbError));

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
    mockClientFrom.mockReturnValueOnce(makeUpdateChain([updated]));

    const result = await updateJob(jobId, { status: 'interviewing' }, userId, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([updated]);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns not-found error when no rows were affected', async () => {
    mockClientFrom.mockReturnValueOnce(makeUpdateChain([]));

    const result = await updateJob(jobId, { status: 'interviewing' }, userId, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error.message).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// deleteJob
// ---------------------------------------------------------------------------

describe('deleteJob', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns deleted job on success', async () => {
    mockClientFrom.mockReturnValueOnce(makeDeleteChain([mockCreatedJob]));

    const result = await deleteJob(jobId, userId, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual(mockCreatedJob);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns not-found error when no rows were affected', async () => {
    mockClientFrom.mockReturnValueOnce(makeDeleteChain([]));

    const result = await deleteJob(jobId, userId, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error.message).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// RLS behaviour — unauthenticated/expired session
// ---------------------------------------------------------------------------

describe('RLS behaviour — unauthenticated or expired session client', () => {
  beforeEach(() => jest.clearAllMocks());

  it('getJobsByUserId returns empty data (not an error) when RLS filters all rows', async () => {
    // Simulates what Supabase returns when auth.uid() does not match any row:
    // an empty result set, not an error.
    mockClientFrom.mockReturnValueOnce(makeSelectManyChain([], 0, null));

    const result = await getJobsByUserId(userId, {}, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('getJobById returns not-found error (PGRST116) when RLS filters the row', async () => {
    // RLS blocks the row → Supabase returns PGRST116 (no rows found for .single())
    mockClientFrom.mockReturnValueOnce(
      makeSelectSingleChain(null, { code: 'PGRST116', message: 'no rows' })
    );

    const result = await getJobById(jobId, userId, mockSupabaseClient);

    expect(result.data).toBeNull();
    // Returns a generic not-found error — does not leak whether the row exists
    expect(result.error.message).toMatch(/not found/i);
  });
});
