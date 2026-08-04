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
 * @param {'default'|'dashboard'} props.appearance - Optional dashboard-scoped presentation.
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
  appearance = 'default',
}) {
  const isDashboard = appearance === 'dashboard';
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
      className={isDashboard
        ? 'dashboard-raised-panel w-full max-w-md p-6 text-dashboard-text sm:p-8'
        : 'w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl sm:p-8'}
    >
      <div className="pr-10">
        <p className={`text-sm font-semibold uppercase tracking-wide ${
          isDashboard ? 'text-dashboard-accent-hover' : 'text-blue-600'
        }`}>
          {plan.displayName}
        </p>
        <h2 id={headingId} className={`mt-1 text-2xl font-semibold ${
          isDashboard ? 'text-dashboard-text' : 'text-gray-900'
        }`}>
          {plan.title}
        </h2>
      </div>

      <ul className={`mt-6 space-y-3 text-sm leading-6 ${
        isDashboard ? 'text-dashboard-muted' : 'text-gray-700'
      }`}>
        {plan.benefits.map((benefit) => (
          <li key={benefit} className="flex items-start gap-3">
            <svg
              aria-hidden="true"
              className={`mt-1 h-4 w-4 flex-none ${
                isDashboard ? 'text-dashboard-accent-hover' : 'text-blue-600'
              }`}
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

      <div className={`mt-6 border-t pt-5 ${
        isDashboard ? 'border-dashboard-line' : 'border-gray-100'
      }`}>
        {isChecking && !actionError && (
          <p role="status" aria-live="polite" className={`mb-4 text-sm ${
            isDashboard ? 'text-dashboard-muted' : 'text-gray-600'
          }`}>
            Checking your current billing status.
          </p>
        )}

        {isIneligible && (
          <div
            role={actionError ? 'alert' : 'status'}
            aria-live={actionError ? undefined : 'polite'}
            className={`mb-4 rounded-md border px-4 py-3 text-sm ${
              isDashboard
                ? 'border-amber-400/50 bg-amber-500/10 text-amber-100'
                : 'border-amber-200 bg-amber-50 text-amber-900'
            }`}
          >
            {actionError?.message || STATUS_CHANGED_MESSAGE}
          </div>
        )}

        {statusReadFailed && (
          <div
            role="alert"
            className={`mb-4 rounded-md border px-4 py-3 text-sm ${
              isDashboard
                ? 'border-red-400/50 bg-red-500/10 text-red-200'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {STATUS_READ_FAILED_MESSAGE} Try again or review Billing.
          </div>
        )}

        {actionError && !isIneligible && !isChecking && !statusReadFailed && (
          <div
            role="alert"
            className={`mb-4 rounded-md border px-4 py-3 text-sm ${
              isDashboard
                ? 'border-red-400/50 bg-red-500/10 text-red-200'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {actionError.message}
          </div>
        )}

        {hasRetryCooldown && !actionError && (
          <p role="status" aria-live="polite" className={`mb-4 text-sm ${
            isDashboard ? 'text-dashboard-muted' : 'text-gray-600'
          }`}>
            Please wait before trying Checkout again.
          </p>
        )}

        {statusReadFailed ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={onRetryStatus}
              className={isDashboard
                ? 'dashboard-control dashboard-focus-ring inline-flex min-h-9 w-full items-center justify-center px-4 py-2.5 text-sm font-medium text-dashboard-text transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover'
                : 'inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700'}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onGoToBilling}
              className={isDashboard
                ? 'dashboard-control dashboard-focus-ring inline-flex min-h-9 w-full items-center justify-center px-4 py-2.5 text-sm font-medium text-dashboard-muted transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover hover:text-dashboard-text'
                : 'inline-flex w-full items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50'}
            >
              Go to billing
            </button>
          </div>
        ) : isIneligible ? (
          <button
            type="button"
            onClick={onGoToBilling}
            className={isDashboard
              ? 'dashboard-control dashboard-focus-ring inline-flex min-h-9 w-full items-center justify-center px-4 py-2.5 text-sm font-medium text-dashboard-text transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-surface-hover'
              : 'inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700'}
          >
            Go to billing
          </button>
        ) : (
          <>
            <p className={`mb-3 text-sm leading-5 ${
              isDashboard ? 'text-dashboard-muted' : 'text-gray-600'
            }`}>
              {plan.checkoutHelperText}
            </p>
            <button
              type="button"
              onClick={onUpgrade}
              disabled={upgradeDisabled}
              className={isDashboard
                ? 'dashboard-focus-ring inline-flex min-h-9 w-full items-center justify-center rounded-dashboard-control border border-dashboard-accent bg-dashboard-accent px-5 py-3 text-sm font-semibold text-dashboard-accent-ink shadow-dashboard-panel transition-colors hover:bg-dashboard-accent-hover disabled:cursor-not-allowed disabled:border-dashboard-line disabled:bg-dashboard-surface-hover disabled:text-dashboard-muted'
                : 'inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400'}
            >
              {upgradeLabel}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
