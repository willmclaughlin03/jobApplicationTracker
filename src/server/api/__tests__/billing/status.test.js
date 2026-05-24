jest.mock('../../../middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
}));

const mockLoadBillingStatusOrThrow = jest.fn();

jest.mock('../../../lib/billingService.js', () => ({
  loadBillingStatusOrThrow: mockLoadBillingStatusOrThrow,
}));

const handler = require('../../../../pages/api/billing/status.js').default;

describe('/api/billing/status handler', () => {
  const mockUser = { id: 'user-billing-status' };
  const mockClient = { from: jest.fn() };
  const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  function createMockReq() {
    return {
      method: 'GET',
      _rateLimitUser: mockUser,
      _supabaseClient: mockClient,
      log: mockLog,
    };
  }

  function createMockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns canonical local billing fields with cache-hardening headers', async () => {
    mockLoadBillingStatusOrThrow.mockResolvedValue({
      entitled: true,
      entitlement: 'ai_tailor',
      status: 'active',
      currentPeriodEnd: '2026-06-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      hasCustomerMapping: true,
      stripeCustomerId: 'cus_local_123',
      hasSubscription: true,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockLoadBillingStatusOrThrow).toHaveBeenCalledWith(mockUser.id, mockClient, mockLog);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.setHeader).toHaveBeenCalledWith('CDN-Cache-Control', 'no-store');
    expect(res.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Cookie');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          entitled: true,
          entitlement: 'ai_tailor',
          status: 'active',
          currentPeriodEnd: '2026-06-01T00:00:00.000Z',
          cancelAtPeriodEnd: false,
          hasCustomerMapping: true,
          hasPortalCustomer: true,
          hasSubscription: true,
        },
        error: null,
      })
    );
  });

  it('reports hasPortalCustomer as false when a local customer row exists without a Stripe customer id', async () => {
    mockLoadBillingStatusOrThrow.mockResolvedValue({
      entitled: false,
      entitlement: null,
      status: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      hasCustomerMapping: true,
      stripeCustomerId: null,
      hasSubscription: false,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          hasCustomerMapping: true,
          hasPortalCustomer: false,
        }),
      })
    );
  });

  it('returns 503 when the local billing read fails', async () => {
    mockLoadBillingStatusOrThrow.mockRejectedValue(new Error('billing read failed'));
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'SERVICE_UNAVAILABLE',
      })
    );
  });
});
