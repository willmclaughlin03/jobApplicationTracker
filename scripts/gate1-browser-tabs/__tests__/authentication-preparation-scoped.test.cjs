'use strict';
/* global Buffer, structuredClone, queueMicrotask, AbortController, setTimeout, clearTimeout */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { TextDecoder } = require('node:util');
const s = require('../authentication-preparation-scoped.cjs');
const c = require('../authentication-preparation-scoped-contract.cjs');
const { CdpConnection } = require('../authentication-preparation-scoped-observer.cjs');
const a = require('../authentication-preparation.cjs');
const d = require('../hosted-csrf-diagnostic.cjs');
const ID = '00000000-0000-4000-8000-000000000001'; const HASH = 'a'.repeat(64);

/** Build fully synthetic provenance; this object is never supplied to the gated native CLI. */
function input() {
  return { plan: { schemaVersion: 2, decision: c.DECISION, approval: 'scoped-authentication-preparation',
    sourceSet: HASH, decisionHash: HASH, toolSet: HASH, qualificationHash: HASH, buildHash: a.BUILD_HASH,
    target: { ...d.TARGET }, buildId: a.BUILD, profile: d.PROFILE, limits: { ...c.LIMITS },
    ledgerBefore: structuredClone(a.BASELINE), approvedAt: 0, expiresAt: 3600000 },
  planHash: HASH, qualificationHash: HASH, qualification: { schemaVersion: 2, scope: 'scoped_authentication_native',
    sourceSet: HASH, decisionHash: HASH, toolSet: HASH, attemptHash: HASH, completionHash: HASH, phase: 'passed',
    checks: Object.fromEntries(c.QUALIFICATION_CHECKS.map(key => [key, true])), browserTrafficMeasured: false, hostedQualified: false },
  review: { planHash: HASH, qualificationHash: HASH, sourceSet: HASH, decisionHash: HASH, toolSet: HASH, completionHash: HASH } };
}

/** Make a completed metadata response for the existing frozen-target validator without provider access. */
function metadata(kind) {
  const target = d.TARGET;
  if (kind === 'project') return { id: target.project, accountId: target.team, targets: { production: { id: target.deployment } }, autoAssignCustomDomains: true };
  if (kind === 'alias') return { alias: target.canonical, projectId: target.project, deployment: { id: target.deployment } };
  return { id: target.deployment, projectId: target.project, url: target.generated, target: 'production', readyState: 'READY',
    meta: { githubCommitSha: target.source }, gitSource: { sha: target.source }, aliasAssigned: true, alias: [target.canonical] };
}

/** Use actual reservation arithmetic around fake responses so orchestration tests catch lost/double charges. */
function complete(budget, kind, source = 'page') {
  const id = budget.reserve(kind, source); budget.acknowledge(id); budget.confirm(id); budget.finish(id); return true;
}

/** Model only native boundaries; record lifecycle order and every receipt write in memory. */
function fixture() {
  const state = { calls: [], record: null, launches: 0, cancelled: 0 }; const bytes = { read: 1, admitted: 1, rejected: 0, written: 1 };
  const proxy = { port: 12345, forwarding: false, start: async () => {},
    open: () => { proxy.forwarding = true; state.calls.push('open'); }, seal: () => { proxy.forwarding = false; }, close: async () => {},
    snapshot: () => ({ connections: 1, concurrent: 0, overLimit: 0, denied: 0, tunnels: 1,
      upstream: { ...bytes }, downstream: { ...bytes }, forwardingClosed: true }) };
  const deps = { clock: () => 1000, preflight: async () => {}, reserveArtifacts: async artifacts => { artifacts.reserved = true; }, proxy: () => proxy,
    metadata: async kind => metadata(kind),
    launch: async (owner, gate) => {
      assert.equal(gate.forwarding, false); state.launches++; owner.child = { pid: state.launches, exitCode: null }; owner.port = 12345 + state.launches;
      if (owner.restart) owner.context = { request: {} }; state.calls.push(owner.restart ? 'restart' : 'launch');
    },
    observe: async () => { state.calls.push('observe'); },
    manualSignIn: async (_owner, budget) => complete(budget, 'application'),
    pageIdentity: async (_owner, budget) => complete(budget, 'session'),
    requestIdentity: async (_owner, budget) => complete(budget, 'session', 'requestClient'),
    summarize: async () => {}, stopObservation: () => {},
    close: async owner => { owner.closed = true; owner.child.exitCode = 0; state.calls.push('close'); return s.ownerRecord(owner); },
    ownerRecord: s.ownerRecord, inspect: async () => { state.calls.push('inspect'); }, profile: async () => true,
    cancelRequests: async () => { state.cancelled++; }, verifyBindings: async () => {},
    writeAttempt: async record => { state.record = record; return HASH; } };
  return { state, deps, proxy };
}

