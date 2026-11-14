'use strict';
/* global Buffer, AbortController, Response, setImmediate */
/** Offline runner tests use synthetic metadata, in-memory writes and fake child-process events. */
const { test, jest: mocks, afterEach } = require('@jest/globals');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const runner = require('../observe-build.cjs');
const provider = require('../provider-read-child.cjs');
const identification = require(path.join(provider.ROOT, '.tmp/gate1-rollback-tools/post-main-f3d6eade-attempt-2/identify-redeployment.cjs'));
const { TARGET } = provider;
const MANIFEST = { packageDigest: 'b'.repeat(64) };
const SECRET = 'synthetic-sensitive-text-never-retain';

/** Restore mocked methods and clocks so later boundary tests cannot inherit a relaxed guard. */
afterEach(() => { mocks.restoreAllMocks(); mocks.useRealTimers(); });

/** Independent expected IPC shapes exercise parent validation without using child projection to construct them. */
function metadata(phase) {
  if (phase.startsWith('alias_')) return { hostname: TARGET.hostname, projectId: TARGET.projectId,
    deploymentId: TARGET.deploymentId, updatedAt: TARGET.aliasUpdatedAt };
  if (phase === 'deployment') return { identity: { deploymentId: TARGET.deploymentId, projectId: TARGET.projectId,
    immutableHostname: TARGET.immutableHostname, target: 'production', readyState: 'READY', gitSha: TARGET.gitSha,
    createdAt: 1000, readyAt: 2000, canonicalAliasListed: true, configuredNodeMajor: '24.x' },
    routes: { available: true, count: 1, recognizedDestinations: ['/login'], unrecognizedDestinations: 0,
      middlewareReferences: 0, headerRules: 0, comparison: 'unqualified_partial_metadata' },
    declaredFramework: 'nextjs', deploymentVersion: 2, configuredNodeMajor: '24.x' };
  if (phase === 'builds') return { available: true, buildCount: 1, outputCount: 1, missingOutputLists: 0,
    unrecognizedOutputs: 0, outputs: [{ route: '/api/auth/session', type: 'lambda', runtime: 'nodejs22.x', size: 2048 }],
    comparison: 'unqualified_partial_metadata' };
  return { eventCount: 1, textEventCount: 1, ignoredEventCount: 0,
    versions: { node: null, npm: null, vercel: '62.2.0', next: '16.3.3', 'eslint-config-next': null,
      react: null, 'react-dom': null, sharp: null, postcss: null },
    routeTable: [{ route: '/login', rendering: 'dynamic' }], unrecognizedRouteRows: 0,
    coverage: 'bounded_sample_not_complete_log' };
}

/** Return the real parser's minimal login shape; cookies and arbitrary body data must never enter evidence. */
function loginResponse(build = TARGET.buildId) {
  return { status: 200, headers: { 'content-type': 'text/html' },
    text: `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ page: '/login', buildId: build })}</script>${SECRET}</html>` };
}

/** Record order/accounting while allowing one precise malformed response, clock or checkpoint failure. */
function harness({ mutate = () => {}, saveFailure = () => false, now, login = loginResponse(), announcements = 1 } = {}) {
  const calls = [], saves = [];
  let active = 0, maxActive = 0;
  return { calls, saves, get maxActive() { return maxActive; }, deps: {
    now,
    /** Project fake provider facts only after recording a bounded dispatch, without any network. */
    async provider(phase, deploymentId, timeoutMs, signal, onDispatch) {
      active++; maxActive = Math.max(maxActive, active); calls.push(phase);
      assert.equal(deploymentId, TARGET.deploymentId); assert.ok(timeoutMs <= 30000); assert.equal(signal.aborted, false);
      for (let i = 0; i < announcements; i++) onDispatch();
      const value = metadata(phase); mutate(phase, value); await Promise.resolve(); active--; return value;
    },
    /** Supply anonymous HTML directly; the runner still uses the reviewed production login parser. */
    async login() { active++; maxActive = Math.max(maxActive, active); calls.push('login'); active--; return login; },
    loginBuild: identification.reviewedLogin().loginBuild,
    /** Save snapshots in memory so tests cannot consume the real evidence destination. */
    save(report) { if (saveFailure(report)) throw new Error(SECRET); saves.push(JSON.parse(JSON.stringify(report))); },
  } };
}

