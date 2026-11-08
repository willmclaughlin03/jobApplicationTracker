'use strict';
/* global Buffer */

const http = require('node:http');
const net = require('node:net');
const { TARGET } = require('./hosted-csrf-diagnostic.cjs');
const { SUPPORT, SUPABASE } = require('./authentication-preparation-traffic.cjs');
const { check, errorCode } = require('./authentication-preparation-scoped-contract.cjs');
const AUTHORITIES = Object.freeze([TARGET.canonical, SUPABASE, 'accounts.google.com', ...SUPPORT].map(host => `${host}:443`));

/** Recognize bounded CONNECT host/port syntax only; this never grants an authority forwarding permission. */
function wellFormedAuthority(value) {
  // Reject line endings explicitly: JavaScript's end anchor can otherwise match before a final newline.
  if (typeof value !== 'string' || value.length > 260 || value.includes('\r') || value.includes('\n')) return false;
  const ipv6 = /^\[([0-9a-fA-F:.]+)\]:([1-9][0-9]{0,4})$/.exec(value);
  if (ipv6) return net.isIP(ipv6[1]) === 6 && Number(ipv6[2]) <= 65535;
  const match = /^([a-zA-Z0-9.-]+):([1-9][0-9]{0,4})$/.exec(value);
  if (!match || match[1].length > 253 || Number(match[2]) > 65535) return false;
  const host = match[1].endsWith('.') ? match[1].slice(0, -1) : match[1];
  if (/^[0-9.]+$/.test(host)) return net.isIP(host) === 4;
  return host.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

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
      this.budget.tunnel?.(direction, size);
      item.admitted += size; return true;
    } catch { item.rejected += size; return false; }
  }
  /** A successful write call is evidence of local enqueue only, never remote HTTP receipt. */
  written(direction, size) { this[direction].written += size; }
}

