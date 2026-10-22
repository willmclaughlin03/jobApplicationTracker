'use strict';
/* global AbortController, AbortSignal, Buffer, URL, __dirname, clearTimeout, document, fetch, process, setTimeout, window */

/**
 * Local GATE-1 browser qualifier. CLI modes are offline only; importing this file
 * has no effects. runProfiles additionally requires explicit live approval, an
 * already prepared exclusive browser context, and an owner-approved identity.
 * No credential files, environment values, or raw logs are read. Only the prepared
 * browser's generated-host protection cookie is read in memory for scoped probes.
 */
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

const CORE_VERSION = '1.62.0-alpha-1783623505000';
const TARGET = Object.freeze({
  origin: 'https://job-application-tracker-kappa-seven.vercel.app',
  immutableOrigin: 'https://job-application-tracker-nc08q52tw-track-the-app.vercel.app',
  deployment: null, // Current Vercel dpl_ ID has not been independently retrieved.
  deploymentReference: 'https://vercel.com/track-the-app/job-application-tracker/5H29GHpsA9x4HQU5P4nDTNbEZm7h',
  githubDeployment: '7237630456',
  commit: '9cb88f0ab1bee2c8921ceb0092de3c9fcd169c7e',
  build: 'aueJAQi4zQIKVDr0go3VB',
});
// Static /login is deployment-cached; this policy attributes its build, not origin execution.
// https://vercel.com/docs/caching/cdn-cache/purge documents deployment-specific cache keys.
const BUILD_POLICY = Object.freeze({
  cacheControl: 'max-age=0,must-revalidate,public',
  cacheStatuses: Object.freeze(['MISS', 'BYPASS', 'REVALIDATED', 'HIT']),
});
const PROFILES = Object.freeze([
  Object.freeze({ tabs: 1, session: 24, app: 80, static: 80 }),
  Object.freeze({ tabs: 2, session: 48, app: 140, static: 160 }),
  Object.freeze({ tabs: 4, session: 96, app: 260, static: 320 }),
  Object.freeze({ tabs: 8, session: 192, app: 500, static: 640 }),
]);
const SCHEDULE = Object.freeze({
  quietMs: 64_000, startupMs: 20_000, startupSpreadMs: 2_000,
  throttleMs: 30_000, cadenceMs: 31_000, rounds: 19, slotMs: 1_000,
  observationMs: 600_000, drainMs: 5_000, profileMs: 720_000,
  readinessMs: 300_000, totalMs: 3_300_000, requestMs: 5_000, p95Ms: 2_000,
});
const LIVE_APPROVAL = 'GATE1_BROWSER_1_2_4_8_APPROVED';
const RESOURCE_TYPES = new Set(['Stylesheet', 'Script', 'Image', 'Font', 'Media']);
const BODY_LIMIT = 1_048_576;

/** Carry only fixed diagnostic codes; arbitrary browser/provider messages stay private. */
class QualificationError extends Error {
  /** Construct a safe error from an internal, non-user-controlled code. */
  constructor(code) { super(code); this.code = code; }
}

/** Assert a contract without including its potentially sensitive input in the error. */
function requireCondition(condition, code) {
  if (!condition) throw new QualificationError(code);
}

/** Reduce unknown failures to one fixed code; never forward stack traces or messages. */
function safeCode(error) {
  return error instanceof QualificationError ? error.code : 'tool_failure';
}

/** Bound browser acknowledgements that may never arrive after the target has already exited. */
async function withTimeout(promise, timeoutMs, code) {
  let timer;
  // The competing rejection is fixed metadata; it neither logs nor inspects the original error.
  const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new QualificationError(code)), timeoutMs); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

/** Classify a request in memory; retain neither URL queries nor arbitrary path segments. */
function classifyRequest(rawUrl, method, origins, resourceType = '') {
  let url;
  try { url = new URL(rawUrl); } catch { throw new QualificationError('invalid_url'); }
  requireCondition(origins.has(url.origin), 'unexpected_origin');
  requireCondition(!url.username && !url.password, 'url_credentials');
  requireCondition(method === 'GET', 'unexpected_method');
  let kind = 'document';
  if (url.pathname === '/api/auth/session') kind = 'session';
  else if (url.pathname === '/api/auth/csrf') kind = 'csrf';
  else if (url.pathname.startsWith('/api/')) kind = 'other_api';
  else if (url.pathname.startsWith('/_next/data/')) kind = 'data';
  else if (url.pathname.startsWith('/_next/static/') || RESOURCE_TYPES.has(resourceType)
    || url.pathname === '/favicon.ico') kind = 'static';
  return kind;
}

/** Compute median/nearest-rank p95/max from finite browser HTTP durations, not tool latency. */
function summarizeDurations(values) {
  const sorted = [...values].sort((a, b) => a - b);
  requireCondition(sorted.every(Number.isFinite), 'missing_timing');
  if (!sorted.length) return { count: 0, medianMs: null, p95Ms: null, maxMs: null };
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1),
  };
}

