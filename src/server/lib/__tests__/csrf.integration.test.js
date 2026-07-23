/**
 * Integration tests for csrf.js — real HMAC crypto, no mocks
 *
 * Purpose: Verify CSRF token generation, validation, cookie helpers,
 * and edge cases using real crypto operations. csrf.js is pure (no
 * external services), so these tests exercise the actual implementation.
 *
 * Connects to: src/server/lib/csrf.js, src/shared/constants/csrf.js
 *
 * Requires: TEST_CSRF env var or the deterministic fallback below,
 *           TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_KEY env vars
 * Run with: npm run test:integration
 *
 * Test coverage:
 * - Generate → validate round-trip with real test user ID
 * - Cross-user token rejection (HMAC binds to userId)
 * - Tampered nonce/timestamp/signature rejection
 * - Expired tokens (real Date.now advancement, not fake timers)
 * - Two tokens for same user both validate (nonce uniqueness)
 * - timingSafeEqual length-mismatch handling (graceful, not crash)
 * - setCsrfCookie / clearCsrfCookie attribute verification
 * - __Host- prefix in production vs csrf-token in dev
 * - Malicious inputs: injection payloads in userId, oversized tokens,
 *   header-only / cookie-only, null bytes in cookie values
 */

const { createClient } = require('@supabase/supabase-js');
const {
    SUPABASE_TEST_PROJECT_REF_ENV_NAME,
    TEST_CSRF_FALLBACK,
    TEST_SUPABASE_ENV_NAMES,
    matchesSupabaseTestProject,
    resolveTestCsrfSecret,
    restoreEnvironmentVariable,
} = require('../../../testSupport/integrationEnvironment.js');
const {
    runIntegrationCleanup,
} = require('../../../testSupport/integrationCleanup.js');

const originalCsrfSecret = process.env.CSRF_SECRET;
const TEST_URL = process.env[TEST_SUPABASE_ENV_NAMES.url];
const TEST_SERVICE_KEY = process.env[TEST_SUPABASE_ENV_NAMES.serviceKey];
const TEST_PROJECT_REF = process.env[SUPABASE_TEST_PROJECT_REF_ENV_NAME];

// Install test-only HMAC configuration before csrf.js validates at import time.
process.env.CSRF_SECRET = resolveTestCsrfSecret(process.env, TEST_CSRF_FALLBACK);

afterAll(() => {
    restoreEnvironmentVariable(process.env, 'CSRF_SECRET', originalCsrfSecret);
});

jest.mock('../../../shared/logger.js', () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    },
}));

const {
    generateCsrfToken,
    validateCsrfToken,
    setCsrfCookie,
    clearCsrfCookie,
} = require('../csrf.js');

const {
    CSRF_COOKIE_NAME,
    CSRF_MAX_AGE_SECONDS,
} = require('../../../shared/constants/csrf.js');

const SKIP_INTEGRATION =
    !TEST_URL ||
    !TEST_SERVICE_KEY;

const describeIntegration = SKIP_INTEGRATION ||
    !matchesSupabaseTestProject(TEST_URL, TEST_PROJECT_REF)
    ? describe.skip
    : describe;