/** Execute the actual page expression against synthetic UTF-8 bytes, tracking decoding, parsing and timer cleanup. */
function pageIdentityFixture(bytes) {
  const state = { decoded: 0, parsed: 0, cleared: 0 };
  /** Count decoding so oversized responses cannot be converted to strings before their byte check. */
  class Decoder extends TextDecoder {
    /** Decode the supplied buffer using the browser's default UTF-8 behavior. */
    decode(body) { state.decoded++; return super.decode(body); }
  }
  const sandbox = { AbortController, TextDecoder: Decoder,
    JSON: { parse: body => { state.parsed++; return JSON.parse(body); } },
    setTimeout: (_callback, ms) => { assert.equal(ms, 30000); return 1; },
    clearTimeout: timer => { assert.equal(timer, 1); state.cleared++; },
    fetch: async (url, options) => {
      assert.equal(url, '/api/auth/session'); assert.equal(options.credentials, 'include');
      assert.equal(options.redirect, 'error'); assert.equal(options.signal.aborted, false);
      return { status: 200, text: async () => bytes.toString('utf8'),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    } };
  const owner = { observer: {}, page: { sessionId: 'synthetic-page' }, cdp: {
    /** Run the production expression in isolation while keeping all browser and network I/O mocked. */
    send: async (method, options, sessionId) => {
      assert.equal(method, 'Runtime.evaluate'); assert.equal(sessionId, owner.page.sessionId);
      assert.equal(options.awaitPromise, true); assert.equal(options.returnByValue, true);
      return { result: { value: await vm.runInNewContext(options.expression, sandbox) } };
    },
  } };
  return { owner, state, budget: new c.ScopedBudget() };
}

/** A valid identity envelope with multibyte text must not bypass the JSON byte cap via string length. */
test('page identity rejects oversized UTF-8 JSON before decoding or parsing', async () => {
  const body = JSON.stringify({ error: null, message: 'Success', data: { user: { id: ID, name: '\u00e9'.repeat(32768) } } });
  const bytes = Buffer.from(body); assert.ok(body.length < d.LIMITS.jsonBytes); assert.ok(bytes.length > d.LIMITS.jsonBytes);
  const f = pageIdentityFixture(bytes);
  await assert.rejects(s.pageIdentity(f.owner, f.budget, ID), { code: 'identity' });
  assert.deepEqual(f.state, { decoded: 0, parsed: 0, cleared: 1 });
});

/** Accept ASCII and multibyte responses through the exact byte boundary, rejecting the next byte before parsing. */
test('page identity enforces the inclusive JSON byte limit for ASCII and UTF-8 responses', async () => {
  for (const name of ['plain', '\u00e9']) {
    const base = Buffer.from(JSON.stringify({ error: null, message: 'Success', data: { user: { id: ID, name } } }));
    for (const offset of [-1, 0, 1]) {
      const bytes = Buffer.concat([base, Buffer.alloc(d.LIMITS.jsonBytes + offset - base.length, 32)]);
      const f = pageIdentityFixture(bytes);
      if (offset > 0) await assert.rejects(s.pageIdentity(f.owner, f.budget, ID), { code: 'identity' });
      else assert.equal(await s.pageIdentity(f.owner, f.budget, ID), true);
      assert.deepEqual(f.state, { decoded: offset > 0 ? 0 : 1, parsed: offset > 0 ? 0 : 1, cleared: 1 });
    }
  }
});

/** Exercise the native poll and CDP transport with synthetic replies and a clock advanced only by polling delays. */
function manualSignInFixture(reply, { manualMs = 1000, deadline = 2000 } = {}) {
  const state = { now: 0, calls: [], delays: [] }; const socket = new EventEmitter();
  const budget = new c.ScopedBudget({ clock: () => state.now, limits: { ...c.LIMITS, manualMs } });
  budget.deadline = deadline;
  /** Feed correlated protocol frames through the real transport without opening a native socket. */
  socket.send = bytes => {
    const request = JSON.parse(bytes); state.calls.push(request);
    const response = request.method === 'Page.navigate' ? { result: {} } : reply(state, budget);
    socket.emit('message', Buffer.from(JSON.stringify({ id: request.id, sessionId: request.sessionId, ...response })));
  };
  socket.terminate = () => {};
  const owner = { cdp: new CdpConnection(socket, budget), observer: {}, page: { sessionId: 'synthetic-page' } };
  const poll = vm.runInNewContext(`(${s.manualSignIn.toString()})`, { c, d, syntheticOwners: new WeakMap(), Date: { now: () => state.now },
    /** Model the cancellable interval without real waiting, preserving the production delay's abort behavior. */
    delay: async (ms, signal) => {
      c.check(!signal.aborted, 'cancelled'); state.delays.push(ms); state.now += ms;
    },
  });
  return { state, budget, owner, run: () => poll(owner, budget, budget.abort.signal) };
}

/** A navigation-lost context is only a missed poll; later success must leave the shared attempt unstopped. */
test('synthetic manual context recovery retries native protocol errors and completes sign-in', async () => {
  for (const message of ['Cannot find context with specified id', 'Cannot find default execution context',
    'Execution context was destroyed.', 'Inspected target navigated or closed']) {
    const f = manualSignInFixture(state => state.calls.length === 2
      ? { error: { code: -32000, message } } : { result: { result: { value: true } } });
    try {
      await f.run(); assert.equal(f.budget.failure, null); assert.equal(f.budget.abort.signal.aborted, false);
      assert.deepEqual(f.state.calls.map(call => call.method), ['Page.navigate', 'Runtime.evaluate', 'Runtime.evaluate']);
      assert.deepEqual(f.state.delays, [250]); assert.equal(f.owner.cdp.pending.size, 0);
    } finally { f.owner.cdp.close(); }
  }
});

/** Repeated context loss cannot renew either the manual-sign-in allowance or the earlier global work deadline. */
test('transient manual polling preserves manualMs and earlier deadline bounds', async () => {
  for (const limits of [{ manualMs: 1000, deadline: 2000 }, { manualMs: 2000, deadline: 1000 }]) {
    const f = manualSignInFixture(() => ({ error: { code: -32000, message: 'Execution context was destroyed.' } }), limits);
    try {
      await assert.rejects(f.run(), { code: 'deadline' }); assert.equal(f.state.now, 1000);
      assert.equal(f.state.calls.length, 5); assert.deepEqual(f.state.delays, [250, 250, 250, 250]);
      assert.equal(f.owner.cdp.pending.size, 0);
    } finally { f.owner.cdp.close(); }
  }
});

/** A late successful reply cannot bypass the fixed manual allowance or global work deadline. */
test('manual polling rejects a successful evaluation that settles at either deadline', async () => {
  for (const limits of [{ manualMs: 1000, deadline: 2000 }, { manualMs: 2000, deadline: 1000 }]) {
    const f = manualSignInFixture(state => {
      state.now = 1000; return { result: { result: { value: true } } };
    }, limits);
    try { await assert.rejects(f.run(), { code: 'deadline' }); assert.deepEqual(f.state.delays, []); }
    finally { f.owner.cdp.close(); }
  }
});

/** Unknown protocol errors, page exceptions and cancellation remain fatal instead of being swallowed by the retry path. */
test('manual polling does not retry non-transient failures or cancellation', async () => {
  for (const response of [{ error: { code: -32000, message: 'private protocol failure' } },
    { result: { exceptionDetails: { text: 'private script failure' } } }]) {
    const f = manualSignInFixture(() => response);
    try {
      await assert.rejects(f.run(), { code: 'observation' }); assert.deepEqual(f.state.delays, []);
      assert.equal(f.state.calls.length, 2);
    } finally { f.owner.cdp.close(); }
  }
  const f = manualSignInFixture((_state, budget) => {
    budget.stop('cancelled'); return { error: { code: -32000, message: 'Execution context was destroyed.' } };
  });
  try {
    await assert.rejects(f.run()); assert.equal(f.budget.failure, 'cancelled');
    assert.equal(f.state.calls.length, 2); assert.deepEqual(f.state.delays, []);
  } finally { f.owner.cdp.close(); }
});

/** Capture both Chrome spawn environments, stopping at mocked attachment before any browser or filesystem access. */
test('Chrome launches omit the approved identity and retain the remaining sanitized environment', async () => {
  const parentEnv = Object.freeze({ GATE1_APPROVED_USER_ID: ID, KEEP: 'retained', DEBUG: 'suppressed', NODE_OPTIONS: 'suppressed' });
  const expected = s.childEnvironment(parentEnv); delete expected.GATE1_APPROVED_USER_ID;
  const stop = new Error('mock attachment stop'); const environments = [];
  const launch = vm.runInNewContext(`(${s.launch.toString()})`, {
    c, d, syntheticOwners: new WeakMap(),
    p: { profilePreserved: async () => {} }, f: { fixtureExecutable: () => 'mock-chrome', isolationArguments: () => [] },
    childEnvironment: () => s.childEnvironment(parentEnv), attachment: async () => { throw stop; },
    /** Capture options at the native process boundary without starting a process. */
    spawn: (_executable, _args, options) => { environments.push(options.env); return new EventEmitter(); },
  });
  for (const restart of [false, true]) {
    await assert.rejects(launch({ profile: d.PROFILE, restart }, { port: 12345 }, { check: () => {} }), stop);
    assert.deepEqual(environments.at(-1), expected);
  }
  assert.equal(environments.length, 2); assert.equal(parentEnv.GATE1_APPROVED_USER_ID, ID);
});

/** Capture the worker spawn with a synthetic environment and mocked startup failure; no parent environment is changed. */
test('supervisor retains the approved identity in the sanitized worker environment', async () => {
  const parentEnv = Object.freeze({ GATE1_APPROVED_USER_ID: ID, KEEP: 'retained', DEBUG: 'suppressed', NODE_OPTIONS: 'suppressed' });
  let environment;
  const supervise = vm.runInNewContext(`(${s.supervise.toString()})`, {
    c, process: Object.assign(new EventEmitter(), { execPath: 'mock-node' }), __filename: 'mock-worker.cjs',
    childEnvironment: () => s.childEnvironment(parentEnv), setTimeout, clearTimeout,
  });
  /** Fail after capturing the spawn options so the real supervisor releases its listeners and timers. */
  const spawn = (_executable, _args, options) => {
    environment = options.env; const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('mock startup failure'))); return child;
  };
  await assert.rejects(supervise(input().plan, HASH, async () => {}, { spawn, clock: () => 1000 }), { code: 'worker_completion' });
  assert.deepEqual(environment, { GATE1_APPROVED_USER_ID: ID, KEEP: 'retained' });
  assert.equal(parentEnv.GATE1_APPROVED_USER_ID, ID);
});

