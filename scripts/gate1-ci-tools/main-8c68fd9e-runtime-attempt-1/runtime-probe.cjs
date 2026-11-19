'use strict';
/* global process, Buffer, setTimeout, clearTimeout, URL, AbortController */

/** Six-case, same-process production-server harness. Its CLI is only for the isolated CI child. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const base = require('../main-8c68fd9e-static-attempt-1/qualify-static.cjs');
const inspector = require('./inspect-runtime.cjs');
const { RuntimeError } = inspector;
const HEADERS = Object.freeze({ key: 'x-gate1-middleware-probe-key', challenge: 'x-gate1-middleware-probe-challenge', observation: 'x-gate1-middleware-runtime' });
const CASES = Object.freeze(['baseline', 'authenticated_1', 'authenticated_2', 'wrong_credential', 'query_excluded', 'protected_redirect']);
const LIMITS = Object.freeze({ requests: 6, httpMs: 10000, headerBytes: 16384, bodyBytes: 1048576, startupMs: 30000, cleanupMs: 5000, runtimeMs: 360000, progressFiles: 8 });
const CODES = Object.freeze([...base.CODES, 'isolation', 'runtime_read', 'http', 'http_cap', 'observation', 'cache_cookie', 'route', 'startup', 'cancelled']);
const COUNT_KEYS = ['version', 'nodeVersion', 'releaseName'];
const PHASES = Object.freeze({ inspect: 120000, startup: 30000, requests: 60000, cleanup: 5000, recheck: 120000 });
const TRANSITIONS = Object.freeze({ isolation: ['inspect'], inspect: ['startup', 'stopped'], startup: ['requests', 'cleanup'],
  requests: ['cleanup'], cleanup: ['recheck', 'stopped'], recheck: ['complete', 'stopped'], complete: [], stopped: [] });
const PHASE_FILES = 6;

/** Reject extra or missing evidence fields; the frozen static helper keeps this utility private. */
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

/** Map arbitrary exceptions to the finite evidence vocabulary before persistence. */
function failureCode(error) { return CODES.includes(error?.code) ? error.code : 'internal'; }

/** Bound async startup and cleanup independently; the service deadline also covers synchronous stalls. */
function bounded(promise, ms, code = 'deadline') {
  let timer;
  if (!Number.isFinite(ms) || ms <= 0) return Promise.reject(new RuntimeError(code));
  return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new RuntimeError(code)), ms); })]).finally(() => clearTimeout(timer));
}

/** Construct synthetic diagnostic inputs once; reject challenge collisions without generating a replacement. */
function smokeCases(random = crypto.randomBytes) {
  const challenges = CASES.map(() => random(16).toString('hex'));
  if (new Set(challenges).size !== CASES.length || challenges.some(value => !/^[a-f0-9]{32}$/.test(value))) throw new RuntimeError('observation');
  return CASES.map((name, index) => ({ case: name, path: name === 'query_excluded' ? '/login?scope=1' : name === 'protected_redirect' ? '/admin' : '/login',
    challenge: challenges[index], headers: name === 'baseline' ? {} : {
      [HEADERS.key]: (name === 'wrong_credential' ? 'c' : 'a').repeat(64), [HEADERS.challenge]: challenges[index] } }));
}

/** Issue one bounded loopback request; bodies are counted/discarded and all terminal paths close both ends. */
function getLocal(request, transport = http.request) {
  return new Promise((resolve, reject) => {
    let req, response, done = false, bytes = 0;
    /** Settle at most once and close owned sockets; only transient response metadata reaches review. */
    function finish(error, result) {
      if (done) return;
      done = true; clearTimeout(timer); response?.destroy(); req?.destroy();
      if (error) reject(error); else resolve(result);
    }
    const timer = setTimeout(() => finish(new RuntimeError('http')), LIMITS.httpMs);
    try {
      req = transport({ host: '127.0.0.1', port: 32147, method: 'GET', path: request.path, headers: request.headers, agent: false, maxHeaderSize: LIMITS.headerBytes }, incoming => {
        response = incoming;
        if (done) { incoming.destroy(); return; }
        incoming.on('data', chunk => { bytes += chunk.length; if (bytes > LIMITS.bodyBytes) finish(new RuntimeError('http_cap')); });
        incoming.once('aborted', () => finish(new RuntimeError('http')));
        incoming.once('error', () => finish(new RuntimeError('http')));
        incoming.once('close', () => { if (!done) finish(new RuntimeError('http')); });
        incoming.once('end', () => finish(null, { status: incoming.statusCode, headers: incoming.headers, rawHeaders: incoming.rawHeaders, bodyBytes: bytes }));
      });
      req.maxHeadersCount = 0; // Preserve every header within the byte cap, including a late Set-Cookie.
      req.once('error', () => finish(new RuntimeError('http')));
      if (done) req.destroy(); else req.end();
    } catch { finish(new RuntimeError('http')); }
  });
}

