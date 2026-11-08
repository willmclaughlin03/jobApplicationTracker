'use strict';
/* global Buffer, setImmediate */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { ScopedBudget, LIMITS } = require('../authentication-preparation-scoped-contract.cjs');
const { TunnelBudget, ScopedProxy, AUTHORITIES } = require('../authentication-preparation-scoped-proxy.cjs');
const n = require('../authentication-preparation-scoped-native-contract.cjs');

/** Simulate socket backpressure and optional asynchronous close events without opening network resources. */
function socket({ closeAsync = false } = {}) {
  const value = new EventEmitter(); value.writes = []; value.destroyed = false; value.paused = false;
  /** Retain the configured idle limit and callback so tests can trigger timeouts without real timers. */
  value.setTimeout = (ms, callback) => { value.timeoutMs = ms; value.on('timeout', callback); return value; };
  value.pause = () => { value.paused = true; }; value.resume = () => { value.paused = false; };
  value.write = bytes => { value.writes.push(bytes); return !value.writableNeedDrain; };
  /** Mark destruction immediately, optionally delaying close so tests distinguish it from released ownership. */
  value.destroy = () => {
    if (!value.destroyed) {
      value.destroyed = true;
      if (closeAsync) setImmediate(value.emit.bind(value), 'close'); else value.emit('close');
    }
  }; value.end = value.destroy;
  return value;
}

/** Keep the proxy's real callbacks with fake server/connect boundaries for deterministic races. */
async function fixture(limits = {}) {
  const budget = new ScopedBudget({ limits: { ...LIMITS, ...limits } }); const server = new EventEmitter();
  server.listen = (_port, _host, ready) => ready(); server.address = () => ({ port: 12345 });
  server.close = ready => ready(); const upstreams = [];
  const proxy = new ScopedProxy(budget, { createServer: options => { assert.equal(options.maxHeaderSize, 8192); return server; },
    connect: () => { const value = socket(); upstreams.push(value); return value; } });
  await proxy.start(); proxy.open(); const client = socket(); server.emit('connection', client);
  return { budget, proxy, server, client, upstreams };
}

test('directional and combined overflow reject whole chunks and never refund prior reservations', () => {
  for (const limits of [{ upstreamBytes: 3 }, { tunnelBytes: 3 }]) {
    const budget = new ScopedBudget({ limits: { ...LIMITS, ...limits } }); const bytes = new TunnelBudget(budget);
    assert.equal(bytes.reserve('upstream', 2), true); assert.equal(bytes.reserve('upstream', 2), false);
    assert.deepEqual(bytes.upstream, { read: 4, admitted: 2, rejected: 2, written: 0 });
    assert.equal(budget.failure, 'budget');
  }
  const budget = new ScopedBudget({ limits: { ...LIMITS, downstreamBytes: 1 } });
  assert.equal(new TunnelBudget(budget).reserve('downstream', 2), false);
});

test('CONNECT head is charged before connection and forwarded exactly once', async () => {
  const f = await fixture(); f.server.emit('connect', { method: 'CONNECT', url: AUTHORITIES[0] }, f.client, Buffer.from('abc'));
  assert.equal(f.proxy.snapshot().upstream.admitted, 3); assert.equal(f.proxy.snapshot().upstream.written, 0);
  f.upstreams[0].emit('connect'); assert.equal(f.upstreams[0].writes.length, 1);
  assert.deepEqual(f.proxy.snapshot().upstream, { read: 3, admitted: 3, rejected: 0, written: 3 });
  await f.proxy.close(); assert.equal(f.proxy.snapshot().concurrent, 0);
});

/** Either idle endpoint must close only its established tunnel, leaving the shared attempt usable. */
test('idle established client and upstream tunnels close without stopping the attempt', async () => {
  for (const endpoint of ['client', 'upstream']) {
    const f = await fixture();
    f.server.emit('connect', { method: 'CONNECT', url: AUTHORITIES[0] }, f.client, Buffer.alloc(0));
    const upstream = f.upstreams[0]; upstream.emit('connect');
    const other = socket(); f.server.emit('connection', other);
    f.server.emit('connect', { method: 'CONNECT', url: AUTHORITIES[0] }, other, Buffer.alloc(0));
    const otherUpstream = f.upstreams[1]; otherUpstream.emit('connect');
    assert.equal(f.client.timeoutMs, 30000); assert.equal(upstream.timeoutMs, 30000);
    (endpoint === 'client' ? f.client : upstream).emit('timeout');
    assert.equal(f.budget.failure, null); assert.equal(f.budget.abort.signal.aborted, false);
    assert.equal(f.client.destroyed, true); assert.equal(upstream.destroyed, true);
    assert.equal(f.proxy.sockets.has(f.client), false); assert.equal(f.proxy.snapshot().concurrent, 1);
    assert.equal(other.destroyed, false); assert.equal(otherUpstream.destroyed, false);
    other.emit('data', Buffer.from('still active'));
    assert.deepEqual(otherUpstream.writes, [Buffer.from('still active')]);
    await f.proxy.close(); assert.equal(f.proxy.snapshot().concurrent, 0);
  }
});

