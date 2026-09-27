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

describe('GATE-1 Preview secrets probe', () => {
  it('emits strict value-free facts once with private no-store caching', () => {
    const { req, res } = fixture();
    const observe = createGate1SecretsProbe({ env: ENV }).createObserver(req, res);
    observe(FACTS);
    observe({ ...FACTS, canonicalFamily: 6 });
    const text = res.getHeader(GATE1_SECRETS_PROBE_HEADER);
    expect(JSON.parse(text)).toEqual({ schemaVersion: 1, scope: 'secret_loader_observation_only',
      contextScope: 'loader', marker: MARKER, ...FACTS });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1536);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('203.0.113.2');
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res.setHeader).toHaveBeenCalledTimes(2);
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
    { ...FACTS, unexpected: 'sentinel' },
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
