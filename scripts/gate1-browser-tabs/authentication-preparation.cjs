'use strict';
/* global __dirname, __filename, URL, process, setTimeout, clearTimeout, fetch */

/** Bounded offline preparation qualification. Hosted execution is intentionally unavailable. */
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const t = require('./authentication-preparation-traffic.cjs');
const p = require('./authentication-preparation-postflight.cjs');
const d = require('./hosted-csrf-diagnostic.cjs');
const b = require('./hosted-csrf-build-attribution.cjs');
const f = require('./request-client-isolation.cjs');
const comparison = require('./page-lifecycle-diagnostic.cjs');
const { check, PreparationError } = t;
const CORE = 'C:/Users/willm/AppData/Local/npm-cache/_npx/a5b920f00216d246/node_modules/playwright-core';
const BUILD = 'YB6TC2dgLcUGcHUpFCAaM';
const BUILD_HASH = '696c9f49c967e7f9a141f2456e672e2ccdc9b5b4c0bd7fd68c090ad456ce6726';
const MANIFEST_HASH = '6335ed68946262c0367dbd3380ffccdf22ccf8675b148624fb8ade51864157e7';
const OLD_SOURCES = '816979a2cbdcd3586dbe824359b00c41d92b2fb9e97ca32add2947b251a1081a';
const FILES = Object.freeze(['authentication-preparation.cjs', 'authentication-preparation-traffic.cjs',
  'authentication-preparation-postflight.cjs', '__tests__/authentication-preparation.test.cjs',
  '__tests__/authentication-preparation-traffic.test.cjs', '__tests__/authentication-preparation-postflight.test.cjs',
  'AUTHENTICATION-PREPARATION.md']);
const BASELINE = Object.freeze({ actual: Object.freeze({ application: 150, static: 150, session: 52 }),
  conservative: Object.freeze({ application: 151, static: 150, session: 52 }) });
const OFFLINE = Object.freeze({ ...t.LIMITS, wholeMs: 180000, cleanupMs: 30000,
  application: 12, session: 4, canonicalStatic: 0, providerStatic: 0, supabase: 0, google: 0, metadata: 0 });
const SYNTHETIC_ID = '00000000-0000-4000-8000-000000000001';

/** Hash only explicitly selected source/package/evidence paths, never browser authentication storage. */
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Permit only checkout CRLF conversion in the two newly published build files, never content edits. */
function dependencyMatches(name, current, consumed) {
  if (current.equals(consumed)) return true;
  return ['hosted-csrf-build-attribution.cjs', '__tests__/hosted-csrf-build-attribution.test.cjs'].includes(name)
    && current.toString('utf8').replaceAll('\r\n', '\n') === consumed.toString('utf8').replaceAll('\r\n', '\n');
}

/** Bind exact checkout bytes and exact accepted bytes separately; qualify only reviewed line-ending conversion. */
async function sourceHash() {
  const old = {}; const accepted = {}; const added = {};
  for (const name of b.SOURCE_FILES) {
    const current = await fs.readFile(path.join(__dirname, name));
    const consumed = await fs.readFile(path.join(d.DIRECTORY, name));
    old[name] = d.digest(current); accepted[name] = d.digest(consumed);
    check(dependencyMatches(name, current, consumed), 'integrity');
  }
  check(d.digest(JSON.stringify(accepted)) === OLD_SOURCES, 'integrity');
  for (const name of FILES) added[name] = await hashFile(path.join(__dirname, name));
  return d.digest(JSON.stringify({ dependencies: old, acceptedDependencies: accepted, preparation: added }));
}

/** Validate a future plan strictly without granting execution, accepting identity only through private memory. */
function validatePlan(plan, expectedIdentity, now = Date.now()) {
  const { z } = require('zod');
  /** Turn the frozen scalar configuration into a strict schema without copying rejected values. */
  const exact = value => z.object(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, z.literal(item)]))).strict();
  const schema = z.object({ approval: z.literal('authentication-preparation-01'), target: exact(d.TARGET),
    buildId: z.literal(BUILD), profile: z.literal(d.PROFILE), sourceSet: z.string().regex(/^[a-f0-9]{64}$/),
    buildHash: z.literal(BUILD_HASH), buildCompletionReviewed: z.literal(true), limits: exact(t.LIMITS),
    ledgerBefore: z.object({ actual: exact(BASELINE.actual), conservative: exact(BASELINE.conservative) }).strict(),
    approvedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().nonnegative().safe() }).strict();
  check(schema.safeParse(plan).success, 'schema');
  check(z.string().uuid().safeParse(expectedIdentity).success, 'identity');
  check(plan.approvedAt <= now && now < plan.expiresAt && plan.expiresAt - plan.approvedAt <= 3600000, 'expired');
  return true;
}