/** Preserve handshake deadlines on accepted clients and either endpoint of an incomplete upstream connection. */
test('pre-CONNECT and pending upstream timeouts still stop the attempt after 30 seconds', async () => {
  for (const phase of ['pre-CONNECT', 'pending-client', 'pending-upstream']) {
    const f = await fixture();
    if (phase !== 'pre-CONNECT') {
      f.server.emit('connect', { method: 'CONNECT', url: AUTHORITIES[0] }, f.client, Buffer.alloc(0));
    }
    const source = phase === 'pending-upstream' ? f.upstreams[0] : f.client;
    assert.equal(source.timeoutMs, 30000); source.emit('timeout');
    assert.equal(f.budget.failure, 'deadline'); assert.equal(f.budget.abort.signal.aborted, true);
    assert.equal(f.client.destroyed, true); assert.equal(f.proxy.snapshot().concurrent, 0);
    if (f.upstreams[0]) {
      assert.equal(f.upstreams[0].destroyed, true); f.upstreams[0].emit('connect');
    }
    assert.equal(f.proxy.snapshot().tunnels, 0); assert.equal(f.client.writes.length, 0);
    await f.proxy.close();
  }
});

test('head overflow cannot connect and unknown authorities cannot be expanded by URL normalization', async () => {
  const f = await fixture({ upstreamBytes: 2 });
  f.server.emit('connect', { method: 'CONNECT', url: AUTHORITIES[0] }, f.client, Buffer.from('abc'));
  assert.equal(f.upstreams.length, 0); assert.equal(f.budget.failure, 'budget'); await f.proxy.close();
  for (const authority of ['unknown.test:443', `${AUTHORITIES[0]}/path`, AUTHORITIES[0].toUpperCase(), 'api.vercel.com:443']) {
    const other = await fixture(); other.server.emit('connect', { method: 'CONNECT', url: authority }, other.client, Buffer.alloc(0));
    assert.equal(other.budget.failure, 'destination'); assert.equal(other.upstreams.length, 0); await other.proxy.close();
  }
});

test('backpressure pauses its source; a late drain or connect cannot reopen stopped forwarding', async () => {
  const f = await fixture(); f.server.emit('connect', { method: 'CONNECT', url: AUTHORITIES[0] }, f.client, Buffer.alloc(0));
  const upstream = f.upstreams[0]; upstream.emit('connect'); upstream.writableNeedDrain = true;
  f.client.emit('data', Buffer.from('payload')); assert.equal(f.client.paused, true);
  f.budget.stop('cancelled'); upstream.emit('drain'); upstream.emit('connect');
  assert.equal(f.client.paused, true); assert.equal(f.client.destroyed, true); assert.equal(upstream.destroyed, true);
  assert.equal(upstream.writes.length, 1); await f.proxy.close();
});

test('concurrent socket overflow is separate from admitted connections and latches stop', async () => {
  const f = await fixture({ proxyConcurrent: 1 }); const excess = socket(); f.server.emit('connection', excess);
  assert.equal(f.proxy.snapshot().connections, 1); assert.equal(f.proxy.snapshot().overLimit, 1);
  assert.equal(excess.destroyed, true); assert.equal(f.budget.failure, 'budget'); await f.proxy.close();
});

test('restart gate rejects CONNECT without creating upstream traffic', async () => {
  const f = await fixture(); f.proxy.seal(); const client = socket(); f.server.emit('connection', client);
  f.server.emit('connect', { method: 'CONNECT', url: AUTHORITIES[0] }, client, Buffer.from('abc'));
  assert.equal(f.upstreams.length, 0); assert.equal(f.proxy.snapshot().denied, 1);
  assert.equal(f.proxy.snapshot().upstream.rejected, 3); await f.proxy.close();
});

