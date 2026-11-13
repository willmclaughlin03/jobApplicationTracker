'use strict';
/* global __dirname, process, Buffer, Response, ReadableStream, Headers, AbortController, setTimeout, clearTimeout */

/** Offline transport/auth/privacy tests. Every response and credential in this file is synthetic. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const child = require('../provider-read-child.cjs');
const { TARGET, LIMITS, operation, projectMetadata, createGuard, installClientGuards } = child;
const DEPLOYMENT = 'dpl_SyntheticReplacement';
const SHA = 'f3c62a4d221fa39e920c0b5faecb61f1add7bab4';
const SECRET_SENTINEL = 'synthetic-private-value-never-retain';

/** Return independently shaped provider responses, including private fields that must be omitted. */
function fixture(phase) {
  if (phase.startsWith('alias_')) return { alias: TARGET.hostname, projectId: TARGET.projectId,
    deploymentId: DEPLOYMENT, updatedAt: 1794600000000, deployment: { id: DEPLOYMENT },
    protectionBypass: SECRET_SENTINEL, creator: { email: SECRET_SENTINEL } };
  if (phase === 'deployment') return { id: DEPLOYMENT, projectId: TARGET.projectId,
    url: 'job-application-tracker-synthetic-track-the-app.vercel.app', target: 'production', readyState: 'READY',
    meta: { githubCommitSha: SHA, other: SECRET_SENTINEL }, gitSource: { sha: SHA },
    createdAt: 1794599900000, ready: 1794599990000, alias: [TARGET.hostname],
    projectSettings: { nodeVersion: '22.x' }, env: { secret: SECRET_SENTINEL } };
  return { id: TARGET.projectId, accountId: TARGET.teamId, targets: { production: { id: DEPLOYMENT } },
    autoAssignCustomDomains: true, lastAliasRequest: { jobStatus: 'succeeded', type: 'promote', requestedAt: 1794599900000 },
    nodeVersion: '24.x', ssoProtection: { deploymentType: 'all_except_custom_domains' }, rollingRelease: null,
    env: [{ value: SECRET_SENTINEL }], owner: { email: SECRET_SENTINEL } };
}

/** Create one response whose stream can be safely consumed by the real guard. */
function response(value, init = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

for (const phase of ['alias_before', 'deployment', 'project', 'alias_after']) {
  test(`projects only safe ${phase} fields`, () => {
    const safe = projectMetadata(phase, fixture(phase));
    assert.ok(!JSON.stringify(safe).includes(SECRET_SENTINEL));
    assert.deepEqual(child.validateMetadata(phase, safe), safe);
  });
}

test('binds all operation URLs to project/team and rejects path injection', () => {
  assert.equal(operation({ phase: 'deployment', deploymentId: DEPLOYMENT }), `/v13/deployments/${DEPLOYMENT}?teamId=${TARGET.teamId}`);
  assert.throws(() => operation({ phase: 'deployment', deploymentId: 'dpl_x?teamId=other' }), { code: 'arguments' });
  assert.throws(() => operation({ phase: 'other', deploymentId: null }), { code: 'arguments' });
});

for (const [label, phase, mutate] of [
  ['wrong project', 'alias_before', (raw) => { raw.projectId = 'prj_other'; }],
  ['wrong hostname', 'alias_before', (raw) => { raw.alias = 'other.vercel.app'; }],
  ['conflicting alias IDs', 'alias_before', (raw) => { raw.deployment.id = 'dpl_Other'; }],
  ['timestamp coercion', 'alias_before', (raw) => { raw.updatedAt = '1794600000000'; }],
  ['conflicting source', 'deployment', (raw) => { raw.gitSource.sha = 'a'.repeat(40); }],
  ['missing source', 'deployment', (raw) => { delete raw.meta; delete raw.gitSource; }],
  ['preview target', 'deployment', (raw) => { raw.target = 'preview'; }],
  ['unready target', 'deployment', (raw) => { raw.readyState = 'BUILDING'; }],
  ['missing canonical alias', 'deployment', (raw) => { raw.alias = []; }],
  ['wrong team', 'project', (raw) => { raw.accountId = 'team_other'; }],
  ['missing current target', 'project', (raw) => { delete raw.targets; }],
  ['missing auto assignment', 'project', (raw) => { delete raw.autoAssignCustomDomains; }],
]) {
  test(`rejects ${label}`, () => {
    const raw = fixture(phase); mutate(raw);
    assert.throws(() => projectMetadata(phase, raw), { code: 'provider_schema' });
  });
}

test('one dispatch uses manual redirects and produces a sanitized replacement response', async () => {
  const events = [];
  let calls = 0;
  const guard = createGuard({ phase: 'alias_before', deploymentId: null }, async (url, options) => {
    calls++;
    assert.equal(url, `https://api.vercel.com${guard.endpoint}`);
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal);
    return response(fixture('alias_before'));
  }, (event) => events.push(event));
  const result = await guard.fetch(`https://api.vercel.com${guard.endpoint}`);
  assert.equal(calls, 1);
  assert.deepEqual(events, [{ type: 'dispatch' }]);
  assert.ok(!(await result.text()).includes(SECRET_SENTINEL));
  await assert.rejects(guard.fetch(`https://api.vercel.com${guard.endpoint}`), { code: 'request_budget' });
  assert.equal(calls, 1);
});

