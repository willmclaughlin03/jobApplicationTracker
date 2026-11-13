'use strict';
/* global __dirname, Buffer, AbortController, Response, setImmediate, setTimeout, clearTimeout */

/** Offline orchestration, persistence and child-protocol tests. No evidence files or provider calls are made. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const runner = require('../identify-redeployment.cjs');
const provider = require('../provider-read-child.cjs');
const DEPLOYMENT = 'dpl_SyntheticReplacement';
const SHA = 'f3c62a4d221fa39e920c0b5faecb61f1add7bab4';
const MANIFEST = { packageDigest: 'a'.repeat(64) };
const BUILD = 'synthetic-new-build';

/** Create already projected metadata so sequence tests are independent of the child projection implementation. */
function metadata(phase) {
  if (phase.startsWith('alias_')) return { hostname: provider.TARGET.hostname, projectId: provider.TARGET.projectId,
    deploymentId: DEPLOYMENT, updatedAt: 1794600000000 };
  if (phase === 'deployment') return { deploymentId: DEPLOYMENT, projectId: provider.TARGET.projectId,
    immutableHostname: 'job-application-tracker-synthetic-track-the-app.vercel.app', target: 'production', readyState: 'READY',
    gitSha: SHA, createdAt: 1794599900000, readyAt: 1794599990000, canonicalAliasListed: true, configuredNodeMajor: '22.x' };
  return { projectId: provider.TARGET.projectId, teamId: provider.TARGET.teamId,
    currentProductionDeploymentId: DEPLOYMENT, autoAssignCustomDomains: true,
    lastRoutingJob: { status: 'succeeded', type: 'promote', requestedAt: 1794599900000 },
    configuredNodeMajor: '24.x', protection: 'all_except_custom_domains', rollingReleaseConfigured: false };
}

