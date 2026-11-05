'use strict';
/* global Buffer */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ScopedBudget, LIMITS } = require('../authentication-preparation-scoped-contract.cjs');
const { CdpConnection, ScopedObserver, MESSAGE_BYTES } = require('../authentication-preparation-scoped-observer.cjs');
const { ORIGIN } = require('../hosted-csrf-diagnostic.cjs');

/** Supply an already supported paused target while retaining the observer's actual event handling. */
function fixture(limits = {}) {
  const budget = new ScopedBudget({ limits: { ...LIMITS, ...limits } }); const connection = new EventEmitter();
  connection.calls = []; connection.send = async (method, params, session) => { connection.calls.push({ method, params, session }); return {}; };
  const observer = new ScopedObserver(connection, budget); observer.targets.set('session', { ready: true });
  return { budget, connection, observer };
}

/** Send a synthetic protocol event; URL values exist only inside this ephemeral test transport. */
function emit(f, method, params) { f.connection.emit('event', { method, params, sessionId: 'session' }); }

test('all target guards precede resume and unpaused/worker targets stop', async () => {
  const f = fixture(); f.observer.targets.clear();
  f.observer.attach({ sessionId: 'new', waitingForDebugger: true, targetInfo: { targetId: 'page', type: 'page', url: 'about:blank' } });
  await Promise.all([...f.observer.tasks]);
  const methods = f.connection.calls.map(call => call.method);
  assert.equal(methods.at(-1), 'Runtime.runIfWaitingForDebugger'); assert.ok(methods.indexOf('Fetch.enable') < methods.length - 1);
  for (const type of ['service_worker', 'shared_worker', 'worker']) {
    assert.throws(() => f.observer.attach({ sessionId: type, waitingForDebugger: true, targetInfo: { targetId: type, type } }));
  }
  f.observer.close();
  const other = fixture(); assert.throws(() => other.observer.attach({ sessionId: 'x', waitingForDebugger: false,
    targetInfo: { targetId: 'x', type: 'page', url: 'about:blank' } }), { code: 'observation' }); other.observer.close();
});

test('redirects reserve before continuation and reconcile reused Network IDs independently', async () => {
  const f = fixture();
  emit(f, 'Network.requestWillBeSent', { requestId: 'network', request: { url: `${ORIGIN}/login`, method: 'GET' } });
  emit(f, 'Fetch.requestPaused', { requestId: 'fetch1', networkId: 'network', request: { url: `${ORIGIN}/login`, method: 'GET' } });
  await Promise.all([...f.observer.tasks]); assert.equal(f.budget.counts.application, 1);
  emit(f, 'Network.requestWillBeSent', { requestId: 'network', redirectResponse: { status: 302 }, request: { url: `${ORIGIN}/`, method: 'GET' } });
  emit(f, 'Fetch.requestPaused', { requestId: 'fetch2', networkId: 'network', request: { url: `${ORIGIN}/`, method: 'GET' } });
  emit(f, 'Network.responseReceived', { requestId: 'network', response: {} });
  emit(f, 'Network.loadingFinished', { requestId: 'network' });
  assert.equal((await f.observer.summary()).pairedPageEvents, true); assert.equal(f.budget.counts.application, 2);
  assert.equal(f.budget.snapshot().uncertain, 0); assert.equal(f.connection.calls.filter(call => call.method === 'Fetch.continueRequest').length, 2);
  f.observer.close();
});

test('Fetch-first ordering is paired; missing Network events cannot pass', async () => {
  const f = fixture();
  emit(f, 'Fetch.requestPaused', { requestId: 'f', networkId: 'n', request: { url: `${ORIGIN}/`, method: 'GET' } });
  await Promise.all([...f.observer.tasks]); await assert.rejects(f.observer.summary(), { code: 'observation' }); f.observer.close();
  const good = fixture(); emit(good, 'Fetch.requestPaused', { requestId: 'f', networkId: 'n', request: { url: `${ORIGIN}/`, method: 'GET' } });
  emit(good, 'Network.requestWillBeSent', { requestId: 'n', request: { url: `${ORIGIN}/`, method: 'GET' } });
  emit(good, 'Network.responseReceived', { requestId: 'n', response: {} }); emit(good, 'Network.loadingFinished', { requestId: 'n' });
  await good.observer.summary(); good.observer.close();
});

test('unknown destinations, lost observation and unreadable POST bodies stop before continuation', async () => {
  for (const request of [{ url: 'https://unknown.test/', method: 'GET' },
    { url: `${ORIGIN}/`, method: 'GET', hasPostData: true }]) {
    const f = fixture(); emit(f, 'Fetch.requestPaused', { requestId: 'f', networkId: 'n', request });
    await Promise.all([...f.observer.tasks]); assert.ok(f.budget.failure);
    assert.equal(f.connection.calls.length, 0); f.observer.close();
  }
  const f = fixture(); emit(f, 'Target.detachedFromTarget', {}); assert.equal(f.budget.failure, 'observation'); f.observer.close();
});

test('pending CDP commands and oversized protocol frames are bounded and errors remain categorical', async () => {
  const budget = new ScopedBudget({ limits: { ...LIMITS, pendingCommands: 1 } }); const socket = new EventEmitter();
  socket.send = () => {}; socket.terminate = () => {};
  const connection = new CdpConnection(socket, budget);
  const pending = connection.send('Network.enable').catch(error => error.code);
  await assert.rejects(connection.send('Fetch.enable'), { code: 'observation' }); connection.close();
  assert.equal(await pending, 'observation');
  const second = new ScopedBudget(); const other = new CdpConnection(socket, second);
  other.receive(Buffer.alloc(MESSAGE_BYTES + 1)); assert.equal(second.failure, 'observation'); assert.equal(other.closed, true);
});

