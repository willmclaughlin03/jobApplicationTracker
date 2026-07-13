const mockProcessBillingWebhookEvent = jest.fn();
jest.mock('../../../../server/lib/billingWebhookDispatcher.js', () => ({
  processBillingWebhookEvent: mockProcessBillingWebhookEvent,
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
    return 'webhook-route-request-id';
  }),
}));

const webhookRoute = require('../../../../pages/api/billing/webhook.js');
const handler = webhookRoute.default;

describe('/api/billing/webhook route', () => {
  const verifiedEvent = {
    id: 'evt_route_123',
    type: 'invoice.paid',
    livemode: false,
    created: 1889308800,
    data: {
      object: {
        id: 'in_route_123',
      },
    },
  };

  /**
   * Create a minimal Next.js API request for webhook route tests.
   *
   * Purpose: tests exercise the real withWebhookAuth wrapper, so request
   * fixtures include rawBody and signature headers instead of parsed req.body.
   *
   * @param {object} overrides
   * @returns {object}
   */
  function createMockReq(overrides = {}) {
    return {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1889308800,v1=test',
      },
      rawBody: Buffer.from('{"id":"evt_route_123"}'),
      ...overrides,
    };
  }

  /**
   * Create a chainable API response mock.
   *
   * Purpose: keep assertions focused on status and JSON response contracts.
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
    mockVerifyWebhookSignature.mockResolvedValue(verifiedEvent);
    mockProcessBillingWebhookEvent.mockResolvedValue({
      receiptResult: 'processed',
      duplicate: false,
    });
  });

  it('exports the raw-body webhook route contract', () => {
    expect(webhookRoute.config).toEqual({
      api: {
        bodyParser: false,
      },
    });
    expect(typeof handler).toBe('function');
  });

  it('rejects non-POST methods through the real webhook middleware wrapper', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(mockVerifyWebhookSignature).not.toHaveBeenCalled();
    expect(mockProcessBillingWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects missing Stripe signatures before dispatcher work', async () => {
    const req = createMockReq({
      headers: {
        'stripe-signature': undefined,
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'WEBHOOK_SIGNATURE_INVALID' })
    );
    expect(mockVerifyWebhookSignature).not.toHaveBeenCalled();
    expect(mockProcessBillingWebhookEvent).not.toHaveBeenCalled();
  });

  it('verifies the signature, dispatches the verified event, and returns 200', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(mockVerifyWebhookSignature).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        signature: 't=1889308800,v1=test',
      })
    );
    expect(mockProcessBillingWebhookEvent).toHaveBeenCalledWith(verifiedEvent, mockLog);
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

  it('lets the webhook middleware turn dispatcher failures into 500 responses', async () => {
    mockProcessBillingWebhookEvent.mockRejectedValue(new Error('dispatch failed'));
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'INTERNAL_SERVER_ERROR' })
    );
  });
});
