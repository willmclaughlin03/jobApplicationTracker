'use strict';
/* global __dirname, AbortSignal, Buffer, process, setTimeout, structuredClone */

/** Offline-prepared, single-use hosted diagnostic. Importing performs no I/O or native initialization. */
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile, spawn } = require('node:child_process');
const fixture = require('./request-client-isolation.cjs');
const comparison = require('./page-lifecycle-diagnostic.cjs');
const qualification = require('./full-isolation-qualification.cjs');
const ROOT = 'C:/Users/willm/job-application-tracker';
const DIRECTORY = path.join(ROOT, '.tmp/gate1-hosted-csrf-01');
const PROFILE = path.join(ROOT, '.tmp/gate1-hosted-csrf-profile-01');
const RESULT = path.join(DIRECTORY, 'hosted-csrf-result.json');
const CORE = 'C:/Users/willm/AppData/Local/npm-cache/_npx/a5b920f00216d246/node_modules/playwright-core';
const VERCEL = 'C:/Users/willm/AppData/Local/npm-cache/_npx/67eb4586ca667318/node_modules/vercel/dist/vc.js';
const VERCEL_CLIENT = path.join(path.dirname(VERCEL), 'chunks/chunk-DECIQZZQ.js');
const VERCEL_HASHES = Object.freeze({ 'vc.js': 'a0459896d4698233bab881d308ade711a772cde6bcc845728731a38ef0348090',
  'chunks/chunk-DECIQZZQ.js': '2ab9699b44b2692ae8087c3ae1787183d87bdfcb349bbace491c6095ba355b7f',
  'chunks/chunk-KREBNPHL.js': '68f2577a4f42085237bce5a1ae017dcbf6cf0387111476c16d5c06d339f70f99' });
const TARGET = Object.freeze({ project: 'prj_b2nMrysMSJtpmqoeGx5g0WGgGuom', team: 'team_7o3efmwjZbMc2Bfy9qAzkc9q',
  canonical: 'job-application-tracker-kappa-seven.vercel.app', deployment: 'dpl_jbyKAs8vNoVbGQ4vSM5hKd7LSrTJ',
  generated: 'job-application-tracker-gefwgn8zj-track-the-app.vercel.app', source: '62b4133d257b43529d93e62f98afc8ccb2faf15b' });
const ORIGIN = `https://${TARGET.canonical}`;
const HISTORY = Object.freeze({ ...qualification.HISTORY,
  'browser-isolation-fixture-cft158-01.json': 'f7f7a8fea52f058842d2a1e6a008823f452593c949684b41a51b5aa40fa8c647' });
const QUALIFIED_SOURCES = '4651ec30caf033c6c0886ed85842d5300ac0f4d4f1c999dacd0d4ec99438e1ef';
const SOURCE_FILES = Object.freeze([...qualification.SOURCE_FILES, 'hosted-csrf-diagnostic.cjs',
  '__tests__/hosted-csrf-diagnostic.test.cjs', 'README.md']);
const BASELINE = Object.freeze({ actual: Object.freeze({ application: 149, static: 150, session: 52 }),
  conservative: Object.freeze({ application: 150, static: 150, session: 52 }) });
const LIMITS = Object.freeze({ wholeMs: 600000, cleanupMs: 20000, preflightMs: 60000, operationMs: 5000,
  startupMs: 10000, metadataMs: 30000, metadataBytes: 2097152, loginBytes: 1048576, jsonBytes: 65536,
  headerBytes: 32768, evidenceBytes: 65536, planBytes: 16384, clockSkewMs: 30000, tokenDateSkewMs: 5000,
  expirySkewSeconds: 5, approvalWindowMs: 3600000, application: 3, static: 0, session: 1,
  metadata: 6, launches: 1, pages: 1, proxyConnections: 200 });
const COOKIE = '__Host-csrf-token';
const MAX_AGE = 14400;
const ENDPOINTS = Object.freeze(['/login', '/api/auth/session', '/api/auth/csrf']);
const APPROVAL = 'hosted-csrf-cft158-01';
const POLICY = 'request-client-only-rejecting-proxy-restored-workers';
const CODES = new Set(['arguments', 'execution_not_approved', 'readiness_not_approved', 'approval_expired', 'plan_schema',
  'target_mismatch', 'build_missing', 'profile_not_approved', 'account_missing', 'ledger_mismatch', 'preparation_missing',
  'execution_directory', 'debug_logging_enabled', 'source_mismatch', 'history_mismatch', 'toolchain_mismatch',
  'package_mismatch', 'profile_path', 'process_inspection', 'process_present', 'evidence_already_exists',
  'operation_failed', 'operation_timeout', 'work_deadline', 'exercise_stopped', 'budget_exceeded', 'metadata_mismatch',
  'response_size', 'response_schema', 'redirect', 'login_contract', 'session_contract', 'csrf_contract',
  'browser_startup', 'browser_process', 'context_count', 'readiness', 'browser_activity', 'browser_cleanup',
  'request_cleanup', 'proxy_cleanup', 'monitor_cleanup', 'profile_preservation', 'overall_deadline',
  'evidence_size', 'evidence_write', 'evidence_close']);

/** Keep errors categorical; arbitrary native messages and response data are never serialized. */
class DiagnosticError extends Error {
  /** Store only the fixed code supplied by a local guard. */
  constructor(code) { super(code); this.code = code; }
}

/** Require a local invariant without including the rejected value in its error. */
function check(ok, code) { if (!ok) throw new DiagnosticError(code); }

