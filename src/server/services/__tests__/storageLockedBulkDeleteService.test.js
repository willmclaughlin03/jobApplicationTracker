/**
 * Tests for storageLockedBulkDeleteService.
 *
 * Purpose: verify locked archive bulk deletion stays terminal-Free-only, calls
 * the bounded RPC, and maps billing ambiguity to retryable service errors.
 */

const mockRpc = jest.fn();
const mockResolveStorageStatusPrivileged = jest.fn();
const mockIsStorageStatusRetryable = jest.fn((status) => [
  'billing_reconciliation_pending',
  'billing_unavailable',
].includes(status));

jest.mock('../../lib/supabaseServer.js', () => ({
  supabaseAdmin: {
    rpc: mockRpc,
  },
}));

jest.mock('../../lib/billingService.js', () => ({
  isStorageStatusRetryable: mockIsStorageStatusRetryable,
  resolveStorageStatusPrivileged: mockResolveStorageStatusPrivileged,
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
  deleteLockedJobsForTerminalFreeUser,
} = require('../storageLockedBulkDeleteService.js');
const {
  STORAGE_CREATE_ERROR_CODES,
  STORAGE_STATUSES,
} = require('../../../shared/constants/billing.js');
const {
  JOB_STORAGE_ERRORS,
  LOCKED_BULK_DELETE_ROW_LIMIT,
} = require('../../../shared/constants/storage.js');

const userId = 'user-locked-bulk-delete';
const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

/**
 * Build the typed storage status consumed by the bulk delete service.
 *
 * @param {string} status - Storage status value.
 * @param {object} overrides - Optional merged fields.
 * @returns {object} Typed storage status fixture.
 */
function buildStorageStatus(status, overrides = {}) {
  return {
    status,
    billingStatus: null,
    retryable: mockIsStorageStatusRetryable(status),
    lockEligible: status === STORAGE_STATUSES.TERMINAL_FREE,
    ...overrides,
  };
}

/**
 * Build a successful locked bulk-delete RPC response.
 *
 * @param {object} overrides - Optional JSON payload fields.
 * @returns {object} Supabase RPC response fixture.
 */
function rpcDeleteResponse(overrides = {}) {
  return {
    data: {
      applied: true,
      deletedCount: 12,
      lockedCountBeforeDelete: 12,
      lockedCountAfterDelete: 0,
      lockedDeleteLimit: LOCKED_BULK_DELETE_ROW_LIMIT,
      ...overrides,
    },
    error: null,
  };
}

describe('storageLockedBulkDeleteService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsStorageStatusRetryable.mockImplementation((status) => [
      STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
      STORAGE_STATUSES.BILLING_UNAVAILABLE,
    ].includes(status));
  });

  it('calls the bounded delete RPC only after confirmed terminal Free status', async () => {
    mockResolveStorageStatusPrivileged.mockResolvedValueOnce(
      buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE)
    );
    mockRpc.mockResolvedValueOnce(rpcDeleteResponse());

    const result = await deleteLockedJobsForTerminalFreeUser(userId, mockLog);

    expect(result.error).toBeNull();
    expect(result.data).toEqual(expect.objectContaining({
      outcome: 'deleted',
      deletedCount: 12,
      lockedCountBeforeDelete: 12,
      lockedCountAfterDelete: 0,
      lockedDeleteLimit: LOCKED_BULK_DELETE_ROW_LIMIT,
    }));
    expect(mockResolveStorageStatusPrivileged).toHaveBeenCalledWith(userId, mockLog, {});
    expect(mockRpc).toHaveBeenCalledWith('delete_locked_jobs_for_terminal_free_user', {
      p_user_id: userId,
      p_storage_status: STORAGE_STATUSES.TERMINAL_FREE,
      p_locked_delete_limit: LOCKED_BULK_DELETE_ROW_LIMIT,
    });
  });

  it('drains locked rows across multiple bounded RPC calls', async () => {
    mockResolveStorageStatusPrivileged.mockResolvedValueOnce(
      buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE)
    );
    mockRpc
      .mockResolvedValueOnce(rpcDeleteResponse({
        deletedCount: LOCKED_BULK_DELETE_ROW_LIMIT,
        lockedCountBeforeDelete: LOCKED_BULK_DELETE_ROW_LIMIT + 301,
        lockedCountAfterDelete: 301,
      }))
      .mockResolvedValueOnce(rpcDeleteResponse({
        deletedCount: 301,
        lockedCountBeforeDelete: 301,
        lockedCountAfterDelete: 0,
      }));

    const result = await deleteLockedJobsForTerminalFreeUser(userId, mockLog);

    expect(result.error).toBeNull();
    expect(result.data).toEqual(expect.objectContaining({
      outcome: 'deleted',
      deletedCount: LOCKED_BULK_DELETE_ROW_LIMIT + 301,
      lockedCountBeforeDelete: LOCKED_BULK_DELETE_ROW_LIMIT + 301,
      lockedCountAfterDelete: 0,
      lockedDeleteLimit: LOCKED_BULK_DELETE_ROW_LIMIT,
    }));
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'deleteLockedJobsForTerminalFreeUser',
        userId,
        deletedCount: LOCKED_BULK_DELETE_ROW_LIMIT + 301,
        rpcAttempts: 2,
      }),
      'Locked archive bulk delete completed'
    );
  });

  it('fails closed when repeated bounded RPC calls cannot drain the archive', async () => {
    mockRpc.mockResolvedValue(rpcDeleteResponse({
      deletedCount: 1,
      lockedCountBeforeDelete: 20,
      lockedCountAfterDelete: 1,
    }));

    const result = await deleteLockedJobsForTerminalFreeUser(userId, mockLog, {
      storageStatusResult: buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE),
    });

    expect(result.data).toBeNull();
    expect(result.error).toEqual(expect.objectContaining({
      code: 'LOCKED_BULK_DELETE_INCOMPLETE',
      deletedCount: 10,
      lockedCountAfterDelete: 1,
    }));
    expect(mockRpc).toHaveBeenCalledTimes(10);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ code: 'LOCKED_BULK_DELETE_INCOMPLETE' }),
        operation: 'deleteLockedJobsForTerminalFreeUser',
        userId,
      }),
      'Failed to bulk delete locked archive rows'
    );
  });

  it('returns an idempotent already-empty result when the RPC deletes zero rows', async () => {
    mockRpc.mockResolvedValueOnce(rpcDeleteResponse({
      deletedCount: 0,
      lockedCountBeforeDelete: 0,
      lockedCountAfterDelete: 0,
    }));

    const result = await deleteLockedJobsForTerminalFreeUser(userId, mockLog, {
      storageStatusResult: buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE),
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual(expect.objectContaining({
      outcome: 'already_empty',
      deletedCount: 0,
    }));
  });

  it.each([
    STORAGE_STATUSES.PREMIUM_ACTIVE,
    STORAGE_STATUSES.PREMIUM_CANCELING,
    STORAGE_STATUSES.PAYMENT_RECOVERY,
    STORAGE_STATUSES.SYNC_PENDING,
    STORAGE_STATUSES.NON_ENTITLED_NON_TERMINAL,
  ])('rejects %s without calling the delete RPC', async (status) => {
    const result = await deleteLockedJobsForTerminalFreeUser(userId, mockLog, {
      storageStatusResult: buildStorageStatus(status),
    });

    expect(result.data).toBeNull();
    expect(result.error).toEqual(expect.objectContaining({
      code: JOB_STORAGE_ERRORS.LOCKED_BULK_DELETE_NOT_ALLOWED,
      statusCode: 409,
      storageStatus: status,
    }));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    [STORAGE_STATUSES.BILLING_UNAVAILABLE, STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE],
    [STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING, STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING],
  ])('returns retryable %s errors without calling the delete RPC', async (status, code) => {
    const result = await deleteLockedJobsForTerminalFreeUser(userId, mockLog, {
      storageStatusResult: buildStorageStatus(status),
    });

    expect(result.data).toBeNull();
    expect(result.error).toEqual(expect.objectContaining({
      code,
      statusCode: 503,
      retryable: true,
      storageStatus: status,
    }));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects when the RPC rechecks canonical billing and refuses the delete', async () => {
    mockRpc.mockResolvedValueOnce(rpcDeleteResponse({
      applied: false,
      reason: 'canonical_billing_not_terminal_free',
      storageStatus: STORAGE_STATUSES.TERMINAL_FREE,
      canonicalStorageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
      deletedCount: 0,
    }));

    const result = await deleteLockedJobsForTerminalFreeUser(userId, mockLog, {
      storageStatusResult: buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE),
    });

    expect(result.data).toBeNull();
    expect(result.error).toEqual(expect.objectContaining({
      code: JOB_STORAGE_ERRORS.LOCKED_BULK_DELETE_NOT_ALLOWED,
      reason: 'canonical_billing_not_terminal_free',
      canonicalStorageStatus: STORAGE_STATUSES.PREMIUM_ACTIVE,
    }));
  });

  it.each([
    ['deletedCount', undefined],
    ['lockedCountAfterDelete', undefined],
    ['deletedCount', -1],
    ['lockedCountAfterDelete', 1.5],
    ['deletedCount', '   '],
  ])('rejects malformed successful RPC count field %s', async (fieldName, fieldValue) => {
    const response = rpcDeleteResponse();

    if (fieldValue === undefined) {
      delete response.data[fieldName];
    } else {
      response.data[fieldName] = fieldValue;
    }

    mockRpc.mockResolvedValueOnce(response);

    const result = await deleteLockedJobsForTerminalFreeUser(userId, mockLog, {
      storageStatusResult: buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE),
    });

    expect(result.data).toBeNull();
    expect(result.error).toEqual(expect.objectContaining({
      name: 'LockedBulkDeleteUnavailableError',
      code: STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
      statusCode: 503,
      retryable: true,
      reason: `invalid_${fieldName}`,
    }));
  });
  it('parses stringified RPC payloads', async () => {
    mockRpc.mockResolvedValueOnce({
      data: JSON.stringify({
        applied: true,
        deletedCount: 3,
        lockedCountBeforeDelete: 3,
        lockedCountAfterDelete: 0,
        lockedDeleteLimit: LOCKED_BULK_DELETE_ROW_LIMIT,
      }),
      error: null,
    });

    const result = await deleteLockedJobsForTerminalFreeUser(userId, mockLog, {
      storageStatusResult: STORAGE_STATUSES.TERMINAL_FREE,
    });

    expect(result.error).toBeNull();
    expect(result.data.deletedCount).toBe(3);
  });

  it('returns RPC errors so callers can fail closed', async () => {
    const rpcError = new Error('delete rpc unavailable');
    mockRpc.mockResolvedValueOnce({ data: null, error: rpcError });

    const result = await deleteLockedJobsForTerminalFreeUser(userId, mockLog, {
      storageStatusResult: buildStorageStatus(STORAGE_STATUSES.TERMINAL_FREE),
    });

    expect(result.data).toBeNull();
    expect(result.error).toBe(rpcError);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: rpcError,
        operation: 'deleteLockedJobsForTerminalFreeUser',
        userId,
      }),
      'Failed to bulk delete locked archive rows'
    );
  });
});
