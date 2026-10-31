'use strict';
/* global Buffer, Response, __dirname, __filename */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { IsolationError, FixtureBudget, WorkerDiagnostics, bounded, isolationArguments, loopbackOrigin, classifyWorker,
  summarizeWorkers, classifyProxyLine, startFixtureServer, startRejectingProxy, closeServer, requestFixture, closeOwned,
  workerProbe, captureWorkerProbe, evidenceHashes, sourceHashes, main } = require('../request-client-isolation.cjs');

/** Create generous local-only test limits without a browser or filesystem mutation. */
function testBudget(overrides = {}, clock = Date.now) {
  return new FixtureBudget({ wholeMs: 10000, launches: 2, fixtureRequests: 10, proxyConnections: 10, ...overrides }, clock);
}

/** Exercise a proxy rejection through loopback TCP and return no submitted request bytes. */
async function proxyExchange(port, line) {
  return bounded(() => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1'); let response = '';
    socket.once('connect', () => socket.write(`${line}\r\nHost: synthetic.invalid\r\n\r\n`));
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.once('end', () => { socket.destroy(); resolve(response); });
    socket.once('error', reject);
  }), 2000);
}

/**
 * Hold native listen until the test releases it, reproducing startup after cleanup.
 * Keep the real server for loopback assertions and always close it, even on failure.
 */
function delayedStartup(t, start, budget, servers) {
  const listen = net.Server.prototype.listen; let server; let resume; let released = false;
  t.mock.method(net.Server.prototype, 'listen', function (...args) {
    server = this; resume = () => listen.apply(this, args); return this;
  });
  const startup = start(budget, servers);
  t.after(async () => {
    if (!released) resume();
    await startup.catch(() => {});
    await closeServer({ server, sockets: new Set() });
  });
  return { startup, server, release: () => { released = true; resume(); } };
}

/** Run the real serialized worker callback with synthetic fetch only; no browser or network is used. */
function syntheticWorker(fetchImplementation) {
  return { evaluate: async (callback, url) => {
    assert.equal(url, 'http://127.0.0.1:1234/probe?kind=worker');
    return vm.runInNewContext(`(${callback.toString()})(url)`, { fetch: fetchImplementation, url });
  } };
}

test('proxy arguments contain exactly one proxy and subtract implicit bypasses', () => {
  assert.deepEqual(isolationArguments(8001), ['--proxy-server=http://127.0.0.1:8001', '--proxy-bypass-list=<-loopback>']);
  assert.deepEqual(isolationArguments(8001, 'http://127.0.0.1:8002'), ['--proxy-server=http://127.0.0.1:8001', '--proxy-bypass-list=<-loopback>;127.0.0.1:8002']);
});

test('invalid ports cannot inject a fallback or extra command-line option', () => {
  for (const port of [0, -1, 65536, 1.5, '8080', '8080,direct://', NaN]) assert.throws(() => isolationArguments(port), /invalid_proxy_port/);
});

test('seed bypass permits only the exact synthetic loopback origin', () => {
  assert.equal(loopbackOrigin('http://127.0.0.1:1234').host, '127.0.0.1:1234');
  for (const origin of ['https://example.invalid', 'http://127.0.0.1.example.invalid:1234', 'http://localhost:1234',
    'http://user:secret@127.0.0.1:1234', 'http://127.0.0.1:1234/path', 'http://127.0.0.1:1234/?x=1', 'http://127.0.0.1:1234/#x']) {
    assert.throws(() => isolationArguments(1234, origin), /invalid_fixture_origin/);
  }
});

test('worker classification does not expose identifiers or confuse suffix origins', () => {
  const origin = 'http://127.0.0.1:1234';
  for (const [raw, expected] of [[origin + '/sw.js', 'fixture'], ['chrome-extension://private-id/private-path', 'extension'],
    ['https://private.invalid/private?q=secret', 'other_web'], ['data:text/javascript,private', 'other'], ['bad URL', 'unparseable']])
    assert.equal(classifyWorker(raw, origin), expected);
  const result = summarizeWorkers([{ url: () => 'chrome-extension://private-id/file' }, { url: () => origin + '/sw.js' }], origin);
  assert.equal(result.fixture, 1); assert.equal(result.extension, 1);
  assert.ok(!JSON.stringify(result).includes('private'));
});

