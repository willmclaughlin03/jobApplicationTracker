const net = require('node:net');
const {
  TARGET, PROPOSED_PROFILE, CSRF_COOKIE, ROUTES, Gate1Error, validateProfile,
  validateLiveEnvironment, requestBounded, sessionCookieJar, applyCookies, cookieHeader,
  createLiveServices, createOfflineServices, runProfile, sleep,
} = require('../../../scripts/gate1-shared-ip-load.js');
const { AUTH_COOKIE_STORAGE_KEY, EXPECTED_SUPABASE_URL } = require('../../../scripts/gate0-auth-evidence.js');
const { withSuppressedDependencyConsole } = require('../../../scripts/capture-gate0-auth-evidence.js');
const { parseArguments, preparation, runCli } = require('../../../scripts/qualify-gate1-shared-ip-load.js');

/** Build a small, valid profile for failure-path tests without changing the 50-session proposal. */
function profile(overrides = {}) {
  const result = { ...PROPOSED_PROFILE, sessions: 2, concurrency: 2, cycles: 1, ...overrides };
  result.maxAppRequests = 2 + result.sessions * result.cycles * 2;
  return result;
}

/** Supply synthetic dedicated credentials; no test reads process.env or any credential file. */
function environment() {
  return { GATE1_SUPABASE_URL: EXPECTED_SUPABASE_URL,
    GATE1_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC_SENTINEL',
    GATE1_SUPABASE_SECRET_KEY: 'sb_secret_SYNTHETIC_SENTINEL', GATE1_LIVE_ALLOWED: 'true' };
}

/** Create a transient application response with the deployed v1 envelope and private-cache policy. */
function appResponse(body, status = 200, extra = {}) {
  return { status, text: JSON.stringify(body), headers: new Headers({
    'content-type': 'application/json', 'cache-control': 'private, no-store', 'x-vercel-cache': 'MISS', ...extra,
  }) };
}

/**
 * Emulate only the exact hosted Auth endpoints behind the installed real SDK.
 * Fault options exercise account ownership and cleanup with zero real network access.
 */
function providerFixture({ failCreateAt = 0, failSignInAt = 0, failDeleteAt = 0, onCreate } = {}) {
  const users = new Map();
  const deleted = [];
  const calls = { create: 0, signIn: 0, delete: 0, app: 0 };
  const preExistingId = '90000000-0000-4000-8000-000000000001';
  users.set(preExistingId, { id: preExistingId, email: 'pre-existing@example.invalid' });
  /** Return SDK-compatible JSON without consulting a provider or real credential. */
  function json(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  }
  /** Serve exact routes, inspect synthetic cookies in memory, and reject every unexpected URL/method. */
  const fetchImpl = jest.fn(async (url, init) => {
    expect(init.redirect).toBe('manual');
    const parsed = new URL(url);
    if (parsed.origin === TARGET.origin) {
      calls.app++;
      expect(init.method).toBe('GET');
      if (parsed.pathname === '/login') return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ buildId: TARGET.nextBuildId })}</script>`);
      const encoded = init.headers.Cookie.split('; ').find(pair => pair.startsWith(`${AUTH_COOKIE_STORAGE_KEY}=`)).split('=')[1];
      const session = JSON.parse(Buffer.from(encoded.slice('base64-'.length), 'base64url').toString());
      const response = appResponse({ data: parsed.pathname === ROUTES.session ? { user: session.user } : null, error: null });
      if (parsed.pathname === ROUTES.csrf) response.headers.append('set-cookie', `${CSRF_COOKIE}=synthetic-csrf; Path=/; Secure; SameSite=Lax; Max-Age=14400`);
      else expect(parsed.pathname).toBe(ROUTES.session);
      return new Response(response.text, { status: response.status, headers: response.headers });
    }
    expect(parsed.origin).toBe(EXPECTED_SUPABASE_URL);
    const body = JSON.parse(init.body);
    if (parsed.pathname === '/auth/v1/admin/users' && init.method === 'POST') {
      calls.create++;
      if (calls.create === failCreateAt) throw new Error('SYNTHETIC_PROVIDER_SECRET create-response-lost');
      const user = { id: `00000000-0000-4000-8000-${String(calls.create).padStart(12, '0')}`,
        email: body.email, app_metadata: body.app_metadata };
      users.set(user.id, user);
      onCreate?.(calls.create);
      return json({ user });
    }
    if (parsed.pathname === '/auth/v1/token' && init.method === 'POST') {
      expect(parsed.search).toBe('?grant_type=password');
      calls.signIn++;
      if (calls.signIn === failSignInAt) return json({ message: 'SYNTHETIC_PROVIDER_SECRET', code: 'bad_credentials' }, 400);
      const user = [...users.values()].find(candidate => candidate.email === body.email);
      const payload = Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
      return json({ user, access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.synthetic-signature`,
        refresh_token: `synthetic-refresh-${calls.signIn}`, expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer' });
    }
    if (parsed.pathname.startsWith('/auth/v1/admin/users/') && init.method === 'DELETE') {
      calls.delete++;
      const userId = parsed.pathname.split('/').at(-1);
      expect(userId).not.toBe(preExistingId);
      expect(users.has(userId)).toBe(true);
      if (calls.delete === failDeleteAt) return json({ message: 'SYNTHETIC_PROVIDER_SECRET' }, 503);
      const user = users.get(userId);
      users.delete(userId); deleted.push(userId);
      return json({ user });
    }
    throw new Error('Unexpected synthetic provider request');
  });
  return { fetchImpl, calls, users, deleted, preExistingId };
}

