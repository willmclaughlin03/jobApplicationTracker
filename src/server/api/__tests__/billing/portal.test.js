jest.mock('../../../middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
}));

const mockLoadBillingStatusOrThrow = jest.fn();
const mockCreatePortalSession = jest.fn();
const mockBuildAppUrl = jest.fn((path) => `https://app.example.test${path}`);
const mockGetBillingPortalConfigurationId = jest.fn();
const mockGetPriceIdForPlan = jest.fn();
const mockGetStripeClient = jest.fn();

jest.mock('../../../lib/billingService.js', () => ({
  loadBillingStatusOrThrow: mockLoadBillingStatusOrThrow,
}));

jest.mock('../../../lib/appUrl.js', () => ({
  buildAppUrl: mockBuildAppUrl,
}));

jest.mock('../../../lib/stripePortalConfig.js', () => ({
  getBillingPortalConfigurationId: mockGetBillingPortalConfigurationId,
}));

jest.mock('../../../lib/stripeCheckoutConfig.js', () => ({
  getPriceIdForPlan: mockGetPriceIdForPlan,
}));

jest.mock('../../../lib/stripeRuntime.js', () => ({
  getStripeClient: mockGetStripeClient,
}));

const handler = require('../../../../pages/api/billing/portal.js').default;

describe('/api/billing/portal handler', () => {
  const mockUser = { id: 'user-billing-portal' };
  const mockClient = { from: jest.fn() };
  const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  /**
   * Create a mock billing-portal POST request.
   *
   * Purpose: tests exercise the handler with middleware-shaped request fields.
   * No params; uses mockUser, mockClient, and mockLog from this suite.
   *
   * @returns {object} POST request with body, _rateLimitUser, _supabaseClient, and log.
   */
  function createMockReq() {
    return {
      method: 'POST',
      body: {},
      _rateLimitUser: mockUser,
      _supabaseClient: mockClient,
      log: mockLog,
    };
  }

  /**
   * Create a chainable billing-portal response mock.
   *
   * Purpose: tests assert status/json response contracts without a real Next.js
   * response object.
   *
   * @returns {object} response with jest.fn() status/json methods using mockReturnThis().
   */
  function createMockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildAppUrl.mockImplementation((path) => `https://app.example.test${path}`);
    mockGetBillingPortalConfigurationId.mockReturnValue('bpc_test_portal_123');
    mockGetStripeClient.mockReturnValue({
      billingPortal: {
        sessions: {
          create: mockCreatePortalSession,
        },
      },
    });
  });

  it('creates a Stripe billing portal session from the local customer mapping', async () => {
    mockLoadBillingStatusOrThrow.mockResolvedValue({
      stripeCustomerId: 'cus_portal_123',
    });
    mockCreatePortalSession.mockResolvedValue({
      url: 'https://billing.stripe.test/session_123',
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockLoadBillingStatusOrThrow).toHaveBeenCalledWith(mockUser.id, mockClient, mockLog);
    expect(mockBuildAppUrl).toHaveBeenCalledWith('/billing');
    expect(mockCreatePortalSession).toHaveBeenCalledWith({
      customer: 'cus_portal_123',
      configuration: 'bpc_test_portal_123',
      return_url: 'https://app.example.test/billing',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { url: 'https://billing.stripe.test/session_123' },
      })
    );
  });

  it('fails closed when no local customer mapping exists', async () => {
    mockLoadBillingStatusOrThrow.mockResolvedValue({
      stripeCustomerId: null,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockCreatePortalSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'PORTAL_SESSION_FAILED',
      })
    );
  });

  it('returns 503 when the strict local billing read fails', async () => {
    const req = createMockReq();
    const res = createMockRes();

    mockLoadBillingStatusOrThrow.mockRejectedValue({
      code: 'BILLING_STATUS_UNAVAILABLE',
      message: 'strict billing read failed',
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'SERVICE_UNAVAILABLE',
      })
    );
  });

  it('returns 503 when Stripe portal session creation fails', async () => {
    mockLoadBillingStatusOrThrow.mockResolvedValue({
      stripeCustomerId: 'cus_portal_123',
    });
    mockCreatePortalSession.mockRejectedValue(new Error('Stripe down'));
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'PORTAL_SESSION_FAILED',
      })
    );
  });

  it('creates the portal session without resolving Checkout price config', async () => {
    mockLoadBillingStatusOrThrow.mockResolvedValue({
      stripeCustomerId: 'cus_portal_123',
    });
    mockCreatePortalSession.mockResolvedValue({
      url: 'https://billing.stripe.test/session_123',
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockGetPriceIdForPlan).not.toHaveBeenCalled();
    expect(mockCreatePortalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: 'bpc_test_portal_123',
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('fails closed when the pinned portal configuration id is missing', async () => {
    mockLoadBillingStatusOrThrow.mockResolvedValue({
      stripeCustomerId: 'cus_portal_123',
    });
    mockGetBillingPortalConfigurationId.mockImplementation(() => {
      throw Object.assign(new Error('missing portal config'), { code: 'STRIPE_CONFIG_INVALID' });
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockCreatePortalSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'PORTAL_SESSION_FAILED',
      })
    );
  });
});
