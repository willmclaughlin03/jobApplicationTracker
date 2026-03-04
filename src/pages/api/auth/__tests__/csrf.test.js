/**
 * Tests for /api/auth/csrf endpoint handler
 *
 * Purpose: Verify the CSRF token endpoint generates a token, sets the cookie,
 * and handles edge cases (missing user).
 *
 * Connects to: src/pages/api/auth/csrf.js
 *
 * Note: withRateLimit is mocked as passthrough — auth and rate limiting are
 * tested in withRateLimit.test.js. These tests focus on handler logic only.
 *
 * Test coverage:
 * - Returns 200 with null data and success message
 * - Calls generateCsrfToken with the authenticated userId
 * - Calls setCsrfCookie with the generated token
 * - Returns 401 when req._rateLimitUser is missing (defense-in-depth)
 */

jest.mock('../../../../server/middleware/withRateLimit.js', () => ({
    withRateLimit: (handler) => handler,
}));

const mockGenerateCsrfToken = jest.fn();
const mockSetCsrfCookie = jest.fn();
jest.mock('../../../../server/lib/csrf.js', () => ({
    generateCsrfToken: mockGenerateCsrfToken,
    setCsrfCookie: mockSetCsrfCookie,
}));

jest.mock('../../../../shared/logger.js', () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    },
}));

const handler = require('../csrf.js').default;

describe('/api/auth/csrf handler', () => {
    const mockUser = { id: 'user-csrf-123', email: 'test@example.com' };

    function createMockReq(user) {
        return {
            method: 'GET',
            _rateLimitUser: user,
        };
    }

    function createMockRes() {
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
        return res;
    }

    beforeEach(() => {
        jest.clearAllMocks();
        mockGenerateCsrfToken.mockReturnValue('mock-nonce.12345.mock-signature');
    });

    /**
     * Happy path: authenticated user gets a CSRF token set as a cookie
     */
    it('returns 200 and sets CSRF cookie for authenticated user', async () => {
        const req = createMockReq(mockUser);
        const res = createMockRes();

        await handler(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ data: null, message: 'CSRF token set' })
        );
    });

    /**
     * generateCsrfToken must receive the authenticated userId
     */
    it('calls generateCsrfToken with the user ID', async () => {
        const req = createMockReq(mockUser);
        const res = createMockRes();

        await handler(req, res);

        expect(mockGenerateCsrfToken).toHaveBeenCalledWith(mockUser.id);
    });

    /**
     * setCsrfCookie must be called with the response and generated token
     */
    it('calls setCsrfCookie with the response and token', async () => {
        const req = createMockReq(mockUser);
        const res = createMockRes();

        await handler(req, res);

        expect(mockSetCsrfCookie).toHaveBeenCalledWith(res, 'mock-nonce.12345.mock-signature');
    });

    /**
     * Defense-in-depth: if _rateLimitUser is somehow missing, return 401
     */
    it('returns 401 when _rateLimitUser is missing', async () => {
        const req = createMockReq(undefined);
        const res = createMockRes();

        await handler(req, res);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ error: 'UNAUTHORIZED' })
        );
        expect(mockGenerateCsrfToken).not.toHaveBeenCalled();
        expect(mockSetCsrfCookie).not.toHaveBeenCalled();
    });

    /**
     * Token is NOT returned in the response body (only via Set-Cookie)
     */
    it('does not leak the token in the response body', async () => {
        const req = createMockReq(mockUser);
        const res = createMockRes();

        await handler(req, res);

        const responseBody = res.json.mock.calls[0][0];
        expect(responseBody.data).toBeNull();
        expect(JSON.stringify(responseBody)).not.toContain('mock-nonce');
    });
});
