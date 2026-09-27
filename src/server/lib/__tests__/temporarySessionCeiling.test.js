import {
  createTemporarySessionCeiling,
  TEMPORARY_SESSION_CEILING_DEADLINE_MS,
} from '../temporarySessionCeiling.js';
import { createTemporarySessionSecrets } from '../temporarySessionSecrets.js';

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

/** Creates the real deployed loader with synthetic values; no transports are used. */
function diagnosticLoader(overrides = {}) {
  return createTemporarySessionSecrets({
    env: { NODE_ENV: 'production', VERCEL: '1', TEMPORARY_SESSION_CEILING_SECRET_MODE: 'vercel',
      TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON: JSON.stringify({ schemaVersion: 1, ...RUNTIME_PAIR.hmac }),
      TEMPORARY_SESSION_CEILING_UPSTASH_JSON: JSON.stringify({ schemaVersion: 1, ...RUNTIME_PAIR.redis }),
      ...overrides },
    onEvent: jest.fn(),
  });
}

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

describe('temporarySessionCeiling secret observations', () => {
  it('does not access the loader after source rejection', async () => {
    const secrets = { getRuntimePair: jest.fn(), getSnapshot: jest.fn(), getDiagnosticSnapshot: jest.fn() };
    const fixture = createFixture({ resolveSource: () => null, secrets });
    const observeSecrets = jest.fn();
    await expect(fixture.ceiling.evaluate({}, { routeVersion: 'v1', observeSecrets }))
      .resolves.toMatchObject({ reason: 'source_unavailable' });
    expect(observeSecrets).toHaveBeenCalledWith(expect.objectContaining({
      sourceResolution: 'rejected', loaderReached: false, loaderStateBefore: null, loader: null,
      identityAttempted: false, redisAttempted: false, scriptAttempted: false,
    }));
    for (const fn of Object.values(secrets)) expect(fn).not.toHaveBeenCalled();
  });

  it('attributes concurrent failures to their own pre-call state and one loader', async () => {
    const secrets = diagnosticLoader({ TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON: undefined });
    const fixture = createFixture({ secrets });
    const first = jest.fn();
    const second = jest.fn();
    await Promise.all([
      fixture.ceiling.evaluate({}, { routeVersion: 'v1', observeSecrets: first }),
      fixture.ceiling.evaluate({}, { routeVersion: 'v1', observeSecrets: second }),
    ]);
    const initial = first.mock.calls[0][0];
    const cached = second.mock.calls[0][0];
    expect(initial.loaderStateBefore).toEqual({ hasCachedPair: false, permanentFailure: false });
    expect(cached.loaderStateBefore).toEqual({ hasCachedPair: false, permanentFailure: true });
    expect(initial.loader).toEqual(cached.loader);
    expect(initial.loader).toMatchObject({ validationAttempts: 1, validationStage: 'hmac', permanentFailure: true });
    expect(initial).toMatchObject({ loaderReached: true, identityAttempted: false,
      redisAttempted: false, scriptAttempted: false, reason: 'secret_unavailable' });
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.loaderStateBefore)).toBe(true);
    expect(Object.isFrozen(initial.loader)).toBe(true);
    expect(fixture.deriveIdentity).not.toHaveBeenCalled();
    expect(fixture.getRedisClientFunction).not.toHaveBeenCalled();
    expect(fixture.executeScript).not.toHaveBeenCalled();
  });

  it('delivers both observer types after enforcement without expanding the source schema', async () => {
    const fixture = createFixture();
    const observeSource = jest.fn();
    const observeSecrets = jest.fn(() => { expect(fixture.executeScript).toHaveBeenCalledTimes(1); });
    await expect(fixture.ceiling.evaluate({}, { routeVersion: 'v1', observeSource, observeSecrets }))
      .resolves.toEqual({ allowed: true });
    expect(observeSecrets).toHaveBeenCalledWith(expect.objectContaining({
      allowed: true, reason: null, loaderReached: true,
      identityAttempted: true, redisAttempted: true, scriptAttempted: true,
    }));
    expect(observeSource).toHaveBeenCalledWith({ effectiveMode: 'local', sourceResolution: 'accepted', canonicalFamily: 4 });
  });

  it.each(['before', 'after', 'observer', 'async observer', 'getter'])(
    'keeps a secret rejection unchanged when %s observation fails', async (where) => {
      const secrets = diagnosticLoader({ TEMPORARY_SESSION_CEILING_UPSTASH_JSON: undefined });
      if (where === 'before') secrets.getSnapshot = () => { throw new Error('before sentinel'); };
      if (where === 'after') secrets.getDiagnosticSnapshot = () => { throw new Error('after sentinel'); };
      const fixture = createFixture({ secrets });
      const observeSecrets = jest.fn(() => {
        if (where === 'observer') throw new Error('observer sentinel');
        if (where === 'async observer') return Promise.reject(new Error('async sentinel'));
      });
      const context = { routeVersion: 'v1', observeSecrets };
      if (where === 'getter') Object.defineProperty(context, 'observeSecrets', { get() { throw new Error('getter'); } });
      await expect(fixture.ceiling.evaluate({}, context)).resolves.toEqual({
        allowed: false, statusCode: 503, reason: 'secret_unavailable',
      });
      expect(fixture.getRedisClientFunction).not.toHaveBeenCalled();
      if (where === 'before') expect(observeSecrets.mock.calls[0][0].loaderStateBefore).toBeNull();
      if (where === 'after') expect(observeSecrets.mock.calls[0][0].loader).toBeNull();
    });

  it('does not initialize diagnostics for an ordinary request', async () => {
    const secrets = diagnosticLoader();
    const before = jest.spyOn(secrets, 'getSnapshot');
    const after = jest.spyOn(secrets, 'getDiagnosticSnapshot');
    await createFixture({ secrets }).ceiling.evaluate({}, { routeVersion: 'v1' });
    expect(before).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'allowed' }, { allowed: true }],
    [{ status: 'rate_limited', retryAfterSeconds: 12 },
      { allowed: false, statusCode: 429, reason: 'limit_exceeded', retryAfterSeconds: 12 }],
  ])('takes the final loader snapshot after the enforcement deadline (%#)', async (result, expected) => {
    let time = 0;
    const secrets = diagnosticLoader();
    const getSnapshot = secrets.getDiagnosticSnapshot;
    secrets.getDiagnosticSnapshot = () => { time = 5000; return getSnapshot(); };
    const fixture = createFixture({ secrets, now: () => time, executeScript: jest.fn(async () => result) });
    const observeSecrets = jest.fn();
    await expect(fixture.ceiling.evaluate({}, { routeVersion: 'v1', observeSecrets })).resolves.toEqual(expected);
    expect(observeSecrets).toHaveBeenCalledTimes(1);
    expect(time).toBe(5000);
  });
});

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

  /**
   * Telemetry failures remain observational for every public decision shape.
   *
   * Why: injected or runtime telemetry faults must not replace an allow, bounded
   * 429, or fail-closed 503 result with a rejected request promise.
   */
  it.each([
    [
      'allowed',
      {},
      { allowed: true },
    ],
    [
      'rate limited',
      { executeScript: jest.fn(async () => ({ status: 'rate_limited', retryAfterSeconds: 17 })) },
      {
        allowed: false,
        statusCode: 429,
        reason: 'limit_exceeded',
        retryAfterSeconds: 17,
      },
    ],
    [
      'unavailable',
      { resolveSource: jest.fn(() => null) },
      { allowed: false, statusCode: 503, reason: 'source_unavailable' },
    ],
  ])('preserves the %s decision when every telemetry hook throws', async (_label, overrides, expected) => {
    const telemetryError = new Error('synthetic telemetry failure');
    const telemetry = {
      record: jest.fn(() => { throw telemetryError; }),
      finish: jest.fn(() => { throw telemetryError; }),
      maybeRotate: jest.fn(() => { throw telemetryError; }),
      getSnapshot: jest.fn(() => ({ total: 0 })),
    };
    const fixture = createFixture({ ...overrides, telemetry });

    await expect(fixture.ceiling.evaluate({}, { routeVersion: 'v1' })).resolves.toEqual(expected);
    expect(telemetry.maybeRotate).toHaveBeenCalledTimes(1);
    expect(telemetry.finish).toHaveBeenCalledTimes(1);
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

  /**
   * The post-client deadline decision uses one monotonic clock observation.
   *
   * Why: the failure reason and telemetry event must describe the same deadline
   * state rather than being selected from separate injected clock reads.
   */
  it('evaluates the deadline once after acquiring the Redis client', async () => {
    const now = jest.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(TEMPORARY_SESSION_CEILING_DEADLINE_MS)
      .mockReturnValue(TEMPORARY_SESSION_CEILING_DEADLINE_MS);
    const fixture = createFixture({ now });

    await expect(fixture.ceiling.evaluate({}, { routeVersion: 'v1' })).resolves.toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'deadline_exceeded',
    });
    expect(now).toHaveBeenCalledTimes(4);
    expect(fixture.executeScript).not.toHaveBeenCalled();
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
