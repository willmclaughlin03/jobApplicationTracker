/**
 * Tests for apiRequest
 *
 * Purpose: Verify authenticated API request handling, including session expiry
 *          behaviour, Authorization header injection, retry logic, and error propagation.
 *
 * Connects to: src/client/lib/api.js
 *
 * Test coverage:
 * - Successful authenticated request — data returned, correct headers sent
 * - No session → signOut() called, UNAUTHORIZED returned, fetch not called
 * - Session error → signOut() called, UNAUTHORIZED returned
 * - Valid session → signOut() never called
 * - SERVICE_UNAVAILABLE retry logic (recovers on second attempt)
 * - Retries exhausted — last response returned after MAX_CLIENT_RETRIES attempts
 * - Non-SERVICE_UNAVAILABLE error — no retry
 * - fetch throws — FETCH_FAILED returned
 */

jest.mock('../supabase.js', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      signOut: jest.fn(),
    },
  },
}));

const { supabase } = require('../supabase.js');
const { apiRequest } = require('../api.js');
const { ERROR_MESSAGES } = require('../../../shared/errors.js');

const VALID_SESSION = {
  user: { id: 'user-123' },
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
};

describe('apiRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    supabase.auth.signOut.mockResolvedValue({});
  });

  // =========================================================================
  // Successful requests
  // =========================================================================
  describe('successful request', () => {
    /**
     * Test: Valid session — fetch is called and response data returned
     * Reasoning: Happy path; session exists, fetch succeeds, body is returned as data
     */
    it('should return data from a successful authenticated fetch', async () => {
      supabase.auth.getSession.mockResolvedValue({ data: { session: VALID_SESSION }, error: null });
      const responseData = { jobs: [{ id: 1 }] };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(responseData),
      });

      const { data, error } = await apiRequest('/api/jobs');

      expect(error).toBeNull();
      expect(data).toEqual(responseData);
    });

    /**
     * Test: Authorization header is set using the session access_token
     * Reasoning: Server validates the Bearer token — must match the session's access_token
     */
    it('should include an Authorization Bearer header from the session access_token', async () => {
      supabase.auth.getSession.mockResolvedValue({ data: { session: VALID_SESSION }, error: null });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({}),
      });

      await apiRequest('/api/jobs');

      const [, fetchOptions] = global.fetch.mock.calls[0];
      expect(fetchOptions.headers['Authorization']).toBe(`Bearer ${VALID_SESSION.access_token}`);
    });

    /**
     * Test: Caller-supplied method and body are forwarded to fetch
     * Reasoning: Callers pass method/body via options; they must survive the header merge
     */
    it('should forward caller method and body options to fetch', async () => {
      supabase.auth.getSession.mockResolvedValue({ data: { session: VALID_SESSION }, error: null });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({}),
      });

      const body = JSON.stringify({ company: 'Acme' });
      await apiRequest('/api/jobs', { method: 'POST', body });

      const [, fetchOptions] = global.fetch.mock.calls[0];
      expect(fetchOptions.method).toBe('POST');
      expect(fetchOptions.body).toBe(body);
    });

    /**
     * Test: Valid session — signOut is never called
     * Reasoning: signOut is only for expired-session cleanup; must not fire on normal requests
     */
    it('should not call signOut when the session is valid', async () => {
      supabase.auth.getSession.mockResolvedValue({ data: { session: VALID_SESSION }, error: null });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({}),
      });

      await apiRequest('/api/jobs');

      expect(supabase.auth.signOut).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Session expiry / no session
  // =========================================================================
  describe('session expiry', () => {
    /**
     * Test: No session — signOut() called to clear stale local state
     * Reasoning: signOut() triggers onAuthStateChange → SIGNED_OUT so the UI redirects to login
     */
    it('should call signOut() when getSession returns no session', async () => {
      supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });

      await apiRequest('/api/jobs');

      expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    });

    /**
     * Test: No session — UNAUTHORIZED error returned
     * Reasoning: Caller needs the error so it can react if the redirect has not yet fired
     */
    it('should return UNAUTHORIZED when session is null', async () => {
      supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });

      const { data, error } = await apiRequest('/api/jobs');

      expect(data).toBeNull();
      expect(error).toBe(ERROR_MESSAGES.UNAUTHORIZED);
    });

    /**
     * Test: No session — fetch is never called
     * Reasoning: No valid token means there is no point hitting the network
     */
    it('should not call fetch when session is null', async () => {
      supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
      global.fetch = jest.fn();

      await apiRequest('/api/jobs');

      expect(global.fetch).not.toHaveBeenCalled();
    });

    /**
     * Test: getSession error — signOut() called
     * Reasoning: A session error is treated the same as no session; stale state must be cleared
     */
    it('should call signOut() when getSession returns an error', async () => {
      supabase.auth.getSession.mockResolvedValue({
        data: { session: null },
        error: { message: 'refresh failed' },
      });

      await apiRequest('/api/jobs');

      expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    });

    /**
     * Test: getSession error — UNAUTHORIZED returned
     * Reasoning: Error path must surface the same UNAUTHORIZED message as the no-session path
     */
    it('should return UNAUTHORIZED when getSession returns an error', async () => {
      supabase.auth.getSession.mockResolvedValue({
        data: { session: null },
        error: { message: 'refresh failed' },
      });

      const { data, error } = await apiRequest('/api/jobs');

      expect(data).toBeNull();
      expect(error).toBe(ERROR_MESSAGES.UNAUTHORIZED);
    });
  });

  // =========================================================================
  // Retry logic (SERVICE_UNAVAILABLE)
  // =========================================================================
  describe('SERVICE_UNAVAILABLE retry', () => {
    /**
     * Test: First attempt returns SERVICE_UNAVAILABLE, second succeeds — data returned
     * Reasoning: Redis cold-start scenario; one retry must recover cleanly
     */
    it('should retry on SERVICE_UNAVAILABLE and return data on success', async () => {
      supabase.auth.getSession.mockResolvedValue({ data: { session: VALID_SESSION }, error: null });
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: false,
          json: jest.fn().mockResolvedValue({ error: 'SERVICE_UNAVAILABLE' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue({ jobs: [] }),
        });

      const { data, error } = await apiRequest('/api/jobs');

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(error).toBeNull();
      expect(data).toEqual({ jobs: [] });
    });

    /**
     * Test: All attempts return SERVICE_UNAVAILABLE — last response data returned
     * Reasoning: After MAX_CLIENT_RETRIES (2) exhausted, loop breaks and returns last received body
     * Note: This test takes ~1s due to retry delays (2 × 500 ms) — intentional behaviour
     */
    it('should stop after max retries and return the last response', async () => {
      supabase.auth.getSession.mockResolvedValue({ data: { session: VALID_SESSION }, error: null });
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: jest.fn().mockResolvedValue({ error: 'SERVICE_UNAVAILABLE' }),
      });

      const { data } = await apiRequest('/api/jobs');

      // MAX_CLIENT_RETRIES = 2 → 3 total attempts (attempt 0, 1, 2)
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(data).toEqual({ error: 'SERVICE_UNAVAILABLE' });
    });

    /**
     * Test: Non-SERVICE_UNAVAILABLE error — no retry
     * Reasoning: Retries are exclusively for Redis cold-start; a 404 or 401 must not be retried
     */
    it('should not retry on non-SERVICE_UNAVAILABLE errors', async () => {
      supabase.auth.getSession.mockResolvedValue({ data: { session: VALID_SESSION }, error: null });
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: jest.fn().mockResolvedValue({ error: 'NOT_FOUND' }),
      });

      await apiRequest('/api/jobs');

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Network errors
  // =========================================================================
  describe('network errors', () => {
    /**
     * Test: fetch throws — FETCH_FAILED returned
     * Reasoning: Network failure (offline, DNS error) must be caught and surfaced cleanly
     */
    it('should return FETCH_FAILED when fetch throws', async () => {
      supabase.auth.getSession.mockResolvedValue({ data: { session: VALID_SESSION }, error: null });
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const { data, error } = await apiRequest('/api/jobs');

      expect(data).toBeNull();
      expect(error).toBe(ERROR_MESSAGES.FETCH_FAILED);
    });
  });
});
