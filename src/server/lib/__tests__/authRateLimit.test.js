import RedisMock from 'ioredis-mock';
import { createAuthRateLimiter } from '../authRateLimit.js';
import { AUTH_RATE_LIMIT_OPERATIONS, AUTH_RATE_LIMIT_TIERS, getAuthRateLimitPolicy } from '../authRateLimitPolicy.js';
import { createTemporarySessionSecrets } from '../temporarySessionSecrets.js';

const user = { id: '9e798a6c-3a93-4c15-bc6a-6dbf76f47a40', email: null, role: 'user' };
const pair = Object.freeze({
  hmac: Object.freeze({ schemaVersion: 1, active: Object.freeze({
    generation: 1, keyId: 'synthetic', key: Buffer.alloc(32, 7).toString('base64url'),
  }), previous: null }),
  redis: Object.freeze({ schemaVersion: 1, url: 'https://synthetic.upstash.io', token: 'synthetic-token' }),
  cacheIdentity: Object.freeze({}),
});

/** Supplies only synthetic request/identity data for one canonical operation. */
function input(operation = 'PRE_AUTH', tier = 'free') {
  return {
    operation, tier, req: { socket: { remoteAddress: '192.0.2.10' } },
    ...(operation === 'AUTH_SESSION' ? { authenticatedUser: user } : {}),
    ...(operation === 'AUTH_LOGOUT' ? { localCleanupAccepted: true } : {}),
  };
}
/** Produces a valid first-charge tuple for dependency-boundary tests only. */
function allowed(operation) {
  const policy = getAuthRateLimitPolicy(operation, 'free');
  return [1, 0, 0, policy.hourly - 1, policy.daily - 1, 3600, 86400, 0];
}
/** Creates observable mocked dependencies around the actual evaluator. */
function fixture(overrides = {}) {
  const redis = { evalsha: jest.fn(async (_sha, _keys, args) => allowed(args[0])), eval: jest.fn() };
  const getRuntimePair = jest.fn().mockResolvedValue(pair);
  const createClient = jest.fn().mockReturnValue(redis);
  const evaluate = createAuthRateLimiter({
    mode: 'local', env: { NODE_ENV: 'test' }, now: () => Date.now(),
    getRuntimePair, createClient, ...overrides,
  });
  return { evaluate, getRuntimePair, createClient, redis };
}