/** Run installed-SDK lifecycle tests with all dependency-owned console output suppressed like the CLI. */
async function runProvider(options = {}, config = profile()) {
  const fixture = providerFixture(options);
  const services = createLiveServices(config, environment(), fixture.fetchImpl);
  const report = await withSuppressedDependencyConsole(() => runProfile(config, services));
  return { fixture, services, report };
}

beforeEach(() => {
  // Any accidental network use is a test failure, including unexpected SDK sockets.
  jest.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Real network forbidden'); });
  jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => { throw new Error('Real socket forbidden'); });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe('configuration, authorization and offline CLI', () => {
  test('requires exact budgets and bounded legitimate visibility settings', () => {
    expect(validateProfile(PROPOSED_PROFILE)).toEqual(PROPOSED_PROFILE);
    for (const bad of [{ sessions: 51 }, { intervalMs: 29999 }, { concurrency: 11 },
      { maxAppRequests: 303 }, { timeoutMs: Infinity }, { durationMs: 600000 }, { unknown: 'secret' }]) {
      expect(() => validateProfile({ ...PROPOSED_PROFILE, ...bad })).toThrow('configuration');
    }
  });
  test('requires dedicated environment keys and the exact provider URL without credentials or suffixes', () => {
    expect(validateLiveEnvironment(environment())).toEqual(environment());
    for (const url of ['https://wrong.invalid', `${EXPECTED_SUPABASE_URL}/`,
      EXPECTED_SUPABASE_URL.replace('https://', 'https://secret@')]) {
      expect(() => validateLiveEnvironment({ ...environment(), GATE1_SUPABASE_URL: url })).toThrow('configuration');
    }
    expect(() => validateLiveEnvironment({ NEXT_PUBLIC_SUPABASE_URL: EXPECTED_SUPABASE_URL })).toThrow('configuration');
    expect(() => validateLiveEnvironment({ ...environment(), GATE1_LIVE_ALLOWED: 'false' })).toThrow('configuration');
  });
  test('live mode requires separate explicit scope acknowledgement and every limit/identity flag', () => {
    expect(() => parseArguments(['--live'])).toThrow('configuration');
    expect(() => parseArguments(['--live', '--authorize-provision-traffic-cleanup'])).toThrow('configuration');
    expect(() => parseArguments(['--dry-run', '--target', 'https://secret@wrong.invalid'])).toThrow('wrong_target');
    expect(() => parseArguments(['--dry-run', '--live'])).toThrow('configuration');
    expect(() => parseArguments(['--sessions', '50', '--sessions', '50'])).toThrow('configuration');
    expect(() => parseArguments(['--help', '--live'])).toThrow('configuration');
  });
  test('help and import do not read credential values or use the network', async () => {
    const env = new Proxy({}, { get: () => { throw new Error('Environment must not be read'); } });
    const output = jest.fn();
    expect(await runCli(['--help'], env, { writeOutput: output })).toBe(0);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('--prepare'));
    jest.isolateModules(() => require('../../../scripts/qualify-gate1-shared-ip-load.js'));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  test('preparation reports names/presence and the direct budgets, without credential values', () => {
    const result = preparation(PROPOSED_PROFILE, environment());
    expect(result.provider.maxDirectRequests).toBe(150);
    expect(result.application.maxDirectRequests).toBe(302);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SENTINEL');
    expect(result.hostedEvidence).toBe('not_executed');
  });
  test('50-session CLI dry-run completes offline and prints no identifiers, cookies, or tokens', async () => {
    const output = jest.fn(); const errors = jest.fn();
    const env = new Proxy({}, { get: () => { throw new Error('Dry-run must not read credentials'); } });
    expect(await runCli(['--dry-run'], env, { writeOutput: output, writeError: errors })).toBe(0);
    const report = JSON.parse(output.mock.calls[0][0]);
    expect(report).toMatchObject({ preparedSessions: 50, distinctSessions: 50, completedCycles: 3,
      appRequests: 302, maxObservedConcurrency: 5, identityMatches: 150,
      hostedEvidence: 'not_executed', gate1Status: 'open' });
    expect(report.provider).toMatchObject({ created: 50, deleted: 50, ownedRemaining: 0 });
    expect(output.mock.calls[0][0]).not.toMatch(/00000000-|synthetic-access|synthetic-refresh|base64-|__Host-csrf-token/);
    expect(errors).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(net.Socket.prototype.connect).not.toHaveBeenCalled();
  });
  test('refusal output cannot echo malicious argument values or credential-shaped errors', async () => {
    const output = jest.fn(); const errors = jest.fn();
    expect(await runCli(['--target', 'https://SYNTHETIC_SECRET@wrong.invalid'], environment(),
      { writeOutput: output, writeError: errors })).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(errors.mock.calls[0][0]).not.toContain('SYNTHETIC_SECRET');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('cookie jars and HTTP boundaries', () => {
  test('installed SSR chunks remain isolated and refreshed/deleted chunks affect only their own jar', () => {
    const a = sessionCookieJar({ user: { id: 'synthetic-a' }, access_token: 'A'.repeat(8000) });
    const b = sessionCookieJar({ user: { id: 'synthetic-b' }, access_token: 'B'.repeat(8000) });
    const before = cookieHeader(b);
    expect(a.size).toBeGreaterThan(1);
    const headers = new Headers();
    headers.append('set-cookie', `${AUTH_COOKIE_STORAGE_KEY}.0=updated; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800`);
    headers.append('set-cookie', `${AUTH_COOKIE_STORAGE_KEY}.1=; Path=/; Secure; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    headers.append('set-cookie', `${CSRF_COOKIE}=new-csrf; Path=/; Secure; SameSite=Lax; Max-Age=14400`);
    expect(applyCookies(a, headers)).toEqual({ writes: 3, csrfWritten: true });
    expect(a.get(`${AUTH_COOKIE_STORAGE_KEY}.0`)).toBe('updated');
    expect(a.has(`${AUTH_COOKIE_STORAGE_KEY}.1`)).toBe(false);
    expect(cookieHeader(b)).toBe(before);
  });
  test('jar expiry removes a short-lived cookie before a later request and honors Max-Age precedence', () => {
    const jar = new Map();
    const now = Date.now();
    applyCookies(jar, new Headers({ 'set-cookie': `${CSRF_COOKIE}=short-lived; Path=/; Secure; SameSite=Lax; Max-Age=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT` }), now);
    expect(cookieHeader(jar, now)).toContain('short-lived');
    expect(cookieHeader(jar, now + 1001)).toBe('');
  });
  test.each([
    'other=value; Path=/; Secure; SameSite=Lax',
    `${CSRF_COOKIE}=value; Path=/; Secure; SameSite=Lax; Domain=evil.invalid`,
    `${CSRF_COOKIE}=value; Path=/; SameSite=Lax`,
    `${AUTH_COOKIE_STORAGE_KEY}=value; Path=/; Secure; SameSite=Lax`,
    `${CSRF_COOKIE}=value; Path=/; Secure; SameSite=Lax; Max-Age=invalid`,
  ])('refuses invalid cookie contracts atomically: %s', field => {
    const jar = new Map([[CSRF_COOKIE, 'original']]);
    expect(() => applyCookies(jar, new Headers({ 'set-cookie': field }))).toThrow('cookie_contract');
    expect(jar.get(CSRF_COOKIE)).toBe('original');
  });
  test('refuses redirect before reading or forwarding its body/cookies', async () => {
    const fetchImpl = jest.fn(async () => new Response('SYNTHETIC_SECRET', { status: 302,
      headers: { location: 'https://wrong.invalid', 'set-cookie': 'secret=value' } }));
    await expect(requestBounded(`${TARGET.origin}/login`, { method: 'GET' }, { fetchImpl, timeoutMs: 100 }))
      .rejects.toThrow('redirect');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
  });
  test('rejects already-followed responses and mismatched effective URLs', async () => {
    const response = new Response('body');
    Object.defineProperty(response, 'url', { value: 'https://wrong.invalid/login' });
    await expect(requestBounded(`${TARGET.origin}/login`, {}, { fetchImpl: async () => response, timeoutMs: 100 }))
      .rejects.toThrow('wrong_target');
  });
  test('body caps and a stalled-body timeout both terminate safely', async () => {
    await expect(requestBounded(`${TARGET.origin}/login`, {}, { fetchImpl: async () => new Response('oversized'),
      timeoutMs: 100, maxBytes: 3 })).rejects.toThrow('response_size');
    jest.useFakeTimers();
    const controller = new AbortController();
    const cancelStream = jest.fn();
    const pending = requestBounded(`${TARGET.origin}/login`, {}, {
      fetchImpl: async () => new Response(new ReadableStream({ cancel: cancelStream })), timeoutMs: 100, signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toThrow('timeout');
    await jest.advanceTimersByTimeAsync(100);
    await assertion;
    expect(cancelStream).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  test('abort cancels a visibility wait and removes its pending timer', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const pending = sleep(31000, controller.signal);
    const assertion = expect(pending).rejects.toThrow('cancelled');
    controller.abort();
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('scheduling, identity, exceptions and accounting', () => {
  test('visibility cadence is per session, mount throttle starts after response, and requests never overlap within a jar', async () => {
    const config = profile({ sessions: 3, concurrency: 2, cycles: 3 });
    const offline = createOfflineServices(config);
    const original = offline.services.request;
    const observations = new Map();
    const active = new Set();
    offline.services.request = async (route, jar, signal) => {
      if (route === ROUTES.session) {
        expect(active.has(jar)).toBe(false); active.add(jar);
        const visits = observations.get(jar) || [];
        visits.push(offline.clock.now()); observations.set(jar, visits);
      }
      const result = await original(route, jar, signal);
      if (route === ROUTES.session) active.delete(jar);
      return result;
    };
    const report = await runProfile(config, offline.services, { dryRun: true, clock: offline.clock });
    expect(report.result).toBe('completed');
    expect(report.maxObservedConcurrency).toBeLessThanOrEqual(2);
    for (const visits of observations.values()) {
      expect(visits).toHaveLength(3);
      expect(visits[1] - visits[0]).toBeGreaterThanOrEqual(config.intervalMs);
      expect(visits[2] - visits[1]).toBeGreaterThanOrEqual(config.intervalMs);
    }
    expect(report.appRequests).toBe(config.maxAppRequests);
  });
  test.each(['user', 'access', 'refresh', 'jar'])('refuses duplicated %s before load and cleans up', async duplicate => {
    const config = profile(); const offline = createOfflineServices(config);
    const original = offline.services.provision; let first;
    offline.services.provision = async signal => {
      const state = await original(signal);
      if (!first) first = state;
      else if (duplicate === 'user') { state.userId = first.userId; state.session.user.id = first.userId; }
      else if (duplicate === 'access') state.session.access_token = first.session.access_token;
      else if (duplicate === 'refresh') state.session.refresh_token = first.session.refresh_token;
      else state.jar = first.jar;
      return state;
    };
    const report = await runProfile(config, offline.services, { dryRun: true, clock: offline.clock });
    expect(report.failureCounts.duplicate_session).toBe(1);
    expect(report.requests.session).toBe(0);
    expect(report.provider.deleted).toBe(2);
  });
  test('identity mismatch stops subsequent requests and never prints returned personal data', async () => {
    const config = profile({ concurrency: 1 }); const offline = createOfflineServices(config);
    const original = offline.services.request;
    offline.services.request = async (route, ...args) => route === ROUTES.session
      ? appResponse({ data: { user: { id: 'SYNTHETIC_WRONG_USER', email: 'SYNTHETIC_PERSONAL_BODY' } }, error: null })
      : original(route, ...args);
    const report = await runProfile(config, offline.services, { dryRun: true, clock: offline.clock });
    expect(report).toMatchObject({ result: 'stopped', identityMatches: 0, identityMismatches: 1 });
    expect(report.requests).toEqual({ build: 1, session: 1, csrf: 0 });
    expect(JSON.stringify(report)).not.toMatch(/SYNTHETIC_WRONG_USER|SYNTHETIC_PERSONAL_BODY/);
    expect(report.provider.deleted).toBe(2);
  });
  test('records the accepted CSRF 503 once, continues later profiles, and never retries or claims a clean result', async () => {
    const config = profile({ cycles: 2 }); const offline = createOfflineServices(config);
    const original = offline.services.request; let exceptions = 0;
    offline.services.request = async (route, ...args) => {
      if (route === ROUTES.csrf && exceptions++ === 0) return appResponse({ error: 'SERVICE_UNAVAILABLE' }, 503, { 'retry-after': '5' });
      return original(route, ...args);
    };
    const report = await runProfile(config, offline.services, { dryRun: true, clock: offline.clock });
    expect(report).toMatchObject({ result: 'completed_with_exceptions', csrfExceptions: 1, completedCycles: 2 });
    expect(report.statusCounts.csrf_503).toBe(1);
    expect(report.statusCounts.csrf_200).toBe(3);
    expect(report.appRequests).toBe(config.maxAppRequests);
    expect(report.failureCounts).toEqual({});
  });
  test.each([429, 401, 504, 503])('unaccepted CSRF %i stops and remains a failure', async status => {
    const config = profile({ concurrency: 1 }); const offline = createOfflineServices(config);
    const original = offline.services.request;
    offline.services.request = async (route, ...args) => route === ROUTES.csrf
      ? appResponse({ error: 'SERVICE_UNAVAILABLE' }, status) : original(route, ...args);
    const report = await runProfile(config, offline.services, { dryRun: true, clock: offline.clock });
    expect(report.result).toBe('stopped');
    expect(report.csrfExceptions).toBe(0);
    expect(report.statusCounts[`csrf_${status}`]).toBe(1);
    expect(report.provider.deleted).toBe(2);
  });
  test('cached personalized responses stop before identity or cookies are accepted', async () => {
    const config = profile({ concurrency: 1 }); const offline = createOfflineServices(config);
    const original = offline.services.request;
    offline.services.request = async (...args) => {
      const response = await original(...args);
      if (args[0] === ROUTES.session) response.headers.set('x-vercel-cache', 'HIT');
      return response;
    };
    const report = await runProfile(config, offline.services, { dryRun: true, clock: offline.clock });
    expect(report.failureCounts.cache_contract).toBe(1);
    expect(report.identityMatches).toBe(0);
  });
  test.each(['before', 'after'])('checks build identity %s the load', async when => {
    const config = profile(); const offline = createOfflineServices(config);
    const original = offline.services.request; let builds = 0;
    offline.services.request = async (route, ...args) => {
      if (route === '/login' && ++builds === (when === 'before' ? 1 : 2)) return { status: 200,
        headers: new Headers(), text: '<script id="__NEXT_DATA__">{"buildId":"wrong"}</script>' };
      return original(route, ...args);
    };
    const report = await runProfile(config, offline.services, { dryRun: true, clock: offline.clock });
    expect(report.failureCounts.build_mismatch).toBe(1);
    expect(report.provider.created).toBe(when === 'before' ? 0 : 2);
    expect(report.provider.ownedRemaining).toBe(0);
  });
  test('duration exhaustion prevents the next wave and still cleans up all accounts', async () => {
    const config = profile({ cycles: 2, durationMs: 32000 }); const offline = createOfflineServices(config);
    const original = offline.services.request;
    offline.services.request = async (...args) => {
      if (args[0] === ROUTES.csrf) await offline.clock.sleep(33000);
      return original(...args);
    };
    const report = await runProfile(config, offline.services, { dryRun: true, clock: offline.clock });
    expect(report.result).toBe('stopped');
    expect(report.failureCounts.duration_limit).toBeGreaterThan(0);
    expect(report.appRequests).toBeLessThan(config.maxAppRequests);
    expect(report.provider.deleted).toBe(2);
  });
});

describe('installed SDK provisioning and owned cleanup with mocked HTTP', () => {
  test('creates independent sessions, applies cookies, and deletes only owned accounts once', async () => {
    const { fixture, services, report } = await runProvider();
    expect(report.result).toBe('completed');
    expect(report.provider).toMatchObject({ createAttempts: 2, signInAttempts: 2, deleteAttempts: 2,
      created: 2, deleted: 2, ownedRemaining: 0 });
    expect(fixture.users.size).toBe(1);
    expect(fixture.users.has(fixture.preExistingId)).toBe(true);
    await services.cleanup();
    expect(fixture.calls.delete).toBe(2);
    expect(JSON.stringify(report)).not.toMatch(/SYNTHETIC|synthetic-refresh|gate0-|example.invalid|00000000-/);
  });
  test('sign-in failure after creation deletes the partially prepared account and earlier accounts', async () => {
    const { report, fixture } = await runProvider({ failSignInAt: 2 });
    expect(report.result).toBe('stopped');
    expect(report.provider).toMatchObject({ created: 2, deleted: 2, cleanupFailed: 0 });
    expect(report.requests.session).toBe(0);
    expect(fixture.calls.signIn).toBe(2);
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC_PROVIDER_SECRET');
  });
  test('lost create response is reported as uncertain and no unknown/pre-existing account is deleted', async () => {
    const { report, fixture } = await runProvider({ failCreateAt: 2 });
    expect(report.result).toBe('stopped');
    expect(report.provider).toMatchObject({ createAttempts: 2, created: 1, deleted: 1, unconfirmedCreates: 1 });
    expect(fixture.calls.create).toBe(2);
    expect(fixture.calls.delete).toBe(1);
    expect(fixture.users.has(fixture.preExistingId)).toBe(true);
  });
  test('cleanup failure is visible and does not skip other owned users or retry deletion', async () => {
    const { report, fixture } = await runProvider({ failDeleteAt: 1 });
    expect(report.result).toBe('stopped');
    expect(report.provider).toMatchObject({ created: 2, deleted: 1, cleanupFailed: 1, ownedRemaining: 1 });
    expect(fixture.calls.delete).toBe(2);
    expect(report.failureCounts.cleanup_failed).toBe(1);
  });
  test('graceful cancellation during account creation cleans up the returned owned receipt', async () => {
    const controller = new AbortController();
    const config = profile();
    const fixture = providerFixture({ onCreate: () => queueMicrotask(() => controller.abort(new Gate1Error('cancelled'))) });
    const services = createLiveServices(config, environment(), fixture.fetchImpl);
    const report = await withSuppressedDependencyConsole(() => runProfile(config, services, { signal: controller.signal }));
    expect(report.result).toBe('stopped');
    expect(report.requests.session).toBe(0);
    // An in-flight creation settles within its timeout so its known receipt remains available for cleanup.
    expect(report.provider).toMatchObject({ created: 1, deleted: 1, unconfirmedCreates: 0 });
    expect(report.provider.ownedRemaining).toBe(0);
    expect(fixture.calls.create).toBe(1);
  });
  test('cancellation before starting performs neither provisioning nor traffic', async () => {
    const controller = new AbortController(); controller.abort();
    const config = profile(); const fixture = providerFixture();
    const services = createLiveServices(config, environment(), fixture.fetchImpl);
    const report = await runProfile(config, services, { signal: controller.signal });
    expect(report.failureCounts.cancelled).toBe(1);
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });
  test('an ordinary AbortController cancellation during load is sanitized and all owned accounts are cleaned', async () => {
    const controller = new AbortController();
    const config = profile({ concurrency: 1 }); const offline = createOfflineServices(config);
    const original = offline.services.request;
    offline.services.request = async (route, ...args) => {
      if (route === ROUTES.session) controller.abort('SYNTHETIC_PRIVATE_ABORT_REASON');
      return original(route, ...args);
    };
    const report = await runProfile(config, offline.services, { signal: controller.signal,
      dryRun: true, clock: offline.clock });
    expect(report.failureCounts.cancelled).toBe(1);
    expect(report.provider.deleted).toBe(2);
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC_PRIVATE_ABORT_REASON');
  });
});
