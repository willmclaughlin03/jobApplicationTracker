const mockAssertStripeLivemode = jest.fn();
const mockClaimStripeEventReceiptProcessing = jest.fn();
const mockFormatStripeIdForLog = jest.fn((value) => value);
const mockGetStripeEventReceiptForEvent = jest.fn();
const mockHasMatchingStripeEventReceiptEnvelope = jest.fn();
const mockMarkMintedCheckoutSessionTerminalByStripeSessionId = jest.fn();
const mockMarkSubscriptionDeletedFromEvent = jest.fn();
const mockRecordStripeEventReceipt = jest.fn();
const mockSyncSubscriptionFromEvent = jest.fn();

jest.mock('../../../../server/lib/billingService.js', () => ({
  assertStripeLivemode: mockAssertStripeLivemode,
  BILLING_WRITE_OUTCOMES: {
    PROCESSED: 'processed',
    STALE_IGNORED: 'stale_ignored',
    CUSTOMER_NOT_FOUND: 'customer_not_found',
    UNSUPPORTED_STATUS_IGNORED: 'unsupported_status_ignored',
  },
  STRIPE_EVENT_RECEIPT_RESULTS: {
    PROCESSING: 'processing',
    PROCESSED: 'processed',
    STALE_IGNORED: 'stale_ignored',
    FAILED: 'failed',
  },
  claimStripeEventReceiptProcessing: mockClaimStripeEventReceiptProcessing,
  formatStripeIdForLog: mockFormatStripeIdForLog,
  getStripeEventReceiptForEvent: mockGetStripeEventReceiptForEvent,
  hasMatchingStripeEventReceiptEnvelope: mockHasMatchingStripeEventReceiptEnvelope,
  markMintedCheckoutSessionTerminalByStripeSessionId:
    mockMarkMintedCheckoutSessionTerminalByStripeSessionId,
  markSubscriptionDeletedFromEvent: mockMarkSubscriptionDeletedFromEvent,
  recordStripeEventReceipt: mockRecordStripeEventReceipt,
  syncSubscriptionFromEvent: mockSyncSubscriptionFromEvent,
}));

const mockReconcileStorageTransitionsForUser = jest.fn();
jest.mock('../../../../server/services/storageTransitionService.js', () => ({
  reconcileStorageTransitionsForUser: mockReconcileStorageTransitionsForUser,
}));

const mockVerifyWebhookSignature = jest.fn();
jest.mock('../../../../server/lib/webhookSignature.js', () => ({
  verifyWebhookSignature: mockVerifyWebhookSignature,
}));

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.mock('../../../../shared/logger.js', () => ({
  logger: mockLog,
  attachRequestLogger: jest.fn((req) => {
    req.log = mockLog;
    return 'webhook-dispatcher-route-request-id';
  }),
}));

const webhookRoute = require('../webhook.js');
const handler = webhookRoute.default;

