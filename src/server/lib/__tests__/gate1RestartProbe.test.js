import {
  createGate1RestartProbe,
  GATE1_RESTART_PROBE_HEADER,
  GATE1_RESTART_DIAGNOSTIC_HEADER,
} from '../gate1RestartProbe.js';
import { logger as defaultLogger } from '../../../shared/logger.js';

/** Keep the default-logger wiring test offline and capture only synthetic log calls. */
jest.mock('../../../shared/logger.js', () => ({ logger: { info: jest.fn() } }));

// Synthetic fixture only; hosted credentials are never used by these tests.
const TEST_SECRET = 'a'.repeat(64);
const TEST_AUTHORIZATION = `Bearer ${TEST_SECRET}`;
const ENABLED_PREVIEW = Object.freeze({
  VERCEL: '1',
  VERCEL_ENV: 'preview',
  NODE_ENV: 'production',
  GATE1_RESTART_PROBE_ENABLED: 'true',
  GATE1_RESTART_PROBE_SECRET: TEST_SECRET,
});

/**
 * Returns deterministic runtime observations without reading host configuration.
 * @returns {object} synthetic Node main-thread facts
 */
function readTestRuntime() {
  return { processUptimeMs: 1_234, nodeVersion: 'v22.18.0', isMainThread: true };
}

/**
 * Builds one authenticated request and a header-only response double.
 * @returns {object} isolated request/response plus case-insensitive header storage
 */
function createExchange() {
  const headers = new Map();
  return {
    req: {
      method: 'GET',
      headers: { authorization: TEST_AUTHORIZATION },
      rawHeaders: ['Authorization', TEST_AUTHORIZATION],
    },
    res: { setHeader: jest.fn((name, value) => headers.set(name.toLowerCase(), value)) },
    headers,
  };
}

/**
 * Marks a synthetic exchange for bounded internal outcomes; the marker grants no access.
 * @returns {object} request/response fixture with the public diagnostic marker
 */
function createMarkedExchange() {
  const exchange = createExchange();
  exchange.req.headers[GATE1_RESTART_DIAGNOSTIC_HEADER] = '1';
  exchange.req.rawHeaders.push(GATE1_RESTART_DIAGNOSTIC_HEADER, '1');
  return exchange;
}

/**
 * Creates a probe with observable dependency calls and explicit fake configuration.
 * @param {object} [overrides] per-case environment, randomness, or runtime reader
 * @returns {object} probe and dependency spies for lazy/failure assertions
 */
function createProbe(overrides = {}) {
  const randomBytesFunction = jest.fn(() => Buffer.alloc(12, 1));
  const readRuntime = jest.fn(readTestRuntime);
  const diagnosticLogger = overrides.logger ?? { info: jest.fn() };
  return {
    randomBytesFunction,
    readRuntime,
    diagnosticLogger,
    probe: createGate1RestartProbe({
      env: ENABLED_PREVIEW,
      randomBytesFunction,
      readRuntime,
      logger: diagnosticLogger,
      ...overrides,
    }),
  };
}

/**
 * Exercises the diagnostic boundary without Redis, network traffic, or live secrets.
 */