for (const status of [200, 204, 404, 502]) {
  test(`worker probe reads native Fetch status ${status} as a property and retains its outcome`, async () => {
    let calls = 0;
    const worker = syntheticWorker(async (url, options) => {
      calls++; assert.equal(url, 'http://127.0.0.1:1234/probe?kind=worker');
      assert.equal(options.cache, 'no-store');
      return new Response(null, { status });
    });
    const probes = {}; const result = await captureWorkerProbe(worker, 'http://127.0.0.1:1234', probes, 'baseline');
    const reached = status < 300;
    assert.deepEqual(result, { status, reached, errorCategory: reached ? null : 'http_error' });
    assert.equal(probes.baseline, result); assert.equal(calls, 1); assert.equal(Object.isFrozen(result), true);
  });
}

test('worker fetch rejection retains a fixed category without its raw message', async () => {
  const worker = syntheticWorker(async () => { throw new Error('private.invalid/cookie-value'); });
  const probes = {}; const result = await captureWorkerProbe(worker, 'http://127.0.0.1:1234', probes, 'restored');
  assert.deepEqual(result, { status: null, reached: false, errorCategory: 'fetch_rejected' });
  assert.equal(probes.restored, result); assert.equal(JSON.stringify(probes).includes('private'), false);
});

test('worker evaluation rejection is recorded before stopping instead of qualifying isolation', async () => {
  const worker = { evaluate: async () => { throw new Error('private evaluation URL'); } };
  const probes = {};
  await assert.rejects(captureWorkerProbe(worker, 'http://127.0.0.1:1234', probes, 'restored'), /worker_evaluation_failed/);
  assert.deepEqual(probes.restored, { status: null, reached: false, errorCategory: 'evaluation_failed' });
  assert.equal(JSON.stringify(probes).includes('private'), false);
});

/**
 * Exercise real orchestration, diagnostics and probe guards with synthetic browser/server/evidence I/O.
 * Inject a failure at one operation; retain calls and serialized receipts without launching or writing.
 */
