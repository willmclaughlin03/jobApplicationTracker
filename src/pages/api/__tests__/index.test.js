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

const mockResolveStorageEntitlement = jest.fn();
jest.mock('../../../server/lib/billingService.js', () => ({
  resolveStorageEntitlement: mockResolveStorageEntitlement,
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

describe('index API handler (/api/jobs)', () => {
  const mockUser = { id: 'user-123', email: 'test@example.com' };
  const mockJobs = [
    { id: 'job-1', company: 'Acme', position: 'Dev', status: 'Applied', user_id: 'user-123' },
    { id: 'job-2', company: 'Globex', position: 'SRE', status: 'Interview', user_id: 'user-123' },
  ];

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
    };
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveStorageEntitlement.mockResolvedValue('free');
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
      expect(mockGetJobsByUserId).toHaveBeenCalledWith(mockUser.id, {}, undefined, noopLog);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { data: mockJobs, count: 2 },
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

      expect(mockGetJobsByUserId).toHaveBeenCalledWith(mockUser.id, { from: 0, to: 10 }, undefined, noopLog);
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

      expect(mockGetJobsByUserId).toHaveBeenCalledWith(mockUser.id, { status: 'Applied' }, undefined, noopLog);
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

      expect(mockGetJobsByUserId).toHaveBeenCalledWith(mockUser.id, {
        from: 0,
        to: 5,
        status: 'Applied',
      }, undefined, noopLog);
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

      expect(mockGetJobsByUserId).toHaveBeenCalledWith(mockUser.id, {}, mockClient, noopLog);
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
          data: { data: [], count: 0 },
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
      mockCreateJob.mockResolvedValue({ data: createdJob, error: null });
      const mockClient = { from: jest.fn() };

      const req = { ...createMockRequest('POST', {}, validJobData), _supabaseClient: mockClient };
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockResolveStorageEntitlement).toHaveBeenCalledWith(mockUser.id, mockClient, noopLog);
      expect(mockCreateJob).toHaveBeenCalledWith(validJobData, mockUser.id, mockClient, noopLog, 'free');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: createdJob,
        })
      );
    });

    it('should use the paid storage tier when local billing entitlement resolves paid', async () => {
      mockResolveStorageEntitlement.mockResolvedValueOnce('paid');
      mockJobSchemaSafeParse.mockReturnValue({ success: true, data: validJobData });
      mockCreateJob.mockResolvedValue({ data: { id: 'new-job-2', ...validJobData, user_id: mockUser.id }, error: null });

      const req = createMockRequest('POST', {}, validJobData);
      const res = createMockResponse();

      await handler(req, res);

      expect(mockCreateJob).toHaveBeenCalledWith(validJobData, mockUser.id, undefined, noopLog, 'paid');
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
      expect(mockResolveStorageEntitlement).not.toHaveBeenCalled();
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

    /**
     * Test: Service error on create
     * Expected: Returns 400
     */
    it('should return 400 when create service fails', async () => {
      mockJobSchemaSafeParse.mockReturnValue({ success: true, data: validJobData });
      mockCreateJob.mockResolvedValue({ data: null, error: 'Insert failed' });

      const req = createMockRequest('POST', {}, validJobData);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
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
