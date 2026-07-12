/**
 * Tests for health.js API handler (/api/health)
 *
 * Purpose: Verify health check endpoint returns correct status for Redis and Supabase
 * Connects to: pages/api/health.js
 *
 * The endpoint is wrapped with withRateLimit (OPERATIONS.HEALTH, 60 req/hour per IP).
 * withRateLimit is mocked here to pass through to the handler so tests focus on
 * health-check logic. Middleware behavior is tested separately.
 */

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(),
};

// Mock withRateLimit to pass through — attaches req.log like the real middleware does
jest.mock('../../../server/middleware/withRateLimit.js', () => ({
  withRateLimit: (handler) => async (req, res) => {
    req.log = mockLog;
    res.setHeader('x-request-id', 'test-request-id');
    return handler(req, res);
  },
}));

const mockGetRedisClient = jest.fn();
jest.mock('../../../server/lib/redis.js', () => ({
  getRedisClient: mockGetRedisClient,
}));

const mockMaybeSingle = jest.fn();
const mockLimit = jest.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = jest.fn(() => ({ limit: mockLimit }));
const mockFrom = jest.fn(() => ({ select: mockSelect }));

jest.mock('../../../server/lib/supabaseServer.js', () => ({
  supabaseAdmin: { from: mockFrom },
}));

const handler = require('../../../pages/api/health.js').default;

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
  mockMaybeSingle.mockResolvedValue({ error: null });
  mockGetRedisClient.mockReturnValue({ ping: jest.fn().mockResolvedValue('PONG') });
});

describe('/api/health', () => {
  /**
   * Test: Successful early service settlements clear both timeout guards.
   * Why it matters: Normal healthy probes must not retain referenced timers
   * after the handler has already returned its response.
   */
  it('clears timeout guards after successful early settlement', async () => {
    jest.useFakeTimers();
    try {
      const req = { method: 'GET', headers: {} };
      const res = createMockRes();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * Test: Failed early service settlements clear both timeout guards.
   * Why it matters: Rejected dependencies must degrade health without leaving
   * their losing timeout promises scheduled in the Node event loop.
   */
  it('clears timeout guards after failed early settlement', async () => {
    jest.useFakeTimers();
    try {
      mockGetRedisClient.mockReturnValue({
        ping: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
      });
      mockMaybeSingle.mockRejectedValue(new Error('connection refused'));
      const req = { method: 'GET', headers: {} };
      const res = createMockRes();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

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

  it('queries Supabase with select/limit/maybeSingle (not count: exact)', async () => {
    const req = { method: 'GET', headers: {} };
    const res = createMockRes();

    await handler(req, res);

    expect(mockFrom).toHaveBeenCalledWith('jobs');
    expect(mockSelect).toHaveBeenCalledWith('id');
    expect(mockLimit).toHaveBeenCalledWith(1);
    expect(mockMaybeSingle).toHaveBeenCalled();
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
    mockMaybeSingle.mockResolvedValue({ error: { message: 'connection refused' } });
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
    mockMaybeSingle.mockResolvedValue({ error: { message: 'connection refused' } });
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

  it('returns degraded when Supabase times out', async () => {
    mockMaybeSingle.mockRejectedValue(new Error('Supabase health check timeout'));
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
   * Why it matters: Most likely real failure mode — client initialized on
   * cold start, then transient network blip causes ping() to throw.
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
   * Edge case: Unexpected payload must be treated as unhealthy.
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
   * Test: Redis ping never resolves — handler enforces HEALTH_CHECK_TIMEOUT_MS
   * Prevents hanging uptime probes if Upstash becomes non-responsive.
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
      await jest.advanceTimersByTimeAsync(2999);
      expect(res.status).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await handlerPromise;

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          checks: { redis: 'fail', supabase: 'ok' },
        })
      );
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
