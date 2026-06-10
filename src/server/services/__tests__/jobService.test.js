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
 * - Creates through the atomic quota RPC for allowed storage statuses
 * - Blocks active and retained quota failures with STORAGE_LIMIT_EXCEEDED
 * - Blocks billing-unavailable, reconciliation, payment, and sync states
 * - Returns RPC errors without attempting fallback writes
 * - Strips server-controlled fields before admin inserts
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
const mockRpc = jest.fn();

jest.mock('../../lib/supabaseServer.js', () => ({
  supabaseAdmin: {
    from: mockFrom,
    rpc: mockRpc,
  },
}));

const mockClassifyStorageCreateFlow = jest.fn();
jest.mock('../../lib/billingService.js', () => ({
  classifyStorageCreateFlow: mockClassifyStorageCreateFlow,
}));

jest.mock('../../../shared/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  createJob,
  getJobsByUserId,
  getJobById,
  updateJob,
  deleteJob,
  StorageCreateBlockedError,
  StorageLimitExceededError,
} = require('../jobService.js');
const {
  STORAGE_CREATE_ACTIONS,
  STORAGE_CREATE_ERROR_CODES,
  STORAGE_STATUSES,
} = require('../../../shared/constants/billing.js');
const {
  ABSOLUTE_RETAINED_JOB_LIMIT,
  FREE_ACTIVE_JOB_LIMIT,
} = require('../../../shared/constants/storage.js');

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

