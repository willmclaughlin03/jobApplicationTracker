'use strict';
/* global __dirname, Buffer, Response, ReadableStream, Headers, AbortController, setTimeout, clearTimeout */
/** Mocked boundary tests: no provider CLI import, credential read or live network call is used. */
const { test } = require('@jest/globals');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const child = require('../provider-read-child.cjs');
const { TARGET, LIMITS, operation, projectMetadata, createGuard, installClientGuards } = child;
const DEPLOYMENT = TARGET.deploymentId;
const SECRET_SENTINEL = 'synthetic-private-value-never-retain';

/** Model independently shaped raw API responses and private fields; projection must remove the sentinel. */
function fixture(phase) {
  if (phase.startsWith('alias_')) return { alias: TARGET.hostname, projectId: TARGET.projectId,
    deploymentId: DEPLOYMENT, updatedAt: TARGET.aliasUpdatedAt, deployment: { id: DEPLOYMENT }, secret: SECRET_SENTINEL };
  if (phase === 'deployment') return { id: DEPLOYMENT, projectId: TARGET.projectId, url: TARGET.immutableHostname,
    target: 'production', readyState: 'READY', meta: { githubCommitSha: TARGET.gitSha }, gitSource: { sha: TARGET.gitSha },
    createdAt: 1794594200000, ready: 1794594300000, alias: [TARGET.hostname], version: 2,
    team: { id: TARGET.teamId }, projectSettings: { nodeVersion: '24.x', framework: 'nextjs' },
    routes: [{ src: SECRET_SENTINEL, dest: '/login', headers: { private: SECRET_SENTINEL } }], env: { private: SECRET_SENTINEL } };
  if (phase === 'builds') return { deploymentId: DEPLOYMENT, builds: [{ id: SECRET_SENTINEL, entrypoint: 'package.json',
    output: [{ type: 'lambda', path: 'api/auth/session', size: 2048, lambda: { runtime: 'nodejs22.x', secret: SECRET_SENTINEL } },
      { type: 'file', path: '/login', size: 512 }, { type: 'file', path: SECRET_SENTINEL }] }] };
  return [{ type: 'stdout', payload: { deploymentId: DEPLOYMENT, text: 'Detected Next.js version: 16.3.3\nVercel CLI 62.2.0\n┌ ƒ /login\n' + SECRET_SENTINEL } },
    { type: 'command', payload: { text: 'Node.js v24.1.0', secret: SECRET_SENTINEL } }];
}

/** Construct a mocked application/json response consumed by the real bounded stream guard. */
function response(value, init = {}) { return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init }); }

/** Verify each phase's projection is strict and never retains arbitrary provider payloads. */
test.each(['alias_before', 'deployment', 'builds', 'events', 'alias_after'])('projects only safe %s fields', (phase) => {
  const safe = projectMetadata(phase, fixture(phase));
  assert.ok(!JSON.stringify(safe).includes(SECRET_SENTINEL));
  assert.deepEqual(child.validateMetadata(phase, safe), safe);
  assert.throws(() => child.validateMetadata(phase, { ...safe, extra: SECRET_SENTINEL }), { code: 'provider_schema' });
});

/** Exact endpoints cannot accept a different target, phase, team, method, time scope or unlimited event limit. */
test('pins five operations to one deployment with finite nonstreaming events', () => {
  assert.equal(operation({ phase: 'builds', deploymentId: DEPLOYMENT }), `/v11/deployments/${DEPLOYMENT}/builds?teamId=${TARGET.teamId}`);
  assert.ok(operation({ phase: 'events', deploymentId: DEPLOYMENT }).endsWith('&follow=0&limit=500&direction=forward&builds=1&delimiter=0'));
  for (const input of [{ phase: 'project', deploymentId: DEPLOYMENT }, { phase: 'deployment', deploymentId: null },
    { phase: 'events', deploymentId: 'dpl_other' }, { phase: 'events', deploymentId: DEPLOYMENT, follow: 1 }]) {
    assert.throws(() => operation(input), { code: 'arguments' });
  }
});

