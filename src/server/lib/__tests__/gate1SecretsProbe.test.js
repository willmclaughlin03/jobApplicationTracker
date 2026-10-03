import { createGate1SecretsProbe, GATE1_SECRETS_PROBE_HEADER } from '../gate1SecretsProbe.js';

const SECRET = 'a'.repeat(64);
const MARKER = `gate1-secrets-${'b'.repeat(32)}`;
const ENV = { NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview',
  GATE1_SECRETS_PROBE_ENABLED: 'true', GATE1_SECRETS_PROBE_SECRET: SECRET };
const FACTS = {
  effectiveMode: 'vercel', sourceResolution: 'accepted', canonicalFamily: 4,
  loaderReached: true, loaderStateBefore: { hasCachedPair: false, permanentFailure: false },
  loader: { loaderId: 'c'.repeat(32), validationAttempts: 1, effectiveMode: 'vercel',
    validationStage: 'hmac', hmacInput: 'missing', redisInput: 'missing',
    hasCachedPair: false, permanentFailure: true },
  identityAttempted: false, redisAttempted: false, scriptAttempted: false,
  allowed: false, reason: 'secret_unavailable',
};

/** Builds synthetic header/response fixtures; all credentials are test-only. */
function fixture() {
  const headers = { authorization: `Bearer ${SECRET}`, 'x-gate1-secrets-diagnostic': '1',
    'user-agent': MARKER, 'x-vercel-forwarded-for': '203.0.113.2' };
  const req = { method: 'GET', headers, rawHeaders: Object.entries(headers).flat() };
  const output = new Map();
  const res = { setHeader: jest.fn((name, value) => output.set(name.toLowerCase(), value)),
    getHeader: (name) => output.get(name.toLowerCase()) };
  return { req, res };
}

