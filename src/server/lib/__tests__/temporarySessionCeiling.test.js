import { createHmac as createNodeHmac } from 'node:crypto';
import {
  TEMPORARY_SESSION_CEILING_LIMIT,
  TEMPORARY_SESSION_CEILING_MAX_ADDRESSES,
  TEMPORARY_SESSION_CEILING_SLOT_COUNT,
  TEMPORARY_SESSION_CEILING_WINDOW_SECONDS,
  createTemporarySessionCeiling,
  temporarySessionCeiling,
} from '../temporarySessionCeiling.js';

const FIXED_HMAC_KEY = Buffer.alloc(32, 0x5a);

/**
 * Creates the minimal request surface consumed by the ceiling.
 *
 * @param {unknown} address - Local socket source candidate.
 * @param {object} [options] - Headers, cookies, raw metadata, and logger seams.
 * @returns {object} Request-like test double.
 */
function createRequest(address, options = {}) {
  return {
    cookies: options.cookies ?? {},
    headers: options.headers ?? {},
    rawHeaders: options.rawHeaders ?? [],
    socket: { remoteAddress: address },
    log: options.logger,
  };
}

/**
 * Creates a deployed request with matching normalized and raw viewer headers.
 *
 * @param {unknown} value - Normalized header candidate.
 * @param {object} [options] - Overrides for duplicate/mismatch tests.
 * @returns {object} Request-like test double.
 */
function createDeployedRequest(value, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (value !== undefined) headers['cloudfront-viewer-address'] = value;

  let rawHeaders = options.rawHeaders;
  if (rawHeaders === undefined) {
    rawHeaders = value === undefined
      ? []
      : ['CloudFront-Viewer-Address', typeof value === 'string' ? value : 'invalid'];
  }

  return createRequest(options.socketAddress ?? '10.0.0.1', {
    cookies: options.cookies,
    headers,
    rawHeaders,
    logger: options.logger,
  });
}

/**
 * Creates deterministic synchronous crypto seams using one fixed test key.
 *
 * @param {object} [overrides] - Failure or observation replacements.
 * @returns {object} Factory crypto option.
 */
function createTestCrypto(overrides = {}) {
  return {
    randomBytes: overrides.randomBytes ?? (() => Buffer.from(FIXED_HMAC_KEY)),
    createHmac: overrides.createHmac ?? createNodeHmac,
  };
}

/**
 * Creates a count-only logger double used for privacy and sampling assertions.
 *
 * @returns {object} Request-scoped logger mock.
 */
function createLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
  };
}

/**
 * Sums one observer-exposed entry without exposing it through production APIs.
 *
 * @param {object} entry - Narrow test observer counter entry.
 * @returns {number} Total stored request count.
 */
function sumEntryCounts(entry) {
  let total = 0;
  for (const count of entry.counts) total += count;
  return total;
}

/**
 * Reproduces the approved length framing for a privacy-only digest assertion.
 *
 * @param {object} hmac - Node HMAC instance.
 * @param {string} value - Framed UTF-8 input.
 * @returns {void}
 */
function updateFramedTestValue(hmac, value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  hmac.update(length);
  hmac.update(bytes);
}

/**
 * Derives the known test digest so its absence from public surfaces is proven.
 *
 * @param {'ipv4'|'ipv6'} family - Canonical test address family.
 * @param {string} address - Canonical test address.
 * @returns {string} Expected fixed-key base64url digest.
 */
function deriveExpectedTestDigest(family, address) {
  const hmac = createNodeHmac('sha256', FIXED_HMAC_KEY);
  for (const value of [
    'temporary-session-ceiling:v1',
    'auth-session',
    family,
    address,
  ]) {
    updateFramedTestValue(hmac, value);
  }
  return hmac.digest('base64url');
}

