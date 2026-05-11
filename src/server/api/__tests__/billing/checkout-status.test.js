jest.mock('../../../middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
}));

const mockAssertStripeLivemode = jest.fn();
const mockFormatStripeIdForLog = jest.fn((value) => value);
const mockLoadBillingStatusOrThrow = jest.fn();
const mockMapCheckoutStatus = jest.fn();
const mockSyncSubscriptionFromStripe = jest.fn();
const mockRetrieveCheckoutSession = jest.fn();

jest.mock('../../../lib/billingService.js', () => ({
  assertStripeLivemode: mockAssertStripeLivemode,
  BILLING_SYNC_MODES: {
    AUTHORITATIVE: 'authoritative',
  },
  BILLING_WRITE_OUTCOMES: {
    CUSTOMER_NOT_FOUND: 'customer_not_found',
    PROCESSED: 'processed',
    UNSUPPORTED_STATUS_IGNORED: 'unsupported_status_ignored',
  },
  formatStripeIdForLog: mockFormatStripeIdForLog,
  loadBillingStatusOrThrow: mockLoadBillingStatusOrThrow,
  mapCheckoutStatus: mockMapCheckoutStatus,
  syncSubscriptionFromStripe: mockSyncSubscriptionFromStripe,
}));

jest.mock('../../../lib/stripe.js', () => ({
  stripe: {
    checkout: {
      sessions: {
        retrieve: mockRetrieveCheckoutSession,
      },
    },
  },
}));

const handler = require('../../../../pages/api/billing/checkout-status.js').default;

