'use strict';

// All HTTP is mocked. PowerShell integration runs preparation or a mocked stopped report only.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const runner = require('../../../scripts/gate1-host-protection.js');
const { HOSTS, TARGET, CANONICAL, LIMITS, BATCHES, BATCH_SIZES, INVENTORY_ID, INVENTORY_SHA256 } = runner;
const launcher = path.resolve(__dirname, '../../../scripts/run-gate1-host-protection.ps1');
const reportDirectory = path.resolve(__dirname, '../../../.tmp');
const CANARY = 'PRIVATE_TEST_VALUE_DO_NOT_RETAIN';
const windowsTest = process.platform === 'win32' ? test : test.skip;
jest.setTimeout(30000);

/** Build transient HTML fixtures; they never come from a deployed application. */
function html(buildId = TARGET.nextBuildId) {
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ page: '/login', buildId })}</script>`;
}

/** Provide synthetic platform headers plus optional overrides for response classification tests. */
function response(status = 200, text = html(), extra = {}) {
  return { status, text, headers: { server: 'Vercel', 'x-vercel-id': 'iad1::test-123',
    'content-type': 'text/html; charset=utf-8', ...extra } };
}

/** Return the expected anonymous response for a reviewed host without dispatching a request. */
function expectedResponse(options) {
  return options.hostname === CANONICAL ? response() : response(307, '', {
    location: `https://vercel.com/sso-api?url=${encodeURIComponent(`https://${options.hostname}/login`)}&nonce=${CANARY}`,
    'set-cookie': CANARY,
  });
}

/**
 * Emulate the native HTTPS event interface, including stalled headers/body and request destruction.
 * A callback or sequence selects fixtures; counters establish sequential dispatch and no replay.
 */
function transport(fixtures = expectedResponse) {
  const state = { calls: [], destroyed: 0, active: 0, maxActive: 0 };
  /** Construct one controllable request; queued events model asynchronous sockets. */
  state.requestImpl = function requestImpl(options, receive) {
    const index = state.calls.length;
    state.calls.push(options);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    const fixture = typeof fixtures === 'function' ? fixtures(options, index) : fixtures[index];
    assert.ok(fixture, 'Unexpected extra HTTP attempt');
    const request = new EventEmitter();
    let ended = false;
    /** Release the synthetic socket once so cleanup counters cannot double-count. */
    function release() { if (!ended) { ended = true; state.active--; } }
    /** Mirror request destruction during timeouts, aborts and response validation failures. */
    request.destroy = function destroyRequest() { state.destroyed++; release(); };
    /** Schedule delivery after listeners have been installed, like the real transport. */
    request.end = function endRequest() {
      /** Drive fixture-specific response events without opening any connection. */
      function deliver() {
        if (fixture.error) { request.emit('error', new Error(CANARY)); release(); return; }
        if (fixture.hang) return;
        const incoming = new EventEmitter();
        incoming.statusCode = fixture.status;
        incoming.rawHeaders = fixture.rawHeaders || Object.entries(fixture.headers).flat();
        incoming.complete = fixture.complete !== false;
        /** Model destruction of the response stream during a bounded failure. */
        incoming.destroy = function destroyResponse() { release(); };
        receive(incoming);
        if (fixture.hangBody) return;
        for (const chunk of fixture.chunks || [Buffer.from(fixture.text)]) incoming.emit('data', chunk);
        if (fixture.abortBody) incoming.emit('aborted');
        release();
        incoming.emit('end');
        incoming.emit('close');
      }
      queueMicrotask(deliver);
    };
    return request;
  };
  return state;
}