/** Compare the response identity privately; only boolean results leave this instance. */
class IdentityObserver {
  #approved;
  #baseline;
  /** Keep the approved synthetic user's ID only in memory, never in a report or log. */
  constructor(approvedId) {
    requireCondition(typeof approvedId === 'string' && approvedId.length > 0, 'account_not_approved');
    this.#approved = approvedId;
  }
  /** Parse the bounded session response and return no profile fields or identifiers. */
  observe(text) {
    requireCondition(typeof text === 'string' && Buffer.byteLength(text) <= BODY_LIMIT, 'body_limit');
    let payload;
    try { payload = JSON.parse(text); } catch { throw new QualificationError('session_schema'); }
    const id = payload?.data?.user?.id;
    const authenticated = typeof id === 'string' && id.length > 0 && id.length <= 200;
    const matchesApprovedAccount = authenticated && id === this.#approved;
    const matchesBaseline = authenticated && (this.#baseline === undefined || id === this.#baseline);
    if (matchesApprovedAccount && matchesBaseline) this.#baseline = id;
    return { authenticated, matchesApprovedAccount, matchesBaseline };
  }
}

/**
 * Reserve dispatches synchronously before any await, sharing caps across all tabs.
 * Already-forwarded/in-flight requests count permanently, including retries.
 */
class RequestBudget {
  /** Accept an injectable clock for boundary/race tests; timers are armed separately. */
  constructor({ clock = performance.now.bind(performance), totalMs = SCHEDULE.totalMs,
    totals = { app: 1000, static: 1280, session: 364 }, rolling = { app: 128, session: 32 } } = {}) {
    this.clock = clock; this.started = clock(); this.deadline = this.started + totalMs;
    this.totals = totals; this.rolling = rolling;
    this.counts = { app: 0, static: 0, session: 0 }; this.window = []; this.records = [];
    this.blocked = 0; this.reason = null; this.controller = new AbortController();
    this.phase = 'readiness'; this.phaseCounts = { app: 0, static: 0, session: 0 };
    this.phaseLimits = { app: 20, static: 80, session: 4 }; this.phaseDeadline = this.started + SCHEDULE.readinessMs;
    this.timer = null; this.onStop = null;
  }
  /** Start one bounded phase; keep total and rolling counts across phase boundaries. */
  begin(phase, limits, durationMs) {
    this.check();
    requireCondition(!this.records.some(record => !record.finished), 'inflight_phase_change');
    this.phase = phase; this.phaseLimits = { ...limits }; this.phaseCounts = { app: 0, static: 0, session: 0 };
    this.phaseDeadline = Math.min(this.deadline, this.clock() + durationMs);
    if (this.timer) this.arm();
  }
  /** Arm the absolute deadline so idle time and stalled network operations cannot evade it. */
  arm() {
    clearTimeout(this.timer);
    // The timer stops the run without logging arbitrary asynchronous errors.
    this.timer = setTimeout(() => this.stop('deadline'), Math.max(0, Math.min(this.deadline, this.phaseDeadline) - this.clock()));
    this.timer.unref();
  }
  /** Reject operations at or after the exact deadline, even if the timer callback is delayed. */
  check() {
    if (!this.reason && this.clock() >= Math.min(this.deadline, this.phaseDeadline)) this.stop('deadline');
    if (this.reason) throw new QualificationError(this.reason);
  }
  /** Reserve one request atomically; no async work may precede counter reservation. */
  reserve(kind, tab = 0) {
    try {
      this.check();
      const now = this.clock();
      // Discard entries exactly outside the half-open 61-second rolling window.
      this.window = this.window.filter(entry => entry.at > now - 61_000);
      const fields = kind === 'static' ? ['static'] : kind === 'session' ? ['app', 'session'] : ['app'];
      for (const field of fields) {
        requireCondition(this.counts[field] < this.totals[field], 'total_budget');
        requireCondition(this.phaseCounts[field] < this.phaseLimits[field], 'profile_budget');
        if (this.rolling[field] !== undefined) {
          // Every dynamic request consumes app capacity; only session requests consume session capacity.
          const used = this.window.filter(entry => field === 'app' ? entry.kind !== 'static' : entry.kind === 'session').length;
          requireCondition(used < this.rolling[field], 'rolling_budget');
        }
      }
      for (const field of fields) { this.counts[field]++; this.phaseCounts[field]++; }
      this.window.push({ at: now, kind });
      const record = { sequence: this.records.length + 1, profile: this.phase, tab, kind, method: 'GET',
        startedMs: now - this.started, status: null, durationMs: null, finished: false, identity: null };
      this.records.push(record);
      return record;
    } catch (error) { this.blocked++; this.stop(safeCode(error)); throw error; }
  }
  /** Latch the first failure and notify the owner of test tabs to close them promptly. */
  stop(code) {
    if (this.reason) return;
    this.reason = code; this.controller.abort(); clearTimeout(this.timer);
    if (this.onStop) this.onStop();
  }
  /** Disarm timers after cleanup without converting a successful run to cancellation. */
  dispose() { clearTimeout(this.timer); this.onStop = null; }
  /** Export only the allowlisted record schema and aggregate budget counters. */
  report() {
    // Copy an explicit schema so late protocol callbacks cannot mutate a delivered report.
    const records = this.records.map(record => ({ sequence: record.sequence, profile: record.profile,
      tab: record.tab, kind: record.kind, method: record.method, startedMs: record.startedMs,
      status: record.status, durationMs: record.durationMs, observationComplete: record.finished,
      timingSource: record.timingSource ?? null,
      timingBoundary: record.timingBoundary ?? null,
      identity: record.identity ? { ...record.identity } : null }));
    return { outcome: this.reason ? 'STOPPED' : 'OBSERVED', reason: this.reason,
      dispatched: { ...this.counts }, blocked: this.blocked, records };
  }
}

/** Wait without masking cancellation; never busy-wait or advance a browser clock. */
async function waitUntil(budget, targetMs) {
  budget.check();
  try { await delay(Math.max(0, targetMs - budget.clock()), undefined, { signal: budget.controller.signal }); }
  catch { budget.check(); throw new QualificationError('cancelled'); }
  budget.check();
}

/** Attribute static login HTML to the pinned build; retain neither its props nor body. */
function validateBuild(html, status, headers, expected = TARGET.build) {
  requireCondition(status === 200, 'target_status');
  // The static route's exact policy and explicit cache state remain required alongside build identity.
  const cacheControl = (headers.get('cache-control') || '').split(',')
    /** Normalize directive formatting while preserving duplicate or unexpected policy tokens. */
    .map(directive => directive.trim().toLowerCase().replace(/\s*=\s*/g, '=')).sort().join(',');
  requireCondition(cacheControl === BUILD_POLICY.cacheControl, 'cached_target');
  const cacheStatus = (headers.get('x-vercel-cache') || '').trim().toUpperCase();
  requireCondition(BUILD_POLICY.cacheStatuses.includes(cacheStatus), 'cached_target');
  const age = headers.get('age');
  // Vercel keeps static files for the deployment's lifetime and ignores query cache busters.
  // Only HIT permits a nonzero Age: require an unambiguous nonnegative safe integer.
  // This exception is limited to the pinned /login probes; it says nothing about auth response caching.
  const validAge = cacheStatus === 'HIT'
    ? typeof age === 'string' && /^[0-9]+$/.test(age) && Number.isSafeInteger(Number(age))
    : age === null || age === '0';
  requireCondition(validAge, 'cached_target');
  const script = /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  requireCondition(Boolean(script), 'build_missing');
  let data;
  try { data = JSON.parse(script[1]); } catch { throw new QualificationError('build_schema'); }
  requireCondition(data.buildId === expected, 'build_mismatch');
  return true;
}

/** Bound cookie lookup, fetch and stream reads with the same probe signal; discard arbitrary errors. */
async function abortable(promise, signal) {
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    /** Use fixed diagnostics rather than an abort reason that could contain provider data. */
    onAbort = () => reject(new QualificationError('probe_timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/**
 * Select only the existing Vercel protection cookie from the dedicated browser.
 * Vercel documents URL-specific authentication; its agent-browser source names
 * _vercel_jwt: https://github.com/vercel-labs/agent-browser/blob/main/skill-data/protected-vercel-deployments/SKILL.md
 * Actual browser metadata must satisfy every guard; no fallback name or domain is guessed.
 * The returned header lives only in this probe's stack, never in reports or global headers.
 */
async function protectionCookie(context, origin, signal) {
  requireCondition(origin === TARGET.immutableOrigin, 'protection_origin');
  requireCondition(context && typeof context.cookies === 'function', 'protection_auth_missing');
  const cookies = await abortable(context.cookies([`${origin}/login`]), signal);
  requireCondition(Array.isArray(cookies), 'protection_auth_missing');
  const candidates = cookies.filter(cookie => cookie.name === '_vercel_jwt');
  requireCondition(candidates.length === 1, candidates.length ? 'protection_auth_ambiguous' : 'protection_auth_missing');
  const cookie = candidates[0];
  requireCondition(cookie.domain === new URL(origin).hostname && cookie.path === '/'
    && cookie.secure === true && cookie.httpOnly === true && !cookie.partitionKey, 'protection_auth_scope');
  requireCondition(Number.isFinite(cookie.expires) && (cookie.expires === -1
    || cookie.expires * 1000 > Date.now() + SCHEDULE.requestMs), 'protection_auth_expired');
  // RFC 6265 cookie-octet excludes delimiters, whitespace and control characters.
  requireCondition(typeof cookie.value === 'string' && cookie.value.length > 0 && cookie.value.length <= 16_384
    && /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(cookie.value), 'protection_auth_value');
  return `_vercel_jwt=${cookie.value}`;
}

/** Read at most one MiB under the probe deadline; cancel the stream without retaining content. */
async function boundedText(response, signal) {
  requireCondition(response.body, 'body_missing');
  const reader = response.body.getReader(); const pieces = []; let size = 0;
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      requireCondition(size <= BODY_LIMIT, 'body_limit'); pieces.push(Buffer.from(part.value));
    }
    return Buffer.concat(pieces).toString('utf8');
  } finally {
    // Cancellation must not keep a timed-out probe alive; suppress only its private cleanup error.
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

/** Static pinned-build probe: canonical stays anonymous; generated-host auth is scoped to one request. */
async function checkBuild(budget, origin, expected = TARGET.build, context = null) {
  const record = budget.reserve('document'); const start = budget.clock();
  const signal = AbortSignal.any([budget.controller.signal, AbortSignal.timeout(SCHEDULE.requestMs)]);
  try {
    requireCondition(origin === TARGET.origin || origin === TARGET.immutableOrigin, 'unexpected_origin');
    const headers = { 'Cache-Control': 'no-cache, no-store, max-age=0', Pragma: 'no-cache' };
    if (origin === TARGET.immutableOrigin) headers.Cookie = await protectionCookie(context, origin, signal);
    budget.check(); requireCondition(!signal.aborted, 'probe_timeout');
    // Unique queries distinguish probes, but cannot bypass Vercel's deployment-cached static files.
    const response = await abortable(fetch(`${origin}/login?gate1_build=${randomUUID()}`, {
      redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
      headers,
    }), signal);
    record.status = response.status;
    if (response.status !== 200) {
      // Reject before reading a redirect/error body; never forward credentials to Location.
      void response.body?.cancel().catch(() => {});
      throw new QualificationError('target_status');
    }
    validateBuild(await boundedText(response, signal), response.status, response.headers, expected);
    budget.check(); requireCondition(!signal.aborted, 'probe_timeout');
  } catch (error) { budget.stop(safeCode(error)); throw new QualificationError(budget.reason); }
  finally { record.durationMs = budget.clock() - start; record.finished = true;
    record.timingBoundary = 'response_body'; record.timingSource = 'host_monotonic_probe'; }
}

/** Install before navigation; the browser itself reports trusted visibility events. */
function installVisibilityObserver() {
  window.__gate1Visibility = [];
  /** Record only native visibility transitions and relative timestamps, without DOM data. */
  function onVisibility(event) {
    window.__gate1Visibility.push({ state: document.visibilityState, trusted: event.isTrusted, atMs: performance.now() });
  }
  document.addEventListener('visibilitychange', onVisibility);
}

/**
 * Observe and gate only owned pages using CDP Fetch before dispatch. Redirect hops
 * get a fresh reservation. Request headers/URLs/bodies are never copied to reports.
 */
class BrowserObserver {
  /** Use an exclusive prepared context; no unrelated pages or personal profiles are accepted. */
  constructor(context, budget, identity, origins, { allowRedirects = false, requestMs = SCHEDULE.requestMs } = {}) {
    this.context = context; this.budget = budget; this.identity = identity; this.origins = new Set(origins);
    this.allowRedirects = allowRedirects; this.requestMs = requestMs;
    this.pages = new Set(); this.pending = new Set(); this.sessions = []; this.closing = false;
    this.cleanupPromise = null; this.visibility = [];
    // A failure closes only pages registered to this observer, never the whole supplied browser.
    budget.onStop = () => { void this.close(); };
  }
  /** Track asynchronous protocol work so no background rejection or missing observation is ignored. */
  track(promise) {
    // Only fixed codes escape this rejection handler; provider messages are discarded.
    const tracked = promise.catch(error => this.budget.stop(safeCode(error)));
    this.pending.add(tracked);
    // Remove completed work without creating an unhandled rejection chain.
    void tracked.then(() => this.pending.delete(tracked));
  }
  /** Create a blank owned page, gate it, then permit the caller to navigate. */
  async newPage(tab) {
    this.budget.check(); const page = await this.context.newPage(); this.pages.add(page);
    await page.addInitScript(installVisibilityObserver);
    const cdp = await this.context.newCDPSession(page);
    const active = new Map(); const starts = new Map(); const timeouts = new Set();
    this.sessions.push({ cdp, timeouts });
    const owner = this;

    /** Mark one request complete from protocol timing; enforce data and latency observations. */
    async function finish(networkId, timestamp, failed = false) {
      const entry = active.get(networkId);
      if (!entry || entry.record.finished) return;
      clearTimeout(entry.timer); timeouts.delete(entry.timer);
      const record = entry.record;
      try {
        const start = starts.get(networkId);
        requireCondition(Number.isFinite(start) && Number.isFinite(timestamp), 'missing_timing');
        record.durationMs = (timestamp - start) * 1000;
        record.timingSource = 'network_finished';
        record.timingBoundary = 'response_body';
        requireCondition(record.durationMs >= 0, 'missing_timing');
        if (failed) throw new QualificationError('transport_failure');
        const redirect = record.status >= 300 && record.status < 400 && record.status !== 304;
        requireCondition((record.status >= 200 && record.status < 300)
          || (record.kind === 'static' && record.status === 304) || (owner.allowRedirects && redirect), 'http_status');
        requireCondition(record.durationMs <= owner.requestMs, 'request_latency');
        if (record.kind === 'session') {
          const body = await cdp.send('Network.getResponseBody', { requestId: networkId });
          const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
          record.identity = owner.identity.observe(text);
          requireCondition(Object.values(record.identity).every(Boolean), 'identity_mismatch');
        }
      } finally { record.finished = true; active.delete(networkId); starts.delete(networkId); }
    }

    /** Reserve synchronously before forwarding; count each redirect and reject unknown origins. */
    async function paused(event) {
      try {
        requireCondition(!owner.closing, 'cleanup_with_pending_request');
        if (event.redirectedRequestId && !owner.allowRedirects) throw new QualificationError('unexpected_redirect');
        const kind = classifyRequest(event.request.url, event.request.method, owner.origins, event.resourceType);
        const record = owner.budget.reserve(kind, tab);
        requireCondition(Boolean(event.networkId), 'missing_network_id');
        // A stalled response stops even if no loadingFinished event ever arrives.
        const timer = setTimeout(() => owner.budget.stop('request_latency'), owner.requestMs);
        timeouts.add(timer); active.set(event.networkId, { record, timer });
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
      } catch (error) {
        owner.budget.stop(safeCode(error));
        try { await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }); }
        catch { /* Closing an owned page also aborts its paused requests. */ }
      }
    }

    /** Keep only monotonic timing; finalize a redirect before its network ID is reused. */
    function started(event) {
      const previous = active.get(event.requestId);
      if (event.redirectResponse && previous) {
        previous.record.status = event.redirectResponse.status;
        owner.track(finish(event.requestId, event.timestamp));
      }
      starts.set(event.requestId, event.timestamp);
    }
    /** Read status only; never retain the protocol event's headers or URL. */
    function responded(event) {
      const entry = active.get(event.requestId);
      if (!entry) return;
      entry.record.status = event.response.status;
      if (event.response.fromServiceWorker) owner.budget.stop('service_worker');
      if (event.response.status >= 400) owner.budget.stop('http_status');
      if (entry.record.kind === 'csrf') finishHeaders(event.requestId, event.timestamp);
    }
    /**
     * Owner-approved CSRF boundary: time to response headers, matching the client's
     * awaited fetch. Its unread token body is never consumed, inspected or timed.
     */
    function finishHeaders(networkId, timestamp) {
      const entry = active.get(networkId);
      if (!entry) return;
      try {
        const start = starts.get(networkId);
        requireCondition(Number.isFinite(start) && Number.isFinite(timestamp), 'missing_timing');
        entry.record.durationMs = (timestamp - start) * 1000;
        entry.record.timingSource = 'network_response_received'; entry.record.timingBoundary = 'response_headers';
        requireCondition(entry.record.durationMs >= 0 && entry.record.durationMs <= owner.requestMs, 'request_latency');
      } catch (error) { owner.budget.stop(safeCode(error)); }
      finally {
        entry.record.finished = true; clearTimeout(entry.timer); timeouts.delete(entry.timer);
        active.delete(networkId); starts.delete(networkId);
      }
    }
    /** Complete successful bodies using the browser's network clock. */
    function completed(event) { owner.track(finish(event.requestId, event.timestamp)); }
    /** Transport errors stay generic; the protocol error text is deliberately ignored. */
    function failed(event) { owner.track(finish(event.requestId, event.timestamp, true)); }
    /** CDP callbacks cannot await; tracked tasks propagate all failures to the shared stop latch. */
    function intercepted(event) { owner.track(paused(event)); }
    /** Workers are outside this page-only measurement contract and must not run unobserved. */
    function workerAttached() { owner.budget.stop('unsupported_child_target'); }
    /** Unexpected page closure is a measurement failure, not successful cleanup. */
    function pageClosed() { if (!owner.closing) owner.budget.stop('browser_closed'); }
    cdp.on('Network.requestWillBeSent', started); cdp.on('Network.responseReceived', responded);
    cdp.on('Network.loadingFinished', completed); cdp.on('Network.loadingFailed', failed);
    cdp.on('Fetch.requestPaused', intercepted); cdp.on('Target.attachedToTarget', workerAttached);
    page.on('close', pageClosed);
    await cdp.send('Network.enable', { maxTotalBufferSize: BODY_LIMIT * 4, maxResourceBufferSize: BODY_LIMIT });
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    // Playwright enables focus emulation by default. Restore native visibility before navigation.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    return page;
  }
  /** Await all current observation work and require every dispatched request to be accounted for. */
  async settled(timeoutMs = SCHEDULE.requestMs) {
    const deadline = this.budget.clock() + timeoutMs;
    // Require a short quiet interval as CDP notifications can trail the page load event.
    while (this.pending.size || this.budget.records.some(record => !record.finished)
      || this.budget.clock() - this.budget.started - (this.budget.records.at(-1)?.startedMs ?? 0) < 250) {
      this.budget.check(); requireCondition(this.budget.clock() < deadline, 'missing_observation');
      await waitUntil(this.budget, this.budget.clock() + 20);
    }
    this.budget.check();
  }
  /** Observe a genuinely hidden document, activate its tab, and require a new trusted visible event. */
  async activate(page, neutral, tab) {
    await neutral.bringToFront();
    // Polling a hidden page must not depend on requestAnimationFrame scheduling.
    await page.waitForFunction(() => document.visibilityState === 'hidden', null, { polling: 20, timeout: 1000 });
    // Read only the observer's scalar state, never a DOM snapshot or account label.
    const before = await page.evaluate(() => ({ state: document.visibilityState, length: window.__gate1Visibility?.length }));
    requireCondition(before.state === 'hidden' && Number.isInteger(before.length), 'visibility_unavailable');
    await page.bringToFront();
    // A short frame-independent wait lets Chromium deliver its native visibility event.
    await page.waitForFunction(() => document.visibilityState === 'visible'
      && window.__gate1Visibility?.at(-1)?.state === 'visible', null, { timeout: 1000 });
    // Return only visibility observations; no application state or storage is traversed.
    const events = await page.evaluate(() => ({ length: window.__gate1Visibility.length, last: window.__gate1Visibility.at(-1) }));
    requireCondition(events.length > before.length && events.last.state === 'visible'
      && events.last.trusted, 'visibility_unavailable');
    this.visibility.push({ profile: this.budget.phase, tab, hiddenStateObserved: true, visibleEventTrusted: true,
      atMs: this.budget.clock() - this.budget.started });
  }
  /** Close only owned pages, idempotently; leave caller-owned account state and tabs untouched. */
  async close() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closing = true;
    for (const session of this.sessions) for (const timer of session.timeouts) clearTimeout(timer);
    // Closing owned pages aborts their in-flight and paused requests without signing out.
    this.cleanupPromise = Promise.allSettled([...this.pages].map(page =>
      withTimeout(page.close({ runBeforeUnload: false }), 2000, 'cleanup_timeout')));
    const results = await this.cleanupPromise;
    // Verify owned-page closure rather than assuming every page in a supplied context is ours.
    this.cleanupSummary = { ownedPages: this.pages.size,
      closeErrors: results.filter(result => result.status === 'rejected').length,
      pagesStillOpen: [...this.pages].filter(page => !page.isClosed()).length };
    if (this.cleanupSummary.closeErrors || this.cleanupSummary.pagesStillOpen) this.budget.stop('cleanup_failed');
  }
}

/** Count only completed session observations for one phase/tab, including application retries. */
function sessionCount(budget, tab) {
  // Records are already sanitized; filter by numeric tab and fixed phase labels only.
  return budget.records.filter(record => record.profile === budget.phase && record.tab === tab && record.kind === 'session').length;
}

/** Reject missing/extra verification calls; never assume one interaction equals one request. */
function assertSessionShape(budget, tabs, expected) {
  for (let tab = 1; tab <= tabs; tab++) requireCondition(sessionCount(budget, tab) === expected, 'session_shape');
}

/** Wait for actual session/CSRF completion; a document load event does not imply React finished mounting. */
async function waitForChecks(observer, tabs, expected, timeoutMs) {
  const budget = observer.budget; const deadline = budget.clock() + timeoutMs;
  for (;;) {
    budget.check(); let complete = true;
    for (let tab = 1; tab <= tabs; tab++) {
      for (const kind of ['session', 'csrf']) {
        // Every expected verification needs its completed observation, not an assumed request.
        const records = budget.records.filter(record => record.profile === budget.phase && record.tab === tab
          && record.kind === kind && record.finished);
        if (records.length < expected) complete = false;
      }
    }
    if (complete) break;
    requireCondition(budget.clock() < deadline, 'missing_observation');
    await waitUntil(budget, budget.clock() + 20);
  }
  await observer.settled(Math.max(1, deadline - budget.clock()));
  assertSessionShape(budget, tabs, expected);
}

/** Run one frozen profile using ordinary navigation and actual tab activation, without fetch loops. */
async function exerciseProfile(observer, profile, origin, schedule = SCHEDULE) {
  const budget = observer.budget; const pages = [];
  const neutral = await observer.newPage(0);
  for (let tab = 1; tab <= profile.tabs; tab++) pages.push(await observer.newPage(tab));
  const startup = budget.clock();
  /** Start all page navigations together; no account mutation or UI submission occurs. */
  await Promise.all(pages.map(page => page.goto(origin, { waitUntil: 'load', timeout: schedule.startupMs })));
  /** Use each tab's first gated document dispatch in this phase, excluding preflight probes. */
  const starts = pages.map((_, index) => budget.records.find(record => record.profile === budget.phase
    && record.tab === index + 1 && record.kind === 'document')?.startedMs);
  requireCondition(starts.every(Number.isFinite), 'missing_observation');
  requireCondition(Math.max(...starts) - Math.min(...starts) <= schedule.startupSpreadMs, 'startup_spread');
  await waitForChecks(observer, profile.tabs, 1, Math.max(1, schedule.startupMs - (budget.clock() - startup)));
  requireCondition(budget.clock() - startup <= schedule.startupMs, 'startup_deadline');
  assertSessionShape(budget, profile.tabs, 1);
  for (let index = 0; index < pages.length; index++) {
    // Locate the completed startup observation rather than assuming when React mounted.
    const mount = budget.records.find(record => record.profile === budget.phase && record.tab === index + 1 && record.kind === 'session');
    requireCondition(budget.clock() - budget.started - mount.startedMs < schedule.throttleMs, 'throttle_probe_late');
    await observer.activate(pages[index], neutral, index + 1);
    await waitUntil(budget, budget.clock() + Math.min(200, schedule.slotMs / 2));
  }
  await observer.settled(); assertSessionShape(budget, profile.tabs, 1);
  const observedAt = budget.clock();
  for (let round = 1; round <= schedule.rounds; round++) {
    for (let index = 0; index < pages.length; index++) {
      const due = observedAt + round * schedule.cadenceMs + index * schedule.slotMs;
      await waitUntil(budget, due);
      requireCondition(budget.clock() - due < schedule.slotMs, 'cadence_missed');
      await observer.activate(pages[index], neutral, index + 1);
    }
    await waitForChecks(observer, profile.tabs, round + 1, schedule.requestMs);
  }
  await waitUntil(budget, observedAt + schedule.observationMs);
  await observer.settled(schedule.drainMs);
  const metrics = {};
  for (const kind of ['session', 'csrf']) {
    // Report and judge each operation separately; never pool tool delays with HTTP timings.
    const values = budget.records.filter(record => record.profile === budget.phase && record.kind === kind).map(record => record.durationMs);
    const summary = summarizeDurations(values);
    requireCondition(summary.count > 0 && summary.p95Ms <= schedule.p95Ms, 'p95_latency');
    metrics[kind] = { timingBoundary: kind === 'csrf' ? 'response_headers' : 'response_body', ...summary };
  }
  return metrics;
}

/**
 * Hosted entry point, deliberately unavailable through the offline CLI. The caller
 * must supply all four explicit approvals and a prepared exclusive context. This
 * function does not launch a browser, sign in or provision users. Generated-host
 * probes use only the prepared context's existing protection cookie in memory.
 */
async function runProfiles({ context, approvedProfiles, approval, approvedUserId, onProgress = null }) {
  requireCondition(approval === LIVE_APPROVAL && JSON.stringify(approvedProfiles) === '[1,2,4,8]', 'live_not_authorized');
  requireCondition(context && context.pages().length === 1 && context.pages()[0].url() === 'about:blank'
    && context.serviceWorkers().length === 0, 'exclusive_context_required');
  const identity = new IdentityObserver(approvedUserId); const budget = new RequestBudget(); budget.arm();
  const results = []; let observer;
  try {
    for (const profile of PROFILES) {
      budget.begin(`tabs_${profile.tabs}`, profile, SCHEDULE.profileMs);
      await waitUntil(budget, budget.clock() + SCHEDULE.quietMs);
      await checkBuild(budget, TARGET.origin); await checkBuild(budget, TARGET.immutableOrigin, TARGET.build, context);
      observer = new BrowserObserver(context, budget, identity, [TARGET.origin]);
      const metrics = await exerciseProfile(observer, profile, TARGET.origin);
      await observer.close();
      await checkBuild(budget, TARGET.origin); await checkBuild(budget, TARGET.immutableOrigin, TARGET.build, context);
      results.push({ tabs: profile.tabs, outcome: 'PASS', metrics, visibility: observer.visibility });
      if (onProgress) onProgress({ completedProfile: profile.tabs, dispatched: { ...budget.counts } });
    }
  } catch (error) { budget.stop(safeCode(error)); }
  finally { if (observer) await observer.close(); budget.dispose(); }
  return { target: TARGET, scope: 'browser_only_cold_http_cache', profiles: results, ...budget.report() };
}

/** Load the explicitly supplied local runtime, without installing packages or inspecting environment values. */
function loadPlaywright(corePath) {
  const metadata = require(path.join(corePath, 'package.json'));
  requireCondition(metadata.name === 'playwright-core' && metadata.version === CORE_VERSION, 'toolchain_mismatch');
  return require(corePath);
}

/**
 * Launch an owned Edge profile, optionally with a manual sign-in phase first.
 * manualFirst opens no debugging port and makes no automation connection; the
 * owner must close that browser normally before attachAfterManualSignIn proceeds.
 * Its same profile is reused, never exported/copied, then deleted by final close.
 * Automated attachment always uses documented noDefaults=true.
 * This prevents Playwright's original CDP session from forcing every tab visible;
 * changing a second CDP session alone cannot remove that original override.
 * The only file read is this new browser's DevToolsActivePort, never auth storage.
 */
async function launchNativeBrowser({ corePath, browserPath, manualFirst = false }) {
  requireCondition([corePath, browserPath].every(value => typeof value === 'string'
    && path.isAbsolute(value) && !value.includes('\0')), 'tool_path');
  requireCondition(typeof manualFirst === 'boolean', 'manual_mode');
  const runtime = loadPlaywright(corePath);
  const scratch = path.resolve(__dirname, '../../.tmp/gate1-browser-tabs');
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.realpath(scratch);
  const profilePath = await fs.mkdtemp(path.join(root, 'edge-fixture-'));
  let child; let processFailed = false; let browser; let closing = false;
  let phase = manualFirst ? 'manual' : 'attaching'; let closePromise; let attachTask;

  /** Spawn only the owned profile, with debugging entirely absent from manual sign-in. */
  function start(debug) {
    const args = [`--user-data-dir=${profilePath}`, '--no-first-run', '--no-default-browser-check'];
    if (debug) args.push('--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--disable-background-networking', '--no-startup-window');
    else args.push('--new-window', `data:text/html;charset=utf-8,${encodeURIComponent(manualSignInHtml())}`);
    processFailed = false;
    const launched = spawn(browserPath, args, { stdio: 'ignore', windowsHide: true }); child = launched;
    // Preserve no OS error text or command line in diagnostics.
    launched.once('error', () => { if (child === launched) processFailed = true; });
  }

  /** Observe only the exact spawned process; a signal exit is insufficient for preserving authentication. */
  function exited() { return child && (child.exitCode !== null || child.signalCode !== null); }

  /** Bound process-exit acknowledgement without enumerating or stopping unrelated Edge processes. */
  async function waitForExit(timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (!processFailed && !exited() && performance.now() < deadline) await delay(50);
  }

  /** Stop only this spawned browser and delete only its verified new workspace profile. */
  function close() {
    if (closePromise) return closePromise;
    closing = true; phase = 'closing';
    /** Let in-progress attachment settle before closing/deleting its owned resources. */
    closePromise = (async () => {
      if (attachTask) {
        try { await withTimeout(attachTask, 16_000, 'browser_close_timeout'); }
        catch { /* The attachment caller retains the original stop reason. */ }
      }
      if (browser?.isConnected()) {
        try {
          const session = await withTimeout(browser.newBrowserCDPSession(), 1000, 'browser_close_timeout');
          await withTimeout(session.send('Browser.close'), 1000, 'browser_close_timeout');
        } catch { /* Browser.close may sever the connection before its reply arrives. */ }
      }
      await waitForExit(3000);
      if (!processFailed && !exited()) { child.kill(); await waitForExit(1000); }
      requireCondition(processFailed || exited(), 'browser_close_timeout');
      if (browser?.isConnected()) {
        try { await withTimeout(browser.close(), 1000, 'browser_close_timeout'); }
        catch { /* The owned process has exited; never wait indefinitely for its acknowledgement. */ }
      }
      const resolved = await fs.realpath(profilePath);
      requireCondition(resolved === profilePath && path.dirname(resolved) === root
        && path.basename(resolved).startsWith('edge-fixture-'), 'cleanup_path');
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      phase = 'closed';
    })();
    return closePromise;
  }

  /** Expose lifecycle booleans only; paths, cookies and browser objects are excluded. */
  function status() {
    return { phase, processExited: Boolean(exited()),
      manualExitClean: phase === 'manual' && !processFailed && child.exitCode === 0 && child.signalCode === null,
      automationAttached: Boolean(browser?.isConnected()) };
  }

  /** Attach only after a fresh debug-enabled launch; startup creates no restored hosted tabs. */
  async function connectOwned() {
    start(true);
    const deadline = performance.now() + 10_000; let port;
    while (!port) {
      requireCondition(!closing && !processFailed && !exited() && performance.now() < deadline, 'browser_startup');
      try {
        const text = await fs.readFile(path.join(profilePath, 'DevToolsActivePort'), 'utf8');
        const candidate = Number(text.split(/\r?\n/)[0]);
        if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65535) port = candidate;
        else await delay(50);
      } catch (error) { if (error.code !== 'ENOENT') throw error; await delay(50); }
    }
    browser = await runtime.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 5000 });
    requireCondition(!closing, 'browser_closed');
    const context = browser.contexts()[0]; requireCondition(context, 'browser_context');
    // Create the keeper explicitly: initial targets can still be attaching when CDP connects.
    const keepAlive = await withTimeout(context.newPage(), 5000, 'browser_startup');
    requireCondition(!closing, 'browser_closed');
    // Replace only this new profile's startup tabs, after the keeper prevents last-tab exit.
    for (const page of context.pages()) if (page !== keepAlive) {
      await withTimeout(page.close(), 2000, 'browser_startup');
    }
    phase = 'attached';
    return { browser, context, keepAlive, close, status };
  }

  /** Preserve the primary failure if owned cleanup also fails, exposing only fixed cleanup metadata. */
  async function cleanAfterFailure(error) {
    try { await close(); }
    catch (cleanupError) {
      const failure = new QualificationError(safeCode(error));
      failure.cleanupFailure = safeCode(cleanupError); throw failure;
    }
    throw error;
  }

  /** One-shot transition after the owner's clean exit; never kill the manual browser to force a restart. */
  async function attachAfterManualSignIn() {
    requireCondition(phase === 'manual' && !closing, 'manual_phase_required');
    requireCondition(exited(), 'manual_browser_still_open');
    requireCondition(!processFailed && child.exitCode === 0 && child.signalCode === null, 'manual_exit_unclean');
    phase = 'attaching'; // Latch before awaiting so double-clicks cannot spawn duplicate browsers.
    attachTask = connectOwned();
    try { return await attachTask; } catch (error) { return cleanAfterFailure(error); }
  }

  try {
    if (manualFirst) {
      start(false); await delay(250);
      requireCondition(!processFailed && !exited(), 'browser_startup');
      return { status, attachAfterManualSignIn, close };
    }
    attachTask = connectOwned(); return await attachTask;
  } catch (error) { return cleanAfterFailure(error); }
}

