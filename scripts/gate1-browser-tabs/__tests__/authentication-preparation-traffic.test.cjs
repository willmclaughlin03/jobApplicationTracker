'use strict';
/* global URL */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const t = require('../authentication-preparation-traffic.cjs');
const d = require('../hosted-csrf-diagnostic.cjs');
const ORIGIN = `https://${d.TARGET.canonical}`;

/** Supply a CDP transport with complete call ordering and no native networking. */
function session() {
  const mock = new EventEmitter(); mock.calls = [];
  mock.send = async (method, params) => { mock.calls.push({ method, params }); };
  mock.detach = async () => {};
  return mock;
}

test('finite destination policy admits only proposed phase/method/host combinations', () => {
  for (const route of t.ROUTES) assert.equal(t.classifyDestination(ORIGIN + route, 'GET', 'login'),
    route === '/api/auth/session' ? 'session' : 'application');
  assert.equal(t.classifyDestination(ORIGIN + '/_next/static/chunk.js', 'GET', 'login'), 'canonicalStatic');
  assert.equal(t.classifyDestination(ORIGIN + '/favicon.png', 'GET', 'verify'), 'canonicalStatic');
  for (const route of ['/auth/v1/authorize', '/auth/v1/callback'])
    assert.equal(t.classifyDestination(`https://${t.SUPABASE}${route}?code=synthetic`, 'GET', 'oauth'), 'supabase');
  for (const method of ['GET', 'POST']) assert.equal(t.classifyDestination('https://accounts.google.com/o/oauth2/v2/auth', method, 'oauth'), 'google');
  for (const host of t.SUPPORT) assert.equal(t.classifyDestination(`https://${host}/resource`, 'GET', 'oauth'), 'providerStatic');
});

for (const [url, method, phase] of [
  [ORIGIN + '/api', 'POST', 'login'], [ORIGIN + '/api/billing/checkout', 'GET', 'verify'],
  [ORIGIN + '/api/auth/session?extra=1', 'GET', 'restart'], [ORIGIN + '/login', 'GET', 'restart'],
  ['https://api.vercel.com/v9/projects/id', 'GET', 'oauth'], ['https://accounts.google.com/', 'GET', 'login'],
  ['https://accounts.google.com/', 'DELETE', 'oauth'], ['https://accounts.google.com.evil.test/', 'GET', 'oauth'],
  ['https://www.gstatic.com/a', 'POST', 'oauth'], ['https://unknown.gstatic.com/a', 'GET', 'oauth'],
  [ORIGIN.replace('https:', 'http:') + '/', 'GET', 'login'], [ORIGIN + ':444/', 'GET', 'login'],
  ['https://user:secret@accounts.google.com/', 'GET', 'oauth'], [ORIGIN + '/login#secret', 'GET', 'login'],
  [ORIGIN + '/a/../api/billing', 'GET', 'verify'], ['https://accounts.google.com\\evil', 'GET', 'oauth'],
  [ORIGIN + '/', 'GET', 'closed'], ['not a URL', 'GET', 'login'],
]) test(`reject destination case ${JSON.stringify([new URL('https://example.test').protocol, method, phase, url.length])}`, () => {
  assert.throws(() => t.classifyDestination(url, method, phase), { code: 'destination' });
});

test('session reservations consume application allowance atomically and stop at the tighter cap', () => {
  const budget = new t.TrafficBudget({ limits: { ...t.LIMITS, application: 2, session: 1 } });
  budget.reserve('session'); budget.reserve('application');
  assert.throws(() => budget.reserve('session'), { code: 'budget' });
  assert.deepEqual(budget.snapshot().requests.actual, { application: 2, static: 0, session: 1 });
  assert.throws(() => budget.reserve('google'), { code: 'stopped' });
});

test('failed transport reservations remain charged and provider static enters cumulative increments', () => {
  const budget = new t.TrafficBudget(); budget.reserve('google'); budget.reserve('canonicalStatic'); budget.reserve('providerStatic');
  budget.stop('operation'); budget.stop('identity');
  assert.equal(budget.snapshot().counters.google, 1); assert.equal(budget.snapshot().requests.actual.static, 2);
  assert.equal(budget.snapshot().firstFailure, 'operation');
});

test('deadline and cancellation permanently prevent later dispatch', () => {
  let now = 0; const budget = new t.TrafficBudget({ clock: () => now });
  now = t.LIMITS.wholeMs - t.LIMITS.cleanupMs;
  assert.throws(() => budget.check(), { code: 'deadline' }); now = 0;
  assert.throws(() => budget.reserve('application'), { code: 'stopped' });
  const cancelled = new t.TrafficBudget(); cancelled.stop('cancelled');
  assert.throws(() => cancelled.reserve('launches'), { code: 'stopped' });
});

