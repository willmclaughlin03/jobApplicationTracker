/** Offline synthetic coverage of disclosure boundaries; no hosted runtime is qualified. */
import nativeProcess from 'node:process';
import {
  createGate1MiddlewareRuntimeProbe,
  MIDDLEWARE_PROBE_KEY_HEADER as KEY,
  MIDDLEWARE_PROBE_CHALLENGE_HEADER as CHALLENGE,
  MIDDLEWARE_PROBE_RESPONSE_HEADER as OBSERVATION,
} from '../gate1MiddlewareRuntimeProbe.js';

jest.mock('next/server', () => ({ NextResponse: { next: jest.fn() } }));

const SECRET = 'a'.repeat(64);
const NONCE = 'b'.repeat(32);

/** Build a synthetic request with only the Web request interface used by the probe. */
function request(overrides = {}) {
  return {
    method: 'GET',
    url: 'https://example.test/login',
    nextUrl: { pathname: '/login', search: '' },
    headers: new Headers({ [KEY]: SECRET, [CHALLENGE]: NONCE }),
    ...overrides,
  };
}

/** Supply a native-shaped, independently specified runtime fixture for each request. */
function runtime(version = 'v22.18.0') {
  return { version, nodeVersion: version.slice(1), releaseName: 'node' };
}

/** Isolate environment and response identity so ordinary login effects remain observable. */
function fixture(overrides = {}) {
  const env = {
    GATE1_MIDDLEWARE_RUNTIME_PROBE_ENABLED: 'true',
    GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET: SECRET,
    NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview',
    ...overrides.env,
  };
  const response = {
    status: 200, body: 'ordinary-login', cookies: { set: jest.fn() },
    headers: new Headers({ 'Cache-Control': 'public, max-age=3600',
      'CDN-Cache-Control': 'public', 'Vercel-CDN-Cache-Control': 'public',
      'Set-Cookie': 'synthetic-cookie=retained; HttpOnly', 'X-Existing': 'retained' }),
  };
  const next = jest.fn(() => response);
  const readRuntime = overrides.readRuntime ?? jest.fn(() => runtime());
  return { env, response, next, readRuntime,
    probe: createGate1MiddlewareRuntimeProbe({ env, next, readRuntime }) };
}

/** Check only the synthetic probe header; absence cannot be parsed into an observation. */
function observation(response) {
  const value = response?.headers.get(OBSERVATION);
  return value ? JSON.parse(value) : null;
}

