const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const {
  TARGET, PROPOSED_PROFILE, PROVISIONING_COOLDOWN_MS, CSRF_COOKIE, ROUTES, Gate1Error, validateProfile,
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
function providerFixture({ failCreateAt = 0, loseCreateResponseAt = 0, failSignInAt = 0,
  signInFailureStatus = 400, failDeleteAt = 0, failListAt = 0, listPage, onCreate, onSignIn } = {}) {
  const users = new Map();
  const deleted = [];
  const calls = { create: 0, signIn: 0, delete: 0, list: 0, app: 0 };
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
    if (parsed.pathname === '/auth/v1/admin/users' && init.method === 'GET') {
      calls.list++;
      expect(calls.delete).toBe(0);
      expect(parsed.search).toBe(`?page=${calls.list}&per_page=50`);
      if (calls.list === failListAt) return json({ message: 'SYNTHETIC_PROVIDER_SECRET' }, 503);
      const records = [...users.values()];
      return json({ users: listPage ? listPage(calls.list, records) : records.slice((calls.list - 1) * 50, calls.list * 50) });
    }
    const body = JSON.parse(init.body);
    if (parsed.pathname === '/auth/v1/admin/users' && init.method === 'POST') {
      calls.create++;
      if (calls.create === failCreateAt) throw new Error('SYNTHETIC_PROVIDER_SECRET create-response-lost');
      const user = { id: `00000000-0000-4000-8000-${String(calls.create).padStart(12, '0')}`,
        email: body.email, app_metadata: body.app_metadata };
      users.set(user.id, user);
      onCreate?.(calls.create);
      if (calls.create === loseCreateResponseAt) throw new Error('SYNTHETIC_PROVIDER_SECRET create-response-lost');
      return json({ user });
    }
    if (parsed.pathname === '/auth/v1/token' && init.method === 'POST') {
      expect(parsed.search).toBe('?grant_type=password');
      calls.signIn++;
      onSignIn?.();
      if (calls.signIn === failSignInAt) return json({ message: 'SYNTHETIC_PROVIDER_SECRET',
        code: 'SYNTHETIC_PRIVATE_PROVIDER_CODE' }, signInFailureStatus);
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

/** Run the installed SDK with mocked HTTP and a virtual clock; callers can inject real fake-timer waits. */
async function runProvider(options = {}, config = profile(), persistMarker = jest.fn(), runOptions = {}) {
  const fixture = providerFixture(options);
  const services = createLiveServices(config, environment(), fixture.fetchImpl, { persistMarker });
  const report = await withSuppressedDependencyConsole(() => runProfile(config, services,
    { clock: createOfflineServices(config).clock, ...runOptions }));
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
  /** Exercise authorized live CLI dispatch and report serialization with synthetic credentials and mocked services. */
  test('authorized live CLI arguments dispatch to live services and emit an attested structured report', async () => {
    // Import the CLI after installing spies because it captures the runner exports on import.
    /** Keep the mocked runner exports private to this CLI test so SDK lifecycle tests use real services. */
    await jest.isolateModulesAsync(async () => {
      const runner = require('../../../scripts/gate1-shared-ip-load.js');
      const services = {};
      const factory = jest.spyOn(runner, 'createLiveServices').mockReturnValue(services);
      const execute = jest.spyOn(runner, 'runProfile').mockResolvedValue({
        schemaVersion: 1, mode: 'live', result: 'completed', target: TARGET, profile: PROPOSED_PROFILE,
        appRequests: 302, provider: { created: 50, deleted: 50, ownedRemaining: 0 },
        attribution: { deploymentAndGit: 'operator_attestation_required', buildBefore: true, buildAfter: true },
      });
      const { runCli: liveRunCli } = require('../../../scripts/qualify-gate1-shared-ip-load.js');
      const env = environment();
      const output = jest.fn(); const errors = jest.fn(); const fetchImpl = jest.fn();
      const beforeSigint = process.listeners('SIGINT');
      const beforeSigterm = process.listeners('SIGTERM');
      const code = await liveRunCli([
        '--live', '--authorize-provision-traffic-cleanup',
        '--sessions', '50', '--cycles', '3', '--interval-ms', '31000', '--concurrency', '5',
        '--timeout-ms', '10000', '--setup-timeout-ms', '600000', '--duration-ms', '180000',
        '--max-app-requests', '302', '--target', TARGET.origin, '--deployment-id', TARGET.deploymentId,
        '--git-sha', TARGET.gitSha, '--next-build-id', TARGET.nextBuildId,
      ], env, { writeOutput: output, writeError: errors, fetchImpl });
      expect(code).toBe(0);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledWith(PROPOSED_PROFILE, env, fetchImpl);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(PROPOSED_PROFILE, services, { signal: expect.any(AbortSignal) });
      expect(output).toHaveBeenCalledTimes(1);
      const report = JSON.parse(output.mock.calls[0][0]);
      expect(report).toEqual({
        schemaVersion: 1, mode: 'live', result: 'completed', target: TARGET, profile: PROPOSED_PROFILE,
        appRequests: 302, provider: { created: 50, deleted: 50, ownedRemaining: 0 },
        attribution: { deploymentAndGit: 'operator_attested', buildBefore: true, buildAfter: true },
      });
      expect(output.mock.calls[0][0]).not.toContain('SYNTHETIC_SENTINEL');
      expect(errors).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(net.Socket.prototype.connect).not.toHaveBeenCalled();
      expect(process.listeners('SIGINT')).toEqual(beforeSigint);
      expect(process.listeners('SIGTERM')).toEqual(beforeSigterm);
    });
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
    expect(result.provider.maxDeleteRequests).toBe(50);
    expect(result.provider.cleanupConcurrency).toBe(5);
    expect(result.provider.provisioningCooldownMs).toBe(2500);
    expect(result.provider.maxReconciliationRequests).toBe(50);
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
    expect(report.setup).toEqual({ provisioningCooldownMs: 2500 });
    expect(report.provider.statusCounts).toEqual({ create_200: 50, signIn_200: 50, delete_200: 50 });
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
  /** Slow setup must respect the shared-IP sign-in cadence without consuming the separate load budget. */
  test('paces all 50 sign-ins even after an early timer wake and completes all application cycles', async () => {
    const config = profile({ sessions: 50, cycles: 3, durationMs: 70000 });
    const clock = createOfflineServices(config).clock;
    const wait = clock.sleep;
    let wokeEarly = false;
    /** Emulate one early timer wake so the runner must recheck its monotonic deadline. */
    clock.sleep = async (ms, signal) => {
      const delay = wokeEarly ? ms : ms / 2;
      wokeEarly = true;
      await wait(delay, signal);
    };
    const signIns = [];
    const { report, fixture } = await runProvider({
      /** Observe only synthetic dispatch times, without changing provider behavior. */
      onSignIn: () => signIns.push(clock.now()),
    }, config, jest.fn(), { clock });
    expect(signIns).toHaveLength(50);
    for (let index = 1; index < signIns.length; index++) {
      expect(signIns[index] - signIns[index - 1]).toBeGreaterThanOrEqual(PROVISIONING_COOLDOWN_MS);
    }
    expect(signIns.at(-1)).toBeGreaterThan(config.durationMs);
    expect(report).toMatchObject({ result: 'completed', preparedSessions: 50, completedCycles: 3,
      appRequests: 302, identityMatches: 150 });
    expect(fixture.calls).toEqual({ create: 50, signIn: 50, delete: 50, list: 0, app: 302 });
    expect(report.provider.statusCounts).toEqual({ create_200: 50, signIn_200: 50, delete_200: 50 });
  });
  /** A setup deadline during the pause must stop before another create and leave cleanup active. */
  test('setup deadline interrupts pacing, deletes the first account, and releases timers', async () => {
    jest.useFakeTimers();
    const pending = runProvider({}, profile({ setupTimeoutMs: 1000 }), jest.fn(), { clock: { now: Date.now, sleep } });
    await jest.advanceTimersByTimeAsync(1000);
    const { report, fixture } = await pending;
    expect(report.failureCounts).toEqual({ setup_deadline: 1 });
    expect(report).toMatchObject({ result: 'stopped', preparedSessions: 1, appRequests: 1 });
    expect(fixture.calls).toEqual({ create: 1, signIn: 1, delete: 1, list: 0, app: 1 });
    expect(report.provider).toMatchObject({ deleted: 1, cleanupFailed: 0, ownedRemaining: 0 });
    expect(jest.getTimerCount()).toBe(0);
  });
  /** Operator cancellation during pacing must not provision another account or leak the abort reason. */
  test('cancellation interrupts pacing and still deletes owned accounts without retries', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const pending = runProvider({}, profile(), jest.fn(), { signal: controller.signal, clock: { now: Date.now, sleep } });
    await jest.advanceTimersByTimeAsync(0);
    controller.abort('SYNTHETIC_PRIVATE_ABORT_REASON');
    const { report, fixture } = await pending;
    expect(report.failureCounts).toEqual({ cancelled: 1 });
    expect(report.preparedSessions).toBe(1);
    expect(fixture.calls).toEqual({ create: 1, signIn: 1, delete: 1, list: 0, app: 1 });
    expect(report.provider).toMatchObject({ deleted: 1, cleanupFailed: 0, ownedRemaining: 0 });
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC_PRIVATE_ABORT_REASON');
    expect(jest.getTimerCount()).toBe(0);
  });
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
  /** Preserve the numeric rejection status while stopping once and cleaning both owned accounts. */
  test.each([400, 429, 503])('sign-in HTTP %i is sanitized and cleans up without retries',
    /** Provider bodies/codes remain private even when their numeric status is useful for diagnosis. */
    async signInFailureStatus => {
      const { report, fixture } = await runProvider({ failSignInAt: 2, signInFailureStatus });
      expect(report.result).toBe('stopped');
      expect(report.failureCounts).toEqual({ sign_in_failed: 1 });
      expect(report.provider).toMatchObject({ created: 2, deleted: 2, cleanupFailed: 0 });
      expect(report.provider.statusCounts).toEqual({ create_200: 2, signIn_200: 1,
        [`signIn_${signInFailureStatus}`]: 1, delete_200: 2 });
      expect(report.requests.session).toBe(0);
      expect(fixture.calls).toEqual({ create: 2, signIn: 2, delete: 2, list: 0, app: 1 });
      expect(JSON.stringify(report)).not.toMatch(/SYNTHETIC|gate0-|example.invalid|00000000-/);
    });
  test('lost create response is reported as uncertain and no unknown/pre-existing account is deleted', async () => {
    const { report, fixture } = await runProvider({ failCreateAt: 2 });
    expect(report.result).toBe('stopped');
    expect(report.provider).toMatchObject({ createAttempts: 2, created: 1, deleted: 1, unconfirmedCreates: 1 });
    expect(fixture.calls.create).toBe(2);
    expect(fixture.calls.delete).toBe(1);
    expect(report.provider.reconciliationAttempts).toBe(1);
    expect(fixture.users.has(fixture.preExistingId)).toBe(true);
  });
  /** A committed create with a lost response must be found and deleted without repeating the create. */
  test('reconciles a lost successful create response before cleanup and keeps the run marker private', async () => {
    const persistMarker = jest.fn();
    const { report, fixture, services } = await runProvider({ loseCreateResponseAt: 2 }, profile(), persistMarker);
    expect(persistMarker).toHaveBeenCalledTimes(1);
    expect(report.provider).toMatchObject({ createAttempts: 2, signInAttempts: 1, created: 2,
      deleted: 2, unconfirmedCreates: 0, reconciled: 1, reconciliationAttempts: 1,
      reconciliationFailed: 0, ownedRemaining: 0 });
    expect(fixture.users.size).toBe(1);
    expect(fixture.users.has(fixture.preExistingId)).toBe(true);
    await services.cleanup();
    expect(fixture.calls).toMatchObject({ create: 2, list: 1, delete: 2 });
    expect(JSON.stringify(report)).not.toContain(persistMarker.mock.calls[0][0]);
    expect(JSON.stringify(report)).not.toMatch(/SYNTHETIC|example.invalid|00000000-/);
  });
  /** Recovery scans later pages and requires both server-owned tags and the attempted account identity. */
  test('finds an uncertain account on a later page while ignoring unrelated ownership tags', async () => {
    const { report, fixture } = await runProvider({ loseCreateResponseAt: 2,
      /** Put only unrelated users on page one, including partial tags and user-editable metadata. */
      listPage: (page, users) => {
        const lost = users.at(-1);
        return page === 1 ? [
          { ...lost, id: '90000000-0000-4000-8000-000000000002', app_metadata: { gate1_qualification: true, gate1_run: 'another-run' } },
          { ...lost, id: '90000000-0000-4000-8000-000000000003', app_metadata: { gate1_run: lost.app_metadata.gate1_run } },
          { ...lost, id: '90000000-0000-4000-8000-000000000004', app_metadata: {}, user_metadata: lost.app_metadata },
          ...Array(47).fill(users[0]),
        ] : [lost];
      } }, profile({ sessions: 3 }));
    expect(report.provider).toMatchObject({ reconciliationAttempts: 2, reconciliationFailed: 0,
      reconciled: 1, deleted: 2, unconfirmedCreates: 0 });
    expect(fixture.users.size).toBe(1);
  });
  /** Resolving all uncertain creates on a full page must avoid a needless, potentially failing request. */
  test('stops after a full page recovers all uncertain creates without requesting a later page', async () => {
    const { report, fixture } = await runProvider({ loseCreateResponseAt: 2, failListAt: 2,
      /** Fill page one with the recovered account and harmless padding; page two must never be requested. */
      listPage: (_page, users) => [...users, ...Array(50 - users.length).fill(users[0])] }, profile({ sessions: 3 }));
    expect(report.provider).toMatchObject({ reconciliationAttempts: 1, reconciled: 1,
      reconciliationFailed: 0, deleted: 2, ownedRemaining: 0, unconfirmedCreates: 0 });
    expect(fixture.calls.list).toBe(1);
    expect(report.failureCounts.reconciliation_failed).toBeUndefined();
    expect(report.failureCounts.cleanup_failed).toBeUndefined();
    expect(report.result).toBe('stopped');
    expect(fixture.users.size).toBe(1);
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC_PROVIDER_SECRET');
  });
  /** Invalid matching IDs cannot authorize deletion or prevent valid discoveries in the same page. */
  test('reports malformed ownership records while retaining valid discoveries', async () => {
    const { report, fixture } = await runProvider({ loseCreateResponseAt: 2,
      /** Prepend an invalid receipt and append a duplicate to exercise validation and deduplication. */
      listPage: (_page, users) => [{ ...users.at(-1), id: 'invalid-id' }, ...users, users.at(-1)] });
    expect(report.provider).toMatchObject({ reconciliationFailed: 1, reconciled: 1, deleted: 2, ownedRemaining: 0 });
    expect(report.failureCounts.reconciliation_failed).toBe(1);
    expect(fixture.calls.delete).toBe(2);
  });
  /** Failed discovery must not skip known accounts, and a failed deletion cannot skip a recovered account. */
  test.each([{ failListAt: 1, deleted: 1, uncertain: 1 }, { failDeleteAt: 1, deleted: 1, uncertain: 0 }])(
    'reports recovery failures and drains every confirmed account: %j',
    /** Exercise independent discovery/deletion failures while preserving the existing cleanup workers. */
    async ({ failListAt, failDeleteAt, deleted, uncertain }) => {
      const { report, fixture } = await runProvider({ loseCreateResponseAt: 2, failListAt, failDeleteAt });
      expect(report.provider.deleted).toBe(deleted);
      expect(report.provider.unconfirmedCreates).toBe(uncertain);
      expect(fixture.calls.delete).toBe(failListAt ? 1 : 2);
      expect(report.result).toBe('stopped');
      expect(fixture.users.has(fixture.preExistingId)).toBe(true);
    });
  /** Recovery on the final budgeted page succeeds even when that page is full. */
  test('recovers all uncertain creates on a full final budgeted page without reconciliation failure', async () => {
    const { report, fixture } = await runProvider({ loseCreateResponseAt: 2,
      /** Fill the only budgeted page while including the last uncertain account. */
      listPage: (_page, users) => [...users, ...Array(50 - users.length).fill(users[0])] });
    expect(report.provider).toMatchObject({ reconciliationAttempts: 1, reconciliationFailed: 0,
      reconciled: 1, deleted: 2, ownedRemaining: 0, unconfirmedCreates: 0 });
    expect(fixture.calls.list).toBe(1);
    expect(fixture.calls.create + fixture.calls.signIn + fixture.calls.list + fixture.calls.delete).toBe(6);
    expect(report.failureCounts.reconciliation_failed).toBeUndefined();
    expect(report.failureCounts.cleanup_failed).toBeUndefined();
  });
  /** Unresolved accounts must still surface scan-budget exhaustion or a later provider failure. */
  test.each([{ sessions: 2, failListAt: 0, attempts: 1 }, { sessions: 3, failListAt: 2, attempts: 2 }])(
    'reports incomplete reconciliation when an uncertain account remains: %j',
    /** Hide the uncertain account from full pages and verify known receipts are still cleaned up. */
    async ({ sessions, failListAt, attempts }) => {
      const { report, fixture } = await runProvider({ loseCreateResponseAt: 2, failListAt,
        /** Return unrelated users so the lost create stays unresolved across every successful page. */
        listPage: (_page, users) => Array(50).fill(users[0]),
      }, profile({ sessions }));
      expect(report.provider).toMatchObject({ reconciliationAttempts: attempts, reconciliationFailed: 1,
        reconciled: 0, deleted: 1, ownedRemaining: 0, unconfirmedCreates: 1 });
      expect(fixture.calls.list).toBe(attempts);
      expect(fixture.calls.delete).toBe(1);
      expect(report.failureCounts.reconciliation_failed).toBe(1);
      expect(report.result).toBe('stopped');
      expect(fixture.users.has(fixture.preExistingId)).toBe(true);
    });
  /** Durable persistence failure must stop provisioning before any credential-bearing provider request. */
  test('fails closed when the run marker cannot be persisted', async () => {
    /** Emulate a private filesystem failure; only its fixed public code may reach the report. */
    const persistMarker = jest.fn(() => { throw new Error('SYNTHETIC_PRIVATE_PATH'); });
    const { report, fixture } = await runProvider({}, profile(), persistMarker);
    expect(report.failureCounts.run_marker_failed).toBe(1);
    expect(fixture.calls).toMatchObject({ create: 0, signIn: 0, list: 0, delete: 0 });
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC_PRIVATE_PATH');
  });
  /** Verify the real persistence boundary writes only tags, flushes exclusively, and precedes creates. */
  test('persists the run marker once in the ignored recovery directory before provisioning', async () => {
    const mkdir = jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const write = jest.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    const config = profile();
    const fixture = providerFixture({
      /** Each synthetic create must observe a completed marker write. */
      onCreate: () => expect(write).toHaveBeenCalledTimes(1),
    });
    const services = createLiveServices(config, environment(), fixture.fetchImpl);
    const report = await withSuppressedDependencyConsole(() => runProfile(config, services,
      { clock: createOfflineServices(config).clock }));
    expect(report.result).toBe('completed');
    expect(write).toHaveBeenCalledTimes(1);
    const [filename, content, options] = write.mock.calls[0];
    const marker = JSON.parse(content);
    expect(marker).toEqual({ gate1_qualification: true, gate1_run: expect.any(String) });
    expect(path.basename(filename)).toBe(`${marker.gate1_run}.json`);
    expect(path.basename(path.dirname(filename))).toBe('gate1-runs');
    expect(mkdir).toHaveBeenCalledWith(path.dirname(filename), { recursive: true });
    expect(options).toEqual({ flag: 'wx', mode: 0o600, flush: true });
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
    const services = createLiveServices(config, environment(), fixture.fetchImpl, { persistMarker: jest.fn() });
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
    const services = createLiveServices(config, environment(), fixture.fetchImpl, { persistMarker: jest.fn() });
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
