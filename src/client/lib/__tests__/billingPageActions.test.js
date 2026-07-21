const { ERROR_MESSAGES } = require('../../../shared/errors.js');
const {
  BILLING_PAGE_ACTIONS,
  createCheckoutAttemptNonce,
  executeBillingRedirectAction,
  resolveBillingRedirectResult,
} = require('../billingPageActions.js');

const CHECKOUT_COPY = Object.freeze({
  requestFailureMessage: ERROR_MESSAGES.CHECKOUT_SESSION_FAILED,
  fallbackApiFailureMessage: ERROR_MESSAGES.CHECKOUT_SESSION_FAILED,
  missingUrlMessage: 'Checkout did not return a redirect URL.',
  navigationFailedMessage: 'Checkout redirect failed. Please try again.',
});

/**
 * Build one shared-client API error envelope for structured mapper tests.
 *
 * @param {string} code - Standardized API error code.
 * @param {number} status - HTTP response status.
 * @param {number|null} [retryAfterSeconds] - Optional Retry-After metadata.
 * @returns {object} Shared-client response fixture.
 */
function buildApiError(code, status, retryAfterSeconds = null) {
  return {
    data: { error: code, message: 'raw response message must not render' },
    error: null,
    meta: { status, retryAfterSeconds },
  };
}

