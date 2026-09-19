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
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { ArrowRight, CheckCircle2, CircleAlert, Clock3, RefreshCw } from 'lucide-react';
import PublicPageShell, {
  PUBLIC_PRIMARY_ACTION_CLASS_NAME,
  PUBLIC_SECONDARY_ACTION_CLASS_NAME,
} from '../../client/components/public/PublicPageShell';
import Spinner from '../../client/components/Spinner';
import { useAuth } from '../../client/contexts/AuthContext';
import { api } from '../../client/lib/api.js';
import {
  BILLING_SUCCESS_OUTCOMES,
  getBillingSuccessRefreshButtonLabel,
  getExhaustedPollingOutcome,
  getNextPollDelayMs,
  isBillingSuccessRefreshDisabled,
  interpretCheckoutStatusPollResult,
} from '../../client/lib/billingSuccessFlow.js';

/**
 * Normalize the Stripe Checkout Session query param from the router.
 *
 * Purpose: keep success-page polling tied to one session id string even when
 * the query param is absent or repeated.
 *
 * Dependencies:
 * - Next.js router query handling, where session_id may arrive as a string,
 *   an array of strings, or undefined before router readiness settles.
 *
 * Params:
 * - queryValue {string|string[]|undefined}: raw router.query.session_id value.
 *
 * Returns:
 * - {string} the first session id value when present, otherwise an empty
 *   string; no side effects.
 */
function getSessionId(queryValue) {
  if (Array.isArray(queryValue)) {
    return queryValue[0] ?? '';
  }

  return typeof queryValue === 'string' ? queryValue : '';
}

/**
 * Build the page copy for a billing success polling outcome.
 *
 * Purpose: centralize the rendered title, description, and support lines for
 * each checkout-status outcome.
 *
 * Dependencies:
 * - BILLING_SUCCESS_OUTCOMES defines the allowed outcome states.
 * - checkoutState comes from checkout-status polling and determines whether
 *   processing copy describes local billing lag or Stripe flow completion.
 *
 * Params:
 * - outcome {string}: expected BILLING_SUCCESS_OUTCOMES value.
 * - checkoutState {string}: current checkout state such as "pending", "free",
 *   "active", or "error".
 *
 * Returns:
 * - {{title: string, description?: string, supportLines?: string[]}} copy for
 *   the current outcome; no side effects.
 */
function getOutcomeCopy(outcome, checkoutState) {
  switch (outcome) {
    case BILLING_SUCCESS_OUTCOMES.ACTIVE:
      return {
        title: 'Premium access is active',
        description: 'Your subscription is active and your premium features are ready to use.',
      };
    case BILLING_SUCCESS_OUTCOMES.REAUTH:
      return {
        title: 'Sign in required',
        description: 'Your session expired while billing was finishing. Sign in again to continue.',
      };
    case BILLING_SUCCESS_OUTCOMES.RATE_LIMITED:
      return {
        title: 'Polling paused',
        description: 'We need a moment before checking again. Try refreshing your payment status shortly.',
      };
    case BILLING_SUCCESS_OUTCOMES.UNAVAILABLE:
      return {
        title: 'Billing is temporarily unavailable',
        supportLines: [
          'Your payment may have completed, but we couldn’t confirm your subscription yet.',
          'Please refresh this page or return in a few minutes to check again.',
          'If premium access still doesn’t appear, contact support at tracktheapp.support@gmail.com.',
        ],
      };
    case BILLING_SUCCESS_OUTCOMES.MANUAL_REFRESH:
      return {
        title: 'Still processing',
        description: checkoutState === 'free'
          ? 'Checkout completed, but your subscription is still updating. Refresh this page to check again.'
          : 'Stripe is still finishing the checkout flow. Refresh this page to check again.',
      };
    case BILLING_SUCCESS_OUTCOMES.ERROR:
      return {
        title: 'Please wait for payment status to update',
      };
    case BILLING_SUCCESS_OUTCOMES.TERMINAL_ERROR:
      return {
        title: 'Checkout could not be confirmed',
        description: 'We could not confirm premium access. Return to billing to check your subscription status.',
      };
    case BILLING_SUCCESS_OUTCOMES.CONTINUE:
    default:
      return {
        title: 'Finalizing billing',
        description: checkoutState === 'free'
          ? 'Checkout completed. Waiting for your subscription to update.'
          : 'Waiting for Stripe to finish the checkout flow.',
      };
  }
}

