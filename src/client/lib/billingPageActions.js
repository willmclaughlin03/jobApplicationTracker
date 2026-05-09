export const BILLING_PAGE_ACTIONS = Object.freeze({
  CHECKOUT: 'checkout',
  PORTAL: 'portal',
});

/**
 * Generate a per-attempt checkout nonce from browser crypto.
 *
 * Purpose: Stripe idempotency should dedupe duplicate submits of the same
 * click attempt without reusing one Checkout Session URL across unrelated
 * retries later in the hour.
 *
 * @param {Crypto | { getRandomValues: (array: Uint8Array) => Uint8Array }} [cryptoApi]
 * @returns {string}
 */
export function generateCheckoutAttemptNonce(cryptoApi = globalThis.crypto) {
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('Secure billing nonce generation is unavailable');
  }

  const nonceBytes = new Uint8Array(16);
  cryptoApi.getRandomValues(nonceBytes);

  return Array.from(nonceBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve a shared-client billing redirect response into either a redirect URL
 * or a user-facing error message.
 *
 * Purpose: checkout and portal flows share the same response contract, so this
 * helper keeps result-shape parsing and fallback messaging aligned.
 *
 * @param {object} params
 * @param {{ data?: any, error?: string | null } | null | undefined} params.result
 * @param {string} params.requestFailureMessage
 * @param {string} params.fallbackApiFailureMessage
 * @param {string} params.missingUrlMessage
 * @returns {{ redirectUrl: string | null, errorMessage: string | null }}
 */
export function resolveBillingRedirectResult({
  result,
  requestFailureMessage,
  fallbackApiFailureMessage,
  missingUrlMessage,
}) {
  if (result?.error) {
    return {
      redirectUrl: null,
      errorMessage: requestFailureMessage,
    };
  }

  if (result?.data?.error) {
    return {
      redirectUrl: null,
      errorMessage: result.data.message || fallbackApiFailureMessage,
    };
  }

  const redirectUrl = typeof result?.data?.data?.url === 'string'
    ? result.data.data.url
    : null;

  if (!redirectUrl) {
    return {
      redirectUrl: null,
      errorMessage: missingUrlMessage,
    };
  }

  return {
    redirectUrl,
    errorMessage: null,
  };
}

/**
 * Run one billing-page action that should end in a browser redirect.
 *
 * Purpose: keep the loading state latched until navigation handoff succeeds,
 * while still clearing it for request failures, API failures, missing URLs, or
 * thrown navigation errors.
 *
 * @param {object} params
 * @param {'checkout' | 'portal'} params.action
 * @param {() => Promise<{ data?: any, error?: string | null }>} params.request
 * @param {(value: string) => void} params.setActionLoading
 * @param {(value: string) => void} params.setErrorMessage
 * @param {string} params.requestFailureMessage
 * @param {string} params.fallbackApiFailureMessage
 * @param {string} params.missingUrlMessage
 * @param {string} params.navigationFailedMessage
 * @param {(url: string) => void} [params.navigate]
 * @returns {Promise<void>}
 */
export async function runBillingPageRedirectAction({
  action,
  request,
  setActionLoading,
  setErrorMessage,
  requestFailureMessage,
  fallbackApiFailureMessage,
  missingUrlMessage,
  navigationFailedMessage,
  navigate,
}) {
  setActionLoading(action);
  setErrorMessage('');

  let result;

  try {
    result = await request();
  } catch (error) {
    setActionLoading('');
    setErrorMessage(requestFailureMessage);
    return;
  }

  const redirectResult = resolveBillingRedirectResult({
    result,
    requestFailureMessage,
    fallbackApiFailureMessage,
    missingUrlMessage,
  });

  if (redirectResult.errorMessage) {
    setActionLoading('');
    setErrorMessage(redirectResult.errorMessage);
    return;
  }

  const performNavigation = navigate ?? ((url) => window.location.assign(url));

  try {
    performNavigation(redirectResult.redirectUrl);
  } catch (error) {
    setActionLoading('');
    setErrorMessage(navigationFailedMessage);
  }
}
