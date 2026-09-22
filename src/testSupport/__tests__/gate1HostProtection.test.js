'use strict';

// All HTTP is mocked. PowerShell integration runs preparation or a mocked stopped report only.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const runner = require('../../../scripts/gate1-host-protection.js');
const { HOSTS, TARGET, CANONICAL, LIMITS } = runner;
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

/** Verify offline defaults, immutable scope, exact cap and refusal of caller-supplied destinations. */
test('preparation pins 28 aliases and two immutable hosts; live flags are strict', function () {
  const prepared = runner.preparation();
  assert.equal(prepared.mode, 'prepare');
  assert.equal(prepared.requests, 0);
  assert.equal(prepared.hostedEvidence, 'not_executed');
  assert.equal(prepared.gate1Status, 'open');
  assert.equal(HOSTS.length, 30);
  assert.equal(new Set(HOSTS.map(runnerHostName)).size, 30);
  assert.equal(HOSTS.filter(publicExpectation).length, 1);
  assert.equal(HOSTS[0].hostname, CANONICAL);
  assert.equal(HOSTS[28].hostname, TARGET.hostname);
  assert.equal(HOSTS[29].knownBuildId, 'VjEJE3geVJngqDN7JymXV');
  assert.ok(Object.isFrozen(HOSTS) && HOSTS.every(Object.isFrozen));
  assert.throws(invalidHost, { code: 'inventory' });
  assert.equal(runner.parseArguments([]), false);
  assert.equal(runner.parseArguments(['--live']), true);
  for (const args of [['--host', 'evil.test'], ['--live', '--live'], [CANARY]]) {
    /** Test rejected CLI input without ever calling the live entry point. */
    function invalidArguments() { runner.parseArguments(args); }
    assert.throws(invalidArguments, { code: 'arguments' });
  }
  /** A cloned object must not broaden or replace the frozen scope. */
  function invalidHost() { runner.requestHost({ ...HOSTS[0], hostname: 'evil.test' }); }
});

/** Extract a reviewed host's name for unique-target assertions. */
function runnerHostName(host) { return host.hostname; }
/** Select the canonical public expectation when checking inventory policy. */
function publicExpectation(host) { return host.expected === 'public_login'; }

/** Exercise every target through the real runner loop with mock HTTPS and inspect outgoing options. */
test('complete mocked run dispatches exactly 30 sequential anonymous requests', async function () {
  const mock = transport();
  const report = await runner.runLive({ requestImpl: mock.requestImpl });
  assert.equal(report.result, 'completed');
  assert.equal(report.requests, LIMITS.maxRequests);
  assert.equal(report.responses, 30);
  assert.equal(report.expectedPatterns, 30);
  assert.equal(report.unvisited, 0);
  assert.equal(mock.maxActive, 1);
  assert.equal(mock.active, 0);
  assert.equal(report.hostedEvidence, 'requires_review');
  assert.equal(report.gate1Status, 'open');
  assert.equal(report.coverage.sourceAndWafAgreement, false);
  assert.equal(JSON.stringify(report).includes(CANARY), false);
  for (const request of mock.calls) {
    assert.equal(request.method, 'GET'); assert.equal(request.path, '/login');
    assert.equal(request.protocol, 'https:'); assert.equal(request.port, 443);
    assert.equal(request.agent, false); assert.equal(request.rejectUnauthorized, true);
    assert.deepEqual(Object.keys(request.headers).sort(), ['Accept', 'Accept-Encoding', 'User-Agent']);
    assert.equal(request.headers['Accept-Encoding'], 'identity');
  }
});

/** Verify unexpected alias exposure stops the scope even when it returns a valid login/build. */
test('public alternate host stops without visiting or retrying remaining targets', async function () {
  const mock = transport([response(), response()]);
  const report = await runner.runLive({ requestImpl: mock.requestImpl });
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
  assert.equal(runner.classify(HOSTS[29], response(200, html(HOSTS[29].knownBuildId))).knownBuildMatch, true);
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
    const report = await runner.runLive({ requestImpl: mock.requestImpl, requestMs: 20 });
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
  const report = await runner.runLive({ requestImpl: stalled.requestImpl, overallMs: 20 });
  assert.equal(report.failure, 'overall_deadline'); assert.equal(stalled.calls.length, 1);
  assert.equal(stalled.active, 0);
  const controller = new AbortController();
  controller.abort(new Error(CANARY));
  const unused = transport();
  const cancelled = await runner.runLive({ requestImpl: unused.requestImpl, signal: controller.signal });
  assert.equal(cancelled.failure, 'cancelled'); assert.equal(unused.calls.length, 0);
  assert.equal(JSON.stringify(cancelled).includes(CANARY), false);
});

