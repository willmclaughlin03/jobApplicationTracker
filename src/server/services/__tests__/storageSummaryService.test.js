/**
 * Tests for storageSummaryService - count-only storage metadata.
 *
 * Purpose: Verify storage summaries load active, locked, and retained counts
 * through the consolidated service-role RPC without exposing job row data, and
 * preserve typed storage status semantics.
 *
 * Connects to:
 * - server/services/storageSummaryService.js
 * - server/lib/billingService.resolveStorageStatus()
 * - supabaseAdmin get_job_storage_counts_for_user RPC
 */

const mockFrom = jest.fn();
const mockRpc = jest.fn();
const mockResolveStorageStatus = jest.fn();

jest.mock('../../lib/supabaseServer.js', () => ({
  supabaseAdmin: {
    from: mockFrom,
    rpc: mockRpc,
  },
}));

jest.mock('../../lib/billingService.js', () => ({
  resolveStorageStatus: mockResolveStorageStatus,
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
  InvalidJobStorageCountsUserIdError,
  buildStorageSummary,
  getJobStorageCounts,
  getProjectedOverflowCount,
  getStorageSummaryForUser,
} = require('../storageSummaryService.js');
const { STORAGE_STATUSES } = require('../../../shared/constants/billing.js');
const {
  ABSOLUTE_RETAINED_JOB_LIMIT,
  FREE_ACTIVE_JOB_LIMIT,
} = require('../../../shared/constants/storage.js');

/**
 * Builds the storage-count RPC payload shape used by the service.
 *
 * Purpose: tests need readable count fixtures while preserving the exact field
 * names returned by get_job_storage_counts_for_user().
 *
 * @param {{ activeCount?: number, lockedCount?: number, retainedTotalCount?: number }} counts - Count overrides.
 * @returns {{ activeCount: number, lockedCount: number, retainedTotalCount: number }} RPC payload.
 */
function buildCountsPayload(counts = {}) {
  return {
    activeCount: counts.activeCount ?? 300,
    lockedCount: counts.lockedCount ?? 2,
    retainedTotalCount: counts.retainedTotalCount ?? 302,
  };
}

/**
 * Queues a successful storage-count RPC response.
 *
 * Purpose: storage-summary tests can focus on summary behavior while still
 * asserting that no legacy table-count fallback is used.
 *
 * @param {object|string} payload - RPC payload object or JSON string.
 * @returns {void}
 */
function mockStorageCountsRpcSuccess(payload = buildCountsPayload()) {
  mockRpc.mockResolvedValueOnce({ data: payload, error: null });
}

describe('storageSummaryService', () => {
  const userId = '00000000-0000-4000-8000-000000000123';
  const mockClient = { from: jest.fn() };
  const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveStorageStatus.mockResolvedValue({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      billingStatus: null,
    });
  });

  it('collects active, locked, and retained counts through one RPC call', async () => {
    const payload = buildCountsPayload({
      activeCount: 300,
      lockedCount: 150,
      retainedTotalCount: 450,
    });
    mockStorageCountsRpcSuccess(payload);

    const result = await getJobStorageCounts(userId, mockLog);

    expect(result).toEqual({ data: payload, error: null });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('get_job_storage_counts_for_user', {
      p_user_id: userId,
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('accepts zero counts from the storage-count RPC', async () => {
    const payload = buildCountsPayload({
      activeCount: 0,
      lockedCount: 0,
      retainedTotalCount: 0,
    });
    mockStorageCountsRpcSuccess(payload);

    const result = await getJobStorageCounts(userId, mockLog);

    expect(result).toEqual({ data: payload, error: null });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('accepts storage-count RPC JSON string payloads', async () => {
    const payload = buildCountsPayload({
      activeCount: 12,
      lockedCount: 3,
      retainedTotalCount: 15,
    });
    mockStorageCountsRpcSuccess(JSON.stringify(payload));

    const result = await getJobStorageCounts(userId, mockLog);

    expect(result).toEqual({ data: payload, error: null });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each([null, 'not-a-uuid'])('fails before the RPC when the user id is invalid: %p', async (invalidUserId) => {
    const result = await getJobStorageCounts(invalidUserId, mockLog);

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(InvalidJobStorageCountsUserIdError);
    expect(result.error).toMatchObject({
      name: 'InvalidJobStorageCountsUserIdError',
      code: 'JOB_STORAGE_COUNTS_INVALID_USER_ID',
      statusCode: 400,
    });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('surfaces RPC failures instead of returning partial summary counts', async () => {
    const rpcError = new Error('storage counts unavailable');
    mockRpc.mockResolvedValueOnce({ data: null, error: rpcError });

    const result = await getJobStorageCounts(userId, mockLog);

    expect(result).toEqual({ data: null, error: rpcError });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: rpcError,
        operation: 'getJobStorageCounts',
        userId,
      }),
      'Failed to load job storage counts'
    );
  });

  it.each([
    ['missing retained count', { activeCount: 1, lockedCount: 0 }],
    ['extra payload field', { ...buildCountsPayload(), staleCount: 99 }],
    ['negative count', { ...buildCountsPayload(), lockedCount: -1 }],
    ['string count', { ...buildCountsPayload(), activeCount: '3' }],
    ['array payload', [buildCountsPayload()]],
    ['invalid JSON string', '{not json'],
  ])('fails closed for malformed storage-count RPC payloads: %s', async (_label, malformedPayload) => {
    mockStorageCountsRpcSuccess(malformedPayload);

    const result = await getJobStorageCounts(userId, mockLog);

    expect(result.data).toBeNull();
    expect(result.error).toEqual(expect.objectContaining({
      code: 'INVALID_STORAGE_COUNTS_RPC_PAYLOAD',
    }));
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: result.error,
        operation: 'getJobStorageCounts',
        userId,
      }),
      'Job storage counts RPC payload was invalid'
    );
  });

  it('computes projected overflow from the Free active limit', () => {
    expect(getProjectedOverflowCount(FREE_ACTIVE_JOB_LIMIT - 1)).toBe(0);
    expect(getProjectedOverflowCount(FREE_ACTIVE_JOB_LIMIT)).toBe(0);
    expect(getProjectedOverflowCount(FREE_ACTIVE_JOB_LIMIT + 12)).toBe(12);
  });

  it('builds canceling Premium summaries with cancellation timing and overflow', () => {
    const summary = buildStorageSummary(
      {
        status: STORAGE_STATUSES.PREMIUM_CANCELING,
        billingStatus: {
          cancelAtPeriodEnd: true,
          currentPeriodEnd: '2026-07-01T00:00:00.000Z',
        },
      },
      {
        activeCount: 450,
        lockedCount: 0,
        retainedTotalCount: 450,
      }
    );

    expect(summary).toEqual({
      status: STORAGE_STATUSES.PREMIUM_CANCELING,
      activeLimit: FREE_ACTIVE_JOB_LIMIT,
      absoluteRetainedLimit: ABSOLUTE_RETAINED_JOB_LIMIT,
      activeCount: 450,
      lockedCount: 0,
      retainedTotalCount: 450,
      projectedOverflowCount: 150,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: '2026-07-01T00:00:00.000Z',
    });
  });

  it('preserves billing_unavailable as its own summary status', () => {
    const summary = buildStorageSummary(
      {
        status: STORAGE_STATUSES.BILLING_UNAVAILABLE,
        billingStatus: null,
      },
      {
        activeCount: 350,
        lockedCount: 2,
        retainedTotalCount: 352,
      }
    );

    expect(summary).toEqual(
      expect.objectContaining({
        status: STORAGE_STATUSES.BILLING_UNAVAILABLE,
        activeCount: 350,
        lockedCount: 2,
        retainedTotalCount: 352,
        projectedOverflowCount: 50,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
      })
    );
    expect(summary).not.toHaveProperty('tier');
  });

  it('resolves typed storage status and count metadata into one summary', async () => {
    const now = new Date('2026-06-10T12:00:00.000Z');
    mockResolveStorageStatus.mockResolvedValueOnce({
      status: STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
      billingStatus: {
        cancelAtPeriodEnd: true,
        currentPeriodEnd: '2026-06-09T00:00:00.000Z',
      },
    });
    mockStorageCountsRpcSuccess(buildCountsPayload({
      activeCount: 301,
      lockedCount: 0,
      retainedTotalCount: 301,
    }));

    const result = await getStorageSummaryForUser(userId, mockClient, mockLog, { now });

    expect(mockResolveStorageStatus).toHaveBeenCalledWith(userId, mockClient, mockLog, { now });
    expect(result).toEqual({
      data: expect.objectContaining({
        status: STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
        activeCount: 301,
        lockedCount: 0,
        retainedTotalCount: 301,
        projectedOverflowCount: 1,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: '2026-06-09T00:00:00.000Z',
      }),
      error: null,
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('reuses an already-resolved storage status without another billing read', async () => {
    const storageStatusResult = {
      status: STORAGE_STATUSES.TERMINAL_FREE,
      billingStatus: null,
    };
    mockStorageCountsRpcSuccess(buildCountsPayload({
      activeCount: 300,
      lockedCount: 1,
      retainedTotalCount: 301,
    }));

    const result = await getStorageSummaryForUser(
      userId,
      mockClient,
      mockLog,
      { storageStatusResult }
    );

    expect(mockResolveStorageStatus).not.toHaveBeenCalled();
    expect(result.data).toEqual(expect.objectContaining({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      activeCount: 300,
      lockedCount: 1,
    }));
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('preserves a string storage status override without another billing read', async () => {
    mockStorageCountsRpcSuccess(buildCountsPayload({
      activeCount: 450,
      lockedCount: 0,
      retainedTotalCount: 450,
    }));

    const result = await getStorageSummaryForUser(
      userId,
      mockClient,
      mockLog,
      { storageStatusResult: STORAGE_STATUSES.PREMIUM_ACTIVE }
    );

    expect(mockResolveStorageStatus).not.toHaveBeenCalled();
    expect(result.data).toEqual(expect.objectContaining({
      status: STORAGE_STATUSES.PREMIUM_ACTIVE,
      activeCount: 450,
      projectedOverflowCount: 150,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
    }));
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
