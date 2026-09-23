import { createGate1SourceProbe, GATE1_SOURCE_PROBE_HEADER } from '../gate1SourceProbe.js';
import { createTemporarySessionCeiling } from '../temporarySessionCeiling.js';

const SECRET = 'a'.repeat(64);
const MARKER = `gate1-source-${'b'.repeat(32)}`;
const SOURCE = '203.0.113.89';
const ENV = {
  NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production',
  GATE1_SOURCE_PROBE_ENABLED: 'true', GATE1_SOURCE_PROBE_SECRET: SECRET,
  TEMPORARY_SESSION_CEILING_SOURCE_MODE: 'vercel',
};
const FACTS = Object.freeze({ effectiveMode: 'vercel', sourceResolution: 'accepted', canonicalFamily: 4 });

/** Builds synthetic raw/normalized metadata and a response; never uses live secrets. */
function fixture(overrides = {}) {
  const headers = {
    authorization: `Bearer ${SECRET}`, 'x-gate1-source-diagnostic': '1',
    'user-agent': MARKER, 'x-vercel-forwarded-for': SOURCE,
  };
  const req = { method: 'GET', headers, rawHeaders: Object.entries(headers).flat(), ...overrides };
  const output = new Map();
  const res = {
    setHeader: jest.fn((name, value) => output.set(name.toLowerCase(), value)),
    getHeader: (name) => output.get(name.toLowerCase()),
  };
  return { req, res, output };
}

/** Reads only the probe header emitted by a fixture response. */
function observation(res) {
  return JSON.parse(res.getHeader(GATE1_SOURCE_PROBE_HEADER));
}

/** Creates real source parsing with mocked enforcement transports and no network. */
function ceiling(overrides = {}) {
  const deriveIdentity = jest.fn(() => ({ redisKey: 'synthetic-key' }));
  const executeScript = jest.fn(async () => ({ status: 'allowed' }));
  const service = createTemporarySessionCeiling({
    env: ENV, now: () => 0,
    secrets: { getRuntimePair: async () => ({ hmac: { active: {} } }) },
    deriveIdentity, getRedisClientFunction: async () => ({}), executeScript,
    telemetry: { record: jest.fn(), finish: jest.fn(), maybeRotate: jest.fn() },
    ...overrides,
  });
  return { service, deriveIdentity, executeScript };
}

