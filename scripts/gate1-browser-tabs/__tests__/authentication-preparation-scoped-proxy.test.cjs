'use strict';
/* global Buffer, setImmediate */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { ScopedBudget, LIMITS } = require('../authentication-preparation-scoped-contract.cjs');
const { TunnelBudget, ScopedProxy, AUTHORITIES } = require('../authentication-preparation-scoped-proxy.cjs');

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
