'use strict';
/* global __dirname, URL, clearTimeout, fetch, navigator, process, setTimeout */

/**
 * Local-only qualification of native Edge network isolation for request clients.
 * The CLI uses a new synthetic profile and loopback fixtures only. It never opens
 * a retained signed-in profile, exports storage, or accepts a hosted target.
 */
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const RESULT = path.join(ROOT, '.tmp/gate1-checkout-enable-dd2c2c6/browser-isolation-fixture-attempt4.json');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CFT158 = 'C:/Users/willm/job-application-tracker/.tmp/browser-tools/chrome-for-testing/158.0.8127.2/chrome-win64/chrome.exe';
const CORE = 'C:/Users/willm/AppData/Local/npm-cache/_npx/a5b920f00216d246/node_modules/playwright-core';
const CORE_VERSION = '1.62.0-alpha-1783623505000';
const LIMITS = Object.freeze({ wholeMs: 900000, launches: 2, fixtureRequests: 100, proxyConnections: 200 });
const COOKIE = 'isolation_fixture';
const SYNTHETIC_VALUE = 'SYNTHETIC_ONLY';
const UPDATED_VALUE = 'SYNTHETIC_UPDATED';
const PRIOR_NAMES = ['staged-result.json', 'staged-result-attempt2.json', 'alias-restoration.json',
  'promotion-result.json', 'free-checkout-result.json', 'free-checkout-result-attempt2.json', 'csrf-diagnostic.json',
  'browser-isolation-fixture.json', 'browser-isolation-fixture-attempt2.json', 'browser-isolation-fixture-attempt3.json'];
const WORKER_OPERATIONS = Object.freeze(['probe_page_create', 'probe_page_close', 'control_page_readiness', 'cdp_session', 'worker_enable',
  'worker_start', 'worker_discovery', 'worker_probe']);
const WORKER_TIMEOUT_CODES = Object.freeze(['worker_session_timeout', 'operation_timeout',
  'worker_restart_timeout', 'fixture_worker_unavailable', 'worker_probe_timeout', 'fixture_deadline',
  'probe_page_create_timeout', 'probe_page_close_timeout']);

/** Fixed-code errors prevent browser URLs, response contents and OS messages reaching evidence. */
class IsolationError extends Error {
  /** Keep failure attribution fixed and independent of raw browser or network errors. */
  constructor(code) { super(code); this.name = 'IsolationError'; this.code = code; }
}

/** Require a reviewed invariant; callers persist only the supplied fixed code. */
function requireCheck(condition, code) { if (!condition) throw new IsolationError(code); }

/** Bound an operation and release its timer on both success and rejection. */
async function bounded(action, milliseconds, code = 'operation_timeout') {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new IsolationError(code)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Yield briefly while waiting for local process/CDP state; no network operation is implicit. */
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

/** Freeze local-only counts and latch the first failure so later phases cannot start. */
class FixtureBudget {
  /** Initialize only this fixture's clock and counters, with no implicit browser activity. */
  constructor(limits = LIMITS, clock = Date.now) {
    this.limits = limits; this.clock = clock; this.startedAt = clock(); this.failure = null;
    this.counts = { launches: 0, fixtureRequests: 0, proxyConnections: 0 };
  }
  /** Reject any next step after a timeout or earlier failed operation. */
  check() {
    if (!this.failure && this.clock() - this.startedAt >= this.limits.wholeMs) this.failure = 'fixture_deadline';
    if (this.failure) throw new IsolationError(this.failure);
  }
  /** Count actual accepted local activity, including the over-limit event that triggers stopping. */
  count(kind) {
    this.check(); requireCheck(Object.hasOwn(this.counts, kind), 'unknown_budget_kind');
    this.counts[kind]++;
    if (this.counts[kind] > this.limits[kind]) this.failure = `${kind}_budget`;
    this.check();
  }
}

/** Attribute page preparation and restored-worker steps; preserve the first sanitized failure through cleanup. */
class WorkerDiagnostics {
  /** Share the fixture record/budget; keep active operation timing private until a failure. */
  constructor(record, budget, clock = Date.now) {
    this.record = record; this.budget = budget; this.clock = clock; this.active = null;
  }
  /** Snapshot an active failure once, including an outer deadline; never retain raw error fields. */
  stop(error) {
    if (!this.active || this.record.restoredWorkerFailure) return;
    const guard = error instanceof IsolationError;
    const timeout = guard ? WORKER_TIMEOUT_CODES.includes(error.code) : error?.name === 'TimeoutError';
    this.record.restoredWorkerFailure = Object.freeze({ operation: this.active.operation,
      errorCategory: timeout ? 'timeout' : guard ? 'guard' : 'other',
      elapsedMs: Math.max(0, this.clock() - this.active.startedAt) });
  }
  /** Run one fixed step with its existing deadline; reject later work after the first stop. */
  async run(operation, action) {
    this.budget.check();
    requireCheck(WORKER_OPERATIONS.includes(operation), 'worker_operation');
    requireCheck(!this.record.restoredWorkerFailure, 'worker_operation_stopped');
    this.active = { operation, startedAt: this.clock() };
    try {
      const result = await action();
      this.budget.check();
      requireCheck(!this.record.restoredWorkerFailure, 'worker_operation_stopped');
      return result;
    } catch (error) { this.stop(error); throw error; }
    finally { this.active = null; }
  }
}

/** Restrict bypass configuration to the one synthetic IPv4 loopback fixture. */
function loopbackOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new IsolationError('invalid_fixture_origin'); }
  requireCheck(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
    && parsed.port !== '' && parsed.username === '' && parsed.password === ''
    && parsed.pathname === '/' && parsed.search === '' && parsed.hash === '', 'invalid_fixture_origin');
  return parsed;
}

