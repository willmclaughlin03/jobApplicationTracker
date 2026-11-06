'use strict';
/* global structuredClone */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const n = require('../authentication-preparation-scoped-native-contract.cjs');
const c = require('../authentication-preparation-scoped-contract.cjs');
const d = require('../hosted-csrf-diagnostic.cjs');
const HASH = 'a'.repeat(64);

/** Build an in-memory review only; it is never saved or supplied to the native CLI. */
function review() {
  return { sourceSet: HASH, decisionHash: HASH, toolSet: HASH, certificateHash: HASH, keyHash: HASH,
    scope: 'scoped-authentication-native-execution-review-v1', operator: 'Codex', owner: 'project-owner',
    directory: n.DIRECTORY, command: 'node scripts/gate1-browser-tabs/authentication-preparation-scoped-native.cjs --execute-native <execution-review-sha256>',
    cases: structuredClone(n.CASES), limits: { ...n.LIMITS }, spki: n.SPKI, profiles: [...n.PROFILES], ports: [...n.PORTS], approvedAt: 0, expiresAt: 480000 };
}

test('native review freezes paths, command, cases, resources, pin and short-lived provenance', () => {
  assert.equal(n.validateReview(review(), 1000).directory, n.DIRECTORY);
  const changes = [value => { value.directory += '-02'; }, value => { value.ports[0]++; },
    value => { value.profiles[0] = d.PROFILE; }, value => { value.limits.launches++; },
    value => { value.cases[0].launches++; }, value => { value.sourceSet = 'not a digest'; },
    value => { value.spki = HASH; }, value => { value.force = true; },
    value => { value.command += ' --force'; }, value => { value.owner = 'agent'; }];
  for (const change of changes) { const value = review(); change(value); assert.throws(() => n.validateReview(value, 1000)); }
  for (const [approvedAt, expiresAt] of [[1001, 480000], [0, 1000], [0, 3600001]]) {
    assert.throws(() => n.validateReview({ ...review(), approvedAt, expiresAt }, 1000), { code: 'expired' });
  }
});

test('only exact loopback GET routes are admitted, including the separate frame authority', () => {
  assert.equal(n.classify(`${n.ORIGIN}/api/auth/session`, 'GET'), 'session');
  assert.equal(n.classify(`${n.FRAME_ORIGIN}/frame`, 'GET'), 'application');
  for (const url of [`${n.ORIGIN}/api/auth/session?x=1`, `${n.ORIGIN}/frame`, `${n.FRAME_ORIGIN}/login`,
    `${n.ORIGIN}/login#x`, `${n.ORIGIN}/a/../login`, 'https://localhost:18443/login', 'https://127.0.0.1:18444/login',
    'https://user@127.0.0.1:18443/login', `${d.ORIGIN}/login`, 'file:///login']) assert.throws(() => n.classify(url, 'GET'));
  assert.throws(() => n.classify(`${n.ORIGIN}/login`, 'POST')); assert.throws(() => n.profile('../lifecycle'));
  assert.throws(() => n.profile(d.PROFILE));
});

/** Exercise every classifier guard with synthetic inputs; the reason never contains the rejected input. */
test('native route attribution distinguishes fixed guards without changing classification or reserving traffic', () => {
  const cases = [['not a private URL', 'GET', 'route_url'], [`${n.ORIGIN}/login`, 'POST', 'route_method'],
    ['https://private:secret@127.0.0.1:18443/login', 'GET', 'route_credentials'],
    [`${n.ORIGIN}/login?private=secret`, 'GET', 'route_query_fragment'],
    [`${n.ORIGIN}/login#private`, 'GET', 'route_query_fragment'],
    [`${n.ORIGIN}/a/../login`, 'GET', 'route_normalization'],
    ['https://private.test/login', 'GET', 'route_origin_path'], [`${n.FRAME_ORIGIN}/login`, 'GET', 'route_origin_path']];
  for (const [url, method, reason] of cases) {
    const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
    assert.throws(() => n.classify(url, method, budget), { code: 'destination', message: 'destination' });
    assert.equal(budget.destinationReason, reason); assert.equal(budget.failure, 'destination');
    root.stop('destination'); assert.equal(root.destinationReason, reason);
    assert.equal(Object.values(root.totals).every(value => value === 0), true);
  }
  const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
  assert.equal(n.classify(`${n.ORIGIN}/api/auth/session`, 'GET', budget), 'session');
  assert.equal(n.classify(`${n.FRAME_ORIGIN}/frame`, 'GET', budget), 'application');
  assert.equal(root.failure, null); assert.equal(budget.destinationReason, null);
});