/** Conflicting identity and invalid metadata must stop rather than being converted into a missing fact. */
test.each([
  ['wrong project', 'deployment', (raw) => { raw.projectId = 'prj_other'; }, 'provider_schema'],
  ['wrong team', 'deployment', (raw) => { raw.team.id = 'team_other'; }, 'attribution_conflict'],
  ['wrong deployment', 'deployment', (raw) => { raw.id = 'dpl_other'; }, 'attribution_conflict'],
  ['wrong source', 'deployment', (raw) => { raw.meta.githubCommitSha = 'a'.repeat(40); }, 'provider_schema'],
  ['wrong immutable host', 'deployment', (raw) => { raw.url = 'job-application-tracker-other.vercel.app'; }, 'attribution_conflict'],
  ['unready', 'deployment', (raw) => { raw.readyState = 'BUILDING'; }, 'provider_schema'],
  ['preview', 'deployment', (raw) => { raw.target = 'preview'; }, 'provider_schema'],
  ['inverted timestamps', 'deployment', (raw) => { raw.ready = 0; }, 'attribution_conflict'],
  ['wrong event attribution', 'events', (raw) => { raw[0].payload.deploymentId = 'dpl_other'; }, 'attribution_conflict'],
  ['conflicting Node', 'events', (raw) => { raw[0].payload.text = 'Node.js v24.1.0'; }, 'attribution_conflict'],
  ['conflicting Next', 'events', (raw) => { raw[0].payload.text = 'Detected Next.js version: 16.3.4'; }, 'attribution_conflict'],
  ['conflicting npm', 'events', (raw) => { raw[0].payload.text = 'npm 10.1.0\nnpm 10.2.0'; }, 'attribution_conflict'],
  ['conflicting output runtime', 'builds', (raw) => { raw.builds[0].output[0].runtime = 'nodejs24.x'; }, 'attribution_conflict'],
  ['wrong build attribution', 'builds', (raw) => { raw.builds[0].deploymentId = 'dpl_other'; }, 'attribution_conflict'],
  ['event cap', 'events', (raw) => { raw.push(...Array(498).fill({ type: 'command' })); }, 'metadata_limit'],
  ['route cap', 'deployment', (raw) => { raw.routes = Array(1025).fill({}); }, 'metadata_limit'],
  ['output cap', 'builds', (raw) => { raw.builds[0].output = Array(2049).fill({}); }, 'metadata_limit'],
  ['build cap', 'builds', (raw) => { raw.builds = Array(65).fill({}); }, 'metadata_limit'],
  ['pagination', 'builds', (raw) => { raw.pagination = { next: SECRET_SENTINEL }; }, 'metadata_limit'],
  ['text byte cap', 'events', (raw) => { raw[0].payload.text = 'a'.repeat(8193); }, 'metadata_limit'],
  ['nonarray output', 'builds', (raw) => { raw.builds[0].output = {}; }, 'provider_schema'],
  ['ambiguous event text', 'events', (raw) => { raw[0].text = SECRET_SENTINEL; }, 'provider_schema'],
])('%s fails closed', (label, phase, mutate, code) => {
  const raw = fixture(phase); mutate(raw);
  assert.throws(() => projectMetadata(phase, raw), { code });
});

/** Absent tool versions stay absent, regardless of source-lock expectations or version-like secret text. */
test('missing and unrecognized evidence is explicit without leaking raw text', () => {
  const events = projectMetadata('events', [{ type: 'stdout', payload: { text:
    `${SECRET_SENTINEL} npm 10.1.0\nDetected Next.js version: 16.3.3 ${SECRET_SENTINEL}\n┌ ƒ /${SECRET_SENTINEL}` } }]);
  assert.ok(Object.values(events.versions).every((value) => value === null));
  assert.equal(events.unrecognizedRouteRows, 1);
  assert.equal(events.routeTable.length, 0);
  assert.ok(!JSON.stringify(events).includes(SECRET_SENTINEL));
  assert.equal(projectMetadata('builds', {}).available, false);
  assert.equal(projectMetadata('builds', { builds: [{}] }).missingOutputLists, 1);
  const deployment = fixture('deployment'); delete deployment.routes;
  assert.equal(projectMetadata('deployment', deployment).routes.available, false);
});

/** Multiple allowlisted versions must agree; source expected versions do not fill omitted package facts. */
test('retains only exact observed version claims and known route classifications', () => {
  const raw = [{ type: 'stdout', text: 'Node.js version: v22.23.5\nnpm version: 10.9.4\n├── react@18.3.1\n└ ○ /404 123 B 1.2 kB' }];
  const result = projectMetadata('events', raw);
  assert.equal(result.versions.node, '22.23.5'); assert.equal(result.versions.npm, '10.9.4');
  assert.equal(result.versions.react, '18.3.1'); assert.equal(result.versions.sharp, null);
  assert.deepEqual(result.routeTable, [{ route: '/404', rendering: 'static' }]);
});