test('two-launch flow observes before opening and independently closes before the rejecting restart', async () => {
  const f = fixture(); const result = await s.runScoped(input(), ID, f.deps);
  assert.equal(result.phase, 'passed'); assert.equal(f.state.launches, 2);
  assert.ok(f.state.calls.indexOf('observe') < f.state.calls.indexOf('open'));
  assert.ok(f.state.calls.indexOf('inspect') < f.state.calls.indexOf('restart'));
  assert.equal(f.state.record.traffic.requestClient, 1); assert.equal(f.state.record.traffic.counts.session, 2);
  assert.equal(f.state.record.traffic.counts.application, 3); assert.equal(f.state.record.traffic.counts.metadata, 6);
  assert.equal(f.state.record.browserTrafficMeasured, false); assert.equal(f.state.record.hostedQualified, false);
});

test('failed launch is owned before its rejection and cleaned without a receipt or second launch', async () => {
  const f = fixture(); const original = f.deps.launch;
  f.deps.launch = async (...args) => { await original(...args); throw new Error('private startup detail'); };
  const result = await s.runScoped(input(), ID, f.deps);
  assert.equal(result.firstFailure, 'operation'); assert.equal(f.state.launches, 1);
  assert.ok(f.state.calls.includes('close')); assert.equal(f.state.record.phase, 'stopped');
});

