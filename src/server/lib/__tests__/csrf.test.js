/**
 * Tests for server/lib/csrf.js
 *
 * Purpose: Verify CSRF token generation, cookie helpers, and validation logic
 *
 * Connects to: src/server/lib/csrf.js
 *
 * Test coverage:
 * - generateCsrfToken: token format, nonce randomness
 * - validateCsrfToken: all pass/fail paths (missing, mismatch, expired, tampered, malformed)
 * - setCsrfCookie: correct cookie attributes
 * - clearCsrfCookie: maxAge 0
 */

// Must set CSRF_SECRET before the module is required
process.env.CSRF_SECRET = 'a'.repeat(32);

const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.mock('../../../shared/logger.js', () => ({ logger: mockLogger }));

// Stub shared constants so tests aren't coupled to NODE_ENV
jest.mock('../../../shared/constants/csrf.js', () => ({
    CSRF_COOKIE_NAME: 'csrf-token',
    CSRF_MAX_AGE_SECONDS: 86400,
}));

const { generateCsrfToken, validateCsrfToken, setCsrfCookie, clearCsrfCookie } = require('../csrf.js');

// =========================================================================
// Helpers
// =========================================================================

/**
 * Builds a minimal req mock that holds CSRF cookie + header.
 */
function makeReq(cookieValue, headerValue) {
    return {
        cookies: cookieValue !== undefined ? { 'csrf-token': cookieValue } : {},
        headers: headerValue !== undefined ? { 'x-csrf-token': headerValue } : {},
    };
}

/**
 * Builds a minimal res mock that records Set-Cookie calls.
 */
function makeRes(existingCookies = []) {
    const headers = { 'Set-Cookie': existingCookies };
    return {
        getHeader: jest.fn(name => headers[name] ?? []),
        setHeader: jest.fn((name, value) => { headers[name] = value; }),
        _headers: headers,
    };
}

// =========================================================================
// generateCsrfToken
// =========================================================================
describe('generateCsrfToken', () => {
    /**
     * Token must have exactly three dot-separated parts: nonce.timestamp.signature
     */
    it('returns a token with exactly 3 dot-separated parts', () => {
        const token = generateCsrfToken('user-123');
        const parts = token.split('.');
        expect(parts).toHaveLength(3);
    });

    /**
     * Nonce is 32 random bytes encoded as hex → 64 characters
     */
    it('nonce is 64 hex characters (32 bytes)', () => {
        const token = generateCsrfToken('user-123');
        const [nonce] = token.split('.');
        expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    });

    /**
     * Two calls must produce different nonces — verifies crypto.randomBytes usage
     */
    it('produces different tokens on successive calls', () => {
        const t1 = generateCsrfToken('user-123');
        const t2 = generateCsrfToken('user-123');
        expect(t1).not.toBe(t2);
    });

    /**
     * Timestamp part must be a numeric string (Unix seconds)
     */
    it('embeds a numeric timestamp', () => {
        const token = generateCsrfToken('user-123');
        const [, timestamp] = token.split('.');
        expect(Number.isInteger(Number(timestamp))).toBe(true);
    });
});

// =========================================================================
// validateCsrfToken — passing case
// =========================================================================
describe('validateCsrfToken (valid token)', () => {
    it('returns true for a freshly generated token', () => {
        const userId = 'user-abc';
        const token = generateCsrfToken(userId);
        const req = makeReq(token, token);
        expect(validateCsrfToken(req, userId)).toBe(true);
    });
});

