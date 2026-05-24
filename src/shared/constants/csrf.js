/**
 * Shared CSRF protection constants
 *
 * Purpose: Single source of truth for CSRF cookie name and token lifetime,
 * imported by both server middleware (csrf.js) and client API layer (api.js).
 *
 * Cookie naming follows the __Host- prefix convention in production:
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie#cookie_prefixes
 * The __Host- prefix enforces Secure, no Domain, and Path=/ — preventing
 * subdomain fixation attacks.
 */

/**
 * Name of the CSRF double-submit cookie.
 * In production, the __Host- prefix is enforced by the browser:
 *   - Must be sent over HTTPS
 *   - Must not include a Domain attribute
 *   - Must have Path=/
 * @type {string}
 */
export const CSRF_COOKIE_NAME =
  process.env.NODE_ENV === 'production' ? '__Host-csrf-token' : 'csrf-token';

/**
 * CSRF token lifetime in seconds (4 hours).
 * Shorter window limits replay risk from stolen tokens
 * while still covering reasonable user sessions.
 * @type {number}
 */
export const CSRF_MAX_AGE_SECONDS = 14400;