/** Parse effective private/no-store directives strictly, rejecting ambiguous or conflicting cache ages. */
function privateNoStore(headers) {
  if (typeof headers['cache-control'] !== 'string') return false;
  const parts = headers['cache-control'].split(',').map(value => value.trim().toLowerCase());
  if (!parts.includes('private') || !parts.includes('no-store') || parts.includes('public')) return false;
  for (const part of parts) {
    const match = /^(s-maxage|max-age)\s*(.*)$/.exec(part);
    if (match && !/^=\s*0$/.test(match[2])) return false;
  }
  return ['cdn-cache-control', 'vercel-cdn-cache-control'].every(key => headers[key] === undefined || headers[key] === 'no-store');
}

/** Review one response and exact native counts; return only allowlisted case facts without raw inputs. */
function reviewResponse(result, request, counts, nativeVersion) {
  const index = CASES.indexOf(request.case), positive = index === 1 || index === 2, protectedCase = index === 5;
  if (index < 0 || !exactKeys(counts, COUNT_KEYS) || Object.values(counts).some(value => !Number.isInteger(value) || value !== (positive ? 1 : 0))) throw new RuntimeError('runtime_read');
  const headers = result.headers, raw = result.rawHeaders;
  if (!headers || !Array.isArray(raw) || raw.length % 2 || raw.some(value => typeof value !== 'string')) throw new RuntimeError('http');
  const names = raw.filter((_value, i) => i % 2 === 0).map(name => name.toLowerCase());
  if (headers['set-cookie'] !== undefined || names.includes('set-cookie')) throw new RuntimeError('cache_cookie');
  if (!Number.isInteger(result.bodyBytes) || result.bodyBytes < 0 || result.bodyBytes > LIMITS.bodyBytes) throw new RuntimeError('http_cap');
  if (protectedCase) {
    if (![307, 308].includes(result.status) || typeof headers.location !== 'string') throw new RuntimeError('route');
    let target;
    try { target = new URL(headers.location, 'http://127.0.0.1:32147'); } catch { throw new RuntimeError('route'); }
    if (target.origin !== 'http://127.0.0.1:32147' || target.pathname !== '/login' || target.search || target.hash || target.username || target.password) throw new RuntimeError('route');
  } else if (result.status !== 200 || result.bodyBytes === 0) throw new RuntimeError('route');
  const needsCache = positive || index === 3 || protectedCase;
  if (needsCache && !privateNoStore(headers)) throw new RuntimeError('cache_cookie');
  const occurrences = names.filter(name => name === HEADERS.observation).length;
  if (positive) {
    let value;
    try { value = JSON.parse(headers[HEADERS.observation]); } catch { throw new RuntimeError('observation'); }
    const rawObservation = raw[names.indexOf(HEADERS.observation) * 2 + 1];
    if (occurrences !== 1 || rawObservation !== headers[HEADERS.observation] || !exactKeys(value, ['schemaVersion', 'scope', 'challenge', 'nodeVersion', 'node22']) ||
        JSON.stringify(value) !== headers[HEADERS.observation] || value.schemaVersion !== 1 || value.scope !== 'middleware' ||
        value.challenge !== request.challenge || nativeVersion !== 'v' + base.VERSIONS.node || value.nodeVersion !== nativeVersion || value.node22 !== true) throw new RuntimeError('observation');
  } else if (occurrences || headers[HEADERS.observation] !== undefined) throw new RuntimeError('observation');
  return { case: request.case, status: result.status, bodyNonempty: result.bodyBytes > 0, observation: positive,
    challengeMatched: positive ? true : null, nodeVersion: positive ? nativeVersion : null, nativeReadCounts: { ...counts },
    noCookies: true, privateNoStore: needsCache ? true : null, loginRedirect: protectedCase ? true : null };
}