/** Exact synthetic authorities use fixed ports, and the live proxy cannot acquire this policy with a live budget. */
test('synthetic proxy is a bounded separate policy with cumulative connection and payload accounting', async () => {
  const n = require('../authentication-preparation-scoped-native-contract.cjs');
  assert.throws(() => new ScopedProxy(new ScopedBudget(), { synthetic: 'fixtures' }), { code: 'approval' });
  for (const mode of ['fixtures', 'transport']) {
    const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
    const server = new EventEmitter(); const upstream = socket(); let endpoint;
    server.listen = (port, host, ready) => { assert.equal(port, 18445); assert.equal(host, '127.0.0.1'); ready(); };
    server.address = () => ({ port: 18445 }); server.close = done => done();
    const proxy = new ScopedProxy(budget, { synthetic: mode, createServer: () => server, connect: value => { endpoint = value; return upstream; } });
    await proxy.start(); proxy.open(); const client = socket(); server.emit('connection', client);
    server.emit('connect', { method: 'CONNECT', url: mode === 'fixtures' ? '127.0.0.2:18444' : '127.0.0.1:18446' }, client, Buffer.from('test'));
    assert.deepEqual(endpoint, { host: mode === 'fixtures' ? '127.0.0.2' : '127.0.0.1', port: mode === 'fixtures' ? 18444 : 18446 });
    assert.equal(root.totals.proxyConnections, 1); assert.equal(root.connections, 1);
    assert.equal(root.totals.upstreamBytes, 4); assert.equal(root.totals.tunnelBytes, 4);
    upstream.emit('connect'); await proxy.close(); assert.equal(root.connections, 0);
  }
});

/** Server completion can precede socket close events; native case accounting must settle before close returns. */
test('proxy close awaits every asynchronous socket closure before releasing the native case', async () => {
  const n = require('../authentication-preparation-scoped-native-contract.cjs');
  for (const closeError of [null, Object.assign(new Error('not listening'), { code: 'ERR_SERVER_NOT_RUNNING' })]) {
    const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
    const server = new EventEmitter(); let serverClosed = false;
    /** Complete server shutdown before socket events, including cleanup of a server that never listened. */
    server.close = done => { serverClosed = true; done(closeError); };
    const proxy = new ScopedProxy(budget, { createServer: () => server });
    const clients = [socket({ closeAsync: true }), socket({ closeAsync: true })];
    for (const client of clients) server.emit('connection', client);
    assert.equal(root.connections, 2); assert.equal(getEventListeners(budget.abort.signal, 'abort').length, 1);
    const closing = proxy.close();
    assert.equal(serverClosed, true); assert.equal(root.connections, 2);
    for (const client of clients) assert.equal(client.destroyed, true);
    await closing;
    assert.equal(root.connections, 0); assert.equal(proxy.snapshot().concurrent, 0); assert.equal(proxy.sockets.size, 0);
    assert.equal(getEventListeners(budget.abort.signal, 'abort').length, 0);
    root.finishCase(budget); assert.equal(root.active, null);
  }
});

/** Cumulative overflow from an earlier case must reject before a later proxy connects upstream. */
test('synthetic cumulative tunnel exhaustion cannot be bypassed by a new proxy', async () => {
  const n = require('../authentication-preparation-scoped-native-contract.cjs');
  const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
  root.totals.upstreamBytes = n.LIMITS.upstreamBytes;
  const bytes = new TunnelBudget(budget); assert.equal(bytes.reserve('upstream', 1), false);
  assert.equal(bytes.upstream.admitted, 0); assert.equal(bytes.upstream.rejected, 1); assert.equal(root.failure, 'budget');
});

/** Reuse actual proxy callbacks with a native budget and fake sockets; no listener or browser is opened. */
async function nativeFixture() {
  const n = require('../authentication-preparation-scoped-native-contract.cjs');
  const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
  const server = new EventEmitter(); const upstreams = [];
  server.listen = (_port, _host, ready) => ready(); server.address = () => ({ port: 18445 }); server.close = done => done();
  const proxy = new ScopedProxy(budget, { synthetic: 'fixtures', createServer: () => server,
    connect: () => { const upstream = socket(); upstreams.push(upstream); return upstream; } });
  await proxy.start(); proxy.open(); const client = socket(); server.emit('connection', client);
  return { root, budget, proxy, server, client, upstreams };
}

