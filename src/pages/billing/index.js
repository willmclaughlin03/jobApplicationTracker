import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import ProfileDropdown from '../../client/components/ProfileDropdown';
import { useAuth } from '../../client/contexts/AuthContext';
import { api } from '../../client/lib/api.js';
import {
  BILLING_PAGE_ACTIONS,
  runBillingPageRedirectAction,
} from '../../client/lib/billingPageActions.js';
import {
  BILLING_PAGE_LOAD_STATES,
  canOpenPortalFromLocalStatus,
  canStartCheckoutFromLocalStatus,
  getBillingStatusSummary,
} from '../../client/lib/billingPageState.js';
import { BILLING_PLANS } from '../../shared/constants/billing.js';
import { ERROR_MESSAGES } from '../../shared/errors.js';

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

export default function BillingPage() {
  const router = useRouter();
  const { user, loading: authLoading, signOut } = useAuth();
  const [billingStatus, setBillingStatus] = useState(null);
  const [loadState, setLoadState] = useState(BILLING_PAGE_LOAD_STATES.LOADING);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const actionLoadingRef = useRef('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    actionLoadingRef.current = actionLoading;
  }, [actionLoading]);

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
      setErrorMessage('');
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
        setLoadState(BILLING_PAGE_LOAD_STATES.ERROR);
        setErrorMessage(ERROR_MESSAGES.SERVICE_UNAVAILABLE);
        setLoading(false);
        return;
      }

      if (result.data?.error) {
        setBillingStatus(null);
        setLoadState(BILLING_PAGE_LOAD_STATES.ERROR);
        setErrorMessage(result.data.message || 'Failed to load billing status.');
        setLoading(false);
        return;
      }

      setBillingStatus(result.data?.data ?? null);
      setLoadState(BILLING_PAGE_LOAD_STATES.READY);
      setLoading(false);
    }

    loadBillingStatus();

    return () => {
      isCancelled = true;
    };
  }, [router, user]);

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  const handleCheckout = async () => {
    if (loading || actionLoading !== '' || actionLoadingRef.current !== '') {
      return;
    }

    actionLoadingRef.current = BILLING_PAGE_ACTIONS.CHECKOUT;
    setActionLoading(BILLING_PAGE_ACTIONS.CHECKOUT);

    await runBillingPageRedirectAction({
      action: BILLING_PAGE_ACTIONS.CHECKOUT,
      request: () => api.post('/api/billing/checkout', {
        plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
      }),
      setActionLoading,
      setErrorMessage,
      requestFailureMessage: ERROR_MESSAGES.CHECKOUT_SESSION_FAILED,
      fallbackApiFailureMessage: 'Failed to start checkout.',
      missingUrlMessage: 'Checkout did not return a redirect URL.',
      navigationFailedMessage: 'Checkout redirect failed. Please try again.',
    });
  };

  const handlePortal = async () => {
    if (loading || actionLoading !== '' || actionLoadingRef.current !== '') {
      return;
    }

    actionLoadingRef.current = BILLING_PAGE_ACTIONS.PORTAL;
    setActionLoading(BILLING_PAGE_ACTIONS.PORTAL);

    await runBillingPageRedirectAction({
      action: BILLING_PAGE_ACTIONS.PORTAL,
      request: () => api.post('/api/billing/portal', {}),
      setActionLoading,
      setErrorMessage,
      requestFailureMessage: ERROR_MESSAGES.PORTAL_SESSION_FAILED,
      fallbackApiFailureMessage: 'Failed to open the billing portal.',
      missingUrlMessage: 'Billing portal did not return a redirect URL.',
      navigationFailedMessage: 'Billing portal redirect failed. Please try again.',
    });
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
  const showCheckoutButton = canStartCheckoutFromLocalStatus({ billingStatus, loadState });
  const showPortalButton = canOpenPortalFromLocalStatus({ billingStatus, loadState });

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
                Resume Tailor Premium
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

          {errorMessage && (
            <div className="mt-5 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {errorMessage}
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

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            {showCheckoutButton && (
              <button
                type="button"
                onClick={handleCheckout}
                disabled={loading || actionLoading !== ''}
                className="inline-flex items-center justify-center rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                {actionLoading === 'checkout' ? 'Redirecting to checkout...' : 'Start checkout'}
              </button>
            )}

            {showPortalButton && (
              <button
                type="button"
                onClick={handlePortal}
                disabled={loading || actionLoading !== ''}
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
