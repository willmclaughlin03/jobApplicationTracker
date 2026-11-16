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


/** Provide a minimal raw build with private extras; all retained diagnosis must discard those extras. */
function fixture() {
  return { deploymentId: DEPLOYMENT, projectId: TARGET.projectId, secret: SECRET_SENTINEL,
    builds: [{ deploymentId: DEPLOYMENT, id: SECRET_SENTINEL,
      output: [{ path: '/api/auth/session', type: 'lambda', size: 2048,
        lambda: { runtime: 'nodejs22.x', secret: SECRET_SENTINEL } }] }] };
}

/** Construct fake bounded JSON without connecting to a provider or loading authorization. */
function response(value, init = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

const cases = [
  ['response_deployment_mismatch', (raw) => { raw.deploymentId = SECRET_SENTINEL; }, []],
  ['response_project_mismatch', (raw) => { raw.projectId = SECRET_SENTINEL; }, []],
  ['build_deployment_mismatch', (raw) => { raw.builds[0].deploymentId = SECRET_SENTINEL; }, []],
  ['output_runtime_fields_disagree', (raw) => { raw.builds[0].output[0].runtime = 'nodejs24.x'; }, [24, 22]],
  ['output_node_runtime_mismatch', (raw) => { raw.builds[0].output[0].lambda.runtime = 'nodejs24.x'; }, [null, 24]],
  ['duplicate_route_runtime_disagrees', (raw) => {
    raw.builds[0].output.push({ path: '/api/auth/session', type: 'lambda', runtime: 'edge', private: SECRET_SENTINEL });
  }, [22, null]],
];

/** Every existing conflict must retain only its fixed reason, bounded majors and explicit evidence limitations. */
test.each(cases)('classifies %s without retaining raw evidence', (reason, mutate, nodeMajors) => {
  const raw = fixture(); mutate(raw);
  const original = require(child.UPSTREAM_FILE);
  assert.throws(() => original.projectMetadata('builds', raw), { code: 'attribution_conflict' });
  const result = projectMetadata('builds', raw);
  const identityReason = reason.endsWith('_mismatch') && !reason.startsWith('output_');
  assert.deepEqual(result, { classification: 'conflict_identified', reason, nodeMajors,
    nodeMajorSlotOrder: identityReason ? 'not_applicable' : reason.startsWith('duplicate_')
      ? 'previous_then_current_projected_runtime' : 'output_runtime_then_lambda_runtime',
    outputClassification: identityReason ? 'not_applicable' : 'known_application_route',
    qualification: 'unqualified_metadata_only', historicalCause: 'not_proven_same_response' });
  assert.ok(!JSON.stringify(result).includes(SECRET_SENTINEL));
  assert.ok(!JSON.stringify(result).includes('/api/auth/session'));
  assert.deepEqual(child.validateMetadata('builds', result), result);
});

/** A new clean or incomplete response cannot explain the consumed failure or qualify any build/runtime. */
test.each([{}, { builds: [] }, { builds: [{}] }, fixture()])('nonconflicting metadata remains inconclusive %#', (raw) => {
  const result = projectMetadata('builds', raw);
  assert.equal(result.classification, 'not_reproduced'); assert.equal(result.reason, null);
  assert.deepEqual(result.nodeMajors, []); assert.equal(result.qualification, 'unqualified_metadata_only');
  assert.equal(result.outputClassification, 'not_applicable'); assert.equal(result.nodeMajorSlotOrder, 'not_applicable');
});

/** Only one immutable-target builds endpoint is available; historical IDs and alternate operations fail locally. */
test('pins exactly one provider operation', () => {
  assert.equal(operation({ phase: 'builds', deploymentId: DEPLOYMENT }),
    '/v11/deployments/' + DEPLOYMENT + '/builds?teamId=' + TARGET.teamId);
  for (const input of [
    ...['alias_before', 'alias_after', 'events', 'deployment', 'project'].map((phase) => ({ phase, deploymentId: DEPLOYMENT })),
    { phase: 'builds', deploymentId: 'dpl_9LmYSk5o8f4EN81ghftV4mEiMCGJ' },
    { phase: 'builds', deploymentId: 'dpl_HqjFQpAagCeJyUpHwQ7ovFrXxUZY' },
    { phase: 'builds', deploymentId: DEPLOYMENT, page: 2 },
  ]) assert.throws(() => operation(input), { code: 'arguments' });
});

/** Nonconflict parser failures retain their original code and cannot turn malformed/capped data into a diagnosis. */
test.each([
  ['build cap', (raw) => { raw.builds = Array(65).fill({}); }, 'metadata_limit'],
  ['output cap', (raw) => { raw.builds[0].output = Array(2049).fill({}); }, 'metadata_limit'],
  ['total output cap', (raw) => { raw.builds = [{ output: Array(1025).fill({}) }, { output: Array(1024).fill({}) }]; }, 'metadata_limit'],
  ['pagination', (raw) => { raw.pagination = { next: SECRET_SENTINEL }; }, 'metadata_limit'],
  ['next page', (raw) => { raw.next = SECRET_SENTINEL; }, 'metadata_limit'],
  ['nonarray builds', (raw) => { raw.builds = {}; }, 'provider_schema'],
  ['nonarray outputs', (raw) => { raw.builds[0].output = {}; }, 'provider_schema'],
  ['invalid size', (raw) => { raw.builds[0].output[0].size = SECRET_SENTINEL; }, 'provider_schema'],
])('%s preserves its terminal failure', (label, mutate, code) => {
  const raw = fixture(); mutate(raw);
  assert.throws(() => projectMetadata('builds', raw), { code });
});

/** Guard precedence is identical to the consumed projector even when several conflicts coexist. */
test('keeps response, output, and duplicate guard precedence', () => {
  const raw = fixture();
  raw.deploymentId = SECRET_SENTINEL; raw.projectId = SECRET_SENTINEL;
  raw.builds[0].deploymentId = SECRET_SENTINEL;
  assert.equal(projectMetadata('builds', raw).reason, 'response_deployment_mismatch');
  delete raw.deploymentId;
  assert.equal(projectMetadata('builds', raw).reason, 'response_project_mismatch');
  delete raw.projectId;
  assert.equal(projectMetadata('builds', raw).reason, 'build_deployment_mismatch');
  delete raw.builds[0].deploymentId;
  raw.builds[0].output.push({ path: '/api/auth/session', type: 'lambda', runtime: 'edge' });
  raw.builds[0].output.push({ path: SECRET_SENTINEL, runtime: 'nodejs20.x' });
  assert.equal(projectMetadata('builds', raw).reason, 'output_node_runtime_mismatch');
});

/** Runtime guards cover unknown paths too, without disclosing either path or unrecognized runtime strings. */
test('conflicting runtime on an unknown path yields only nullable majors', () => {
  const raw = fixture();
  raw.builds[0].output[0] = { path: SECRET_SENTINEL, runtime: SECRET_SENTINEL, lambda: { runtime: 'nodejs22.x' } };
  const result = projectMetadata('builds', raw);
  assert.equal(result.reason, 'output_runtime_fields_disagree');
  assert.deepEqual(result.nodeMajors, [null, 22]);
  assert.equal(result.outputClassification, 'unrecognized_output');
  assert.ok(!JSON.stringify(result).includes(SECRET_SENTINEL));
});

/** The exact old runtime contract remains binding; noncanonical/oversized numeric strings never become retained text. */
test.each([
  ['nodejs022.x', null], ['nodejs9999.x', null],
  ['nodejs0.x', 0], ['nodejs999.x', 999],
])('retains bounded metadata for original conflict %j', (runtime, major) => {
  const raw = fixture(); raw.builds[0].output[0].lambda.runtime = runtime;
  const result = projectMetadata('builds', raw);
  assert.equal(result.reason, 'output_node_runtime_mismatch');
  assert.deepEqual(result.nodeMajors, [null, major]);
});

/** Malformed runtime strings remain unknown under the original grammar and never supply a numeric major. */
test('does not reinterpret malformed Node text as a concrete Node declaration', () => {
  const raw = fixture(); raw.builds[0].output[0].lambda.runtime = 'nodejs24.x\n';
  assert.equal(projectMetadata('builds', raw).classification, 'not_reproduced');
  raw.builds[0].output[0].runtime = 'nodejs22.x';
  const result = projectMetadata('builds', raw);
  assert.equal(result.reason, 'output_runtime_fields_disagree');
  assert.deepEqual(result.nodeMajors, [22, null]);
});

/** Missing/unknown runtime labels are not invented conflicts; duplicate validation uses the original projected labels. */
test('preserves duplicate normalization and missing-runtime handling', () => {
  const raw = fixture(); raw.builds[0].output.push({ path: 'api/auth/session', type: 'lambda' });
  assert.equal(projectMetadata('builds', raw).classification, 'not_reproduced');
  raw.builds[0].output.push({ path: 'api/auth/session', type: 'lambda', runtime: SECRET_SENTINEL });
  assert.equal(projectMetadata('builds', raw).reason, 'duplicate_route_runtime_disagrees');
});

/** Strict receipts forbid extra data, arbitrary reasons, inconsistent state and unbounded numeric metadata. */
test.each([
  (m) => { m.extra = SECRET_SENTINEL; },
  (m) => { m.reason = SECRET_SENTINEL; },
  (m) => { m.outputClassification = SECRET_SENTINEL; },
  (m) => { m.outputClassification = 'not_applicable'; },
  (m) => { delete m.outputClassification; },
  (m) => { m.nodeMajorSlotOrder = SECRET_SENTINEL; },
  (m) => { m.nodeMajorSlotOrder = 'previous_then_current_projected_runtime'; },
  (m) => { delete m.nodeMajorSlotOrder; },
  (m) => { m.nodeMajors = [1000, 22]; },
  (m) => { m.nodeMajors = [-1, 22]; },
  (m) => { m.nodeMajors = [24.1, 22]; },
  (m) => { m.nodeMajors = [SECRET_SENTINEL, 22]; },
  (m) => { m.nodeMajors = [24, 22, 20]; },
  (m) => { m.classification = 'not_reproduced'; },
  (m) => { m.reason = 'response_project_mismatch'; },
  (m) => { m.reason = 'duplicate_route_runtime_disagrees'; },
  (m) => { m.qualification = 'passed'; },
])('rejects corrupt diagnostic receipt %#', (mutate) => {
  const raw = fixture(); raw.builds[0].output[0].runtime = 'nodejs24.x';
  const result = projectMetadata('builds', raw); mutate(result);
  assert.throws(() => child.validateMetadata('builds', result), { code: 'provider_schema' });
});

/** The original projection file is itself pinned before CLI imports or managed authorization access. */
test('rejects drift in the authoritative projector', () => {
  assert.throws(() => child.verifyPins((file) => file === child.UPSTREAM_FILE
    ? Buffer.from('changed projection') : fs.readFileSync(file)), { code: 'dependency_changed' });
});

/** CLI reauthentication and retry adapters stay disabled even after a valid managed login. */
test('valid authorization cannot enable retries or refresh', async () => {
  class Client {
    /** Return a synthetic response through the installed CLI method without networking. */
    async _fetch() { return response({ safe: true }); }
  }
  const guard = createGuard({ phase: 'builds', deploymentId: DEPLOYMENT }, async () => {});
  installClientGuards(Client, () => true, guard);
  const client = new Client(); await client.fetch(guard.endpoint);
  await assert.rejects(client.reauthenticate(), { code: 'auth_refresh_disabled' });
  await assert.rejects(client.retry(), { code: 'request_not_allowed' });
});

test('one dispatch uses manual redirects and produces a sanitized replacement response', async () => {
  const events = [];
  let calls = 0;
  const guard = createGuard({ phase: 'builds', deploymentId: DEPLOYMENT }, async (url, options) => {
    calls++;
    assert.equal(url, `https://api.vercel.com${guard.endpoint}`);
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal);
    return response(fixture('builds'));
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
    const guard = createGuard({ phase: 'builds', deploymentId: DEPLOYMENT }, async () => { calls++; });
    await assert.rejects(guard.fetch(url || `https://api.vercel.com${guard.endpoint}`, options), { code: 'request_not_allowed' });
    assert.equal(calls, 0);
  });
}

for (const status of [302, 401, 403, 429, 500]) {
  test(`stops HTTP ${status} with no retry or retained error body`, async () => {
    let calls = 0;
    const guard = createGuard({ phase: 'builds', deploymentId: DEPLOYMENT }, async () => {
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
    const guard = createGuard({ phase: 'builds', deploymentId: DEPLOYMENT }, async () => makeResponse());
    await assert.rejects(guard.fetch(`https://api.vercel.com${guard.endpoint}`), { code });
  });
}

test('times out stalled response bodies and cancels the reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const guard = createGuard({ phase: 'builds', deploymentId: DEPLOYMENT }, async () => new Response(stream,
    { headers: { 'content-type': 'application/json' } }), () => {}, 10);
  await assert.rejects(guard.fetch(`https://api.vercel.com${guard.endpoint}`), { code: 'request_timeout' });
  assert.equal(cancelled, true);
});