test('identity mismatch remains first failure through missing profile and cleanup failure', async () => {
  const f = fixture(); f.deps.pageIdentity = async () => { throw new c.PreparationError('identity'); };
  f.deps.profile = async () => { throw new c.PreparationError('profile'); };
  const result = await s.runScoped(input(), ID, f.deps);
  assert.equal(result.firstFailure, 'identity'); assert.equal(result.receiptFinalized, false); assert.equal(f.state.record.phase, 'stopped');
});

test('restart cancellation disposes actual request client and late completion cannot write success', async () => {
  const f = fixture(); f.deps.requestIdentity = async (_owner, budget) => { budget.reserve('session', 'requestClient'); budget.stop('cancelled'); return true; };
  const result = await s.runScoped(input(), ID, f.deps);
  assert.equal(result.firstFailure, 'cancelled'); assert.equal(f.state.cancelled, 1); assert.equal(f.state.record.phase, 'stopped');
  assert.equal(f.state.record.traffic.requestClient, 1); assert.equal(f.state.record.traffic.uncertain, 1);
});

test('request client shares context cookies, disables retry/redirect and disposes its response', async () => {
  const budget = new c.ScopedBudget(); let disposed = 0;
  const owner = { context: { request: { get: async (url, options) => {
    assert.equal(url, `${d.ORIGIN}/api/auth/session`); assert.equal(options.maxRedirects, 0); assert.equal(options.maxRetries, 0);
    return { status: () => 200, body: async () => Buffer.from(JSON.stringify({ error: null, message: 'Success', data: { user: { id: ID } } })),
      dispose: async () => { disposed++; } };
  } } } };
  assert.equal(await s.requestIdentity(owner, budget, ID), true); assert.equal(disposed, 1);
  assert.equal(budget.snapshot().requestClient, 1); assert.equal(budget.snapshot().page, 0);
  await assert.rejects(s.requestIdentity(owner, budget, '00000000-0000-4000-8000-000000000002'), { code: 'identity' });
  assert.equal(disposed, 2); assert.equal(budget.counts.session, 2);
});

