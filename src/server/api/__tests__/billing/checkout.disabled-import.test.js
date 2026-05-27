jest.mock('../../../middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
}));

jest.mock('../../../lib/supabaseServer.js', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

const mockGetConfiguredStripeMode = jest.fn(() => {
  throw new Error('stripeRuntime mode should not resolve while checkout is disabled');
});
const mockGetStripeClient = jest.fn(() => {
  throw new Error('stripeRuntime client should not load while checkout is disabled');
});

jest.mock('../../../lib/stripeRuntime.js', () => ({
  getConfiguredStripeMode: mockGetConfiguredStripeMode,
  getStripeClient: mockGetStripeClient,
}));

jest.mock('../../../lib/appUrl.js', () => {
  throw new Error('appUrl module should not load while checkout is disabled');
});

jest.mock('../../../lib/stripeCheckoutConfig.js', () => {
  throw new Error('stripeCheckoutConfig module should not load while checkout is disabled');
});

describe('/api/billing/checkout disabled import boundary', () => {
  const originalCheckoutDisabled = process.env.BILLING_CHECKOUT_DISABLED;
  const originalBillingLogHashSecret = process.env.BILLING_LOG_HASH_SECRET;

  /**
   * Create a minimal authenticated Checkout request for disabled-path tests.
   *
   * Purpose: the route should return the halt response before validating the
   * body or using billing-service functions from the real transitive import.
   *
   * @returns {object}
   */
  function createMockReq() {
    return {
      method: 'POST',
      body: {
        plan: 'invalid-before-validation',
        checkoutAttemptNonce: 'invalid-before-validation',
      },
      _rateLimitUser: { id: 'user-disabled-import', email: 'test@example.com' },
      _supabaseClient: { from: jest.fn() },
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    };
  }

  /**
   * Create a chainable API response mock.
   *
   * Purpose: keep this import-boundary test focused on status and response
   * envelope shape rather than a real Next.js response object.
   *
   * @returns {object}
   */
  function createMockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  }

  afterAll(() => {
    if (originalCheckoutDisabled === undefined) {
      delete process.env.BILLING_CHECKOUT_DISABLED;
    } else {
      process.env.BILLING_CHECKOUT_DISABLED = originalCheckoutDisabled;
    }

    if (originalBillingLogHashSecret === undefined) {
      delete process.env.BILLING_LOG_HASH_SECRET;
    } else {
      process.env.BILLING_LOG_HASH_SECRET = originalBillingLogHashSecret;
    }
  });

  it('loads the billing service chain but returns disabled before Checkout creation modules', async () => {
    process.env.BILLING_CHECKOUT_DISABLED = 'true';
    process.env.BILLING_LOG_HASH_SECRET = 'disabled-import-test-secret';
    const billingService = require('../../../lib/billingService.js');
    const handler = require('../../../../pages/api/billing/checkout.js').default;
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(typeof billingService.loadBillingStatusOrThrow).toBe('function');
    expect(mockGetConfiguredStripeMode).not.toHaveBeenCalled();
    expect(mockGetStripeClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'BILLING_CHECKOUT_DISABLED',
      })
    );
  });
});