/** Use one rejecting proxy, never DIRECT fallback; seed bypass is exact loopback only. */
function isolationArguments(port, seedOrigin = null) {
  requireCheck(Number.isInteger(port) && port > 0 && port < 65536, 'invalid_proxy_port');
  const bypass = seedOrigin === null ? '<-loopback>' : `<-loopback>;${loopbackOrigin(seedOrigin).host}`;
  return [`--proxy-server=http://127.0.0.1:${port}`, `--proxy-bypass-list=${bypass}`];
}

/** Classify a worker privately without exposing extension IDs, hosts, paths or query strings. */
function classifyWorker(raw, fixtureOrigin) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'chrome-extension:' || url.protocol === 'extension:') return 'extension';
    if (url.origin === fixtureOrigin) return 'fixture';
    if (url.protocol === 'http:' || url.protocol === 'https:') return 'other_web';
    return 'other';
  } catch { return 'unparseable'; }
}

/** Retain only category counts for workers visible to this synthetic context. */
function summarizeWorkers(workers, fixtureOrigin) {
  const counts = { fixture: 0, extension: 0, other_web: 0, other: 0, unparseable: 0 };
  for (const worker of workers) counts[classifyWorker(worker.url(), fixtureOrigin)]++;
  return counts;
}

/** Listen on IPv4 loopback only; callers retain the assigned port, never a public binding. */
async function listenLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return server.address().port;
}

/** Classify a proxy request line against fixed synthetic probes; discard all raw input. */
function classifyProxyLine(line, origin) {
  const parts = line.split(' ');
  if (parts[0] === 'CONNECT') return parts[1] === new URL(origin).host ? 'fixtureConnect' : 'other';
  try {
    const url = new URL(parts[1]);
    if (url.origin !== origin || url.pathname !== '/probe') return 'other';
    return ['page', 'worker'].includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : 'other';
  } catch { return 'other'; }
}

/**
 * Reject every proxy connection locally. No socket to an upstream server exists.
 * Only fixed synthetic probe counters survive; raw request bytes are discarded.
 * Register in servers before listening; a latched budget failure closes late startup.
 */
async function startRejectingProxy(budget, origin, servers = []) {
  budget.check();
  const sockets = new Set(); const counts = { page: 0, worker: 0, fixtureConnect: 0, other: 0 };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    try { budget.count('proxyConnections'); } catch { socket.destroy(); return; }
    let input = ''; let answered = false;
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('data', chunk => {
      if (answered) return;
      input += chunk.toString('latin1');
      if (input.length > 8192) { answered = true; input = ''; socket.destroy(); return; }
      const end = input.indexOf('\r\n');
      if (end < 0) return;
      answered = true; counts[classifyProxyLine(input.slice(0, end), origin)]++; input = '';
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
  });
  const resource = { server, sockets, counts }; servers.push(resource);
  try {
    resource.port = await listenLoopback(server);
    budget.check();
    return resource;
  } catch (error) { await closeServer(resource); throw error; }
}

