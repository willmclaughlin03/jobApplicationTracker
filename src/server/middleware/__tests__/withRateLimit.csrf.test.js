/**
 * CSRF integration tests for withRateLimit middleware
 *
 * Purpose: Verify that CSRF validation is applied correctly for state-changing
 * methods and that the csrfProtect option overrides the default behaviour.
 *
 * Connects to: src/server/middleware/withRateLimit.js
 *
 * Test coverage:
 * - POST on protected route: rejected when CSRF token missing (403)
 * - POST on protected route: accepted when valid CSRF token present
 * - GET on protected route: CSRF check skipped (GET is read-only)
 * - csrfProtect: false: skips CSRF even for POST
 * - requireAuth: false (public route): no CSRF by default
 * - explicit csrfProtect: true with requireAuth: false: enforces CSRF
 */

const mockGetUserFromRequest = jest.fn();
jest.mock('../../lib/supabaseServer.js', () => ({
    getUserFromRequest: mockGetUserFromRequest,
}));

const mockCheckRateLimit = jest.fn();
jest.mock('../../lib/rateLimit.js', () => ({
    checkRateLimit: mockCheckRateLimit,
}));

const mockValidateCsrfToken = jest.fn();
jest.mock('../../lib/csrf.js', () => ({
    validateCsrfToken: mockValidateCsrfToken,
}));

jest.mock('../../../shared/logger.js', () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    },
}));

const { withRateLimit } = require('../withRateLimit.js');

describe('withRateLimit — CSRF integration', () => {
    const mockUser = { id: 'user-csrf-test', email: 'test@example.com' };

    const createMockRequest = (method, headers = {}) => ({
        method,
        headers: { ...headers },
        cookies: {},
        socket: { remoteAddress: '127.0.0.1' },
    });

    const createMockResponse = () => ({
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn(),
        getHeader: jest.fn().mockReturnValue([]),
        end: jest.fn().mockReturnThis(),
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetUserFromRequest.mockResolvedValue({ user: mockUser, error: null });
        mockCheckRateLimit.mockResolvedValue({
            success: true,
            limit: 100,
            remaining: 99,
            reset: Date.now() + 3600000,
            window: 'hourly',
        });
        // Default: valid CSRF token
        mockValidateCsrfToken.mockReturnValue(true);
    });

    // =========================================================================
    // Protected POST — CSRF required by default
    // =========================================================================
    describe('protected route with requireAuth: true (default)', () => {
        /**
         * Test: POST without a valid CSRF token returns 403
         * Verifies: Default behaviour — CSRF is enforced on protected state-changing routes
         */
        it('rejects POST when CSRF token is missing/invalid (403)', async () => {
            mockValidateCsrfToken.mockReturnValue(false);
            const req = createMockRequest('POST');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { allowedMethods: ['POST'] })(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'CSRF_VALIDATION_FAILED' })
            );
            expect(handler).not.toHaveBeenCalled();
            // Rate limit quota must NOT be consumed
            expect(mockCheckRateLimit).not.toHaveBeenCalled();
        });

        /**
         * Test: POST with a valid CSRF token passes through to handler
         * Verifies: Happy path — good token → auth → rate limit → handler
         */
        it('passes POST when CSRF token is valid', async () => {
            mockValidateCsrfToken.mockReturnValue(true);
            const req = createMockRequest('POST');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { allowedMethods: ['POST'] })(req, res);

            expect(handler).toHaveBeenCalledWith(req, res);
            expect(res.status).not.toHaveBeenCalledWith(403);
        });

        /**
         * Test: PUT and DELETE also require CSRF
         * Verifies: All state-changing methods are protected
         */
        it.each(['PUT', 'DELETE', 'PATCH'])(
            'rejects %s when CSRF token is invalid',
            async (method) => {
                mockValidateCsrfToken.mockReturnValue(false);
                const req = createMockRequest(method);
                const res = createMockResponse();
                const handler = jest.fn();

                await withRateLimit(handler, { allowedMethods: [method] })(req, res);

                expect(res.status).toHaveBeenCalledWith(403);
                expect(handler).not.toHaveBeenCalled();
            }
        );

        /**
         * Test: GET is exempt from CSRF (read-only, no state change)
         * Verifies: validateCsrfToken is never called for GET requests
         */
        it('skips CSRF check for GET requests', async () => {
            const req = createMockRequest('GET');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { allowedMethods: ['GET'] })(req, res);

            expect(mockValidateCsrfToken).not.toHaveBeenCalled();
            expect(handler).toHaveBeenCalled();
        });

        /**
         * Test: CSRF validation receives the authenticated userId
         * Verifies: Token is bound to the correct user from req._rateLimitUser
         */
        it('passes userId from req._rateLimitUser to validateCsrfToken', async () => {
            const req = createMockRequest('POST');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, { allowedMethods: ['POST'] })(req, res);

            expect(mockValidateCsrfToken).toHaveBeenCalledWith(req, mockUser.id);
        });
    });

    // =========================================================================
    // csrfProtect: false — explicit opt-out
    // =========================================================================
    describe('csrfProtect: false', () => {
        /**
         * Test: csrfProtect: false skips CSRF even for POST on a protected route
         * Use case: the /api/auth/csrf endpoint itself (circular dependency avoidance)
         */
        it('skips CSRF validation when csrfProtect: false', async () => {
            mockValidateCsrfToken.mockReturnValue(false); // would fail if called
            const req = createMockRequest('POST');
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                requireAuth: true,
                csrfProtect: false,
                allowedMethods: ['POST'],
            })(req, res);

            expect(mockValidateCsrfToken).not.toHaveBeenCalled();
            expect(handler).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Public route (requireAuth: false) — no CSRF by default
    // =========================================================================
    describe('requireAuth: false (public route)', () => {
        /**
         * Test: Public routes do NOT enforce CSRF by default
         * Rationale: No userId available for HMAC; logout must remain reachable
         * with an expired session.
         */
        it('skips CSRF for POST on public routes by default', async () => {
            const req = createMockRequest('POST', {});
            req.socket.remoteAddress = '10.0.0.1';
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                requireAuth: false,
                allowedMethods: ['POST'],
            })(req, res);

            expect(mockValidateCsrfToken).not.toHaveBeenCalled();
            expect(handler).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // csrfProtect: true with requireAuth: false — explicit opt-in
    // =========================================================================
    describe('csrfProtect: true with requireAuth: false', () => {
        /**
         * Test: csrfProtect: true + requireAuth: false always returns 403
         * This combo is intentionally unsupported — without auth, req._rateLimitUser
         * is never set, so the !userId guard always triggers. This test documents
         * that behaviour so it doesn't silently change.
         */
        it('always returns 403 because no userId is available without auth', async () => {
            // No auth → no userId → !userId guard triggers → 403 without calling
            // validateCsrfToken (can't verify HMAC without a bound user)
            mockValidateCsrfToken.mockReturnValue(false);
            const req = createMockRequest('POST', {});
            req.socket.remoteAddress = '10.0.0.1';
            const res = createMockResponse();
            const handler = jest.fn();

            await withRateLimit(handler, {
                requireAuth: false,
                csrfProtect: true,
                allowedMethods: ['POST'],
            })(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'CSRF_VALIDATION_FAILED' })
            );
            expect(handler).not.toHaveBeenCalled();
        });
    });
});
