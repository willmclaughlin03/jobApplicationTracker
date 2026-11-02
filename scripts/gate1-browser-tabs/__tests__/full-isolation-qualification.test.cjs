'use strict';
/* global __dirname, Buffer, setImmediate, setTimeout, clearTimeout */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const fixture = require('../request-client-isolation.cjs');
const diagnostic = require('../page-lifecycle-diagnostic.cjs');
const qualification = require('../full-isolation-qualification.cjs');
const { PIN, HISTORY, LIMITS, DIRECTORY, SOURCE_FILES, QualificationBudget, runQualification } = qualification;
const SOURCE = 'a'.repeat(64);

/** Flush promise continuations independently of mocked timers. */
function nextTurn() { return new Promise(resolve => setImmediate(resolve)); }

/**
 * Model only native boundaries; the real shared sequence, guards, probes and qualification orchestration execute.
 * Browser objects carry synthetic values only and never launch a process or read profile storage.
 */
function harness(options = {}) {
  const calls = []; const writes = []; const owners = []; let fixtureBudget; let release;
  const local = { origin: 'http://127.0.0.1:1234', counts: { page: 0, worker: 0, seed: 0, check: 0 }, kind: 'fixture' };
  const proxy = { port: 1235, counts: { page: 0, worker: 0, fixtureConnect: 0, other: 0 }, kind: 'proxy' };
  const deps = {
    /** Admit only the frozen synthetic source and history, without native imports. */
    async preflight(expected) {
      calls.push('preflight'); assert.equal(expected, SOURCE);
      if (options.preflightFailure) throw new fixture.IsolationError('package_mismatch');
      return { sources: { files: {}, set: SOURCE }, history: { ...HISTORY }, packageProvenance: { ...PIN } };
    },
    /** Capture exclusive-output ordering and the final bounded bytes in memory. */
    async reserve() {
      calls.push('reserve');
      if (options.occupied) throw new fixture.IsolationError('evidence_already_exists');
      return {
        /** Model immutable receipt output, including a failed disk write. */
        async writeFile(text) { calls.push('write'); if (options.writeFailure) throw new Error('PRIVATE_WRITE'); writes.push(text); },
        /** The handle must close even after failed serialization or writing. */
        async close() { calls.push('handle_close'); },
      };
    },
    /** Return a stand-in runtime only after admission and reservation. */
    runtime() { calls.push('runtime'); return {}; },
    /** Return a fresh synthetic name without creating a directory. */
    async profile() { calls.push('profile'); return path.join(DIRECTORY, 'isolation-fixture-cft158-01-synthetic'); },
    /** Observe directory preservation without examining its contents. */
    async profileExists() { return !options.profileMissing; },
    /** Supply either the preserved history or one deliberately modified predecessor. */
    async history() { return { ...HISTORY, ...(options.historyChanged ? { 'csrf-diagnostic.json': SOURCE } : {}) }; },
    /** Report exact runtime/test provenance after normal cleanup. */
    async sources() { return { set: options.sourcesChanged ? 'b'.repeat(64) : SOURCE }; },
    /** Register fixture ownership before any subsequent native setup. */
    async startFixture(budget, servers) { fixtureBudget = budget; calls.push('fixture'); servers.push(local); return local; },
    /** Register the rejecting proxy; no upstream socket exists in this harness. */
    async startProxy(budget, origin, servers) { assert.equal(origin, local.origin); servers.push(proxy); calls.push('proxy'); return proxy; },
    /** Model both launches, the same profile, exact Chrome selection and the removed restart exception. */
    async launch(args) {
      args.budget.count('launches');
      assert.equal(args.browser, 'cft158');
      const restored = owners.length === 1;
      assert.equal(args.seedOrigin, restored ? null : local.origin);
      if (restored) { assert.equal(owners[0].closed, true); assert.equal(args.profile, owners[0].profile); }
      calls.push(restored ? 'restart' : 'launch');
      const context = new EventEmitter(); let pages = []; let probeClosed = false;
      const owner = { context, profile: args.profile, child: { exitCode: null }, closed: false };
      const worker = {
        /** Match only the exact fixture worker script. */
        url() { return local.origin + '/sw.js'; },
        /** Exercise real result projection and proxy/origin evidence checks. */
        async evaluate() {
          calls.push(restored ? 'restored_probe' : 'baseline_probe');
          if (!restored) {
            if (!options.baselineMissingHit) local.counts.worker++;
            return { status: 200, reached: true, errorCategory: null };
          }
          if (options.hangWorker) return new Promise(resolve => { release = resolve; });
          if (options.workerError) throw new Error('PRIVATE_WORKER https://private.invalid');
          if (!options.missingWorkerProxy) proxy.counts.worker++;
          if (options.workerOriginHit) local.counts.worker++;
          if (options.invalidWorker) return { status: null, reached: false, errorCategory: 'PRIVATE_RESULT' };
          return { status: null, reached: false, errorCategory: 'fetch_rejected', extra: 'PRIVATE_EXTRA' };
        },
      };
      /** Discover only the exact persisted synthetic registration. */
      context.serviceWorkers = () => restored && options.missingWorker ? [] : [worker];
      /** Model cookie write-back without reading any real storage. */
      context.cookies = async () => options.writebackMissing ? [] : [{ name: 'isolation_fixture', value: 'SYNTHETIC_UPDATED' }];
      /** Return the owned page inventory used by simultaneous-page and keeper guards. */
      context.pages = () => pages;
      /** Create the sole disposable page and model its synchronous page event. */
      context.newPage = async () => {
        calls.push('probe_create');
        const page = {
          /** Supply only local page metadata and normal-close semantics. */
          url() { return 'about:blank'; },
          /** Observe closure independently of the resolved close promise. */
          isClosed() { return probeClosed; },
          /** Keep HTTPS-to-close sequencing visible and reject a false close success. */
          async close(args) {
            assert.deepEqual(args, { runBeforeUnload: false }); calls.push('probe_close');
            if (options.closeIncomplete) return;
            probeClosed = true; pages = [owner.keeper];
          },
        };
        pages.push(page);
        if (options.extraPage) pages.push({});
        context.emit('page', page); return page;
      };
      /** Attach only to the untouched keeper for the restored-worker commands. */
      context.newCDPSession = async page => {
        assert.equal(page, owner.keeper); calls.push('worker_session');
        return {
          /** Keep enable/start order exact and hold startup past deadline when requested. */
          async send(method) {
            calls.push(method);
            if (options.hangStart && method === 'ServiceWorker.startWorker') return new Promise(resolve => { release = resolve; });
          },
          /** Mark explicit detach so failed operations still clean up the owned session. */
          async detach() { calls.push('detach'); },
        };
      };
      owner.keeper = {
        /** The restored keeper is never navigated by page probes. */
        async goto(url) { assert.equal(restored, false); assert.equal(url, local.origin + '/fixture'); calls.push('seed_navigation'); },
        /** Model successful synthetic worker installation. */
        async evaluate() { calls.push('install'); },
        /** Keep the synthetic control page blank and open. */
        url() { return 'about:blank'; },
        /** Expose only a boolean closure state. */
        isClosed() { return false; },
      };
      owner.browser = {
        /** Use only the cached version value, checked on both launches. */
        version() { return options.wrongVersion === (restored ? 2 : 1) ? '0.0.0.0' : PIN.version; },
        /** Keep cleanup ownership tied to the synthetic child. */
        isConnected() { return owner.child.exitCode === null; },
      };
      pages = [owner.keeper]; args.owners.push(owner); owners.push(owner); return owner;
    },
    /** Preserve request order and model only the synthetic cookie exchange. */
    async request(context, origin, endpoint) {
      assert.equal(origin, local.origin); calls.push(endpoint);
      if (options.hangRequest) return new Promise(resolve => { release = resolve; });
      return { cookiePresent: endpoint === '/api/seed' ? !!options.seedNotFresh : !options.cookieMissing };
    },
    /** Count proxy evidence without allowing page hits at the fixture. */
    async pageProbe(page, url) {
      const https = url.startsWith('https:'); calls.push(https ? 'https' : 'http');
      if (options.missingPageProxy !== (https ? 'https' : 'http')) proxy.counts[https ? 'fixtureConnect' : 'page']++;
      if (options.pageOriginHit) local.counts.page++;
      return true;
    },
    /** Normal browser cleanup verifies parent exit and never kills or removes a profile. */
    async closeBrowser(owner, runtime, deadline) {
      assert.ok(Number.isFinite(deadline)); if (owner.closed) return true;
      calls.push('browser_close');
      if (options.browserCleanupFailure) return false;
      if (options.hangCleanup && owners.length === 2) return new Promise(resolve => { release = resolve; });
      owner.child.exitCode = 0; owner.closed = true; return true;
    },
    /** Both loopback resources are attempted even when another cleanup failed. */
    async closeServer(resource) {
      calls.push('close_' + resource.kind);
      if (options.cleanupOverflow && resource.kind === 'proxy') fixtureBudget.counts.proxyConnections = LIMITS.proxyConnections;
      if (options.cleanupOverflow && resource.kind === 'proxy') {
        try { fixtureBudget.count('proxyConnections'); } catch { /* Incoming traffic must still latch overflow. */ }
      }
      if (options.serverCleanupFailure) throw new Error('PRIVATE_CLEANUP');
    },
  };
  return { deps, calls, writes, owners, get budget() { return fixtureBudget; }, finish: value => release(value) };
}