/** Map native and reused helper failures to the diagnostic's reviewed vocabulary. */
function errorCode(error) {
  return (error instanceof DiagnosticError || error instanceof fixture.IsolationError) && CODES.has(error.code)
    ? error.code : error?.name === 'TimeoutError' ? 'operation_timeout' : 'operation_failed';
}

/** Hash source or evidence bytes; never use this to persist account or cookie material. */
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/** Stream only explicitly named source/package/receipt files, without opening authentication storage. */
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Compare only named target fields, rejecting extra configuration that could conceal another destination. */
function sameTarget(value) {
  return value && Object.keys(value).length === Object.keys(TARGET).length
    && Object.keys(TARGET).every(key => value[key] === TARGET[key]);
}

/** Validate finite nonnegative ledger entries with sessions already included in application counts. */
function validCounts(value) {
  return value && Object.keys(value).sort().join(',') === 'application,session,static'
    && Object.values(value).every(n => Number.isSafeInteger(n) && n >= 0) && value.session <= value.application;
}

/** Add recorded increments without resetting any historical or preparation consumption. */
function addCounts(...values) {
  return Object.fromEntries(['application', 'static', 'session'].map(key => [key, values.reduce((sum, v) => sum + v[key], 0)]));
}

/** Require an exact ledger projection, including the one historical conservative reservation. */
function equalCounts(a, b) { return validCounts(a) && validCounts(b) && Object.keys(b).every(key => a[key] === b[key]); }

/** Validate the reviewed manifest and private expected identity before any receipt, profile or network activity. */
function validatePlan(plan, expectedUserId, now = Date.now()) {
  check(plan && plan.approval === APPROVAL, 'execution_not_approved');
  check(plan.readinessPolicy === POLICY, 'readiness_not_approved');
  check(sameTarget(plan.target), 'target_mismatch');
  check(typeof plan.buildId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(plan.buildId), 'build_missing');
  check(plan.profile === PROFILE && plan.profilePreparationApproved === true, 'profile_not_approved');
  check(typeof expectedUserId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(expectedUserId), 'account_missing');
  check(Number.isSafeInteger(plan.approvedAt) && Number.isSafeInteger(plan.expiresAt)
    && plan.approvedAt <= now && now < plan.expiresAt && plan.expiresAt - plan.approvedAt <= LIMITS.approvalWindowMs,
  'approval_expired');
  check(typeof plan.sourceSet === 'string' && /^[a-f0-9]{64}$/.test(plan.sourceSet), 'source_mismatch');
  for (const name of ['build-attribution.json', 'authentication-preparation.json']) {
    check(typeof plan.preparationHashes?.[name] === 'string' && /^[a-f0-9]{64}$/.test(plan.preparationHashes[name]), 'preparation_missing');
  }
  for (const kind of ['actual', 'conservative']) {
    const before = plan.ledgerBefore?.[kind]; const ceiling = plan.ledgerCeiling?.[kind];
    check(validCounts(before) && before.application >= BASELINE[kind].application + 1
      && before.static >= BASELINE[kind].static && before.session >= BASELINE[kind].session
      && equalCounts(ceiling, addCounts(before, { application: 3, static: 0, session: 1 })), 'ledger_mismatch');
  }
  check(['application', 'static', 'session'].every(key => plan.ledgerBefore.conservative[key] >= plan.ledgerBefore.actual[key]), 'ledger_mismatch');
  return plan;
}

/** Bind separately reviewed preparation receipts to target, build, profile and all counted preparation traffic. */
function validatePreparation(plan, build, auth) {
  check(build?.phase === 'passed' && sameTarget(build.target) && build.buildId === plan.buildId
    && equalCounts(build.requests, { application: 1, static: 0, session: 0 }), 'preparation_missing');
  check(auth?.phase === 'passed' && sameTarget(auth.target) && auth.buildId === plan.buildId
    && auth.profile === PROFILE && auth.identityVerified === true && auth.browserTrafficMeasured === true
    && auth.closedNormally === true && auth.independentProcessExitVerified === true, 'preparation_missing');
  for (const kind of ['actual', 'conservative']) {
    check(validCounts(auth.requests?.[kind])
      && equalCounts(plan.ledgerBefore[kind], addCounts(BASELINE[kind], build.requests, auth.requests[kind])), 'ledger_mismatch');
  }
}

/**
 * Check provider identity in memory; only categorical outcomes leave this boundary.
 * Omitted project pendingAlias is valid; alias/deployment records still establish assignment.
 */
function validateMetadata(kind, data) {
  let ok = false;
  if (kind === 'project') ok = data?.id === TARGET.project && data.accountId === TARGET.team
    && data.targets?.production?.id === TARGET.deployment && data.autoAssignCustomDomains === true
    && (!Object.hasOwn(data, 'pendingAlias') || data.pendingAlias === false);
  if (kind === 'alias') ok = data?.alias === TARGET.canonical && data.projectId === TARGET.project
    && data.deployment?.id === TARGET.deployment && (data.redirect === null || data.redirect === undefined);
  if (kind === 'deployment') ok = data?.id === TARGET.deployment && data.projectId === TARGET.project
    && data.url === TARGET.generated && data.target === 'production' && data.readyState === 'READY'
    && data.meta?.githubCommitSha === TARGET.source && data.gitSource?.sha === TARGET.source
    && data.aliasAssigned === true && Array.isArray(data.alias) && data.alias.includes(TARGET.canonical);
  check(ok, 'metadata_mismatch');
  return true;
}