/** Successful observation remains explicitly partial despite seven validated operations. */
test('runs the seven-phase sequence once and preserves qualification gaps', async () => {
  const h = harness(), report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.result, 'observed_with_gaps'); assert.equal(report.failure, null);
  assert.deepEqual(report.observations.map((item) => item.phase), runner.PROFILE.sequence);
  assert.deepEqual(h.calls, ['alias_before', 'login', 'deployment', 'builds', 'events', 'login', 'alias_after']);
  assert.equal(h.maxActive, 1); assert.equal(report.providerAttempts, 5);
  assert.equal(report.providerDispatchAnnouncements, 5); assert.equal(report.applicationAttempts, 2);
  assert.equal(report.attribution.exactManifestComparison, 'unqualified');
  assert.ok(report.attribution.gaps.includes('build_version_node_unobserved'));
  assert.equal(report.attribution.buildLogVersionClaims.node, null);
  assert.equal(report.runtimeProbeExecuted, false); assert.equal(report.rollbackExecuted, false);
  assert.ok(!JSON.stringify(h.saves).includes(SECRET));
});

/** Parent validation independently rejects corrupted IPC and target/build drift before any later phase. */
test.each([
  ['initial deployment drift', 'alias_before', (m) => { m.deploymentId = 'dpl_other'; }, 'alias_drift'],
  ['alias timestamp drift', 'alias_before', (m) => { m.updatedAt++; }, 'alias_drift'],
  ['final alias drift', 'alias_after', (m) => { m.updatedAt++; }, 'alias_drift'],
  ['project drift', 'deployment', (m) => { m.identity.projectId = 'prj_other'; }, 'provider_schema'],
  ['source drift', 'deployment', (m) => { m.identity.gitSha = 'a'.repeat(40); }, 'identity_mismatch'],
  ['deployment drift', 'deployment', (m) => { m.identity.deploymentId = 'dpl_other'; }, 'identity_mismatch'],
  ['version contradiction', 'events', (m) => { m.versions.next = '16.3.4'; }, 'attribution_conflict'],
  ['build Node contradiction', 'events', (m) => { m.versions.node = '24.1.0'; }, 'attribution_conflict'],
  ['raw field injection', 'builds', (m) => { m.secret = SECRET; }, 'provider_schema'],
])('%s stops without retries', async (label, phase, mutate, expected) => {
  const h = harness({ mutate: (p, m) => { if (p === phase) mutate(m); } });
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.result, 'stopped'); assert.equal(report.failure, expected);
  assert.equal(h.calls.at(-1), phase); assert.equal(h.calls.filter((p) => p === phase).length, 1);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

/** Missing arrays and versions do not silently inherit historical or source-lock passes. */
test('missing provider attribution finishes only with explicit gaps', async () => {
  const h = harness({ mutate: (phase, m) => {
    if (phase === 'builds') { m.available = false; m.buildCount = 0; m.outputCount = 0; m.outputs = []; }
    if (phase === 'deployment') { m.routes.available = false; m.routes.count = 0; m.routes.recognizedDestinations = []; }
    if (phase === 'events') { m.versions.next = null; m.routeTable = []; }
  } });
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.result, 'observed_with_gaps');
  for (const gap of ['provider_build_outputs_missing', 'provider_routes_missing', 'build_version_next_unobserved']) assert.ok(report.attribution.gaps.includes(gap));
});

/** Checkpoint failures prohibit subsequent operations and do not retry a broken evidence sink. */
test.each([0, 1, 4])('stops at checkpoint after %s observations', async (count) => {
  const h = harness({ saveFailure: (report) => report.observations.length === count });
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.failure, 'checkpoint'); assert.equal(h.calls.length, count);
});

/** Both too few and duplicate dispatch receipts invalidate the attempt without extra traffic. */
test.each([0, 2])('rejects %s dispatch announcements', async (announcements) => {
  const h = harness({ announcements }); const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.result, 'stopped'); assert.equal(h.calls.length, 1);
  assert.equal(report.failure, announcements ? 'request_budget' : 'child_protocol');
});

