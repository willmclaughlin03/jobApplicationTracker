/** Metadata/privacy tests use synthetic provider replies; native network is forbidden throughout. */
const { EventEmitter } = require('node:events');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { LIMITS, TARGETS, PROJECT, TEAM, ATTESTATIONS, InventoryError,
  profileTemplate, parseProfile, approvalId, preparation, operationPath,
  reviewIdentity, reviewOutputs, exchange, createStore, runInventory } = require('../../../scripts/gate1-artifact-inventory');

const TOKEN = 'synthetic_provider_token_0123456789';
const CLI = path.resolve(__dirname, '../../../scripts/gate1-artifact-inventory.js');
const LAUNCHER = path.resolve(__dirname, '../../../scripts/run-gate1-artifact-inventory.ps1');
let nativeGuard;
beforeAll(() => { nativeGuard = jest.spyOn(https, 'request').mockImplementation(() => { throw new Error('Native network forbidden'); }); });
afterEach(() => { expect(nativeGuard).not.toHaveBeenCalled(); jest.useRealTimers(); });
afterAll(() => { nativeGuard.mockRestore(); });

/** Create a reviewed fixture with no private data and stable target-bound authorization. */
function profile() {
  const value = profileTemplate();
  value.attestations = Object.fromEntries(ATTESTATIONS.map((key) => [key, true]));
  return value;
}

/** Supply only a synthetic token through the same shape as private stdin. */
function envelope(selected = profile()) {
  return { profile: selected, approval: approvalId(selected), liveApproved: true, credentials: { providerToken: TOKEN } };
}

/** Represent the documented deployment identity, including Preview's explicit null target. */
function identity(target = TARGETS[0]) {
  return { id: target.deploymentId, projectId: PROJECT, team: { id: TEAM }, version: 2,
    url: target.hostname, target: target.environment === 'preview' ? null : 'production',
    readyState: 'READY', gitSource: { sha: target.gitSha },
    env: { PRIVATE: TOKEN }, meta: { privateUnrelatedMetadata: TOKEN } };
}

/** Representative output types include inaccessible compiled contents and no fetchable artifact URLs. */
function outputs(target = TARGETS[0]) {
  return { builds: [{ id: 'bld_fixture', deploymentId: target.deploymentId, readyState: 'READY',
    output: [{ type: 'file', path: '_next/static/private-name.js', digest: TOKEN },
      { type: 'file', path: '_next/static/private-name.js.map' },
      { type: 'file', path: 'index.html' },
      { type: 'lambda', path: 'api/auth/session', lambda: { functionName: TOKEN, deployedTo: ['iad1'] } }] }] };
}

/** Match only the pinned two routes, asserting credentials cannot reach an arbitrary authority. */
function reply(url) {
  expect(url.origin).toBe('https://api.vercel.com');
  expect(url.searchParams.get('teamId')).toBe(TEAM);
  const target = TARGETS.find((item) => url.pathname.includes(item.deploymentId));
  expect(target).toBeDefined();
  return { value: url.pathname.endsWith('/builds') ? outputs(target) : identity(target) };
}

/** Model asynchronous Node HTTPS events with controllable stalls, failures and stream corruption. */
function transport(responder = reply) {
  const calls = [], requests = [], responses = [];
  const requestImpl = jest.fn((url, options, receive) => {
    const request = new EventEmitter(); request.destroy = jest.fn(); requests.push(request);
    request.end = jest.fn(() => {
      calls.push({ url, options });
      Promise.resolve().then(() => {
        const result = responder(url, calls.length);
        if (result.hang) return;
        if (result.error) { request.emit('error', new Error(TOKEN)); return; }
        const response = new EventEmitter(); responses.push(response);
        response.destroy = jest.fn(); response.complete = result.complete !== false;
        response.statusCode = result.status ?? 200;
        response.rawHeaders = result.rawHeaders ?? ['content-type', 'application/json', ...Object.entries(result.headers || {}).flat()];
        receive(response);
        if (response.destroy.mock.calls.length || result.hangBody) return;
        if (result.closeEarly) { response.emit('close'); return; }
        for (const chunk of result.chunks || [Buffer.from(result.body ?? JSON.stringify(result.value))]) response.emit('data', chunk);
        if (result.aborted) response.emit('aborted'); else response.emit('end');
        response.emit('close');
      }).catch((error) => request.emit('error', error));
    });
    return request;
  });
  return { requestImpl, calls, requests, responses };
}

