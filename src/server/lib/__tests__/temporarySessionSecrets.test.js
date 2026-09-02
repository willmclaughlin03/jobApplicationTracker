import {
  createTemporarySessionSecrets,
  parseTemporarySessionHmacSecret,
  parseTemporarySessionRedisSecret,
  resolveTemporarySessionSecretMode,
} from '../temporarySessionSecrets.js';

const KEY_ONE = Buffer.alloc(32, 1).toString('base64url');
const KEY_TWO = Buffer.alloc(32, 2).toString('base64url');

/**
 * Builds a strict synthetic HMAC configuration fixture.
 *
 * @param {object} active active key fields
 * @param {object|null} previous previous key fields
 * @returns {object} strict keyring payload
 */
function hmacSecret(active = { generation: 1, keyId: 'gate1-key-1', key: KEY_ONE }, previous = null) {
  return { schemaVersion: 1, active, previous };
}

/**
 * Builds a strict synthetic Redis configuration fixture.
 *
 * @param {string} token synthetic token value
 * @returns {object} strict Redis payload
 */
function redisSecret(token = 'synthetic-token-one') {
  return { schemaVersion: 1, url: 'https://synthetic-gate1.upstash.io', token };
}

/**
 * Builds an explicit Vercel runtime environment with both JSON values.
 *
 * @param {object} [overrides] environment overrides
 * @returns {object} isolated environment snapshot
 */
function vercelEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    VERCEL: '1',
    TEMPORARY_SESSION_CEILING_SECRET_MODE: 'vercel',
    TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON: JSON.stringify(hmacSecret()),
    TEMPORARY_SESSION_CEILING_UPSTASH_JSON: JSON.stringify(redisSecret()),
    ...overrides,
  };
}

describe('temporarySessionSecrets schemas', () => {
  it('accepts one steady generation and one adjacent bridge pair', () => {
    expect(parseTemporarySessionHmacSecret(hmacSecret()).active.generation).toBe(1);
    expect(parseTemporarySessionHmacSecret(hmacSecret(
      { generation: 2, keyId: 'gate1-key-2', key: KEY_TWO },
      { generation: 1, keyId: 'gate1-key-1', key: KEY_ONE }
    )).previous.generation).toBe(1);
  });

  it.each([
    hmacSecret({ generation: 3, keyId: 'gate1-key-3', key: KEY_TWO }),
    hmacSecret(
      { generation: 2, keyId: 'gate1-key-2', key: KEY_TWO },
      { generation: 0, keyId: 'gate1-key-1', key: KEY_ONE }
    ),
    hmacSecret(
      { generation: 2, keyId: 'same-id', key: KEY_TWO },
      { generation: 1, keyId: 'same-id', key: KEY_ONE }
    ),
    { ...hmacSecret(), extra: true },
  ])('rejects unknown, mismatched, or non-strict keyrings', (payload) => {
    expect(() => parseTemporarySessionHmacSecret(payload)).toThrow(
      'temporary session secrets are unavailable'
    );
  });

  it.each([
    { ...redisSecret(), extra: true },
    { ...redisSecret(), url: 'http://synthetic-gate1.upstash.io' },
    { ...redisSecret(), url: 'https://user:password@synthetic-gate1.upstash.io' },
    { ...redisSecret(), url: 'https://redis.example.test' },
    { ...redisSecret(), url: 'https://synthetic-gate1.upstash.io/path' },
    { ...redisSecret(), token: '' },
  ])('rejects malformed or non-Upstash Redis payloads', (payload) => {
    expect(() => parseTemporarySessionRedisSecret(payload)).toThrow(
      'temporary session secrets are unavailable'
    );
  });

  it('rejects malformed and oversized JSON payloads', () => {
    expect(() => parseTemporarySessionRedisSecret('{')).toThrow(
      'temporary session secrets are unavailable'
    );
    expect(() => parseTemporarySessionRedisSecret('x'.repeat(8_193))).toThrow(
      'temporary session secrets are unavailable'
    );
  });

  it('requires explicit Vercel mode and a consistent runtime marker', () => {
    expect(resolveTemporarySessionSecretMode({ env: vercelEnvironment() })).toBe('vercel');
    expect(resolveTemporarySessionSecretMode({
      env: { NODE_ENV: 'production', TEMPORARY_SESSION_CEILING_SECRET_MODE: 'vercel' },
    })).toBeNull();
    expect(resolveTemporarySessionSecretMode({
      env: { NODE_ENV: 'production', VERCEL: '1', TEMPORARY_SESSION_CEILING_SECRET_MODE: 'local' },
    })).toBeNull();
    expect(resolveTemporarySessionSecretMode({
      env: { NODE_ENV: 'test', VERCEL: '1', TEMPORARY_SESSION_CEILING_SECRET_MODE: 'vercel' },
    })).toBeNull();
    expect(resolveTemporarySessionSecretMode({ env: { NODE_ENV: 'production' } })).toBeNull();
  });
});