/** Compare a response to an independently supplied identity; no identity, hash or body leaves this function. */
function verifyIdentity(data, expected) {
  const { z } = require('zod');
  check(z.string().uuid().safeParse(expected).success && data?.error === null && data.message === 'Success'
    && data.data?.user?.id === expected, 'identity');
  return true;
}

/** Preserve original completion evidence and exact pinned toolchain before any native qualification begins. */
async function preflight(expected) {
  check(!['DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'NODE_OPTIONS', 'NODE_DEBUG'].some(name => process.env[name]), 'debug_logging');
  check(/^[a-f0-9]{64}$/.test(expected) && await sourceHash() === expected, 'integrity');
  check(await hashFile(path.join(d.DIRECTORY, 'build-attribution.json')) === BUILD_HASH
    && await hashFile(path.join(d.DIRECTORY, 'build-attribution-plan.json')) === MANIFEST_HASH, 'integrity');
  await d.historyHashes();
  const metadata = JSON.parse(await fs.readFile(path.join(CORE, 'package.json'), 'utf8'));
  check(metadata.name === 'playwright-core', 'toolchain');
  comparison.checkToolchain({ node: process.version, playwright: metadata.version,
    bundle: await hashFile(path.join(CORE, 'lib/coreBundle.js')),
    executable: await hashFile(f.fixtureExecutable('cft158')) }, 'cft158');
  comparison.checkPackage(await comparison.packageHashes());
  await p.inspectBrowserAbsence();
}

/** Start one owned loopback listener and register it before asynchronous binding can fail. */
async function listen(server, resources) {
  const resource = { server, sockets: new Set(), port: null }; resources.push(resource);
  server.on('connection', socket => { resource.sockets.add(socket); socket.once('close', () => resource.sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  resource.port = server.address().port; return resource;
}

/** Serve only synthetic redirects and a persistent, non-secret cookie; no real account or OAuth data exists. */
async function startOrigin(resources) {
  const counts = { requests: 0, sessions: 0 };
  const resource = await listen(http.createServer((request, response) => {
    counts.requests++;
    if (counts.requests > 12 || request.method !== 'GET') { response.writeHead(403).end(); return; }
    if (request.url === '/start') { response.writeHead(302, { location: '/login' }).end(); return; }
    if (request.url === '/login') {
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store',
        'set-cookie': 'gate1-synthetic=seed; Path=/; Max-Age=600; SameSite=Lax' });
      response.end('<!doctype html><link rel="icon" href="data:,"><title>Gate 1 synthetic preparation</title>'); return;
    }
    if (request.url === '/session') {
      counts.sessions++;
      const present = /(?:^|;\s*)gate1-synthetic=seed(?:;|$)/.test(request.headers.cookie || '');
      response.writeHead(present ? 200 : 401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: null, message: 'Success', data: { user: { id: present ? SYNTHETIC_ID : null } } })); return;
    }
    response.writeHead(403).end();
  }), resources);
  return { ...resource, counts, origin: `http://127.0.0.1:${resource.port}` };
}

/**
 * A loopback-only HTTP proxy, denied until observation is ready. CONNECT is always rejected;
 * it never opens an external connection, forwards DNS names or inspects encrypted payloads.
 */
async function startProxy(origin, budget, resources) {
  const state = { ready: false, forwarded: 0, denied: 0, connections: 0, readyBeforeForwarding: true };
  const server = http.createServer((request, response) => {
    let destination;
    try {
      budget.check(); destination = new URL(request.url);
      check(state.ready && destination.origin === origin.origin && request.method === 'GET'
        && ['/start', '/login', '/session'].includes(destination.pathname) && !destination.search
        && !destination.username && !destination.password, 'destination');
    } catch { state.denied++; response.writeHead(403).end(); return; }
    state.forwarded++;
    const upstream = http.request({ host: '127.0.0.1', port: origin.port, path: destination.pathname,
      method: 'GET', timeout: 5000, headers: { connection: 'close', ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}) } }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
    });
    upstream.once('timeout', () => { budget.stop('deadline'); upstream.destroy(); });
    upstream.once('error', () => { budget.stop('operation'); response.destroy(); });
    response.once('close', () => upstream.destroy()); upstream.end();
  });
  server.on('connect', (_request, socket) => { state.denied++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  const resource = await listen(server, resources);
  server.on('connection', socket => {
    state.connections++;
    try {
      budget.reserve('proxyConnections');
      check(resource.sockets.size <= OFFLINE.proxyConcurrent, 'budget');
    } catch { budget.stop('budget'); socket.destroy(); return; }
    socket.on('data', chunk => {
      try { budget.reserve('proxyBytes', chunk.length); } catch { socket.destroy(); }
    });
  });
  return { ...resource, state };
}

/** Bound local operations with the shared work deadline; late results cannot authorize another step. */
async function step(budget, action, maximum = 5000) {
  budget.check();
  const result = await f.bounded(action, Math.max(1, Math.min(maximum, budget.deadline - Date.now())));
  budget.check(); return result;
}

/** Launch only the fixed new synthetic profile behind a rejecting proxy; retain ownership immediately. */
async function launch(runtime, proxy, budget, owners) {
  budget.reserve('launches'); check(await fs.realpath(p.PROFILE) === path.resolve(p.PROFILE), 'profile');
  const owner = { profile: p.PROFILE, launchTime: Date.now(), child: null, browser: null, port: null,
    failed: false, closed: false };
  owners.push(owner);
  owner.child = spawn(f.fixtureExecutable('cft158'), [`--user-data-dir=${p.PROFILE}`, '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--disable-background-networking', '--disable-quic', '--no-startup-window', ...f.isolationArguments(proxy.port, null)],
  { stdio: 'ignore', windowsHide: true });
  owner.child.once('error', () => { owner.failed = true; budget.stop('operation'); });
  const startupEnd = Date.now() + 10000;
  while (!owner.port && Date.now() < startupEnd) {
    budget.check(); check(!owner.failed && owner.child.exitCode === null, 'closure');
    try {
      const file = path.join(p.PROFILE, 'DevToolsActivePort'); const stat = await fs.stat(file);
      if (stat.mtimeMs >= owner.launchTime) {
        const value = await fs.readFile(file, 'utf8');
        check(value.length <= 1024, 'profile');
        const port = Number(value.split(/\r?\n/)[0]); if (Number.isInteger(port) && port > 0 && port < 65536) owner.port = port;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!owner.port) await new Promise(resolve => setTimeout(resolve, 50));
  }
  check(owner.port, 'closure');
  owner.browser = await step(budget, () => runtime.chromium.connectOverCDP(`http://127.0.0.1:${owner.port}`, { noDefaults: true, timeout: 5000 }));
  const contexts = owner.browser.contexts(); check(contexts.length === 1, 'fixture'); owner.context = contexts[0];
  check(owner.context.pages().length <= 1 && owner.context.pages().every(page => page.url() === 'about:blank'), 'fixture');
  owner.keeper = owner.context.pages()[0] || await step(budget, () => owner.context.newPage());
  owner.context.on('serviceworker', () => budget.stop('observation'));
  owner.context.on('page', () => { if (owner.context.pages().length > 2) budget.stop('observation'); });
  return owner;
}

/** Establish page interception before enabling the proxy or making the first navigation. */
async function observe(owner, origin, budget, observers) {
  const page = await step(budget, () => owner.context.newPage());
  const session = await step(budget, () => owner.context.newCDPSession(page));
  const denied = `http://localhost:${origin.port}/blocked`;
  const observer = new t.PageTrafficObserver(session, budget, (url, method) => {
    if (url === denied && method === 'GET') return 'synthetic_denial';
    check(method === 'GET' && ['/start', '/login', '/session'].some(route => url === origin.origin + route), 'destination');
    return url.endsWith('/session') ? 'session' : 'application';
  });
  observers.push(observer); await step(budget, () => observer.start());
  return { page, observer, denied };
}

/** Close only the owned browser normally and require both exit code zero and independent OS/socket evidence. */
async function closeBrowser(owner, runtime, deadline) {
  check(await f.closeOwned(owner, runtime, deadline) && owner.child.exitCode === 0, 'closure');
  const record = { profile: p.PROFILE, pid: owner.child.pid, port: owner.port, closedNormally: true, exitCode: 0 };
  await p.inspectProcessClosure(record); return record;
}

/** Stop and close local listeners; destroying owned proxy sockets does not terminate a browser process. */
async function closeListeners(resources) {
  for (const resource of [...resources].reverse()) {
    for (const socket of resource.sockets) socket.destroy();
    if (resource.server.listening) await f.bounded(() => new Promise((resolve, reject) =>
      resource.server.close(error => error ? reject(error) : resolve())), 2000);
    if (resource.port) await p.portClosed(resource.port);
  }
}

/** Execute exactly two synthetic launches; all failures retain evidence and cancel subsequent steps. */
async function runLoopback(expected, startedAt) {
  check(Number.isSafeInteger(startedAt) && Date.now() >= startedAt && Date.now() - startedAt < 150000, 'expired');
  const budget = new t.TrafficBudget({ limits: OFFLINE }); budget.startedAt = startedAt; budget.deadline = startedAt + 150000;
  const resources = []; const owners = []; const observers = []; const closures = []; const pageTraffic = [];
  const checks = Object.fromEntries(p.CHECKS.map(key => [key, false]));
  let origin; let proxy; let runtime;
  /** Cancellation closes subsequent dispatch while preserving normal browser cleanup. */
  const cancel = () => budget.stop('cancelled');
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel); process.on('message', cancel);
  try {
    const claim = await fs.open(path.join(p.DIRECTORY, 'worker-started'), 'wx'); await claim.close();
    await step(budget, () => preflight(expected), 30000);
    await fs.mkdir(p.PROFILE); runtime = require(CORE);
    origin = await startOrigin(resources); proxy = await startProxy(origin, budget, resources);
    const first = await launch(runtime, proxy, budget, owners);
    const initial = await observe(first, origin, budget, observers);
    checks.observationBeforeNavigation = initial.observer.ready; proxy.state.ready = true;
    await step(budget, () => initial.page.goto(origin.origin + '/start', { timeout: 5000, waitUntil: 'load' }));
    checks.redirectReserved = initial.observer.allowed === 2 && origin.counts.requests === 2;
    checks.syntheticIdentityBeforeRestart = await step(budget, () => initial.page.evaluate(async () => {
      const response = await fetch('/session'); const data = await response.json();
      return response.status === 200 && data?.data?.user?.id === '00000000-0000-4000-8000-000000000001';
    }));
    pageTraffic.push(await step(budget, () => initial.observer.summary()));
    proxy.state.ready = false; await initial.observer.close();
    closures.push(await closeBrowser(first, runtime, startedAt + 165000));
    const second = await launch(runtime, proxy, budget, owners);
    budget.reserve('session');
    let response;
    try {
      response = await step(budget, () => second.context.request.get(origin.origin + '/session', { timeout: 5000, maxRedirects: 0, maxRetries: 0 }));
      check(response.status() === 200, 'identity');
      const bytes = await step(budget, () => response.body()); check(bytes.length <= 1024, 'identity');
      checks.syntheticIdentityAfterRestart = verifyIdentity(JSON.parse(bytes.toString('utf8')), SYNTHETIC_ID);
    } finally { if (response) await response.dispose(); }
    const restored = await observe(second, origin, budget, observers); const before = origin.counts.requests;
    await step(budget, async () => {
      try { await restored.page.goto(restored.denied, { timeout: 5000, waitUntil: 'load' }); }
      catch (error) { check(/net::ERR_(BLOCKED_BY_CLIENT|FAILED)/.test(error.message), 'destination'); }
    });
    pageTraffic.push(await step(budget, () => restored.observer.summary()));
    checks.destinationBlocked = restored.observer.blocked === 1 && origin.counts.requests === before;
    await restored.observer.close(); closures.push(await closeBrowser(second, runtime, startedAt + 165000));
    checks.normalClosure = true;
    check(Object.entries(checks).filter(([key]) => !['profilePreserved', 'localListenersClosed'].includes(key)).every(([, value]) => value), 'fixture');
  } catch (error) { budget.stop(t.errorCode(error)); }
  finally {
    if (proxy) proxy.state.ready = false;
    for (const observer of observers) {
      try { await f.bounded(() => observer.close(), 1000); } catch { budget.stop('closure'); }
    }
    for (const owner of owners) {
      if (!owner.closed) {
        try { await closeBrowser(owner, runtime, startedAt + 165000); } catch { budget.stop('closure'); owner.child?.unref(); }
      }
    }
    budget.halted = true;
    try { await closeListeners(resources); checks.localListenersClosed = true; } catch { budget.stop('closure'); }
    checks.profilePreserved = await fs.stat(p.PROFILE).then(stat => stat.isDirectory(), () => false);
    try { check(await sourceHash() === expected, 'integrity'); } catch { budget.stop('integrity'); }
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); process.removeListener('message', cancel);
  }
  const record = { schemaVersion: 1, scope: 'synthetic_loopback_only', phase: budget.failure ? 'stopped' : 'passed',
    startedAt, completedAt: Date.now(), sourceSet: expected, checks, owners: closures,
    listenerPorts: resources.map(resource => resource.port), pageTraffic, requests: budget.snapshot().requests,
    proxy: { connections: proxy?.state.connections || 0, denied: proxy?.state.denied || 0,
      forwarded: proxy?.state.forwarded || 0, readyBeforeForwarding: true }, firstFailure: budget.failure,
    browserTrafficMeasured: false, hostedQualified: false };
  const attemptHash = await p.writeExclusive(p.ATTEMPT, record);
  return { phase: record.phase, firstFailure: record.firstFailure, receiptFinalized: true, attemptHash, sourceSet: expected };
}