/** Strictly validate retained cases by order and fixed expectations, rejecting arbitrary fields or values. */
function validateCases(cases) {
  if (!Array.isArray(cases) || cases.length > LIMITS.requests) throw new RuntimeError('report_schema');
  cases.forEach((value, index) => {
    const positive = index === 1 || index === 2, protectedCase = index === 5;
    if (!exactKeys(value, ['case', 'status', 'bodyNonempty', 'observation', 'challengeMatched', 'nodeVersion', 'nativeReadCounts', 'noCookies', 'privateNoStore', 'loginRedirect']) ||
        value.case !== CASES[index] || !(protectedCase ? [307, 308].includes(value.status) : value.status === 200) ||
        typeof value.bodyNonempty !== 'boolean' || (!protectedCase && !value.bodyNonempty) || value.observation !== positive ||
        value.challengeMatched !== (positive ? true : null) || value.nodeVersion !== (positive ? 'v' + base.VERSIONS.node : null) ||
        !exactKeys(value.nativeReadCounts, COUNT_KEYS) || Object.values(value.nativeReadCounts).some(count => count !== (positive ? 1 : 0)) ||
        value.noCookies !== true || value.privateNoStore !== (positive || index === 3 || protectedCase ? true : null) || value.loginRedirect !== (protectedCase ? true : null)) throw new RuntimeError('report_schema');
  });
  return cases;
}

/** Build the initial runtime evidence; unknown fields stay null until actually observed. */
function emptyRuntime() {
  return { stage: 'isolation', failure: null, attempted: 0, cases: [], serverStarted: false, inspection: null, isolationVerified: false,
    sourceUnchanged: false, compiledUnchanged: false, descriptorsRestored: null, serverClosed: null, nextClosed: null };
}

/** Validate the complete runtime/progress schema, including failure and cleanup consistency. */
function validateRuntime(value, complete = false) {
  if (!exactKeys(value, Object.keys(emptyRuntime())) || !['isolation', 'inspect', 'startup', 'requests', 'recheck', 'cleanup', 'complete'].includes(value.stage) ||
      (value.failure !== null && !CODES.includes(value.failure)) || !Number.isInteger(value.attempted) || value.attempted < 0 || value.attempted > 6 ||
      typeof value.serverStarted !== 'boolean' || typeof value.isolationVerified !== 'boolean' || typeof value.sourceUnchanged !== 'boolean' || typeof value.compiledUnchanged !== 'boolean' ||
      ['descriptorsRestored', 'serverClosed', 'nextClosed'].some(key => value[key] !== null && typeof value[key] !== 'boolean')) throw new RuntimeError('report_schema');
  validateCases(value.cases);
  if (value.cases.length > value.attempted || value.attempted - value.cases.length > 1 || (value.attempted > 0 && (!value.serverStarted || !value.isolationVerified || value.inspection === null))) throw new RuntimeError('report_schema');
  if (value.inspection !== null) base.validateInspection(value.inspection);
  if ((value.serverStarted && (!value.isolationVerified || value.inspection === null)) ||
      (value.inspection !== null && !value.isolationVerified) || (value.compiledUnchanged && (value.inspection === null || value.cases.length !== 6)) ||
      (value.sourceUnchanged && !value.compiledUnchanged) || (value.stage === 'complete' && !complete)) {
    if (value.stage === 'complete' && !complete) return validateRuntime(value, true);
    throw new RuntimeError('report_schema');
  }
  if (value.failure !== null && ['descriptorsRestored', 'serverClosed', 'nextClosed'].some(key => value[key] === false) && value.failure !== 'cleanup') throw new RuntimeError('report_schema');
  if (complete && (value.failure !== null || value.stage !== 'complete' || value.attempted !== 6 || value.cases.length !== 6 ||
      !value.serverStarted || !value.isolationVerified || !value.sourceUnchanged || !value.compiledUnchanged || value.inspection === null ||
      !value.descriptorsRestored || !value.serverClosed || !value.nextClosed)) throw new RuntimeError('report_schema');
  return value;
}