/** Cancel after dispatch and verify active sockets are destroyed without retaining the abort reason. */
test('in-flight cancellation destroys the request; larger budgets are refused before dispatch', async function () {
  const controller = new AbortController();
  const stalled = transport([{ hang: true }]);
  const pending = runner.runLive({ requestImpl: stalled.requestImpl, signal: controller.signal });
  controller.abort(CANARY);
  const report = await pending;
  assert.equal(report.failure, 'cancelled'); assert.equal(stalled.calls.length, 1);
  assert.equal(stalled.active, 0); assert.equal(JSON.stringify(report).includes(CANARY), false);
  for (const limits of [{ requestMs: 10001 }, { overallMs: 300001 }]) {
    const unused = transport();
    const rejected = await runner.runLive({ requestImpl: unused.requestImpl, ...limits });
    assert.equal(rejected.failure, 'request_budget'); assert.equal(rejected.requests, 0);
    assert.equal(unused.calls.length, 0);
  }
});

/** Ensure unknown response strings and transport failures cannot leak into persistent evidence. */
test('sanitized reports exclude bodies, headers, invalid IDs and transport errors', async function () {
  const mock = transport([response(401, CANARY, { 'x-vercel-id': `${CANARY}:invalid`,
    location: `https://vercel.com/login?secret=${CANARY}`, 'set-cookie': CANARY })]);
  const report = await runner.runLive({ requestImpl: mock.requestImpl });
  assert.equal(report.receipts[0].vercelId, null);
  assert.equal(JSON.stringify(report).includes(CANARY), false);
  const failed = transport([{ error: true }]);
  const errorReport = await runner.runLive({ requestImpl: failed.requestImpl });
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
  assert.match(path.basename(resolved), /^gate1-host-protection-\d{8}-\d{9}-[a-f0-9]{32}\.json$/);
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

/** Mock only the launcher's Node executor so saved stopped reports and exit propagation are testable offline. */
windowsTest('PowerShell preserves nonzero exit status and catches stopped reports with zero exit', function () {
  for (const exitCode of [7, 0]) {
    const child = powershell(`
. ${psLiteral(launcher)}
# Return a small synthetic stopped report without invoking Node or any network.
function Invoke-Gate1HostNode([string]$Runner, [bool]$LiveMode) {
  return @{ Json = '{"schemaVersion":1,"scope":"selected_login_host_access_only","mode":"prepare","gate1Status":"open","result":"stopped"}'; ExitCode = ${exitCode} }
}
$saved = Invoke-Gate1HostProtection
Write-Output ('Report: ' + $saved.Path)
exit $saved.ExitCode
`);
    assert.equal(child.status, exitCode || 1);
    const match = /^Report: (.+)\r?\n$/.exec(child.stdout);
    assert.ok(match); assert.equal(consumeReport(match[1]).result, 'stopped');
  }
});

/** Confirm -Live reaches only the fixed runner argument using a replacement executor, never real HTTP. */
windowsTest('PowerShell explicit live flag is forwarded to the fixed runner with sanitized report capture', function () {
  const child = powershell(`
. ${psLiteral(launcher)}
# Verify dispatch arguments while replacing the entire native process call.
function Invoke-Gate1HostNode([string]$Runner, [bool]$LiveMode) {
  if (-not $LiveMode -or $Runner -ne ${psLiteral(path.resolve(__dirname, '../../../scripts/gate1-host-protection.js'))}) { throw 'Invalid dispatch.' }
  return @{ Json = '{"schemaVersion":1,"scope":"selected_login_host_access_only","mode":"live","gate1Status":"open","result":"stopped"}'; ExitCode = 2 }
}
$saved = Invoke-Gate1HostProtection -LiveMode
Write-Output ('Report: ' + $saved.Path)
exit $saved.ExitCode
`);
  assert.equal(child.status, 2);
  const match = /^Report: (.+)\r?\n$/.exec(child.stdout);
  assert.ok(match); assert.equal(consumeReport(match[1]).mode, 'live');
});

/** Invalid subprocess output must not be saved or echoed as a diagnostic report. */
windowsTest('PowerShell rejects invalid stdout without exposing it', function () {
  const child = powershell(`
. ${psLiteral(launcher)}
# Simulate a malformed subprocess reply containing a private marker.
function Invoke-Gate1HostNode([string]$Runner, [bool]$LiveMode) {
  return @{ Json = '${CANARY}'; ExitCode = 1 }
}
try { $null = Invoke-Gate1HostProtection; exit 0 } catch { Write-Output 'invalid_report'; exit 9 }
`);
  assert.equal(child.status, 9); assert.equal(child.stdout.trim(), 'invalid_report');
  assert.equal((child.stdout + child.stderr).includes(CANARY), false);
});