/** Run the attempt in a child so successful exit and receipt completion can be reviewed independently. */
async function supervise(expected) {
  const startedAt = Date.now(); await f.bounded(() => preflight(expected), 30000);
  try { await fs.mkdir(p.DIRECTORY); } catch { throw new PreparationError('already_used'); }
  const completion = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--loopback-worker', expected], { windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore', 'ipc'], env: { ...process.env, GATE1_OFFLINE_STARTED_AT: String(startedAt) } });
    let output = ''; let overflow = false;
    /** Request cooperative cleanup without killing the browser or erasing its profile. */
    const cancel = () => { if (child.connected) child.send({ cancel: true }, () => {}); };
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    const timer = setTimeout(cancel, Math.max(1, startedAt + 150000 - Date.now()));
    child.stdout.on('data', bytes => { if (output.length + bytes.length > 2048) { overflow = true; cancel(); } else output += bytes; });
    child.once('error', () => { clearTimeout(timer); reject(new PreparationError('worker_completion')); });
    child.once('close', exitCode => {
      clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      try { check(!overflow, 'worker_completion'); resolve({ ...JSON.parse(output), exitCode }); }
      catch { reject(new PreparationError('worker_completion')); }
    });
  });
  if (completion.phase !== 'passed' || completion.exitCode !== 0) {
    throw new PreparationError(completion.firstFailure || 'worker_completion');
  }
  return p.finalizeOffline(completion, sourceHash);
}

