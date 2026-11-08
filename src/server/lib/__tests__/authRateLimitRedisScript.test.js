import RedisMock from 'ioredis-mock';
import { AUTH_RATE_LIMIT_OPERATIONS, getAuthRateLimitPolicy } from '../authRateLimitPolicy.js';
import {
  AUTH_RATE_LIMIT_REDIS_SCRIPT, AUTH_RATE_LIMIT_REDIS_SCRIPT_SHA,
  executeAuthRateLimitRedisScript, parseAuthRateLimitRedisResult,
} from '../authRateLimitRedisScript.js';
import { AUTH_RATE_LIMIT_NOSCRIPT, createAuthRateLimitRedisClient } from '../authRateLimitRedisClient.js';

let sequence = 0;
/** Executes production Lua in isolated in-memory Redis; no JS quota substitute. */
function harness({ failWrite = false } = {}) {
  sequence += 1;
  const redis = new RedisMock({ host: 'auth-limiter-unit', port: 9000 + sequence });
  // ioredis-mock rounds epoch seconds and takes microseconds from unrelated hrtime.
  // Replace only that command's clock input; execute the production Lua unchanged.
  redis.defineCommand('decideAtTime', { numberOfKeys: 1, lua: `
local original_call = redis.call
local clock = {ARGV[2], ARGV[3]}
ARGV = {ARGV[1]}
redis.call = function(command, ...)
  if command == 'TIME' then return clock end
  ${failWrite ? "if command == 'SET' then error('synthetic write failure') end" : ''}
  return original_call(command, ...)
end
${AUTH_RATE_LIMIT_REDIS_SCRIPT}` });
  /** Supplies coherent Redis TIME fields to the actual Lua at the fake wall clock. */
  redis.decide = (redisKey, operation) => redis.decideAtTime(
    redisKey, operation, String(Math.floor(Date.now() / 1000)), String((Date.now() % 1000) * 1000)
  );
  return redis;
}
/** Creates an internal synthetic key satisfying the production namespace contract. */
function key(operation = 'AUTH_FAILURE') { return `arl:v1:${operation}:${'a'.repeat(43)}`; }
/** Seeds a valid state so exact large policy boundaries can be tested without load. */
async function seed(redis, operation, { hour = 0, hc = 1, day = 0, dc = hc, ttl = 86400000 } = {}) {
  const policy = getAuthRateLimitPolicy(operation, 'free');
  await redis.set(key(operation), `1:${policy.hourly}:${policy.daily}:${hour}:${hc}:${day}:${dc}`, 'PX', ttl);
}
/** Supplies the shared monotonic clock/deadline context for wrapper tests. */
function context() { return { signal: new AbortController().signal, deadlineAt: 1500, now: () => Date.now() }; }

