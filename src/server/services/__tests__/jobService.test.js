/**
 * Tests for jobService - storage limit enforcement in createJob
 *
 * Purpose: Verify that createJob correctly enforces the per-user 300-entry
 * storage limit before attempting a database insert
 *
 * Connects to: server/services/jobService.js
 *
 * Test coverage:
 * - createJob: Allows insert when under limit (0, 299 entries)
 * - createJob: Blocks insert at limit (300 entries) with STORAGE_LIMIT_EXCEEDED
 * - createJob: Blocks insert over limit (301 entries)
 * - createJob: Returns generic error if count query fails
 * - createJob: Treats null count as 0, allows insert
 * - createJob: Returns insert error when DB insert fails after limit check passes (edge case 1)
 * - createJob: Enforces limit dynamically from tier config, not a hardcoded value (edge case 2)
 * - createJob: Fails closed when maxJobs is undefined or null — requires defensive check (edge case 3)
 * - createJob: Catches unexpected throw from getStorargeLimitForTier (edge case 4)
 */

const mockFrom = jest.fn();

jest.mock('../../lib/supabaseServer.js', () => ({
  supabaseAdmin: {
    from: mockFrom,
  },
}));

jest.mock('../../../shared/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../../shared/constants/tiers.js', () => ({
  getStorargeLimitForTier: jest.fn().mockReturnValue({ maxJobs: 300 }),
  TIERS: { FREE: 'free' },
}));

