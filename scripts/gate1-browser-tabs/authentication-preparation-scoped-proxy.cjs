'use strict';
/* global Buffer */

const http = require('node:http');
const net = require('node:net');
const { TARGET } = require('./hosted-csrf-diagnostic.cjs');
const { SUPPORT, SUPABASE } = require('./authentication-preparation-traffic.cjs');
const { check, errorCode } = require('./authentication-preparation-scoped-contract.cjs');
const AUTHORITIES = Object.freeze([TARGET.canonical, SUPABASE, 'accounts.google.com', ...SUPPORT].map(host => `${host}:443`));

/** Account payload reads once, retaining attempted/rejected bytes separately from forwarding reservations. */
class TunnelBudget {
  /** Share the worker's stop signal and numeric limits; no request counts are inferred from tunnels. */
  constructor(budget) {
    this.budget = budget; this.upstream = { read: 0, admitted: 0, rejected: 0, written: 0 };
    this.downstream = { read: 0, admitted: 0, rejected: 0, written: 0 };
  }
  /** Atomically reserve directional and combined payload; reject the whole offending chunk. */
  reserve(direction, size, permitted = true) {
    check(['upstream', 'downstream'].includes(direction) && Number.isSafeInteger(size) && size >= 0, 'schema');
    const item = this[direction]; item.read += size;
    if (!permitted || this.budget.failure) { item.rejected += size; return false; }
    try {
      this.budget.check();
      this.budget.require(item.admitted + size <= this.budget.limits[`${direction}Bytes`]
        && this.upstream.admitted + this.downstream.admitted + size <= this.budget.limits.tunnelBytes, 'budget');
      item.admitted += size; return true;
    } catch { item.rejected += size; return false; }
  }
  /** A successful write call is evidence of local enqueue only, never remote HTTP receipt. */
  written(direction, size) { this[direction].written += size; }
}

