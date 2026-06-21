let capturedRateLimitOptions;
const mockWithRateLimit = jest.fn((handler, options) => {
  capturedRateLimitOptions = options;
  return handler;
});

jest.mock('../../../middleware/withRateLimit.js', () => ({
  withRateLimit: mockWithRateLimit,
}));

const mockDeleteLockedJobsForTerminalFreeUser = jest.fn();

jest.mock('../../../services/storageLockedBulkDeleteService.js', () => ({
  deleteLockedJobsForTerminalFreeUser: mockDeleteLockedJobsForTerminalFreeUser,
}));

const handler = require('../../../../pages/api/storage/locked-jobs.js').default;
const { ERROR_MESSAGES } = require('../../../../shared/errors.js');
const { STORAGE_CREATE_ERROR_CODES } = require('../../../../shared/constants/billing.js');
const { JOB_STORAGE_ERRORS } = require('../../../../shared/constants/storage.js');
const { OPERATIONS } = require('../../../../shared/constants/tiers.js');

describe('/api/storage/locked-jobs handler', () => {
  const mockUser = { id: 'user-locked-bulk-route' };
  const mockLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  /**
   * Create a mock locked bulk-delete request.
   *
   * Purpose: route tests run after auth middleware has attached the user and
   * logger, matching the repo's storage route test pattern.
   *
   * @param {object} params - Request fixture overrides.
   * @returns {object} Mock Next.js request.
   */
  function createMockReq({ query = {}, body = { confirmation: 'permanently_delete_locked_jobs' } } = {}) {
    return {
      method: 'DELETE',
      query,
      body,
      _rateLimitUser: mockUser,
      log: mockLog,
    };
  }

  /**
   * Create a mock locked bulk-delete response.
   *
   * Purpose: tests inspect JSON envelopes and cache/retry headers without a
   * real Next.js response object.
   *
   * @returns {object} Mock Next.js response.
   */
  function createMockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteLockedJobsForTerminalFreeUser.mockResolvedValue({
      data: {
        deletedCount: 12,
        lockedCountBeforeDelete: 12,
        lockedCountAfterDelete: 0,
        lockedDeleteLimit: 2700,
      },
      error: null,
    });
  });

  it('uses the dedicated locked bulk-delete rate limit operation', () => {
    expect(capturedRateLimitOptions).toEqual({
      requireAuth: true,
      operation: OPERATIONS.BULK_DELETE_LOCKED_JOBS,
      allowedMethods: ['DELETE'],
    });
  });

  it('deletes locked rows for the authenticated user and returns count only', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockDeleteLockedJobsForTerminalFreeUser).toHaveBeenCalledWith(
      mockUser.id,
      mockLog
    );
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.setHeader).toHaveBeenCalledWith('CDN-Cache-Control', 'no-store');
    expect(res.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Cookie');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: { deletedCount: 12 },
      error: null,
      message: 'Locked archive deleted successfully',
    }));
    expect(res.json.mock.calls[0][0].data).not.toHaveProperty('lockedCountBeforeDelete');
    expect(res.json.mock.calls[0][0].data).not.toHaveProperty('company');
    expect(res.json.mock.calls[0][0].data).not.toHaveProperty('notes');
  });

  it('rejects missing or wrong confirmation bodies before calling the service', async () => {
    for (const body of [null, {}, { confirmation: 'delete' }]) {
      const req = createMockReq({ body });
      const res = createMockRes();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'VALIDATION_ERROR',
        message: ERROR_MESSAGES.VALIDATION_ERROR,
      }));
    }

    expect(mockDeleteLockedJobsForTerminalFreeUser).not.toHaveBeenCalled();
  });

  it('rejects client-supplied user ids in query or body', async () => {
    const queryReq = createMockReq({ query: { user_id: 'other-user' } });
    const queryRes = createMockRes();
    await handler(queryReq, queryRes);

    const bodyReq = createMockReq({
      body: {
        confirmation: 'permanently_delete_locked_jobs',
        user_id: 'other-user',
      },
    });
    const bodyRes = createMockRes();
    await handler(bodyReq, bodyRes);

    expect(queryRes.status).toHaveBeenCalledWith(400);
    expect(bodyRes.status).toHaveBeenCalledWith(400);
    expect(mockDeleteLockedJobsForTerminalFreeUser).not.toHaveBeenCalled();
  });

  it('returns not-allowed copy when the service rejects the storage status', async () => {
    mockDeleteLockedJobsForTerminalFreeUser.mockResolvedValueOnce({
      data: null,
      error: { code: JOB_STORAGE_ERRORS.LOCKED_BULK_DELETE_NOT_ALLOWED },
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: null,
      error: JOB_STORAGE_ERRORS.LOCKED_BULK_DELETE_NOT_ALLOWED,
      message: ERROR_MESSAGES.LOCKED_BULK_DELETE_NOT_ALLOWED,
    }));
  });

  it('returns retryable service unavailable when billing status is unavailable', async () => {
    mockDeleteLockedJobsForTerminalFreeUser.mockResolvedValueOnce({
      data: null,
      error: { code: STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE },
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 5);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'SERVICE_UNAVAILABLE',
      message: ERROR_MESSAGES.SERVICE_UNAVAILABLE,
    }));
  });

  it('returns retryable reconciliation-pending copy when billing is stale', async () => {
    mockDeleteLockedJobsForTerminalFreeUser.mockResolvedValueOnce({
      data: null,
      error: { code: STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING },
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 5);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING,
      message: ERROR_MESSAGES.BILLING_RECONCILIATION_PENDING,
    }));
  });

  it('returns a public-safe unavailable error when the service fails unexpectedly', async () => {
    mockDeleteLockedJobsForTerminalFreeUser.mockResolvedValueOnce({
      data: null,
      error: new Error('internal delete detail'),
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: null,
      error: 'SERVICE_UNAVAILABLE',
      message: ERROR_MESSAGES.SERVICE_UNAVAILABLE,
    }));
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('internal delete detail');
  });
});
