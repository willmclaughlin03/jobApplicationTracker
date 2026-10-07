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
const { randomBytes } = require('node:crypto');
const { createTemporarySessionSecrets, parseTemporarySessionHmacSecret,
  parseTemporarySessionRedisSecret } = require('../../server/lib/temporarySessionSecrets');
const { createTemporarySessionCeiling } = require('../../server/lib/temporarySessionCeiling');
const { createGate1SecretsProbe } = require('../../server/lib/gate1SecretsProbe');
const { LIMITS, SUCCESS_CASE, DIAGNOSTIC_CASE, PREVIEW_DIAGNOSTIC_CASE, RECORDED_CASE, DIAGNOSTIC_LIMITS, CanaryError, profileTemplate, parseProfile, preparation, approvalId, selectedHeaders,
  evidenceDirectory, createStore, runCanary, readInput, reviewProbe } = require('../../../scripts/gate1-secrets-canary');

const ROOT = path.resolve(__dirname, '../../..');
const CLI = path.join(ROOT, 'scripts/gate1-secrets-canary.js');
const LAUNCHER = path.join(ROOT, 'scripts/run-gate1-secrets-canary.ps1');
const START = Date.parse('2026-09-27T22:00:00.000Z');
const PROBE = 'c7'.repeat(32);
const BYPASS = 'fixture_only_bypass_credential';
const PRIVATE = 'untrusted_response_sentinel';
const LOADER = 'a1'.repeat(16);
const SYNTHETIC_CASES = [
  { id: RECORDED_CASE, stage: 'redis', redisInput: 'missing', recorded: true, legacyId: 'redis_input_missing',
    fixtureId: 'synthetic_hmac_redis_absent_v1', scope: 'preview_missing_redis_recorded_initialization_only',
    evidence: 'recorded_missing_redis_initialization_and_same_loader_failure_observed', template: 'RecordedMissingRedisTemplate',
    option: '--template-recorded-missing-redis', confirmation: 'RUN PREVIEW RECORDED MISSING REDIS ONCE' },
  { id: 'hmac_input_malformed_recorded_initialization', stage: 'hmac', redisInput: 'missing', recorded: true,
    legacyId: 'hmac_input_malformed', fixtureId: 'invalid_hmac_json_redis_absent_v1',
    scope: 'preview_malformed_hmac_recorded_initialization_only',
    evidence: 'recorded_malformed_hmac_initialization_and_same_loader_failure_observed', template: 'RecordedMalformedHmacTemplate',
    option: '--template-recorded-malformed-hmac', confirmation: 'RUN PREVIEW RECORDED MALFORMED HMAC ONCE' },
  { id: 'redis_input_malformed_recorded_initialization', stage: 'redis', redisInput: 'present', recorded: true,
    legacyId: 'redis_input_malformed', fixtureId: 'synthetic_hmac_invalid_redis_json_v1',
    scope: 'preview_malformed_redis_recorded_initialization_only',
    evidence: 'recorded_malformed_redis_initialization_and_same_loader_failure_observed', template: 'RecordedMalformedRedisTemplate',
    option: '--template-recorded-malformed-redis', confirmation: 'RUN PREVIEW RECORDED MALFORMED REDIS ONCE' },
  { id: 'redis_input_missing', stage: 'redis', redisInput: 'missing',
    fixtureId: 'synthetic_hmac_redis_absent_v1', scope: 'preview_missing_redis_only',
    evidence: 'missing_redis_and_same_loader_failure_observed', template: 'MissingRedisTemplate',
    option: '--template-missing-redis', confirmation: 'RUN PREVIEW MISSING REDIS ONCE' },
  { id: 'hmac_input_malformed', stage: 'hmac', redisInput: 'missing',
    fixtureId: 'invalid_hmac_json_redis_absent_v1', scope: 'preview_malformed_hmac_only',
    evidence: 'malformed_hmac_and_same_loader_failure_observed', template: 'MalformedHmacTemplate',
    option: '--template-malformed-hmac', confirmation: 'RUN PREVIEW MALFORMED HMAC ONCE' },
  { id: 'redis_input_malformed', stage: 'redis', redisInput: 'present',
    fixtureId: 'synthetic_hmac_invalid_redis_json_v1', scope: 'preview_malformed_redis_only',
    evidence: 'malformed_redis_and_same_loader_failure_observed', template: 'MalformedRedisTemplate',
    option: '--template-malformed-redis', confirmation: 'RUN PREVIEW MALFORMED REDIS ONCE' },
];
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
function profile(time = START, caseId) {
  const value = { ...profileTemplate(caseId), hostname: 'job-application-tracker-fixture-track-the-app.vercel.app',
    deploymentId: 'dpl_fixtureCanary', gitSha: '1'.repeat(40), nextBuildId: 'fixture-build', reviewedAt: new Date(time).toISOString() };
  if ([DIAGNOSTIC_CASE, PREVIEW_DIAGNOSTIC_CASE].includes(caseId)) value.trace = { schemaVersion: 1, marker: `gate1-secrets-${'b'.repeat(32)}`,
    startsAt: new Date(START).toISOString(), expiresAt: new Date(START + 900000).toISOString() };
  for (const name of Object.keys(value.attestations)) value.attestations[name] = true;
  return value;
}

