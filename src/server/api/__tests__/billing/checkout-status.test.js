jest.mock('../../../middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
}));

const mockAssertStripeLivemode = jest.fn();
const mockBuildAuthoritativeSubscriptionSnapshot = jest.fn();
const mockFormatStripeIdForLog = jest.fn((value) => value);
const mockGetMintedCheckoutSessionForUser = jest.fn();
const mockLoadBillingStatusOrThrow = jest.fn();
const mockMarkMintedCheckoutSessionTerminal = jest.fn();
const mockMapCheckoutStatus = jest.fn();
const mockSyncSubscriptionFromStripe = jest.fn();
const mockGetStripeClient = jest.fn();
const mockRetrieveCheckoutSession = jest.fn();

jest.mock('../../../lib/billingService.js', () => ({
  assertStripeLivemode: mockAssertStripeLivemode,
  BILLING_AUTHORITATIVE_SYNC_PURPOSES: {
    CHECKOUT_COMPLETION: 'checkout_completion',
  },
  BILLING_SYNC_MODES: {
    AUTHORITATIVE: 'authoritative',
  },
  BILLING_WRITE_OUTCOMES: {
    CUSTOMER_NOT_FOUND: 'customer_not_found',
    PROCESSED: 'processed',
    UNSUPPORTED_STATUS_IGNORED: 'unsupported_status_ignored',
  },
  buildAuthoritativeSubscriptionSnapshot: mockBuildAuthoritativeSubscriptionSnapshot,
  formatStripeIdForLog: mockFormatStripeIdForLog,
  getMintedCheckoutSessionForUser: mockGetMintedCheckoutSessionForUser,
  loadBillingStatusOrThrow: mockLoadBillingStatusOrThrow,
  markMintedCheckoutSessionTerminal: mockMarkMintedCheckoutSessionTerminal,
  mapCheckoutStatus: mockMapCheckoutStatus,
  syncSubscriptionFromStripe: mockSyncSubscriptionFromStripe,
}));

jest.mock('../../../lib/stripeRuntime.js', () => ({
  getStripeClient: mockGetStripeClient,
}));

const handler = require('../../../../pages/api/billing/checkout-status.js').default;