/** Verify offline defaults, four disjoint batches, fixed target attribution and strict CLI selection. */
test('preparation pins 102 cases while live execution requires one explicit batch', function () {
  const prepared = runner.preparation();
  assert.equal(prepared.mode, 'prepare'); assert.equal(prepared.requests, 0);
  assert.equal(prepared.hostedEvidence, 'not_executed'); assert.equal(prepared.gate1Status, 'open');
  assert.equal(prepared.batch, null); assert.equal(prepared.limits.maxRequests, 0);
  assert.equal(prepared.inventory.length, 0); assert.equal(prepared.outsideSelectedBatch, 102);
  assert.equal(prepared.schemaVersion, 2);
  assert.equal(HOSTS.length, 102);
  assert.equal(new Set(HOSTS.map(runnerHostName)).size, 102);
  assert.deepEqual(BATCHES.map(batchLength), [30, 30, 30, 12]);
  assert.equal(HOSTS.filter(publicExpectation).length, 1);
  assert.equal(HOSTS[0].hostname, CANONICAL);
  assert.equal(TARGET.nextBuildId, 'q0zlIgmPLmJWCHTAV9jpK');
  assert.equal(TARGET.deploymentId, 'dpl_2hjZCj2WZ251FZUJsTyaRiVoq1mH');
  assert.equal(prepared.inventoryId, INVENTORY_ID);
  assert.equal(prepared.inventorySha256, INVENTORY_SHA256);
  assert.ok(Object.isFrozen(HOSTS) && HOSTS.every(Object.isFrozen));
  assert.ok(Object.isFrozen(BATCHES) && BATCHES.every(Object.isFrozen));
  for (const batch of BATCHES) {
    assert.ok(Object.isFrozen(batch.hosts));
    const selected = runner.preparation(batch.id);
    assert.equal(selected.batch, batch.id);
    assert.equal(selected.inventory.length, batch.hosts.length);
    assert.equal(selected.limits.maxRequests, batch.hosts.length);
    assert.equal(selected.outsideSelectedBatch + selected.unvisited, 102);
  }
  assert.throws(invalidHost, { code: 'inventory' });
  assert.deepEqual(runner.parseArguments([]), { live: false, batch: null });
  assert.deepEqual(runner.parseArguments(['--batch', '4']), { live: false, batch: 4 });
  assert.deepEqual(runner.parseArguments(['--live', '--batch', '1']), { live: true, batch: 1 });
  assert.deepEqual(runner.parseArguments(['--batch', '2', '--live']), { live: true, batch: 2 });
  for (const args of [['--live'], ['--all'], ['--host', 'evil.test'], ['--live', '--live'],
    ['--batch', '0'], ['--batch', '5'], ['--batch', '1.0'], ['--batch', '01'], ['--batch'],
    ['--batch', '1', '--batch', '2'], ['--batch=1'], [CANARY]]) {
    /** Check malformed CLI input without invoking the live entry point. */
    function invalidArguments() { runner.parseArguments(args); }
    assert.throws(invalidArguments, { code: 'arguments' });
  }
  /** A cloned object must not broaden or replace the frozen scope. */
  function invalidHost() { runner.requestHost({ ...HOSTS[0], hostname: 'evil.test' }); }
});

/** Return the bounded number of hosts in a fixed batch. */
function batchLength(batch) { return batch.hosts.length; }

/** Extract a reviewed host's name for unique-target assertions. */
function runnerHostName(host) { return host.hostname; }
/** Select the canonical public expectation when checking inventory policy. */
function publicExpectation(host) { return host.expected === 'public_login'; }

