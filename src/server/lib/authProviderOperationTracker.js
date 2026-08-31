/**
 * Request-scoped Supabase Auth operation tracking.
 *
 * Purpose: Preserve only the last fixed operation needed for exact error
 * classification while never retaining provider URLs, headers, or payloads.
 * Connects to: Supabase's custom fetch option and auth session classification.
 */

export const AUTH_PROVIDER_OPERATIONS = Object.freeze({
  GET_USER: 'getUser',
  IMPLICIT_REFRESH: 'implicit_refresh',
});

/**
 * Reads the effective request URL from Fetch-compatible inputs.
 * Malformed or accessor-backed inputs fail closed as an untracked request.
 *
 * @param {unknown} input fetch input
 * @returns {string|null} absolute URL string or null
 */
function readRequestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof input === 'object' && input !== null && typeof input.url === 'string') {
    return input.url;
  }
  return null;
}

/**
 * Reads the method that Fetch will apply after an optional init override.
 * Only the SDK's exact uppercase methods are recognized by the classifier.
 *
 * @param {unknown} input fetch input
 * @param {unknown} init fetch initialization options
 * @returns {string|null} effective method or null
 */
function readRequestMethod(input, init) {
  if (typeof init === 'object' && init !== null && init.method !== undefined) {
    return typeof init.method === 'string' ? init.method : null;
  }
  if (typeof input === 'object' && input !== null && input.method !== undefined) {
    return typeof input.method === 'string' ? input.method : null;
  }
  return 'GET';
}

/**
 * Classifies one exact Supabase Auth fetch without returning request data.
 * Unsupported methods, paths, queries, fragments, and protocols map to null.
 *
 * @param {unknown} input fetch input
 * @param {unknown} init fetch initialization options
 * @returns {'getUser'|'implicit_refresh'|null} bounded provider operation
 */
function classifyAuthProviderOperation(input, init) {
  try {
    const rawUrl = readRequestUrl(input);
    const method = readRequestMethod(input, init);
    if (rawUrl === null || method === null) return null;

    const url = new URL(rawUrl);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username !== ''
      || url.password !== ''
      || url.hash !== '') {
      return null;
    }

    if (method === 'GET'
      && url.pathname === '/auth/v1/user'
      && url.search === '') {
      return AUTH_PROVIDER_OPERATIONS.GET_USER;
    }
    if (method === 'POST'
      && url.pathname === '/auth/v1/token'
      && url.search === '?grant_type=refresh_token') {
      return AUTH_PROVIDER_OPERATIONS.IMPLICIT_REFRESH;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Wraps a fetch implementation with isolated, bounded operation state.
 * Each tracker instance supports only one Auth request and must not be shared
 * across concurrent Auth requests because calls overwrite its single operation slot.
 * Each fetch replaces prior state before delegating and preserves thrown errors.
 *
 * @param {(input: unknown, init?: unknown) => Promise<unknown>} fetchImplementation fetch seam
 * @returns {{fetch: Function, getOperation: Function}} tracked fetch and state reader
 */
export function createAuthProviderOperationTracker(fetchImplementation = globalThis.fetch) {
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('auth provider fetch implementation must be a function');
  }

  let operation = null;

  /**
   * Tracks only the bounded operation before forwarding the original arguments.
   * Provider request data remains exclusively in the delegated fetch call.
   *
   * @param {unknown} input fetch input
   * @param {unknown} init fetch initialization options
   * @returns {Promise<unknown>} delegated fetch result
   */
  async function trackedFetch(input, init) {
    operation = classifyAuthProviderOperation(input, init);
    return fetchImplementation(input, init);
  }

  /**
   * Returns the current fixed operation without exposing provider request data.
   *
   * @returns {'getUser'|'implicit_refresh'|null} current request-scoped operation
   */
  function getOperation() {
    return operation;
  }

  return Object.freeze({ fetch: trackedFetch, getOperation });
}