/** Every rejecting proxy boundary has a fixed category while retaining the original denial and byte accounting. */
test('native proxy distinguishes HTTP, parser and each CONNECT rejection before upstream dispatch', async () => {
  for (const reason of ['proxy_http_request', 'proxy_parser_error', 'proxy_owner_missing', 'proxy_owner_reused', 'proxy_method', 'proxy_authority']) {
    const q = await nativeFixture(); const request = { method: 'CONNECT', url: '127.0.0.1:18443' };
    let rejected = q.client; let response;
    if (reason === 'proxy_http_request') {
      response = socket(); q.server.emit('request', Object.assign(socket(), { url: 'https://private.test/?secret=value' }), response);
    } else if (reason === 'proxy_parser_error') {
      q.server.emit('clientError', Object.assign(new Error('private parser contents'), { rawPacket: Buffer.from('private') }), q.client);
    } else {
      if (reason === 'proxy_owner_missing') rejected = socket();
      if (reason === 'proxy_owner_reused') q.proxy.sockets.get(q.client).handled = true;
      if (reason === 'proxy_method') request.method = 'POST';
      if (reason === 'proxy_authority') request.url = 'private.test:443';
      q.server.emit('connect', request, rejected, Buffer.from('private'));
      assert.equal(q.proxy.snapshot().upstream.rejected, 7);
    }
    assert.equal(q.budget.failure, 'destination'); assert.equal(q.budget.destinationReason, reason);
    assert.equal(q.upstreams.length, 0); assert.equal(rejected.destroyed, true);
    if (response) assert.equal(response.destroyed, true);
    assert.equal(JSON.stringify(q.proxy.snapshot()).includes('private'), false);
    assert.equal(q.proxy.snapshot().forwardingClosed, true);
    q.root.stop('destination'); assert.equal(q.root.destinationReason, reason);
    await q.proxy.close(); assert.equal(q.root.connections, 0);
  }
});

/** A valid but closed readiness barrier is an expected denial, not a new destination violation. */
test('native readiness denial and late cleanup callbacks cannot invent or replace attribution', async () => {
  const q = await nativeFixture(); q.proxy.seal(); const client = socket(); q.server.emit('connection', client);
  q.server.emit('connect', { method: 'CONNECT', url: '127.0.0.1:18443' }, client, Buffer.alloc(0));
  assert.equal(q.budget.failure, null); assert.equal(q.budget.destinationReason, null); assert.equal(q.upstreams.length, 0);
  assert.equal(q.proxy.evidence.deniedFixture, 1);
  q.budget.stop('cancelled'); q.server.emit('clientError', new Error('private'), client);
  q.server.emit('request', socket(), socket()); assert.equal(q.budget.failure, 'cancelled');
  assert.equal(q.budget.destinationReason, null); await q.proxy.close();

  const other = await nativeFixture();
  other.client.once('close', () => other.server.emit('clientError', new Error('private cleanup'), other.client));
  other.server.emit('connect', { method: 'CONNECT', url: 'private.test:443' }, other.client, Buffer.alloc(0));
  assert.equal(other.budget.destinationReason, 'proxy_authority'); await other.proxy.close();
});

/** Exercise the opt-in launch policy through real callbacks, with all network boundaries replaced in memory. */
async function launchFixture({ root = new n.NativeLedger(0, 480000, () => 1000), item = n.CASES[0], begin = true, policy = n.LAUNCH_POLICY } = {}) {
  const budget = new n.NativeBudget(root, item); const server = new EventEmitter(); let upstreams = 0;
  server.listen = (_port, _host, ready) => ready(); server.address = () => ({ port: 18445 }); server.close = done => done();
  const proxy = new ScopedProxy(budget, { synthetic: 'fixtures', launchPolicy: policy, createServer: () => server,
    connect: () => { upstreams++; return socket(); } });
  await proxy.start(); budget.launch(); const interval = begin ? proxy.beginLaunchInterval() : null;
  /** Deliver one synthetic CONNECT; the caller can retain a socket across interval boundaries. */
  const deny = (url = 'unlisted.test:443', client = null, head = Buffer.alloc(0), method = 'CONNECT') => {
    if (!client) { client = socket(); server.emit('connection', client); }
    server.emit('connect', { method, url }, client, head); return client;
  };
  return { root, budget, proxy, server, interval, deny, upstreams: () => upstreams };
}

