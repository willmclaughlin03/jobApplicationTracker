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

  function createMockReq(body = {
    plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
    checkoutAttemptNonce: '0123456789abcdef0123456789abcdef',
  }) {
    return {
      method: 'POST',
      body,
      _rateLimitUser: mockUser,
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
    const req = createMockReq({ plan: 'bad-plan' });
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
      idempotencyKey: 'billing_checkout_hash1234567890hash123456_resume_tailor_monthly_0123456789abcdef0123456789abcdef',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { url: 'https://checkout.stripe.test/session_123' },
      })
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
