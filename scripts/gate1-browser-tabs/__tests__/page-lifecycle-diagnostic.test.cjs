'use strict';
/* global __dirname, Buffer */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { setImmediate: nextTurn } = require('node:timers/promises');
const fixture = require('../request-client-isolation.cjs');
const diagnostic = require('../page-lifecycle-diagnostic.cjs');
const { PIN, LIMITS, HISTORY, DiagnosticBudget, Recorder, LifecycleObserver, browserBridge, checkToolchain,
  errorCode, historyHashes, historyMatches, sourceHashes, interpretation, closeCase, reserveEvidence,
  encodeEvidence, finalEvidence, runDiagnostic, main } = diagnostic;
const SOURCE_SET = 'a'.repeat(64);
const HOSTILE = 'https://private.invalid/?cookie=SESSION_SECRET&token=RAW_SECRET';

/** Make an inspectable fake native boundary; no process, browser, listener or file is created. */
function harness(options = {}) {
  const calls = []; const pages = []; const implementations = new Map(); let nextId = 0; let written;
  const serverBrowser = { _crPages: new Map() };
  const connection = { _protocolLogger: () => calls.push('original_logger'), rootSession: {
    /** Return raw private IDs only to the observer, which must project presence to a boolean. */
    send: async method => {
      assert.equal(method, 'Target.getTargets'); calls.push('inventory');
      if (options.inventoryError) throw new Error(HOSTILE);
      return { targetInfos: pages.filter(page => !page.closed).map(page => ({ targetId: page.target, url: HOSTILE })) };
    },
  } };
  serverBrowser._connection = connection;
  /** Deliver protocol messages on the same fake connection that Playwright would consume. */
  function protocol(direction, message) { connection._protocolLogger(direction, message); }
  /** Complete target closure separately from the close command's acknowledgment. */
  function finish(page, detach = true, client = true) {
    if (page.closed) return;
    if (detach) protocol('receive', { method: 'Target.detachedFromTarget', params: { targetId: page.target, sessionId: page.session } });
    page.closed = true; page.server.emit('close');
    if (client) page.emit('close');
    serverBrowser._crPages.delete(page.target);
    if (page.resolve) page.resolve();
  }
  /** A fake context-created page exposes only the metadata and close methods used by this diagnostic. */
  class FakePage extends EventEmitter {
    /** Give each page independent target/session/server identities to detect incorrect correlation. */
    constructor(label) {
      super(); this.label = label; this.closed = false; this.target = `private-target-${label}-${HOSTILE}`;
      this.session = `private-session-${label}`; this.server = new EventEmitter();
      this.delegate = { _targetId: this.target, _mainFrameSession: { _client: { _sessionId: this.session } }, _page: this.server };
      this.server.delegate = this.delegate; serverBrowser._crPages.set(this.target, this.delegate);
      implementations.set(this, this.server); pages.push(this);
    }
    /** Match public synchronous metadata without navigating or reading page contents. */
    isClosed() { return this.closed; }
    /** Keep fixture metadata synthetic while raw protocol data uses hostile test values. */
    url() { return 'about:blank'; }
    /** Model acknowledgment, close events and promise completion as independently failing stages. */
    close(args) {
      assert.deepEqual(args, { runBeforeUnload: false }); calls.push(`close_${this.label}`);
      const mode = options[this.label] || 'normal';
      if (mode === 'throw') throw new Error(HOSTILE);
      if (mode === 'no_command') return new Promise(resolve => { this.resolve = resolve; });
      const id = ++nextId; protocol('send', { id, method: 'Target.closeTarget', params: { targetId: this.target } });
      if (mode !== 'missing_reply') protocol('receive', mode === 'error_open'
        ? { id, error: { code: -32000, message: HOSTILE, data: HOSTILE } } : { id, result: { success: true, extra: HOSTILE } });
      if (['ack_open', 'error_open', 'missing_reply'].includes(mode)) return new Promise(resolve => { this.resolve = resolve; });
      if (mode === 'detach_no_client') {
        protocol('receive', { method: 'Target.detachedFromTarget', params: { targetId: this.target } });
        this.server.emit('close'); return new Promise(resolve => { this.resolve = resolve; });
      }
      finish(this, mode !== 'closed_no_detach'); return Promise.resolve();
    }
  }
  const keeper = new FakePage('keeper'); const context = {
    pages: () => pages.filter(page => !page.closed),
    /** Create only the two explicitly scripted disposable pages. */
    newPage: async () => {
      const label = pages.some(page => page.label === 'blank') ? 'blocked' : 'blank';
      calls.push(`create_${label}`); return new FakePage(label);
    },
  };
  const browser = { isConnected: () => true, version: () => options.version || PIN.edge,
    _connection: { toImpl: object => object === browser ? serverBrowser : implementations.get(object) } };
  const owner = { browser, context, keeper }; const local = { origin: 'http://127.0.0.1:12345', counts: { page: 0, worker: 0, check: 0, seed: 0 } };
  const proxy = { port: 12346, counts: { page: 0, worker: 0, fixtureConnect: 0, other: 0 } };
  let budget;
  const deps = {
    preflight: async expected => { assert.equal(expected, SOURCE_SET); calls.push('preflight'); return { sources: { set: SOURCE_SET }, history: { ...HISTORY } }; },
    /** Mock the exclusive evidence handle and retain serialized output for redaction assertions. */
    reserve: async () => { calls.push('reserve'); return {
      writeFile: async text => { calls.push('write'); written = text; }, close: async () => calls.push('file_close'),
    }; },
    runtime: () => { calls.push('runtime'); return {}; },
    profile: async () => 'C:/synthetic/isolation-fixture-lifecycle-test', profileExists: async () => !options.profileMissing,
    history: async () => options.changedHistory ? {} : { ...HISTORY },
    startFixture: async (shared, servers) => { budget = shared; servers.push(local); return local; },
    startProxy: async (_shared, _origin, servers) => { servers.push(proxy); return proxy; },
    launch: async args => { calls.push('launch'); assert.equal(args.seedOrigin, null); args.budget.count('launches'); args.owners.push(owner); return owner; },
    bridge: browserBridge,
    /** Simulate proxy counter increments, never an HTTP request or worker registration. */
    pageProbe: async (_page, url) => {
      const secure = url.startsWith('https:'); calls.push(secure ? 'https_probe' : 'http_probe'); budget.count('proxyConnections');
      if (options.probeRejected) return false;
      if (!options.missingProxy) proxy.counts[secure ? 'fixtureConnect' : 'page']++;
      if (options.originReached) local.counts.page++;
      return true;
    },
    /** Let delayed close promises settle during cleanup, testing immutability of deadline observations. */
    closeBrowser: async () => {
      calls.push('browser_cleanup');
      if (options.cleanupThrows) throw new Error(HOSTILE);
      for (const page of pages) finish(page);
      return !options.cleanupFails;
    },
    closeServer: async () => { calls.push('server_cleanup'); if (options.serverFails) throw new Error(HOSTILE); },
  };
  return { deps, calls, pages, owner, connection, serverBrowser, protocol, finish, FakePage,
    written: () => written, getBudget: () => budget };
}