/**
 * Serve synthetic cookie/SW probes only; no upstream calls or real authentication are possible.
 * Register in servers before listening; a latched budget failure closes late startup.
 */
async function startFixtureServer(budget, servers = []) {
  budget.check();
  const sockets = new Set(); const counts = { page: 0, worker: 0, check: 0, seed: 0 };
  const server = http.createServer((req, res) => {
    try { budget.count('fixtureRequests'); } catch { res.writeHead(503); res.end(); return; }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/fixture') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Local isolation fixture</title>'); }
    else if (url.pathname === '/sw.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end("self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));\nself.addEventListener('activate', event => event.waitUntil(self.clients.claim()));\n");
    } else if (url.pathname === '/api/seed' || url.pathname === '/api/check') {
      const isSeed = url.pathname === '/api/seed'; counts[isSeed ? 'seed' : 'check']++;
      const cookiePresent = String(req.headers.cookie || '').split(';').some(part => part.trim() === `${COOKIE}=${SYNTHETIC_VALUE}`);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Set-Cookie', `${COOKIE}=${isSeed ? SYNTHETIC_VALUE : UPDATED_VALUE}; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax`);
      res.end(JSON.stringify({ synthetic: true, cookiePresent }));
    } else if (url.pathname === '/probe') {
      const kind = url.searchParams.get('kind'); if (Object.hasOwn(counts, kind)) counts[kind]++;
      res.end('synthetic');
    } else { res.writeHead(404); res.end(); }
  });
  const resource = { server, sockets, counts }; servers.push(resource);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  try {
    const port = await listenLoopback(server);
    budget.check();
    resource.origin = `http://127.0.0.1:${port}`;
    return resource;
  } catch (error) { await closeServer(resource); throw error; }
}

/** Close only owned loopback listeners/sockets; no browser or profile is removed here. */
async function closeServer(resource) {
  if (!resource) return;
  await bounded(async () => {
    const closed = [...resource.sockets].map(socket => new Promise(resolve => {
      socket.once('close', resolve); socket.destroy();
    }));
    if (resource.server.listening) closed.push(new Promise(resolve => resource.server.close(resolve)));
    await Promise.all(closed);
  }, 2000, 'server_close_timeout');
}

/** Wait for local state with a bounded polling interval and a latched fixture deadline. */
async function waitFor(read, budget, milliseconds, code) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { budget.check(); const value = await read(); if (value) return value; await delay(50); }
  throw new IsolationError(code);
}

