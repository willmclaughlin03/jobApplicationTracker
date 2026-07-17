import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import {
  BILLING_PAGE_ACTIONS,
  createBillingActionError,
  createCheckoutAttemptNonce,
  executeBillingRedirectAction,
} from '../lib/billingPageActions.js';
import { ERROR_MESSAGES } from '../../shared/errors.js';

export const BILLING_ACTION_RESULT_STATUSES = Object.freeze({
  REDIRECTING: 'redirecting',
  ERROR: 'error',
  IGNORED: 'ignored',
});

const ACTION_COPY = Object.freeze({
  [BILLING_PAGE_ACTIONS.CHECKOUT]: Object.freeze({
    requestFailureMessage: ERROR_MESSAGES.CHECKOUT_SESSION_FAILED,
    fallbackApiFailureMessage: ERROR_MESSAGES.CHECKOUT_SESSION_FAILED,
    missingUrlMessage: 'Checkout did not return a redirect URL.',
    navigationFailedMessage: 'Checkout redirect failed. Please try again.',
  }),
  [BILLING_PAGE_ACTIONS.PORTAL]: Object.freeze({
    requestFailureMessage: ERROR_MESSAGES.PORTAL_SESSION_FAILED,
    fallbackApiFailureMessage: ERROR_MESSAGES.PORTAL_SESSION_FAILED,
    missingUrlMessage: 'Billing portal did not return a redirect URL.',
    navigationFailedMessage: 'Billing portal redirect failed. Please try again.',
  }),
});

/**
 * Build the typed result returned by each public billing action.
 *
 * Purpose: consumers can distinguish navigation handoff, a sanitized failure,
 * and a synchronously ignored duplicate without making the hook own routing.
 *
 * @param {string} status - One BILLING_ACTION_RESULT_STATUSES value.
 * @param {object | null} [error] - Structured action error for failed results.
 * @returns {{ status: string, error: object|null }}
 */
function createActionResult(status, error = null) {
  return { status, error };
}

/**
 * Calculate the remaining whole-second cooldown from its wall-clock snapshot.
 *
 * Purpose: elapsed wall-clock time continues to count while a browser tab is
 * suspended, and a live 429 cooldown survives UI error resets.
 *
 * @param {{ startedAtMs: number, initialSeconds: number } | null} cooldown
 * @returns {number} Non-negative remaining whole seconds.
 */
function getRemainingCooldownSeconds(cooldown) {
  if (!cooldown) {
    return 0;
  }

  const elapsedSeconds = Math.floor(Math.max(0, Date.now() - cooldown.startedAtMs) / 1000);
  return Math.max(0, cooldown.initialSeconds - elapsedSeconds);
}

/**
 * Orchestrate mutually exclusive Checkout and portal redirect actions.
 *
 * Purpose: provide the modal and Billing page with one secure nonce, duplicate
 * latch, API request, structured-error, Retry-After, and redirect implementation.
 * The optional navigator exists for deterministic tests; production defaults to
 * the allowlisted window.location.assign handoff in billingPageActions.
 *
 * @param {{ navigate?: (url: string) => void }} [options]
 * @returns {object} Billing action state and action methods.
 */