/** Exercise one production server with injected synthetic seams for tests; cleanup attempts are independent. */
async function smoke(app, inspection, report, progress, operations = {}) {
  const createServer = operations.createServer || http.createServer;
  const observe = operations.observe || inspector.observeNativeReads;
  const request = operations.request || getLocal;
  const nativeVersion = operations.nativeVersion || process.version;
  const now = operations.now || Date.now, phase = operations.phase || (() => {});
  let observer, next, server, serverError = false;
  const sockets = new Set();
  const listening = new AbortController();
  try {
    report.stage = 'startup';
    phase('startup');
    const startupDeadline = now() + LIMITS.startupMs;
    try { observer = observe(inspection.reader); report.descriptorsRestored = false; }
    catch (error) { report.descriptorsRestored = error.descriptorsRestored ?? null; throw error; }
    const makeNext = operations.makeNext || require(path.join(app, 'node_modules/next'));
    next = makeNext({ dev: false, dir: app, hostname: '127.0.0.1', port: 32147 }); report.nextClosed = false;
    await bounded(next.prepare(), startupDeadline - now(), 'startup');
    if (now() >= startupDeadline) throw new RuntimeError('startup');
    server = createServer(next.getRequestHandler()); report.serverClosed = false;
    server.on('error', () => { serverError = true; });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen({ port: 32147, host: '127.0.0.1', signal: listening.signal }, resolve); }), startupDeadline - now(), 'startup');
    if (now() >= startupDeadline) throw new RuntimeError('startup');
    report.serverStarted = true; progress(report);
    report.stage = 'requests'; phase('requests');
    for (const item of (operations.cases || smokeCases)()) {
      if (serverError || report.attempted >= LIMITS.requests) throw new RuntimeError('http');
      observer.reset(); report.attempted++; progress(report);
      const response = await request(item);
      if (serverError) throw new RuntimeError('http');
      report.cases.push(reviewResponse(response, item, observer.snapshot(), nativeVersion));
    }
  } finally {
    const cleanup = [];
    const cleanupDeadline = now() + LIMITS.cleanupMs;
    report.stage = 'cleanup';
    try { phase('cleanup'); } catch { cleanup.push('phase'); }
    listening.abort();
    if (observer) {
      try { observer.restore(); report.descriptorsRestored = true; }
      catch { report.descriptorsRestored = false; cleanup.push('descriptors'); }
    }
    // Initiate both asynchronous closures within the same allowance, even if either throws or stalls.
    const closures = [];
    try {
      for (const socket of sockets) { try { socket.destroy(); } catch { cleanup.push('socket'); } }
      if (server) closures.push(bounded(new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())), cleanupDeadline - now(), 'cleanup')
        .then(() => { if (server.listening || [...sockets].some(socket => !socket.destroyed)) throw new RuntimeError('cleanup'); report.serverClosed = true; })
        .catch(() => { cleanup.push('server'); }));
    } catch { cleanup.push('server'); }
    try {
      if (next) closures.push(bounded(next.close(), cleanupDeadline - now(), 'cleanup').then(() => { report.nextClosed = true; }).catch(() => { cleanup.push('next'); }));
    } catch { cleanup.push('next'); }
    await Promise.all(closures);
    if (now() >= cleanupDeadline) cleanup.push('deadline');
    // Cleanup failure has precedence, and each remaining cleanup action was still attempted.
    // eslint-disable-next-line no-unsafe-finally
    if (cleanup.length) throw new RuntimeError('cleanup');
  }
}

/** Resolve a fixed protocol filename beneath a real, link-free scratch directory, before any access. */
function recordPath(scratch, name, io = fs) {
  if (!/^(?:input|ready|release|runtime|progress-0[0-7]|phase-0[0-5])\.json$/.test(name)) throw new RuntimeError('persistence');
  const root = path.resolve(scratch);
  for (let current = root; ; current = path.dirname(current)) {
    const stat = io.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimeError('persistence');
    if (path.dirname(current) === current) break;
  }
  if (io.realpathSync(root) !== root) throw new RuntimeError('persistence');
  return path.join(root, name);
}

