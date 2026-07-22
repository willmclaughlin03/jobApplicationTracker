import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import ProfileDropdown from '../../client/components/ProfileDropdown';
import { useAuth } from '../../client/contexts/AuthContext';
import {
  BILLING_ACTION_RESULT_STATUSES,
  useBillingActions,
} from '../../client/hooks/useBillingActions.js';
import { api } from '../../client/lib/api.js';
import {
  BILLING_PAGE_LOAD_STATES,
  canOpenPortalFromLocalStatus,
  canStartCheckoutFromLocalStatus,
  getBillingStatusSummary,
} from '../../client/lib/billingPageState.js';
import { BILLING_PLANS } from '../../shared/constants/billing.js';
import {
  formatStorageDate,
  getStorageCount,
  shouldShowPremiumCancelingStorageWarning,
  shouldShowTerminalFreeArchiveCopy,
} from '../../client/lib/storageSummaryUi.js';
import { ERROR_MESSAGES } from '../../shared/errors.js';

const STORAGE_STATUS_UNAVAILABLE_MESSAGE = 'Storage details are temporarily unavailable. Please refresh before relying on archive or downgrade counts.';

/**
 * Format a billing period timestamp for display in the billing summary.
 *
 * Purpose: keep nullable or malformed billing dates from rendering as invalid
 * dates in the page UI.
 *
 * Dependencies:
 * - JavaScript Date and toLocaleString() for browser-local date formatting.
 * - BillingPage uses this helper when rendering currentPeriodEnd from
 *   /api/billing/status.
 *
 * Params:
 * - value {string|number|Date|null|undefined}: raw billing timestamp from the
 *   local billing status response.
 *
 * Returns:
 * - {string} formatted local date text, or "Not set" when the value is absent
 *   or cannot be parsed as a date.
 */
function formatDate(value) {
  if (!value) {
    return 'Not set';
  }

  const asDate = new Date(value);

  if (Number.isNaN(asDate.getTime())) {
    return 'Not set';
  }

  return asDate.toLocaleString();
}

/**
 * Render the authenticated billing management page.
 *
 * Purpose: show the caller's canonical local billing status and route checkout
 * or portal actions through server-created billing redirects.
 *
 * Dependencies:
 * - useAuth for auth state and sign-out handling, useRouter for login
 *   navigation, and ProfileDropdown for the signed-in page header.
 * - api loads /api/billing/status and /api/storage/status; billingPageState
 *   keeps copy and capability checks centralized, while useBillingActions owns
 *   Checkout and portal request, duplicate-action, and redirect behavior.
 * - BILLING_PLANS and ERROR_MESSAGES provide the checkout plan id and shared
 *   failure copy.
 *
 * Params:
 * - none; this Next.js page reads auth, router, and billing state from hooks
 *   and API responses rather than props.
 *
 * Returns:
 * - JSX for the billing status, checkout, and portal controls.
 * - side effects include redirecting unauthenticated users to /login, loading
 *   billing status, signing out unauthorized sessions, and handing successful
 *   checkout or portal actions to the backend-provided redirect URL.
 */