/** Corrupt IPC counts and repeated function claims cannot manufacture complete or contradictory attribution. */
test.each([
  ['builds', (m) => { m.outputCount++; }],
  ['builds', (m) => { m.available = false; }],
  ['events', (m) => { m.eventCount++; }],
  ['events', (m) => { m.routeTable.push(m.routeTable[0]); }],
  ['deployment', (m) => { m.routes.available = false; }],
  ['deployment', (m) => { m.routes.recognizedDestinations.push('/login'); }],
])('rejects inconsistent projected %s counts', (phase, mutate) => {
  const metadata = projectMetadata(phase, fixture(phase)); mutate(metadata);
  assert.throws(() => child.validateMetadata(phase, metadata), { code: 'provider_schema' });
});

/** A different concrete runtime for the same named function is a conflict, not an omitted fact. */
test('rejects contradictory function outputs without retaining unknown paths', () => {
  const raw = fixture('builds');
  raw.builds[0].output.push({ type: 'lambda', path: '/api/auth/session', lambda: { runtime: 'edge' } });
  assert.throws(() => projectMetadata('builds', raw), { code: 'attribution_conflict' });
});

/** CLI reauthentication and retry adapters stay disabled even after a valid managed login. */
test('valid authorization cannot enable retries or refresh', async () => {
  class Client {
    /** Return a synthetic response through the installed CLI method without networking. */
    async _fetch() { return response({ safe: true }); }
  }
  const guard = createGuard({ phase: 'alias_before', deploymentId: DEPLOYMENT }, async () => {});
  installClientGuards(Client, () => true, guard);
  const client = new Client(); await client.fetch(guard.endpoint);
  await assert.rejects(client.reauthenticate(), { code: 'auth_refresh_disabled' });
  await assert.rejects(client.retry(), { code: 'request_not_allowed' });
});

test('one dispatch uses manual redirects and produces a sanitized replacement response', async () => {
  const events = [];
  let calls = 0;
  const guard = createGuard({ phase: 'alias_before', deploymentId: DEPLOYMENT }, async (url, options) => {
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
    const guard = createGuard({ phase: 'alias_before', deploymentId: DEPLOYMENT }, async () => { calls++; });
    await assert.rejects(guard.fetch(url || `https://api.vercel.com${guard.endpoint}`, options), { code: 'request_not_allowed' });
    assert.equal(calls, 0);
  });
}

for (const status of [302, 401, 403, 429, 500]) {
  test(`stops HTTP ${status} with no retry or retained error body`, async () => {
    let calls = 0;
    const guard = createGuard({ phase: 'alias_before', deploymentId: DEPLOYMENT }, async () => {
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
    const guard = createGuard({ phase: 'alias_before', deploymentId: DEPLOYMENT }, async () => makeResponse());
    await assert.rejects(guard.fetch(`https://api.vercel.com${guard.endpoint}`), { code });
  });
}

test('times out stalled response bodies and cancels the reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const guard = createGuard({ phase: 'alias_before', deploymentId: DEPLOYMENT }, async () => new Response(stream,
    { headers: { 'content-type': 'application/json' } }), () => {}, 10);
  await assert.rejects(guard.fetch(`https://api.vercel.com${guard.endpoint}`), { code: 'request_timeout' });
  assert.equal(cancelled, true);
});

test('times out stalled headers even when the mocked transport ignores abort', async () => {
  const guard = createGuard({ phase: 'alias_before', deploymentId: DEPLOYMENT }, () => new Promise(() => {}), () => {}, 10);
  await assert.rejects(guard.fetch(`https://api.vercel.com${guard.endpoint}`), { code: 'request_timeout' });
  assert.equal(guard.state.nativeFetchCalls, 1);
  assert.equal(guard.state.metadata, null);
});

test('dispatch notification failure sends no network request and clears its timer', async () => {
  let calls = 0;
  const guard = createGuard({ phase: 'alias_before', deploymentId: DEPLOYMENT }, async () => { calls++; },
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
  const guard = createGuard({ phase: 'alias_before', deploymentId: DEPLOYMENT }, async () => {});
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
  const guard = createGuard({ phase: 'alias_before', deploymentId: DEPLOYMENT }, async () => {});
  installClientGuards(Client, () => true, guard);
  const client = new Client();
  await assert.rejects(client.fetch('/v2/user'), { code: 'request_not_allowed' });
  assert.equal(guard.state.failure, null);
  assert.equal(JSON.stringify(await client.fetch(guard.endpoint)), JSON.stringify({ safe: true }));
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
  const exitCode = await main(['--read', 'alias_before', DEPLOYMENT]);
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