/** Local-only instructions for the owner's manual sign-ins; no scripts, remote resources or credential fields. */
function manualSignInHtml() {
  return `<!doctype html><meta charset="utf-8"><title>GATE-1 manual sign-in</title>
<style>body{font:18px system-ui;max-width:780px;margin:60px auto;padding:0 24px;line-height:1.6}li{margin:24px 0}</style>
<h1>GATE-1 manual sign-in</h1><p>This dedicated browser has no automation connection. The load test has not started.</p>
<ol><li><a target="_blank" rel="noopener" href="${TARGET.immutableOrigin}/login">Open the protected deployment</a>
<br>Complete Vercel sign-in if needed. Stop at the application's login page on this host.</li>
<li><a target="_blank" rel="noopener" href="${TARGET.origin}/login">Open the canonical application</a>
<br>Sign in with the approved Google test account.</li></ol>
<p>When both steps succeed, close every window belonging to this dedicated browser normally, then reply <strong>done</strong>.
The runner will reopen the same profile and verify the saved authentication. Keep credentials in the browser.</p>`;
}

/** Serve synthetic HTML that mimics only mount/visibility checks; it never imports the application. */
function fixtureHtml(throttleMs) {
  return `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>GATE-1 local fixture</title>
<script id="__NEXT_DATA__" type="application/json">{"buildId":"fixture-build"}</script>
<script>
let lastCheck = 0;
/** Fetch fixture-only identity and CSRF responses, emulating the deployed check cadence. */
async function check(initial) {
  const response = await fetch('/api/auth/session');
  await response.json();
  if (initial) lastCheck = Date.now();
  await fetch('/api/auth/csrf');
}
check(true);
/** Real visibility events run this fixture; no synthetic events or fake clock are used. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || Date.now() - lastCheck < ${throttleMs}) return;
  lastCheck = Date.now(); check(false);
});
</script>`;
}