/** Own every socket before asynchronous connect; callbacks cannot reopen forwarding after a stop. */
class ScopedProxy {
  /** Dependency injection permits fully mocked transport tests without listening or forwarding. */
  constructor(budget, { createServer = http.createServer, connect = net.connect } = {}) {
    this.budget = budget; this.connect = connect; this.bytes = new TunnelBudget(budget);
    this.forwarding = false; this.closing = false; this.sockets = new Map(); this.port = null;
    this.counts = { connections: 0, concurrent: 0, overLimit: 0, denied: 0, tunnels: 0 };
    this.server = createServer({ maxHeaderSize: budget.limits.connectHeaderBytes,
      headersTimeout: budget.limits.operationMs, requestTimeout: budget.limits.operationMs });
    this.server.on('connection', socket => this.accept(socket));
    this.server.on('connect', (request, socket, head) => this.tunnel(request, socket, head));
    this.server.on('request', (request, response) => {
      this.counts.denied++; this.budget.stop('destination'); request.destroy(); response.destroy();
    });
    this.server.on('clientError', (_error, socket) => { this.budget.stop('destination'); socket.destroy(); });
    this.server.on('error', () => this.budget.stop('operation'));
    this.onStop = () => this.seal(); budget.abort.signal.addEventListener('abort', this.onStop, { once: true });
  }
  /** Register accepted sockets and count every connection, including later policy denials. */
  accept(socket) {
    if (this.closing || this.budget.failure || this.counts.connections >= this.budget.limits.proxyConnections
      || this.counts.concurrent >= this.budget.limits.proxyConcurrent) {
      this.counts.overLimit++; socket.on('error', () => {}); socket.destroy();
      if (!this.closing && !this.budget.failure) this.budget.stop('budget'); return;
    }
    this.counts.connections++; this.counts.concurrent++;
    const owner = { socket, upstream: null, connected: false, handled: false };
    this.sockets.set(socket, owner);
    socket.on('error', () => { if (!this.closing && this.forwarding) this.budget.stop('operation'); socket.destroy(); });
    socket.setTimeout(this.budget.limits.operationMs, () => { if (!this.closing) this.budget.stop('deadline'); socket.destroy(); });
    socket.once('close', () => {
      if (this.sockets.delete(socket)) this.counts.concurrent--;
      owner.upstream?.destroy();
    });
  }
  /** Bind loopback only, retaining the server even if startup fails or cancellation races readiness. */
  async start() {
    this.budget.check();
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        if (this.closing || this.budget.failure) this.server.close(() => {});
        resolve();
      });
    });
    this.port = this.server.address()?.port; this.budget.check(); check(this.port, 'operation'); return this;
  }
  /** Only the observer-readiness barrier may enable forwarding; a sealed proxy never reopens. */
  open() { this.budget.check(); check(!this.closing, 'stopped'); this.forwarding = true; }
  /** Stop forwarding and destroy owned network activity, including still-connecting upstream sockets. */
  seal() {
    this.forwarding = false;
    for (const owner of this.sockets.values()) { owner.socket.destroy(); owner.upstream?.destroy(); }
  }
  /** Bridge a single direction without a user-space queue; drain resumes only while still authorized. */
  forward(owner, source, destination, direction, data, reserved = false) {
    if ((!reserved && !this.bytes.reserve(direction, data.length, this.forwarding && !this.closing))
      || !this.forwarding || this.closing || this.budget.failure) {
      source.destroy(); destination.destroy(); return;
    }
    try {
      this.budget.check();
      const writable = destination.write(data); this.bytes.written(direction, data.length);
      if (!writable) {
        source.pause();
        destination.once('drain', () => { if (this.forwarding && !this.closing && !this.budget.failure) source.resume(); });
      }
    } catch (error) { this.budget.stop(errorCode(error)); owner.socket.destroy(); owner.upstream?.destroy(); }
  }
  /** Admit exact CONNECT authority/443 only; encrypted methods, paths and HTTP authorities remain opaque. */
  tunnel(request, socket, head = Buffer.alloc(0)) {
    const owner = this.sockets.get(socket);
    if (!owner || owner.handled || request.method !== 'CONNECT' || !AUTHORITIES.includes(request.url)) {
      this.counts.denied++; this.bytes.reserve('upstream', head.length, false);
      this.budget.stop('destination'); socket.destroy(); return;
    }
    owner.handled = true; socket.pause();
    if (!this.forwarding || this.closing || this.budget.failure) {
      this.counts.denied++; this.bytes.reserve('upstream', head.length, false); socket.destroy(); return;
    }
    try {
      this.budget.check();
      if (!this.bytes.reserve('upstream', head.length)) { socket.destroy(); return; }
      const upstream = this.connect({ host: request.url.slice(0, -4), port: 443 }); owner.upstream = upstream;
      upstream.on('error', () => { if (!this.closing) this.budget.stop('operation'); socket.destroy(); upstream.destroy(); });
      upstream.setTimeout(this.budget.limits.operationMs, () => { if (!this.closing) this.budget.stop('deadline'); upstream.destroy(); socket.destroy(); });
      upstream.once('close', () => socket.destroy());
      upstream.once('connect', () => {
        if (!this.forwarding || this.closing || this.budget.failure || socket.destroyed) { upstream.destroy(); return; }
        this.counts.tunnels++; owner.connected = true;
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.on('data', data => this.forward(owner, socket, upstream, 'upstream', data));
        upstream.on('data', data => this.forward(owner, upstream, socket, 'downstream', data));
        socket.on('end', () => upstream.end()); upstream.on('end', () => socket.end());
        // Head is already read by the HTTP parser; pass it through the same single accounting point.
        if (head.length) this.forward(owner, socket, upstream, 'upstream', head, true);
        if (!this.budget.failure && !upstream.writableNeedDrain) socket.resume();
      });
    } catch (error) { this.budget.stop(errorCode(error)); socket.destroy(); owner.upstream?.destroy(); }
  }
  /** Close listeners after destroying all owned sockets; the supervisor separately probes the port. */
  async close() {
    this.closing = true; this.seal();
    await new Promise((resolve, reject) => {
      this.server.close(error => { if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve(); });
    });
    this.budget.abort.signal.removeEventListener('abort', this.onStop);
  }
  /** Return sanitized transport counters, never destinations, headers or payloads. */
  snapshot() { return { ...this.counts, upstream: { ...this.bytes.upstream }, downstream: { ...this.bytes.downstream }, forwardingClosed: !this.forwarding }; }
}

module.exports = { AUTHORITIES, TunnelBudget, ScopedProxy };