describe('GATE-1 deployment secrets probe', () => {
  /** Trace the actual first rejection; later credential/header checks must stay unexecuted. */
  it.each([
    ['probe_disabled', { GATE1_SECRETS_PROBE_ENABLED: 'false' }],
    ['runtime_ineligible', { VERCEL: '0' }],
    ['production_opt_in_missing', { VERCEL_ENV: 'production' }],
    ['configured_credential_invalid', { GATE1_SECRETS_PROBE_SECRET: 'invalid' }],
    ['raw_metadata_invalid', {}, { rawHeaders: ['odd'] }],
    ['diagnostic_marker_invalid', {}, { diagnostic: '0' }],
    ['authorization_invalid', {}, { authorization: 'invalid' }],
    ['credential_mismatch', {}, { authorization: `Bearer ${'d'.repeat(64)}` }],
    ['user_agent_invalid', {}, { marker: 'invalid' }],
  ])('records only %s at its existing check', (reason, change, metadata = {}) => {
    const { req, res } = fixture(), env = { ...ENV, ...change }, trace = { record: jest.fn() };
    if (metadata.diagnostic) req.headers['x-gate1-secrets-diagnostic'] = metadata.diagnostic;
    if (metadata.authorization) req.headers.authorization = metadata.authorization;
    if (metadata.marker) req.headers['user-agent'] = metadata.marker;
    req.rawHeaders = metadata.rawHeaders || Object.entries(req.headers).flat();
    const later = jest.fn(() => { throw new Error('must not execute'); });
    if (['probe_disabled', 'runtime_ineligible', 'production_opt_in_missing'].includes(reason)) {
      Object.defineProperty(env, 'GATE1_SECRETS_PROBE_SECRET', { get: later });
    } else if (reason === 'configured_credential_invalid') Object.defineProperty(req, 'rawHeaders', { get: later });
    else if (reason === 'raw_metadata_invalid') Object.defineProperty(req, 'headers', { get: later });
    else if (reason === 'diagnostic_marker_invalid') Object.defineProperty(req.headers, 'authorization', { get: later });
    else if (['authorization_invalid', 'credential_mismatch'].includes(reason)) Object.defineProperty(req.headers, 'user-agent', { get: later });
    expect(createGate1SecretsProbe({ env }).createObserver(req, res, trace)).toBeUndefined();
    expect(trace.record.mock.calls).toEqual([['authentication', reason]]);
    expect(later).not.toHaveBeenCalled(); expect(res.setHeader).not.toHaveBeenCalled();
  });

  /** Instrumentation must count invocations before suppressing duplicate header writes. */
  it('counts duplicate callbacks while preserving the original one-shot emission', () => {
    const { req, res } = fixture(), trace = { record: jest.fn() };
    const observe = createGate1SecretsProbe({ env: ENV }).createObserver(req, res, trace);
    observe(FACTS); observe(FACTS);
    expect(trace.record.mock.calls).toEqual([['authentication', 'accepted'], ['invocation', undefined],
      ['emission', 'header_set_returned'], ['invocation', undefined]]);
    expect(res.setHeader).toHaveBeenCalledTimes(2);
  });

  /** Fixed emission reasons identify failure boundaries without exposing thrown values. */
  it.each(['response_closed', 'facts_rejected', 'payload_oversized', 'header_write_failed', 'internal_error'])(
    'records %s without changing the response', (reason) => {
      const { req, res } = fixture(), trace = { record: jest.fn() };
      const observe = createGate1SecretsProbe({ env: ENV }).createObserver(req, res, trace);
      let facts = FACTS, spy;
      if (reason === 'response_closed') res.headersSent = true;
      if (reason === 'facts_rejected') facts = { ...FACTS, private: 'sentinel' };
      if (reason === 'payload_oversized') spy = jest.spyOn(Buffer, 'byteLength').mockReturnValue(1537);
      if (reason === 'header_write_failed') res.setHeader.mockImplementation(() => { throw new Error('sentinel'); });
      if (reason === 'internal_error') facts = { get effectiveMode() { throw new Error('sentinel'); } };
      try { expect(() => observe(facts)).not.toThrow(); } finally { spy?.mockRestore(); }
      expect(trace.record).toHaveBeenLastCalledWith('emission', reason);
      expect(res.getHeader(GATE1_SECRETS_PROBE_HEADER)).toBeUndefined();
      expect(JSON.stringify(trace.record.mock.calls)).not.toContain('sentinel');
    });

  /** Probe-internal errors and broken diagnostic observers stay observational only. */
  it('contains authentication and trace exceptions', () => {
    const { req, res } = fixture(), trace = { record: jest.fn() };
    const env = { get VERCEL_ENV() { throw new Error('sentinel'); } };
    expect(createGate1SecretsProbe({ env }).createObserver(req, res, trace)).toBeUndefined();
    expect(trace.record).toHaveBeenCalledWith('authentication', 'internal_error');
    trace.record.mockImplementation(() => { throw new Error('trace failure'); });
    const observe = createGate1SecretsProbe({ env: ENV }).createObserver(req, res, trace);
    expect(() => observe(FACTS)).not.toThrow(); expect(res.getHeader(GATE1_SECRETS_PROBE_HEADER)).toBeDefined();
  });

  it('emits strict value-free facts once with private no-store caching', () => {
    const { req, res } = fixture();
    const observe = createGate1SecretsProbe({ env: ENV }).createObserver(req, res);
    observe(FACTS);
    observe({ ...FACTS, canonicalFamily: 6 });
    const text = res.getHeader(GATE1_SECRETS_PROBE_HEADER);
    expect(JSON.parse(text)).toEqual({ schemaVersion: 2, scope: 'secret_loader_observation_only',
      environment: 'preview', contextScope: 'loader', marker: MARKER, ...FACTS });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1536);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('203.0.113.2');
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res.setHeader).toHaveBeenCalledTimes(2);
  });

  it('requires explicit Production opt-in and captures the authenticated runtime environment', () => {
    const env = { ...ENV, VERCEL_ENV: 'production', GATE1_SECRETS_PROBE_PRODUCTION_ENABLED: 'true' };
    const { req, res } = fixture();
    const observe = createGate1SecretsProbe({ env }).createObserver(req, res);
    env.VERCEL_ENV = 'preview';
    observe(FACTS);
    expect(JSON.parse(res.getHeader(GATE1_SECRETS_PROBE_HEADER)))
      .toMatchObject({ schemaVersion: 2, environment: 'production' });
  });

  it.each([
    { GATE1_SECRETS_PROBE_PRODUCTION_ENABLED: undefined },
    { GATE1_SECRETS_PROBE_PRODUCTION_ENABLED: 'false' },
    { GATE1_SECRETS_PROBE_PRODUCTION_ENABLED: 'True' },
    { GATE1_SECRETS_PROBE_ENABLED: 'false' },
    { GATE1_SECRETS_PROBE_SECRET: 'd'.repeat(64) },
    { VERCEL_ENV: 'development' }, { VERCEL: undefined }, { NODE_ENV: 'test' },
  ])('keeps all Production authorization boundaries (%#)', (change) => {
    const { req, res } = fixture();
    const env = { ...ENV, VERCEL_ENV: 'production', GATE1_SECRETS_PROBE_PRODUCTION_ENABLED: 'true', ...change };
    expect(createGate1SecretsProbe({ env }).createObserver(req, res)).toBeUndefined();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it.each([
    ['production', { VERCEL_ENV: 'production' }], ['development', { VERCEL_ENV: 'development' }],
    ['missing environment', { VERCEL_ENV: undefined }], ['wrong runtime', { NODE_ENV: 'test' }],
    ['missing platform', { VERCEL: undefined }], ['disabled', { GATE1_SECRETS_PROBE_ENABLED: 'false' }],
    ['wrong flag casing', { GATE1_SECRETS_PROBE_ENABLED: 'True' }],
    ['missing credential', { GATE1_SECRETS_PROBE_SECRET: undefined }],
    ['malformed credential', { GATE1_SECRETS_PROBE_SECRET: 'invalid' }],
    ['wrong credential', { GATE1_SECRETS_PROBE_SECRET: 'd'.repeat(64) }],
  ])('does not authenticate %s or touch the response', (_label, overrides) => {
    const { req, res } = fixture();
    expect(createGate1SecretsProbe({ env: { ...ENV, ...overrides } }).createObserver(req, res)).toBeUndefined();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it.each(['authorization', 'x-gate1-secrets-diagnostic', 'user-agent'])(
    'requires exactly one agreeing, valid %s', (name) => {
      for (const variant of ['duplicate', 'raw missing', 'normalized missing', 'array', 'mismatch', 'malformed']) {
        const { req, res } = fixture();
        if (variant === 'duplicate') req.rawHeaders.push(name.toUpperCase(), req.headers[name]);
        if (variant === 'raw missing') req.rawHeaders = Object.entries(req.headers).filter(([key]) => key !== name).flat();
        if (variant === 'normalized missing') delete req.headers[name];
        if (variant === 'array') req.headers[name] = [req.headers[name]];
        if (variant === 'mismatch') req.headers[name] += 'x';
        if (variant === 'malformed') {
          req.headers[name] = 'invalid';
          req.rawHeaders = Object.entries(req.headers).flat();
        }
        expect(createGate1SecretsProbe({ env: ENV }).createObserver(req, res)).toBeUndefined();
      }
    });

  it.each([undefined, null, {}, ['odd'], ['name', {}], ['', 'x'], ['n'.repeat(129), 'x'],
    Array(258).fill('x'), ['name', 'x'.repeat(32769)]])('bounds malformed raw metadata (%#)', (rawHeaders) => {
    const { req, res } = fixture();
    req.rawHeaders = rawHeaders;
    expect(createGate1SecretsProbe({ env: ENV }).createObserver(req, res)).toBeUndefined();
  });

  it('rejects non-GET and contains throwing request/environment getters', () => {
    const { req, res } = fixture();
    req.method = 'POST';
    expect(createGate1SecretsProbe({ env: ENV }).createObserver(req, res)).toBeUndefined();
    expect(createGate1SecretsProbe({ env: { get GATE1_SECRETS_PROBE_ENABLED() { throw new Error('sentinel'); } } })
      .createObserver(req, res)).toBeUndefined();
  });

  it.each([
    { ...FACTS, unexpected: 'sentinel' }, { ...FACTS, environment: 'production' },
    { ...FACTS, reason: 'raw-error-sentinel' },
    { ...FACTS, loader: { ...FACTS.loader, key: 'credential-sentinel' } },
    { ...FACTS, loader: { ...FACTS.loader, loaderId: 'unsafe-sentinel' } },
    { ...FACTS, loader: { ...FACTS.loader, hasCachedPair: true } },
    { ...FACTS, loaderReached: false },
    { ...FACTS, redisAttempted: true },
    { ...FACTS, allowed: true },
    { ...FACTS, sourceResolution: 'rejected' },
    { ...FACTS, canonicalFamily: null },
  ])('omits malformed, contradictory or sensitive facts (%#)', (facts) => {
    const { req, res } = fixture();
    const observe = createGate1SecretsProbe({ env: ENV }).createObserver(req, res);
    observe(facts);
    observe(FACTS);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it.each(['headersSent', 'writableEnded', 'finished'])('does not write a %s response', (field) => {
    const { req, res } = fixture();
    res[field] = true;
    createGate1SecretsProbe({ env: ENV }).createObserver(req, res)(FACTS);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('contains header writer failures and permits explicitly incomplete attribution', () => {
    const { req, res } = fixture();
    res.setHeader.mockImplementation(() => { throw new Error('writer sentinel'); });
    expect(() => createGate1SecretsProbe({ env: ENV }).createObserver(req, res)(FACTS)).not.toThrow();
    const other = fixture();
    createGate1SecretsProbe({ env: ENV }).createObserver(other.req, other.res)({ ...FACTS, loader: null });
    expect(JSON.parse(other.res.getHeader(GATE1_SECRETS_PROBE_HEADER)).loader).toBeNull();
  });
});