/** Run against memory storage, recording even stopped outcomes without consuming a real approval. */
async function trial(responder = reply, input = envelope(), options = {}) {
  const wire = transport(responder), saved = [];
  const storeFactory = jest.fn(() => ({ save: (report) => { saved.push(report); return 'memory-report'; } }));
  const result = await runInventory(input, { requestImpl: wire.requestImpl, storeFactory,
    now: () => 0, wall: () => Date.parse('2026-10-11T19:00:00Z'), ...options });
  return { ...result, ...wire, saved, storeFactory };
}

/** Assert metadata and provider failures cannot leak raw strings or claim complete privacy. */
function expectPrivate(report) {
  const text = JSON.stringify(report);
  for (const value of [TOKEN, 'private-name', 'RAW_PROVIDER_ERROR', 'attacker.invalid']) expect(text).not.toContain(value);
  expect(report.gate1Status).toBe('open');
  expect(text).not.toContain('complete_artifact_privacy');
}

test('offline template refuses unconfirmed attestations and fixed-target changes', () => {
  expect(() => parseProfile(profileTemplate())).toThrow('profile');
  const p = profile(), prepared = preparation(p);
  expect(prepared).toMatchObject({ mode: 'prepare', liveApproved: false, appRequests: 0, providerRequests: 0,
    completeness: 'unqualified', compiledContentAccess: 'not_established' });
  expect(prepared.operations).toHaveLength(4);
  expect(prepared.operations.every((item) => item.method === 'GET')).toBe(true);
  const id = approvalId(p); p.runId = '1'.repeat(32); expect(approvalId(p)).not.toBe(id);
  p.targets.reverse(); expect(() => parseProfile(p)).toThrow('profile');
});

test.each(['targets', 'projectId', 'teamId', 'attestations', 'scope'])('profile cannot expand %s', (field) => {
  const p = profile(); p[field] = 'attacker.invalid';
  expect(() => parseProfile(p)).toThrow('profile');
});

test('approval changes with launcher, runner or dependency lock bytes', () => {
  const p = profile(), id = approvalId(p), read = fs.readFileSync;
  for (const name of ['gate1-artifact-inventory.js', 'run-gate1-artifact-inventory.ps1', 'package-lock.json']) {
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) =>
      String(file).endsWith(name) ? Buffer.from('changed-executable-fixture') : read(file, ...args));
    try { expect(approvalId(p)).not.toBe(id); } finally { spy.mockRestore(); }
  }
});

