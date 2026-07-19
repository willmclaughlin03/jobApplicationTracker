import { ERROR_MESSAGES } from '../../shared/errors.js';

export const BILLING_PAGE_ACTIONS = Object.freeze({
  CHECKOUT: 'checkout',
  PORTAL: 'portal',
});

const BILLING_REDIRECT_ALLOWED_STRIPE_HOSTS = new Set([
  'checkout.stripe.com',
  'billing.stripe.com',
]);
const BILLING_REDIRECT_ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const CHECKOUT_STATUS_CHANGED_MESSAGE = 'Your billing status changed. Review billing before continuing.';

/**
 * Create fresh secure entropy for one submitted Checkout attempt.
 *
 * Purpose: return the API's lowercase 32-hex nonce format through either
 * supported browser crypto path and fail closed if neither path is usable.
 *
 * @param {Crypto | null | undefined} [cryptoSource] - Optional testable crypto provider.
 * @returns {string} Lowercase 32-character hexadecimal nonce.
 * @throws {Error} When secure nonce generation is unavailable.
 */
export function createCheckoutAttemptNonce(
  cryptoSource = typeof globalThis !== 'undefined' ? globalThis.crypto : null
) {
  if (typeof cryptoSource?.randomUUID === 'function') {
    try {
      const rawUuid = cryptoSource.randomUUID();
      const uuidNonce = typeof rawUuid === 'string'
        ? rawUuid.replace(/-/g, '').toLowerCase()
        : '';

      if (/^[0-9a-f]{32}$/.test(uuidNonce)) {
        return uuidNonce;
      }
    } catch {
      // Continue to the independent secure-random-bytes fallback below.
    }
  }

  if (typeof cryptoSource?.getRandomValues === 'function') {
    try {
      const randomBytes = new Uint8Array(16);
      cryptoSource.getRandomValues(randomBytes);
      const bytesNonce = Array.from(
        randomBytes,
        (byte) => byte.toString(16).padStart(2, '0')
      ).join('');

      if (/^[0-9a-f]{32}$/.test(bytesNonce)) {
        return bytesNonce;
      }
    } catch {
      // Both secure browser entropy paths are unavailable; fail closed below.
    }
  }

  throw new Error('Secure checkout nonce generation is unavailable');
}

/**
 * Build the narrow sanitized error contract exposed to billing consumers.
 *
 * @param {object} params - Safe error fields.
 * @returns {{ code: string|null, message: string, httpStatus: number|null, retryAfterSeconds: number|null }}
 */
export function createBillingActionError({
  code = null,
  message,
  httpStatus = null,
  retryAfterSeconds = null,
}) {
  return {
    code: typeof code === 'string' && code ? code : null,
    message,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    retryAfterSeconds: Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 0
      ? retryAfterSeconds
      : null,
  };
}

/**
 * Read safe HTTP and Retry-After metadata from a shared-client result.
 *
 * Purpose: preserve response details for typed outcomes while tolerating the
 * legacy body-coded status shape used by existing auth tests.
 *
 * @param {object | null | undefined} result - Shared API client result.
 * @returns {{ httpStatus: number|null, retryAfterSeconds: number|null }}
 */
function getBillingResponseMeta(result) {
  const status = [result?.meta?.status, result?.data?.status]
    .find((value) => Number.isInteger(value) && value >= 100 && value <= 599);
  const retryAfterSeconds = result?.meta?.retryAfterSeconds;

  return {
    httpStatus: status ?? null,
    retryAfterSeconds: Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 0
      ? retryAfterSeconds
      : null,
  };
}

/**
 * Parse and allowlist a billing redirect URL before browser navigation.
 *
 * Purpose: checkout and portal redirects are backend-created but still cross an
 * untrusted network boundary before reaching the browser, so client navigation
 * is limited to current-origin URLs or known Stripe billing hosts.
 *
 * @param {unknown} rawUrl
 * @returns {string | null}
 */
function getAllowedBillingRedirectUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return null;
  }

  const trimmedUrl = rawUrl.trim();

  if (!trimmedUrl) {
    return null;
  }

  const browserLocation = typeof window !== 'undefined' ? window.location : null;
  const baseOrigin = typeof browserLocation?.origin === 'string'
    ? browserLocation.origin
    : undefined;

  let parsedUrl;

  try {
    parsedUrl = baseOrigin
      ? new URL(trimmedUrl, baseOrigin)
      : new URL(trimmedUrl);
  } catch (error) {
    return null;
  }

  if (!BILLING_REDIRECT_ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
    return null;
  }

  const isCurrentOrigin = typeof browserLocation?.origin === 'string'
    && parsedUrl.origin === browserLocation.origin;
  const isStripeBillingHost = BILLING_REDIRECT_ALLOWED_STRIPE_HOSTS.has(parsedUrl.host);

  if (!isCurrentOrigin && !isStripeBillingHost) {
    return null;
  }

  if (isStripeBillingHost && parsedUrl.protocol !== 'https:') {
    return null;
  }

  return parsedUrl.href;
}

/**
 * Map one failed shared-client result to approved action-specific UI copy.
 *
 * Purpose: preserve codes and response metadata without rendering raw server
 * messages or Stripe-adjacent response payloads.
 *
 * @param {object} params - Action, response, and safe fallback copy.
 * @returns {ReturnType<typeof createBillingActionError> | null}
 */
