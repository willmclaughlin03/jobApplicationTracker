'use strict';
/* global __dirname, Buffer, process */

/** One fixed, separately approved local Chrome qualification; importing this module is inert. */
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const fixture = require('./request-client-isolation.cjs');
const diagnostic = require('./page-lifecycle-diagnostic.cjs');
const { IsolationError, FixtureBudget, WorkerDiagnostics, bounded } = fixture;
const ROOT = 'C:/Users/willm/job-application-tracker';
const CORE = 'C:/Users/willm/AppData/Local/npm-cache/_npx/a5b920f00216d246/node_modules/playwright-core';
const DIRECTORY = path.join(ROOT, '.tmp/gate1-isolation-cft158-01');
const RECEIPTS = path.join(ROOT, '.tmp/gate1-checkout-enable-dd2c2c6');
const RESULT = path.join(RECEIPTS, 'browser-isolation-fixture-cft158-01.json');
const PROFILE_PREFIX = 'isolation-fixture-cft158-01-';
const PIN = diagnostic.COMPARISON_PIN;
const HISTORY = Object.freeze({ ...diagnostic.COMPARISON_02_HISTORY,
  'browser-page-lifecycle-comparison-cft158-02.json': '96eb4d6d7df5cb895aa1833958fc7dd3d90f8c1095aee6030b7801d383f0983a' });
const SOURCE_FILES = Object.freeze([...diagnostic.SOURCE_FILES,
  'full-isolation-qualification.cjs', '__tests__/full-isolation-qualification.test.cjs']);
const LIMITS = Object.freeze({ wholeMs: 900000, cleanupReserveMs: 20000, preflightMs: 60000,
  operationMs: 5000, startupMs: 10000, detachMs: 2000, browserCleanupMs: 11000,
  launches: 2, fixtureRequests: 100, proxyConnections: 200, navigations: 3, requestClientCalls: 2,
  workerProbes: 2, pagesCreated: 3, simultaneousPages: 2, versionReads: 2, evidenceBytes: 131072 });
const CODES = new Set(['argument_required', 'execution_directory', 'debug_logging_enabled', 'toolchain_mismatch',
  'source_mismatch', 'history_mismatch', 'package_mismatch', 'evidence_already_exists', 'evidence_size_limit',
  'operation_failed', 'operation_timeout', 'fixture_deadline', 'exercise_stopped', 'browser_selection',
  'launches_budget', 'fixtureRequests_budget', 'proxyConnections_budget', 'navigations_budget', 'requestClientCalls_budget',
  'workerProbes_budget', 'pagesCreated_budget', 'versionReads_budget', 'simultaneous_pages',
  'synthetic_profile_required', 'browser_startup', 'browser_process', 'context_count', 'unexpected_initial_page',
  'keeper_timeout', 'debug_port_read', 'synthetic_cookie_not_fresh', 'worker_install_timeout', 'worker_baseline',
  'first_browser_close', 'cookie_not_persistent', 'request_cookie_writeback', 'cookie_metadata_timeout',
  'fixture_request_status', 'fixture_response', 'fixture_worker_unavailable', 'worker_probe_timeout',
  'worker_evaluation_failed', 'worker_probe_result', 'probe_page_create_timeout', 'probe_page_state',
  'page_probe_timeout', 'page_not_proxy_blocked', 'page_network_isolation', 'https_not_proxy_blocked', 'https_network_isolation',
  'probe_page_close_timeout', 'probe_page_not_closed', 'control_page_not_ready', 'worker_session_timeout',
  'worker_restart_timeout', 'worker_not_proxy_blocked', 'worker_network_isolation', 'browser_cleanup',
  'session_cleanup', 'server_cleanup', 'page_monitor_cleanup', 'profile_preservation', 'overall_deadline', 'evidence_write', 'evidence_close']);
const STAGES = new Set(['setup', 'cases', 'cleanup', 'preservation']);