/** Generate one valid Next login response, using the real strict parser in all sequence tests. */
function loginResponse(build = BUILD) {
  return { status: 200, headers: { 'content-type': 'text/html' },
    text: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ page: '/login', buildId: build })}</script>` };
}

/** Assemble fake transports and immutable checkpoint snapshots with optional fault injection. */
function harness(options = {}) {
  const calls = [], saves = [];
  const deps = { loginBuild: runner.reviewedLogin().loginBuild,
    now: options.now || (() => 0),
    save: (report) => { if (options.saveFailure?.(report)) throw new Error('private disk failure');
      saves.push(JSON.parse(JSON.stringify(report))); },
    provider: async (phase, deploymentId, timeout, signal, onDispatch) => {
      calls.push(phase); onDispatch();
      if (options.failurePhase === phase) throw new provider.ReadError('provider_status');
      const value = metadata(phase); options.mutate?.(phase, value); return value;
    },
    login: async () => { calls.push('login'); return options.login || loginResponse(); },
  };
  return { calls, saves, deps };
}

test('exact five-operation sequence identifies source/build and preserves unpassed gates', async () => {
  const h = harness();
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.result, 'identified');
  assert.deepEqual(h.calls, ['alias_before', 'deployment', 'project', 'login', 'alias_after']);
  assert.equal(report.providerAttempts, 4);
  assert.equal(report.providerDispatchAnnouncements, 4);
  assert.equal(report.applicationAttempts, 1);
  assert.equal(report.candidate.buildId, BUILD);
  assert.equal(report.candidate.gitSha, SHA);
  assert.equal(report.gate1Status, 'open');
  assert.equal(report.gate5aStatus, 'unpassed');
  assert.equal(report.runtimeProbeExecuted, false);
  assert.equal(report.mode, 'offline_fixture');
});

for (const [label, phase, field, value, expected, callCount] of [
  ['unchanged deployment', 'alias_before', 'deploymentId', runner.PROFILE.previousDeploymentId, 'deployment_not_replaced', 1],
  ['old alias timestamp', 'alias_before', 'updatedAt', 1794442548053, 'deployment_not_replaced', 1],
  ['changed source', 'deployment', 'gitSha', 'b'.repeat(40), 'source_mismatch', 2],
  ['wrong deployment ID', 'deployment', 'deploymentId', 'dpl_Other', 'identity_mismatch', 2],
  ['wrong production ID', 'project', 'currentProductionDeploymentId', 'dpl_Other', 'identity_mismatch', 3],
  ['rolling release', 'project', 'rollingReleaseConfigured', true, 'routing_unsettled', 3],
  ['alias drift', 'alias_after', 'updatedAt', 1794600000001, 'alias_drift', 5],
]) {
  test(`stops on ${label} and preserves completed observations`, async () => {
    const h = harness({ mutate: (current, row) => { if (current === phase) row[field] = value; } });
    const report = await runner.runWithAdapters(MANIFEST, h.deps);
    assert.equal(report.result, 'stopped');
    assert.equal(report.failure, expected);
    assert.equal(h.calls.length, callCount);
    assert.ok(report.observations.some((row) => row.phase === phase));
    assert.equal(report.candidate, undefined);
  });
}

for (const phase of ['alias_before', 'deployment', 'project', 'alias_after']) {
  test(`stops without replay after ${phase} transport failure`, async () => {
    const h = harness({ failurePhase: phase });
    const report = await runner.runWithAdapters(MANIFEST, h.deps);
    assert.equal(report.failure, 'provider_status');
    assert.equal(h.calls.filter((value) => value === phase).length, 1);
    assert.equal(h.calls.at(-1), phase);
  });
}

test('pending routing stops before application traffic', async () => {
  const h = harness({ mutate: (phase, value) => { if (phase === 'project') value.lastRoutingJob.status = 'pending'; } });
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.failure, 'routing_unsettled');
  assert.equal(report.applicationAttempts, 0);
});

test('checkpoint failure stops before the first provider child', async () => {
  const h = harness({ saveFailure: () => true });
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.failure, 'checkpoint');
  assert.deepEqual(h.calls, []);
});

test('checkpoint failure between requests prevents all later traffic', async () => {
  const h = harness({ saveFailure: (report) => report.observations.length === 1 });
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.failure, 'checkpoint');
  assert.deepEqual(h.calls, ['alias_before']);
});

test('overall deadline stops before any traffic and discards arbitrary errors', async () => {
  let clock = 0;
  const h = harness({ now: () => { clock += 120001; return clock; } });
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.failure, 'overall_deadline');
  assert.deepEqual(h.calls, []);
  assert.equal(runner.failureCode(new Error('private token')), 'internal');
});

for (const [label, login] of [
  ['wrong page', { ...loginResponse(), text: loginResponse().text.replace('/login', '/dashboard') }],
  ['redirect', { ...loginResponse(), status: 302 }],
  ['duplicate build records', { ...loginResponse(), text: loginResponse().text.repeat(2) }],
  ['non HTML', { ...loginResponse(), headers: { 'content-type': 'application/json' } }],
]) {
  test(`rejects ${label} without the final provider read`, async () => {
    const h = harness({ login });
    const report = await runner.runWithAdapters(MANIFEST, h.deps);
    assert.equal(report.failure, 'login_contract');
    assert.equal(h.calls.at(-1), 'login');
  });
}

test('real login transport sends one canonical anonymous request and retains no response cookies', async () => {
  let calls = 0;
  const transport = runner.reviewedLogin();
  const result = await transport.login(new AbortController().signal, 10000, async (url, init) => {
    calls++;
    assert.equal(url, `https://${provider.TARGET.hostname}/login`);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers.Cookie, undefined);
    return new Response(loginResponse().text, { headers: { 'content-type': 'text/html', 'set-cookie': 'synthetic=private' } });
  });
  assert.equal(calls, 1);
  assert.equal(transport.loginBuild(result), BUILD);
  assert.ok(!JSON.stringify(result).includes('synthetic=private'));
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
    ftruncateSync() {}, writeSync(fd, bytes, offset, length) { data.push(bytes.toString()); return length; },
    fsyncSync() {}, closeSync() {},
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