// =========================================================================
// validateCsrfToken — failure cases
// =========================================================================
describe('validateCsrfToken (failure paths)', () => {
    let userId;
    let validToken;

    beforeEach(() => {
        userId = 'user-xyz';
        validToken = generateCsrfToken(userId);
    });

    /**
     * Cookie absent → false
     */
    it('returns false when cookie is missing', () => {
        const req = makeReq(undefined, validToken);
        expect(validateCsrfToken(req, userId)).toBe(false);
    });

    /**
     * Header absent → false
     */
    it('returns false when header is missing', () => {
        const req = makeReq(validToken, undefined);
        expect(validateCsrfToken(req, userId)).toBe(false);
    });

    /**
     * Cookie ≠ header → false (double-submit check)
     */
    it('returns false when cookie and header do not match', () => {
        const otherToken = generateCsrfToken(userId);
        const req = makeReq(validToken, otherToken);
        expect(validateCsrfToken(req, userId)).toBe(false);
    });

    /**
     * Equal character counts with unequal UTF-8 bytes should reject cleanly.
     */
    it('returns false without throwing for multibyte cookie/header byte-length mismatch', () => {
        const req = makeReq('éé', 'ab');

        expect(() => {
            expect(validateCsrfToken(req, userId)).toBe(false);
        }).not.toThrow();
    });

    /**
     * Identical cookie/header token whose signature segment matches the hex
     * digest in character count but not UTF-8 bytes must reject cleanly at the
     * signature comparison instead of throwing in timingSafeEqual.
     */
    it('returns false without throwing for a multibyte signature segment', () => {
        const freshTimestamp = Math.floor(Date.now() / 1000);
        const multibyteSignature = `${'a'.repeat(63)}é`;
        const forgedToken = `nonce.${freshTimestamp}.${multibyteSignature}`;
        const req = makeReq(forgedToken, forgedToken);

        expect(() => {
            expect(validateCsrfToken(req, userId)).toBe(false);
        }).not.toThrow();
    });

    /**
     * Wrong userId -> HMAC mismatch -> false
     */
    it('returns false for a wrong userId (HMAC mismatch)', () => {
        const req = makeReq(validToken, validToken);
        expect(validateCsrfToken(req, 'wrong-user-id')).toBe(false);
    });

    /**
     * Expired token (timestamp > 24h ago) → false
     * Uses Date.now mock so the token is properly signed at generation time,
     * then advances time past the 24h window for validation.
     */
    it('returns false for an expired token', () => {
        const realDateNow = Date.now;
        // Generate token at a fixed past time (25h ago)
        const pastMs = realDateNow.call(Date) - (86400 + 1) * 1000;
        Date.now = jest.fn(() => pastMs);
        const expiredToken = generateCsrfToken(userId);
        // Restore real time — token is now >24h old
        Date.now = realDateNow;

        const req = makeReq(expiredToken, expiredToken);
        expect(validateCsrfToken(req, userId)).toBe(false);
    });

    /**
     * Future timestamp → negative age → false (defense-in-depth)
     */
    it('returns false for a token with a future timestamp', () => {
        const realDateNow = Date.now;
        // Generate token 1 hour in the future
        Date.now = jest.fn(() => realDateNow.call(Date) + 3600 * 1000);
        const futureToken = generateCsrfToken(userId);
        Date.now = realDateNow;

        const req = makeReq(futureToken, futureToken);
        expect(validateCsrfToken(req, userId)).toBe(false);
    });

    /**
     * Non-numeric timestamp → NaN guard → false
     */
    it('returns false for a token with a non-numeric timestamp', () => {
        const [nonce, , signature] = validToken.split('.');
        const badToken = `${nonce}.abc.${signature}`;
        const req = makeReq(badToken, badToken);
        expect(validateCsrfToken(req, userId)).toBe(false);
    });

    /**
     * Tampered signature → HMAC mismatch → false
     */
    it('returns false for a tampered signature', () => {
        const [nonce, timestamp] = validToken.split('.');
        const tamperedToken = `${nonce}.${timestamp}.${'0'.repeat(64)}`;
        const req = makeReq(tamperedToken, tamperedToken);
        expect(validateCsrfToken(req, userId)).toBe(false);
    });

    /**
     * Malformed token (wrong number of parts) → false
     */
    it('returns false for a malformed token (wrong part count)', () => {
        const malformed = 'onlytwoparts.here';
        const req = makeReq(malformed, malformed);
        expect(validateCsrfToken(req, userId)).toBe(false);
    });
});

