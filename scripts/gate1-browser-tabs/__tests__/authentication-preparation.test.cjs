'use strict';
/* global structuredClone, Buffer */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const a = require('../authentication-preparation.cjs');
const t = require('../authentication-preparation-traffic.cjs');
const p = require('../authentication-preparation-postflight.cjs');
const d = require('../hosted-csrf-diagnostic.cjs');
const ID = '00000000-0000-4000-8000-000000000001';

/** Construct a synthetic future manifest; validation is not execution approval or a coverage override. */
function plan() {
  return { approval: 'authentication-preparation-01', target: { ...d.TARGET }, buildId: a.BUILD,
    profile: d.PROFILE, sourceSet: 'a'.repeat(64), buildHash: a.BUILD_HASH, buildCompletionReviewed: true,
    limits: { ...t.LIMITS }, ledgerBefore: structuredClone(a.BASELINE), approvedAt: 1000, expiresAt: 2000 };
}

/** Exercise proxy callbacks with mocked HTTP transports so budget tests never bind or forward traffic. */
async function proxyFixture(context, proxyBytes = 4) {
  const server = new EventEmitter();
  server.listen = (_port, _host, ready) => ready(); server.address = () => ({ port: 12345 });
  context.mock.method(http, 'createServer', handler => { server.on('request', handler); return server; });
  context.mock.method(http, 'request', () => Object.assign(new EventEmitter(), {
    end: context.mock.fn(), destroy: context.mock.fn(),
  }));
  const budget = new t.TrafficBudget({ limits: { ...a.OFFLINE, proxyBytes } });
  const proxy = await a.startProxy({ origin: 'http://127.0.0.1:12346', port: 12346 }, budget, []);
  proxy.state.ready = true;
  const socket = Object.assign(new EventEmitter(), { destroy: context.mock.fn(), end: context.mock.fn() });
  server.emit('connection', socket);
  /** Dispatch a synthetic request; its body chunks are emitted separately from socket framing. */
  function request(method = 'GET') {
    const incoming = Object.assign(new EventEmitter(), {
      method, url: 'http://127.0.0.1:12346/login', headers: {}, destroy: context.mock.fn(),
    });
    const response = Object.assign(new EventEmitter(), { end: context.mock.fn() });
    response.writeHead = () => response;
    server.emit('request', incoming, response); return incoming;
  }
  return { server, budget, proxy, socket, request };
}

test('proxy headers and rejected CONNECT traffic do not consume the request body budget', async context => {
  const fixture = await proxyFixture(context, 0);
  fixture.request();
  fixture.socket.emit('data', Buffer.from('GET http://127.0.0.1:12346/login HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  fixture.server.emit('connect', {}, fixture.socket);
  fixture.socket.emit('data', Buffer.from('CONNECT example.test:443 HTTP/1.1\r\n\r\n'));
  assert.equal(fixture.budget.snapshot().counters.proxyBytes, 0);
  assert.equal(fixture.budget.snapshot().counters.proxyConnections, 1);
  assert.equal(fixture.budget.halted, false);
  assert.equal(fixture.socket.destroy.mock.callCount(), 0);
  assert.equal(fixture.proxy.state.forwarded, 1);
  assert.equal(fixture.proxy.state.denied, 1);
});

for (const method of ['GET', 'POST']) test(`proxy counts ${method} body chunks across requests and destroys an over-budget request`, async context => {
  const fixture = await proxyFixture(context);
  const first = fixture.request(method); first.emit('data', Buffer.from('ab'));
  const second = fixture.request(method); second.emit('data', Buffer.from('c')); second.emit('data', Buffer.from('d'));
  assert.equal(fixture.budget.snapshot().counters.proxyBytes, 4);
  assert.equal(fixture.budget.halted, false);
  assert.equal(first.destroy.mock.callCount(), 0); assert.equal(second.destroy.mock.callCount(), 0);
  second.emit('data', Buffer.from('e'));
  assert.equal(second.destroy.mock.callCount(), 1);
  assert.equal(fixture.budget.failure, 'budget'); assert.equal(fixture.budget.halted, true);
  assert.equal(fixture.budget.snapshot().counters.proxyBytes, 4);
  assert.equal(fixture.socket.destroy.mock.callCount(), 0);
  assert.equal(fixture.proxy.state[method === 'GET' ? 'forwarded' : 'denied'], 2);
});

/** Run the real worker orchestration with native boundaries mocked to isolate its final profile check. */
async function profileCleanup(profile, priorFailure = null) {
  let record;
  const expected = 'a'.repeat(64);
  const sandbox = {
    expected, startedAt: Date.now(), path, t, check: t.check, OFFLINE: a.OFFLINE,
    process: new EventEmitter(), CORE: 'mock-runtime', require: () => ({}),
    fs: {
      open: async () => ({ close: async () => {} }), mkdir: async () => {},
      /** Simulate directory preservation or a failed stat without touching the real profile. */
      stat: async file => {
        assert.equal(file, p.PROFILE);
        if (['ENOENT', 'EACCES'].includes(profile)) throw Object.assign(new Error('stat failed'), { code: profile });
        return { isDirectory: () => profile === 'directory' };
      },
    },
    p: { ...p, writeExclusive: async (file, value) => { assert.equal(file, p.ATTEMPT); record = value; return expected; } },
    f: { bounded: action => action() }, step: a.step, verifyIdentity: a.verifyIdentity,
    preflight: async () => { if (priorFailure) throw new t.PreparationError(priorFailure); },
    sourceHash: async () => expected,
    startOrigin: async () => ({ origin: 'http://127.0.0.1:12346', counts: { requests: 2 } }),
    startProxy: async () => ({ state: {} }),
    launch: async () => ({ closed: true, context: { request: { get: async () => ({
      status: () => 200, body: async () => Buffer.from(JSON.stringify({
        error: null, message: 'Success', data: { user: { id: ID } },
      })), dispose: async () => {},
    }) } } }),
    SYNTHETIC_ID: ID,
    observe: async () => ({ page: { goto: async () => {}, evaluate: async () => true },
      observer: { ready: true, allowed: 2, blocked: 1, close: async () => {}, summary: async () => ({}) } }),
    closeBrowser: async () => ({}), closeListeners: async () => {},
  };
  const completion = await vm.runInNewContext(`(${a.runLoopback.toString()})(expected, startedAt)`, sandbox);
  return { record, completion };
}

for (const [profile, priorFailure, failure] of [
  ['directory', null, null], ['ENOENT', null, 'profile'], ['file', null, 'profile'],
  ['EACCES', null, 'profile'], ['ENOENT', 'closure', 'closure'],
]) test(`profile cleanup reports ${profile} with prior failure ${priorFailure}`, async () => {
  const { record, completion } = await profileCleanup(profile, priorFailure);
  assert.equal(record.checks.profilePreserved, profile === 'directory');
  assert.equal(record.checks.localListenersClosed, true);
  assert.equal(record.firstFailure, failure); assert.equal(completion.firstFailure, failure);
  assert.equal(record.phase, failure ? 'stopped' : 'passed'); assert.equal(completion.phase, record.phase);
  assert.equal(completion.receiptFinalized, true);
});

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
