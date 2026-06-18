/**
 * Tests for storageTransitionService - shared storage repair orchestration.
 *
 * Purpose: Verify request and webhook callers get one fail-closed transition
 * boundary that runs existing downgrade repair and then Premium restoration.
 */

const mockReconcileAndLockDowngradedStorageForUser = jest.fn();
const mockRestoreLockedJobsForPremiumUser = jest.fn();

jest.mock('../storageDowngradeService.js', () => ({
  reconcileAndLockDowngradedStorageForUser: mockReconcileAndLockDowngradedStorageForUser,
}));

jest.mock('../storageRestoreService.js', () => ({
  restoreLockedJobsForPremiumUser: mockRestoreLockedJobsForPremiumUser,
}));

jest.mock('../../../shared/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

const { reconcileStorageTransitionsForUser } = require('../storageTransitionService.js');
const { STORAGE_STATUSES } = require('../../../shared/constants/billing.js');

const userId = 'user-transition-123';
const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

describe('storageTransitionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs Premium restore after downgrade repair resolves a storage status', async () => {
    const storageStatusResult = { status: STORAGE_STATUSES.PREMIUM_ACTIVE };
    const downgradeData = {
      outcome: 'skipped',
      reason: 'storage_status_not_lock_eligible',
      storageStatusResult,
    };
    const restoreData = {
      outcome: 'restored',
      restoredCount: 42,
    };
    mockReconcileAndLockDowngradedStorageForUser.mockResolvedValueOnce({
      data: downgradeData,
      error: null,
    });
    mockRestoreLockedJobsForPremiumUser.mockResolvedValueOnce({
      data: restoreData,
      error: null,
    });

    const result = await reconcileStorageTransitionsForUser(userId, mockLog);

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      ...downgradeData,
      restoreResult: restoreData,
    });
    expect(mockReconcileAndLockDowngradedStorageForUser).toHaveBeenCalledWith(
      userId,
      mockLog,
      {}
    );
    expect(mockRestoreLockedJobsForPremiumUser).toHaveBeenCalledWith(
      userId,
      storageStatusResult,
      mockLog
    );
  });

  it('passes storage-status options through to downgrade repair', async () => {
    const storageStatusResult = { status: STORAGE_STATUSES.TERMINAL_FREE };
    const options = {
      storageStatusResult,
      now: new Date('2026-06-15T12:00:00.000Z'),
    };
    mockReconcileAndLockDowngradedStorageForUser.mockResolvedValueOnce({
      data: {
        outcome: 'already_within_limit',
        storageStatusResult,
      },
      error: null,
    });
    mockRestoreLockedJobsForPremiumUser.mockResolvedValueOnce({
      data: { outcome: 'skipped', restoredCount: 0 },
      error: null,
    });

    await reconcileStorageTransitionsForUser(userId, mockLog, options);

    expect(mockReconcileAndLockDowngradedStorageForUser).toHaveBeenCalledWith(
      userId,
      mockLog,
      options
    );
  });

  it('propagates downgrade repair errors without attempting restore', async () => {
    const downgradeError = new Error('lock failed');
    mockReconcileAndLockDowngradedStorageForUser.mockResolvedValueOnce({
      data: null,
      error: downgradeError,
    });

    const result = await reconcileStorageTransitionsForUser(userId, mockLog);

    expect(result).toEqual({ data: null, error: downgradeError });
    expect(mockRestoreLockedJobsForPremiumUser).not.toHaveBeenCalled();
  });

  it('propagates Premium restore errors so callers fail closed', async () => {
    const restoreError = new Error('restore failed');
    const storageStatusResult = { status: STORAGE_STATUSES.PREMIUM_ACTIVE };
    mockReconcileAndLockDowngradedStorageForUser.mockResolvedValueOnce({
      data: {
        outcome: 'skipped',
        storageStatusResult,
      },
      error: null,
    });
    mockRestoreLockedJobsForPremiumUser.mockResolvedValueOnce({
      data: null,
      error: restoreError,
    });

    const result = await reconcileStorageTransitionsForUser(userId, mockLog);

    expect(result).toEqual({ data: null, error: restoreError });
  });
});