/** Attach the real observer to fake private objects for focused correlation tests. */
function observed(options = {}) {
  const fake = harness(options); const budget = new DiagnosticBudget(); const recorder = new Recorder(budget);
  const observer = new LifecycleObserver(browserBridge(fake.owner.browser), recorder);
  const page = new fake.FakePage('blank'); observer.watch('blank', page);
  return { ...fake, budget, recorder, observer, page };
}

/** Flush promise continuations before advancing mocked timers; uses no sleeping or native process. */
async function flush() { await nextTurn(); }

/** Prove imports and default CLI invocation cannot load Playwright or launch anything. */
test('import is inert and CLI requires a source digest with the exact diagnostic flag', async () => {
  const code = await fs.readFile(path.join(__dirname, '../page-lifecycle-diagnostic.cjs'), 'utf8');
  const testModule = { exports: {} }; const requested = [];
  vm.runInNewContext(code, { module: testModule, exports: testModule.exports, __dirname,
    require: name => { requested.push(name); assert.ok(name.startsWith('node:') || name === './request-client-isolation.cjs');
      return name === './request-client-isolation.cjs' ? fixture : require(name); } });
  assert.ok(!requested.some(name => name.includes('playwright')));
  for (const args of [[], ['--diagnostic'], ['--fixture'], ['--diagnostic', '--source-set-sha256=secret'],
    ['--diagnostic', `--source-set-sha256=${SOURCE_SET}`, '--profile=retained']]) await assert.rejects(main(args), /argument_required/);
});