/** Context-loss tolerance is opt-in for the manual evaluation only; protocol details must never escape as errors. */
test('context-loss polling policy leaves other commands and unknown errors fatal', async () => {
  for (const [method, options, error] of [
    ['Runtime.evaluate', undefined, { code: -32000, message: 'Execution context was destroyed.' }],
    ['Page.navigate', { contextLossAsFalse: true }, { code: -32000, message: 'Execution context was destroyed.' }],
    ['Runtime.evaluate', { contextLossAsFalse: true }, { code: -32602, message: 'Execution context was destroyed.' }],
    ['Runtime.evaluate', { contextLossAsFalse: true }, { code: -32000, message: 'Target crashed' }],
    ['Runtime.evaluate', { contextLossAsFalse: true }, { code: -32000, message: 'Execution context was destroyed. private suffix' }],
  ]) {
    const budget = new ScopedBudget(); const socket = new EventEmitter();
    socket.send = () => {}; socket.terminate = () => {}; const connection = new CdpConnection(socket, budget);
    const pending = connection.send(method, {}, 'session', false, options);
    connection.receive(Buffer.from(JSON.stringify({ id: 1, sessionId: 'session', error })));
    try {
      await assert.rejects(pending, { code: 'observation', message: 'observation' });
      assert.equal(budget.failure, 'observation'); assert.equal(connection.pending.size, 0);
    } finally { connection.close(); }
  }
});

test('failed continuation remains uncertain and cannot be promoted by later events', async () => {
  const f = fixture(); f.connection.send = async () => { throw new Error('private protocol payload'); };
  emit(f, 'Fetch.requestPaused', { requestId: 'f', networkId: 'n', request: { url: `${ORIGIN}/`, method: 'GET' } });
  await Promise.all([...f.observer.tasks]); assert.equal(f.budget.snapshot().admitted, 1);
  assert.equal(f.budget.snapshot().uncertain, 1); assert.equal(f.budget.failure, 'operation'); f.observer.close();
});

test('matching IDs with differing method/URL cannot reconcile or dispatch under the wrong category', async () => {
  const f = fixture();
  emit(f, 'Network.requestWillBeSent', { requestId: 'n', request: { url: `${ORIGIN}/api/auth/session`, method: 'GET' } });
  emit(f, 'Fetch.requestPaused', { requestId: 'f', networkId: 'n', request: { url: `${ORIGIN}/`, method: 'GET' } });
  await Promise.all([...f.observer.tasks]); assert.equal(f.budget.failure, 'observation');
  assert.equal(f.connection.calls.length, 0); f.observer.close();
});

test('second OAuth initiation and provider refusal stop without any allowance expansion', async () => {
  const f = fixture(); f.observer.phase = 'oauth';
  const request = { url: 'https://apxfjggdcybjticrnbpk.supabase.co/auth/v1/authorize', method: 'GET' };
  emit(f, 'Fetch.requestPaused', { requestId: 'f1', networkId: 'n1', request });
  await Promise.all([...f.observer.tasks]);
  emit(f, 'Fetch.requestPaused', { requestId: 'f2', networkId: 'n2', request });
  await Promise.all([...f.observer.tasks]); assert.equal(f.budget.failure, 'budget');
  assert.equal(f.budget.counts.supabase, 1); f.observer.close();
  const other = fixture(); other.observer.phase = 'oauth';
  emit(other, 'Network.requestWillBeSent', { requestId: 'n', request });
  emit(other, 'Network.responseReceived', { requestId: 'n', response: { status: 403 } });
  assert.equal(other.budget.failure, 'operation'); other.observer.close();
});

test('attached-target and relevant-event caps are independent of HTTP connection counts', () => {
  const f = fixture({ targetSessions: 1 });
  assert.throws(() => f.observer.attach({ sessionId: 'new', waitingForDebugger: true,
    targetInfo: { targetId: 'page', type: 'page', url: 'about:blank' } }), { code: 'observation' }); f.observer.close();
  const other = fixture({ events: 1 }); emit(other, 'Target.targetInfoChanged', {}); emit(other, 'Target.targetInfoChanged', {});
  assert.equal(other.budget.failure, 'observation'); other.observer.close();
});

test('Network-only observations consume shared HTTP capacity before Fetch admission', async () => {
  const f = fixture({ httpConcurrent: 1 });
  emit(f, 'Network.requestWillBeSent', { requestId: 'n1', request: { url: `${ORIGIN}/`, method: 'GET' } });
  assert.equal(f.budget.snapshot().unreservedObservations, 1);
  emit(f, 'Fetch.requestPaused', { requestId: 'f1', networkId: 'n1', request: { url: `${ORIGIN}/`, method: 'GET' } });
  await Promise.all([...f.observer.tasks]); assert.equal(f.budget.inFlight, 1);
  assert.equal(f.budget.snapshot().unreservedObservations, 0);
  emit(f, 'Network.requestWillBeSent', { requestId: 'n2', request: { url: `${ORIGIN}/`, method: 'GET' } });
  assert.equal(f.budget.failure, 'budget'); assert.equal(f.budget.counts.application, 1); f.observer.close();
});
