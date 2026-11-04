'use strict';
/* global URL */

/** Offline traffic controls. Importing does not create sockets or enable hosted execution. */
const { TARGET } = require('./hosted-csrf-diagnostic.cjs');
const LIMITS = Object.freeze({ wholeMs: 900000, cleanupMs: 60000, manualMs: 600000,
  operationMs: 30000, restartMs: 5000, metadataMs: 30000, launches: 2, pages: 2,
  application: 24, session: 8, canonicalStatic: 80, providerStatic: 120,
  supabase: 4, google: 96, metadata: 6, proxyConnections: 128, proxyConcurrent: 16,
  proxyBytes: 67108864, receiptBytes: 16384 });
const SUPPORT = Object.freeze(['www.gstatic.com', 'ssl.gstatic.com', 'fonts.gstatic.com',
  'fonts.googleapis.com', 'lh3.googleusercontent.com']);
const SUPABASE = 'apxfjggdcybjticrnbpk.supabase.co';
const ROUTES = Object.freeze(['/', '/login', '/auth/callback', '/api/auth/session', '/api/auth/csrf', '/api']);
const CODES = new Set(['arguments', 'approval', 'expired', 'target', 'identity', 'schema', 'integrity',
  'coverage_unqualified', 'destination', 'budget', 'deadline', 'stopped', 'observation', 'operation',
  'cancelled', 'closure', 'process_inspection', 'process_present', 'port_open', 'receipt', 'already_used',
  'toolchain', 'profile', 'debug_logging', 'fixture', 'worker_completion']);

/** Use a closed vocabulary so rejected URLs, native errors and private values never reach evidence. */
class PreparationError extends Error {
  /** Retain only an approved local category, never the supplied message. */
  constructor(code) { super(CODES.has(code) ? code : 'operation'); this.code = this.message; }
}

/** Enforce an invariant without reporting the rejected value. */
function check(value, code) { if (!value) throw new PreparationError(code); }

/** Reduce arbitrary dependency failures to the same non-sensitive error vocabulary. */
function errorCode(error) { return error instanceof PreparationError ? error.code : 'operation'; }

/** Classify a proposed browser dispatch in memory; URLs and query values are never returned. */
function classifyDestination(raw, method, phase) {
  check(typeof raw === 'string' && raw.length <= 16384 && ['GET', 'POST'].includes(method), 'destination');
  let url;
  try { url = new URL(raw); } catch { throw new PreparationError('destination'); }
  check(url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username
    && !url.password && !url.hash && !raw.includes('\\') && [...raw].every(char => char.charCodeAt(0) > 32), 'destination');
  check(['login', 'oauth', 'verify', 'restart'].includes(phase), 'destination');
  if (url.hostname === TARGET.canonical && method === 'GET') {
    if (phase === 'restart') { check(url.pathname === '/api/auth/session' && !url.search, 'destination'); return 'session'; }
    if (ROUTES.includes(url.pathname)) return url.pathname === '/api/auth/session' ? 'session' : 'application';
    if (url.pathname.startsWith('/_next/static/') || url.pathname === '/favicon.png') return 'canonicalStatic';
  }
  if (phase === 'oauth') {
    if (url.hostname === SUPABASE && method === 'GET'
      && ['/auth/v1/authorize', '/auth/v1/callback'].includes(url.pathname)) return 'supabase';
    if (url.hostname === 'accounts.google.com') return 'google';
    if (SUPPORT.includes(url.hostname) && method === 'GET') return 'providerStatic';
  }
  throw new PreparationError('destination');
}

/** Reserve every HTTP hop before continuation, including failures; a stop permanently closes dispatch. */
class TrafficBudget {
  /** Use a private counter set and one clock; callers receive only copied snapshots. */
  constructor({ clock = Date.now, limits = LIMITS } = {}) {
    this.clock = clock; this.limits = Object.freeze({ ...limits }); this.startedAt = clock();
    this.deadline = this.startedAt + limits.wholeMs - limits.cleanupMs;
    this.failure = null; this.halted = false;
    this.counts = { application: 0, session: 0, canonicalStatic: 0, providerStatic: 0,
      supabase: 0, google: 0, metadata: 0, launches: 0, proxyConnections: 0, proxyBytes: 0 };
  }
  /** Preserve the first categorical cause even when cleanup or late completions also fail. */
  stop(code) { this.failure ||= CODES.has(code) ? code : 'operation'; this.halted = true; }
  /** Deadline checks also latch failure, preventing retries after the clock later changes. */
  check() {
    if (this.halted) throw new PreparationError('stopped');
    if (this.clock() >= this.deadline) { this.stop('deadline'); throw new PreparationError('deadline'); }
  }
  /** Atomically reserve coupled application/session counters; rejected reservations never dispatch. */
  reserve(kind, amount = 1) {
    this.check();
    check(Number.isSafeInteger(amount) && amount > 0 && Object.hasOwn(this.counts, kind), 'schema');
    const keys = kind === 'session' ? ['application', 'session'] : [kind];
    if (keys.some(key => this.counts[key] + amount > this.limits[key])) {
      this.stop('budget'); throw new PreparationError('budget');
    }
    for (const key of keys) this.counts[key] += amount;
  }
  /** Reuse the existing browser launch helper's counter interface. */
  count(kind) { this.reserve(kind); }
  /** Project measured increments; static includes both application and provider resources. */
  snapshot() {
    const counts = { application: this.counts.application, static: this.counts.canonicalStatic + this.counts.providerStatic,
      session: this.counts.session };
    return { counters: { ...this.counts }, requests: { actual: counts, conservative: { ...counts } },
      firstFailure: this.failure };
  }
}