test('source, decision or late write failures prevent completion despite successful earlier lifecycle', async () => {
  for (const phase of ['verifyBindings', 'writeAttempt']) {
    const f = fixture(); f.deps[phase] = async () => { throw new c.PreparationError('integrity'); };
    const result = await s.runScoped(input(), ID, f.deps); assert.equal(result.phase, 'stopped'); assert.equal(result.receiptFinalized, false);
  }
});

test('supervisor requires actual zero worker exit and rejects duplicate completion messages', async () => {
  for (const [exitCode, duplicate] of [[1, false], [0, true]]) {
    let finalized = 0;
    const spawn = () => {
      const child = new EventEmitter(); child.connected = true; child.send = () => {};
      queueMicrotask(() => {
        const value = { phase: 'passed', receiptFinalized: true, attemptHash: HASH, sourceSet: HASH, planHash: HASH };
        child.emit('message', value); if (duplicate) child.emit('message', value); child.emit('close', exitCode);
      }); return child;
    };
    await assert.rejects(s.supervise(input().plan, HASH, async () => {}, { spawn, clock: () => 1000,
      finalize: async completion => { assert.equal(c.check(completion.exitCode === 0, 'worker_completion'), undefined); finalized++; } }));
    assert.equal(finalized, 0);
  }
});

/** Finalization must inherit the original supervisor clock and earlier of approval expiry and the whole-attempt limit. */
test('supervisor passes its original combined deadline and clock into finalization', async () => {
  for (const expiresAt of [4000, 3600000]) {
    const plan = { ...input().plan, expiresAt }; let now = 1000; const clock = () => now;
    /** Simulate a successful worker that consumes time before its completion and actual exit. */
    const spawn = () => {
      const child = new EventEmitter(); child.connected = true; child.send = () => {};
      queueMicrotask(() => {
        now = 2000;
        child.emit('message', { phase: 'passed', receiptFinalized: true, attemptHash: HASH, sourceSet: HASH, planHash: HASH });
        child.emit('close', 0);
      }); return child;
    };
    const verify = async () => {};
    const result = await s.supervise(plan, HASH, verify, { spawn, clock,
      /** Capture the real dispatch boundary so finalization cannot silently fall back to a new clock or budget. */
      finalize: async (completion, receivedPlan, receivedVerify, deps) => {
        assert.equal(completion.exitCode, 0); assert.equal(receivedPlan, plan); assert.equal(receivedVerify, verify);
        assert.equal(deps?.clock, clock); assert.equal(deps.deadline, Math.min(1000 + c.LIMITS.wholeMs, expiresAt));
        assert.equal(deps.clock(), 2000); return 'finalized';
      },
    });
    assert.equal(result, 'finalized');
  }
});