/** Execute the real CLI/preflight with synthetic input I/O, stopping at the occupied receipt before any native import. */
async function preflightHarness(options = {}) {
  const code = await fs.readFile(require.resolve('../full-isolation-qualification.cjs'), 'utf8'); const calls = [];
  const history = { ...HISTORY, ...options.history };
  if (options.missingHistory) delete history[options.missingHistory];
  const fakeFs = {
    /** Enforce the fixed execution root and reject redirected-directory tests. */
    async realpath(file) { assert.equal(file, DIRECTORY); return options.redirect ? DIRECTORY + '-redirected' : DIRECTORY; },
    /** Read only toolchain metadata; profile storage access fails this test. */
    async readFile(file) { assert.equal(path.basename(file), 'package.json'); calls.push('metadata');
      return JSON.stringify({ name: 'playwright-core', version: PIN.playwright, ...options.metadata }); },
    /** An occupied output proves reservation precedes runtime loading or profile creation. */
    async open(file, flag) { calls.push('reserve'); assert.equal(file, qualification.RESULT); assert.equal(flag, 'wx');
      throw Object.assign(new Error('synthetic occupied'), { code: 'EEXIST' }); },
  };
  const sandbox = { module: { exports: {} }, __dirname: DIRECTORY, Buffer, setTimeout, clearTimeout,
    process: { version: options.node || PIN.node, env: options.env || {} },
    /** Permit helper imports and standard libraries only; Playwright loading is always a test failure. */
    require(name) {
      if (name === 'node:fs/promises') return fakeFs;
      if (name.startsWith('node:')) return require(name);
      if (name === './request-client-isolation.cjs') return fixture;
      if (name === './page-lifecycle-diagnostic.cjs') return { ...diagnostic,
        packageHashes: async () => { calls.push('package'); return { ...PIN, ...options.package }; } };
      throw new Error('Unexpected native import');
    },
    /** Substitute only fixed toolchain hashes, without opening any native package. */
    readHash: async file => file.endsWith('coreBundle.js') ? options.bundle || PIN.bundle : options.executable || PIN.executable,
    /** Supply the test's deliberately stable or drifting source manifest. */
    readSources: async () => ({ files: {}, set: options.source || SOURCE }),
    /** Supply the exact predecessor map selected for this guard test. */
    readHistory: async () => history,
  };
  vm.runInNewContext(code + '\nhashFile = readHash; sourceHashes = readSources; historyHashes = readHistory;', sandbox);
  return { api: sandbox.module.exports, calls };
}

