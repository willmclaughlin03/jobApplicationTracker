/**
 * @jest-environment jsdom
 *
 * Tests for apiRequest (cookie-based auth)
 *
 * Purpose: Verify authenticated API request handling, including CSRF header
 * injection, CSRF retry logic, SERVICE_UNAVAILABLE retry, and error propagation.
 *
 * Connects to: src/client/lib/api.js
 *
 * Auth model: Cookie-based (httpOnly). No Authorization header is set client-side;
 * the browser sends auth cookies automatically via credentials: 'same-origin'.
 *
 * Test coverage:
 * - Successful GET — data returned, no CSRF header, credentials forwarded
 * - Successful POST — x-csrf-token header read from cookie
 * - POST with no cookie — x-csrf-token header absent (not null/undefined sent)
 * - 401 response → UNAUTHORIZED returned
 * - SERVICE_UNAVAILABLE retry — recovers on second attempt
 * - Retries exhausted — last response returned after MAX_CLIENT_RETRIES
 * - Non-SERVICE_UNAVAILABLE error — no retry
 * - CSRF_VALIDATION_FAILED — refreshes token and retries once
 * - CSRF refresh fails — original 403 returned, not the refresh error
 * - fetch throws — FETCH_FAILED returned
 */

const { ERROR_MESSAGES } = require('../../../shared/errors.js');

// Mock the CSRF constants module so tests are not coupled to NODE_ENV
jest.mock('../../../shared/constants/csrf.js', () => ({
    CSRF_COOKIE_NAME: 'csrf-token',
}));

const { apiRequest } = require('../api.js');

// =========================================================================
// Helpers
// =========================================================================

function mockFetchOnce(status, body, ok = status < 400, headers = {}) {
    return {
        ok,
        status,
        headers: {
            get: jest.fn((name) => {
                const normalizedName = typeof name === 'string' ? name.toLowerCase() : '';
                return headers[normalizedName] ?? null;
            }),
        },
        json: jest.fn().mockResolvedValue(body),
    };
}

function setCsrfCookie(value) {
    Object.defineProperty(document, 'cookie', {
        writable: true,
        value: `csrf-token=${value}`,
    });
}

function clearCsrfCookie() {
    Object.defineProperty(document, 'cookie', {
        writable: true,
        value: '',
    });
}

// =========================================================================
// GET requests (no CSRF)
// =========================================================================
describe('apiRequest — GET requests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearCsrfCookie();
    });

    /**
     * Test: Happy path — data is returned and error is null
     */
    it('returns data from a successful GET', async () => {
        const responseData = { jobs: [{ id: 1 }] };
        global.fetch = jest.fn().mockResolvedValue(mockFetchOnce(200, responseData));

        const { data, error, meta } = await apiRequest('/api/jobs', { method: 'GET' });

        expect(error).toBeNull();
        expect(data).toEqual(responseData);
        expect(meta).toEqual({
            status: 200,
            retryAfterSeconds: null,
        });
    });

    /**
     * Test: credentials: 'same-origin' is always set so auth cookies are sent
     */
    it('sends credentials: same-origin on GET', async () => {
        global.fetch = jest.fn().mockResolvedValue(mockFetchOnce(200, {}));

        await apiRequest('/api/jobs', { method: 'GET' });

        const [, opts] = global.fetch.mock.calls[0];
        expect(opts.credentials).toBe('same-origin');
    });

    /**
     * Test: x-csrf-token header is NOT set on GET (read-only, no state change)
     */
    it('does not send x-csrf-token on GET', async () => {
        setCsrfCookie('some-token');
        global.fetch = jest.fn().mockResolvedValue(mockFetchOnce(200, {}));

        await apiRequest('/api/jobs', { method: 'GET' });

        const [, opts] = global.fetch.mock.calls[0];
        expect(opts.headers['x-csrf-token']).toBeUndefined();
    });

    /**
     * Test: 401 response → UNAUTHORIZED error regardless of body
     */
    it('returns UNAUTHORIZED on 401', async () => {
        global.fetch = jest.fn().mockResolvedValue(mockFetchOnce(401, { error: 'UNAUTHORIZED' }, false));

        const { data, error, meta } = await apiRequest('/api/jobs', { method: 'GET' });

        expect(data).toBeNull();
        expect(error).toBe(ERROR_MESSAGES.UNAUTHORIZED);
        expect(meta).toEqual({
            status: 401,
            retryAfterSeconds: null,
        });
    });

    /**
     * Test: fetch throws → FETCH_FAILED returned
     */
    it('returns FETCH_FAILED when fetch throws', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

        const { data, error, meta } = await apiRequest('/api/jobs', { method: 'GET' });

        expect(data).toBeNull();
        expect(error).toBe(ERROR_MESSAGES.FETCH_FAILED);
        expect(meta).toEqual({
            status: null,
            retryAfterSeconds: null,
        });
    });
});