/** Fail with a fixed reviewed code; raw native errors never enter retained evidence. */
function check(condition, code) { if (!condition) throw new IsolationError(code); }

/** Normalize only approved errors, discarding arbitrary messages, properties and stacks. */
function errorCode(error) {
  if (error instanceof IsolationError && CODES.has(error.code)) return error.code;
  return error?.name === 'TimeoutError' ? 'operation_timeout' : 'operation_failed';
}

/** Hash synthetic labels or ordered manifests without retaining identifying input bytes. */
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/** Stream explicitly named source/package/receipt files only; profile storage is never opened. */
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Hash every runtime/test dependency, including unchanged validators, in a fixed order. */
async function sourceHashes(readHash = hashFile) {
  const files = {};
  for (const name of SOURCE_FILES) files[name] = await readHash(path.join(__dirname, name));
  return { files, set: digest(JSON.stringify(files)) };
}

/** Read exactly the fourteen consumed predecessors; the new output is never its own history. */
async function historyHashes(readHash = hashFile) {
  const hashes = {};
  for (const name of Object.keys(HISTORY)) hashes[name] = await readHash(path.join(RECEIPTS, name));
  return hashes;
}

/** Reject missing, modified and additional manifest entries before or after native work. */
function historyMatches(hashes) { return JSON.stringify(hashes) === JSON.stringify(HISTORY); }

/** Check the fixed execution location, exact package/toolchain and immutable inputs without native initialization. */
async function preflight(expectedSourceSet) {
  check(typeof expectedSourceSet === 'string' && /^[a-f0-9]{64}$/.test(expectedSourceSet), 'argument_required');
  check(path.resolve(__dirname) === path.resolve(DIRECTORY)
    && path.resolve(await fs.realpath(DIRECTORY)) === path.resolve(DIRECTORY), 'execution_directory');
  check(!process.env.DEBUG && !process.env.DEBUG_FILE && !process.env.PWDEBUG, 'debug_logging_enabled');
  const metadata = JSON.parse(await fs.readFile(path.join(CORE, 'package.json'), 'utf8'));
  check(metadata.name === 'playwright-core' && metadata.version === PIN.playwright, 'toolchain_mismatch');
  diagnostic.checkToolchain({ node: process.version, playwright: metadata.version,
    bundle: await hashFile(path.join(CORE, 'lib/coreBundle.js')),
    executable: await hashFile(fixture.fixtureExecutable('cft158')) }, 'cft158');
  const packageProvenance = await diagnostic.packageHashes(); diagnostic.checkPackage(packageProvenance);
  const sources = await sourceHashes(); check(sources.set === expectedSourceSet, 'source_mismatch');
  const history = await historyHashes(); check(historyMatches(history), 'history_mismatch');
  return { sources, history, packageProvenance };
}

/** Exclusively consume this invocation before loading Playwright; a late reservation is closed and remains consumed. */
async function reserveEvidence() {
  let expired = false;
  const pending = fs.open(RESULT, 'wx').then(async handle => {
    if (expired) { await handle.close(); throw new IsolationError('operation_timeout'); }
    return handle;
  });
  try { return await bounded(() => pending, LIMITS.operationMs); }
  catch (error) { expired = true; if (error.code === 'EEXIST') throw new IsolationError('evidence_already_exists'); throw error; }
}