/** Bound header input and preserve duplicates so ambiguous cache/cookie headers cannot silently pass. */
function headersOf(response) {
  check(Array.isArray(response.headers) && response.headers.length <= 256, 'response_schema');
  const headers = new Map(); let bytes = 0;
  for (const entry of response.headers) {
    check(typeof entry.name === 'string' && typeof entry.value === 'string', 'response_schema');
    bytes += Buffer.byteLength(entry.name) + Buffer.byteLength(entry.value);
    check(bytes <= LIMITS.headerBytes, 'response_size');
    const key = entry.name.toLowerCase(); const values = headers.get(key) || [];
    values.push(entry.value); headers.set(key, values);
  }
  return headers;
}

/** Return only an unambiguous header; missing/duplicate values fail their relevant contract checks. */
function single(headers, name) { const values = headers.get(name); return values?.length === 1 ? values[0] : null; }

/** Normalize directives without hiding duplicates, extra directives or conflicting cache instructions. */
function directives(value) { return typeof value === 'string' ? value.split(',').map(v => v.trim().toLowerCase().replace(/\s*=\s*/g, '=')).sort().join(',') : null; }

/** Project the protected-response cache contract into independent booleans, never raw header values. */
function protectedChecks(response, headers) {
  const cache = (single(headers, 'cache-control') || '').split(',').map(v => v.trim().toLowerCase());
  const overrideNames = ['cdn-cache-control', 'vercel-cdn-cache-control'];
  return { status: response.status === 200, contentType: /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(single(headers, 'content-type') || ''),
    privateNoStore: cache.includes('private') && cache.includes('no-store')
      && cache.every(v => ['private', 'no-store', 'no-cache', 'max-age=0', 'must-revalidate'].includes(v))
      && new Set(cache).size === cache.length,
    cacheOverrides: overrideNames.every(name => !headers.has(name) || directives(single(headers, name)) === 'no-store'),
    cacheStatus: ['MISS', 'BYPASS', 'REVALIDATED'].includes(single(headers, 'x-vercel-cache')?.toUpperCase()),
    age: !headers.has('age') || single(headers, 'age') === '0' };
}

/** Parse bounded JSON only in memory; invalid documents produce a fixed false envelope check. */
function jsonBody(body) { try { return JSON.parse(body.toString('utf8')); } catch { return null; } }