async function simulatedFixture({ failOperation = null, failureCode = null, browserTimeout = false,
  baselineFailure = false, cleanupFailure = false, missingProxyEvidence = false, detachFailure = false } = {}) {
  const helperPath = require.resolve('../request-client-isolation.cjs');
  const source = await fs.readFile(helperPath, 'utf8'); const writes = []; const calls = []; const closed = [];
  const origin = 'http://127.0.0.1:1234'; let loaded; let fixture; let proxy;
  /** Mark only the selected restored operation and inject private errors for redaction assertions. */
  function step(operation) {
    calls.push(operation);
    if (operation !== failOperation) return;
    if (failureCode) throw new loaded.IsolationError(failureCode);
    const error = new Error('PRIVATE_OPERATION https://private.invalid/cookie');
    if (browserTimeout) error.name = 'TimeoutError';
    throw error;
  }
  const fixtureFs = {
    /** Allow a new synthetic receipt without inspecting existing evidence. */
    async access() { throw Object.assign(new Error('synthetic missing receipt'), { code: 'ENOENT' }); },
    /** Supply stable synthetic bytes for both provenance and historical evidence hashes. */
    async readFile() { return Buffer.from('synthetic evidence'); },
    /** Model a fresh profile without creating browser storage. */
    async mkdtemp(prefix) { return `${prefix}synthetic`; },
    /** Preserve the profile invariant without inspecting a real profile. */
    async stat() { return {
      /** Report the synthetic directory created by mkdtemp above. */
      isDirectory() { return true; },
    }; },
    /** Capture the serialized receipt, including its exclusive-write contract, for inspection below. */
    async writeFile(file, contents, options) {
      assert.equal(file, loaded.RESULT); assert.deepEqual(options, { flag: 'wx' }); writes.push(contents);
    },
  };
  const replacements = {
    /** Model the loopback origin and register its ownership without opening a listener. */
    async startFixtureServer(budget, servers) {
      fixture = { kind: 'fixture', origin, counts: { page: 0, worker: 0, check: 0, seed: 0 } };
      servers.push(fixture); return fixture;
    },
    /** Model only the proxy counters checked by real qualification guards. */
    async startRejectingProxy(budget, fixtureOrigin, servers) {
      assert.equal(fixtureOrigin, origin);
      proxy = { kind: 'proxy', port: 1235, counts: { page: 0, worker: 0, fixtureConnect: 0, other: 0 } };
      servers.push(proxy); return proxy;
    },
    /** Record each cleanup even when a synthetic cleanup failure follows the primary stop. */
    async closeServer(resource) {
      closed.push(resource.kind);
      if (cleanupFailure) throw new Error('PRIVATE_CLEANUP');
    },
    /** Supply two fake launches while retaining real budget, worker selection and Browser.close handling. */
    async launchFixtureBrowser({ seedOrigin, budget, owners }) {
      budget.count('launches'); const restored = seedOrigin === null; let discovered = false;
      const worker = {
        /** Identify the exact synthetic worker without consulting browser storage. */
        url() { return `${origin}/sw.js`; },
        /** Keep real probe validation while supplying only synthetic fetch results or evaluation errors. */
        async evaluate() {
          if (!restored) {
            if (baselineFailure) throw new Error('PRIVATE_WORKER_EVALUATION');
            fixture.counts.worker++; return { status: 200, reached: true, errorCategory: null };
          }
          step('worker_probe');
          if (!missingProxyEvidence) proxy.counts.worker++;
          return { status: null, reached: false, errorCategory: 'fetch_rejected' };
        },
      };
      const cdp = {
        /** Verify real protocol calls and inject errors without sending a CDP command. */
        async send(method, params) {
          if (method === 'ServiceWorker.enable') step('worker_enable');
          else {
            assert.equal(method, 'ServiceWorker.startWorker'); assert.deepEqual(params, { scopeURL: `${origin}/` });
            step('worker_start');
          }
        },
        /** Distinguish a later detach failure from the already completed worker operations. */
        async detach() { if (detachFailure) throw new Error('PRIVATE_DETACH'); },
      };
      const owner = { child: { exitCode: null }, context: {
        /** Let the real worker lookup run and inject a discovery failure only in the restored phase. */
        serviceWorkers() {
          if (restored && !discovered) { step('worker_discovery'); discovered = true; }
          return [worker];
        },
        /** Supply the synthetic write-back invariant, never saved authentication cookies. */
        async cookies() { return [{ name: 'isolation_fixture', value: 'SYNTHETIC_UPDATED' }]; },
        /** Model page-session attachment at its actual position in the fixture. */
        async newCDPSession(page) { assert.equal(page, owner.keeper); step('cdp_session'); return cdp; },
      }, keeper: {
        /** Model baseline navigation and successful proxy probes before the blank-page diagnostic. */
        async goto(url, options) {
          assert.equal(options.timeout, 5000);
          if (url === 'about:blank') { step('blank_navigation'); return null; }
          if (restored) {
            if (url.startsWith('https:')) proxy.counts.fixtureConnect++; else proxy.counts.page++;
          }
          return {
            /** Return only the synthetic response status required by the real page probe. */
            status() { return 502; },
          };
        },
        /** Model worker installation so the real baseline probe is reached. */
        async evaluate() { return true; },
      }, browser: {
        /** Keep the real cleanup path active until its synthetic process exits. */
        isConnected() { return owner.child.exitCode === null; },
        /** Permit only normal Browser.close; cleanup never kills a process or deletes a profile. */
        async newBrowserCDPSession() { return {
          /** Record normal close and let the real exit check complete. */
          async send(method) {
            assert.equal(method, 'Browser.close'); owner.child.exitCode = 0; closed.push(restored ? 'second_browser' : 'first_browser');
          },
        }; },
      } };
      owners.push(owner); return owner;
    },
    /** Supply synthetic cookie state for both request-client phases without sending a request. */
    async requestFixture(context, origin, endpoint) {
      assert.ok(['/api/seed', '/api/check'].includes(endpoint)); return { cookiePresent: endpoint === '/api/check' };
    },
  };
  /** Replace filesystem/toolchain loading while retaining the helper's real Node dependencies. */
  function fixtureRequire(name) {
    if (name === 'node:fs/promises') return fixtureFs;
    if (name.startsWith('node:')) return require(name);
    if (name === loaded.CORE) return {};
    assert.equal(name, path.join(loaded.CORE, 'package.json'));
    return { name: 'playwright-core', version: loaded.CORE_VERSION };
  }
  loaded = vm.compileFunction(`${source}\nlaunchFixtureBrowser = replacements.launchFixtureBrowser;
    startFixtureServer = replacements.startFixtureServer; startRejectingProxy = replacements.startRejectingProxy;
    closeServer = replacements.closeServer; requestFixture = replacements.requestFixture;
    return { runFixture, CORE, CORE_VERSION, RESULT, IsolationError };`,
  ['require', 'module', '__dirname', 'replacements'], { filename: helperPath })(fixtureRequire, { exports: {} }, path.dirname(helperPath), replacements);
  await loaded.runFixture();
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0], /PRIVATE_|private\.invalid/);
  return { receipt: JSON.parse(writes[0]), calls, closed };
}