/** Start a loopback-only fixture and retain request counters, never cookies/headers/bodies. */
async function startFixture() {
  const counts = new Map();
  /** Serve fixed fixtures and a redirect chain for pre-dispatch budget verification. */
  function handle(request, response) {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    counts.set(pathname, (counts.get(pathname) || 0) + 1);
    response.setHeader('Cache-Control', 'private, no-store');
    if (pathname === '/redirect') { response.writeHead(302, { Location: '/redirect-target' }); response.end(); return; }
    if (pathname === '/api/auth/session') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: { user: { id: 'fixture-user', email: 'PRIVATE_FIXTURE_SENTINEL' } } })); return;
    }
    if (pathname === '/api/auth/csrf') { response.setHeader('Content-Type', 'application/json'); response.end('{}'); return; }
    response.setHeader('Content-Type', 'text/html'); response.end(fixtureHtml(5000));
  }
  const server = http.createServer(handle);
  // Bind to loopback only; no service is exposed to the local network.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, counts,
    /** Close fixture sockets and release the only listening port during final cleanup. */
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

/** Exercise real browser cookie lookup with synthetic state in the disposable fixture profile, without network I/O. */
async function verifyProtectionFixture(context) {
  const domain = new URL(TARGET.immutableOrigin).hostname;
  await context.addCookies([{ name: '_vercel_jwt', value: 'SYNTHETIC_FIXTURE_PROTECTION',
    domain, path: '/', httpOnly: true, secure: true, expires: Date.now() / 1000 + 60 }]);
  try {
    const header = await protectionCookie(context, TARGET.immutableOrigin, AbortSignal.timeout(SCHEDULE.requestMs));
    requireCondition(header === '_vercel_jwt=SYNTHETIC_FIXTURE_PROTECTION', 'fixture_protection_cookie');
  } finally { await context.clearCookies({ name: '_vercel_jwt', domain, path: '/' }); }
}