/** Cover auth, runtime and response boundaries using independent assertions. */
describe('Gate 1 middleware runtime observer', () => {
  /** Valid evidence preserves the selected response and its unrelated headers/cookies. */
  it('attaches bounded Node 22 facts while forwarding the normal login request', () => {
    const f = fixture();
    const req = request();
    req.headers.set('Cookie', 'synthetic-cookie=retained');
    req.headers.set('Authorization', 'Bearer synthetic-ordinary-auth');
    req.headers.set(OBSERVATION, 'spoofed-input');
    expect(f.probe.handle(req)).toBe(f.response);
    expect(observation(f.response)).toEqual({ schemaVersion: 1, scope: 'middleware',
      challenge: NONCE, nodeVersion: 'v22.18.0', node22: true });
    expect(f.next).toHaveBeenCalledTimes(1);
    const forwarded = f.next.mock.calls[0][0].request.headers;
    for (const name of [KEY, CHALLENGE, OBSERVATION]) expect(forwarded.has(name)).toBe(false);
    expect(forwarded.get('Cookie')).toBe('synthetic-cookie=retained');
    expect(forwarded.get('Authorization')).toBe('Bearer synthetic-ordinary-auth');
    expect(req.headers.get(KEY)).toBe(SECRET);
    expect(f.response.status).toBe(200);
    expect(f.response.body).toBe('ordinary-login');
    expect(f.response.cookies.set).not.toHaveBeenCalled();
    expect(f.response.headers.get('Set-Cookie')).toBe('synthetic-cookie=retained; HttpOnly');
    expect(f.response.headers.get('X-Existing')).toBe('retained');
    expect(f.response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(f.response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(f.response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store');
    expect(f.response.headers.get(OBSERVATION)).not.toContain(SECRET);
  });

  /** Missing opt-in, dedicated credentials or approved environment never reads runtime. */
  it.each([
    ['GATE1_MIDDLEWARE_RUNTIME_PROBE_ENABLED', undefined],
    ['GATE1_MIDDLEWARE_RUNTIME_PROBE_ENABLED', 'false'],
    ['GATE1_MIDDLEWARE_RUNTIME_PROBE_ENABLED', 'TRUE'],
    ['GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET', undefined],
    ['GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET', 'A'.repeat(64)],
    ['GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET', 'a'.repeat(63)],
    ['GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET', 'a'.repeat(65)],
    ['NODE_ENV', 'development'], ['VERCEL', undefined], ['VERCEL_ENV', 'development'],
  ])('rejects configuration %s case %# without disclosing facts', (key, value) => {
    const f = fixture({ env: { [key]: value } });
    expect(f.probe.handle(request())).toBe(f.response);
    expect(observation(f.response)).toBeNull();
    expect(f.readRuntime).not.toHaveBeenCalled();
    expect(f.next.mock.calls[0][0].request.headers.has(KEY)).toBe(false);
  });

  /** Strict length/grammar rejects malformed and comma-combined Web header values. */
  it.each([
    [KEY, null], [KEY, ''], [KEY, 'c'.repeat(64)], [KEY, 'A'.repeat(64)],
    [KEY, 'a'.repeat(63)], [KEY, 'a'.repeat(65)], [KEY, `${SECRET}, ${SECRET}`],
    [KEY, `Bearer ${SECRET}`], [KEY, 'a'.repeat(4096)],
    [CHALLENGE, null], [CHALLENGE, ''], [CHALLENGE, 'B'.repeat(32)],
    [CHALLENGE, 'b'.repeat(31)], [CHALLENGE, 'b'.repeat(33)],
    [CHALLENGE, `${NONCE}, ${NONCE}`], [CHALLENGE, 'not-a-challenge'],
  ])('rejects malformed or incorrect input %s case %#', (header, value) => {
    const f = fixture();
    const req = request();
    if (value === null) req.headers.delete(header);
    else req.headers.set(header, value);
    f.probe.handle(req);
    expect(observation(f.response)).toBeNull();
    expect(f.readRuntime).not.toHaveBeenCalled();
  });

  /** Fetch Headers joins duplicate custom fields; the combined credential is invalid. */
  it('rejects duplicate mixed-case credentials and challenges', () => {
    for (const name of [KEY, CHALLENGE]) {
      const f = fixture();
      const req = request();
      req.headers.append(name.toUpperCase(), req.headers.get(name));
      f.probe.handle(req);
      expect(observation(f.response)).toBeNull();
      expect(f.readRuntime).not.toHaveBeenCalled();
    }
  });

  /** Wrong methods, raw/parsed disagreement, query strings and path variants are ordinary. */
  it.each([
    { method: 'POST' }, { method: 'HEAD' }, { method: 'get' },
    { nextUrl: { pathname: '/login/', search: '' } },
    { nextUrl: { pathname: '/admin', search: '' } },
    { nextUrl: { pathname: '/api/auth/session', search: '' } },
    { nextUrl: { pathname: '/login', search: '?probe=1' } },
    { url: 'https://example.test/login?probe=1' },
    { url: 'https://example.test/login#probe' },
    { url: 'https://example.test/log%69n' },
    { url: 'https://example.test/_next/data/build/login.json' },
    { url: 'not-a-url' }, { headers: null },
  ])('ignores a request outside exact diagnostic scope %#', (overrides) => {
    const f = fixture();
    expect(f.probe.handle(request(overrides))).toBeNull();
    expect(f.readRuntime).not.toHaveBeenCalled();
    expect(f.next).not.toHaveBeenCalled();
  });

  /** Ordinary login and a copied historical credential do not opt into this probe. */
  it('leaves unmarked requests untouched and never falls back to the restart secret', () => {
    const f = fixture({ env: { GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET: undefined,
      GATE1_RESTART_PROBE_SECRET: SECRET } });
    expect(f.probe.handle(request({ headers: new Headers() }))).toBeNull();
    expect(f.next).not.toHaveBeenCalled();
    f.probe.handle(request());
    expect(observation(f.response)).toBeNull();
    expect(f.readRuntime).not.toHaveBeenCalled();
  });

  /** Invalid native facts are missing evidence, never a fabricated matching runtime. */
  it.each([
    undefined, null, {}, { ...runtime(), version: undefined },
    runtime('v24.1.0-private'), runtime('v022.1.0'), runtime('v1000.1.0'),
    { ...runtime(), nodeVersion: '24.1.0' }, { ...runtime(), releaseName: 'edge' },
    { ...runtime(), unexpected: 'private-data' },
  ])('omits unavailable, malformed or contradictory runtime %#', (value) => {
    const f = fixture({ readRuntime: jest.fn(() => value) });
    expect(f.probe.handle(request())).toBe(f.response);
    expect(observation(f.response)).toBeNull();
    expect(f.response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  /** A concrete incompatible major is visible but explicitly fails the Node 22 guard. */
  it.each(['v20.19.0', 'v24.1.0', 'v0.1.0', 'v999.999.999'])(
    'preserves incompatible runtime %s as node22=false', (version) => {
      const f = fixture({ readRuntime: jest.fn(() => runtime(version)) });
      f.probe.handle(request());
      expect(observation(f.response)).toEqual({ schemaVersion: 1, scope: 'middleware',
        challenge: NONCE, nodeVersion: version, node22: false });
    }
  );

  /** Every authenticated call reads again and echoes its own challenge, with no memoization. */
  it('does not reuse runtime observations across requests', () => {
    const f = fixture({ readRuntime: jest.fn()
      .mockReturnValueOnce(runtime()).mockReturnValueOnce(runtime('v24.1.0')) });
    f.probe.handle(request());
    expect(observation(f.response).node22).toBe(true);
    const second = request();
    second.headers.set(CHALLENGE, 'c'.repeat(32));
    f.probe.handle(second);
    expect(f.readRuntime).toHaveBeenCalledTimes(2);
    expect(observation(f.response)).toMatchObject({ challenge: 'c'.repeat(32), node22: false });
  });

  /** Reader exceptions and stale response fields must not expose a previous observation. */
  it('contains observation failures and clears stale diagnostic output', () => {
    const f = fixture({ readRuntime: jest.fn(() => { throw new Error('synthetic-private-error'); }) });
    f.response.headers.set(OBSERVATION, 'stale-observation');
    expect(() => f.probe.handle(request())).not.toThrow();
    expect(observation(f.response)).toBeNull();
    expect(f.response.body).toBe('ordinary-login');
  });

  /** This local reader check proves only execution in the test process, never deployment. */
  it('reads the current native process through the default runtime reader', () => {
    const f = fixture();
    const probe = createGate1MiddlewareRuntimeProbe({ env: f.env, next: f.next });
    probe.handle(request());
    expect(observation(f.response).nodeVersion).toBe(nativeProcess.version);
    expect(observation(f.response).node22).toBe(nativeProcess.versions.node.startsWith('22.'));
  });
});
