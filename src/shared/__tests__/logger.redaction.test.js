/**
 * Redaction verification tests for the Pino logger
 *
 * Purpose: Ensure all sensitive fields defined in the logger's redact config
 * are properly censored in log output. Prevents accidental removal of
 * redaction paths during future refactors.
 *
 * Connects to: src/shared/logger.js (application singleton and request children)
 *
 * Test coverage:
 * - password field is redacted
 * - access_token field is redacted
 * - refresh_token field is redacted
 * - req.headers.authorization is redacted
 * - req.headers.cookie is redacted
 * - req.headers["stripe-signature"] is redacted
 * - headers["stripe-signature"] is redacted
 * - err.headers["stripe-signature"] is redacted
 * - err.request.headers["stripe-signature"] is redacted
 * - err.body is redacted
 * - err.rawBody is redacted
 * - err.config.headers.authorization is redacted
 * - err.config.headers.cookie is redacted
 * - Non-sensitive sibling fields are preserved
 * - Runtime hostname is omitted from singleton, child and fallback JSON output
 */

const pino = require('pino');
const { PassThrough } = require('stream');
const { createTemporarySessionTelemetry } = require('../../server/lib/temporarySessionTelemetry.js');

/**
 * Loads the real application logger with deterministic environment settings.
 * Only destination/transport creation is intercepted; real Pino serializes the
 * application's options to memory. mode/axiom select configuration branches;
 * failTransport exercises fallback without starting workers or sending logs.
 * Returns application exports, attempted options and the last parsed log entry.
 * Environment and the module mock are restored even if initialization throws.
 */
function createTestLogger({ mode = 'production', axiom = false, failTransport = false } = {}) {
  const stream = new PassThrough();
  const attemptedOptions = [];
  const originalEnv = process.env;
  let lastLine = '';
  let application;

  stream.on('data', (chunk) => {
    lastLine = chunk.toString().trim();
  });

  process.env = {
    ...originalEnv,
    NODE_ENV: mode,
    AXIOM_DATASET: axiom ? 'synthetic-dataset' : '',
    AXIOM_TOKEN: axiom ? 'synthetic-token' : '',
  };
  try {
    // Intercept the I/O boundary, keeping application-selected bindings/redaction.
    jest.doMock('pino', () => (options) => {
      attemptedOptions.push(options);
      if (failTransport && options.transport) throw new Error('synthetic transport failure');
      const { transport, ...jsonOptions } = options;
      return pino(jsonOptions, stream);
    });
    jest.isolateModules(() => {
      application = require('../logger.js');
    });
  } finally {
    process.env = originalEnv;
    jest.dontMock('pino');
  }

  return {
    ...application,
    attemptedOptions,
    getOutput: () => JSON.parse(lastLine),
  };
}

