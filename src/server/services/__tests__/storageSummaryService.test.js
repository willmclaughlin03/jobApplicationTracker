/**
 * Tests for storageSummaryService - count-only storage metadata.
 *
 * Purpose: Verify Chunk 3 storage summary helpers count active, locked, and
 * retained rows without exposing job data, and preserve typed storage status.
 *
 * Connects to:
 * - server/services/storageSummaryService.js
 * - server/lib/billingService.resolveStorageStatus()
 * - supabaseAdmin jobs count queries
 */

const mockFrom = jest.fn();
const mockResolveStorageStatus = jest.fn();

jest.mock('../../lib/supabaseServer.js', () => ({
  supabaseAdmin: {
    from: mockFrom,
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
  buildStorageSummary,
  getActiveJobCount,
  getJobStorageCounts,
  getLockedJobCount,
  getProjectedOverflowCount,
  getRetainedTotalJobCount,
  getStorageSummaryForUser,
} = require('../storageSummaryService.js');
const { STORAGE_STATUSES } = require('../../../shared/constants/billing.js');
const {
  ABSOLUTE_RETAINED_JOB_LIMIT,
  FREE_ACTIVE_JOB_LIMIT,
  JOB_STORAGE_STATES,
} = require('../../../shared/constants/storage.js');

/**
 * Create a chainable Supabase query fake.
 *
 * Purpose: service tests need to inspect fluent query construction while await
 * resolves to caller-provided count/error metadata.
 *
 * @param {object} resolvedValue - Supabase-like terminal response.
 * @returns {Proxy} Chainable thenable query fake with recorded calls.
 */
function fakeQuery(resolvedValue) {
  const _calls = {};

  const chain = new Proxy({}, {
    get(_, prop) {
      if (prop === '_calls') return _calls;

      if (prop === 'then') {
        return (resolve, reject) =>
          Promise.resolve(resolvedValue).then(resolve, reject);
      }

      return (...args) => {
        _calls[prop] = _calls[prop] || [];
        _calls[prop].push(args);
        return chain;
      };
    },
  });

  return chain;
}

describe('storageSummaryService', () => {
  const userId = 'user-storage-summary';
  const mockClient = { from: jest.fn() };
  const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveStorageStatus.mockResolvedValue({
      status: STORAGE_STATUSES.TERMINAL_FREE,
      billingStatus: null,
    });
  });

  it('counts active jobs through a count-only active-row query', async () => {
    const query = fakeQuery({ count: 42, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getActiveJobCount(userId, mockLog);

    expect(result).toEqual({ count: 42, error: null });
    expect(mockFrom).toHaveBeenCalledWith('jobs');
    expect(query._calls.select).toEqual([['id', { count: 'exact', head: true }]]);
    expect(query._calls.eq).toEqual([
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.ACTIVE],
    ]);
  });

  it('counts locked jobs through a count-only locked-row query', async () => {
    const query = fakeQuery({ count: 7, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getLockedJobCount(userId, mockLog);

    expect(result).toEqual({ count: 7, error: null });
    expect(query._calls.select).toEqual([['id', { count: 'exact', head: true }]]);
    expect(query._calls.eq).toEqual([
      ['user_id', userId],
      ['storage_state', JOB_STORAGE_STATES.LOCKED_OVER_PLAN_LIMIT],
    ]);
  });

  it('counts retained total jobs without a storage-state filter', async () => {
    const query = fakeQuery({ count: 49, error: null });
    mockFrom.mockReturnValueOnce(query);

    const result = await getRetainedTotalJobCount(userId, mockLog);

    expect(result).toEqual({ count: 49, error: null });
    expect(query._calls.select).toEqual([['id', { count: 'exact', head: true }]]);
    expect(query._calls.eq).toEqual([['user_id', userId]]);
  });

  it('collects active, locked, and retained counts into one shape', async () => {
    mockFrom
      .mockReturnValueOnce(fakeQuery({ count: 300, error: null }))
      .mockReturnValueOnce(fakeQuery({ count: 150, error: null }))
      .mockReturnValueOnce(fakeQuery({ count: 450, error: null }));

    const result = await getJobStorageCounts(userId, mockLog);

    expect(result).toEqual({
      data: {
        activeCount: 300,
        lockedCount: 150,
        retainedTotalCount: 450,
      },
      error: null,
    });
  });

  it('surfaces count failures instead of returning partial summary counts', async () => {
    const countError = new Error('count failed');
    mockFrom.mockReturnValueOnce(fakeQuery({ count: null, error: countError }));

    const result = await getJobStorageCounts(userId, mockLog);

    expect(result).toEqual({ data: null, error: countError });
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: countError,
        operation: 'getActiveJobCount',
      }),
      'Failed to count job storage rows'
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
    mockFrom
      .mockReturnValueOnce(fakeQuery({ count: 301, error: null }))
      .mockReturnValueOnce(fakeQuery({ count: 0, error: null }))
      .mockReturnValueOnce(fakeQuery({ count: 301, error: null }));

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
  });
});
