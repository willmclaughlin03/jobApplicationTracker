/** Offline canary contracts: all HTTPS is mocked; real transport is forbidden throughout this suite. */
jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'), execFileSync: jest.fn(),
}));

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { LIMITS, CanaryError, profileTemplate, parseProfile, preparation, approvalId, selectedHeaders,
  evidenceDirectory, createStore, runCanary, readInput } = require('../../../scripts/gate1-secrets-canary');

const ROOT = path.resolve(__dirname, '../../..');
const CLI = path.join(ROOT, 'scripts/gate1-secrets-canary.js');
const LAUNCHER = path.join(ROOT, 'scripts/run-gate1-secrets-canary.ps1');
const START = Date.parse('2026-09-27T22:00:00.000Z');
const PROBE = 'c7'.repeat(32);
const BYPASS = 'fixture_only_bypass_credential';
const PRIVATE = 'untrusted_response_sentinel';
const LOADER = 'a1'.repeat(16);
const directories = [];
let nativeGuard;
beforeAll(() => { nativeGuard = jest.spyOn(https, 'request').mockImplementation(() => { throw new Error('Network forbidden'); }); });
beforeEach(() => {
  // Keep synthetic approvals independent of the developer's HEAD and pending edits.
  execFileSync.mockReset().mockImplementation((command, args, options) => {
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return profile().gitSha + '\n';
    if (command === 'git' && args[0] === 'status') return '';
    return jest.requireActual('node:child_process').execFileSync(command, args, options);
  });
});
afterEach(() => { expect(nativeGuard).not.toHaveBeenCalled(); jest.useRealTimers(); });
afterAll(() => {
  nativeGuard.mockRestore();
  for (const directory of directories) {
    if (!path.resolve(directory).startsWith(path.join(ROOT, '.tmp', 'secrets-test-'))) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** Return a synthetic immutable Preview identity with deliberate fixture attestations, never a hosted approval. */
function profile(time = START) {
  const value = { ...profileTemplate(), hostname: 'job-application-tracker-fixture-track-the-app.vercel.app',
    deploymentId: 'dpl_fixtureCanary', gitSha: '1'.repeat(40), nextBuildId: 'fixture-build', reviewedAt: new Date(time).toISOString() };
  for (const name of Object.keys(value.attestations)) value.attestations[name] = true;
  return value;
}

/** Emit the exact secret observation shape; cached is the request's pre-call permanent-failure state. */
function facts(marker, cached) {
  return { schemaVersion: 1, scope: 'secret_loader_observation_only', contextScope: 'loader', marker,
    effectiveMode: 'vercel', sourceResolution: 'accepted', canonicalFamily: 4, loaderReached: true,
    loaderStateBefore: { hasCachedPair: false, permanentFailure: cached },
    loader: { loaderId: LOADER, validationAttempts: 1, effectiveMode: 'vercel', validationStage: 'hmac',
      hmacInput: 'missing', redisInput: 'missing', hasCachedPair: false, permanentFailure: true },
    identityAttempted: false, redisAttempted: false, scriptAttempted: false, allowed: false, reason: 'secret_unavailable' };
}

/** Produce a valid login/probe response based solely on mocked request sequence; no deployment is contacted. */
function reply(options, index) {
  if (options.path === '/login') return { status: 200, headers: { 'content-type': 'text/html' },
    body: '<script id="__NEXT_DATA__" type="application/json">{"page":"/login","buildId":"fixture-build"}</script>' };
  return { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store',
    'x-vercel-cache': 'BYPASS', 'x-gate1-secrets-probe': JSON.stringify(facts(options.headers['User-Agent'], index === 2)) },
  body: JSON.stringify({ data: null, error: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable. Please try again later.' }) };
}

/** Simulate native streams and their failure modes; retain outgoing credentials only in test-local assertions. */
function transport(responder = reply) {
  const calls = [], requests = [], responses = [];
  const requestImpl = jest.fn((options, receive) => {
    const request = new EventEmitter(); request.destroy = jest.fn(); requests.push(request);
    request.end = jest.fn(() => {
      const index = calls.length; calls.push(options);
      Promise.resolve().then(() => {
        const result = responder(options, index);
        if (result.hang) return;
        if (result.error) { request.emit('error', new Error(PROBE)); return; }
        const response = new EventEmitter(); response.destroy = jest.fn(); responses.push(response);
        response.statusCode = result.status; response.complete = result.complete !== false;
        response.rawHeaders = result.rawHeaders || Object.entries(result.headers || {}).flat();
        receive(response);
        if (response.destroy.mock.calls.length || result.hangBody) return;
        if (result.earlyClose) { response.emit('close'); return; }
        for (const chunk of result.chunks || [Buffer.from(result.body || '')]) response.emit('data', chunk);
        if (result.aborted) response.emit('aborted'); else response.emit('end');
        response.emit('close');
      }).catch((error) => request.emit('error', error));
    });
    return request;
  });
  return { requestImpl, calls, requests, responses };
}

/** Execute a fixture-only trial with deterministic clocks and optional storage/error seams. */
async function trial(responder, changes = {}) {
  const wire = transport(responder), selected = changes.profile || profile();
  const input = { profile: selected, approval: approvalId(selected), liveApproved: true,
    credentials: { probeSecret: PROBE, bypassSecret: BYPASS }, ...changes.input };
  const result = await runCanary(input, { requestImpl: wire.requestImpl, now: () => 0, wall: () => START, ...changes.deps });
  return { ...result, ...wire };
}

/** Assert the output boundary excludes credentials, arbitrary responses and widened qualification claims. */
function expectPrivate(report) {
  const encoded = JSON.stringify(report);
  for (const value of [PROBE, BYPASS, PRIVATE, '192.0.2.28', 'Bearer ']) expect(encoded).not.toContain(value);
  expect(Buffer.byteLength(encoded)).toBeLessThan(LIMITS.reportBytes);
  expect(report).toMatchObject({ mode: 'fixture', gate1Status: 'open', hostedEvidence: 'not_executed',
    sourceAgreement: 'not_evaluated', providerRequests: 0, configMutations: 0, wafEvidence: 'not_qualified_by_this_run' });
}

/** Allocate isolated fixture files inside the current worktree, never historical evidence directories. */
function directory() {
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  const value = fs.mkdtempSync(path.join(ROOT, '.tmp', 'secrets-test-')); directories.push(value); return value;
}

describe('Preview canary approval and fixed sequence', () => {
  it('prepares offline and leaves the template deliberately unusable', () => {
    expect(() => parseProfile(profileTemplate())).toThrow('profile');
    expect(preparation()).toMatchObject({ appRequests: 0, providerRequests: 0, liveApproved: false, approvalId: null });
    expect(preparation(profile()).approvalId).toBe(approvalId(profile()));
    expect(approvalId(profile(START + 1))).not.toBe(approvalId(profile()));
  });

  it('checks HEAD and every bound file from the repository root before approving', () => {
    expect(approvalId(profile())).toMatch(/^[a-f0-9]{64}$/);
    const options = { cwd: ROOT, encoding: 'utf8', timeout: 3000, maxBuffer: 65536,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    expect(execFileSync.mock.calls).toEqual([
      ['git', ['rev-parse', 'HEAD'], options],
      ['git', ['status', '--porcelain', '--',
        'scripts/gate1-secrets-canary.js', 'scripts/run-gate1-secrets-canary.ps1',
        'scripts/gate1-host-protection.js', 'src/server/lib/gate1SecretsProbe.js',
        'src/server/lib/temporarySessionSecrets.js', 'src/server/lib/temporarySessionCeiling.js',
        'src/server/lib/temporarySessionSource.js', 'src/pages/api/auth/session.js',
        'src/server/middleware/withRateLimit.js', 'src/shared/response.js', 'src/shared/errors.js'], options],
    ]);
  });

  it.each([
    ['different HEAD', 'rev-parse', '2'.repeat(40)],
    ['modified file', 'status', ' M scripts/gate1-secrets-canary.js\n'],
    ['staged file', 'status', 'M  src/pages/api/auth/session.js\n'],
    ['deleted file', 'status', ' D src/shared/errors.js\n'],
    ['untracked file', 'status', '?? scripts/run-gate1-secrets-canary.ps1\n'],
    ['failed HEAD lookup', 'rev-parse', new Error(PRIVATE)],
    ['failed status lookup', 'status', new Error(PRIVATE)],
  ])('rejects %s before reading bound bytes without retaining Git output', (_label, command, result) => {
    execFileSync.mockImplementation((_file, args) => {
      if (args[0] !== command) return profile().gitSha + '\r\n';
      if (result instanceof Error) throw result;
      return result;
    });
    const read = jest.spyOn(fs, 'readFileSync');
    try {
      expect(() => approvalId(profile())).toThrow(expect.objectContaining({
        constructor: CanaryError, code: 'profile', message: 'profile',
      }));
      expect(read.mock.calls.filter(([name]) => typeof name === 'string' && name.startsWith(ROOT + path.sep))).toEqual([]);
    } finally { read.mockRestore(); }
  });

  it.each(['revision', 'changes', 'failure'])('rechecks checkout %s before storage or HTTP dispatch', async (change) => {
    const selected = profile(), approval = approvalId(selected), wire = transport(), save = jest.fn();
    execFileSync.mockImplementation((_file, args) => {
      if (change === 'failure') throw new Error(PRIVATE);
      if (args[0] === 'rev-parse') return change === 'revision' ? '2'.repeat(40) : selected.gitSha;
      return ' M scripts/gate1-secrets-canary.js\n';
    });
    const { report } = await runCanary({ profile: selected, approval, liveApproved: true,
      credentials: { probeSecret: PROBE, bypassSecret: BYPASS } },
    { requestImpl: wire.requestImpl, store: { save }, now: () => 0, wall: () => START });
    expect(report).toMatchObject({ result: 'stopped', failure: 'profile', stoppedPhase: 'validation', appRequests: 0 });
    expect(save).not.toHaveBeenCalled(); expect(wire.requestImpl).not.toHaveBeenCalled(); expectPrivate(report);
  });

  it('binds launcher, helper and application bytes into the approval', () => {
    const initial = approvalId(profile()), read = fs.readFileSync;
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((name, ...args) => {
      const value = read(name, ...args);
      return name === LAUNCHER ? Buffer.concat([value, Buffer.from('\n# fixture change')]) : value;
    });
    try { expect(approvalId(profile())).not.toBe(initial); } finally { spy.mockRestore(); }
  });

  it('validates four sequential exact GETs and same-loader failure without claiming hosted qualification', async () => {
    const { report, calls } = await trial();
    expect(report).toMatchObject({ result: 'completed', appRequests: 4, validatedRequests: 4,
      unvalidatedAttempts: 0, secretEvidence: 'missing_both_and_same_loader_failure_observed', failure: null, stoppedPhase: null });
    expect(calls.map((call) => call.path)).toEqual(['/login', '/api/auth/session', '/api/auth/session', '/login']);
    for (const [index, call] of calls.entries()) {
      expect(call).toMatchObject({ protocol: 'https:', hostname: profile().hostname, port: 443, method: 'GET',
        agent: false, rejectUnauthorized: true, maxHeaderSize: 16384 });
      expect(call.headers['x-vercel-protection-bypass']).toBe(BYPASS);
      expect(call.headers.Cookie).toBeUndefined();
      if (index === 1 || index === 2) {
        expect(call.headers.Authorization).toBe(`Bearer ${PROBE}`);
        expect(call.headers['x-gate1-secrets-diagnostic']).toBe('1');
      } else expect(call.headers.Authorization).toBeUndefined();
    }
    expect(calls[1].headers['User-Agent']).not.toBe(calls[2].headers['User-Agent']);
    expect(report.observations.map((row) => row.cacheStateBefore)).toEqual(['uninitialized', 'permanent_failure']);
    expect(report.observations.map((row) => row.loaderId)).toEqual([LOADER, LOADER]);
    expectPrivate(report);
  });

  it.each([
    { environment: 'production' }, { hostname: 'job-application-tracker-kappa-seven.vercel.app' },
    { hostname: 'job-application-tracker-fixture-track-the-app.vercel.app.evil.example' },
    { hostname: 'https://example.org' }, { hostname: '127.0.0.1' }, { projectId: 'prj_other' }, { teamId: 'team_other' },
    { accessMode: 'public' }, { deploymentId: '../escape' }, { gitSha: 'main' }, { nextBuildId: '../bad' },
    { attestations: {} }, { endpoint: PRIVATE },
  ])('rejects a widened or incomplete profile (%#)', async (change) => {
    const { report, calls } = await trial(undefined, { input: { profile: { ...profile(), ...change } } });
    expect(calls).toHaveLength(0); expect(report.result).toBe('stopped'); expectPrivate(report);
  });

  it.each([{ liveApproved: false }, { liveApproved: undefined }, { approval: '0'.repeat(64) },
    { credentials: { probeSecret: PROBE, bypassSecret: 'short' } },
    { credentials: { probeSecret: PROBE, bypassSecret: PROBE } },
    { credentials: { probeSecret: PROBE, bypassSecret: `${BYPASS}\n` } },
    { credentials: { probeSecret: PROBE, bypassSecret: BYPASS, extra: PRIVATE } }, { extra: PRIVATE }])(
    'rejects missing approval or invalid credentials before reservation (%#)', async (input) => {
      const save = jest.fn(); const { report, calls } = await trial(undefined, { input, deps: { store: { save } } });
      expect(calls).toHaveLength(0); expect(save).not.toHaveBeenCalled(); expectPrivate(report);
    });

  it.each([-LIMITS.profileAgeMs - 1, 1])('refuses stale/future review (%s)', async (offset) => {
    const { report, calls } = await trial(undefined, { profile: profile(START + offset) });
    expect(report.failure).toBe('profile'); expect(calls).toHaveLength(0);
  });

  it('refuses profile fields that contain a credential', async () => {
    const selected = { ...profile(), nextBuildId: BYPASS };
    const { report, calls } = await trial(undefined, { profile: selected });
    expect(report.failure).toBe('credentials'); expect(report.target).toBeNull(); expect(calls).toHaveLength(0); expectPrivate(report);
  });
});

describe('response and loader qualification', () => {
  it.each([0, 1, 2, 3])('stops on a redirect in phase %s with no follow-up', async (index) => {
    const { report, calls } = await trial((options, i) => i === index ? { ...reply(options, i), status: 302 } : reply(options, i));
    expect(calls).toHaveLength(index + 1); expect(report.failure).toBe('redirect');
    expect(report.validatedRequests).toBe(index); expect(report.unvalidatedAttempts).toBe(1); expectPrivate(report);
  });

  it.each([0, 3])('rejects a changed login build at phase %s', async (index) => {
    const { report, calls } = await trial((options, i) => {
      const response = reply(options, i); if (i === index) response.body = response.body.replace('fixture-build', 'different'); return response;
    });
    expect(report.failure).toBe('build_mismatch'); expect(calls).toHaveLength(index + 1);
  });

  it.each([
    ['source_rejected', (value) => { value.sourceResolution = 'rejected'; value.canonicalFamily = null; }],
    ['source_rejected', (value) => { value.effectiveMode = 'local'; }],
    ['secret_contract', (value) => { value.loaderReached = false; }],
    ['secret_contract', (value) => { value.loader = null; }],
    ['secret_contract', (value) => { value.loader.loaderId = null; }],
    ['secret_contract', (value) => { value.loader.validationAttempts = 2; }],
    ['secret_contract', (value) => { value.loader.validationStage = 'redis'; }],
    ['secret_contract', (value) => { value.loader.hmacInput = 'present'; }],
    ['secret_contract', (value) => { value.loader.redisInput = 'present'; }],
    ['secret_contract', (value) => { value.loader.hasCachedPair = true; }],
    ['secret_contract', (value) => { value.loader.permanentFailure = false; }],
    ['secret_contract', (value) => { value.identityAttempted = true; }],
    ['secret_contract', (value) => { value.redisAttempted = true; }],
    ['secret_contract', (value) => { value.scriptAttempted = true; }],
    ['secret_contract', (value) => { value.reason = 'source_invalid'; }],
    ['loader_already_initialized', (value) => { value.loaderStateBefore.permanentFailure = true; }],
    ['probe_contract', (value) => { value.marker = 'gate1-secrets-' + '0'.repeat(32); }],
    ['probe_contract', (value) => { value.extra = PRIVATE; }],
    ['probe_contract', (value) => { value.loader.extra = PRIVATE; }],
  ])('rejects ambiguous observation %s (%#)', async (code, mutate) => {
    const { report, calls } = await trial((options, index) => {
      const response = reply(options, index);
      if (index === 1) {
        const value = JSON.parse(response.headers['x-gate1-secrets-probe']); mutate(value);
        response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
      }
      return response;
    });
    expect(report.failure).toBe(code); expect(calls).toHaveLength(2); expect(report.observations).toEqual([]); expectPrivate(report);
  });

  it.each(['different', 'uncached'])('rejects a second loader that is %s', async (change) => {
    const { report, calls } = await trial((options, index) => {
      const response = reply(options, index);
      if (index === 2) {
        const value = JSON.parse(response.headers['x-gate1-secrets-probe']);
        if (change === 'different') value.loader.loaderId = 'b2'.repeat(16); else value.loaderStateBefore.permanentFailure = false;
        response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
      }
      return response;
    });
    expect(report.failure).toBe(change === 'different' ? 'loader_changed' : 'secret_contract'); expect(calls).toHaveLength(3);
  });

  it('rejects a credential echoed inside a schema-valid loader identifier before retaining it', async () => {
    const bypass = LOADER.slice(0, 16);
    const { report, calls } = await trial(undefined, { input: { credentials: { probeSecret: PROBE, bypassSecret: bypass } } });
    expect(report.failure).toBe('probe_contract'); expect(calls).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain(bypass); expect(report.observations).toEqual([]);
  });

  it.each([
    ['session_status', (response) => { response.status = 200; }],
    ['body_contract', (response) => { response.body = JSON.stringify({ error: PRIVATE }); }],
    ['body_contract', (response) => { response.body = PROBE; }],
    ['body_contract', (response) => { response.headers['content-type'] = 'text/html'; }],
    ['probe_contract', (response) => { delete response.headers['x-gate1-secrets-probe']; }],
    ['probe_contract', (response) => { response.headers['x-gate1-secrets-probe'] = PROBE; }],
    ['probe_contract', (response) => { response.headers['x-gate1-secrets-probe'] = 'a'.repeat(1537); }],
    ['cache_contract', (response) => { response.headers['cache-control'] = 'public, max-age=10'; }],
    ['cache_contract', (response) => { response.headers['x-vercel-cache'] = 'HIT'; }],
    ['cache_contract', (response) => { delete response.headers['x-vercel-cache']; }],
    ['cache_contract', (response) => { response.headers['retry-after'] = '1'; }],
    ['cache_contract', (response) => { response.headers['cdn-cache-control'] = 'no-store'; }],
    ['cookie_contract', (response) => { response.headers['set-cookie'] = PRIVATE; }],
  ])('rejects nonqualifying session contract %s (%#)', async (code, mutate) => {
    const { report, calls } = await trial((options, index) => { const response = reply(options, index); if (index === 1) mutate(response); return response; });
    expect(report.failure).toBe(code); expect(calls).toHaveLength(2); expectPrivate(report);
  });
});

describe('bounded streams, clocks and cancellation', () => {
  it.each([
    ['response_size', { body: 'a'.repeat(LIMITS.buildBytes + 1) }],
    ['response_size', { headers: { 'content-length': '1048577' } }],
    ['response_size', { headers: { 'content-length': '-1' } }],
    ['response_incomplete', { headers: { 'content-length': '100' }, body: 'short' }],
    ['response_encoding', { headers: { 'content-encoding': 'gzip' } }],
    ['response_headers', { rawHeaders: ['Cache-Control', 'private', 'cache-control', 'no-store'] }],
    ['response_headers', { rawHeaders: ['x-extra', 'a'.repeat(LIMITS.headerBytes)] }],
    ['response_headers', { rawHeaders: ['odd'] }],
    ['response_headers', { status: undefined }],
    ['response_incomplete', { complete: false }], ['response_incomplete', { aborted: true }],
    ['response_incomplete', { earlyClose: true }], ['response_incomplete', { chunks: ['not-buffer'] }],
    ['transport', { error: true }],
  ])('stops and destroys owned streams on %s (%#)', async (code, change) => {
    const { report, calls, requests, responses } = await trial((options, index) => ({ ...reply(options, index), ...change }));
    expect(report.failure).toBe(code); expect(calls).toHaveLength(1); expect(requests[0].destroy).toHaveBeenCalled();
    for (const response of responses) expect(response.destroy).toHaveBeenCalled(); expectPrivate(report);
  });

  it('bounds session bodies separately and ignores unselected private headers', async () => {
    expect(selectedHeaders(['x-private', PRIVATE])).toEqual({});
    const { report } = await trial((options, index) => ({ ...reply(options, index), ...(index === 1 ? { body: 'a'.repeat(8193) } : {}) }));
    expect(report.failure).toBe('response_size'); expect(report.appRequests).toBe(2);
  });

  it.each([false, true])('expires a request while waiting for %s response body', async (body) => {
    jest.useFakeTimers();
    const running = trial((options, index) => ({ ...reply(options, index), ...(body ? { hangBody: true } : { hang: true }) }));
    await jest.advanceTimersByTimeAsync(10001);
    const { report, calls, requests } = await running;
    expect(report.failure).toBe('deadline'); expect(calls).toHaveLength(1); expect(requests[0].destroy).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects cancellation before dispatch and while a response is pending', async () => {
    const before = new AbortController(); before.abort(PROBE);
    const first = await trial(undefined, { deps: { signal: before.signal } });
    expect(first.calls).toHaveLength(0); expect(first.report.failure).toBe('cancelled');
    const during = new AbortController();
    const next = await trial(() => { during.abort(PRIVATE); return { hang: true }; }, { deps: { signal: during.signal } });
    expect(next.report.failure).toBe('cancelled'); expect(next.calls).toHaveLength(1); expectPrivate(next.report);
  });

  it.each(['backward', 'overall', 'wall'])('stops before another request on a %s clock failure', async (kind) => {
    let elapsed = 0, wallDrift = 0;
    const { report, calls } = await trial((options, index) => {
      elapsed = kind === 'backward' ? -1 : kind === 'overall' ? 60000 : 0;
      wallDrift = kind === 'wall' ? 6000 : elapsed; return reply(options, index);
    }, { deps: { now: () => elapsed, wall: () => START + wallDrift } });
    expect(report.failure).toBe('deadline'); expect(calls).toHaveLength(1);
  });

  it('rechecks expiry after a slow checkpoint before the physical dispatch', async () => {
    let elapsed = 0, count = 0;
    const { report, calls } = await trial(undefined, { deps: { now: () => elapsed, wall: () => START + elapsed,
      store: { save() { count += 1; if (count === 2) elapsed = 60000; } } } });
    expect(report.failure).toBe('deadline'); expect(calls).toHaveLength(0);
  });

  it('reports failed-request elapsed time without allowing a clock exception to escape', async () => {
    let elapsed = 0;
    const timed = await trial(() => { elapsed = 250; return { error: true }; }, { deps: { now: () => elapsed } });
    expect(timed.report.elapsedMs).toBe(250);
    let broken = false;
    const failed = await trial(() => { broken = true; return { error: true }; }, {
      deps: { now: () => { if (broken) throw new Error(PRIVATE); return 0; } },
    });
    expect(failed.report).toMatchObject({ result: 'stopped', failure: 'transport', elapsedMs: null }); expectPrivate(failed.report);
  });
});

describe('durable evidence and consumed trials', () => {
  it('uses the same common-checkout directory across linked worktrees', () => {
    expect(evidenceDirectory()).toMatch(/[\\/]\.tmp[\\/]gate1-secrets-canary$/);
    expect(evidenceDirectory()).not.toContain(`${path.sep}worktrees${path.sep}`);
  });

  it('reserves deployment/case once, including a changed profile approval', () => {
    const location = directory(), selected = profile(), initial = approvalId(selected);
    const store = createStore(selected, initial, location);
    store.save({ result: 'stopped', fixture: true });
    expect(JSON.parse(fs.readFileSync(store.reportPath, 'utf8'))).toEqual({ result: 'stopped', fixture: true });
    expect(() => createStore(profile(START + 1), approvalId(profile(START + 1)), location)).toThrow('reservation');
    expect(fs.readdirSync(location).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a transient %s replacement while retaining the previous checkpoint', (code) => {
    const location = directory(), store = createStore(profile(), approvalId(profile()), location);
    store.save({ result: 'stopped' });
    const replace = fs.renameSync;
    const rename = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      expect(JSON.parse(fs.readFileSync(store.reportPath, 'utf8')).result).toBe('stopped');
      if (rename.mock.calls.length < 5) throw Object.assign(new Error(PRIVATE), { code });
      return replace(from, to);
    });
    const wait = jest.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    try {
      store.save({ result: 'completed' });
      expect(rename).toHaveBeenCalledTimes(5);
      expect(new Set(rename.mock.calls.map(([from]) => from)).size).toBe(1);
      expect(rename.mock.calls.every(([, to]) => to === store.reportPath)).toBe(true);
      expect(wait).toHaveBeenCalledTimes(4);
      for (const args of wait.mock.calls) expect(args).toEqual([expect.any(Int32Array), 0, 0, 25]);
    } finally { rename.mockRestore(); wait.mockRestore(); }
    expect(JSON.parse(fs.readFileSync(store.reportPath, 'utf8')).result).toBe('completed');
    expect(fs.readdirSync(location).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('bounds persistent %s retries and preserves the previous checkpoint', (code) => {
    const location = directory(), store = createStore(profile(), approvalId(profile()), location);
    store.save({ result: 'stopped' });
    const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      expect(JSON.parse(fs.readFileSync(store.reportPath, 'utf8')).result).toBe('stopped');
      throw Object.assign(new Error(PRIVATE), { code });
    });
    const wait = jest.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    try {
      expect(() => store.save({ result: 'completed' })).toThrow(new CanaryError('local_evidence'));
      expect(rename).toHaveBeenCalledTimes(5);
      expect(wait).toHaveBeenCalledTimes(4);
    } finally { rename.mockRestore(); wait.mockRestore(); }
    expect(JSON.parse(fs.readFileSync(store.reportPath, 'utf8')).result).toBe('stopped');
    expect(fs.readdirSync(location).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each([undefined, 'ENOENT', 'ENOSPC'])('retains the previous checkpoint without retrying nontransient failure %s', (code) => {
    const location = directory(), store = createStore(profile(), approvalId(profile()), location);
    store.save({ result: 'stopped' });
    const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error(PRIVATE), { code }); });
    const wait = jest.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    try {
      expect(() => store.save({ result: 'completed' })).toThrow(new CanaryError('local_evidence'));
      expect(rename).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
    } finally { rename.mockRestore(); wait.mockRestore(); }
    expect(JSON.parse(fs.readFileSync(store.reportPath, 'utf8')).result).toBe('stopped');
    expect(fs.readdirSync(location).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('consumes the reservation even if its initial durable write fails', () => {
    const location = directory(), selected = profile(), digest = approvalId(selected);
    const sync = jest.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error(PRIVATE); });
    try { expect(() => createStore(selected, digest, location)).toThrow('local_evidence'); } finally { sync.mockRestore(); }
    expect(() => createStore(selected, digest, location)).toThrow('reservation');
    expect(fs.readdirSync(location)).toHaveLength(1);
  });

  it('rejects redirected storage before creating a reservation', () => {
    const location = directory(), stat = fs.lstatSync;
    const spy = jest.spyOn(fs, 'lstatSync').mockImplementation((name, ...args) =>
      name === location ? { isSymbolicLink: () => true } : stat(name, ...args));
    try { expect(() => createStore(profile(), approvalId(profile()), location)).toThrow('local_evidence'); }
    finally { spy.mockRestore(); }
    expect(fs.readdirSync(location)).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('stops on checkpoint failure %s and never persists a passing final result', async (failAt) => {
    let count = 0, retained = null;
    const save = jest.fn((report) => {
      count += 1; if (count >= failAt) throw new Error(PRIVATE); retained = JSON.parse(JSON.stringify(report));
    });
    const { report, calls } = await trial(undefined, { deps: { store: { reportPath: null, save } } });
    const phase = failAt === 1 ? 'validation' : failAt === 10 ? 'report'
      : ['buildBefore', 'probe1', 'probe2', 'buildAfter'][Math.floor((failAt - 2) / 2)];
    expect(report).toMatchObject({ result: 'stopped', secretEvidence: 'unqualified', failure: 'local_evidence',
      stoppedPhase: phase, finalCheckpoint: 'failed' });
    expect(calls.length).toBe(Math.min(4, Math.floor((failAt - 1) / 2)));
    if (retained) expect(retained.result).toBe('stopped'); expectPrivate(report);
  });

  it.each([
    ['transport', 'buildBefore', 0], ['build_mismatch', 'buildAfter', 3], ['deadline', 'probe2', 2],
  ])('preserves %s in %s when the final checkpoint also fails', async (failure, phase, failedIndex) => {
    let elapsed = 0, retained = null;
    const save = jest.fn((report) => {
      if (report.failure !== null) throw new Error(PRIVATE);
      retained = JSON.parse(JSON.stringify(report));
    });
    const { report, calls } = await trial((options, index) => {
      const response = reply(options, index);
      if (index !== failedIndex) return response;
      if (failure === 'transport') return { error: true };
      if (failure === 'build_mismatch') response.body = response.body.replace('fixture-build', 'different');
      else elapsed = LIMITS.overallMs;
      return response;
    }, { deps: { store: { reportPath: null, save }, now: () => elapsed, wall: () => START + elapsed } });
    expect(report).toMatchObject({ result: 'stopped', secretEvidence: 'unqualified', failure,
      stoppedPhase: phase, finalCheckpoint: 'failed' });
    expect(calls).toHaveLength(failedIndex + 1);
    expect(retained.result).toBe('stopped'); expectPrivate(report);
  });

  it('stores the bounded completed fixture and refuses unsafe reservation identifiers', async () => {
    const location = directory(), selected = profile();
    const store = createStore(selected, approvalId(selected), location);
    const { report } = await trial(undefined, { deps: { store } });
    expect(JSON.parse(fs.readFileSync(store.reportPath, 'utf8'))).toEqual(report);
    expect(report).toMatchObject({ result: 'completed', failure: null, stoppedPhase: null });
    expect(report).not.toHaveProperty('finalCheckpoint');
    expect(() => createStore({ ...selected, deploymentId: '../escape' }, approvalId(selected), location)).toThrow('profile');
    expect(() => createStore(selected, '../escape', location)).toThrow('approval');
    expect(() => store.save({ data: 'a'.repeat(16385) })).toThrow('local_evidence');
  });
});

describe('bounded stdin and offline CLI', () => {
  it('accepts BOM JSON and releases input listeners', async () => {
    const stream = new PassThrough(), running = readInput(stream);
    stream.end('\uFEFF{"fixture":true}'); expect(await running).toEqual({ fixture: true });
    expect(stream.listenerCount('data')).toBe(0); expect(stream.listenerCount('end')).toBe(0);
  });
  it.each([PROBE, 'a'.repeat(16385)])('rejects malformed/oversize input without echo (%#)', async (value) => {
    const stream = new PassThrough(), running = readInput(stream); stream.end(value); await expect(running).rejects.toThrow('input');
  });
  it('bounds an unfinished stdin stream', async () => {
    jest.useFakeTimers(); const stream = new PassThrough(), running = readInput(stream);
    const assertion = expect(running).rejects.toThrow('input'); await jest.advanceTimersByTimeAsync(15001); await assertion;
    expect(stream.listenerCount('data')).toBe(0);
  });
  it.each([[], ['--template'], ['--review'], ['--live'], ['--unknown']].map((args) => [args]))('keeps CLI offline without a valid live envelope (%j)', (args) => {
    const output = spawnSync(process.execPath, [CLI, ...args], { input: args[0] === '--review' ? JSON.stringify(profile()) : '{}',
      encoding: 'utf8', timeout: 5000, maxBuffer: 32768, windowsHide: true });
    expect(output.error).toBeUndefined();
    if (args[0] === '--live') { expect(JSON.parse(output.stdout).report.appRequests).toBe(0); expect(output.status).toBe(1); }
    else if (args[0] === '--unknown' || args[0] === '--review') expect(output.status).toBe(1);
    else expect(output.status).toBe(0);
    expect(output.stdout + output.stderr).not.toContain(PROBE);
  });
});

const windows = process.platform === 'win32' ? describe : describe.skip;
windows('PowerShell launcher offline fixtures', () => {
  /** Run only local PowerShell helpers; supplied code uses mocked credentials and never calls real live HTTP. */
  function powershell(source) {
    const file = path.join(directory(), 'fixture.ps1'); fs.writeFileSync(file, source);
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, windowsHide: true });
  }
  /** Quote trusted local fixture paths as literal PowerShell strings, never shell interpolation. */
  function quoted(value) { return "'" + value.replace(/'/g, "''") + "'"; }

  it('starts offline by default and returns Node preparation', () => {
    const output = powershell(`& ${quoted(LAUNCHER)}\nexit $LASTEXITCODE`);
    expect(output.status).toBe(0); expect(JSON.parse(output.stdout)).toMatchObject({ mode: 'prepare', liveApproved: false, appRequests: 0 });
  });

  it.each(['approve', 'wrong_hash', 'wrong_limits', 'cancel', 'offline', 'invalid_checkout'])('reviews before hidden prompts (%s)', (mode) => {
    const location = directory(), file = path.join(location, 'profile.json'); fs.writeFileSync(file, JSON.stringify(profile()));
    const digest = approvalId(profile());
    const output = powershell(`
. ${quoted(LAUNCHER)}
$ProfilePath = ${quoted(file)}
$Live = ${mode === 'offline' ? '$false' : '$true'}
$Approval = ${mode === 'offline' ? '$null' : quoted(mode === 'wrong_hash' ? '0'.repeat(64) : digest)}
$script:originalNode = (Get-Item Function:Invoke-Gate1SecretsNode).ScriptBlock
$script:prompts = 0
$script:liveCalls = 0
function Invoke-Gate1SecretsNode([string]$Mode, [string]$InputJson = '') {
    if ($Mode -ceq '--live') {
        $script:liveCalls++
        $value = $InputJson | ConvertFrom-Json
        if ($value.credentials.probeSecret -cne '${PROBE}' -or $value.credentials.bypassSecret -cne '${BYPASS}' -or $value.liveApproved -ne $true) { throw 'Fixture envelope failed' }
        return @{ Json = '{"fixture":true}'; ExitCode = 7 }
    }
    # Fixture reviews isolate launcher approval checks; invalid_checkout exercises the real Git guard.
    if ($Mode -ceq '--review' -and '${mode}' -cne 'invalid_checkout') {
        $value = @{ Json = ${quoted(JSON.stringify(preparation(profile())))}; ExitCode = 0 }
    } else { $value = & $script:originalNode $Mode $InputJson }
    ${mode === 'wrong_limits' ? "$parsed = $value.Json | ConvertFrom-Json; $parsed.limits.maxAppRequests = 5; $value.Json = $parsed | ConvertTo-Json -Depth 10" : ''}
    return $value
}
function Read-Host { return '${mode === 'cancel' ? 'CANCEL' : 'RUN PREVIEW CANARY ONCE'}' }
function Read-Gate1SecretsCredential([string]$Prompt) { $script:prompts++; if ($script:prompts -eq 1) { return '${PROBE}' }; return '${BYPASS}' }
try { $result = Invoke-Gate1SecretsCanary; $stopped = $false } catch { $stopped = $true }
@{ stopped = $stopped; prompts = $script:prompts; liveCalls = $script:liveCalls; exitCode = $result.ExitCode } | ConvertTo-Json
`);
    expect(output.status).toBe(0); const value = JSON.parse(output.stdout);
    if (mode === 'approve') expect(value).toMatchObject({ stopped: false, prompts: 2, liveCalls: 1, exitCode: 7 });
    else if (mode === 'offline') expect(value).toMatchObject({ stopped: false, prompts: 0, liveCalls: 0 });
    else expect(value).toMatchObject({ stopped: true, prompts: 0, liveCalls: 0 });
    expect(output.stdout + output.stderr).not.toContain(PROBE); expect(output.stdout + output.stderr).not.toContain(BYPASS);
  });

  it.each(['stdout', 'stderr'])('caps child %s while draining without exposing content', (stream) => {
    const location = directory(), launcher = path.join(location, 'run-gate1-secrets-canary.ps1');
    fs.copyFileSync(LAUNCHER, launcher);
    fs.writeFileSync(path.join(location, 'gate1-secrets-canary.js'), `process.${stream}.write('${PRIVATE}'.repeat(5000));`);
    const output = powershell(`& ${quoted(launcher)}\nexit $LASTEXITCODE`);
    expect(output.status).toBe(1); expect(output.stdout + output.stderr).not.toContain(PRIVATE);
  });
});
