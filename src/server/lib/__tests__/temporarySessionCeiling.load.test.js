import { createTemporarySessionCeiling } from '../temporarySessionCeiling.js';

/**
 * Creates an atomic counter Redis surface for controlled local load.
 *
 * @returns {object} Redis-compatible client and count reader
 */
function createLoadRedis() {
  const counts = new Map();

  /**
   * Applies one synchronous 400-request allowance per internal key.
   *
   * @param {string[]} keys one-key command input
   * @returns {number[]} versioned result tuple
   */
  function evaluate(keys) {
    const key = keys[0];
    const count = counts.get(key) ?? 0;
    if (count >= 400) return [1, 1, 60];
    counts.set(key, count + 1);
    return [1, 0, 0];
  }

  return {
    evalsha: jest.fn(async (_sha, keys) => evaluate(keys)),
    eval: jest.fn(async (_script, keys) => evaluate(keys)),
    getCounts: () => [...counts.values()].sort((left, right) => left - right),
  };
}

describe('temporarySessionCeiling controlled load', () => {
  it('allows the documented 1, 2, 4, 8-tab and 50-session legitimate profiles', async () => {
    const redis = createLoadRedis();
    const runtimePair = Object.freeze({
      hmac: Object.freeze({ active: Object.freeze({ generation: 1 }) }),
      redis: Object.freeze({}),
      cacheIdentity: Object.freeze({}),
    });
    const ceiling = createTemporarySessionCeiling({
      env: { NODE_ENV: 'test' },
      sourceMode: 'local',
      now: () => 0,
      resolveSource: (req) => ({ family: 4, addressBytes: Buffer.from(req.sourceBytes) }),
      secrets: { getRuntimePair: async () => runtimePair },
      deriveIdentity: (source) => ({ redisKey: `synthetic-${source.addressBytes.toString('hex')}` }),
      getRedisClientFunction: async () => redis,
      telemetry: {
        record: jest.fn(),
        finish: jest.fn(),
        maybeRotate: jest.fn(),
        getSnapshot: jest.fn(() => ({})),
      },
    });

    const tabProfiles = [1, 2, 4, 8];
    const profileRequests = tabProfiles.flatMap((tabCount) => Array.from(
      { length: tabCount },
      () => ceiling.evaluate({ sourceBytes: [192, 0, 2, 100] }, { routeVersion: 'v1' })
    ));
    const sessionRequests = Array.from({ length: 50 }, () => ceiling.evaluate(
      { sourceBytes: [192, 0, 2, 101] },
      { routeVersion: 'v1' }
    ));
    const decisions = await Promise.all([...profileRequests, ...sessionRequests]);

    expect(decisions).toHaveLength(65);
    expect(decisions.every((decision) => decision.allowed === true)).toBe(true);
    expect(redis.getCounts()).toEqual([15, 50]);
  });
});