/** Exercise every batch independently through mocked HTTPS and verify each stops at its own boundary. */
test('four separate mocked runs cover exactly 102 sequential anonymous requests', async function () {
  const visited = [];
  for (const batch of BATCHES) {
    const mock = transport();
    const report = await runner.runLive({ batch: batch.id, requestImpl: mock.requestImpl });
    assert.equal(report.result, 'completed');
    assert.equal(report.requests, batch.hosts.length);
    assert.equal(report.limits.maxRequests, batch.hosts.length);
    assert.equal(report.responses, batch.hosts.length);
    assert.equal(report.expectedPatterns, batch.hosts.length);
    assert.equal(report.unvisited, 0);
    assert.equal(mock.maxActive, 1); assert.equal(mock.active, 0);
    assert.equal(report.batch, batch.id);
    assert.equal(report.outsideSelectedBatch, 102 - batch.hosts.length);
    assert.equal(report.hostedEvidence, 'requires_review'); assert.equal(report.gate1Status, 'open');
    assert.ok(Object.values(report.coverage).every(isFalse));
    assert.equal(JSON.stringify(report).includes(CANARY), false);
    assert.ok(Buffer.byteLength(JSON.stringify(report, null, 2)) < 65536);
    assert.deepEqual(mock.calls.map(runnerHostName), batch.hosts.map(runnerHostName));
    for (const request of mock.calls) {
      visited.push(request.hostname);
      assert.equal(request.method, 'GET'); assert.equal(request.path, '/login');
      assert.equal(request.protocol, 'https:'); assert.equal(request.port, 443);
      assert.equal(request.agent, false); assert.equal(request.rejectUnauthorized, true);
      assert.deepEqual(Object.keys(request.headers).sort(), ['Accept', 'Accept-Encoding', 'User-Agent']);
      assert.equal(request.headers['Accept-Encoding'], 'identity');
    }
  }
  assert.equal(visited.length, 102); assert.equal(new Set(visited).size, 102);
});

/** Check a coverage flag without granting qualification from successful mock responses. */
function isFalse(value) { return value === false; }

/** Require an integer batch at the live API boundary even when callers skip CLI parsing. */
test('missing or invalid live batch cannot dispatch a request', async function () {
  for (const batch of [undefined, null, 0, 5, -1, 1.5, '1']) {
    const mock = transport();
    await assert.rejects(runner.runLive({ batch, requestImpl: mock.requestImpl }), { code: 'arguments' });
    assert.equal(mock.calls.length, 0);
  }
});

/** A management ERROR state cannot turn a 404 into protection evidence or skip a failed batch. */
test('failed preview response stops its selected batch and preserves untouched batches', async function () {
  const mock = transport([response(404, '', { 'x-vercel-error': 'DEPLOYMENT_NOT_FOUND' })]);
  const report = await runner.runLive({ batch: 4, requestImpl: mock.requestImpl });
  assert.equal(BATCHES[3].hosts[0].recordedState, 'ERROR');
  assert.equal(report.result, 'stopped'); assert.equal(report.failure, 'deployment_unavailable');
  assert.equal(report.requests, 1); assert.equal(report.unvisited, 11);
  assert.equal(report.expectedPatterns, 0); assert.equal(report.outsideSelectedBatch, 90);
  assert.equal(mock.calls.length, 1);
  assert.equal(report.receipts[0].hostname, BATCHES[3].hosts[0].hostname);
});

/** Verify unexpected alias exposure stops the scope even when it returns a valid login/build. */
test('public alternate host stops without visiting or retrying remaining targets', async function () {
  const mock = transport([response(), response()]);
  const report = await runner.runLive({ batch: 1, requestImpl: mock.requestImpl });
  assert.equal(report.result, 'stopped');
  assert.equal(report.failure, 'unexpected_public_login');
  assert.equal(report.requests, 2); assert.equal(report.unvisited, 28);
  assert.equal(mock.calls.length, 2);
  assert.equal(report.receipts[1].knownBuildMatch, true);
});

