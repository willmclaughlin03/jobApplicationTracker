'use strict';
/* global Buffer, setImmediate */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const f = require('../authentication-preparation-scoped-native-fixtures.cjs');
const n = require('../authentication-preparation-scoped-native-contract.cjs');
const c = require('../authentication-preparation-scoped-contract.cjs');

/** Fake only HTTP/socket objects; exercise the real fixture's validation and aggregate witnesses. */
function fixture() {
  const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[0]);
  const fixtures = new f.Fixtures(root);
  /** Dispatch a synthetic request synchronously without starting any listener or writing profile files. */
  function request(route, cookie = '', extra = {}) {
    const req = Object.assign(new EventEmitter(), { method: 'GET', url: route, headers: { host: '127.0.0.1:18443', cookie },
      socket: new EventEmitter(), destroyed: false, ...extra }); req.destroy = () => { req.destroyed = true; };
    const res = { headers: {}, body: null, destroyed: false,
      setHeader: (name, value) => { res.headers[name] = value; }, end: body => { res.body = body; }, destroy: () => { res.destroyed = true; } };
    fixtures.handle(n.ORIGIN, req, res); return { req, res };
  }
  return { root, budget, fixtures, request };
}

test('public TLS fixture pins the exact SANs and corresponding key without runtime regeneration', async () => {
  const value = await f.certificate(); assert.match(value.certificateHash, /^[a-f0-9]{64}$/); assert.match(value.keyHash, /^[a-f0-9]{64}$/);
  await assert.rejects(f.certificate({ readFile: async () => Buffer.from('invalid public fixture') }));
});

test('synthetic persistence and write-back use categorical server witnesses only', () => {
  const q = fixture(); const initial = 'gate1_public_synthetic=public-test-initial'; const updated = 'gate1_public_synthetic=public-test-updated';
  assert.equal(q.request('/start').res.statusCode, 302); assert.equal(q.request('/hop').res.headers.Location, '/ready');
  q.request('/ready', initial); q.request('/api/auth/session', initial); q.request('/api/native/writeback', initial); q.request('/ready', updated);
  assert.equal(q.fixtures.counts.readyInitial, 1); assert.equal(q.fixtures.counts.readyUpdated, 1);
  assert.equal(q.fixtures.counts.sessionInitial, 1); assert.equal(q.fixtures.counts.writeBack, 1);
  assert.equal(JSON.stringify(q.fixtures.counts).includes('public-test'), false);
  assert.equal(q.root.totals.fixtureRequests, 6); assert.equal(q.root.totals.application, 0);
  assert.equal(f.cookieState(`${initial}; ${updated}`), 'absent');
});

test('unexpected routes, hosts, methods and body framing stop instead of forwarding or expanding policy', () => {
  for (const [route, extra] of [['/login?token=private', {}], ['/frame', {}], ['/login', { method: 'POST' }],
    ['/login', { headers: { host: 'external.test' } }], ['/login', { headers: { host: '127.0.0.1:18443', 'transfer-encoding': 'chunked' } }]]) {
    const q = fixture(); const { req, res } = q.request(route, '', extra);
    assert.equal(q.root.failure, 'destination'); assert.equal(req.destroyed, true); assert.equal(res.destroyed, true);
  }
  const q = fixture(); const { req } = q.request('/login'); req.emit('data', Buffer.alloc(1));
  assert.equal(q.root.failure, 'destination'); assert.equal(q.root.totals.proxyBytes, 1);
});

/** Classify exact fixture guards without retaining request headers, paths, cookies or payloads. */
test('fixture rejections retain fixed reasons and deny requests before fixture accounting', async () => {
  const headers = { host: '127.0.0.1:18443' };
  for (const [reason, route, extra] of [
    ['fixture_closing', '/login', {}], ['fixture_host', '/login', { headers: { host: 'private.test' } }],
    ['fixture_transfer_encoding', '/login', { headers: { ...headers, 'transfer-encoding': 'private' } }],
    ['fixture_content_length', '/login', { headers: { ...headers, 'content-length': '1' } }],
    ['route_method', '/login', { method: 'POST' }], ['route_query_fragment', '/login?secret=private', {}],
    ['route_normalization', '/a/../login', {}], ['route_origin_path', '/private', {}],
  ]) {
    const q = fixture(); if (reason === 'fixture_closing') await q.fixtures.close();
    const { req, res } = q.request(route, 'private', extra);
    assert.equal(q.root.failure, 'destination'); assert.equal(q.root.destinationReason, reason);
    assert.equal(req.destroyed, true); assert.equal(res.destroyed, true); assert.equal(res.body, null);
    assert.equal(q.root.totals.fixtureRequests, 0); assert.equal(q.budget.abort.signal.aborted, true);
    q.request('/another-private-route'); assert.equal(q.root.destinationReason, reason);
  }
});

/** Body rejection keeps the original parsed-byte charge; subsequent failures cannot replace the first reason. */
test('fixture body attribution survives cleanup and respects earlier case cancellation', async () => {
  const q = fixture(); const { req, res } = q.request('/login', '', { headers: { host: '127.0.0.1:18443', 'content-length': '0' } });
  req.emit('data', Buffer.from('private')); assert.equal(q.root.totals.proxyBytes, 7);
  assert.equal(q.root.destinationReason, 'fixture_body'); assert.equal(req.destroyed, true); assert.equal(res.destroyed, true);
  await q.fixtures.close(); q.request('/private'); assert.equal(q.root.destinationReason, 'fixture_body');

  const other = fixture(); other.budget.stop('cancelled'); other.request('/private');
  assert.equal(other.root.destinationReason, null); assert.equal(other.budget.failure, 'cancelled');
});

