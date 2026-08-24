import {
  createTemporarySessionSecrets,
  parseTemporarySessionHmacSecret,
  parseTemporarySessionRedisSecret,
  resolveTemporarySessionSecretMode,
} from '../temporarySessionSecrets.js';

const KEY_ONE = Buffer.alloc(32, 1).toString('base64url');
const KEY_TWO = Buffer.alloc(32, 2).toString('base64url');

/**
 * Builds a strict synthetic HMAC secret fixture.
 *
 * @param {object} active active key fields
 * @param {object|null} previous previous key fields
 * @returns {object} strict keyring payload
 */
function hmacSecret(active = { generation: 1, keyId: 'gate1-key-1', key: KEY_ONE }, previous = null) {
  return { schemaVersion: 1, active, previous };
}

/**
 * Builds a strict synthetic Redis secret fixture.
 *
 * @param {string} token synthetic token value
 * @returns {object} strict Redis payload
 */
function redisSecret(token = 'synthetic-token-one') {
  return { schemaVersion: 1, url: 'https://synthetic-gate1.upstash.io', token };
}

/**
 * Creates a deferred promise used to observe secret single-flight behavior.
 *
 * @returns {{promise: Promise<unknown>, resolve: Function, reject: Function}} deferred
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
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
    expect(() => parseTemporarySessionRedisSecret('{')).toThrow();
    expect(() => parseTemporarySessionRedisSecret('x'.repeat(8_193))).toThrow();
  });

  it('requires Secrets Manager in production', () => {
    expect(resolveTemporarySessionSecretMode({
      env: { NODE_ENV: 'production', TEMPORARY_SESSION_CEILING_SECRET_MODE: 'aws-secrets-manager' },
    })).toBe('aws-secrets-manager');
    expect(resolveTemporarySessionSecretMode({
      env: { NODE_ENV: 'production', TEMPORARY_SESSION_CEILING_SECRET_MODE: 'local' },
    })).toBeNull();
  });
});

describe('temporarySessionSecrets runtime cache', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('loads on first use, caches for less than 60 seconds, and atomically swaps both secrets', async () => {
    let clock = 0;
    let payloads = { hmacSecret: hmacSecret(), redisSecret: redisSecret() };
    const provider = jest.fn(() => payloads);
    const loader = createTemporarySessionSecrets({
      mode: 'local',
      env: { NODE_ENV: 'test' },
      now: () => clock,
      localSecretProvider: provider,
      onEvent: jest.fn(),
    });

    const first = await loader.getRuntimePair({ deadlineAt: 3_000 });
    clock = 59_999;
    expect(await loader.getRuntimePair({ deadlineAt: 62_999 })).toBe(first);
    expect(provider).toHaveBeenCalledTimes(1);

    payloads = {
      hmacSecret: hmacSecret(
        { generation: 2, keyId: 'gate1-key-2', key: KEY_TWO },
        { generation: 1, keyId: 'gate1-key-1', key: KEY_ONE }
      ),
      redisSecret: redisSecret('synthetic-token-two'),
    };
    clock = 60_000;
    const second = await loader.getRuntimePair({ deadlineAt: 63_000 });
    expect(second).not.toBe(first);
    expect(second.hmac.active.generation).toBe(2);
    expect(second.redis.token).toBe('synthetic-token-two');
    expect(Object.isFrozen(second)).toBe(true);
  });

  it('enforces the 62-second bridge drain clock before removing previous', async () => {
    let clock = 0;
    let payloads = {
      hmacSecret: hmacSecret(
        { generation: 2, keyId: 'gate1-key-2', key: KEY_TWO },
        { generation: 1, keyId: 'gate1-key-1', key: KEY_ONE }
      ),
      redisSecret: redisSecret(),
    };
    const loader = createTemporarySessionSecrets({
      mode: 'local',
      env: { NODE_ENV: 'test' },
      now: () => clock,
      localSecretProvider: () => payloads,
      onEvent: jest.fn(),
    });
    await loader.getRuntimePair({ deadlineAt: 3_000 });

    payloads = { hmacSecret: hmacSecret(
      { generation: 2, keyId: 'gate1-key-2', key: KEY_TWO },
      null
    ), redisSecret: redisSecret() };
    clock = 60_000;
    await expect(loader.getRuntimePair({ deadlineAt: 63_000 })).rejects.toThrow(
      'temporary session secrets are unavailable'
    );

    clock = 65_000;
    await expect(loader.getRuntimePair({ deadlineAt: 68_000 })).resolves.toMatchObject({
      hmac: { active: { generation: 2 }, previous: null },
    });
  });

  it('deduplicates concurrent AWS reads under one shared abort signal', async () => {
    const firstRead = deferred();
    const secondRead = deferred();
    const send = jest.fn()
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(() => secondRead.promise);
    const loader = createTemporarySessionSecrets({
      mode: 'aws-secrets-manager',
      env: {
        NODE_ENV: 'test',
        TEMPORARY_SESSION_CEILING_HMAC_SECRET_ID: 'synthetic-hmac-resource',
        TEMPORARY_SESSION_CEILING_REDIS_SECRET_ID: 'synthetic-redis-resource',
      },
      now: () => 0,
      awsClient: { send },
      onEvent: jest.fn(),
    });

    const first = loader.getRuntimePair({ deadlineAt: 3_000 });
    const second = loader.getRuntimePair({ deadlineAt: 3_000 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][1].abortSignal).toBe(send.mock.calls[1][1].abortSignal);
    firstRead.resolve({ SecretString: JSON.stringify(hmacSecret()) });
    secondRead.resolve({ SecretString: JSON.stringify(redisSecret()) });
    const [firstPair, secondPair] = await Promise.all([first, second]);
    expect(secondPair).toBe(firstPair);
  });

  it('starts cooldown after failure and never returns the expired pair', async () => {
    let clock = 0;
    const send = jest.fn()
      .mockResolvedValueOnce({ SecretString: JSON.stringify(hmacSecret()) })
      .mockResolvedValueOnce({ SecretString: JSON.stringify(redisSecret()) })
      .mockRejectedValue(new Error('synthetic provider failure'));
    const loader = createTemporarySessionSecrets({
      mode: 'aws-secrets-manager',
      env: {
        NODE_ENV: 'test',
        TEMPORARY_SESSION_CEILING_HMAC_SECRET_ID: 'synthetic-hmac-resource',
        TEMPORARY_SESSION_CEILING_REDIS_SECRET_ID: 'synthetic-redis-resource',
      },
      now: () => clock,
      awsClient: { send },
      onEvent: jest.fn(),
    });
    await loader.getRuntimePair({ deadlineAt: 3_000 });
    clock = 60_000;
    await expect(loader.getRuntimePair({ deadlineAt: 63_000 })).rejects.toThrow();
    const callsAfterFailure = send.mock.calls.length;
    clock = 60_100;
    await expect(loader.getRuntimePair({ deadlineAt: 63_100 })).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(callsAfterFailure);
  });

  it('aborts both AWS reads at the shared one-second deadline', async () => {
    jest.useFakeTimers();
    let clock = 0;
    const send = jest.fn((_command, { abortSignal }) => new Promise((_, reject) => {
      abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const loader = createTemporarySessionSecrets({
      mode: 'aws-secrets-manager',
      env: {
        NODE_ENV: 'test',
        TEMPORARY_SESSION_CEILING_HMAC_SECRET_ID: 'synthetic-hmac-resource',
        TEMPORARY_SESSION_CEILING_REDIS_SECRET_ID: 'synthetic-redis-resource',
      },
      now: () => clock,
      awsClient: { send },
      onEvent: jest.fn(),
    });
    const result = loader.getRuntimePair({ deadlineAt: 3_000 });
    const rejection = expect(result).rejects.toThrow('temporary session secrets are unavailable');
    clock = 1_000;
    await jest.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(send.mock.calls[0][1].abortSignal.aborted).toBe(true);
    expect(send.mock.calls[1][1].abortSignal.aborted).toBe(true);
  });
});