/** Latch the first stop, cap scripted actions and count incoming traffic through normal cleanup. */
class QualificationBudget extends FixtureBudget {
  /** Include preflight in the overall clock and reserve the final twenty seconds from case work. */
  constructor(clock = Date.now) {
    super({ ...LIMITS, wholeMs: LIMITS.wholeMs - LIMITS.cleanupReserveMs }, clock);
    this.workDeadline = this.startedAt + this.limits.wholeMs; this.halted = false; this.firstFailure = null;
    Object.assign(this.counts, { navigations: 0, requestClientCalls: 0, workerProbes: 0, pagesCreated: 0, versionReads: 0 });
  }
  /** Late continuations cannot start work, even when all cases completed before cleanup. */
  check() { check(!this.halted, 'exercise_stopped'); super.check(); }
  /** Reject excess scripted calls before dispatch; incoming excess events remain counted and rejected. */
  count(kind) {
    if (!['fixtureRequests', 'proxyConnections'].includes(kind)) return super.count(kind);
    this.counts[kind]++;
    if (this.counts[kind] > this.limits[kind]) this.failure ||= kind + '_budget';
    this.check();
  }
  /** Preserve first-cause attribution independently of later cleanup or integrity failures. */
  stop(error, stage) {
    const code = CODES.has(this.failure) ? this.failure : errorCode(error);
    this.failure ||= code;
    this.firstFailure ||= Object.freeze({ stage: STAGES.has(stage) ? stage : 'setup', code,
      elapsedMs: Math.max(0, this.clock() - this.startedAt) });
  }
}

/** Enforce page ownership snapshots; no unexpected page is accepted as a probe or keeper. */
function checkPages(owner) { check(owner.context.pages().length <= LIMITS.simultaneousPages, 'simultaneous_pages'); }

/** Keep native dependencies lazy and fixed; overrides exist only for mocked orchestration tests. */
function nativeDependencies() {
  return { preflight, reserve: reserveEvidence, runtime: () => require(CORE),
    profile: () => fs.mkdtemp(path.join(DIRECTORY, PROFILE_PREFIX)),
    profileExists: profile => fs.stat(profile).then(stat => stat.isDirectory(), () => false),
    history: historyHashes, sources: sourceHashes, startFixture: fixture.startFixtureServer, startProxy: fixture.startRejectingProxy,
    launch: args => fixture.launchFixtureBrowser({ ...args, browser: 'cft158' }),
    request: fixture.requestFixture, pageProbe: fixture.pageProbe, closeBrowser: fixture.closeOwned, closeServer: fixture.closeServer };
}

/** Retain one bounded record; overflow stops qualification and falls back to fixed minimal failure evidence. */
function encodeEvidence(record, budget) {
  let text = JSON.stringify(record, null, 2) + '\n';
  if (Buffer.byteLength(text) <= LIMITS.evidenceBytes) return text;
  budget.stop(new IsolationError('evidence_size_limit'), 'preservation');
  record.phase = 'stopped'; record.localChecksPassed = false; record.isolationQualified = false; record.firstFailure = budget.firstFailure;
  text = JSON.stringify({ schemaVersion: 1, phase: 'stopped', isolationQualified: false, gate1Status: 'open',
    firstFailure: record.firstFailure, evidenceTruncated: true, approvalConsumed: true }) + '\n';
  return text;
}

/** Spend only a phase's remaining cleanup allocation; never queue a new action after its cutoff. */
async function cleanupStep(action, deadline, maximum) {
  const remaining = Math.min(maximum, deadline - Date.now());
  check(remaining > 0, 'overall_deadline');
  return bounded(() => { check(Date.now() < deadline, 'overall_deadline'); return action(); }, remaining, 'overall_deadline');
}

/**
 * Run the fixed two-launch sequence once, preserving first failure and all owned resources for normal cleanup.
 * A receipt is a target-bound local result; independent process inspection still gates operational acceptance.
 */