test('fixture receipt retains a baseline worker evaluation failure after stopping and cleanup', async () => {
  const { receipt, calls, closed } = await simulatedFixture({ baselineFailure: true });
  assert.equal(receipt.phase, 'stopped'); assert.equal(receipt.stopCode, 'worker_evaluation_failed');
  assert.deepEqual(receipt.workerProbes, { baseline: { status: null, reached: false, errorCategory: 'evaluation_failed' } });
  assert.equal(receipt.counts.launches, 1); assert.equal(receipt.ownedBrowsersClosedNormally, true);
  assert.equal(receipt.checks.workerBaselineReachedFixture, undefined);
  assert.equal(receipt.checks.restoredWorkerBlockedAtProxy, undefined);
  assert.equal(receipt.restoredWorkerFailure, null); assert.deepEqual(calls, []);
  assert.deepEqual(closed, ['first_browser', 'proxy', 'fixture']);
});

const restoredOperations = ['blank_navigation', 'cdp_session', 'worker_enable', 'worker_start', 'worker_discovery', 'worker_probe'];
for (const [index, operation] of restoredOperations.entries()) {
  test(`stopped receipt identifies ${operation}, preserves probes and closes owned resources`, async () => {
    const { receipt, calls, closed } = await simulatedFixture({ failOperation: operation });
    assert.equal(receipt.phase, 'stopped');
    assert.equal(receipt.stopCode, operation === 'worker_probe' ? 'worker_evaluation_failed' : 'fixture_operation_failed');
    assert.equal(receipt.restoredWorkerFailure.operation, operation);
    assert.equal(receipt.restoredWorkerFailure.errorCategory, operation === 'worker_probe' ? 'guard' : 'other');
    assert.ok(Number.isInteger(receipt.restoredWorkerFailure.elapsedMs) && receipt.restoredWorkerFailure.elapsedMs >= 0);
    assert.deepEqual(Object.keys(receipt.restoredWorkerFailure).sort(), ['elapsedMs', 'errorCategory', 'operation']);
    assert.deepEqual(calls, restoredOperations.slice(0, index + 1));
    assert.deepEqual(closed, ['first_browser', 'second_browser', 'proxy', 'fixture']);
    assert.equal(receipt.ownedBrowsersClosedNormally, true); assert.equal(receipt.priorEvidenceUnchanged, true);
    assert.equal(receipt.checks.httpsConnectBlockedAtProxy, true); assert.equal(receipt.checks.restoredWorkerBlockedAtProxy, undefined);
    assert.deepEqual(receipt.workerProbes.baseline, { status: 200, reached: true, errorCategory: null });
    assert.deepEqual(receipt.workerProbes.restored, operation === 'worker_probe'
      ? { status: null, reached: false, errorCategory: 'evaluation_failed' } : undefined);
  });
}