function getBillingResultError({ action, result, requestFailureMessage, fallbackApiFailureMessage }) {
  const { httpStatus, retryAfterSeconds } = getBillingResponseMeta(result);
  const code = typeof result?.data?.error === 'string' ? result.data.error : null;

  /** Create one error using the response metadata shared by this mapper call. */
  const buildError = (errorCode, message, status = httpStatus) => createBillingActionError({
    code: errorCode,
    message,
    httpStatus: status,
    retryAfterSeconds,
  });

  if (httpStatus === 401 || code === 'UNAUTHORIZED' || result?.error === ERROR_MESSAGES.UNAUTHORIZED) {
    return buildError('UNAUTHORIZED', ERROR_MESSAGES.UNAUTHORIZED, httpStatus ?? 401);
  }
  if (result?.error) {
    return buildError(null, requestFailureMessage);
  }
  if (httpStatus === 400 || code === 'VALIDATION_ERROR') {
    return buildError(code ?? 'VALIDATION_ERROR', ERROR_MESSAGES.VALIDATION_ERROR);
  }
  if (httpStatus === 403 || code === 'CSRF_VALIDATION_FAILED') {
    return buildError(code ?? 'CSRF_VALIDATION_FAILED', ERROR_MESSAGES.CSRF_VALIDATION_FAILED);
  }
  if (httpStatus === 429 || code === 'RATE_LIMIT_EXCEEDED') {
    return buildError(code ?? 'RATE_LIMIT_EXCEEDED', ERROR_MESSAGES.RATE_LIMIT_EXCEEDED);
  }
  if (code === 'BILLING_CHECKOUT_DISABLED') {
    return buildError(code, ERROR_MESSAGES.BILLING_CHECKOUT_DISABLED);
  }
  if (httpStatus === 409 && action === BILLING_PAGE_ACTIONS.CHECKOUT) {
    return buildError(code, CHECKOUT_STATUS_CHANGED_MESSAGE);
  }
  if (code === 'SERVICE_UNAVAILABLE' || (httpStatus === 503 && !code)) {
    return buildError(code, ERROR_MESSAGES.SERVICE_UNAVAILABLE);
  }
  if (code === 'CHECKOUT_SESSION_FAILED') {
    return buildError(code, ERROR_MESSAGES.CHECKOUT_SESSION_FAILED);
  }
  if (code === 'PORTAL_SESSION_FAILED') {
    return buildError(code, ERROR_MESSAGES.PORTAL_SESSION_FAILED);
  }
  if (code || (httpStatus !== null && httpStatus >= 400)) {
    return buildError(code, fallbackApiFailureMessage);
  }

  return null;
}

/**
 * Resolve a shared-client response into an allowlisted URL or structured error.
 *
 * @param {object} params - Response plus action-specific safe copy.
 * @returns {{ redirectUrl: string|null, error: ReturnType<typeof createBillingActionError>|null }}
 */
export function resolveBillingRedirectResult({
  action = BILLING_PAGE_ACTIONS.CHECKOUT,
  result,
  requestFailureMessage,
  fallbackApiFailureMessage,
  missingUrlMessage,
}) {
  const error = getBillingResultError({
    action,
    result,
    requestFailureMessage,
    fallbackApiFailureMessage,
  });

  if (error) {
    return { redirectUrl: null, error };
  }

  const redirectUrl = getAllowedBillingRedirectUrl(result?.data?.data?.url);

  if (!redirectUrl) {
    return {
      redirectUrl: null,
      error: createBillingActionError({
        message: missingUrlMessage,
        ...getBillingResponseMeta(result),
      }),
    };
  }

  return { redirectUrl, error: null };
}

/**
 * Execute one billing request and hand its allowlisted URL to navigation.
 *
 * Purpose: give the shared hook one canonical request, response normalization,
 * redirect validation, and navigation path for every billing action consumer.
 *
 * @param {object} params - Action request, safe copy, and optional navigator.
 * @param {() => boolean} [params.shouldNavigate] - Optional lifecycle guard
 * checked immediately before navigation.
 * @returns {Promise<{ redirected: boolean, error: ReturnType<typeof createBillingActionError>|null }>}
 */
export async function executeBillingRedirectAction({
  action,
  request,
  requestFailureMessage,
  fallbackApiFailureMessage,
  missingUrlMessage,
  navigationFailedMessage,
  navigate,
  shouldNavigate,
}) {
  let result;

  try {
    result = await request();
  } catch (error) {
    return {
      redirected: false,
      error: createBillingActionError({ message: requestFailureMessage }),
    };
  }

  const resolved = resolveBillingRedirectResult({
    action,
    result,
    requestFailureMessage,
    fallbackApiFailureMessage,
    missingUrlMessage,
  });

  if (resolved.error) {
    return { redirected: false, error: resolved.error };
  }

  const safeRedirectUrl = getAllowedBillingRedirectUrl(resolved.redirectUrl);

  if (!safeRedirectUrl) {
    return {
      redirected: false,
      error: createBillingActionError({
        message: missingUrlMessage,
        ...getBillingResponseMeta(result),
      }),
    };
  }

  try {
    if (typeof shouldNavigate === 'function' && !shouldNavigate()) {
      return { redirected: false, error: null };
    }

    (navigate ?? ((url) => window.location.assign(url)))(safeRedirectUrl);
  } catch (error) {
    return {
      redirected: false,
      error: createBillingActionError({
        message: navigationFailedMessage,
        ...getBillingResponseMeta(result),
      }),
    };
  }

  return { redirected: true, error: null };
}
