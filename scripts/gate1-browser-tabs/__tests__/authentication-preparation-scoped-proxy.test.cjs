'use strict';
/* global Buffer */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ScopedBudget, LIMITS } = require('../authentication-preparation-scoped-contract.cjs');
const { TunnelBudget, ScopedProxy, AUTHORITIES } = require('../authentication-preparation-scoped-proxy.cjs');

/** Simulate socket backpressure and closure without opening network resources. */
function socket() {
  const value = new EventEmitter(); value.writes = []; value.destroyed = false; value.paused = false;
  value.setTimeout = () => {}; value.pause = () => { value.paused = true; }; value.resume = () => { value.paused = false; };
  value.write = bytes => { value.writes.push(bytes); return !value.writableNeedDrain; };
  value.destroy = () => { if (!value.destroyed) { value.destroyed = true; value.emit('close'); } }; value.end = value.destroy;
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
