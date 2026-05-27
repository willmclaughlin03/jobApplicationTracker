const mockSupabaseAdmin = {
  from: jest.fn(),
};
const mockRetrieveCheckoutSession = jest.fn();
const mockExpireCheckoutSession = jest.fn();
const mockGetStripeClient = jest.fn();
const mockFormatStripeIdForLog = jest.fn((value) => value);
const mockMarkMintedCheckoutSessionTerminalByStripeSessionId = jest.fn();
const mockSyncSubscriptionFromStripe = jest.fn();

jest.mock('../supabaseServer.js', () => ({
  supabaseAdmin: mockSupabaseAdmin,
}));

jest.mock('../stripeRuntime.js', () => ({
  getStripeClient: mockGetStripeClient,
}));

jest.mock('../billingService.js', () => ({
  BILLING_SYNC_MODES: {
    AUTHORITATIVE: 'authoritative',
  },
  formatStripeIdForLog: mockFormatStripeIdForLog,
  markMintedCheckoutSessionTerminalByStripeSessionId:
    mockMarkMintedCheckoutSessionTerminalByStripeSessionId,
  syncSubscriptionFromStripe: mockSyncSubscriptionFromStripe,
}));

const { drainOpenCheckoutSessions } = require('../billingCheckoutDrain.js');

describe('billingCheckoutDrain', () => {
  const mockLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  /**
   * Configure the service-role open-session query for one drain run.
   *
   * Purpose: tests need to assert the exact local query shape while returning
   * Supabase-like promise payloads from the terminal `.limit(...)` call.
   *
   * @param {object[]} rows
   * @param {object | null} error
   * @returns {object}
   */
  function mockOpenRows(rows, error = null) {
    const builder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: rows, error }),
    };

    mockSupabaseAdmin.from.mockReturnValue(builder);

    return builder;
  }

  /**
   * Build a valid local open Checkout Session row fixture.
   *
   * Purpose: drain scenarios only vary the Stripe-side Session status, so this
   * keeps local row setup terse and consistent across tests.
   *
   * @param {object} overrides
   * @returns {object}
   */
  function createOpenRow(overrides = {}) {
    return {
      id: 42,
      user_id: 'user-drain-123',
      plan: 'resume_tailor_monthly',
      stripe_checkout_session_id: 'cs_test_open_123',
      status: 'open',
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          retrieve: mockRetrieveCheckoutSession,
          expire: mockExpireCheckoutSession,
        },
      },
    });
    mockMarkMintedCheckoutSessionTerminalByStripeSessionId.mockResolvedValue({
      id: 42,
      status: 'expired',
    });
    mockSyncSubscriptionFromStripe.mockResolvedValue({ outcome: 'processed' });
  });

  it('enumerates locally open Checkout Sessions and expires Stripe-open Sessions before mirroring locally', async () => {
    const row = createOpenRow();
    const builder = mockOpenRows([row]);
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: row.stripe_checkout_session_id,
      status: 'open',
    });
    mockExpireCheckoutSession.mockResolvedValue({
      id: row.stripe_checkout_session_id,
      status: 'expired',
    });

    const summary = await drainOpenCheckoutSessions({ limit: 25 }, mockLog);

    expect(mockSupabaseAdmin.from).toHaveBeenCalledWith('billing_checkout_sessions');
    expect(builder.eq).toHaveBeenCalledWith('status', 'open');
    expect(builder.limit).toHaveBeenCalledWith(25);
    expect(mockRetrieveCheckoutSession).toHaveBeenCalledWith('cs_test_open_123');
    expect(mockExpireCheckoutSession).toHaveBeenCalledWith('cs_test_open_123');
    expect(mockMarkMintedCheckoutSessionTerminalByStripeSessionId).toHaveBeenCalledWith(
      {
        sessionId: 'cs_test_open_123',
        status: 'expired',
      },
      mockLog
    );
    expect(summary).toEqual(expect.objectContaining({
      total: 1,
      expired: 1,
      failed: 0,
    }));
  });

  it('does not force expiration when Stripe says the Checkout Session is complete', async () => {
    const row = createOpenRow({
      stripe_checkout_session_id: 'cs_test_complete_123',
    });
    mockOpenRows([row]);
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: row.stripe_checkout_session_id,
      status: 'complete',
      subscription: 'sub_checkout_complete_123',
    });

    const summary = await drainOpenCheckoutSessions({}, mockLog);

    expect(mockExpireCheckoutSession).not.toHaveBeenCalled();
    expect(mockSyncSubscriptionFromStripe).toHaveBeenCalledWith(
      'sub_checkout_complete_123',
      {
        mode: 'authoritative',
        expectedUserId: 'user-drain-123',
      },
      mockLog
    );
    expect(mockMarkMintedCheckoutSessionTerminalByStripeSessionId).toHaveBeenCalledWith(
      {
        sessionId: 'cs_test_complete_123',
        status: 'complete',
      },
      mockLog
    );
    expect(summary).toEqual(expect.objectContaining({
      complete: 1,
      expired: 0,
      failed: 0,
    }));
  });

  it('mirrors Stripe-expired Sessions locally without calling expire again', async () => {
    const row = createOpenRow({
      stripe_checkout_session_id: 'cs_test_expired_123',
    });
    mockOpenRows([row]);
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: row.stripe_checkout_session_id,
      status: 'expired',
    });

    const summary = await drainOpenCheckoutSessions({}, mockLog);

    expect(mockExpireCheckoutSession).not.toHaveBeenCalled();
    expect(mockMarkMintedCheckoutSessionTerminalByStripeSessionId).toHaveBeenCalledWith(
      {
        sessionId: 'cs_test_expired_123',
        status: 'expired',
      },
      mockLog
    );
    expect(summary).toEqual(expect.objectContaining({
      alreadyExpired: 1,
      failed: 0,
    }));
  });

  it('leaves local rows open and reports failure when Stripe expiration is not confirmed', async () => {
    const row = createOpenRow();
    mockOpenRows([row]);
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: row.stripe_checkout_session_id,
      status: 'open',
    });
    mockExpireCheckoutSession.mockResolvedValue({
      id: row.stripe_checkout_session_id,
      status: 'open',
    });

    const summary = await drainOpenCheckoutSessions({}, mockLog);

    expect(mockMarkMintedCheckoutSessionTerminalByStripeSessionId).not.toHaveBeenCalled();
    expect(summary).toEqual(expect.objectContaining({
      failed: 1,
      expired: 0,
    }));
    expect(summary.results[0]).toEqual(expect.objectContaining({
      outcome: 'failed',
      errorCode: 'BILLING_CHECKOUT_DRAIN_EXPIRE_UNCONFIRMED',
    }));
  });

  it('leaves completed rows open for follow-up when no subscription id is available', async () => {
    const row = createOpenRow();
    mockOpenRows([row]);
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: row.stripe_checkout_session_id,
      status: 'complete',
      subscription: null,
    });

    const summary = await drainOpenCheckoutSessions({}, mockLog);

    expect(mockSyncSubscriptionFromStripe).not.toHaveBeenCalled();
    expect(mockMarkMintedCheckoutSessionTerminalByStripeSessionId).not.toHaveBeenCalled();
    expect(summary.results[0]).toEqual(expect.objectContaining({
      outcome: 'failed',
      errorCode: 'BILLING_CHECKOUT_DRAIN_SUBSCRIPTION_MISSING',
    }));
  });
});
