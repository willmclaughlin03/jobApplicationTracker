import RedisMock from 'ioredis-mock';
import { createTemporarySessionCeiling } from '../temporarySessionCeiling.js';
import {
  TEMPORARY_SESSION_REDIS_SCRIPT,
  TEMPORARY_SESSION_REDIS_SCRIPT_SHA,
  TEMPORARY_SESSION_REDIS_SLOT_COUNT,
} from '../temporarySessionRedisScript.js';

const RUNTIME_PAIR = Object.freeze({
  hmac: Object.freeze({ active: Object.freeze({ generation: 1, keyId: 'gate1-key-1', key: 'unused' }) }),
  redis: Object.freeze({ url: 'https://synthetic-gate1.upstash.io', token: 'unused' }),
  cacheIdentity: Object.freeze({}),
});

let redisHarnessSequence = 0;

/**
 * Builds the deterministic Redis key used by the injected identity seam.
 *
 * @param {number[]} sourceBytes synthetic source bytes
 * @returns {string} test-only Redis key
 */
function createSyntheticRedisKey(sourceBytes) {
  return `synthetic-key-${Buffer.from(sourceBytes).toString('hex')}`;
}

/**
 * Creates an isolated in-memory Redis adapter that executes the production Lua.
 *
 * Why: local CI must exercise the exact deployed state validation and bucket
 * algorithm without external credentials or skipped tests.
 *
 * @returns {object} Upstash-compatible commands and bounded state controls
 */
