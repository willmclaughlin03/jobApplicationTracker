import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../client/contexts/AuthContext';
import { api } from '../../client/lib/api.js';
import {
  BILLING_SUCCESS_OUTCOMES,
  getBillingSuccessPollScheduleText,
  getBillingSuccessRefreshButtonLabel,
  getExhaustedPollingOutcome,
  getNextPollDelayMs,
  isBillingSuccessRefreshDisabled,
  interpretCheckoutStatusPollResult,
} from '../../client/lib/billingSuccessFlow.js';

function getSessionId(queryValue) {
  if (Array.isArray(queryValue)) {
    return queryValue[0] ?? '';
  }

  return typeof queryValue === 'string' ? queryValue : '';
}

function getOutcomeCopy(outcome, checkoutState) {
  switch (outcome) {
    case BILLING_SUCCESS_OUTCOMES.ACTIVE:
      return {
        title: 'Premium access is active',
        description: 'Your local billing state is active and premium access is ready to use.',
      };
    case BILLING_SUCCESS_OUTCOMES.REAUTH:
      return {
        title: 'Sign in required',
        description: 'Your session expired while billing was finishing. Sign in again to continue.',
      };
    case BILLING_SUCCESS_OUTCOMES.RATE_LIMITED:
      return {
        title: 'Polling paused',
        description: 'The billing write rate limit was reached. Refresh this page in a moment to continue.',
      };
    case BILLING_SUCCESS_OUTCOMES.UNAVAILABLE:
      return {
        title: 'Billing is temporarily unavailable',
        supportLines: [
          'Your payment may have completed, but we couldn’t confirm the local billing update yet.',
          'Please refresh this page or return in a few minutes to check again.',
          'If premium access still doesn’t appear, contact support at tracktheapp.support@gmail.com.',
        ],
      };
    case BILLING_SUCCESS_OUTCOMES.MANUAL_REFRESH:
      return {
        title: 'Still processing',
        description: checkoutState === 'free'
          ? 'Checkout completed, but the local billing state is still catching up. Refresh this page to check again.'
          : 'Stripe is still finishing the checkout flow. Refresh this page to check again.',
      };
    case BILLING_SUCCESS_OUTCOMES.ERROR:
      return {
        title: 'Checkout could not be confirmed',
        description: 'The redirect completed, but premium access was not confirmed from local billing state.',
      };
    case BILLING_SUCCESS_OUTCOMES.CONTINUE:
    default:
      return {
        title: 'Finalizing billing',
        description: checkoutState === 'free'
          ? 'Checkout completed. Waiting for the local billing state to reflect the update.'
          : 'Waiting for Stripe to finish the checkout flow.',
      };
  }
}

export default function BillingSuccessPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [outcome, setOutcome] = useState(BILLING_SUCCESS_OUTCOMES.CONTINUE);
  const [checkoutState, setCheckoutState] = useState('pending');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [rateLimitCooldownSeconds, setRateLimitCooldownSeconds] = useState(null);

  const sessionId = useMemo(
    () => getSessionId(router.query.session_id),
    [router.query.session_id]
  );

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login');
    }
  }, [authLoading, router, user]);

  useEffect(() => {
    if (!router.isReady || authLoading || !user) {
      return undefined;
    }

    if (!sessionId) {
      setOutcome(BILLING_SUCCESS_OUTCOMES.ERROR);
      setCheckoutState('error');
      return undefined;
    }

    let isCancelled = false;
    const timers = [];
    setRateLimitCooldownSeconds(null);

    async function runPoll(pollIndex) {
      const result = await api.post('/api/billing/checkout-status', { sessionId });

      if (isCancelled) {
        return;
      }

      const interpreted = interpretCheckoutStatusPollResult(result);
      setRateLimitCooldownSeconds(
        interpreted.outcome === BILLING_SUCCESS_OUTCOMES.RATE_LIMITED
          ? interpreted.retryAfterSeconds ?? null
          : null
      );

      if (interpreted.outcome === BILLING_SUCCESS_OUTCOMES.CONTINUE) {
        setOutcome(BILLING_SUCCESS_OUTCOMES.CONTINUE);
        setCheckoutState(interpreted.checkoutState);

        const nextDelayMs = getNextPollDelayMs(pollIndex);

        if (nextDelayMs === null) {
          setOutcome(getExhaustedPollingOutcome(interpreted.checkoutState));
          return;
        }

        const timer = window.setTimeout(() => {
          runPoll(pollIndex + 1);
        }, nextDelayMs);
        timers.push(timer);
        return;
      }

      setOutcome(interpreted.outcome);
      if (interpreted.checkoutState) {
        setCheckoutState(interpreted.checkoutState);
      }
    }

    runPoll(0);

    return () => {
      isCancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [authLoading, refreshVersion, router.isReady, sessionId, user]);

  useEffect(() => {
    if (!Number.isFinite(rateLimitCooldownSeconds) || rateLimitCooldownSeconds <= 0) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setRateLimitCooldownSeconds((currentValue) => {
        if (!Number.isFinite(currentValue) || currentValue <= 1) {
          return null;
        }

        return currentValue - 1;
      });
    }, 1000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [rateLimitCooldownSeconds]);

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

  const copy = getOutcomeCopy(outcome, checkoutState);
  const refreshDisabled = isBillingSuccessRefreshDisabled(rateLimitCooldownSeconds);
  const refreshButtonLabel = getBillingSuccessRefreshButtonLabel(rateLimitCooldownSeconds);

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <p className="text-sm uppercase tracking-wide text-blue-600 font-semibold">
          Billing
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-gray-900">{copy.title}</h1>
        {copy.description && (
          <p className="mt-3 text-gray-600">{copy.description}</p>
        )}
        {copy.supportLines?.map((line) => (
          <p key={line} className="mt-3 text-gray-600">
            {line}
          </p>
        ))}

        <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <p className="text-sm text-gray-500">Polling schedule</p>
          <p className="mt-1 text-sm text-gray-700">
            {getBillingSuccessPollScheduleText()}
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          {(outcome === BILLING_SUCCESS_OUTCOMES.MANUAL_REFRESH
            || outcome === BILLING_SUCCESS_OUTCOMES.UNAVAILABLE
            || outcome === BILLING_SUCCESS_OUTCOMES.RATE_LIMITED) && (
            <button
              type="button"
              onClick={() => setRefreshVersion((value) => value + 1)}
              disabled={refreshDisabled}
              className="inline-flex items-center justify-center rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
            >
              {refreshButtonLabel}
            </button>
          )}

          {outcome === BILLING_SUCCESS_OUTCOMES.REAUTH ? (
            <button
              type="button"
              onClick={() => router.push('/login')}
              className="inline-flex items-center justify-center rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Sign in again
            </button>
          ) : (
            <Link
              href="/billing"
              className="inline-flex items-center justify-center rounded-md border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Back to billing
            </Link>
          )}

          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
