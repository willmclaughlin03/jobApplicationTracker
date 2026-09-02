import RedisMock from 'ioredis-mock';
import {
  executeTemporarySessionRedisScript,
  isTemporarySessionNoscriptError,
  parseTemporarySessionRedisResult,
  TEMPORARY_SESSION_REDIS_LIMIT,
  TEMPORARY_SESSION_REDIS_SCRIPT,
  TEMPORARY_SESSION_REDIS_SCRIPT_SHA,
  TEMPORARY_SESSION_REDIS_SLOT_COUNT,
  TEMPORARY_SESSION_REDIS_TTL_SECONDS,
  TEMPORARY_SESSION_REDIS_WINDOW_SECONDS,
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

  it('freezes one-key Redis TIME and constant-derived persistence semantics', () => {
    const hashFieldCount = 1 + (2 * TEMPORARY_SESSION_REDIS_SLOT_COUNT);
    expect(TEMPORARY_SESSION_REDIS_SLOT_COUNT).toBe(TEMPORARY_SESSION_REDIS_WINDOW_SECONDS + 1);
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain("local key = KEYS[1]");
    expect(TEMPORARY_SESSION_REDIS_SCRIPT.match(/KEYS\[1\]/g)).toHaveLength(1);
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).not.toContain('KEYS[2]');
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain("redis.call('TIME')");
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain("redis.call('HLEN', key)");
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain("redis.call('TTL', key)");
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain("redis.call('HSET', unpack(write_arguments))");
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain(
      `for index = 0, ${TEMPORARY_SESSION_REDIS_SLOT_COUNT - 1} do`
    );
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain(`field_count ~= ${hashFieldCount}`);
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain(`#values ~= ${hashFieldCount}`);
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain(
      `redis.call('EXPIRE', key, ${TEMPORARY_SESSION_REDIS_TTL_SECONDS})`
    );
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain(
      `if total >= ${TEMPORARY_SESSION_REDIS_LIMIT} then`
    );
    expect(TEMPORARY_SESSION_REDIS_SCRIPT).toContain(
      `label >= now - ${TEMPORARY_SESSION_REDIS_WINDOW_SECONDS}`
    );
    expect(TEMPORARY_SESSION_REDIS_SCRIPT_SHA).toMatch(/^[a-f0-9]{40}$/);
  });

  it('allows below the configured limit and then returns the bounded retry', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const redis = createRedisScriptHarness();
    await redis.hset('synthetic-key', ...createStoredHashFields({
      0: [0, TEMPORARY_SESSION_REDIS_LIMIT - 1],
    }));
    await redis.expire('synthetic-key', TEMPORARY_SESSION_REDIS_TTL_SECONDS);

    await expect(redis.runTemporarySessionScript('synthetic-key')).resolves.toEqual([1, 0, 0]);
    await expect(redis.runTemporarySessionScript('synthetic-key')).resolves.toEqual([
      1, 1, TEMPORARY_SESSION_REDIS_WINDOW_SECONDS,
    ]);
    await expect(redis.hget('synthetic-key', 'c0')).resolves.toBe(String(TEMPORARY_SESSION_REDIS_LIMIT));
  });

  it('reuses the expired physical slot after one complete slot cycle', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const redis = createRedisScriptHarness();

    await redis.runTemporarySessionScript('synthetic-key');
    jest.setSystemTime(TEMPORARY_SESSION_REDIS_WINDOW_SECONDS * 1_000);
    await redis.runTemporarySessionScript('synthetic-key');
    jest.setSystemTime(TEMPORARY_SESSION_REDIS_SLOT_COUNT * 1_000);
    await expect(redis.runTemporarySessionScript('synthetic-key')).resolves.toEqual([1, 0, 0]);
    await expect(redis.hmget(
      'synthetic-key',
      'l0',
      'c0',
      `l${TEMPORARY_SESSION_REDIS_WINDOW_SECONDS}`,
      `c${TEMPORARY_SESSION_REDIS_WINDOW_SECONDS}`
    )).resolves.toEqual([
      String(TEMPORARY_SESSION_REDIS_SLOT_COUNT),
      '1',
      String(TEMPORARY_SESSION_REDIS_WINDOW_SECONDS),
      '1',
    ]);
  });

  it('clears stale residue before validating and persisting the active-window total', async () => {
    jest.useFakeTimers();
    jest.setSystemTime((TEMPORARY_SESSION_REDIS_SLOT_COUNT + 1) * 1_000);
    const redis = createRedisScriptHarness();
    await redis.hset('synthetic-key', ...createStoredHashFields({
      0: [0, TEMPORARY_SESSION_REDIS_LIMIT],
      2: [2, 1],
    }));
    await redis.expire('synthetic-key', TEMPORARY_SESSION_REDIS_TTL_SECONDS);

    await expect(redis.runTemporarySessionScript('synthetic-key')).resolves.toEqual([1, 0, 0]);
    await expect(redis.hmget(
      'synthetic-key',
      'l0',
      'c0',
      'l1',
      'c1',
      'l2',
      'c2'
    )).resolves.toEqual([
      '-1',
      '0',
      String(TEMPORARY_SESSION_REDIS_SLOT_COUNT + 1),
      '1',
      '2',
      '1',
    ]);
  });

  it('rejects an active-window total over the configured limit', async () => {
    jest.useFakeTimers();
    jest.setSystemTime((TEMPORARY_SESSION_REDIS_SLOT_COUNT + 1) * 1_000);
    const redis = createRedisScriptHarness();
    await redis.hset('synthetic-key', ...createStoredHashFields({
      2: [2, TEMPORARY_SESSION_REDIS_LIMIT],
      3: [3, 1],
    }));
    await redis.expire('synthetic-key', TEMPORARY_SESSION_REDIS_TTL_SECONDS);

    await expect(redis.runTemporarySessionScript('synthetic-key')).resolves.toEqual([1, 2, 0]);
  });

  it.each([
    [[1, 0, 0], { status: 'allowed' }],
    [
      [1, 1, TEMPORARY_SESSION_REDIS_WINDOW_SECONDS],
      { status: 'rate_limited', retryAfterSeconds: TEMPORARY_SESSION_REDIS_WINDOW_SECONDS },
    ],
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
    [1, 1, TEMPORARY_SESSION_REDIS_WINDOW_SECONDS + 1],
    [1, 2, 1],
    [1, 3, 0],
  ])('rejects every malformed or unbounded result shape', (raw) => {
    expect(() => parseTemporarySessionRedisResult(raw)).toThrow(
      'temporary session Redis evaluation is unavailable'
    );
  });

  it.each([
    new Error('NOSCRIPT No matching script.'),
    new Error('Command failed: NOSCRIPT No matching script. Please use EVAL.'),
  ])('falls back from EVALSHA to one EVAL for an exact NOSCRIPT response', async (error) => {
    const redis = {
      evalsha: jest.fn().mockRejectedValue(error),
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
    new Error('Command failed: prefix NOSCRIPT No matching script.'),
    new Error('Command failed: NOSCRIPTED'),
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
    expect(isTemporarySessionNoscriptError(new Error('Command failed: NOSCRIPT'))).toBe(true);
    expect(isTemporarySessionNoscriptError(
      new Error('Command failed: NOSCRIPT missing')
    )).toBe(true);
    expect(isTemporarySessionNoscriptError(new Error(' noscript missing'))).toBe(false);
    expect(isTemporarySessionNoscriptError(
      new Error('Command failed: NOSCRIPTED')
    )).toBe(false);
  });
});
