'use strict';
/* global __dirname, Buffer, process */

/**
 * One separately authorized synthetic Edge lifecycle diagnostic, never isolation qualification.
 * Importing this module performs no I/O. Native execution requires the reviewed source-set hash.
 * The pinned private observer retains no protocol payloads, URLs, target IDs or raw errors.
 */
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const fixture = require('./request-client-isolation.cjs');
const { IsolationError, FixtureBudget, bounded } = fixture;
const ROOT = 'C:/Users/willm/job-application-tracker';
const EXECUTION_DIR = path.join(ROOT, '.tmp/gate1-browser-tabs');
const RECEIPT_DIR = path.join(ROOT, '.tmp/gate1-checkout-enable-dd2c2c6');
const RESULT = path.join(RECEIPT_DIR, 'browser-page-lifecycle-diagnostic-01.json');
const CORE = 'C:/Users/willm/AppData/Local/npm-cache/_npx/a5b920f00216d246/node_modules/playwright-core';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PIN = Object.freeze({ node: 'v22.18.0', playwright: '1.62.0-alpha-1783623505000', edge: '156.0.4314.50',
  bundle: 'be2e09efef3017b4eaa76f0cb5289f66c4ea57833f94319b17c1c2f184987ad7',
  executable: 'f87d927bed3597f19c70af67bc786dd22e4eca3b5c7cc050336a016bb42f7fda' });
const LIMITS = Object.freeze({ wholeMs: 90000, cleanupReserveMs: 20000, operationMs: 5000, inventoryMs: 1000,
  launches: 1, fixtureRequests: 10, proxyConnections: 100, navigations: 2, inventoryReads: 2,
  versionReads: 1, pagesCreated: 2, simultaneousPages: 2, events: 256, evidenceBytes: 131072 });
const HISTORY = Object.freeze({
  'staged-result.json': 'b1e31ced9c417987ecc70b783e35a2760c3a5a56914d8ae41d3695910d649323',
  'staged-result-attempt2.json': '49e2e8e70d6a3da2688d7cc8f2ad4d3b478adc4e364b91d3e11397ae7ef8e24d',
  'alias-restoration.json': 'dc35a0171ec6091ab9610e27b931889bf44fd45a715c683ebe5b9d69467cd18f',
  'promotion-result.json': 'c5f5afd6bbd3fc629a02b49da67647664685086bc80e7c269b126943082d4fd9',
  'free-checkout-result.json': '0c761565a23b7f457568dcf24aaab77bb704e260852111a90fd0466c9b7eb3db',
  'free-checkout-result-attempt2.json': '55b34140b498d72beb412ab61883c96bcad5aeb5fd6789565b640cff708bd2d4',
  'csrf-diagnostic.json': 'e0f40796329c8e2438cb7429b13f00d0a64d5a423f0fa2b675775efb40e34676',
  'browser-isolation-fixture.json': 'ecb96aaf3b61c3d0007e38a14ef0ff537ee7bb5f9c0a7124bba2b9487b03242d',
  'browser-isolation-fixture-attempt2.json': '49d78306a1ac1a82e075c80523ee842460b8c1a9750d801c3d87f0b626042c2e',
  'browser-isolation-fixture-attempt3.json': '03872b1c99a4236bb0239793e978e7a443e61081a20be3def937f008cf095120',
  'browser-isolation-fixture-attempt4.json': '3d153850ac7a5c57c98b3e52be465633d6e22bfaf5cab9b48b271a9f3154935d',
});
const SOURCE_FILES = Object.freeze(['request-client-isolation.cjs', '__tests__/request-client-isolation.test.cjs',
  'page-lifecycle-diagnostic.cjs', '__tests__/page-lifecycle-diagnostic.test.cjs']);