/** Monotonic timeout checks prevent even the first dispatch after deadline expiry. */
test('expired overall deadline stops before traffic', async () => {
  let clock = 0; const h = harness({ now: () => { clock += 120001; return clock; } });
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.failure, 'overall_deadline'); assert.equal(h.calls.length, 0);
});

/** The outer timer also bounds a transport that never settles or cooperates with abort. */
test('stalled adapters cannot hang the overall deadline', async () => {
  mocks.useFakeTimers(); const h = harness(); h.deps.provider = () => new Promise(() => {});
  const pending = runner.runWithAdapters(MANIFEST, h.deps);
  await mocks.advanceTimersByTimeAsync(120001);
  const report = await pending; assert.equal(report.failure, 'overall_deadline');
  assert.equal(mocks.getTimerCount(), 0);
});

/** Invalid login responses cannot be accepted merely because a build-like token appears in their body. */
test.each([
  ['wrong build', loginResponse('wrong')], ['redirect', { ...loginResponse(), status: 302 }],
  ['wrong page', { ...loginResponse(), text: loginResponse().text.replace('/login', '/dashboard') }],
  ['duplicate build', { ...loginResponse(), text: loginResponse().text.repeat(2) }],
  ['wrong MIME', { ...loginResponse(), headers: { 'content-type': 'application/json' } }],
])('%s stops before build reads', async (label, login) => {
  const h = harness({ login }), report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.failure, 'login_contract'); assert.deepEqual(h.calls, ['alias_before', 'login']);
});

/** Exercise the shared bounded anonymous transport with a fake fetch and cookie-bearing response. */
test('login transport discards cookies and uses manual redirects with no auth', async () => {
  let calls = 0; const transport = identification.reviewedLogin();
  const response = await transport.login(new AbortController().signal, 10000, async (url, init) => {
    calls++; assert.equal(url, runner.PROFILE.applicationURL); assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit'); assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers.Cookie, undefined);
    return new Response(loginResponse().text, { headers: { 'content-type': 'text/html', 'set-cookie': 'private=sentinel' } });
  });
  assert.equal(calls, 1); assert.equal(transport.loginBuild(response), TARGET.buildId);
  assert.ok(!JSON.stringify(response).includes('private=sentinel'));
});

/** Model a filesystem in memory so reservation/checkpoint tests never create evidence artifacts. */
function fakeIo(existing = false, failAt = null) {
  const writes = [], data = [];
  let present = existing;
  /** Simulate a filesystem failure at a named reservation operation, after recording any attempted write. */
  function fail(point) { if (failAt === point) throw new Error('synthetic disk failure'); }
  return { writes, data,
    /** Report attempt-directory presence independently of open report handles. */
    existsSync() { return present; },
    /** Model exclusive directory creation, including a competing reservation after the initial check. */
    mkdirSync() {
      if (failAt === 'race') present = true;
      if (present) { const error = new Error(); error.code = 'EEXIST'; throw error; }
      fail('mkdir'); present = true;
    },
    /** Record partial profile/reservation writes before an injected failure. */
    writeFileSync(file, bytes, options) { writes.push({ file, bytes, options }); fail(path.basename(file)); },
    /** Model report creation failing before a sink can be returned. */
    openSync(file, flag) { writes.push({ file, flag }); fail('report.json'); return 1; },
    /** Keep truncation entirely in memory; write tests separately inject partial progress. */
    ftruncateSync() {},
    /** Capture synthetic checkpoint content and acknowledge the requested byte count. */
    writeSync(fd, bytes, offset, length) { data.push(bytes.toString()); return length; },
    /** Model a successful durability flush without touching a disk. */
    fsyncSync() {},
    /** Model releasing the synthetic report descriptor without changing reservation state. */
    closeSync() {},
  };
}

test('reservation is exclusive and records consumed no-replay state', () => {
  const io = fakeIo();
  const sink = runner.reserve(MANIFEST, io);
  assert.equal(io.writes.length, 3);
  assert.ok(io.writes.every((row) => (row.flag || row.options.flag) === 'wx'));
  assert.ok(io.writes[1].bytes.includes('reserved_no_replay'));
  sink.save({ safe: true }); sink.close();
  assert.deepEqual(JSON.parse(io.data[0]), { safe: true });
});

