/**
 * Tests for storageRestoreService - Premium re-entitlement restore.
 *
 * Purpose: Verify locked overflow rows restore only for Premium storage states,
 * stay idempotent, and log over-cap retained totals without unlocking from
 * billing ambiguity.
 */

const mockRpc = jest.fn();

jest.mock('../../lib/supabaseServer.js', () => ({
  supabaseAdmin: {
    rpc: mockRpc,
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

const { restoreLockedJobsForPremiumUser } = require('../storageRestoreService.js');
const { STORAGE_STATUSES } = require('../../../shared/constants/billing.js');
const {
  ABSOLUTE_RETAINED_JOB_LIMIT,
} = require('../../../shared/constants/storage.js');

const userId = 'user-restore-123';
const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

/**
 * Build the typed storage status consumed by restore helpers.
 *
 * @param {string} status Storage status value.
 * @param {object} overrides Optional fields to merge into the result.
 * @returns {object} Typed storage-status fixture.
 */
function buildStorageStatus(status, overrides = {}) {
  return {
    status,
    retryable: false,
    billingStatus: null,
    ...overrides,
  };
}

/**
 * Build a successful Premium restore RPC response.
 *
 * @param {object} overrides Optional JSON payload fields.
 * @returns {object} Supabase RPC response shape.
 */
function rpcRestoreResponse(overrides = {}) {
  return {
    data: {
      applied: true,
      restoredCount: 12,
      activeCountBeforeRestore: 300,
      activeCountAfterRestore: 312,
      lockedCountBeforeRestore: 12,
      lockedCountAfterRestore: 0,
      retainedTotalCount: 312,
      absoluteRetainedLimit: ABSOLUTE_RETAINED_JOB_LIMIT,
      retainedOverLimit: false,
      ...overrides,
    },
    error: null,
  };
}

describe('storageRestoreService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls the restore RPC only for confirmed Premium storage status', async () => {
    mockRpc.mockResolvedValueOnce(rpcRestoreResponse());

    const result = await restoreLockedJobsForPremiumUser(
      userId,
      buildStorageStatus(STORAGE_STATUSES.PREMIUM_ACTIVE),
      mockLog
    );

    expect(result.error).toBeNull();
    expect(result.data).toEqual(
      expect.objectContaining({
        outcome: 'restored',
        storageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
        restoredCount: 12,
        activeCountAfterRestore: 312,
        lockedCountAfterRestore: 0,
      })
    );
    expect(mockRpc).toHaveBeenCalledWith('restore_locked_jobs_for_premium_user', {
      p_user_id: userId,
      p_storage_status: STORAGE_STATUSES.PREMIUM_ACTIVE,
      p_absolute_retained_job_limit: ABSOLUTE_RETAINED_JOB_LIMIT,
    });
  });

  it('accepts canceling Premium as restore-eligible until period end', async () => {
    mockRpc.mockResolvedValueOnce(rpcRestoreResponse({
      restoredCount: 0,
      activeCountBeforeRestore: 3000,
      activeCountAfterRestore: 3000,
      lockedCountBeforeRestore: 0,
      lockedCountAfterRestore: 0,
    }));

    const result = await restoreLockedJobsForPremiumUser(
      userId,
      buildStorageStatus(STORAGE_STATUSES.PREMIUM_CANCELING),
      mockLog
    );

    expect(result.error).toBeNull();
    expect(result.data).toEqual(expect.objectContaining({
      outcome: 'already_restored',
      restoredCount: 0,
    }));
    expect(mockRpc).toHaveBeenCalledWith('restore_locked_jobs_for_premium_user', {
      p_user_id: userId,
      p_storage_status: STORAGE_STATUSES.PREMIUM_CANCELING,
      p_absolute_retained_job_limit: ABSOLUTE_RETAINED_JOB_LIMIT,
    });
  });

  it.each([
    STORAGE_STATUSES.BILLING_UNAVAILABLE,
    STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
    STORAGE_STATUSES.TERMINAL_FREE,
    STORAGE_STATUSES.PAYMENT_RECOVERY,
    STORAGE_STATUSES.SYNC_PENDING,
    STORAGE_STATUSES.NON_ENTITLED_NON_TERMINAL,
  ])('skips %s without calling the restore RPC', async (status) => {
    const result = await restoreLockedJobsForPremiumUser(
      userId,
      buildStorageStatus(status),
      mockLog
    );

    expect(result.error).toBeNull();
    expect(result.data).toEqual(
      expect.objectContaining({
        outcome: 'skipped',
        reason: 'storage_status_not_restore_eligible',
        restoredCount: 0,
      })
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns a skipped result when canonical billing is no longer Premium', async () => {
    mockRpc.mockResolvedValueOnce(rpcRestoreResponse({
      applied: false,
      reason: 'canonical_billing_not_premium',
      restoredCount: 0,
      canonicalStorageStatus: STORAGE_STATUSES.TERMINAL_FREE,
    }));

    const result = await restoreLockedJobsForPremiumUser(
      userId,
      buildStorageStatus(STORAGE_STATUSES.PREMIUM_ACTIVE),
      mockLog
    );

    expect(result.error).toBeNull();
    expect(result.data).toEqual(expect.objectContaining({
      outcome: 'skipped',
      reason: 'canonical_billing_not_premium',
      restoredCount: 0,
    }));
  });

  it('logs over-cap retained totals after a bounded Premium restore', async () => {
    mockRpc.mockResolvedValueOnce(rpcRestoreResponse({
      restoredCount: 2700,
      activeCountBeforeRestore: 300,
      activeCountAfterRestore: ABSOLUTE_RETAINED_JOB_LIMIT,
      lockedCountBeforeRestore: 2900,
      lockedCountAfterRestore: 200,
      retainedTotalCount: ABSOLUTE_RETAINED_JOB_LIMIT + 200,
      retainedOverLimit: true,
    }));

    const result = await restoreLockedJobsForPremiumUser(
      userId,
      buildStorageStatus(STORAGE_STATUSES.PREMIUM_ACTIVE),
      mockLog
    );

    expect(result.error).toBeNull();
    expect(result.data).toEqual(expect.objectContaining({
      outcome: 'restored',
      restoredCount: 2700,
      retainedOverLimit: true,
      lockedCountAfterRestore: 200,
    }));
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'premium_restore_retained_total_over_limit',
        operation: 'restoreLockedJobsForPremiumUser',
        userId,
        retainedTotalCount: ABSOLUTE_RETAINED_JOB_LIMIT + 200,
        restoredCount: 2700,
      }),
      'Premium restore left retained rows over the absolute storage cap'
    );
  });

  it('returns restore RPC errors so callers can fail closed', async () => {
    const rpcError = new Error('restore rpc unavailable');
    mockRpc.mockResolvedValueOnce({ data: null, error: rpcError });

    const result = await restoreLockedJobsForPremiumUser(
      userId,
      buildStorageStatus(STORAGE_STATUSES.PREMIUM_ACTIVE),
      mockLog
    );

    expect(result.data).toBeNull();
    expect(result.error).toBe(rpcError);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: rpcError,
        operation: 'restoreLockedJobsForPremiumUser',
        userId,
      }),
      'Failed to restore Premium storage archive'
    );
  });
});