/** Check build mismatches, older-host attribution and minimal positive canonical evidence. */
test('build checks stay scoped to their deployment and canonical page', function () {
  assert.equal(runner.classify(HOSTS[0], response()).expectedPatternObserved, true);
  assert.equal(runner.classify(HOSTS[0], response(200, html('wrong-build'))).classification, 'build_mismatch');
  const immutable = HOSTS.find(currentImmutable);
  assert.equal(runner.classify(immutable, response(200, html(TARGET.nextBuildId))).knownBuildMatch, true);
  assert.equal(runner.classify(HOSTS[3], response()).knownBuildMatch, null);
  assert.equal(runner.classify(HOSTS[0], response(200, html(), { server: 'unknown' })).expectedPatternObserved, false);
  assert.equal(runner.classify(HOSTS[0], response(200, html() + html())).expectedPatternObserved, false);
  assert.equal(runner.classify(HOSTS[0], response(200, '<script id="__NEXT_DATA__">{bad}</script>')).expectedPatternObserved, false);
  for (const misleading of [html().replace('id=', 'data-id='), `<!--${html()}-->`,
    html().replace('id="__NEXT_DATA__"', 'data-marker=\' id="__NEXT_DATA__"\''),
    html().replace('type=', 'id="duplicate" type=')]) {
    assert.equal(runner.classify(HOSTS[0], response(200, misleading)).expectedPatternObserved, false);
  }
});

/** Find the current immutable hostname, whose application remains gated to anonymous requests. */
function currentImmutable(host) { return host.hostname === TARGET.hostname; }

/** Recognize a final solidus separated from quoted or unquoted attributes by HTML whitespace. */
test('login data accepts a whitespace-separated trailing solidus', function () {
  for (const attributes of ['id="__NEXT_DATA__" type="application/json"',
    'id=__NEXT_DATA__ type=application/json']) {
    for (const whitespace of [' ', '\t', '\r\n']) {
      const text = html().replace(/<script[^>]*>/, `<script ${attributes}${whitespace}/>`);
      const receipt = runner.classify(HOSTS[0], response(200, text));
      assert.equal(receipt.classification, 'canonical_login');
      assert.equal(receipt.knownBuildMatch, true);
      assert.equal(receipt.expectedPatternObserved, true);
    }
  }
});

/** Preserve fail-closed parsing when a solidus belongs to a value or accompanies malformed attributes. */
test('login data rejects malformed attributes and unquoted identity values ending in a solidus', function () {
  for (const attributes of [
    'id="__NEXT_DATA__" type=application/json/',
    'type="application/json" id=__NEXT_DATA__/',
    'id="__NEXT_DATA__" type=application/json/ /',
    'type="application/json" id=__NEXT_DATA__/ /',
    'id="__NEXT_DATA__" type= /',
    'id="__NEXT_DATA__" type="application/json" //',
    'id="__NEXT_DATA__" type="application/json" / extra',
    'id="__NEXT_DATA__" type="application/json" id="duplicate" /',
  ]) {
    const text = html().replace(/<script[^>]*>/, `<script ${attributes}>`);
    const receipt = runner.classify(HOSTS[0], response(200, text));
    assert.equal(receipt.loginBuildRecognized, false, attributes);
    assert.equal(receipt.expectedPatternObserved, false, attributes);
  }
});

/** Restrict recognized redirect patterns; no generic rejection or arbitrary redirect can qualify. */
test('generic 401/403/404/redirects and deceptive destinations remain unresolved', function () {
  for (const status of [401, 403, 404, 302, 307, 500]) {
    assert.equal(runner.classify(HOSTS[1], response(status, CANARY)).expectedPatternObserved, false);
  }
  for (const location of ['https://vercel.com.evil.test/login', 'http://vercel.com/login',
    'https://user@vercel.com/login', 'https://vercel.com:444/login', 'https://vercel.com/other',
    'https://vercel.com/login#fragment', '//evil.test/login', `https://${CANONICAL}/login?token=${CANARY}`,
    'https://vercel.com\\@evil.test/login']) {
    assert.equal(runner.classify(HOSTS[1], response(307, '', { location })).expectedPatternObserved, false);
  }
  assert.equal(runner.classify(HOSTS[1], response(307, '', { location: `https://${CANONICAL}/login` })).classification, 'canonical_redirect');
  assert.equal(runner.classify(HOSTS[0], response(307, '', { location: 'https://vercel.com/login' })).classification, 'unexpected_gate');
  assert.equal(runner.classify(HOSTS[1], response(404, '', { 'x-vercel-error': 'DEPLOYMENT_NOT_FOUND' })).classification, 'deployment_unavailable');
});