/** Offline browser qualification: real tabs, synthetic identities, redirect cap, and owned cleanup. */
async function selfCheck(options) {
  const fixture = await startFixture(); let native; let result; let cleanupError;
  const checks = []; const budgets = []; const observers = [];
  try {
    native = await launchNativeBrowser(options);
    const context = native.context;
    const budget = new RequestBudget({ totalMs: 60_000, rolling: { app: 128, session: 32 } }); budgets.push(budget);
    budget.begin('offline_tabs_2', { app: 80, static: 80, session: 24 }, 60_000); budget.arm();
    const observer = new BrowserObserver(context, budget, new IdentityObserver('fixture-user'), [fixture.origin]); observers.push(observer);
    const schedule = { ...SCHEDULE, throttleMs: 5000, cadenceMs: 6000, rounds: 2,
      slotMs: 500, observationMs: 13_000, startupMs: 5000, requestMs: 5000 };
    const metrics = await exerciseProfile(observer, { tabs: 2 }, fixture.origin, schedule);
    requireCondition(budget.counts.session === 6, 'fixture_session_count');
    checks.push({ case: 'real_visibility_and_throttle', outcome: 'PASS', tabs: 2, sessionRequests: 6,
      transitions: observer.visibility.length, metrics });
    await observer.close(); budget.dispose();
    requireCondition(observer.cleanupSummary.closeErrors === 0 && observer.cleanupSummary.pagesStillOpen === 0, 'cleanup_failed');
    checks.push({ case: 'owned_tab_cleanup', outcome: 'PASS', ...observer.cleanupSummary });

    await verifyProtectionFixture(context);
    checks.push({ case: 'synthetic_browser_protection_cookie', outcome: 'PASS', hostedRequests: 0 });

    const redirectContext = context;
    const redirectBudget = new RequestBudget(); budgets.push(redirectBudget);
    redirectBudget.begin('offline_redirect', { app: 1, static: 0, session: 0 }, 10_000); redirectBudget.arm();
    const redirectObserver = new BrowserObserver(redirectContext, redirectBudget, new IdentityObserver('fixture-user'), [fixture.origin], { allowRedirects: true });
    observers.push(redirectObserver);
    const page = await redirectObserver.newPage(1);
    try { await page.goto(`${fixture.origin}/redirect`, { timeout: 5000 }); } catch { /* The cap must abort navigation. */ }
    await redirectObserver.close();
    requireCondition(redirectBudget.reason === 'profile_budget' && redirectBudget.counts.app === 1
      && fixture.counts.get('/redirect') === 1 && !fixture.counts.has('/redirect-target'), 'redirect_cap_failed');
    checks.push({ case: 'redirect_blocked_before_dispatch', outcome: 'PASS', dispatched: 1, targetRequests: 0 });
    result = { outcome: 'PASS', scope: 'loopback_fixture_only', hostedRequests: 0, checks,
      measurements: budget.report(), limitations: ['cold_http_cache', 'child_targets_stop_run', 'no_hosted_account_or_target_qualification'] };
  } catch (error) {
    for (const budget of budgets) budget.stop(safeCode(error));
    // Failed fixture runs retain the same sanitized observations as successful runs.
    result = { outcome: 'STOPPED', scope: 'loopback_fixture_only', hostedRequests: 0, reason: safeCode(error), checks,
      measurements: budgets.map(budget => budget.report()) };
  } finally {
    for (const observer of observers) await observer.close();
    for (const budget of budgets) budget.dispose();
    try { if (native) await native.close(); }
    catch (error) { cleanupError = safeCode(error); }
    finally { await fixture.close(); }
  }
  // Preserve the original stop reason; cleanup failure alone must still stop an otherwise successful run.
  return cleanupError ? { ...result, outcome: 'STOPPED',
    reason: result.outcome === 'STOPPED' ? result.reason : cleanupError, cleanupFailure: cleanupError } : result;
}