/** Exercise each exact toolchain guard independently, including the private implementation hash. */
test('toolchain guards reject every version or hash drift', () => {
  assert.doesNotThrow(() => checkToolchain(PIN));
  for (const key of ['node', 'playwright', 'bundle', 'executable']) {
    assert.throws(() => checkToolchain({ ...PIN, [key]: HOSTILE }), /toolchain_mismatch/);
  }
  assert.throws(() => browserBridge({}), /private_interface/);
  assert.throws(() => browserBridge({ _connection: { toImpl: () => ({ _connection: {} }) } }), /private_interface/);
});

/** Verify that source manifests cover both helpers/tests and preserve a stable ordered digest. */
test('source provenance includes all four inputs and changes with any input', async () => {
  const paths = []; const first = await sourceHashes(async file => { paths.push(file); return SOURCE_SET; });
  assert.equal(paths.length, 4); assert.equal(Object.keys(first.files).length, 4);
  const second = await sourceHashes(async file => file.endsWith('page-lifecycle-diagnostic.test.cjs') ? 'b'.repeat(64) : SOURCE_SET);
  assert.notEqual(first.set, second.set); assert.match(first.set, /^[a-f0-9]{64}$/);
});

/** Ensure all eleven historical files are included and the future receipt is excluded. */
test('history preservation is exact and includes attempt4', async () => {
  const names = []; const hashes = await historyHashes(async file => { const name = path.basename(file); names.push(name); return HISTORY[name]; });
  assert.equal(names.length, 11); assert.ok(names.includes('browser-isolation-fixture-attempt4.json'));
  assert.ok(historyMatches(hashes)); assert.ok(!historyMatches({ ...hashes, extra: SOURCE_SET }));
  assert.ok(!historyMatches({ ...hashes, 'browser-isolation-fixture-attempt4.json': SOURCE_SET }));
});

/** Atomic reservation prevents two diagnostic invocations from passing an existence-check race. */
test('evidence reservation uses exclusive creation and refuses an existing destination', async t => {
  t.mock.method(fs, 'open', async (file, flag) => {
    assert.equal(path.basename(file), 'browser-page-lifecycle-diagnostic-01.json'); assert.equal(flag, 'wx');
    throw Object.assign(new Error(HOSTILE), { code: 'EEXIST' });
  });
  await assert.rejects(reserveEvidence(), /evidence_already_exists/);
  const fake = harness(); fake.deps.reserve = reserveEvidence;
  await assert.rejects(runDiagnostic(SOURCE_SET, fake.deps), /evidence_already_exists/);
  assert.ok(!fake.calls.includes('runtime')); assert.ok(!fake.calls.includes('launch'));
});

/** A failed preflight is terminal before the receipt, profile or runtime can be created. */
test('preflight failure prevents reservation and native setup', async () => {
  const fake = harness(); fake.deps.preflight = async () => { throw new fixture.IsolationError('source_mismatch'); };
  await assert.rejects(runDiagnostic(SOURCE_SET, fake.deps), /source_mismatch/); assert.deepEqual(fake.calls, []);
});

