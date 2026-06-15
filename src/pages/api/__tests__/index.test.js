/**
 * Tests for index.js API handler (/api/jobs collection endpoint)
 *
 * Purpose: Verify job collection operations (GET list, POST create) work correctly
 * Connects to: pages/api/index.js
 *
 * Note: Authentication and rate limiting are tested in withRateLimit.test.js.
 * These tests mock withRateLimit as a passthrough and focus on handler business logic.
 *
 * Test coverage:
 * - GET jobs list (pagination, filtering, service errors)
 * - POST create job (validation, service errors, success)
 * - Method handling (405 for unsupported methods)
 */

// Mock withRateLimit as passthrough so we test handler logic directly
jest.mock('../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
}));

// Mock jobService
const mockGetJobsByUserId = jest.fn();
const mockCreateJob = jest.fn();

jest.mock('../../../server/services/jobService.js', () => ({
  getJobsByUserId: mockGetJobsByUserId,
  createJob: mockCreateJob,
}));

const mockGetStorageSummaryForUser = jest.fn();
jest.mock('../../../server/services/storageSummaryService.js', () => ({
  getStorageSummaryForUser: mockGetStorageSummaryForUser,
}));

const mockReconcileAndLockDowngradedStorageForUser = jest.fn();
jest.mock('../../../server/services/storageDowngradeService.js', () => ({
  reconcileAndLockDowngradedStorageForUser: mockReconcileAndLockDowngradedStorageForUser,
}));

// Mock jobSchema to avoid isomorphic-dompurify dependency issues
const mockJobSchemaSafeParse = jest.fn();
const mockGetQuerySchemaSafeParse = jest.fn();
jest.mock('../../../shared/validations/jobSchema.js', () => ({
  jobSchema: {
    safeParse: mockJobSchemaSafeParse,
  },
  getQuerySchema: {
    safeParse: mockGetQuerySchemaSafeParse,
  },
}));