/** Validate the public login policy and exact build without applying authenticated no-store rules. */
function loginChecks(response, buildId) {
  const headers = headersOf(response); const status = single(headers, 'x-vercel-cache')?.toUpperCase();
  const age = single(headers, 'age');
  const scripts = [...response.body.toString('utf8').matchAll(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const data = scripts.length === 1 ? jsonBody(Buffer.from(scripts[0][1])) : null;
  return { status: response.status === 200,
    cachePolicy: directives(single(headers, 'cache-control')) === 'max-age=0,must-revalidate,public',
    cacheStatus: ['MISS', 'BYPASS', 'REVALIDATED', 'HIT'].includes(status),
    age: status === 'HIT' ? typeof age === 'string' && /^\d+$/.test(age) && Number.isSafeInteger(Number(age))
      : !headers.has('age') || age === '0',
    build: data?.buildId === buildId };
}

/** Compare session identity privately; no account field or hash is returned to evidence. */
function sessionChecks(response, expectedUserId) {
  const headers = headersOf(response); const body = jsonBody(response.body);
  return { ...protectedChecks(response, headers), envelope: body?.error === null && body.message === 'Success',
    identity: body?.data?.user?.id === expectedUserId };
}

/** Parse only the named CSRF cookie, retaining duplicate-attribute detection and no serialized token output. */
function csrfCookie(headers) {
  const matches = (headers.get('set-cookie') || []).filter(value => value.split('=', 1)[0].trim() === COOKIE);
  const parts = matches.length === 1 ? matches[0].split(';').map(v => v.trim()) : [];
  const value = parts[0]?.slice(COOKIE.length + 1); const attrs = new Map(); let duplicate = false;
  for (const part of parts.slice(1)) {
    const equals = part.indexOf('='); const key = (equals < 0 ? part : part.slice(0, equals)).toLowerCase();
    if (attrs.has(key)) duplicate = true;
    attrs.set(key, equals < 0 ? true : part.slice(equals + 1));
  }
  return { unique: matches.length === 1, value, attrs, duplicate };
}

/** Validate token shape and cookie delivery without the signing secret or any claim of HMAC verification. */
function csrfChecks(response, cookies, startedAt, completedAt) {
  const headers = headersOf(response); const body = jsonBody(response.body); const cookie = csrfCookie(headers);
  const token = /^([a-f0-9]{64})\.(\d{1,12})\.([a-f0-9]{64})$/.exec(cookie.value || '');
  const tokenMs = token ? Number(token[2]) * 1000 : NaN; const date = single(headers, 'date'); const serverMs = Date.parse(date);
  const stored = Array.isArray(cookies) ? cookies.filter(c => c.name === COOKIE) : [];
  const one = stored.length === 1 ? stored[0] : null;
  return { ...protectedChecks(response, headers), envelope: body?.data === null && body?.error === null
      && body?.message === 'CSRF token set' && Object.keys(body).sort().join(',') === 'data,error,message',
    cookieHeaderUnique: cookie.unique, cookieAttributesUnique: !cookie.duplicate,
    cookieSecure: cookie.attrs.get('secure') === true, cookieHttpOnly: !cookie.attrs.has('httponly'),
    cookieSameSite: typeof cookie.attrs.get('samesite') === 'string' && cookie.attrs.get('samesite').toLowerCase() === 'lax',
    cookiePath: cookie.attrs.get('path') === '/',
    cookieHostOnly: !cookie.attrs.has('domain'), cookieMaxAge: cookie.attrs.get('max-age') === String(MAX_AGE),
    cookieAttributesKnown: [...cookie.attrs.keys()].every(key => ['secure', 'samesite', 'path', 'max-age'].includes(key)),
    tokenShape: token !== null,
    tokenClock: tokenMs >= startedAt - LIMITS.clockSkewMs && tokenMs <= completedAt + LIMITS.clockSkewMs,
    serverClock: Number.isFinite(serverMs) && new Date(serverMs).toUTCString() === date
      && serverMs >= startedAt - LIMITS.clockSkewMs && serverMs <= completedAt + LIMITS.clockSkewMs,
    tokenServerClock: Math.abs(tokenMs - serverMs) <= LIMITS.tokenDateSkewMs,
    cookieWriteback: !!one && typeof cookie.value === 'string' && one.value === cookie.value,
    cookieBrowserAttributes: !!one && one.domain === TARGET.canonical && one.path === '/' && one.secure === true
      && one.httpOnly === false && one.sameSite === 'Lax' && one.partitionKey === undefined,
    cookieExpiry: !!one && Number.isFinite(one.expires) && one.expires >= startedAt / 1000 + MAX_AGE - LIMITS.expirySkewSeconds
      && one.expires <= completedAt / 1000 + MAX_AGE + LIMITS.expirySkewSeconds };
}

/** Bound all scripted work, preserve its first failure and charge incoming rejected proxy traffic during cleanup. */
class Budget {
  /** Start one clock before preflight and keep the final twenty seconds for normal cleanup and evidence. */
  constructor(clock = Date.now) {
    this.clock = clock; this.startedAt = clock(); this.workDeadline = this.startedAt + LIMITS.wholeMs - LIMITS.cleanupMs;
    this.halted = false; this.firstFailure = null;
    this.counts = { application: 0, static: 0, session: 0, metadata: 0, launches: 0, pages: 0, proxyConnections: 0 };
  }
  /** Reject continuation after failure, cleanup or expiry, including late promise completions. */
  check() { check(!this.firstFailure && !this.halted, 'exercise_stopped'); check(this.clock() < this.workDeadline, 'work_deadline'); }
  /** Reserve script actions before dispatch; proxy events remain counted and rejected after the stop latch. */
  count(kind) {
    if (kind === 'proxyConnections') {
      this.counts[kind]++;
      if (this.counts[kind] > LIMITS[kind]) this.stop(new DiagnosticError('budget_exceeded'), 'proxy');
      this.check(); return;
    }
    this.check();
    if (!Object.hasOwn(this.counts, kind) || this.counts[kind] >= LIMITS[kind]) {
      this.stop(new DiagnosticError('budget_exceeded'), 'budget'); throw new DiagnosticError('budget_exceeded');
    }
    this.counts[kind]++;
  }
  /** Retain only one fixed primary reason; cleanup failures have their own bounded list. */
  stop(error, stage) {
    this.firstFailure ||= { stage, code: errorCode(error), elapsedMs: Math.max(0, this.clock() - this.startedAt) };
  }
  /** Check both sides of asynchronous operations; their raw result cannot mutate evidence after expiry. */
  async step(action, milliseconds = LIMITS.operationMs) {
    this.check();
    const result = await fixture.bounded(() => { this.check(); return action(); },
      Math.max(1, Math.min(milliseconds, this.workDeadline - this.clock())));
    this.check(); return result;
  }
}

/** Enforce the owned blank keeper; restored workers are allowed only under this diagnostic's launch policy. */
function readiness(owner) {
  check(owner.child && owner.child.exitCode === null && !owner.failed && owner.browser.isConnected(), 'browser_process');
  check(owner.browser.version() === qualification.PIN.version, 'toolchain_mismatch');
  const pages = owner.context.pages();
  check(pages.length === 1 && pages[0] === owner.keeper && !owner.keeper.isClosed()
    && owner.keeper.url() === 'about:blank', 'readiness');
}

/** Observe additional pages and navigation without inspecting worker URLs, storage or protocol payloads. */
function monitor(owner, budget, monitors) {
  /** Unexpected page lifecycle activity stops later request-client dispatch. */
  function changed() { if (!budget.halted) budget.stop(new DiagnosticError('browser_activity'), 'browser'); }
  for (const [object, event] of [[owner.context, 'page'], [owner.keeper, 'framenavigated'], [owner.keeper, 'close']]) {
    object.on(event, changed); monitors.push({ object, event, listener: changed });
  }
}

/** Read only bounded plan/preparation JSON; profile authentication storage is never read from disk. */
async function readJson(file, maximum = LIMITS.planBytes) {
  const stat = await fs.lstat(file); check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, 'plan_schema');
  const bytes = await fs.readFile(file); check(bytes.length <= maximum, 'plan_schema');
  try { return { data: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), hash: digest(bytes) }; }
  catch { throw new DiagnosticError('plan_schema'); }
}

/** Bind execution to the nine reviewed source/document files, including the unchanged qualified dependency set. */
async function sourceHashes() {
  const files = {};
  for (const name of SOURCE_FILES) files[name] = await hashFile(path.join(__dirname, name));
  const qualified = Object.fromEntries(qualification.SOURCE_FILES.map(name => [name, files[name]]));
  check(digest(JSON.stringify(qualified)) === QUALIFIED_SOURCES, 'source_mismatch');
  return { files, set: digest(JSON.stringify(files)) };
}