for (const [operation, failureCode] of [['cdp_session', 'worker_session_timeout'], ['worker_enable', 'operation_timeout'],
  ['worker_start', 'worker_restart_timeout'], ['worker_discovery', 'fixture_worker_unavailable']]) {
  test(`stopped receipt retains ${operation}'s existing timeout code and sanitized category`, async () => {
    const { receipt } = await simulatedFixture({ failOperation: operation, failureCode });
    assert.equal(receipt.stopCode, failureCode); assert.equal(receipt.restoredWorkerFailure.operation, operation);
    assert.equal(receipt.restoredWorkerFailure.errorCategory, 'timeout');
  });
}

test('browser navigation timeout is attributed without retaining the private browser error', async () => {
  const { receipt } = await simulatedFixture({ failOperation: 'blank_navigation', browserTimeout: true });
  assert.equal(receipt.stopCode, 'fixture_operation_failed');
  assert.equal(receipt.restoredWorkerFailure.operation, 'blank_navigation');
  assert.equal(receipt.restoredWorkerFailure.errorCategory, 'timeout');
});

test('restored fetch rejection still requires proxy evidence and retains its guard failure', async () => {
  const { receipt } = await simulatedFixture({ missingProxyEvidence: true });
  assert.equal(receipt.stopCode, 'worker_network_isolation');
  assert.equal(receipt.restoredWorkerFailure.operation, 'worker_probe');
  assert.equal(receipt.restoredWorkerFailure.errorCategory, 'guard');
  assert.equal(receipt.workerProbes.restored.errorCategory, 'fetch_rejected');
  assert.equal(receipt.checks.restoredWorkerBlockedAtProxy, undefined);
});

test('cleanup failure cannot replace the first operation failure in the serialized receipt', async () => {
  const { receipt, closed } = await simulatedFixture({ failOperation: 'worker_start', cleanupFailure: true });
  assert.equal(receipt.stopCode, 'fixture_operation_failed'); assert.equal(receipt.cleanupFailure, 'local_server_close');
  assert.equal(receipt.restoredWorkerFailure.operation, 'worker_start');
  assert.equal(receipt.restoredWorkerFailure.errorCategory, 'other');
  assert.deepEqual(closed, ['first_browser', 'second_browser', 'proxy', 'fixture']);
});

test('successful synthetic orchestration has no failure diagnostic and retains every isolation guard', async () => {
  const { receipt, calls } = await simulatedFixture();
  assert.equal(receipt.phase, 'passed'); assert.equal(receipt.restoredWorkerFailure, null);
  assert.equal(receipt.checks.restoredWorkerBlockedAtProxy, true); assert.deepEqual(calls, restoredOperations);
});

test('a later detach failure is not misattributed to the completed worker probe', async () => {
  const { receipt } = await simulatedFixture({ detachFailure: true });
  assert.equal(receipt.phase, 'stopped'); assert.equal(receipt.restoredWorkerFailure, null);
  assert.equal(receipt.checks.restoredWorkerBlockedAtProxy, true);
});

test('operation timeout freezes its first diagnostic and rejects later work and late completion', async () => {
  const record = {}; const diagnostics = new WorkerDiagnostics(record, testBudget()); let finish;
  await assert.rejects(diagnostics.run('cdp_session', () => bounded(() => new Promise(resolve => { finish = resolve; }),
    5, 'worker_session_timeout')), /worker_session_timeout/);
  const stopped = record.restoredWorkerFailure;
  assert.equal(Object.isFrozen(stopped), true); assert.equal(stopped.errorCategory, 'timeout');
  finish('PRIVATE_LATE'); await Promise.resolve();
  diagnostics.stop(new Error('PRIVATE_SECOND_ERROR'));
  let laterCalled = false;
  await assert.rejects(diagnostics.run('worker_enable', async () => { laterCalled = true; }), /worker_operation_stopped/);
  assert.equal(laterCalled, false); assert.equal(record.restoredWorkerFailure, stopped);
});

