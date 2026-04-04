/**
 * Tests for health.js API handler (/api/health)
 *
 * Purpose: Verify health check endpoint returns correct status for Redis and Supabase
 * Connects to: pages/api/health.js
 *
 * Note: This endpoint intentionally skips withRateLimit for uptime monitor access.
 */

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(),
};

jest.mock('../../../shared/logger.js', () => ({
  attachRequestLogger: jest.fn((req) => {
    req.log = mockLog;
    return 'test-request-id';
  }),
  logger: { child: jest.fn(() => mockLog) },
}));

const mockGetRedisClient = jest.fn();
jest.mock('../../../server/lib/redis.js', () => ({
  getRedisClient: mockGetRedisClient,
}));

const mockSelect = jest.fn();
const mockLimit = jest.fn();
const mockFrom = jest.fn(() => ({ select: mockSelect }));

jest.mock('../../../server/lib/supabaseServer.js', () => ({
  supabaseAdmin: { from: mockFrom },
}));

const handler = require('../health.js').default;

function createMockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSelect.mockReturnValue({ limit: mockLimit });
  mockLimit.mockResolvedValue({ error: null });
  mockGetRedisClient.mockReturnValue({ ping: jest.fn().mockResolvedValue('PONG') });
});

describe('/api/health', () => {
  it('returns 200 with status ok when both services are healthy', async () => {
    const req = { method: 'GET', headers: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        checks: { redis: 'ok', supabase: 'ok' },
      })
    );
    expect(mockLog.info).toHaveBeenCalledWith({ status: 'ok' }, 'Health check passed');
  });

  it('returns 503 with status degraded when Redis is down', async () => {
    mockGetRedisClient.mockReturnValue(null);
    const req = { method: 'GET', headers: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'degraded',
        checks: { redis: 'fail', supabase: 'ok' },
      })
    );
    expect(mockLog.warn).toHaveBeenCalled();
  });

  it('returns 503 with status degraded when Supabase is down', async () => {
    mockLimit.mockResolvedValue({ error: { message: 'connection refused' } });
    const req = { method: 'GET', headers: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'degraded',
        checks: { redis: 'ok', supabase: 'fail' },
      })
    );
  });

  it('returns 503 with status degraded when both services are down', async () => {
    mockGetRedisClient.mockReturnValue(null);
    mockLimit.mockResolvedValue({ error: { message: 'connection refused' } });
    const req = { method: 'GET', headers: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'degraded',
        checks: { redis: 'fail', supabase: 'fail' },
      })
    );
  });

  it('returns 405 for non-GET methods', async () => {
    const req = { method: 'POST', headers: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('sets x-request-id header on response', async () => {
    const req = { method: 'GET', headers: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'test-request-id');
  });

  it('returns degraded when Supabase times out', async () => {
    mockLimit.mockRejectedValue(new Error('Supabase health check timeout'));
    const req = { method: 'GET', headers: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'degraded',
        checks: { redis: 'ok', supabase: 'fail' },
      })
    );
  });

  it('includes a timestamp in the response', async () => {
    const req = { method: 'GET', headers: {} };
    const res = createMockRes();

    await handler(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.timestamp).toBeDefined();
    expect(new Date(body.timestamp).getTime()).not.toBeNaN();
  });
});