// =========================================================================
// POST/PUT/DELETE/PATCH requests (CSRF required)
// =========================================================================
describe('apiRequest — state-changing requests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearCsrfCookie();
    });

    /**
     * Test: x-csrf-token header is set from the cookie for POST
     */
    it('sends x-csrf-token header on POST using cookie value', async () => {
        setCsrfCookie('my-csrf-token');
        global.fetch = jest.fn().mockResolvedValue(mockFetchOnce(200, {}));

        await apiRequest('/api/jobs', { method: 'POST', body: '{}' });

        const [, opts] = global.fetch.mock.calls[0];
        expect(opts.headers['x-csrf-token']).toBe('my-csrf-token');
    });

    /**
     * Test: x-csrf-token is sent for PUT, DELETE, PATCH too
     */
    it.each(['PUT', 'DELETE', 'PATCH'])(
        'sends x-csrf-token header on %s',
        async (method) => {
            setCsrfCookie('token-for-' + method);
            global.fetch = jest.fn().mockResolvedValue(mockFetchOnce(200, {}));

            await apiRequest('/api/jobs/1', { method });

            const [, opts] = global.fetch.mock.calls[0];
            expect(opts.headers['x-csrf-token']).toBe('token-for-' + method);
        }
    );

    /**
     * Test: If cookie is absent, x-csrf-token is not sent (falsy getCookie result)
     */
    it('does not send x-csrf-token header when cookie is absent', async () => {
        clearCsrfCookie();
        global.fetch = jest.fn().mockResolvedValue(mockFetchOnce(200, {}));

        await apiRequest('/api/jobs', { method: 'POST', body: '{}' });

        const [, opts] = global.fetch.mock.calls[0];
        expect(opts.headers['x-csrf-token']).toBeUndefined();
    });

    /**
     * Test: Caller-supplied method and body are forwarded to fetch
     */
    it('forwards method and body to fetch', async () => {
        global.fetch = jest.fn().mockResolvedValue(mockFetchOnce(200, {}));
        const body = JSON.stringify({ company: 'Acme' });

        await apiRequest('/api/jobs', { method: 'POST', body });

        const [, opts] = global.fetch.mock.calls[0];
        expect(opts.method).toBe('POST');
        expect(opts.body).toBe(body);
    });
});

// =========================================================================
// SERVICE_UNAVAILABLE retry logic
// =========================================================================
describe('apiRequest — SERVICE_UNAVAILABLE retry', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearCsrfCookie();
    });

    /**
     * Test: First attempt fails with SERVICE_UNAVAILABLE, second succeeds
     */
    it('retries on SERVICE_UNAVAILABLE and returns data on success', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce(mockFetchOnce(503, { error: 'SERVICE_UNAVAILABLE' }, false))
            .mockResolvedValueOnce(mockFetchOnce(200, { jobs: [] }));

        const { data, error } = await apiRequest('/api/jobs', { method: 'GET' });

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(error).toBeNull();
        expect(data).toEqual({ jobs: [] });
    });

    /**
     * Test: All attempts return SERVICE_UNAVAILABLE — last response body returned
     * Note: This test takes ~1s due to retry delays (2 × 500 ms) — intentional
     */
    it('stops after max retries and returns the last response', async () => {
        global.fetch = jest.fn().mockResolvedValue(
            mockFetchOnce(503, { error: 'SERVICE_UNAVAILABLE' }, false)
        );

        const { data, meta } = await apiRequest('/api/jobs', { method: 'GET' });

        // MAX_CLIENT_RETRIES = 2 → 3 total attempts (attempt 0, 1, 2)
        expect(global.fetch).toHaveBeenCalledTimes(3);
        expect(data).toEqual({ error: 'SERVICE_UNAVAILABLE' });
        expect(meta).toEqual({
            status: 503,
            retryAfterSeconds: null,
        });
    }, 10000);

    /**
     * Test: Non-SERVICE_UNAVAILABLE error — no retry
     */
    it('does not retry on non-SERVICE_UNAVAILABLE errors', async () => {
        global.fetch = jest.fn().mockResolvedValue(
            mockFetchOnce(404, { error: 'NOT_FOUND' }, false)
        );

        await apiRequest('/api/jobs', { method: 'GET' });

        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('surfaces Retry-After metadata on rate-limited responses', async () => {
        global.fetch = jest.fn().mockResolvedValue(
            mockFetchOnce(
                429,
                { error: 'RATE_LIMIT_EXCEEDED' },
                false,
                { 'retry-after': '45' }
            )
        );

        const { data, error, meta } = await apiRequest('/api/jobs', { method: 'GET' });

        expect(error).toBeNull();
        expect(data).toEqual({ error: 'RATE_LIMIT_EXCEEDED' });
        expect(meta).toEqual({
            status: 429,
            retryAfterSeconds: 45,
        });
    });
});