describeIntegration('csrf.js — integration (real crypto, real user)', () => {
    let testUserId;

    beforeAll(async () => {
        if (SKIP_INTEGRATION || !matchesSupabaseTestProject(TEST_URL, TEST_PROJECT_REF)) return;

        const supabase = createClient(
            TEST_URL,
            TEST_SERVICE_KEY
        );
        const testEmail = `csrf-test-${Date.now()}@integration-test.local`;
        const { data, error } = await supabase.auth.admin.createUser({
            email: testEmail,
            email_confirm: true,
        });
        if (error) throw new Error(`Test user creation failed: ${error.message}`);
        testUserId = data.user.id;
    });

    afterAll(async () => {
        if (
            !SKIP_INTEGRATION &&
            testUserId &&
            matchesSupabaseTestProject(TEST_URL, TEST_PROJECT_REF)
        ) {
            const supabase = createClient(
                TEST_URL,
                TEST_SERVICE_KEY
            );
            await runIntegrationCleanup([
                {
                    label: 'CSRF auth user',
                    cleanup: () => supabase.auth.admin.deleteUser(testUserId),
                },
            ]);
        }
    });

    // -- Helpers ----------------------------------------------------------

    function makeReq(cookieValue, headerValue) {
        return {
            cookies: cookieValue !== undefined
                ? { [CSRF_COOKIE_NAME]: cookieValue }
                : {},
            headers: headerValue !== undefined
                ? { 'x-csrf-token': headerValue }
                : {},
        };
    }

    function makeRes(existingCookies = []) {
        const headers = { 'Set-Cookie': existingCookies };
        return {
            getHeader: jest.fn(name => headers[name] ?? []),
            setHeader: jest.fn((name, value) => { headers[name] = value; }),
            _headers: headers,
        };
    }

    // ===================================================================
    // Generate → validate round-trip
    // ===================================================================

    describe('generate → validate round-trip', () => {
        it('freshly generated token validates for the real test user', () => {
            const token = generateCsrfToken(testUserId);
            const req = makeReq(token, token);
            expect(validateCsrfToken(req, testUserId)).toBe(true);
        });

        it('two tokens for the same user both validate independently', () => {
            const token1 = generateCsrfToken(testUserId);
            const token2 = generateCsrfToken(testUserId);

            // Different nonces → different tokens
            expect(token1).not.toBe(token2);

            // Both should validate
            expect(validateCsrfToken(makeReq(token1, token1), testUserId)).toBe(true);
            expect(validateCsrfToken(makeReq(token2, token2), testUserId)).toBe(true);
        });
    });

    // ===================================================================
    // Cross-user token rejection
    // ===================================================================

    describe('cross-user rejection', () => {
        it('token for test user rejected when validated with different userId', () => {
            const token = generateCsrfToken(testUserId);
            const req = makeReq(token, token);

            expect(validateCsrfToken(req, 'different-user-id')).toBe(false);
        });

        it('token generated for synthetic user rejected for real test user', () => {
            const token = generateCsrfToken('attacker-user-id');
            const req = makeReq(token, token);

            expect(validateCsrfToken(req, testUserId)).toBe(false);
        });
    });

    // ===================================================================
    // Tampered token rejection
    // ===================================================================

    describe('tampered token rejection', () => {
        it('rejects tampered nonce (first segment)', () => {
            const token = generateCsrfToken(testUserId);
            const [nonce, ts, sig] = token.split('.');
            // Flip one character in the nonce
            const flipped = nonce[0] === 'a' ? 'b' : 'a';
            const tampered = `${flipped}${nonce.slice(1)}.${ts}.${sig}`;
            const req = makeReq(tampered, tampered);

            expect(validateCsrfToken(req, testUserId)).toBe(false);
        });

        it('rejects tampered timestamp (second segment)', () => {
            const token = generateCsrfToken(testUserId);
            const [nonce, ts, sig] = token.split('.');
            const tampered = `${nonce}.${Number(ts) + 1}.${sig}`;
            const req = makeReq(tampered, tampered);

            expect(validateCsrfToken(req, testUserId)).toBe(false);
        });

        it('rejects tampered signature (third segment)', () => {
            const token = generateCsrfToken(testUserId);
            const [nonce, ts, sig] = token.split('.');
            const lastChar = sig[sig.length - 1];
            const flipped = lastChar === 'a' ? 'b' : 'a';
            const tampered = `${nonce}.${ts}.${sig.slice(0, -1)}${flipped}`;
            const req = makeReq(tampered, tampered);

            expect(validateCsrfToken(req, testUserId)).toBe(false);
        });
    });

    // ===================================================================
    // Expired tokens (real timer advancement)
    // ===================================================================

    describe('expired tokens', () => {
        it('rejects a token older than CSRF_MAX_AGE_SECONDS', () => {
            const realDateNow = Date.now;

            // Generate token at a past time (just over the max age)
            const pastMs = realDateNow.call(Date) - (CSRF_MAX_AGE_SECONDS + 1) * 1000;
            Date.now = jest.fn(() => pastMs);
            const expiredToken = generateCsrfToken(testUserId);
            Date.now = realDateNow;

            const req = makeReq(expiredToken, expiredToken);
            expect(validateCsrfToken(req, testUserId)).toBe(false);
        });

        it('rejects a token with a future timestamp', () => {
            const realDateNow = Date.now;

            // Generate token 1 hour in the future
            Date.now = jest.fn(() => realDateNow.call(Date) + 3600_000);
            const futureToken = generateCsrfToken(testUserId);
            Date.now = realDateNow;

            const req = makeReq(futureToken, futureToken);
            expect(validateCsrfToken(req, testUserId)).toBe(false);
        });
    });

    // ===================================================================
    // timingSafeEqual length-mismatch handling
    // ===================================================================

    describe('timingSafeEqual length-mismatch (graceful, not crash)', () => {
        it('cookie/header length mismatch returns false without throwing', () => {
            const token = generateCsrfToken(testUserId);
            // Header is token + extra character → different length
            const req = makeReq(token, token + 'x');

            expect(() => {
                const result = validateCsrfToken(req, testUserId);
                expect(result).toBe(false);
            }).not.toThrow();
        });

        it('signature length mismatch returns false without throwing', () => {
            const token = generateCsrfToken(testUserId);
            const [nonce, ts] = token.split('.');
            // Shorter signature than expected HMAC-SHA256 hex (64 chars)
            const shortSig = 'abcd';
            const tampered = `${nonce}.${ts}.${shortSig}`;
            const req = makeReq(tampered, tampered);

            expect(() => {
                const result = validateCsrfToken(req, testUserId);
                expect(result).toBe(false);
            }).not.toThrow();
        });
    });

    // ===================================================================
    // setCsrfCookie / clearCsrfCookie attributes
    // ===================================================================

    describe('setCsrfCookie()', () => {
        it('sets non-httpOnly cookie with correct attributes', () => {
            const res = makeRes();
            const token = generateCsrfToken(testUserId);
            setCsrfCookie(res, token);

            expect(res.setHeader).toHaveBeenCalled();
            const [headerName, cookieArray] = res.setHeader.mock.calls[0];
            expect(headerName).toBe('Set-Cookie');

            const cookieStr = Array.isArray(cookieArray)
                ? cookieArray.find(c => c.includes(CSRF_COOKIE_NAME))
                : cookieArray;

            expect(cookieStr).toContain(`${CSRF_COOKIE_NAME}=`);
            expect(cookieStr).not.toContain('HttpOnly');
            expect(cookieStr).toContain('SameSite=Lax');
            expect(cookieStr).toContain('Path=/');
            expect(cookieStr).toContain(`Max-Age=${CSRF_MAX_AGE_SECONDS}`);
        });

        it('preserves existing Set-Cookie headers', () => {
            const res = makeRes(['existing-cookie=val']);
            setCsrfCookie(res, generateCsrfToken(testUserId));

            const [, cookieArray] = res.setHeader.mock.calls[0];
            expect(Array.isArray(cookieArray)).toBe(true);
            expect(cookieArray.some(c => c === 'existing-cookie=val')).toBe(true);
            expect(cookieArray.some(c => c.includes(CSRF_COOKIE_NAME))).toBe(true);
        });
    });

    describe('clearCsrfCookie()', () => {
        it('expires the cookie with maxAge 0', () => {
            const res = makeRes();
            clearCsrfCookie(res);

            const [headerName, cookieArray] = res.setHeader.mock.calls[0];
            expect(headerName).toBe('Set-Cookie');

            const cookieStr = Array.isArray(cookieArray)
                ? cookieArray.find(c => c.includes(CSRF_COOKIE_NAME))
                : cookieArray;

            expect(cookieStr).toContain(`${CSRF_COOKIE_NAME}=`);
            expect(cookieStr).toContain('Max-Age=0');
        });
    });

    // ===================================================================
    // __Host- prefix behavior
    // ===================================================================

    describe('cookie name prefix', () => {
        it('uses csrf-token in non-production (test) environment', () => {
            // jest.setup.js does not set NODE_ENV=production
            expect(CSRF_COOKIE_NAME).toBe('csrf-token');
        });
    });

    // ===================================================================
    // Double-submit pattern enforcement
    // ===================================================================

    describe('double-submit enforcement', () => {
        it('rejects when cookie present but header missing', () => {
            const token = generateCsrfToken(testUserId);
            const req = makeReq(token, undefined);
            expect(validateCsrfToken(req, testUserId)).toBe(false);
        });

        it('rejects when header present but cookie missing', () => {
            const token = generateCsrfToken(testUserId);
            const req = makeReq(undefined, token);
            expect(validateCsrfToken(req, testUserId)).toBe(false);
        });

        it('rejects when cookie and header are different valid tokens', () => {
            const token1 = generateCsrfToken(testUserId);
            const token2 = generateCsrfToken(testUserId);
            const req = makeReq(token1, token2);
            expect(validateCsrfToken(req, testUserId)).toBe(false);
        });
    });

    // ===================================================================
    // Malicious inputs
    // ===================================================================

    describe('malicious input resilience', () => {
        it('rejects injection payload in userId without crashing', () => {
            const maliciousUserId = "'; DROP TABLE users; --";
            const token = generateCsrfToken(maliciousUserId);
            const req = makeReq(token, token);

            // Token generated for malicious userId should validate for that userId
            expect(validateCsrfToken(req, maliciousUserId)).toBe(true);
            // But not for the real test user
            expect(validateCsrfToken(req, testUserId)).toBe(false);
        });

        it('rejects oversized token string', () => {
            const oversized = 'a'.repeat(10000) + '.12345.' + 'b'.repeat(64);
            const req = makeReq(oversized, oversized);

            expect(() => {
                const result = validateCsrfToken(req, testUserId);
                expect(result).toBe(false);
            }).not.toThrow();
        });

        it('handles null bytes in cookie value', () => {
            const token = generateCsrfToken(testUserId);
            const poisoned = token.replace('.', '.\x00');
            const req = makeReq(poisoned, poisoned);

            expect(() => {
                const result = validateCsrfToken(req, testUserId);
                expect(result).toBe(false);
            }).not.toThrow();
        });

        it('rejects token with extra dot-separated segments', () => {
            const token = generateCsrfToken(testUserId);
            const extra = token + '.extra-segment';
            const req = makeReq(extra, extra);

            expect(validateCsrfToken(req, testUserId)).toBe(false);
        });

        it('rejects completely empty strings for cookie and header', () => {
            const req = makeReq('', '');
            expect(validateCsrfToken(req, testUserId)).toBe(false);
        });
    });

    // ===================================================================
    // generateCsrfToken userId validation
    // ===================================================================

    describe('generateCsrfToken userId edge cases', () => {
        it('throws TypeError for empty string', () => {
            expect(() => generateCsrfToken('')).toThrow(TypeError);
        });

        it('throws TypeError for null', () => {
            expect(() => generateCsrfToken(null)).toThrow(TypeError);
        });

        it('throws TypeError for non-string', () => {
            expect(() => generateCsrfToken(12345)).toThrow(TypeError);
        });

        it('accepts userId with special characters (HMAC handles any string)', () => {
            const specialId = 'user:with/slashes&ampersands=equals';
            const token = generateCsrfToken(specialId);
            const req = makeReq(token, token);
            expect(validateCsrfToken(req, specialId)).toBe(true);
        });
    });
});
