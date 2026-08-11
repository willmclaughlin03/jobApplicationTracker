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

const { api, apiRequest } = require('../api.js');

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

/**
 * Flushes mocked fetch/json promise continuations before timer assertions.
 *
 * @returns {Promise<void>}
 */
async function flushAsyncWork() {
    for (let step = 0; step < 20; step++) {
        await Promise.resolve();
    }
}

/**
 * Advances the currently scheduled retry timer after pending promises settle.
 *
 * @param {number} milliseconds - Fake milliseconds to advance.
 * @returns {Promise<void>}
 */
async function advanceRetryTimerBy(milliseconds) {
    await flushAsyncWork();
    await jest.advanceTimersByTimeAsync(milliseconds);
    await flushAsyncWork();
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

    /**
     * Subject/work cancellation must reach convenience methods so callers do
     * not need to bypass the shared API surface to supply an AbortSignal.
     */
    it('forwards caller options and AbortSignal through api.get', async () => {
        const controller = new AbortController();
        global.fetch = jest.fn().mockResolvedValue(mockFetchOnce(200, {}));

        await api.get('/api/jobs', { signal: controller.signal });

        expect(global.fetch).toHaveBeenCalledWith('/api/jobs', expect.objectContaining({
            method: 'GET',
            signal: controller.signal,
        }));
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

    it.each([
        ['post', '/api/jobs', { company: 'Acme' }],
        ['put', '/api/jobs/1', { company: 'Beta' }],
        ['delete', '/api/jobs/1', { reason: 'cleanup' }],
    ])('forwards caller options and AbortSignal through api.%s', async (
        methodName,
        endpoint,
        body
    ) => {
        const controller = new AbortController();
        global.fetch = jest.fn().mockResolvedValue(mockFetchOnce(200, {}));

        await api[methodName](endpoint, body, {
            signal: controller.signal,
            headers: { 'x-work-epoch': '7' },
        });

        expect(global.fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({
            signal: controller.signal,
            body: JSON.stringify(body),
            headers: expect.objectContaining({ 'x-work-epoch': '7' }),
        }));
    });
});

// =========================================================================
// SERVICE_UNAVAILABLE retry logic
// =========================================================================
describe('apiRequest - SERVICE_UNAVAILABLE retry', () => {
    let setTimeoutSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        clearCsrfCookie();
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
        setTimeoutSpy = jest.spyOn(global, 'setTimeout');
        jest.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    /**
     * Test: First attempt fails with SERVICE_UNAVAILABLE, second succeeds.
     */
    it('retries on SERVICE_UNAVAILABLE and returns data on success', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce(mockFetchOnce(503, { error: 'SERVICE_UNAVAILABLE' }, false))
            .mockResolvedValueOnce(mockFetchOnce(200, { jobs: [] }));

        const requestPromise = apiRequest('/api/jobs', { method: 'GET' });

        await flushAsyncWork();
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 500);
        expect(global.fetch).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(499);
        expect(global.fetch).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        const { data, error } = await requestPromise;

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(error).toBeNull();
        expect(data).toEqual({ jobs: [] });
    });

    /**
     * Test: All attempts return SERVICE_UNAVAILABLE; last response body wins.
     */
    it('stops after max retries and returns the last response', async () => {
        global.fetch = jest.fn().mockResolvedValue(
            mockFetchOnce(503, { error: 'SERVICE_UNAVAILABLE' }, false)
        );

        const requestPromise = apiRequest('/api/jobs', { method: 'GET' });

        await flushAsyncWork();
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 500);

        await advanceRetryTimerBy(500);
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1000);

        await jest.advanceTimersByTimeAsync(1000);
        const { data, meta } = await requestPromise;

        expect(global.fetch).toHaveBeenCalledTimes(3);
        expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
        expect(data).toEqual({ error: 'SERVICE_UNAVAILABLE' });
        expect(meta).toEqual({
            status: 503,
            retryAfterSeconds: null,
        });
    });

    /**
     * Test: Numeric Retry-After remains the minimum retry delay.
     */
    it('does not undercut numeric Retry-After as the retry delay', async () => {
        Math.random.mockReturnValue(0);
        global.fetch = jest.fn()
            .mockResolvedValueOnce(mockFetchOnce(
                503,
                { error: 'SERVICE_UNAVAILABLE' },
                false,
                { 'retry-after': '3' }
            ))
            .mockResolvedValueOnce(mockFetchOnce(200, { jobs: [] }));

        const requestPromise = apiRequest('/api/jobs', { method: 'GET' });

        await flushAsyncWork();
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 3000);

        await jest.advanceTimersByTimeAsync(2999);
        expect(global.fetch).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        const { data } = await requestPromise;

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(data).toEqual({ jobs: [] });
    });

    /**
     * Test: HTTP-date Retry-After uses additive jitter without retrying early.
     */
    it('uses additive-jittered date-form Retry-After as the retry delay', async () => {
        Math.random.mockReturnValue(0.75);
        const retryAt = new Date(Date.now() + 4000).toUTCString();
        global.fetch = jest.fn()
            .mockResolvedValueOnce(mockFetchOnce(
                503,
                { error: 'SERVICE_UNAVAILABLE' },
                false,
                { 'retry-after': retryAt }
            ))
            .mockResolvedValueOnce(mockFetchOnce(200, { jobs: [] }));

        const requestPromise = apiRequest('/api/jobs', { method: 'GET' });

        await flushAsyncWork();
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 4750);

        await advanceRetryTimerBy(4750);
        const { data } = await requestPromise;

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(data).toEqual({ jobs: [] });
    });

    /**
     * Test: Very long Retry-After values remain capped after additive jitter.
     */
    it('caps additive-jittered very long Retry-After delays', async () => {
        Math.random.mockReturnValue(0.25);
        global.fetch = jest.fn()
            .mockResolvedValueOnce(mockFetchOnce(
                503,
                { error: 'SERVICE_UNAVAILABLE' },
                false,
                { 'retry-after': '120' }
            ))
            .mockResolvedValueOnce(mockFetchOnce(200, { jobs: [] }));

        const requestPromise = apiRequest('/api/jobs', { method: 'GET' });

        await flushAsyncWork();
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 8000);

        await advanceRetryTimerBy(8000);
        const { data } = await requestPromise;

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(data).toEqual({ jobs: [] });
    });

    /**
     * Test: Backoff and jitter are used when Retry-After is absent.
     */
    it('uses jittered exponential backoff without Retry-After', async () => {
        Math.random.mockReturnValue(0.75);
        global.fetch = jest.fn()
            .mockResolvedValueOnce(mockFetchOnce(503, { error: 'SERVICE_UNAVAILABLE' }, false))
            .mockResolvedValueOnce(mockFetchOnce(503, { error: 'SERVICE_UNAVAILABLE' }, false))
            .mockResolvedValueOnce(mockFetchOnce(200, { jobs: [] }));

        const requestPromise = apiRequest('/api/jobs', { method: 'GET' });

        await flushAsyncWork();
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 563);

        await advanceRetryTimerBy(563);
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1125);

        await advanceRetryTimerBy(1125);
        const { data } = await requestPromise;

        expect(global.fetch).toHaveBeenCalledTimes(3);
        expect(data).toEqual({ jobs: [] });
    });

    /**
     * Test: Retry-After alone does not make other errors retryable.
     */
    it('does not retry non-SERVICE_UNAVAILABLE errors', async () => {
        global.fetch = jest.fn().mockResolvedValue(
            mockFetchOnce(
                503,
                { error: 'BILLING_RECONCILIATION_PENDING' },
                false,
                { 'retry-after': '5' }
            )
        );

        const { data, meta } = await apiRequest('/api/jobs', { method: 'GET' });

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(setTimeoutSpy).not.toHaveBeenCalled();
        expect(data).toEqual({ error: 'BILLING_RECONCILIATION_PENDING' });
        expect(meta).toEqual({
            status: 503,
            retryAfterSeconds: 5,
        });
    });

    /**
     * Test: 429 Retry-After metadata is exposed but not retried.
     */
    it('surfaces Retry-After metadata on rate-limited responses without retrying', async () => {
        global.fetch = jest.fn().mockResolvedValue(
            mockFetchOnce(
                429,
                { error: 'RATE_LIMIT_EXCEEDED' },
                false,
                { 'retry-after': '45' }
            )
        );

        const { data, error, meta } = await apiRequest('/api/jobs', { method: 'GET' });

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(setTimeoutSpy).not.toHaveBeenCalled();
        expect(error).toBeNull();
        expect(data).toEqual({ error: 'RATE_LIMIT_EXCEEDED' });
        expect(meta).toEqual({
            status: 429,
            retryAfterSeconds: 45,
        });
    });

    /**
     * Numeric prefixes and non-integer numeric forms are not valid complete
     * delta-seconds values and must not influence client retry scheduling.
     */
    it.each(['5junk', '+5', '-1', '1.5'])(
        'rejects malformed Retry-After value %s',
        async (retryAfter) => {
            global.fetch = jest.fn().mockResolvedValue(
                mockFetchOnce(
                    429,
                    { error: 'RATE_LIMIT_EXCEEDED' },
                    false,
                    { 'retry-after': retryAfter }
                )
            );

            const { meta } = await apiRequest('/api/jobs', { method: 'GET' });

            expect(meta.retryAfterSeconds).toBeNull();
        }
    );

    /**
     * Aborting during backoff must clear the wait and prevent the next fetch
     * so a subject/work epoch shutdown completes promptly.
     */
    it('aborts an in-flight retry sleep without dispatching another request', async () => {
        const controller = new AbortController();
        const addAbortListenerSpy = jest.spyOn(controller.signal, 'addEventListener');
        const removeAbortListenerSpy = jest.spyOn(controller.signal, 'removeEventListener');
        global.fetch = jest.fn().mockResolvedValue(
            mockFetchOnce(503, { error: 'SERVICE_UNAVAILABLE' }, false)
        );
        let settled = false;

        const requestPromise = apiRequest('/api/jobs', {
            method: 'GET',
            signal: controller.signal,
        }).then((result) => {
            settled = true;
            return result;
        });

        await flushAsyncWork();
        controller.abort();
        await flushAsyncWork();

        try {
            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(settled).toBe(true);
            expect(jest.getTimerCount()).toBe(0);
            await jest.advanceTimersByTimeAsync(10_000);
            expect(global.fetch).toHaveBeenCalledTimes(1);
            const usesOneShotListener = addAbortListenerSpy.mock.calls.some(
                ([eventName, _listener, options]) => (
                    eventName === 'abort' && options?.once === true
                )
            );
            const removesListenerExplicitly = removeAbortListenerSpy.mock.calls.some(
                ([eventName, listener]) => (
                    eventName === 'abort' && typeof listener === 'function'
                )
            );
            expect(usesOneShotListener || removesListenerExplicitly).toBe(true);
            await requestPromise;
        } finally {
            jest.clearAllTimers();
        }
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

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
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

    it('propagates one AbortSignal through the CSRF refresh and retry', async () => {
        const controller = new AbortController();
        setCsrfCookie('stale-token');
        global.fetch = jest.fn()
            .mockResolvedValueOnce(mockFetchOnce(403, { error: 'CSRF_VALIDATION_FAILED' }, false))
            .mockImplementationOnce(async () => {
                setCsrfCookie('fresh-token');
                return mockFetchOnce(200, null);
            })
            .mockResolvedValueOnce(mockFetchOnce(200, { ok: true }));

        await apiRequest('/api/jobs', {
            method: 'POST',
            body: '{}',
            signal: controller.signal,
        });

        expect(global.fetch).toHaveBeenNthCalledWith(1, '/api/jobs', expect.objectContaining({
            signal: controller.signal,
        }));
        expect(global.fetch).toHaveBeenNthCalledWith(2, '/api/auth/csrf', expect.objectContaining({
            signal: controller.signal,
        }));
        expect(global.fetch).toHaveBeenNthCalledWith(3, '/api/jobs', expect.objectContaining({
            signal: controller.signal,
        }));
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

    /**
     * Test: CSRF refresh starts a fresh SERVICE_UNAVAILABLE retry execution.
     */
    it('uses a fresh SERVICE_UNAVAILABLE retry budget after CSRF refresh', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
        const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
        jest.spyOn(Math, 'random').mockReturnValue(0.5);
        setCsrfCookie('stale-token');

        global.fetch = jest.fn()
            .mockResolvedValueOnce(mockFetchOnce(403, { error: 'CSRF_VALIDATION_FAILED' }, false))
            .mockImplementationOnce(async (url) => {
                expect(url).toBe('/api/auth/csrf');
                setCsrfCookie('fresh-token');
                return mockFetchOnce(200, null);
            })
            .mockResolvedValueOnce(mockFetchOnce(503, { error: 'SERVICE_UNAVAILABLE' }, false))
            .mockResolvedValueOnce(mockFetchOnce(503, { error: 'SERVICE_UNAVAILABLE' }, false))
            .mockResolvedValueOnce(mockFetchOnce(200, { ok: true }));

        const requestPromise = apiRequest('/api/jobs', { method: 'POST', body: '{}' });

        await flushAsyncWork();
        expect(global.fetch).toHaveBeenCalledTimes(3);
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 500);

        await advanceRetryTimerBy(500);
        expect(global.fetch).toHaveBeenCalledTimes(4);
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1000);

        await advanceRetryTimerBy(1000);
        const { data } = await requestPromise;

        expect(global.fetch).toHaveBeenCalledTimes(5);
        expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
        expect(global.fetch.mock.calls[4][1].headers['x-csrf-token']).toBe('fresh-token');
        expect(data).toEqual({ ok: true });
    });
});