test('existing reservation blocks all file writes and dispatch', () => {
  const io = fakeIo(true);
  assert.throws(() => runner.reserve(MANIFEST, io), { code: 'evidence_exists' });
  assert.equal(io.writes.length, 0);
});

/** Provide an EventEmitter child whose entire protocol is driven by the test callback. */
function fakeFork(actions) {
  return (file, args, options) => {
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.execArgv, []);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    setImmediate(() => actions(child));
    return child;
  };
}

/** Return a valid sanitized provider receipt for parent-process protocol tests. */
function receipt() {
  return { type: 'receipt', schemaVersion: 1, result: 'read', failure: null,
    nativeFetchCalls: 1, adapterCalls: 1, suppressedUserLookups: 0, status: 200, cliExitCode: 0,
    metadata: metadata('alias_before') };
}

test('child receipts require a dispatch announcement and successful process completion', async () => {
  let dispatched = 0;
  const value = await runner.readProvider('alias_before', TARGET.deploymentId, 1000, new AbortController().signal,
    () => { dispatched++; }, fakeFork((child) => {
      child.emit('message', { type: 'dispatch' }); child.emit('message', receipt()); child.emit('close', 0);
    }));
  assert.equal(dispatched, 1);
  assert.deepEqual(value, metadata('alias_before'));
});

test('failed child preserves bounded status/exit accounting without raw response fields', async () => {
  await assert.rejects(runner.readProvider('alias_before', TARGET.deploymentId, 1000, new AbortController().signal,
    () => {}, fakeFork((child) => {
      child.emit('message', { type: 'dispatch' });
      child.emit('message', { ...receipt(), result: 'stopped', failure: 'provider_status',
        status: 403, cliExitCode: 1, metadata: null });
      child.emit('close', 1);
    })), (error) => {
    assert.equal(error.code, 'provider_status');
    assert.equal(error.providerFacts.status, 403);
    assert.equal(error.providerFacts.cliExitCode, 1);
    assert.equal(error.providerFacts.metadata, undefined);
    return true;
  });
});

for (const [label, actions, code] of [
  ['missing receipt', (child) => child.emit('close', 0), 'child_failed'],
  ['receipt without dispatch', (child) => child.emit('message', receipt()), 'child_protocol'],
  ['duplicate dispatch', (child) => { child.emit('message', { type: 'dispatch' }); child.emit('message', { type: 'dispatch' }); }, 'child_protocol'],
  ['extra receipt fields', (child) => child.emit('message', { ...receipt(), secret: 'synthetic' }), 'child_protocol'],
  ['child error', (child) => child.emit('error', new Error('private')), 'child_failed'],
  ['timeout', () => {}, 'child_timeout'],
]) {
  test(`stops on ${label}`, async () => {
    await assert.rejects(runner.readProvider('alias_before', TARGET.deploymentId, 20, new AbortController().signal,
      () => {}, fakeFork(actions)), { code });
  });
}

/** Incorrect or absent authorization must never reach reservation, source execution or transport. */
test.each([['--execute', 'a'.repeat(64)], ['--execute'], ['--read'], ['--execute', 'not-a-digest']])('rejects unauthorized arguments %j', async (...args) => {
  const output = [], sideEffect = mocks.fn(() => { throw new Error('unexpected side effect'); });
  const code = await runner.main(args, { prepare: () => MANIFEST, output: (value) => output.push(value),
    verifySource: sideEffect, reserve: sideEffect, provider: sideEffect });
  assert.equal(code, 1); assert.equal(sideEffect.mock.calls.length, 0);
  assert.ok(['approval', 'arguments'].includes(output.at(-1).failure));
});

/** Preparation is read-only even with a valid package; default mode cannot execute a provider read. */
test('default mode only returns the prepared manifest', async () => {
  const output = [], reserve = mocks.fn();
  assert.equal(await runner.main([], { prepare: () => MANIFEST, output: (value) => output.push(value), reserve }), 0);
  assert.equal(output[0].liveExecuted, false); assert.equal(reserve.mock.calls.length, 0);
});