const CODES = new Set(['operation_failed', 'operation_timeout', 'close_timeout', 'close_incomplete', 'inventory_timeout',
  'inventory_invalid', 'private_interface', 'observer_failed', 'recorder_limit', 'evidence_size_limit', 'evidence_already_exists',
  'fixture_deadline', 'launches_budget', 'fixtureRequests_budget', 'proxyConnections_budget', 'navigations_budget',
  'inventoryReads_budget', 'versionReads_budget', 'pagesCreated_budget', 'page_state', 'control_state', 'toolchain_mismatch',
  'source_mismatch', 'history_mismatch', 'execution_directory', 'debug_logging_enabled', 'argument_required',
  'http_isolation', 'https_isolation', 'page_probe_timeout', 'browser_startup', 'browser_process', 'context_count',
  'unexpected_initial_page', 'keeper_timeout', 'synthetic_profile_required', 'debug_port_read', 'server_close_timeout',
  'browser_cleanup', 'server_cleanup', 'observer_cleanup', 'profile_preservation', 'overall_deadline', 'exercise_stopped']);
const STAGES = new Set(['setup', 'blank', 'blocked', 'cleanup', 'preservation']);
const EVENT_NAMES = new Set(['close_called', 'close_sent', 'close_reply_ok', 'close_reply_error', 'root_detached',
  'root_detached_session_only', 'server_close', 'client_close', 'promise_resolved', 'promise_rejected', 'frame_navigated',
  'frame_same_document', 'frame_detached_swap', 'frame_detached_remove', 'frame_started', 'frame_stopped',
  'lifecycle_init', 'lifecycle_domcontentloaded', 'lifecycle_load', 'lifecycle_other']);

/** Raise only fixed diagnostic guard codes; no native exception text enters evidence. */
function check(condition, code) { if (!condition) throw new IsolationError(code); }

/** Project unexpected exceptions to a fixed category, including forged/raw error properties. */
function errorCode(error) {
  if (error instanceof IsolationError && CODES.has(error.code)) return error.code;
  return error?.name === 'TimeoutError' ? 'operation_timeout' : 'operation_failed';
}

/** Hash bytes into a non-identifying provenance value shared by source and profile labels. */
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/** Stream only explicitly named source/executable/receipt files; never open browser storage. */
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Hash all eleven fixed predecessors in stable order; missing evidence fails preparation/execution. */
async function historyHashes(readHash = hashFile) {
  const hashes = {};
  for (const name of Object.keys(HISTORY)) hashes[name] = await readHash(path.join(RECEIPT_DIR, name));
  return hashes;
}

/** Compare the complete frozen history, rejecting changed, missing or additional entries. */
function historyMatches(hashes) { return JSON.stringify(hashes) === JSON.stringify(HISTORY); }

/** Hash the four executable/test inputs and their ordered manifest, avoiding a self-hash constant. */
async function sourceHashes(readHash = hashFile) {
  const files = {};
  for (const name of SOURCE_FILES) files[name] = await readHash(path.join(__dirname, name));
  return { files, set: digest(JSON.stringify(files)) };
}

/** Reject any version or executable/bundle digest drift before private interfaces can be used. */
function checkToolchain(actual) {
  check(['node', 'playwright', 'bundle', 'executable'].every(key => actual[key] === PIN[key]), 'toolchain_mismatch');
}

/** Validate immutable inputs before reserving evidence or loading Playwright; no browser is started. */
async function preflight(expectedSourceSet) {
  check(path.resolve(__dirname) === path.resolve(EXECUTION_DIR), 'execution_directory');
  check(!process.env.DEBUG && !process.env.DEBUG_FILE && !process.env.PWDEBUG, 'debug_logging_enabled');
  const metadata = JSON.parse(await fs.readFile(path.join(CORE, 'package.json'), 'utf8'));
  check(metadata.name === 'playwright-core' && metadata.version === PIN.playwright, 'toolchain_mismatch');
  checkToolchain({ node: process.version, playwright: metadata.version,
    bundle: await hashFile(path.join(CORE, 'lib/coreBundle.js')), executable: await hashFile(EDGE) });
  const sources = await sourceHashes(); check(sources.set === expectedSourceSet, 'source_mismatch');
  const history = await historyHashes(); check(historyMatches(history), 'history_mismatch');
  return { sources, history };
}