test('new and old CLI gates refuse manifests/force flags before any native I/O', async () => {
  for (const args of [['--execute-scoped'], ['--execute-scoped', '--force'], ['--scoped-worker']]) {
    await assert.rejects(s.main(args), { code: 'coverage_unqualified' });
  }
  await assert.rejects(a.main(['--execute-reviewed-manifest']), { code: 'coverage_unqualified' });
  await assert.rejects(s.main(['--scoped-worker', HASH, '1000']), { code: 'approval' });
  const env = s.childEnvironment({ DEBUG: 'private', NODE_OPTIONS: 'private', KEEP: 'retained' });
  assert.deepEqual(env, { KEEP: 'retained' });
});

test('execution review independently binds manifest, native receipt and actual native completion digests', async () => {
  const value = input();
  const review = { ...value.review, scope: 'scoped-authentication-execution-review-v1', operator: 'Codex', owner: 'project-owner',
    approvedAt: 0, expiresAt: 3600000 };
  const completion = { scope: 'scoped_authentication_native', phase: 'passed', exitCode: 0, receiptFinalized: true,
    attemptHash: HASH, sourceSet: HASH, decisionHash: HASH, toolSet: HASH };
  const records = { 'execution-review.json': review, 'reviewed-plan.json': value.plan,
    'native-qualification.json': value.qualification, 'native-completion.json': completion };
  const read = async name => ({ data: records[name], hash: HASH });
  assert.equal((await s.loadReviewed(HASH, ID, read, 1000)).planHash, HASH);
  await assert.rejects(s.loadReviewed('b'.repeat(64), ID, read, 1000), { code: 'approval' });
  await assert.rejects(s.loadReviewed(HASH, ID, read, 3600000), { code: 'expired' });
  completion.exitCode = 1;
  await assert.rejects(s.loadReviewed(HASH, ID, read, 1000), { code: 'worker_completion' });
  completion.exitCode = 0; value.qualification.schemaVersion = 1;
  await assert.rejects(s.loadReviewed(HASH, ID, read, 1000), { code: 'coverage_unqualified' });
});

test('source binding includes the decision digest, all modules/tests and both public TLS fixture files', async () => {
  assert.equal(s.FILES.length, 18); let decision = HASH; let source = HASH;
  const sandbox = { FILES: s.FILES, DECISION_FILE: 'decision', __dirname: '.',
    path: require('node:path'), d, a: { sourceHash: async () => HASH,
      hashFile: async file => file === 'decision' ? decision : source } };
  const read = vm.runInNewContext(`(${s.sourceHashes.toString()})`, sandbox);
  const initial = await read(); decision = 'b'.repeat(64); const changedDecision = await read();
  assert.notEqual(initial.sourceSet, changedDecision.sourceSet); assert.equal(changedDecision.decisionHash, decision);
  source = 'c'.repeat(64); assert.notEqual(changedDecision.sourceSet, (await read()).sourceSet);
});

test('consumed artifact marker refuses a second attempt without writing evidence into its directory', async () => {
  const f = fixture(); f.deps.reserveArtifacts = async () => { throw new c.PreparationError('already_used'); };
  const result = await s.runScoped(input(), ID, f.deps);
  assert.equal(result.firstFailure, 'already_used'); assert.equal(result.failureEvidenceWritten, false);
  assert.equal(f.state.launches, 0); assert.equal(f.state.record, null);
});

/** Live launch rejects synthetic profiles before metadata/process access, while synthetic adapters accept only their fixed case. */
test('live and synthetic adapters cannot exchange arbitrary profiles or destinations', async () => {
  const n = require('../authentication-preparation-scoped-native-contract.cjs');
  await assert.rejects(s.launch({ profile: n.PROFILES[0] }, {}, {}), { code: 'profile' });
  assert.throws(() => s.syntheticAdapters('unknown'), { code: 'approval' });
  assert.throws(() => s.syntheticAdapters('lifecycle', 'https://external.test'), { code: 'approval' });
  const adapter = s.syntheticAdapters('lifecycle');
  const budget = new n.NativeBudget(new n.NativeLedger(0, 480000, () => 1000), n.CASES[0]);
  await assert.rejects(adapter.launch({ profile: d.PROFILE }, { listenPort: 18445 }, budget), { code: 'approval' });
  await assert.rejects(adapter.request({}, budget, '/api/auth/session'), { code: 'destination' });
});

