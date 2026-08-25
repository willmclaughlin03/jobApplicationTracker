import {
  createTemporarySessionCeiling,
  TEMPORARY_SESSION_CEILING_DEADLINE_MS,
} from '../temporarySessionCeiling.js';

const SOURCE = Object.freeze({ family: 4, addressBytes: Buffer.from([192, 0, 2, 80]) });
const RUNTIME_PAIR = Object.freeze({
  hmac: Object.freeze({
    active: Object.freeze({
      generation: 1,
      keyId: 'gate1-key-1',
      key: Buffer.alloc(32, 1).toString('base64url'),
    }),
    previous: null,
  }),
  redis: Object.freeze({ url: 'https://synthetic-gate1.upstash.io', token: 'synthetic-token' }),
  cacheIdentity: Object.freeze({}),
});

/**
 * Creates a fixed telemetry spy surface for facade tests.
 *
 * @returns {object} telemetry mock
 */
function createTelemetry() {
  return {
    record: jest.fn(),
    finish: jest.fn(),
    maybeRotate: jest.fn(),
    getSnapshot: jest.fn(() => ({ total: 0 })),
  };
}

/**
 * Creates one fully injected facade and returns its dependency spies.
 *
 * @param {object} [overrides] dependency overrides
 * @returns {object} ceiling and spies
 */
function createFixture(overrides = {}) {
  const telemetry = overrides.telemetry ?? createTelemetry();
  const resolveSource = overrides.resolveSource ?? jest.fn(() => SOURCE);
  const secrets = overrides.secrets ?? { getRuntimePair: jest.fn(async () => RUNTIME_PAIR) };
  const deriveIdentity = overrides.deriveIdentity
    ?? jest.fn(() => ({ redisKey: 'synthetic-internal-key' }));
  const redis = overrides.redis ?? { evalsha: jest.fn(), eval: jest.fn() };
  const getRedisClientFunction = overrides.getRedisClientFunction ?? jest.fn(async () => redis);
  const executeScript = overrides.executeScript ?? jest.fn(async () => ({ status: 'allowed' }));
  const now = overrides.now ?? (() => 0);
  const ceiling = createTemporarySessionCeiling({
    env: { NODE_ENV: 'test' },
    sourceMode: 'local',
    now,
    telemetry,
    resolveSource,
    secrets,
    deriveIdentity,
    getRedisClientFunction,
    executeScript,
  });
  return {
    ceiling,
    telemetry,
    resolveSource,
    secrets,
    deriveIdentity,
    getRedisClientFunction,
    executeScript,
    redis,
  };
}