/** Prove the native transport does not automatically follow any redirect. */
test('transport returns a redirect after exactly one exchange', async function () {
  const mock = transport([response(307, CANARY, { location: `https://vercel.com/login?nonce=${CANARY}` })]);
  const actual = await runner.requestHost(HOSTS[1], { requestImpl: mock.requestImpl });
  assert.equal(actual.status, 307); assert.equal(mock.calls.length, 1);
});

/** Cover both response size mechanisms and malformed/ambiguous metadata using mocked byte streams. */
test('body bounds, encoding, duplicate headers and truncation fail closed', async function () {
  const cases = [
    [{ ...response(), chunks: [Buffer.alloc(12), Buffer.alloc(12)] }, 'response_size'],
    [response(200, '', { 'content-length': '10000000' }), 'response_size'],
    [response(200, '', { 'content-encoding': 'gzip' }), 'response_encoding'],
    [{ ...response(), rawHeaders: ['Location', '/login', 'location', '/other'] }, 'response_headers'],
    [{ ...response(), rawHeaders: ['server'] }, 'response_headers'],
    [{ ...response(), rawHeaders: ['server', 42] }, 'response_headers'],
    [{ ...response(), rawHeaders: ['server', 'x'.repeat(LIMITS.headerBytes)] }, 'response_headers'],
    [{ ...response(200, ''), complete: false }, 'response_incomplete'],
    [{ ...response(200, ''), abortBody: true }, 'response_incomplete'],
  ];
  for (const [fixture, code] of cases) {
    const mock = transport([fixture]);
    await assert.rejects(runner.requestHost(HOSTS[0], { requestImpl: mock.requestImpl, responseBytes: 20 }), { code });
    assert.equal(mock.calls.length, 1); assert.equal(mock.active, 0);
    assert.ok(mock.destroyed >= 1);
  }
});

/** Exercise deadlines with noncooperative header/body streams; the runner must destroy and stop. */
test('request timeout covers headers and body and never retries', async function () {
  for (const fixture of [{ hang: true }, { ...response(), hangBody: true }]) {
    const mock = transport([fixture]);
    const report = await runner.runLive({ batch: 1, requestImpl: mock.requestImpl, requestMs: 20 });
    assert.equal(report.failure, 'request_timeout'); assert.equal(report.result, 'stopped');
    assert.equal(mock.calls.length, 1); assert.equal(mock.active, 0);
    assert.ok(mock.destroyed >= 1);
    assert.equal(report.receipts[0].hostname, CANONICAL);
    assert.equal(report.receipts[0].classification, 'request_timeout');
  }
});

/** Distinguish cancellation from overall deadline while excluding arbitrary abort reasons. */
test('overall timeout and pre-aborted cancellation stop within the request budget', async function () {
  const stalled = transport([{ hang: true }]);
  const report = await runner.runLive({ batch: 1, requestImpl: stalled.requestImpl, overallMs: 20 });
  assert.equal(report.failure, 'overall_deadline'); assert.equal(stalled.calls.length, 1);
  assert.equal(stalled.active, 0);
  const controller = new AbortController();
  controller.abort(new Error(CANARY));
  const unused = transport();
  const cancelled = await runner.runLive({ batch: 1, requestImpl: unused.requestImpl, signal: controller.signal });
  assert.equal(cancelled.failure, 'cancelled'); assert.equal(unused.calls.length, 0);
  assert.equal(JSON.stringify(cancelled).includes(CANARY), false);
});

