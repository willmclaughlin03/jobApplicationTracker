import { ERROR_MESSAGES } from '../../shared/errors.js';

export const BILLING_SUCCESS_POLL_SCHEDULE_MS = Object.freeze([
  0,
  3_000,
  10_000,
  30_000,
  60_000,
]);

export const BILLING_SUCCESS_OUTCOMES = Object.freeze({
  ACTIVE: 'active',
  CONTINUE: 'continue',
  ERROR: 'error',
  MANUAL_REFRESH: 'manual_refresh',
  RATE_LIMITED: 'rate_limited',
  REAUTH: 'reauth',
  UNAVAILABLE: 'unavailable',
});

/**
 * Normalize a Retry-After-style cooldown to a positive integer second count.
 *
 * @param {number | null | undefined} retryAfterSeconds
 * @returns {number | null}
 */
export function getPositiveRetryAfterSeconds(retryAfterSeconds) {
  if (!Number.isFinite(retryAfterSeconds)) {
    return null;
  }

  const normalizedSeconds = Math.floor(retryAfterSeconds);
  return normalizedSeconds > 0 ? normalizedSeconds : null;
}

/**
 * Derive the rendered billing-success poll schedule text from the shared
 * schedule constant.
 *
 * @param {readonly number[]} scheduleMs
 * @returns {string}
 */
export function getBillingSuccessPollScheduleText(scheduleMs = BILLING_SUCCESS_POLL_SCHEDULE_MS) {
  const scheduleSeconds = scheduleMs.map((delayMs) => `${delayMs / 1000}s`);

  if (scheduleSeconds.length === 0) {
    return 'Automatic polling is disabled.';
  }

  if (scheduleSeconds.length === 1) {
    return `${scheduleSeconds[0]}. Automatic polling stops after the final tick.`;
  }

  const leadingSchedule = scheduleSeconds.slice(0, -1).join(', ');
  const trailingSchedule = scheduleSeconds[scheduleSeconds.length - 1];

  return `${leadingSchedule}, and ${trailingSchedule}. Automatic polling stops after the final tick.`;
}

/**
 * Build the refresh-button label for the billing success page.
 *
 * @param {number | null | undefined} cooldownRemainingSeconds
 * @returns {string}
 */
export function getBillingSuccessRefreshButtonLabel(cooldownRemainingSeconds) {
  const positiveCooldownSeconds = getPositiveRetryAfterSeconds(cooldownRemainingSeconds);
  return positiveCooldownSeconds
    ? `Refresh status in ${positiveCooldownSeconds}s`
    : 'Refresh status';
}

/**
 * Decide whether the billing success page should disable manual refresh.
 *
 * @param {number | null | undefined} cooldownRemainingSeconds
 * @returns {boolean}
 */
export function isBillingSuccessRefreshDisabled(cooldownRemainingSeconds) {
  return getPositiveRetryAfterSeconds(cooldownRemainingSeconds) !== null;
}

export function interpretCheckoutStatusPollResult(result) {
  const retryAfterSeconds = getPositiveRetryAfterSeconds(result?.meta?.retryAfterSeconds);

  if (result?.error === ERROR_MESSAGES.UNAUTHORIZED) {
    return { outcome: BILLING_SUCCESS_OUTCOMES.REAUTH };
  }

  if (result?.error === ERROR_MESSAGES.FETCH_FAILED) {
    return { outcome: BILLING_SUCCESS_OUTCOMES.UNAVAILABLE };
  }

  const responseError = result?.data?.error;

  if (responseError === 'RATE_LIMIT_EXCEEDED') {
    return retryAfterSeconds === null
      ? { outcome: BILLING_SUCCESS_OUTCOMES.RATE_LIMITED }
      : { outcome: BILLING_SUCCESS_OUTCOMES.RATE_LIMITED, retryAfterSeconds };
  }

  if (responseError === 'SERVICE_UNAVAILABLE') {
    return retryAfterSeconds === null
      ? { outcome: BILLING_SUCCESS_OUTCOMES.UNAVAILABLE }
      : { outcome: BILLING_SUCCESS_OUTCOMES.UNAVAILABLE, retryAfterSeconds };
  }

  if (responseError) {
    return { outcome: BILLING_SUCCESS_OUTCOMES.ERROR };
  }

  const checkoutState = result?.data?.data?.state;

  if (checkoutState === 'active') {
    return { outcome: BILLING_SUCCESS_OUTCOMES.ACTIVE };
  }

  if (checkoutState === 'error') {
    return { outcome: BILLING_SUCCESS_OUTCOMES.ERROR };
  }

  if (checkoutState === 'pending' || checkoutState === 'free') {
    return {
      outcome: BILLING_SUCCESS_OUTCOMES.CONTINUE,
      checkoutState,
    };
  }

  return { outcome: BILLING_SUCCESS_OUTCOMES.ERROR };
}

export function getExhaustedPollingOutcome(checkoutState) {
  if (checkoutState === 'pending' || checkoutState === 'free') {
    return BILLING_SUCCESS_OUTCOMES.MANUAL_REFRESH;
  }

  return BILLING_SUCCESS_OUTCOMES.ERROR;
}

export function getNextPollDelayMs(currentIndex) {
  if (currentIndex < 0 || currentIndex >= BILLING_SUCCESS_POLL_SCHEDULE_MS.length - 1) {
    return null;
  }

  return BILLING_SUCCESS_POLL_SCHEDULE_MS[currentIndex + 1] - BILLING_SUCCESS_POLL_SCHEDULE_MS[currentIndex];
}
