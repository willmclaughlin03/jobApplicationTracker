/**
 * Tests for storageDowngradeService - paid-to-free overflow repair.
 *
 * Purpose: Verify downgrade locking stays terminal-Free-only, idempotent at the
 * service boundary, and never mutates from billing ambiguity or failed
 * authoritative reconciliation.
 */

const mockRpc = jest.fn();
const mockResolveStorageStatusPrivileged = jest.fn();
const mockSyncSubscriptionFromStripe = jest.fn();

/**
 * Mirror the strict billing snapshot converter for downgrade-service mocks.
 *
 * Purpose: preserve the production absent/existing discriminator while failing
 * malformed fixtures instead of silently treating them as absent.
 *
 * @param {object|null|undefined} billingStatus
 * @returns {object}
 */
const mockBuildAuthoritativeSubscriptionSnapshot = jest.fn((billingStatus) => {
  if (billingStatus?.subscription === null) return { exists: false };

  const subscription = billingStatus?.subscription;
  if (!subscription?.stripe_subscription_id || !subscription?.snapshot_version) {
    throw new Error('invalid strict snapshot');
  }

  return {
    exists: true,
    subscriptionId: subscription.stripe_subscription_id,
    snapshotVersion: subscription.snapshot_version,
  };
});

/**
 * Mirror the production terminal-Free-only lock eligibility rule in tests.
 *
 * @param {string|object|null|undefined} storageStatus - Storage status fixture.
 * @returns {boolean} True only for terminal Free.
 */
function mockLockEligibility(storageStatus) {
  const status = typeof storageStatus === 'object'
    ? storageStatus?.status
    : storageStatus;

  return status === 'terminal_free';
}

const mockIsAutomaticOverflowLockEligible = jest.fn(mockLockEligibility);

jest.mock('../../lib/supabaseServer.js', () => ({
  supabaseAdmin: {
    rpc: mockRpc,
  },
}));