test('outer deadline captures the active operation and prevents a late success continuing', async () => {
  const record = {}; const budget = testBudget(); let now = 100; let finish;
  const diagnostics = new WorkerDiagnostics(record, budget, () => now);
  const pending = diagnostics.run('worker_start', () => new Promise(resolve => { finish = resolve; }));
  now = 125; diagnostics.stop(new IsolationError('fixture_deadline')); budget.failure = 'fixture_deadline';
  const stopped = record.restoredWorkerFailure;
  assert.deepEqual(stopped, { operation: 'worker_start', errorCategory: 'timeout', elapsedMs: 25 });
  finish(); await assert.rejects(pending, /fixture_deadline/);
  assert.equal(record.restoredWorkerFailure, stopped); assert.equal(Object.isFrozen(stopped), true);
  assert.equal(diagnostics.active, null);
});

test('unrecognized operation labels are rejected before action execution or evidence capture', async () => {
  const record = {}; const diagnostics = new WorkerDiagnostics(record, testBudget()); let called = false;
  await assert.rejects(diagnostics.run('PRIVATE_URL', async () => { called = true; }), /worker_operation/);
  assert.equal(called, false); assert.equal(record.restoredWorkerFailure, undefined);
});

test('worker timeout stops after the fixed deadline and a late completion cannot change the receipt', async () => {
  let finish;
  const worker = { evaluate: () => new Promise(resolve => { finish = resolve; }) };
  const probes = {}; const record = { workerProbes: probes }; const diagnostics = new WorkerDiagnostics(record, testBudget());
  await assert.rejects(diagnostics.run('worker_probe',
    () => captureWorkerProbe(worker, 'http://127.0.0.1:1234', probes, 'restored')), /worker_probe_timeout/);
  const stopped = probes.restored;
  const failure = record.restoredWorkerFailure;
  assert.equal(failure.operation, 'worker_probe'); assert.equal(failure.errorCategory, 'timeout');
  assert.deepEqual(stopped, { status: null, reached: false, errorCategory: 'timeout' });
  finish({ status: 200, reached: true, errorCategory: null });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(probes.restored, stopped); assert.equal(Object.isFrozen(stopped), true);
  assert.equal(stopped.reached, false);
  assert.equal(record.restoredWorkerFailure, failure); assert.equal(Object.isFrozen(failure), true);
});

test('malformed or inconsistent worker results stop without retaining arbitrary data', async () => {
  for (const result of [null, { status: 'private status', reached: false, errorCategory: 'private category' },
    { status: 200, reached: false, errorCategory: 'http_error' }, { status: 502, reached: true, errorCategory: null }]) {
    const probes = {};
    await assert.rejects(captureWorkerProbe({ evaluate: async () => result }, 'http://127.0.0.1:1234', probes, 'baseline'), /worker_probe_result/);
    assert.deepEqual(probes.baseline, { status: null, reached: false, errorCategory: 'invalid_result' });
  }
});

test('worker result projection excludes extra browser data', async () => {
  const result = await workerProbe({ evaluate: async () => ({ status: 200, reached: true, errorCategory: null,
    url: 'private.invalid', cookie: 'private value' }) }, 'http://127.0.0.1:1234');
  assert.deepEqual(result, { status: 200, reached: true, errorCategory: null });
});