/** Abort listeners run synchronously, so the triggering guard must be retained before they reject again. */
test('first destination reason survives reentrant abort callbacks and root propagation', () => {
  for (const source of ['case', 'root']) {
    const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
    budget.abort.signal.addEventListener('abort', () => {
      budget.destination('proxy_parser_error'); root.destination('fixture_host');
    }, { once: true });
    if (source === 'case') budget.destination('proxy_authority'); else root.destination('fixture_body');
    const reason = source === 'case' ? 'proxy_authority' : 'fixture_body';
    root.stop('destination'); root.destination('fixture_content_length'); budget.destination('proxy_http_request');
    assert.equal(root.failure, 'destination'); assert.equal(root.destinationReason, reason);
    assert.equal(budget.failure, 'destination'); assert.equal(budget.abort.signal.aborted, true);
    assert.throws(() => budget.reserve('application'));
  }
});

/** A generic stop must retain the active case's cause before cleanup retires that budget. */
test('generic native stops promote the original active failure and retain it after cleanup', () => {
  for (const failure of ['destination', 'observation']) for (const alreadyStopped of [false, true]) {
    const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
    if (failure === 'destination') budget.destination('proxy_authority'); else budget.stop(failure);
    // Model an earlier catch that has already stored only the generic check error on the root.
    if (alreadyStopped) root.failure = 'stopped';
    assert.throws(() => budget.check(), { code: 'stopped' });
    root.stop('stopped'); root.stop('stopped'); root.finishCase(budget); root.stop('stopped');
    assert.equal(root.failure, failure); assert.equal(root.destinationReason, failure === 'destination' ? 'proxy_authority' : null);
    assert.equal(budget.failure, failure); assert.equal(root.active, null);
  }
});

/** Expected negatives and later guards cannot supply a cause for an unrelated generic stop. */
test('generic native stops do not borrow retired failures or later destination attribution', () => {
  const root = new n.NativeLedger(0, 480000, () => 1000); const retired = new n.NativeBudget(root, n.CASES[2]);
  retired.stop('cancelled'); root.finishCase(retired); root.check();
  const active = new n.NativeBudget(root, n.CASES[3]); root.stop('stopped');
  active.destination('proxy_authority'); root.destination('fixture_host'); root.stop('stopped');
  assert.equal(root.failure, 'stopped'); assert.equal(root.destinationReason, null);
  assert.equal(active.failure, 'stopped'); assert.equal(active.destinationReason, null);
});

/** Missing attribution is never filled from cleanup, an earlier stop or a retired case's callbacks. */
test('earlier failures and retired native budgets cannot acquire a later destination reason', () => {
  for (const scope of ['case', 'root']) {
    for (const failure of ['cancelled', 'deadline', 'destination']) {
      const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
      (scope === 'case' ? budget : root).stop(failure);
      budget.destination('proxy_authority'); root.stop(failure); root.destination('fixture_host');
      assert.equal(root.failure, failure); assert.equal(root.destinationReason, null); assert.equal(budget.destinationReason, null);
    }
  }
  const root = new n.NativeLedger(0, 480000, () => 1000); const old = new n.NativeBudget(root, n.CASES[0]);
  root.finishCase(old); const active = new n.NativeBudget(root, n.CASES[1]); old.destination('proxy_authority');
  assert.equal(old.destinationReason, null); assert.equal(active.failure, null); assert.equal(root.destinationReason, null);
  active.destination('proxy_method'); root.stop('destination'); assert.equal(root.destinationReason, 'proxy_method');
});