describe('temporarySessionCeiling', () => {
  it('freezes the approved production bounds and singleton surface', () => {
    expect(TEMPORARY_SESSION_CEILING_LIMIT).toBe(400);
    expect(TEMPORARY_SESSION_CEILING_WINDOW_SECONDS).toBe(60);
    expect(TEMPORARY_SESSION_CEILING_SLOT_COUNT).toBe(61);
    expect(TEMPORARY_SESSION_CEILING_MAX_ADDRESSES).toBe(10_000);
    expect(temporarySessionCeiling).toEqual({
      evaluate: expect.any(Function),
      getSnapshot: expect.any(Function),
    });
  });

  it.each([
    ['limit above the approved bound', { limit: TEMPORARY_SESSION_CEILING_LIMIT + 1 }],
    [
      'window above the approved bound',
      { windowSeconds: TEMPORARY_SESSION_CEILING_WINDOW_SECONDS + 1 },
    ],
    [
      'address capacity above the approved bound',
      { maxAddresses: TEMPORARY_SESSION_CEILING_MAX_ADDRESSES + 1 },
    ],
    ['zero limit', { limit: 0 }],
    ['fractional window', { windowSeconds: 1.5 }],
    ['non-finite address capacity', { maxAddresses: Number.POSITIVE_INFINITY }],
    ['negative telemetry window', { telemetryWindowSeconds: -1 }],
  ])('rejects %s at construction', (_description, overrides) => {
    expect(() => createTemporarySessionCeiling({
      ...overrides,
      now: () => 0,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    })).toThrow(TypeError);
  });

  it('rejects a non-callable test entry observer', () => {
    expect(() => createTemporarySessionCeiling({
      now: () => 0,
      sourceMode: 'local',
      crypto: createTestCrypto(),
      testEntryObserver: 'not-callable',
    })).toThrow(TypeError);
  });

  it('allows requests 1-400 and rejects request 401 without incrementing', () => {
    let observedEntry;
    const ceiling = createTemporarySessionCeiling({
      now: () => 0,
      sourceMode: 'local',
      crypto: createTestCrypto(),
      testEntryObserver: (entry) => {
        observedEntry = entry;
      },
    });
    const request = createRequest('192.0.2.10');

    for (let index = 0; index < 400; index += 1) {
      expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });
    }
    expect(sumEntryCounts(observedEntry)).toBe(400);

    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({
      allowed: false,
      statusCode: 429,
      reason: 'limit_exceeded',
      retryAfterSeconds: 60,
    });
    expect(sumEntryCounts(observedEntry)).toBe(400);
  });

  it('keeps Retry-After integer-bounded and conservative through expiry', () => {
    let nowMs = 0;
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const request = createRequest('192.0.2.11');

    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });
    const observations = [];
    for (const second of [1, 30, 59, 60]) {
      nowMs = second * 1000;
      const result = ceiling.evaluate(request, { routeVersion: 'v1' });
      observations.push(result.retryAfterSeconds);
      expect(result.statusCode).toBe(429);
      expect(Number.isInteger(result.retryAfterSeconds)).toBe(true);
      expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
    expect(observations).toEqual([60, 31, 2, 1]);

    nowMs = 61_000;
    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });
  });

  it('prevents the second-0/second-60 physical-slot collision', () => {
    let nowMs = 999;
    const ceiling = createTemporarySessionCeiling({
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const request = createRequest('192.0.2.12');

    for (let index = 0; index < 399; index += 1) {
      expect(ceiling.evaluate(request, { routeVersion: 'v1' }).allowed).toBe(true);
    }
    nowMs = 60_000;
    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });

    let additionallyAllowed = 0;
    for (let index = 0; index < 399; index += 1) {
      if (ceiling.evaluate(request, { routeVersion: 'v1' }).allowed) additionallyAllowed += 1;
    }
    expect(additionallyAllowed).toBe(0);
  });

  it('does not admit two complete bursts less than sixty seconds apart', () => {
    let nowMs = 900;
    const ceiling = createTemporarySessionCeiling({
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const request = createRequest('192.0.2.13');

    for (let index = 0; index < 400; index += 1) {
      expect(ceiling.evaluate(request, { routeVersion: 'v1' }).allowed).toBe(true);
    }
    nowMs = 59_000;
    const earlyBurst = [];
    for (let index = 0; index < 400; index += 1) {
      earlyBurst.push(ceiling.evaluate(request, { routeVersion: 'v1' }));
    }
    expect(earlyBurst.filter((result) => result.allowed)).toHaveLength(0);

    nowMs = 61_000;
    const eligibleBurst = [];
    for (let index = 0; index < 400; index += 1) {
      eligibleBurst.push(ceiling.evaluate(request, { routeVersion: 'v2' }));
    }
    expect(eligibleBurst.filter((result) => result.allowed)).toHaveLength(400);
  });

  it('keeps sources independent while sharing one v1/future-v2 allowance', () => {
    const ceiling = createTemporarySessionCeiling({
      limit: 2,
      now: () => 5_000,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const first = createRequest('192.0.2.21');
    const second = createRequest('192.0.2.22');

    expect(ceiling.evaluate(first, { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(first, { routeVersion: 'v2' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(first, { routeVersion: 'v1' }).statusCode).toBe(429);
    expect(ceiling.evaluate(second, { routeVersion: 'v2' })).toEqual({ allowed: true });
  });

  it.each([
    ['expanded IPv6', '2001:0DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['mapped dotted IPv6', '::ffff:192.0.2.44', '192.0.2.44'],
    ['mapped hexadecimal IPv6', '::ffff:c000:22c', '192.0.2.44'],
  ])('shares one local budget for equivalent %s representations', (_name, first, second) => {
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => 6_000,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });

    expect(ceiling.evaluate(createRequest(first), { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(createRequest(second), { routeVersion: 'v2' }).statusCode).toBe(429);
  });

  it.each([
    undefined,
    '',
    ' 192.0.2.1',
    '192.0.2.1 ',
    'example.com',
    '999.1.1.1',
    'fe80::1%eth0',
    [],
  ])('fails closed for invalid local socket source %p', (address) => {
    const ceiling = createTemporarySessionCeiling({
      now: () => 7_000,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const result = ceiling.evaluate(createRequest(address, {
      headers: {
        'cloudfront-viewer-address': '198.51.100.1:1234',
        forwarded: 'for=198.51.100.1',
        'x-forwarded-for': '198.51.100.1',
        'x-real-ip': '198.51.100.1',
      },
      rawHeaders: ['CloudFront-Viewer-Address', '198.51.100.1:1234'],
    }), { routeVersion: 'v1' });

    expect(result).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'source_unavailable',
    });
  });

  it('uses only the local socket and ignores all forwarding metadata', () => {
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => 8_000,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const first = createRequest('203.0.113.7', {
      headers: { 'x-forwarded-for': '198.51.100.1' },
    });
    const second = createRequest('203.0.113.7', {
      headers: { 'x-forwarded-for': '192.0.2.2' },
    });

    expect(ceiling.evaluate(first, { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(second, { routeVersion: 'v1' }).statusCode).toBe(429);
  });

  it('accepts only exact deployed IPv4 and bracketed IPv6 serializations', () => {
    const ipv4Ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => 9_000,
      sourceMode: 'deployed',
      crypto: createTestCrypto(),
    });
    expect(ipv4Ceiling.evaluate(
      createDeployedRequest('198.51.100.10:46532'),
      { routeVersion: 'v1' }
    )).toEqual({ allowed: true });
    expect(ipv4Ceiling.evaluate(
      createDeployedRequest('198.51.100.10:46533'),
      { routeVersion: 'v2' }
    ).statusCode).toBe(429);

    const ipv6Ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => 9_000,
      sourceMode: 'deployed',
      crypto: createTestCrypto(),
    });
    expect(ipv6Ceiling.evaluate(
      createDeployedRequest('[2001:0DB8:0:0:0:0:0:1]:46532'),
      { routeVersion: 'v1' }
    )).toEqual({ allowed: true });
    expect(ipv6Ceiling.evaluate(
      createDeployedRequest('[2001:db8::1]:46533'),
      { routeVersion: 'v1' }
    ).statusCode).toBe(429);
  });

  it('canonicalizes bracketed mapped IPv6 into the native IPv4 budget', () => {
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => 9_500,
      sourceMode: 'deployed',
      crypto: createTestCrypto(),
    });

    expect(ceiling.evaluate(
      createDeployedRequest('[::ffff:c000:22c]:1234'),
      { routeVersion: 'v1' }
    )).toEqual({ allowed: true });
    expect(ceiling.evaluate(
      createDeployedRequest('192.0.2.44:5678'),
      { routeVersion: 'v2' }
    ).statusCode).toBe(429);
  });

  it.each([
    ['missing', undefined],
    ['comma list', '198.51.100.1:1234,198.51.100.2:1234'],
    ['leading whitespace', ' 198.51.100.1:1234'],
    ['trailing whitespace', '198.51.100.1:1234 '],
    ['missing port', '198.51.100.1'],
    ['zero port', '198.51.100.1:0'],
    ['leading-zero port', '198.51.100.1:0123'],
    ['out-of-range port', '198.51.100.1:65536'],
    ['bracketed IPv4', '[198.51.100.1]:1234'],
    ['unbracketed IPv6', '2001:db8::1:1234'],
    ['IPv6 zone', '[fe80::1%25eth0]:1234'],
    ['hostname', 'example.com:1234'],
    ['malformed address', 'not-an-ip:1234'],
  ])('fails closed for deployed %s input', (_name, value) => {
    const ceiling = createTemporarySessionCeiling({
      now: () => 10_000,
      sourceMode: 'deployed',
      crypto: createTestCrypto(),
    });
    expect(ceiling.evaluate(createDeployedRequest(value), { routeVersion: 'v1' })).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'source_unavailable',
    });
  });

  it.each([
    ['duplicate raw occurrences', {
      value: '198.51.100.1:1234',
      rawHeaders: [
        'CloudFront-Viewer-Address', '198.51.100.1:1234',
        'cloudfront-viewer-address', '198.51.100.1:1234',
      ],
    }],
    ['normalized/raw mismatch', {
      value: '198.51.100.1:1234',
      rawHeaders: ['CloudFront-Viewer-Address', '198.51.100.2:1234'],
    }],
    ['normalized array', {
      value: ['198.51.100.1:1234'],
      rawHeaders: ['CloudFront-Viewer-Address', '198.51.100.1:1234'],
    }],
    ['odd raw metadata', {
      value: '198.51.100.1:1234',
      rawHeaders: ['CloudFront-Viewer-Address'],
    }],
  ])('requires one matching deployed raw-header occurrence: %s', (_name, fixture) => {
    const ceiling = createTemporarySessionCeiling({
      now: () => 11_000,
      sourceMode: 'deployed',
      crypto: createTestCrypto(),
    });
    expect(ceiling.evaluate(
      createDeployedRequest(fixture.value, { rawHeaders: fixture.rawHeaders }),
      { routeVersion: 'v1' }
    ).statusCode).toBe(503);
  });

  it('never falls back to forwarding headers or the deployed origin socket', () => {
    const ceiling = createTemporarySessionCeiling({
      now: () => 12_000,
      sourceMode: 'deployed',
      crypto: createTestCrypto(),
    });
    const request = createRequest('198.51.100.1', {
      headers: {
        forwarded: 'for=198.51.100.1',
        'x-forwarded-for': '198.51.100.1',
        'x-real-ip': '198.51.100.1',
      },
    });

    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'source_unavailable',
    });
  });

  it('does not treat an AWS marker as deployed source-trust proof', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAwsMarker = process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.NODE_ENV = 'development';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'untrusted-test-marker';

    try {
      const ceiling = createTemporarySessionCeiling({
        now: () => 13_000,
        crypto: createTestCrypto(),
      });
      expect(ceiling.evaluate(createRequest('192.0.2.30'), { routeVersion: 'v1' }))
        .toEqual({ allowed: true });
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalAwsMarker === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      else process.env.AWS_LAMBDA_FUNCTION_NAME = originalAwsMarker;
    }
  });

  it('fixes the default deployed policy at factory construction', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const ceiling = createTemporarySessionCeiling({
        now: () => 14_000,
        crypto: createTestCrypto(),
      });
      process.env.NODE_ENV = 'test';
      expect(ceiling.evaluate(createRequest('192.0.2.31'), { routeVersion: 'v1' }).statusCode)
        .toBe(503);
      expect(ceiling.evaluate(
        createDeployedRequest('192.0.2.31:4321'),
        { routeVersion: 'v1' }
      )).toEqual({ allowed: true });
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('rejects invalid route labels without creating a source budget', () => {
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => 15_000,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const request = createRequest('192.0.2.32');

    expect(ceiling.evaluate(request, { routeVersion: 'v3' })).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'route_version_invalid',
    });
    expect(ceiling.getSnapshot().activeEntryCount).toBe(0);
    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });
  });

  it('bounds a null context as an invalid route without throwing or creating state', () => {
    const ceiling = createTemporarySessionCeiling({
      now: () => 15_500,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });

    expect(ceiling.evaluate(createRequest('192.0.2.32'), null)).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'route_version_invalid',
    });
    expect(ceiling.getSnapshot().activeEntryCount).toBe(0);
  });

  it('constructs one random process key and uses HMAC-SHA-256 for lookups', () => {
    const generatedKey = Buffer.alloc(32, 0x31);
    const randomBytesMock = jest.fn(() => generatedKey);
    const createHmacMock = jest.fn(createNodeHmac);
    const ceiling = createTemporarySessionCeiling({
      now: () => 16_000,
      sourceMode: 'local',
      crypto: { randomBytes: randomBytesMock, createHmac: createHmacMock },
    });

    expect(ceiling.evaluate(createRequest('192.0.2.33'), { routeVersion: 'v1' }))
      .toEqual({ allowed: true });
    expect(randomBytesMock).toHaveBeenCalledTimes(1);
    expect(randomBytesMock).toHaveBeenCalledWith(32);
    expect(createHmacMock).toHaveBeenCalledWith('sha256', expect.any(Buffer));
    expect(createHmacMock.mock.calls[0][1]).not.toBe(generatedKey);
    expect(createHmacMock.mock.calls[0][1]).toEqual(generatedKey);
  });

  it.each([
    ['random generation throws', {
      randomBytes: () => { throw new Error('test random failure'); },
      createHmac: createNodeHmac,
    }, 'test random failure'],
    ['random key has wrong length', {
      randomBytes: () => Buffer.alloc(31),
      createHmac: createNodeHmac,
    }, 'temporary session ceiling crypto is unavailable'],
    ['HMAC construction throws', {
      randomBytes: () => Buffer.from(FIXED_HMAC_KEY),
      createHmac: () => { throw new Error('test construction failure'); },
    }, null],
    ['HMAC update throws', {
      randomBytes: () => Buffer.from(FIXED_HMAC_KEY),
      createHmac: () => ({
        update: () => { throw new Error('test update failure'); },
        digest: () => Buffer.alloc(32),
      }),
    }, null],
    ['HMAC digest throws', {
      randomBytes: () => Buffer.from(FIXED_HMAC_KEY),
      createHmac: () => ({
        update: () => undefined,
        digest: () => { throw new Error('test digest failure'); },
      }),
    }, null],
    ['HMAC digest is malformed', {
      randomBytes: () => Buffer.from(FIXED_HMAC_KEY),
      createHmac: () => ({
        update: () => undefined,
        digest: () => Buffer.alloc(31),
      }),
    }, null],
  ])('latches fail-closed after %s', (_name, crypto, constructionFailureReason) => {
    const logger = createLogger();
    const ceiling = createTemporarySessionCeiling({
      now: () => 17_000,
      sourceMode: 'local',
      crypto,
    });
    const request = createRequest('192.0.2.34');

    expect(ceiling.evaluate(request, { routeVersion: 'v1', logger })).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'internal_failure',
    });
    expect(ceiling.evaluate(request, { routeVersion: 'v1', logger }).statusCode).toBe(503);
    expect(ceiling.getSnapshot().activeEntryCount).toBe(0);
    expect(ceiling.getSnapshot().unhealthy).toBe(true);
    expect(ceiling.getSnapshot().telemetry.internalFailures).toBe(2);
    expect(logger.warn.mock.calls.filter(
      ([fields]) => fields.event === 'temporary_session_ceiling_internal_failure_latched'
    )).toEqual([[
      {
        event: 'temporary_session_ceiling_internal_failure_latched',
        outcome: 'unavailable',
        reason: 'internal_failure',
        routeVersion: 'v1',
        ...(constructionFailureReason === null ? {} : { constructionFailureReason }),
      },
      'Temporary session ceiling internal failure latched',
    ]]);
  });

  it.each([
    ['throwing', () => { throw new Error('test clock failure'); }],
    ['non-finite NaN', () => Number.NaN],
    ['non-finite positive infinity', () => Number.POSITIVE_INFINITY],
    ['negative', () => -1],
    ['unsafe', () => Number.MAX_SAFE_INTEGER + 1],
  ])('latches fail-closed for a %s clock', (_name, now) => {
    const ceiling = createTemporarySessionCeiling({
      now,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    expect(ceiling.evaluate(createRequest('192.0.2.35'), { routeVersion: 'v1' }).statusCode)
      .toBe(503);
    expect(ceiling.evaluate(createRequest('192.0.2.36'), { routeVersion: 'v1' }).statusCode)
      .toBe(503);
    expect(ceiling.getSnapshot().activeEntryCount).toBe(0);
  });

  it('detects backward movement at millisecond resolution and stays unhealthy', () => {
    let nowMs = 18_000.75;
    const logger = createLogger();
    const ceiling = createTemporarySessionCeiling({
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const request = createRequest('192.0.2.37', { logger });

    expect(ceiling.getSnapshot().unhealthy).toBe(false);
    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });
    nowMs = 18_000.5;
    expect(ceiling.evaluate(request, { routeVersion: 'v1' }).statusCode).toBe(503);
    expect(ceiling.getSnapshot().unhealthy).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith({
      event: 'temporary_session_ceiling_internal_failure_latched',
      outcome: 'unavailable',
      reason: 'internal_failure',
      routeVersion: 'v1',
    }, 'Temporary session ceiling internal failure latched');
    nowMs = 19_000;
    expect(ceiling.evaluate(request, { routeVersion: 'v1' }).statusCode).toBe(503);
    expect(logger.warn.mock.calls.filter(
      ([fields]) => fields.event === 'temporary_session_ceiling_internal_failure_latched'
    )).toHaveLength(1);
  });

  it('expires state safely after a large forward monotonic movement', () => {
    let nowMs = 0;
    const ceiling = createTemporarySessionCeiling({
      maxAddresses: 1,
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });

    expect(ceiling.evaluate(createRequest('192.0.2.40'), { routeVersion: 'v1' }))
      .toEqual({ allowed: true });
    nowMs = 1_000_000_000_000;
    expect(ceiling.evaluate(createRequest('192.0.2.41'), { routeVersion: 'v1' }))
      .toEqual({ allowed: true });
    expect(ceiling.getSnapshot().activeEntryCount).toBe(1);
    expect(ceiling.getSnapshot().telemetry.expiredEntryCleanupCount).toBe(1);
  });

  it('prunes shape-valid expired entries without scanning stale ring slots', () => {
    let nowMs = 0;
    let observedEntry;
    const ceiling = createTemporarySessionCeiling({
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createTestCrypto(),
      testEntryObserver: (entry) => {
        observedEntry = entry;
      },
    });

    expect(ceiling.evaluate(createRequest('192.0.2.42'), { routeVersion: 'v1' }))
      .toEqual({ allowed: true });
    observedEntry.labels[0] = 1;

    nowMs = 61_000;
    expect(ceiling.evaluate(createRequest('192.0.2.43'), { routeVersion: 'v1' }))
      .toEqual({ allowed: true });
    expect(ceiling.getSnapshot().activeEntryCount).toBe(1);
    expect(ceiling.getSnapshot().telemetry.expiredEntryCleanupCount).toBe(1);
  });

  it.each([
    ['negative', -1],
    ['future', 62],
    ['non-integer', 0.5],
  ])('rejects an expired entry with a %s last-seen timestamp', (_description, invalidTimestamp) => {
    let nowMs = 0;
    let observedEntry;
    const ceiling = createTemporarySessionCeiling({
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createTestCrypto(),
      testEntryObserver: (entry) => {
        observedEntry = entry;
      },
    });

    expect(ceiling.evaluate(createRequest('192.0.2.44'), { routeVersion: 'v1' }))
      .toEqual({ allowed: true });
    observedEntry.lastSeenSecond = invalidTimestamp;

    nowMs = 61_000;
    expect(ceiling.evaluate(createRequest('192.0.2.45'), { routeVersion: 'v1' })).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'internal_failure',
    });
    expect(ceiling.getSnapshot().activeEntryCount).toBe(1);
    expect(ceiling.getSnapshot().telemetry.expiredEntryCleanupCount).toBe(0);
  });

  it('rejects an expired entry with a malformed counter shape', () => {
    let nowMs = 0;
    let observedEntry;
    const ceiling = createTemporarySessionCeiling({
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createTestCrypto(),
      testEntryObserver: (entry) => {
        observedEntry = entry;
      },
    });

    expect(ceiling.evaluate(createRequest('192.0.2.46'), { routeVersion: 'v1' }))
      .toEqual({ allowed: true });
    observedEntry.counts = new Uint16Array(1);

    nowMs = 61_000;
    expect(ceiling.evaluate(createRequest('192.0.2.47'), { routeVersion: 'v1' })).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'internal_failure',
    });
    expect(ceiling.getSnapshot().activeEntryCount).toBe(1);
    expect(ceiling.getSnapshot().telemetry.expiredEntryCleanupCount).toBe(0);
  });

  it('rejects an unseen source at capacity while preserving tracked enforcement', () => {
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      maxAddresses: 2,
      now: () => 20_000,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });

    expect(ceiling.evaluate(createRequest('192.0.2.50'), { routeVersion: 'v1' }).allowed).toBe(true);
    expect(ceiling.evaluate(createRequest('192.0.2.51'), { routeVersion: 'v1' }).allowed).toBe(true);
    expect(ceiling.evaluate(createRequest('192.0.2.52'), { routeVersion: 'v1' })).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'state_capacity',
    });
    expect(ceiling.evaluate(createRequest('192.0.2.50'), { routeVersion: 'v2' }).statusCode)
      .toBe(429);
    expect(ceiling.getSnapshot().activeEntryCount).toBe(2);
  });

  it('runs cleanup at most once per observed monotonic second', () => {
    let nowMs = 21_000;
    const ceiling = createTemporarySessionCeiling({
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });

    for (let index = 0; index < 20; index += 1) {
      ceiling.evaluate(createRequest('192.0.2.60'), { routeVersion: 'v1' });
    }
    expect(ceiling.getSnapshot().pruneScanCount).toBe(1);
    nowMs = 22_000;
    ceiling.evaluate(createRequest('192.0.2.60'), { routeVersion: 'v1' });
    ceiling.evaluate(createRequest('192.0.2.61'), { routeVersion: 'v1' });
    expect(ceiling.getSnapshot().pruneScanCount).toBe(2);
  });

  it('classifies expiry without validating unrelated ring contents', () => {
    let nowMs = 0;
    const observedEntries = [];
    const observer = jest.fn((entry) => {
      observedEntries.push(entry);
    });
    const ceiling = createTemporarySessionCeiling({
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createTestCrypto(),
      testEntryObserver: observer,
    });

    expect(ceiling.evaluate(createRequest('192.0.2.70'), { routeVersion: 'v1' }).allowed).toBe(true);
    nowMs = 59_000;
    expect(ceiling.evaluate(createRequest('192.0.2.71'), { routeVersion: 'v1' }).allowed).toBe(true);
    expect(observer.mock.calls.every((call) => call.length === 1)).toBe(true);
    observedEntries[1].labels[59] = 58;

    nowMs = 61_000;
    expect(ceiling.evaluate(createRequest('192.0.2.72'), { routeVersion: 'v1' }))
      .toEqual({ allowed: true });
    expect(ceiling.getSnapshot().activeEntryCount).toBe(2);
    expect(ceiling.getSnapshot().telemetry.expiredEntryCleanupCount).toBe(1);

    expect(ceiling.evaluate(createRequest('192.0.2.71'), { routeVersion: 'v1' })).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'internal_failure',
    });
    expect(ceiling.evaluate(createRequest('192.0.2.72'), { routeVersion: 'v1' }).statusCode)
      .toBe(503);
  });

  it('latches unhealthy when the currently addressed entry is malformed', () => {
    let observedEntry;
    const ceiling = createTemporarySessionCeiling({
      now: () => 30_000,
      sourceMode: 'local',
      crypto: createTestCrypto(),
      testEntryObserver: (entry) => {
        observedEntry = entry;
      },
    });
    const request = createRequest('192.0.2.73');

    expect(ceiling.evaluate(request, { routeVersion: 'v1' }).allowed).toBe(true);
    observedEntry.counts = new Uint16Array(1);
    expect(ceiling.evaluate(request, { routeVersion: 'v1' }).statusCode).toBe(503);
    expect(ceiling.evaluate(createRequest('192.0.2.74'), { routeVersion: 'v1' }).statusCode)
      .toBe(503);
  });

  it('serializes same-turn Promise.all checks without exceeding the limit', async () => {
    const ceiling = createTemporarySessionCeiling({
      now: () => 31_000,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const request = createRequest('192.0.2.80');
    const pending = Array.from(
      { length: 500 },
      () => Promise.resolve().then(() => ceiling.evaluate(request, { routeVersion: 'v1' }))
    );
    const results = await Promise.all(pending);

    expect(results.filter((result) => result.allowed)).toHaveLength(400);
    expect(results.filter((result) => result.statusCode === 429)).toHaveLength(100);
  });

  it('creates no timers, immediates, or queued microtasks', () => {
    const intervalSpy = jest.spyOn(global, 'setInterval');
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const immediateSpy = jest.spyOn(global, 'setImmediate');
    const microtaskSpy = jest.spyOn(global, 'queueMicrotask');

    try {
      const ceiling = createTemporarySessionCeiling({
        now: () => 32_000,
        sourceMode: 'local',
        crypto: createTestCrypto(),
      });
      ceiling.evaluate(createRequest('192.0.2.81'), { routeVersion: 'v1' });
      expect(intervalSpy).not.toHaveBeenCalled();
      expect(timeoutSpy).not.toHaveBeenCalled();
      expect(immediateSpy).not.toHaveBeenCalled();
      expect(microtaskSpy).not.toHaveBeenCalled();
    } finally {
      intervalSpy.mockRestore();
      timeoutSpy.mockRestore();
      immediateSpy.mockRestore();
      microtaskSpy.mockRestore();
    }
  });

  it('isolates factory state while keeping a production module singleton', () => {
    const first = createTemporarySessionCeiling({
      limit: 1,
      now: () => 33_000,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const second = createTemporarySessionCeiling({
      limit: 1,
      now: () => 33_000,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const request = createRequest('192.0.2.82');

    expect(first.evaluate(request, { routeVersion: 'v1' }).allowed).toBe(true);
    expect(first.evaluate(request, { routeVersion: 'v1' }).statusCode).toBe(429);
    expect(second.evaluate(request, { routeVersion: 'v1' }).allowed).toBe(true);
    expect(temporarySessionCeiling).not.toBe(first);
    expect(temporarySessionCeiling).not.toBe(second);
  });

  it('bounds aggregate logs and exposes only count-based snapshots', () => {
    let nowMs = 34_000;
    const logger = createLogger();
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const request = createRequest('192.0.2.90', { logger });

    expect(ceiling.evaluate(request, { routeVersion: 'v1' }).allowed).toBe(true);
    for (let index = 0; index < 25; index += 1) {
      expect(ceiling.evaluate(request, { routeVersion: 'v2' }).statusCode).toBe(429);
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);

    nowMs = 94_000;
    ceiling.evaluate(request, { routeVersion: 'v1' });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(ceiling.getSnapshot()).toEqual({
      activeEntryCount: 1,
      pruneScanCount: 2,
      unhealthy: false,
      telemetry: {
        totalChecks: 1,
        allowedChecks: 0,
        rejectedChecks: 1,
        sourceResolutionFailures: 0,
        stateCapacityFailures: 0,
        internalFailures: 0,
        expiredEntryCleanupCount: 0,
        routeVersionTotals: { v1: 1, v2: 0, unknown: 0 },
      },
    });
  });

  it('retries rejection sampling until a logger emits successfully', () => {
    const throwingLogger = {
      warn: jest.fn(() => { throw new Error('test warn failure'); }),
    };
    const validLogger = createLogger();
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => 34_500,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });

    expect(ceiling.evaluate(createRequest('192.0.2.89'), { routeVersion: 'v1' }))
      .toEqual({ allowed: true });
    expect(ceiling.evaluate(createRequest('192.0.2.89'), { routeVersion: 'v1' }).statusCode)
      .toBe(429);
    expect(ceiling.evaluate(
      createRequest('192.0.2.89', { logger: throwingLogger }),
      { routeVersion: 'v1' }
    ).statusCode).toBe(429);
    expect(ceiling.evaluate(
      createRequest('192.0.2.89', { logger: validLogger }),
      { routeVersion: 'v1' }
    ).statusCode).toBe(429);
    expect(ceiling.evaluate(
      createRequest('192.0.2.89', { logger: validLogger }),
      { routeVersion: 'v1' }
    ).statusCode).toBe(429);

    expect(throwingLogger.warn).toHaveBeenCalledTimes(1);
    expect(validLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('swallows logger failures without changing enforcement', () => {
    let nowMs = 35_000;
    const logger = {
      info: jest.fn(() => { throw new Error('test info failure'); }),
      warn: jest.fn(() => { throw new Error('test warn failure'); }),
    };
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => nowMs,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const request = createRequest('192.0.2.91', { logger });

    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(request, { routeVersion: 'v1' }).statusCode).toBe(429);
    nowMs = 95_000;
    expect(ceiling.evaluate(request, { routeVersion: 'v1' }).statusCode).toBe(429);
  });

  it('swallows throwing logger property access without changing enforcement', () => {
    const logger = {};
    Object.defineProperties(logger, {
      info: { get: () => { throw new Error('test info getter failure'); } },
      warn: { get: () => { throw new Error('test warn getter failure'); } },
    });
    const request = createRequest('192.0.2.92', { logger });
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => 35_500,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });

    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(request, { routeVersion: 'v1' }).statusCode).toBe(429);
  });

  it('swallows a throwing request logger getter before enforcement', () => {
    const request = createRequest('192.0.2.93');
    Object.defineProperty(request, 'log', {
      get: () => { throw new Error('test request logger getter failure'); },
    });
    const ceiling = createTemporarySessionCeiling({
      now: () => 35_750,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });

    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });
  });

  it('never exposes addresses, digests, auth material, or environment values', () => {
    const environmentMarker = 'never-log-environment-marker';
    const originalMarker = process.env.TEMPORARY_SESSION_CEILING_TEST_MARKER;
    process.env.TEMPORARY_SESSION_CEILING_TEST_MARKER = environmentMarker;
    const logger = createLogger();
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => 36_000,
      sourceMode: 'local',
      crypto: createTestCrypto(),
    });
    const request = createRequest('192.0.2.99', {
      cookies: { session: 'never-log-cookie' },
      headers: {
        authorization: 'Bearer never-log-token',
        'x-forwarded-for': '203.0.113.99',
      },
      logger,
    });

    try {
      const results = [
        ceiling.evaluate(request, { routeVersion: 'v1' }),
        ceiling.evaluate(request, { routeVersion: 'v2' }),
      ];
      const expectedDigest = deriveExpectedTestDigest('ipv4', '192.0.2.99');
      const serialized = JSON.stringify({
        results,
        snapshot: ceiling.getSnapshot(),
        logs: { info: logger.info.mock.calls, warn: logger.warn.mock.calls },
      });

      for (const forbidden of [
        '192.0.2.99',
        '203.0.113.99',
        expectedDigest,
        'never-log-cookie',
        'never-log-token',
        environmentMarker,
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(Object.keys(ceiling.getSnapshot())).toEqual([
        'activeEntryCount',
        'pruneScanCount',
        'unhealthy',
        'telemetry',
      ]);
    } finally {
      if (originalMarker === undefined) {
        delete process.env.TEMPORARY_SESSION_CEILING_TEST_MARKER;
      } else {
        process.env.TEMPORARY_SESSION_CEILING_TEST_MARKER = originalMarker;
      }
    }
  });
});