/** Accept only explicit offline commands. No argument can enable hosted preparation or write its receipt. */
async function main(args) {
  if (args.length === 1 && args[0] === '--source-hash') return { sourceSet: await sourceHash() };
  if (args[0] === '--execute-reviewed-manifest') t.requireLiveCoverage();
  check(args.length === 2 && /^[a-f0-9]{64}$/.test(args[1]), 'arguments');
  if (args[0] === '--qualify-loopback') return supervise(args[1]);
  if (args[0] === '--loopback-worker') {
    check(process.connected === true, 'approval');
    return runLoopback(args[1], Number(process.env.GATE1_OFFLINE_STARTED_AT));
  }
  throw new PreparationError('arguments');
}

module.exports = { BUILD, BUILD_HASH, MANIFEST_HASH, FILES, BASELINE, OFFLINE, validatePlan, verifyIdentity,
  hashFile, dependencyMatches, sourceHash, preflight, startOrigin, startProxy, launch, observe, step, closeListeners,
  closeBrowser, runLoopback, supervise, main };
if (require.main === module) main(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.phase === 'stopped') process.exitCode = 1;
  if (process.connected) process.disconnect();
}).catch(error => {
  process.stderr.write(JSON.stringify({ stopCode: t.errorCode(error), gate1Status: 'open' }) + '\n');
  process.exitCode = 1; if (process.connected) process.disconnect();
});
