const mockGetUserFromRequest = jest.fn();
jest.mock('../../lib/supabaseServer.js', () => ({
  getUserFromRequest: mockGetUserFromRequest,
}));

const mockCheckRateLimit = jest.fn();
jest.mock('../../lib/rateLimit.js', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

const mockValidateCsrfToken = jest.fn();
jest.mock('../../lib/csrf.js', () => ({
  validateCsrfToken: mockValidateCsrfToken,
}));

const mockVerifyWebhookSignature = jest.fn();
jest.mock('../../lib/webhookSignature.js', () => ({
  verifyWebhookSignature: mockVerifyWebhookSignature,
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockRootLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock('../../../shared/logger.js', () => ({
  logger: mockRootLogger,
  attachRequestLogger: jest.fn((req) => {
    req.log = mockLog;
    return 'webhook-request-id';
  }),
}));

const { attachRequestLogger } = require('../../../shared/logger.js');
const { withWebhookAuth } = require('../withWebhookAuth.js');

describe('withWebhookAuth middleware', () => {
  const createMockRequest = (method, headers = {}, extra = {}) => ({
    method,
    headers: {
      'stripe-signature': 't=1713456000,v1=valid-signature',
      ...headers,
    },
    rawBody: Buffer.from('{"id":"evt_123","type":"invoice.payment_succeeded"}'),
    ...extra,
  });

  const createMockResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    end: jest.fn().mockReturnThis(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyWebhookSignature.mockResolvedValue({
      id: 'evt_123',
      type: 'invoice.payment_succeeded',
    });
  });

  it('attaches a request logger to req.log', async () => {
    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn().mockResolvedValue(undefined);

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(req.log).toBe(mockLog);
  });

  it('sets x-request-id response header', async () => {
    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn().mockResolvedValue(undefined);

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'webhook-request-id');
  });

  it('returns 405 for OPTIONS requests', async () => {
    const req = createMockRequest('OPTIONS');
    const res = createMockResponse();
    const handler = jest.fn();

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'METHOD_NOT_ALLOWED' })
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 405 when allowedMethods is omitted', async () => {
    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn();

    await withWebhookAuth(handler)(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 405 when method is not allowed', async () => {
    const req = createMockRequest('GET');
    const res = createMockResponse();
    const handler = jest.fn();

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects requests missing the signature header', async () => {
    const req = createMockRequest('POST', { 'stripe-signature': undefined });
    const res = createMockResponse();
    const handler = jest.fn().mockResolvedValue(undefined);

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'WEBHOOK_SIGNATURE_INVALID' })
    );
    expect(handler).not.toHaveBeenCalled();
    expect(mockVerifyWebhookSignature).not.toHaveBeenCalled();
    expect(mockGetUserFromRequest).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockValidateCsrfToken).not.toHaveBeenCalled();
  });

  it('rejects requests with an invalid signature', async () => {
    mockVerifyWebhookSignature.mockRejectedValueOnce(new Error('Invalid signature'));

    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn().mockResolvedValue(undefined);

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'WEBHOOK_SIGNATURE_INVALID' })
    );
    expect(handler).not.toHaveBeenCalled();
    expect(mockGetUserFromRequest).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockValidateCsrfToken).not.toHaveBeenCalled();
  });

  it('rejects requests with a stale or replayed timestamp', async () => {
    const replayError = new Error('Webhook timestamp outside tolerance');
    replayError.code = 'WEBHOOK_REPLAY_DETECTED';
    mockVerifyWebhookSignature.mockRejectedValueOnce(replayError);

    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn().mockResolvedValue(undefined);

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'WEBHOOK_SIGNATURE_INVALID' })
    );
    expect(handler).not.toHaveBeenCalled();
    expect(mockGetUserFromRequest).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockValidateCsrfToken).not.toHaveBeenCalled();
  });

  it('returns 503 when the webhook verifier is not configured', async () => {
    const misconfiguredVerifierError = new Error('Webhook signature verifier is not configured');
    misconfiguredVerifierError.code = 'WEBHOOK_VERIFIER_NOT_CONFIGURED';
    mockVerifyWebhookSignature.mockRejectedValueOnce(misconfiguredVerifierError);

    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn().mockResolvedValue(undefined);

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'SERVICE_UNAVAILABLE' })
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('calls the handler when method is allowed and the signature is valid', async () => {
    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn().mockResolvedValue('ok');
    const verifiedEvent = {
      id: 'evt_valid',
      type: 'invoice.payment_succeeded',
    };
    mockVerifyWebhookSignature.mockResolvedValueOnce(verifiedEvent);

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(handler).toHaveBeenCalledWith(req, res);
    expect(req.webhookEvent).toEqual(verifiedEvent);
    expect(mockVerifyWebhookSignature).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        signature: 't=1713456000,v1=valid-signature',
        signatureHeader: 'stripe-signature',
      })
    );
  });

  it('returns 500 when the handler throws', async () => {
    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn().mockRejectedValue(new Error('boom'));

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'INTERNAL_SERVER_ERROR' })
    );
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST' }),
      'Unhandled webhook handler error'
    );
  });

  it('falls back to the root logger when req.log is unavailable', async () => {
    attachRequestLogger.mockImplementationOnce(() => 'webhook-request-id');

    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn().mockRejectedValue(new Error('boom'));

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(mockRootLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST' }),
      'Unhandled webhook handler error'
    );
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns 500 if attachRequestLogger throws', async () => {
    attachRequestLogger.mockImplementationOnce(() => {
      throw new Error('logger init failed');
    });

    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn();

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(mockRootLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST' }),
      'Unhandled webhook handler error'
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(handler).not.toHaveBeenCalled();
  });

  it('ends cleanly when headers were already sent before a handler error', async () => {
    const req = createMockRequest('POST');
    const res = createMockResponse();
    res.headersSent = true;
    const handler = jest.fn().mockRejectedValue(new Error('stream failed'));

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });

  it('does not call Supabase auth helpers', async () => {
    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn().mockResolvedValue(undefined);

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(mockGetUserFromRequest).not.toHaveBeenCalled();
  });

  it('does not call Redis rate-limit helpers', async () => {
    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn().mockResolvedValue(undefined);

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('does not call the CSRF validator', async () => {
    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn().mockResolvedValue(undefined);

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(mockValidateCsrfToken).not.toHaveBeenCalled();
  });
});