const { createJob } = require('../jobService.js');
const { getStorargeLimitForTier: mockGetStorageLimitForTier } = require('../../../shared/constants/tiers.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds mock chain for the count-only query:
 *   supabaseAdmin.from('jobs').select('*', { count: 'exact', head: true }).eq('user_id', userId)
 */
function makeCountChain(count, error = null) {
  const eq = jest.fn().mockResolvedValue({ count, error });
  const select = jest.fn().mockReturnValue({ eq });
  return { select };
}

/**
 * Builds mock chain for the insert query:
 *   supabaseAdmin.from('jobs').insert({...}).select()
 */
function makeInsertChain(data, error = null) {
  const select = jest.fn().mockResolvedValue({ data, error });
  const insert = jest.fn().mockReturnValue({ select });
  return { insert };
}

const validJobData = { company: 'Acme', position: 'Engineer', status: 'applied' };
const userId = 'user-123';
const mockCreatedJob = { id: 'job-abc', ...validJobData, user_id: userId };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createJob - storage limit enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-apply default after clearAllMocks wipes it
    mockGetStorageLimitForTier.mockReturnValue({ maxJobs: 300 });
  });

  describe('when user is under the limit', () => {
    it('allows insert when user has 0 existing entries', async () => {
      mockFrom
        .mockReturnValueOnce(makeCountChain(0))
        .mockReturnValueOnce(makeInsertChain([mockCreatedJob]));

      const result = await createJob(validJobData, userId);

      expect(result.error).toBeNull();
      expect(result.data).toEqual([mockCreatedJob]);
      // Confirm insert was called (from() called twice)
      expect(mockFrom).toHaveBeenCalledTimes(2);
    });

    it('allows insert when user has 299 existing entries', async () => {
      mockFrom
        .mockReturnValueOnce(makeCountChain(299))
        .mockReturnValueOnce(makeInsertChain([mockCreatedJob]));

      const result = await createJob(validJobData, userId);

      expect(result.error).toBeNull();
      expect(result.data).toEqual([mockCreatedJob]);
      expect(mockFrom).toHaveBeenCalledTimes(2);
    });
  });

  describe('when user is at or over the limit', () => {
    it('blocks insert and returns STORAGE_LIMIT_EXCEEDED error at exactly 300 entries', async () => {
      mockFrom.mockReturnValueOnce(makeCountChain(300));

      const result = await createJob(validJobData, userId);

      expect(result.data).toBeNull();
      expect(result.error).not.toBeNull();
      expect(result.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(result.error.message).toContain('300');
      // Insert must NOT have been called
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });

    it('blocks insert when user has 301 entries', async () => {
      mockFrom.mockReturnValueOnce(makeCountChain(301));

      const result = await createJob(validJobData, userId);

      expect(result.data).toBeNull();
      expect(result.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the count query fails', () => {
    it('returns the count error without attempting an insert', async () => {
      const dbError = new Error('Connection timeout');
      mockFrom.mockReturnValueOnce(makeCountChain(null, dbError));

      const result = await createJob(validJobData, userId);

      expect(result.data).toBeNull();
      expect(result.error).toBe(dbError);
      // Insert must NOT have been called
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the count is null (no rows in DB)', () => {
    it('treats null count as 0 and allows insert', async () => {
      mockFrom
        .mockReturnValueOnce(makeCountChain(null))
        .mockReturnValueOnce(makeInsertChain([mockCreatedJob]));

      const result = await createJob(validJobData, userId);

      expect(result.error).toBeNull();
      expect(result.data).toEqual([mockCreatedJob]);
      expect(mockFrom).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge case 1: insert query fails after the limit check passes
  // ---------------------------------------------------------------------------

  describe('when the insert query fails after passing the limit check', () => {
    it('returns the insert error and does not return data', async () => {
      const insertError = new Error('DB constraint violation');
      mockFrom
        .mockReturnValueOnce(makeCountChain(0))
        .mockReturnValueOnce(makeInsertChain(null, insertError));

      const result = await createJob(validJobData, userId);

      expect(result.data).toBeNull();
      expect(result.error).toBe(insertError);
      // Both the count query and the insert query must have run
      expect(mockFrom).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge case 2: limit is read dynamically from getStorargeLimitForTier,
  //              not hardcoded to 300
  // ---------------------------------------------------------------------------

  describe('when the tier config supplies a non-default maxJobs', () => {
    it('blocks insert at the custom limit rather than the default 300', async () => {
      mockGetStorageLimitForTier.mockReturnValueOnce({ maxJobs: 5 });
      mockFrom.mockReturnValueOnce(makeCountChain(5));

      const result = await createJob(validJobData, userId);

      expect(result.data).toBeNull();
      expect(result.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });

    it('allows insert when count is below the custom limit', async () => {
      mockGetStorageLimitForTier.mockReturnValueOnce({ maxJobs: 5 });
      mockFrom
        .mockReturnValueOnce(makeCountChain(4))
        .mockReturnValueOnce(makeInsertChain([mockCreatedJob]));

      const result = await createJob(validJobData, userId);

      expect(result.error).toBeNull();
      expect(result.data).toEqual([mockCreatedJob]);
      expect(mockFrom).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge case 3: maxJobs is undefined or null (broken tier config)
  //
  // NOTE: These tests document DESIRED fail-closed behaviour.
  // They require a defensive check added to createJob BEFORE the count query:
  //   if (typeof maxJobs !== 'number' || maxJobs <= 0) {
  //     return { data: null, error: new Error('Storage limit configuration is invalid') };
  //   }
  // Without that check, (count ?? 0) >= undefined evaluates to false and the
  // service silently allows unlimited inserts.
  // ---------------------------------------------------------------------------

  describe('when the tier config returns an invalid maxJobs (fail-closed)', () => {
    it('returns a config error and does not run the count or insert query when maxJobs is undefined', async () => {
      mockGetStorageLimitForTier.mockReturnValueOnce({ maxJobs: undefined });

      const result = await createJob(validJobData, userId);

      expect(result.data).toBeNull();
      expect(result.error).not.toBeNull();
      // Fail closed: neither count nor insert should have been attempted
      expect(mockFrom).toHaveBeenCalledTimes(0);
    });

    it('returns a config error and does not run the count or insert query when maxJobs is null', async () => {
      mockGetStorageLimitForTier.mockReturnValueOnce({ maxJobs: null });

      const result = await createJob(validJobData, userId);

      expect(result.data).toBeNull();
      expect(result.error).not.toBeNull();
      expect(mockFrom).toHaveBeenCalledTimes(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge case 4: getStorargeLimitForTier throws unexpectedly
  //
  // The outer try/catch in createJob already handles this — no code change
  // required. This test pins the existing behaviour.
  // ---------------------------------------------------------------------------

  describe('when getStorargeLimitForTier throws unexpectedly', () => {
    it('catches the exception and returns an error without calling the database', async () => {
      mockGetStorageLimitForTier.mockImplementationOnce(() => {
        throw new Error('Config module failure');
      });

      const result = await createJob(validJobData, userId);

      expect(result.data).toBeNull();
      expect(result.error.message).toBe('Config module failure');
      // Neither the count query nor the insert should have been attempted
      expect(mockFrom).toHaveBeenCalledTimes(0);
    });
  });
});
