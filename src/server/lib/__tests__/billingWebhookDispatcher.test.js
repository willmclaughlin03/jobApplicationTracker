const mockAssertStripeLivemode = jest.fn();
const mockClaimStripeEventReceiptProcessing = jest.fn();
const mockFormatStripeIdForLog = jest.fn((value) => value);
const mockGetStripeEventReceiptForEvent = jest.fn();
const mockHasMatchingStripeEventReceiptEnvelope = jest.fn();
const mockMarkMintedCheckoutSessionTerminalByStripeSessionId = jest.fn();
const mockMarkSubscriptionDeletedFromEvent = jest.fn();
const mockRecordStripeEventReceipt = jest.fn();
const mockReconcileStorageTransitionsForUser = jest.fn();
const mockSyncSubscriptionFromEvent = jest.fn();

jest.mock('../billingService.js', () => ({
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

jest.mock('../../services/storageTransitionService.js', () => ({
  reconcileStorageTransitionsForUser: mockReconcileStorageTransitionsForUser,
}));

const { processBillingWebhookEvent } = require('../billingWebhookDispatcher.js');

describe('billingWebhookDispatcher', () => {
  const mockLog = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  /**
   * Build a signed-and-verified Stripe event fixture for dispatcher tests.
   *
   * Purpose: tests exercise post-verification orchestration only, so the event
   * shape is intentionally minimal and never includes email fields.
   *
   * @param {object} overrides
   * @returns {object}
   */
  function createEvent(overrides = {}) {
    return {
      id: 'evt_webhook_123',
      type: 'invoice.paid',
      livemode: false,
      created: 1889308800,
      data: {
        object: {
          id: 'in_webhook_123',
          parent: {
            subscription_details: {
              subscription: 'sub_webhook_123',
            },
          },
        },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertStripeLivemode.mockImplementation(() => false);
    mockClaimStripeEventReceiptProcessing.mockResolvedValue({
      outcome: 'recorded',
      receipt: {
        result: 'processing',
      },
    });
    mockGetStripeEventReceiptForEvent.mockResolvedValue(null);
    mockHasMatchingStripeEventReceiptEnvelope.mockReturnValue(true);
    mockMarkMintedCheckoutSessionTerminalByStripeSessionId.mockResolvedValue(null);
    mockMarkSubscriptionDeletedFromEvent.mockResolvedValue({ outcome: 'processed' });
    mockRecordStripeEventReceipt.mockResolvedValue({ outcome: 'updated' });
    mockReconcileStorageTransitionsForUser.mockResolvedValue({
      data: { outcome: 'skipped', lockedCount: 0 },
      error: null,
    });
    mockSyncSubscriptionFromEvent.mockResolvedValue({ outcome: 'processed' });
  });

  it('rejects livemode mismatches before receipt pre-read or database work', async () => {
    const livemodeError = new Error('Stripe livemode mismatch');
    livemodeError.code = 'BILLING_LIVEMODE_MISMATCH';
    mockAssertStripeLivemode.mockImplementationOnce(() => {
      throw livemodeError;
    });

    await expect(processBillingWebhookEvent(createEvent({ livemode: true }), mockLog))
      .rejects.toMatchObject({ code: 'BILLING_LIVEMODE_MISMATCH' });

    expect(mockGetStripeEventReceiptForEvent).not.toHaveBeenCalled();
    expect(mockClaimStripeEventReceiptProcessing).not.toHaveBeenCalled();
    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
  });

  it('logs future timestamp rejections from receipt pre-read before claiming processing', async () => {
    const timestampError = new Error('Stripe event receipt timestamp is too far in the future');
    timestampError.code = 'BILLING_EVENT_TIMESTAMP_IN_FUTURE';
    mockGetStripeEventReceiptForEvent.mockRejectedValue(timestampError);

    await expect(processBillingWebhookEvent(createEvent(), mockLog))
      .rejects.toMatchObject({ code: 'BILLING_EVENT_TIMESTAMP_IN_FUTURE' });

    expect(mockClaimStripeEventReceiptProcessing).not.toHaveBeenCalled();
    expect(mockRecordStripeEventReceipt).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: timestampError,
        event: 'billing_webhook_future_timestamp_rejected',
        stripeEvent: expect.objectContaining({
          id: 'evt_webhook_123',
          created: 1889308800,
        }),
      }),
      'Rejected Stripe webhook because the event timestamp is too far in the future'
    );
  });

  it('short-circuits same-envelope processed duplicates before claiming processing', async () => {
    mockGetStripeEventReceiptForEvent.mockResolvedValue({
      eventId: 'evt_webhook_123',
      eventType: 'invoice.paid',
      livemode: false,
      stripeEventCreated: '2029-11-14T00:00:00.000Z',
      result: 'processed',
    });

    const result = await processBillingWebhookEvent(createEvent(), mockLog);

    expect(result).toEqual(expect.objectContaining({
      duplicate: true,
      receiptResult: 'processed',
    }));
    expect(mockClaimStripeEventReceiptProcessing).not.toHaveBeenCalled();
    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
    expect(mockRecordStripeEventReceipt).not.toHaveBeenCalled();
  });

  it('rejects receipt envelope mismatches as integrity failures', async () => {
    mockGetStripeEventReceiptForEvent.mockResolvedValue({
      eventId: 'evt_webhook_123',
      eventType: 'invoice.payment_failed',
      livemode: false,
      stripeEventCreated: '2029-11-14T00:00:00.000Z',
      result: 'failed',
    });
    mockHasMatchingStripeEventReceiptEnvelope.mockReturnValue(false);

    await expect(processBillingWebhookEvent(createEvent(), mockLog))
      .rejects.toMatchObject({ code: 'BILLING_EVENT_RECEIPT_ENVELOPE_MISMATCH' });

    expect(mockClaimStripeEventReceiptProcessing).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'billing_event_receipt_envelope_mismatch',
        stripeEvent: expect.objectContaining({
          created: '2029-11-14T00:00:00.000Z',
        }),
      }),
      'Rejected Stripe webhook because the event receipt envelope mismatched'
    );
  });

  it('normalizes digit-only string created timestamps in receipt mismatch logs', async () => {
    mockGetStripeEventReceiptForEvent.mockResolvedValue({
      eventId: 'evt_webhook_123',
      eventType: 'invoice.payment_failed',
      livemode: false,
      stripeEventCreated: '2029-11-14T00:00:00.000Z',
      result: 'failed',
    });
    mockHasMatchingStripeEventReceiptEnvelope.mockReturnValue(false);

    await expect(processBillingWebhookEvent(createEvent({ created: '1889308800' }), mockLog))
      .rejects.toMatchObject({ code: 'BILLING_EVENT_RECEIPT_ENVELOPE_MISMATCH' });

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'billing_event_receipt_envelope_mismatch',
        stripeEvent: expect.objectContaining({
          created: '2029-11-14T00:00:00.000Z',
        }),
      }),
      'Rejected Stripe webhook because the event receipt envelope mismatched'
    );
  });

  it('claims processing, syncs invoice subscription ids, and records processed', async () => {
    const event = createEvent();

    const result = await processBillingWebhookEvent(event, mockLog);

    expect(mockClaimStripeEventReceiptProcessing).toHaveBeenCalledWith(event, mockLog);
    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledWith(
      'sub_webhook_123',
      1889308800,
      mockLog
    );
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'processed', mockLog);
    expect(result).toEqual(expect.objectContaining({
      duplicate: false,
      receiptResult: 'processed',
    }));
  });

  it('records stale_ignored when the billing service reports a stale event', async () => {
    mockSyncSubscriptionFromEvent.mockResolvedValue({ outcome: 'stale_ignored', userId: 'user_stale_123' });
    const event = createEvent();

    const result = await processBillingWebhookEvent(event, mockLog);

    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'stale_ignored', mockLog);
    expect(mockReconcileStorageTransitionsForUser).not.toHaveBeenCalled();
    expect(result.receiptResult).toBe('stale_ignored');
  });

  it('runs storage transition repair after processed billing syncs with a resolved user', async () => {
    mockSyncSubscriptionFromEvent.mockResolvedValue({
      outcome: 'processed',
      userId: 'user_processed_123',
    });
    const event = createEvent();

    const result = await processBillingWebhookEvent(event, mockLog);

    expect(mockReconcileStorageTransitionsForUser).toHaveBeenCalledWith(
      'user_processed_123',
      mockLog
    );
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'processed', mockLog);
    expect(
      mockReconcileStorageTransitionsForUser.mock.invocationCallOrder[0]
    ).toBeLessThan(mockRecordStripeEventReceipt.mock.invocationCallOrder[0]);
    expect(result.receiptResult).toBe('processed');
  });

  it('records failed and rejects when post-billing storage transition repair fails', async () => {
    const repairError = new Error('overflow lock failed');
    mockSyncSubscriptionFromEvent.mockResolvedValue({
      outcome: 'processed',
      userId: 'user_repair_failed_123',
    });
    mockReconcileStorageTransitionsForUser.mockResolvedValue({
      data: null,
      error: repairError,
    });
    const event = createEvent();

    await expect(processBillingWebhookEvent(event, mockLog)).rejects.toBe(repairError);

    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'failed', mockLog);
  });

  it('safe-ignores invoice events without subscription ids', async () => {
    const event = createEvent({
      data: {
        object: {
          id: 'in_without_subscription',
        },
      },
    });

    const result = await processBillingWebhookEvent(event, mockLog);

    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'processed', mockLog);
    expect(result.receiptResult).toBe('processed');
  });

  it('records failed for malformed required subscription lifecycle events', async () => {
    const event = createEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {},
      },
    });

    await expect(processBillingWebhookEvent(event, mockLog))
      .rejects.toMatchObject({ code: 'BILLING_WEBHOOK_MALFORMED_EVENT' });

    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'failed', mockLog);
  });

  it('dispatches subscription delete events through the delete snapshot helper', async () => {
    const subscription = {
      id: 'sub_deleted_123',
      customer: 'cus_delete_123',
      cancel_at_period_end: true,
    };
    const event = createEvent({
      type: 'customer.subscription.deleted',
      data: {
        object: subscription,
      },
    });

    const result = await processBillingWebhookEvent(event, mockLog);

    expect(mockMarkSubscriptionDeletedFromEvent).toHaveBeenCalledWith(
      subscription,
      {
        eventCreated: 1889308800,
        livemode: false,
      },
      mockLog
    );
    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'processed', mockLog);
    expect(result.receiptResult).toBe('processed');
  });

  it('runs storage transition repair after processed subscription delete events with a resolved user', async () => {
    const subscription = {
      id: 'sub_deleted_repair_123',
      customer: 'cus_delete_repair_123',
      cancel_at_period_end: false,
    };
    mockMarkSubscriptionDeletedFromEvent.mockResolvedValue({
      outcome: 'processed',
      userId: 'user_deleted_repair_123',
    });
    const event = createEvent({
      type: 'customer.subscription.deleted',
      data: {
        object: subscription,
      },
    });

    const result = await processBillingWebhookEvent(event, mockLog);

    expect(mockMarkSubscriptionDeletedFromEvent).toHaveBeenCalledWith(
      subscription,
      {
        eventCreated: 1889308800,
        livemode: false,
      },
      mockLog
    );
    expect(mockReconcileStorageTransitionsForUser).toHaveBeenCalledWith(
      'user_deleted_repair_123',
      mockLog
    );
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'processed', mockLog);
    expect(
      mockReconcileStorageTransitionsForUser.mock.invocationCallOrder[0]
    ).toBeLessThan(mockRecordStripeEventReceipt.mock.invocationCallOrder[0]);
    expect(result.receiptResult).toBe('processed');
  });

  it('records failed for malformed subscription delete events before calling the service', async () => {
    const event = createEvent({
      type: 'customer.subscription.deleted',
      data: {
        object: {
          customer: 'cus_delete_123',
        },
      },
    });

    await expect(processBillingWebhookEvent(event, mockLog))
      .rejects.toMatchObject({ code: 'BILLING_WEBHOOK_MALFORMED_EVENT' });

    expect(mockMarkSubscriptionDeletedFromEvent).not.toHaveBeenCalled();
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'failed', mockLog);
  });

  it('records failed for non-object subscription delete payloads before calling the service', async () => {
    const event = createEvent({
      type: 'customer.subscription.deleted',
      data: {
        object: 'sub_deleted_123',
      },
    });

    await expect(processBillingWebhookEvent(event, mockLog))
      .rejects.toMatchObject({
        code: 'BILLING_WEBHOOK_MALFORMED_EVENT',
        message: 'Stripe subscription delete webhook is missing a subscription object',
      });

    expect(mockMarkSubscriptionDeletedFromEvent).not.toHaveBeenCalled();
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'failed', mockLog);
  });

  it('records processed when the delete helper ignores a non-current subscription', async () => {
    mockMarkSubscriptionDeletedFromEvent.mockResolvedValue({
      outcome: 'processed',
      localSubscription: {
        stripe_subscription_id: 'sub_active_123',
        status: 'active',
      },
    });
    const event = createEvent({
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_old_123',
          customer: 'cus_delete_123',
        },
      },
    });

    const result = await processBillingWebhookEvent(event, mockLog);

    expect(mockMarkSubscriptionDeletedFromEvent).toHaveBeenCalledWith(
      event.data.object,
      {
        eventCreated: 1889308800,
        livemode: false,
      },
      mockLog
    );
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'processed', mockLog);
    expect(result).toEqual(expect.objectContaining({
      outcome: 'processed',
      receiptResult: 'processed',
    }));
  });

  it('terminalizes completed Checkout Sessions after safe handling without a subscription id', async () => {
    const event = createEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_completed_123',
          subscription: null,
        },
      },
    });

    const result = await processBillingWebhookEvent(event, mockLog);

    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
    expect(mockMarkMintedCheckoutSessionTerminalByStripeSessionId).toHaveBeenCalledWith(
      {
        sessionId: 'cs_test_completed_123',
        status: 'complete',
      },
      mockLog
    );
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'processed', mockLog);
    expect(result.receiptResult).toBe('processed');
  });

  it('terminalizes expired Checkout Sessions without syncing entitlement from the row', async () => {
    const event = createEvent({
      type: 'checkout.session.expired',
      data: {
        object: {
          id: 'cs_test_expired_123',
        },
      },
    });

    const result = await processBillingWebhookEvent(event, mockLog);

    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
    expect(mockMarkMintedCheckoutSessionTerminalByStripeSessionId).toHaveBeenCalledWith(
      {
        sessionId: 'cs_test_expired_123',
        status: 'expired',
      },
      mockLog
    );
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'processed', mockLog);
    expect(result).toEqual(expect.objectContaining({
      outcome: 'processed',
      receiptResult: 'processed',
    }));
  });

  it('records failed for malformed checkout session expired events', async () => {
    const event = createEvent({
      type: 'checkout.session.expired',
      data: {
        object: {},
      },
    });

    await expect(processBillingWebhookEvent(event, mockLog))
      .rejects.toMatchObject({ code: 'BILLING_WEBHOOK_MALFORMED_EVENT' });

    expect(mockMarkMintedCheckoutSessionTerminalByStripeSessionId).not.toHaveBeenCalled();
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'failed', mockLog);
  });

  it('monitors payment-action-required invoices through invoice subscription sync', async () => {
    const event = createEvent({
      type: 'invoice.payment_action_required',
    });

    const result = await processBillingWebhookEvent(event, mockLog);

    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledWith(
      'sub_webhook_123',
      1889308800,
      mockLog
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'billing_invoice_payment_action_required',
      }),
      'Stripe invoice requires payment action'
    );
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'processed', mockLog);
    expect(result.receiptResult).toBe('processed');
  });

  it('logs and records unknown event types as processed safe-ignores', async () => {
    const event = createEvent({
      type: 'customer.created',
      data: {
        object: {
          id: 'cus_ignored_123',
        },
      },
    });

    const result = await processBillingWebhookEvent(event, mockLog);

    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'billing_unknown_event_type',
      }),
      'Ignored unsupported Stripe billing webhook event type'
    );
    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(event, 'processed', mockLog);
    expect(result.receiptResult).toBe('processed');
  });

  it('does not mark failed when another invocation is still processing the event', async () => {
    const processingError = new Error('already processing');
    processingError.code = 'BILLING_WEBHOOK_PROCESSING_ACTIVE';
    mockClaimStripeEventReceiptProcessing.mockRejectedValue(processingError);

    await expect(processBillingWebhookEvent(createEvent(), mockLog))
      .rejects.toMatchObject({ code: 'BILLING_WEBHOOK_PROCESSING_ACTIVE' });

    expect(mockRecordStripeEventReceipt).not.toHaveBeenCalled();
    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
  });

  it('preserves the original dispatch error when failed-receipt recording also fails', async () => {
    const originalError = new Error('Stripe fetch failed');
    originalError.code = 'STRIPE_FETCH_FAILED';
    const receiptError = new Error('receipt write failed');
    mockSyncSubscriptionFromEvent.mockRejectedValue(originalError);
    mockRecordStripeEventReceipt.mockRejectedValue(receiptError);

    await expect(processBillingWebhookEvent(createEvent(), mockLog))
      .rejects.toMatchObject({ code: 'STRIPE_FETCH_FAILED' });

    expect(mockRecordStripeEventReceipt).toHaveBeenCalledWith(
      expect.any(Object),
      'failed',
      mockLog
    );
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        originalErrorCode: 'STRIPE_FETCH_FAILED',
      }),
      'Failed to record failed Stripe webhook receipt after dispatcher error'
    );
  });
});