describe('GATE-1 source observation', () => {
  it('emits only bounded facts, once, with no independent WAF claim', () => {
    const { req, res } = fixture();
    const observe = createGate1SourceProbe({ env: ENV }).createObserver(req, res);
    observe(FACTS);
    observe({ ...FACTS, canonicalFamily: 6 });
    expect(observation(res)).toEqual({
      schemaVersion: 1, scope: 'server_header_observation_only', marker: MARKER,
      applicationRequestId: null, rawMetadataValid: true, trustedHeaderCount: 1,
      normalizedShape: 'scalar', rawNormalizedEqual: true, ...FACTS,
      sourceAgreement: 'not_evaluated',
    });
    const serialized = res.getHeader(GATE1_SOURCE_PROBE_HEADER);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(1024);
    expect(serialized).not.toContain(SOURCE);
    expect(serialized).not.toContain(SECRET);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res.setHeader).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['disabled', { GATE1_SOURCE_PROBE_ENABLED: 'false' }],
    ['wrong flag casing', { GATE1_SOURCE_PROBE_ENABLED: 'True' }],
    ['missing secret', { GATE1_SOURCE_PROBE_SECRET: undefined }],
    ['malformed secret', { GATE1_SOURCE_PROBE_SECRET: 'not-a-secret' }],
    ['wrong runtime', { NODE_ENV: 'test' }],
    ['missing platform', { VERCEL: undefined }],
    ['unknown environment', { VERCEL_ENV: 'development' }],
  ])('omits observation for %s without touching the response', (_name, change) => {
    const { req, res } = fixture();
    expect(createGate1SourceProbe({ env: { ...ENV, ...change } }).createObserver(req, res)).toBeUndefined();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it.each(['authorization', 'x-gate1-source-diagnostic', 'user-agent'])(
    'rejects duplicate, missing, array and mismatched %s', (name) => {
      for (const variant of ['duplicate', 'missing', 'array', 'mismatch']) {
        const { req, res } = fixture();
        if (variant === 'duplicate') req.rawHeaders.push(name.toUpperCase(), req.headers[name]);
        if (variant === 'missing') delete req.headers[name];
        if (variant === 'array') req.headers[name] = [req.headers[name]];
        if (variant === 'mismatch') req.headers[name] += 'x';
        expect(createGate1SourceProbe({ env: ENV }).createObserver(req, res)).toBeUndefined();
      }
    }
  );

  it.each([undefined, null, {}, ['odd'], ['name', {}], Array(258).fill('x'), ['name', 'x'.repeat(32769)]])(
    'does not claim origin observations when raw metadata cannot authenticate (%#)', (rawHeaders) => {
      const { req, res } = fixture({ rawHeaders });
      expect(createGate1SourceProbe({ env: ENV }).createObserver(req, res)).toBeUndefined();
    }
  );

  it('rejects a well-formed wrong secret and non-GET requests', () => {
    const { req, res } = fixture();
    expect(createGate1SourceProbe({ env: { ...ENV, GATE1_SOURCE_PROBE_SECRET: 'c'.repeat(64) } })
      .createObserver(req, res)).toBeUndefined();
    req.method = 'POST';
    expect(createGate1SourceProbe({ env: ENV }).createObserver(req, res)).toBeUndefined();
  });

  it.each([
    ['missing', undefined, [], 'missing', null, 0, 'rejected', null],
    ['array', [SOURCE], ['x-vercel-forwarded-for', SOURCE], 'array', null, 1, 'rejected', null],
    ['mismatch', SOURCE, ['x-vercel-forwarded-for', '192.0.2.9'], 'scalar', false, 1, 'rejected', null],
    ['duplicates', SOURCE, ['X-Vercel-Forwarded-For', SOURCE, 'x-vercel-forwarded-for', SOURCE], 'scalar', null, 2, 'rejected', null],
    ['comma', `${SOURCE},192.0.2.9`, null, 'scalar', true, 1, 'rejected', null],
    ['space', ` ${SOURCE}`, null, 'scalar', true, 1, 'rejected', null],
    ['port', `${SOURCE}:443`, null, 'scalar', true, 1, 'rejected', null],
    ['zone', 'fe80::1%eth0', null, 'scalar', true, 1, 'rejected', null],
    ['bracket', '[2001:db8::1]', null, 'scalar', true, 1, 'rejected', null],
    ['IPv6', '2001:db8::1', null, 'scalar', true, 1, 'accepted', 6],
    ['mapped IPv6', '::ffff:203.0.113.89', null, 'scalar', true, 1, 'accepted', 4],
  ])('observes actual parser result for %s', async (_label, value, raw, shape, equal, count, result, family) => {
    const { req, res } = fixture();
    req.headers['x-vercel-forwarded-for'] = value;
    req.rawHeaders = req.rawHeaders.slice(0, -2).concat(raw ?? ['x-vercel-forwarded-for', value]);
    const { service, executeScript } = ceiling();
    const observeSource = createGate1SourceProbe({ env: ENV }).createObserver(req, res);
    const decision = await service.evaluate(req, { routeVersion: 'v1', observeSource });
    expect(observation(res)).toMatchObject({
      normalizedShape: shape, rawNormalizedEqual: equal, trustedHeaderCount: count,
      sourceResolution: result, canonicalFamily: family,
    });
    expect(decision.allowed).toBe(result === 'accepted');
    expect(executeScript).toHaveBeenCalledTimes(result === 'accepted' ? 1 : 0);
  });

  it('observes mode failure separately from source rejection without weakening the guard', async () => {
    const { req, res } = fixture();
    const { service, executeScript } = ceiling({ env: { ...ENV, TEMPORARY_SESSION_CEILING_SOURCE_MODE: 'local' } });
    await expect(service.evaluate(req, {
      routeVersion: 'v1', observeSource: createGate1SourceProbe({ env: ENV }).createObserver(req, res),
    })).resolves.toMatchObject({ statusCode: 503, reason: 'source_mode_invalid' });
    expect(observation(res)).toMatchObject({ effectiveMode: 'invalid', sourceResolution: 'not_attempted', canonicalFamily: null });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('does not reparse headers or give a callback access to canonical bytes', async () => {
    const actualSource = { family: 6, addressBytes: Buffer.alloc(16, 1) };
    const resolveSource = jest.fn(() => actualSource);
    const { req } = fixture();
    const { service, deriveIdentity, executeScript } = ceiling({ resolveSource });
    let observed;
    const observeSource = jest.fn((facts) => {
      observed = { facts, scriptCalls: executeScript.mock.calls.length };
      facts.canonicalFamily = 4;
    });
    await expect(service.evaluate(req, { routeVersion: 'v1', observeSource })).resolves.toEqual({ allowed: true });
    expect(observeSource).toHaveBeenCalledTimes(1);
    expect(observed.scriptCalls).toBe(1);
    expect(Object.isFrozen(observed.facts)).toBe(true);
    expect(observed.facts).toEqual({ effectiveMode: 'vercel', sourceResolution: 'accepted', canonicalFamily: 6 });
    expect(resolveSource).toHaveBeenCalledTimes(1);
    expect(deriveIdentity.mock.calls[0][0]).toBe(actualSource);
    expect(actualSource.addressBytes.equals(Buffer.alloc(16, 1))).toBe(true);
  });

  it.each([
    [{ status: 'allowed' }, { allowed: true }],
    [{ status: 'rate_limited', retryAfterSeconds: 13 }, { allowed: false, statusCode: 429, reason: 'limit_exceeded', retryAfterSeconds: 13 }],
    [{ status: 'invalid_state' }, { allowed: false, statusCode: 503, reason: 'script_state_invalid' }],
  ])('preserves decisions and Redis identity with an absent, throwing or mutating observer (%#)', async (result, expected) => {
    for (const observer of [undefined, () => { throw new Error(SOURCE); }, (facts) => { facts.canonicalFamily = 6; }]) {
      const { req } = fixture();
      const { service, deriveIdentity } = ceiling({ executeScript: async () => result });
      await expect(service.evaluate(req, { routeVersion: 'v1', observeSource: observer })).resolves.toEqual(expected);
      expect(deriveIdentity.mock.calls[0][0]).toEqual({ family: 4, addressBytes: Buffer.from([203, 0, 113, 89]) });
    }
  });

  it('contains header writer errors and rejects extra/private fact fields', () => {
    const { req, res } = fixture();
    res.setHeader.mockImplementation(() => { throw new Error(SECRET); });
    expect(() => createGate1SourceProbe({ env: ENV }).createObserver(req, res)(FACTS)).not.toThrow();
    res.setHeader.mockClear();
    createGate1SourceProbe({ env: ENV }).createObserver(req, res)({ ...FACTS, address: SOURCE });
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  /** Observer time is outside the enforcement deadline, with no delayed Redis work. */
  it('finishes enforcement before invoking the diagnostic callback', async () => {
    let time = 0;
    const { service, executeScript } = ceiling({ now: () => time });
    const { req } = fixture();
    await expect(service.evaluate(req, {
      routeVersion: 'v1', observeSource: () => { time = 5_000; },
    })).resolves.toEqual({ allowed: true });
    expect(time).toBe(5_000);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  /** Async observer mistakes must not escape as unhandled rejection or change enforcement. */
  it('contains accidental rejected promises and snapshot getter failures', async () => {
    const { req } = fixture();
    const { service } = ceiling();
    await expect(service.evaluate(req, { routeVersion: 'v1', observeSource: async () => {
      throw new Error('synthetic-observer-failure');
    } })).resolves.toEqual({ allowed: true });
    const source = { get family() { throw new Error('synthetic-snapshot-failure'); } };
    const brokenSnapshot = ceiling({ resolveSource: () => source });
    const observeSource = jest.fn();
    await expect(brokenSnapshot.service.evaluate(req, { routeVersion: 'v1', observeSource }))
      .resolves.toEqual({ allowed: true });
    expect(observeSource).toHaveBeenCalledWith({ effectiveMode: 'vercel', sourceResolution: 'not_attempted', canonicalFamily: null });
  });
});