test('evidence preservation includes both stopped fixtures and never hashes the future result as history', async t => {
  const names = [];
  t.mock.method(fs, 'readFile', async file => { names.push(path.basename(file)); return Buffer.from('synthetic receipt'); });
  const hashes = await evidenceHashes();
  assert.deepEqual(names, ['staged-result.json', 'staged-result-attempt2.json', 'alias-restoration.json',
    'promotion-result.json', 'free-checkout-result.json', 'free-checkout-result-attempt2.json', 'csrf-diagnostic.json',
    'browser-isolation-fixture.json', 'browser-isolation-fixture-attempt2.json']);
  assert.deepEqual(Object.keys(hashes), names);
  for (const hash of Object.values(hashes)) assert.match(hash, /^[a-f0-9]{64}$/);
});

test('source provenance hashes this helper and its adjacent test bytes', async () => {
  const hashes = await sourceHashes();
  const helper = await fs.readFile(path.join(__dirname, '../request-client-isolation.cjs'));
  const tests = await fs.readFile(__filename);
  assert.deepEqual(hashes, { helper: crypto.createHash('sha256').update(helper).digest('hex'),
    tests: crypto.createHash('sha256').update(tests).digest('hex') });
});

test('an existing replacement receipt stops before toolchain loading or browser creation', async t => {
  let checks = 0;
  t.mock.method(fs, 'access', async file => {
    checks++; assert.equal(path.basename(file), 'browser-isolation-fixture-attempt3.json');
  });
  await assert.rejects(main(['--fixture']), /evidence_already_exists/);
  assert.equal(checks, 1);
});

test('proxy classifications use exact fixture targets and retain no raw line', () => {
  const origin = 'http://127.0.0.1:1234';
  assert.equal(classifyProxyLine(`GET ${origin}/probe?kind=worker HTTP/1.1`, origin), 'worker');
  assert.equal(classifyProxyLine(`GET ${origin}/probe?kind=page HTTP/1.1`, origin), 'page');
  assert.equal(classifyProxyLine('CONNECT 127.0.0.1:1234 HTTP/1.1', origin), 'fixtureConnect');
  assert.equal(classifyProxyLine('CONNECT private.invalid:443 HTTP/1.1', origin), 'other');
  assert.equal(classifyProxyLine('GET http://127.0.0.1:9999/probe?kind=page HTTP/1.1', origin), 'other');
});

test('budget latches failure and rejects a third launch', () => {
  const budget = testBudget(); budget.count('launches'); budget.count('launches');
  assert.throws(() => budget.count('launches'), /launches_budget/);
  assert.equal(budget.counts.launches, 3);
  assert.throws(() => budget.count('fixtureRequests'), /launches_budget/);
  assert.equal(budget.counts.fixtureRequests, 0);
});

test('deadline stops exactly at the boundary', () => {
  let now = 100; const budget = testBudget({ wholeMs: 10 }, () => now);
  now = 109; budget.check(); now = 110; assert.throws(() => budget.check(), /fixture_deadline/);
});

test('bounded operations propagate results and reject stalled work', async () => {
  assert.equal(await bounded(async () => 42, 100), 42);
  await assert.rejects(bounded(() => new Promise(() => {}), 5, 'synthetic_timeout'), /synthetic_timeout/);
  await assert.rejects(bounded(async () => { throw new IsolationError('synthetic_failure'); }, 100), /synthetic_failure/);
});

for (const [name, start] of [
  ['fixture', startFixtureServer],
  ['proxy', (budget, servers) => startRejectingProxy(budget, 'http://127.0.0.1:1234', servers)],
]) {
  test(`${name} registers before listening and preserves ownership on success`, async t => {
    const servers = []; const pending = delayedStartup(t, start, testBudget(), servers);
    assert.equal(servers.length, 1);
    assert.equal(servers[0].server, pending.server);
    assert.equal(pending.server.listening, false);
    pending.release();
    const resource = await pending.startup;
    assert.equal(resource, servers[0]);
    assert.equal(resource.server.listening, true);
    await closeServer(resource);
    assert.equal(resource.server.listening, false);
    assert.equal(resource.sockets.size, 0);
  });

  test(`${name} closes startup that finishes after bounded timeout and cleanup`, async t => {
    const servers = []; const budget = testBudget(); const pending = delayedStartup(t, start, budget, servers);
    await assert.rejects(bounded(() => pending.startup, 5, 'fixture_deadline').catch(error => {
      // Mirror runFixture's failure latch before its finally block cleans owned servers.
      budget.failure = error.code; throw error;
    }), /fixture_deadline/);
    for (const resource of servers) await closeServer(resource);
    pending.release();
    await assert.rejects(pending.startup, /fixture_deadline/);
    assert.equal(pending.server.listening, false);
    assert.equal(servers[0].sockets.size, 0);
  });

  test(`${name} does not create a server after the fixture has stopped`, async () => {
    const servers = []; const budget = testBudget(); budget.failure = 'fixture_deadline';
    await assert.rejects(start(budget, servers), /fixture_deadline/);
    assert.equal(servers.length, 0);
  });
}