/** Read one fresh port from the owned profile; startup and cleanup share freshness/range checks. */
async function readPortIfFresh(profile, launchTime) {
  const file = path.join(profile, 'DevToolsActivePort');
  try {
    const stat = await fs.stat(file); if (stat.mtimeMs < launchTime) return null;
    const port = Number((await fs.readFile(file, 'utf8')).split(/\r?\n/)[0]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw new IsolationError('debug_port_read'); }
}

/** Preserve the ten-second startup deadline and budget even when cleanup can later recover a port. */
async function readFreshPort(profile, launchTime, budget) {
  return waitFor(() => readPortIfFresh(profile, launchTime), budget, 10000, 'browser_startup');
}

/**
 * Start the new synthetic profile, guarded by a rejecting proxy from process launch.
 * The owner array receives the process immediately so attachment failures still clean up.
 */
async function launchFixtureBrowser({ runtime, profile, proxyPort, seedOrigin, budget, owners, browser = 'edge' }) {
  const executable = fixtureExecutable(browser);
  const resolved = await fs.realpath(profile);
  requireCheck(path.dirname(resolved) === await fs.realpath(__dirname)
    && path.basename(resolved).startsWith('isolation-fixture-'), 'synthetic_profile_required');
  budget.count('launches');
  const args = [`--user-data-dir=${resolved}`, '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--disable-background-networking',
    '--disable-quic', '--no-startup-window', ...isolationArguments(proxyPort, seedOrigin)];
  const launchTime = Date.now();
  const owner = { child: null, browser: null, context: null, keeper: null, port: null, failed: false, closed: false,
    profile: resolved, launchTime };
  owners.push(owner);
  owner.child = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
  owner.child.once('error', () => { owner.failed = true; });
  owner.port = await readFreshPort(resolved, launchTime, budget);
  requireCheck(!owner.failed && owner.child.exitCode === null, 'browser_process');
  owner.browser = await runtime.chromium.connectOverCDP(`http://127.0.0.1:${owner.port}`, { noDefaults: true, timeout: 5000 });
  const contexts = owner.browser.contexts(); requireCheck(contexts.length === 1, 'context_count');
  owner.context = contexts[0];
  requireCheck(owner.context.pages().every(page => page.url() === 'about:blank') && owner.context.pages().length <= 1, 'unexpected_initial_page');
  owner.keeper = owner.context.pages()[0] || await bounded(() => owner.context.newPage(), 5000, 'keeper_timeout');
  return owner;
}

/** Select only the existing Edge or fixed comparison package; callers cannot supply executable paths. */
function fixtureExecutable(browser = 'edge') {
  requireCheck(browser === 'edge' || browser === 'cft158', 'browser_selection');
  return browser === 'edge' ? EDGE : CFT158;
}

/** Normal shutdown only; preserves the synthetic profile and reports failure rather than killing. */
async function closeOwned(owner, runtime) {
  if (!owner || owner.closed) return true;
  const recoveryEnd = !owner.port && !owner.browser?.isConnected() && owner.profile && Number.isFinite(owner.launchTime)
    ? Date.now() + 5000 : null;
  /** Spend only the original no-port wait on recovery; each read/CDP step shares its remaining time. */
  function cleanupTimeout(maximum) {
    const remaining = recoveryEnd === null ? maximum : Math.min(maximum, recoveryEnd - Date.now());
    requireCheck(remaining > 0, 'operation_timeout'); return remaining;
  }
  try {
    while (recoveryEnd !== null && !owner.port && owner.child && owner.child.exitCode === null
      && !owner.failed && Date.now() < recoveryEnd) {
      const port = await bounded(() => readPortIfFresh(owner.profile, owner.launchTime), cleanupTimeout(5000));
      if (Date.now() >= recoveryEnd || owner.child.exitCode !== null || owner.failed) break;
      owner.port = port;
      if (!port) await delay(cleanupTimeout(50));
    }
    if (!owner.browser?.isConnected() && owner.port && owner.child.exitCode === null && !owner.failed) {
      const timeout = cleanupTimeout(3000);
      owner.browser = await bounded(() => runtime.chromium.connectOverCDP(`http://127.0.0.1:${owner.port}`,
        { noDefaults: true, timeout }), timeout);
    }
    if (owner.browser?.isConnected()) {
      const session = await bounded(() => owner.browser.newBrowserCDPSession(), cleanupTimeout(1000));
      await bounded(() => session.send('Browser.close'), cleanupTimeout(2000)).catch(() => {});
    }
  } catch { /* The process-exit check is authoritative; no raw browser error is retained. */ }
  const end = recoveryEnd ?? Date.now() + 5000;
  while (owner.child && owner.child.exitCode === null && !owner.failed && Date.now() < end) await delay(Math.min(50, end - Date.now()));
  owner.closed = !!owner.child && (owner.child.exitCode !== null || owner.failed);
  return owner.closed;
}

/** Make one bounded request-client call to the exact synthetic fixture origin and dispose it. */
async function requestFixture(context, origin, endpoint) {
  loopbackOrigin(origin); requireCheck(['/api/seed', '/api/check'].includes(endpoint), 'fixture_endpoint');
  let response;
  try {
    response = await context.request.get(origin + endpoint, { maxRedirects: 0, maxRetries: 0, timeout: 5000 });
    requireCheck(response.status() === 200, 'fixture_request_status');
    const data = await response.json();
    requireCheck(data.synthetic === true && typeof data.cookiePresent === 'boolean', 'fixture_response');
    return { cookiePresent: data.cookiePresent };
  } finally { if (response) await response.dispose(); }
}

/** Select only our fixed synthetic worker; unrelated worker URLs are never evaluated or recorded. */
async function fixtureWorker(context, origin, budget) {
  return waitFor(() => context.serviceWorkers().find(worker => worker.url() === `${origin}/sw.js`), budget, 5000, 'fixture_worker_unavailable');
}

/**
 * Exercise one worker fetch within five seconds; retain only validated scalars and fixed categories.
 * Evaluation failures and timeouts remain distinct from a completed, unsuccessful HTTP fetch.
 */
async function workerProbe(worker, origin) {
  try {
    const result = await bounded(() => worker.evaluate(async url => {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        return { status: response.status, reached: response.ok, errorCategory: response.ok ? null : 'http_error' };
      } catch { return { status: null, reached: false, errorCategory: 'fetch_rejected' }; }
    }, `${origin}/probe?kind=worker`), 5000, 'worker_probe_timeout');
    const httpResult = Number.isInteger(result?.status) && result.status >= 100 && result.status <= 599
      && result.reached === (result.status >= 200 && result.status <= 299)
      && result.errorCategory === (result.reached ? null : 'http_error');
    const fetchRejected = result?.status === null && result.reached === false && result.errorCategory === 'fetch_rejected';
    if (!httpResult && !fetchRejected) return Object.freeze({ status: null, reached: false, errorCategory: 'invalid_result' });
    return Object.freeze({ status: result.status, reached: result.reached, errorCategory: result.errorCategory });
  } catch (error) {
    return Object.freeze({ status: null, reached: false,
      errorCategory: error instanceof IsolationError && error.code === 'worker_probe_timeout' ? 'timeout' : 'evaluation_failed' });
  }
}

