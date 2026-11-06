'use strict';
/* global __dirname, Buffer, setTimeout */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const net = require('node:net');
const c = require('./authentication-preparation-scoped-contract.cjs');
const n = require('./authentication-preparation-scoped-native-contract.cjs');
const { ScopedProxy } = require('./authentication-preparation-scoped-proxy.cjs');
const CERT = path.join(__dirname, 'fixtures/scoped-native-loopback-cert.pem');
const KEY = path.join(__dirname, 'fixtures/scoped-native-loopback-key.pem');
const COOKIE_NAME = 'gate1_public_synthetic';
const INITIAL = 'public-test-initial'; const UPDATED = 'public-test-updated';

/** Read only the two public test files and verify SAN, key pairing and the frozen SPKI pin offline. */
async function certificate(io = fs) {
  const cert = await io.readFile(CERT); const key = await io.readFile(KEY); const x509 = new crypto.X509Certificate(cert);
  const spki = x509.publicKey.export({ type: 'spki', format: 'der' });
  c.check(x509.subjectAltName === 'IP Address:127.0.0.1, IP Address:127.0.0.2'
    && crypto.createHash('sha256').update(spki).digest('base64') === n.SPKI
    && x509.checkPrivateKey(crypto.createPrivateKey(key)), 'integrity');
  return { cert, key, certificateHash: crypto.createHash('sha256').update(cert).digest('hex'),
    keyHash: crypto.createHash('sha256').update(key).digest('hex') };
}

/** Compare synthetic cookies privately at the fixture; never return or retain their raw values. */
function cookieState(raw = '') {
  const items = raw.split(';').map(item => item.trim()).filter(item => item.startsWith(`${COOKIE_NAME}=`));
  if (items.length !== 1) return 'absent';
  return items[0] === `${COOKIE_NAME}=${INITIAL}` ? 'initial' : items[0] === `${COOKIE_NAME}=${UPDATED}` ? 'updated' : 'invalid';
}

/** Wait on a categorical native witness within one absolute operation deadline, with no polling HTTP. */
async function waitFor(predicate, budget, milliseconds = n.LIMITS.operationMs, allowStopped = false) {
  const deadline = Math.min(allowStopped ? budget.end : budget.deadline, budget.clock() + milliseconds);
  while (budget.clock() < deadline) {
    if (!allowStopped) budget.check(); if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new c.PreparationError('coverage_unqualified');
}

/** Bind one fixed listener and retain ownership even when listen fails or the attempt aborts. */
function listen(server, host, port, stopped = () => false) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new c.PreparationError('fixture'));
    c.check(!stopped(), 'stopped');
    server.once('error', fail); server.listen(port, host, () => {
      server.removeListener('error', fail);
      if (stopped()) { server.close(() => {}); reject(new c.PreparationError('stopped')); } else resolve();
    });
  });
}

/** Close a retained server after its owned sockets; never forget a late connection callback. */
function closeServer(server) {
  return new Promise((resolve, reject) => server.close(error => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(new c.PreparationError('closure')); else resolve();
  }));
}

