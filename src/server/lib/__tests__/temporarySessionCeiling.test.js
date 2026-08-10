import {
  TEMPORARY_SESSION_CEILING_LIMIT,
  TEMPORARY_SESSION_CEILING_MAX_ADDRESSES,
  TEMPORARY_SESSION_CEILING_WINDOW_SECONDS,
  createTemporarySessionCeiling,
  normalizeTemporarySessionAddress,
  resolveTemporarySessionSource,
} from '../temporarySessionCeiling.js';

/**
 * Creates a request double with an explicit local socket and safe logger.
 *
 * @param {string|undefined} address - Socket source address.
 * @param {object} [headers] - Request headers.
 * @param {object} [requestLogger] - Optional logger double.
 * @returns {object} Request surface consumed by the ceiling.
 */
function createRequest(address, headers = {}, requestLogger = undefined) {
  return {
    cookies: {},
    headers,
    socket: { remoteAddress: address },
    log: requestLogger,
  };
}

/**
 * Creates a count-only structured logger double.
 *
 * @returns {object} Logger methods used by the ceiling.
 */
function createLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
  };
}

describe('temporarySessionCeiling', () => {
  it('freezes the approved per-instance bounds', () => {
    expect(TEMPORARY_SESSION_CEILING_LIMIT).toBe(400);
    expect(TEMPORARY_SESSION_CEILING_WINDOW_SECONDS).toBe(60);
    expect(TEMPORARY_SESSION_CEILING_MAX_ADDRESSES).toBe(10_000);
  });

  it('allows requests 1-400 and rejects request 401 with Retry-After', () => {
    let nowMs = 10_000;
    const ceiling = createTemporarySessionCeiling({ now: () => nowMs, sourceMode: 'local' });
    const request = createRequest('192.0.2.10');

    for (let index = 0; index < 400; index += 1) {
      expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });
    }

    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({
      allowed: false,
      statusCode: 429,
      reason: 'limit_exceeded',
      retryAfterSeconds: 60,
    });

    nowMs += 59_000;
    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual(
      expect.objectContaining({ statusCode: 429, retryAfterSeconds: 1 })
    );

    nowMs += 1_000;
    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual(
      expect.objectContaining({ statusCode: 429, retryAfterSeconds: 1 })
    );

    nowMs += 1_000;
    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });
  });

  it('keeps independent counters for independent canonical addresses', () => {
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => 20_000,
      sourceMode: 'local',
    });

    expect(ceiling.evaluate(createRequest('192.0.2.1'), { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(createRequest('192.0.2.2'), { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(createRequest('192.0.2.1'), { routeVersion: 'v1' }).statusCode).toBe(429);
  });

  it('shares one counter across v1 and v2 route labels', () => {
    const ceiling = createTemporarySessionCeiling({
      limit: 2,
      now: () => 30_000,
      sourceMode: 'local',
    });
    const request = createRequest('198.51.100.8');

    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(request, { routeVersion: 'v2' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(request, { routeVersion: 'v1' }).statusCode).toBe(429);
  });

  it('counts the same source regardless of cookie contents', () => {
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => 35_000,
      sourceMode: 'local',
    });
    const withCookie = {
      ...createRequest('198.51.100.9'),
      cookies: { session: 'valid-looking-cookie' },
    };
    const withoutCookie = createRequest('198.51.100.9');

    expect(ceiling.evaluate(withCookie, { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(withoutCookie, { routeVersion: 'v1' }).statusCode).toBe(429);
  });

  it.each([
    ['IPv4', '192.0.2.44', '192.0.2.44'],
    ['expanded IPv6', '2001:0DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['mapped dotted IPv6', '::ffff:192.0.2.44', '192.0.2.44'],
    ['mapped hexadecimal IPv6', '::ffff:c000:22c', '192.0.2.44'],
  ])('canonicalizes %s addresses', (_name, input, expected) => {
    expect(normalizeTemporarySessionAddress(input)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    ' 192.0.2.1',
    'example.com',
    '999.1.1.1',
    'fe80::1%eth0',
    [],
  ])('rejects a non-canonical local source: %p', (address) => {
    expect(resolveTemporarySessionSource(createRequest(address), 'local')).toEqual({
      success: false,
      reason: 'source_missing_or_invalid',
    });
  });

  it.each([
    ['IPv4 with port', '198.51.100.10:46532', '198.51.100.10'],
    ['unbracketed IPv6 with port', '2001:0DB8::1:46532', '2001:db8::1'],
    ['bracketed IPv6 with port', '[2001:0DB8::1]:46532', '2001:db8::1'],
  ])('strictly parses deployed %s', (_name, value, expected) => {
    expect(resolveTemporarySessionSource(
      createRequest('10.0.0.1', { 'cloudfront-viewer-address': value }),
      'deployed'
    )).toEqual({ success: true, address: expected });
  });

  it.each([
    ['missing', undefined],
    ['repeated', ['198.51.100.1:1234', '198.51.100.2:1234']],
    ['comma joined', '198.51.100.1:1234,198.51.100.2:1234'],
    ['missing port', '198.51.100.1'],
    ['zero port', '198.51.100.1:0'],
    ['leading-zero port', '198.51.100.1:0123'],
    ['out-of-range port', '198.51.100.1:65536'],
    ['bracketed IPv4', '[198.51.100.1]:1234'],
    ['malformed address', 'not-an-ip:1234'],
  ])('fails closed for a %s deployed source', (_name, value) => {
    const headers = value === undefined ? {} : { 'cloudfront-viewer-address': value };
    expect(resolveTemporarySessionSource(createRequest('10.0.0.1', headers), 'deployed')).toEqual(
      expect.objectContaining({ success: false })
    );
  });

  it('ignores forwarding headers in local mode and buckets only by the socket', () => {
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => 40_000,
      sourceMode: 'local',
    });

    const first = createRequest('203.0.113.7', {
      'cloudfront-viewer-address': '198.51.100.1:12345',
      forwarded: 'for=198.51.100.1',
      'x-forwarded-for': '198.51.100.1',
      'x-real-ip': '198.51.100.1',
    });
    const second = createRequest('203.0.113.7', {
      'cloudfront-viewer-address': '192.0.2.2:54321',
      forwarded: 'for=192.0.2.2',
      'x-forwarded-for': '192.0.2.2',
      'x-real-ip': '192.0.2.2',
    });

    expect(ceiling.evaluate(first, { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(second, { routeVersion: 'v1' }).statusCode).toBe(429);
  });

  it('never falls back to forwarding headers or the origin socket when deployed', () => {
    const ceiling = createTemporarySessionCeiling({
      now: () => 50_000,
      sourceMode: 'deployed',
    });
    const request = createRequest('10.0.0.1', {
      forwarded: 'for=198.51.100.1',
      'x-forwarded-for': '198.51.100.1',
      'x-real-ip': '198.51.100.1',
    });

    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'source_missing_or_repeated',
    });
  });

  it('uses the deployed source policy by default outside local and test runtimes', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalLambdaName = process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.NODE_ENV = 'production';
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;

    try {
      const ceiling = createTemporarySessionCeiling({ now: () => 55_000 });
      expect(ceiling.evaluate(createRequest('10.0.0.1'), { routeVersion: 'v1' }).statusCode).toBe(503);
      expect(ceiling.evaluate(createRequest('10.0.0.1', {
        'cloudfront-viewer-address': '198.51.100.55:12345',
      }), { routeVersion: 'v1' })).toEqual({ allowed: true });
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalLambdaName === undefined) {
        delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      } else {
        process.env.AWS_LAMBDA_FUNCTION_NAME = originalLambdaName;
      }
    }
  });

  it('forces the deployed policy on AWS even if NODE_ENV is development', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalLambdaName = process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.NODE_ENV = 'development';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'preproduction-function';

    try {
      const ceiling = createTemporarySessionCeiling({ now: () => 56_000 });
      expect(ceiling.evaluate(createRequest('10.0.0.1'), { routeVersion: 'v1' }).statusCode).toBe(503);
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalLambdaName === undefined) {
        delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      } else {
        process.env.AWS_LAMBDA_FUNCTION_NAME = originalLambdaName;
      }
    }
  });

  it('cannot select a different deployed bucket with forwarding headers', () => {
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => 57_000,
      sourceMode: 'deployed',
    });
    const first = createRequest('10.0.0.1', {
      'cloudfront-viewer-address': '198.51.100.57:12345',
      'x-forwarded-for': '192.0.2.1',
    });
    const second = createRequest('10.0.0.2', {
      'cloudfront-viewer-address': '198.51.100.57:54321',
      'x-forwarded-for': '192.0.2.2',
    });

    expect(ceiling.evaluate(first, { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(second, { routeVersion: 'v1' }).statusCode).toBe(429);
  });

  it('never evicts a live entry to admit a new address at capacity', () => {
    const ceiling = createTemporarySessionCeiling({
      limit: 2,
      maxAddresses: 2,
      now: () => 60_000,
      sourceMode: 'local',
    });

    expect(ceiling.evaluate(createRequest('192.0.2.1'), { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(createRequest('192.0.2.2'), { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.evaluate(createRequest('192.0.2.3'), { routeVersion: 'v1' })).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'state_capacity',
    });
    expect(ceiling.evaluate(createRequest('192.0.2.1'), { routeVersion: 'v1' })).toEqual({ allowed: true });
    expect(ceiling.getSnapshot().activeEntryCount).toBe(2);
  });

  it('prunes expired entries deterministically on a later request', () => {
    let nowMs = 70_000;
    const requestLogger = createLogger();
    const ceiling = createTemporarySessionCeiling({
      maxAddresses: 1,
      now: () => nowMs,
      sourceMode: 'local',
    });

    expect(ceiling.evaluate(
      createRequest('192.0.2.1', {}, requestLogger),
      { routeVersion: 'v1' }
    )).toEqual({ allowed: true });
    nowMs += 61_000;
    expect(ceiling.evaluate(
      createRequest('192.0.2.2', {}, requestLogger),
      { routeVersion: 'v1' }
    )).toEqual({ allowed: true });
    expect(ceiling.getSnapshot().activeEntryCount).toBe(1);
    expect(requestLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        activeEntryCount: 0,
        expiredEntryCleanupCount: 1,
      }),
      'Temporary session ceiling summary'
    );
  });

  it('uses no cleanup timers', () => {
    const intervalSpy = jest.spyOn(global, 'setInterval');
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const ceiling = createTemporarySessionCeiling({ now: () => 80_000, sourceMode: 'local' });

    ceiling.evaluate(createRequest('192.0.2.1'), { routeVersion: 'v1' });

    expect(intervalSpy).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it('fails closed when the clock is invalid or moves backward', () => {
    let nowMs = 90_000;
    const ceiling = createTemporarySessionCeiling({ now: () => nowMs, sourceMode: 'local' });

    expect(ceiling.evaluate(createRequest('192.0.2.1'), { routeVersion: 'v1' })).toEqual({ allowed: true });
    nowMs = Number.NaN;
    expect(ceiling.evaluate(createRequest('192.0.2.1'), { routeVersion: 'v1' }).statusCode).toBe(503);
    nowMs = 89_000;
    expect(ceiling.evaluate(createRequest('192.0.2.1'), { routeVersion: 'v1' }).statusCode).toBe(503);
    expect(ceiling.getSnapshot().telemetry).toEqual(expect.objectContaining({
      totalChecks: 3,
      allowedChecks: 1,
      rejectedChecks: 2,
      internalFailures: 2,
    }));
  });

  it('fails closed when internal source-mode evaluation throws', () => {
    const ceiling = createTemporarySessionCeiling({
      now: () => 100_000,
      sourceMode: () => {
        throw new Error('sanitized test failure');
      },
    });

    expect(ceiling.evaluate(createRequest('192.0.2.1'), { routeVersion: 'v1' })).toEqual({
      allowed: false,
      statusCode: 503,
      reason: 'internal_failure',
    });
  });

  it('bounds aggregate and sampled rejection logs without identifiers', () => {
    let nowMs = 110_000;
    const requestLogger = createLogger();
    const ceiling = createTemporarySessionCeiling({
      limit: 1,
      now: () => nowMs,
      sourceMode: 'local',
    });
    const request = createRequest('192.0.2.99', {
      cookie: 'session=never-log-this',
      'x-forwarded-for': '203.0.113.99',
    }, requestLogger);

    expect(ceiling.evaluate(request, { routeVersion: 'v1' })).toEqual({ allowed: true });
    for (let index = 0; index < 25; index += 1) {
      expect(ceiling.evaluate(request, { routeVersion: 'v2' }).statusCode).toBe(429);
    }
    expect(requestLogger.warn).toHaveBeenCalledTimes(1);

    nowMs += 60_000;
    ceiling.evaluate(createRequest(undefined, {}, requestLogger), { routeVersion: 'v1' });

    expect(requestLogger.info).toHaveBeenCalledTimes(1);
    expect(requestLogger.warn).toHaveBeenCalledTimes(2);
    const serializedLogs = JSON.stringify({
      info: requestLogger.info.mock.calls,
      warn: requestLogger.warn.mock.calls,
    });
    expect(serializedLogs).not.toContain('192.0.2.99');
    expect(serializedLogs).not.toContain('203.0.113.99');
    expect(serializedLogs).not.toContain('never-log-this');
    expect(serializedLogs).not.toContain('maxAddresses');
    expect(serializedLogs).not.toContain('"limit":');
  });
});