/**
 * Save a probe before enforcing evaluation success, so stopped receipts retain its fixed cause.
 * A fetch rejection still needs the caller's proxy/origin counters to establish blocking.
 */
async function captureWorkerProbe(worker, origin, probes, phase) {
  requireCheck(['baseline', 'restored'].includes(phase), 'worker_probe_phase');
  const result = await workerProbe(worker, origin); probes[phase] = result;
  if (result.errorCategory === 'timeout') throw new IsolationError('worker_probe_timeout');
  if (result.errorCategory === 'evaluation_failed') throw new IsolationError('worker_evaluation_failed');
  if (result.errorCategory === 'invalid_result') throw new IsolationError('worker_probe_result');
  return result;
}

/** Navigate only to a synthetic probe and distinguish proxy failure from an unqualified timeout. */
async function pageProbe(page, url) {
  try { const response = await page.goto(url, { timeout: 5000, waitUntil: 'domcontentloaded' }); return response?.status() === 502; }
  catch (error) {
    if (error.name === 'TimeoutError') throw new IsolationError('page_probe_timeout');
    return /net::ERR_(PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|HTTP_RESPONSE_CODE_FAILURE)/.test(error.message);
  }
}

/** Hash only the named sanitized historical records; no browser data or environment files are read. */
async function evidenceHashes() {
  const result = {};
  for (const name of PRIOR_NAMES) result[name] = crypto.createHash('sha256').update(await fs.readFile(path.join(path.dirname(RESULT), name))).digest('hex');
  return result;
}

/** Hash this executable and its adjacent tests for provenance without reading profile storage. */
async function sourceHashes() {
  const result = {};
  for (const [key, file] of [['helper', 'request-client-isolation.cjs'], ['tests', '__tests__/request-client-isolation.test.cjs']])
    result[key] = crypto.createHash('sha256').update(await fs.readFile(path.join(__dirname, file))).digest('hex');
  return result;
}

/**
 * Run exactly one two-launch fixture and write one immutable sanitized result.
 * Failure stops the remaining cases; no hosted request, retry or signed-in profile is possible.
 */
