jest.mock('../../../middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
}));

const mockGetStorageSummaryForUser = jest.fn();
const mockReconcileAndLockDowngradedStorageForUser = jest.fn();

jest.mock('../../../services/storageSummaryService.js', () => ({
  getStorageSummaryForUser: mockGetStorageSummaryForUser,
}));

jest.mock('../../../services/storageDowngradeService.js', () => ({
  reconcileAndLockDowngradedStorageForUser: mockReconcileAndLockDowngradedStorageForUser,
}));

const handler = require('../../../../pages/api/storage/status.js').default;

describe('/api/storage/status handler', () => {
  const mockUser = { id: 'user-storage-status' };
  const mockClient = { from: jest.fn() };
  const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const mockStorageSummary = {
    status: 'billing_unavailable',
    activeLimit: 300,
    absoluteRetainedLimit: 3000,
    activeCount: 350,
    lockedCount: 0,
    retainedTotalCount: 350,
    projectedOverflowCount: 50,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
  };
  const mockStorageStatusResult = {
    status: 'billing_unavailable',
    billingStatus: null,
  };

  /**
   * Create a mock storage-status GET request.
   *
   * Purpose: tests exercise the route with the authenticated fields supplied
   * by withRateLimit in production.
   * Params/vars: no params; uses module-scoped mock user, client, and logger.
   * Returns: request with method, _rateLimitUser, _supabaseClient, and log.
   * Side effects/connections: relies on shared mocks reset by beforeEach.
   */
  function createMockReq() {
    return {
      method: 'GET',
      _rateLimitUser: mockUser,
      _supabaseClient: mockClient,
      log: mockLog,
    };
  }

  /**
   * Create a mock storage-status response.
   *
   * Purpose: tests assert response envelopes and cache headers without a real
   * Next.js response object.
   * Params/vars: no params; uses jest.fn() stubs and mockReturnThis() chaining.
   * Returns: response with status, json, and setHeader mocks.
   * Side effects/connections: mock calls are inspected by the status tests.
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
    mockGetStorageSummaryForUser.mockResolvedValue({
      data: mockStorageSummary,
      error: null,
    });
    mockReconcileAndLockDowngradedStorageForUser.mockResolvedValue({
      data: {
        outcome: 'skipped',
        lockedCount: 0,
        storageStatusResult: mockStorageStatusResult,
      },
      error: null,
    });
  });

  it('returns storage summary metadata with cache-hardening headers', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockReconcileAndLockDowngradedStorageForUser).toHaveBeenCalledWith(
      mockUser.id,
      mockLog
    );
    expect(mockGetStorageSummaryForUser).toHaveBeenCalledWith(
      mockUser.id,
      mockClient,
      mockLog,
      { storageStatusResult: mockStorageStatusResult }
    );
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.setHeader).toHaveBeenCalledWith('CDN-Cache-Control', 'no-store');
    expect(res.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Cookie');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: mockStorageSummary,
        error: null,
        message: 'Storage status retrieved successfully',
      })
    );
  });

  it('does not return dashboard jobs or locked job details', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    const responsePayload = res.json.mock.calls[0][0];
    expect(responsePayload.data).not.toHaveProperty('data');
    expect(responsePayload.data).not.toHaveProperty('jobs');
    expect(responsePayload.data).not.toHaveProperty('company');
    expect(responsePayload.data).not.toHaveProperty('position');
    expect(responsePayload.data).not.toHaveProperty('notes');
    expect(responsePayload.data).not.toHaveProperty('salary_min');
    expect(responsePayload.data.status).toBe('billing_unavailable');
  });

  it('returns 503 when storage summary metadata cannot be loaded', async () => {
    mockGetStorageSummaryForUser.mockResolvedValueOnce({
      data: null,
      error: new Error('summary count failed'),
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: null,
        error: 'SERVICE_UNAVAILABLE',
      })
    );
  });

  it('returns 503 when confirmed downgrade storage repair fails', async () => {
    const repairError = new Error('overflow lock failed');
    mockReconcileAndLockDowngradedStorageForUser.mockResolvedValueOnce({
      data: null,
      error: repairError,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockGetStorageSummaryForUser).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: null,
        error: 'SERVICE_UNAVAILABLE',
      })
    );
  });
});
