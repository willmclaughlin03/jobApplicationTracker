/**
 * Tests for [id].js API handler
 *
 * Purpose: Verify single job operations (GET, PUT, DELETE) work correctly
 * Connects to: pages/api/[id].js
 *
 * Note: Authentication and rate limiting are tested in withRateLimit.test.js.
 * These tests mock withRateLimit as a passthrough and focus on handler business logic.
 *
 * Test coverage:
 * - UUID validation (format checking)
 * - GET single job (ownership verification)
 * - PUT update job (validation + ownership)
 * - DELETE remove job (ownership verification)
 * - Method handling (405 for unsupported methods)
 */

// Mock withRateLimit as passthrough so we test handler logic directly
let mockCapturedRateLimitOptions;
jest.mock('../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: (handler, options) => {
    mockCapturedRateLimitOptions = options;
    return handler;
  },
}));

// Mock jobService before importing handler
const mockGetJobById = jest.fn();
const mockUpdateJob = jest.fn();
const mockDeleteJob = jest.fn();

jest.mock('../../../server/services/jobService.js', () => ({
  getJobById: mockGetJobById,
  updateJob: mockUpdateJob,
  deleteJob: mockDeleteJob,
}));

const mockReconcileStorageTransitionsForUser = jest.fn();
jest.mock('../../../server/services/storageTransitionService.js', () => ({
  reconcileStorageTransitionsForUser: mockReconcileStorageTransitionsForUser,
}));