test('every redirect hop reserves before continuation, even with a reused Network ID', async () => {
  const transport = session(); const budget = new t.TrafficBudget();
  const observer = new t.PageTrafficObserver(transport, budget, () => 'application');
  await observer.start();
  for (const id of ['hop1', 'hop2']) {
    observer.observe({ requestId: 'network' });
    await observer.dispatch({ requestId: id, networkId: 'network', request: { url: ORIGIN, method: 'GET' } });
  }
  assert.equal(budget.snapshot().requests.actual.application, 2);
  assert.deepEqual(await observer.summary(), { allowed: 2, blocked: 0, pairedPageEvents: true,
    browserTrafficMeasured: false, coverage: 'page_http_only' });
  assert.equal(transport.calls.filter(call => call.method === 'Fetch.continueRequest').length, 2);
  assert.ok(transport.calls.findIndex(call => call.method === 'Fetch.enable')
    < transport.calls.findIndex(call => call.method === 'Fetch.continueRequest'));
  await observer.close(); assert.equal(transport.listenerCount('Fetch.requestPaused'), 0);
});

test('unknown redirect destination is aborted before continuation and latches failure', async () => {
  const transport = session(); const budget = new t.TrafficBudget();
  const observer = new t.PageTrafficObserver(transport, budget, (url, method) => t.classifyDestination(url, method, 'login'));
  await observer.start(); observer.observe({ requestId: 'id' });
  await observer.dispatch({ requestId: 'hop', networkId: 'id', request: { url: 'https://unexpected.test/?secret=synthetic', method: 'GET' } });
  assert.equal(transport.calls.filter(call => call.method === 'Fetch.continueRequest').length, 0);
  assert.equal(transport.calls.at(-1).method, 'Fetch.failRequest');
  assert.equal(budget.failure, 'destination'); assert.equal(JSON.stringify(budget.snapshot()).includes('synthetic'), false);
});

test('absent observation, disconnected targets, WebSockets and missing IDs cannot qualify', async () => {
  for (const mode of ['missing_event', 'detached', 'socket', 'missing_id']) {
    const transport = session(); const budget = new t.TrafficBudget();
    const observer = new t.PageTrafficObserver(transport, budget, () => 'application'); await observer.start();
    if (mode === 'missing_event') observer.observe({ requestId: 'unpaired' });
    if (mode === 'detached') transport.emit('Disconnected');
    if (mode === 'socket') transport.emit('Network.webSocketCreated');
    if (mode === 'missing_id') await observer.dispatch({ requestId: 'missing', request: {} });
    await assert.rejects(observer.summary()); await observer.close();
  }
});

test('readiness failure and failed continuation never produce a passing observation', async () => {
  const transport = session(); transport.send = async () => { throw new Error('private-payload'); };
  const budget = new t.TrafficBudget(); const observer = new t.PageTrafficObserver(transport, budget, () => 'application');
  await assert.rejects(observer.start()); assert.equal(observer.ready, false);
  await observer.dispatch({ requestId: 'id', networkId: 'network', request: {} });
  assert.equal(budget.failure, 'observation');
});

test('no supplied flag or evidence can enable complete live coverage', () => {
  assert.throws(() => t.requireLiveCoverage({ browserTrafficMeasured: true }), { code: 'coverage_unqualified' });
  assert.equal(t.errorCode(new Error('secret')), 'operation');
  assert.equal(new t.PreparationError('secret').message, 'operation');
});

test('inline favicon is not counted as HTTP; missing HTTP observation latches failure', async () => {
  const observer = new t.PageTrafficObserver(session(), new t.TrafficBudget(), () => 'application');
  await observer.start(); observer.observe({ requestId: 'inline', request: { url: 'data:,' } });
  assert.equal((await observer.summary()).allowed, 0);
  observer.observe({ requestId: 'missing-fetch', request: { url: ORIGIN } });
  await assert.rejects(observer.summary(), { code: 'observation' });
  assert.throws(() => observer.budget.reserve('application'), { code: 'stopped' });
});

test('concurrent paused requests cannot overrun the shared application budget', async () => {
  const transport = session(); const budget = new t.TrafficBudget({ limits: { ...t.LIMITS, application: 1 } });
  const observer = new t.PageTrafficObserver(transport, budget, () => 'application'); await observer.start();
  await Promise.all(['one', 'two'].map(id => observer.dispatch({ requestId: id, networkId: id, request: {} })));
  assert.equal(transport.calls.filter(call => call.method === 'Fetch.continueRequest').length, 1);
  assert.equal(budget.snapshot().requests.actual.application, 1); assert.equal(budget.failure, 'budget');
});

test('every independently budgeted traffic category stops at its configured ceiling', () => {
  for (const kind of ['canonicalStatic', 'providerStatic', 'google', 'supabase', 'metadata', 'launches', 'proxyConnections', 'proxyBytes']) {
    const budget = new t.TrafficBudget({ limits: { ...t.LIMITS, [kind]: 1 } }); budget.reserve(kind);
    assert.throws(() => budget.reserve(kind), { code: 'budget' }); assert.equal(budget.snapshot().counters[kind], 1);
  }
});
