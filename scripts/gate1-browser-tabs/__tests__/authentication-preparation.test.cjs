'use strict';
/* global structuredClone, Buffer */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const a = require('../authentication-preparation.cjs');
const t = require('../authentication-preparation-traffic.cjs');
const d = require('../hosted-csrf-diagnostic.cjs');
const ID = '00000000-0000-4000-8000-000000000001';

/** Construct a synthetic future manifest; validation is not execution approval or a coverage override. */
function plan() {
  return { approval: 'authentication-preparation-01', target: { ...d.TARGET }, buildId: a.BUILD,
    profile: d.PROFILE, sourceSet: 'a'.repeat(64), buildHash: a.BUILD_HASH, buildCompletionReviewed: true,
    limits: { ...t.LIMITS }, ledgerBefore: structuredClone(a.BASELINE), approvedAt: 1000, expiresAt: 2000 };
}

test('strict proposal validation preserves consumed build traffic exactly once', () => {
  assert.equal(a.validatePlan(plan(), ID, 1500), true);
  assert.deepEqual(a.BASELINE.actual, { application: 150, static: 150, session: 52 });
  assert.deepEqual(a.BASELINE.conservative, { application: 151, static: 150, session: 52 });
});

for (const [name, mutate] of Object.entries({
  target: value => { value.target.deployment = 'different'; },
  source: value => { value.sourceSet = 'invalid'; },
  build: value => { value.buildId = 'different'; },
  receipt: value => { value.buildHash = 'a'.repeat(64); },
  completion: value => { value.buildCompletionReviewed = false; },
  budget: value => { value.limits.application++; },
  ledger: value => { value.ledgerBefore.actual.application++; },
  profile: value => { value.profile = 'existing-personal-profile'; },
  approval: value => { value.approval = 'old-approval'; },
  extra: value => { value.executeAnyway = true; },
  extraTarget: value => { value.target.alias = 'unapproved'; },
})) test(`future proposal rejects ${name} drift`, () => {
  const value = plan(); mutate(value); assert.throws(() => a.validatePlan(value, ID, 1500), { code: 'schema' });
});

test('expiry, future approval and excessive validity fail before execution', () => {
  assert.throws(() => a.validatePlan(plan(), ID, 2000), { code: 'expired' });
  assert.throws(() => a.validatePlan(plan(), ID, 999), { code: 'expired' });
  const value = plan(); value.expiresAt = 4000000;
  assert.throws(() => a.validatePlan(value, ID, 1500), { code: 'expired' });
});

test('identity must be separately supplied and exactly match; mismatch errors contain no identity', () => {
  const response = { error: null, message: 'Success', data: { user: { id: ID } } };
  assert.equal(a.verifyIdentity(response, ID), true);
  for (const identity of [undefined, '', 'email@example.test', '00000000-0000-4000-8000-000000000002']) {
    assert.throws(() => a.verifyIdentity(response, identity), error => error.code === 'identity' && !error.message.includes(ID));
  }
  assert.throws(() => a.validatePlan(plan(), undefined, 1500), { code: 'identity' });
  assert.throws(() => a.verifyIdentity({ ...response, error: 'denied' }, ID), { code: 'identity' });
});

test('late cancellation prevents using a completed operation or dispatching its next step', async () => {
  const budget = new t.TrafficBudget(); let calls = 0;
  await assert.rejects(a.step(budget, async () => { calls++; budget.stop('cancelled'); return 'late'; }), { code: 'stopped' });
  await assert.rejects(a.step(budget, async () => { calls++; }), { code: 'stopped' }); assert.equal(calls, 1);
});

test('live command fails before filesystem reads, credentials, provider access or browser startup', async () => {
  await assert.rejects(a.main(['--execute-reviewed-manifest']), { code: 'coverage_unqualified' });
  await assert.rejects(a.main(['--execute-reviewed-manifest', '--force']), { code: 'coverage_unqualified' });
  await assert.rejects(a.main(['--qualify-loopback']), { code: 'arguments' });
  await assert.rejects(a.main(['--loopback-worker', 'a'.repeat(64)]), { code: 'approval' });
});

test('normal closure must include zero process exit and cannot accept a forced termination', async () => {
  const owner = { closed: true, child: { exitCode: null } };
  await assert.rejects(a.closeBrowser(owner, {}, Date.now() + 10), { code: 'closure' });
});

test('source binding permits only the two observed checkout line-ending conversions', () => {
  const lf = Buffer.from('const value = 1;\n'); const crlf = Buffer.from('const value = 1;\r\n');
  assert.equal(a.dependencyMatches('hosted-csrf-build-attribution.cjs', crlf, lf), true);
  assert.equal(a.dependencyMatches('__tests__/hosted-csrf-build-attribution.test.cjs', crlf, lf), true);
  assert.equal(a.dependencyMatches('request-client-isolation.cjs', crlf, lf), false);
  assert.equal(a.dependencyMatches('hosted-csrf-build-attribution.cjs', Buffer.from('const value = 2;\n'), lf), false);
  assert.equal(a.dependencyMatches('request-client-isolation.cjs', lf, lf), true);
});

module.exports = { plan };
