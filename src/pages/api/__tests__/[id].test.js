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
jest.mock('../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
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

const handler = require('../[id].js').default;

describe('[id] API handler', () => {
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

  /**
   * Helper to create mock request with _rateLimitUser pre-set
   * Simulates what withRateLimit provides after successful auth
   */
  const createMockRequest = (method, id, body = {}, headers = {}) => ({
    method,
    query: { id },
    body,
    headers: {
      authorization: 'Bearer valid-token',
      ...headers,
    },
    _rateLimitUser: mockUser,
  });

  // Helper to create mock response
  const createMockResponse = () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: valid update data
    mockSafeParse.mockReturnValue({ success: true, data: {} });
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
          error: expect.stringContaining('Invalid job ID'),
        })
      );
      // Should not attempt DB calls
      expect(mockGetJobById).not.toHaveBeenCalled();
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
      expect(mockGetJobById).toHaveBeenCalledWith(validUUID, mockUser.id);
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
        { status: 'Interview' },
        mockUser.id
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: updatedJob,
        })
      );
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
        mockUser.id
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
      expect(mockDeleteJob).toHaveBeenCalledWith(validUUID, mockUser.id);
    });

    /**
     * Test: Valid delete
     * Expected: Returns 200 with deleted job data
     */
    it('should delete and return job when valid', async () => {
      mockDeleteJob.mockResolvedValue({ data: mockJob, error: null });

      const req = createMockRequest('DELETE', validUUID);
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockDeleteJob).toHaveBeenCalledWith(validUUID, mockUser.id);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: mockJob,
        })
      );
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
          error: expect.stringContaining('Method not allowed'),
        })
      );
    });
  });
});