describe('GATE-1 restart probe', () => {
  /**
   * The observable identity remains stable while process age advances across requests.
   */
  it.each(['preview', 'production'])('returns bounded module-scoped facts in %s', (deploymentEnvironment) => {
    const { probe, readRuntime, randomBytesFunction } = createProbe({
      env: { ...ENABLED_PREVIEW, VERCEL_ENV: deploymentEnvironment },
    });
    const first = createExchange();
    const second = createExchange();
    Object.freeze(first.req.headers);
    Object.freeze(first.req.rawHeaders);
    Object.freeze(first.req);

    probe.attach(first.req, first.res);
    readRuntime.mockReturnValue({ ...readTestRuntime(), processUptimeMs: 2_345 });
    probe.attach(second.req, second.res);

    const firstValue = first.headers.get(GATE1_RESTART_PROBE_HEADER.toLowerCase());
    const secondValue = JSON.parse(second.headers.get(GATE1_RESTART_PROBE_HEADER.toLowerCase()));
    expect(JSON.parse(firstValue)).toEqual({
      schemaVersion: 1,
      contextScope: 'module',
      contextId: '01'.repeat(12),
      ...readTestRuntime(),
    });
    expect(secondValue.contextId).toBe(JSON.parse(firstValue).contextId);
    expect(secondValue.processUptimeMs).toBe(2_345);
    expect(first.res.setHeader.mock.calls[0]).toEqual(['Cache-Control', 'private, no-store']);
    expect(Buffer.byteLength(firstValue)).toBeLessThanOrEqual(256);
    expect(firstValue).not.toContain(TEST_SECRET);
    expect(randomBytesFunction).toHaveBeenCalledTimes(1);
  });

  /**
   * Every deployment/configuration gate must explicitly match before any observation.
   */
  it.each([
    {},
    { ...ENABLED_PREVIEW, VERCEL: undefined },
    { ...ENABLED_PREVIEW, VERCEL: '0' },
    { ...ENABLED_PREVIEW, VERCEL_ENV: 'staging' },
    { ...ENABLED_PREVIEW, VERCEL_ENV: 'development' },
    { ...ENABLED_PREVIEW, VERCEL_ENV: undefined },
    { ...ENABLED_PREVIEW, VERCEL_ENV: 'Production' },
    { ...ENABLED_PREVIEW, VERCEL_ENV: 'production ' },
    { ...ENABLED_PREVIEW, VERCEL_ENV: ['production'] },
    { ...ENABLED_PREVIEW, NODE_ENV: 'test' },
    { ...ENABLED_PREVIEW, NODE_ENV: undefined },
    { ...ENABLED_PREVIEW, GATE1_RESTART_PROBE_ENABLED: undefined },
    { ...ENABLED_PREVIEW, GATE1_RESTART_PROBE_ENABLED: 'false' },
    { ...ENABLED_PREVIEW, GATE1_RESTART_PROBE_ENABLED: 'TRUE' },
    { ...ENABLED_PREVIEW, GATE1_RESTART_PROBE_SECRET: undefined },
    { ...ENABLED_PREVIEW, GATE1_RESTART_PROBE_SECRET: 'a'.repeat(63) },
    { ...ENABLED_PREVIEW, GATE1_RESTART_PROBE_SECRET: 'a'.repeat(65) },
    { ...ENABLED_PREVIEW, GATE1_RESTART_PROBE_SECRET: 'g'.repeat(64) },
    { ...ENABLED_PREVIEW, GATE1_RESTART_PROBE_SECRET: ` ${TEST_SECRET}` },
    { ...ENABLED_PREVIEW, VERCEL_ENV: 'production', GATE1_RESTART_PROBE_ENABLED: undefined },
    { ...ENABLED_PREVIEW, VERCEL_ENV: 'production', GATE1_RESTART_PROBE_ENABLED: 'false' },
    { ...ENABLED_PREVIEW, VERCEL_ENV: 'production', GATE1_RESTART_PROBE_SECRET: undefined },
    { ...ENABLED_PREVIEW, VERCEL_ENV: 'production', GATE1_RESTART_PROBE_SECRET: 'invalid' },
    { ...ENABLED_PREVIEW, VERCEL_ENV: 'production', NODE_ENV: 'development' },
    { ...ENABLED_PREVIEW, VERCEL_ENV: 'production', VERCEL: '0' },
  ])('omits diagnostics for disabled or invalid configuration %#', (env) => {
    const { probe, readRuntime, randomBytesFunction } = createProbe({ env });
    const { req, res } = createExchange();
    probe.attach(req, res);
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(readRuntime).not.toHaveBeenCalled();
    expect(randomBytesFunction).not.toHaveBeenCalled();
  });

  /**
   * Both deployment targets require scalar, exact, bounded credentials.
   */
  it.each([
    undefined, '', TEST_SECRET, [TEST_AUTHORIZATION],
    `Bearer ${'b'.repeat(64)}`, `bearer ${TEST_SECRET}`, `${TEST_AUTHORIZATION} `,
    `${TEST_AUTHORIZATION}, ${TEST_AUTHORIZATION}`, `Bearer ${'a'.repeat(65)}`,
    `Bearer ${'é'.repeat(64)}`, `Bearer ${'A'.repeat(64)}`,
  ])('omits diagnostics for an invalid credential %#', (authorization) => {
    for (const deploymentEnvironment of ['preview', 'production']) {
      const { probe, readRuntime } = createProbe({
        env: { ...ENABLED_PREVIEW, VERCEL_ENV: deploymentEnvironment },
      });
      const { req, res } = createExchange();
      req.headers.authorization = authorization;
      req.rawHeaders = ['Authorization', authorization];
      probe.attach(req, res);
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(readRuntime).not.toHaveBeenCalled();
    }
  });

  /**
   * Neither deployment target accepts raw credentials hidden by Node normalization.
   */
  it.each([
    undefined, {}, [], ['Authorization'],
    ['Authorization', `Bearer ${'b'.repeat(64)}`],
    ['Authorization', TEST_AUTHORIZATION, 'aUtHoRiZaTiOn', TEST_AUTHORIZATION],
    ['Authorization', TEST_AUTHORIZATION, 'Authorization', 'discarded-duplicate'],
    [null, 'invalid-name', 'Authorization', TEST_AUTHORIZATION],
    ['x'.repeat(129), 'invalid-name', 'Authorization', TEST_AUTHORIZATION],
    Array(258).fill('oversized'),
  ])('rejects missing or ambiguous raw metadata %#', (rawHeaders) => {
    for (const deploymentEnvironment of ['preview', 'production']) {
      const { probe } = createProbe({
        env: { ...ENABLED_PREVIEW, VERCEL_ENV: deploymentEnvironment },
      });
      const { req, res } = createExchange();
      req.rawHeaders = rawHeaders;
      probe.attach(req, res);
      expect(res.setHeader).not.toHaveBeenCalled();
    }
  });

  /**
   * Real HTTP header names are case-insensitive and unrelated headers carry no authority.
   */
  it('accepts a single mixed-case raw name with exact normalized agreement', () => {
    const { probe } = createProbe();
    const { req, res, headers } = createExchange();
    req.rawHeaders = ['Host', 'preview.invalid', 'aUtHoRiZaTiOn', TEST_AUTHORIZATION];
    probe.attach(req, res);
    expect(headers.has(GATE1_RESTART_PROBE_HEADER.toLowerCase())).toBe(true);
  });

  /**
   * Bodies, cookies, and query data must never be consumed by the probe.
   */
  it('ignores all non-header credential locations without reading them', () => {
    const { probe } = createProbe();
    const { req, res } = createExchange();
    req.headers = {};
    req.rawHeaders = [];
    const readSensitive = jest.fn(() => { throw new Error('must not read'); });
    for (const property of ['cookies', 'query', 'body']) {
      Object.defineProperty(req, property, { get: readSensitive });
    }
    probe.attach(req, res);
    expect(readSensitive).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  /**
   * Unsupported methods retain their normal route handling and reveal no diagnostics.
   */
  it.each(['POST', 'OPTIONS', 'HEAD', undefined])('ignores method %s', (method) => {
    const { probe, readRuntime } = createProbe();
    const { req, res } = createExchange();
    req.method = method;
    probe.attach(req, res);
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(readRuntime).not.toHaveBeenCalled();
  });

  /**
   * Late observations cannot attempt to mutate an already committed response.
   */
  it.each(['headersSent', 'writableEnded', 'finished'])('ignores a %s response', (flag) => {
    const { probe, readRuntime } = createProbe();
    const { req, res } = createExchange();
    res[flag] = true;
    probe.attach(req, res);
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(readRuntime).not.toHaveBeenCalled();
  });

  /**
   * Invalid runtime facts are omitted rather than coerced into apparent evidence.
   */
  it.each([
    null,
    { ...readTestRuntime(), processUptimeMs: NaN },
    { ...readTestRuntime(), processUptimeMs: Infinity },
    { ...readTestRuntime(), processUptimeMs: -1 },
    { ...readTestRuntime(), processUptimeMs: 0.5 },
    { ...readTestRuntime(), processUptimeMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...readTestRuntime(), nodeVersion: 'unbounded\r\nInjected: value' },
    { ...readTestRuntime(), isMainThread: 'true' },
    { ...readTestRuntime(), unapprovedField: 'provider-payload' },
  ])('omits out-of-contract runtime data %#', (runtime) => {
    const { probe } = createProbe({ readRuntime: () => runtime });
    const { req, res } = createExchange();
    probe.attach(req, res);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  /**
   * Maximum valid values and worker status remain within the fixed header budget.
   */
  it('supports bounded worker observations without claiming a process identity', () => {
    const runtime = {
      processUptimeMs: Number.MAX_SAFE_INTEGER,
      nodeVersion: 'v999.999.999',
      isMainThread: false,
    };
    const { probe } = createProbe({ readRuntime: () => runtime });
    const { req, res, headers } = createExchange();
    probe.attach(req, res);
    const value = headers.get(GATE1_RESTART_PROBE_HEADER.toLowerCase());
    expect(JSON.parse(value)).toMatchObject({ ...runtime, contextScope: 'module' });
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(256);
  });

  /**
   * Failed randomness cannot manufacture an identity or retry into apparent continuity.
   */
  it.each([null, Buffer.alloc(11), 'not-bytes', new Error('random source failed')])(
    'latches failed context initialization %#', (randomResult) => {
      const randomBytesFunction = jest.fn(() => {
        if (randomResult instanceof Error) throw randomResult;
        return randomResult;
      });
      const { probe } = createProbe({ randomBytesFunction });
      const { req, res } = createExchange();
      expect(() => probe.attach(req, res)).not.toThrow();
      probe.attach(req, res);
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(randomBytesFunction).toHaveBeenCalledTimes(1);
    }
  );

  /**
   * Diagnostic failures are observational even when dependencies or response writes throw.
   */
  it('contains runtime and header writer failures without logging', () => {
    const { probe, readRuntime } = createProbe();
    const { req, res } = createExchange();
    readRuntime.mockImplementationOnce(() => { throw new Error('private runtime failure'); });
    expect(() => probe.attach(req, res)).not.toThrow();
    expect(res.setHeader).not.toHaveBeenCalled();
    res.setHeader.mockImplementation(() => { throw new Error('header unavailable'); });
    expect(() => probe.attach(req, res)).not.toThrow();
  });

  /**
   * The default reader reports actual local runtime facts without involving hosted services.
   */
  it('can observe the executing Node runtime through its real reader', () => {
    const probe = createGate1RestartProbe({ env: ENABLED_PREVIEW });
    const { req, res, headers } = createExchange();
    probe.attach(req, res);
    const value = JSON.parse(headers.get(GATE1_RESTART_PROBE_HEADER.toLowerCase()));
    expect(value.nodeVersion).toBe(process.version);
    expect(value.processUptimeMs).toBeGreaterThanOrEqual(0);
    expect(value.processUptimeMs).toBeLessThanOrEqual(Math.floor(process.uptime() * 1_000));
    expect(typeof value.isMainThread).toBe('boolean');
    expect(value.contextId).toMatch(/^[a-f0-9]{24}$/);
  });

  /** A public marker diagnoses rejection internally and never authenticates a request. */
  it.each([
    ['authorization_missing', undefined, []],
    ['authorization_format_invalid', 'invalid', []],
    ['raw_headers_invalid', TEST_AUTHORIZATION, undefined],
    ['raw_headers_invalid', TEST_AUTHORIZATION, ['Authorization']],
    ['raw_headers_invalid', TEST_AUTHORIZATION, Array(258).fill('oversized')],
    ['raw_headers_invalid', TEST_AUTHORIZATION, [null, 'private-value']],
    ['raw_authorization_missing', TEST_AUTHORIZATION, []],
    ['raw_header_mismatch', TEST_AUTHORIZATION, ['Authorization', `Bearer ${'b'.repeat(64)}`]],
    ['raw_authorization_duplicate', TEST_AUTHORIZATION,
      ['Authorization', TEST_AUTHORIZATION, 'authorization', TEST_AUTHORIZATION]],
    ['credential_mismatch', `Bearer ${'b'.repeat(64)}`, ['Authorization', `Bearer ${'b'.repeat(64)}`]],
  ])('records only %s for rejected marked authentication %#', (outcome, authorization, rawHeaders) => {
    const { probe, diagnosticLogger, readRuntime, randomBytesFunction } = createProbe();
    const { req, res } = createMarkedExchange();
    req.headers.authorization = authorization;
    req.rawHeaders = rawHeaders;
    for (let attempt = 0; attempt < 20; attempt += 1) probe.attach(req, res);
    expect(diagnosticLogger.info.mock.calls).toEqual([
      [{ event: 'gate1_restart_probe_outcome', outcome }, 'GATE-1 restart probe diagnostic'],
    ]);
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(readRuntime).not.toHaveBeenCalled();
    expect(randomBytesFunction).not.toHaveBeenCalled();
  });

  /** Unmarked, malformed-marker, disabled, and unsupported requests produce no new log traffic. */
  it.each([undefined, '', '0', 'true', '1, 1', ['1'], '1 '])(
    'does not log an unmarked or ambiguous request %#', (marker) => {
      const { probe, diagnosticLogger } = createProbe();
      const { req, res } = createExchange();
      req.headers[GATE1_RESTART_DIAGNOSTIC_HEADER] = marker;
      probe.attach(req, res);
      expect(diagnosticLogger.info).not.toHaveBeenCalled();
    }
  );

  /** Explicit disablement and method guards apply to logs as well as response observations. */
  it.each([
    ['false', 'GET'], [undefined, 'GET'], ['TRUE', 'GET'], ['true', 'POST'], ['true', 'HEAD'],
  ])('stays silent when disabled or method-rejected %#', (flag, method) => {
    const { probe, diagnosticLogger } = createProbe({
      env: { ...ENABLED_PREVIEW, GATE1_RESTART_PROBE_ENABLED: flag },
    });
    const { req, res } = createMarkedExchange();
    req.method = method;
    probe.attach(req, res);
    expect(diagnosticLogger.info).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  /** Configuration, observation, and response guards report fixed stages without values. */
  it.each([
    ['environment_rejected', { env: { ...ENABLED_PREVIEW, VERCEL_ENV: 'invalid' } }],
    ['secret_format_invalid', { env: { ...ENABLED_PREVIEW, GATE1_RESTART_PROBE_SECRET: 'private-value' } }],
    ['context_unavailable', { randomBytesFunction: jest.fn().mockReturnValue(null) }],
    ['runtime_invalid', { readRuntime: jest.fn().mockReturnValue({ nodeVersion: 'private-value' }) }],
  ])('records %s without leaking rejected data', (outcome, options) => {
    const { probe, diagnosticLogger } = createProbe(options);
    const { req, res } = createMarkedExchange();
    probe.attach(req, res);
    expect(diagnosticLogger.info.mock.calls).toEqual([
      [{ event: 'gate1_restart_probe_outcome', outcome }, 'GATE-1 restart probe diagnostic'],
    ]);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  /** Closed responses never receive headers, and their reason remains private and bounded. */
  it.each(['headersSent', 'writableEnded', 'finished'])('logs a closed %s response once', (property) => {
    const { probe, diagnosticLogger } = createProbe();
    const { req, res } = createMarkedExchange();
    res[property] = true;
    probe.attach(req, res);
    probe.attach(req, res);
    expect(diagnosticLogger.info).toHaveBeenCalledTimes(1);
    expect(diagnosticLogger.info.mock.calls[0][0].outcome).toBe('response_unavailable');
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  /** Outcome deduplication is per kind, while a valid later request still authenticates normally. */
  it('logs distinct outcomes once without retaining request or runtime facts', () => {
    const { probe, diagnosticLogger } = createProbe();
    const missing = createMarkedExchange();
    delete missing.req.headers.authorization;
    const valid = createMarkedExchange();
    valid.req.headers.cookie = 'private-cookie-value';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      probe.attach(missing.req, missing.res);
      probe.attach(valid.req, valid.res);
    }
    expect(diagnosticLogger.info.mock.calls).toEqual([
      [{ event: 'gate1_restart_probe_outcome', outcome: 'authorization_missing' }, 'GATE-1 restart probe diagnostic'],
      [{ event: 'gate1_restart_probe_outcome', outcome: 'header_attached' }, 'GATE-1 restart probe diagnostic'],
    ]);
    expect(valid.headers.has(GATE1_RESTART_PROBE_HEADER.toLowerCase())).toBe(true);
    expect(missing.headers.has(GATE1_RESTART_PROBE_HEADER.toLowerCase())).toBe(false);
  });

  /** Exceptions in the logger neither suppress valid metadata nor create repeated log attempts. */
  it('contains and latches logger failures', () => {
    const logFailure = jest.fn();
    /** Throw a synthetic private error to verify that neither it nor its message escapes. */
    function failLog() { logFailure(); throw new Error('private-logger-failure'); }
    const { probe } = createProbe({ logger: { info: failLog } });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { req, res, headers } = createMarkedExchange();
      expect(() => probe.attach(req, res)).not.toThrow();
      expect(headers.has(GATE1_RESTART_PROBE_HEADER.toLowerCase())).toBe(true);
    }
    expect(logFailure).toHaveBeenCalledTimes(1);
  });

  /** Runtime exceptions produce one static outcome and never expose the thrown payload. */
  it('contains marked observation failures without logging error objects', () => {
    /** Simulate a private provider/runtime exception behind the fixed diagnostic boundary. */
    function failRuntime() { throw new Error('private-runtime-failure'); }
    const { probe, diagnosticLogger } = createProbe({ readRuntime: failRuntime });
    const { req, res } = createMarkedExchange();
    probe.attach(req, res);
    probe.attach(req, res);
    expect(diagnosticLogger.info.mock.calls).toEqual([
      [{ event: 'gate1_restart_probe_outcome', outcome: 'observation_failed' }, 'GATE-1 restart probe diagnostic'],
    ]);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  /** Production code uses the existing logger only after a marked request requests diagnostics. */
  it('uses the default logger with a fixed event payload', () => {
    defaultLogger.info.mockClear();
    const probe = createGate1RestartProbe({ env: ENABLED_PREVIEW });
    const { req, res } = createMarkedExchange();
    probe.attach(req, res);
    expect(defaultLogger.info.mock.calls).toEqual([
      [{ event: 'gate1_restart_probe_outcome', outcome: 'header_attached' }, 'GATE-1 restart probe diagnostic'],
    ]);
  });
});
