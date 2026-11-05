'use strict';
/* global Buffer, URL, setTimeout, clearTimeout */

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { check, PreparationError, errorCode } = require('./authentication-preparation-scoped-contract.cjs');
const { classifyDestination } = require('./authentication-preparation-traffic.cjs');
const MESSAGE_BYTES = 65536;

/** Correlate method/URL privately in bounded memory; fingerprints are never retained in receipts. */
function fingerprint(request) { return crypto.createHash('sha256').update(`${request.method}\n${request.url}`).digest('hex'); }

/** One raw flattened CDP controller; no Playwright controller participates in the first launch. */
class CdpConnection extends EventEmitter {
  /** Own the supplied loopback WebSocket immediately; the native factory also sets its parser payload cap. */
  constructor(socket, budget) {
    super(); this.socket = socket; this.budget = budget; this.pending = new Map(); this.nextId = 0; this.closed = false;
    socket.on('message', bytes => this.receive(bytes));
    socket.on('error', () => { if (!this.closed && !this.closing) budget.stop('observation'); this.close(); });
    socket.on('close', () => { if (!this.closed && !this.closing) budget.stop('observation'); this.close(); });
  }
  /** Reject malformed/oversized protocol frames without retaining payloads or remote errors. */
  receive(bytes) {
    if (this.closed) return;
    try {
      check(bytes.length <= MESSAGE_BYTES, 'observation'); const message = JSON.parse(bytes.toString());
      if (Object.hasOwn(message, 'id')) {
        const item = this.pending.get(message.id); check(item && message.sessionId === item.sessionId, 'observation');
        this.pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) {
          // Only the opted-in location poll can treat a known navigation/context-loss response as not yet ready.
          const contextLost = item.contextLossAsFalse && message.error.code === -32000
            && ['Cannot find context with specified id', 'Cannot find default execution context',
              'Execution context was destroyed.', 'Inspected target navigated or closed'].includes(message.error.message);
          if (contextLost) item.resolve({ result: { value: false } });
          else { item.reject(new PreparationError('observation')); this.budget.stop('observation'); }
        }
        else item.resolve(message.result || {});
      } else {
        check(typeof message.method === 'string', 'observation'); this.emit('event', message);
      }
    } catch { this.budget.stop('observation'); this.close(); }
  }
  /** Bound commands and lifetime; contextLossAsFalse permits only evaluation polling to tolerate a lost context. */
  send(method, params = {}, sessionId, cleanup = false, { contextLossAsFalse = false } = {}) {
    try {
      if (!cleanup) this.budget.check();
      check(!this.closed && (!cleanup || method === 'Browser.close')
        && this.pending.size < this.budget.limits.pendingCommands, 'observation');
      const id = ++this.nextId; const bytes = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      check(Buffer.byteLength(bytes) <= MESSAGE_BYTES, 'observation');
      return new Promise((resolve, reject) => {
        const timeout = Math.min(cleanup ? 2000 : this.budget.limits.operationMs,
          (cleanup ? this.budget.end : this.budget.deadline) - this.budget.clock());
        if (timeout <= 0) { reject(new PreparationError('deadline')); return; }
        const timer = setTimeout(() => {
          this.pending.delete(id); reject(new PreparationError('deadline')); this.budget.stop('deadline'); this.close();
        }, timeout);
        this.pending.set(id, { resolve, reject, timer, sessionId,
          contextLossAsFalse: contextLossAsFalse === true && !cleanup && method === 'Runtime.evaluate' });
        try { this.socket.send(bytes); } catch { this.budget.stop('observation'); this.close(); }
      });
    } catch (error) { this.budget.stop(errorCode(error)); return Promise.reject(new PreparationError(errorCode(error))); }
  }
  /** Reject pending commands and terminate only the local controller socket, never kill Chrome. */
  close() {
    if (this.closed) return; this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new PreparationError('observation')); }
    this.pending.clear(); this.socket.terminate();
  }
}