/** Emit the exact secret observation shape; cached is the request's pre-call permanent-failure state. */
function facts(marker, cached) {
  return { schemaVersion: 2, environment: 'preview', scope: 'secret_loader_observation_only', contextScope: 'loader', marker,
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

/** Supply controlled stage/presence facts for adversarial synthetic-case responses without HTTP. */
function syntheticReply(options, index, spec) {
  const response = reply(options, index);
  if (options.path !== '/login') {
    const value = JSON.parse(response.headers['x-gate1-secrets-probe']);
    Object.assign(value.loader, { validationStage: spec.stage, hmacInput: 'present', redisInput: spec.redisInput });
    if (spec.recorded) {
      value.schemaVersion = 3;
      value.loader.initialization = initializationRecord(spec);
    }
    response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
  }
  return response;
}

/** Build the selected case's independent expected record, without values or initial-request attribution. */
function initializationRecord(spec) {
  return { schemaVersion: 1, priorHasCachedPair: false, priorPermanentFailure: false,
    validationAttemptsBefore: 0, validationAttempts: 1, effectiveMode: 'vercel', validationStage: spec.stage,
    hmacInput: 'present', redisInput: spec.redisInput, hasCachedPair: false, permanentFailure: true };
}

/** Builds the Production success contract with either observed initialization or a warm first loader. */
function successReply(options, index, warm = false) {
  const response = reply(options, index);
  if (options.path === '/login') return response;
  const value = facts(options.headers['User-Agent'], false);
  value.environment = 'production';
  value.loaderStateBefore = { hasCachedPair: warm || index === 2, permanentFailure: false };
  Object.assign(value.loader, { validationStage: 'complete', hmacInput: 'present', redisInput: 'present',
    hasCachedPair: true, permanentFailure: false });
  Object.assign(value, { identityAttempted: true, redisAttempted: true, scriptAttempted: true, allowed: true, reason: null });
  response.status = 200;
  response.body = JSON.stringify({ data: { user: null }, error: null, message: 'Success' });
  response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
  return response;
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
  if (report.failure !== 'probe_contract') expect(report.probeFailure).toBeNull();
  if (!['secret_contract', 'loader_changed', 'loader_already_initialized'].includes(report.failure)) {
    expect(report.secretFailure).toBeNull();
  }
  if (report.secretFailure) {
    const detail = JSON.stringify(report.secretFailure);
    for (const value of [LOADER, 'gate1-secrets-', 'loaderId"', 'marker"', 'reason"']) expect(detail).not.toContain(value);
  }
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
        'src/server/lib/gate1SecretsTrace.js', 'src/shared/logger.js',
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
    let failure, reads;
    try {
      try { approvalId(profile()); } catch (error) { failure = error; }
      // Snapshot before Jest's error matchers can lazily read their own source files.
      reads = [...read.mock.calls];
    } finally { read.mockRestore(); }
    expect(failure).toBeInstanceOf(CanaryError);
    expect(failure).toMatchObject({ code: 'profile', message: 'profile' });
    expect(reads).toEqual([]);
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

describe.each(SYNTHETIC_CASES)('synthetic Preview qualification: $id', (spec) => {
  it('binds a fixed fixture and false template attestations without generating secret inputs', () => {
    const template = profileTemplate(spec.id), selected = profile(START, spec.id), prepared = preparation(selected);
    expect(template).toMatchObject({ caseId: spec.id, environment: 'preview', fixtureId: spec.fixtureId });
    expect(Object.values(template.attestations).every((value) => value === false)).toBe(true);
    expect(() => parseProfile(template)).toThrow('profile');
    expect(prepared).toMatchObject({ scope: spec.scope, liveApproved: false, appRequests: 0, providerRequests: 0,
      limits: LIMITS, sequence: ['buildBefore', 'probe1', 'probe2', 'buildAfter'] });
    expect(prepared.limitations).toContain('fixture_provenance_operator_attested');
    expect(prepared.limitations).not.toContain('no_hosted_success_or_malformed_cases');
    expect(new Set([approvalId(profile()), ...SYNTHETIC_CASES.map((entry) => approvalId(profile(START, entry.id)))]).size)
      .toBe(SYNTHETIC_CASES.length + 1);
    for (const key of Object.keys(selected.attestations)) {
      expect(() => parseProfile({ ...selected, attestations: { ...selected.attestations, [key]: false } })).toThrow('profile');
    }
  });

  /** Compose real loader, ceiling and authenticated probe; only HTTP transport and downstream dependencies are mocked. */
  it.each(spec.recorded ? [false, true] : [false])('qualifies real parser failure and reuse (warm=%s)', async (warm) => {
    const key = randomBytes(32).toString('base64url');
    const hmac = JSON.stringify({ schemaVersion: 1, active: { generation: 1, keyId: 'gate1_fixture', key }, previous: null });
    const malformed = '{';
    expect(() => parseTemporarySessionHmacSecret(hmac)).not.toThrow();
    expect(() => parseTemporarySessionHmacSecret(malformed)).toThrow('temporary session secrets are unavailable');
    expect(() => parseTemporarySessionRedisSecret(malformed)).toThrow('temporary session secrets are unavailable');
    const env = { NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview', TEMPORARY_SESSION_CEILING_SECRET_MODE: 'vercel',
      GATE1_SECRETS_PROBE_ENABLED: 'true', GATE1_SECRETS_PROBE_SECRET: PROBE,
      TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON: spec.stage === 'hmac' ? malformed : hmac,
      ...(spec.redisInput === 'present' ? { TEMPORARY_SESSION_CEILING_UPSTASH_JSON: malformed } : {}) };
    const events = jest.fn(), loader = createTemporarySessionSecrets({ env, onEvent: events });
    const deriveIdentity = jest.fn(), getRedisClientFunction = jest.fn(), executeScript = jest.fn();
    const ceiling = createTemporarySessionCeiling({ env, sourceMode: 'vercel', secrets: loader,
      resolveSource: jest.fn(() => ({ family: 4, addressBytes: Buffer.from([192, 0, 2, 80]) })),
      deriveIdentity, getRedisClientFunction, executeScript,
      telemetry: { record: jest.fn(), finish: jest.fn(), maybeRotate: jest.fn() } });
    const expectedDecision = { allowed: false, statusCode: 503, reason: 'secret_unavailable' };
    if (warm) await expect(ceiling.evaluate({}, { routeVersion: 'v1' })).resolves.toEqual(expectedDecision);
    const observations = [];
    for (let i = 0; i < 2; i += 1) {
      const observeSecrets = jest.fn();
      await expect(ceiling.evaluate({}, { routeVersion: 'v1', observeSecrets })).resolves.toEqual(expectedDecision);
      expect(observeSecrets).toHaveBeenCalledTimes(1);
      observations.push(observeSecrets.mock.calls[0][0]);
    }
    expect(events).toHaveBeenCalledTimes(1);
    expect(deriveIdentity).not.toHaveBeenCalled();
    expect(getRedisClientFunction).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
    const { report, calls } = await trial((options, index) => {
      const response = reply(options, index);
      if (options.path !== '/login') {
        delete response.headers['x-gate1-secrets-probe'];
        const headers = Object.fromEntries(Object.entries(options.headers).map(([name, value]) => [name.toLowerCase(), value]));
        const req = { method: 'GET', headers, rawHeaders: Object.entries(headers).flat() };
        const res = { setHeader: jest.fn((name, value) => { response.headers[name.toLowerCase()] = value; }) };
        const observer = createGate1SecretsProbe({ env }).createObserver(req, res);
        expect(observer).toEqual(expect.any(Function));
        observer(observations[index - 1]);
      }
      return response;
    }, { profile: profile(START, spec.id) });
    expect(report).toMatchObject({ result: 'completed', scope: spec.scope, secretEvidence: spec.evidence,
      appRequests: 4, validatedRequests: 4, unvalidatedAttempts: 0, failure: null });
    expect(calls.map((call) => call.path)).toEqual(['/login', '/api/auth/session', '/api/auth/session', '/login']);
    expect(report.observations.map((o) => o.cacheStateBefore)).toEqual([warm ? 'permanent_failure' : 'uninitialized', 'permanent_failure']);
    expect(calls.filter((call) => call.path === '/api/auth/session')
      .map((call) => call.headers['x-gate1-secrets-diagnostic'])).toEqual(spec.recorded ? ['2', '2'] : ['1', '1']);
    if (spec.recorded) {
      expect(report.initializationEvidence).toBe('recorded_by_loader_observed_via_probes');
      expect(report.observations.map((o) => o.initialization)).toEqual([initializationRecord(spec), initializationRecord(spec)]);
    }
    expect(new Set(report.observations.map((o) => o.loaderId)).size).toBe(1);
    for (const observation of report.observations) expect(observation).toMatchObject({
      hmacInput: 'present', redisInput: spec.redisInput, validationStage: spec.stage,
      validationAttempts: 1, hasCachedPair: false, permanentFailure: true, downstreamAttempted: false });
    expect(JSON.stringify(report)).not.toContain(key);
    expect(JSON.stringify(report)).not.toContain(hmac);
    expectPrivate(report);
  });

  it.each(['production', 'fixture', 'raw_fixture', 'unknown', 'unattested'])('rejects %s profiles before storage or traffic', async (change) => {
    const selected = profile(START, spec.id), invalid = JSON.parse(JSON.stringify(selected)), save = jest.fn();
    if (change === 'production') invalid.environment = 'production';
    if (change === 'fixture') invalid.fixtureId = 'unreviewed_fixture';
    if (change === 'raw_fixture') invalid.fixture = PRIVATE;
    if (change === 'unknown') invalid.caseId = '__proto__';
    if (change === 'unattested') delete invalid.attestations.fixtureLocallyValidated;
    const { report, calls } = await trial(undefined, { profile: selected, input: { profile: invalid }, deps: { store: { save } } });
    expect(report.failure).toBe('input'); expect(calls).toHaveLength(0); expect(save).not.toHaveBeenCalled(); expectPrivate(report);
  });

  it('rejects another case approval before storage or HTTP', async () => {
    const save = jest.fn();
    const other = SYNTHETIC_CASES.find((entry) => entry.id !== spec.id);
    const { report, calls } = await trial(undefined, { profile: profile(START, spec.id),
      input: { approval: approvalId(profile(START, other.id)) }, deps: { store: { save } } });
    expect(report.failure).toBe('approval'); expect(calls).toHaveLength(0); expect(save).not.toHaveBeenCalled(); expectPrivate(report);
  });

  it.each([
    ['wrong stage', 'secret_contract', (v) => { v.loader.validationStage = spec.stage === 'redis' ? 'hmac' : 'redis'; }],
    ['missing HMAC', 'secret_contract', (v) => { v.loader.hmacInput = 'missing'; }],
    ['wrong Redis presence', 'secret_contract', (v) => { v.loader.redisInput = spec.redisInput === 'missing' ? 'present' : 'missing'; }],
    ['unread input', 'secret_contract', (v) => { v.loader.redisInput = 'not_read'; }],
    ['revalidation', 'secret_contract', (v) => { v.loader.validationAttempts = 2; }],
    ['cached pair', 'secret_contract', (v) => { v.loader.hasCachedPair = true; }],
    ['nonpermanent failure', 'secret_contract', (v) => { v.loader.permanentFailure = false; }],
    ['identity work', 'secret_contract', (v) => { v.identityAttempted = true; }],
    ['Redis work', 'secret_contract', (v) => { v.redisAttempted = true; }],
    ['script work', 'secret_contract', (v) => { v.scriptAttempted = true; }],
    ['allow', 'secret_contract', (v) => { v.allowed = true; }],
    ['source rejection', 'source_rejected', (v) => { v.sourceResolution = 'rejected'; }],
    ['warm first loader', 'loader_already_initialized', (v) => { v.loaderStateBefore.permanentFailure = true; }],
    ['credential-shaped extra', 'probe_contract', (v) => { v.loader.fixtureValue = PRIVATE; }],
  ].filter(([name]) => !spec.recorded || name !== 'warm first loader'))('rejects %s even with a 503 and stops before probe2', async (_label, failure, mutate) => {
    const { report, calls } = await trial((options, index) => {
      const response = syntheticReply(options, index, spec);
      if (index === 1) {
        const value = JSON.parse(response.headers['x-gate1-secrets-probe']); mutate(value);
        response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
      }
      return response;
    }, { profile: profile(START, spec.id) });
    expect(report).toMatchObject({ result: 'stopped', failure, secretEvidence: 'unqualified', stoppedPhase: 'probe1' });
    expect(report.observations).toEqual([]); expect(calls).toHaveLength(2); expectPrivate(report);
  });

  it.each(['different', 'uncached'])('rejects a %s second loader without retry', async (change) => {
    const { report, calls } = await trial((options, index) => {
      const response = syntheticReply(options, index, spec);
      if (index === 2) {
        const value = JSON.parse(response.headers['x-gate1-secrets-probe']);
        if (change === 'different') value.loader.loaderId = 'b2'.repeat(16); else value.loaderStateBefore.permanentFailure = false;
        response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
      }
      return response;
    }, { profile: profile(START, spec.id) });
    expect(report.failure).toBe(change === 'different' ? 'loader_changed' : 'secret_contract');
    expect(report.secretEvidence).toBe('unqualified'); expect(calls).toHaveLength(3); expectPrivate(report);
  });

  it.each(['header_missing', 'status', 'body', 'cache', 'size', 'redirect'])('stops on %s and preserves consumed evidence', async (change) => {
    const selected = profile(START, spec.id), location = directory(), store = createStore(selected, approvalId(selected), location);
    const { report, calls } = await trial((options, index) => {
      const response = syntheticReply(options, index, spec);
      if (index === 1) {
        if (change === 'header_missing') delete response.headers['x-gate1-secrets-probe'];
        if (change === 'status') response.status = 200;
        if (change === 'body') response.body = JSON.stringify({ error: PRIVATE });
        if (change === 'cache') response.headers['x-vercel-cache'] = 'HIT';
        if (change === 'size') response.body = PRIVATE.repeat(8192);
        if (change === 'redirect') response.status = 307;
      }
      return response;
    }, { profile: selected, deps: { store } });
    expect(report).toMatchObject({ result: 'stopped', secretEvidence: 'unqualified', stoppedPhase: 'probe1' });
    expect(calls).toHaveLength(2); expect(JSON.parse(fs.readFileSync(store.reportPath))).toEqual(report);
    const fresh = profile(START + 1, spec.id);
    expect(() => createStore(fresh, approvalId(fresh), location)).toThrow('reservation'); expectPrivate(report);
  });

  it('expires a hung session once without attempting another request', async () => {
    jest.useFakeTimers();
    const running = trial((options, index) => index === 1 ? { hang: true } : syntheticReply(options, index, spec),
      { profile: profile(START, spec.id) });
    await jest.advanceTimersByTimeAsync(10001);
    const { report, calls } = await running;
    expect(report.failure).toBe('deadline'); expect(calls).toHaveLength(2); expect(jest.getTimerCount()).toBe(0); expectPrivate(report);
  });

  it.each([4, 10])('does not accept or proceed after checkpoint failure %s', async (failAt) => {
    let count = 0;
    const save = jest.fn(() => { if (++count >= failAt) throw new Error(PRIVATE); });
    const { report, calls } = await trial((options, index) => syntheticReply(options, index, spec),
      { profile: profile(START, spec.id), deps: { store: { save } } });
    expect(report).toMatchObject({ result: 'stopped', secretEvidence: 'unqualified', failure: 'local_evidence', finalCheckpoint: 'failed' });
    expect(calls).toHaveLength(failAt === 4 ? 1 : 4); expectPrivate(report);
  });
});

describe.each(SYNTHETIC_CASES.filter((value) => value.recorded))('recorded initialization qualification: $id', (spec) => {

  /** Both warm and fresh first probes require the same actual record and later failure reuse. */
  it.each([true, false])('qualifies only recorded initialization and current same-loader reuse (warm=%s)', async (warm) => {
    const { report, calls } = await trial((options, index) => {
      const response = syntheticReply(options, index, spec);
      if (index === 1 && warm) {
        const value = JSON.parse(response.headers['x-gate1-secrets-probe']);
        value.loaderStateBefore.permanentFailure = true;
        response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
      }
      return response;
    }, { profile: profile(START, spec.id) });
    expect(report).toMatchObject({ result: 'completed', secretEvidence: spec.evidence,
      initializationEvidence: 'recorded_by_loader_observed_via_probes', failure: null });
    expect(report.observations.map((value) => value.initialization)).toEqual([initializationRecord(spec), initializationRecord(spec)]);
    expect(report.observations[0].cacheStateBefore).toBe(warm ? 'permanent_failure' : 'uninitialized');
    expect(calls.filter((call) => call.path === '/api/auth/session')
      .map((call) => call.headers['x-gate1-secrets-diagnostic'])).toEqual(['2', '2']);
    expectPrivate(report);
    const prepared = preparation(profile(START, spec.id));
    expect(prepared.limitations).toContain('initializing_request_not_observed');
    expect(prepared.profile.attestations).not.toHaveProperty('freshLoaderTrialReviewed');
    expect(prepared.profile.attestations.recordedInitializationScopeReviewed).toBe(true);
  });

  /** Historical state is mandatory, bounded and consistent, even when the current failure looks correct. */
  it.each([
    ['missing', (v) => { delete v.loader.initialization; }],
    ['null', (v) => { v.loader.initialization = null; }],
    ['version downgrade', (v) => { v.schemaVersion = 2; delete v.loader.initialization; }],
    ['extra data', (v) => { v.loader.initialization.credential = PRIVATE; }],
    ...Object.entries(initializationRecord(spec)).map(([name, value]) => [name, (v) => {
      v.loader.initialization[name] = typeof value === 'boolean' ? !value : typeof value === 'number' ? 2
        : name === 'effectiveMode' ? 'local' : name === 'validationStage' ? (value === 'hmac' ? 'redis' : 'hmac') : 'not_read';
    }]),
  ].flatMap(([name, mutate]) => [1, 2].map((index) => [name, index, mutate])))(
    'rejects %s on probe%s and retains no invalid record', async (_name, at, mutate) => {
      const { report, calls } = await trial((options, index) => {
        const response = syntheticReply(options, index, spec);
        if (index === at) {
          const value = JSON.parse(response.headers['x-gate1-secrets-probe']); mutate(value);
          response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
        }
        return response;
      }, { profile: profile(START, spec.id) });
      expect(report.result).toBe('stopped'); expect(report.secretEvidence).toBe('unqualified');
      expect(report.initializationEvidence).toBe('not_observed');
      expect(report.observations).toHaveLength(at - 1); expect(calls).toHaveLength(at + 1);
      expectPrivate(report);
    });

  /** Reusing an accepted record from another first observation cannot bypass the explicit comparison. */
  it('requires a matching first record for the second probe', () => {
    const response = syntheticReply({ path: '/api/auth/session', headers: { 'User-Agent': `gate1-secrets-${'0'.repeat(32)}` } }, 2, spec);
    expect(() => reviewProbe({ ...response, text: response.body }, `gate1-secrets-${'0'.repeat(32)}`,
      LOADER, spec.id, null)).toThrow('secret_contract');
  });

  /** Keeping the legacy contract strict prevents retroactive promotion of historical failures. */
  it('rejects the new response version for the corresponding legacy case', async () => {
    const { report } = await trial((options, index) => syntheticReply(options, index, spec),
      { profile: profile(START, spec.legacyId) });
    expect(report).toMatchObject({ result: 'stopped', failure: 'probe_contract', probeFailure: 'schema_invalid' });
  });

  /** A record from another case cannot pass even when current observations match the selected fixture. */
  it.each(SYNTHETIC_CASES.filter((value) => value.recorded && value.id !== spec.id))('rejects a $id initialization record', async (other) => {
    const { report, calls } = await trial((options, index) => {
      const response = syntheticReply(options, index, spec);
      if (index === 1) {
        const value = JSON.parse(response.headers['x-gate1-secrets-probe']);
        value.loader.initialization = initializationRecord(other);
        response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
      }
      return response;
    }, { profile: profile(START, spec.id) });
    expect(report).toMatchObject({ failure: 'secret_contract', secretEvidence: 'unqualified',
      secretFailure: { check: 'initialization_record_mismatch' } });
    expect(report.observations).toEqual([]); expect(calls).toHaveLength(2); expectPrivate(report);
  });

  /** A new case ID cannot reuse the consumed legacy approval even when its fixture identifier is identical. */
  it('rejects a legacy approval and fresh-first attestation for the recorded case', async () => {
    const selected = profile(START, spec.id), save = jest.fn();
    const { report, calls } = await trial(undefined, { profile: selected,
      input: { approval: approvalId(profile(START, spec.legacyId)) }, deps: { store: { save } } });
    expect(report.failure).toBe('approval'); expect(calls).toHaveLength(0); expect(save).not.toHaveBeenCalled();
    delete selected.attestations.recordedInitializationScopeReviewed;
    selected.attestations.freshLoaderTrialReviewed = true;
    expect(() => parseProfile(selected)).toThrow('profile');
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
    ['environment_mismatch', (value) => { value.environment = 'production'; }],
    ['probe_contract', (value) => { delete value.environment; }],
    ['probe_contract', (value) => { value.schemaVersion = 1; }],
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
    expect(report).toMatchObject({ failure: 'probe_contract', probeFailure: 'credential_echo' }); expect(calls).toHaveLength(2);
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

describe('Production success/cache qualification', () => {
  it('binds a distinct case, scope and complete Production attestations into review', () => {
    const selected = profile(START, SUCCESS_CASE);
    expect(() => parseProfile(profileTemplate(SUCCESS_CASE))).toThrow('profile');
    expect(preparation(selected)).toMatchObject({ scope: 'production_secret_success_cache_only', appRequests: 0,
      providerRequests: 0, liveApproved: false, profile: { environment: 'production', caseId: SUCCESS_CASE } });
    expect(approvalId(selected)).not.toBe(approvalId(profile()));
    for (const name of Object.keys(selected.attestations)) {
      expect(() => parseProfile({ ...selected, attestations: { ...selected.attestations, [name]: false } })).toThrow('profile');
    }
    expect(() => parseProfile({ ...selected, environment: 'preview' })).toThrow('profile');
    expect(() => parseProfile({ ...selected, attestations: profile().attestations })).toThrow('profile');
  });

  it.each([false, true])('requires same-loader cached success and distinguishes warm start (%s)', async (warm) => {
    const { report, calls } = await trial((options, index) => successReply(options, index, warm), { profile: profile(START, SUCCESS_CASE) });
    expect(report).toMatchObject({ result: 'completed', scope: 'production_secret_success_cache_only',
      appRequests: 4, validatedRequests: 4, unvalidatedAttempts: 0,
      secretEvidence: 'validated_pair_and_same_loader_cache_reuse_observed',
      initializationEvidence: warm ? 'already_cached_on_probe1' : 'observed_on_probe1', failure: null });
    expect(report.observations.map((row) => row.cacheStateBefore)).toEqual([warm ? 'cached_pair' : 'uninitialized', 'cached_pair']);
    expect(report.observations.map((row) => row.loaderId)).toEqual([LOADER, LOADER]);
    expect(report.observations.every((row) => row.environment === 'production' && row.validationAttempts === 1)).toBe(true);
    expect(calls.map((call) => call.path)).toEqual(['/login', '/api/auth/session', '/api/auth/session', '/login']);
    expect(calls.every((call) => call.headers.Cookie === undefined && call.agent === false && call.rejectUnauthorized === true)).toBe(true);
    expectPrivate(report);
  });

  it.each([
    ['environment_mismatch', (value) => { value.environment = 'preview'; }],
    ['probe_contract', (value) => { delete value.environment; }],
    ['probe_contract', (value) => { value.schemaVersion = 1; }],
    ['source_rejected', (value) => { value.effectiveMode = 'local'; }],
    ['source_rejected', (value) => { value.sourceResolution = 'rejected'; }],
    ['source_rejected', (value) => { value.canonicalFamily = null; }],
    ['secret_contract', (value) => { value.loaderReached = false; }],
    ['secret_contract', (value) => { value.loader = null; }],
    ['secret_contract', (value) => { value.loader.loaderId = null; }],
    ['secret_contract', (value) => { value.loader.validationAttempts = 2; }],
    ['secret_contract', (value) => { value.loader.validationStage = 'redis'; }],
    ['secret_contract', (value) => { value.loader.effectiveMode = 'local'; }],
    ['secret_contract', (value) => { value.loader.hmacInput = 'missing'; }],
    ['secret_contract', (value) => { value.loader.redisInput = 'missing'; }],
    ['secret_contract', (value) => { value.loader.hasCachedPair = false; }],
    ['secret_contract', (value) => { value.loader.permanentFailure = true; }],
    ['secret_contract', (value) => { value.loaderStateBefore.permanentFailure = true; }],
    ['secret_contract', (value) => { value.loaderStateBefore = null; }],
    ['secret_contract', (value) => { value.identityAttempted = false; }],
    ['secret_contract', (value) => { value.redisAttempted = false; }],
    ['secret_contract', (value) => { value.scriptAttempted = false; }],
    ['secret_contract', (value) => { value.allowed = false; }],
    ['secret_contract', (value) => { value.reason = 'secret_unavailable'; }],
    ['probe_contract', (value) => { value.marker = 'gate1-secrets-' + '0'.repeat(32); }],
    ['probe_contract', (value) => { value.loader.token = PRIVATE; }],
  ])('rejects ambiguous Production facts %s (%#)', async (code, mutate) => {
    const { report, calls } = await trial((options, index) => {
      const response = successReply(options, index);
      if (index === 1) {
        const value = JSON.parse(response.headers['x-gate1-secrets-probe']);
        mutate(value); response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
      }
      return response;
    }, { profile: profile(START, SUCCESS_CASE) });
    expect(report).toMatchObject({ failure: code, result: 'stopped', secretEvidence: 'unqualified', initializationEvidence: 'not_observed' });
    expect(report.observations).toEqual([]); expect(calls).toHaveLength(2); expectPrivate(report);
  });

  it.each(['different', 'uncached'])('rejects a Production second loader that is %s', async (change) => {
    const { report, calls } = await trial((options, index) => {
      const response = successReply(options, index);
      if (index === 2) {
        const value = JSON.parse(response.headers['x-gate1-secrets-probe']);
        if (change === 'different') value.loader.loaderId = 'b2'.repeat(16); else value.loaderStateBefore.hasCachedPair = false;
        response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
      }
      return response;
    }, { profile: profile(START, SUCCESS_CASE) });
    expect(report.failure).toBe(change === 'different' ? 'loader_changed' : 'secret_contract');
    expect(report.secretEvidence).toBe('unqualified'); expect(calls).toHaveLength(3);
  });

  it.each([
    ['session_status', (response) => { response.status = 503; }],
    ['session_status', (response) => { response.status = 429; }],
    ['body_contract', (response) => { response.body = JSON.stringify({ data: { user: { id: PRIVATE } }, error: null, message: 'Success' }); }],
    ['body_contract', (response) => { response.body = JSON.stringify({ data: { user: null }, error: null, message: 'Success', extra: PRIVATE }); }],
    ['cache_contract', (response) => { response.headers['cache-control'] = 'public, max-age=60'; }],
    ['cache_contract', (response) => { response.headers['x-vercel-cache'] = 'HIT'; }],
    ['cache_contract', (response) => { response.headers['retry-after'] = '1'; }],
    ['cookie_contract', (response) => { response.headers['set-cookie'] = PRIVATE; }],
    ['probe_contract', (response) => { delete response.headers['x-gate1-secrets-probe']; }],
  ])('rejects nonqualifying Production response %s (%#)', async (code, mutate) => {
    const { report, calls } = await trial((options, index) => {
      const response = successReply(options, index); if (index === 1) mutate(response); return response;
    }, { profile: profile(START, SUCCESS_CASE) });
    expect(report.failure).toBe(code); expect(calls).toHaveLength(2); expectPrivate(report);
  });

  it('rejects credentials in projected Production facts before retaining them', async () => {
    const bypass = LOADER.slice(0, 16);
    const { report } = await trial(successReply, { profile: profile(START, SUCCESS_CASE),
      input: { credentials: { probeSecret: PROBE, bypassSecret: bypass } } });
    expect(report).toMatchObject({ failure: 'probe_contract', probeFailure: 'credential_echo' }); expect(report.observations).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(bypass);
  });

  it('keeps each case reservation consumed across fresh reviews without overwriting the negative case', () => {
    const location = directory(), negative = profile(), positive = profile(START, SUCCESS_CASE);
    const oldStore = createStore(negative, approvalId(negative), location);
    const oldBytes = fs.readFileSync(oldStore.reportPath);
    createStore(positive, approvalId(positive), location);
    const reservation = JSON.parse(fs.readFileSync(path.join(location, `${positive.deploymentId}-${SUCCESS_CASE}.reservation.json`)));
    expect(reservation).toEqual({ deploymentId: positive.deploymentId, caseId: SUCCESS_CASE, approvalId: approvalId(positive) });
    expect(() => createStore(profile(START + 1, SUCCESS_CASE), approvalId(profile(START + 1, SUCCESS_CASE)), location)).toThrow('reservation');
    expect(() => createStore(negative, approvalId(negative), location)).toThrow('reservation');
    expect(fs.readFileSync(oldStore.reportPath)).toEqual(oldBytes);
  });

  it('drops Production completion claims on final persistence failure', async () => {
    const { report } = await trial(successReply, { profile: profile(START, SUCCESS_CASE), deps: { store: {
      /** Simulates a failure only when attempting to save the completed fixture. */
      save(value) { if (value.result === 'completed') throw new Error(PRIVATE); },
    } } });
    expect(report).toMatchObject({ result: 'stopped', secretEvidence: 'unqualified', initializationEvidence: 'not_observed', failure: 'local_evidence' });
  });
});

const DIAGNOSTIC_ID = '12345678-1234-4123-8123-123456789abc';

/** Produces case-specific diagnostic fixtures; warm applies only to the Preview failure sentinel. */
function diagnosticReply(options, index, present = false, caseId = DIAGNOSTIC_CASE, warm = false) {
  const response = caseId === PREVIEW_DIAGNOSTIC_CASE ? reply(options, index) : successReply(options, index);
  if (options.path === '/api/auth/session') {
    response.headers['x-request-id'] = DIAGNOSTIC_ID;
    if (caseId === PREVIEW_DIAGNOSTIC_CASE) response.headers['x-gate1-secrets-probe'] = JSON.stringify(facts(options.headers['User-Agent'], warm));
    if (!present) delete response.headers['x-gate1-secrets-probe'];
  }
  return response;
}

describe.each([DIAGNOSTIC_CASE, PREVIEW_DIAGNOSTIC_CASE])('private stage runner %s', (caseId) => {
  /** Supplies the selected environment's fixture contract to the shared bounded-run checks. */
  function caseReply(options, index, present = false) { return diagnosticReply(options, index, present, caseId); }
  /** Both header outcomes require both builds but cannot qualify loader reuse. */
  it.each([false, true])('uses exactly three sequential requests with header present=%s', async (present) => {
    const selected = profile(START, caseId), saved = [];
    const { report, calls } = await trial((options, index) => caseReply(options, index, present), {
      profile: selected, deps: { store: { save(value) { saved.push(JSON.parse(JSON.stringify(value))); } } },
    });
    expect(report).toMatchObject({ result: 'completed', scope: caseId, limits: DIAGNOSTIC_LIMITS,
      appRequests: 3, validatedRequests: 3, unvalidatedAttempts: 0, failure: null,
      attribution: 'operator_attested_snapshot_with_http_build_checks_only',
      secretEvidence: 'unqualified', initializationEvidence: 'not_observed',
      diagnostic: { requestId: DIAGNOSTIC_ID, probeHeader: present ? 'present' : 'missing', privateLog: 'not_reviewed' } });
    expect(calls.map((call) => call.path)).toEqual(['/login', '/api/auth/session', '/login']);
    expect(calls[1].headers['User-Agent']).toBe(selected.trace.marker);
    expect(calls.filter((call) => call.headers.Authorization)).toHaveLength(1);
    expect(report.receipts[1].requestId).toBe(DIAGNOSTIC_ID);
    expect(report.observations).toHaveLength(present ? 1 : 0);
    expect(saved.at(-1)).toEqual(report); expectPrivate(report);
  });

  /** Preparation is offline and pins the smaller budget, arming metadata and manual-log boundary. */
  it('binds diagnostic scope and arming without generating or applying deployment configuration', () => {
    expect(() => parseProfile(profileTemplate(caseId))).toThrow('profile');
    const selected = profile(START, caseId), prepared = preparation(selected);
    expect(prepared).toMatchObject({ liveApproved: false, appRequests: 0, providerRequests: 0,
      limits: DIAGNOSTIC_LIMITS, scope: caseId, sequence: ['buildBefore', 'probe1', 'buildAfter'] });
    for (const change of [{ marker: `gate1-secrets-${'d'.repeat(32)}` }, { expiresAt: new Date(START + 800000).toISOString() }]) {
      expect(approvalId({ ...selected, trace: { ...selected.trace, ...change } })).not.toBe(prepared.approvalId);
    }
    for (const name of ['traceConfigurationReviewed', 'privateLogPrivacyReviewed', 'privateLogAccessReviewed', 'singleManualLogInspectionApproved']) {
      expect(() => parseProfile({ ...selected, attestations: { ...selected.attestations, [name]: false } })).toThrow('profile');
    }
  });

  /** Newly bound server and logging bytes invalidate old approval digests. */
  it.each(['src/server/lib/gate1SecretsTrace.js', 'src/shared/logger.js'])('binds %s into approval', (relative) => {
    const selected = profile(START, caseId), initial = approvalId(selected), read = fs.readFileSync;
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((name, ...args) => {
      const value = read(name, ...args);
      return name === path.join(ROOT, relative) ? Buffer.concat([value, Buffer.from('\n// fixture')]) : value;
    });
    try { expect(approvalId(selected)).not.toBe(initial); } finally { spy.mockRestore(); }
  });

  /** The only relaxed outcome is absence; every unexpected response still stops immediately. */
  it.each([
    ['transport', 'transport'], ['redirect', 'redirect'], ['status', 'session_status'], ['body', 'body_contract'],
    ['cache', 'cache_contract'], ['cookie', 'cookie_contract'], ['retry', 'cache_contract'], ['cdn', 'cache_contract'],
    ['json', 'probe_contract'], ['schema', 'probe_contract'], ['marker', 'probe_contract'], ['environment', 'environment_mismatch'],
    ['duplicate_probe', 'response_headers'], ['missing_id', 'correlation_contract'], ['bad_id', 'correlation_contract'],
    ['uppercase_id', 'correlation_contract'], ['duplicate_id', 'response_headers'],
  ])('stops at unexpected %s', async (variant, failure) => {
    const { report, calls } = await trial((options, index) => {
      const response = caseReply(options, index, true);
      if (index !== 1) return response;
      if (variant === 'transport') response.error = true;
      if (variant === 'redirect') response.status = 302;
      if (variant === 'status') response.status = caseId === PREVIEW_DIAGNOSTIC_CASE ? 200 : 503;
      if (variant === 'body') response.body = '{}';
      if (variant === 'cache') response.headers['cache-control'] = 'public';
      if (variant === 'cookie') response.headers['set-cookie'] = PRIVATE;
      if (variant === 'retry') response.headers['retry-after'] = '1';
      if (variant === 'cdn') response.headers['cdn-cache-control'] = 'public';
      if (variant === 'json') response.headers['x-gate1-secrets-probe'] = '{';
      if (variant === 'schema') response.headers['x-gate1-secrets-probe'] = '{}';
      if (variant === 'marker' || variant === 'environment') {
        const value = JSON.parse(response.headers['x-gate1-secrets-probe']);
        value[variant] = variant === 'marker' ? `gate1-secrets-${'d'.repeat(32)}` : caseId === PREVIEW_DIAGNOSTIC_CASE ? 'production' : 'preview';
        response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
      }
      if (variant === 'missing_id') delete response.headers['x-request-id'];
      if (variant === 'bad_id') response.headers['x-request-id'] = PRIVATE;
      if (variant === 'uppercase_id') response.headers['x-request-id'] = DIAGNOSTIC_ID.toUpperCase();
      if (variant.startsWith('duplicate_')) {
        const name = variant === 'duplicate_id' ? 'x-request-id' : 'x-gate1-secrets-probe';
        response.rawHeaders = [...Object.entries(response.headers).flat(), name.toUpperCase(), response.headers[name]];
      }
      return response;
    }, { profile: profile(START, caseId) });
    expect(report).toMatchObject({ result: 'stopped', failure, appRequests: 2, stoppedPhase: 'probe1', secretEvidence: 'unqualified' });
    expect(calls).toHaveLength(2);
    if (['json', 'schema', 'marker', 'environment'].includes(variant)) expect(report.diagnostic.requestId).toBe(DIAGNOSTIC_ID);
    expectPrivate(report);
  });

  /** Canonical IDs are still rejected when they echo a credential substring. */
  it('rejects credential echoes before retaining the response correlation', async () => {
    const { report } = await trial(caseReply, { profile: profile(START, caseId),
      input: { credentials: { probeSecret: PROBE, bypassSecret: DIAGNOSTIC_ID.slice(0, 18) } } });
    expect(report.failure).toBe('correlation_contract'); expect(report.diagnostic.requestId).toBeNull();
    expect(JSON.stringify(report)).not.toContain(DIAGNOSTIC_ID.slice(0, 18));
  });

  /** Build mismatch before or after the single probe cannot result in a completed diagnostic. */
  it.each([0, 2])('requires matching build at phase %s', async (phase) => {
    const { report, calls } = await trial((options, index) => {
      const response = caseReply(options, index);
      if (index === phase) response.body = response.body.replace('fixture-build', 'wrong-build');
      return response;
    }, { profile: profile(START, caseId) });
    expect(report.failure).toBe('build_mismatch'); expect(calls).toHaveLength(phase + 1);
  });

  /** The runner never dispatches outside arming or with less than a full trial budget remaining. */
  it.each([-1, 840001, 900000])('refuses clock offset %s before storage or dispatch', async (offset) => {
    const save = jest.fn(), selected = profile(START - Math.max(0, -offset), caseId);
    const { report, calls } = await trial(caseReply, { profile: selected,
      deps: { wall: () => START + offset, store: { save } } });
    expect(report.failure).toBe('trace_window'); expect(calls).toHaveLength(0); expect(save).not.toHaveBeenCalled();
  });

  /** Slow checkpoints must be followed by another physical-dispatch window check. */
  it('rechecks arming after a slow checkpoint consumes the remaining buffer', async () => {
    let elapsed = 0;
    const selected = profile(START, caseId);
    selected.trace.expiresAt = new Date(START + 60000).toISOString();
    const { report, calls } = await trial(caseReply, { profile: selected,
      deps: { now: () => elapsed, wall: () => START + elapsed, store: { save() { elapsed += 1; } } } });
    expect(report.failure).toBe('trace_window'); expect(calls).toHaveLength(0);
  });

  /** Request timeout destroys the one pending stream and prevents the final build. */
  it('keeps the ten-second request deadline and never retries', async () => {
    jest.useFakeTimers();
    const pending = trial((options, index) => index === 1 ? { hang: true } : caseReply(options, index),
      { profile: profile(START, caseId) });
    await jest.advanceTimersByTimeAsync(10000);
    const { report, calls, requests } = await pending;
    expect(report.failure).toBe('deadline'); expect(calls).toHaveLength(2); expect(requests[1].destroy).toHaveBeenCalled();
  });

  /** Changing marker or approval never frees a consumed deployment/case reservation. */
  it('preserves durable reports and prevents replay across marker changes', async () => {
    const selected = profile(START, caseId), location = directory();
    const store = createStore(selected, approvalId(selected), location);
    const { report } = await trial(caseReply, { profile: selected, deps: { store } });
    expect(JSON.parse(fs.readFileSync(store.reportPath, 'utf8'))).toEqual(report);
    const changed = { ...selected, trace: { ...selected.trace, marker: `gate1-secrets-${'d'.repeat(32)}` } };
    expect(() => createStore(changed, approvalId(changed), location)).toThrow('reservation');
  });

  /** Persistence failure retains the correlation and cannot promote the diagnostic to qualification. */
  it('stops if evidence persistence fails after the missing-header observation', async () => {
    const { report, calls } = await trial(caseReply, { profile: profile(START, caseId),
      deps: { store: { save(value) { if (value.diagnostic?.requestId) throw new Error(PRIVATE); } } } });
    expect(report).toMatchObject({ failure: 'local_evidence', finalCheckpoint: 'failed', secretEvidence: 'unqualified',
      diagnostic: { requestId: DIAGNOSTIC_ID, probeHeader: 'missing' } });
    expect(calls).toHaveLength(2); expectPrivate(report);
  });
});

/** Preview diagnostics deliberately investigate an already-used loader without qualifying it. */
describe('Preview stage diagnostics preserve qualification boundaries', () => {
  /** Missing-input snapshot attestations remain explicit; fresh-loader evidence cannot be asserted here. */
  it('requires Preview diagnostic attestations and rejects Production/profile substitutions', () => {
    const selected = profile(START, PREVIEW_DIAGNOSTIC_CASE);
    expect(selected.environment).toBe('preview');
    expect(selected.attestations).toMatchObject({ bothApplicationSecretsAbsent: true,
      previewOverridesReviewed: true, productionCredentialsExcluded: true, warmLoaderDiagnosticScopeReviewed: true });
    expect(selected.attestations.freshLoaderTrialReviewed).toBeUndefined();
    for (const name of Object.keys(selected.attestations)) {
      expect(() => parseProfile({ ...selected, attestations: { ...selected.attestations, [name]: false } })).toThrow('profile');
    }
    for (const change of [{ environment: 'production' }, { caseId: DIAGNOSTIC_CASE },
      { attestations: profile().attestations }, { trace: undefined }]) {
      expect(() => parseProfile({ ...selected, ...change })).toThrow('profile');
    }
    expect(preparation(selected).limitations).toContain('warm_failure_permitted_for_diagnosis_only');
  });

  /** A warm negative observation can diagnose emission but never passes the original fresh-loader trial. */
  it.each([false, true])('records Preview loader state with warm=%s without qualification', async (warm) => {
    const selected = profile(START, PREVIEW_DIAGNOSTIC_CASE);
    const { report } = await trial((options, index) => diagnosticReply(options, index, true, PREVIEW_DIAGNOSTIC_CASE, warm),
      { profile: selected });
    expect(report).toMatchObject({ result: 'completed', appRequests: 3, validatedRequests: 3,
      secretEvidence: 'unqualified', initializationEvidence: 'not_observed', diagnostic: { privateLog: 'not_reviewed' } });
    expect(report.observations).toEqual([expect.objectContaining({ environment: 'preview',
      cacheStateBefore: warm ? 'permanent_failure' : 'uninitialized', validationAttempts: 1 })]);
    expectPrivate(report);
    if (warm) {
      const negative = await trial((options, index) => diagnosticReply(options, index, true, PREVIEW_DIAGNOSTIC_CASE, true));
      expect(negative.report).toMatchObject({ result: 'stopped', failure: 'loader_already_initialized', appRequests: 2 });
    }
  });

  /** Warm allowance never permits contradictory cache state, downstream work or a different negative case. */
  it.each(['cached_pair', 'downstream', 'redis_stage', 'present_input', 'multiple_attempts'])('rejects %s observations', async (variant) => {
    const { report, calls } = await trial((options, index) => {
      const response = diagnosticReply(options, index, true, PREVIEW_DIAGNOSTIC_CASE, true);
      if (index === 1) {
        const value = JSON.parse(response.headers['x-gate1-secrets-probe']);
        if (variant === 'cached_pair') value.loaderStateBefore.hasCachedPair = true;
        if (variant === 'downstream') value.redisAttempted = true;
        if (variant === 'redis_stage') value.loader.validationStage = 'redis';
        if (variant === 'present_input') value.loader.hmacInput = 'present';
        if (variant === 'multiple_attempts') value.loader.validationAttempts = 2;
        response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
      }
      return response;
    }, { profile: profile(START, PREVIEW_DIAGNOSTIC_CASE) });
    expect(report).toMatchObject({ result: 'stopped', failure: 'secret_contract', secretEvidence: 'unqualified' });
    expect(calls).toHaveLength(2); expectPrivate(report);
  });

  /** A new diagnostic case cannot overwrite or free the consumed qualification reservation. */
  it('preserves both case reservations across fresh profiles', async () => {
    const location = directory(), negative = profile(), selected = profile(START, PREVIEW_DIAGNOSTIC_CASE);
    createStore(negative, approvalId(negative), location);
    const reservation = path.join(location, `${negative.deploymentId}-${negative.caseId}.reservation.json`);
    const original = fs.readFileSync(reservation, 'utf8');
    const store = createStore(selected, approvalId(selected), location);
    const { report } = await trial((options, index) => diagnosticReply(options, index, false, PREVIEW_DIAGNOSTIC_CASE),
      { profile: selected, deps: { store } });
    expect(report.result).toBe('completed');
    expect(fs.readFileSync(reservation, 'utf8')).toBe(original);
    for (const value of [negative, selected]) expect(() => createStore({ ...value, reviewedAt: new Date(START + 1).toISOString() },
      approvalId(value), location)).toThrow('reservation');
  });
});

describe('sanitized probe failure detail', () => {
  describe.each([
    ['Preview', undefined, reply], ['Production', SUCCESS_CASE, successReply],
  ])('%s report', (_label, caseId, responder) => {
    describe.each([1, 2])('probe %s', (failedIndex) => {
      it.each([
        ['missing header', 'header_missing', () => undefined],
        ['oversized UTF-8 header', 'header_oversized', () => '\u00e9'.repeat(769)],
        ['malformed JSON', 'json_invalid', () => '{"private":"' + PRIVATE],
        ['empty header', 'json_invalid', () => ''],
        ['JSON null', 'schema_invalid', () => 'null'],
        ['old schema', 'schema_invalid', (value) => JSON.stringify({ ...value, schemaVersion: 1 })],
        ['missing environment', 'schema_invalid', (value) => {
          delete value.environment; return JSON.stringify(value);
        }],
        ['untrusted nested field', 'schema_invalid', (value) => {
          value.loader[PRIVATE] = PROBE; return JSON.stringify(value);
        }],
        ['different marker', 'marker_mismatch', (value) => JSON.stringify({ ...value, marker: 'gate1-secrets-' + '0'.repeat(32) })],
      ])('stops and checkpoints only the fixed reason for %s', async (_name, reason, header) => {
        let retained;
        const { report, calls } = await trial((options, index) => {
          const response = responder(options, index);
          if (index === failedIndex) {
            const value = header(JSON.parse(response.headers['x-gate1-secrets-probe']));
            if (value === undefined) delete response.headers['x-gate1-secrets-probe'];
            else response.headers['x-gate1-secrets-probe'] = value;
          }
          return response;
        }, { profile: profile(START, caseId), deps: { store: {
          /** Capture detached checkpoints to verify only sanitized report fields are persisted. */
          save(value) { retained = JSON.parse(JSON.stringify(value)); },
        } } });
        expect(report).toMatchObject({ result: 'stopped', failure: 'probe_contract', probeFailure: reason,
          stoppedPhase: `probe${failedIndex}`, dispatchState: 'response_received',
          appRequests: failedIndex + 1, validatedRequests: failedIndex, unvalidatedAttempts: 1,
          secretEvidence: 'unqualified', initializationEvidence: 'not_observed' });
        expect(calls).toHaveLength(failedIndex + 1);
        expect(report.receipts.at(-1).validated).toBe(false);
        expect(report.observations).toHaveLength(failedIndex - 1);
        expect(retained).toEqual(report); expectPrivate(retained);
        expect(JSON.stringify(retained)).not.toContain(calls.at(-1).headers['User-Agent']);
      });
    });
  });

  it.each([null, 42, [PRIVATE]])('rejects a nonscalar header at the direct review boundary (%#)', (raw) => {
    const marker = 'gate1-secrets-' + '1'.repeat(32);
    const response = successReply({ path: '/api/auth/session', headers: { 'User-Agent': marker } }, 1);
    response.headers['x-gate1-secrets-probe'] = raw;
    expect(() => reviewProbe({ ...response, text: response.body }, marker, null, SUCCESS_CASE))
      .toThrow(expect.objectContaining({ code: 'probe_contract', probeFailure: 'header_invalid' }));
  });

  it.each([
    ['probe_contract', PRIVATE], ['probe_contract', { message: PROBE }], ['probe_contract', undefined],
    ['transport', 'header_missing'], [PRIVATE, 'schema_invalid'],
  ])('discards unknown or inapplicable diagnostic detail (%#)', (code, detail) => {
    const error = new CanaryError(code, detail);
    expect(error.probeFailure).toBeNull();
    expect(error.message).toBe(code === PRIVATE ? 'internal' : code);
    expect(JSON.stringify(error)).not.toContain(PRIVATE); expect(JSON.stringify(error)).not.toContain(PROBE);
  });

  it('preserves the original diagnostic if final persistence also fails', async () => {
    const { report, calls } = await trial((options, index) => {
      const response = successReply(options, index);
      if (index === 1) delete response.headers['x-gate1-secrets-probe'];
      return response;
    }, { profile: profile(START, SUCCESS_CASE), deps: { store: {
      /** Fail the final failure checkpoint without changing earlier fixture checkpoints. */
      save(value) { if (value.failure !== null) throw new Error(PRIVATE); },
    } } });
    expect(report).toMatchObject({ result: 'stopped', failure: 'probe_contract', probeFailure: 'header_missing',
      finalCheckpoint: 'failed', stoppedPhase: 'probe1', secretEvidence: 'unqualified' });
    expect(calls).toHaveLength(2); expectPrivate(report);
  });

  it('keeps a persisted failure consumed even when a fresh approval is supplied', async () => {
    const location = directory(), selected = profile(START, SUCCESS_CASE);
    const store = createStore(selected, approvalId(selected), location);
    const { report, calls } = await trial((options, index) => {
      const response = successReply(options, index);
      if (index === 1) response.headers['x-gate1-secrets-probe'] = PROBE;
      return response;
    }, { profile: selected, deps: { store } });
    expect(report).toMatchObject({ failure: 'probe_contract', probeFailure: 'json_invalid', result: 'stopped' });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(store.reportPath, 'utf8'))).toEqual(report); expectPrivate(report);
    const fresh = profile(START + 1, SUCCESS_CASE);
    expect(() => createStore(fresh, approvalId(fresh), location)).toThrow('reservation');
  });
});

describe('sanitized secret-contract failure detail', () => {
  describe.each([null, ...SYNTHETIC_CASES])('Preview case %#', (spec) => {
    describe.each([1, 2])('failed probe %s', (failedIndex) => {
      it.each([
        ['loader_not_reached', (v) => { v.loaderReached = false; }, { loaderReached: false }],
        ['loader_missing', (v) => { v.loader = null; }, { loaderPresent: false, effectiveMode: null, validationStage: null }],
        ['prior_state_missing', (v) => { v.loaderStateBefore = null; }, { priorStatePresent: false, priorHasCachedPair: null }],
        ['loader_id_missing', (v) => { v.loader.loaderId = null; }, { loaderIdPresent: false }],
        ['secret_mode_mismatch', (v) => { v.loader.effectiveMode = 'invalid'; }, { effectiveMode: 'invalid' }],
        ['validation_attempts_mismatch', (v) => { v.loader.validationAttempts = 2; }, { validationAttempts: 2 }],
        ['decision_allowance_mismatch', (v) => { v.allowed = true; }, { allowed: true }],
        ['decision_reason_mismatch', (v) => { v.reason = PRIVATE; }, { expectedReasonMatches: false }],
        ['identity_attempt_mismatch', (v) => { v.identityAttempted = true; }, { identityAttempted: true }],
        ['redis_attempt_mismatch', (v) => { v.redisAttempted = true; }, { redisAttempted: true }],
        ['script_attempt_mismatch', (v) => { v.scriptAttempted = true; }, { scriptAttempted: true }],
        ['validation_stage_mismatch', (v) => { v.loader.validationStage = 'payloads'; }, { validationStage: 'payloads' }],
        ['hmac_presence_mismatch', (v) => { v.loader.hmacInput = 'not_read'; }, { hmacInput: 'not_read' }],
        ['redis_presence_mismatch', (v) => { v.loader.redisInput = 'not_read'; }, { redisInput: 'not_read' }],
        ['cached_pair_mismatch', (v) => { v.loader.hasCachedPair = true; }, { hasCachedPair: true }],
        ['permanent_failure_mismatch', (v) => { v.loader.permanentFailure = false; }, { permanentFailure: false }],
      ])('stops on %s and persists actual fixed facts without accepting the observation', async (check, mutate, expected) => {
        let retained;
        const { report, calls } = await trial((options, index) => {
          const response = spec ? syntheticReply(options, index, spec) : reply(options, index);
          if (index === failedIndex) {
            const value = JSON.parse(response.headers['x-gate1-secrets-probe']);
            mutate(value); response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
          }
          return response;
        }, { profile: profile(START, spec?.id), deps: { store: {
          /** Detach checkpoints so later report mutation cannot manufacture persisted diagnostics. */
          save(value) { retained = JSON.parse(JSON.stringify(value)); },
        } } });
        expect(report).toMatchObject({ result: 'stopped', failure: 'secret_contract', probeFailure: null,
          secretFailure: { check, facts: expected }, secretEvidence: 'unqualified', initializationEvidence: 'not_observed',
          stoppedPhase: `probe${failedIndex}`, appRequests: failedIndex + 1, validatedRequests: failedIndex, unvalidatedAttempts: 1 });
        expect(report.secretFailure.facts).toHaveProperty('sameLoader', failedIndex === 1 || check === 'loader_missing'
          || check === 'loader_id_missing' ? null : true);
        expect(report.observations).toHaveLength(failedIndex - 1);
        expect(report.receipts.at(-1).validated).toBe(false);
        expect(calls).toHaveLength(failedIndex + 1);
        expect(retained).toEqual(report); expectPrivate(retained);
      });
    });
  });

  describe.each([SUCCESS_CASE, DIAGNOSTIC_CASE])('%s', (caseId) => {
    it.each([
      ['decision_allowance_mismatch', (v) => { v.allowed = false; }, { allowed: false }],
      ['decision_reason_mismatch', (v) => { v.reason = BYPASS; }, { expectedReasonMatches: false }],
      ['identity_attempt_mismatch', (v) => { v.identityAttempted = false; }, { identityAttempted: false }],
      ['redis_attempt_mismatch', (v) => { v.redisAttempted = false; }, { redisAttempted: false }],
      ['script_attempt_mismatch', (v) => { v.scriptAttempted = false; }, { scriptAttempted: false }],
      ['validation_stage_mismatch', (v) => { v.loader.validationStage = 'hmac'; }, { validationStage: 'hmac' }],
      ['hmac_presence_mismatch', (v) => { v.loader.hmacInput = 'missing'; }, { hmacInput: 'missing' }],
      ['redis_presence_mismatch', (v) => { v.loader.redisInput = 'missing'; }, { redisInput: 'missing' }],
      ['cached_pair_mismatch', (v) => { v.loader.hasCachedPair = false; }, { hasCachedPair: false }],
      ['permanent_failure_mismatch', (v) => { v.loader.permanentFailure = true; }, { permanentFailure: true }],
      ['prior_permanent_failure_unexpected', (v) => { v.loaderStateBefore.permanentFailure = true; }, { priorPermanentFailure: true }],
    ])('retains the %s failure with success expectations', async (check, mutate, expected) => {
      const { report, calls } = await trial((options, index) => {
        const response = successReply(options, index);
        if (index === 1) {
          response.headers['x-request-id'] = '11111111-2222-4333-8444-555555555555';
          const value = JSON.parse(response.headers['x-gate1-secrets-probe']);
          mutate(value); response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
        }
        return response;
      }, { profile: profile(START, caseId) });
      expect(report).toMatchObject({ result: 'stopped', failure: 'secret_contract', secretFailure: { check, facts: expected },
        validatedRequests: 1, unvalidatedAttempts: 1, secretEvidence: 'unqualified', observations: [] });
      expect(calls).toHaveLength(2); expectPrivate(report);
    });
  });

  it.each([
    [undefined, 1, 'loader_already_initialized', (v) => { v.loaderStateBefore.permanentFailure = true; },
      { priorPermanentFailure: true, sameLoader: null }],
    [undefined, 2, 'loader_changed', (v) => { v.loader.loaderId = 'b2'.repeat(16); }, { sameLoader: false }],
    [undefined, 2, 'prior_cached_pair_unexpected', (v) => { v.loaderStateBefore.hasCachedPair = true; }, { priorHasCachedPair: true }],
    [undefined, 2, 'prior_permanent_failure_missing', (v) => { v.loaderStateBefore.permanentFailure = false; },
      { priorPermanentFailure: false }],
    [SUCCESS_CASE, 2, 'prior_cached_pair_missing', (v) => { v.loaderStateBefore.hasCachedPair = false; }, { priorHasCachedPair: false }],
    [PREVIEW_DIAGNOSTIC_CASE, 1, 'prior_cached_pair_unexpected', (v) => { v.loaderStateBefore.hasCachedPair = true; },
      { priorHasCachedPair: true }],
  ])('preserves freshness/reuse rejection %s / probe %s / %s', async (caseId, failedIndex, check, mutate, expected) => {
    const { report, calls } = await trial((options, index) => {
      const response = caseId === SUCCESS_CASE ? successReply(options, index) : reply(options, index);
      if (index === failedIndex) {
        response.headers['x-request-id'] = '11111111-2222-4333-8444-555555555555';
        const value = JSON.parse(response.headers['x-gate1-secrets-probe']);
        mutate(value); response.headers['x-gate1-secrets-probe'] = JSON.stringify(value);
      }
      return response;
    }, { profile: profile(START, caseId) });
    const failure = ['loader_changed', 'loader_already_initialized'].includes(check) ? check : 'secret_contract';
    expect(report).toMatchObject({ result: 'stopped', failure, secretFailure: { check, facts: expected },
      unvalidatedAttempts: 1, secretEvidence: 'unqualified' });
    expect(calls).toHaveLength(failedIndex + 1); expectPrivate(report);
  });

  /** Obtain only fixed failure facts through the real review boundary for constructor/privacy tests. */
  function secretError() {
    const marker = 'gate1-secrets-' + '1'.repeat(32);
    const response = reply({ path: '/api/auth/session', headers: { 'User-Agent': marker } }, 1);
    try { reviewProbe({ ...response, text: response.body }, marker, null, 'redis_input_missing'); }
    catch (error) { return error; }
    throw new Error('Expected fixture mismatch');
  }

  it('identifies the first mismatch while preserving later fixed facts without raw identifiers', () => {
    const error = secretError();
    expect(error).toMatchObject({ code: 'secret_contract', secretFailure: { check: 'validation_stage_mismatch',
      facts: { validationStage: 'hmac', hmacInput: 'missing', redisInput: 'missing' } } });
    expect(JSON.stringify(error)).not.toContain(LOADER);
    expect(JSON.stringify(error)).not.toContain('gate1-secrets-');
  });

  it.each([
    ['unknown check', (d) => { d.check = PRIVATE; }],
    ['wrong code', (d) => { d.check = 'loader_changed'; }],
    ['extra field', (d) => { d.raw = PROBE; }],
    ['extra fact', (d) => { d.facts.raw = BYPASS; }],
    ['untrusted mode', (d) => { d.facts.effectiveMode = PRIVATE; }],
    ['untrusted stage', (d) => { d.facts.validationStage = PRIVATE; }],
    ['untrusted presence', (d) => { d.facts.hmacInput = PRIVATE; }],
    ['unbounded count', (d) => { d.facts.validationAttempts = 9999; }],
    ['nonboolean state', (d) => { d.facts.hasCachedPair = PROBE; }],
  ])('discards %s at the error boundary', (_label, mutate) => {
    const detail = secretError().secretFailure;
    mutate(detail);
    const error = new CanaryError('secret_contract', null, detail);
    expect(error.secretFailure).toBeNull();
    for (const value of [PRIVATE, PROBE, BYPASS]) expect(JSON.stringify(error)).not.toContain(value);
  });

  it('detaches accepted detail and rejects detail attached to unrelated errors', () => {
    const detail = secretError().secretFailure;
    const error = new CanaryError('secret_contract', null, detail);
    detail.facts.validationStage = PRIVATE;
    expect(error.secretFailure.facts.validationStage).toBe('hmac');
    expect(new CanaryError('transport', null, error.secretFailure).secretFailure).toBeNull();
  });

  it('rejects even a fixed diagnostic that happens to echo the supplied bypass credential', async () => {
    const bypass = 'validation_stage_mismatch';
    const { report, calls } = await trial(reply, { profile: profile(START, 'redis_input_missing'),
      input: { credentials: { probeSecret: PROBE, bypassSecret: bypass } } });
    expect(report).toMatchObject({ failure: 'probe_contract', probeFailure: 'credential_echo', secretFailure: null,
      result: 'stopped', observations: [], secretEvidence: 'unqualified' });
    expect(JSON.stringify(report)).not.toContain(bypass);
    expect(calls).toHaveLength(2); expectPrivate(report);
  });

  it('preserves the original loader diagnosis when the final checkpoint also fails', async () => {
    const { report, calls } = await trial(reply, { profile: profile(START, 'redis_input_missing'), deps: { store: {
      /** Reject final persistence without leaking the filesystem failure or enabling another request. */
      save(value) { if (value.failure !== null) throw new Error(PRIVATE); },
    } } });
    expect(report).toMatchObject({ failure: 'secret_contract', secretFailure: { check: 'validation_stage_mismatch' },
      finalCheckpoint: 'failed', result: 'stopped', secretEvidence: 'unqualified' });
    expect(calls).toHaveLength(2); expectPrivate(report);
  });

  it('persists sanitized failure detail and keeps the deployment/case reservation consumed', async () => {
    const location = directory(), selected = profile(START, 'redis_input_missing');
    const store = createStore(selected, approvalId(selected), location);
    const { report } = await trial(reply, { profile: selected, deps: { store } });
    expect(report).toMatchObject({ failure: 'secret_contract', secretFailure: { check: 'validation_stage_mismatch' } });
    expect(JSON.parse(fs.readFileSync(store.reportPath, 'utf8'))).toEqual(report); expectPrivate(report);
    const fresh = profile(START + 1, 'redis_input_missing');
    expect(() => createStore(fresh, approvalId(fresh), location)).toThrow('reservation');
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
  it.each([[], ['--template'], ['--template-production'], ['--template-diagnostic'], ['--template-preview-diagnostic'],
    ...SYNTHETIC_CASES.map((spec) => [spec.option]), ['--review'], ['--live'], ['--unknown']].map((args) => [args]))('keeps CLI offline without a valid live envelope (%j)', (args) => {
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

  it('returns an unusable Production template without prompts or requests', () => {
    const output = powershell(`& ${quoted(LAUNCHER)} -ProductionTemplate\nexit $LASTEXITCODE`);
    expect(output.status).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual(profileTemplate(SUCCESS_CASE));
  });

  /** The diagnostic template does not generate arming metadata or prompt for credentials. */
  it.each([['DiagnosticTemplate', DIAGNOSTIC_CASE], ['PreviewDiagnosticTemplate', PREVIEW_DIAGNOSTIC_CASE]])('returns an unusable %s offline', (flag, caseId) => {
    const output = powershell(`& ${quoted(LAUNCHER)} -${flag}\nexit $LASTEXITCODE`);
    expect(output.status).toBe(0); expect(JSON.parse(output.stdout)).toEqual(profileTemplate(caseId));
  });

  it.each(SYNTHETIC_CASES)('returns the fixed $id template through PowerShell without credentials', (spec) => {
    const output = powershell(`& ${quoted(LAUNCHER)} -${spec.template}\nexit $LASTEXITCODE`);
    expect(output.status).toBe(0); expect(JSON.parse(output.stdout)).toEqual(profileTemplate(spec.id));
  });

  it.each(SYNTHETIC_CASES)('rejects conflicting $id template switches before Node or prompts', (spec) => {
    const output = powershell(`
. ${quoted(LAUNCHER)}
$${spec.template} = [switch]$true
$Template = [switch]$true
function Invoke-Gate1SecretsNode { throw 'Node must not run' }
function Read-Host { throw 'Prompt must not run' }
try { $null = Invoke-Gate1SecretsCanary; exit 2 } catch {
    if ($_.Exception.Message -cne 'Invalid canary mode.') { exit 3 }
}
`);
    expect(output.status).toBe(0);
  });

  it.each(SYNTHETIC_CASES)('independently rejects widened $id fixture metadata before prompts', (spec) => {
    const selected = profile(START, spec.id), prepared = preparation(selected);
    const output = powershell(`
. ${quoted(LAUNCHER)}
$prepared = ${quoted(JSON.stringify(prepared))} | ConvertFrom-Json
$selected = $prepared.profile
if (-not (Test-Gate1SecretsReview $prepared $selected)) { exit 2 }
$rejections = @()
foreach ($change in @('fixture', 'production', 'attestation', 'attestationType', 'extra', 'case', 'sequence')) {
    $prepared = ${quoted(JSON.stringify(prepared))} | ConvertFrom-Json
    $selected = $prepared.profile
    switch ($change) {
        'fixture' { $selected.fixtureId = 'unknown' }
        'production' { $selected.environment = 'production' }
        'attestation' { $selected.attestations.fixtureLocallyValidated = $false }
        'attestationType' { $selected.attestations.fixtureLocallyValidated = 'true' }
        'extra' { $selected | Add-Member -NotePropertyName fixturePayload -NotePropertyValue 'private_fixture' }
        'case' { $selected.caseId = 'REDIS_INPUT_MISSING' }
        'sequence' { $prepared.sequence = @('buildBefore', 'probe1', 'buildAfter') }
    }
    $rejections += -not (Test-Gate1SecretsReview $prepared $selected)
}
ConvertTo-Json -InputObject $rejections
`);
    expect(output.status).toBe(0); expect(JSON.parse(output.stdout)).toEqual(Array(7).fill(true));
  });

  it.each([
    ['empty', ''],
    ['ASCII JSON', '{"fixture":true}'],
    ['Unicode JSON', JSON.stringify({ fixture: '\u00e9\u6f22\u5b57\ud83d\ude00' })],
    ['ASCII at cap', 'a'.repeat(LIMITS.inputBytes)],
    ['Unicode at cap', '\ud83d\ude00'.repeat(LIMITS.inputBytes / 4)],
    ['ASCII over cap', 'a'.repeat(LIMITS.inputBytes + 1)],
    ['Unicode over cap', '\ud83d\ude00'.repeat(LIMITS.inputBytes / 4) + 'a'],
  ])('counts and transmits the same UTF-8 bytes (%s)', (label, input) => {
    const location = directory(), launcher = path.join(location, 'run-gate1-secrets-canary.ps1');
    fs.copyFileSync(LAUNCHER, launcher);
    // A local child records startup and returns raw stdin bytes, without parsing or re-encoding them.
    fs.writeFileSync(path.join(location, 'gate1-secrets-canary.js'), `
require('node:fs').writeFileSync(require('node:path').join(__dirname, 'started'), 'yes');
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  process.stdout.write(JSON.stringify({ base64: input.toString('base64'), bytes: input.length }));
});
`);
    const expected = Buffer.from(input, 'utf8');
    const output = powershell(`
. ${quoted(launcher)}
$value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected.toString('base64')}'))
try {
    $result = Invoke-Gate1SecretsNode '--review' $value
    Write-Output $result.Json
    exit $result.ExitCode
} catch {
    if ($_.Exception.Message -cne 'Invalid canary input.') { exit 2 }
    Write-Output '{"rejected":true}'
}
`);
    expect(output.error).toBeUndefined(); expect(output.status).toBe(0);
    if (expected.length > LIMITS.inputBytes) {
      expect(JSON.parse(output.stdout)).toEqual({ rejected: true });
      expect(fs.existsSync(path.join(location, 'started'))).toBe(false);
    } else {
      expect(JSON.parse(output.stdout)).toEqual({ base64: expected.toString('base64'), bytes: expected.length });
      expect(fs.existsSync(path.join(location, 'started'))).toBe(true);
    }
  });

  it.each([undefined, SUCCESS_CASE, DIAGNOSTIC_CASE, PREVIEW_DIAGNOSTIC_CASE, ...SYNTHETIC_CASES.map((spec) => spec.id)].flatMap((caseId) =>
    ['approve', 'wrong_hash', 'wrong_limits', 'wrong_scope', 'wrong_case', 'cancel', 'wrong_confirmation', 'offline', 'invalid_checkout']
      .map((mode) => [mode, caseId])))('reviews before hidden prompts (%s, %s)', (mode, caseId) => {
    const selected = profile(START, caseId);
    const location = directory(), file = path.join(location, 'profile.json'); fs.writeFileSync(file, JSON.stringify(selected));
    const digest = approvalId(selected);
    const confirmation = SYNTHETIC_CASES.find((spec) => spec.id === caseId)?.confirmation
      ?? (caseId === PREVIEW_DIAGNOSTIC_CASE ? 'RUN PREVIEW SECRET STAGE DIAGNOSTIC ONCE'
      : caseId === DIAGNOSTIC_CASE ? 'RUN PRIVATE SECRET STAGE DIAGNOSTIC ONCE'
      : caseId === SUCCESS_CASE ? 'RUN PRODUCTION CACHE CANARY ONCE' : 'RUN PREVIEW CANARY ONCE');
    const otherConfirmation = caseId === SUCCESS_CASE ? 'RUN PREVIEW CANARY ONCE' : 'RUN PRODUCTION CACHE CANARY ONCE';
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
        $value = @{ Json = ${quoted(JSON.stringify(preparation(selected)))}; ExitCode = 0 }
    } else { $value = & $script:originalNode $Mode $InputJson }
    ${mode === 'wrong_limits' ? "$parsed = $value.Json | ConvertFrom-Json; $parsed.limits.maxAppRequests = 5; $value.Json = $parsed | ConvertTo-Json -Depth 10" : ''}
    ${mode === 'wrong_scope' ? "$parsed = $value.Json | ConvertFrom-Json; $parsed.scope = 'other'; $value.Json = $parsed | ConvertTo-Json -Depth 10" : ''}
    ${mode === 'wrong_case' ? "$parsed = $value.Json | ConvertFrom-Json; $parsed.profile.environment = 'other'; $value.Json = $parsed | ConvertTo-Json -Depth 10" : ''}
    return $value
}
function Read-Host { return '${mode === 'cancel' ? 'CANCEL' : mode === 'wrong_confirmation' ? otherConfirmation : confirmation}' }
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