test('four GETs return sanitized counts and validated historical attribution only', async () => {
  const result = await trial();
  expect(result.report).toMatchObject({ result: 'completed', mode: 'fixture', hostedEvidence: 'not_executed',
    appRequests: 0, providerRequests: 4, validatedRequests: 4, unvalidatedAttempts: 0,
    contentDownloads: 0, configMutations: 0, outputEntries: 8, artifactPrivacy: 'not_evaluated',
    completeness: 'unqualified', compiledContentAccess: 'not_established' });
  expect(result.calls.map(({ url }) => url.pathname)).toEqual(TARGETS.flatMap((target) =>
    [`/v13/deployments/${target.deploymentId}`, `/v11/deployments/${target.deploymentId}/builds`]));
  expect(result.calls.every(({ options }) => options.method === 'GET' && options.agent === false &&
    options.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  expect(result.calls[0].url.searchParams.get('withGitRepoInfo')).toBe('true');
  for (const target of result.report.targets) expect(target).toMatchObject({ identityValidated: true,
    listingValidated: true, listing: 'entries_returned', sourceMapAbsence: 'not_established',
    nextBuildIdEvidence: 'historical_profile_only_no_http_verification',
    counts: { builds: 1, outputEntries: 4, staticJavaScript: 1, sourceMaps: 1, otherStatic: 1, functions: 1, unsupported: 0 } });
  expect(result.saved).toEqual([result.report]); expectPrivate(result.report);
  expect(result.reportPath).toBe('memory-report');
  expect(result.report).not.toHaveProperty('reportWrite');
});

/** A storage failure must retain completed or stopped evidence without exposing exception details. */
test.each(['completed', 'stopped'])('report write failure retains the sanitized %s outcome', async (outcome) => {
  const input = envelope();
  /** Simulate a write error containing private details that must never reach the returned report. */
  const save = jest.fn(() => { throw new Error(`${TOKEN} RAW_PROVIDER_ERROR`); });
  const result = await trial(outcome === 'completed' ? reply : () => ({ error: true }), input,
    { storeFactory: () => ({ save }) });
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0]).toBe(result.report);
  expect(result.reportPath).toBeNull();
  expect(result.report).toMatchObject({ result: outcome, approvalId: input.approval, reportWrite: 'report_write',
    failure: outcome === 'completed' ? null : 'transport',
    providerRequests: outcome === 'completed' ? 4 : 1, validatedRequests: outcome === 'completed' ? 4 : 0 });
  expect(result.report.targets).toHaveLength(outcome === 'completed' ? 2 : 1);
  expect(result.report.receipts).toHaveLength(outcome === 'completed' ? 4 : 1);
  expectPrivate(result.report);
});

/** A post-run credential collision must keep the fixed fallback even when its save fails. */
test('report write failure retains only the sanitized credential fallback', async () => {
  const input = envelope(); input.credentials.providerToken = 'historical_profile_only';
  /** Fail persistence after the credential guard has replaced the detailed report. */
  const save = jest.fn(() => { throw new InventoryError('report_write'); });
  const result = await trial(reply, input, { storeFactory: () => ({ save }) });
  expect(result.calls).toHaveLength(4);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0]).toBe(result.report);
  expect(result.reportPath).toBeNull();
  expect(result.report).toEqual({ schemaVersion: 1, result: 'stopped', gate1Status: 'open',
    failure: 'credentials', providerRequests: 4, appRequests: 0, reportWrite: 'report_write' });
  expect(JSON.stringify(result.report)).not.toContain(input.credentials.providerToken);
  expectPrivate(result.report);
});

test.each(['approval', 'liveApproved', 'credentials', 'extra'])('invalid %s stops before reservation or network', async (key) => {
  const input = envelope();
  input[key] = key === 'approval' ? '0'.repeat(64) : false;
  const result = await trial(reply, input);
  expect(result.report.result).toBe('stopped'); expect(result.calls).toHaveLength(0);
  expect(result.storeFactory).not.toHaveBeenCalled(); expect(result.reportPath).toBeNull(); expectPrivate(result.report);
});

test.each(['id', 'projectId', 'url', 'readyState', 'version', 'target', 'gitSource', 'team'])('identity %s mismatch stops before listing', async (field) => {
  const value = identity(); value[field] = 'incorrect';
  const result = await trial(() => ({ value }));
  expect(result.report.failure).toBe('attribution'); expect(result.calls).toHaveLength(1);
  expect(result.saved).toEqual([result.report]); expectPrivate(result.report);
});

test('owner metadata must be present and all supplied owner/SHA claims must agree', () => {
  const value = identity(); delete value.team;
  expect(() => reviewIdentity(value, TARGETS[0])).toThrow('attribution');
  value.ownerId = TEAM; expect(reviewIdentity(value, TARGETS[0]).identityValidated).toBe(true);
  value.teamId = 'different-team'; expect(() => reviewIdentity(value, TARGETS[0])).toThrow('attribution');
  delete value.teamId; value.meta.githubCommitSha = 'different-sha';
  expect(() => reviewIdentity(value, TARGETS[0])).toThrow('attribution');
});