/** Own fixed HTTPS listeners and record only server-side categorical witnesses and actual request counters. */
class Fixtures {
  /** Construction performs no I/O, permitting mocked tests to exercise the actual route policy. */
  constructor(root, { createServer = https.createServer } = {}) {
    this.root = root; this.createServer = createServer; this.servers = []; this.sockets = new Set(); this.closing = false;
    this.counts = { requests: 0, sessionInitial: 0, readyInitial: 0, readyUpdated: 0, writeBack: 0, workerProbe: 0,
      held: 0, heldClosed: 0, start: 0, hop: 0, frame: 0 }; this.seedTokens = null;
  }
  /** Start only the approved main/frame origins; all resources are owned before asynchronous listen. */
  async start(material) {
    for (const [host, port, origin] of [['127.0.0.1', 18443, n.ORIGIN], ['127.0.0.2', 18444, n.FRAME_ORIGIN]]) {
      this.root.check(); c.check(!this.closing, 'stopped');
      const server = this.createServer({ key: material.key, cert: material.cert, maxHeaderSize: 8192,
        headersTimeout: 5000, requestTimeout: 5000 }, (request, response) => this.handle(origin, request, response));
      this.servers.push(server);
      server.on('connection', socket => {
        socket.on('error', () => {});
        if (this.closing || this.root.failure || this.sockets.size >= 8) {
          socket.destroy(); if (!this.closing && !this.root.failure) this.root.stop('budget'); return;
        }
        this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); socket.setTimeout(5000, () => socket.destroy());
      });
      server.on('error', () => this.root.stop('fixture'));
      server.on('clientError', (_error, socket) => { this.root.stop('fixture'); socket.destroy(); });
      await listen(server, host, port, () => this.closing || !!this.root.failure); this.root.check();
    }
  }
  /** Admit exact GET routes with no bodies; raw headers and cookie values stay inside this synchronous call. */
  handle(origin, request, response) {
    try {
      this.root.check(); n.requireDestination(!this.closing, 'fixture_closing', this.root);
      n.requireDestination(request.headers.host === origin.slice(8), 'fixture_host', this.root);
      n.requireDestination(!request.headers['transfer-encoding'], 'fixture_transfer_encoding', this.root);
      n.requireDestination(!request.headers['content-length'] || request.headers['content-length'] === '0', 'fixture_content_length', this.root);
      n.classify(`${origin}${request.url}`, request.method, this.root);
      this.root.charge({ fixtureRequests: 1, ...(request.url === '/api/auth/session' ? { fixtureSession: 1 } : {}),
        ...(request.url === '/worker-probe' ? { fixtureProbe: 1 } : {}) }); this.counts.requests++;
      request.on('data', bytes => { this.root.active?.body(bytes.length); this.root.destination('fixture_body'); request.destroy(); response.destroy(); });
      const cookie = cookieState(request.headers.cookie); const route = request.url;
      if (this.seedTokens) {
        const entry = this.seedTokens.get(route); c.check(entry && !entry.used, 'budget'); entry.used = true;
        entry.budget.acknowledge(entry.token); entry.budget.confirm(entry.token); entry.budget.finish(entry.token);
      }
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Connection', 'close');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (route === '/start' || route === '/hop') {
        this.counts[route.slice(1)]++; response.statusCode = 302;
        response.setHeader('Location', route === '/start' ? '/hop' : '/ready');
        if (route === '/start') response.setHeader('Set-Cookie', `${COOKIE_NAME}=${INITIAL}; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax`);
        response.end(); return;
      }
      if (route === '/api/auth/session') {
        c.check(cookie === 'initial' || cookie === 'updated', 'identity'); if (cookie === 'initial') this.counts.sessionInitial++;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: null, message: 'Success', data: { user: { id: n.ID } } })); return;
      }
      if (route === '/api/native/writeback') {
        c.check(cookie === 'initial', 'identity'); this.counts.writeBack++;
        response.setHeader('Set-Cookie', `${COOKIE_NAME}=${UPDATED}; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax`);
        response.end('{}'); return;
      }
      if (route === '/api/native/hold') {
        this.counts.held++; request.socket.once('close', () => { this.counts.heldClosed++; }); return;
      }
      if (route === '/worker-probe') { this.counts.workerProbe++; response.end('synthetic'); return; }
      if (route === '/worker.js') {
        response.setHeader('Content-Type', 'application/javascript'); response.setHeader('Service-Worker-Allowed', '/');
        response.end("fetch('/worker-probe',{cache:'no-store'}).catch(()=>{});self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));"); return;
      }
      if (route === '/worker-seed') {
        response.end("<!doctype html><link rel='icon' href='data:,'><script>navigator.serviceWorker.register('/worker.js',{scope:'/'}).catch(()=>{});</script>synthetic worker"); return;
      }
      if (route === '/ready') { if (cookie === 'initial') this.counts.readyInitial++; if (cookie === 'updated') this.counts.readyUpdated++; }
      if (route === '/frame') this.counts.frame++;
      if (route === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
      const frame = route === '/' ? `<iframe src="${n.FRAME_ORIGIN}/frame"></iframe>` : '';
      response.end(`<!doctype html><link rel="icon" href="data:,"><title>Synthetic qualification</title>${frame}`);
    } catch (error) { this.root.stop(c.errorCode(error)); request.destroy(); response.destroy(); }
  }
  /** Pre-reserve every possible worker seed request before the unobserved setup page is navigated. */
  seed(budget) {
    c.check(!this.seedTokens, 'fixture'); this.seedTokens = new Map();
    for (const route of ['/worker-seed', '/worker.js', '/worker-probe']) {
      this.seedTokens.set(route, { budget, token: budget.reserve(n.classify(`${n.ORIGIN}${route}`, 'GET', budget)), used: false });
    }
  }
  /** Require all pre-reserved setup requests witnessed; setup is never counted as observed page coverage. */
  finishSeed() {
    c.check(this.seedTokens && [...this.seedTokens.values()].every(item => item.used), 'coverage_unqualified'); this.seedTokens = null;
  }
  /** Close owned sockets before listeners, including a held request or partially started server. */
  async close() {
    this.closing = true; for (const socket of this.sockets) socket.destroy();
    const results = await Promise.allSettled(this.servers.map(server => closeServer(server)));
    c.check(results.every(result => result.status === 'fulfilled'), 'closure');
  }
}