/** Partial writes consume the attempt; a second reservation cannot reuse or erase the failed first reservation. */
test.each(['profile.json', 'reservation.json', 'report.json', 'race'])('preserves no-replay after %s failure', async (point) => {
  const io = fakeIo(false, point), state = {};
  assert.throws(() => runner.reserve(MANIFEST, io, state), { code: point === 'race' ? 'evidence_exists' : 'checkpoint' });
  assert.equal(state.evidenceMayExist, true);
  assert.throws(() => runner.reserve(MANIFEST, io, {}), { code: 'evidence_exists' });
});

/** A consumed destination blocks the authorized orchestration before its first provider callback. */
test('authorized execution still refuses a consumed attempt', async () => {
  const io = fakeIo(true), providerCall = mocks.fn(), output = [];
  const code = await runner.main(['--execute', MANIFEST.packageDigest], { prepare: () => MANIFEST,
    verifySource: () => {}, reserve: (manifest, unused, state) => runner.reserve(manifest, io, state),
    loginTransport: {}, provider: providerCall, output: (value) => output.push(value) });
  assert.equal(code, 1); assert.equal(output.at(-1).failure, 'evidence_exists');
  assert.equal(output.at(-1).evidenceMayExist, true); assert.equal(providerCall.mock.calls.length, 0);
});

/** Report writes tolerate short writes but reject zero progress, oversized evidence and sync failures. */
test('checkpoint writer handles partial writes and rejects broken disks', () => {
  const io = fakeIo(); let written = 0;
  io.writeSync = (fd, bytes, offset, length) => { const count = Math.min(3, length); written += count; return count; };
  const sink = runner.reserve(MANIFEST, io); sink.save({ safe: true });
  assert.equal(written, Buffer.byteLength(JSON.stringify({ safe: true }, null, 2) + '\n'));
  io.writeSync = () => 0; assert.throws(() => sink.save({ safe: true }), { code: 'checkpoint' });
  assert.throws(() => sink.save({ data: 'a'.repeat(262144) }), { code: 'checkpoint' });
  sink.close();
});

/** A rejected provider operation is terminal; the runner discards exception text and never retries. */
test.each(['provider_status', 'existing_auth_unavailable', 'metadata_limit', 'transport'])('stops once on %s', async (code) => {
  const h = harness(); let attempts = 0;
  h.deps.provider = async () => { attempts++; throw Object.assign(new Error(SECRET), { code }); };
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.failure, code); assert.equal(attempts, 1); assert.equal(report.applicationAttempts, 0);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

/** Parent cancellation kills an unfinished child and clears its deadline instead of permitting a later dispatch. */
test('cancels a provider child and ignores late receipts', async () => {
  const controller = new AbortController(); let childRef;
  const pending = runner.readProvider('alias_before', TARGET.deploymentId, 1000, controller.signal, () => {},
    fakeFork((child) => { childRef = child; controller.abort(); child.emit('message', receipt()); child.emit('close', 0); }));
  await assert.rejects(pending, { code: 'child_timeout' }); assert.equal(childRef.killed, true);
});

/** Hashing both historical evidence and source pins must happen before any live effects are enabled. */
test('changed preserved runtime evidence blocks preparation', () => {
  const read = fs.readFileSync;
  const pinned = path.join(provider.ROOT, Object.keys(runner.LOCAL_PINS)[0]);
  mocks.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => file === pinned ? Buffer.from('changed') : read(file, ...args));
  assert.throws(() => runner.preparation(), { code: 'dependency_changed' });
});

/** Real offline preparation validates the source inventory and pins without creating the live evidence directory. */
test('preparation yields a stable four-file digest and source-only inventory', () => {
  const before = fs.existsSync(path.join(provider.ROOT, runner.PROFILE.evidenceDirectory));
  const a = runner.preparation(), b = runner.preparation();
  assert.equal(a.packageDigest, b.packageDigest); assert.equal(Object.keys(a.components).length, 4);
  assert.deepEqual(a.sourceInventory.routes, [...provider.ROUTES].sort());
  assert.equal(a.sourceInventory.currentLocalNextExists, false);
  assert.equal(a.sourceInventory.currentLocalBuildOutputExists, false);
  assert.equal(fs.existsSync(path.join(provider.ROOT, runner.PROFILE.evidenceDirectory)), before);
  assert.equal(a.profile.runtimeEvidence.nodeVersion, 'v22.23.5');
});
