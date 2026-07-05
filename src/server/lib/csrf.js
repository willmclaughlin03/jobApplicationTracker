/**
 * CSRF protection utilities — double-submit cookie pattern with HMAC verification
 *
 * Purpose: Generate and validate CSRF tokens bound to authenticated user IDs.
 * Uses HMAC-SHA256 so the server can verify token integrity without storing state.
 *
 * Token format (returned to client): nonce.timestamp.signature
 *   - nonce: 64-char hex (32 random bytes) — prevents token reuse
 *   - timestamp: Unix seconds — enables 24-hour expiration
 *   - signature: HMAC-SHA256(nonce.userId.timestamp) — binds token to user
 *   Note: userId is NOT in the returned token; it is the implicit server-side input
 *
 * Connects to:
 * - src/pages/api/auth/csrf.js for token generation endpoint
 * - src/server/middleware/withRateLimit.js for validateCsrfToken()
 * - src/shared/constants/csrf.js for shared cookie name and max age
 */
import crypto from 'crypto';
import { serialize } from 'cookie';
import { CSRF_COOKIE_NAME, CSRF_MAX_AGE_SECONDS } from '../../shared/constants/csrf.js';
import { logger } from '../../shared/logger.js';

const CSRF_SECRET = process.env.CSRF_SECRET;

// Fail-fast: refuse to start with a weak or missing secret
if (!CSRF_SECRET || CSRF_SECRET.length < 32) {
  logger.error('CSRF_SECRET is missing or shorter than 32 characters — refusing to start');
  throw new Error('CSRF_SECRET must be set and at least 32 characters long');
}

/**
 * Generates a new CSRF token bound to a user ID.
 *
 * The token embeds a random nonce and timestamp so each token is unique and
 * expires after CSRF_MAX_AGE_SECONDS. The signature binds the token to userId
 * so tokens from one user cannot be used by another.
 *
 * @param {string} userId - Authenticated user's ID (from req._rateLimitUser.id)
 * @returns {string} Token string: nonce.timestamp.signature (all dot-separated)
 */
export function generateCsrfToken(userId) {
  if (!userId || typeof userId !== 'string') {
    throw new TypeError('generateCsrfToken requires a non-empty string userId');
  }
  const nonce = crypto.randomBytes(32).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${nonce}.${userId}.${timestamp}`;
  const signature = crypto
    .createHmac('sha256', CSRF_SECRET)
    .update(payload)
    .digest('hex');
  return `${nonce}.${timestamp}.${signature}`;
}

/**
 * Sets the CSRF double-submit cookie on the response.
 *
 * httpOnly: false — the client JavaScript must read this value to send it as
 * the x-csrf-token header (the core of the double-submit pattern).
 *
 * @param {import('next').NextApiResponse} res - Next.js response object
 * @param {string} token - Token from generateCsrfToken()
 */
export function setCsrfCookie(res, token) {
  const cookie = serialize(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: CSRF_MAX_AGE_SECONDS,
  });

  const existing = res.getHeader('Set-Cookie') ?? [];
  res.setHeader(
    'Set-Cookie',
    [...(Array.isArray(existing) ? existing : [existing]), cookie]
  );
}

/**
 * Expires the CSRF cookie by setting maxAge to 0.
 * Called during sign-out to ensure the cookie is cleared alongside auth cookies.
 *
 * @param {import('next').NextApiResponse} res - Next.js response object
 */
export function clearCsrfCookie(res) {
  const cookie = serialize(CSRF_COOKIE_NAME, '', {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });

  const existing = res.getHeader('Set-Cookie') ?? [];
  res.setHeader(
    'Set-Cookie',
    [...(Array.isArray(existing) ? existing : [existing]), cookie]
  );
}

/**
 * Validates the CSRF token using the double-submit + HMAC pattern.
 *
 * Checks (in order):
 *  1. Cookie and header both present
 *  2. Cookie value equals header value (double-submit check, timing-safe)
 *  3. Token has exactly 3 dot-separated parts (nonce.timestamp.signature)
 *  4. Token is not older than CSRF_MAX_AGE_SECONDS
 *  5. HMAC signature matches (binds token to userId)
 *
 * @param {import('next').NextApiRequest} req - Next.js request object
 * @param {string} userId - Authenticated user's ID (from req._rateLimitUser.id)
 * @returns {boolean} true if valid, false otherwise
 */
export function validateCsrfToken(req, userId) {
  if (!userId || typeof userId !== 'string') {
    logger.warn({ userId: typeof userId }, 'CSRF validation failed: invalid userId');
    return false;
  }
  const cookieValue = req.cookies?.[CSRF_COOKIE_NAME];
  const headerValue = req.headers?.['x-csrf-token'];

  if (!cookieValue || !headerValue) {
    logger.warn({ hasCookie: !!cookieValue, hasHeader: !!headerValue }, 'CSRF validation failed: missing token');
    return false;
  }

  if (typeof cookieValue !== 'string' || typeof headerValue !== 'string') {
    logger.warn(
      { cookieType: typeof cookieValue, headerType: typeof headerValue },
      'CSRF validation failed: token values must be strings'
    );
    return false;
  }

  const cookieBuffer = Buffer.from(cookieValue, 'utf8');
  const headerBuffer = Buffer.from(headerValue, 'utf8');

  // Double-submit check — cookie and header must match (timing-safe)
  if (cookieBuffer.length !== headerBuffer.length) {
    logger.warn('CSRF validation failed: cookie/header length mismatch');
    return false;
  }

  const cookieMatches = crypto.timingSafeEqual(
    cookieBuffer,
    headerBuffer
  );

  if (!cookieMatches) {
    logger.warn('CSRF validation failed: cookie/header mismatch');
    return false;
  }

  // Parse token: nonce.timestamp.signature
  const parts = cookieValue.split('.');
  if (parts.length !== 3) {
    logger.warn({ parts: parts.length }, 'CSRF validation failed: malformed token');
    return false;
  }

  const [nonce, timestamp, signature] = parts;

  // Expiration check
  const parsedTimestamp = parseInt(timestamp, 10);
  if (isNaN(parsedTimestamp)) {
    logger.warn('CSRF validation failed: non-numeric timestamp');
    return false;
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - parsedTimestamp;
  if (ageSeconds < 0 || ageSeconds > CSRF_MAX_AGE_SECONDS) {
    logger.warn({ ageSeconds }, 'CSRF validation failed: expired or future token');
    return false;
  }

  // HMAC verification: reconstruct payload using userId (not from token)
  const payload = `${nonce}.${userId}.${timestamp}`;
  const expectedSignature = crypto
    .createHmac('sha256', CSRF_SECRET)
    .update(payload)
    .digest('hex');

  if (signature.length !== expectedSignature.length) {
    logger.warn('CSRF validation failed: signature length mismatch');
    return false;
  }

  const signatureValid = crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );

  if (!signatureValid) {
    logger.warn('CSRF validation failed: invalid signature');
    return false;
  }

  return true;
}