for (const [label, url, options] of [
  ['other origin', 'https://example.com', {}],
  ['other endpoint', 'https://api.vercel.com/v2/user', {}],
  ['mutation', null, { method: 'POST' }],
  ['body', null, { body: '{}' }],
  ['cookie', null, { headers: { cookie: SECRET_SENTINEL } }],
]) {
  test(`blocks ${label} before transport`, async () => {
    let calls = 0;
    const guard = createGuard({ phase: 'alias_before', deploymentId: null }, async () => { calls++; });
    await assert.rejects(guard.fetch(url || `https://api.vercel.com${guard.endpoint}`, options), { code: 'request_not_allowed' });
    assert.equal(calls, 0);
  });
}

for (const status of [302, 401, 403, 429, 500]) {
  test(`stops HTTP ${status} with no retry or retained error body`, async () => {
    let calls = 0;
    const guard = createGuard({ phase: 'alias_before', deploymentId: null }, async () => {
      calls++; return response({ error: SECRET_SENTINEL }, { status });
    });
    await assert.rejects(guard.fetch(`https://api.vercel.com${guard.endpoint}`), { code: 'provider_status' });
    assert.equal(calls, 1);
    assert.equal(guard.state.metadata, null);
    assert.ok(!JSON.stringify(guard.state).includes(SECRET_SENTINEL));
  });
}

for (const [label, makeResponse, code] of [
  ['invalid JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } }), 'provider_schema'],
  ['wrong MIME', () => response({}, { headers: { 'content-type': 'text/html' } }), 'response_headers'],
  ['oversized headers', () => response({}, { headers: { 'content-type': 'application/json', 'x-large': 'a'.repeat(17000) } }), 'response_headers'],
  ['oversized declared body', () => response({}, { headers: { 'content-type': 'application/json', 'content-length': String(LIMITS.responseBytes + 1) } }), 'response_size'],
  ['oversized streamed body', () => response('a'.repeat(LIMITS.responseBytes + 1)), 'response_size'],
]) {
  test(`stops ${label}`, async () => {
    const guard = createGuard({ phase: 'alias_before', deploymentId: null }, async () => makeResponse());
    await assert.rejects(guard.fetch(`https://api.vercel.com${guard.endpoint}`), { code });
  });
}

test('times out stalled response bodies and cancels the reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const guard = createGuard({ phase: 'alias_before', deploymentId: null }, async () => new Response(stream,
    { headers: { 'content-type': 'application/json' } }), () => {}, 10);
  await assert.rejects(guard.fetch(`https://api.vercel.com${guard.endpoint}`), { code: 'request_timeout' });
  assert.equal(cancelled, true);
});

test('times out stalled headers even when the mocked transport ignores abort', async () => {
  const guard = createGuard({ phase: 'alias_before', deploymentId: null }, () => new Promise(() => {}), () => {}, 10);
  await assert.rejects(guard.fetch(`https://api.vercel.com${guard.endpoint}`), { code: 'request_timeout' });
  assert.equal(guard.state.nativeFetchCalls, 1);
  assert.equal(guard.state.metadata, null);
});

test('dispatch notification failure sends no network request and clears its timer', async () => {
  let calls = 0;
  const guard = createGuard({ phase: 'alias_before', deploymentId: null }, async () => { calls++; },
    () => { throw new Error('private IPC error'); }, 10);
  await assert.rejects(guard.fetch(`https://api.vercel.com${guard.endpoint}`), { code: 'transport' });
  assert.equal(calls, 0);
  assert.equal(guard.state.nativeFetchCalls, 0);
});

test('guarded CLI auth never refreshes an unavailable session', async () => {
  let authChecks = 0, transportCalls = 0;
  /** Model the CLI method that invokes its managed authorization check before dispatch. */
  class Client {
    /** Supply synthetic managed authorization state only. */
    constructor() { this.authConfig = { valid: false }; }
    /** Exercise the installed authorization guard before the fake transport. */
    async _fetch() { await this.ensureAuthorized(); transportCalls++; }
  }
  const guard = createGuard({ phase: 'alias_before', deploymentId: null }, async () => {});
  installClientGuards(Client, (config) => { authChecks++; return config.valid; }, guard);
  await assert.rejects(new Client().fetch(guard.endpoint), { code: 'existing_auth_unavailable' });
  assert.equal(authChecks, 1);
  assert.equal(transportCalls, 0);
});