/** Own every socket before asynchronous connect; callbacks cannot reopen forwarding after a stop. */
class ScopedProxy {
  /** Dependency injection permits fully mocked transport tests without listening or forwarding. */
  constructor(budget, { createServer = http.createServer, connect = net.connect, synthetic = null, launchPolicy = null } = {}) {
    const n = require('./authentication-preparation-scoped-native-contract.cjs');
    check(synthetic === null || (['fixtures', 'transport'].includes(synthetic) && budget instanceof n.NativeBudget), 'approval');
    this.nativeBudget = budget instanceof n.NativeBudget ? budget : null;
    check(launchPolicy === null || (launchPolicy === n.LAUNCH_POLICY && synthetic === 'fixtures'
      && this.nativeBudget?.root.mode === 'qualification'), 'approval');
    this.launchPolicy = launchPolicy; this.launchInterval = null;
    this.authorities = synthetic === 'fixtures' ? ['127.0.0.1:18443', '127.0.0.2:18444']
      : synthetic === 'transport' ? ['127.0.0.1:18446'] : AUTHORITIES;
    this.listenPort = synthetic ? 18445 : 0;
    this.evidence = { headBeforeConnect: 0, backpressure: 0, lateBlocked: 0, deniedFixture: 0 };
    this.budget = budget; this.connect = connect; this.bytes = new TunnelBudget(budget);
    this.forwarding = false; this.closing = false; this.sockets = new Map(); this.port = null;
    this.counts = { connections: 0, concurrent: 0, overLimit: 0, denied: 0, tunnels: 0 };
    this.server = createServer({ maxHeaderSize: budget.limits.connectHeaderBytes,
      headersTimeout: budget.limits.operationMs, requestTimeout: budget.limits.operationMs });
    this.server.on('connection', socket => this.accept(socket));
    this.server.on('connect', (request, socket, head) => this.tunnel(request, socket, head));
    this.server.on('request', (request, response) => {
      this.counts.denied++; this.stopDestination('proxy_http_request'); request.destroy(); response.destroy();
    });
    this.server.on('clientError', (_error, socket) => { this.stopDestination('proxy_parser_error'); socket.destroy(); });
    this.server.on('error', () => this.budget.stop('operation'));
    this.onStop = () => this.seal(); budget.abort.signal.addEventListener('abort', this.onStop, { once: true });
  }
  /** Attribute native rejection before sealing sockets; live budgets retain their existing destination-only stop. */
  stopDestination(reason) {
    if (this.nativeBudget) this.nativeBudget.destination(reason); else this.budget.stop('destination');
  }
  /** Register accepted sockets and count every connection, including later policy denials. */
  accept(socket) {
    if (this.closing || this.budget.failure || this.counts.connections >= this.budget.limits.proxyConnections
      || this.counts.concurrent >= this.budget.limits.proxyConcurrent) {
      this.counts.overLimit++; socket.on('error', () => {}); socket.destroy();
      if (!this.closing && !this.budget.failure) this.budget.stop('budget'); return;
    }
    try { this.budget.connection?.(); } catch { socket.on('error', () => {}); socket.destroy(); return; }
    this.counts.connections++; this.counts.concurrent++;
    const owner = { socket, upstream: null, connected: false, handled: false, launchInterval: this.launchInterval };
    this.sockets.set(socket, owner);
    socket.on('error', () => { if (!this.closing && this.forwarding) this.budget.stop('operation'); socket.destroy(); });
    socket.setTimeout(this.budget.limits.operationMs, () => {
      // Stalled handshakes stop the attempt; established idle tunnels only close their sockets.
      if (!this.closing && !owner.connected) this.budget.stop('deadline');
      socket.destroy();
    });
    socket.once('close', () => {
      if (this.sockets.delete(socket)) { this.counts.concurrent--; this.budget.connectionClosed?.(); }
      owner.upstream?.destroy();
    });
  }
  /** Bind loopback only, retaining the server even if startup fails or cancellation races readiness. */
  async start() {
    this.budget.check();
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.listenPort, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        if (this.closing || this.budget.failure) this.server.close(() => {});
        resolve();
      });
    });
    this.port = this.server.address()?.port; this.budget.check(); check(this.port, 'operation'); return this;
  }
  /** Enable the reviewed synthetic exception only for a newly reserved owned launch, while forwarding stays closed. */
  beginLaunchInterval() {
    this.budget.check(); check(this.launchPolicy && !this.closing && !this.forwarding && !this.launchInterval, 'approval');
    this.launchInterval = this.nativeBudget.beginLaunchInterval(); return this.launchInterval;
  }
  /** End an exact interval without letting stale adapter callbacks retire or borrow a later interval. */
  endLaunchInterval(interval) {
    if (interval && this.launchInterval === interval) {
      this.nativeBudget.endLaunchInterval(interval); this.launchInterval = null;
    }
  }
  /** Only the observer-readiness barrier may enable forwarding after attachment has finished. */
  open() { this.budget.check(); check(!this.closing && !this.launchInterval, 'stopped'); this.forwarding = true; }
  /** Stop forwarding and destroy owned network activity, including still-connecting upstream sockets. */
  seal() {
    this.endLaunchInterval(this.launchInterval);
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
        this.evidence.backpressure++; source.pause();
        destination.once('drain', () => {
          if (this.forwarding && !this.closing && !this.budget.failure) source.resume(); else this.evidence.lateBlocked++;
        });
      }
    } catch (error) { this.budget.stop(errorCode(error)); owner.socket.destroy(); owner.upstream?.destroy(); }
  }
  /** Admit exact CONNECT authority/443 only; encrypted methods, paths and HTTP authorities remain opaque. */
  tunnel(request, socket, head = Buffer.alloc(0)) {
    const owner = this.sockets.get(socket);
    const reason = !owner ? 'proxy_owner_missing' : owner.handled ? 'proxy_owner_reused'
      : request.method !== 'CONNECT' ? 'proxy_method' : !this.authorities.includes(request.url) ? 'proxy_authority' : null;
    if (reason) {
      this.counts.denied++; this.bytes.reserve('upstream', head.length, false);
      if (reason === 'proxy_authority' && this.launchPolicy && this.launchInterval
        && owner.launchInterval === this.launchInterval && !socket.destroyed && !this.forwarding && !this.closing
        && head.length === 0 && wellFormedAuthority(request.url)) {
        owner.handled = true;
        try { this.nativeBudget.launchDenial(this.launchInterval); } catch { /* The original stop remains authoritative. */ }
        socket.destroy(); return;
      }
      this.stopDestination(reason); socket.destroy(); return;
    }
    owner.handled = true; socket.pause();
    if (!this.forwarding || this.closing || this.budget.failure) {
      if (request.url === '127.0.0.1:18443') this.evidence.deniedFixture++;
      this.counts.denied++; this.bytes.reserve('upstream', head.length, false); socket.destroy(); return;
    }
    try {
      this.budget.check();
      if (!this.bytes.reserve('upstream', head.length)) { socket.destroy(); return; }
      if (head.length) this.evidence.headBeforeConnect++;
      const [host, port] = request.url.split(':');
      const upstream = this.connect({ host, port: Number(port) }); owner.upstream = upstream;
      upstream.on('error', () => { if (!this.closing) this.budget.stop('operation'); socket.destroy(); upstream.destroy(); });
      upstream.setTimeout(this.budget.limits.operationMs, () => {
        // Keep the upstream connection deadline without treating an established idle tunnel as failure.
        if (!this.closing && !owner.connected) this.budget.stop('deadline');
        upstream.destroy(); socket.destroy();
      });
      upstream.once('close', () => socket.destroy());
      upstream.once('connect', () => {
        if (!this.forwarding || this.closing || this.budget.failure || socket.destroyed) { this.evidence.lateBlocked++; upstream.destroy(); return; }
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
  /** Await owned socket close events and listener shutdown so connection accounting settles before returning. */
  async close() {
    this.closing = true;
    const closed = [...this.sockets.keys()].map(socket => new Promise(resolve => socket.once('close', resolve)));
    this.seal();
    await new Promise((resolve, reject) => {
      this.server.close(error => { if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve(); });
    });
    await Promise.all(closed);
    this.budget.abort.signal.removeEventListener('abort', this.onStop);
  }
  /** Return sanitized transport counters, never destinations, headers or payloads. */
  snapshot() { return { ...this.counts, upstream: { ...this.bytes.upstream }, downstream: { ...this.bytes.downstream }, forwardingClosed: !this.forwarding }; }
}

module.exports = { AUTHORITIES, TunnelBudget, ScopedProxy };