/** Publish complete capped JSON with an exclusive hard link; unfinished writes never expose a final name. */
function publish(scratch, name, value, io = fs) {
  const filename = recordPath(scratch, name, io), pending = path.join(path.dirname(filename), '.pending-' + name);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (bytes.length > base.LIMITS.reportBytes) throw new RuntimeError('report_schema');
  let fd;
  try {
    fd = io.openSync(pending, 'wx', 0o600);
    io.writeFileSync(fd, bytes); io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
    io.linkSync(pending, filename); // Atomic visibility and EEXIST, unlike overwriting rename().
    io.unlinkSync(pending);
  } catch {
    if (fd !== undefined) { try { io.closeSync(fd); } catch { /* Preserve the interrupted pending file; never replay it. */ } }
    throw new RuntimeError('persistence');
  }
  return base.sha(bytes);
}

/** Check ordered phase starts and elapsed bounds, including phases completed between parent polls. */
function validatePhases(records, releaseAt, now, deadline, terminal = false) {
  if (!Array.isArray(records) || records.length > PHASE_FILES || !Number.isSafeInteger(releaseAt) || !Number.isSafeInteger(now) || now < releaseAt) throw new RuntimeError('report_schema');
  let previous = { phase: 'isolation', at: releaseAt };
  for (const value of records) {
    if (!exactKeys(value, ['phase', 'at']) || !Number.isSafeInteger(value.at) || value.at < previous.at || value.at > now || value.at >= deadline ||
        !TRANSITIONS[previous.phase].includes(value.phase)) throw new RuntimeError('report_schema');
    if (value.at - previous.at >= (PHASES[previous.phase] || LIMITS.startupMs)) throw new RuntimeError('deadline');
    previous = value;
  }
  if (terminal && !['complete', 'stopped'].includes(previous.phase)) throw new RuntimeError('report_schema');
  if (!['complete', 'stopped'].includes(previous.phase) && now - previous.at >= (PHASES[previous.phase] || LIMITS.startupMs)) throw new RuntimeError('deadline');
  if (now >= deadline) throw new RuntimeError('deadline');
  return previous.phase;
}

/** Read canonical bounded JSON; duplicate keys and noncanonical encodings cannot disappear through parsing. */
function readJson(filename) {
  const bytes = base.readBounded(filename), text = bytes.toString('utf8');
  let value;
  try { value = JSON.parse(text); } catch { throw new RuntimeError('report_schema'); }
  if (text !== JSON.stringify(value, null, 2) + '\n') throw new RuntimeError('report_schema');
  return value;
}

