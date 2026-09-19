import { applyProtectedPageCache } from '../../server/lib/protectedPageCache.js';

/**
 * Opt this protected shell into request-time rendering and prevent CDN storage.
 * Middleware and existing client/API guards retain their authentication duties;
 * no user data or credentials are serialized into props by this cache boundary.
 * @param {import('next').GetServerSidePropsContext} context - Page response.
 * @returns {Promise<{props: object}>} Empty props for the existing client shell.
 */
export async function getServerSideProps({ res }) {
  applyProtectedPageCache(res);
  return { props: {} };
}

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { ArrowLeft, ArrowRight, CreditCard, Download, ExternalLink } from 'lucide-react';
import ProfileDropdown from '../../client/components/ProfileDropdown';
import PublicPageShell, {
  PUBLIC_PRIMARY_ACTION_CLASS_NAME,
  PUBLIC_SECONDARY_ACTION_CLASS_NAME,
} from '../../client/components/public/PublicPageShell';
import Spinner from '../../client/components/Spinner';
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
      <PublicPageShell>
        <div role="status" aria-live="polite" className="flex items-center gap-3 text-dashboard-body text-dashboard-muted">
          <Spinner size="sm" className="text-dashboard-accent" />
          <span>Loading...</span>
        </div>
      </PublicPageShell>
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
  const statusUnavailable = loadState === BILLING_PAGE_LOAD_STATES.ERROR || (!loading && !billingStatus);

  return (
    <PublicPageShell
      layout="billing"
      contentTestId="billing-panel"
      headerActions={<ProfileDropdown user={user} onSignOut={handleSignOut} />}
    >
      <div className="mb-6 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-dashboard-text sm:text-dashboard-heading">Billing</h1>
          <p className="mt-1 text-dashboard-body text-dashboard-muted">Manage your subscription and billing details.</p>
        </div>
        <Link href="/" className={[PUBLIC_SECONDARY_ACTION_CLASS_NAME, 'shrink-0 sm:w-auto'].join(' ')}>
          <ArrowLeft aria-hidden="true" size={16} />
          Back to dashboard
        </Link>
      </div>

      <section aria-labelledby="billing-summary-heading" className="dashboard-major-panel p-5 sm:p-7">
        <div role="status" aria-live="polite" aria-atomic="true">
          <p className="flex items-center gap-2 text-dashboard-caption font-semibold uppercase tracking-wider text-dashboard-accent">
            <CreditCard aria-hidden="true" size={16} />
            {billingStatus?.entitled && !statusUnavailable ? 'Premium' : 'Subscription'}
          </p>
          <h2 id="billing-summary-heading" className="mt-3 text-xl font-semibold tracking-tight text-dashboard-text sm:text-2xl">{summary.title}</h2>
          <p className="mt-2 max-w-2xl text-dashboard-body leading-6 text-dashboard-muted">{summary.description}</p>
        </div>

        {statusErrorMessage && (
          <div className="mt-5 rounded-dashboard-control border border-red-400/55 bg-red-500/10 px-4 py-3 text-dashboard-body text-red-100">
            <span role='alert'>{statusErrorMessage}</span>
          </div>
        )}

        {actionError && (
          <div
            role='alert'
            className="mt-5 rounded-dashboard-control border border-red-400/55 bg-red-500/10 px-4 py-3 text-dashboard-body text-red-100"
          >
            {actionError.message}
            {retryCooldownActive && ' Try again in ' + retryAfterSeconds + 's.'}
          </div>
        )}

        {storageStatusErrorMessage && (
          <div
            role="status"
            aria-live="polite"
            className="mt-5 rounded-dashboard-control border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-dashboard-body text-amber-100"
          >
            {storageStatusErrorMessage}
          </div>
        )}

        <dl className="mt-7 grid gap-3 md:grid-cols-3">
          <div className="min-w-0 rounded-dashboard-control border border-dashboard-line bg-dashboard-surface-raised/70 p-4">
            <dt className="text-dashboard-caption text-dashboard-muted">Subscription status</dt>
            <dd className="mt-2 break-words text-base font-medium capitalize text-dashboard-text">
              {loading ? 'Loading...' : statusUnavailable ? 'Unavailable' : billingStatus?.status ?? 'none'}
            </dd>
          </div>
          <div className="min-w-0 rounded-dashboard-control border border-dashboard-line bg-dashboard-surface-raised/70 p-4">
            <dt className="text-dashboard-caption text-dashboard-muted">Billing period ends</dt>
            <dd className="mt-2 break-words text-base font-medium text-dashboard-text">
              {loading ? 'Loading...' : statusUnavailable ? 'Unavailable' : formatDate(billingStatus?.currentPeriodEnd)}
            </dd>
          </div>
          <div className="min-w-0 rounded-dashboard-control border border-dashboard-line bg-dashboard-surface-raised/70 p-4">
            <dt className="text-dashboard-caption text-dashboard-muted">Cancels at period end</dt>
            <dd className="mt-2 text-base font-medium text-dashboard-text">
              {loading ? 'Loading...' : statusUnavailable ? 'Unavailable' : billingStatus?.cancelAtPeriodEnd ? 'Yes' : 'No'}
            </dd>
          </div>
        </dl>

        {(showPremiumStorageWarning || showTerminalFreeArchiveNotice) && (
          <div className={[
            'mt-6 rounded-dashboard-control border p-4 text-dashboard-body',
            showPremiumStorageWarning
              ? 'border-amber-400/40 bg-amber-500/10 text-amber-100'
              : 'border-dashboard-line bg-dashboard-surface-raised/70 text-dashboard-text',
          ].join(' ')}>
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
                      className={[PUBLIC_SECONDARY_ACTION_CLASS_NAME, 'mt-4 sm:w-auto'].join(' ')}
                    >
                      <Download aria-hidden="true" size={16} />
                      Export CSV
                    </a>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {showCheckoutButton && (
            <button
              type="button"
              onClick={handleCheckout}
              disabled={billingActionDisabled}
              aria-busy={actionLoading === 'checkout' || undefined}
              className={[PUBLIC_PRIMARY_ACTION_CLASS_NAME, 'justify-center gap-3 sm:w-auto'].join(' ')}
            >
              {actionLoading === 'checkout' && <Spinner size="sm" className="shrink-0 text-dashboard-accent" />}
              {actionLoading === 'checkout' ? 'Redirecting to checkout...' : 'Start checkout'}
              {actionLoading !== 'checkout' && <ArrowRight aria-hidden="true" size={16} className="shrink-0 text-dashboard-accent" />}
            </button>
          )}

          {showPortalButton && (
            <button
              type="button"
              onClick={handlePortal}
              disabled={billingActionDisabled}
              aria-busy={actionLoading === 'portal' || undefined}
              className={[
                showCheckoutButton ? PUBLIC_SECONDARY_ACTION_CLASS_NAME : PUBLIC_PRIMARY_ACTION_CLASS_NAME,
                'justify-center gap-3 sm:w-auto',
              ].join(' ')}
            >
              {actionLoading === 'portal' && <Spinner size="sm" className="shrink-0 text-dashboard-accent" />}
              {actionLoading === 'portal' ? 'Opening portal...' : 'Open billing portal'}
              {actionLoading !== 'portal' && <ExternalLink aria-hidden="true" size={16} className="shrink-0 text-dashboard-accent" />}
            </button>
          )}
        </div>
      </section>
    </PublicPageShell>
  );
}