describe('temporarySessionCeiling facade', () => {
  it('uses one immutable runtime pair for active identity and Redis in strict order', async () => {
    const order = [];
    const fixture = createFixture({
      resolveSource: jest.fn(() => { order.push('source'); return SOURCE; }),
      secrets: { getRuntimePair: jest.fn(async () => { order.push('secrets'); return RUNTIME_PAIR; }) },
      deriveIdentity: jest.fn((_source, active) => {
        order.push('identity');
        expect(active).toBe(RUNTIME_PAIR.hmac.active);
        return { redisKey: 'synthetic-internal-key' };
      }),
      getRedisClientFunction: jest.fn(async (pair) => {
        order.push('redis-client');
        expect(pair).toBe(RUNTIME_PAIR);
        return { evalsha: jest.fn(), eval: jest.fn() };
      }),
      executeScript: jest.fn(async () => { order.push('script'); return { status: 'allowed' }; }),
    });
    await expect(fixture.ceiling.evaluate({}, { routeVersion: 'v1' })).resolves.toEqual({ allowed: true });
    expect(order).toEqual(['source', 'secrets', 'identity', 'redis-client', 'script']);
    expect(fixture.telemetry.finish).toHaveBeenCalledWith('allowed', undefined, 0);
  });

  it('returns the exact bounded 429 decision', async () => {
    const fixture = createFixture({
      executeScript: jest.fn(async () => ({ status: 'rate_limited', retryAfterSeconds: 17 })),
    });
    await expect(fixture.ceiling.evaluate({}, { routeVersion: 'v2' })).resolves.toEqual({
      allowed: false,
      statusCode: 429,
      reason: 'limit_exceeded',
      retryAfterSeconds: 17,
    });
  });

  it('maps invalid stored state and malformed results to sanitized 503 decisions', async () => {
    const invalidState = createFixture({
      executeScript: jest.fn(async () => ({ status: 'invalid_state' })),
    });
    await expect(invalidState.ceiling.evaluate({}, { routeVersion: 'v1' })).resolves.toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'script_state_invalid',
    });

    const malformed = createFixture({ executeScript: jest.fn(async () => ({ status: 'unknown' })) });
    await expect(malformed.ceiling.evaluate({}, { routeVersion: 'v1' })).resolves.toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'script_result_invalid',
    });
  });

  it('stops before secrets when source resolution fails', async () => {
    const fixture = createFixture({ resolveSource: jest.fn(() => null) });
    await expect(fixture.ceiling.evaluate({}, { routeVersion: 'v1' })).resolves.toMatchObject({
      allowed: false,
      statusCode: 503,
      reason: 'source_unavailable',
    });
    expect(fixture.secrets.getRuntimePair).not.toHaveBeenCalled();
    expect(fixture.getRedisClientFunction).not.toHaveBeenCalled();
    expect(fixture.executeScript).not.toHaveBeenCalled();
  });

  it('stops before identity and Redis when secret acquisition fails', async () => {
    const fixture = createFixture({
      secrets: { getRuntimePair: jest.fn(async () => { throw new Error('synthetic'); }) },
    });
    await expect(fixture.ceiling.evaluate({}, { routeVersion: 'v1' })).resolves.toMatchObject({
      statusCode: 503,
      reason: 'secret_unavailable',
    });
    expect(fixture.deriveIdentity).not.toHaveBeenCalled();
    expect(fixture.getRedisClientFunction).not.toHaveBeenCalled();
  });

  it.each([
    ['identity', { deriveIdentity: jest.fn(() => { throw new Error('synthetic'); }) }, 'identity_unavailable'],
    ['client', { getRedisClientFunction: jest.fn(async () => null) }, 'redis_unavailable'],
    ['script', { executeScript: jest.fn(async () => { throw new Error('synthetic'); }) }, 'redis_uncertain'],
  ])('fails closed for %s uncertainty without returning sensitive data', async (_label, overrides, reason) => {
    const fixture = createFixture(overrides);
    const decision = await fixture.ceiling.evaluate({}, { routeVersion: 'v1' });
    expect(decision).toEqual({ allowed: false, statusCode: 503, reason });
    expect(JSON.stringify(decision)).not.toContain('synthetic-internal-key');
  });

  it('enforces the 3,000 ms complete-limiter deadline before identity work', async () => {
    let clock = 0;
    const fixture = createFixture({
      now: () => clock,
      secrets: { getRuntimePair: jest.fn(async () => {
        clock = TEMPORARY_SESSION_CEILING_DEADLINE_MS;
        return RUNTIME_PAIR;
      }) },
    });
    await expect(fixture.ceiling.evaluate({}, { routeVersion: 'v1' })).resolves.toMatchObject({
      statusCode: 503,
      reason: 'deadline_exceeded',
    });
    expect(fixture.deriveIdentity).not.toHaveBeenCalled();
  });

  it('rejects unknown route labels before all limiter dependencies', async () => {
    const fixture = createFixture();
    await expect(fixture.ceiling.evaluate({}, { routeVersion: 'caller-selected' })).resolves.toMatchObject({
      statusCode: 503,
      reason: 'internal_failure',
    });
    expect(fixture.resolveSource).not.toHaveBeenCalled();
    expect(fixture.secrets.getRuntimePair).not.toHaveBeenCalled();
  });

  it('exposes only identifier-free aggregate snapshots', () => {
    const fixture = createFixture();
    expect(fixture.ceiling.getSnapshot()).toEqual({ telemetry: { total: 0 } });
  });
});