/** Validate the installed-child input with Zod before it can select source files or influence execution. */
function validateInput(input, app) {
  const { z } = createRequire(path.join(app, 'package.json'))('zod');
  const entry = z.object({ name: z.string().max(1024).regex(/^(?!.*(?:\\|:|\.\.))[A-Za-z0-9_./@()[\]-]+$/), oid: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
  const schema = z.object({ executionDigest: z.string().regex(/^[a-f0-9]{64}$/), unit: z.string().regex(/^gate1-runtime-[1-9]\d{0,14}-1\.service$/),
    hostNamespace: z.string().regex(/^net:\[\d+\]$/), deadline: z.number().int().positive(), entries: z.array(entry).length(362),
    routes: z.array(z.string().max(256).startsWith('/')).max(4096) }).strict();
  if (!schema.safeParse(input).success || base.sha(JSON.stringify(input.entries)) !== 'c97d1f5080c6674b97151e06d68f20a337cbe9b2c5014e00e9dd28a461a77c87' ||
      JSON.stringify(base.pageRoutes(input.entries)) !== JSON.stringify(input.routes)) throw new RuntimeError('source_inventory');
  return input;
}

/** Run only after the parent and kernel checks agree; progress precedes each request and contains no secrets. */
async function childMain(app, scratch, operations = {}) {
  const isolation = require('./isolate-runtime.cjs'), input = (operations.validateInput || validateInput)(readJson(recordPath(scratch, 'input.json')), app);
  const inputHash = base.sha(base.readBounded(path.join(scratch, 'input.json'))), report = emptyRuntime();
  const now = operations.now || Date.now, phases = [];
  let sequence = 0, releaseAt = null;
  /** Persist monotonic pre-request evidence exclusively; failure prevents that request from starting. */
  function progress(value) {
    validateRuntime(value);
    if (sequence >= LIMITS.progressFiles) throw new RuntimeError('report_schema');
    publish(scratch, `progress-${String(sequence++).padStart(2, '0')}.json`, { inputHash, runtime: value });
  }
  /** Publish lifecycle transitions before work, so the external watchdog also bounds synchronous stalls. */
  function phase(name) {
    const value = { phase: name, at: now() };
    validatePhases([...phases, value], releaseAt, now(), input.deadline);
    publish(scratch, `phase-${String(phases.length).padStart(2, '0')}.json`, { inputHash, ...value });
    phases.push(value);
  }
  try {
    if ((operations.childFlag ?? process.env.GATE1_RUNTIME_CHILD) !== '1') throw new RuntimeError('approval');
    (operations.verifyKernel || isolation.verifyKernel)(input, fs, { app, scratch, tooling: path.resolve(__dirname, '../../..'), node: process.execPath });
    base.validateVersions(operations.versions || { node: process.versions.node, ...base.installedVersions(app) }, ['node', 'next', 'react', 'react-dom', 'acorn']);
    publish(scratch, 'ready.json', { inputHash, kernelVerified: true });
    const releaseDeadline = Math.min(input.deadline, now() + LIMITS.startupMs);
    while (!fs.existsSync(path.join(scratch, 'release.json'))) {
      if (now() >= releaseDeadline) throw new RuntimeError('isolation');
      await (operations.pause || (() => new Promise(resolve => setTimeout(resolve, 50))))();
    }
    const release = readJson(path.join(scratch, 'release.json'));
    if (!exactKeys(release, ['inputHash', 'serviceVerified', 'at']) || release.inputHash !== inputHash || release.serviceVerified !== true ||
        !Number.isSafeInteger(release.at) || release.at > now() || now() >= releaseDeadline) throw new RuntimeError('isolation');
    releaseAt = release.at;
    report.isolationVerified = true; progress(report);
    report.stage = 'inspect'; phase('inspect');
    (operations.verify || base.verifyFiles)(app, input.entries);
    const parse = operations.parse || createRequire(path.join(app, 'package.json'))('acorn').parse;
    const inspection = (operations.inspect || inspector.inspect)(app, input.routes, parse); report.inspection = inspection.facts;
    await smoke(app, inspection, report, progress, { ...operations.smoke, phase });
    report.stage = 'recheck'; phase('recheck');
    (operations.recheck || inspector.recheck)(app, input.routes, parse, inspection.facts); report.compiledUnchanged = true;
    (operations.verify || base.verifyFiles)(app, input.entries); report.sourceUnchanged = true;
    phase('complete');
    report.stage = 'complete'; validateRuntime(report, true);
  } catch (error) {
    report.failure = failureCode(error);
    if (releaseAt !== null && phases.length && !['complete', 'stopped'].includes(phases.at(-1).phase)) {
      try { phase('stopped'); } catch (phaseError) { if (report.failure !== 'cleanup') report.failure = failureCode(phaseError); }
    }
    if (report.stage === 'complete') report.stage = 'cleanup';
  }
  validateRuntime(report);
  publish(scratch, 'runtime.json', { inputHash, runtime: report });
  return report;
}

if (require.main === module) {
  if (process.argv.length !== 5 || process.argv[2] !== '--child') process.exitCode = 1;
  else childMain(path.resolve(process.argv[3]), path.resolve(process.argv[4])).then(report => process.exit(report.failure ? 1 : 0)).catch(() => process.exit(1));
}

module.exports = { HEADERS, CASES, LIMITS, CODES, PHASES, PHASE_FILES, exactKeys, failureCode, bounded, smokeCases, getLocal, privateNoStore, reviewResponse, validateCases,
  emptyRuntime, validateRuntime, smoke, recordPath, publish, validatePhases, readJson, validateInput, childMain };