test('CLI user lookup is suppressed without consuming the approved read', async () => {
  /** Minimal fake Client for the command adapter contract. */
  class Client {
    /** Return a safe fake response without performing network I/O. */
    async _fetch(url, options) { assert.equal(options.useCurrentTeam, false); return response({ safe: true }); }
  }
  const guard = createGuard({ phase: 'alias_before', deploymentId: null }, async () => {});
  installClientGuards(Client, () => true, guard);
  const client = new Client();
  await assert.rejects(client.fetch('/v2/user'), { code: 'request_not_allowed' });
  assert.equal(guard.state.failure, null);
  assert.deepEqual(await client.fetch(guard.endpoint), { safe: true });
  await assert.rejects(client.fetch(guard.endpoint), { code: 'request_budget' });
});

test('child environment excludes credentials, proxies, debugging and injected Node options', () => {
  const env = child.childEnvironment({ SystemRoot: 'C:/Windows', Path: 'synthetic-path', USERPROFILE: 'synthetic-home',
    VERCEL_TOKEN: SECRET_SENTINEL, GATE1_RESTART_PROBE_SECRET: SECRET_SENTINEL,
    NODE_OPTIONS: SECRET_SENTINEL, NODE_PATH: SECRET_SENTINEL, Node_Path: SECRET_SENTINEL,
    HTTPS_PROXY: SECRET_SENTINEL, DEBUG: SECRET_SENTINEL });
  assert.equal(env.PATH, 'synthetic-path');
  assert.ok(!JSON.stringify(env).includes(SECRET_SENTINEL));
  assert.equal(env.VERCEL_TELEMETRY_DISABLED, '1');
  assert.equal(env.NO_UPDATE_NOTIFIER, '1');
  assert.equal(env.GATE1_REVIEW_WORKSPACE, child.ROOT);
  assert.equal(env.GATE1_VERCEL_CLI_DIST, child.CLI);
  assert.equal(env.NODE_PATH, path.join(child.ROOT, 'node_modules'));
  assert.equal(env.TEMP, env.TMP);
});