/** Cancel after dispatch and verify active sockets are destroyed without retaining the abort reason. */
test('in-flight cancellation destroys the request; larger budgets are refused before dispatch', async function () {
  const controller = new AbortController();
  const stalled = transport([{ hang: true }]);
  const pending = runner.runLive({ batch: 1, requestImpl: stalled.requestImpl, signal: controller.signal });
  controller.abort(CANARY);
  const report = await pending;
  assert.equal(report.failure, 'cancelled'); assert.equal(stalled.calls.length, 1);
  assert.equal(stalled.active, 0); assert.equal(JSON.stringify(report).includes(CANARY), false);
  for (const limits of [{ requestMs: 10001 }, { overallMs: 300001 }]) {
    const unused = transport();
    const rejected = await runner.runLive({ batch: 1, requestImpl: unused.requestImpl, ...limits });
    assert.equal(rejected.failure, 'request_budget'); assert.equal(rejected.requests, 0);
    assert.equal(unused.calls.length, 0);
  }
});

/** Ensure unknown response strings and transport failures cannot leak into persistent evidence. */
test('sanitized reports exclude bodies, headers, invalid IDs and transport errors', async function () {
  const mock = transport([response(401, CANARY, { 'x-vercel-id': `${CANARY}:invalid`,
    location: `https://vercel.com/login?secret=${CANARY}`, 'set-cookie': CANARY })]);
  const report = await runner.runLive({ batch: 1, requestImpl: mock.requestImpl });
  assert.equal(report.receipts[0].vercelId, null);
  assert.equal(JSON.stringify(report).includes(CANARY), false);
  const failed = transport([{ error: true }]);
  const errorReport = await runner.runLive({ batch: 1, requestImpl: failed.requestImpl });
  assert.equal(errorReport.failure, 'transport_error');
  assert.equal(JSON.stringify(errorReport).includes(CANARY), false);
  assert.equal(failed.calls.length, 1);
});

/** Run trusted test-only PowerShell text without shell interpolation or any live diagnostic. */
function powershell(script) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20000, windowsHide: true });
}

/** Quote a fixed filesystem path as a PowerShell single-quoted literal. */
function psLiteral(value) { return `'${value.replaceAll("'", "''")}'`; }

/** Read and remove only this test's unique report after checking its exact parent and filename pattern. */
function consumeReport(reportPath) {
  const resolved = path.resolve(reportPath);
  assert.equal(path.dirname(resolved), reportDirectory);
  assert.match(path.basename(resolved), /^gate1-host-protection-(?:overview|batch-[1-4])-(?:prepare|live)-\d{8}-\d{9}-[a-f0-9]{32}\.json$/);
  try { return JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  finally { fs.unlinkSync(resolved); }
}

/** Execute the actual launcher twice in default prepare mode and prove unique, parseable file capture. */
windowsTest('PowerShell default saves unique offline reports without dumping JSON', function () {
  const paths = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', launcher],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(child.status, 0, 'Offline launcher failed');
    const match = /^Report: (.+)\r?\n$/.exec(child.stdout);
    assert.ok(match, 'Launcher should emit only the report path');
    paths.push(match[1]);
    const report = consumeReport(match[1]);
    assert.equal(report.mode, 'prepare'); assert.equal(report.requests, 0);
  }
  assert.notEqual(paths[0], paths[1]);
});

/** Construct a real bounded envelope for launcher failure tests without executing HTTP. */
function stoppedFixture(batch = null, live = false) {
  const report = runner.preparation(batch);
  report.mode = live ? 'live' : 'prepare';
  report.result = 'stopped'; report.failure = 'cancelled';
  report.hostedEvidence = live ? 'requires_review' : 'not_executed';
  return report;
}

/**
 * Replace only the PowerShell Node executor and validate dispatch arguments. All live-mode tests
 * use this replacement, so saving/validation/exit behavior is exercised without any HTTP.
 */
