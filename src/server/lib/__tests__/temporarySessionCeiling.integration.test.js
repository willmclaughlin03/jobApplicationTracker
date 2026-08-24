import { createTemporarySessionCeiling } from '../temporarySessionCeiling.js';

const RUNTIME_PAIR = Object.freeze({
  hmac: Object.freeze({ active: Object.freeze({ generation: 1, keyId: 'gate1-key-1', key: 'unused' }) }),
  redis: Object.freeze({ url: 'https://synthetic-gate1.upstash.io', token: 'unused' }),
  cacheIdentity: Object.freeze({}),
});

/**
 * Creates an in-memory atomic Redis-script contract harness.
 *
 * Why: local CI can exercise concurrency, collision, TTL, and rejection-write
 * invariants without external credentials or skipped tests.
 *
 * @returns {object} Redis-compatible commands and identifier-free controls
 */
function createAtomicRedisHarness() {
  let currentSecond = 0;
  const states = new Map();
  let writeCount = 0;

  /**
   * Removes one key when its Redis TTL boundary has elapsed.
   *
   * @param {string} key internal synthetic key
   * @returns {object|null} live state
   */
  function readLiveState(key) {
    const state = states.get(key);
    if (state && currentSecond >= state.expiresAt) {
      states.delete(key);
      return null;
    }
    return state ?? null;
  }

  /**
   * Applies the frozen 61-bucket algorithm as one synchronous Redis operation.
   *
   * @param {string[]} keys exact one-key list
   * @returns {number[]} versioned Lua-compatible tuple
   */
  function evaluate(keys) {
    if (!Array.isArray(keys) || keys.length !== 1) return [1, 2, 0];
    const key = keys[0];
    let state = readLiveState(key);
    if (!state) {
      state = {
        labels: Array(61).fill(-1),
        counts: Array(61).fill(0),
        expiresAt: -1,
      };
    }

    let total = 0;
    let oldest = null;
    for (let index = 0; index < 61; index += 1) {
      const label = state.labels[index];
      const count = state.counts[index];
      if (!Number.isInteger(label)
        || !Number.isInteger(count)
        || label < -1
        || label > currentSecond
        || count < 0
        || count > 400
        || (count === 0 && label !== -1)
        || (count > 0 && (label < 0 || label % 61 !== index))) {
        return [1, 2, 0];
      }
      if (count > 0 && label >= currentSecond - 60) {
        total += count;
        if (total > 400) return [1, 2, 0];
        if (oldest === null || label < oldest) oldest = label;
      }
    }

    if (total >= 400) {
      return [1, 1, Math.min(60, Math.max(1, (oldest ?? currentSecond) + 61 - currentSecond))];
    }

    const index = currentSecond % 61;
    if (state.labels[index] !== currentSecond) {
      state.labels[index] = currentSecond;
      state.counts[index] = 0;
    }
    state.counts[index] += 1;
    state.expiresAt = currentSecond + 61;
    states.set(key, state);
    writeCount += 1;
    return [1, 0, 0];
  }

  return {
    evalsha: jest.fn(async (_sha, keys) => evaluate(keys)),
    eval: jest.fn(async (_script, keys) => evaluate(keys)),
    setSecond(value) { currentSecond = value; },
    getSnapshot() {
      for (const key of [...states.keys()]) readLiveState(key);
      return {
        activeKeyCount: states.size,
        writeCount,
        expiresAt: states.size === 1 ? [...states.values()][0].expiresAt : null,
      };
    },
  };
}

/**
 * Creates a facade wired to the in-memory Redis contract harness.
 *
 * @param {object} redis Redis harness
 * @param {() => number} now monotonic millisecond clock
 * @returns {object} shared ceiling facade
 */