describe('billingPageActions', () => {
  describe('createCheckoutAttemptNonce', () => {
    it('normalizes the randomUUID path to lowercase 32-hex', () => {
      expect(createCheckoutAttemptNonce({
        randomUUID: () => '01234567-89AB-CDEF-0123-456789ABCDEF',
      })).toBe('0123456789abcdef0123456789abcdef');
    });

    it('uses 16 secure random bytes when randomUUID is unavailable', () => {
      const bytes = Array.from({ length: 16 }, (_value, index) => index + 1);

      expect(createCheckoutAttemptNonce({
        getRandomValues: (target) => {
          target.set(bytes);
          return target;
        },
      })).toBe('0102030405060708090a0b0c0d0e0f10');
    });

    it.each([
      ['throws', () => { throw new Error('randomUUID unavailable'); }],
      ['returns a non-string value', () => null],
    ])('uses secure random bytes when randomUUID %s', (_label, randomUUID) => {
      expect(createCheckoutAttemptNonce({
        randomUUID,
        getRandomValues: (target) => {
          target.fill(0xab);
          return target;
        },
      })).toBe('abababababababababababababababab');
    });

    it('fails closed when both secure entropy paths throw', () => {
      expect(() => createCheckoutAttemptNonce({
        randomUUID: () => { throw new Error('randomUUID unavailable'); },
        getRandomValues: () => { throw new Error('random bytes unavailable'); },
      })).toThrow('Secure checkout nonce generation is unavailable');
    });

    it('fails closed when secure randomness is unavailable', () => {
      expect(() => createCheckoutAttemptNonce({})).toThrow(
        'Secure checkout nonce generation is unavailable'
      );
    });
  });

  it('returns an allowlisted Stripe redirect with no action error', () => {
    expect(resolveBillingRedirectResult({
      action: BILLING_PAGE_ACTIONS.CHECKOUT,
      result: {
        data: { data: { url: 'https://checkout.stripe.com/session_123' } },
        error: null,
        meta: { status: 200, retryAfterSeconds: null },
      },
      ...CHECKOUT_COPY,
    })).toEqual({
      redirectUrl: 'https://checkout.stripe.com/session_123',
      error: null,
    });
  });

  it.each([
    ['validation', buildApiError('VALIDATION_ERROR', 400), {
      code: 'VALIDATION_ERROR',
      message: ERROR_MESSAGES.VALIDATION_ERROR,
      httpStatus: 400,
      retryAfterSeconds: null,
    }],
    ['unauthorized', {
      data: null,
      error: ERROR_MESSAGES.UNAUTHORIZED,
      meta: { status: 401, retryAfterSeconds: null },
    }, {
      code: 'UNAUTHORIZED',
      message: ERROR_MESSAGES.UNAUTHORIZED,
      httpStatus: 401,
      retryAfterSeconds: null,
    }],
    ['csrf', buildApiError('CSRF_VALIDATION_FAILED', 403), {
      code: 'CSRF_VALIDATION_FAILED',
      message: ERROR_MESSAGES.CSRF_VALIDATION_FAILED,
      httpStatus: 403,
      retryAfterSeconds: null,
    }],
    ['billing state change', buildApiError('CHECKOUT_SESSION_FAILED', 409), {
      code: 'CHECKOUT_SESSION_FAILED',
      message: 'Your billing status changed. Review billing before continuing.',
      httpStatus: 409,
      retryAfterSeconds: null,
    }],
    ['rate limit', buildApiError('RATE_LIMIT_EXCEEDED', 429, 45), {
      code: 'RATE_LIMIT_EXCEEDED',
      message: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
      httpStatus: 429,
      retryAfterSeconds: 45,
    }],
    ['negative retry metadata', buildApiError('RATE_LIMIT_EXCEEDED', 429, -1), {
      code: 'RATE_LIMIT_EXCEEDED',
      message: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
      httpStatus: 429,
      retryAfterSeconds: null,
    }],
    ['fractional retry metadata', buildApiError('RATE_LIMIT_EXCEEDED', 429, 1.5), {
      code: 'RATE_LIMIT_EXCEEDED',
      message: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
      httpStatus: 429,
      retryAfterSeconds: null,
    }],
    ['unsafe-integer retry metadata', buildApiError(
      'RATE_LIMIT_EXCEEDED',
      429,
      Number.MAX_SAFE_INTEGER + 1
    ), {
      code: 'RATE_LIMIT_EXCEEDED',
      message: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
      httpStatus: 429,
      retryAfterSeconds: null,
    }],
    ['status below valid HTTP range', buildApiError('CHECKOUT_SESSION_FAILED', 99), {
      code: 'CHECKOUT_SESSION_FAILED',
      message: ERROR_MESSAGES.CHECKOUT_SESSION_FAILED,
      httpStatus: null,
      retryAfterSeconds: null,
    }],
    ['status above valid HTTP range', buildApiError('CHECKOUT_SESSION_FAILED', 600), {
      code: 'CHECKOUT_SESSION_FAILED',
      message: ERROR_MESSAGES.CHECKOUT_SESSION_FAILED,
      httpStatus: null,
      retryAfterSeconds: null,
    }],
    ['disabled checkout', buildApiError('BILLING_CHECKOUT_DISABLED', 503), {
      code: 'BILLING_CHECKOUT_DISABLED',
      message: ERROR_MESSAGES.BILLING_CHECKOUT_DISABLED,
      httpStatus: 503,
      retryAfterSeconds: null,
    }],
    ['service unavailable', buildApiError('SERVICE_UNAVAILABLE', 503), {
      code: 'SERVICE_UNAVAILABLE',
      message: ERROR_MESSAGES.SERVICE_UNAVAILABLE,
      httpStatus: 503,
      retryAfterSeconds: null,
    }],
    ['checkout failure', buildApiError('CHECKOUT_SESSION_FAILED', 503), {
      code: 'CHECKOUT_SESSION_FAILED',
      message: ERROR_MESSAGES.CHECKOUT_SESSION_FAILED,
      httpStatus: 503,
      retryAfterSeconds: null,
    }],
  ])('maps %s to a sanitized structured error', (_label, result, expectedError) => {
    expect(resolveBillingRedirectResult({
      action: BILLING_PAGE_ACTIONS.CHECKOUT,
      result,
      ...CHECKOUT_COPY,
    })).toEqual({ redirectUrl: null, error: expectedError });
  });

  it.each([
    'javascript:alert(1)',
    'https://checkout.stripe.example/session_123',
    'http://checkout.stripe.com/session_123',
    'https://evil.example.test/session_123',
  ])('rejects the unsafe redirect URL %s', (url) => {
    expect(resolveBillingRedirectResult({
      action: BILLING_PAGE_ACTIONS.CHECKOUT,
      result: {
        data: { data: { url } },
        error: null,
        meta: { status: 200, retryAfterSeconds: null },
      },
      ...CHECKOUT_COPY,
    })).toEqual({
      redirectUrl: null,
      error: {
        code: null,
        message: CHECKOUT_COPY.missingUrlMessage,
        httpStatus: 200,
        retryAfterSeconds: null,
      },
    });
  });

  it('keeps the action successful after an allowlisted navigation handoff', async () => {
    const navigate = jest.fn();

    await expect(executeBillingRedirectAction({
      action: BILLING_PAGE_ACTIONS.CHECKOUT,
      request: async () => ({
        data: { data: { url: 'https://checkout.stripe.com/session_123' } },
        error: null,
        meta: { status: 200, retryAfterSeconds: null },
      }),
      navigate,
      ...CHECKOUT_COPY,
    })).resolves.toEqual({ redirected: true, error: null });

    expect(navigate).toHaveBeenCalledWith('https://checkout.stripe.com/session_123');
  });

  it('skips navigation when the lifecycle guard rejects the handoff', async () => {
    const navigate = jest.fn();

    await expect(executeBillingRedirectAction({
      action: BILLING_PAGE_ACTIONS.CHECKOUT,
      request: async () => ({
        data: { data: { url: 'https://checkout.stripe.com/session_123' } },
        error: null,
        meta: { status: 200, retryAfterSeconds: null },
      }),
      navigate,
      shouldNavigate: () => false,
      ...CHECKOUT_COPY,
    })).resolves.toEqual({ redirected: false, error: null });

    expect(navigate).not.toHaveBeenCalled();
  });

  it('returns sanitized errors for thrown requests and navigation failures', async () => {
    await expect(executeBillingRedirectAction({
      action: BILLING_PAGE_ACTIONS.CHECKOUT,
      request: async () => {
        throw new Error('raw network failure');
      },
      ...CHECKOUT_COPY,
    })).resolves.toEqual({
      redirected: false,
      error: {
        code: null,
        message: ERROR_MESSAGES.CHECKOUT_SESSION_FAILED,
        httpStatus: null,
        retryAfterSeconds: null,
      },
    });

    await expect(executeBillingRedirectAction({
      action: BILLING_PAGE_ACTIONS.CHECKOUT,
      request: async () => ({
        data: { data: { url: 'https://checkout.stripe.com/session_123' } },
        error: null,
        meta: { status: 200, retryAfterSeconds: null },
      }),
      navigate: () => {
        throw new Error('raw navigation failure');
      },
      ...CHECKOUT_COPY,
    })).resolves.toEqual({
      redirected: false,
      error: {
        code: null,
        message: CHECKOUT_COPY.navigationFailedMessage,
        httpStatus: 200,
        retryAfterSeconds: null,
      },
    });
  });

});