test('Preview needs an explicit null target and rejects custom environments', () => {
  const value = identity(TARGETS[1]); delete value.target;
  expect(() => reviewIdentity(value, TARGETS[1])).toThrow('attribution');
  value.target = null; value.customEnvironment = { id: 'env_custom' };
  expect(() => reviewIdentity(value, TARGETS[1])).toThrow('attribution');
});

test('empty listings and zero maps never become absence or completeness claims', async () => {
  const result = await trial((url) => url.pathname.endsWith('/builds') ? { value: { builds: [] } } : reply(url));
  expect(result.report.result).toBe('completed');
  for (const target of result.report.targets) expect(target).toMatchObject({ listing: 'empty_listing_returned',
    completeness: 'unqualified', sourceMapAbsence: 'not_established', compiledContentAccess: 'not_established',
    counts: { builds: 0, outputEntries: 0, sourceMaps: 0 } });
});

test.each(['next', 'nextCursor', 'pagination', 'truncated', 'hasMore', 'partial', 'links'])('continuation indicator %s stops without following', async (key) => {
  const result = await trial((url) => url.pathname.endsWith('/builds')
    ? { value: { ...outputs(), [key]: key === 'next' ? 'https://attacker.invalid' : false } } : reply(url));
  expect(result.report.failure).toBe('pagination'); expect(result.calls).toHaveLength(2); expectPrivate(result.report);
});

test.each(['build', 'output'])('nested %s continuation marker remains non-passing', (level) => {
  const value = outputs();
  (level === 'build' ? value.builds[0] : value.builds[0].output[0]).nextCursor = TOKEN;
  expect(() => reviewOutputs(value, TARGETS[0], {}, { outputEntries: 0 })).toThrow('pagination');
});

test.each([
  { path: 'mystery.js' }, { type: 'edge', path: 'mystery.js' }, { type: 'lambda', path: 'route' },
  { type: 'file', path: 'file.js', lambda: { functionName: TOKEN, deployedTo: [] } },
  { type: 'file', path: 123 },
])('unsupported entry cannot silently count as inspected: %j', async (entry) => {
  const value = outputs(); value.builds[0].output = [entry];
  const result = await trial((url) => url.pathname.endsWith('/builds') ? { value } : reply(url));
  expect(result.report.failure).toBe('unsupported_output');
  expect(result.report.targets[0].counts.unsupported).toBe(1);
  expect(result.report.targets[0].listingValidated).toBe(false); expect(result.calls).toHaveLength(2);
});

test.each(['schema', 'deployment', 'duplicate'])('invalid build %s is non-passing', async (kind) => {
  const value = outputs();
  if (kind === 'schema') delete value.builds[0].output;
  if (kind === 'deployment') value.builds[0].deploymentId = TARGETS[1].deploymentId;
  if (kind === 'duplicate') value.builds.push(value.builds[0]);
  const result = await trial((url) => url.pathname.endsWith('/builds') ? { value } : reply(url));
  expect(result.report.failure).toBe(kind === 'deployment' ? 'attribution' : 'provider_schema');
  expect(result.calls).toHaveLength(2);
});

test('entry budget applies across both deployments and admits exactly 2000', async () => {
  for (const count of [1000, 1001]) {
    const result = await trial((url) => {
      const fixture = reply(url);
      if (url.pathname.endsWith('/builds')) fixture.value.builds[0].output = Array.from({ length: count },
        (_, index) => ({ type: 'file', path: `file-${index}.js` }));
      return fixture;
    });
    expect(result.report.result).toBe(count === 1000 ? 'completed' : 'stopped');
    expect(result.report.failure).toBe(count === 1000 ? null : 'entry_limit');
    expect(result.report.outputEntries).toBeLessThanOrEqual(2000);
  }
});