function mockedLauncher(report, exitCode, batch = 0, live = false) {
  const json = typeof report === 'string' ? report : JSON.stringify(report);
  const liveValue = live ? '$true' : '$false';
  return powershell([
    '. ' + psLiteral(launcher),
    '# Return only a test fixture and check the selected fixed runner/batch before report handling.',
    'function Invoke-Gate1HostNode([string]$Runner, [bool]$LiveMode, [int]$BatchId = 0) {',
    '  if ($BatchId -ne ' + batch + ' -or $LiveMode -ne ' + liveValue +
      ' -or $Runner -ne ' + psLiteral(path.resolve(__dirname, '../../../scripts/gate1-host-protection.js')) +
      ') { throw "Invalid dispatch." }',
    '  return @{ Json = ' + psLiteral(json) + '; ExitCode = ' + exitCode + ' }',
    '}',
    'try {',
    '  $saved = Invoke-Gate1HostProtection -BatchId ' + batch + ' -LiveMode:' + liveValue,
    '  Write-Output ("Report: " + $saved.Path)',
    '  exit $saved.ExitCode',
    '} catch { Write-Output "invalid_report"; exit 9 }',
  ].join('\n'));
}

/** Check failure preservation independently from a child's occasionally incorrect zero exit status. */
windowsTest('PowerShell preserves nonzero exit status and catches stopped reports with zero exit', function () {
  for (const exitCode of [7, 0]) {
    const child = mockedLauncher(stoppedFixture(), exitCode);
    assert.equal(child.status, exitCode || 1);
    const match = /^Report: (.+)\r?\n$/.exec(child.stdout);
    assert.ok(match); assert.equal(consumeReport(match[1]).result, 'stopped');
  }
});

/** The -Live path forwards exactly one batch to the mocked executor and labels its report correctly. */
windowsTest('PowerShell live mode forwards only the selected batch and saves its bounded report', function () {
  const child = mockedLauncher(stoppedFixture(4, true), 2, 4, true);
  assert.equal(child.status, 2);
  const match = /^Report: (.+)\r?\n$/.exec(child.stdout);
  assert.ok(match); assert.match(path.basename(match[1]), /batch-4-live-/);
  const report = consumeReport(match[1]);
  assert.equal(report.mode, 'live'); assert.equal(report.batch, 4);
  assert.equal(report.limits.maxRequests, 12);
});

/** Exercise each real CLI batch argument in offline mode to detect quoting/dispatch or size regressions. */
windowsTest('PowerShell offline selection saves exactly the requested batch with no automatic progression', function () {
  for (const batch of [1, 2, 3, 4]) {
    const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', launcher,
      '-Batch', String(batch)], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(child.status, 0, 'Offline batch launcher failed');
    const match = /^Report: (.+)\r?\n$/.exec(child.stdout);
    assert.ok(match);
    const report = consumeReport(match[1]);
    assert.equal(report.batch, batch); assert.equal(report.mode, 'prepare');
    assert.equal(report.requests, 0);
    assert.equal(report.inventory.length, BATCH_SIZES[batch - 1]);
  }
});

/** Missing live selection must fail before the executor, even if that executor is replaced. */
windowsTest('PowerShell rejects live mode without a batch before process dispatch', function () {
  const child = powershell([
    '. ' + psLiteral(launcher),
    '# A call to this test-only executor would reveal an unintended dispatch.',
    'function Invoke-Gate1HostNode { Write-Output "unexpected_dispatch"; throw "unexpected_dispatch" }',
    'try { $null = Invoke-Gate1HostProtection -LiveMode; exit 0 }',
    'catch { Write-Output "batch_required"; exit 9 }',
  ].join('\n'));
  assert.equal(child.status, 9); assert.equal(child.stdout.trim(), 'batch_required');
  assert.equal((child.stdout + child.stderr).includes('unexpected_dispatch'), false);
});

/** Reject wrong-batch, excessive, or falsely completed reports before any file is saved. */
windowsTest('PowerShell refuses cross-batch and impossible completion accounting', function () {
  const fixtures = [
    stoppedFixture(1, true),
    { ...stoppedFixture(4, true), requests: 13, unvisited: 0 },
    { ...stoppedFixture(4, true), result: 'completed', failure: null },
    { ...stoppedFixture(4, true), inventorySha256: 'wrong-inventory' },
  ];
  for (const report of fixtures) {
    const child = mockedLauncher(report, 0, 4, true);
    assert.equal(child.status, 9); assert.equal(child.stdout.trim(), 'invalid_report');
  }
});