describe('/api/billing/webhook dispatcher route boundary', () => {
  const defaultCreated = 1889308800;

  /**
   * Build a verified Stripe event for route-dispatcher integration tests.
   *
   * Purpose: these tests verify the public route passes a real dispatcher event
   * through to event-specific billing-service calls without using raw payloads.
   *
   * @param {string} type
   * @param {object} object
   * @returns {object}
   */
  function createVerifiedEvent(type, object) {
    return {
      id: `evt_route_${type.replace(/\./g, '_')}`,
      type,
      livemode: false,
      created: defaultCreated,
      data: {
        object,
      },
    };
  }

  /**
   * Create a minimal signed webhook request for the public billing route.
   *
   * Purpose: withWebhookAuth still owns signature-header gating before the
   * mocked verifier returns the already-verified Stripe event.
   *
   * @returns {object}
   */
  function createMockReq() {
    return {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1889308800,v1=test',
      },
      rawBody: Buffer.from('{"id":"evt_route_boundary"}'),
    };
  }

  /**
   * Create a chainable API response mock for route-boundary assertions.
   *
   * Purpose: tests assert the public response envelope and status code without
   * depending on a real Next.js response instance.
   *
   * @returns {object}
   */
  function createMockRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      end: jest.fn().mockReturnThis(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertStripeLivemode.mockImplementation(() => {});
    mockClaimStripeEventReceiptProcessing.mockResolvedValue({
      outcome: 'recorded',
      receipt: {
        result: 'processing',
      },
    });
    mockGetStripeEventReceiptForEvent.mockResolvedValue(null);
    mockHasMatchingStripeEventReceiptEnvelope.mockReturnValue(true);
    mockMarkMintedCheckoutSessionTerminalByStripeSessionId.mockResolvedValue({
      id: 42,
      status: 'expired',
    });
    mockMarkSubscriptionDeletedFromEvent.mockResolvedValue({ outcome: 'processed' });
    mockRecordStripeEventReceipt.mockResolvedValue({ outcome: 'updated' });
    mockSyncSubscriptionFromEvent.mockResolvedValue({ outcome: 'processed' });
    mockReconcileStorageTransitionsForUser.mockResolvedValue({
      data: { outcome: 'skipped', lockedCount: 0 },
      error: null,
    });
  });

  it('calls storage repair after processing customer.subscription.updated', async () => {
    const event = createVerifiedEvent('customer.subscription.updated', {
      id: 'sub_test_route_updated_123',
      customer: 'cus_test_123',
    });
    mockSyncSubscriptionFromEvent.mockResolvedValue({
      outcome: 'processed',
      userId: 'user-123',
    });
    mockVerifyWebhookSignature.mockResolvedValue(event);
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockReconcileStorageTransitionsForUser).toHaveBeenCalledWith(
      'user-123',
      mockLog
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('skips storage repair when dispatch outcome is not processed', async () => {
    const event = createVerifiedEvent('customer.subscription.updated', {
      id: 'sub_test_stale_123',
    });
    mockSyncSubscriptionFromEvent.mockResolvedValue({
      outcome: 'stale_ignored',
    });
    mockVerifyWebhookSignature.mockResolvedValue(event);
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockReconcileStorageTransitionsForUser).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('fails webhook when storage repair returns an error', async () => {
    const event = createVerifiedEvent('customer.subscription.updated', {
      id: 'sub_test_repair_error_123',
    });
    const repairError = new Error('Repair failed');
    mockSyncSubscriptionFromEvent.mockResolvedValue({
      outcome: 'processed',
      userId: 'user-456',
    });
    mockReconcileStorageTransitionsForUser.mockResolvedValue({
      data: null,
      error: repairError,
    });
    mockVerifyWebhookSignature.mockResolvedValue(event);
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockReconcileStorageTransitionsForUser).toHaveBeenCalledWith(
      'user-456',
      mockLog
    );
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'failed', mockLog);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('processes checkout.session.expired through the public route and real dispatcher', async () => {
    const event = createVerifiedEvent('checkout.session.expired', {
      id: 'cs_test_route_expired_123',
    });
    mockVerifyWebhookSignature.mockResolvedValue(event);
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockMarkMintedCheckoutSessionTerminalByStripeSessionId).toHaveBeenCalledWith(
      {
        sessionId: 'cs_test_route_expired_123',
        status: 'expired',
      },
      mockLog
    );
    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'processed', mockLog);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          received: true,
          receiptResult: 'processed',
          duplicate: false,
        },
      })
    );
  });

  it('processes invoice.payment_action_required through the public route and real dispatcher', async () => {
    const event = createVerifiedEvent('invoice.payment_action_required', {
      id: 'in_route_action_required_123',
      parent: {
        subscription_details: {
          subscription: 'sub_route_action_required_123',
        },
      },
    });
    mockVerifyWebhookSignature.mockResolvedValue(event);
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledWith(
      'sub_route_action_required_123',
      defaultCreated,
      mockLog
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'billing_invoice_payment_action_required',
      }),
      'Stripe invoice requires payment action'
    );
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'processed', mockLog);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          received: true,
          receiptResult: 'processed',
          duplicate: false,
        },
      })
    );
  });
});