/** Latch one primary failure while applying the smaller working deadline and finite resource counts. */
class DiagnosticBudget extends FixtureBudget {
  /** Allocate bounded counters; reserve the final twenty seconds exclusively for cleanup/evidence. */
  constructor(clock = Date.now) {
    super({ ...LIMITS, wholeMs: LIMITS.wholeMs - LIMITS.cleanupReserveMs }, clock);
    Object.assign(this.counts, { navigations: 0, inventoryReads: 0, versionReads: 0, pagesCreated: 0 });
    this.firstFailure = null; this.halted = false;
  }
  /** A cleanup stop is distinct from a primary failure, but blocks every later exercise operation. */
  check() {
    check(!this.halted, 'exercise_stopped'); super.check();
  }
  /** Count actual incoming loopback activity even during cleanup; scripted actions still stop immediately. */
  count(kind) {
    if (!['fixtureRequests', 'proxyConnections'].includes(kind)) return super.count(kind);
    this.counts[kind]++;
    if (this.counts[kind] > this.limits[kind]) this.failure ||= `${kind}_budget`;
    this.check();
  }
  /** Keep the first fixed cause even when later cleanup, overflow or preservation also fails. */
  stop(error, stage) {
    const code = CODES.has(this.failure) ? this.failure : errorCode(error);
    this.failure ||= code;
    this.firstFailure ||= Object.freeze({ stage: STAGES.has(stage) ? stage : 'setup', code,
      elapsedMs: Math.max(0, this.clock() - this.startedAt) });
  }
}

/** Retain at most 256 fixed scalar events; overflow latches failure without throwing into CDP. */
class Recorder {
  /** Share the exercise clock and failure latch, keeping cleanup events in a separate phase. */
  constructor(budget) { this.budget = budget; this.events = []; this.phase = 'exercise'; this.overflow = false; this.sealed = false; }
  /** Validate labels and numerical codes before projection; discard every other incoming property. */
  add(label, event, code = null) {
    if (this.sealed) return;
    if (!['blank', 'blocked'].includes(label) || !EVENT_NAMES.has(event)) {
      this.budget.stop(new IsolationError('observer_failed'), 'setup'); return;
    }
    if (this.events.length >= LIMITS.events) {
      this.overflow = true; this.budget.stop(new IsolationError('recorder_limit'), label); return;
    }
    this.events.push(Object.freeze({ case: label, phase: this.phase,
      elapsedMs: Math.max(0, this.budget.clock() - this.budget.startedAt), event,
      code: Number.isInteger(code) && Math.abs(code) <= 1000000 ? code : null }));
  }
}

/** Validate the exact pinned in-process bridge; using a second CDP attachment would hide delivery failures. */
function browserBridge(browser) {
  check(typeof browser?._connection?.toImpl === 'function', 'private_interface');
  const server = browser._connection.toImpl(browser); const connection = server?._connection;
  check(connection && typeof connection._protocolLogger === 'function' && server._crPages instanceof Map
    && typeof connection.rootSession?.send === 'function', 'private_interface');
  return { server, connection, toImpl: browser._connection.toImpl.bind(browser._connection) };
}

