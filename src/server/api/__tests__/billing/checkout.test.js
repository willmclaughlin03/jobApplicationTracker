jest.mock('../../../middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
}));

const mockCanStartCheckout = jest.fn();
const mockGetOrCreateStripeCustomer = jest.fn();
const mockHashUserIdForIdempotency = jest.fn();
const mockLoadBillingStatusOrThrow = jest.fn();
const mockBuildAppUrl = jest.fn((path) => `https://app.example.test${path}`);
const mockGetPriceIdForPlan = jest.fn();
const mockCreateCheckoutSession = jest.fn();

jest.mock('../../../lib/billingService.js', () => ({
  canStartCheckout: mockCanStartCheckout,
  getOrCreateStripeCustomer: mockGetOrCreateStripeCustomer,
  hashUserIdForIdempotency: mockHashUserIdForIdempotency,
  loadBillingStatusOrThrow: mockLoadBillingStatusOrThrow,
}));

jest.mock('../../../lib/stripe.js', () => ({
  buildAppUrl: mockBuildAppUrl,
  getPriceIdForPlan: mockGetPriceIdForPlan,
  stripe: {
    checkout: {
      sessions: {
        create: mockCreateCheckoutSession,
      },
    },
  },
}));

const { BILLING_PLANS } = require('../../../../shared/constants/billing.js');
const handler = require('../../../../pages/api/billing/checkout.js').default;