test('successful mocked qualification reuses one profile across two Chrome launches and every required case', async () => {
  const fake = harness(); const record = await runQualification(SOURCE, fake.deps);
  assert.equal(record.phase, 'passed'); assert.equal(record.firstFailure, null);
  assert.equal(record.localChecksPassed, true); assert.equal(record.isolationQualified, false);
  assert.equal(record.independentProcessExitVerified, false);
  assert.deepEqual(record.cleanupFailures, []); assert.equal(record.gate1Status, 'open');
  assert.equal(record.ownedBrowsersClosedNormally, true); assert.equal(record.priorEvidenceUnchanged, true);
  assert.equal(record.sourceSetUnchanged, true); assert.equal(record.syntheticProfilePreserved, true);
  assert.equal(Object.keys(record.checks).length, 11);
  assert.ok(Object.values(record.checks).every(Boolean));
  assert.deepEqual(record.counts, { launches: 2, fixtureRequests: 0, proxyConnections: 0,
    navigations: 3, requestClientCalls: 2, workerProbes: 2, pagesCreated: 3, versionReads: 2 });
  assert.deepEqual(fake.calls.slice(0, 5), ['preflight', 'reserve', 'runtime', 'profile', 'fixture']);
  assert.ok(fake.calls.indexOf('browser_close') < fake.calls.indexOf('restart'));
  assert.deepEqual(fake.calls.slice(fake.calls.indexOf('http'), fake.calls.indexOf('worker_session') + 1),
    ['http', 'https', 'probe_close', 'worker_session']);
  assert.deepEqual(fake.calls.slice(-4), ['close_proxy', 'close_fixture', 'write', 'handle_close']);
  assert.equal(fake.writes.length, 1); assert.ok(Buffer.byteLength(fake.writes[0]) < LIMITS.evidenceBytes);
  assert.doesNotMatch(fake.writes[0], /PRIVATE_|SYNTHETIC_UPDATED|127\.0\.0\.1|isolation-fixture-cft158-01-synthetic/);
  for (const owner of fake.owners) assert.equal(owner.context.listenerCount('page'), 0);
});