test('held request requires the actual socket close event; request completion alone is not cancellation evidence', () => {
  const q = fixture(); const { req, res } = q.request('/api/native/hold');
  assert.equal(q.fixtures.counts.held, 1); assert.equal(res.body, null);
  req.emit('close'); assert.equal(q.fixtures.counts.heldClosed, 0);
  req.socket.emit('close'); assert.equal(q.fixtures.counts.heldClosed, 1);
});

test('worker setup pre-reserves exact requests and cannot silently consume another route or repeat', () => {
  const q = fixture(); q.fixtures.seed(q.budget); assert.equal(q.root.totals.application, 2); assert.equal(q.root.totals.canonicalStatic, 1);
  assert.throws(() => q.fixtures.finishSeed());
  q.request('/worker-seed'); q.request('/worker.js'); q.request('/worker-probe'); q.fixtures.finishSeed();
  assert.equal(q.budget.snapshot().uncertain, 0); assert.equal(q.fixtures.counts.workerProbe, 1);
  const other = fixture(); other.fixtures.seed(other.budget); other.request('/worker.js'); other.request('/worker.js');
  assert.equal(other.root.failure, 'budget');
});

test('listener ownership is retained on partial startup failure and occupied ports never fall back', async () => {
  const q = fixture(); const servers = []; const listened = [];
  q.fixtures.createServer = () => {
    const server = new EventEmitter(); servers.push(server);
    server.listen = (port, host, callback) => { listened.push([host, port]); if (port === 18444) server.emit('error', new Error('occupied')); else callback(); };
    server.close = callback => { server.closed = true; callback(); }; return server;
  };
  await assert.rejects(q.fixtures.start({ cert: Buffer.alloc(0), key: Buffer.alloc(0) }));
  assert.deepEqual(listened, [['127.0.0.1', 18443], ['127.0.0.2', 18444]]);
  await q.fixtures.close(); assert.equal(servers.every(server => server.closed), true);
});

test('late listener readiness closes the owned server and cannot start the next listener after cancellation', async () => {
  const q = fixture(); let ready; let created = 0; let closed = 0;
  q.fixtures.createServer = () => {
    created++; const server = new EventEmitter(); server.listen = (_port, _host, callback) => { ready = callback; };
    server.close = callback => { closed++; callback(); }; return server;
  };
  const pending = q.fixtures.start({ cert: Buffer.alloc(0), key: Buffer.alloc(0) }); const rejected = assert.rejects(pending);
  q.root.stop('cancelled'); await q.fixtures.close(); ready(); await rejected;
  assert.equal(created, 1); assert.equal(closed, 2);
});

test('all HTTPS listeners receive cleanup even when one close fails; stopped roots reject late sockets', async () => {
  const q = fixture(); const servers = []; let closes = 0;
  q.fixtures.createServer = () => {
    const server = new EventEmitter(); servers.push(server); server.listen = (_port, _host, done) => done();
    server.close = done => { closes++; done(servers[0] === server ? new Error('synthetic failure') : null); }; return server;
  };
  await q.fixtures.start({ cert: Buffer.alloc(0), key: Buffer.alloc(0) });
  q.root.stop('cancelled'); const socket = new EventEmitter(); socket.destroy = () => { socket.destroyed = true; };
  servers[0].emit('connection', socket); assert.equal(socket.destroyed, true); assert.equal(q.fixtures.sockets.size, 0);
  await assert.rejects(q.fixtures.close(), { code: 'closure' }); assert.equal(closes, 2);
});

test('missing transport head witness stops immediately and closes every owned resource despite proxy close failure', async () => {
  for (const closeFails of [false, true]) {
    const root = new n.NativeLedger(0, 480000, () => 1000); let accept; let created = 0; let sinkClosed = 0; let proxyClosed = 0; let client;
    const sinkSocket = new EventEmitter(); sinkSocket.destroy = () => { sinkSocket.destroyed = true; sinkSocket.emit('close'); };
    const deps = {
      createServer: callback => {
        accept = callback; created++; const server = new EventEmitter(); server.listen = (_port, _host, done) => done();
        server.close = done => { sinkClosed++; done(); }; return server;
      }, proxy: () => ({ evidence: { headBeforeConnect: 0 }, bytes: { upstream: { admitted: 4 } },
        start: async () => {}, open: () => {}, close: async () => { proxyClosed++; if (closeFails) throw new c.PreparationError('closure'); } }),
      connect: () => {
        client = new EventEmitter(); client.destroy = () => { client.destroyed = true; client.emit('close'); };
        client.write = () => { accept(sinkSocket); sinkSocket.emit('data', Buffer.alloc(4)); client.emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n')); };
        setImmediate(() => client.emit('connect')); return client;
      },
    };
    await assert.rejects(f.transportProbes(root, deps), { code: 'coverage_unqualified' });
    assert.equal(created, 1); assert.equal(proxyClosed, 1); assert.equal(sinkClosed, 1);
    assert.equal(client.destroyed, true); assert.equal(sinkSocket.destroyed, true);
    assert.equal(root.failure, 'coverage_unqualified'); assert.equal(root.cleanupFailed, closeFails);
    const late = new EventEmitter(); late.destroy = () => { late.destroyed = true; };
    accept(late); assert.equal(late.destroyed, true);
  }
});
