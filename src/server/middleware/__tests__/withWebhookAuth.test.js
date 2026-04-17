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

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../shared/logger.js', () => ({
  attachRequestLogger: jest.fn((req) => {
    req.log = mockLog;
    return 'webhook-request-id';
  }),
}));

const { withWebhookAuth } = require('../withWebhookAuth.js');

describe('withWebhookAuth middleware', () => {
  const createMockRequest = (method) => ({
    method,
    headers: {},
  });

  const createMockResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    end: jest.fn().mockReturnThis(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
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

  it('calls the handler when method is allowed', async () => {
    const req = createMockRequest('POST');
    const res = createMockResponse();
    const handler = jest.fn().mockResolvedValue('ok');

    await withWebhookAuth(handler, { allowedMethods: ['POST'] })(req, res);

    expect(handler).toHaveBeenCalledWith(req, res);
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