// =========================================================================
// generateCsrfToken — edge-case userId values
// =========================================================================
describe('generateCsrfToken userId validation', () => {
    /**
     * Empty string userId — throws TypeError (prevents weak HMAC payload)
     */
    it('throws TypeError for empty string userId', () => {
        expect(() => generateCsrfToken('')).toThrow(TypeError);
        expect(() => generateCsrfToken('')).toThrow('non-empty string userId');
    });

    /**
     * Null userId — throws TypeError
     */
    it('throws TypeError for null userId', () => {
        expect(() => generateCsrfToken(null)).toThrow(TypeError);
    });

    /**
     * Undefined userId — throws TypeError
     */
    it('throws TypeError for undefined userId', () => {
        expect(() => generateCsrfToken(undefined)).toThrow(TypeError);
    });

    /**
     * Non-string userId — throws TypeError
     */
    it('throws TypeError for numeric userId', () => {
        expect(() => generateCsrfToken(123)).toThrow(TypeError);
    });
});

// =========================================================================
// validateCsrfToken — invalid userId returns false
// =========================================================================
describe('validateCsrfToken userId validation', () => {
    it('returns false for null userId', () => {
        const token = generateCsrfToken('user-123');
        const req = makeReq(token, token);
        expect(validateCsrfToken(req, null)).toBe(false);
    });

    it('returns false for undefined userId', () => {
        const token = generateCsrfToken('user-123');
        const req = makeReq(token, token);
        expect(validateCsrfToken(req, undefined)).toBe(false);
    });

    it('returns false for empty string userId', () => {
        const token = generateCsrfToken('user-123');
        const req = makeReq(token, token);
        expect(validateCsrfToken(req, '')).toBe(false);
    });

    it('returns false for numeric userId', () => {
        const token = generateCsrfToken('user-123');
        const req = makeReq(token, token);
        expect(validateCsrfToken(req, 123)).toBe(false);
    });
});

// =========================================================================
// setCsrfCookie
// =========================================================================
describe('setCsrfCookie', () => {
    it('appends a non-httpOnly cookie with the token value', () => {
        const res = makeRes();
        const token = generateCsrfToken('user-1');
        setCsrfCookie(res, token);

        expect(res.setHeader).toHaveBeenCalled();
        const [headerName, cookieArray] = res.setHeader.mock.calls[0];
        expect(headerName).toBe('Set-Cookie');

        const cookieStr = Array.isArray(cookieArray)
            ? cookieArray.find(c => c.startsWith('csrf-token='))
            : cookieArray;

        expect(cookieStr).toContain('csrf-token=');
        expect(cookieStr).not.toContain('HttpOnly');
        expect(cookieStr).toContain('SameSite=Lax');
        expect(cookieStr).toContain('Path=/');
        expect(cookieStr).toContain('Max-Age=86400');
    });

    it('preserves existing Set-Cookie headers when appending', () => {
        const res = makeRes(['existing-cookie=val']);
        setCsrfCookie(res, generateCsrfToken('user-1'));

        const [, cookieArray] = res.setHeader.mock.calls[0];
        expect(Array.isArray(cookieArray)).toBe(true);
        expect(cookieArray.some(c => c === 'existing-cookie=val')).toBe(true);
        expect(cookieArray.some(c => c.startsWith('csrf-token='))).toBe(true);
    });
});

// =========================================================================
// clearCsrfCookie
// =========================================================================
describe('clearCsrfCookie', () => {
    it('sets the CSRF cookie with maxAge 0 to expire it', () => {
        const res = makeRes();
        clearCsrfCookie(res);

        const [headerName, cookieArray] = res.setHeader.mock.calls[0];
        expect(headerName).toBe('Set-Cookie');

        const cookieStr = Array.isArray(cookieArray)
            ? cookieArray.find(c => c.startsWith('csrf-token='))
            : cookieArray;

        expect(cookieStr).toContain('csrf-token=');
        expect(cookieStr).toContain('Max-Age=0');
    });
});
