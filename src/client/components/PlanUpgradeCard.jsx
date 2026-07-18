export const UPGRADE_ELIGIBILITY_STATES = Object.freeze({
  CHECKING: 'checking',
  ELIGIBLE: 'eligible',
  INELIGIBLE: 'ineligible',
  ERROR: 'error',
});

const STATUS_CHANGED_MESSAGE = 'Your billing status changed. Review billing before continuing.';
const STATUS_READ_FAILED_MESSAGE = 'We could not verify your billing status right now.';

/**
 * Render reusable Premium plan content and controls from controller-owned state.
 *
 * Purpose: keep customer-facing plan presentation independent from billing
 * reads, routing, authentication recovery, and Checkout orchestration.
 *
 * @param {object} props - Plan metadata, UI state, and controller callbacks.
 * @param {object} props.plan - Frozen plan-catalog entry to display.
 * @param {string} props.headingId - Unique id used by the parent dialog label.
 * @param {'checking'|'eligible'|'ineligible'|'error'} props.eligibilityState
 * @param {boolean} props.actionLoading - Whether Checkout is in flight.
 * @param {object|null} props.actionError - Sanitized shared-action error.
 * @param {number|null} props.retryAfterSeconds - Active server cooldown.
 * @param {Function} props.onUpgrade - Requests Checkout from the controller.
 * @param {Function} props.onRetryStatus - Re-reads canonical billing status.
 * @param {Function} props.onGoToBilling - Opens the canonical Billing page.
 * @returns {import('react').ReactElement} Presentational Premium plan card.
 */
export default function PlanUpgradeCard({
  plan,
  headingId,
  eligibilityState = UPGRADE_ELIGIBILITY_STATES.CHECKING,
  actionLoading = false,
  actionError = null,
  retryAfterSeconds = null,
  onUpgrade,
  onRetryStatus,
  onGoToBilling,
}) {
  const hasRetryCooldown = Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0;
  const isChecking = eligibilityState === UPGRADE_ELIGIBILITY_STATES.CHECKING;
  const isIneligible = eligibilityState === UPGRADE_ELIGIBILITY_STATES.INELIGIBLE;
  const statusReadFailed = eligibilityState === UPGRADE_ELIGIBILITY_STATES.ERROR;
  const upgradeDisabled = isChecking || actionLoading || hasRetryCooldown;
  const upgradeLabel = actionLoading
    ? 'Redirecting to checkout…'
    : hasRetryCooldown
      ? `Try again in ${retryAfterSeconds}s`
      : isChecking
        ? 'Checking availability…'
        : 'Upgrade';

  return (
    <section
      aria-labelledby={headingId}
      className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl sm:p-8"
    >
      <div className="pr-10">
        <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">
          {plan.displayName}
        </p>
        <h2 id={headingId} className="mt-1 text-2xl font-semibold text-gray-900">
          {plan.title}
        </h2>
      </div>

      <ul className="mt-6 space-y-3 text-sm leading-6 text-gray-700">
        {plan.benefits.map((benefit) => (
          <li key={benefit} className="flex items-start gap-3">
            <svg
              aria-hidden="true"
              className="mt-1 h-4 w-4 flex-none text-blue-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                d="M5 13l4 4L19 7"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
              />
            </svg>
            <span>{benefit}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6 border-t border-gray-100 pt-5">
        {isChecking && !actionError && (
          <p role="status" aria-live="polite" className="mb-4 text-sm text-gray-600">
            Checking your current billing status.
          </p>
        )}

        {isIneligible && (
          <div
            role={actionError ? 'alert' : 'status'}
            aria-live={actionError ? undefined : 'polite'}
            className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            {actionError?.message || STATUS_CHANGED_MESSAGE}
          </div>
        )}

        {statusReadFailed && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {STATUS_READ_FAILED_MESSAGE} Try again or review Billing.
          </div>
        )}

        {actionError && !isIneligible && !isChecking && !statusReadFailed && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {actionError.message}
          </div>
        )}

        {hasRetryCooldown && !actionError && (
          <p role="status" aria-live="polite" className="mb-4 text-sm text-gray-600">
            Please wait before trying Checkout again.
          </p>
        )}

        {statusReadFailed ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={onRetryStatus}
              className="inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onGoToBilling}
              className="inline-flex w-full items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Go to billing
            </button>
          </div>
        ) : isIneligible ? (
          <button
            type="button"
            onClick={onGoToBilling}
            className="inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Go to billing
          </button>
        ) : (
          <>
            <p className="mb-3 text-sm leading-5 text-gray-600">
              {plan.checkoutHelperText}
            </p>
            <button
              type="button"
              onClick={onUpgrade}
              disabled={upgradeDisabled}
              className="inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
            >
              {upgradeLabel}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