// Mock logger to prevent console output during tests
jest.mock('../../../shared/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

const handler = require('../index.js').default;
const { ERROR_MESSAGES } = require('../../../shared/errors.js');
const {
  STORAGE_CREATE_ACTIONS,
  STORAGE_CREATE_ERROR_CODES,
  STORAGE_STATUSES,
} = require('../../../shared/constants/billing.js');

describe('index API handler (/api/jobs)', () => {
  const mockUser = { id: 'user-123', email: 'test@example.com' };
  const mockJobs = [
    { id: 'job-1', company: 'Acme', position: 'Dev', status: 'Applied', user_id: 'user-123' },
    { id: 'job-2', company: 'Globex', position: 'SRE', status: 'Interview', user_id: 'user-123' },
  ];
  const mockStorageSummary = {
    status: 'terminal_free',
    activeLimit: 300,
    absoluteRetainedLimit: 3000,
    activeCount: 2,
    lockedCount: 0,
    retainedTotalCount: 2,
    projectedOverflowCount: 0,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
  };
  /**
   * Build a typed storage-status result for create-route tests.
   *
   * @param {string} status Storage policy status.
   * @param {string} action Create-flow action.
   * @param {string|null} code Optional stable create-flow error code.
   * @returns {object} Storage status result returned by resolveStorageStatus().
   */
  function buildStorageStatusResult(status, action, code = null) {
    return {
      status,
      createFlow: {
        action,
        code,
        retryable: action === STORAGE_CREATE_ACTIONS.BLOCK_RETRYABLE,
        mayUseFreeQuotaCopy: code === STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED,
      },
    };
  }

  const terminalFreeStorageStatus = buildStorageStatusResult(
    STORAGE_STATUSES.TERMINAL_FREE,
    STORAGE_CREATE_ACTIONS.APPLY_FREE_LIMIT,
    STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED
  );

  /**
   * Helper to create mock request with _rateLimitUser pre-set
   * Simulates what withRateLimit provides after successful auth
   */
  const noopLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  const createMockRequest = (method, query = {}, body = {}, user = mockUser) => ({
    method,
    query,
    body,
    _rateLimitUser: user,
    log: noopLog,
  });

  const createMockResponse = () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };
    return res;
  };

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
        storageStatusResult: terminalFreeStorageStatus,
      },
      error: null,
    });
  });

  describe('GET /api/jobs', () => {
    /**
     * Test: Successful retrieval of jobs list
     * Expected: Returns 200 with jobs data and count
     */
    it('should return jobs list for authenticated user', async () => {
      mockGetQuerySchemaSafeParse.mockReturnValue({ success: true, data: {} });
      mockGetJobsByUserId.mockResolvedValue({ data: mockJobs, count: 2, error: null });

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockGetJobsByUserId).toHaveBeenCalledWith(
        mockUser.id,
        {},
        undefined,
        noopLog,
        mockStorageSummary
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            data: mockJobs,
            count: 2,
            storageSummary: mockStorageSummary,
          },
        })
      );
    });

    /**
     * Test: Pagination parameters passed correctly
     * Expected: from/to parsed as integers and forwarded to service
     */
    it('should pass pagination parameters to service', async () => {
      mockGetQuerySchemaSafeParse.mockReturnValue({ success: true, data: { from: 0, to: 10 } });
      mockGetJobsByUserId.mockResolvedValue({ data: mockJobs, count: 2, error: null });

      const req = createMockRequest('GET', { from: '0', to: '10' });
      const res = createMockResponse();

      await handler(req, res);

      expect(mockGetJobsByUserId).toHaveBeenCalledWith(
        mockUser.id,
        { from: 0, to: 10 },
        undefined,
        noopLog,
        mockStorageSummary
      );
    });

    /**
     * Test: Status filter passed correctly
     * Expected: status forwarded to service
     */
    it('should pass status filter to service', async () => {
      mockGetQuerySchemaSafeParse.mockReturnValue({ success: true, data: { status: 'Applied' } });
      mockGetJobsByUserId.mockResolvedValue({ data: mockJobs, count: 2, error: null });

      const req = createMockRequest('GET', { status: 'Applied' });
      const res = createMockResponse();

      await handler(req, res);

      expect(mockGetJobsByUserId).toHaveBeenCalledWith(
        mockUser.id,
        { status: 'Applied' },
        undefined,
        noopLog,
        mockStorageSummary
      );
    });

    it('should pass locked storage_state archive queries to the service', async () => {
      const lockedTeasers = [
        {
          id: 'locked-job-1',
          created_at: '2026-06-10T00:00:00.000Z',
          locked_at: '2026-06-11T00:00:00.000Z',
          locked_reason: 'premium_to_free_over_plan_limit',
          locked_policy_version: 'v1',
        },
      ];
      mockGetQuerySchemaSafeParse.mockReturnValue({
        success: true,
        data: { storage_state: 'locked' },
      });
      mockGetJobsByUserId.mockResolvedValue({ data: lockedTeasers, count: 1, error: null });

      const req = createMockRequest('GET', { storage_state: 'locked' });
      const res = createMockResponse();

      await handler(req, res);

      expect(mockGetJobsByUserId).toHaveBeenCalledWith(
        mockUser.id,
        { storage_state: 'locked' },
        undefined,
        noopLog,
        mockStorageSummary
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('company');
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('salary_min');
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('notes');
    });

    /**
     * Test: Combined pagination and status filter
     * Expected: All parameters forwarded correctly
     */
    it('should handle pagination with status filter', async () => {
      mockGetQuerySchemaSafeParse.mockReturnValue({ success: true, data: { from: 0, to: 5, status: 'Applied' } });
      mockGetJobsByUserId.mockResolvedValue({ data: [mockJobs[0]], count: 1, error: null });

      const req = createMockRequest('GET', { from: '0', to: '5', status: 'Applied' });
      const res = createMockResponse();

      await handler(req, res);

      expect(mockGetJobsByUserId).toHaveBeenCalledWith(
        mockUser.id,
        {
          from: 0,
          to: 5,
          status: 'Applied',
        },
        undefined,
        noopLog,
        mockStorageSummary
      );
    });

    /**
     * Test: Service error on fetch
     * Expected: Returns 503
     */
    it('should return 503 when service returns error', async () => {
      mockGetQuerySchemaSafeParse.mockReturnValue({ success: true, data: {} });
      mockGetJobsByUserId.mockResolvedValue({ data: null, count: 0, error: 'DB error' });

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('should fail closed when lazy downgrade repair fails before listing jobs', async () => {
      const repairError = new Error('overflow lock failed');
      mockGetQuerySchemaSafeParse.mockReturnValue({ success: true, data: {} });
      mockReconcileAndLockDowngradedStorageForUser.mockResolvedValueOnce({
        data: null,
        error: repairError,
      });

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handler(req, res);

      expect(mockReconcileAndLockDowngradedStorageForUser).toHaveBeenCalledWith(
        mockUser.id,
        noopLog
      );
      expect(res.status).toHaveBeenCalledWith(503);
      expect(mockGetStorageSummaryForUser).not.toHaveBeenCalled();
      expect(mockGetJobsByUserId).not.toHaveBeenCalled();
    });

    it('should fail closed when lazy downgrade repair omits storage status before listing jobs', async () => {
      mockGetQuerySchemaSafeParse.mockReturnValue({ success: true, data: {} });
      mockReconcileAndLockDowngradedStorageForUser.mockResolvedValueOnce({
        data: {
          outcome: 'skipped',
          lockedCount: 0,
        },
        error: null,
      });

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'SERVICE_UNAVAILABLE',
        })
      );
      expect(mockGetStorageSummaryForUser).not.toHaveBeenCalled();
      expect(mockGetJobsByUserId).not.toHaveBeenCalled();
    });

    it('should return retryable 503 when locked archive access needs confirmed billing', async () => {
      mockGetQuerySchemaSafeParse.mockReturnValue({
        success: true,
        data: { storage_state: 'locked' },
      });
      mockGetJobsByUserId.mockResolvedValue({
        data: null,
        count: 0,
        error: {
          code: STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
        },
      });

      const req = createMockRequest('GET', { storage_state: 'locked' });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 5);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'SERVICE_UNAVAILABLE',
          message: ERROR_MESSAGES.SERVICE_UNAVAILABLE,
        })
      );
    });

    /**
     * Test: Invalid query parameters
     * Expected: Returns 400 without calling service
     */
    it('should return 400 for invalid query parameters', async () => {
      mockGetQuerySchemaSafeParse.mockReturnValue({
        success: false,
        error: { issues: [{ message: 'Invalid from' }] },
      });

      const req = createMockRequest('GET', { from: 'abc' });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockGetJobsByUserId).not.toHaveBeenCalled();
    });

    /**
     * Test: supabaseClient passed through to service layer
     * Expected: req._supabaseClient forwarded as 3rd argument
     */
    it('should pass supabaseClient through to service', async () => {
      const mockClient = { auth: { getUser: jest.fn() } };
      mockGetQuerySchemaSafeParse.mockReturnValue({ success: true, data: {} });
      mockGetJobsByUserId.mockResolvedValue({ data: mockJobs, count: 2, error: null });

      const req = { ...createMockRequest('GET'), _supabaseClient: mockClient };
      const res = createMockResponse();

      await handler(req, res);

      expect(mockGetJobsByUserId).toHaveBeenCalledWith(
        mockUser.id,
        {},
        mockClient,
        noopLog,
        mockStorageSummary
      );
      expect(mockGetStorageSummaryForUser).toHaveBeenCalledWith(
        mockUser.id,
        mockClient,
        noopLog,
        { storageStatusResult: terminalFreeStorageStatus }
      );
    });

    /**
     * Test: Empty jobs list
     * Expected: Returns 200 with empty array
     */
    it('should return 200 with empty list when user has no jobs', async () => {
      mockGetQuerySchemaSafeParse.mockReturnValue({ success: true, data: {} });
      mockGetJobsByUserId.mockResolvedValue({ data: [], count: 0, error: null });

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            data: [],
            count: 0,
            storageSummary: mockStorageSummary,
          },
        })
      );
    });

    /**
     * Test: Storage summary failure
     * Expected: Returns 503 without a partial success envelope
     */
    it('should return 503 when storage summary metadata cannot be loaded', async () => {
      mockGetQuerySchemaSafeParse.mockReturnValue({ success: true, data: {} });
      mockGetJobsByUserId.mockResolvedValue({ data: mockJobs, count: 2, error: null });
      mockGetStorageSummaryForUser.mockResolvedValueOnce({
        data: null,
        error: new Error('storage summary failed'),
      });

      const req = createMockRequest('GET');
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(mockGetJobsByUserId).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'SERVICE_UNAVAILABLE',
        })
      );
    });
  });

  describe('POST /api/jobs', () => {
    const validJobData = {
      company: 'Test Corp',
      position: 'Developer',
      status: 'Applied',
    };

    /**
     * Test: Successful job creation
     * Expected: Returns 201 with created job data
     */
    it('should create job and return 201', async () => {
      const createdJob = { id: 'new-job-1', ...validJobData, user_id: mockUser.id };
      mockJobSchemaSafeParse.mockReturnValue({ success: true, data: validJobData });
      mockCreateJob.mockResolvedValue({ data: [createdJob], error: null });
      const mockClient = { from: jest.fn() };

      const req = { ...createMockRequest('POST', {}, validJobData), _supabaseClient: mockClient };
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockReconcileAndLockDowngradedStorageForUser).toHaveBeenCalledWith(
        mockUser.id,
        noopLog
      );
      expect(mockCreateJob).toHaveBeenCalledWith(
        validJobData,
        mockUser.id,
        mockClient,
        noopLog,
        terminalFreeStorageStatus
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [createdJob],
        })
      );
    });

    it('should pass Premium storage status through to the create service', async () => {
      const premiumStorageStatus = buildStorageStatusResult(
        STORAGE_STATUSES.PREMIUM_ACTIVE,
        STORAGE_CREATE_ACTIONS.APPLY_PREMIUM_LIMIT
      );
      mockReconcileAndLockDowngradedStorageForUser.mockResolvedValueOnce({
        data: {
          outcome: 'skipped',
          lockedCount: 0,
          storageStatusResult: premiumStorageStatus,
        },
        error: null,
      });
      mockJobSchemaSafeParse.mockReturnValue({ success: true, data: validJobData });
      mockCreateJob.mockResolvedValue({ data: [{ id: 'new-job-2', ...validJobData, user_id: mockUser.id }], error: null });

      const req = createMockRequest('POST', {}, validJobData);
      const res = createMockResponse();

      await handler(req, res);

      expect(mockCreateJob).toHaveBeenCalledWith(validJobData, mockUser.id, undefined, noopLog, premiumStorageStatus);
    });

    /**
     * Test: Validation failure
     * Expected: Returns 400 with validation error message, no DB call
     */
    it('should return 400 for invalid job data', async () => {
      mockJobSchemaSafeParse.mockReturnValue({
        success: false,
        error: { issues: [{ message: 'Company is required' }] },
      });

      const req = createMockRequest('POST', {}, { position: 'Dev' });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockCreateJob).not.toHaveBeenCalled();
      expect(mockReconcileAndLockDowngradedStorageForUser).not.toHaveBeenCalled();
    });

    /**
     * Test: Multiple validation errors
     * Expected: Returns 400 with generic message (Zod details are not exposed to clients)
     */
    it('should return 400 with generic message on validation failure', async () => {
      mockJobSchemaSafeParse.mockReturnValue({
        success: false,
        error: {
          issues: [
            { message: 'Company is required' },
            { message: 'Position is required' },
          ],
        },
      });

      const req = createMockRequest('POST', {}, {});
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Invalid request parameters.',
        })
      );
    });

    /**
     * Test: Storage limit exceeded
     * Expected: Returns 409 with STORAGE_LIMIT_EXCEEDED error code
     */
    it('should return 409 when storage limit exceeded', async () => {
      mockJobSchemaSafeParse.mockReturnValue({ success: true, data: validJobData });
      mockCreateJob.mockResolvedValue({
        data: null,
        error: {
          code: 'STORAGE_LIMIT_EXCEEDED',
          message: 'Internal storage limit detail: paid tier max 3000',
        },
      });

      const req = createMockRequest('POST', {}, validJobData);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'STORAGE_LIMIT_EXCEEDED',
          message: ERROR_MESSAGES.STORAGE_LIMIT_EXCEEDED,
        })
      );
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('paid tier max 3000');
    });

    it('should return retryable 503 SERVICE_UNAVAILABLE when billing status is unavailable', async () => {
      mockJobSchemaSafeParse.mockReturnValue({ success: true, data: validJobData });
      mockCreateJob.mockResolvedValue({
        data: null,
        error: {
          code: STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
          message: 'Internal billing read failed',
        },
      });

      const req = createMockRequest('POST', {}, validJobData);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 5);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'SERVICE_UNAVAILABLE',
          message: ERROR_MESSAGES.SERVICE_UNAVAILABLE,
        })
      );
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('Internal billing read failed');
    });

    it('should return retryable 503 when billing reconciliation is pending', async () => {
      mockJobSchemaSafeParse.mockReturnValue({ success: true, data: validJobData });
      mockCreateJob.mockResolvedValue({
        data: null,
        error: {
          code: STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING,
          message: 'Internal stale period-end state',
        },
      });

      const req = createMockRequest('POST', {}, validJobData);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 5);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING,
          message: ERROR_MESSAGES.BILLING_RECONCILIATION_PENDING,
        })
      );
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('Internal stale period-end state');
    });

    it.each([
      [
        STORAGE_CREATE_ERROR_CODES.PAYMENT_METHOD_UPDATE_REQUIRED,
        402,
        ERROR_MESSAGES.PAYMENT_METHOD_UPDATE_REQUIRED,
      ],
      [
        STORAGE_CREATE_ERROR_CODES.BILLING_SYNC_PENDING,
        409,
        ERROR_MESSAGES.BILLING_SYNC_PENDING,
      ],
      [
        STORAGE_CREATE_ERROR_CODES.BILLING_STATE_REVIEW_REQUIRED,
        409,
        ERROR_MESSAGES.BILLING_STATE_REVIEW_REQUIRED,
      ],
    ])('should return %s without Free quota copy', async (code, statusCode, message) => {
      mockJobSchemaSafeParse.mockReturnValue({ success: true, data: validJobData });
      mockCreateJob.mockResolvedValue({
        data: null,
        error: {
          code,
          message: 'Internal create-flow detail',
        },
      });

      const req = createMockRequest('POST', {}, validJobData);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(statusCode);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: code,
          message,
        })
      );
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain(ERROR_MESSAGES.STORAGE_LIMIT_EXCEEDED);
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('Internal create-flow detail');
    });

    /**
     * Test: Service error on create
     * Expected: Returns 500
     */
    it('should return 500 when create service fails without a status', async () => {
      mockJobSchemaSafeParse.mockReturnValue({ success: true, data: validJobData });
      mockCreateJob.mockResolvedValue({ data: null, error: 'Insert failed' });

      const req = createMockRequest('POST', {}, validJobData);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'ADD_FAILED',
          message: ERROR_MESSAGES.ADD_FAILED,
        })
      );
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('Insert failed');
    });

    /**
     * Test: Service error on create with explicit client status
     * Expected: Preserves the service-provided 4xx status
     */
    it('should preserve explicit client status when unmapped create service fails', async () => {
      mockJobSchemaSafeParse.mockReturnValue({ success: true, data: validJobData });
      mockCreateJob.mockResolvedValue({
        data: null,
        error: {
          code: 'UNMAPPED_CLIENT_ERROR',
          statusCode: 400,
          message: 'Internal client-side create detail',
        },
      });

      const req = createMockRequest('POST', {}, validJobData);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'ADD_FAILED',
          message: ERROR_MESSAGES.ADD_FAILED,
        })
      );
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain(
        'Internal client-side create detail'
      );
    });

    it('should fail closed when lazy downgrade repair fails before creating jobs', async () => {
      const repairError = new Error('overflow lock failed');
      mockJobSchemaSafeParse.mockReturnValue({ success: true, data: validJobData });
      mockReconcileAndLockDowngradedStorageForUser.mockResolvedValueOnce({
        data: null,
        error: repairError,
      });

      const req = createMockRequest('POST', {}, validJobData);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(mockCreateJob).not.toHaveBeenCalled();
    });
  });

  describe('Method handling', () => {
    /**
     * Test: PUT not allowed on collection endpoint
     * Expected: Returns 405 — PUT requires a specific [id]
     */
    it('should return 405 for PUT requests', async () => {
      const req = createMockRequest('PUT');
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(405);
    });

    /**
     * Test: DELETE not allowed on collection endpoint
     * Expected: Returns 405 — DELETE requires a specific [id]
     */
    it('should return 405 for DELETE requests', async () => {
      const req = createMockRequest('DELETE');
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(405);
    });

    /**
     * Test: PATCH not allowed
     * Expected: Returns 405
     */
    it('should return 405 for PATCH requests', async () => {
      const req = createMockRequest('PATCH');
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(405);
    });
  });
});