function createAtomicRedisHarness() {
  redisHarnessSequence += 1;
  const client = new RedisMock({
    host: 'temporary-session-integration',
    port: 6379 + redisHarnessSequence,
  });
  let currentSecond = 0;
  let scriptLoaded = false;

  client.defineCommand('runTemporarySessionCeilingScript', {
    numberOfKeys: 1,
    lua: TEMPORARY_SESSION_REDIS_SCRIPT,
  });

  /**
   * Verifies the production executor passed the fixed one-key/zero-argument contract.
   *
   * @param {string[]} keys exact key list
   * @param {unknown[]} args exact argument list
   * @returns {void}
   */
  function expectFixedInvocation(keys, args) {
    expect(keys).toHaveLength(1);
    expect(args).toEqual([]);
  }

  /**
   * Executes the production Lua command against the isolated Redis emulator.
   *
   * @param {string[]} keys exact one-key list
   * @param {unknown[]} args exact empty argument list
   * @returns {Promise<number[]>} versioned Lua-compatible tuple
   */
  async function executeProductionScript(keys, args) {
    expectFixedInvocation(keys, args);
    return client.runTemporarySessionCeilingScript(keys[0]);
  }

  /**
   * Seeds a complete production-shaped hash for corruption and boundary tests.
   *
   * @param {string} key synthetic Redis key
   * @param {object} [options] version, TTL, and per-slot overrides
   * @returns {Promise<void>} completion after state is stored
   */
  async function seedHashState(key, options = {}) {
    const version = options.version ?? '1';
    const ttlSeconds = options.ttlSeconds;
    const slots = options.slots ?? {};
    const fields = ['v', version];
    for (let index = 0; index < TEMPORARY_SESSION_REDIS_SLOT_COUNT; index += 1) {
      const [label, count] = slots[index] ?? [-1, 0];
      fields.push(`l${index}`, String(label), `c${index}`, String(count));
    }
    await client.hset(key, ...fields);
    if (ttlSeconds !== undefined) await client.expire(key, ttlSeconds);
  }

  /**
   * Stores an intentionally wrong Redis value type at the limiter key.
   *
   * @param {string} key synthetic Redis key
   * @returns {Promise<string>} Redis acknowledgement
   */
  function seedStringState(key) {
    return client.set(key, 'wrong-type');
  }

  /**
   * Stores selected raw hash fields for malformed-shape tests.
   *
   * @param {string} key synthetic Redis key
   * @param {object} fields raw field/value pairs
   * @returns {Promise<number>} number of fields added
   */
  function seedHashFields(key, fields) {
    const entries = Object.entries(fields).flatMap(([field, value]) => [field, String(value)]);
    return client.hset(key, ...entries);
  }

  /**
   * Applies a test TTL without changing the stored Redis value.
   *
   * @param {string} key synthetic Redis key
   * @param {number} seconds expiration interval
   * @returns {Promise<number>} Redis expiry result
   */
  function setExpiry(key, seconds) {
    return client.expire(key, seconds);
  }

  /**
   * Advances the Redis wall clock used by TIME and TTL.
   *
   * @param {number} value whole epoch second
   * @returns {void}
   */
  function setSecond(value) {
    currentSecond = value;
    jest.setSystemTime(value * 1_000);
  }

  /**
   * Reads identifier-free key, stored-count, and expiration evidence.
   *
   * @returns {Promise<object>} bounded Redis state summary
   */
  async function getSnapshot() {
    const keys = await client.keys('synthetic-key-*');
    const countFields = Array.from(
      { length: TEMPORARY_SESSION_REDIS_SLOT_COUNT },
      (_unused, index) => `c${index}`
    );
    const storedCounts = await Promise.all(keys.map(async (key) => {
      if (await client.type(key) !== 'hash') return 0;
      const counts = await client.hmget(key, ...countFields);
      return counts.reduce((total, count) => total + Number(count ?? 0), 0);
    }));
    const ttl = keys.length === 1 ? await client.ttl(keys[0]) : null;
    return {
      activeKeyCount: keys.length,
      writeCount: storedCounts.reduce((total, count) => total + count, 0),
      expiresAt: Number.isInteger(ttl) && ttl >= 0 ? currentSecond + ttl : null,
    };
  }

  return {
    evalsha: jest.fn(async (sha, keys, args) => {
      expect(sha).toBe(TEMPORARY_SESSION_REDIS_SCRIPT_SHA);
      expectFixedInvocation(keys, args);
      if (!scriptLoaded) throw new Error('NOSCRIPT No matching script.');
      return executeProductionScript(keys, args);
    }),
    eval: jest.fn(async (script, keys, args) => {
      expect(script).toBe(TEMPORARY_SESSION_REDIS_SCRIPT);
      scriptLoaded = true;
      return executeProductionScript(keys, args);
    }),
    setSecond,
    getSnapshot,
    seedStringState,
    seedHashState,
    seedHashFields,
    setExpiry,
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
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

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
    expect(await redis.getSnapshot()).toEqual({ activeKeyCount: 1, writeCount: 400, expiresAt: 61 });
  });

  it('does not write or extend TTL for a rejected request', async () => {
    const redis = createAtomicRedisHarness();
    const ceiling = createIntegratedCeiling(redis, () => 0);
    for (let index = 0; index < 400; index += 1) {
      await ceiling.evaluate({ sourceBytes: [192, 0, 2, 91] }, { routeVersion: 'v1' });
    }
    const before = await redis.getSnapshot();
    await expect(ceiling.evaluate(
      { sourceBytes: [192, 0, 2, 91] },
      { routeVersion: 'v1' }
    )).resolves.toMatchObject({ statusCode: 429 });
    expect(await redis.getSnapshot()).toEqual(before);
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
    expect((await redis.getSnapshot()).activeKeyCount).toBe(1);

    redis.setSecond(122);
    milliseconds = 122_000;
    expect((await redis.getSnapshot()).activeKeyCount).toBe(0);
  });

  it('bounds sparse-source cardinality to one expiring key per source', async () => {
    const redis = createAtomicRedisHarness();
    const ceiling = createIntegratedCeiling(redis, () => 0);
    await Promise.all(Array.from({ length: 100 }, (_unused, index) => ceiling.evaluate(
      { sourceBytes: [192, 0, 2, index + 1] },
      { routeVersion: index % 2 === 0 ? 'v1' : 'v2' }
    )));
    expect(await redis.getSnapshot()).toEqual({ activeKeyCount: 100, writeCount: 100, expiresAt: null });
  });

  it('rejects a non-hash limiter key without replacing it', async () => {
    const sourceBytes = [192, 0, 2, 93];
    const redis = createAtomicRedisHarness();
    const ceiling = createIntegratedCeiling(redis, () => 0);
    await redis.seedStringState(createSyntheticRedisKey(sourceBytes));

    await expect(ceiling.evaluate(
      { sourceBytes },
      { routeVersion: 'v1' }
    )).resolves.toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'script_state_invalid',
    });
    expect(await redis.getSnapshot()).toEqual({ activeKeyCount: 1, writeCount: 0, expiresAt: null });
  });

  it('rejects malformed hash shape and version before writing', async () => {
    const shapeSource = [192, 0, 2, 94];
    const versionSource = [192, 0, 2, 95];
    const redis = createAtomicRedisHarness();
    const ceiling = createIntegratedCeiling(redis, () => 0);
    const shapeKey = createSyntheticRedisKey(shapeSource);
    const versionKey = createSyntheticRedisKey(versionSource);
    await redis.seedHashFields(shapeKey, { v: '1', l0: '-1', c0: '0' });
    await redis.setExpiry(shapeKey, 61);
    await redis.seedHashState(versionKey, { version: '2', ttlSeconds: 61 });

    await expect(ceiling.evaluate(
      { sourceBytes: shapeSource },
      { routeVersion: 'v1' }
    )).resolves.toMatchObject({ statusCode: 503, reason: 'script_state_invalid' });
    await expect(ceiling.evaluate(
      { sourceBytes: versionSource },
      { routeVersion: 'v2' }
    )).resolves.toMatchObject({ statusCode: 503, reason: 'script_state_invalid' });
    expect((await redis.getSnapshot()).writeCount).toBe(0);
  });

  it('rejects missing and oversized TTLs on production-shaped hashes', async () => {
    const missingTtlSource = [192, 0, 2, 96];
    const oversizedTtlSource = [192, 0, 2, 97];
    const redis = createAtomicRedisHarness();
    const ceiling = createIntegratedCeiling(redis, () => 0);
    await redis.seedHashState(createSyntheticRedisKey(missingTtlSource));
    await redis.seedHashState(createSyntheticRedisKey(oversizedTtlSource), { ttlSeconds: 62 });

    await expect(ceiling.evaluate(
      { sourceBytes: missingTtlSource },
      { routeVersion: 'v1' }
    )).resolves.toMatchObject({ statusCode: 503, reason: 'script_state_invalid' });
    await expect(ceiling.evaluate(
      { sourceBytes: oversizedTtlSource },
      { routeVersion: 'v1' }
    )).resolves.toMatchObject({ statusCode: 503, reason: 'script_state_invalid' });
    expect((await redis.getSnapshot()).writeCount).toBe(0);
  });

  it('rejects non-canonical numeric hash values', async () => {
    const sourceBytes = [192, 0, 2, 98];
    const redis = createAtomicRedisHarness();
    const ceiling = createIntegratedCeiling(redis, () => 0);
    const key = createSyntheticRedisKey(sourceBytes);
    await redis.seedHashState(key, { ttlSeconds: 61 });
    await redis.seedHashFields(key, { l0: '00', c0: '1' });

    await expect(ceiling.evaluate(
      { sourceBytes },
      { routeVersion: 'v1' }
    )).resolves.toMatchObject({ statusCode: 503, reason: 'script_state_invalid' });
    expect((await redis.getSnapshot()).writeCount).toBe(1);
  });

  it('rejects a stored total over 400 even when most counts are outside the window', async () => {
    const sourceBytes = [192, 0, 2, 99];
    const redis = createAtomicRedisHarness();
    redis.setSecond(61);
    const ceiling = createIntegratedCeiling(redis, () => 0);
    await redis.seedHashState(createSyntheticRedisKey(sourceBytes), {
      ttlSeconds: 61,
      slots: {
        0: [0, 400],
        1: [1, 1],
      },
    });

    await expect(ceiling.evaluate(
      { sourceBytes },
      { routeVersion: 'v1' }
    )).resolves.toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'script_state_invalid',
    });
    expect((await redis.getSnapshot()).writeCount).toBe(401);
  });
});
