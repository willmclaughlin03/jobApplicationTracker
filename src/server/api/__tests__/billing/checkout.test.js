jest.mock('../../../middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => handler,
}));

const mockCanStartCheckout = jest.fn();
const mockClaimPendingCheckoutSession = jest.fn();
const mockFailPendingCheckoutSession = jest.fn();
const mockFinalizePendingCheckoutSession = jest.fn();
const mockGetOrCreateStripeCustomer = jest.fn();
const mockHashUserIdForIdempotency = jest.fn();
const mockLoadBillingStatusOrThrow = jest.fn();
const mockWaitForPendingCheckoutSessionOpen = jest.fn();
const mockBuildAppUrl = jest.fn((path) => `https://app.example.test${path}`);
const mockGetPriceIdForPlan = jest.fn();
const mockCreateCheckoutSession = jest.fn();

jest.mock('../../../lib/billingService.js', () => ({
  canStartCheckout: mockCanStartCheckout,
  claimPendingCheckoutSession: mockClaimPendingCheckoutSession,
  failPendingCheckoutSession: mockFailPendingCheckoutSession,
  finalizePendingCheckoutSession: mockFinalizePendingCheckoutSession,
  getOrCreateStripeCustomer: mockGetOrCreateStripeCustomer,
  hashUserIdForIdempotency: mockHashUserIdForIdempotency,
  loadBillingStatusOrThrow: mockLoadBillingStatusOrThrow,
  PENDING_CHECKOUT_SESSION_OUTCOMES: {
    CLAIMED: 'claimed',
    CREATING: 'creating',
    REUSED: 'reused',
  },
  waitForPendingCheckoutSessionOpen: mockWaitForPendingCheckoutSessionOpen,
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
  const defaultPendingSession = {
    id: 42,
    userId: mockUser.id,
    plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
    status: 'creating',
    checkoutUrl: null,
    expiresAt: null,
  };
  const defaultCheckoutSession = {
    id: 'cs_test_checkout_123',
    url: 'https://checkout.stripe.test/session_123',
    expires_at: 1899849600,
  };
  const defaultExpiresAtIso = '2030-03-16T00:00:00.000Z';

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
    mockClaimPendingCheckoutSession.mockResolvedValue({
      outcome: 'claimed',
      session: defaultPendingSession,
    });
    mockFailPendingCheckoutSession.mockResolvedValue({
      ...defaultPendingSession,
      status: 'failed',
    });
    mockFinalizePendingCheckoutSession.mockResolvedValue({
      ...defaultPendingSession,
      status: 'open',
      stripeCheckoutSessionId: defaultCheckoutSession.id,
      checkoutUrl: defaultCheckoutSession.url,
      expiresAt: defaultExpiresAtIso,
    });
    mockGetOrCreateStripeCustomer.mockResolvedValue({ stripeCustomerId: 'cus_checkout_123' });
    mockHashUserIdForIdempotency.mockReturnValue('hash1234567890hash1234567890');
    mockLoadBillingStatusOrThrow.mockResolvedValue({ hasSubscription: false, status: null });
    mockWaitForPendingCheckoutSessionOpen.mockResolvedValue(null);
    mockGetPriceIdForPlan.mockReturnValue('price_tailor_monthly');
    mockCreateCheckoutSession.mockResolvedValue(defaultCheckoutSession);
  });

  it('rejects invalid billing request bodies', async () => {
    const req = createMockReq({
      plan: 'bad-plan',
      checkoutAttemptNonce: defaultCheckoutAttemptNonce,
    });
    const res = createMockRes();

    await handler(req, res);

    expect(mockLoadBillingStatusOrThrow).not.toHaveBeenCalled();
    expect(mockClaimPendingCheckoutSession).not.toHaveBeenCalled();
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
    expect(mockClaimPendingCheckoutSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'VALIDATION_ERROR',
      })
    );
  });

  it('rejects checkout before local billing or Stripe work when the authenticated user has no email', async () => {
    const req = createMockReq(
      {
        plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
        checkoutAttemptNonce: defaultCheckoutAttemptNonce,
      },
      { id: mockUser.id, email: '   ' }
    );
    const res = createMockRes();

    await handler(req, res);

    expect(mockLoadBillingStatusOrThrow).not.toHaveBeenCalled();
    expect(mockClaimPendingCheckoutSession).not.toHaveBeenCalled();
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_FAILED',
      })
    );
  });

  it.each([
    ['malformed', 'not-an-email'],
    ['overlong', `${'a'.repeat(309)}@example.com`],
  ])('rejects checkout before local billing or Stripe work when the authenticated email is %s', async (_label, email) => {
    const req = createMockReq(
      {
        plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
        checkoutAttemptNonce: defaultCheckoutAttemptNonce,
      },
      { id: mockUser.id, email }
    );
    const res = createMockRes();

    await handler(req, res);

    expect(mockLoadBillingStatusOrThrow).not.toHaveBeenCalled();
    expect(mockClaimPendingCheckoutSession).not.toHaveBeenCalled();
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_FAILED',
      })
    );
  });

  it('trims a valid authenticated billing email before resolving the Stripe customer', async () => {
    const req = createMockReq(
      {
        plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
        checkoutAttemptNonce: defaultCheckoutAttemptNonce,
      },
      { id: mockUser.id, email: '  test@example.com  ' }
    );
    const res = createMockRes();

    await handler(req, res);

    expect(mockGetOrCreateStripeCustomer).toHaveBeenCalledWith(
      mockUser.id,
      'test@example.com',
      mockLog
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('claims a pending row before Stripe creation and persists the returned session URL', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockLoadBillingStatusOrThrow).toHaveBeenCalledWith(mockUser.id, mockClient, mockLog);
    expect(mockCanStartCheckout).toHaveBeenCalledWith({ hasSubscription: false, status: null });
    expect(mockClaimPendingCheckoutSession).toHaveBeenCalledWith(
      {
        userId: mockUser.id,
        plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
        checkoutAttemptNonce: defaultCheckoutAttemptNonce,
      },
      mockLog
    );
    expect(mockClaimPendingCheckoutSession.mock.invocationCallOrder[0]).toBeLessThan(
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
    expect(mockFinalizePendingCheckoutSession).toHaveBeenCalledWith(
      {
        userId: mockUser.id,
        id: defaultPendingSession.id,
        stripeCheckoutSessionId: defaultCheckoutSession.id,
        checkoutUrl: defaultCheckoutSession.url,
        expiresAt: defaultExpiresAtIso,
      },
      mockLog
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { url: defaultCheckoutSession.url },
      })
    );
  });

  it('reuses an existing open pending session without calling Stripe again', async () => {
    mockClaimPendingCheckoutSession.mockResolvedValue({
      outcome: 'reused',
      session: {
        ...defaultPendingSession,
        status: 'open',
        checkoutUrl: 'https://checkout.stripe.test/reused',
      },
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(mockFinalizePendingCheckoutSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { url: 'https://checkout.stripe.test/reused' },
      })
    );
  });

  it('waits for another creating claim and reuses its persisted URL', async () => {
    mockClaimPendingCheckoutSession.mockResolvedValue({
      outcome: 'creating',
      session: defaultPendingSession,
    });
    mockWaitForPendingCheckoutSessionOpen.mockResolvedValue({
      ...defaultPendingSession,
      status: 'open',
      checkoutUrl: 'https://checkout.stripe.test/waited',
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockWaitForPendingCheckoutSessionOpen).toHaveBeenCalledWith(
      {
        userId: mockUser.id,
        plan: BILLING_PLANS.RESUME_TAILOR_MONTHLY,
      },
      mockLog
    );
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { url: 'https://checkout.stripe.test/waited' },
      })
    );
  });

  it('dedupes parallel requests with different nonces to one persisted pending-session URL', async () => {
    const firstNonce = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const secondNonce = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    mockClaimPendingCheckoutSession
      .mockResolvedValueOnce({
        outcome: 'claimed',
        session: defaultPendingSession,
      })
      .mockResolvedValueOnce({
        outcome: 'creating',
        session: defaultPendingSession,
      });
    mockWaitForPendingCheckoutSessionOpen.mockResolvedValue({
      ...defaultPendingSession,
      status: 'open',
      checkoutUrl: defaultCheckoutSession.url,
    });
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

    await Promise.all([
      handler(firstReq, firstRes),
      handler(secondReq, secondRes),
    ]);

    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1);
    expect(mockFinalizePendingCheckoutSession).toHaveBeenCalledTimes(1);
    expect(firstRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { url: defaultCheckoutSession.url },
      })
    );
    expect(secondRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { url: defaultCheckoutSession.url },
      })
    );
  });

  it('keeps user-specific Stripe idempotency material for the claim owner', async () => {
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

  it('keeps nonce-specific Stripe idempotency material only after owning a claim', async () => {
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

    expect(mockClaimPendingCheckoutSession).not.toHaveBeenCalled();
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

    expect(mockClaimPendingCheckoutSession).not.toHaveBeenCalled();
    expect(mockGetOrCreateStripeCustomer).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'SERVICE_UNAVAILABLE',
      })
    );
  });

  it('returns retryable 503 when another creating claim never becomes reusable', async () => {
    mockClaimPendingCheckoutSession.mockResolvedValue({
      outcome: 'creating',
      session: defaultPendingSession,
    });
    mockWaitForPendingCheckoutSessionOpen.mockResolvedValue(null);
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'SERVICE_UNAVAILABLE',
      })
    );
  });

  it('marks the pending claim failed when Stripe checkout session creation fails', async () => {
    mockCreateCheckoutSession.mockRejectedValue(new Error('Stripe unavailable'));
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockFailPendingCheckoutSession).toHaveBeenCalledWith(
      { userId: mockUser.id, id: defaultPendingSession.id },
      mockLog
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_FAILED',
      })
    );
  });

  it('marks the pending claim failed when Stripe omits required session fields', async () => {
    mockCreateCheckoutSession.mockResolvedValue({ id: 'cs_test_missing_url' });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockFailPendingCheckoutSession).toHaveBeenCalledWith(
      { userId: mockUser.id, id: defaultPendingSession.id },
      mockLog
    );
    expect(mockFinalizePendingCheckoutSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['non-finite number', Number.POSITIVE_INFINITY],
  ])('marks the pending claim failed when Stripe returns a %s expiry', async (_label, expiresAt) => {
    mockCreateCheckoutSession.mockResolvedValue({
      ...defaultCheckoutSession,
      expires_at: expiresAt,
    });
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockFailPendingCheckoutSession).toHaveBeenCalledWith(
      { userId: mockUser.id, id: defaultPendingSession.id },
      mockLog
    );
    expect(mockFinalizePendingCheckoutSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_FAILED',
      })
    );
  });

  it('does not return an unpersisted Stripe URL when pending finalize fails', async () => {
    mockFinalizePendingCheckoutSession.mockRejectedValue(new Error('database unavailable'));
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockFailPendingCheckoutSession).toHaveBeenCalledWith(
      { userId: mockUser.id, id: defaultPendingSession.id },
      mockLog
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CHECKOUT_SESSION_FAILED',
      })
    );
  });
});