for (const [option, code, absent] of [
  ['seedNotFresh', 'synthetic_cookie_not_fresh', 'install'], ['baselineMissingHit', 'worker_baseline', 'restart'],
  ['cookieMissing', 'cookie_not_persistent', 'probe_create'], ['writebackMissing', 'request_cookie_writeback', 'probe_create'],
  ['closeIncomplete', 'probe_page_not_closed', 'worker_session'], ['extraPage', 'simultaneous_pages', 'http'],
  ['missingWorkerProxy', 'worker_network_isolation', null], ['workerOriginHit', 'worker_network_isolation', null],
  ['workerError', 'worker_evaluation_failed', null], ['invalidWorker', 'worker_probe_result', null],
  ['pageOriginHit', 'page_network_isolation', 'https'],
]) {
  test(option + ' stops the real sequence, preserves first failure and cleans owned resources', async () => {
    const fake = harness({ [option]: true, serverCleanupFailure: true }); const record = await runQualification(SOURCE, fake.deps);
    assert.equal(record.phase, 'stopped'); assert.equal(record.isolationQualified, false); assert.equal(record.firstFailure.code, code);
    if (absent) assert.ok(!fake.calls.includes(absent));
    assert.ok(fake.calls.includes('close_proxy')); assert.ok(fake.calls.includes('close_fixture'));
    assert.ok(record.cleanupFailures.includes('server_cleanup')); assert.doesNotMatch(fake.writes[0], /PRIVATE_/);
  });
}

for (const launch of [1, 2]) {
  test('wrong cached version on launch ' + launch + ' stops before further cases', async () => {
    const fake = harness({ wrongVersion: launch }); const record = await runQualification(SOURCE, fake.deps);
    assert.equal(record.firstFailure.code, 'toolchain_mismatch'); assert.equal(record.counts.launches, launch);
    assert.ok(!fake.calls.includes(launch === 1 ? 'seed_navigation' : '/api/check'));
  });
}

for (const [option, code] of [['historyChanged', 'history_mismatch'], ['sourcesChanged', 'source_mismatch'],
  ['profileMissing', 'profile_preservation'], ['serverCleanupFailure', 'server_cleanup'],
  ['browserCleanupFailure', 'first_browser_close'], ['cleanupOverflow', 'proxyConnections_budget']]) {
  test(option + ' cannot retain a passing qualification', async () => {
    const fake = harness({ [option]: true }); const record = await runQualification(SOURCE, fake.deps);
    assert.equal(record.phase, 'stopped'); assert.equal(record.firstFailure.code, code);
    if (option === 'browserCleanupFailure') { assert.equal(record.counts.launches, 1); assert.equal(record.ownedBrowsersClosedNormally, false); }
  });
}

for (const option of ['preflightFailure', 'occupied']) {
  test(option + ' prevents runtime loading, profile creation and browser ownership', async () => {
    const fake = harness({ [option]: true }); await assert.rejects(runQualification(SOURCE, fake.deps));
    assert.ok(!fake.calls.includes('runtime')); assert.equal(fake.owners.length, 0); assert.equal(fake.writes.length, 0);
  });
}

test('disk-write failure closes the reserved handle and cannot report success', async () => {
  const fake = harness({ writeFailure: true }); await assert.rejects(runQualification(SOURCE, fake.deps), /evidence_write/);
  assert.equal(fake.calls.at(-1), 'handle_close'); assert.equal(fake.writes.length, 0);
});