async function runFixture() {
  try { await fs.access(RESULT); throw new IsolationError('evidence_already_exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const metadata = require(path.join(CORE, 'package.json'));
  requireCheck(metadata.name === 'playwright-core' && metadata.version === CORE_VERSION, 'toolchain_mismatch');
  const runtime = require(CORE); const budget = new FixtureBudget(); const owners = []; const servers = [];
  const record = { schemaVersion: 1, scope: 'synthetic_loopback_only', phase: 'running',
    operator: 'Codex agent', operationalOwner: 'Project owner', approval: 'Owner approved probe-page-isolated local fixture',
    approvalConsumed: true, startedAt: new Date(budget.startedAt).toISOString(), limits: LIMITS,
    toolchain: { node: process.version, playwright: metadata.version }, sourceHashes: await sourceHashes(), checks: {}, workerProbes: {},
    restoredWorkerFailure: null, hostedExerciseAuthorized: false, liveGuardChanged: false, gate1Status: 'open' };
  const workerDiagnostics = new WorkerDiagnostics(record, budget);
  const before = await evidenceHashes(); let fixture; let proxy; let profile;
  try {
    // Reserve 20 seconds for normal browser/server cleanup within the whole-fixture limit.
    await bounded(async () => {
    profile = await fs.mkdtemp(path.join(__dirname, 'isolation-fixture-')); record.syntheticProfile = profile;
    fixture = await startFixtureServer(budget, servers); proxy = await startRejectingProxy(budget, fixture.origin, servers);
    const first = await launchFixtureBrowser({ runtime, profile, proxyPort: proxy.port, seedOrigin: fixture.origin, budget, owners });
    await first.keeper.goto(`${fixture.origin}/fixture`, { timeout: 5000, waitUntil: 'domcontentloaded' });
    const seed = await requestFixture(first.context, fixture.origin, '/api/seed');
    requireCheck(seed.cookiePresent === false, 'synthetic_cookie_not_fresh'); record.checks.freshSyntheticCookie = true;
    await bounded(() => first.keeper.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; return true;
    }), 5000, 'worker_install_timeout');
    const initialWorker = await fixtureWorker(first.context, fixture.origin, budget);
    requireCheck((await captureWorkerProbe(initialWorker, fixture.origin, record.workerProbes, 'baseline')).reached, 'worker_baseline');
    record.checks.workerBaselineReachedFixture = true;
    record.seedWorkerCategories = summarizeWorkers(first.context.serviceWorkers(), fixture.origin);
    requireCheck(await closeOwned(first, runtime), 'first_browser_close'); record.checks.firstBrowserClosedNormally = true;

    const second = await launchFixtureBrowser({ runtime, profile, proxyPort: proxy.port, seedOrigin: null, budget, owners });
    const client = await requestFixture(second.context, fixture.origin, '/api/check');
    requireCheck(client.cookiePresent, 'cookie_not_persistent'); record.checks.requestClientBypassesBrowserProxy = true;
    record.checks.syntheticCookiePersisted = true;
    const applicable = await bounded(() => second.context.cookies(fixture.origin), 5000, 'cookie_metadata_timeout');
    requireCheck(applicable.some(cookie => cookie.name === COOKIE && cookie.value === UPDATED_VALUE), 'request_cookie_writeback');
    record.checks.requestCookieWriteback = true;

    // Expected network failures may leave an error-page transition pending; keep the control page untouched.
    const probePage = await workerDiagnostics.run('probe_page_create', async () => {
      const page = await bounded(() => second.context.newPage(), 5000, 'probe_page_create_timeout');
      requireCheck(page !== second.keeper && !page.isClosed() && page.url() === 'about:blank', 'probe_page_state');
      return page;
    });
    const pageBefore = fixture.counts.page; const proxyPageBefore = proxy.counts.page;
    requireCheck(await pageProbe(probePage, `${fixture.origin}/probe?kind=page`), 'page_not_proxy_blocked');
    requireCheck(fixture.counts.page === pageBefore && proxy.counts.page > proxyPageBefore, 'page_network_isolation');
    record.checks.pageBlockedAtProxy = true;
    const connectBefore = proxy.counts.fixtureConnect;
    requireCheck(await pageProbe(probePage, `${fixture.origin.replace('http:', 'https:')}/probe?kind=page`), 'https_not_proxy_blocked');
    requireCheck(proxy.counts.fixtureConnect > connectBefore && fixture.counts.page === pageBefore, 'https_network_isolation');
    record.checks.httpsConnectBlockedAtProxy = true;
    // Close the probe normally without a recovery navigation; browser cleanup still owns it on failure.
    await workerDiagnostics.run('probe_page_close', async () => {
      await bounded(() => probePage.close({ runBeforeUnload: false }), 5000, 'probe_page_close_timeout');
      requireCheck(probePage.isClosed(), 'probe_page_not_closed');
    });
    record.checks.probePageClosedNormally = true;
    // Use synchronous page metadata only; worker setup requires the sole surviving blank control page.
    await workerDiagnostics.run('control_page_readiness', async () => {
      const pages = second.context.pages();
      requireCheck(second.browser.isConnected() && !second.keeper.isClosed() && second.keeper.url() === 'about:blank'
        && pages.length === 1 && pages[0] === second.keeper, 'control_page_not_ready');
    });
    record.checks.controlPageReady = true;

    const cdp = await workerDiagnostics.run('cdp_session',
      () => bounded(() => second.context.newCDPSession(second.keeper), 5000, 'worker_session_timeout'));
    await workerDiagnostics.run('worker_enable', () => bounded(() => cdp.send('ServiceWorker.enable'), 5000));
    await workerDiagnostics.run('worker_start',
      () => bounded(() => cdp.send('ServiceWorker.startWorker', { scopeURL: `${fixture.origin}/` }), 5000, 'worker_restart_timeout'));
    const restoredWorker = await workerDiagnostics.run('worker_discovery', () => fixtureWorker(second.context, fixture.origin, budget));
    const workerBefore = fixture.counts.worker; const proxyWorkerBefore = proxy.counts.worker;
    await workerDiagnostics.run('worker_probe', async () => {
      requireCheck(!(await captureWorkerProbe(restoredWorker, fixture.origin, record.workerProbes, 'restored')).reached, 'worker_not_proxy_blocked');
      requireCheck(fixture.counts.worker === workerBefore && proxy.counts.worker > proxyWorkerBefore, 'worker_network_isolation');
    });
    record.checks.restoredWorkerBlockedAtProxy = true;
    record.restoredWorkerCategories = summarizeWorkers(second.context.serviceWorkers(), fixture.origin);
    await bounded(() => cdp.detach(), 2000); budget.check();
    record.phase = 'passed';
    }, Math.max(1, LIMITS.wholeMs - 20000 - (Date.now() - budget.startedAt)), 'fixture_deadline');
  } catch (error) {
    workerDiagnostics.stop(error);
    record.phase = 'stopped'; record.stopCode = error instanceof IsolationError ? error.code : 'fixture_operation_failed';
    budget.failure ||= record.stopCode;
  } finally {
    const closure = [];
    for (const owner of owners) closure.push(await closeOwned(owner, runtime));
    record.ownedBrowsersClosedNormally = closure.every(Boolean);
    if (!record.ownedBrowsersClosedNormally) { record.phase = 'stopped'; record.cleanupFailure = 'owned_browser_still_running'; }
    for (const resource of servers.reverse()) {
      try { await closeServer(resource); } catch { record.phase = 'stopped'; record.cleanupFailure = 'local_server_close'; }
    }
    record.counts = { ...budget.counts }; record.proxyProbeCounts = proxy?.counts || null;
    record.fixtureProbeCounts = fixture?.counts || null;
    record.syntheticProfilePreserved = profile ? await fs.stat(profile).then(stat => stat.isDirectory(), () => false) : false;
    record.priorEvidenceUnchanged = JSON.stringify(before) === JSON.stringify(await evidenceHashes());
    record.priorEvidenceHashes = before;
    record.completedAt = new Date().toISOString(); record.elapsedMs = Date.now() - budget.startedAt;
    record.withinOverallLimit = record.elapsedMs < LIMITS.wholeMs;
    if (budget.failure || !record.priorEvidenceUnchanged || !record.withinOverallLimit) {
      record.phase = 'stopped'; record.stopCode ||= budget.failure || 'fixture_final_invariant';
    }
    record.limitations = 'Local HTTP/HTTPS browser-stack fixture only. Not OS-wide egress isolation, WebRTC/UDP qualification, or proof about the historical worker. Signed-in profiles were never opened. No hosted diagnostic is authorized by this result.';
    await fs.writeFile(RESULT, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  }
  return record;
}

/** Expose only the reviewed local fixture command, never arbitrary targets or profile paths. */
async function main(args) {
  requireCheck(args.length === 1 && args[0] === '--fixture', 'local_fixture_argument_required');
  const result = await runFixture();
  process.stdout.write(`${JSON.stringify({ phase: result.phase, stopCode: result.stopCode,
    checks: result.checks, counts: result.counts, ownedBrowsersClosedNormally: result.ownedBrowsersClosedNormally,
    priorEvidenceUnchanged: result.priorEvidenceUnchanged, resultFile: path.relative(ROOT, RESULT) })}\n`);
  if (result.phase !== 'passed') process.exitCode = 1;
}

module.exports = { IsolationError, FixtureBudget, WorkerDiagnostics, bounded, isolationArguments, loopbackOrigin, classifyWorker,
  summarizeWorkers, classifyProxyLine, startFixtureServer, startRejectingProxy, closeServer, requestFixture, closeOwned,
  workerProbe, captureWorkerProbe, evidenceHashes, sourceHashes, launchFixtureBrowser, fixtureExecutable, pageProbe, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${JSON.stringify({ stopCode: error instanceof IsolationError ? error.code : 'local_fixture_setup_failed' })}\n`);
  process.exitCode = 1;
});
