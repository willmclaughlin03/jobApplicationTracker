const { ERROR_MESSAGES } = require('../../../shared/errors.js');
const {
  BILLING_SUCCESS_OUTCOMES,
  BILLING_SUCCESS_POLL_SCHEDULE_MS,
  getBillingSuccessPollScheduleText,
  getBillingSuccessRefreshButtonLabel,
  getExhaustedPollingOutcome,
  getNextPollDelayMs,
  getPositiveRetryAfterSeconds,
  interpretCheckoutStatusPollResult,
  isBillingSuccessRefreshDisabled,
} = require('../billingSuccessFlow.js');

describe('billingSuccessFlow', () => {
  it('keeps the fixed bounded poll schedule', () => {
    expect(BILLING_SUCCESS_POLL_SCHEDULE_MS).toEqual([0, 3000, 10000, 30000, 60000]);
    expect(getNextPollDelayMs(0)).toBe(3000);
    expect(getNextPollDelayMs(1)).toBe(7000);
    expect(getNextPollDelayMs(2)).toBe(20000);
    expect(getNextPollDelayMs(3)).toBe(30000);
    expect(getNextPollDelayMs(4)).toBeNull();
    expect(getBillingSuccessPollScheduleText()).toBe(
      '0s, 3s, 10s, 30s, and 60s. Automatic polling stops after the final tick.'
    );
  });

  it('stops and requires re-auth on 401-style shared-client errors', () => {
    expect(
      interpretCheckoutStatusPollResult({ data: null, error: ERROR_MESSAGES.UNAUTHORIZED })
    ).toEqual({ outcome: BILLING_SUCCESS_OUTCOMES.REAUTH });
  });

  it('treats top-level fetch failures as temporary unavailability', () => {
    expect(
      interpretCheckoutStatusPollResult({ data: null, error: ERROR_MESSAGES.FETCH_FAILED })
    ).toEqual({ outcome: BILLING_SUCCESS_OUTCOMES.UNAVAILABLE });
  });

  it('stops on rate-limit and service-unavailable shared-client errors', () => {
    expect(
      interpretCheckoutStatusPollResult({
        data: { error: 'RATE_LIMIT_EXCEEDED' },
        error: null,
        meta: { status: 429, retryAfterSeconds: 45 },
      })
    ).toEqual({
      outcome: BILLING_SUCCESS_OUTCOMES.RATE_LIMITED,
      retryAfterSeconds: 45,
    });

    expect(
      interpretCheckoutStatusPollResult({ data: { error: 'SERVICE_UNAVAILABLE' }, error: null })
    ).toEqual({ outcome: BILLING_SUCCESS_OUTCOMES.UNAVAILABLE });
  });

  it('surfaces positive Retry-After cooldowns from shared-client metadata', () => {
    expect(getPositiveRetryAfterSeconds(12)).toBe(12);
    expect(getPositiveRetryAfterSeconds(0)).toBeNull();
    expect(getPositiveRetryAfterSeconds(-1)).toBeNull();
    expect(getPositiveRetryAfterSeconds(null)).toBeNull();

    expect(
      interpretCheckoutStatusPollResult({
        data: { error: 'RATE_LIMIT_EXCEEDED' },
        error: null,
        meta: { status: 429, retryAfterSeconds: 12 },
      })
    ).toEqual({
      outcome: BILLING_SUCCESS_OUTCOMES.RATE_LIMITED,
      retryAfterSeconds: 12,
    });
  });

  it('stops on active and terminal error checkout states', () => {
    expect(
      interpretCheckoutStatusPollResult({ data: { data: { state: 'active' } }, error: null })
    ).toEqual({ outcome: BILLING_SUCCESS_OUTCOMES.ACTIVE });

    expect(
      interpretCheckoutStatusPollResult({ data: { data: { state: 'error' } }, error: null })
    ).toEqual({ outcome: BILLING_SUCCESS_OUTCOMES.ERROR });
  });

  it('continues polling on pending and free states while budget remains', () => {
    expect(
      interpretCheckoutStatusPollResult({ data: { data: { state: 'pending' } }, error: null })
    ).toEqual({
      outcome: BILLING_SUCCESS_OUTCOMES.CONTINUE,
      checkoutState: 'pending',
    });

    expect(
      interpretCheckoutStatusPollResult({ data: { data: { state: 'free' } }, error: null })
    ).toEqual({
      outcome: BILLING_SUCCESS_OUTCOMES.CONTINUE,
      checkoutState: 'free',
    });
  });

  it('falls back to terminal error on unknown result shapes', () => {
    expect(
      interpretCheckoutStatusPollResult({ data: { data: { state: 'mystery' } }, error: null })
    ).toEqual({ outcome: BILLING_SUCCESS_OUTCOMES.ERROR });

    expect(
      interpretCheckoutStatusPollResult({ data: { error: 'CHECKOUT_SESSION_INVALID' }, error: null })
    ).toEqual({ outcome: BILLING_SUCCESS_OUTCOMES.ERROR });
  });

  it('switches pending and free states to manual refresh when the poll budget is exhausted', () => {
    expect(getExhaustedPollingOutcome('pending')).toBe(BILLING_SUCCESS_OUTCOMES.MANUAL_REFRESH);
    expect(getExhaustedPollingOutcome('free')).toBe(BILLING_SUCCESS_OUTCOMES.MANUAL_REFRESH);
    expect(getExhaustedPollingOutcome('active')).toBe(BILLING_SUCCESS_OUTCOMES.ERROR);
  });

  it('builds the cooldown-aware refresh label and disable state', () => {
    expect(getBillingSuccessRefreshButtonLabel(null)).toBe('Refresh status');
    expect(getBillingSuccessRefreshButtonLabel(9)).toBe('Refresh status in 9s');
    expect(isBillingSuccessRefreshDisabled(null)).toBe(false);
    expect(isBillingSuccessRefreshDisabled(9)).toBe(true);
  });
});