function createIntegratedCeiling(redis, now) {
  return createTemporarySessionCeiling({
    env: { NODE_ENV: 'test' },
    sourceMode: 'local',
    now,
    resolveSource: (req) => ({ family: 4, addressBytes: Buffer.from(req.sourceBytes) }),
    secrets: { getRuntimePair: async () => RUNTIME_PAIR },
    deriveIdentity: (source) => ({ redisKey: `synthetic-key-${source.addressBytes.toString('hex')}` }),
    getRedisClientFunction: async (pair) => {
      expect(pair).toBe(RUNTIME_PAIR);
      return redis;
    },
    telemetry: {
      record: jest.fn(),
      finish: jest.fn(),
      maybeRotate: jest.fn(),
      getSnapshot: jest.fn(() => ({})),
    },
  });
}

describe('temporarySessionCeiling atomic integration', () => {
  it('allows requests 1-400 and rejects concurrent request 401 exactly', async () => {
    const redis = createAtomicRedisHarness();
    const ceiling = createIntegratedCeiling(redis, () => 0);
    const decisions = await Promise.all(Array.from({ length: 401 }, () => ceiling.evaluate(
      { sourceBytes: [192, 0, 2, 90] },
      { routeVersion: 'v1' }
    )));
    expect(decisions.filter((decision) => decision.allowed).length).toBe(400);
    expect(decisions.filter((decision) => decision.statusCode === 429)).toEqual([{
      allowed: false,
      statusCode: 429,
      reason: 'limit_exceeded',
      retryAfterSeconds: 60,
    }]);
    expect(redis.getSnapshot()).toEqual({ activeKeyCount: 1, writeCount: 400, expiresAt: 61 });
  });

  it('does not write or extend TTL for a rejected request', async () => {
    const redis = createAtomicRedisHarness();
    const ceiling = createIntegratedCeiling(redis, () => 0);
    for (let index = 0; index < 400; index += 1) {
      await ceiling.evaluate({ sourceBytes: [192, 0, 2, 91] }, { routeVersion: 'v1' });
    }
    const before = redis.getSnapshot();
    await expect(ceiling.evaluate(
      { sourceBytes: [192, 0, 2, 91] },
      { routeVersion: 'v1' }
    )).resolves.toMatchObject({ statusCode: 429 });
    expect(redis.getSnapshot()).toEqual(before);
  });

  it('keeps the oldest boundary in a distinct physical slot and expires cleanly', async () => {
    let milliseconds = 0;
    const redis = createAtomicRedisHarness();
    const ceiling = createIntegratedCeiling(redis, () => milliseconds);
    await ceiling.evaluate({ sourceBytes: [192, 0, 2, 92] }, { routeVersion: 'v1' });
    redis.setSecond(60);
    milliseconds = 60_000;
    for (let index = 1; index < 400; index += 1) {
      await ceiling.evaluate({ sourceBytes: [192, 0, 2, 92] }, { routeVersion: 'v1' });
    }
    await expect(ceiling.evaluate(
      { sourceBytes: [192, 0, 2, 92] },
      { routeVersion: 'v1' }
    )).resolves.toMatchObject({ statusCode: 429, retryAfterSeconds: 1 });

    redis.setSecond(61);
    milliseconds = 61_000;
    await expect(ceiling.evaluate(
      { sourceBytes: [192, 0, 2, 92] },
      { routeVersion: 'v1' }
    )).resolves.toEqual({ allowed: true });
    expect(redis.getSnapshot().activeKeyCount).toBe(1);

    redis.setSecond(122);
    milliseconds = 122_000;
    expect(redis.getSnapshot().activeKeyCount).toBe(0);
  });

  it('bounds sparse-source cardinality to one expiring key per source', async () => {
    const redis = createAtomicRedisHarness();
    const ceiling = createIntegratedCeiling(redis, () => 0);
    await Promise.all(Array.from({ length: 100 }, (_unused, index) => ceiling.evaluate(
      { sourceBytes: [192, 0, 2, index + 1] },
      { routeVersion: index % 2 === 0 ? 'v1' : 'v2' }
    )));
    expect(redis.getSnapshot()).toEqual({ activeKeyCount: 100, writeCount: 100, expiresAt: null });
  });
});