test('both runners use workspace Zod despite conflicting checkout resolution or cwd', () => {
  // Compile the unchanged worker at a virtual external path; no external files or CLI imports are needed.
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const filename = path.join(path.parse(process.argv[1]).root,
      '__gate1_external_checkout__', 'scripts', 'gate1-rollback-tools', 'provider-read-child.cjs');
    const worker = new Module(filename);
    worker.filename = filename;
    worker.paths = [];
    const loadWorker = worker.require.bind(worker);
    /** Simulate a checkout-local Zod copy that must never be selected. */
    worker.require = function loadDependency(name) {
      assert.notEqual(name, 'zod', 'worker selected checkout-local Zod');
      return loadWorker(name);
    };
    worker._compile(fs.readFileSync(process.argv[1], 'utf8'), filename);
    const approvedEntry = require.resolve(path.join(worker.exports.ROOT, 'node_modules', 'zod', 'index.cjs'));
    assert.equal(worker.exports.ZOD_ENTRY, approvedEntry);
    assert.equal(worker.exports.z, require(approvedEntry).z);
    assert.ok(worker.exports.operation({ phase: 'alias_before', deploymentId: null }).startsWith('/v4/aliases/'));
    const parentFilename = path.join(path.dirname(filename), 'identify-redeployment.cjs');
    const parent = new Module(parentFilename);
    parent.filename = parentFilename;
    parent.paths = [];
    const loadParent = parent.require.bind(parent);
    /** Keep the parent on the same provider module and reject any independent bare Zod lookup. */
    parent.require = function loadDependency(name) {
      if (name === './provider-read-child.cjs') return worker.exports;
      assert.notEqual(name, 'zod', 'parent selected checkout-local Zod');
      return loadParent(name);
    };
    parent._compile(fs.readFileSync(process.argv[2], 'utf8'), parentFilename);
    assert.equal(parent.exports.LOCAL_PINS[worker.exports.ZOD_PIN.file], worker.exports.ZOD_PIN.sha256);
  `;
  for (const cwd of [child.ROOT, path.dirname(process.execPath)]) {
    execFileSync(process.execPath, ['-e', script, path.resolve(__dirname, '../provider-read-child.cjs'),
      path.resolve(__dirname, '../identify-redeployment.cjs')], {
      cwd, env: child.childEnvironment(), windowsHide: true, timeout: 10000, stdio: 'pipe',
    });
  }
});

test('dependency drift fails without reading auth or dispatching', () => {
  assert.throws(() => child.verifyPins(() => Buffer.from('changed')), { code: 'dependency_changed' });
});

test('worker pin verification rejects drift in the Zod entry it actually loaded', () => {
  assert.throws(() => child.verifyPins((file) => file === child.ZOD_ENTRY
    ? Buffer.from('changed validator') : fs.readFileSync(file)), { code: 'dependency_changed' });
});

/** Run the private entry point with synthetic CLI imports, transport and IPC; isolate process mutations. */
async function runMain({ stream = 'stdout', outputBytes = LIMITS.outputBytes + 1, cliExitCode = 0,
  guardFailure = false, cliReject = false } = {}) {
  const events = [];
  const runtime = { Buffer, Response, Headers, AbortController, setTimeout, clearTimeout,
    __dirname: path.resolve(__dirname, '..'), module: { exports: {} },
    process: { env: { GATE1_REVIEW_WORKSPACE: child.ROOT }, execPath: 'synthetic-node', stdout: {}, stderr: {},
      /** Capture only synthetic IPC events and acknowledge the final receipt. */
      send(event, callback) { events.push(event); callback?.(); } },
    /** Supply a valid provider response without making a network request. */
    fetch: async () => response(fixture('alias_before')),
    /** Stub mutable Node transports so installing guards cannot affect the test runner. */
    require(name) {
      if (name === 'node:http' || name === 'node:https') return {};
      if (name === 'node:module') return { syncBuiltinESMExports() {} };
      return require(name);
    },
  };
  runtime.require.resolve = require.resolve;
  /** Exercise the real CLI adapter and fetch guards with synthetic authorization. */
  class Client {
    /** Route the mock CLI request through the installed authorization and native-fetch guards. */
    async _fetch(url, options) {
      await this.ensureAuthorized();
      return runtime.fetch(`https://api.vercel.com${url}`, options);
    }
  }
  /** Model a CLI that catches output errors before resolving or rejecting its exit-code promise. */
  runtime.importCli = async function importCli(url) {
    if (url.endsWith('/chunks/chunk-DECIQZZQ.js')) return { Client, isValidAccessToken: () => true };
    assert.ok(url.endsWith('/index.js'));
    const client = new Client();
    await client.fetch(runtime.process.argv[3]);
    try { runtime.process[stream].write(Buffer.alloc(outputBytes)); }
    catch (error) { assert.equal(error.code, 'output_limit'); }
    if (guardFailure) await assert.rejects(client.fetch(runtime.process.argv[3]), { code: 'request_budget' });
    return { cliPromise: cliReject ? Promise.reject(new Error('synthetic CLI failure')) : Promise.resolve(cliExitCode) };
  };
  const source = fs.readFileSync(path.join(__dirname, '../provider-read-child.cjs'), 'utf8');
  // Replace only external CLI loading/pin checks in the isolated copy; execute the real main and guards.
  const main = vm.runInNewContext(source.replaceAll('await import(', 'await importCli(')
    + '\nverifyPins = () => {}; main;', runtime);
  const exitCode = await main(['--read', 'alias_before', '-']);
  return { exitCode, receipt: events.at(-1) };
}

for (const [label, options] of [
  ['stdout with a successful CLI exit', {}],
  ['stderr with a successful CLI exit', { stream: 'stderr' }],
  ['a failed CLI exit', { cliExitCode: 1 }],
  ['a subsequent guard failure', { guardFailure: true }],
  ['a CLI promise rejection', { cliReject: true }],
  ['a subsequent guard failure and CLI promise rejection', { guardFailure: true, cliReject: true }],
]) {
  test(`preserves output_limit after ${label}`, async () => {
    const { exitCode, receipt } = await runMain(options);
    assert.equal(exitCode, 1);
    assert.equal(receipt.type, 'receipt');
    assert.equal(receipt.result, 'stopped');
    assert.equal(receipt.failure, 'output_limit');
    assert.equal(receipt.metadata, null);
    assert.equal(receipt.cliExitCode, options.cliReject ? null : options.cliExitCode ?? 0);
    assert.equal(receipt.nativeFetchCalls, 1);
    assert.equal(receipt.adapterCalls, 1);
  });
}

test('accepts successful CLI output at the exact discard limit', async () => {
  const { exitCode, receipt } = await runMain({ outputBytes: LIMITS.outputBytes });
  assert.equal(exitCode, 0);
  assert.equal(receipt.result, 'read');
  assert.equal(receipt.failure, null);
  assert.equal(receipt.metadata.deploymentId, DEPLOYMENT);
});

module.exports = { fixture, DEPLOYMENT };