test('fixed CLI refuses overrides and its real preflight stops at occupied output', async () => {
  const fake = await preflightHarness();
  for (const args of [[], ['--fixture'], ['--fixture-cft158-02', '--source-set-sha256=' + SOURCE],
    ['--fixture-cft158-01', '--source-set-sha256=' + SOURCE, '--profile=saved'],
    ['--fixture-cft158-01', '--source-set-sha256=' + SOURCE, '--timeout=900001']]) {
    await assert.rejects(fake.api.main(args), /argument_required/);
  }
  assert.deepEqual(fake.calls, []);
  await assert.rejects(fake.api.main(['--fixture-cft158-01', '--source-set-sha256=' + SOURCE]), /evidence_already_exists/);
  assert.deepEqual(fake.calls, ['metadata', 'package', 'reserve']);
});

for (const [name, options, code] of [
  ['directory redirect', { redirect: true }, 'execution_directory'],
  ['debug logging', { env: { DEBUG: 'synthetic' } }, 'debug_logging_enabled'],
  ['Node version', { node: 'v0.0.0' }, 'toolchain_mismatch'],
  ['Playwright version', { metadata: { version: '0' } }, 'toolchain_mismatch'],
  ['bundle hash', { bundle: SOURCE }, 'toolchain_mismatch'], ['executable hash', { executable: SOURCE }, 'toolchain_mismatch'],
  ['package manifest', { package: { packageSet: SOURCE } }, 'package_mismatch'],
  ['source set', { source: 'b'.repeat(64) }, 'source_mismatch'],
  ['changed predecessor', { history: { 'csrf-diagnostic.json': SOURCE } }, 'history_mismatch'],
  ['additional predecessor', { history: { unexpected: SOURCE } }, 'history_mismatch'],
]) {
  test(name + ' drift fails before receipt reservation', async () => {
    const fake = await preflightHarness(options);
    await assert.rejects(fake.api.main(['--fixture-cft158-01', '--source-set-sha256=' + SOURCE]), new RegExp(code));
    assert.ok(!fake.calls.includes('reserve'));
  });
}

test('all fourteen predecessors are mandatory and cannot include the future output', async () => {
  assert.equal(Object.keys(HISTORY).length, 14); assert.ok(Object.isFrozen(HISTORY));
  assert.ok(!Object.hasOwn(HISTORY, path.basename(qualification.RESULT)));
  for (const name of Object.keys(HISTORY)) {
    const fake = await preflightHarness({ missingHistory: name });
    await assert.rejects(fake.api.preflight(SOURCE), /history_mismatch/);
    assert.ok(!fake.calls.includes('reserve'));
  }
  const names = []; assert.equal(qualification.historyMatches(await qualification.historyHashes(async file => {
    names.push(path.basename(file)); return HISTORY[path.basename(file)];
  })), true);
  assert.deepEqual(names, Object.keys(HISTORY));
});

test('source digest covers all six inputs including reused validators', async () => {
  assert.equal(SOURCE_FILES.length, 6); const seen = [];
  const first = await qualification.sourceHashes(async file => { seen.push(path.relative(path.join(__dirname, '..'), file).replaceAll('\\', '/')); return SOURCE; });
  assert.deepEqual(seen, SOURCE_FILES);
  for (const changed of SOURCE_FILES) {
    const next = await qualification.sourceHashes(async file => file.endsWith(changed.replaceAll('/', path.sep)) ? 'b'.repeat(64) : SOURCE);
    assert.notEqual(first.set, next.set);
  }
});

test('concurrent reservation admits only one invocation and never truncates the occupied output', async t => {
  let consumed = false; let closed = 0;
  t.mock.method(fs, 'open', async (file, flag) => {
    assert.equal(file, qualification.RESULT); assert.equal(flag, 'wx');
    if (consumed) throw Object.assign(new Error('occupied'), { code: 'EEXIST' });
    consumed = true; return { close: async () => { closed++; } };
  });
  const results = await Promise.allSettled([qualification.reserveEvidence(), qualification.reserveEvidence()]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'evidence_already_exists'); await results[0].value.close(); assert.equal(closed, 1);
});