/** Tests total-deadline behavior and ordering without any route or provider calls. */
describe('authRateLimit', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it.each(AUTH_RATE_LIMIT_OPERATIONS)('evaluates explicit policies across all tiers: %s', async (operation) => {
    const f = fixture();
    const keys = [];
    for (const tier of AUTH_RATE_LIMIT_TIERS) {
      const result = await f.evaluate(input(operation, tier));
      expect(result.status).toBe('allowed');
      expect(result.hourly.limit).toBe(getAuthRateLimitPolicy(operation, tier).hourly);
      keys.push(f.redis.evalsha.mock.calls.at(-1)[1][0]);
      expect(Object.isFrozen(result)).toBe(true);
    }
    expect(new Set(keys).size).toBe(1);
    expect(f.createClient.mock.calls[0][0]).toBe(pair);
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each([
    null, {}, { ...input(), tier: null }, { ...input(), operation: 'AUTH' },
    { ...input(), extra: 'secret-sentinel' }, { ...input(), req: {} },
    { ...input('AUTH_SESSION'), authenticatedUser: undefined },
    { ...input('AUTH_SESSION'), authenticatedUser: { id: user.id } },
  ])('rejects invalid input before any dependency work', async (value) => {
    const f = fixture();
    expect(await f.evaluate(value)).toEqual({ status: 'unavailable' });
    expect(f.getRuntimePair).not.toHaveBeenCalled();
    expect(f.createClient).not.toHaveBeenCalled();
  });
  it('requires accepted logout cleanup before even source resolution', async () => {
    const f = fixture();
    const getter = jest.fn(() => { throw new Error('source should not be inspected'); });
    const req = Object.defineProperty({}, 'socket', { get: getter });
    expect(await f.evaluate({ ...input('AUTH_LOGOUT'), req, localCleanupAccepted: false })).toEqual({ status: 'unavailable' });
    expect(getter).not.toHaveBeenCalled();
    expect(f.getRuntimePair).not.toHaveBeenCalled();
  });
  it.each([
    { NODE_ENV: 'production' },
    { NODE_ENV: 'production', VERCEL: '1', TEMPORARY_SESSION_CEILING_SOURCE_MODE: 'vercel', TEMPORARY_SESSION_CEILING_SECRET_MODE: 'local' },
    { NODE_ENV: 'test', VERCEL: '1' },
  ])('fails closed for missing or contradictory deployment mode', async (env) => {
    const f = fixture({ mode: undefined, env });
    expect(await f.evaluate(input())).toEqual({ status: 'unavailable' });
    expect(f.getRuntimePair).not.toHaveBeenCalled();
  });
  it.each([
    { headers: { 'x-vercel-forwarded-for': '192.0.2.10' } },
    { rawHeaders: ['x-vercel-forwarded-for', '192.0.2.10', 'X-Vercel-Forwarded-For', '192.0.2.10'], headers: { 'x-vercel-forwarded-for': '192.0.2.10' } },
    { rawHeaders: ['x-vercel-forwarded-for', '192.0.2.10'], headers: { 'x-vercel-forwarded-for': '192.0.2.11' } },
    { rawHeaders: ['x-vercel-forwarded-for', '192.0.2.10'], headers: { 'x-vercel-forwarded-for': ['192.0.2.10'] } },
    ...['192.0.2.10,192.0.2.11', ' 192.0.2.10', '192.0.2.10:80'].map((value) => ({
      rawHeaders: ['x-vercel-forwarded-for', value], headers: { 'x-vercel-forwarded-for': value },
    })),
  ])('rejects ambiguous deployed source without a socket fallback', async (req) => {
    const f = fixture({ mode: 'vercel', env: { NODE_ENV: 'production', VERCEL: '1' } });
    expect(await f.evaluate({ ...input(), req: { ...req, socket: { remoteAddress: '192.0.2.10' } } })).toEqual({ status: 'unavailable' });
    expect(f.getRuntimePair).not.toHaveBeenCalled();
  });
  it('accepts only the explicit singleton deployed source and ignores local forwarding headers', async () => {
    const req = { rawHeaders: ['X-Vercel-Forwarded-For', '192.0.2.10'], headers: { 'x-vercel-forwarded-for': '192.0.2.10' } };
    const deployed = fixture({ mode: 'vercel', env: { NODE_ENV: 'production', VERCEL: '1' } });
    expect((await deployed.evaluate({ ...input(), req })).status).toBe('allowed');
    const local = fixture();
    await local.evaluate({ ...input(), req: { ...input().req, headers: { 'x-forwarded-for': '192.0.2.99' } } });
    expect(local.redis.evalsha.mock.calls[0][1]).toEqual(deployed.redis.evalsha.mock.calls[0][1]);
  });
  it('returns denial metadata and the later reset as a bounded integer Retry-After', async () => {
    const f = fixture();
    f.redis.evalsha.mockResolvedValue([1, 1, 0, 0, 0, 3600, 86400, 86400]);
    expect(await f.evaluate(input('AUTH_FAILURE'))).toEqual({
      status: 'rate_limited', retryAfterSeconds: 86400,
      hourly: { limit: 15, remaining: 0, resetAtSeconds: 3600 },
      daily: { limit: 30, remaining: 0, resetAtSeconds: 86400 },
    });
  });
  it('rejects rotating keys before client construction', async () => {
    const f = fixture();
    f.getRuntimePair.mockResolvedValue({ ...pair, hmac: { ...pair.hmac,
      active: { ...pair.hmac.active, generation: 2 },
      previous: { ...pair.hmac.active, keyId: 'previous', key: Buffer.alloc(32, 9).toString('base64url') },
    } });
    expect(await f.evaluate(input())).toEqual({ status: 'unavailable' });
    expect(f.createClient).not.toHaveBeenCalled();
  });
  it.each(['configuration', 'client', 'redis', 'output'])('sanitizes %s failure without logging or retry headers', async (stage) => {
    const spies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
    const f = fixture();
    const error = new Error(`raw-private ${user.id} 192.0.2.10 ${pair.redis.token}`);
    if (stage === 'configuration') f.getRuntimePair.mockRejectedValue(error);
    if (stage === 'client') f.createClient.mockImplementation(() => { throw error; });
    if (stage === 'redis') f.redis.evalsha.mockRejectedValue(error);
    if (stage === 'output') f.redis.evalsha.mockResolvedValue({ raw: error.message });
    expect(await f.evaluate(input())).toEqual({ status: 'unavailable' });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(f.redis.eval).not.toHaveBeenCalled();
  });
  it('bounds a stalled loader and never advances after its late completion', async () => {
    let release;
    const f = fixture({ getRuntimePair: () => new Promise((resolve) => { release = resolve; }) });
    const pending = f.evaluate(input());
    await jest.advanceTimersByTimeAsync(1500);
    expect(await pending).toEqual({ status: 'unavailable' });
    release(pair);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.createClient).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('shares one total deadline across configuration, client, and Redis', async () => {
    const f = fixture();
    f.getRuntimePair.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(pair), 1000)));
    f.redis.evalsha.mockImplementation(() => new Promise(() => {}));
    const pending = f.evaluate(input());
    await jest.advanceTimersByTimeAsync(1499);
    expect(f.redis.evalsha).toHaveBeenCalledTimes(1);
    expect(f.createClient.mock.calls[0][1].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: 'unavailable' });
    expect(f.createClient.mock.calls[0][1].signal.aborted).toBe(true);
    expect(f.redis.eval).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('never sends Redis work after asynchronous client construction finishes late', async () => {
    let release;
    const f = fixture();
    f.createClient.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.evaluate(input());
    await jest.advanceTimersByTimeAsync(1500);
    expect(await pending).toEqual({ status: 'unavailable' });
    release(f.redis);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.redis.evalsha).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('cancels in-flight Redis, ignores its late result, and removes the caller listener', async () => {
    let release;
    const f = fixture();
    f.redis.evalsha.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const pending = f.evaluate(input(), { signal: controller.signal });
    await jest.advanceTimersByTimeAsync(0);
    controller.abort('raw-private-reason');
    expect(await pending).toEqual({ status: 'unavailable' });
    release(allowed('PRE_AUTH'));
    await jest.advanceTimersByTimeAsync(0);
    expect(f.redis.evalsha).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('does not start dependencies for pre-aborted or malformed signals', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    for (const signal of [controller.signal, 'invalid', {}]) {
      expect(await f.evaluate(input(), { signal })).toEqual({ status: 'unavailable' });
    }
    expect(f.getRuntimePair).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1501, Infinity, 1.5])('rejects invalid timeout %p', async (timeoutMs) => {
    const f = fixture({ timeoutMs });
    expect(await f.evaluate(input())).toEqual({ status: 'unavailable' });
    expect(f.getRuntimePair).not.toHaveBeenCalled();
  });
  it('executes evaluator + actual SDK + production Lua using a synthetic secret loader', async () => {
    const redis = new RedisMock({ host: 'auth-limiter-pipeline-unit', port: 8001 });
    const loader = createTemporarySessionSecrets({ mode: 'local', env: { NODE_ENV: 'test' },
      localHmacSecret: pair.hmac, localRedisSecret: pair.redis });
    const originalFetch = global.fetch;
    /** Bridges actual SDK command serialization to in-memory Lua, without HTTP. */
    global.fetch = jest.fn(async (_url, options) => {
      const [command, ...args] = JSON.parse(options.body);
      if (command === 'evalsha') return new Response(JSON.stringify({ error: 'NOSCRIPT No matching script. Please use EVAL.' }));
      if (command !== 'eval') throw new Error('unexpected command');
      return new Response(JSON.stringify({ result: await redis.eval(...args) }));
    });
    try {
      const evaluate = createAuthRateLimiter({ mode: 'local', env: { NODE_ENV: 'test' },
        getRuntimePair: loader.getRuntimePair, now: () => Date.now() });
      const results = await Promise.all(Array.from({ length: 16 }, () => evaluate(input('AUTH_FAILURE'))));
      expect(results.filter((result) => result.status === 'allowed')).toHaveLength(15);
      expect(results.filter((result) => result.status === 'rate_limited')).toHaveLength(1);
      expect(await redis.keys('*')).toHaveLength(1);
      expect(global.fetch).toHaveBeenCalledTimes(32);
    } finally { global.fetch = originalFetch; }
  });
});