test.each([
  [{ status: 302, headers: { location: 'https://attacker.invalid' } }, 'http_status'],
  [{ status: 403, body: '{"error":"RAW_PROVIDER_ERROR"}' }, 'http_status'],
  [{ status: 404 }, 'http_status'], [{ status: 429 }, 'http_status'],
  [{ rawHeaders: ['content-type', 'text/html'] }, 'content_type'],
  [{ headers: { 'content-encoding': 'gzip' } }, 'encoding'],
  [{ headers: { 'content-length': String(LIMITS.providerBytes + 1) } }, 'body_size'],
  [{ headers: { 'content-length': 'NaN' } }, 'body_size'],
  [{ rawHeaders: ['content-type', 'application/json', 'Content-Type', 'application/json'] }, 'headers'],
  [{ headers: { link: 'https://attacker.invalid' } }, 'pagination'],
  [{ headers: { 'content-range': 'entries 1-2/5' } }, 'pagination'],
  [{ rawHeaders: ['invalid'] }, 'headers'],
  [{ headers: { ignored: 'a'.repeat(LIMITS.headerBytes) } }, 'headers'],
  [{ body: '{RAW_PROVIDER_ERROR' }, 'provider_json'],
  [{ chunks: [Buffer.from([0xff])] }, 'encoding'],
  [{ error: true }, 'transport'], [{ closeEarly: true }, 'incomplete_body'],
  [{ aborted: true }, 'incomplete_body'], [{ complete: false }, 'incomplete_body'],
  [{ headers: { 'content-length': '1' } }, 'incomplete_body'],
])('transport failure case %# is bounded, retained and never retried', async (override, failure) => {
  const result = await trial(() => ({ value: identity(), ...override }));
  expect(result.report.failure).toBe(failure); expect(result.calls).toHaveLength(1);
  expect(result.report.unvalidatedAttempts).toBe(1); expect(result.saved).toEqual([result.report]);
  expect(result.requests[0].destroy).toHaveBeenCalled(); expectPrivate(result.report);
});

test('streaming byte cap destroys I/O before retaining an oversized body', async () => {
  const result = await trial(() => ({ chunks: [Buffer.alloc(LIMITS.providerBytes, 32), Buffer.from('x')] }));
  expect(result.report.failure).toBe('body_size'); expect(result.calls).toHaveLength(1);
  expect(result.report.bytesReceived).toBe(LIMITS.providerBytes + 1);
});

test('total byte and request guards reject attempts beyond the fixed budget', async () => {
  const wire = transport(() => ({ value: identity() }));
  const state = { started: 0, previous: 0, report: { providerRequests: 3, bytesReceived: LIMITS.totalBytes } };
  const deps = { requestImpl: wire.requestImpl, now: () => 0 };
  await expect(exchange(TARGETS[0], 'identity', TOKEN, state, deps, {})).rejects.toThrow('total_bytes');
  await expect(exchange(TARGETS[0], 'identity', TOKEN, state, deps, {})).rejects.toThrow('request_limit');
  expect(wire.calls).toHaveLength(1);
  expect(() => operationPath({ deploymentId: 'attacker' }, 'identity')).toThrow('input');
  expect(() => operationPath(TARGETS[0], 'content')).toThrow('input');
});

