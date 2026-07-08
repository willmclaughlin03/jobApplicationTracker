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
const mockIsStorageStatusRetryable = jest.fn((status) => (
  status === 'billing_unavailable'
  || status === 'billing_reconciliation_pending'
));
jest.mock('../../lib/billingService.js', () => ({
  classifyStorageCreateFlow: mockClassifyStorageCreateFlow,
  isStorageStatusRetryable: mockIsStorageStatusRetryable,
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
  JobLockedByPlanError,
  InvalidJobReadOptionsError,
  StorageAccessUnavailableError,
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
  JOB_STORAGE_ERRORS,
  JOB_STORAGE_QUERY_STATES,
  JOB_STORAGE_STATES,
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
const activeAccessRecord = {
  id: jobId,
  storage_state: JOB_STORAGE_STATES.ACTIVE,
  locked_at: null,
  locked_reason: null,
  locked_policy_version: null,
};
const lockedAccessRecord = {
  id: jobId,
  storage_state: JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT,
  locked_at: '2026-06-10T00:00:00.000Z',
  locked_reason: 'premium_to_free_over_plan_limit',
  locked_policy_version: 'v1',
};
const terminalFreeAccessStatus = { status: STORAGE_STATUSES.TERMINAL_FREE };
const premiumAccessStatus = { status: STORAGE_STATUSES.PREMIUM_ACTIVE };
const billingUnavailableAccessStatus = { status: STORAGE_STATUSES.BILLING_UNAVAILABLE };
const nonEntitledNonTerminalAccessStatus = { status: STORAGE_STATUSES.NON_ENTITLED_NON_TERMINAL };

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
   * @param {object} options Fixture options.
   * @param {boolean} options.stringifyData Whether to return the RPC data as a JSON string.
   * @returns {object} Supabase RPC response shape.
   */
  function rpcCreated(job = mockCreatedJob, { stringifyData = false } = {}) {
    const data = {
      created: true,
      job,
      activeCountBeforeCreate: 0,
      retainedTotalCountBeforeCreate: 0,
      activeLimit: FREE_ACTIVE_JOB_LIMIT,
      absoluteRetainedLimit: ABSOLUTE_RETAINED_JOB_LIMIT,
    };

    return {
      data: stringifyData ? JSON.stringify(data) : data,
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

  it('creates a job when the atomic quota RPC returns JSON string data', async () => {
    mockRpc.mockResolvedValueOnce(rpcCreated(mockCreatedJob, { stringifyData: true }));

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

  it('returns retryable billing unavailable when canonical billing changes inside the create RPC', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        created: false,
        code: STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
        reason: 'billing_status_changed',
        storageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
        canonicalStorageStatus: STORAGE_STATUSES.TERMINAL_FREE,
      },
      error: null,
    });

    const result = await createJob(
      validJobData,
      userId,
      mockSupabaseClient,
      undefined,
      premiumStatus
    );

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StorageCreateBlockedError);
    expect(result.error.code).toBe(STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE);
    expect(result.error.retryable).toBe(true);
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
    const accessQuery = fakeQuery({ data: activeAccessRecord, error: null });
    const updateQuery = fakeQuery({ data: [mockCreatedJob], error: null });
    mockFrom
      .mockReturnValueOnce(accessQuery)
      .mockReturnValueOnce(updateQuery);

    const result = await updateJob(jobId, {}, userId, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([mockCreatedJob]);
    expect(mockClientFrom).not.toHaveBeenCalled();

    // Verify an empty object was passed to .update()
    expect(accessQuery._calls.select).toEqual([['id, storage_state, locked_at, locked_reason, locked_policy_version']]);
    expect(updateQuery._calls.update).toEqual([[{}]]);
    expect(updateQuery._calls.eq).toEqual([
      ['id', jobId],
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.ACTIVE],
    ]);
  });

  /**
   * Test: Empty update returning no rows still produces not-found error
   */
  it('returns not-found when empty update matches no rows', async () => {
    mockFrom
      .mockReturnValueOnce(fakeQuery({ data: activeAccessRecord, error: null }))
      .mockReturnValueOnce(fakeQuery({ data: [], error: null }));

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
    const query = fakeQuery({ data: jobs, count: jobs.length, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getJobsByUserId(userId, {}, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual(jobs);
    expect(result.count).toBe(jobs.length);
    expect(mockFrom).toHaveBeenCalledWith('jobs');
    expect(mockClientFrom).not.toHaveBeenCalled();

    // Verify query was built correctly
    expect(query._calls.select).toEqual([['*']]);
    expect(query._calls.eq).toEqual([
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.ACTIVE],
    ]);
    expect(query._calls.order).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(query._calls.limit).toEqual([[ABSOLUTE_RETAINED_JOB_LIMIT + 1]]);
  });

  it('returns error on DB failure', async () => {
    const dbError = new Error('DB down');
    mockFrom.mockReturnValueOnce(fakeQuery({ data: null, count: 0, error: dbError }));

    const result = await getJobsByUserId(userId, {}, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error).toBe(dbError);
  });

  it('returns zero count for unpaginated non-array data', async () => {
    const query = fakeQuery({ data: null, count: 99, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getJobsByUserId(userId, {}, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toBeNull();
    expect(result.count).toBe(0);
    expect(result.truncated).toBe(false);
    expect(query._calls.select).toEqual([['*']]);
  });

  it('does not warn when an unpaginated Premium query returns the retained limit', async () => {
    const jobs = Array.from({ length: ABSOLUTE_RETAINED_JOB_LIMIT }, (_, index) => ({
      ...mockCreatedJob,
      id: `job-${index}`,
    }));
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const query = fakeQuery({ data: jobs, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getJobsByUserId(
      userId,
      {},
      mockSupabaseClient,
      log,
      {
        ...premiumAccessStatus,
        retainedTotalCount: ABSOLUTE_RETAINED_JOB_LIMIT,
      }
    );

    expect(result.error).toBeNull();
    expect(result.count).toBe(ABSOLUTE_RETAINED_JOB_LIMIT);
    expect(result.truncated).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns and marks unpaginated Premium lists as truncated when one extra row is fetched', async () => {
    const jobs = Array.from({ length: ABSOLUTE_RETAINED_JOB_LIMIT + 1 }, (_, index) => ({
      ...mockCreatedJob,
      id: `job-${index}`,
    }));
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const query = fakeQuery({ data: jobs, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getJobsByUserId(
      userId,
      {},
      mockSupabaseClient,
      log,
      {
        ...premiumAccessStatus,
        retainedTotalCount: ABSOLUTE_RETAINED_JOB_LIMIT,
      }
    );

    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(ABSOLUTE_RETAINED_JOB_LIMIT);
    expect(result.data[result.data.length - 1].id).toBe(`job-${ABSOLUTE_RETAINED_JOB_LIMIT - 1}`);
    expect(result.count).toBe(ABSOLUTE_RETAINED_JOB_LIMIT);
    expect(result.truncated).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'getJobsByUserId',
        userId,
        returnedCount: ABSOLUTE_RETAINED_JOB_LIMIT,
        fetchedCount: ABSOLUTE_RETAINED_JOB_LIMIT + 1,
        limit: ABSOLUTE_RETAINED_JOB_LIMIT,
      }),
      'Job list truncated at absolute retained job limit'
    );
  });

  it('applies status filter when provided', async () => {
    const query = fakeQuery({ data: [], count: 0, error: null });
    mockFrom.mockReturnValueOnce(query);

    await getJobsByUserId(userId, { status: 'applied' }, mockSupabaseClient);

    // Should include owner, storage-state, and status filters.
    expect(query._calls.eq).toEqual([
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.ACTIVE],
      ['status', 'applied'],
    ]);
  });

  it('does not mark status-filtered unpaginated reads truncated from broader retained totals', async () => {
    const jobs = Array.from({ length: ABSOLUTE_RETAINED_JOB_LIMIT }, (_, index) => ({
      ...mockCreatedJob,
      id: `applied-job-${index}`,
      status: 'applied',
    }));
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const query = fakeQuery({ data: jobs, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getJobsByUserId(
      userId,
      { status: 'applied' },
      mockSupabaseClient,
      log,
      {
        ...terminalFreeAccessStatus,
        retainedTotalCount: ABSOLUTE_RETAINED_JOB_LIMIT + 25,
      }
    );

    expect(result.error).toBeNull();
    expect(result.count).toBe(ABSOLUTE_RETAINED_JOB_LIMIT);
    expect(result.truncated).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
    expect(query._calls.eq).toEqual([
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.ACTIVE],
      ['status', 'applied'],
    ]);
  });

  it('applies pagination range when from/to are provided', async () => {
    const query = fakeQuery({ data: [], count: 42, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getJobsByUserId(userId, { from: 0, to: 9 }, mockSupabaseClient);

    expect(result.count).toBe(42);
    expect(result.truncated).toBe(false);
    expect(query._calls.select).toEqual([['*', { count: 'exact' }]]);
    expect(query._calls.range).toEqual([[0, 9]]);
    expect(query._calls.limit).toBeUndefined();
    expect(query._calls.order).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
  });

  it.each([
    ['missing to', { from: 0 }, /both be provided/i],
    ['missing from', { to: 9 }, /both be provided/i],
    ['negative from', { from: -1, to: 9 }, /from must be >= 0/i],
    ['negative to', { from: 0, to: -1 }, /to must be >= 0/i],
    ['fractional from', { from: 1.5, to: 9 }, /from must be an integer/i],
    ['fractional to', { from: 0, to: 9.5 }, /to must be an integer/i],
    ['reversed range', { from: 10, to: 2 }, /to must be greater than or equal to from/i],
  ])('rejects invalid pagination options before querying: %s', async (_label, options, messagePattern) => {
    const result = await getJobsByUserId(userId, options, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.count).toBe(0);
    expect(result.error).toBeInstanceOf(InvalidJobReadOptionsError);
    expect(result.error).toMatchObject({
      name: 'InvalidJobReadOptionsError',
      code: 'JOB_READ_OPTIONS_INVALID',
      statusCode: 400,
    });
    expect(result.error.message).toMatch(messagePattern);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('returns teaser rows only for locked archive queries', async () => {
    const lockedTeaser = {
      id: jobId,
      created_at: '2026-06-10T00:00:00.000Z',
      locked_at: lockedAccessRecord.locked_at,
      locked_reason: lockedAccessRecord.locked_reason,
      locked_policy_version: lockedAccessRecord.locked_policy_version,
    };
    const query = fakeQuery({ data: [lockedTeaser], count: 1, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getJobsByUserId(
      userId,
      { storage_state: JOB_STORAGE_QUERY_STATES.LOCKED },
      mockSupabaseClient,
      undefined,
      terminalFreeAccessStatus
    );

    expect(result.error).toBeNull();
    expect(result.data).toEqual([lockedTeaser]);
    expect(result.count).toBe(1);
    expect(query._calls.select).toEqual([
      ['id, created_at, locked_at, locked_reason, locked_policy_version'],
    ]);
    expect(query._calls.order).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(query._calls.eq).toEqual([
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT],
    ]);
  });

  it('does not mark locked archive reads truncated from broader retained totals', async () => {
    const lockedRows = Array.from({ length: ABSOLUTE_RETAINED_JOB_LIMIT }, (_, index) => ({
      id: `locked-job-${index}`,
      created_at: '2026-06-10T00:00:00.000Z',
      locked_at: lockedAccessRecord.locked_at,
      locked_reason: lockedAccessRecord.locked_reason,
      locked_policy_version: lockedAccessRecord.locked_policy_version,
    }));
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const query = fakeQuery({ data: lockedRows, count: ABSOLUTE_RETAINED_JOB_LIMIT, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getJobsByUserId(
      userId,
      { storage_state: JOB_STORAGE_QUERY_STATES.LOCKED },
      mockSupabaseClient,
      log,
      {
        ...terminalFreeAccessStatus,
        retainedTotalCount: ABSOLUTE_RETAINED_JOB_LIMIT + 25,
      }
    );

    expect(result.error).toBeNull();
    expect(result.count).toBe(ABSOLUTE_RETAINED_JOB_LIMIT);
    expect(result.truncated).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
    expect(query._calls.eq).toEqual([
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT],
    ]);
  });

  it('keeps exact counts for paginated locked archive queries', async () => {
    const lockedTeaser = {
      id: jobId,
      created_at: '2026-06-10T00:00:00.000Z',
      locked_at: lockedAccessRecord.locked_at,
      locked_reason: lockedAccessRecord.locked_reason,
      locked_policy_version: lockedAccessRecord.locked_policy_version,
    };
    const query = fakeQuery({ data: [lockedTeaser], count: 7, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getJobsByUserId(
      userId,
      { storage_state: JOB_STORAGE_QUERY_STATES.LOCKED, from: 0, to: 4 },
      mockSupabaseClient,
      undefined,
      terminalFreeAccessStatus
    );

    expect(result.error).toBeNull();
    expect(result.data).toEqual([lockedTeaser]);
    expect(result.count).toBe(7);
    expect(query._calls.select).toEqual([
      ['id, created_at, locked_at, locked_reason, locked_policy_version', { count: 'exact' }],
    ]);
    expect(query._calls.range).toEqual([[0, 4]]);
    expect(query._calls.eq).toEqual([
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT],
    ]);
    expect(JSON.stringify(result.data)).not.toContain('company');
    expect(JSON.stringify(result.data)).not.toContain('notes');
  });

  it('returns retryable unavailable error for locked archive queries during billing ambiguity', async () => {
    const result = await getJobsByUserId(
      userId,
      { storage_state: JOB_STORAGE_QUERY_STATES.LOCKED },
      mockSupabaseClient,
      undefined,
      billingUnavailableAccessStatus
    );

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StorageAccessUnavailableError);
    expect(result.error.code).toBe(STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('does not active-filter Premium normal lists', async () => {
    const query = fakeQuery({ data: [mockCreatedJob], count: 1, error: null });
    mockFrom.mockReturnValueOnce(query);

    await getJobsByUserId(userId, {}, mockSupabaseClient, undefined, premiumAccessStatus);

    expect(query._calls.eq).toEqual([['user_id', userId]]);
    expect(query._calls.order).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(query._calls.limit).toEqual([[ABSOLUTE_RETAINED_JOB_LIMIT + 1]]);
  });
});

// ---------------------------------------------------------------------------
// getJobById
// ---------------------------------------------------------------------------

describe('getJobById', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the job for a valid user+id', async () => {
    const accessQuery = fakeQuery({ data: activeAccessRecord, error: null });
    const fullQuery = fakeQuery({ data: mockCreatedJob, error: null });
    mockFrom
      .mockReturnValueOnce(accessQuery)
      .mockReturnValueOnce(fullQuery);

    const result = await getJobById(jobId, userId, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual(mockCreatedJob);
    expect(mockFrom).toHaveBeenCalledWith('jobs');
    expect(mockClientFrom).not.toHaveBeenCalled();

    // Verify the query filters by both id and user_id, then calls .single()
    expect(accessQuery._calls.select).toEqual([['id, storage_state, locked_at, locked_reason, locked_policy_version']]);
    expect(accessQuery._calls.eq).toEqual([['id', jobId], ['user_id', userId]]);
    expect(fullQuery._calls.select).toEqual([['*']]);
    expect(fullQuery._calls.eq).toEqual([['id', jobId], ['user_id', userId]]);
    expect(fullQuery._calls.single).toHaveLength(1);
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

  it('returns 423-style locked error for locked rows under terminal Free', async () => {
    mockFrom.mockReturnValueOnce(fakeQuery({ data: lockedAccessRecord, error: null }));

    const result = await getJobById(
      jobId,
      userId,
      mockSupabaseClient,
      undefined,
      terminalFreeAccessStatus
    );

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(JobLockedByPlanError);
    expect(result.error.code).toBe(JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN);
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('returns retryable unavailable error for locked rows during billing ambiguity', async () => {
    mockFrom.mockReturnValueOnce(fakeQuery({ data: lockedAccessRecord, error: null }));

    const result = await getJobById(
      jobId,
      userId,
      mockSupabaseClient,
      undefined,
      billingUnavailableAccessStatus
    );

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StorageAccessUnavailableError);
    expect(result.error.code).toBe(STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE);
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('allows Premium users to fetch full locked rows', async () => {
    const lockedFullJob = { ...mockCreatedJob, ...lockedAccessRecord };
    mockFrom
      .mockReturnValueOnce(fakeQuery({ data: lockedAccessRecord, error: null }))
      .mockReturnValueOnce(fakeQuery({ data: lockedFullJob, error: null }));

    const result = await getJobById(
      jobId,
      userId,
      mockSupabaseClient,
      undefined,
      premiumAccessStatus
    );

    expect(result.error).toBeNull();
    expect(result.data).toEqual(lockedFullJob);
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// updateJob
// ---------------------------------------------------------------------------

describe('updateJob', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns updated job on success', async () => {
    const updated = { ...mockCreatedJob, status: 'interviewing' };
    const accessQuery = fakeQuery({ data: activeAccessRecord, error: null });
    const updateQuery = fakeQuery({ data: [updated], error: null });
    mockFrom
      .mockReturnValueOnce(accessQuery)
      .mockReturnValueOnce(updateQuery);

    const result = await updateJob(jobId, { status: 'interviewing' }, userId, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual([updated]);
    expect(mockFrom).toHaveBeenCalledWith('jobs');
    expect(mockClientFrom).not.toHaveBeenCalled();

    // Verify correct update payload and ownership filters
    expect(updateQuery._calls.update).toEqual([[{ status: 'interviewing' }]]);
    expect(updateQuery._calls.eq).toEqual([
      ['id', jobId],
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.ACTIVE],
    ]);
    expect(updateQuery._calls.select).toEqual([['*']]);
  });

  it('returns not-found error when no rows were affected', async () => {
    mockFrom
      .mockReturnValueOnce(fakeQuery({ data: activeAccessRecord, error: null }))
      .mockReturnValueOnce(fakeQuery({ data: [], error: null }));

    const result = await updateJob(jobId, { status: 'interviewing' }, userId, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error.message).toMatch(/not found/i);
  });

  it('strips server-controlled fields before updating through the admin client', async () => {
    const updateQuery = fakeQuery({ data: [{ ...mockCreatedJob, status: 'interviewing' }], error: null });
    mockFrom
      .mockReturnValueOnce(fakeQuery({ data: activeAccessRecord, error: null }))
      .mockReturnValueOnce(updateQuery);

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
    expect(updateQuery._calls.update).toEqual([[{ status: 'interviewing' }]]);
    expect(updateQuery._calls.eq).toEqual([
      ['id', jobId],
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.ACTIVE],
    ]);
  });

  it('rejects locked row updates for terminal Free users before update', async () => {
    mockFrom.mockReturnValueOnce(fakeQuery({ data: lockedAccessRecord, error: null }));

    const result = await updateJob(
      jobId,
      { status: 'interviewing' },
      userId,
      mockSupabaseClient,
      undefined,
      terminalFreeAccessStatus
    );

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(JobLockedByPlanError);
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('allows Premium users to update locked rows with the locked-state race guard', async () => {
    const updated = { ...mockCreatedJob, ...lockedAccessRecord, status: 'interviewing' };
    const updateQuery = fakeQuery({ data: [updated], error: null });
    mockFrom
      .mockReturnValueOnce(fakeQuery({ data: lockedAccessRecord, error: null }))
      .mockReturnValueOnce(updateQuery);

    const result = await updateJob(
      jobId,
      { status: 'interviewing' },
      userId,
      mockSupabaseClient,
      undefined,
      premiumAccessStatus
    );

    expect(result.error).toBeNull();
    expect(result.data).toEqual([updated]);
    expect(updateQuery._calls.eq).toEqual([
      ['id', jobId],
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT],
    ]);
  });
});

// ---------------------------------------------------------------------------
// deleteJob
// ---------------------------------------------------------------------------

describe('deleteJob', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns only the deleted job id on success', async () => {
    const deleteQuery = fakeQuery({ data: [mockCreatedJob], error: null });
    mockFrom
      .mockReturnValueOnce(fakeQuery({ data: activeAccessRecord, error: null }))
      .mockReturnValueOnce(deleteQuery);

    const result = await deleteJob(jobId, userId, mockSupabaseClient);

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ id: jobId });
    expect(mockFrom).toHaveBeenCalledWith('jobs');
    expect(mockClientFrom).not.toHaveBeenCalled();

    // Verify delete filters by both id and user_id
    expect(deleteQuery._calls.delete).toHaveLength(1);
    expect(deleteQuery._calls.eq).toEqual([
      ['id', jobId],
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.ACTIVE],
    ]);
    expect(deleteQuery._calls.select).toEqual([['id']]);
  });

  it('returns not-found error when no rows were affected', async () => {
    mockFrom
      .mockReturnValueOnce(fakeQuery({ data: activeAccessRecord, error: null }))
      .mockReturnValueOnce(fakeQuery({ data: [], error: null }));

    const result = await deleteJob(jobId, userId, mockSupabaseClient);

    expect(result.data).toBeNull();
    expect(result.error.message).toMatch(/not found/i);
  });

  it('allows terminal-Free locked row deletion but returns only the id', async () => {
    const deleteQuery = fakeQuery({
      data: [{ id: jobId, company: 'Hidden Corp', notes: 'Hidden notes' }],
      error: null,
    });
    mockFrom
      .mockReturnValueOnce(fakeQuery({ data: lockedAccessRecord, error: null }))
      .mockReturnValueOnce(deleteQuery);

    const result = await deleteJob(
      jobId,
      userId,
      mockSupabaseClient,
      undefined,
      terminalFreeAccessStatus
    );

    expect(result.error).toBeNull();
    expect(result.data).toEqual({ id: jobId });
    expect(deleteQuery._calls.eq).toEqual([
      ['id', jobId],
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT],
    ]);
    expect(deleteQuery._calls.select).toEqual([['id']]);
    expect(JSON.stringify(result.data)).not.toContain('Hidden Corp');
    expect(JSON.stringify(result.data)).not.toContain('Hidden notes');
  });

  it('rejects locked row deletion during ambiguous billing status before delete', async () => {
    mockFrom.mockReturnValueOnce(fakeQuery({ data: lockedAccessRecord, error: null }));

    const result = await deleteJob(
      jobId,
      userId,
      mockSupabaseClient,
      undefined,
      billingUnavailableAccessStatus
    );

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StorageAccessUnavailableError);
    expect(result.error.code).toBe(STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE);
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('blocks locked row deletion for confirmed non-terminal, non-premium status', async () => {
    mockFrom.mockReturnValueOnce(fakeQuery({ data: lockedAccessRecord, error: null }));

    const result = await deleteJob(
      jobId,
      userId,
      mockSupabaseClient,
      undefined,
      nonEntitledNonTerminalAccessStatus
    );

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(JobLockedByPlanError);
    expect(mockFrom).toHaveBeenCalledTimes(1);
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