jest.mock('../../lib/billingService.js', () => ({
  BILLING_AUTHORITATIVE_SYNC_PURPOSES: {
    RECONCILE_CURRENT: 'reconcile_current',
  },
  BILLING_SYNC_MODES: {
    AUTHORITATIVE: 'authoritative',
  },
  buildAuthoritativeSubscriptionSnapshot: mockBuildAuthoritativeSubscriptionSnapshot,
  isAutomaticOverflowLockEligible: mockIsAutomaticOverflowLockEligible,
  resolveStorageStatusPrivileged: mockResolveStorageStatusPrivileged,
  syncSubscriptionFromStripe: mockSyncSubscriptionFromStripe,
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
  lockOverflowJobsForTerminalFreeUser,
  reconcileAndLockDowngradedStorageForUser,
} = require('../storageDowngradeService.js');
const { STORAGE_STATUSES } = require('../../../shared/constants/billing.js');
const {
  FREE_ACTIVE_JOB_LIMIT,
  JOB_STORAGE_LOCK_POLICY_VERSION,
  JOB_STORAGE_LOCK_REASONS,
} = require('../../../shared/constants/storage.js');

const userId = 'user-downgrade-123';
const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

/**
 * Build the typed storage status consumed by downgrade repair helpers.
 *
 * @param {string} status - Storage status value.
 * @param {object} overrides - Optional fields to merge into the result.
 * @returns {object} Typed storage-status fixture.
 */
function buildStorageStatus(status, overrides = {}) {
  return {
    status,
    lockEligible: status === STORAGE_STATUSES.TERMINAL_FREE,
    retryable: false,
    billingStatus: null,
    ...overrides,
  };
}

/**
 * Build a successful overflow lock RPC response.
 *
 * @param {object} overrides - Optional JSON payload fields.
 * @returns {object} Supabase RPC response shape.
 */
function rpcLockResponse(overrides = {}) {
  return {
    data: {
      applied: true,
      lockedCount: 12,
      activeCountBeforeLock: FREE_ACTIVE_JOB_LIMIT + 12,
      activeCountAfterLock: FREE_ACTIVE_JOB_LIMIT,
      activeLimit: FREE_ACTIVE_JOB_LIMIT,
      ...overrides,
    },
    error: null,
  };
}

describe('storageDowngradeService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAutomaticOverflowLockEligible.mockImplementation(mockLockEligibility);
  });

  describe('lockOverflowJobsForTerminalFreeUser', () => {
    it('calls the lock RPC only for confirmed terminal Free storage status', async () => {
      mockRpc.mockResolvedValueOnce(rpcLockResponse());

      const result = await lockOverflowJobsForTerminalFreeUser(
        userId,
        buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE),
        mockLog
      );

      expect(result.error).toBeNull();
      expect(result.data).toEqual(
        expect.objectContaining({
          outcome: 'locked',
          storageStatus: STORAGE_STATUSES.TERMINAL_FREE,
          lockedCount: 12,
          activeCountAfterLock: FREE_ACTIVE_JOB_LIMIT,
        })
      );
      expect(mockRpc).toHaveBeenCalledWith('lock_overflow_jobs_for_terminal_free_user', {
        p_user_id: userId,
        p_storage_status: STORAGE_STATUSES.TERMINAL_FREE,
        p_active_job_limit: FREE_ACTIVE_JOB_LIMIT,
        p_locked_reason: JOB_STORAGE_LOCK_REASONS.PREMIUM_TO_FREE_OVER_PLAN_LIMIT,
        p_locked_policy_version: JOB_STORAGE_LOCK_POLICY_VERSION,
      });
    });

    it('returns an idempotent already-within-limit result when the RPC locks zero rows', async () => {
      mockRpc.mockResolvedValueOnce(rpcLockResponse({
        lockedCount: 0,
        activeCountBeforeLock: FREE_ACTIVE_JOB_LIMIT,
        activeCountAfterLock: FREE_ACTIVE_JOB_LIMIT,
      }));

      const result = await lockOverflowJobsForTerminalFreeUser(
        userId,
        buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE),
        mockLog
      );

      expect(result.error).toBeNull();
      expect(result.data).toEqual(
        expect.objectContaining({
          outcome: 'already_within_limit',
          lockedCount: 0,
          activeCountAfterLock: FREE_ACTIVE_JOB_LIMIT,
        })
      );
    });

    it.each([
      STORAGE_STATUSES.BILLING_UNAVAILABLE,
      STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
      STORAGE_STATUSES.PAYMENT_RECOVERY,
      STORAGE_STATUSES.SYNC_PENDING,
      STORAGE_STATUSES.NON_ENTITLED_NON_TERMINAL,
      STORAGE_STATUSES.PREMIUM_ACTIVE,
      STORAGE_STATUSES.PREMIUM_CANCELING,
    ])('skips %s without calling the lock RPC', async (status) => {
      const result = await lockOverflowJobsForTerminalFreeUser(
        userId,
        buildStorageStatus(status),
        mockLog
      );

      expect(result.error).toBeNull();
      expect(result.data).toEqual(
        expect.objectContaining({
          outcome: 'skipped',
          reason: 'storage_status_not_lock_eligible',
          lockedCount: 0,
        })
      );
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('honors an explicit non-lock-eligible terminal result', async () => {
      const result = await lockOverflowJobsForTerminalFreeUser(
        userId,
        buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE, { lockEligible: false }),
        mockLog
      );

      expect(result.error).toBeNull();
      expect(result.data.reason).toBe('storage_status_not_lock_eligible');
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('returns lock RPC errors so callers can fail closed', async () => {
      const rpcError = new Error('lock rpc unavailable');
      mockRpc.mockResolvedValueOnce({ data: null, error: rpcError });

      const result = await lockOverflowJobsForTerminalFreeUser(
        userId,
        buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE),
        mockLog
      );

      expect(result.data).toBeNull();
      expect(result.error).toBe(rpcError);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: rpcError,
          operation: 'lockOverflowJobsForTerminalFreeUser',
          userId,
        }),
        'Failed to lock downgrade overflow jobs'
      );
    });
  });

  describe('reconcileAndLockDowngradedStorageForUser', () => {
    it('resolves privileged terminal Free status and locks overflow', async () => {
      mockResolveStorageStatusPrivileged.mockResolvedValueOnce(
        buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE)
      );
      mockRpc.mockResolvedValueOnce(rpcLockResponse());

      const result = await reconcileAndLockDowngradedStorageForUser(userId, mockLog);

      expect(result.error).toBeNull();
      expect(result.data).toEqual(
        expect.objectContaining({
          outcome: 'locked',
          initialStorageStatus: STORAGE_STATUSES.TERMINAL_FREE,
          storageStatus: STORAGE_STATUSES.TERMINAL_FREE,
          lockedCount: 12,
        })
      );
      expect(mockResolveStorageStatusPrivileged).toHaveBeenCalledWith(userId, mockLog, {});
      expect(mockSyncSubscriptionFromStripe).not.toHaveBeenCalled();
      expect(mockRpc).toHaveBeenCalledTimes(1);
    });

    it('authoritatively reconciles stale canceling Premium before locking terminal Free overflow', async () => {
      mockResolveStorageStatusPrivileged
        .mockResolvedValueOnce(buildStorageStatus(
          STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
          {
            retryable: true,
            lockEligible: false,
            billingStatus: {
              stripeSubscriptionId: 'sub_stale_123',
              subscription: {
                stripe_subscription_id: 'sub_stale_123',
                snapshot_version: 7,
              },
            },
          }
        ))
        .mockResolvedValueOnce(buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE));
      mockSyncSubscriptionFromStripe.mockResolvedValueOnce({ outcome: 'processed' });
      mockRpc.mockResolvedValueOnce(rpcLockResponse({ lockedCount: 1 }));

      const result = await reconcileAndLockDowngradedStorageForUser(userId, mockLog);

      expect(result.error).toBeNull();
      expect(result.data).toEqual(
        expect.objectContaining({
          outcome: 'locked',
          initialStorageStatus: STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
          storageStatus: STORAGE_STATUSES.TERMINAL_FREE,
          syncOutcome: 'processed',
          lockedCount: 1,
        })
      );
      expect(mockSyncSubscriptionFromStripe).toHaveBeenCalledWith(
        'sub_stale_123',
        {
          mode: 'authoritative',
          expectedUserId: userId,
          expectedSubscriptionSnapshot: {
            exists: true,
            subscriptionId: 'sub_stale_123',
            snapshotVersion: 7,
          },
          authoritativeSyncPurpose: 'reconcile_current',
        },
        mockLog
      );
      expect(mockRpc).toHaveBeenCalledTimes(1);
    });

    it('does not lock when authoritative reconciliation fails', async () => {
      const syncError = new Error('Stripe unavailable');
      mockResolveStorageStatusPrivileged.mockResolvedValueOnce(buildStorageStatus(
        STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
        {
          retryable: true,
          lockEligible: false,
          billingStatus: {
              stripeSubscriptionId: 'sub_stale_123',
              subscription: {
                stripe_subscription_id: 'sub_stale_123',
                snapshot_version: 8,
              },
          },
        }
      ));
      mockSyncSubscriptionFromStripe.mockRejectedValueOnce(syncError);

      const result = await reconcileAndLockDowngradedStorageForUser(userId, mockLog);

      expect(result.error).toBeNull();
      expect(result.data).toEqual(
        expect.objectContaining({
          outcome: 'skipped',
          reason: 'authoritative_reconcile_failed',
          storageStatus: STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
          lockedCount: 0,
        })
      );
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: syncError,
          operation: 'reconcilePendingBillingStatus',
          userId,
        }),
        'Failed to reconcile stale downgrade billing state before storage repair'
      );
    });

    it('does not lock reconciliation-pending status without a complete subscription snapshot', async () => {
      mockResolveStorageStatusPrivileged.mockResolvedValueOnce(buildStorageStatus(
        STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
        {
          retryable: true,
          lockEligible: false,
          billingStatus: {},
        }
      ));

      const result = await reconcileAndLockDowngradedStorageForUser(userId, mockLog);

      expect(result.error).toBeNull();
      expect(result.data).toEqual(
        expect.objectContaining({
          outcome: 'skipped',
          reason: 'reconciliation_snapshot_missing',
          lockedCount: 0,
        })
      );
      expect(mockSyncSubscriptionFromStripe).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('rereads current billing when guarded reconciliation reports a changed snapshot', async () => {
      mockResolveStorageStatusPrivileged
        .mockResolvedValueOnce(buildStorageStatus(
          STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
          {
            retryable: true,
            lockEligible: false,
            billingStatus: {
              stripeSubscriptionId: 'sub_recovered_123',
              subscription: {
                stripe_subscription_id: 'sub_recovered_123',
                snapshot_version: 9,
              },
            },
          }
        ))
        .mockResolvedValueOnce(buildStorageStatus(STORAGE_STATUSES.PREMIUM_ACTIVE));
      mockSyncSubscriptionFromStripe.mockResolvedValueOnce({ outcome: 'snapshot_changed' });

      const result = await reconcileAndLockDowngradedStorageForUser(userId, mockLog);

      expect(result.error).toBeNull();
      expect(result.data).toEqual(
        expect.objectContaining({
          outcome: 'skipped',
          reason: 'storage_status_not_lock_eligible',
          initialStorageStatus: STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
          storageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
          syncOutcome: 'snapshot_changed',
          lockedCount: 0,
        })
      );
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('rereads billing when the lock RPC rejects a stale terminal-Free decision', async () => {
      mockResolveStorageStatusPrivileged
        .mockResolvedValueOnce(buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE))
        .mockResolvedValueOnce(buildStorageStatus(STORAGE_STATUSES.PREMIUM_ACTIVE));
      mockRpc.mockResolvedValueOnce(rpcLockResponse({
        applied: false,
        reason: 'canonical_billing_not_terminal_free',
        lockedCount: 0,
      }));

      const result = await reconcileAndLockDowngradedStorageForUser(userId, mockLog);

      expect(result.error).toBeNull();
      expect(result.data).toEqual(expect.objectContaining({
        outcome: 'skipped',
        reason: 'canonical_billing_not_terminal_free',
        initialStorageStatus: STORAGE_STATUSES.TERMINAL_FREE,
        storageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
        storageStatusResult: expect.objectContaining({
          status: STORAGE_STATUSES.PREMIUM_ACTIVE,
        }),
      }));
      expect(mockResolveStorageStatusPrivileged).toHaveBeenCalledTimes(2);
    });
  });
});