/** Ignore unrelated sessions/IDs and retain only the matching root response's fixed status. */
test('observer correlates root command responses and restores the exact original hook', () => {
  const fake = observed(); const original = fake.observer.original;
  fake.protocol('send', { id: 7, method: 'Target.closeTarget', params: { targetId: fake.page.target } });
  fake.protocol('receive', { id: 8, result: {} });
  fake.protocol('receive', { id: 7, sessionId: 'other', error: { code: -32000, message: HOSTILE } });
  assert.equal(fake.observer.snapshot('blank').reply, 'absent');
  fake.protocol('receive', { id: 7, result: { success: true, private: HOSTILE } });
  assert.equal(fake.observer.snapshot('blank').reply, 'ok');
  assert.equal(fake.calls.filter(call => call === 'original_logger').length, 4);
  fake.observer.dispose(); assert.equal(fake.connection._protocolLogger, original);
  assert.equal(fake.page.listenerCount('close'), 0); assert.equal(fake.page.server.listenerCount('close'), 0);
});

/** Delivery order may vary; IDs and independent flags must still produce the same evidence. */
for (const order of [['reply', 'detach', 'server', 'client'], ['detach', 'server', 'reply', 'client'], ['client', 'server', 'detach', 'reply']]) {
  test(`observer tolerates close event order ${order.join('/')}`, () => {
    const fake = observed();
    fake.protocol('send', { id: 1, method: 'Target.closeTarget', params: { targetId: fake.page.target } });
    for (const event of order) {
      if (event === 'reply') fake.protocol('receive', { id: 1, result: {} });
      if (event === 'detach') fake.protocol('receive', { method: 'Target.detachedFromTarget', params: { targetId: fake.page.target } });
      if (event === 'server') fake.page.server.emit('close');
      if (event === 'client') fake.page.emit('close');
    }
    fake.observer.settled('blank', true);
    assert.equal(interpretation(fake.observer.snapshot('blank'), { present: false }), 'closure_observed'); fake.observer.dispose();
  });
}

/** A session-only detach cannot stand in for the target-ID lookup used by pinned Playwright. */
test('session-only root detach is distinct from a matching target detach', () => {
  const fake = observed();
  fake.protocol('receive', { method: 'Target.detachedFromTarget', params: { sessionId: fake.page.session } });
  assert.equal(fake.observer.snapshot('blank').rootDetached, false);
  assert.equal(fake.observer.snapshot('blank').rootDetachedSessionOnly, true); fake.observer.dispose();
});

/** Hostile protocol fields must never appear in snapshots, lifecycle events or error projections. */
test('navigation and protocol-error projection discard URLs IDs cookies and arbitrary messages', () => {
  const fake = observed();
  fake.protocol('send', { id: 1, method: 'Target.closeTarget', params: { targetId: fake.page.target } });
  fake.protocol('receive', { id: 1, error: { code: -32000, message: HOSTILE, data: HOSTILE } });
  fake.protocol('receive', { sessionId: fake.page.session, method: 'Page.frameNavigated', params: { frame: { id: fake.page.target, url: HOSTILE } } });
  for (const name of ['DOMContentLoaded', 'load', 'init', HOSTILE, 'constructor']) {
    fake.protocol('receive', { sessionId: fake.page.session, method: 'Page.lifecycleEvent', params: { frameId: fake.page.target, name, cookie: HOSTILE } });
  }
  fake.protocol('receive', { sessionId: fake.page.session, method: 'Page.frameDetached', params: { frameId: fake.page.target, reason: 'swap' } });
  const retained = JSON.stringify({ state: fake.observer.snapshot('blank'), events: fake.recorder.events });
  for (const sentinel of [HOSTILE, 'private-target', 'private-session', 'SESSION_SECRET', 'RAW_SECRET']) assert.ok(!retained.includes(sentinel));
  assert.equal(fake.observer.snapshot('blank').protocolErrorCode, -32000);
  assert.equal(errorCode(Object.assign(new Error(HOSTILE), { code: HOSTILE })), 'operation_failed'); fake.observer.dispose();
});

/** Bound retained memory even if a target produces an unlimited stream of lifecycle notifications. */
test('recorder overflow is latched and capped without throwing into the transport', () => {
  const fake = observed();
  for (let i = 0; i < LIMITS.events + 20; i++) {
    fake.protocol('receive', { sessionId: fake.page.session, method: 'Page.frameStartedLoading', params: { frameId: fake.page.target } });
  }
  assert.equal(fake.recorder.events.length, LIMITS.events); assert.ok(fake.recorder.overflow);
  assert.equal(fake.budget.firstFailure.code, 'recorder_limit'); fake.observer.dispose();
  assert.throws(() => encodeEvidence({ data: 'x'.repeat(LIMITS.evidenceBytes) }), /evidence_size_limit/);
});