// =========================================================================
// CSRF retry logic
// =========================================================================
describe('apiRequest — CSRF retry', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearCsrfCookie();
    });

    /**
     * Test: CSRF_VALIDATION_FAILED → fetch /api/auth/csrf → retry with new token
     * The retry succeeds, so the final result is the second fetch's response.
     */
    it('refreshes CSRF token and retries once on CSRF_VALIDATION_FAILED', async () => {
        setCsrfCookie('stale-token');

        global.fetch = jest.fn()
            // First POST → 403 CSRF_VALIDATION_FAILED
            .mockResolvedValueOnce(mockFetchOnce(403, { error: 'CSRF_VALIDATION_FAILED' }, false))
            // CSRF refresh → 200
            .mockResolvedValueOnce(mockFetchOnce(200, null))
            // Retry POST → 200
            .mockResolvedValueOnce(mockFetchOnce(200, { ok: true }));

        // After the refresh, simulate a new cookie value being set
        global.fetch.mockImplementationOnce(async (url) => {
            if (url === '/api/auth/csrf') {
                setCsrfCookie('fresh-token');
                return mockFetchOnce(200, null);
            }
        });

        // Re-define fetch with the correct sequencing
        global.fetch = jest.fn()
            .mockResolvedValueOnce(mockFetchOnce(403, { error: 'CSRF_VALIDATION_FAILED' }, false))
            .mockImplementationOnce(async (url) => {
                // This is the CSRF refresh call
                expect(url).toBe('/api/auth/csrf');
                setCsrfCookie('fresh-token');
                return { ok: true, json: jest.fn().mockResolvedValue(null) };
            })
            .mockResolvedValueOnce(mockFetchOnce(200, { ok: true }));

        const { data } = await apiRequest('/api/jobs', { method: 'POST', body: '{}' });

        expect(global.fetch).toHaveBeenCalledTimes(3);
        // Retry must use the refreshed token
        const retryOpts = global.fetch.mock.calls[2][1];
        expect(retryOpts.headers['x-csrf-token']).toBe('fresh-token');
        expect(data).toEqual({ ok: true });
    });

    /**
     * Test: CSRF refresh fails → return the original 403, not the refresh error
     */
    it('returns original 403 when CSRF refresh fails', async () => {
        setCsrfCookie('bad-token');
        const original403 = { error: 'CSRF_VALIDATION_FAILED' };

        global.fetch = jest.fn()
            .mockResolvedValueOnce(mockFetchOnce(403, original403, false))
            .mockRejectedValueOnce(new Error('Network error during refresh'));

        const { data } = await apiRequest('/api/jobs', { method: 'POST', body: '{}' });

        expect(data).toEqual(original403);
    });

    /**
     * Test: CSRF_VALIDATION_FAILED on GET is not retried (GET is exempt)
     */
    it('does not trigger CSRF retry for GET requests', async () => {
        global.fetch = jest.fn().mockResolvedValue(
            mockFetchOnce(403, { error: 'CSRF_VALIDATION_FAILED' }, false)
        );

        await apiRequest('/api/jobs', { method: 'GET' });

        // Only the original request — no CSRF refresh call
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});