/** Run the fixed socket subcases using real loopback sockets; callback injection is labeled separately. */
async function transportProbes(root, deps = {}) {
  const s = require('./authentication-preparation-scoped.cjs');
  const createServer = deps.createServer || net.createServer; const connect = deps.connect || net.connect;
  const result = Object.fromEntries(n.WITNESSES.transport.map(key => [key, false]));
  const cases = ['head', 'upstream', 'downstream', 'combined', 'backpressure', 'idle', 'preconnect', 'pending'];
  for (const name of cases) {
    const limits = { operationMs: 2000, ...(name === 'upstream' ? { upstreamBytes: 16 } : {}),
      ...(name === 'downstream' ? { downstreamBytes: 16 } : {}), ...(name === 'combined' ? { tunnelBytes: 16 } : {}) };
    const budget = new n.NativeBudget(root, n.CASES[8], limits); const sockets = new Set(); let sink; let proxy; let client;
    let accepted = 0; let received = 0; let closed = false; let header = ''; let connected = false; let closing = false; let failure;
    try {
      sink = createServer(socket => {
        if (closing || budget.failure || root.failure) { socket.on('error', () => {}); socket.destroy(); return; }
        sockets.add(socket); accepted++; socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
        if (['backpressure', 'pending'].includes(name)) socket.pause();
        else socket.on('data', bytes => { received += bytes.length; if (['downstream', 'combined'].includes(name)) socket.write(Buffer.alloc(32)); });
      });
      sink.on('error', () => budget.stop('fixture'));
      await s.step(budget, () => listen(sink, '127.0.0.1', 18446, () => !!budget.failure));
      proxy = deps.proxy ? deps.proxy(budget) : new ScopedProxy(budget, { synthetic: 'transport' });
      await s.step(budget, () => proxy.start()); proxy.open();
      client = connect({ host: '127.0.0.1', port: 18445 }); client.on('error', () => {});
      client.once('close', () => { closed = true; });
      client.on('data', bytes => {
        if (!connected) {
          if (Buffer.byteLength(header) + bytes.length > 8192) { budget.stop('observation'); client.destroy(); return; }
          header += bytes.toString('ascii'); if (header.includes('\r\n\r\n')) { connected = true; header = ''; }
        }
      });
      await s.step(budget, () => new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', () => reject(new c.PreparationError('fixture'))); }));
      if (name === 'preconnect') {
        await waitFor(() => closed, budget, 3000, true); result.preConnectTimeout = budget.failure === 'deadline';
      } else {
        client.write(Buffer.concat([Buffer.from('CONNECT 127.0.0.1:18446 HTTP/1.1\r\nHost: 127.0.0.1:18446\r\n\r\n'),
          Buffer.alloc(name === 'head' ? 4 : name === 'upstream' ? 32 : 0)]));
        if (name === 'upstream') {
          await waitFor(() => closed, budget, 3000, true); result.upstreamOverflow = budget.failure === 'budget' && accepted === 0;
        } else {
          await waitFor(() => connected, budget);
          if (name === 'head') { await waitFor(() => received === 4, budget); result.headBeforeConnect = proxy.evidence.headBeforeConnect === 1 && proxy.bytes.upstream.admitted === 4; }
          if (['downstream', 'combined'].includes(name)) {
            client.write(Buffer.alloc(8)); await waitFor(() => closed, budget, 3000, true);
            result[name === 'downstream' ? 'downstreamOverflow' : 'combinedOverflow'] = budget.failure === 'budget' && proxy.bytes.downstream.rejected > 0;
          }
          if (name === 'backpressure') {
            for (let index = 0; index < 32 && !proxy.evidence.backpressure; index++) { budget.check(); client.write(Buffer.alloc(65536)); await new Promise(resolve => setTimeout(resolve, 10)); }
            result.socketBackpressure = proxy.evidence.backpressure > 0;
          }
          if (name === 'idle') { await waitFor(() => closed, budget, 3000); result.idleClosure = !budget.failure; }
          if (name === 'pending') {
            let owner; const forward = proxy.forward.bind(proxy);
            /** Deliberately close at a witnessed real backpressure boundary while native socket work is pending. */
            proxy.forward = (candidate, ...args) => {
              forward(candidate, ...args);
              if (candidate.upstream?.writableNeedDrain && proxy.evidence.backpressure > 0) { owner = candidate; proxy.seal(); }
            };
            for (let index = 0; index < 32 && !owner; index++) {
              budget.check(); client.write(Buffer.alloc(65536)); await new Promise(resolve => setTimeout(resolve, 10));
            }
            c.check(owner, 'coverage_unqualified'); await waitFor(() => closed, budget);
            result.pendingClosed = owner.socket.destroyed && owner.upstream.destroyed;
            // Controlled late callbacks on real destroyed sockets test the guard, not a naturally observed race.
            const written = proxy.bytes.upstream.written; owner.upstream.emit('drain'); owner.upstream.emit('connect');
            result.lateCallbackBlocked = proxy.evidence.lateBlocked > 0 && proxy.bytes.upstream.written === written && !proxy.forwarding;
          }
        }
      }
      const expected = ['upstream', 'downstream', 'combined'].includes(name) ? 'budget' : name === 'preconnect' ? 'deadline' : null;
      c.check(budget.failure === expected, 'coverage_unqualified');
      const required = { head: ['headBeforeConnect'], upstream: ['upstreamOverflow'], downstream: ['downstreamOverflow'],
        combined: ['combinedOverflow'], backpressure: ['socketBackpressure'], idle: ['idleClosure'],
        preconnect: ['preConnectTimeout'], pending: ['pendingClosed', 'lateCallbackBlocked'] };
      c.check(required[name].every(key => result[key] === true), 'coverage_unqualified');
    } catch (error) { failure = error; root.stop(c.errorCode(error)); }
    finally {
      closing = true;
      client?.destroy(); for (const socket of sockets) socket.destroy();
      const cleanup = await Promise.all([
        proxy ? s.cleanup(budget, async () => { await proxy.close(); return true; }) : true,
        sink ? s.cleanup(budget, async () => { await closeServer(sink); return true; }) : true,
      ]);
      try { c.check(cleanup.every(value => value === true), 'closure'); root.finishCase(budget); }
      catch (error) { failure ||= error; root.cleanupFailed = true; root.stop('closure'); }
    }
    if (failure) throw failure;
  }
  c.check(Object.values(result).every(Boolean), 'coverage_unqualified'); return result;
}

module.exports = { CERT, KEY, certificate, cookieState, waitFor, listen, closeServer, Fixtures, transportProbes };
