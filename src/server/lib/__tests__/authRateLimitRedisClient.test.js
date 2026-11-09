import {
  AUTH_RATE_LIMIT_NOSCRIPT, createAuthRateLimitRedisClient, withinAuthRateLimitDeadline,
} from '../authRateLimitRedisClient.js';

const runtimePair = { redis: { schemaVersion: 1, url: 'https://synthetic.upstash.io', token: 'synthetic-token' } };

/** Exercises the actual locked SDK with fetch stubbed; no HTTP is sent. */
describe('authRateLimitRedisClient', () => {
  const originalFetch = global.fetch;
  beforeEach(() => { global.fetch = jest.fn(); });
  afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });

  it.each(['evalsha', 'eval'])('makes exactly one fetch on uncertain %s failure', async (method) => {
    global.fetch.mockRejectedValue(new Error('lost response secret-sentinel'));
    const client = createAuthRateLimitRedisClient(runtimePair, { signal: new AbortController().signal });
    await expect(client[method]('synthetic-script', ['synthetic-key'], ['PRE_AUTH']))
      .rejects.toThrow('auth rate limit unavailable');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([200, 400, 503])('does not retry an HTTP %s error and strips provider details', async (status) => {
    global.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'ERR raw-secret' }), { status }));
    const client = createAuthRateLimitRedisClient(runtimePair, { signal: new AbortController().signal });
    await expect(client.evalsha('sha', ['private-key'], [])).rejects.toMatchObject({ message: 'auth rate limit unavailable' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('classifies only an exact server NOSCRIPT at the cached command boundary', async () => {
    global.fetch.mockImplementation(async () => new Response(JSON.stringify({ error: 'NOSCRIPT No matching script. Please use EVAL.' })));
    const client = createAuthRateLimitRedisClient(runtimePair, { signal: new AbortController().signal });
    await expect(client.evalsha('sha', [], [])).rejects.toBe(AUTH_RATE_LIMIT_NOSCRIPT);
    await expect(client.eval('script', [], [])).rejects.toThrow('auth rate limit unavailable');
  });
  it.each(['prefix NOSCRIPT', 'NOSCRIPTED', 'Command failed: NOSCRIPT missing'])('rejects inexact server code %s', async (error) => {
    global.fetch.mockResolvedValue(new Response(JSON.stringify({ error })));
    const client = createAuthRateLimitRedisClient(runtimePair, { signal: new AbortController().signal });
    await expect(client.evalsha('sha', [], [])).rejects.toThrow('auth rate limit unavailable');
  });
  it('never treats an ordinary transport error containing NOSCRIPT as a fallback', async () => {
    global.fetch.mockRejectedValue(new Error('NOSCRIPT transport-sentinel'));
    const client = createAuthRateLimitRedisClient(runtimePair, { signal: new AbortController().signal });
    await expect(client.evalsha('sha', [], [])).rejects.toThrow('auth rate limit unavailable');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('passes the request abort signal and rejects late SDK completion', async () => {
    const controller = new AbortController();
    let release;
    global.fetch.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const client = createAuthRateLimitRedisClient(runtimePair, { signal: controller.signal });
    const result = client.evalsha('sha', [], []);
    expect(global.fetch.mock.calls[0][1].signal).toBe(controller.signal);
    controller.abort('private-reason');
    release(new Response(JSON.stringify({ result: [1, 0] })));
    await expect(result).rejects.toThrow('auth rate limit unavailable');
    await expect(client.evalsha('sha', [], [])).rejects.toThrow('auth rate limit unavailable');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([null, { redis: { ...runtimePair.redis, url: 'http://localhost' } }, { redis: { ...runtimePair.redis, token: '' } }])(
    'rejects invalid credentials before fetch', (pair) => {
      expect(() => createAuthRateLimitRedisClient(pair, { signal: new AbortController().signal }))
        .toThrow('auth rate limit unavailable');
      expect(global.fetch).not.toHaveBeenCalled();
    }
  );
  it('does not start work at or after the absolute deadline', async () => {
    const start = jest.fn();
    await expect(withinAuthRateLimitDeadline(start, {
      signal: new AbortController().signal, deadlineAt: 1500, now: () => 1500,
    })).rejects.toThrow('auth rate limit unavailable');
    expect(start).not.toHaveBeenCalled();
  });
  it('cleans timers/listeners on successful and cancelled stages', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const context = { signal: controller.signal, deadlineAt: 1500, now: () => Date.now() };
    await expect(withinAuthRateLimitDeadline(() => 7, context)).resolves.toBe(7);
    const pending = withinAuthRateLimitDeadline(() => new Promise(() => {}), context);
    const rejected = expect(pending).rejects.toThrow('auth rate limit unavailable');
    controller.abort();
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
