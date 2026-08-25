import RedisMock from 'ioredis-mock';
import {
  executeTemporarySessionRedisScript,
  isTemporarySessionNoscriptError,
  parseTemporarySessionRedisResult,
  TEMPORARY_SESSION_REDIS_SCRIPT,
  TEMPORARY_SESSION_REDIS_SCRIPT_SHA,
  TEMPORARY_SESSION_REDIS_SLOT_COUNT,
} from '../temporarySessionRedisScript.js';

let redisHarnessSequence = 0;

/**
 * Creates an isolated in-memory Redis command that executes the production Lua.
 *
 * Why: unit coverage should verify the script's behavior, not only its source shape.
 *
 * @returns {object} Redis mock with the production script registered as a command
 */
function createRedisScriptHarness() {
  redisHarnessSequence += 1;
  const redis = new RedisMock({
    host: 'temporary-session-script-unit',
    port: 7_000 + redisHarnessSequence,
  });
  redis.defineCommand('runTemporarySessionScript', {
    numberOfKeys: 1,
    lua: TEMPORARY_SESSION_REDIS_SCRIPT,
  });
  return redis;
}

/**
 * Builds the complete versioned hash shape accepted by the production Lua.
 *
 * @param {object} slots per-index label and count overrides
 * @returns {string[]} flattened Redis hash field/value arguments
 */
function createStoredHashFields(slots = {}) {
  const fields = ['v', '1'];
  for (let index = 0; index < TEMPORARY_SESSION_REDIS_SLOT_COUNT; index += 1) {
    const [label, count] = slots[index] ?? [-1, 0];
    fields.push(`l${index}`, String(label), `c${index}`, String(count));
  }
  return fields;
}

describe('temporarySessionRedisScript', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('freezes one-key Redis TIME and 61-slot persistence semantics', () => {
    expect(TEMPORARY_SESSION_REDIS_SLOT_COUNT).toBe(61);
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain("local key = KEYS[1]");
    expect(TEMPORARY_SESSION_REDIS_SCRIPT.match(/KEYS\[1\]/g)).toHaveLength(1);
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).not.toContain('KEYS[2]');
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain("redis.call('TIME')");
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain("redis.call('HLEN', key)");
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain("redis.call('TTL', key)");
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain("redis.call('HSET', unpack(write_arguments))");
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain("redis.call('EXPIRE', key, 61)");
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain('if total >= 400 then');
    expect(TEMPORARY_SESSION_REDIS_SCRIPT_SHA).toMatch(/^[a-f0-9]{40}$/);
  });

  it('allows below 400 and limits at 400 with the bounded retry', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const redis = createRedisScriptHarness();
    await redis.hset('synthetic-key', ...createStoredHashFields({ 0: [0, 399] }));
    await redis.expire('synthetic-key', 61);

    await expect(redis.runTemporarySessionScript('synthetic-key')).resolves.toEqual([1, 0, 0]);
    await expect(redis.runTemporarySessionScript('synthetic-key')).resolves.toEqual([1, 1, 60]);
    await expect(redis.hget('synthetic-key', 'c0')).resolves.toBe('400');
  });

  it('reuses the expired physical slot at now plus 61', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const redis = createRedisScriptHarness();

    await redis.runTemporarySessionScript('synthetic-key');
    jest.setSystemTime(60_000);
    await redis.runTemporarySessionScript('synthetic-key');
    jest.setSystemTime(61_000);
    await expect(redis.runTemporarySessionScript('synthetic-key')).resolves.toEqual([1, 0, 0]);
    await expect(redis.hmget('synthetic-key', 'l0', 'c0', 'l60', 'c60')).resolves.toEqual([
      '61', '1', '60', '1',
    ]);
  });

  it('rejects a stored total over 400 even when most counts have expired', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(61_000);
    const redis = createRedisScriptHarness();
    await redis.hset('synthetic-key', ...createStoredHashFields({
      0: [0, 400],
      1: [1, 1],
    }));
    await redis.expire('synthetic-key', 61);

    await expect(redis.runTemporarySessionScript('synthetic-key')).resolves.toEqual([1, 2, 0]);
  });

  it.each([
    [[1, 0, 0], { status: 'allowed' }],
    [[1, 1, 60], { status: 'rate_limited', retryAfterSeconds: 60 }],
    [[1, 2, 0], { status: 'invalid_state' }],
  ])('accepts only an exact versioned tuple', (raw, expected) => {
    expect(parseTemporarySessionRedisResult(raw)).toEqual(expected);
  });

  it.each([
    null,
    [1, 0],
    [1, 0, 0, 0],
    ['1', 0, 0],
    [2, 0, 0],
    [1, 0, 1],
    [1, 1, 0],
    [1, 1, 61],
    [1, 2, 1],
    [1, 3, 0],
  ])('rejects every malformed or unbounded result shape', (raw) => {
    expect(() => parseTemporarySessionRedisResult(raw)).toThrow(
      'temporary session Redis evaluation is unavailable'
    );
  });

  it('falls back from EVALSHA to one EVAL only for an exact NOSCRIPT code', async () => {
    const redis = {
      evalsha: jest.fn().mockRejectedValue(new Error('NOSCRIPT No matching script.')),
      eval: jest.fn().mockResolvedValue([1, 0, 0]),
    };
    await expect(executeTemporarySessionRedisScript(redis, 'synthetic-key', {
      now: () => 0,
      deadlineAt: 3_000,
    })).resolves.toEqual({ status: 'allowed' });
    expect(redis.evalsha).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.evalsha.mock.calls[0][1]).toEqual(['synthetic-key']);
    expect(redis.evalsha.mock.calls[0][2]).toEqual([]);
  });

  it.each([
    new Error('ETIMEDOUT'),
    new Error('transport failed'),
    new Error('prefix NOSCRIPT No matching script.'),
    new Error('NOSCRIPTED'),
  ])('never retries uncertain or inexact errors', async (error) => {
    const redis = {
      evalsha: jest.fn().mockRejectedValue(error),
      eval: jest.fn(),
    };
    await expect(executeTemporarySessionRedisScript(redis, 'synthetic-key', {
      now: () => 0,
      deadlineAt: 3_000,
    })).rejects.toThrow('temporary session Redis evaluation is unavailable');
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('does not retry a malformed result after Redis may have consumed a slot', async () => {
    const redis = {
      evalsha: jest.fn().mockResolvedValue([1, 0]),
      eval: jest.fn(),
    };
    await expect(executeTemporarySessionRedisScript(redis, 'synthetic-key', {
      now: () => 0,
      deadlineAt: 3_000,
    })).rejects.toThrow();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('bounds a pending Redis operation by the absolute deadline', async () => {
    jest.useFakeTimers();
    let clock = 0;
    const redis = {
      evalsha: jest.fn(() => new Promise(() => {})),
      eval: jest.fn(),
    };
    const result = executeTemporarySessionRedisScript(redis, 'synthetic-key', {
      now: () => clock,
      deadlineAt: 3_000,
    });
    const rejection = expect(result).rejects.toThrow(
      'temporary session Redis evaluation is unavailable'
    );
    clock = 3_000;
    await jest.advanceTimersByTimeAsync(3_000);
    await rejection;
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('recognizes no aliases for the exact NOSCRIPT code', () => {
    expect(isTemporarySessionNoscriptError(new Error('NOSCRIPT'))).toBe(true);
    expect(isTemporarySessionNoscriptError(new Error('NOSCRIPT missing'))).toBe(true);
    expect(isTemporarySessionNoscriptError(new Error(' noscript missing'))).toBe(false);
  });
});