/** Exercise the real main/reserve recovery flow with in-memory I/O and no provider or CLI execution. */
async function recovery(io, args = ['--execute', MANIFEST.packageDigest]) {
  const output = [];
  let runs = 0;
  const runtime = { __dirname: path.resolve(__dirname, '..'), Buffer, AbortController, setTimeout, clearTimeout,
    module: { exports: {} }, manifest: MANIFEST,
    process: { stdout: { write: (text) => output.push(JSON.parse(text)) } },
    /** Substitute only filesystem and provider-module imports; all evidence writes stay in memory. */
    require(name) {
      if (name === 'node:fs') return io;
      if (name === './provider-read-child.cjs') return provider;
      return require(name);
    },
    /** Record any execution after reserve returns and force the outer recovery path without traffic. */
    run() { runs++; throw new Error('synthetic execution failure'); },
  };
  const source = fs.readFileSync(path.join(__dirname, '../identify-redeployment.cjs'), 'utf8');
  const main = vm.runInNewContext(source + '\npreparation = () => manifest; verifySource = () => {};'
    + ' reviewedLogin = () => ({}); runWithAdapters = run; main;', runtime);
  const exitCode = await main(args);
  return { exitCode, report: output.at(-1), runs };
}

for (const [label, existing, failAt, expected, evidenceMayExist, writes, runs] of [
  ['existing reservation', true, null, 'evidence_exists', true, 0, 0],
  ['competing reservation', false, 'race', 'evidence_exists', true, 0, 0],
  ['directory creation failure', false, 'mkdir', 'checkpoint', false, 0, 0],
  ['profile write failure', false, 'profile.json', 'checkpoint', true, 1, 0],
  ['reservation write failure', false, 'reservation.json', 'checkpoint', true, 2, 0],
  ['report creation failure', false, 'report.json', 'checkpoint', true, 3, 0],
  ['failure after reserve returns', false, null, 'internal', true, 3, 1],
]) {
  test(`recovery reports evidence presence after ${label}`, async () => {
    const io = fakeIo(existing, failAt);
    const result = await recovery(io);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.failure, expected);
    assert.equal(result.report.evidenceMayExist, evidenceMayExist);
    assert.equal(io.writes.length, writes);
    assert.equal(result.runs, runs);
  });
}

for (const existing of [false, true]) {
  test(`recovery checks existing evidence (${existing}) before argument validation`, async () => {
    const io = fakeIo(existing);
    const result = await recovery(io, ['--invalid']);
    assert.equal(result.report.failure, 'arguments');
    assert.equal(result.report.evidenceMayExist, existing);
    assert.equal(io.writes.length, 0);
    assert.equal(result.runs, 0);
  });
}

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
  const value = await runner.readProvider('alias_before', null, 1000, new AbortController().signal,
    () => { dispatched++; }, fakeFork((child) => {
      child.emit('message', { type: 'dispatch' }); child.emit('message', receipt()); child.emit('close', 0);
    }));
  assert.equal(dispatched, 1);
  assert.deepEqual(value, metadata('alias_before'));
});

test('failed child preserves bounded status/exit accounting without raw response fields', async () => {
  await assert.rejects(runner.readProvider('alias_before', null, 1000, new AbortController().signal,
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
    await assert.rejects(runner.readProvider('alias_before', null, 20, new AbortController().signal,
      () => {}, fakeFork(actions)), { code });
  });
}

test('preparation verifies pins and computes a repeatable digest without evidence creation', () => {
  const first = runner.preparation(), second = runner.preparation();
  assert.match(first.packageDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.packageDigest, second.packageDigest);
  assert.equal(Object.keys(first.components).length, 4);
  assert.equal(first.reviewWorkspace, provider.ROOT);
  assert.equal(first.validatorEntry, require.resolve(path.join(provider.ROOT, 'node_modules/zod/index.cjs')));
  assert.equal(first.validatorEntry, provider.ZOD_ENTRY);
  assert.equal(first.localDependencies[provider.ZOD_PIN.file], runner.hash(fs.readFileSync(first.validatorEntry)));
  assert.equal(first.profile.ownerAttestations.onlyChangedSetting, 'GATE1_RESTART_PROBE_SECRET');
});
