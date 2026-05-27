export const BILLING_PAGE_ACTIONS = Object.freeze({
  CHECKOUT: 'checkout',
  PORTAL: 'portal',
});

const BILLING_REDIRECT_ALLOWED_STRIPE_HOSTS = new Set([
  'checkout.stripe.com',
  'billing.stripe.com',
]);
const BILLING_REDIRECT_ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

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
  const safeRedirectUrl = getAllowedBillingRedirectUrl(redirectUrl);

  if (!safeRedirectUrl) {
    return {
      redirectUrl: null,
      errorMessage: missingUrlMessage,
    };
  }

  return {
    redirectUrl: safeRedirectUrl,
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
  const safeRedirectUrl = getAllowedBillingRedirectUrl(redirectResult.redirectUrl);

  if (!safeRedirectUrl) {
    setActionLoading('');
    setErrorMessage(missingUrlMessage);
    return;
  }

  try {
    performNavigation(safeRedirectUrl);
  } catch (error) {
    setActionLoading('');
    setErrorMessage(navigationFailedMessage);
  }
}