/** Byte overflow produces an explicitly incomplete bounded receipt instead of truncating JSON. */
test('oversized events are discarded with an inconclusive evidence-size failure', () => {
  const budget = new DiagnosticBudget(); const record = { phase: 'not_reproduced', events: ['x'.repeat(LIMITS.evidenceBytes)] };
  const encoded = finalEvidence(record, budget); const parsed = JSON.parse(encoded);
  assert.equal(parsed.phase, 'inconclusive'); assert.equal(parsed.firstFailure.code, 'evidence_size_limit');
  assert.equal(parsed.evidenceTruncated, true); assert.deepEqual(parsed.events, []);
});

/** A negative success result must remain distinct from an accepted close with an open target. */
test('reported close failure and invalid numeric error codes are projected explicitly', () => {
  const fake = observed();
  fake.protocol('send', { id: 1, method: 'Target.closeTarget', params: { targetId: fake.page.target } });
  fake.protocol('receive', { id: 1, result: { success: false } });
  assert.equal(interpretation(fake.observer.snapshot('blank'), { present: true }), 'close_reported_unsuccessful');
  fake.protocol('receive', { id: 1, error: { code: HOSTILE, message: HOSTILE } });
  assert.equal(fake.observer.snapshot('blank').protocolErrorCode, null); fake.observer.dispose();
});

/** Classify acknowledged-but-open, unanswered, protocol-error and propagation failures independently. */
for (const [mode, expected] of [['ack_open', 'acknowledged_target_present'], ['error_open', 'close_protocol_error'],
  ['missing_reply', 'close_reply_not_observed'], ['no_command', 'close_command_not_observed'],
  ['detach_no_client', 'acknowledged_target_present']]) {
  test(`close timeout freezes ${mode} before late cleanup completion`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
    const fake = observed({ blank: mode }); const cases = {};
    const closing = closeCase('blank', fake.page, fake.owner, fake.observer, fake.recorder, fake.budget, cases);
    const rejected = assert.rejects(closing, /close_timeout/); await flush(); t.mock.timers.tick(5000); await rejected;
    const frozen = JSON.stringify(cases.blank); assert.equal(cases.blank.interpretation, expected);
    assert.equal(cases.blank.cutoff.promise, 'pending'); assert.equal(cases.blank.completed, false);
    fake.recorder.phase = 'cleanup'; fake.finish(fake.page); await flush();
    assert.equal(JSON.stringify(cases.blank), frozen); assert.equal(fake.observer.snapshot('blank').promise, 'resolved');
    assert.ok(fake.recorder.events.some(event => event.phase === 'cleanup' && event.event === 'promise_resolved')); fake.observer.dispose();
  });
}

/** Distinguish target disappearance from missing root delivery instead of treating closure as sufficient. */
test('target absence without root detachment remains incomplete', async () => {
  const fake = observed({ blank: 'closed_no_detach' }); const cases = {};
  await assert.rejects(closeCase('blank', fake.page, fake.owner, fake.observer, fake.recorder, fake.budget, cases), /close_incomplete/);
  assert.equal(cases.blank.interpretation, 'target_absent_detachment_not_observed'); fake.observer.dispose();
  assert.equal(interpretation({ commandSent: true, reply: 'ok', rootDetached: true, serverClosed: true, clientClosed: false }, { present: false }),
    'close_propagation_incomplete');
});