describe('/api/billing/checkout-status handler', () => {
  const mockUser = { id: 'user-billing-status' };
  const mockClient = { from: jest.fn() };
  const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  /**
   * Create an authenticated checkout-status request mock.
   *
   * Purpose: tests can vary the request body while preserving the middleware
   * fields the handler reads.
   *
   * @param {object} body defaults to a valid sessionId payload.
   * @returns {object} request with _rateLimitUser, _supabaseClient, and log attached.
   */
  function createMockReq(body = { sessionId: 'cs_test_a1Ae6ClgOkjygKwrf9B3L6IT' }) {
    return {
      method: 'POST',
      body,
      _rateLimitUser: mockUser,
      _supabaseClient: mockClient,
      log: mockLog,
    };
  }

  /**
   * Create a chainable checkout-status response mock.
   *
   * Purpose: tests assert status/json response contracts without a real Next.js
   * response object.
   *
   * @returns {object} response with chainable mocked status and json functions.
   */
  function createMockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertStripeLivemode.mockReset();
    mockBuildAuthoritativeSubscriptionSnapshot.mockReset();
    mockLoadBillingStatusOrThrow.mockReset();
    mockMarkMintedCheckoutSessionTerminal.mockReset();
    mockMapCheckoutStatus.mockReset();
    mockSyncSubscriptionFromStripe.mockReset();
    mockGetMintedCheckoutSessionForUser.mockReset();
    mockRetrieveCheckoutSession.mockReset();
    mockGetStripeClient.mockReset();
    mockGetStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          retrieve: mockRetrieveCheckoutSession,
        },
      },
    });
    mockGetMintedCheckoutSessionForUser.mockResolvedValue({
      id: 42,
      userId: mockUser.id,
      stripeCheckoutSessionId: 'cs_test_a1Ae6ClgOkjygKwrf9B3L6IT',
    });
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
      subscription: null,
    });
    /**
     * Mirror the route-facing strict snapshot conversion for local fixtures.
     *
     * @param {object|null|undefined} billingStatus
     * @returns {object}
     */
    mockBuildAuthoritativeSubscriptionSnapshot.mockImplementation((billingStatus) => (
      billingStatus?.subscription
        ? {
          exists: true,
          subscriptionId: billingStatus.subscription.stripe_subscription_id,
          snapshotVersion: billingStatus.subscription.snapshot_version,
        }
        : { exists: false }
    ));
    mockMarkMintedCheckoutSessionTerminal.mockResolvedValue(null);
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

  it('rejects unknown local checkout sessions before calling Stripe', async () => {
    mockGetMintedCheckoutSessionForUser.mockResolvedValue(null);
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockGetMintedCheckoutSessionForUser).toHaveBeenCalledWith(
      {
        userId: mockUser.id,
        sessionId: 'cs_test_a1Ae6ClgOkjygKwrf9B3L6IT',
      },
      mockLog
    );
    expect(mockRetrieveCheckoutSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_OWNERSHIP_INVALID',
      })
    );
  });

  it('returns 503 when the local checkout-session ownership check fails', async () => {
    mockGetMintedCheckoutSessionForUser.mockRejectedValue(new Error('database unavailable'));
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockRetrieveCheckoutSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'SERVICE_UNAVAILABLE',
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
    expect(mockMarkMintedCheckoutSessionTerminal).not.toHaveBeenCalled();
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

    expect(mockMarkMintedCheckoutSessionTerminal).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce({
        entitled: false,
        stripeCustomerId: 'cus_local_123',
        subscription: {
          stripe_subscription_id: 'sub_previous_canceled_456',
          snapshot_version: 9,
        },
      })
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
        expectedSubscriptionSnapshot: {
          exists: true,
          subscriptionId: 'sub_previous_canceled_456',
          snapshotVersion: 9,
        },
        authoritativeSyncPurpose: 'checkout_completion',
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
    expect(mockSyncSubscriptionFromStripe).toHaveBeenCalledWith(
      'sub_checkout_123',
      {
        mode: 'authoritative',
        expectedUserId: mockUser.id,
        expectedSubscriptionSnapshot: { exists: false },
        authoritativeSyncPurpose: 'checkout_completion',
      },
      mockLog
    );
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

    expect(mockMarkMintedCheckoutSessionTerminal).not.toHaveBeenCalled();
    expect(mockSyncSubscriptionFromStripe).not.toHaveBeenCalled();
    expect(mockMapCheckoutStatus).toHaveBeenCalledWith({
      billingStatus: expect.objectContaining({
        entitled: false,
        stripeCustomerId: 'cus_local_123',
      }),
      checkoutSessionStatus: 'open',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { state: 'pending' },
      })
    );
  });

  it('marks a completed locally minted checkout session terminal without using that row for entitlement', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'complete',
      subscription: 'sub_checkout_123',
    });
    mockLoadBillingStatusOrThrow.mockResolvedValue({
      entitled: true,
      stripeCustomerId: 'cus_local_123',
    });
    mockMapCheckoutStatus.mockReturnValue('active');
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockMarkMintedCheckoutSessionTerminal).toHaveBeenCalledWith(
      {
        userId: mockUser.id,
        sessionId: 'cs_test_a1Ae6ClgOkjygKwrf9B3L6IT',
        status: 'complete',
      },
      mockLog
    );
    expect(mockSyncSubscriptionFromStripe).not.toHaveBeenCalled();
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

  it('marks an expired locally minted checkout session terminal and returns the mapped state', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'expired',
      subscription: null,
    });
    mockMapCheckoutStatus.mockReturnValue('error');
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockMarkMintedCheckoutSessionTerminal).toHaveBeenCalledWith(
      {
        userId: mockUser.id,
        sessionId: 'cs_test_a1Ae6ClgOkjygKwrf9B3L6IT',
        status: 'expired',
      },
      mockLog
    );
    expect(mockSyncSubscriptionFromStripe).not.toHaveBeenCalled();
    expect(mockMapCheckoutStatus).toHaveBeenCalledWith({
      billingStatus: expect.objectContaining({
        entitled: false,
        stripeCustomerId: 'cus_local_123',
      }),
      checkoutSessionStatus: 'expired',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { state: 'error' },
      })
    );
  });

  it('continues checkout-status resolution when terminal local marking fails', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      client_reference_id: mockUser.id,
      customer: 'cus_local_123',
      livemode: false,
      status: 'expired',
      subscription: null,
    });
    mockMarkMintedCheckoutSessionTerminal.mockRejectedValue(new Error('mark failed'));
    mockMapCheckoutStatus.mockReturnValue('error');
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockMarkMintedCheckoutSessionTerminal).toHaveBeenCalledTimes(1);
    expect(mockMapCheckoutStatus).toHaveBeenCalledWith({
      billingStatus: expect.objectContaining({
        entitled: false,
        stripeCustomerId: 'cus_local_123',
      }),
      checkoutSessionStatus: 'expired',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { state: 'error' },
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