export function useBillingActions({ navigate } = {}) {
  const [actionLoading, setActionLoading] = useState('');
  const [actionError, setActionError] = useState(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(null);
  const [retryCountdownVersion, setRetryCountdownVersion] = useState(0);
  const actionLatchRef = useRef('');
  const retryCooldownRef = useRef(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let intervalId = null;

    /** Update the visible countdown from the preserved cooldown snapshot. */
    function updateRetryCountdown() {
      const remainingSeconds = getRemainingCooldownSeconds(retryCooldownRef.current);

      if (remainingSeconds <= 0) {
        retryCooldownRef.current = null;
        setRetryAfterSeconds(null);
        setActionError((currentError) => (
          currentError?.code === 'RATE_LIMIT_EXCEEDED' ? null : currentError
        ));

        if (intervalId !== null) {
          clearInterval(intervalId);
        }
        return;
      }

      setRetryAfterSeconds(remainingSeconds);
    }

    if (getRemainingCooldownSeconds(retryCooldownRef.current) > 0) {
      updateRetryCountdown();
      intervalId = setInterval(updateRetryCountdown, 1000);
    }

    return () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
      }
    };
  }, [retryCountdownVersion]);

  /**
   * Start a positive server-directed Retry-After countdown.
   *
   * @param {number|null} seconds - Preserved response cooldown.
   * @returns {void}
   */
  const startRetryCooldown = useCallback((seconds) => {
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      return;
    }

    retryCooldownRef.current = {
      startedAtMs: Date.now(),
      initialSeconds: seconds,
    };
    setRetryAfterSeconds(seconds);
    setRetryCountdownVersion((version) => version + 1);
  }, []);

  /**
   * Claim the shared synchronous action latch before any async boundary.
   *
   * @param {'checkout'|'portal'} action - Requested billing action.
   * @returns {boolean} Whether this call owns the action slot.
   */
  const beginAction = useCallback((action) => {
    if (
      actionLatchRef.current !== ''
      || getRemainingCooldownSeconds(retryCooldownRef.current) > 0
    ) {
      return false;
    }

    actionLatchRef.current = action;
    setActionLoading(action);
    setActionError(null);
    return true;
  }, []);

  /**
   * Release a failed action while preserving any server-directed cooldown.
   *
   * @param {object} error - Structured failure returned by the executor.
   * @returns {void}
   */
  const releaseFailedAction = useCallback((error) => {
    actionLatchRef.current = '';

    if (!isMountedRef.current) {
      return;
    }

    setActionLoading('');
    setActionError(error);
    startRetryCooldown(error?.retryAfterSeconds ?? null);
  }, [startRetryCooldown]);

  /**
   * Run a claimed action through the canonical redirect executor.
   *
   * @param {'checkout'|'portal'} action - Claimed billing action.
   * @param {() => Promise<object>} request - Relative same-origin API request.
   * @returns {Promise<{status: string, error: object|null}>}
   */
  const runClaimedAction = useCallback(async (action, request) => {
    const outcome = await executeBillingRedirectAction({
      action,
      request,
      ...ACTION_COPY[action],
      navigate,
      shouldNavigate: () => isMountedRef.current,
    });

    if (outcome.error) {
      releaseFailedAction(outcome.error);
      return createActionResult(BILLING_ACTION_RESULT_STATUSES.ERROR, outcome.error);
    }

    // Lifecycle cancellation is neither a redirect handoff nor a user-facing failure.
    if (!outcome.redirected) {
      actionLatchRef.current = '';
      return createActionResult(BILLING_ACTION_RESULT_STATUSES.IGNORED);
    }

    return createActionResult(BILLING_ACTION_RESULT_STATUSES.REDIRECTING);
  }, [navigate, releaseFailedAction]);

  /**
   * Start Premium Checkout with a fresh secure per-attempt nonce.
   *
   * @param {string} planId - Canonical catalog plan identifier.
   * @returns {Promise<{status: string, error: object|null}>}
   */
  const startCheckout = useCallback(async (planId) => {
    if (!beginAction(BILLING_PAGE_ACTIONS.CHECKOUT)) {
      return createActionResult(BILLING_ACTION_RESULT_STATUSES.IGNORED);
    }

    let checkoutAttemptNonce;

    try {
      checkoutAttemptNonce = createCheckoutAttemptNonce();
    } catch (error) {
      const nonceError = createBillingActionError({
        code: 'CHECKOUT_NONCE_UNAVAILABLE',
        message: ERROR_MESSAGES.CHECKOUT_SESSION_FAILED,
      });
      releaseFailedAction(nonceError);
      return createActionResult(BILLING_ACTION_RESULT_STATUSES.ERROR, nonceError);
    }

    return runClaimedAction(
      BILLING_PAGE_ACTIONS.CHECKOUT,
      () => api.post('/api/billing/checkout', { plan: planId, checkoutAttemptNonce })
    );
  }, [beginAction, releaseFailedAction, runClaimedAction]);

  /**
   * Open the server-created Billing Portal through the shared action latch.
   *
   * @returns {Promise<{status: string, error: object|null}>}
   */
  const openPortal = useCallback(async () => {
    if (!beginAction(BILLING_PAGE_ACTIONS.PORTAL)) {
      return createActionResult(BILLING_ACTION_RESULT_STATUSES.IGNORED);
    }

    return runClaimedAction(
      BILLING_PAGE_ACTIONS.PORTAL,
      () => api.post('/api/billing/portal', {})
    );
  }, [beginAction, runClaimedAction]);

  /**
   * Clear stale UI errors without releasing a request or active 429 cooldown.
   *
   * Purpose: a reopened modal starts visually clean but cannot bypass an active
   * redirect latch or immediately resubmit during the server's retry window.
   *
   * @returns {void}
   */
  const resetActionState = useCallback(() => {
    setActionError(null);

    const remainingSeconds = getRemainingCooldownSeconds(retryCooldownRef.current);

    if (remainingSeconds > 0) {
      setRetryAfterSeconds(remainingSeconds);
      return;
    }

    retryCooldownRef.current = null;
    setRetryAfterSeconds(null);
    setRetryCountdownVersion((version) => version + 1);
  }, []);

  return {
    actionLoading,
    actionError,
    retryAfterSeconds,
    resetActionState,
    startCheckout,
    openPortal,
  };
}