/** Tolerance counts blocked connections only; even a correct fixture stays behind the unchanged readiness barrier. */
test('eligible launch denials are destroyed with zero upstream dispatch and no HTTP or byte admission', async () => {
  const q = await launchFixture();
  for (const authority of ['unlisted.test:443', '[2001:db8::1]:443', '192.0.2.1:8443', 'Example.TEST.:443']) {
    const client = q.deny(authority); assert.equal(client.destroyed, true); assert.deepEqual(client.writes, []);
  }
  q.deny('127.0.0.1:18443');
  assert.deepEqual(q.root.launchDenials, { total: 4, perLaunch: [4] });
  assert.equal(q.root.totals.proxyConnections, 5); assert.equal(q.budget.failure, null); assert.equal(q.upstreams(), 0);
  assert.equal(q.root.totals.application, 0); assert.equal(q.root.totals.tunnelBytes, 0);
  assert.equal(q.proxy.snapshot().denied, 5); assert.equal(q.proxy.snapshot().forwardingClosed, true);
  assert.equal(q.proxy.evidence.deniedFixture, 1);
  assert.equal(JSON.stringify(q.root.launchDenials).includes('unlisted'), false);
  await q.proxy.close(); assert.equal(q.root.launchInterval, null);
});

/** Syntax failures, payload, wrong methods and ownership errors never enter the tolerant counter. */
test('launch exception rejects malformed authorities and all noneligible CONNECTs', async () => {
  const malformed = ['', 'unlisted.test', 'user@unlisted.test:443', 'unlisted.test:443/path', 'unlisted.test:443?x',
    'unlisted.test:443#x', 'unlisted.test:0', 'unlisted.test:65536', 'unlisted.test:0443', 'unlisted.test:\n443',
    'unlisted.test:443\r\n', 'unlisted.test:443\n', '[::1]:443\n', 'unlisted.test:443\0', 'unlisted.test:443\u007f',
    'unlisted.test: 443', '-bad.test:443', 'bad..test:443', `${'a'.repeat(64)}.test:443`, '999.0.0.1:443',
    '[not-ip]:443', '[2001:::1]:443', '[::1%zone]:443', 'https://unlisted.test:443', {}, null];
  for (const authority of malformed) {
    const q = await launchFixture(); q.deny(authority);
    assert.equal(q.budget.failure, 'destination'); assert.equal(q.root.launchDenials.total, 0);
    assert.equal(q.upstreams(), 0); await q.proxy.close();
  }
  for (const mode of ['head', 'method', 'missing', 'reused', 'parser', 'http']) {
    const q = await launchFixture(); const client = socket();
    if (mode !== 'missing') q.server.emit('connection', client);
    if (mode === 'reused') q.proxy.sockets.get(client).handled = true;
    if (mode === 'parser') q.server.emit('clientError', new Error('synthetic'), client);
    else if (mode === 'http') q.server.emit('request', client, socket());
    else q.deny('unlisted.test:443', client, Buffer.from(mode === 'head' ? 'payload' : ''), mode === 'method' ? 'POST' : 'CONNECT');
    assert.equal(q.budget.failure, 'destination'); assert.equal(q.root.launchDenials.total, 0);
    assert.equal(q.upstreams(), 0); await q.proxy.close();
  }
});

/** Default, startup and transport policies cannot opt into synthetic fixture launch tolerance. */
test('strict policies reject authority denials and cannot borrow launch permission', async () => {
  const strict = await launchFixture({ begin: false, policy: null }); strict.deny();
  assert.equal(strict.budget.failure, 'destination'); assert.equal(strict.root.launchDenials.total, 0); await strict.proxy.close();
  const startup = new n.NativeBudget(new n.NativeLedger(0, 180000, () => 1000, 'startup'), n.STARTUP_CASE);
  for (const [budget, synthetic] of [[startup, 'fixtures'], [new ScopedBudget(), null],
    [new n.NativeBudget(new n.NativeLedger(0, 480000, () => 1000), n.CASES[0]), 'transport']]) {
    assert.throws(() => new ScopedProxy(budget, { synthetic, launchPolicy: n.LAUNCH_POLICY }), { code: 'approval' });
  }
  const live = await fixture(); live.server.emit('connect', { method: 'CONNECT', url: 'unlisted.test:443' }, live.client);
  assert.equal(live.budget.failure, 'destination'); assert.equal(live.upstreams.length, 0); await live.proxy.close();
});

