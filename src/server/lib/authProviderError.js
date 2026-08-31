/**
 * Privacy-safe provider error formatting for authentication boundaries.
 *
 * Purpose: Convert arbitrary failures into fixed-cardinality log metadata and
 * prevent raw provider errors or request data from reaching structured logs.
 * Connects to: future auth route, callback, middleware, SSR, and API logging.
 */

export const AUTH_PROVIDER_LOG_ROUTES = Object.freeze({
  V2_SESSION: 'v2_session',
  V2_SIGNOUT: 'v2_signout',
  OAUTH_CALLBACK: 'oauth_callback',
  PROTECTED_API: 'protected_api',
  SERVER_RENDER: 'server_render',
  EDGE_MIDDLEWARE: 'edge_middleware',
  UNKNOWN: 'unknown',
});

export const AUTH_PROVIDER_LOG_EVENTS = Object.freeze({
  SESSION_LOOKUP_FAILED: 'session_lookup_failed',
  SIGNOUT_FAILED: 'signout_failed',
  TOKEN_EXCHANGE_FAILED: 'token_exchange_failed',
  AUTHORIZATION_FAILED: 'authorization_failed',
  PROVIDER_EXCEPTION: 'provider_exception',
  UNKNOWN: 'unknown',
});

const AUTH_PROVIDER_ERROR_NAMES = new Set([
  'AuthApiError',
  'AuthSessionMissingError',
  'AuthRetryableFetchError',
  'AuthUnknownError',
  'Error',
]);

const AUTH_PROVIDER_ERROR_CODES = new Set([
  'bad_jwt',
  'user_not_found',
  'user_banned',
  'session_expired',
  'session_not_found',
  'refresh_token_not_found',
  'refresh_token_already_used',
]);

const AUTH_PROVIDER_LOG_ROUTE_VALUES = new Set(Object.values(AUTH_PROVIDER_LOG_ROUTES));
const AUTH_PROVIDER_LOG_EVENT_VALUES = new Set(Object.values(AUTH_PROVIDER_LOG_EVENTS));

/**
 * Reads one property without allowing a hostile getter or Proxy to escape.
 *
 * @param {unknown} value object candidate
 * @param {string} property property name
 * @returns {unknown} property value or undefined
 */
function readPropertySafely(value, property) {
  try {
    return typeof value === 'object' && value !== null ? value[property] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Maps caller-supplied metadata to a fixed allowlist value.
 *
 * @param {unknown} value candidate route or event
 * @param {Set<string>} allowedValues finite allowlist
 * @returns {string} approved value or unknown
 */
function normalizeFixedMetadata(value, allowedValues) {
  return typeof value === 'string' && allowedValues.has(value) ? value : 'unknown';
}

/**
 * Maps an arbitrary provider name to a finite low-cardinality value.
 *
 * @param {unknown} value provider error name
 * @returns {string} approved name or unknown
 */
function normalizeProviderErrorName(value) {
  return typeof value === 'string' && AUTH_PROVIDER_ERROR_NAMES.has(value)
    ? value
    : 'unknown';
}

/**
 * Keeps only an integer HTTP status in the complete valid status range.
 *
 * @param {unknown} value provider status candidate
 * @returns {number|null} safe HTTP status or null
 */
function normalizeProviderErrorStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

/**
 * Maps provider codes to the finite Gate-0 evidence vocabulary.
 * Missing and unsupported codes use distinct fixed fallback labels.
 *
 * @param {unknown} value provider error code
 * @returns {string} approved code, absent, or unknown
 */
function normalizeProviderErrorCode(value) {
  if (value === undefined || value === null) return 'absent';
  return typeof value === 'string' && AUTH_PROVIDER_ERROR_CODES.has(value)
    ? value
    : 'unknown';
}

/**
 * Formats bounded provider-error metadata without retaining the source object.
 * The operation is total and non-throwing so logging cannot alter auth control.
 *
 * @param {unknown} input route, event, and provider error candidate
 * @returns {{route: string, event: string, name: string, status: number|null, code: string}}
 */
export function formatAuthProviderError(input) {
  const route = readPropertySafely(input, 'route');
  const event = readPropertySafely(input, 'event');
  const error = readPropertySafely(input, 'error');

  return {
    route: normalizeFixedMetadata(route, AUTH_PROVIDER_LOG_ROUTE_VALUES),
    event: normalizeFixedMetadata(event, AUTH_PROVIDER_LOG_EVENT_VALUES),
    name: normalizeProviderErrorName(readPropertySafely(error, 'name')),
    status: normalizeProviderErrorStatus(readPropertySafely(error, 'status')),
    code: normalizeProviderErrorCode(readPropertySafely(error, 'code')),
  };
}
