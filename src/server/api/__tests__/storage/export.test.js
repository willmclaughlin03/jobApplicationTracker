let capturedRateLimitOptions;
const mockWithRateLimit = jest.fn((handler, options) => {
  capturedRateLimitOptions = options;
  return handler;
});

jest.mock('../../../middleware/withRateLimit.js', () => ({
  withRateLimit: mockWithRateLimit,
}));

const mockGetJobsCsvExportForUser = jest.fn();

jest.mock('../../../services/jobExportService.js', () => ({
  getJobsCsvExportForUser: mockGetJobsCsvExportForUser,
}));

const handler = require('../../../../pages/api/storage/export.js').default;
const { ERROR_MESSAGES } = require('../../../../shared/errors.js');
const { OPERATIONS } = require('../../../../shared/constants/tiers.js');

describe('/api/storage/export handler', () => {
  const mockUser = { id: 'user-storage-export' };
  const mockLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  const csv = 'company,position,status,notes,created_at\r\n"Acme","Dev","applied","","2026-06-18T00:00:00.000Z"\r\n';

  /**
   * Create a mock storage export request.
   *
   * Purpose: tests exercise the route with authenticated middleware fields
   * already attached, matching the route-test style used in this repo.
   *
   * @param {object} query - Optional route query parameters.
   * @returns {object} Mock Next.js request.
   */
  function createMockReq(query = {}) {
    return {
      method: 'GET',
      query,
      _rateLimitUser: mockUser,
      log: mockLog,
    };
  }

  /**
   * Create a mock storage export response.
   *
   * Purpose: route tests assert headers, JSON errors, and CSV send calls
   * without relying on a real Next.js response object.
   *
   * @returns {object} Mock Next.js response.
   */
  function createMockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetJobsCsvExportForUser.mockResolvedValue({
      data: { csv, rowCount: 1 },
      error: null,
    });
  });

  it('uses the dedicated storage export rate limit operation', () => {
    expect(capturedRateLimitOptions).toEqual({
      requireAuth: true,
      operation: OPERATIONS.STORAGE_EXPORT,
      allowedMethods: ['GET'],
    });
  });

  it('returns a CSV file download for the authenticated user', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockGetJobsCsvExportForUser).toHaveBeenCalledWith(mockUser.id, mockLog);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.setHeader).toHaveBeenCalledWith('CDN-Cache-Control', 'no-store');
    expect(res.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Cookie');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="job-applications-export.csv"'
    );
    expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(csv);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('rejects client-supplied user ids instead of using them for ownership', async () => {
    const req = createMockReq({ user_id: 'other-user' });
    const res = createMockRes();

    await handler(req, res);

    expect(mockGetJobsCsvExportForUser).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: null,
        error: 'VALIDATION_ERROR',
        message: ERROR_MESSAGES.VALIDATION_ERROR,
      })
    );
    expect(res.setHeader).not.toHaveBeenCalledWith(
      'Content-Disposition',
      expect.any(String)
    );
    expect(res.send).not.toHaveBeenCalled();
  });

  it('returns a public-safe error when CSV export fails', async () => {
    mockGetJobsCsvExportForUser.mockResolvedValueOnce({
      data: null,
      error: new Error('internal database detail'),
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: null,
        error: 'EXPORT_FAILED',
        message: ERROR_MESSAGES.EXPORT_FAILED,
      })
    );
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('internal database detail');
    expect(res.setHeader).not.toHaveBeenCalledWith(
      'Content-Disposition',
      expect.any(String)
    );
    expect(res.send).not.toHaveBeenCalled();
  });

  it('returns a public-safe error when the service omits CSV data', async () => {
    mockGetJobsCsvExportForUser.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'EXPORT_FAILED',
        message: ERROR_MESSAGES.EXPORT_FAILED,
      })
    );
    expect(res.send).not.toHaveBeenCalled();
  });

  it.each([
    ['missing csv', {}],
    ['non-string csv', { csv: 123 }],
  ])('returns a public-safe error when the service returns %s', async (_label, data) => {
    mockGetJobsCsvExportForUser.mockResolvedValueOnce({
      data,
      error: null,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'EXPORT_FAILED',
        message: ERROR_MESSAGES.EXPORT_FAILED,
      })
    );
    expect(res.setHeader).not.toHaveBeenCalledWith(
      'Content-Disposition',
      expect.any(String)
    );
    expect(res.send).not.toHaveBeenCalled();
  });
});