const mockGetStorageSummaryForUser = jest.fn();
jest.mock('../../../server/services/storageSummaryService.js', () => ({
  getStorageSummaryForUser: mockGetStorageSummaryForUser,
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

// Mock jobSchema to avoid isomorphic-dompurify dependency issues
// This provides the essential validation schemas needed by the handler
const mockSafeParse = jest.fn();
jest.mock('../../../shared/validations/jobSchema.js', () => ({
  uuidSchema: {
    safeParse: (value) => {
      // Real UUID v4 validation regex
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      return {
        success: typeof value === 'string' && uuidRegex.test(value),
      };
    },
  },
  jobUpdateSchema: {
    safeParse: mockSafeParse,
  },
}));

const jobByIdRoute = require('../../../pages/api/[id].js');
const handler = jobByIdRoute.default;
const { ERROR_MESSAGES } = require('../../../shared/errors.js');
const { STORAGE_CREATE_ERROR_CODES, STORAGE_STATUSES } = require('../../../shared/constants/billing.js');
const { JOB_STORAGE_ERRORS } = require('../../../shared/constants/storage.js');

describe('[id] API handler', () => {
  /** Verify detail mutations remain behind the protected wrapper default. */
  it('keeps /api/[id] protected for cache and authentication policy', () => {
    expect(mockCapturedRateLimitOptions).toEqual({
      requireAuth: true,
      allowedMethods: ['GET', 'PUT', 'DELETE'],
    });
  });
  // Test fixtures
  const validUUID = '550e8400-e29b-41d4-a716-446655440000';
  const mockUser = { id: 'user-123', email: 'test@example.com' };
  const mockJob = {
    id: validUUID,
    company: 'Test Corp',
    position: 'Developer',
    status: 'Applied',
    user_id: 'user-123',
  };
  const terminalFreeStorageStatus = { status: STORAGE_STATUSES.TERMINAL_FREE };
  const mockStorageSummary = {
    status: STORAGE_STATUSES.TERMINAL_FREE,
    activeLimit: 300,
    absoluteRetainedLimit: 3000,
    activeCount: 1,
    lockedCount: 0,
    retainedTotalCount: 1,
    projectedOverflowCount: 0,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
  };

  /**
   * Helper to create mock request with _rateLimitUser pre-set
   * Simulates what withRateLimit provides after successful auth
   */
  const noopLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  const createMockRequest = (method, id, body = {}, headers = {}) => ({
    method,
    query: { id },
    body,
    headers: {
      ...headers,
    },
    _rateLimitUser: mockUser,
    log: noopLog,
  });

  // Helper to create mock response
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
    mockReconcileStorageTransitionsForUser.mockResolvedValue({
      data: {
        outcome: 'already_within_limit',
        lockedCount: 0,
        storageStatusResult: terminalFreeStorageStatus,
      },
      error: null,
    });
    mockGetStorageSummaryForUser.mockResolvedValue({
      data: mockStorageSummary,
      error: null,
    });
    // Default: valid update data
    mockSafeParse.mockReturnValue({ success: true, data: {} });
  });

  it('exports the small job body-parser route contract', () => {
    expect(jobByIdRoute.config).toEqual({
      api: {
        bodyParser: {
          sizeLimit: '16kb',
        },
      },
    });
    expect(typeof handler).toBe('function');
  });

  describe('UUID Validation', () => {
    /**
     * Test: Invalid UUID format
     * Expected: Returns 400 before any DB calls
     */
    it('should return 400 for invalid UUID format', async () => {
      const req = createMockRequest('GET', 'not-a-valid-uuid');
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'INVALID_ID',
        })
      );
      // Should not attempt DB calls
      expect(mockGetJobById).not.toHaveBeenCalled();
      expect(mockReconcileStorageTransitionsForUser).not.toHaveBeenCalled();
    });

    /**
     * Test: Empty ID
     * Expected: Returns 400
     */
    it('should return 400 for empty id', async () => {
      const req = createMockRequest('GET', '');
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    /**
     * Test: Undefined ID
     * Expected: Returns 400
     */
    it('should return 400 for undefined id', async () => {
      const req = createMockRequest('GET', undefined);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    /**
     * Test: Valid UUID format accepted
     * Expected: Proceeds to handler logic (not rejected at validation)
     */
    it('should accept valid UUID v4 format', async () => {
      const req = createMockRequest('GET', validUUID);
      const res = createMockResponse();

      mockGetJobById.mockResolvedValue({ data: mockJob, error: null });

      await handler(req, res);

      // Should have proceeded past UUID validation to DB call
      expect(mockGetJobById).toHaveBeenCalled();
    });
  });

  describe('GET /api/jobs/[id]', () => {
    /**
     * Test: Job not found
     * Expected: Returns 404
     */
    it('should return 404 when job does not exist', async () => {
      mockGetJobById.mockResolvedValue({
        data: null,
        error: new Error('Job not found or unauthorized'),
      });

      const req = createMockRequest('GET', validUUID);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockGetJobById).toHaveBeenCalledWith(
        validUUID,
        mockUser.id,
        undefined,
        noopLog,
        terminalFreeStorageStatus
      );
    });

    /**
     * Test: supabaseClient passed through to service layer
     * Expected: req._supabaseClient forwarded as 3rd argument
     */
    it('should pass supabaseClient through to service', async () => {
      const mockClient = { auth: { getUser: jest.fn() } };
      mockGetJobById.mockResolvedValue({ data: mockJob, error: null });

      const req = { ...createMockRequest('GET', validUUID), _supabaseClient: mockClient };
      const res = createMockResponse();

      await handler(req, res);

      expect(mockGetJobById).toHaveBeenCalledWith(
        validUUID,
        mockUser.id,
        mockClient,
        noopLog,
        terminalFreeStorageStatus
      );
    });

    /**
     * Test: Job belongs to different user
     * Expected: Returns 404 (not 403, to prevent enumeration)
     */
    it('should return 404 when job belongs to different user', async () => {
      mockGetJobById.mockResolvedValue({
        data: null,
        error: new Error('Job not found or unauthorized'),
      });

      const req = createMockRequest('GET', validUUID);
      const res = createMockResponse();

      await handler(req, res);

      // Should return 404 not 403 (prevents user enumeration)
      expect(res.status).toHaveBeenCalledWith(404);
    });

    /**
     * Test: Valid request for owned job
     * Expected: Returns 200 with job data
     */
    it('should return job data when user owns the job', async () => {
      mockGetJobById.mockResolvedValue({ data: mockJob, error: null });

      const req = createMockRequest('GET', validUUID);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: mockJob,
        })
      );
    });

    it('should return 423 for locked plan-gated job detail', async () => {
      mockGetJobById.mockResolvedValue({
        data: null,
        error: {
          code: JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN,
        },
      });

      const req = createMockRequest('GET', validUUID);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(423);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN,
          message: ERROR_MESSAGES.JOB_LOCKED_BY_PLAN,
        })
      );
    });

    it('should return retryable 503 for locked detail during billing ambiguity', async () => {
      mockGetJobById.mockResolvedValue({
        data: null,
        error: {
          code: STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
        },
      });

      const req = createMockRequest('GET', validUUID);
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

    it('should fail closed when storage transition repair fails before job detail access', async () => {
      mockReconcileStorageTransitionsForUser.mockResolvedValueOnce({
        data: null,
        error: new Error('overflow lock failed'),
      });

      const req = createMockRequest('GET', validUUID);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(mockGetJobById).not.toHaveBeenCalled();
    });

    it('should fail closed when storage transition repair rejects before job detail access', async () => {
      const repairError = new Error('storage transition rejected');
      mockReconcileStorageTransitionsForUser.mockRejectedValueOnce(repairError);

      const req = createMockRequest('GET', validUUID);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(noopLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: repairError,
          operation: 'repairStorageTransitionsForJobRequest',
          userId: mockUser.id,
        }),
        'Storage transition repair failed'
      );
      expect(mockGetJobById).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/jobs/[id]', () => {
    /**
     * Test: Invalid update data
     * Expected: Returns 400 with validation errors
     */
    it('should return 400 for invalid update data', async () => {
      // Mock validation failure
      mockSafeParse.mockReturnValue({
        success: false,
        error: { issues: [{ message: 'Company is required' }] },
      });

      const req = createMockRequest('PUT', validUUID, {
        company: '', // Empty string should fail validation (min 1)
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockUpdateJob).not.toHaveBeenCalled();
    });

    /**
     * Test: Job not found or unauthorized
     * Expected: Returns 404
     */
    it('should return 404 when job not found or unauthorized', async () => {
      mockSafeParse.mockReturnValue({ success: true, data: { status: 'Interview' } });
      mockUpdateJob.mockResolvedValue({
        data: null,
        error: new Error('Job not found or unauthorized'),
      });

      const req = createMockRequest('PUT', validUUID, { status: 'Interview' });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should return 423 when updating a locked plan-gated job', async () => {
      mockSafeParse.mockReturnValue({ success: true, data: { status: 'Interview' } });
      mockUpdateJob.mockResolvedValue({
        data: null,
        error: {
          code: JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN,
        },
      });

      const req = createMockRequest('PUT', validUUID, { status: 'Interview' });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(423);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN,
          message: ERROR_MESSAGES.JOB_LOCKED_BY_PLAN,
        })
      );
    });

    it('should reject locked salary partial updates before calling updateJob', async () => {
      mockSafeParse.mockReturnValue({ success: true, data: { salary_min: 100000 } });
      mockGetJobById.mockResolvedValue({
        data: null,
        error: {
          code: JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN,
        },
      });

      const req = createMockRequest('PUT', validUUID, { salary_min: 100000 });
      const res = createMockResponse();

      await handler(req, res);

      expect(mockGetJobById).toHaveBeenCalledWith(
        validUUID,
        mockUser.id,
        undefined,
        noopLog,
        terminalFreeStorageStatus
      );
      expect(mockUpdateJob).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(423);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: JOB_STORAGE_ERRORS.JOB_LOCKED_BY_PLAN,
        })
      );
    });

    /**
     * Test: Valid update
     * Expected: Returns 200 with updated job data
     */
    it('should update and return job when valid', async () => {
      mockSafeParse.mockReturnValue({ success: true, data: { status: 'Interview' } });
      const updatedJob = { ...mockJob, status: 'Interview' };
      mockUpdateJob.mockResolvedValue({ data: updatedJob, error: null });

      const req = createMockRequest('PUT', validUUID, { status: 'Interview' });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockUpdateJob).toHaveBeenCalledWith(
        validUUID,
        expect.objectContaining({
          status: 'Interview',
          status_date: expect.any(String),
        }),
        mockUser.id,
        undefined,
        noopLog,
        terminalFreeStorageStatus
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: updatedJob,
        })
      );
    });

    it('should fail closed when storage transition repair fails before job update', async () => {
      mockSafeParse.mockReturnValue({ success: true, data: { notes: 'Updated notes' } });
      mockReconcileStorageTransitionsForUser.mockResolvedValueOnce({
        data: null,
        error: new Error('overflow lock failed'),
      });

      const req = createMockRequest('PUT', validUUID, { notes: 'Updated notes' });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(mockGetJobById).not.toHaveBeenCalled();
      expect(mockUpdateJob).not.toHaveBeenCalled();
    });

    /**
     * Test: Partial update (only some fields)
     * Expected: Successfully updates specified fields only
     */
    it('should allow partial updates', async () => {
      mockSafeParse.mockReturnValue({ success: true, data: { notes: 'Updated notes' } });
      const updatedJob = { ...mockJob, notes: 'Updated notes' };
      mockUpdateJob.mockResolvedValue({ data: updatedJob, error: null });

      const req = createMockRequest('PUT', validUUID, { notes: 'Updated notes' });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockUpdateJob).toHaveBeenCalledWith(
        validUUID,
        { notes: 'Updated notes' },
        mockUser.id,
        undefined,
        noopLog,
        terminalFreeStorageStatus
      );
    });
  });

  describe('DELETE /api/jobs/[id]', () => {
    /**
     * Test: Job not found or unauthorized
     * Expected: Returns 404
     */
    it('should return 404 when job not found or unauthorized', async () => {
      mockDeleteJob.mockResolvedValue({
        data: null,
        error: new Error('Job not found or unauthorized'),
      });

      const req = createMockRequest('DELETE', validUUID);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockDeleteJob).toHaveBeenCalledWith(validUUID, mockUser.id, undefined, noopLog, terminalFreeStorageStatus);
      expect(mockReconcileStorageTransitionsForUser).toHaveBeenCalledWith(mockUser.id, noopLog);
      expect(mockGetStorageSummaryForUser).not.toHaveBeenCalled();
    });

    /**
     * Test: Valid active-row delete
     * Expected: Returns 200 with minimal deleted job id and no summary wait
     */
    it('should delete and return a minimal id response without loading storage summary', async () => {
      const mockClient = { from: jest.fn() };
      mockDeleteJob.mockResolvedValue({ data: { id: validUUID }, error: null });

      const req = { ...createMockRequest('DELETE', validUUID), _supabaseClient: mockClient };
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockDeleteJob).toHaveBeenCalledWith(validUUID, mockUser.id, mockClient, noopLog, terminalFreeStorageStatus);
      expect(mockReconcileStorageTransitionsForUser).toHaveBeenCalledWith(mockUser.id, noopLog);
      expect(mockGetStorageSummaryForUser).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { id: validUUID },
          error: null,
          message: 'Successfully deleted job',
        })
      );
      expect(res.json.mock.calls[0][0]).not.toHaveProperty('storageSummary');
    });

    it('should keep delete data minimal for locked-row deletes', async () => {
      const lockedDeleteData = { id: validUUID };
      mockDeleteJob.mockResolvedValue({ data: lockedDeleteData, error: null });

      const req = createMockRequest('DELETE', validUUID);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: lockedDeleteData,
        })
      );
      expect(res.json.mock.calls[0][0]).not.toHaveProperty('storageSummary');
      expect(res.json.mock.calls[0][0].data).toEqual({ id: validUUID });
      expect(JSON.stringify(res.json.mock.calls[0][0].data)).not.toContain('company');
      expect(JSON.stringify(res.json.mock.calls[0][0].data)).not.toContain('notes');
      expect(JSON.stringify(res.json.mock.calls[0][0].data)).not.toContain('salary');
      expect(JSON.stringify(res.json.mock.calls[0][0].data)).not.toContain('position');
      expect(JSON.stringify(res.json.mock.calls[0][0].data)).not.toContain('status');
      expect(mockDeleteJob).toHaveBeenCalledWith(validUUID, mockUser.id, undefined, noopLog, terminalFreeStorageStatus);
    });

    it('should fail closed when storage transition repair fails before job delete', async () => {
      mockReconcileStorageTransitionsForUser.mockResolvedValueOnce({
        data: null,
        error: new Error('overflow lock failed'),
      });

      const req = createMockRequest('DELETE', validUUID);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(mockDeleteJob).not.toHaveBeenCalled();
      expect(mockGetStorageSummaryForUser).not.toHaveBeenCalled();
    });

    it('should return retryable 503 when locked delete is blocked by billing ambiguity', async () => {
      mockDeleteJob.mockResolvedValue({
        data: null,
        error: {
          code: STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
        },
      });

      const req = createMockRequest('DELETE', validUUID);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 5);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(mockDeleteJob).toHaveBeenCalledWith(validUUID, mockUser.id, undefined, noopLog, terminalFreeStorageStatus);
      expect(mockGetStorageSummaryForUser).not.toHaveBeenCalled();
    });
  });
  describe('Method handling', () => {
    /**
     * Test: POST not allowed on [id] endpoint
     * Expected: Returns 405
     */
    it('should return 405 for POST requests', async () => {
      const req = createMockRequest('POST', validUUID, { company: 'Test' });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(405);
    });

    /**
     * Test: PATCH not allowed
     * Expected: Returns 405
     */
    it('should return 405 for unsupported methods', async () => {
      const req = createMockRequest('PATCH', validUUID);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'METHOD_NOT_ALLOWED',
        })
      );
    });
  });
});
