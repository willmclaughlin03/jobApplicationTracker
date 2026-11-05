'use strict';
/* global Buffer, structuredClone, queueMicrotask */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const s = require('../authentication-preparation-scoped.cjs');
const c = require('../authentication-preparation-scoped-contract.cjs');
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

test('source binding includes the decision digest and all ten approved implementation/test files', async () => {
  assert.equal(s.FILES.length, 10); let decision = HASH; let source = HASH;
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

test('deployment drift stops before Chrome and retains the failed metadata reservation', async () => {
  const f = fixture(); f.deps.metadata = async kind => kind === 'alias' ? { alias: 'drift' } : metadata(kind);
  const result = await s.runScoped(input(), ID, f.deps);
  assert.equal(result.phase, 'stopped'); assert.equal(f.state.launches, 0);
  assert.equal(f.state.record.traffic.counts.metadata, 2); assert.equal(f.state.record.traffic.uncertain, 1);
});