test('times out stalled headers even when the mocked transport ignores abort', async () => {
  const guard = createGuard({ phase: 'builds', deploymentId: DEPLOYMENT }, () => new Promise(() => {}), () => {}, 10);
  await assert.rejects(guard.fetch(`https://api.vercel.com${guard.endpoint}`), { code: 'request_timeout' });
  assert.equal(guard.state.nativeFetchCalls, 1);
  assert.equal(guard.state.metadata, null);
});

test('dispatch notification failure sends no network request and clears its timer', async () => {
  let calls = 0;
  const guard = createGuard({ phase: 'builds', deploymentId: DEPLOYMENT }, async () => { calls++; },
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
  const guard = createGuard({ phase: 'builds', deploymentId: DEPLOYMENT }, async () => {});
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
  const guard = createGuard({ phase: 'builds', deploymentId: DEPLOYMENT }, async () => {});
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

/** Evaluate fresh module initialization with read-only pin mocks and recorded dependency loads, without running main. */
function initializeChild(changedFile, events) {
  const source = fs.readFileSync(path.join(__dirname, '../provider-read-child.cjs'), 'utf8');
  const runtime = { __dirname: path.resolve(__dirname, '..'), module: { exports: {} },
    process: { env: { GATE1_REVIEW_WORKSPACE: child.ROOT, GATE1_VERCEL_CLI_DIST: child.CLI } },
    /** Record pin reads and simulate changed bytes without modifying any preserved dependency. */
    require(name) {
      if (name === 'node:fs') return {
        /** Read only dependency bytes; substitute drift for the selected pin. */
        readFileSync(file) {
          events.push(['read', file]);
          return file === changedFile ? Buffer.from('changed dependency') : fs.readFileSync(file);
        },
      };
      if (!name.startsWith('node:')) events.push(['require', name]);
      return require(name);
    },
  };
  runtime.require.resolve = require.resolve;
  vm.runInNewContext(source, runtime);
  return runtime.module.exports;
}

/** A changed validator, projector or CLI pin must stop initialization before either dependency can execute. */
test.each([child.ZOD_ENTRY, child.UPSTREAM_FILE, path.join(child.CLI, 'index.js')])(
  'initialization rejects changed %s before dependency evaluation', (file) => {
    const events = [];
    assert.throws(() => initializeChild(file, events), { code: 'dependency_changed' });
    assert.deepEqual(events.filter(([kind]) => kind === 'require'), []);
  });

/** Valid pins permit schema/projector initialization only after every existing pin has been read. */
test('initialization verifies all pins before loading valid dependencies', () => {
  const events = [], initialized = initializeChild(null, events);
  const firstLoad = events.findIndex(([kind]) => kind === 'require');
  assert.deepEqual(new Set(events.slice(0, firstLoad).map(([, file]) => file)),
    new Set([child.ZOD_ENTRY, child.UPSTREAM_FILE, ...Object.keys(child.PINS).map((name) => path.join(child.CLI, name))]));
  assert.deepEqual(events.slice(firstLoad), [['require', child.ZOD_ENTRY], ['require', child.UPSTREAM_FILE]]);
  assert.equal(initialized.projectMetadata('builds', fixture()).classification, 'not_reproduced');
});

/** Run the private entry point with synthetic CLI imports, transport and IPC; isolate process mutations. */
async function runMain({ stream = 'stdout', outputBytes = LIMITS.outputBytes + 1, cliExitCode = 0,
  guardFailure = false, cliReject = false, raw = fixture() } = {}) {
  const events = [];
  const runtime = { Buffer, Response, Headers, AbortController, setTimeout, clearTimeout,
    __dirname: path.resolve(__dirname, '..'), module: { exports: {} },
    process: { env: { GATE1_REVIEW_WORKSPACE: child.ROOT }, execPath: 'synthetic-node', stdout: {}, stderr: {},
      /** Capture only synthetic IPC events and acknowledge the final receipt. */
      send(event, callback) { events.push(event); callback?.(); } },
    /** Supply a valid provider response without making a network request. */
    fetch: async () => response(raw),
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
  const exitCode = await main(['--read', 'builds', DEPLOYMENT]);
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
  assert.equal(receipt.metadata.classification, 'not_reproduced');
});


/** Exercise the real private entry/CLI guards: a diagnostic receipt may carry a conflict, never its raw payload. */
test('private child emits a strict fixed classification for a conflicting response', async () => {
  const raw = fixture(); raw.builds[0].output[0].runtime = 'nodejs24.x';
  const { exitCode, receipt } = await runMain({ outputBytes: 0, raw });
  assert.equal(exitCode, 0); assert.equal(receipt.result, 'read');
  assert.equal(receipt.metadata.reason, 'output_runtime_fields_disagree');
  assert.equal(receipt.metadata.qualification, 'unqualified_metadata_only');
  assert.ok(!JSON.stringify(receipt).includes(SECRET_SENTINEL));
});


/** Reason/major combinations impossible under the original parser cannot be forged through otherwise valid IPC. */
test.each([
  ['output_runtime_fields_disagree', [22, 22]],
  ['output_node_runtime_mismatch', [22, null]],
  ['output_node_runtime_mismatch', [24, 20]],
  ['duplicate_route_runtime_disagrees', [22, 22]],
])('rejects impossible major slots for %s: %j', (reason, nodeMajors) => {
  assert.throws(() => child.validateMetadata('builds', { classification: 'conflict_identified', reason, nodeMajors,
    nodeMajorSlotOrder: reason.startsWith('duplicate_') ? 'previous_then_current_projected_runtime' : 'output_runtime_then_lambda_runtime',
    outputClassification: 'known_application_route',
    qualification: 'unqualified_metadata_only', historicalCause: 'not_proven_same_response' }), { code: 'provider_schema' });
});

/** Equal concrete non-22 runtime declarations are one contract conflict, not disagreeing fields. */
test('retains equal non-22 declarations in both bounded slots', () => {
  const raw = fixture();
  raw.builds[0].output[0].runtime = 'nodejs24.x'; raw.builds[0].output[0].lambda.runtime = 'nodejs24.x';
  const result = projectMetadata('builds', raw);
  assert.equal(result.reason, 'output_node_runtime_mismatch'); assert.deepEqual(result.nodeMajors, [24, 24]);
});

/** Only bounded allowlisted paths determine output class; raw type labels and path lookalikes confer no trust. */
test.each([
  ['/api/auth/session', 'known_application_route'], ['api/auth/session', 'known_application_route'],
  ['/login', 'known_application_route'], ['/', 'known_application_route'],
  ['_middleware', 'middleware'], ['/_middleware', 'middleware'],
  [SECRET_SENTINEL, 'unrecognized_output'], [null, 'unrecognized_output'],
  [{ private: SECRET_SENTINEL }, 'unrecognized_output'],
  ['a'.repeat(256), 'unrecognized_output'], ['a'.repeat(257), 'unrecognized_output'],
  ['/api/auth/session?private=' + SECRET_SENTINEL, 'unrecognized_output'],
  ['/api/auth%2fsession', 'unrecognized_output'], ['/api/auth/session/', 'unrecognized_output'],
  ['/api/auth/session\n', 'unrecognized_output'], [' /_middleware', 'unrecognized_output'],
  ['https://example.invalid/login', 'unrecognized_output'], ['../login', 'unrecognized_output'],
])('classifies path fixture %# without retaining it or weakening runtime rejection', (rawPath, expected) => {
  for (const slots of [{ runtime: 'nodejs24.x' }, { lambda: { runtime: 'nodejs24.x' } },
    { runtime: 'nodejs24.x', lambda: { runtime: 'nodejs24.x' } },
    { runtime: 'nodejs22.x', lambda: { runtime: 'nodejs24.x' } }]) {
    const raw = fixture(); raw.builds[0].output = [{ path: rawPath, type: 'middleware', ...slots }];
    assert.throws(() => require(child.UPSTREAM_FILE).projectMetadata('builds', raw), { code: 'attribution_conflict' });
    const result = projectMetadata('builds', raw);
    assert.equal(result.outputClassification, expected);
    assert.equal(result.nodeMajorSlotOrder, 'output_runtime_then_lambda_runtime');
    assert.equal(result.reason, slots.runtime === 'nodejs22.x' ? 'output_runtime_fields_disagree' : 'output_node_runtime_mismatch');
    assert.deepEqual(result.nodeMajors, [slots.runtime ? Number(slots.runtime.slice(6, -2)) : null,
      slots.lambda ? 24 : null]);
    assert.ok(!JSON.stringify(result).includes(SECRET_SENTINEL));
    assert.ok(!JSON.stringify(result).includes('/api/auth/session'));
  }
});

/** Duplicate metadata uses the authority's normalized route key and never invents unknown-output duplicate proof. */
test.each([
  ['_middleware', '/_middleware', 'middleware'],
  ['api/auth/session', '/api/auth/session', 'known_application_route'],
])('classifies duplicate fixture %# and names its previous/current slots', (first, second, expected) => {
  const raw = fixture(); raw.builds[0].output = [
    { path: first, type: 'lambda', runtime: 'nodejs22.x' },
    { path: second, type: 'lambda', runtime: 'edge' },
  ];
  const result = projectMetadata('builds', raw);
  assert.equal(result.reason, 'duplicate_route_runtime_disagrees');
  assert.equal(result.outputClassification, expected);
  assert.equal(result.nodeMajorSlotOrder, 'previous_then_current_projected_runtime');
  assert.deepEqual(result.nodeMajors, [22, null]);
  result.outputClassification = 'unrecognized_output';
  assert.throws(() => child.validateMetadata('builds', result), { code: 'provider_schema' });
});

/** Unknown output duplicates remain outside the authority's duplicate comparison, leaving qualification inconclusive. */
test('unknown paths do not manufacture duplicate-route attribution', () => {
  const raw = fixture(); raw.builds[0].output = [
    { path: SECRET_SENTINEL, type: 'lambda', runtime: 'nodejs22.x' },
    { path: SECRET_SENTINEL, type: 'lambda', runtime: 'edge' },
  ];
  const result = projectMetadata('builds', raw);
  assert.equal(result.classification, 'not_reproduced');
  assert.equal(result.outputClassification, 'not_applicable');
});

/** Parent receipt validation cannot attach an affected route to identity failures or inconclusive responses. */
test.each(['known_application_route', 'middleware', 'unrecognized_output'])('rejects fabricated output class %s', (outputClassification) => {
  for (const raw of [{}, { deploymentId: SECRET_SENTINEL }, { projectId: SECRET_SENTINEL },
    { builds: [{ deploymentId: SECRET_SENTINEL }] }]) {
    const result = projectMetadata('builds', raw);
    assert.equal(result.outputClassification, 'not_applicable');
    result.outputClassification = outputClassification;
    assert.throws(() => child.validateMetadata('builds', result), { code: 'provider_schema' });
  }
});

/** A preceding schema failure stays terminal; a later one cannot replace the earlier runtime conflict. */
test('retains schema-versus-runtime guard ordering', () => {
  const badRuntime = { path: SECRET_SENTINEL, runtime: 'nodejs24.x' };
  const raw = fixture(); raw.builds[0].output = [null, badRuntime];
  assert.throws(() => projectMetadata('builds', raw), { code: 'provider_schema' });
  raw.builds[0].output = [badRuntime, null];
  const result = projectMetadata('builds', raw);
  assert.equal(result.reason, 'output_node_runtime_mismatch');
  assert.equal(result.outputClassification, 'unrecognized_output');
});

/** Exact count boundaries remain usable without an off-by-one expansion or a false complete-manifest claim. */
test('accepts the exact build and output count caps only as inconclusive metadata', () => {
  const raw = fixture(); raw.builds = Array.from({ length: 64 }, () => ({ output: [] }));
  raw.builds[0].output = Array.from({ length: 2048 }, () => ({ path: '/login', runtime: 'nodejs22.x' }));
  assert.equal(projectMetadata('builds', raw).classification, 'not_reproduced');
  raw.builds[1].output.push({ path: '/login', runtime: 'nodejs22.x' });
  assert.throws(() => projectMetadata('builds', raw), { code: 'metadata_limit' });
});
