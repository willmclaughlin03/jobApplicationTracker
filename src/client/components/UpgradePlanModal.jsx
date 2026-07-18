import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useBillingActions, BILLING_ACTION_RESULT_STATUSES } from '../hooks/useBillingActions.js';
import { useOverlayAccessibility } from '../hooks/useOverlayAccessibility.js';
import { api } from '../lib/api.js';
import { BILLING_PAGE_ACTIONS } from '../lib/billingPageActions.js';
import {
  BILLING_PAGE_LOAD_STATES,
  canStartCheckoutFromLocalStatus,
} from '../lib/billingPageState.js';
import { ERROR_MESSAGES } from '../../shared/errors.js';
import PlanUpgradeCard, { UPGRADE_ELIGIBILITY_STATES } from './PlanUpgradeCard.jsx';

/**
 * Detect an unauthorized canonical-status response across supported API shapes.
 *
 * Purpose: status reads use the shared API client, while older tests and
 * responses may carry the 401 signal in response metadata or the response body.
 *
 * @param {object|null|undefined} result - Shared API client result.
 * @returns {boolean} Whether Dashboard auth recovery should run.
 */
function isUnauthorizedStatusResult(result) {
  return result?.error === ERROR_MESSAGES.UNAUTHORIZED
    || result?.meta?.status === 401
    || result?.data?.error === 'UNAUTHORIZED'
    || result?.data?.status === 401;
}

/**
 * Render and control the accessible Dashboard Premium upgrade dialog.
 *
 * Purpose: re-read canonical local billing status for each modal session,
 * ignore stale status responses, and delegate eligible Checkout requests to
 * the shared billing-actions hook without importing Dashboard routing.
 *
 * @param {object} props - Modal visibility, plan metadata, and parent callbacks.
 * @param {boolean} props.isOpen - Whether the modal session is visible.
 * @param {object} props.plan - Frozen plan-catalog entry used for Checkout.
 * @param {Function} props.onClose - Dismisses an idle modal session.
 * @param {Function} props.onUnauthorized - Runs Dashboard auth recovery.
 * @param {Function} props.onGoToBilling - Navigates to canonical Billing.
 * @returns {import('react').ReactElement|null} Upgrade dialog or null.
 */