/** Validate the offline mode and explicit local tool paths before any fixture or browser starts. */
function parseCli(args) {
  requireCondition(Array.isArray(args) && args.every(arg => typeof arg === 'string'), 'offline_cli_only');
  if (args.length === 1 && args[0] === '--describe') return { mode: 'describe' };
  requireCondition(args.length === 5 && args[0] === '--self-check'
    && args[1] === '--playwright-core' && args[3] === '--edge-executable', 'offline_cli_only');
  requireCondition([args[2], args[4]].every(value => path.isAbsolute(value) && !value.includes('\0')), 'tool_path');
  return { mode: 'self-check', corePath: args[2], browserPath: args[4] };
}

/** Offline CLI only: no accidental invocation can launch a hosted load test. */
async function main(args) {
  const options = parseCli(args);
  if (options.mode === 'describe') return { target: TARGET, profiles: PROFILES, schedule: SCHEDULE, liveExecution: 'requires_separate_approval_and_prepared_context' };
  return selfCheck(options);
}

module.exports = { TARGET, PROFILES, SCHEDULE, LIVE_APPROVAL, QualificationError, requireCondition,
  classifyRequest, summarizeDurations, IdentityObserver, RequestBudget, BrowserObserver,
  validateBuild, checkBuild, waitUntil, waitForChecks, withTimeout, exerciseProfile, runProfiles,
  launchNativeBrowser, parseCli, main };

if (require.main === module) {
  // Emit only constructed, sanitized reports; arbitrary errors and stack traces are not logged.
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.outcome === 'STOPPED') process.exitCode = 1;
  }).catch(error => {
    process.stderr.write(`${JSON.stringify({ outcome: 'STOPPED', reason: safeCode(error) })}\n`); process.exitCode = 1;
  });
}