/** Observe the real connection without changing commands or event ordering; restore every hook in finally. */
class LifecycleObserver {
  /** Install one reversible logger wrapper; failures in observation never throw through the transport. */
  constructor(bridge, recorder) {
    this.bridge = bridge; this.recorder = recorder; this.cases = new Map();
    this.original = bridge.connection._protocolLogger;
    const observer = this;
    /** Preserve the original logger's call and arguments, then project only reviewed protocol fields. */
    this.wrapper = function (direction, message) {
      observer.original.call(this, direction, message);
      try { observer.observe(direction, message); }
      catch { recorder.budget.stop(new IsolationError('observer_failed'), 'setup'); }
    };
    bridge.connection._protocolLogger = this.wrapper;
  }
  /** Register one owned disposable page; all raw IDs remain private to these two bounded entries. */
  watch(label, page) {
    check(['blank', 'blocked'].includes(label) && !this.cases.has(label), 'private_interface');
    const server = this.bridge.toImpl(page); const delegate = server?.delegate;
    const target = delegate?._targetId; const session = delegate?._mainFrameSession?._client?._sessionId;
    check(typeof target === 'string' && target.length > 0 && typeof session === 'string' && session.length > 0
      && this.bridge.server._crPages.get(target) === delegate && delegate._page === server
      && typeof server.on === 'function' && typeof server.removeListener === 'function'
      && typeof page.on === 'function' && typeof page.removeListener === 'function', 'private_interface');
    const entry = { target, session, server, page, commandId: null, state: { commandSent: false,
      reply: 'absent', reportedSuccess: null, protocolErrorCode: null, rootDetached: false, rootDetachedSessionOnly: false,
      serverClosed: false, clientClosed: false, promise: 'pending' } };
    /** Record server propagation independently of public client delivery. */
    entry.onServerClose = () => { entry.state.serverClosed = true; this.recorder.add(label, 'server_close'); };
    /** Record public close delivery without relying on promise settlement alone. */
    entry.onClientClose = () => { entry.state.clientClosed = true; this.recorder.add(label, 'client_close'); };
    server.on('close', entry.onServerClose); page.on('close', entry.onClientClose); this.cases.set(label, entry);
  }
  /** Correlate only root close commands/replies and this page's main-frame protocol events. */
  observe(direction, message) {
    for (const [label, entry] of this.cases) {
      const root = !message.sessionId;
      if (direction === 'send' && root && message.method === 'Target.closeTarget' && message.params?.targetId === entry.target) {
        if (entry.commandId !== null) { this.recorder.budget.stop(new IsolationError('observer_failed'), label); continue; }
        entry.commandId = message.id; entry.state.commandSent = true; this.recorder.add(label, 'close_sent');
      } else if (direction === 'receive' && root && entry.commandId !== null && message.id === entry.commandId) {
        const code = message.error?.code;
        entry.state.reply = message.error ? 'error' : 'ok';
        entry.state.reportedSuccess = !message.error && typeof message.result?.success === 'boolean' ? message.result.success : null;
        entry.state.protocolErrorCode = Number.isInteger(code) && Math.abs(code) <= 1000000 ? code : null;
        this.recorder.add(label, message.error ? 'close_reply_error' : 'close_reply_ok', entry.state.protocolErrorCode);
      } else if (direction === 'receive' && root && message.method === 'Target.detachedFromTarget') {
        if (message.params?.targetId === entry.target) {
          entry.state.rootDetached = true; this.recorder.add(label, 'root_detached');
        } else if (message.params?.sessionId === entry.session) {
          entry.state.rootDetachedSessionOnly = true; this.recorder.add(label, 'root_detached_session_only');
        }
      } else if (direction === 'receive' && message.sessionId === entry.session) {
        this.navigation(label, entry, message);
      }
    }
  }
  /** Reduce main-frame lifecycle messages to fixed categories; subframes and raw payloads are discarded. */
  navigation(label, entry, message) {
    const params = message.params || {}; let event;
    if (message.method === 'Page.frameNavigated' && params.frame?.id === entry.target && !params.frame.parentId) event = 'frame_navigated';
    if (params.frameId === entry.target) {
      if (message.method === 'Page.navigatedWithinDocument') event = 'frame_same_document';
      if (message.method === 'Page.frameStartedLoading') event = 'frame_started';
      if (message.method === 'Page.frameStoppedLoading') event = 'frame_stopped';
      if (message.method === 'Page.frameDetached' && ['swap', 'remove'].includes(params.reason)) event = `frame_detached_${params.reason}`;
      if (message.method === 'Page.lifecycleEvent') {
        const names = { init: 'init', DOMContentLoaded: 'domcontentloaded', load: 'load' };
        const name = Object.hasOwn(names, params.name) ? names[params.name] : 'other';
        event = `lifecycle_${name || 'other'}`;
      }
    }
    if (event) this.recorder.add(label, event);
  }
  /** Track the public promise independently; late completion is retained only as later-phase evidence. */
  settled(label, resolved) {
    this.cases.get(label).state.promise = resolved ? 'resolved' : 'rejected';
    this.recorder.add(label, resolved ? 'promise_resolved' : 'promise_rejected');
  }
  /** Copy scalar state so later detach/cleanup events cannot rewrite a cutoff observation. */
  snapshot(label) { return Object.freeze({ ...this.cases.get(label).state }); }
  /** Make one bounded inventory on the same connection, retaining only whether the owned target exists. */
  async present(label, milliseconds) {
    const target = this.cases.get(label).target;
    const result = await bounded(() => this.bridge.connection.rootSession.send('Target.getTargets'), milliseconds, 'inventory_timeout');
    check(Array.isArray(result?.targetInfos) && result.targetInfos.length <= 256
      && result.targetInfos.every(info => typeof info?.targetId === 'string'), 'inventory_invalid');
    return result.targetInfos.some(info => info.targetId === target);
  }
  /** Remove listeners and restore the original logger even after timeout or browser disconnection. */
  dispose() {
    this.recorder.sealed = true;
    const intact = this.bridge.connection._protocolLogger === this.wrapper;
    this.bridge.connection._protocolLogger = this.original;
    for (const entry of this.cases.values()) {
      entry.server.removeListener('close', entry.onServerClose); entry.page.removeListener('close', entry.onClientClose);
    }
    check(intact, 'observer_cleanup');
  }
}