test('rejecting proxy blocks HTTP and CONNECT without opening an upstream socket', async () => {
  const budget = testBudget(); const origin = 'http://127.0.0.1:1234'; const proxy = await startRejectingProxy(budget, origin);
  try {
    assert.match(await proxyExchange(proxy.port, `GET ${origin}/probe?kind=page HTTP/1.1`), /^HTTP\/1.1 502/);
    assert.match(await proxyExchange(proxy.port, 'CONNECT 127.0.0.1:1234 HTTP/1.1'), /^HTTP\/1.1 502/);
    assert.deepEqual(proxy.counts, { page: 1, worker: 0, fixtureConnect: 1, other: 0 });
    assert.equal(budget.counts.proxyConnections, 2);
  } finally { await closeServer(proxy); }
  assert.equal(proxy.server.listening, false); assert.equal(proxy.sockets.size, 0);
});

test('request client uses only the fixed loopback origin, no redirects/retries, and disposes', async () => {
  let disposed = 0; let calls = 0;
  const context = { request: { get: async (url, options) => {
    calls++; assert.equal(url, 'http://127.0.0.1:1234/api/check');
    assert.deepEqual(options, { maxRedirects: 0, maxRetries: 0, timeout: 5000 });
    return { status: () => 200, json: async () => ({ synthetic: true, cookiePresent: true }), dispose: async () => { disposed++; } };
  } } };
  assert.deepEqual(await requestFixture(context, 'http://127.0.0.1:1234', '/api/check'), { cookiePresent: true });
  assert.equal(calls, 1); assert.equal(disposed, 1);
  await assert.rejects(requestFixture(context, 'https://example.invalid', '/api/check'), /invalid_fixture_origin/);
  await assert.rejects(requestFixture(context, 'http://127.0.0.1:1234', '/billing/checkout'), /fixture_endpoint/);
  assert.equal(calls, 1);
});

test('failed fixture response is disposed and cannot be treated as valid cookies', async () => {
  let disposed = false;
  const context = { request: { get: async () => ({ status: () => 401, dispose: async () => { disposed = true; } }) } };
  await assert.rejects(requestFixture(context, 'http://127.0.0.1:1234', '/api/check'), /fixture_request_status/);
  assert.equal(disposed, true);
});

test('cleanup sends normal Browser.close and never kills or removes a profile', async () => {
  const child = { exitCode: null, kill: () => { throw new Error('kill must not be called'); } };
  const calls = []; const owner = { child, closed: false, browser: { isConnected: () => true,
    newBrowserCDPSession: async () => ({ send: async method => { calls.push(method); child.exitCode = 0; } }) } };
  assert.equal(await closeOwned(owner, {}), true); assert.deepEqual(calls, ['Browser.close']);
  assert.equal(await closeOwned(owner, {}), true); assert.equal(calls.length, 1);
});

test('CLI refuses arbitrary profiles, targets, or an unapproved default run', async () => {
  await assert.rejects(main([]), /local_fixture_argument_required/);
  await assert.rejects(main(['--fixture', '--profile=saved']), /local_fixture_argument_required/);
  await assert.rejects(main(['--hosted']), /local_fixture_argument_required/);
});