/** Invalid stdout must not be saved, echoed, or exposed through an exception. */
windowsTest('PowerShell rejects invalid stdout without exposing it', function () {
  const child = mockedLauncher(CANARY, 1);
  assert.equal(child.status, 9); assert.equal(child.stdout.trim(), 'invalid_report');
  assert.equal((child.stdout + child.stderr).includes(CANARY), false);
});

/**
 * Re-import with a transient mocked manifest read; no source files are altered. This exercises
 * the fixed loader's missing/invalid/tampered data path and always restores the filesystem mock.
 */
function reloadWithManifest(value) {
  const actualRead = fs.readFileSync;
  const manifestPath = path.resolve(__dirname, '../../../scripts/gate1-host-protection-inventory.json');
  let loaded;
  const spy = jest.spyOn(fs, 'readFileSync');
  /** Intercept only the fixed inventory path; preserve Babel/module reads and unrelated files. */
  function manifestRead(filename, ...args) {
    if (path.resolve(String(filename)) === manifestPath) {
      if (value instanceof Error) throw value;
      return value;
    }
    return actualRead.call(fs, filename, ...args);
  }
  spy.mockImplementation(manifestRead);
  try {
    /** Re-evaluate the runner's immutable inventory without disturbing the other tests' module instance. */
    function importIsolated() { loaded = require('../../../scripts/gate1-host-protection.js'); }
    jest.isolateModules(importIsolated);
  } finally { spy.mockRestore(); }
  return loaded;
}

/** A parsed-content digest survives Git line-ending conversion while preserving the approved batch scope. */
test('manifest digest accepts equivalent LF and CRLF serialization', function () {
  const text = fs.readFileSync(path.resolve(__dirname, '../../../scripts/gate1-host-protection-inventory.json'), 'utf8');
  const loaded = reloadWithManifest(text.replace(/\r?\n/g, '\r\n'));
  assert.equal(loaded.preparation(4).inventory.length, 12);
  assert.equal(loaded.preparation(4).inventorySha256, INVENTORY_SHA256);
});

/** Reject source, order, and duplicate changes instead of silently broadening the authorized destinations. */
test('missing, malformed, oversized or modified manifests fail before HTTP with sanitized errors', async function () {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../scripts/gate1-host-protection-inventory.json'), 'utf8'));
  const changedHost = JSON.parse(JSON.stringify(manifest));
  changedHost.batches[0].hosts[0].hostname = 'job-application-tracker-unapproved.vercel.app';
  const duplicate = JSON.parse(JSON.stringify(manifest));
  duplicate.batches[0].hosts[1] = duplicate.batches[0].hosts[0];
  const reordered = JSON.parse(JSON.stringify(manifest));
  reordered.batches.reverse();
  for (const value of [new Error(CANARY), CANARY, 'x'.repeat(65537),
    JSON.stringify(changedHost), JSON.stringify(duplicate), JSON.stringify(reordered)]) {
    const loaded = reloadWithManifest(value);
    const mock = transport();
    /** Check the safe public failure without serializing any raw loader exception. */
    function prepareInvalid() { loaded.preparation(); }
    assert.throws(prepareInvalid, { code: 'inventory', message: 'inventory' });
    await assert.rejects(loaded.runLive({ batch: 1, requestImpl: mock.requestImpl }), { code: 'inventory' });
    assert.equal(mock.calls.length, 0);
  }
});

/** Invoke only invalid live CLI input so the entry point proves it fails before network work. */
test('CLI rejects --live without a batch and emits a sanitized zero-request report', function () {
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../../../scripts/gate1-host-protection.js'), '--live'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(child.status, 1);
  const report = JSON.parse(child.stdout);
  assert.equal(report.result, 'stopped'); assert.equal(report.failure, 'arguments');
  assert.equal(report.requests, 0); assert.equal(report.batch, null);
});
