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
    expect(mockLog.info).not.toHaveBeenCalled();
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

  /**
   * Test: Redis client exists but ping() rejects
   * Why it matters: This is the most likely real failure mode — the client
   * initialized on cold start, then a transient network blip or Upstash
   * outage causes ping() to throw. The previous coverage only exercised
   * the null-client branch.
   */
  it('returns 503 degraded when Redis ping() throws', async () => {
    mockGetRedisClient.mockReturnValue({
      ping: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
    });
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

  /**
   * Test: Redis returns non-PONG response
   * Edge case: Upstash responding with an unexpected payload (e.g. corrupted
   * response) must be treated as unhealthy rather than falsely reported ok.
   */
  it('returns 503 degraded when Redis ping() returns non-PONG', async () => {
    mockGetRedisClient.mockReturnValue({
      ping: jest.fn().mockResolvedValue('NOT_PONG'),
    });
    const req = { method: 'GET', headers: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        checks: { redis: 'fail', supabase: 'ok' },
      })
    );
  });

  /**
   * Test: Redis ping never resolves → handler enforces HEALTH_CHECK_TIMEOUT_MS
   * Prevents: Hanging uptime probes if Upstash becomes non-responsive.
   * Uses fake timers so we don't actually wait 3 seconds.
   */
  it('returns 503 degraded when Redis ping exceeds the health check timeout', async () => {
    jest.useFakeTimers();
    try {
      mockGetRedisClient.mockReturnValue({
        ping: jest.fn(() => new Promise(() => { /* never resolves */ })),
      });
      const req = { method: 'GET', headers: {} };
      const res = createMockRes();

      const handlerPromise = handler(req, res);
      // Advance past HEALTH_CHECK_TIMEOUT_MS (3000ms)
      await jest.advanceTimersByTimeAsync(3100);
      await handlerPromise;

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          checks: { redis: 'fail', supabase: 'ok' },
        })
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