describe('Application logger runtime privacy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    { label: 'production stdout', mode: 'production', axiom: false, failTransport: false },
    { label: 'production transport input', mode: 'production', axiom: true, failTransport: false },
    { label: 'production fallback', mode: 'production', axiom: true, failTransport: true },
    { label: 'development transport input', mode: 'development', axiom: false, failTransport: false },
    { label: 'development fallback', mode: 'development', axiom: false, failTransport: true },
  ])('omits hostname and preserves redaction/correlation in $label', (settings) => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { logger, attachRequestLogger, attemptedOptions, getOutput } = createTestLogger(settings);
    const secret = 'synthetic-private-value';

    logger.info({ event: 'synthetic_event', password: secret }, 'singleton');
    const singleton = getOutput();
    expect(Object.hasOwn(singleton, 'hostname')).toBe(false);
    expect(singleton).toMatchObject({
      pid: process.pid, event: 'synthetic_event', password: '[REDACTED]', msg: 'singleton',
    });

    const req = {};
    const requestId = attachRequestLogger(req);
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    req.log.info({ req: { headers: { authorization: secret }, rawHeaders: [secret] },
      statusCode: 503, durationMs: 1 }, 'request');
    const child = getOutput();
    expect(Object.hasOwn(child, 'hostname')).toBe(false);
    expect(child).toMatchObject({
      pid: process.pid, requestId, statusCode: 503, durationMs: 1, msg: 'request',
      req: { headers: { authorization: '[REDACTED]' }, rawHeaders: '[REDACTED]' },
    });
    expect(JSON.stringify(child)).not.toContain(secret);

    expect(attemptedOptions).toHaveLength(settings.failTransport ? 2 : 1);
    if (settings.axiom || settings.mode === 'development') {
      expect(attemptedOptions[0].transport.target).toBe(
        settings.axiom ? '@axiomhq/pino' : 'pino-pretty'
      );
    }
    if (settings.failTransport) {
      expect(attemptedOptions[1]).not.toHaveProperty('transport');
      expect(stderr).toHaveBeenCalledTimes(1);
    } else {
      expect(stderr).not.toHaveBeenCalled();
    }
  });

  it('serializes the limiter summary without hostname and retains aggregate attribution', () => {
    const { attachRequestLogger, getOutput } = createTestLogger();
    const req = {};
    const requestId = attachRequestLogger(req);
    let clock = 0;
    const telemetry = createTemporarySessionTelemetry({
      now: () => clock,
      randomBytesFunction: () => Buffer.alloc(12, 1),
      env: { VERCEL_GIT_COMMIT_SHA: 'synthetic-sha', VERCEL_DEPLOYMENT_ID: 'dpl_synthetic' },
    });
    telemetry.record('configurationFailed');
    telemetry.finish('unavailable', 'secret_unavailable', 1);
    clock = 60_000;
    telemetry.maybeRotate(req.log);
    const summary = getOutput();
    expect(Object.hasOwn(summary, 'hostname')).toBe(false);
    expect(summary).toMatchObject({
      pid: process.pid, requestId, event: 'temporary_session_ceiling_summary',
      reportingWindowMs: 60_000, total: 1,
      attribution: { buildId: 'synthetic-sha', deploymentId: 'dpl_synthetic' },
      events: { configurationFailed: 1, unavailable: 1 },
      reasons: { secret_unavailable: 1 }, durations: { lt50: 1 },
    });
  });
});