describe('createJob - atomic storage quota enforcement', () => {
  /**
   * Build a typed storage-status result with a create-flow contract.
   *
   * @param {string} status Storage policy status.
   * @param {string} action Create-flow action.
   * @param {string|null} code Optional stable error code.
   * @returns {object} Storage status result consumed by createJob().
   */
  function buildStorageStatusResult(status, action, code = null) {
    return {
      status,
      createFlow: {
        action,
        code,
        retryable: false,
        mayUseFreeQuotaCopy: code === STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED,
      },
    };
  }

  /**
   * Build a successful atomic create RPC response.
   *
   * @param {object} job Created job row.
   * @returns {object} Supabase RPC response shape.
   */
  function rpcCreated(job = mockCreatedJob) {
    return {
      data: {
        created: true,
        job,
        activeCountBeforeCreate: 0,
        retainedTotalCountBeforeCreate: 0,
        activeLimit: FREE_ACTIVE_JOB_LIMIT,
        absoluteRetainedLimit: ABSOLUTE_RETAINED_JOB_LIMIT,
      },
      error: null,
    };
  }

  const terminalFreeStatus = buildStorageStatusResult(
    STORAGE_STATUSES.TERMINAL_FREE,
    STORAGE_CREATE_ACTIONS.APPLY_FREE_LIMIT,
    STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED
  );
  const premiumStatus = buildStorageStatusResult(
    STORAGE_STATUSES.PREMIUM_ACTIVE,
    STORAGE_CREATE_ACTIONS.APPLY_PREMIUM_LIMIT
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockClassifyStorageCreateFlow.mockReturnValue({
      action: STORAGE_CREATE_ACTIONS.BLOCK_RETRYABLE,
      code: STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
      retryable: true,
      mayUseFreeQuotaCopy: false,
    });
  });

  it('creates a job through the atomic quota RPC for confirmed terminal Free', async () => {
    mockRpc.mockResolvedValueOnce(rpcCreated());

    const result = await createJob(validJobData, userId, mockSupabaseClient, undefined, terminalFreeStatus);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([mockCreatedJob]);
    expect(mockRpc).toHaveBeenCalledWith('create_job_with_storage_quota', {
      p_user_id: userId,
      p_job_data: validJobData,
      p_storage_status: STORAGE_STATUSES.TERMINAL_FREE,
      p_active_job_limit: FREE_ACTIVE_JOB_LIMIT,
      p_absolute_retained_job_limit: ABSOLUTE_RETAINED_JOB_LIMIT,
    });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockClientFrom).not.toHaveBeenCalled();
  });

  it('uses the Premium storage status without falling back to a tier string', async () => {
    mockRpc.mockResolvedValueOnce(rpcCreated());

    const result = await createJob(validJobData, userId, mockSupabaseClient, undefined, premiumStatus);

    expect(result.error).toBeNull();
    expect(mockRpc).toHaveBeenCalledWith(
      'create_job_with_storage_quota',
      expect.objectContaining({
        p_storage_status: STORAGE_STATUSES.PREMIUM_ACTIVE,
        p_absolute_retained_job_limit: ABSOLUTE_RETAINED_JOB_LIMIT,
      })
    );
  });

  it('strips server-controlled fields before sending the RPC payload', async () => {
    mockRpc.mockResolvedValueOnce(rpcCreated());

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
      mockSupabaseClient,
      undefined,
      terminalFreeStatus
    );

    expect(result.error).toBeNull();
    expect(mockRpc).toHaveBeenCalledWith(
      'create_job_with_storage_quota',
      expect.objectContaining({
        p_job_data: validJobData,
      })
    );
  });

  it('returns STORAGE_LIMIT_EXCEEDED when the RPC blocks on the active cap', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        created: false,
        code: STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED,
        reason: 'active_limit_exceeded',
        activeCount: FREE_ACTIVE_JOB_LIMIT,
        retainedTotalCount: FREE_ACTIVE_JOB_LIMIT,
        activeLimit: FREE_ACTIVE_JOB_LIMIT,
        absoluteRetainedLimit: ABSOLUTE_RETAINED_JOB_LIMIT,
      },
      error: null,
    });

    const result = await createJob(validJobData, userId, mockSupabaseClient, undefined, terminalFreeStatus);

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StorageLimitExceededError);
    expect(result.error.code).toBe(STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED);
    expect(result.error.message).toContain(String(FREE_ACTIVE_JOB_LIMIT));
  });

  it('returns STORAGE_LIMIT_EXCEEDED when the RPC blocks on the retained cap', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        created: false,
        code: STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED,
        reason: 'retained_limit_exceeded',
        activeCount: 299,
        retainedTotalCount: ABSOLUTE_RETAINED_JOB_LIMIT,
        activeLimit: FREE_ACTIVE_JOB_LIMIT,
        absoluteRetainedLimit: ABSOLUTE_RETAINED_JOB_LIMIT,
      },
      error: null,
    });

    const result = await createJob(validJobData, userId, mockSupabaseClient, undefined, terminalFreeStatus);

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StorageLimitExceededError);
    expect(result.error.message).toContain(String(ABSOLUTE_RETAINED_JOB_LIMIT));
  });

  it.each([
    [
      STORAGE_STATUSES.BILLING_UNAVAILABLE,
      STORAGE_CREATE_ACTIONS.BLOCK_RETRYABLE,
      STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
    ],
    [
      STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
      STORAGE_CREATE_ACTIONS.BLOCK_RETRYABLE,
      STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING,
    ],
    [
      STORAGE_STATUSES.PAYMENT_RECOVERY,
      STORAGE_CREATE_ACTIONS.BLOCK_PAYMENT_RECOVERY,
      STORAGE_CREATE_ERROR_CODES.PAYMENT_METHOD_UPDATE_REQUIRED,
    ],
    [
      STORAGE_STATUSES.SYNC_PENDING,
      STORAGE_CREATE_ACTIONS.BLOCK_SYNC_PENDING,
      STORAGE_CREATE_ERROR_CODES.BILLING_SYNC_PENDING,
    ],
  ])('blocks %s before the jobs RPC', async (status, action, code) => {
    const result = await createJob(
      validJobData,
      userId,
      mockSupabaseClient,
      undefined,
      buildStorageStatusResult(status, action, code)
    );

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StorageCreateBlockedError);
    expect(result.error.code).toBe(code);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('falls back through classifyStorageCreateFlow when only a status string is supplied', async () => {
    mockClassifyStorageCreateFlow.mockReturnValueOnce({
      action: STORAGE_CREATE_ACTIONS.APPLY_FREE_LIMIT,
      code: STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED,
    });
    mockRpc.mockResolvedValueOnce(rpcCreated());

    const result = await createJob(validJobData, userId, mockSupabaseClient, undefined, STORAGE_STATUSES.TERMINAL_FREE);

    expect(result.error).toBeNull();
    expect(mockClassifyStorageCreateFlow).toHaveBeenCalledWith(STORAGE_STATUSES.TERMINAL_FREE);
    expect(mockRpc).toHaveBeenCalledWith(
      'create_job_with_storage_quota',
      expect.objectContaining({
        p_storage_status: STORAGE_STATUSES.TERMINAL_FREE,
      })
    );
  });

  it('returns RPC errors without attempting a fallback insert', async () => {
    const rpcError = new Error('RPC unavailable');
    mockRpc.mockResolvedValueOnce({ data: null, error: rpcError });

    const result = await createJob(validJobData, userId, mockSupabaseClient, undefined, terminalFreeStatus);

    expect(result.data).toBeNull();
    expect(result.error).toBe(rpcError);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockClientFrom).not.toHaveBeenCalled();
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