/** Inspect synchronous metadata only; a healthy keeper must be the sole remaining blank page. */
function controlReady(owner) {
  const pages = owner.context.pages();
  return owner.browser.isConnected() && !owner.keeper.isClosed() && owner.keeper.url() === 'about:blank'
    && pages.length === 1 && pages[0] === owner.keeper;
}

/** Classify observations conservatively; a target inventory is timed separately from the close cutoff. */
function interpretation(cutoff, inventory) {
  if (!cutoff.commandSent) return 'close_command_not_observed';
  if (cutoff.reply === 'error') return 'close_protocol_error';
  if (cutoff.reply === 'absent') return 'close_reply_not_observed';
  if (cutoff.reportedSuccess === false) return 'close_reported_unsuccessful';
  if (inventory?.present === true) return 'acknowledged_target_present';
  if (inventory?.present === false && !cutoff.rootDetached) return 'target_absent_detachment_not_observed';
  if (cutoff.rootDetached && (!cutoff.serverClosed || !cutoff.clientClosed)) return 'close_propagation_incomplete';
  if (cutoff.promise !== 'resolved') return 'public_close_unsettled';
  return inventory?.present === false ? 'closure_observed' : 'inventory_inconclusive';
}

/**
 * Close once, freeze the five-second observation before any post-failure inventory/cleanup,
 * and require target absence within that same deadline for a completed case. No retry follows.
 */
async function closeCase(label, page, owner, observer, recorder, budget, cases) {
  budget.check();
  const startedAt = budget.clock(); const deadline = startedAt + LIMITS.operationMs;
  const result = { closeStartedMs: startedAt - budget.startedAt, cutoff: null, inventory: null, completed: false };
  cases[label] = result; recorder.add(label, 'close_called');
  let closeError;
  // Call close synchronously after the HTTPS assertions: no intervening CDP request or navigation.
  const closing = page.close({ runBeforeUnload: false }).then(() => observer.settled(label, true), error => {
    observer.settled(label, false); throw error;
  });
  try { await bounded(() => closing, LIMITS.operationMs, 'close_timeout'); }
  catch (error) { closeError = error; budget.stop(error, label); }
  check(!budget.halted, 'exercise_stopped');
  result.cutoff = observer.snapshot(label); result.cutoffElapsedMs = budget.clock() - startedAt;
  // A timeout is already latched. One bounded inventory may diagnose it, never upgrade it.
  try {
    check(budget.counts.inventoryReads < LIMITS.inventoryReads, 'inventoryReads_budget'); budget.counts.inventoryReads++;
    const available = closeError ? LIMITS.inventoryMs : Math.min(LIMITS.inventoryMs, deadline - budget.clock());
    check(available > 0, 'close_timeout');
    const present = await observer.present(label, available);
    check(!budget.halted, 'exercise_stopped');
    result.inventory = { present, elapsedMs: budget.clock() - startedAt, withinCloseDeadline: budget.clock() < deadline };
  } catch (error) {
    check(!budget.halted, 'exercise_stopped');
    result.inventoryFailure = errorCode(error); closeError ||= error; budget.stop(error, label);
  }
  result.interpretation = interpretation(result.cutoff, result.inventory);
  result.controlReady = controlReady(owner);
  if (closeError) throw closeError;
  budget.check();
  check(result.cutoff.commandSent && result.cutoff.reply === 'ok' && result.cutoff.reportedSuccess === true && result.cutoff.rootDetached
    && result.cutoff.serverClosed && result.cutoff.clientClosed && result.cutoff.promise === 'resolved'
    && result.inventory?.present === false && result.inventory.withinCloseDeadline && page.isClosed(), 'close_incomplete');
  check(result.controlReady, 'control_state'); result.completed = true;
}