describe('Logger redaction config', () => {
  let logger;
  let getOutput;

  beforeEach(() => {
    ({ logger, getOutput } = createTestLogger());
  });

  it('should redact password field', () => {
    logger.info({ password: 'super-secret-password' }, 'test');
    const output = getOutput();
    expect(output.password).toBe('[REDACTED]');
  });

  it('should redact access_token field', () => {
    logger.info({ access_token: 'eyJhbGciOiJIUzI1NiJ9.test.sig' }, 'test');
    const output = getOutput();
    expect(output.access_token).toBe('[REDACTED]');
  });

  it('should redact refresh_token field', () => {
    logger.info({ refresh_token: 'refresh-token-value' }, 'test');
    const output = getOutput();
    expect(output.refresh_token).toBe('[REDACTED]');
  });

  it('should redact req.headers.authorization', () => {
    logger.info({ req: { headers: { authorization: 'Bearer secret-jwt' } } }, 'test');
    const output = getOutput();
    expect(output.req.headers.authorization).toBe('[REDACTED]');
  });

  it('should redact req.headers.cookie', () => {
    logger.info({ req: { headers: { cookie: 'session=abc123; token=xyz' } } }, 'test');
    const output = getOutput();
    expect(output.req.headers.cookie).toBe('[REDACTED]');
  });

  it('should redact req.headers["stripe-signature"]', () => {
    logger.info({ req: { headers: { 'stripe-signature': 't=1,v1=signature' } } }, 'test');
    const output = getOutput();
    expect(output.req.headers['stripe-signature']).toBe('[REDACTED]');
  });

  it('should redact top-level headers["stripe-signature"]', () => {
    logger.info({ headers: { 'stripe-signature': 't=1,v1=signature' } }, 'test');
    const output = getOutput();
    expect(output.headers['stripe-signature']).toBe('[REDACTED]');
  });

  it('should redact err.headers["stripe-signature"]', () => {
    logger.info({
      err: { headers: { 'stripe-signature': 't=1,v1=signature' } },
    }, 'test');
    const output = getOutput();
    expect(output.err.headers['stripe-signature']).toBe('[REDACTED]');
  });

  it('should redact err.request.headers["stripe-signature"]', () => {
    logger.info({
      err: { request: { headers: { 'stripe-signature': 't=1,v1=signature' } } },
    }, 'test');
    const output = getOutput();
    expect(output.err.request.headers['stripe-signature']).toBe('[REDACTED]');
  });

  it('should redact err.body', () => {
    logger.info({
      err: { body: '{"id":"evt_123"}', type: 'StripeSignatureVerificationError' },
    }, 'test');
    const output = getOutput();
    expect(output.err.body).toBe('[REDACTED]');
    expect(output.err.type).toBe('StripeSignatureVerificationError');
  });

  it('should redact err.rawBody', () => {
    logger.info({
      err: { rawBody: '{"id":"evt_123"}', type: 'StripeSignatureVerificationError' },
    }, 'test');
    const output = getOutput();
    expect(output.err.rawBody).toBe('[REDACTED]');
    expect(output.err.type).toBe('StripeSignatureVerificationError');
  });

  it('should redact err.config.headers.authorization', () => {
    logger.info({
      err: { config: { headers: { authorization: 'Bearer leaked-token' } } },
    }, 'test');
    const output = getOutput();
    expect(output.err.config.headers.authorization).toBe('[REDACTED]');
  });

  it('should redact err.config.headers.cookie', () => {
    logger.info({
      err: { config: { headers: { cookie: 'session=leaked' } } },
    }, 'test');
    const output = getOutput();
    expect(output.err.config.headers.cookie).toBe('[REDACTED]');
  });

  it('preserves non-header sibling fields while redacting every header value', () => {
    logger.info({
      password: 'secret',
      username: 'testuser',
      req: {
        headers: {
          authorization: 'Bearer x',
          'stripe-signature': 't=1,v1=signature',
          'content-type': 'application/json',
        },
      },
      headers: {
        'stripe-signature': 't=1,v1=signature',
        'content-length': '123',
      },
      err: {
        headers: { 'stripe-signature': 't=1,v1=signature', 'content-type': 'application/json' },
        request: { headers: { 'stripe-signature': 't=1,v1=signature', accept: 'application/json' } },
        body: '{"id":"evt_123"}',
        rawBody: '{"id":"evt_123"}',
        type: 'StripeSignatureVerificationError',
      },
    }, 'test');
    const output = getOutput();
    expect(output.password).toBe('[REDACTED]');
    expect(output.username).toBe('testuser');
    expect(output.req.headers.authorization).toBe('[REDACTED]');
    expect(output.req.headers['stripe-signature']).toBe('[REDACTED]');
    expect(output.req.headers['content-type']).toBe('[REDACTED]');
    expect(output.headers['stripe-signature']).toBe('[REDACTED]');
    expect(output.headers['content-length']).toBe('[REDACTED]');
    expect(output.err.headers['stripe-signature']).toBe('[REDACTED]');
    expect(output.err.headers['content-type']).toBe('[REDACTED]');
    expect(output.err.request.headers['stripe-signature']).toBe('[REDACTED]');
    expect(output.err.request.headers.accept).toBe('[REDACTED]');
    expect(output.err.body).toBe('[REDACTED]');
    expect(output.err.rawBody).toBe('[REDACTED]');
    expect(output.err.type).toBe('StripeSignatureVerificationError');
  });

  /** Header casing/duplicates must not expose probe credentials or transient source data. */
  it('redacts diagnostic headers and raw pairs at every supported log location', () => {
    const sentinel = 'PRIVATE_SOURCE_PROBE_TEST_VALUE';
    const sensitive = { headers: { Authorization: sentinel, 'X-Vercel-Forwarded-For': sentinel,
      'x-gate1-source-probe': sentinel, 'X-Gate1-Source-Diagnostic': sentinel },
    rawHeaders: ['AUTHORIZATION', sentinel, 'x-vercel-forwarded-for', sentinel] };
    logger.info({ ...sensitive, req: sensitive,
      err: { ...sensitive, request: sensitive, config: sensitive } }, 'test');
    const output = getOutput();
    expect(JSON.stringify(output)).not.toContain(sentinel);
    expect(output.req.rawHeaders).toBe('[REDACTED]');
    expect(output.req.headers.Authorization).toBe('[REDACTED]');
  });
});