/**
 * Observe one page's HTTP hops through CDP Fetch and Network. This is deliberately NOT
 * a browser-wide coverage assertion. The classifier is fixed by the offline caller.
 */
class PageTrafficObserver {
  /** Keep ephemeral protocol IDs in memory only; bounded maps contain no URLs or payloads. */
  constructor(session, budget, classify) {
    this.session = session; this.budget = budget; this.classify = classify;
    this.ready = false; this.closed = false; this.allowed = 0; this.blocked = 0;
    this.network = new Map(); this.paused = new Map(); this.pending = new Set(); this.events = 0;
    this.onNetwork = event => this.observe(event);
    this.onPaused = event => {
      const pending = this.dispatch(event).catch(() => { this.budget.stop('observation'); });
      this.pending.add(pending); pending.finally(() => this.pending.delete(pending));
    };
    this.onSocket = () => this.budget.stop('observation');
    this.onDetached = () => { if (!this.closed) this.budget.stop('observation'); };
  }
  /** Bound event storage before accepting identifiers, including redirects reusing a Network ID. */
  increment(map, id) {
    check(typeof id === 'string' && id.length <= 256 && ++this.events <= 1024, 'observation');
    map.set(id, (map.get(id) || 0) + 1);
  }
  /** Record each Network event, including redirect hops, without retaining request contents. */
  observe(event) {
    // The fixture's exact inline favicon is not an HTTP dispatch and never reaches Fetch.
    if (event.request?.url === 'data:,') return;
    try { this.increment(this.network, event.requestId); }
    catch { this.budget.stop('observation'); }
  }
  /** Install listeners and await interception readiness before the caller can navigate. */
  async start() {
    this.session.on('Network.requestWillBeSent', this.onNetwork);
    this.session.on('Fetch.requestPaused', this.onPaused);
    this.session.on('Network.webSocketCreated', this.onSocket);
    this.session.on('Disconnected', this.onDetached);
    await this.session.send('Network.enable');
    await this.session.send('Network.setCacheDisabled', { cacheDisabled: true });
    await this.session.send('Network.setBypassServiceWorker', { bypass: true });
    await this.session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    this.budget.check(); this.ready = true;
  }
  /** Reserve immediately before continueRequest; abort on every failure or deliberate synthetic denial. */
  async dispatch(event) {
    let continued = false;
    try {
      this.budget.check(); check(this.ready && !this.closed, 'observation');
      this.increment(this.paused, event.networkId);
      const category = this.classify(event.request?.url, event.request?.method);
      if (category === 'synthetic_denial') this.blocked++;
      else {
        this.budget.reserve(category); this.allowed++;
        this.budget.check();
        await this.session.send('Fetch.continueRequest', { requestId: event.requestId });
        continued = true;
      }
    } catch (error) { this.budget.stop(errorCode(error)); }
    finally {
      if (!continued) await this.session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
        .catch(() => { this.budget.stop('observation'); });
    }
  }
  /** Require two independent page event streams to agree; this still excludes background HTTP traffic. */
  async summary() {
    await Promise.all([...this.pending]); this.budget.check();
    if (this.network.size !== this.paused.size || ![...this.network].every(([id, count]) => this.paused.get(id) === count)) {
      this.budget.stop('observation'); throw new PreparationError('observation');
    }
    return { allowed: this.allowed, blocked: this.blocked, pairedPageEvents: true,
      browserTrafficMeasured: false, coverage: 'page_http_only' };
  }
  /** Stop page continuation and remove listeners only during owned-browser cleanup. */
  async close() {
    this.closed = true; this.ready = false;
    await Promise.all([...this.pending]);
    this.session.removeListener('Network.requestWillBeSent', this.onNetwork);
    this.session.removeListener('Fetch.requestPaused', this.onPaused);
    this.session.removeListener('Network.webSocketCreated', this.onSocket);
    this.session.removeListener('Disconnected', this.onDetached);
    await this.session.detach().catch(() => {});
  }
}

/** Reject live qualification unconditionally until an independently reviewed coverage mechanism exists. */
function requireLiveCoverage() { throw new PreparationError('coverage_unqualified'); }

module.exports = { LIMITS, SUPPORT, SUPABASE, ROUTES, PreparationError, check, errorCode,
  classifyDestination, TrafficBudget, PageTrafficObserver, requireLiveCoverage };