/** Create exactly one disposable page beside the keeper and register observation before navigation. */
async function createCase(label, owner, observer, budget) {
  budget.check(); check(controlReady(owner), 'control_state'); budget.count('pagesCreated');
  const page = await bounded(() => owner.context.newPage(), LIMITS.operationMs); budget.check();
  const pages = owner.context.pages();
  check(page !== owner.keeper && !page.isClosed() && page.url() === 'about:blank' && pages.length === LIMITS.simultaneousPages
    && pages.includes(owner.keeper) && pages.includes(page), 'page_state');
  observer.watch(label, page); return page;
}

/** Reserve the immutable destination atomically before any native launch; concurrent runs cannot both proceed. */
async function reserveEvidence() {
  try { return await fs.open(RESULT, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new IsolationError('evidence_already_exists'); throw error; }
}

/** Enforce the retained evidence byte ceiling before touching the reserved destination. */
function encodeEvidence(record) {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  check(Buffer.byteLength(text) <= LIMITS.evidenceBytes, 'evidence_size_limit'); return text;
}

/** Preserve a bounded inconclusive receipt if the event serialization ever exceeds its byte ceiling. */
function finalEvidence(record, budget) {
  try { return encodeEvidence(record); }
  catch (error) {
    if (!(error instanceof IsolationError) || error.code !== 'evidence_size_limit') throw error;
    budget.stop(error, 'preservation'); record.firstFailure = budget.firstFailure; record.phase = 'inconclusive';
    record.events = []; record.evidenceTruncated = true; return encodeEvidence(record);
  }
}

/** Bound cleanup/preservation by its shared deadline, reserving one second for immutable evidence I/O. */
async function duringCleanup(budget, action, writing = false) {
  const remaining = budget.cleanupDeadline - Date.now() - (writing ? 0 : 1000);
  return bounded(action, Math.max(1, remaining), 'overall_deadline');
}

/** Supply native operations lazily, so importing/testing never loads Playwright or creates a browser. */
function nativeDependencies() {
  return { preflight, reserve: reserveEvidence, runtime: () => require(CORE), history: historyHashes,
    profile: () => fs.mkdtemp(path.join(EXECUTION_DIR, 'isolation-fixture-lifecycle-')),
    profileExists: profile => fs.stat(profile).then(stat => stat.isDirectory(), () => false),
    startFixture: fixture.startFixtureServer, startProxy: fixture.startRejectingProxy, launch: fixture.launchFixtureBrowser,
    closeBrowser: fixture.closeOwned, closeServer: fixture.closeServer, pageProbe: fixture.pageProbe, bridge: browserBridge };
}

/**
 * Run the two frozen cases with one owner and one immutable receipt. Dependencies are injectable
 * for offline orchestration tests only; CLI targets, profiles, budgets and versions are fixed.
 */
async function runDiagnostic(expectedSourceSet, deps = nativeDependencies()) {
  check(/^[a-f0-9]{64}$/.test(expectedSourceSet), 'argument_required');
  const inputs = await deps.preflight(expectedSourceSet); const destination = await deps.reserve();
  const budget = new DiagnosticBudget(); const recorder = new Recorder(budget); const owners = []; const servers = [];
  const record = { schemaVersion: 1, scope: 'synthetic_page_lifecycle_only', phase: 'running',
    operator: 'Codex agent', operationalOwner: 'Project owner', gate1Status: 'open', isolationQualified: false,
    hostedExerciseAuthorized: false, startedAt: new Date(budget.startedAt).toISOString(), limits: LIMITS,
    toolchain: PIN, sourceHashes: inputs.sources, priorEvidenceHashes: inputs.history, cases: {}, checks: {} };
  let runtime; let profile; let local; let proxy; let observer; let stage = 'setup';
  try {
    await bounded(async () => {
      runtime = deps.runtime(); budget.check(); profile = await deps.profile(); budget.check();
      record.syntheticProfileNameHash = digest(path.basename(profile));
      local = await deps.startFixture(budget, servers); budget.check();
      proxy = await deps.startProxy(budget, local.origin, servers); budget.check();
      const owner = await deps.launch({ runtime, profile, proxyPort: proxy.port, seedOrigin: null, budget, owners }); budget.check();
      budget.count('versionReads'); check(owner.browser.version() === PIN.edge, 'toolchain_mismatch');
      check(controlReady(owner), 'control_state'); observer = new LifecycleObserver(deps.bridge(owner.browser), recorder);
      stage = 'blank'; const blank = await createCase('blank', owner, observer, budget);
      await closeCase('blank', blank, owner, observer, recorder, budget, record.cases); budget.check();
      stage = 'blocked'; const blocked = await createCase('blocked', owner, observer, budget);
      const originBefore = local.counts.page; const proxyBefore = proxy.counts.page;
      budget.count('navigations');
      check(await deps.pageProbe(blocked, `${local.origin}/probe?kind=page`), 'http_isolation'); budget.check();
      check(local.counts.page === originBefore && proxy.counts.page > proxyBefore, 'http_isolation');
      record.checks.httpBlocked = true; const connectBefore = proxy.counts.fixtureConnect;
      budget.count('navigations');
      check(await deps.pageProbe(blocked, `${local.origin.replace('http:', 'https:')}/probe?kind=page`), 'https_isolation'); budget.check();
      check(local.counts.page === originBefore && proxy.counts.fixtureConnect > connectBefore, 'https_isolation');
      record.checks.httpsBlocked = true;
      await closeCase('blocked', blocked, owner, observer, recorder, budget, record.cases); budget.check();
      record.phase = 'not_reproduced';
    }, Math.max(1, budget.limits.wholeMs - (Date.now() - budget.startedAt)), 'fixture_deadline');
  } catch (error) { budget.stop(error, stage); record.phase = 'inconclusive'; }
  finally {
    // Stop future exercise steps before cleanup; late callbacks cannot qualify a frozen case.
    budget.halted = true; recorder.phase = 'cleanup'; record.cleanupFailures = [];
    budget.cleanupDeadline = Math.min(budget.startedAt + LIMITS.wholeMs, Date.now() + LIMITS.cleanupReserveMs);
    record.cutoffBeforeCleanup = {};
    if (observer) {
      for (const label of observer.cases.keys()) {
        record.cutoffBeforeCleanup[label] = observer.snapshot(label);
        const result = record.cases[label];
        if (result && !result.cutoff) {
          result.cutoff = record.cutoffBeforeCleanup[label];
          result.cutoffElapsedMs = Date.now() - budget.startedAt - result.closeStartedMs;
        }
      }
    }
    try {
      record.ownedBrowsersClosedNormally = true;
      for (const owner of owners) {
        try {
          if (await duringCleanup(budget, () => deps.closeBrowser(owner, runtime))) continue;
        } catch { /* Each owned server must still be closed after a browser cleanup exception. */ }
        record.ownedBrowsersClosedNormally = false; record.cleanupFailures.push('browser_cleanup');
      }
      for (const resource of servers.reverse()) {
        try { await duringCleanup(budget, () => deps.closeServer(resource)); } catch { record.cleanupFailures.push('server_cleanup'); }
      }
    } catch { record.ownedBrowsersClosedNormally = false; record.cleanupFailures.push('browser_cleanup'); }
    finally {
      if (observer) {
        record.afterCleanup = {};
        for (const label of observer.cases.keys()) record.afterCleanup[label] = observer.snapshot(label);
        try { observer.dispose(); } catch { record.cleanupFailures.push('observer_cleanup'); }
      }
    }
    try {
      record.syntheticProfilePreserved = !!profile && await duringCleanup(budget, () => deps.profileExists(profile));
      record.priorEvidenceUnchanged = historyMatches(await duringCleanup(budget, () => deps.history()));
      if (!record.syntheticProfilePreserved) record.cleanupFailures.push('profile_preservation');
      if (!record.priorEvidenceUnchanged) record.cleanupFailures.push('history_mismatch');
    } catch { record.priorEvidenceUnchanged = false; record.cleanupFailures.push('history_mismatch'); }
    if (record.cleanupFailures.length && !budget.firstFailure) {
      budget.stop(new IsolationError(record.cleanupFailures[0]), 'cleanup');
    }
    if (budget.failure && !budget.firstFailure) budget.stop(new IsolationError(budget.failure), 'cleanup');
    record.completedAt = new Date().toISOString(); record.elapsedMs = Date.now() - budget.startedAt;
    record.withinOverallLimit = record.elapsedMs < LIMITS.wholeMs;
    if (!record.withinOverallLimit && !budget.firstFailure) {
      budget.stop(new IsolationError('overall_deadline'), 'cleanup');
    }
    record.firstFailure = budget.firstFailure; record.counts = { ...budget.counts };
    record.events = recorder.events.slice(); record.recorderOverflow = recorder.overflow;
    record.proxyProbeCounts = proxy ? { ...proxy.counts } : null;
    record.fixtureProbeCounts = local ? { ...local.counts } : null;
    if (record.firstFailure || record.cleanupFailures.length) record.phase = 'inconclusive';
    record.limitations = ['Reduced setup omits restart and worker seeding; it cannot clear attempt3 or qualify restored-worker isolation.',
      'Target inventories are separately timed observations, not proof of target presence at an earlier cutoff.',
      'Rejected-proxy browser traffic is not OS-wide egress isolation. No hosted application or provider exercise is authorized.',
      'Playwright attachment performs its own initialization commands; counters cover diagnostic-issued version/inventory reads.',
      'No automatic retry, toolchain change or full isolation fixture follows this result.'];
    try { await duringCleanup(budget, () => destination.writeFile(finalEvidence(record, budget)), true); }
    finally { await duringCleanup(budget, () => destination.close(), true); }
  }
  return record;
}

/** Accept only the reviewed diagnostic and its complete source-set digest; print fixed summary fields. */
async function main(args) {
  check(args.length === 2 && args[0] === '--diagnostic' && /^--source-set-sha256=[a-f0-9]{64}$/.test(args[1]), 'argument_required');
  const record = await runDiagnostic(args[1].slice('--source-set-sha256='.length));
  process.stdout.write(`${JSON.stringify({ phase: record.phase, firstFailure: record.firstFailure,
    ownedBrowsersClosedNormally: record.ownedBrowsersClosedNormally, priorEvidenceUnchanged: record.priorEvidenceUnchanged })}\n`);
  if (record.phase !== 'not_reproduced') process.exitCode = 1;
}

module.exports = { PIN, LIMITS, HISTORY, SOURCE_FILES, DiagnosticBudget, Recorder, LifecycleObserver, browserBridge,
  errorCode, historyHashes, historyMatches, sourceHashes, checkToolchain, preflight, interpretation, closeCase, createCase,
  reserveEvidence, encodeEvidence, finalEvidence, runDiagnostic, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${JSON.stringify({ stopCode: errorCode(error) })}\n`); process.exitCode = 1;
});