describe('/api/billing/checkout handler', () => {
  const mockUser = { id: 'user-billing-checkout', email: 'test@example.com' };
  const mockClient = { from: jest.fn() };
  const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const defaultCheckoutAttemptNonce = '0123456789abcdef0123456789abcdef';

  function createMockReq(
    body = {
      plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
      checkoutAttemptNonce: defaultCheckoutAttemptNonce,
    },
    user = mockUser
  ) {
    return {
      method: 'POST',
      body,
      _rateLimitUser: user,
      _supabaseClient: mockClient,
      log: mockLog,
    };
  }

  function createMockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockCanStartCheckout.mockReturnValue(true);
    mockGetOrCreateStripeCustomer.mockResolvedValue({ stripeCustomerId: 'cus_checkout_123' });
    mockHashUserIdForIdempotency.mockReturnValue('hash1234567890hash1234567890');
    mockLoadBillingStatusOrThrow.mockResolvedValue({ hasSubscription: false, status: null });
    mockGetPriceIdForPlan.mockReturnValue('price_tailor_monthly');
    mockCreateCheckoutSession.mockResolvedValue({
      url: 'https://checkout.stripe.test/session_123',
    });
  });

  it('rejects invalid billing request bodies', async () => {
    const req = createMockReq({
      plan: 'bad-plan',
      checkoutAttemptNonce: defaultCheckoutAttemptNonce,
    });
    const res = createMockRes();

    await handler(req, res);

    expect(mockLoadBillingStatusOrThrow).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'VALIDATION_ERROR',
      })
    );
  });

  it('rejects invalid checkout attempt nonces before billing reads', async () => {
    const req = createMockReq({
      plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
      checkoutAttemptNonce: 'not-a-valid-nonce',
    });
    const res = createMockRes();

    await handler(req, res);

    expect(mockLoadBillingStatusOrThrow).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'VALIDATION_ERROR',
      })
    );
  });

  it('loads eligibility before customer creation and creates the exact Stripe checkout payload', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockLoadBillingStatusOrThrow).toHaveBeenCalledWith(mockUser.id, mockClient, mockLog);
    expect(mockCanStartCheckout).toHaveBeenCalledWith({ hasSubscription: false, status: null });
    expect(mockLoadBillingStatusOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetOrCreateStripeCustomer.mock.invocationCallOrder[0]
    );
    expect(mockGetOrCreateStripeCustomer).toHaveBeenCalledWith(
      mockUser.id,
      mockUser.email,
      mockLog
    );
    expect(mockGetPriceIdForPlan).toHaveBeenCalledWith(BILLING_PLANS.RESUME_TAILOR_MONTHLY);
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      mode: 'subscription',
      customer: 'cus_checkout_123',
      client_reference_id: mockUser.id,
      line_items: [
        {
          price: 'price_tailor_monthly',
          quantity: 1,
        },
      ],
      success_url: 'https://app.example.test/billing/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://app.example.test/billing/cancel',
    }, {
      idempotencyKey: `billing_checkout_hash1234567890hash123456_resume_tailor_monthly_${defaultCheckoutAttemptNonce}`,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { url: 'https://checkout.stripe.test/session_123' },
      })
    );
  });

  it('dedupes parallel duplicate submits with the same nonce to one Stripe session URL', async () => {
    const sessionsByIdempotencyKey = new Map();
    mockCreateCheckoutSession.mockImplementation((payload, options) => {
      const url = sessionsByIdempotencyKey.get(options.idempotencyKey)
        ?? `https://checkout.stripe.test/${options.idempotencyKey}`;
      sessionsByIdempotencyKey.set(options.idempotencyKey, url);
      return Promise.resolve({ url });
    });

    const firstReq = createMockReq();
    const firstRes = createMockRes();
    const secondReq = createMockReq();
    const secondRes = createMockRes();

    await Promise.all([
      handler(firstReq, firstRes),
      handler(secondReq, secondRes),
    ]);

    const firstKey = mockCreateCheckoutSession.mock.calls[0][1].idempotencyKey;
    const secondKey = mockCreateCheckoutSession.mock.calls[1][1].idempotencyKey;

    expect(secondKey).toBe(firstKey);
    expect(sessionsByIdempotencyKey.size).toBe(1);
    expect(firstRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { url: `https://checkout.stripe.test/${firstKey}` },
      })
    );
    expect(secondRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { url: `https://checkout.stripe.test/${firstKey}` },
      })
    );
  });

  it('uses different idempotency keys for different users', async () => {
    mockHashUserIdForIdempotency.mockImplementation((userId) => {
      if (userId === 'user-a') {
        return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      }

      return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    });

    const firstReq = createMockReq(
      {
        plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
        checkoutAttemptNonce: defaultCheckoutAttemptNonce,
      },
      { id: 'user-a', email: 'a@example.com' }
    );
    const secondReq = createMockReq(
      {
        plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
        checkoutAttemptNonce: defaultCheckoutAttemptNonce,
      },
      { id: 'user-b', email: 'b@example.com' }
    );
    const firstRes = createMockRes();
    const secondRes = createMockRes();

    await handler(firstReq, firstRes);
    await handler(secondReq, secondRes);

    const firstKey = mockCreateCheckoutSession.mock.calls[0][1].idempotencyKey;
    const secondKey = mockCreateCheckoutSession.mock.calls[1][1].idempotencyKey;

    expect(firstKey).toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(secondKey).toContain('bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(secondKey).not.toBe(firstKey);
  });

  it('uses different idempotency keys for different checkout attempt nonces', async () => {
    const firstNonce = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const secondNonce = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const firstReq = createMockReq({
      plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
      checkoutAttemptNonce: firstNonce,
    });
    const firstRes = createMockRes();
    const secondReq = createMockReq({
      plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
      checkoutAttemptNonce: secondNonce,
    });
    const secondRes = createMockRes();

    await handler(firstReq, firstRes);
    await handler(secondReq, secondRes);

    expect(mockCreateCheckoutSession.mock.calls[0][1].idempotencyKey).toBe(
      `billing_checkout_hash1234567890hash123456_resume_tailor_monthly_${firstNonce}`
    );
    expect(mockCreateCheckoutSession.mock.calls[1][1].idempotencyKey).toBe(
      `billing_checkout_hash1234567890hash123456_resume_tailor_monthly_${secondNonce}`
    );
  });

  it('fails closed when checkout is not allowed for the local billing state', async () => {
    mockCanStartCheckout.mockReturnValue(false);
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_FAILED',
      })
    );
  });

  it('returns 503 when the strict billing read fails', async () => {
    mockLoadBillingStatusOrThrow.mockRejectedValue({
      code: 'BILLING_STATUS_UNAVAILABLE',
      message: 'strict read failed',
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'SERVICE_UNAVAILABLE',
      })
    );
  });

  it('returns 503 when Stripe checkout session creation fails', async () => {
    mockCreateCheckoutSession.mockRejectedValue(new Error('Stripe unavailable'));
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_FAILED',
      })
    );
  });
});