/** Successful reduced cases produce a non-reproduction, never an isolation/GATE-1 pass. */
test('orchestration runs exactly two cases with immediate HTTPS-to-close and normal cleanup', async () => {
  const fake = harness(); const result = await runDiagnostic(SOURCE_SET, fake.deps);
  assert.equal(result.phase, 'not_reproduced'); assert.equal(result.gate1Status, 'open'); assert.equal(result.isolationQualified, false);
  assert.equal(result.counts.launches, 1); assert.equal(result.counts.navigations, 2); assert.equal(result.counts.inventoryReads, 2);
  assert.equal(result.counts.versionReads, 1); assert.equal(result.counts.pagesCreated, 2);
  const https = fake.calls.indexOf('https_probe'); assert.equal(fake.calls[https + 1], 'close_blocked');
  assert.equal(fake.calls.filter(call => call === 'server_cleanup').length, 2);
  assert.ok(result.ownedBrowsersClosedNormally && result.syntheticProfilePreserved && result.priorEvidenceUnchanged);
  assert.equal(result.firstFailure, null); assert.equal(fake.calls.at(-1), 'file_close');
  assert.ok(Buffer.byteLength(fake.written()) < LIMITS.evidenceBytes); assert.ok(!fake.written().includes(HOSTILE));
});

/** A first-case failure prevents case2, even if normal browser cleanup later completes the close. */
test('first failure stops later cases and survives cleanup failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const fake = harness({ blank: 'ack_open', cleanupFails: true }); const running = runDiagnostic(SOURCE_SET, fake.deps);
  await flush(); t.mock.timers.tick(5000); const result = await running;
  assert.equal(result.firstFailure.code, 'close_timeout'); assert.equal(result.firstFailure.stage, 'blank');
  assert.equal(result.phase, 'inconclusive'); assert.ok(!fake.calls.includes('create_blocked'));
  assert.equal(result.cases.blank.cutoff.promise, 'pending'); assert.equal(result.afterCleanup.blank.promise, 'resolved');
  assert.deepEqual(result.cleanupFailures, ['browser_cleanup']); assert.equal(result.ownedBrowsersClosedNormally, false);
});

/** Browser cleanup exceptions still close both owned listeners and preserve the first failure. */
test('throwing browser cleanup cannot skip server cleanup', async () => {
  const fake = harness({ blank: 'closed_no_detach', cleanupThrows: true }); const result = await runDiagnostic(SOURCE_SET, fake.deps);
  assert.equal(result.firstFailure.code, 'close_incomplete'); assert.equal(fake.calls.filter(call => call === 'server_cleanup').length, 2);
  assert.ok(result.cleanupFailures.includes('browser_cleanup'));
});

/** Failed network evidence cannot start the blocked-page close or mark the exercise complete. */
for (const option of ['probeRejected', 'missingProxy', 'originReached']) {
  test(`network guard stops on ${option}`, async () => {
    const fake = harness({ [option]: true }); const result = await runDiagnostic(SOURCE_SET, fake.deps);
    assert.equal(result.firstFailure.code, 'http_isolation'); assert.ok(!fake.calls.includes('https_probe'));
    assert.ok(!fake.calls.includes('close_blocked')); assert.equal(result.phase, 'inconclusive');
  });
}

/** Preservation failures after two completed cases remain terminal diagnostic failures. */
for (const [option, code] of [['changedHistory', 'history_mismatch'], ['profileMissing', 'profile_preservation'], ['serverFails', 'server_cleanup']]) {
  test(`final preservation/cleanup detects ${option}`, async () => {
    const fake = harness({ [option]: true }); const result = await runDiagnostic(SOURCE_SET, fake.deps);
    assert.equal(result.phase, 'inconclusive'); assert.equal(result.firstFailure.code, code);
  });
}

/** Counts and deadlines stop exactly at their boundary and never allow a later exercise after cleanup. */
test('resource budgets and cleanup latch reject further work', () => {
  let now = 0; const budget = new DiagnosticBudget(() => now);
  budget.count('launches'); assert.throws(() => budget.count('launches'), /launches_budget/);
  budget.stop(new Error(HOSTILE), 'setup'); assert.equal(budget.firstFailure.code, 'launches_budget');
  const deadline = new DiagnosticBudget(() => now); now = 70000; assert.throws(() => deadline.check(), /fixture_deadline/);
  const halted = new DiagnosticBudget(); halted.halted = true; assert.throws(() => halted.check(), /exercise_stopped/);
  assert.throws(() => halted.count('proxyConnections'), /exercise_stopped/); assert.equal(halted.counts.proxyConnections, 1);
});

