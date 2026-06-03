export const AUTH_ERROR_CODES = Object.freeze({
  AUTH_INVALID: 'AUTH_INVALID',
  AUTH_NOT_FOUND: 'AUTH_NOT_FOUND',
  AUTH_UNAVAILABLE: 'AUTH_UNAVAILABLE',
});

/**
 * Checks whether a Supabase Auth error represents a missing browser session.
 *
 * Purpose: distinguish a normal logged-out request from ambiguous auth
 * provider failures while preserving the fail-closed default for unknown
 * shapes.
 *
 * @param {unknown} error - Error returned by Supabase Auth
 * @returns {boolean} True when the error is a known missing-session shape
 */
function isAuthSessionMissingError(error) {
  const status = typeof error?.status === 'number' ? error.status : null;
  const message = typeof error?.message === 'string' ? error.message : '';

  return error?.name === 'AuthSessionMissingError'
    || (status === 400 && message.toLowerCase().includes('auth session missing'));
}

/**
 * Classify Supabase auth errors into stable route-facing failure codes.
 *
 * Purpose: protected routes and session checks must distinguish invalid or
 * missing sessions from auth backend outages so retryable service failures
 * return 503 instead of looking like a confirmed sign-out.
 *
 * @param {unknown} error
 * @returns {'AUTH_INVALID' | 'AUTH_UNAVAILABLE'}
 */
export function classifyAuthError(error) {
  const status = typeof error?.status === 'number' ? error.status : null;

  if (isAuthSessionMissingError(error)) {
    return AUTH_ERROR_CODES.AUTH_INVALID;
  }

  if (status === 401 || status === 403) {
    return AUTH_ERROR_CODES.AUTH_INVALID;
  }

  if (status === 429 || (status !== null && status >= 500)) {
    return AUTH_ERROR_CODES.AUTH_UNAVAILABLE;
  }

  if (error?.name === 'AuthRetryableFetchError') {
    return AUTH_ERROR_CODES.AUTH_UNAVAILABLE;
  }

  return AUTH_ERROR_CODES.AUTH_UNAVAILABLE;
}