/** Mock real framed transport, proving that native witnesses require a genuine incoming error frame. */
test('native context witness records only recognized opted-in inbound errors and counts commands', async () => {
  const n = require('../authentication-preparation-scoped-native-contract.cjs');
  for (const recognized of [true, false]) {
    const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
    const socket = new EventEmitter(); socket.terminate = () => {};
    socket.send = bytes => {
      const request = JSON.parse(bytes);
      queueMicrotask(() => socket.emit('message', Buffer.from(JSON.stringify({ id: request.id, sessionId: request.sessionId,
        ...(recognized ? { error: { code: -32000, message: 'Execution context was destroyed.' } } : { result: { result: { value: false } } }) }))));
    };
    const owner = { socket, cdp: new CdpConnection(socket, budget) };
    const instrument = vm.runInNewContext(`(${s.nativeController.toString()})`, {
      c, MESSAGE_BYTES: 65536, syntheticOwners: { get: () => ({ origin: n.ORIGIN, navigation: null }) },
    });
    instrument(owner, budget);
    assert.equal((await owner.cdp.send('Runtime.evaluate', { expression: 'false' }, 'page', false, { contextLossAsFalse: true })).result.value, false);
    assert.equal(owner.native.contextLoss, recognized ? 1 : 0); assert.equal(root.totals.commands, 1);
    owner.cdp.close();
  }
});

/** Exercise the pinned Playwright seam with mocked native transport, including commands sent during attachment. */
test('synthetic Playwright counts internal CDP commands before dispatch and bounds incoming protocol', async () => {
  const n = require('../authentication-preparation-scoped-native-contract.cjs');
  for (const mode of ['pass', 'commands', 'pending', 'message', 'late', 'unavailable']) {
    const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
    const owner = { port: 23456, endpoint: '/devtools/browser/synthetic' }; const ws = new EventEmitter(); ws._receiver = {};
    let received = 0; let sent = 0; let restored = false;
    const transport = { _ws: ws, _progress: { log: () => assert.fail('raw log') },
      send: () => { sent++; }, close: () => { ws.emit('close'); } };
    /** Model the server's protocol setup after the adapter receives ownership but before any command. */
    const original = async (_progress, current) => {
      assert.equal(current._ws._receiver._maxPayload, 65536); assert.equal(current._progress, null);
      current.onmessage = () => { received++; };
      if (mode === 'commands') root.totals.commands = 2048;
      if (mode === 'pending') {
        for (let id = 1; id <= 33; id++) current.send({ id, method: 'Browser.getVersion', params: {} });
      } else current.send({ id: 1, method: 'Browser.getVersion', params: {} });
      if (mode === 'message') current.onmessage({ id: 1, result: { value: 'x'.repeat(65536) } });
      else if (mode === 'late') { budget.stop('cancelled'); current.send({ id: 2, method: 'Browser.getVersion', params: {} }); }
      else current.onmessage({ id: 1, result: {} });
      return {};
    };
    const impl = { _connectOverCDPImpl: original }; const runtime = { chromium: {} };
    runtime.chromium._connection = { toImpl: () => mode === 'unavailable' ? {} : impl };
    runtime.chromium.connectOverCDP = async () => impl._connectOverCDPImpl(null, transport);
    const connect = vm.runInNewContext(`(${s.nativePlaywright.toString()})`, {
      c, Buffer, setTimeout, clearTimeout, MESSAGE_BYTES: 65536, syntheticOwners: { has: () => true },
    });
    try {
      if (['commands', 'pending', 'late', 'unavailable'].includes(mode)) await assert.rejects(connect(owner, budget, runtime));
      else await connect(owner, budget, runtime);
      restored = impl._connectOverCDPImpl === original;
      if (mode === 'pass') { assert.equal(sent, 1); assert.equal(received, 1); assert.equal(root.totals.commands, 1); }
      if (mode === 'message') { assert.equal(received, 0); assert.equal(budget.failure, 'observation'); }
      if (mode === 'commands') assert.equal(sent, 0);
      if (mode === 'pending') assert.equal(sent, 32);
      if (mode === 'late') assert.equal(sent, 1);
      assert.equal(restored, true);
    } finally { transport.close(); }
  }
});