/** Arbitrary diagnostics cannot become retained reasons, even through the attribution helper itself. */
test('destination attribution rejects unknown and private reasons before mutating the native ledger', () => {
  const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
  for (const reason of ['https://private.test/?token=secret', 'unknown', { url: 'private' }]) {
    assert.throws(() => root.destination(reason), { code: 'schema' });
    assert.throws(() => budget.destination(reason), { code: 'schema' });
    assert.throws(() => n.requireDestination(false, reason, budget), { code: 'schema' });
  }
  assert.equal(root.failure, null); assert.equal(budget.failure, null); assert.equal(root.destinationReason, null);
  assert.throws(() => n.requireDestination(false, 'route_url', {}), { code: 'schema' });
});

test('expected local stops retain cumulative reservations and cannot renew the original clock', () => {
  let now = 1000; const root = new n.NativeLedger(now, 481000, () => now);
  const first = new n.NativeBudget(root, n.CASES[2]);
  first.reserve('session', 'requestClient'); first.stop('cancelled'); root.finishCase(first);
  const second = new n.NativeBudget(root, n.CASES[3]);
  assert.equal(second.deadline, 361000); assert.equal(root.totals.session, 1); assert.equal(root.totals.application, 1);
  assert.equal(first.snapshot().uncertain, 1); assert.throws(() => first.reserve('application'));
  second.reserve('session', 'requestClient'); assert.equal(root.totals.application, 2);
  now = 361000; assert.throws(() => second.check(), { code: 'deadline' }); assert.equal(root.failure, 'deadline');
});

test('cumulative request-client, record, event, command, tunnel and connection caps cannot reset between cases', () => {
  for (const [field, cap, action] of [['requestClient', 8, budget => budget.reserve('session', 'requestClient')],
    ['records', 256, budget => budget.observeSlot()], ['events', 8192, budget => budget.event()],
    ['commands', 2048, budget => budget.command()], ['proxyConnections', 256, budget => budget.connection()],
    ['tunnelBytes', 16777216, budget => budget.tunnel('upstream', 1)]]) {
    const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
    root.totals[field] = cap; assert.throws(() => action(budget), { code: 'budget' });
    assert.equal(root.totals[field], cap); assert.equal(root.failure, 'budget'); assert.equal(budget.abort.signal.aborted, true);
  }
});

test('Network-first storage is charged once and unpaired observations remain charged after stop', () => {
  const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[7]);
  const slot = budget.observeSlot(); assert.equal(root.totals.records, 1); assert.equal(budget.snapshot().unreservedObservations, 1);
  budget.reserve('application', 'page', slot); assert.equal(root.totals.records, 1);
  budget.observeSlot(); budget.stop('observation'); assert.equal(root.totals.records, 2); assert.equal(budget.snapshot().unreservedObservations, 1);
});

test('case ownership prevents concurrent Chrome and cannot release a surviving connection', () => {
  const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
  budget.launch(); assert.throws(() => budget.launch(), { code: 'budget' });
  assert.equal(root.totals.launches, 1); assert.throws(() => root.finishCase(budget));
  assert.throws(() => new n.NativeBudget(root, n.CASES[1]));
});

test('every mandatory check requires all predetermined native and labeled fault witnesses', () => {
  const results = n.CASES.map(item => ({ id: item.id, mode: item.mode, launches: item.launches,
    failure: item.expected, outcome: 'passed', cleanup: true,
    witnesses: Object.fromEntries(n.WITNESSES[item.id].map(key => [key, true])) }));
  assert.deepEqual(Object.keys(n.qualificationChecks(results)), c.QUALIFICATION_CHECKS);
  for (let index = 0; index < results.length; index++) {
    for (const key of Object.keys(results[index].witnesses)) {
      const copy = structuredClone(results); copy[index].witnesses[key] = false; assert.throws(() => n.qualificationChecks(copy));
    }
  }
  const copy = structuredClone(results); copy[4].mode = 'native'; assert.throws(() => n.qualificationChecks(copy));
  assert.throws(() => n.qualificationChecks(results.slice(1)));
});