/**
 * Render the authenticated billing success redirect page.
 *
 * Purpose: verify a Stripe Checkout redirect against local billing state before
 * showing premium success or recovery copy.
 *
 * Dependencies:
 * - useRouter supplies session_id from the query string and handles login
 *   navigation for unauthenticated users.
 * - useAuth gates polling until the caller is authenticated.
 * - api posts to /api/billing/checkout-status, while billingSuccessFlow helpers
 *   interpret checkoutState, retry delays, refresh cooldowns, and outcomes.
 *
 * Params:
 * - none; this Next.js page reads auth, router query params, and polling state
 *   from hooks rather than props.
 *
 * Returns:
 * - JSX for the billing success, manual refresh, reauth, or recovery state.
 * - side effects include redirecting unauthenticated users to /login, polling
 *   checkout-status, updating checkoutState/outcome UI state, and managing
 *   bounded retry/cooldown timers.
 */
export default function BillingSuccessPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [outcome, setOutcome] = useState(BILLING_SUCCESS_OUTCOMES.CONTINUE);
  const [checkoutState, setCheckoutState] = useState('pending');
  const [refreshPending, setRefreshPending] = useState(false);
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

  /**
   * Poll the canonical checkout-status route after the Stripe redirect lands.
   *
   * Purpose: drive the success-page state machine from the local billing record
   * instead of trusting the redirect alone.
   *
   * Dependency contract:
   * - starts only when authLoading is false, user exists, router.isReady is true,
   *   and the sessionId query param has been derived
   * - restarts when refreshVersion increments via manual refresh after the
   *   click handler latches refreshPending to block duplicate refreshes
   * - stops when auth/user/router/session prerequisites disappear or the effect
   *   is replaced/unmounted
   *
   * Side effects and transitions:
   * - POSTs /api/billing/checkout-status with the current sessionId
   * - updates outcome, checkoutState, and rateLimitCooldownSeconds from
   *   interpretCheckoutStatusPollResult()
   * - schedules bounded retry timers using getNextPollDelayMs()
   * - switches pending/free exhaustion to getExhaustedPollingOutcome() when the
   *   fixed poll budget runs out
   * - clears refreshPending when a manual refresh-triggered poll attempt
   *   settles into a terminal outcome or hard error; CONTINUE keeps the latch
   *   in place across scheduled backoff steps
   *
   * Cleanup:
   * - isCancelled blocks late async completions from mutating state after the
   *   effect has been torn down
   * - timers stores every scheduled timeout id so cleanup can clear them
   */
  useEffect(() => {
    const shouldResetRefreshPending = refreshVersion > 0;

    if (!router.isReady || authLoading || !user) {
      if (shouldResetRefreshPending) {
        setRefreshPending(false);
      }

      return undefined;
    }

    if (!sessionId) {
      setOutcome(BILLING_SUCCESS_OUTCOMES.TERMINAL_ERROR);
      setCheckoutState('error');
      if (shouldResetRefreshPending) {
        setRefreshPending(false);
      }

      return undefined;
    }

    let isCancelled = false;
    const timers = [];
    setRateLimitCooldownSeconds(null);

    /**
     * Execute one checkout-status poll tick and either settle the rendered
     * outcome or schedule the next backoff step.
     *
     * Inputs:
     * - pollIndex selects the current delay bucket from the fixed poll schedule
     *
     * Result normalization and transitions:
     * - the try block POSTs /api/billing/checkout-status and immediately
     *   normalizes the raw shared-client result through
     *   interpretCheckoutStatusPollResult()
     * - the interpreted object is the page-facing state-machine payload and
     *   always carries a terminal/continue outcome plus optional checkoutState
     *   and retryAfterSeconds
     * - rejected poll promises clear pending timers, clear any rate-limit
     *   cooldown, and force the page into the terminal error state so the UI
     *   stops rendering the continuing poll path
     * - RATE_LIMITED stores retryAfterSeconds in rateLimitCooldownSeconds so the
     *   manual refresh button can show/disable against the server cooldown
     * - CONTINUE keeps polling, updates checkoutState ('pending' or 'free'),
     *   and advances via getNextPollDelayMs()
     * - when no next delay exists, getExhaustedPollingOutcome() converts the
     *   last in-flight checkoutState into MANUAL_REFRESH or ERROR
     * - terminal outcomes (ACTIVE, REAUTH, UNAVAILABLE, ERROR, RATE_LIMITED)
     *   stop scheduling further polls, update outcome immediately, and clear
     *   refreshPending when the current run was triggered by manual refresh
     *
     * Cancellation semantics:
     * - return early when isCancelled is true so stale async completions do not
     *   set React state after cleanup
     * - cancelled stale runs deliberately avoid clearing refreshPending so only
     *   the active manual-refresh attempt can release that latch
     */
    async function runPoll(pollIndex) {
      let interpreted;

      try {
        const result = await api.post('/api/billing/checkout-status', { sessionId });
        interpreted = interpretCheckoutStatusPollResult(result);
      } catch {
        if (isCancelled) {
          return;
        }

        timers.forEach((timer) => window.clearTimeout(timer));
        timers.length = 0;
        setRateLimitCooldownSeconds(null);
        setOutcome(BILLING_SUCCESS_OUTCOMES.TERMINAL_ERROR);
        setCheckoutState('error');
        if (shouldResetRefreshPending) {
          setRefreshPending(false);
        }

        return;
      }

      if (isCancelled) {
        return;
      }

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
          if (shouldResetRefreshPending) {
            setRefreshPending(false);
          }

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

      if (shouldResetRefreshPending) {
        setRefreshPending(false);
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

  const copy = getOutcomeCopy(outcome, checkoutState);
  const refreshDisabled = isBillingSuccessRefreshDisabled(rateLimitCooldownSeconds);
  const refreshButtonLabel = getBillingSuccessRefreshButtonLabel(rateLimitCooldownSeconds);
  const isPending = outcome === BILLING_SUCCESS_OUTCOMES.CONTINUE || refreshPending;
  const isActive = outcome === BILLING_SUCCESS_OUTCOMES.ACTIVE;
  const isTerminalError = outcome === BILLING_SUCCESS_OUTCOMES.TERMINAL_ERROR;
  const OutcomeIcon = isActive ? CheckCircle2 : isTerminalError ? CircleAlert : Clock3;

  return (
    <PublicPageShell contentTestId="billing-success-panel">
      <div role="status" aria-live="polite" aria-atomic="true">
        <div className={[
          'mb-6 inline-flex h-12 w-12 items-center justify-center rounded-dashboard-panel border',
          isPending || isActive
            ? 'border-dashboard-accent/50 bg-dashboard-accent/10 text-dashboard-accent'
            : isTerminalError
              ? 'border-red-400/40 bg-red-500/10 text-red-200'
              : 'border-amber-400/40 bg-amber-500/10 text-amber-200',
        ].join(' ')}>
          {isPending ? <Spinner size="md" /> : <OutcomeIcon aria-hidden="true" size={24} strokeWidth={1.6} />}
        </div>
        <p className="text-dashboard-caption font-semibold uppercase tracking-wider text-dashboard-accent">Billing</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-dashboard-text sm:text-[1.75rem] sm:leading-9">{copy.title}</h1>
        {copy.description && (
          <p className="mt-3 text-dashboard-body leading-6 text-dashboard-muted">{copy.description}</p>
        )}
        {copy.supportLines?.map((line) => (
          <p key={line} className="mt-3 break-words text-dashboard-body leading-6 text-dashboard-muted">
            {line}
          </p>
        ))}
      </div>

      <div className="mt-8 flex flex-col gap-3">
        {(outcome === BILLING_SUCCESS_OUTCOMES.MANUAL_REFRESH
          || outcome === BILLING_SUCCESS_OUTCOMES.ERROR
          || outcome === BILLING_SUCCESS_OUTCOMES.UNAVAILABLE
          || outcome === BILLING_SUCCESS_OUTCOMES.RATE_LIMITED) && (
          <button
            type="button"
            onClick={() => {
              if (refreshPending) {
                return;
              }

              setRefreshPending(true);
              setRefreshVersion((value) => value + 1);
            }}
            disabled={refreshDisabled || refreshPending}
            aria-busy={refreshPending || undefined}
            className={[PUBLIC_PRIMARY_ACTION_CLASS_NAME, 'justify-center gap-3'].join(' ')}
          >
            <RefreshCw aria-hidden="true" size={16} className="shrink-0 text-dashboard-accent" />
            {refreshButtonLabel}
          </button>
        )}

        {outcome === BILLING_SUCCESS_OUTCOMES.REAUTH ? (
          <button
            type="button"
            onClick={() => router.push('/login')}
            className={[PUBLIC_PRIMARY_ACTION_CLASS_NAME, 'justify-center gap-3'].join(' ')}
          >
            Sign in again
            <ArrowRight aria-hidden="true" size={16} className="text-dashboard-accent" />
          </button>
        ) : (
          <Link
            href={isActive ? '/' : '/billing'}
            className={isActive
              ? [PUBLIC_PRIMARY_ACTION_CLASS_NAME, 'justify-center gap-3'].join(' ')
              : PUBLIC_SECONDARY_ACTION_CLASS_NAME}
          >
            {isActive ? 'Dashboard' : 'Back to billing'}
            {isActive && <ArrowRight aria-hidden="true" size={16} className="text-dashboard-accent" />}
          </Link>
        )}

        <Link
          href={isActive ? '/billing' : '/'}
          className={PUBLIC_SECONDARY_ACTION_CLASS_NAME}
        >
          {isActive ? 'Back to billing' : 'Dashboard'}
        </Link>
      </div>
    </PublicPageShell>
  );
}