test('Playwright closure clears pending timers, blocks late dispatch and restores its attachment hook on failure', async () => {
  const n = require('../authentication-preparation-scoped-native-contract.cjs');
  for (const mode of ['unexpected', 'normal', 'attach-failure', 'timeout']) {
    const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
    const owner = { port: 23456, endpoint: '/devtools/browser/synthetic' }; const ws = new EventEmitter(); ws._receiver = {};
    const timers = new Set(); let sent = 0; let received = 0;
    const transport = { _ws: ws, send: () => { sent++; }, close: () => ws.emit('close') };
    /** Send through the real wrapper and simulate only transport completion or attachment rejection. */
    const original = async (_progress, current) => {
      current.onmessage = () => { received++; };
      if (mode === 'normal') { owner.nativeClosing = true; budget.stop('cancelled'); }
      current.send({ id: 1, method: mode === 'normal' ? 'Browser.close' : 'Browser.getVersion', params: {} });
      assert.equal(timers.size, 1);
      if (mode === 'attach-failure') throw new c.PreparationError('operation');
      if (mode === 'timeout') [...timers][0](); else current.close();
      current.onmessage({ id: 1, result: {} });
      assert.equal(timers.size, 0); assert.equal(received, 0);
      assert.throws(() => current.send({ id: 2, method: 'Browser.close', params: {} }));
      return {};
    };
    const impl = { _connectOverCDPImpl: original }; const runtime = { chromium: { _connection: { toImpl: () => impl } } };
    runtime.chromium.connectOverCDP = async () => impl._connectOverCDPImpl(null, transport);
    const connect = vm.runInNewContext(`(${s.nativePlaywright.toString()})`, {
      c, Buffer, MESSAGE_BYTES: 65536, syntheticOwners: { has: () => true },
      setTimeout: callback => { timers.add(callback); return callback; }, clearTimeout: timer => timers.delete(timer),
    });
    if (mode === 'attach-failure') await assert.rejects(connect(owner, budget, runtime), { code: 'operation' });
    else await connect(owner, budget, runtime);
    assert.equal(impl._connectOverCDPImpl, original); assert.equal(timers.size, 0); assert.equal(sent, 1);
    assert.equal(budget.failure, mode === 'normal' ? 'cancelled' : mode === 'timeout' ? 'deadline' : 'observation');
  }
});

test('failed Playwright attachment retires its transport before owned raw normal-close recovery', async () => {
  const calls = []; const owner = { restart: true, child: { exitCode: null },
    nativeTransport: { close: () => calls.push('retire-transport') } };
  const close = vm.runInNewContext(`(${s.close.toString()})`, {
    c, Date: { now: () => 1000 }, syntheticOwners: { has: () => true }, ownerRecord: value => ({ closed: value.closed }),
    attachment: async (_owner, _budget, cleanupOnly) => { assert.equal(cleanupOnly, true); calls.push('attachment'); },
    connectController: async (value, _budget, cleanupOnly) => {
      assert.equal(cleanupOnly, true); assert.equal(value.nativeClosing, true); calls.push('connect');
      value.cdp = { close: () => calls.push('close-controller'), send: async (method, _params, _session, cleanup) => {
        assert.equal(method, 'Browser.close'); assert.equal(cleanup, true); calls.push('normal-close'); value.child.exitCode = 0;
      } };
    },
  });
  assert.equal((await close(owner, { end: 5000 })).closed, true);
  assert.deepEqual(calls, ['retire-transport', 'attachment', 'connect', 'normal-close', 'close-controller']);
});

test('deployment drift stops before Chrome and retains the failed metadata reservation', async () => {
  const f = fixture(); f.deps.metadata = async kind => kind === 'alias' ? { alias: 'drift' } : metadata(kind);
  const result = await s.runScoped(input(), ID, f.deps);
  assert.equal(result.phase, 'stopped'); assert.equal(f.state.launches, 0);
  assert.equal(f.state.record.traffic.counts.metadata, 2); assert.equal(f.state.record.traffic.uncertain, 1);
});