/** Outer expiry freezes observations before cleanup and prevents a late probe from starting HTTPS or close. */
test('outer deadline stops continuation after an unresolved probe settles late', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const fake = harness(); let release;
  fake.deps.pageProbe = () => new Promise(resolve => { release = resolve; });
  const running = runDiagnostic(SOURCE_SET, fake.deps); await flush(); t.mock.timers.tick(70000);
  const result = await running; const frozen = fake.written();
  assert.equal(result.firstFailure.code, 'fixture_deadline'); assert.equal(result.firstFailure.stage, 'blocked');
  assert.equal(result.cutoffBeforeCleanup.blocked.clientClosed, false);
  release(true); await flush(); assert.equal(fake.written(), frozen);
  assert.ok(!fake.calls.includes('https_probe')); assert.ok(!fake.calls.includes('close_blocked'));
});

/** Freeze an active close on outer expiry; late resolution cannot request inventory during cleanup. */
test('outer deadline during close cannot mutate its frozen case or start a late inventory', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const fake = harness({ blocked: 'ack_open' });
  const probe = fake.deps.pageProbe;
  fake.deps.pageProbe = async (...args) => {
    if (args[1].startsWith('https:')) t.mock.timers.tick(68000);
    return probe(...args);
  };
  const running = runDiagnostic(SOURCE_SET, fake.deps); await flush(); t.mock.timers.tick(2000);
  const result = await running; const frozen = JSON.stringify(result.cases.blocked);
  assert.equal(result.firstFailure.code, 'fixture_deadline'); assert.equal(result.cases.blocked.cutoff.promise, 'pending');
  assert.equal(result.counts.inventoryReads, 1); await flush();
  assert.equal(JSON.stringify(result.cases.blocked), frozen); assert.equal(fake.calls.filter(call => call === 'inventory').length, 1);
});

/** A hung cleanup operation consumes its finite reserve and still allows receipt persistence. */
test('hung browser cleanup is bounded and both local resources still receive cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const fake = harness(); fake.deps.closeBrowser = () => new Promise(() => {});
  const running = runDiagnostic(SOURCE_SET, fake.deps); await flush(); t.mock.timers.tick(19000);
  const result = await running;
  assert.equal(result.phase, 'inconclusive'); assert.equal(result.firstFailure.code, 'browser_cleanup');
  assert.equal(result.ownedBrowsersClosedNormally, false); assert.equal(fake.calls.filter(call => call === 'server_cleanup').length, 2);
  assert.equal(fake.calls.at(-1), 'file_close');
});

/** Incoming cleanup traffic is counted and can invalidate a previously completed reduced exercise. */
test('cleanup proxy overflow cannot leave a not-reproduced result', async () => {
  const fake = harness(); const close = fake.deps.closeBrowser;
  fake.deps.closeBrowser = async (...args) => {
    const budget = fake.getBudget();
    for (let i = 0; i <= LIMITS.proxyConnections; i++) { try { budget.count('proxyConnections'); } catch { /* Expected after halt. */ } }
    return close(...args);
  };
  const result = await runDiagnostic(SOURCE_SET, fake.deps);
  assert.equal(result.phase, 'inconclusive'); assert.equal(result.firstFailure.code, 'proxyConnections_budget');
  assert.ok(result.counts.proxyConnections > LIMITS.proxyConnections);
});

/** An inventory failure cannot turn a resolved public close into a completed diagnostic case. */
test('inventory rejection stops before case2 and retains only a fixed failure', async () => {
  const fake = harness({ inventoryError: true }); const result = await runDiagnostic(SOURCE_SET, fake.deps);
  assert.equal(result.phase, 'inconclusive'); assert.equal(result.cases.blank.inventoryFailure, 'operation_failed');
  assert.ok(!fake.calls.includes('create_blocked')); assert.ok(!fake.written().includes(HOSTILE));
});