/** Closed forwarding is insufficient: both the socket and request must belong to the same active launch interval. */
test('outside-interval and stale-socket denials remain fatal and old callbacks cannot borrow a restart interval', async () => {
  for (const mode of ['before', 'after', 'prior-socket', 'stale-launch']) {
    const q = await launchFixture({ begin: mode !== 'before' && mode !== 'prior-socket' });
    let client;
    if (mode === 'prior-socket' || mode === 'stale-launch') { client = socket(); q.server.emit('connection', client); }
    if (mode === 'prior-socket') q.proxy.beginLaunchInterval();
    if (mode === 'after') q.proxy.endLaunchInterval(q.interval);
    if (mode === 'stale-launch') {
      q.proxy.endLaunchInterval(q.interval); q.root.chrome--; q.budget.launch();
      const next = q.proxy.beginLaunchInterval(); q.proxy.endLaunchInterval(q.interval);
      assert.equal(q.proxy.launchInterval, next);
    }
    q.deny('unlisted.test:443', client); assert.equal(q.budget.failure, 'destination');
    assert.equal(q.root.launchDenials.total, 0); assert.equal(q.upstreams(), 0); await q.proxy.close();
  }
});

/** A launch cannot renew its clock or allowance through overlap, reentry, a new proxy or cleanup. */
test('launch intervals cannot overlap or reopen and an elapsed attachment clock stops before tolerance', async () => {
  for (const mode of ['overlap', 'reopen', 'cleanup']) {
    const q = await launchFixture();
    if (mode === 'reopen') q.proxy.endLaunchInterval(q.interval);
    if (mode === 'cleanup') await q.proxy.close();
    assert.throws(() => q.proxy.beginLaunchInterval(), { code: 'approval' }); await q.proxy.close();
  }
  const shared = await launchFixture(); shared.proxy.endLaunchInterval(shared.interval);
  const other = new ScopedProxy(shared.budget, { synthetic: 'fixtures', launchPolicy: n.LAUNCH_POLICY, createServer: () => new EventEmitter() });
  assert.throws(() => other.beginLaunchInterval(), { code: 'approval' });
  assert.equal(shared.root.lastLaunchInterval, 1); await shared.proxy.close();
  let now = 1000; const q = await launchFixture({ root: new n.NativeLedger(1000, 481000, () => now) });
  now = 11000; q.deny(); assert.equal(q.budget.failure, 'deadline'); assert.equal(q.root.launchDenials.total, 0);
  assert.equal(q.upstreams(), 0); await q.proxy.close();
});

/** Per-launch overflow is global, and cumulative reservations survive normal restarts and retirement of expected-negative cases. */
test('launch denial limits stop at four per launch and sixteen across cases without refunds', async () => {
  const one = await launchFixture(); for (let index = 0; index < 5; index++) one.deny();
  assert.equal(one.root.failure, 'budget'); assert.deepEqual(one.root.launchDenials, { total: 4, perLaunch: [4] });
  assert.equal(one.root.totals.proxyConnections, 5); assert.equal(one.upstreams(), 0); await one.proxy.close();
  const root = new n.NativeLedger(0, 480000, () => 1000);
  for (let index = 0; index < 5; index++) {
    const q = await launchFixture({ root, item: n.CASES[index] });
    for (let count = 0; count < (index < 4 ? 4 : 1); count++) q.deny();
    if (index < 4) { assert.equal(root.failure, null); q.budget.stop(q.budget.item.expected || 'cancelled'); }
    else assert.equal(root.failure, 'budget');
    assert.equal(q.upstreams(), 0); await q.proxy.close(); root.chrome--; root.finishCase(q.budget);
  }
  assert.deepEqual(root.launchDenials, { total: 16, perLaunch: [4, 4, 4, 4, 0] });
  assert.equal(root.totals.proxyConnections, 17); assert.equal(root.deadline, 360000);
});

/** Launch tolerance never supplements existing connection allowances or overrides an earlier stop. */
test('launch denials still consume connection budgets and preserve cancellation', async () => {
  for (const mode of ['cumulative', 'concurrent', 'cancelled']) {
    const q = await launchFixture();
    if (mode === 'cumulative') q.root.totals.proxyConnections = n.LIMITS.proxyConnections;
    if (mode === 'concurrent') for (let index = 0; index < n.LIMITS.proxyConcurrent; index++) q.server.emit('connection', socket());
    if (mode === 'cancelled') q.budget.stop('cancelled');
    q.deny(); assert.equal(q.budget.failure, mode === 'cancelled' ? 'cancelled' : 'budget');
    assert.equal(q.root.launchDenials.total, 0); assert.equal(q.upstreams(), 0); await q.proxy.close();
  }
});