export default function BillingPage() {
  const router = useRouter();
  const { user, loading: authLoading, signOut } = useAuth();
  const [billingStatus, setBillingStatus] = useState(null);
  const [storageSummary, setStorageSummary] = useState(null);
  const [loadState, setLoadState] = useState(BILLING_PAGE_LOAD_STATES.LOADING);
  const [loading, setLoading] = useState(true);
  const [statusErrorMessage, setStatusErrorMessage] = useState('');
  const [storageStatusErrorMessage, setStorageStatusErrorMessage] = useState('');
  const {
    actionLoading,
    actionError,
    retryAfterSeconds,
    resetActionState,
    startCheckout,
    openPortal,
  } = useBillingActions();

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login');
    }
  }, [authLoading, router, user]);

  useEffect(() => {
    if (!user) {
      return;
    }

    let isCancelled = false;

    async function loadBillingStatus() {
      setLoading(true);
      setLoadState(BILLING_PAGE_LOAD_STATES.LOADING);
      setStatusErrorMessage('');
      setStorageStatusErrorMessage('');

      try {
        const result = await api.get('/api/billing/status');

        if (isCancelled) {
          return;
        }

        if (
          result.error === ERROR_MESSAGES.UNAUTHORIZED
          || result.meta?.status === 401
          || (result.data?.error === 'UNAUTHORIZED' && result.data?.status === 401)
        ) {
          await signOut();
          router.replace('/login');
          return;
        }

        if (result.error) {
          setBillingStatus(null);
          setStorageSummary(null);
          setStorageStatusErrorMessage('');
          setLoadState(BILLING_PAGE_LOAD_STATES.ERROR);
          setStatusErrorMessage(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
          setLoading(false);
          return;
        }

        if (result.data?.error) {
          setBillingStatus(null);
          setStorageSummary(null);
          setStorageStatusErrorMessage('');
          setLoadState(BILLING_PAGE_LOAD_STATES.ERROR);
          setStatusErrorMessage(result.data.message || 'Failed to load billing status.');
          setLoading(false);
          return;
        }

        let storageResult;

        try {
          storageResult = await api.get('/api/storage/status');
        } catch {
          storageResult = { data: null, error: STORAGE_STATUS_UNAVAILABLE_MESSAGE, meta: null };
        }

        if (isCancelled) {
          return;
        }

        if (
          storageResult.error === ERROR_MESSAGES.UNAUTHORIZED
          || storageResult.meta?.status === 401
          || (storageResult.data?.error === 'UNAUTHORIZED' && storageResult.data?.status === 401)
        ) {
          await signOut();
          router.replace('/login');
          return;
        }

        const storageStatusFailed = Boolean(storageResult.error || storageResult.data?.error);

        setBillingStatus(result.data?.data ?? null);
        setStorageSummary(storageStatusFailed ? null : storageResult.data?.data ?? null);
        setStorageStatusErrorMessage(storageStatusFailed ? STORAGE_STATUS_UNAVAILABLE_MESSAGE : '');
        setLoadState(BILLING_PAGE_LOAD_STATES.READY);
        setLoading(false);
      } catch {
        if (isCancelled) {
          return;
        }

        setBillingStatus(null);
        setStorageSummary(null);
        setStorageStatusErrorMessage('');
        setLoadState(BILLING_PAGE_LOAD_STATES.ERROR);
        setStatusErrorMessage(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
        setLoading(false);
      }
    }

    loadBillingStatus();

    return () => {
      isCancelled = true;
    };
    // AuthContext recreates signOut; depending on it would repeat this load after provider renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, user]);

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  /**
   * Route typed unauthorized action failures through the existing auth recovery.
   *
   * @param {{ status: string, error: object|null }} outcome - Shared hook result.
   * @returns {Promise<void>}
   */
  const handleBillingActionOutcome = async (outcome) => {
    if (
      outcome.status !== BILLING_ACTION_RESULT_STATUSES.ERROR
      || (outcome.error?.code !== 'UNAUTHORIZED' && outcome.error?.httpStatus !== 401)
    ) {
      return;
    }

    resetActionState();
    await signOut();
    router.replace('/login');
  };

  /**
   * Start canonical Premium Checkout through the shared billing action hook.
   *
   * Purpose: honor the billing-page `loading` guard before passing
   * `BILLING_PLANS.PREMIUM_MONTHLY` to `startCheckout`, which owns the shared
   * action state and redirect hand-off.
   *
   * Side effects: on success the hook navigates to the server-provided Checkout
   * URL; unauthorized outcomes pass through `handleBillingActionOutcome`, which
   * resets action state, signs out, and replaces the current route with `/login`.
   *
   * @returns {Promise<void>}
   */
  const handleCheckout = async () => {
    if (loading) {
      return;
    }

    const outcome = await startCheckout(BILLING_PLANS.PREMIUM_MONTHLY);
    await handleBillingActionOutcome(outcome);
  };

  /**
   * Open the Billing Portal through the same mutually exclusive action hook.
   *
   * Purpose: honor the billing-page `loading` guard before calling `openPortal`,
   * which owns the shared action state and redirect hand-off.
   *
   * Side effects: on success the hook navigates to the server-provided Portal
   * URL; unauthorized outcomes pass through `handleBillingActionOutcome`, which
   * resets action state, signs out, and replaces the current route with `/login`.
   *
   * @returns {Promise<void>}
   */
  const handlePortal = async () => {
    if (loading) {
      return;
    }

    const outcome = await openPortal();
    await handleBillingActionOutcome(outcome);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 text-gray-500">
        Loading...
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const summary = getBillingStatusSummary({ billingStatus, loadState });
  const showPremiumStorageWarning = shouldShowPremiumCancelingStorageWarning(storageSummary);
  const showTerminalFreeArchiveNotice = shouldShowTerminalFreeArchiveCopy(storageSummary);
  const storagePeriodEnd = formatStorageDate(storageSummary?.currentPeriodEnd) ?? 'your current period end';
  const storageActiveLimit = getStorageCount(storageSummary?.activeLimit);
  const storageActiveCount = getStorageCount(storageSummary?.activeCount);
  const storageOverflowCount = getStorageCount(storageSummary?.projectedOverflowCount);
  const storageLockedCount = getStorageCount(storageSummary?.lockedCount);
  const showCheckoutButton = canStartCheckoutFromLocalStatus({ billingStatus, loadState });
  const showPortalButton = canOpenPortalFromLocalStatus({ billingStatus, loadState });
  const retryCooldownActive = Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0;
  const billingActionDisabled = loading || actionLoading !== '' || retryCooldownActive;

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm py-4 px-6">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-gray-500">Account</p>
            <h1 className="text-xl font-semibold text-gray-800">Billing</h1>
          </div>
          <ProfileDropdown user={user} onSignOut={handleSignOut} />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm uppercase tracking-wide text-blue-600 font-semibold">
                Premium
              </p>
              <h2 className="text-2xl font-semibold text-gray-900 mt-1">{summary.title}</h2>
              <p className="text-gray-600 mt-2 max-w-2xl">{summary.description}</p>
            </div>
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Back to dashboard
            </Link>
          </div>

          {statusErrorMessage && (
            <div className="mt-5 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              <span role='alert'>{statusErrorMessage}</span>
            </div>
          )}

          {actionError && (
            <div
              role='alert'
              className='mt-5 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700'
            >
              {actionError.message}
              {retryCooldownActive && ' Try again in ' + retryAfterSeconds + 's.'}
            </div>
          )}

          {storageStatusErrorMessage && (
            <div
              role="status"
              aria-live="polite"
              className="mt-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              {storageStatusErrorMessage}
            </div>
          )}

          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="text-sm text-gray-500">Local status</p>
              <p className="mt-1 text-lg font-medium text-gray-900">
                {loading ? 'Loading...' : billingStatus?.status ?? 'none'}
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="text-sm text-gray-500">Current period end</p>
              <p className="mt-1 text-lg font-medium text-gray-900">
                {loading ? 'Loading...' : formatDate(billingStatus?.currentPeriodEnd)}
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="text-sm text-gray-500">Cancel at period end</p>
              <p className="mt-1 text-lg font-medium text-gray-900">
                {loading ? 'Loading...' : billingStatus?.cancelAtPeriodEnd ? 'Yes' : 'No'}
              </p>
            </div>
          </div>

          {(showPremiumStorageWarning || showTerminalFreeArchiveNotice) && (
            <div className="mt-6 rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm text-blue-950">
              {showPremiumStorageWarning && (
                <div>
                  <h3 className="font-semibold">Storage after cancellation</h3>
                  <p className="mt-1 leading-6">
                    Your Premium plan ends on {storagePeriodEnd}. Free accounts can keep {storageActiveLimit}
                    {' '}active applications. You currently have {storageActiveCount}, so {storageOverflowCount}
                    {' '}will move to a locked archive if you do not renew. Nothing will be deleted.
                  </p>
                </div>
              )}
              {showTerminalFreeArchiveNotice && (
                <div>
                  <h3 className="font-semibold">Free storage archive</h3>
                  <p className="mt-1 leading-6">
                    Your Free account has {storageActiveCount} active applications and {storageLockedCount}
                    {' '}archived application{storageLockedCount === 1 ? '' : 's'}. Free accounts can keep
                    {' '}{storageActiveLimit} active applications.
                  </p>
                  {storageLockedCount > 0 && (
                    <>
                      {/* This API navigation intentionally triggers a browser-managed CSV download. */}
                      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                      <a
                        href="/api/storage/export"
                        className="mt-3 inline-flex items-center justify-center rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
                      >
                        Export CSV
                      </a>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            {showCheckoutButton && (
              <button
                type="button"
                onClick={handleCheckout}
                disabled={billingActionDisabled}
                className="inline-flex items-center justify-center rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                {actionLoading === 'checkout' ? 'Redirecting to checkout...' : 'Start checkout'}
              </button>
            )}

            {showPortalButton && (
              <button
                type="button"
                onClick={handlePortal}
                disabled={billingActionDisabled}
                className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed"
              >
                {actionLoading === 'portal' ? 'Opening portal...' : 'Open billing portal'}
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