/** Verify all fifteen historical receipts without rewriting the consumed qualification's fourteen-entry history. */
async function historyHashes() {
  const hashes = {};
  for (const name of Object.keys(HISTORY)) hashes[name] = await hashFile(path.join(ROOT, '.tmp/gate1-checkout-enable-dd2c2c6', name));
  check(Object.keys(HISTORY).every(name => hashes[name] === HISTORY[name]), 'history_mismatch');
  return hashes;
}

/** Execute a fixed CLI without a shell; bound output/time and discard native errors and stderr. */
function cli(file, args, milliseconds, maximum, env = process.env) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: milliseconds, maxBuffer: maximum, env }, (error, stdout) => {
      if (error) { reject(new DiagnosticError('operation_failed')); return; }
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); } catch { reject(new DiagnosticError('response_schema')); }
    });
  });
}

/** Count matching processes without printing command lines; an inspection error never means absence. */
async function inspectProcesses() {
  const executable = fixture.fixtureExecutable('cft158').replaceAll('/', '\\');
  const profile = PROFILE.replaceAll('/', '\\');
  const script = "$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process); "
    + `$b=@($p | Where-Object { ($_.Name -in @('chrome.exe','msedge.exe')) -and ($_.ExecutablePath -eq '${executable}' -or $_.CommandLine -like '*${profile}*') }); `
    + `$r=@($p | Where-Object { $_.Name -eq 'node.exe' -and $_.ProcessId -ne ${process.pid} -and $_.CommandLine -match '(hosted-csrf-diagnostic|full-isolation-qualification|page-lifecycle-diagnostic|request-client-isolation)\\.cjs' }); `
    + '@{browsers=$b.Count;runners=$r.Count} | ConvertTo-Json -Compress';
  let result;
  try { result = await cli('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 5000, 1024); }
  catch { throw new DiagnosticError('process_inspection'); }
  check(result.browsers === 0 && result.runners === 0, 'process_present');
}

/** Inspect paths and frozen inputs before reserving a receipt, importing Playwright or contacting the hosted target. */
async function preflight(plan) {
  check(path.resolve(__dirname) === path.resolve(DIRECTORY)
    && path.resolve(await fs.realpath(DIRECTORY)) === path.resolve(DIRECTORY), 'execution_directory');
  check(!process.env.DEBUG && !process.env.DEBUG_FILE && !process.env.PWDEBUG
    && !process.env.NODE_OPTIONS && !process.env.NODE_DEBUG, 'debug_logging_enabled');
  const stat = await fs.lstat(PROFILE);
  check(stat.isDirectory() && !stat.isSymbolicLink() && path.resolve(await fs.realpath(PROFILE)) === path.resolve(PROFILE), 'profile_path');
  const sources = await sourceHashes(); check(sources.set === plan.sourceSet, 'source_mismatch');
  const history = await historyHashes();
  const metadata = (await readJson(path.join(CORE, 'package.json'))).data;
  check(metadata.name === 'playwright-core', 'toolchain_mismatch');
  comparison.checkToolchain({ node: process.version, playwright: metadata.version,
    bundle: await hashFile(path.join(CORE, 'lib/coreBundle.js')),
    executable: await hashFile(fixture.fixtureExecutable('cft158')) }, 'cft158');
  const packageProvenance = await comparison.packageHashes(); comparison.checkPackage(packageProvenance);
  const vercelPackage = (await readJson(path.join(path.dirname(VERCEL), '../package.json'))).data;
  check(vercelPackage.name === 'vercel' && vercelPackage.version === '62.2.0', 'toolchain_mismatch');
  for (const [name, expected] of Object.entries(VERCEL_HASHES)) {
    check(await hashFile(path.join(path.dirname(VERCEL), name)) === expected, 'toolchain_mismatch');
  }
  const build = await readJson(path.join(DIRECTORY, 'build-attribution.json'));
  const auth = await readJson(path.join(DIRECTORY, 'authentication-preparation.json'));
  check(build.hash === plan.preparationHashes['build-attribution.json']
    && auth.hash === plan.preparationHashes['authentication-preparation.json'], 'preparation_missing');
  validatePreparation(plan, build.data, auth.data); await inspectProcesses();
  return { sources, history, packageProvenance };
}

/** Consume the fixed output exclusively; a late open is closed but never deleted or reused. */
async function reserveEvidence() {
  let expired = false;
  const pending = fs.open(RESULT, 'wx').then(async handle => {
    if (expired) { await handle.close(); throw new DiagnosticError('operation_timeout'); }
    return handle;
  });
  try { return await fixture.bounded(() => pending, LIMITS.operationMs); }
  catch (error) { expired = true; throw new DiagnosticError(error.code === 'EEXIST' ? 'evidence_already_exists' : 'operation_failed'); }
}

/**
 * Narrow the pinned CLI client before its entry point loads. CLI-owned authentication stays private;
 * expired credentials stop instead of refreshing. Only one exact GET may reach the API client.
 */
function guardMetadataClient(Client, validAccessToken, expected) {
  const original = Client.prototype.fetch; let consumed = false;
  /** Refuse implicit refresh; this examines the CLI's own in-memory authentication validity only. */
  Client.prototype.ensureAuthorized = async function ensureExistingAuthorization() {
    if (!validAccessToken(this.authConfig)) throw new Error('metadata_auth_unavailable');
  };
  /** Refuse a SAML response's otherwise implicit reauthentication path. */
  Client.prototype.reauthenticate = async function noReauthentication() { throw new Error('metadata_auth_unavailable'); };
  /** Restrict destination, method and dispatch count and override built-in redirect/retry defaults. */
  Client.prototype.fetch = function singleMetadataFetch(url, options = {}) {
    if (consumed || url !== expected || this.apiUrl !== 'https://api.vercel.com'
      || options.method !== 'GET' || options.body !== undefined) throw new Error('metadata_dispatch_refused');
    consumed = true;
    return original.call(this, url, { ...options, useCurrentTeam: false, accountId: undefined,
      retry: { retries: 0 }, redirect: 'manual', bailOn429: true, signal: AbortSignal.timeout(29000) });
  };
}

/** Produce a fixed in-memory preload, importing only the hash-pinned CLI client, never a user-supplied module. */
function metadataArguments(kind) {
  const routes = { project: `/v9/projects/${TARGET.project}`, alias: `/v4/aliases/${TARGET.canonical}`,
    deployment: `/v13/deployments/${TARGET.deployment}` };
  check(Object.hasOwn(routes, kind), 'metadata_mismatch');
  const endpoint = `${routes[kind]}?teamId=${TARGET.team}`;
  const preload = `import { Client, isValidAccessToken } from ${JSON.stringify(pathToFileURL(VERCEL_CLIENT).href)};\n`
    + `(${guardMetadataClient.toString()})(Client, isValidAccessToken, ${JSON.stringify(endpoint)});`;
  return ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, VERCEL,
    'api', endpoint, '--method', 'GET', '--raw', '--non-interactive'];
}

/** Force the guarded JavaScript path for one metadata GET; the pinned parser rejects the launcher's opt-out flag. */
async function metadata(kind) {
  return cli(process.execPath, metadataArguments(kind),
    LIMITS.metadataMs, LIMITS.metadataBytes, { ...process.env, VERCEL_CLI_USE_NATIVE_BINARY: '0',
      VERCEL_TELEMETRY_DISABLED: '1', NO_UPDATE_NOTIFIER: '1' });
}

/** Preserve the qualified launch arguments while enforcing a separate, exact owned authenticated-profile path. */
function launchArguments(profile, port) {
  check(profile === PROFILE, 'profile_path');
  return [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1', '--disable-background-networking', '--disable-quic', '--no-startup-window',
    ...fixture.isolationArguments(port, null)];
}

/** Launch only the separately prepared profile; register ownership before polling or attachment can fail. */
async function launch({ runtime, proxy, budget, owners }) {
  check(path.resolve(await fs.realpath(PROFILE)) === path.resolve(PROFILE), 'profile_path'); budget.check();
  budget.count('launches');
  const owner = { child: null, browser: null, context: null, keeper: null, port: null, failed: false, closed: false,
    profile: PROFILE, launchTime: Date.now() }; owners.push(owner);
  owner.child = spawn(fixture.fixtureExecutable('cft158'), launchArguments(PROFILE, proxy.port), { stdio: 'ignore', windowsHide: true,
    env: { ...process.env, TEMP: path.join(ROOT, '.tmp'), TMP: path.join(ROOT, '.tmp') } });
  owner.child.once('error', () => { owner.failed = true; budget.stop(new DiagnosticError('browser_process'), 'browser'); });
  const deadline = Math.min(budget.workDeadline, owner.launchTime + LIMITS.startupMs);
  while (!owner.port && Date.now() < deadline) {
    budget.check(); check(!owner.failed && owner.child.exitCode === null, 'browser_process');
    try {
      const file = path.join(PROFILE, 'DevToolsActivePort'); const stat = await fs.stat(file);
      if (stat.mtimeMs >= owner.launchTime && stat.size <= 1024) {
        const port = Number((await fs.readFile(file, 'utf8')).split(/\r?\n/)[0]);
        if (Number.isInteger(port) && port > 0 && port < 65536) owner.port = port;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw new DiagnosticError('browser_startup'); }
    if (!owner.port) await new Promise(resolve => setTimeout(resolve, 50));
  }
  check(owner.port && Date.now() < deadline, 'browser_startup'); budget.check();
  owner.browser = await runtime.chromium.connectOverCDP(`http://127.0.0.1:${owner.port}`,
    { noDefaults: true, timeout: Math.max(1, Math.min(5000, deadline - Date.now())) }); budget.check();
  const contexts = owner.browser.contexts(); check(contexts.length === 1, 'context_count'); owner.context = contexts[0];
  const pages = owner.context.pages(); check(pages.length <= 1 && pages.every(page => page.url() === 'about:blank'), 'readiness');
  budget.count('pages'); owner.keeper = pages[0] || await owner.context.newPage(); budget.check();
  readiness(owner); return owner;
}

/** Make one context-bound GET with no retry/redirect; dispose response bytes even on failed validation or timeout. */
async function request(owner, endpoint, budget) {
  check(ENDPOINTS.includes(endpoint), 'response_schema'); budget.check();
  const cap = endpoint === '/login' ? LIMITS.loginBytes : LIMITS.jsonBytes;
  let response;
  try {
    response = await owner.context.request.get(ORIGIN + endpoint, { timeout: LIMITS.operationMs, maxRedirects: 0, maxRetries: 0,
      failOnStatusCode: false, headers: { 'Cache-Control': 'no-cache, no-store, max-age=0', Pragma: 'no-cache' } });
    budget.check(); check(response.url() === ORIGIN + endpoint, 'redirect');
    const status = response.status(); check(status < 300 || status >= 400, 'redirect');
    const headers = response.headersArray(); const mapped = headersOf({ headers }); const length = single(mapped, 'content-length');
    check(!mapped.has('content-length') || (typeof length === 'string' && /^\d+$/.test(length) && Number(length) <= cap), 'response_size');
    const body = await response.body(); budget.check(); check(body.length <= cap, 'response_size');
    return { status, headers, body };
  } finally { if (response) await fixture.bounded(() => response.dispose(), 1000); }
}

/** Assemble native boundaries lazily; importing or unit-testing validators never initializes Playwright. */
function nativeDependencies() {
  return { preflight, reserve: reserveEvidence, runtime: () => require(CORE), metadata, launch, request,
    proxy: (budget, servers) => fixture.startRejectingProxy(budget, ORIGIN, servers),
    cookies: owner => owner.context.cookies(ORIGIN + '/'),
    closeBrowser: fixture.closeOwned, closeProxy: fixture.closeServer,
    cancelRequests: owner => owner.context?.request.dispose(), sources: sourceHashes, history: historyHashes,
    profileExists: () => fs.lstat(PROFILE).then(stat => stat.isDirectory() && !stat.isSymbolicLink(), () => false) };
}

/** Serialize only locally constructed evidence; a size overflow cannot become a successful diagnostic. */
function encodeEvidence(record) {
  const text = JSON.stringify(record, null, 2) + '\n'; check(Buffer.byteLength(text) <= LIMITS.evidenceBytes, 'evidence_size'); return text;
}

/** Spend only remaining cleanup time; never extend the whole-run ceiling or kill a browser. */
async function cleanupStep(action, deadline, maximum) {
  const remaining = Math.min(maximum, deadline - Date.now()); check(remaining > 0, 'overall_deadline');
  return fixture.bounded(action, remaining);
}

/** Run exactly the reviewed three-request sequence with fixed metadata checks and fail-closed normal cleanup. */
async function runDiagnostic(input, expectedUserId, deps = nativeDependencies()) {
  // Snapshot reviewed configuration so a caller cannot change destinations/budgets during an await.
  const plan = structuredClone(input); const budget = new Budget(); validatePlan(plan, expectedUserId, budget.startedAt);
  const inputs = await budget.step(() => deps.preflight(plan), LIMITS.preflightMs);
  let destination; let reservationExpired = false;
  try {
    destination = await budget.step(async () => {
      const handle = await deps.reserve();
      if (reservationExpired) { await handle.close(); throw new DiagnosticError('operation_timeout'); }
      destination = handle; return handle;
    });
  } catch (error) {
    reservationExpired = true;
    if (destination) await fixture.bounded(() => destination.close(), 1000);
    throw error;
  }
  const owners = []; const servers = []; const monitors = [];
  const record = { schemaVersion: 1, scope: 'hosted_csrf_request_client_only', phase: 'running', gate1Status: 'open',
    operator: 'Codex agent', operationalOwner: 'Project owner', approvalConsumed: true, hostedQualified: false,
    independentProcessExitVerified: false, target: TARGET, buildId: plan.buildId, readinessPolicy: POLICY,
    startedAt: new Date(budget.startedAt).toISOString(), limits: LIMITS, sourceSet: plan.sourceSet,
    priorEvidenceHashes: { ...HISTORY }, preparationHashes: Object.fromEntries(
      ['build-attribution.json', 'authentication-preparation.json'].map(name => [name, plan.preparationHashes[name]])),
    packageProvenance: { ...qualification.PIN }, checks: {}, metadata: [], cleanupFailures: [],
    historicalBackgroundTrafficMeasured: false };
  let runtime; let finalizationError; let stage = 'setup';
  try {
    check(inputs.sources.set === plan.sourceSet && Object.keys(HISTORY).every(name => inputs.history[name] === HISTORY[name]), 'source_mismatch');
    for (const kind of ['project', 'alias', 'deployment']) {
      validatePlan(plan, expectedUserId);
      budget.count('metadata'); const data = await budget.step(() => deps.metadata(kind), LIMITS.metadataMs);
      validateMetadata(kind, data); record.metadata.push({ phase: 'before', kind, matches: true });
    }
    runtime = deps.runtime(); budget.check();
    const proxy = await budget.step(() => deps.proxy(budget, servers));
    const owner = await budget.step(() => deps.launch({ runtime, proxy, budget, owners }), LIMITS.startupMs);
    readiness(owner); monitor(owner, budget, monitors); stage = 'cases';
    for (const endpoint of ENDPOINTS) {
      readiness(owner); budget.check(); validatePlan(plan, expectedUserId);
      const startedAt = Date.now(); budget.count('application'); if (endpoint === '/api/auth/session') budget.count('session');
      const checks = await budget.step(async () => {
        const response = await deps.request(owner, endpoint, budget); budget.check();
        check(Buffer.isBuffer(response.body) && response.body.length <= (endpoint === '/login' ? LIMITS.loginBytes : LIMITS.jsonBytes), 'response_size');
        if (endpoint === '/login') return loginChecks(response, plan.buildId);
        if (endpoint === '/api/auth/session') return sessionChecks(response, expectedUserId);
        const cookies = await deps.cookies(owner); budget.check(); return csrfChecks(response, cookies, startedAt, Date.now());
      });
      const name = endpoint === '/login' ? 'login' : endpoint.endsWith('session') ? 'session' : 'csrf';
      record.checks[name] = checks; check(Object.values(checks).every(value => value === true), name + '_contract');
      readiness(owner);
    }
    stage = 'metadata_after';
    for (const kind of ['project', 'alias', 'deployment']) {
      validatePlan(plan, expectedUserId);
      budget.count('metadata'); const data = await budget.step(() => deps.metadata(kind), LIMITS.metadataMs);
      validateMetadata(kind, data); record.metadata.push({ phase: 'after', kind, matches: true });
    }
    readiness(owner); budget.check(); record.phase = 'passed';
  } catch (error) { budget.stop(error, stage); record.phase = 'stopped'; }
  finally {
    budget.halted = true;
    const deadline = Math.min(budget.startedAt + LIMITS.wholeMs, Date.now() + LIMITS.cleanupMs);
    /** Keep cleanup errors separate while preserving the original cause and normal resource ownership. */
    function failed(code) { record.cleanupFailures.push(code); budget.stop(new DiagnosticError(code), 'cleanup'); }
    for (const owner of owners) {
      try { await cleanupStep(() => deps.cancelRequests(owner), deadline - 18000, 1000); } catch { failed('request_cleanup'); }
      try {
        if (!await cleanupStep(() => deps.closeBrowser(owner, runtime, deadline - 6000), deadline - 6000, 11000)
          || owner.closed !== true) failed('browser_cleanup');
      }
      catch { failed('browser_cleanup'); }
    }
    for (const server of servers) {
      try { await cleanupStep(() => deps.closeProxy(server), deadline - 4000, 2000); } catch { failed('proxy_cleanup'); }
    }
    for (const item of monitors) {
      try { item.object.removeListener(item.event, item.listener); } catch { failed('monitor_cleanup'); }
    }
    try { record.profilePreserved = await cleanupStep(() => deps.profileExists(), deadline - 1000, 1000) === true; }
    catch { record.profilePreserved = false; }
    if (!record.profilePreserved) failed('profile_preservation');
    try {
      const history = await cleanupStep(() => deps.history(), deadline - 1000, 1000);
      record.historyUnchanged = Object.keys(HISTORY).every(name => history[name] === HISTORY[name]);
    } catch { record.historyUnchanged = false; }
    if (!record.historyUnchanged) failed('history_mismatch');
    try { record.sourcesUnchanged = (await cleanupStep(() => deps.sources(), deadline - 1000, 1000)).set === plan.sourceSet; }
    catch { record.sourcesUnchanged = false; }
    if (!record.sourcesUnchanged) failed('source_mismatch');
    record.counts = { ...budget.counts };
    record.ledgerBefore = Object.fromEntries(['actual', 'conservative'].map(kind => [kind, { ...plan.ledgerBefore[kind] }]));
    record.ledgerCeiling = Object.fromEntries(['actual', 'conservative'].map(kind => [kind, { ...plan.ledgerCeiling[kind] }]));
    const increments = { application: budget.counts.application, static: 0, session: budget.counts.session };
    record.ledgerAfter = Object.fromEntries(['actual', 'conservative'].map(kind => [kind, addCounts(plan.ledgerBefore[kind], increments)]));
    record.completedAt = new Date().toISOString(); record.elapsedMs = Date.now() - budget.startedAt;
    if (record.elapsedMs >= LIMITS.wholeMs) failed('overall_deadline');
    record.firstFailure = budget.firstFailure; if (record.firstFailure) record.phase = 'stopped';
    record.ownedBrowsersClosedNormally = owners.every(owner => owner.closed === true);
    record.diagnosticChecksPassed = record.phase === 'passed';
    try { await cleanupStep(() => destination.writeFile(encodeEvidence(record)), deadline, 1000); }
    catch (error) { finalizationError = new DiagnosticError(errorCode(error) === 'evidence_size' ? 'evidence_size' : 'evidence_write'); }
    finally {
      try { await cleanupStep(() => destination.close(), deadline, 1000); }
      catch { finalizationError ||= new DiagnosticError('evidence_close'); }
    }
  }
  if (finalizationError) throw finalizationError;
  return record;
}

/** Accept only a separately frozen manifest in the fixed execution directory; preparation supplies no live manifest. */
async function main(args) {
  check(args.length === 1 && args[0] === '--execute-reviewed-manifest', 'arguments');
  check(path.resolve(__dirname) === path.resolve(DIRECTORY), 'execution_directory');
  const { data: plan } = await readJson(path.join(DIRECTORY, 'execution-plan.json'));
  const record = await runDiagnostic(plan, process.env.GATE1_APPROVED_USER_ID);
  process.stdout.write(JSON.stringify({ phase: record.phase, firstFailure: record.firstFailure,
    diagnosticChecksPassed: record.diagnosticChecksPassed, gate1Status: 'open' }) + '\n');
  if (record.phase !== 'passed') process.exitCode = 1;
}

module.exports = { TARGET, ORIGIN, DIRECTORY, PROFILE, RESULT, SOURCE_FILES, HISTORY, BASELINE, LIMITS, APPROVAL, POLICY, VERCEL_HASHES,
  DiagnosticError, Budget, errorCode, digest, addCounts, validatePlan, validatePreparation, validateMetadata,
  headersOf, loginChecks, sessionChecks, csrfChecks, readiness, monitor, readJson, sourceHashes, historyHashes,
  preflight, reserveEvidence, guardMetadataClient, metadataArguments, launchArguments, launch, request, nativeDependencies, encodeEvidence, runDiagnostic, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(JSON.stringify({ stopCode: errorCode(error) }) + '\n'); process.exitCode = 1;
});