export default function UpgradePlanModal({
  isOpen,
  plan,
  onClose,
  onUnauthorized,
  onGoToBilling,
}) {
  const titleId = useId();
  const [eligibilityState, setEligibilityState] = useState(
    UPGRADE_ELIGIBILITY_STATES.CHECKING
  );
  const requestGenerationRef = useRef(0);
  const isOpenRef = useRef(isOpen);
  const onUnauthorizedRef = useRef(onUnauthorized);
  isOpenRef.current = isOpen;

  const {
    actionLoading,
    actionError,
    retryAfterSeconds,
    resetActionState,
    startCheckout,
  } = useBillingActions();
  const checkoutActive = actionLoading === BILLING_PAGE_ACTIONS.CHECKOUT;

  // Keep async status and Checkout handlers connected to the latest callback
  // without refetching status when a parent recreates the callback.
  useEffect(() => {
    onUnauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  /**
   * Request modal dismissal only when no Checkout redirect is in flight.
   *
   * @returns {void}
   */
  const requestClose = useCallback(() => {
    if (!checkoutActive) {
      onClose();
    }
  }, [checkoutActive, onClose]);

  const { containerRef } = useOverlayAccessibility(isOpen, requestClose);

  /**
   * Read and evaluate one canonical billing snapshot for the active session.
   *
   * Side effects: updates eligibility only if this request still owns the
   * current open-session generation, or invokes parent auth recovery for 401.
   *
   * @returns {Promise<void>}
   */
  const readBillingStatus = useCallback(async () => {
    if (!isOpenRef.current) {
      return;
    }

    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    setEligibilityState(UPGRADE_ELIGIBILITY_STATES.CHECKING);

    let result;

    try {
      result = await api.get('/api/billing/status');
    } catch {
      if (
        isOpenRef.current
        && requestGenerationRef.current === requestGeneration
      ) {
        setEligibilityState(UPGRADE_ELIGIBILITY_STATES.ERROR);
      }
      return;
    }

    if (
      !isOpenRef.current
      || requestGenerationRef.current !== requestGeneration
    ) {
      return;
    }

    if (isUnauthorizedStatusResult(result)) {
      requestGenerationRef.current += 1;
      onUnauthorizedRef.current();
      return;
    }

    const billingStatus = result?.data?.data;
    const statusReadFailed = Boolean(result?.error || result?.data?.error)
      || !billingStatus
      || typeof billingStatus !== 'object'
      || Array.isArray(billingStatus);

    if (statusReadFailed) {
      setEligibilityState(UPGRADE_ELIGIBILITY_STATES.ERROR);
      return;
    }

    const canStartCheckout = canStartCheckoutFromLocalStatus({
      billingStatus,
      loadState: BILLING_PAGE_LOAD_STATES.READY,
    });

    setEligibilityState(
      canStartCheckout
        ? UPGRADE_ELIGIBILITY_STATES.ELIGIBLE
        : UPGRADE_ELIGIBILITY_STATES.INELIGIBLE
    );
  }, []);

  // Start a clean visual session on every open, while the shared hook preserves
  // any live Retry-After cooldown or successful redirect latch.
  useEffect(() => {
    if (!isOpen) {
      requestGenerationRef.current += 1;
      setEligibilityState(UPGRADE_ELIGIBILITY_STATES.CHECKING);
      return undefined;
    }

    resetActionState();
    readBillingStatus();

    return () => {
      requestGenerationRef.current += 1;
    };
  }, [isOpen, readBillingStatus, resetActionState]);

  /**
   * Start Checkout for an eligible plan and route typed outcomes safely.
   *
   * Side effects: invokes auth recovery for 401 and converts 409 failures into
   * the canonical Billing fallback state; all other errors remain in the hook.
   *
   * @returns {Promise<void>}
   */
  const handleUpgrade = useCallback(async () => {
    if (
      eligibilityState !== UPGRADE_ELIGIBILITY_STATES.ELIGIBLE
      || checkoutActive
      || (Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0)
    ) {
      return;
    }

    const outcome = await startCheckout(plan.planId);

    if (outcome.status !== BILLING_ACTION_RESULT_STATUSES.ERROR) {
      return;
    }

    if (outcome.error?.code === 'UNAUTHORIZED' || outcome.error?.httpStatus === 401) {
      resetActionState();
      onUnauthorizedRef.current();
      return;
    }

    if (outcome.error?.httpStatus === 409) {
      setEligibilityState(UPGRADE_ELIGIBILITY_STATES.INELIGIBLE);
    }
  }, [
    checkoutActive,
    eligibilityState,
    plan.planId,
    resetActionState,
    retryAfterSeconds,
    startCheckout,
  ]);

  /**
   * Close only when a click lands directly on the backdrop.
   *
   * @param {import('react').MouseEvent<HTMLDivElement>} event - Backdrop click.
   * @returns {void}
   */
  const handleBackdropClick = useCallback((event) => {
    if (event.target === event.currentTarget) {
      requestClose();
    }
  }, [requestClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4 sm:p-6"
      onClick={handleBackdropClick}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={checkoutActive || undefined}
        tabIndex={-1}
        className="relative w-full max-w-md"
      >
        <button
          type="button"
          onClick={requestClose}
          disabled={checkoutActive}
          aria-label="Close upgrade modal"
          className="absolute right-4 top-4 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
          </svg>
        </button>

        <PlanUpgradeCard
          plan={plan}
          headingId={titleId}
          eligibilityState={eligibilityState}
          actionLoading={checkoutActive}
          actionError={actionError}
          retryAfterSeconds={retryAfterSeconds}
          onUpgrade={handleUpgrade}
          onRetryStatus={readBillingStatus}
          onGoToBilling={onGoToBilling}
        />
      </div>
    </div>
  );
}
