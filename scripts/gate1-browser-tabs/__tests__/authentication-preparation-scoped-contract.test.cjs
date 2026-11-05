'use strict';
/* global structuredClone */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../authentication-preparation-scoped-contract.cjs');
const a = require('../authentication-preparation.cjs');
const d = require('../hosted-csrf-diagnostic.cjs');
const ID = '00000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

/** Construct a strictly synthetic manifest without authorizing native or hosted activity. */
function plan() {
  return { schemaVersion: 2, decision: c.DECISION, approval: 'scoped-authentication-preparation',
    sourceSet: HASH, decisionHash: HASH, toolSet: HASH, qualificationHash: HASH,
    buildHash: a.BUILD_HASH, target: { ...d.TARGET }, buildId: a.BUILD, profile: d.PROFILE,
    limits: { ...c.LIMITS }, ledgerBefore: structuredClone(a.BASELINE), approvedAt: 0, expiresAt: 3600000 };
}

test('strict manifest binds decision, historical target, profile, limits and the session subset', () => {
  assert.equal(c.validatePlan(plan(), ID, 1), true);
  for (const key of ['decision', 'profile', 'buildHash', 'approval']) {
    const value = plan(); value[key] = 'unapproved'; assert.throws(() => c.validatePlan(value, ID, 1), { code: 'schema' });
  }
  for (const mutate of [value => { value.limits.tunnelBytes++; }, value => { value.target.deployment = 'drift'; },
    value => { value.force = true; }, value => { value.ledgerBefore.actual.session++; }]) {
    const value = plan(); mutate(value); assert.throws(() => c.validatePlan(value, ID, 1), { code: 'schema' });
  }
  assert.throws(() => c.validatePlan(plan(), ID, 3600000), { code: 'expired' });
  assert.throws(() => c.validatePlan(plan(), 'private-invalid-identity', 1), error => error.message === 'identity');
});

test('concurrent session/application reservations are atomic at the tighter cap', async () => {
  const budget = new c.ScopedBudget({ limits: { ...c.LIMITS, application: 2, session: 1 } });
  await Promise.allSettled([Promise.resolve().then(() => budget.reserve('session')),
    Promise.resolve().then(() => budget.reserve('application')), Promise.resolve().then(() => budget.reserve('session'))]);
  assert.deepEqual([budget.counts.application, budget.counts.session, budget.records.size], [2, 1, 2]);
  assert.equal(budget.failure, 'budget'); assert.equal(budget.abort.signal.aborted, true);
});

test('failed and uncertain reservations remain charged; acknowledgements are not confirmations', () => {
  const budget = new c.ScopedBudget(); const id = budget.reserve('session'); budget.acknowledge(id);
  assert.equal(budget.snapshot().confirmed, 0); assert.equal(budget.snapshot().uncertain, 1);
  budget.finish(id, false); budget.stop('closure');
  assert.equal(budget.failure, 'operation'); assert.equal(budget.counts.application, 1);
  assert.throws(() => budget.reserve('session'), { code: 'stopped' });
});

test('HTTP concurrency, retained records and event limits stop without connection-count assumptions', () => {
  for (const [limit, action] of [['httpConcurrent', budget => budget.reserve('application')],
    ['records', budget => budget.reserve('application')], ['events', budget => budget.event()]]) {
    const budget = new c.ScopedBudget({ limits: { ...c.LIMITS, [limit]: 1 } });
    action(budget); assert.throws(() => action(budget)); assert.equal(budget.abort.signal.aborted, true);
  }
});

test('deadline is permanent and body allowance stays distinct from tunnel bytes', () => {
  let now = 0; const budget = new c.ScopedBudget({ clock: () => now, limits: { ...c.LIMITS, proxyBytes: 3 } });
  budget.body(3); assert.equal(budget.bodyBytes, 3); assert.throws(() => budget.body(1), { code: 'budget' });
  const timed = new c.ScopedBudget({ clock: () => now }); now = timed.deadline;
  assert.throws(() => timed.check(), { code: 'deadline' }); now = 0;
  assert.throws(() => timed.check(), { code: 'stopped' });
});

test('old receipts, extra private fields and changed qualification provenance cannot unlock execution', () => {
  const value = { schemaVersion: 2, scope: 'scoped_authentication_native', sourceSet: HASH,
    decisionHash: HASH, toolSet: HASH, attemptHash: HASH, completionHash: HASH, phase: 'passed',
    checks: Object.fromEntries(c.QUALIFICATION_CHECKS.map(key => [key, true])), browserTrafficMeasured: false, hostedQualified: false };
  const review = { qualificationHash: HASH, sourceSet: HASH, decisionHash: HASH, toolSet: HASH, completionHash: HASH };
  assert.equal(c.validateQualification(value, HASH, plan(), review), true);
  for (const altered of [{ ...value, schemaVersion: 1 }, { ...value, identity: ID },
    { ...value, sourceSet: 'b'.repeat(64) }, { ...value, checks: { ...value.checks, restoredWorkerBlocked: false } }]) {
    assert.throws(() => c.validateQualification(altered, HASH, plan(), review));
  }
  assert.throws(() => c.validateQualification(value, 'b'.repeat(64), plan(), review), { code: 'integrity' });
  assert.throws(() => c.validateQualification(value, HASH, plan(), { approved: true }), { code: 'integrity' });
});