/** Reconcile bounded Fetch/Network hop records while enforcing a pause-before-resume target barrier. */
class ScopedObserver {
  /** Keep protocol IDs ephemeral; only aggregate ledger evidence can leave this object. */
  constructor(connection, budget, classify = classifyDestination) {
    this.connection = connection; this.budget = budget; this.classify = classify; this.phase = 'login';
    this.targets = new Map(); this.streams = new Map(); this.hops = 0; this.tasks = new Set(); this.fetchIds = new Set();
    this.closing = false; this.ready = false; this.oauthAttempts = 0;
    this.onEvent = message => {
      if (this.closing) return;
      try { this.handle(message); } catch (error) { budget.stop(errorCode(error)); }
    };
    connection.on('event', this.onEvent);
    this.onStop = () => { for (const stream of this.streams.values()) for (const hop of stream.hops) clearTimeout(hop.timer); };
    budget.abort.signal.addEventListener('abort', this.onStop, { once: true });
  }
  /** Track asynchronous setup/continuation in a bounded set, latching any first error. */
  track(promise) {
    this.budget.require(this.tasks.size < this.budget.limits.pendingCommands, 'observation');
    const tracked = promise.catch(error => this.budget.stop(errorCode(error)));
    this.tasks.add(tracked); tracked.finally(() => this.tasks.delete(tracked)); return tracked;
  }
  /** Arm related-target pausing before creating either owned page; reject pre-existing active targets. */
  async start() {
    const existing = await this.connection.send('Target.getTargets');
    this.budget.require(Array.isArray(existing.targetInfos)
      && existing.targetInfos.every(target => target.type === 'browser'), 'observation');
    await this.connection.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await this.connection.send('Target.setDiscoverTargets', { discover: true });
    this.budget.check(); this.ready = true;
  }
  /** Validate every relevant event before mutation; unsupported targets and observation loss stop the run. */
  handle(message) {
    const { method, params = {}, sessionId } = message;
    if (!/^(Target\.|Fetch\.|Network\.|Inspector\.)/.test(method)) return;
    this.budget.event();
    if (method === 'Target.attachedToTarget') { this.attach(params); return; }
    if (method === 'Target.targetCreated') {
      this.budget.require(['browser', 'page', 'iframe'].includes(params.targetInfo?.type), 'observation'); return;
    }
    if (['Target.detachedFromTarget', 'Target.targetCrashed', 'Target.targetDestroyed', 'Inspector.detached'].includes(method)) {
      this.budget.stop('observation'); return;
    }
    if (method.startsWith('Target.')) return;
    const target = this.targets.get(sessionId);
    this.budget.require(target?.ready, 'observation');
    if (['Network.webSocketCreated', 'Network.eventSourceMessageReceived', 'Network.requestServedFromCache'].includes(method)) {
      this.budget.stop('observation'); return;
    }
    if (method === 'Fetch.requestPaused') this.track(this.pause(sessionId, params));
    else if (method === 'Network.requestWillBeSent') this.network(sessionId, params);
    else if (method === 'Network.responseReceived') {
      this.budget.require(!params.response?.fromDiskCache && !params.response?.fromServiceWorker, 'observation');
      this.response(sessionId, params.requestId, false, params.response?.status);
    } else if (method === 'Network.loadingFinished') this.response(sessionId, params.requestId, true);
    else if (method === 'Network.loadingFailed') this.budget.stop('operation');
  }
  /** Register ownership synchronously, before any asynchronous target initialization. */
  attach(event) {
    const info = event.targetInfo;
    this.budget.require(event.waitingForDebugger === true && ['page', 'iframe'].includes(info?.type)
      && typeof event.sessionId === 'string' && event.sessionId.length <= 256
      && typeof info.targetId === 'string' && info.targetId.length <= 256
      && !this.targets.has(event.sessionId) && this.targets.size < this.budget.limits.targetSessions, 'observation');
    if (info.type === 'page') this.budget.require([...this.targets.values()].filter(item => item.type === 'page').length
      < this.budget.limits.pages && info.url === 'about:blank', 'observation');
    const target = { id: info.targetId, type: info.type, sessionId: event.sessionId, ready: false };
    this.targets.set(event.sessionId, target); this.track(this.initialize(target));
  }
  /** Install interception and recursively pause child targets before the sole controller resumes activity. */
  async initialize(target) {
    for (const [method, params] of [
      ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
      ['Network.enable', {}], ['Network.setCacheDisabled', { cacheDisabled: true }],
      ['Network.setBypassServiceWorker', { bypass: true }],
      ['Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }],
    ]) await this.connection.send(method, params, target.sessionId);
    this.budget.check(); target.ready = true;
    await this.connection.send('Runtime.runIfWaitingForDebugger', {}, target.sessionId);
  }
  /** Resolve readiness only after both owned blank pages are attached and all setup commands finish. */
  async createPage() {
    this.budget.require(this.ready, 'observation');
    const created = await this.connection.send('Target.createTarget', { url: 'about:blank' });
    await Promise.all([...this.tasks]); this.budget.check();
    const target = [...this.targets.values()].find(item => item.id === created.targetId);
    this.budget.require(target?.ready, 'observation'); return target;
  }
  /** Retrieve bounded stream/hop storage, retaining only IDs, flags and ledger tokens. */
  stream(session, id) {
    this.budget.require(typeof id === 'string' && id.length > 0 && id.length <= 256, 'observation');
    const key = `${session}:${id}`;
    if (!this.streams.has(key)) {
      this.budget.require(this.streams.size < this.budget.limits.records, 'observation');
      this.streams.set(key, { network: 0, fetch: 0, hops: [] });
    }
    return this.streams.get(key);
  }
  /** Create one bounded redirect-hop slot regardless of which event stream arrives first. */
  hop(stream, index) {
    if (!stream.hops[index]) {
      this.budget.require(index === stream.hops.length && ++this.hops <= this.budget.limits.records, 'observation');
      const hop = { token: null, slot: this.budget.observeSlot(), response: false, done: false,
        confirmed: false, finished: false, network: false };
      hop.timer = setTimeout(() => this.budget.stop('observation'), this.budget.limits.operationMs);
      stream.hops.push(hop);
    }
    return stream.hops[index];
  }
  /** Observe every HTTP redirect hop without retaining URLs; redirects complete the previous reservation. */
  network(session, event) {
    if (event.request?.url === 'data:,') return;
    const kind = this.classify(event.request?.url, event.request?.method, this.phase);
    const stream = this.stream(session, event.requestId); const index = stream.network++;
    if (index > 0) {
      this.budget.require(!!event.redirectResponse, 'observation');
      const previous = this.hop(stream, index - 1); previous.response = true; previous.done = true; this.reconcile(previous);
    } else this.budget.require(!event.redirectResponse, 'observation');
    const hop = this.hop(stream, index); hop.network = true; hop.kind = kind;
    hop.networkFingerprint = fingerprint(event.request); this.reconcile(hop);
  }
  /** Reserve before continuation; redirect hops never share reservations or refund failed dispatches. */
  async pause(session, event) {
    this.budget.check();
    this.budget.require(typeof event.requestId === 'string' && event.requestId.length <= 256, 'observation');
    const fetchId = `${session}:${event.requestId}`;
    this.budget.require(!this.fetchIds.has(fetchId) && this.fetchIds.size < this.budget.limits.records, 'observation'); this.fetchIds.add(fetchId);
    const stream = this.stream(session, event.networkId); const hop = this.hop(stream, stream.fetch++);
    const kind = this.classify(event.request?.url, event.request?.method, this.phase);
    hop.fetchFingerprint = fingerprint(event.request);
    if (hop.network) this.budget.require(hop.networkFingerprint === hop.fetchFingerprint, 'observation');
    if (kind === 'supabase' && new URL(event.request.url).pathname === '/auth/v1/authorize') {
      this.budget.require(++this.oauthAttempts === 1, 'budget');
    }
    this.budget.require(!event.request?.hasPostData || typeof event.request.postData === 'string', 'observation');
    this.budget.body(Buffer.byteLength(event.request?.postData || ''));
    hop.token = this.budget.reserve(kind, 'page', hop.slot); this.reconcile(hop);
    await this.connection.send('Fetch.continueRequest', { requestId: event.requestId }, session);
    this.budget.check(); this.budget.acknowledge(hop.token);
  }
  /** Pair response/finish events only with an already observed Network hop. */
  response(session, id, done, status) {
    const stream = this.stream(session, id); this.budget.require(stream.network > 0, 'observation');
    const hop = this.hop(stream, stream.network - 1);
    if (!done && ['supabase', 'google'].includes(hop.kind)) this.budget.require(Number.isInteger(status) && status < 400, 'operation');
    if (done) { this.budget.require(hop.response, 'observation'); hop.done = true; }
    else { this.budget.require(!hop.response, 'observation'); hop.response = true; }
    this.reconcile(hop);
  }
  /** Apply each independent observation once, tolerating Fetch/Network callback ordering. */
  reconcile(hop) {
    if (!hop.token) return;
    if (hop.network) this.budget.require(hop.networkFingerprint === hop.fetchFingerprint, 'observation');
    if (hop.response && !hop.confirmed) { this.budget.confirm(hop.token); hop.confirmed = true; }
    if (hop.done && hop.network && !hop.finished) {
      this.budget.finish(hop.token); hop.finished = true; clearTimeout(hop.timer);
    }
  }
  /** Require complete paired event streams and no pending dispatch before a passing worker can close. */
  async summary() {
    await Promise.all([...this.tasks]); this.budget.check();
    this.budget.require([...this.streams.values()].every(stream => stream.network === stream.fetch
      && stream.hops.every(hop => hop.finished && hop.confirmed)), 'observation');
    return { pairedPageEvents: true, browserTrafficMeasured: false };
  }
  /** Suppress expected shutdown detachment only after the caller seals forwarding and checks summary. */
  close() {
    this.closing = true; this.onStop(); this.connection.removeListener('event', this.onEvent);
    this.budget.abort.signal.removeEventListener('abort', this.onStop);
  }
}

module.exports = { MESSAGE_BYTES, CdpConnection, ScopedObserver };
