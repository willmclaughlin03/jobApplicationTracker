/**
 * Redaction verification tests for the Pino logger
 *
 * Purpose: Ensure all sensitive fields defined in the logger's redact config
 * are properly censored in log output. Prevents accidental removal of
 * redaction paths during future refactors.
 *
 * Connects to: src/shared/logger.js (redact configuration)
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
 */

const pino = require('pino');
const { PassThrough } = require('stream');
const { REDACT_CONFIG } = require('../logger.js');

/**
 * Creates a Pino logger that writes JSON to a PassThrough stream.
 * Returns { logger, getOutput } where getOutput() parses the last
 * line written to the stream.
 */
function createTestLogger() {
  const stream = new PassThrough();
  let lastLine = '';

  stream.on('data', (chunk) => {
    lastLine = chunk.toString().trim();
  });

  const logger = pino({ redact: REDACT_CONFIG }, stream);

  return {
    logger,
    getOutput: () => JSON.parse(lastLine),
  };
}

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

  it('should preserve non-sensitive sibling fields', () => {
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
    expect(output.req.headers['content-type']).toBe('application/json');
    expect(output.headers['stripe-signature']).toBe('[REDACTED]');
    expect(output.headers['content-length']).toBe('123');
    expect(output.err.headers['stripe-signature']).toBe('[REDACTED]');
    expect(output.err.headers['content-type']).toBe('application/json');
    expect(output.err.request.headers['stripe-signature']).toBe('[REDACTED]');
    expect(output.err.request.headers.accept).toBe('application/json');
    expect(output.err.body).toBe('[REDACTED]');
    expect(output.err.rawBody).toBe('[REDACTED]');
    expect(output.err.type).toBe('StripeSignatureVerificationError');
  });
});