test('late exclusive reservation is closed and cannot start native setup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 }); let finish; let closed = 0;
  t.mock.method(fs, 'open', () => new Promise(resolve => { finish = resolve; }));
  const pending = assert.rejects(qualification.reserveEvidence(), /operation_timeout/); await nextTurn();
  t.mock.timers.tick(5000); await pending; finish({ close: async () => { closed++; } }); await nextTurn(); assert.equal(closed, 1);
});

test('native boundary always selects Chrome regardless of injected browser argument', async t => {
  const selected = []; t.mock.method(fixture, 'launchFixtureBrowser', async args => { selected.push(args.browser); });
  const deps = qualification.nativeDependencies(); await deps.launch({ browser: 'edge' }); await deps.launch({ browser: 'arbitrary' });
  assert.deepEqual(selected, ['cft158', 'cft158']);
});

test('budgets reject every extra scripted operation and incoming overflow remains counted after stop', () => {
  for (const name of Object.keys(new QualificationBudget().counts)) {
    const budget = new QualificationBudget(); budget.counts[name] = LIMITS[name];
    assert.throws(() => budget.count(name)); assert.equal(budget.failure, name + '_budget');
  }
  const budget = new QualificationBudget(); budget.halted = true; budget.counts.proxyConnections = LIMITS.proxyConnections;
  assert.throws(() => budget.count('proxyConnections')); assert.equal(budget.counts.proxyConnections, 201);
  budget.stop(new fixture.IsolationError('worker_probe_timeout'), 'cases');
  assert.equal(budget.firstFailure.code, 'proxyConnections_budget');
});

for (const option of ['hangRequest', 'hangStart', 'hangWorker', 'missingWorker']) {
  test(option + ' stops at five seconds and a late completion cannot resume cases or rewrite evidence', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const fake = harness({ [option]: true }); const pending = runQualification(SOURCE, fake.deps); await nextTurn();
    t.mock.timers.tick(5000); await nextTurn(); const record = await pending;
    assert.equal(record.phase, 'stopped'); const before = fake.calls.slice(); const evidence = fake.writes[0];
    if (option !== 'missingWorker') { fake.finish({ status: null, reached: false, errorCategory: 'fetch_rejected', cookiePresent: false }); await nextTurn(); }
    assert.deepEqual(fake.calls, before); assert.equal(fake.writes[0], evidence);
    assert.ok(!fake.calls.includes(option === 'hangRequest' ? 'install' : option === 'hangStart' ? 'restored_probe' : 'impossible'));
    if (option === 'hangWorker') assert.ok(!record.checks.restoredWorkerBlockedAtProxy);
  });
}

test('outer working deadline prevents late setup from launching a browser', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const fake = harness(); let finish; fake.deps.profile = () => new Promise(resolve => { finish = resolve; });
  const pending = runQualification(SOURCE, fake.deps); await nextTurn(); t.mock.timers.tick(LIMITS.wholeMs - LIMITS.cleanupReserveMs);
  const record = await pending; assert.equal(record.firstFailure.code, 'fixture_deadline');
  const before = fake.calls.slice(); finish(path.join(DIRECTORY, 'isolation-fixture-late')); await nextTurn();
  assert.deepEqual(fake.calls, before); assert.equal(fake.owners.length, 0);
});

test('hung browser cleanup respects its allocation and still closes both servers and writes stopped evidence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const fake = harness({ hangCleanup: true }); const pending = runQualification(SOURCE, fake.deps); await nextTurn();
  t.mock.timers.tick(LIMITS.browserCleanupMs); const record = await pending;
  assert.equal(record.firstFailure.code, 'browser_cleanup'); assert.equal(record.ownedBrowsersClosedNormally, false);
  assert.ok(fake.calls.includes('close_proxy')); assert.ok(fake.calls.includes('close_fixture'));
  const before = fake.calls.slice(); fake.finish(true); await nextTurn(); assert.deepEqual(fake.calls, before);
});

test('evidence overflow emits bounded stopped scalars and excludes arbitrary content', () => {
  const budget = new QualificationBudget(); const record = { phase: 'passed', arbitrary: 'PRIVATE_'.repeat(30000) };
  const text = qualification.encodeEvidence(record, budget); const result = JSON.parse(text);
  assert.equal(result.phase, 'stopped'); assert.equal(result.firstFailure.code, 'evidence_size_limit');
  assert.equal(result.isolationQualified, false); assert.ok(Buffer.byteLength(text) < LIMITS.evidenceBytes); assert.doesNotMatch(text, /PRIVATE_/);
});