test.each(['hang', 'hangBody'])('real timer ends %s without a retry', async (kind) => {
  jest.useFakeTimers();
  const pending = trial(() => ({ value: identity(), [kind]: true }));
  await jest.advanceTimersByTimeAsync(LIMITS.requestMs + 1);
  const result = await pending;
  expect(result.report.failure).toBe('request_timeout'); expect(result.calls).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('overall deadline includes response parsing/review and monotonic discontinuity', async () => {
  let time = 0;
  const result = await trial((url) => { time = LIMITS.overallMs; return reply(url); }, envelope(), { now: () => time });
  expect(result.report.failure).toBe('overall_deadline'); expect(result.calls).toHaveLength(1);
  let nowCalls = 0;
  const reversed = await trial(reply, envelope(), { now: () => nowCalls++ < 2 ? 10 : 0 });
  expect(reversed.report.failure).toBe('overall_deadline'); expect(reversed.calls).toHaveLength(0);
});

test('cancellation before dispatch or during a response never advances the sequence', async () => {
  const controller = new AbortController(); controller.abort();
  const early = await trial(reply, envelope(), { signal: controller.signal });
  expect(early.report.failure).toBe('cancelled'); expect(early.calls).toHaveLength(0);
  const active = new AbortController();
  const pending = trial(() => { active.abort(); return { hang: true }; }, envelope(), { signal: active.signal });
  const result = await pending;
  expect(result.report.failure).toBe('cancelled'); expect(result.calls).toHaveLength(1);
});

test('consume-once store prevents replay, exclusive report overwrite and reservation release', () => {
  const mkdir = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
  const exists = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
  const files = new Map();
  const write = jest.spyOn(fs, 'writeFileSync').mockImplementation((file, content, options) => {
    expect(options.flag).toBe('wx'); expect(options.mode).toBe(0o600);
    if (files.has(file)) throw new Error(TOKEN);
    files.set(file, content);
  });
  try {
    const store = createStore('a'.repeat(64));
    expect(() => createStore('a'.repeat(64))).toThrow('reservation');
    store.save({ result: 'stopped' });
    expect(() => store.save({ result: 'stopped' })).toThrow('report_write');
    expect(() => store.save({ value: 'a'.repeat(LIMITS.reportBytes) })).toThrow('report_write');
    expect(files.size).toBe(2);
    exists.mockReturnValue(true);
    expect(() => createStore('b'.repeat(64))).toThrow('reservation');
  } finally { mkdir.mockRestore(); exists.mockRestore(); write.mockRestore(); }
});

test('reservation failure causes zero dispatch and no fabricated saved report', async () => {
  const result = await trial(reply, envelope(), { storeFactory: () => { throw new InventoryError('reservation'); } });
  expect(result.report.failure).toBe('reservation'); expect(result.calls).toHaveLength(0); expect(result.reportPath).toBeNull();
});

test('tokens colliding with fixed metadata are rejected before reservation', async () => {
  const input = envelope(); input.credentials.providerToken = TARGETS[0].deploymentId;
  const result = await trial(reply, input);
  expect(result.report.failure).toBe('credentials'); expect(result.calls).toHaveLength(0);
  expect(result.storeFactory).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain(input.credentials.providerToken);
});

test('unexpected provider fields are discarded instead of printed as raw metadata', async () => {
  const result = await trial((url) => {
    const fixture = reply(url);
    if (url.pathname.endsWith('/builds')) fixture.value.builds[0].config = { secret: TOKEN, raw: 'RAW_PROVIDER_ERROR' };
    return fixture;
  });
  expect(result.report.result).toBe('completed'); expectPrivate(result.report);
});

test('CLI defaults offline and rejects credential arguments without echoing them', () => {
  const template = spawnSync(process.execPath, [CLI], { encoding: 'utf8', timeout: 10000 });
  expect(template.error).toBeUndefined();
  expect(template.status).toBe(0);
  expect(JSON.parse(template.stdout).attestations.sourceCodeReviewed).toBe(false);
  const rejected = spawnSync(process.execPath, [CLI, '--token', TOKEN], { encoding: 'utf8', timeout: 10000 });
  expect(rejected.status).toBe(1); expect(rejected.stdout + rejected.stderr).not.toContain(TOKEN);
});

(process.platform === 'win32' ? test : test.skip)('PowerShell syntax, offline template and invalid live invocation require no private prompt', () => {
  const quoted = LAUNCHER.replace(/'/g, "''");
  const command = `$tokens=$null; $errors=$null; $null=[Management.Automation.Language.Parser]::ParseFile('${quoted}',[ref]$tokens,[ref]$errors); if($errors.Count){exit 3}; . '${quoted}'; function Read-Gate1InventoryToken { throw 'Unexpected token prompt' }; $result=Invoke-Gate1ArtifactInventory; if($result.ExitCode -ne 0){exit 4}; $parsed=$result.Json | ConvertFrom-Json; if($parsed.scope -cne 'historical_build_output_metadata_only'){exit 5}; $Live=$true; try { $null=Invoke-Gate1ArtifactInventory; exit 6 } catch { exit 0 }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 15000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe(''); expect(result.status).toBe(0);
});