async function runQualification(expectedSourceSet, deps = nativeDependencies()) {
  const budget = new QualificationBudget();
  check(typeof expectedSourceSet === 'string' && /^[a-f0-9]{64}$/.test(expectedSourceSet), 'argument_required');
  const inputs = await bounded(() => deps.preflight(expectedSourceSet), LIMITS.preflightMs); budget.check();
  const destination = await deps.reserve();
  const owners = []; const servers = []; const sessions = []; const monitors = [];
  const record = { schemaVersion: 1, scope: 'synthetic_loopback_only', mode: 'fixture-cft158-01', phase: 'running',
    operator: 'Codex agent', operationalOwner: 'Project owner', approvalConsumed: true,
    gate1Status: 'open', isolationQualified: false, hostedExerciseAuthorized: false, liveGuardChanged: false,
    startedAt: new Date(budget.startedAt).toISOString(), limits: LIMITS, toolchain: PIN,
    sourceHashes: inputs.sources, priorEvidenceHashes: inputs.history, packageProvenance: inputs.packageProvenance,
    checks: {}, workerProbes: {}, restoredWorkerFailure: null, cleanupFailures: [] };
  const workerDiagnostics = new WorkerDiagnostics(record, budget);
  let runtime; let profile; let local; let proxy; let finalizationError; let stage = 'setup';
  try {
    await bounded(async () => {
      budget.check(); runtime = deps.runtime(); budget.check();
      profile = await deps.profile(); budget.check(); record.syntheticProfileNameHash = digest(path.basename(profile));
      local = await bounded(() => deps.startFixture(budget, servers), LIMITS.operationMs); budget.check();
      proxy = await bounded(() => deps.startProxy(budget, local.origin, servers), LIMITS.operationMs); budget.check();
      stage = 'cases';
      await fixture.runFixtureCases({ runtime, profile, fixture: local, proxy, budget, owners, record, workerDiagnostics, sessions }, {
        ...deps, checkPages,
        /** Verify each cached browser version and observe extra pages before any qualification case can proceed. */
        launch: async args => {
          budget.check(); budget.count('pagesCreated');
          const owner = await deps.launch({ ...args, browser: 'cft158' }); budget.check();
          budget.count('versionReads'); check(owner.browser.version() === PIN.version, 'toolchain_mismatch');
          checkPages(owner);
          /** Latch unexpected page growth without throwing into the browser event dispatcher. */
          function onPage() { try { checkPages(owner); } catch (error) { budget.stop(error, 'cases'); } }
          owner.context.on('page', onPage); monitors.push({ context: owner.context, listener: onPage });
          return owner;
        },
        closeBrowser: (owner, activeRuntime) => deps.closeBrowser(owner, activeRuntime,
          Math.min(budget.workDeadline, Date.now() + LIMITS.browserCleanupMs)),
      });
      budget.check(); record.phase = 'passed';
    }, Math.max(1, budget.workDeadline - Date.now()), 'fixture_deadline');
  } catch (error) { workerDiagnostics.stop(error); budget.stop(error, stage); record.phase = 'stopped'; }
  finally {
    budget.halted = true;
    const deadline = Math.min(budget.startedAt + LIMITS.wholeMs, Date.now() + LIMITS.cleanupReserveMs);
    /** Record each bounded cleanup failure while preserving the original case failure. */
    function failed(code) { record.cleanupFailures.push(code); budget.stop(new IsolationError(code), 'cleanup'); }
    for (const session of sessions) {
      try { await cleanupStep(() => session.detach(), deadline - 18000, LIMITS.detachMs); }
      catch { failed('session_cleanup'); }
    }
    record.ownedBrowsersClosedNormally = true;
    for (const owner of owners) {
      try {
        if (owner.closed || await cleanupStep(() => deps.closeBrowser(owner, runtime, deadline - 7000),
          deadline - 7000, LIMITS.browserCleanupMs)) continue;
      } catch { /* Continue normal cleanup of the remaining owned resources. */ }
      record.ownedBrowsersClosedNormally = false; failed('browser_cleanup');
    }
    for (const resource of servers.reverse()) {
      try { await cleanupStep(() => deps.closeServer(resource), deadline - 3000, 2000); }
      catch { failed('server_cleanup'); }
    }
    for (const monitor of monitors) {
      try { monitor.context.removeListener('page', monitor.listener); } catch { failed('page_monitor_cleanup'); }
    }
    try {
      record.syntheticProfilePreserved = !!profile && await cleanupStep(() => deps.profileExists(profile), deadline - 1000, 2000);
      if (!record.syntheticProfilePreserved) failed('profile_preservation');
    } catch { record.syntheticProfilePreserved = false; failed('profile_preservation'); }
    try {
      record.priorEvidenceUnchanged = historyMatches(await cleanupStep(() => deps.history(), deadline - 1000, 2000));
      if (!record.priorEvidenceUnchanged) failed('history_mismatch');
    } catch { record.priorEvidenceUnchanged = false; failed('history_mismatch'); }
    try {
      record.sourceSetUnchanged = (await cleanupStep(() => deps.sources(), deadline - 1000, 2000)).set === expectedSourceSet;
      if (!record.sourceSetUnchanged) failed('source_mismatch');
    } catch { record.sourceSetUnchanged = false; failed('source_mismatch'); }
    if (budget.failure && !budget.firstFailure) budget.stop(new IsolationError(budget.failure), 'cleanup');
    record.completedAt = new Date().toISOString(); record.elapsedMs = Date.now() - budget.startedAt;
    record.withinOverallLimit = record.elapsedMs < LIMITS.wholeMs;
    if (!record.withinOverallLimit) budget.stop(new IsolationError('overall_deadline'), 'cleanup');
    record.firstFailure = budget.firstFailure; record.counts = { ...budget.counts };
    record.proxyProbeCounts = proxy ? { ...proxy.counts } : null; record.fixtureProbeCounts = local ? { ...local.counts } : null;
    record.phase = !record.firstFailure && record.phase === 'passed' ? 'passed' : 'stopped';
    record.localChecksPassed = record.phase === 'passed';
    record.independentProcessExitVerified = false;
    record.isolationQualified = false;
    record.limitations = ['Local HTTP/HTTPS browser/request-client behavior for the pinned Chrome package only.',
      'Not OS-wide egress, WebRTC/UDP, installed Edge, hosted behavior, historical-worker causality or a GATE-1 pass.',
      'chrome.exe and chrome.dll are unsigned; provenance uses fixed archive and extracted-package hashes.',
      'Process-exit events cover owned browser parents; independent post-run browser/runner inspection is required.',
      'An elapsed receipt is not proof of process termination. No automatic retry, force-kill or hosted exercise follows.'];
    try { await cleanupStep(() => destination.writeFile(encodeEvidence(record, budget)), deadline, 1000); }
    catch {
      record.phase = 'stopped'; record.localChecksPassed = false; failed('evidence_write');
      finalizationError = new IsolationError('evidence_write');
    }
    finally {
      try { await cleanupStep(() => destination.close(), deadline, 1000); }
      catch { finalizationError ||= new IsolationError('evidence_close'); }
    }
  }
  if (finalizationError) throw finalizationError;
  return record;
}

/** Accept only this fixed invocation and its reviewed source digest, then emit a sanitized outcome. */
async function main(args) {
  check(args.length === 2 && args[0] === '--fixture-cft158-01' && typeof args[1] === 'string'
    && /^--source-set-sha256=[a-f0-9]{64}$/.test(args[1]), 'argument_required');
  const record = await runQualification(args[1].slice('--source-set-sha256='.length));
  process.stdout.write(JSON.stringify({ phase: record.phase, firstFailure: record.firstFailure,
    cleanupFailures: record.cleanupFailures, isolationQualified: record.isolationQualified, gate1Status: 'open' }) + '\n');
  if (record.phase !== 'passed') process.exitCode = 1;
}

module.exports = { DIRECTORY, RESULT, PROFILE_PREFIX, PIN, HISTORY, SOURCE_FILES, LIMITS, errorCode, sourceHashes,
  historyHashes, historyMatches, preflight, reserveEvidence, QualificationBudget, nativeDependencies, encodeEvidence,
  cleanupStep, runQualification, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(JSON.stringify({ stopCode: errorCode(error) }) + '\n'); process.exitCode = 1;
});