describe('/api/billing/checkout-status handler', () => {
  const mockUser = { id: 'user-billing-status' };
  const mockClient = { from: jest.fn() };
  const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  function createMockReq(body = { sessionId: 'cs_test_a1Ae6ClgOkjygKwrf9B3L6IT' }) {
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
    mockAssertStripeLivemode.mockReset();
    mockLoadBillingStatusOrThrow.mockReset();
    mockMapCheckoutStatus.mockReset();
    mockSyncSubscriptionFromStripe.mockReset();
    mockRetrieveCheckoutSession.mockReset();
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'open',
      subscription: null,
    });
    mockLoadBillingStatusOrThrow.mockResolvedValue({
      entitled: false,
      stripeCustomerId: 'cus_local_123',
    });
    mockMapCheckoutStatus.mockReturnValue('pending');
    mockSyncSubscriptionFromStripe.mockResolvedValue({ outcome: 'processed' });
  });

  it('rejects invalid request bodies', async () => {
    const req = createMockReq({ sessionId: 'bad-id' });
    const res = createMockRes();

    await handler(req, res);

    expect(mockRetrieveCheckoutSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'VALIDATION_ERROR',
      })
    );
  });

  it('collapses valid-but-missing checkout sessions to the same ownership failure response', async () => {
    mockRetrieveCheckoutSession.mockRejectedValue({
      type: 'StripeInvalidRequestError',
      statusCode: 404,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_OWNERSHIP_INVALID',
      })
    );
  });

  it('verifies ownership before livemode checks or reconcile work', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: 'different-user',
      customer: 'cus_local_123',
      livemode: false,
      status: 'complete',
      subscription: 'sub_123',
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockAssertStripeLivemode).not.toHaveBeenCalled();
    expect(mockSyncSubscriptionFromStripe).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_OWNERSHIP_INVALID',
      })
    );
  });

  it('rejects reconcile work when the Stripe customer does not match the local billing mapping', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_other_user',
      livemode: false,
      status: 'complete',
      subscription: 'sub_123',
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSyncSubscriptionFromStripe).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_OWNERSHIP_INVALID',
      })
    );
  });

  it('rejects completed-session reconcile work when the Checkout Session omits a customer id', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: null,
      livemode: false,
      status: 'complete',
      subscription: 'sub_123',
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSyncSubscriptionFromStripe).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_OWNERSHIP_INVALID',
      })
    );
  });

  it('rejects completed-session reconcile work when the Checkout Session customer is unparseable', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: { deleted: true },
      livemode: false,
      status: 'complete',
      subscription: 'sub_123',
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSyncSubscriptionFromStripe).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_OWNERSHIP_INVALID',
      })
    );
  });

  it('rejects completed-session reconcile work when the local billing state has no Stripe customer id', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'complete',
      subscription: 'sub_123',
    });
    mockLoadBillingStatusOrThrow.mockResolvedValue({
      entitled: false,
      stripeCustomerId: null,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSyncSubscriptionFromStripe).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_OWNERSHIP_INVALID',
      })
    );
  });

  it('returns a terminal error state when the livemode assertion fails', async () => {
    mockAssertStripeLivemode.mockImplementation(() => {
      throw Object.assign(new Error('bad mode'), { code: 'BILLING_LIVEMODE_MISMATCH' });
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { state: 'error' },
      })
    );
  });

  it('returns 503 when the strict local billing read fails', async () => {
    mockLoadBillingStatusOrThrow.mockRejectedValue(new Error('strict read failed'));
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

  it('reconciles at most once when Stripe completed checkout but local state is still non-entitled', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'complete',
      subscription: 'sub_checkout_123',
    });
    mockLoadBillingStatusOrThrow
      .mockResolvedValueOnce({ entitled: false, stripeCustomerId: 'cus_local_123' })
      .mockResolvedValueOnce({ entitled: true, stripeCustomerId: 'cus_local_123' });
    mockMapCheckoutStatus.mockReturnValue('active');
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSyncSubscriptionFromStripe).toHaveBeenCalledTimes(1);
    expect(mockSyncSubscriptionFromStripe).toHaveBeenCalledWith(
      'sub_checkout_123',
      {
        mode: 'authoritative',
        expectedUserId: mockUser.id,
      },
      mockLog
    );
    expect(mockLoadBillingStatusOrThrow).toHaveBeenCalledTimes(2);
    expect(mockMapCheckoutStatus).toHaveBeenCalledWith({
      billingStatus: { entitled: true, stripeCustomerId: 'cus_local_123' },
      checkoutSessionStatus: 'complete',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { state: 'active' },
      })
    );
  });

  it('returns a terminal error when completed checkout reconcile leaves local state non-entitled', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'complete',
      subscription: 'sub_checkout_123',
    });
    mockLoadBillingStatusOrThrow
      .mockResolvedValueOnce({ entitled: false, stripeCustomerId: 'cus_local_123' })
      .mockResolvedValueOnce({ entitled: false, stripeCustomerId: 'cus_local_123' });
    mockSyncSubscriptionFromStripe.mockResolvedValue({ outcome: 'processed' });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSyncSubscriptionFromStripe).toHaveBeenCalledTimes(1);
    expect(mockLoadBillingStatusOrThrow).toHaveBeenCalledTimes(2);
    expect(mockMapCheckoutStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { state: 'error' },
      })
    );
  });

  it('returns pending for an open checkout session with non-entitled local state', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'open',
      subscription: null,
    });
    mockLoadBillingStatusOrThrow.mockResolvedValue({
      entitled: false,
      stripeCustomerId: 'cus_local_123',
    });
    mockMapCheckoutStatus.mockReturnValue('pending');
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSyncSubscriptionFromStripe).not.toHaveBeenCalled();
    expect(mockMapCheckoutStatus).toHaveBeenCalledWith({
      billingStatus: { entitled: false, stripeCustomerId: 'cus_local_123' },
      checkoutSessionStatus: 'open',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { state: 'pending' },
      })
    );
  });

  it('returns a terminal error state when a completed session has no subscription id to reconcile', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'complete',
      subscription: null,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSyncSubscriptionFromStripe).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { state: 'error' },
      })
    );
  });

  it('returns a terminal error state when reconcile reports a missing local customer mapping', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'complete',
      subscription: 'sub_checkout_123',
    });
    mockSyncSubscriptionFromStripe.mockResolvedValue({
      outcome: 'customer_not_found',
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockLoadBillingStatusOrThrow).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { state: 'error' },
      })
    );
  });

  it('returns a terminal error state when reconcile reports an unsupported Stripe status', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'complete',
      subscription: 'sub_checkout_123',
    });
    mockSyncSubscriptionFromStripe.mockResolvedValue({
      outcome: 'unsupported_status_ignored',
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockLoadBillingStatusOrThrow).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { state: 'error' },
      })
    );
  });

  it('returns 403 when authoritative reconcile resolves to a different local user', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'complete',
      subscription: 'sub_checkout_123',
    });
    mockSyncSubscriptionFromStripe.mockResolvedValue({
      outcome: 'processed',
      userId: 'user-other',
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockLoadBillingStatusOrThrow).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_OWNERSHIP_INVALID',
      })
    );
  });

  it('returns 403 when authoritative reconcile throws a billing ownership mismatch', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'complete',
      subscription: 'sub_checkout_123',
    });
    mockSyncSubscriptionFromStripe.mockRejectedValue(
      Object.assign(new Error('wrong user'), { code: 'BILLING_OWNERSHIP_MISMATCH' })
    );
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockLoadBillingStatusOrThrow).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_OWNERSHIP_INVALID',
      })
    );
  });

  it('returns 503 when authoritative reconcile work fails in a retryable way', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'complete',
      subscription: 'sub_checkout_123',
    });
    mockSyncSubscriptionFromStripe.mockRejectedValue(
      Object.assign(new Error('Stripe transport failed'), { type: 'StripeConnectionError' })
    );
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSyncSubscriptionFromStripe).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'SERVICE_UNAVAILABLE',
      })
    );
  });

  it('returns a terminal error state when reconcile fails with a non-retryable internal error', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'complete',
      subscription: 'sub_checkout_123',
    });
    mockSyncSubscriptionFromStripe.mockRejectedValue(new Error('unexpected reconcile bug'));
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSyncSubscriptionFromStripe).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { state: 'error' },
      })
    );
  });
});