/** Tests actual Lua transitions, strict output parsing, and bounded fallback. */
describe('authRateLimitRedisScript', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); });
  afterEach(() => { jest.useRealTimers(); });

  it.each(AUTH_RATE_LIMIT_OPERATIONS)('allows the last hourly request then rejects without any write: %s', async (operation) => {
    const redis = harness();
    const policy = getAuthRateLimitPolicy(operation, 'free');
    await seed(redis, operation, { hc: policy.hourly - 1 });
    const last = await redis.decide(key(operation), operation);
    expect(parseAuthRateLimitRedisResult(last, operation).status).toBe('allowed');
    const state = await redis.get(key(operation));
    const ttl = await redis.pttl(key(operation));
    const denied = parseAuthRateLimitRedisResult(await redis.decide(key(operation), operation), operation);
    expect(denied.status).toBe('rate_limited');
    expect(denied.hourly.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBe(3600);
    expect(await redis.get(key(operation))).toBe(state);
    expect(await redis.pttl(key(operation))).toBe(ttl);
  });
  it.each(AUTH_RATE_LIMIT_OPERATIONS)('allows the last daily request then leaves hourly untouched: %s', async (operation) => {
    const redis = harness();
    const policy = getAuthRateLimitPolicy(operation, 'free');
    await seed(redis, operation, { hc: 1, dc: policy.daily - 1 });
    expect(parseAuthRateLimitRedisResult(await redis.decide(key(operation), operation), operation).status).toBe('allowed');
    const state = await redis.get(key(operation));
    const denied = parseAuthRateLimitRedisResult(await redis.decide(key(operation), operation), operation);
    expect(denied.daily.remaining).toBe(0);
    expect(denied.hourly.remaining).toBe(policy.hourly - 2);
    expect(denied.retryAfterSeconds).toBe(86400);
    expect(await redis.get(key(operation))).toBe(state);
  });
  it('uses the later reset when both windows are exhausted', async () => {
    const redis = harness();
    await seed(redis, 'AUTH_FAILURE', { hc: 15, dc: 30 });
    expect(await redis.decide(key(), 'AUTH_FAILURE')).toEqual([1, 1, 0, 0, 0, 3600, 86400, 86400]);
  });
  it('rolls the hour exactly at its aligned boundary while retaining daily count', async () => {
    const redis = harness();
    await seed(redis, 'AUTH_FAILURE', { hc: 15, dc: 20 });
    jest.setSystemTime(3599999);
    expect((await redis.decide(key(), 'AUTH_FAILURE')).at(-1)).toBe(1);
    jest.setSystemTime(3600000);
    expect(await redis.decide(key(), 'AUTH_FAILURE')).toEqual([1, 0, 3600, 14, 9, 7200, 86400, 0]);
  });
  it('expires at the day boundary and admits a fresh pair of counters', async () => {
    const redis = harness();
    jest.setSystemTime(86399999);
    await seed(redis, 'AUTH_FAILURE', { hour: 82800, hc: 1, dc: 30, ttl: 1 });
    expect((await redis.decide(key(), 'AUTH_FAILURE')).at(-1)).toBe(1);
    jest.setSystemTime(86400000);
    expect(await redis.decide(key(), 'AUTH_FAILURE')).toEqual([1, 0, 86400, 14, 29, 90000, 172800, 0]);
  });
  it('atomically admits exactly the hourly quota under concurrent local calls', async () => {
    const redis = harness();
    const results = await Promise.all(Array.from({ length: 25 }, () => redis.decide(key(), 'AUTH_FAILURE')));
    expect(results.filter((result) => result[1] === 0)).toHaveLength(15);
    expect(results.filter((result) => result[1] === 1)).toHaveLength(10);
    expect(await redis.get(key())).toBe('1:15:30:0:15:0:15');
    expect(await redis.keys('*')).toEqual([key()]);
  });
  it('bounds one value and expiry, without extending the aligned day on later requests', async () => {
    const redis = harness();
    jest.setSystemTime(1234);
    await redis.decide(key(), 'AUTH_FAILURE');
    expect(await redis.pttl(key())).toBe(86400000 - 1234);
    jest.setSystemTime(5000);
    await redis.decide(key(), 'AUTH_FAILURE');
    expect(await redis.pttl(key())).toBe(86400000 - 5000);
    expect((await redis.get(key())).length).toBeLessThanOrEqual(96);
  });
  it.each([1794168000123, 2147483647123, 4102444799999])('handles realistic and maximum supported epoch %p', async (milliseconds) => {
    const redis = harness();
    jest.setSystemTime(milliseconds);
    const result = parseAuthRateLimitRedisResult(await redis.decide(key(), 'AUTH_FAILURE'), 'AUTH_FAILURE');
    expect(result.status).toBe('allowed');
    expect(await redis.pttl(key())).toBeGreaterThan(0);
    expect(await redis.pttl(key())).toBeLessThanOrEqual(86400000);
    expect(parseAuthRateLimitRedisResult(await redis.decide(key(), 'AUTH_FAILURE'), 'AUTH_FAILURE').hourly.remaining).toBe(13);
  });
  it('leaves both counters and expiry intact if the sole SET fails', async () => {
    const redis = harness({ failWrite: true });
    await seed(redis, 'AUTH_FAILURE', { hc: 3 });
    await expect(redis.decide(key(), 'AUTH_FAILURE')).rejects.toThrow('synthetic write failure');
    expect(await redis.get(key())).toBe('1:15:30:0:3:0:3');
    expect(await redis.pttl(key())).toBe(86400000);
  });
  it.each([['0', '1000000'], ['NaN', '0'], ['4102444800', '0'], ['01', '0']])(
    'rejects invalid Redis TIME %s/%s before creating state', async (seconds, micros) => {
      const redis = harness();
      expect((await redis.decideAtTime(key(), 'AUTH_FAILURE', seconds, micros))[1]).toBe(2);
      expect(await redis.keys('*')).toEqual([]);
    }
  );
  it.each([
    'secret-sentinel', '1:15:30:0:0:0:0', '2:15:30:0:1:0:1',
    '1:015:30:0:1:0:1', '1:15:30:0:16:0:16', '1:15:30:0:1:0:31',
    '1:15:30:0:2:0:1', '1:15:30:3600:1:0:1', '1:15:30:1:1:0:1',
    '1:15:30:0:1:86400:1', '1:30:100:0:1:0:1', 'x'.repeat(97),
    '1:15:30:0:1:0:1:extra', '1:15:30:0:1.0:0:1',
  ])('rejects malformed state without changing its bytes or TTL: %s', async (value) => {
    const redis = harness();
    await redis.set(key(), value, 'PX', 86400000);
    expect(await redis.decide(key(), 'AUTH_FAILURE')).toEqual([1, 2, 0, 0, 0, 0, 0, 0]);
    expect(await redis.get(key())).toBe(value);
    expect(await redis.pttl(key())).toBe(86400000);
  });
  it.each([null, 86400001])('rejects absent/excessive expiry without mutation: %p', async (ttl) => {
    const redis = harness();
    await redis.set(key(), '1:15:30:0:1:0:1');
    if (ttl !== null) await redis.pexpire(key(), ttl);
    const before = await redis.pttl(key());
    expect((await redis.decide(key(), 'AUTH_FAILURE'))[1]).toBe(2);
    expect(await redis.pttl(key())).toBe(before);
  });
  it('rejects wrong key type, invalid operation, and cross-operation key before mutation', async () => {
    const redis = harness();
    await redis.hset(key(), 'private', 'synthetic');
    expect((await redis.decide(key(), 'AUTH_FAILURE'))[1]).toBe(2);
    expect(await redis.hgetall(key())).toEqual({ private: 'synthetic' });
    expect((await redis.decide(key('PRE_AUTH'), 'AUTH_FAILURE'))[1]).toBe(2);
    expect((await redis.decide(key('PRE_AUTH'), 'unknown'))[1]).toBe(2);
    expect((await redis.decide('raw-address', 'PRE_AUTH'))[1]).toBe(2);
  });
  it('rejects malformed time and backward-clock state without erasing counters', async () => {
    const redis = harness();
    await seed(redis, 'AUTH_FAILURE', { hour: 3600, hc: 3 });
    expect((await redis.decide(key(), 'AUTH_FAILURE'))[1]).toBe(2);
    expect(await redis.get(key())).toBe('1:15:30:3600:3:0:3');
    jest.setSystemTime(-1000);
    expect((await redis.decide(key('PRE_AUTH'), 'PRE_AUTH'))[1]).toBe(2);
  });
  it.each([
    null, [1, 0], ['1', 0, 0, 14, 29, 3600, 86400, 0],
    [1, 2, 0, 0, 0, 0, 0, 0], [2, 0, 0, 14, 29, 3600, 86400, 0],
    [1, 0, 0, 15, 30, 3600, 86400, 0], [1, 0, 0, 14, 29, 3601, 86400, 0],
    [1, 0, 0, 14, 29, 3600, 86400, 1], [1, 0, 0, 13, 29, 3600, 86400, 0],
    [1, 1, 0, 0, 15, 3600, 86400, 1], [1, 1, 0, 14, 29, 3600, 86400, 3600],
    [1, 1, 0, 0, 0, 3600, 86400, 3600], [1, 0, NaN, 14, 29, 3600, 86400, 0],
  ])('rejects malformed or contradictory output %p', (raw) => {
    expect(() => parseAuthRateLimitRedisResult(raw, 'AUTH_FAILURE')).toThrow('auth rate limit unavailable');
  });
  it('uses EVALSHA then EVAL exactly once for the fixed NOSCRIPT sentinel', async () => {
    const redis = { evalsha: jest.fn().mockRejectedValue(AUTH_RATE_LIMIT_NOSCRIPT), eval: jest.fn().mockResolvedValue([1, 0, 0, 14, 29, 3600, 86400, 0]) };
    const result = await executeAuthRateLimitRedisScript(redis, key(), 'AUTH_FAILURE', context());
    expect(result.status).toBe('allowed');
    expect(redis.evalsha).toHaveBeenCalledWith(AUTH_RATE_LIMIT_REDIS_SCRIPT_SHA, [key()], ['AUTH_FAILURE']);
    expect(redis.eval).toHaveBeenCalledWith(AUTH_RATE_LIMIT_REDIS_SCRIPT, [key()], ['AUTH_FAILURE']);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });
  it.each([new Error('NOSCRIPT missing'), new Error('timeout'), new Error('lost response')])(
    'never retries an unclassified failure', async (error) => {
      const redis = { evalsha: jest.fn().mockRejectedValue(error), eval: jest.fn() };
      await expect(executeAuthRateLimitRedisScript(redis, key(), 'AUTH_FAILURE', context())).rejects.toThrow('auth rate limit unavailable');
      expect(redis.evalsha).toHaveBeenCalledTimes(1);
      expect(redis.eval).not.toHaveBeenCalled();
    }
  );
  it('does not fall back for malformed output or after deadline expiry', async () => {
    const redis = { evalsha: jest.fn().mockResolvedValue([1, 0]), eval: jest.fn() };
    await expect(executeAuthRateLimitRedisScript(redis, key(), 'AUTH_FAILURE', context())).rejects.toThrow();
    redis.evalsha.mockImplementation(async () => { jest.setSystemTime(1500); throw AUTH_RATE_LIMIT_NOSCRIPT; });
    await expect(executeAuthRateLimitRedisScript(redis, key(), 'AUTH_FAILURE', context())).rejects.toThrow();
    expect(redis.eval).not.toHaveBeenCalled();
  });
  it('proves two fetches total for real-SDK NOSCRIPT followed by an uncertain EVAL', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'NOSCRIPT No matching script. Please use EVAL.' })))
      .mockRejectedValueOnce(new Error('lost response'));
    try {
      const ctx = context();
      const redis = createAuthRateLimitRedisClient({ redis: {
        schemaVersion: 1, url: 'https://synthetic.upstash.io', token: 'synthetic-token',
      } }, ctx);
      await expect(executeAuthRateLimitRedisScript(redis, key(), 'AUTH_FAILURE', ctx)).rejects.toThrow('auth rate limit unavailable');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    } finally { global.fetch = originalFetch; }
  });
});