describe('temporarySessionSecrets instance cache', () => {
  it('atomically freezes both Vercel values and emits configuration success once', async () => {
    const env = vercelEnvironment();
    const onEvent = jest.fn();
    const loader = createTemporarySessionSecrets({ env, onEvent });

    const [first, second] = await Promise.all([
      loader.getRuntimePair(),
      loader.getRuntimePair(),
    ]);

    expect(second).toBe(first);
    expect(first).toMatchObject({
      hmac: { active: { generation: 1, keyId: 'gate1-key-1' }, previous: null },
      redis: { url: 'https://synthetic-gate1.upstash.io', token: 'synthetic-token-one' },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.hmac)).toBe(true);
    expect(Object.isFrozen(first.redis)).toBe(true);
    expect(Object.isFrozen(first.cacheIdentity)).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith('configurationSucceeded');
    expect(loader.getSnapshot()).toEqual({ hasCachedPair: true, permanentFailure: false });
  });

  it('ignores environment changes after success until the test reset seam runs', async () => {
    const env = vercelEnvironment();
    const loader = createTemporarySessionSecrets({ env, onEvent: jest.fn() });
    const first = await loader.getRuntimePair();

    env.TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON = JSON.stringify(hmacSecret(
      { generation: 2, keyId: 'gate1-key-2', key: KEY_TWO },
      { generation: 1, keyId: 'gate1-key-1', key: KEY_ONE }
    ));
    env.TEMPORARY_SESSION_CEILING_UPSTASH_JSON = JSON.stringify(
      redisSecret('synthetic-token-two')
    );

    expect(await loader.getRuntimePair()).toBe(first);
    loader.reset();
    await expect(loader.getRuntimePair()).resolves.toMatchObject({
      hmac: { active: { generation: 2 }, previous: { generation: 1 } },
      redis: { token: 'synthetic-token-two' },
    });
  });

  it('memoizes one sanitized permanent failure and never falls back to standalone Redis values', async () => {
    const secretSentinel = 'never-emit-this-config-sentinel';
    const env = vercelEnvironment({
      TEMPORARY_SESSION_CEILING_UPSTASH_JSON: `{"schemaVersion":1,"token":"${secretSentinel}"}`,
      UPSTASH_REDIS_REST_URL: 'https://fallback.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'standalone-fallback-token',
    });
    const onEvent = jest.fn();
    const loader = createTemporarySessionSecrets({ env, onEvent });

    const firstError = await loader.getRuntimePair().catch((error) => error);
    env.TEMPORARY_SESSION_CEILING_UPSTASH_JSON = JSON.stringify(redisSecret('corrected-token'));
    const secondError = await loader.getRuntimePair().catch((error) => error);

    expect(firstError).toMatchObject({
      name: 'TemporarySessionSecretsUnavailableError',
      message: 'temporary session secrets are unavailable',
    });
    expect(secondError).toMatchObject({
      name: 'TemporarySessionSecretsUnavailableError',
      message: 'temporary session secrets are unavailable',
    });
    expect(onEvent.mock.calls).toEqual([['configurationFailed']]);
    expect(loader.getSnapshot()).toEqual({ hasCachedPair: false, permanentFailure: true });
    expect(JSON.stringify({
      firstError: { name: firstError.name, message: firstError.message },
      secondError: { name: secondError.name, message: secondError.message },
      renderedErrors: [String(firstError), firstError.stack, String(secondError), secondError.stack],
      events: onEvent.mock.calls,
      snapshot: loader.getSnapshot(),
    })).not.toContain(secretSentinel);

    loader.reset();
    await expect(loader.getRuntimePair()).resolves.toMatchObject({
      redis: { token: 'corrected-token' },
    });
  });

  it('keeps local fixtures instance-stable and reloads them only after reset', async () => {
    let payloads = { hmacSecret: hmacSecret(), redisSecret: redisSecret() };
    const provider = jest.fn(() => payloads);
    const loader = createTemporarySessionSecrets({
      mode: 'local',
      env: { NODE_ENV: 'test' },
      localSecretProvider: provider,
      onEvent: jest.fn(),
    });
    const first = await loader.getRuntimePair();
    payloads = {
      hmacSecret: hmacSecret(
        { generation: 2, keyId: 'gate1-key-2', key: KEY_TWO },
        { generation: 1, keyId: 'gate1-key-1', key: KEY_ONE }
      ),
      redisSecret: redisSecret('synthetic-token-two'),
    };

    expect(await loader.getRuntimePair()).toBe(first);
    expect(provider).toHaveBeenCalledTimes(1);
    loader.reset();
    await expect(loader.getRuntimePair()).resolves.toMatchObject({
      hmac: { active: { generation: 2 } },
      redis: { token: 'synthetic-token-two' },
    });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('installs no partial pair when either deployed value is missing', async () => {
    for (const missingName of [
      'TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON',
      'TEMPORARY_SESSION_CEILING_UPSTASH_JSON',
    ]) {
      const env = vercelEnvironment();
      delete env[missingName];
      const loader = createTemporarySessionSecrets({ env, onEvent: jest.fn() });

      await expect(loader.getRuntimePair()).rejects.toThrow(
        'temporary session secrets are unavailable'
      );
      expect(loader.getSnapshot()).toEqual({ hasCachedPair: false, permanentFailure: true });
    }
  });
});
