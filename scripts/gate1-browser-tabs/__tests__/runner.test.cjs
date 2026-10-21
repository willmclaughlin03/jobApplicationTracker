'use strict';
/* global Headers, clearTimeout, setTimeout */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { RequestBudget, IdentityObserver, BrowserObserver, classifyRequest, validateBuild,
  summarizeDurations, waitUntil, waitForChecks, withTimeout, runProfiles, parseCli, main, TARGET, PROFILES } = require('../runner.cjs');

/** Supply a deterministic clock and generous phase limits without starting timers or I/O. */
function budgetFixture(overrides = {}) {
  let now = 0;
  // Tests control elapsed time without waiting or changing browser/application clocks.
  const budget = new RequestBudget({ clock: () => now, ...overrides });
  budget.begin('test', { app: 1000, static: 1280, session: 364 }, 100_000);
  return { budget,
    /** Advance the deterministic host clock to test exact rolling/deadline boundaries. */
    advance(ms) { now += ms; } };
}

/** Verify synchronous reservations cannot overshoot when many tabs resume concurrently. */
test('concurrent dispatch reservations admit exactly the cap', async () => {
  const { budget } = budgetFixture(); budget.phaseLimits.app = 8;
  // Each continuation represents a simultaneously resumed request interception.
  const results = await Promise.allSettled(Array.from({ length: 20 }, async () => budget.reserve('document')));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 8);
  assert.equal(budget.counts.app, 8); assert.equal(budget.reason, 'profile_budget');
  assert.equal(budget.records.length, 8);
});

/** Count retries and every dynamic category against totals while keeping static accounting separate. */
test('nested per-profile and total caps count all dispatch attempts', () => {
  const { budget } = budgetFixture({ totals: { app: 3, static: 1, session: 2 } });
  for (const kind of ['session', 'csrf', 'other_api', 'static']) budget.reserve(kind).finished = true;
  assert.deepEqual(budget.counts, { app: 3, static: 1, session: 1 });
  budget.begin('next', { app: 100, static: 100, session: 100 }, 1000);
  assert.throws(() => budget.reserve('session'), /total_budget/);
  assert.equal(budget.counts.session, 1);
});

/** Prove exact half-open rolling-window boundaries and preserve rolling state between profiles. */
test('rolling capacity is released at 61 seconds, not earlier', () => {
  const early = budgetFixture({ rolling: { app: 2, session: 1 } });
  early.budget.reserve('session').finished = true; early.advance(60_999);
  early.budget.begin('next', { app: 20, static: 20, session: 20 }, 50_000);
  assert.throws(() => early.budget.reserve('session'), /rolling_budget/);
  const exact = budgetFixture({ rolling: { app: 2, session: 1 } });
  exact.budget.reserve('session').finished = true; exact.advance(61_000);
  exact.budget.reserve('session'); assert.equal(exact.budget.counts.session, 2);
});

/** Ensure no late timer or sleep can grant extra dispatches after the approved deadline. */
test('deadline equality is a stop and cancellation wakes a pending wait', async () => {
  const { budget, advance } = budgetFixture({ totalMs: 100 });
  advance(100); assert.throws(() => budget.reserve('session'), /deadline/);
  assert.equal(budget.counts.app, 0);
  const pending = new RequestBudget();
  const waiting = waitUntil(pending, pending.clock() + 60_000);
  pending.stop('cancelled'); await assert.rejects(waiting, /cancelled/);
});

/** In-flight requests cannot disappear when a new profile resets its counters. */
test('phase changes require complete observations and first failure is preserved', () => {
  const { budget } = budgetFixture(); budget.reserve('session');
  assert.throws(() => budget.begin('next', { app: 1, static: 1, session: 1 }, 100), /inflight_phase_change/);
  budget.stop('identity_mismatch'); budget.stop('transport_failure');
  assert.equal(budget.reason, 'identity_mismatch');
});

/** A late React mount must be observed instead of treating the earlier document load as readiness. */
test('startup readiness waits for completed session and CSRF events', async () => {
  const budget = new RequestBudget();
  // Mimic browser protocol notifications arriving after the document load promise resolves.
  const timer = setTimeout(() => {
    budget.reserve('session', 1).finished = true;
    budget.reserve('csrf', 1).finished = true;
  }, 15);
  const observer = { budget,
    /** No extra transport work exists in this readiness-specific mock. */
    async settled() {} };
  try { await waitForChecks(observer, 1, 1, 200); }
  finally { clearTimeout(timer); budget.dispose(); }
  assert.equal(budget.counts.session, 1);
  const empty = { budget: new RequestBudget(), settled: observer.settled };
  await assert.rejects(waitForChecks(empty, 1, 1, 25), /missing_observation/);
});

/** Reports must remain fixed even if cleanup receives late protocol callbacks. */
test('report snapshots cannot change after delivery or retain extra raw fields', () => {
  const { budget } = budgetFixture(); const record = budget.reserve('session');
  record.unexpectedRawBody = 'PRIVATE_BODY';
  const report = budget.report(); record.status = 200; record.finished = true;
  budget.reserve('csrf');
  assert.equal(report.records.length, 1); assert.equal(report.records[0].status, null);
  assert.equal(report.dispatched.app, 1); assert.doesNotMatch(JSON.stringify(report), /PRIVATE_BODY/);
});

/** Keep sensitive query strings, path identifiers, and off-origin/mutating requests out of evidence. */
test('classification is allowlisted and never returns sensitive URL segments', () => {
  const origins = new Set(['https://example.test']);
  assert.equal(classifyRequest('https://example.test/api/jobs/PRIVATE?token=SECRET', 'GET', origins), 'other_api');
  assert.equal(classifyRequest('https://example.test/_next/data/build/page.json', 'GET', origins), 'data');
  assert.equal(classifyRequest('https://example.test/_next/static/a.js', 'GET', origins), 'static');
  assert.throws(() => classifyRequest('https://other.test/', 'GET', origins), /unexpected_origin/);
  assert.throws(() => classifyRequest('https://example.test/api/auth/signout', 'POST', origins), /unexpected_method/);
});

/** Check identity changes, anonymous responses, malformed JSON and report redaction without real accounts. */
test('identity comparison exports booleans only and rejects changed/absent identities', () => {
  const observer = new IdentityObserver('PRIVATE_ID_SENTINEL');
  const valid = observer.observe(JSON.stringify({ data: { user: { id: 'PRIVATE_ID_SENTINEL', email: 'PRIVATE_EMAIL_SENTINEL' } }, token: 'PRIVATE_TOKEN_SENTINEL' }));
  assert.deepEqual(valid, { authenticated: true, matchesApprovedAccount: true, matchesBaseline: true });
  assert.deepEqual(observer.observe('{"data":{"user":{"id":"different"}}}'),
    { authenticated: true, matchesApprovedAccount: false, matchesBaseline: false });
  assert.deepEqual(observer.observe('{"data":{"user":null}}'),
    { authenticated: false, matchesApprovedAccount: false, matchesBaseline: false });
  assert.throws(() => observer.observe('{broken'), /session_schema/);
  assert.throws(() => observer.observe('x'.repeat(1_048_577)), /body_limit/);
  const { budget } = budgetFixture(); const record = budget.reserve('session'); record.identity = valid;
  assert.doesNotMatch(JSON.stringify({ observer, report: budget.report() }), /PRIVATE|different/);
});

/** Stop target drift and stale documents; valid build IDs alone cannot override bad status/cache evidence. */
test('build attribution rejects stale, missing, mismatched and redirected documents', () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ buildId: TARGET.build, props: { private: 'DO_NOT_RETAIN' } })}</script>`;
  assert.equal(validateBuild(html, 200, new Headers()), true);
  assert.throws(() => validateBuild(html, 302, new Headers()), /target_status/);
  assert.throws(() => validateBuild(html, 200, new Headers({ 'x-vercel-cache': 'HIT' })), /cached_target/);
  assert.throws(() => validateBuild(html, 200, new Headers({ age: '1' })), /cached_target/);
  assert.throws(() => validateBuild(html, 200, new Headers(), 'different-build'), /build_mismatch/);
  assert.throws(() => validateBuild('<html></html>', 200, new Headers()), /build_missing/);
});

/** Freeze percentile semantics and return explicit missing values for empty observations. */
test('latency summaries use nearest-rank p95 and preserve missing data', () => {
  assert.deepEqual(summarizeDurations([4, 1, 3, 2]), { count: 4, medianMs: 2.5, p95Ms: 4, maxMs: 4 });
  assert.equal(summarizeDurations(Array.from({ length: 20 }, (_, index) => index + 1)).p95Ms, 19);
  assert.equal(summarizeDurations([]).p95Ms, null);
  assert.throws(() => summarizeDurations([NaN]), /missing_timing/);
});

/** Offline CLI and imported live entry point must reject incomplete/accidental execution approval. */
test('no CLI invocation or partial profile approval can initiate live traffic', async () => {
  await assert.rejects(main(['--live']), /offline_cli_only/);
  await assert.rejects(runProfiles({ approval: 'go', approvedProfiles: [1, 2, 4, 8] }), /live_not_authorized/);
  const description = await main(['--describe']); assert.equal(description.profiles.length, 4);
  assert.deepEqual(PROFILES.map(profile => profile.tabs), [1, 2, 4, 8]);
  assert.equal(PROFILES.reduce((sum, profile) => sum + profile.app, 20), 1000);
  assert.equal(PROFILES.reduce((sum, profile) => sum + profile.static, 80), 1280);
});

/** Reject missing, relative, malformed and extra tool arguments before browser or network side effects. */
test('offline CLI requires explicit absolute tool paths and never accepts a live flag', () => {
  const corePath = path.resolve('fixture-playwright-core');
  const browserPath = path.resolve('fixture-edge');
  const args = ['--self-check', '--playwright-core', corePath, '--edge-executable', browserPath];
  assert.deepEqual(parseCli(args), { mode: 'self-check', corePath, browserPath });
  assert.deepEqual(parseCli(['--describe']), { mode: 'describe' });
  for (const invalid of [[], ['--self-check'], [...args, '--live'], ['--describe', '--live'],
    ['--self-check', '--edge-executable', browserPath, '--playwright-core', corePath], [null], null]) {
    assert.throws(() => parseCli(invalid), /offline_cli_only/);
  }
  assert.throws(() => parseCli(['--self-check', '--playwright-core', './relative', '--edge-executable', browserPath]), /tool_path/);
  assert.throws(() => parseCli(['--self-check', '--playwright-core', corePath, '--edge-executable', './relative']), /tool_path/);
  assert.throws(() => parseCli(['--self-check', '--playwright-core', `${corePath}\0`, '--edge-executable', browserPath]), /tool_path/);
});

/** Minimal protocol/page doubles exercise stop cleanup without launching or reading a browser profile. */
function fakeBrowser() {
  const protocol = new EventEmitter(); const commands = []; const page = new EventEmitter();
  let closed = 0;
  // Record command names and safe request IDs only; no raw protocol payloads enter assertions.
  protocol.send = async function send(command, params) { commands.push({ command, requestId: params?.requestId, enabled: params?.enabled }); return {}; };
  /** Accept an init observer without executing browser code in the unit-test process. */
  page.addInitScript = async function addInitScript() {};
  /** Model one owned close and emit the normal page event. */
  page.close = async function close() { closed++; page.emit('close'); };
  /** Match the browser's scalar closure observation without exposing page contents. */
  page.isClosed = function isClosed() { return closed > 0; };
  return { protocol, commands, page,
    /** Return only the owned page/session to the observer under test. */
    context: { async newPage() { return page; }, async newCDPSession() { return protocol; } },
    /** Expose a scalar close count for the idempotent-cleanup assertion. */
    closed() { return closed; } };
}

/** Simulate paused concurrent requests to prove forwarding happens only after reservation. */
test('protocol guard forwards only admitted requests and closes owned pages once', async () => {
  const fake = fakeBrowser(); const { budget } = budgetFixture(); budget.phaseLimits.app = 1;
  const observer = new BrowserObserver(fake.context, budget, new IdentityObserver('fixture'), ['https://example.test']);
  await observer.newPage(1);
  assert.equal(fake.commands.find(command => command.command === 'Emulation.setFocusEmulationEnabled').enabled, false);
  for (let index = 1; index <= 3; index++) fake.protocol.emit('Fetch.requestPaused', {
    requestId: `fetch-${index}`, networkId: `net-${index}`, resourceType: 'Document',
    request: { url: 'https://example.test/?PRIVATE_TOKEN', method: 'GET', headers: { Authorization: 'PRIVATE' } },
  });
  await Promise.all([...observer.pending]); await observer.close(); await observer.close();
  assert.equal(fake.commands.filter(command => command.command === 'Fetch.continueRequest').length, 1);
  assert.equal(budget.counts.app, 1); assert.equal(fake.closed(), 1);
  assert.doesNotMatch(JSON.stringify(budget.report()), /PRIVATE|example\.test|fetch-|net-/);
});

/** Redirect targets must be stopped before forwarding when redirects are outside the live contract. */
test('live protocol policy rejects a redirected request before consuming a dispatch', async () => {
  const fake = fakeBrowser(); const { budget } = budgetFixture();
  const observer = new BrowserObserver(fake.context, budget, new IdentityObserver('fixture'), ['https://example.test']);
  await observer.newPage(1);
  fake.protocol.emit('Fetch.requestPaused', { requestId: 'next', networkId: 'net', redirectedRequestId: 'previous',
    resourceType: 'Document', request: { url: 'https://example.test/next', method: 'GET' } });
  await Promise.all([...observer.pending]); await observer.close();
  assert.equal(budget.reason, 'unexpected_redirect'); assert.equal(budget.counts.app, 0);
  assert.equal(fake.commands.filter(command => command.command === 'Fetch.continueRequest').length, 0);
});

/** CSRF metadata must finish at the explicitly approved header boundary without reading token bytes. */
test('CSRF timing uses response headers and never retrieves its body', async () => {
  const fake = fakeBrowser(); const { budget } = budgetFixture();
  const observer = new BrowserObserver(fake.context, budget, new IdentityObserver('fixture'), ['https://example.test']);
  await observer.newPage(1);
  fake.protocol.emit('Network.requestWillBeSent', { requestId: 'net-csrf', timestamp: 1 });
  fake.protocol.emit('Fetch.requestPaused', { requestId: 'csrf', networkId: 'net-csrf', resourceType: 'Fetch',
    request: { url: 'https://example.test/api/auth/csrf', method: 'GET' } });
  await Promise.all([...observer.pending]);
  fake.protocol.emit('Network.responseReceived', { requestId: 'net-csrf', timestamp: 1.02,
    response: { status: 200, headers: { 'Set-Cookie': 'PRIVATE_CSRF' } } });
  const record = budget.report().records[0];
  assert.equal(record.observationComplete, true); assert.equal(record.timingBoundary, 'response_headers');
  assert.ok(Math.abs(record.durationMs - 20) < 0.001);
  assert.equal(fake.commands.filter(command => command.command === 'Network.getResponseBody').length, 0);
  assert.doesNotMatch(JSON.stringify(budget.report()), /PRIVATE_CSRF/);
  await observer.close();
});

/** An armed deadline must close owned browser pages even when no further request arrives. */
test('idle deadline triggers owned-tab cleanup', async () => {
  const fake = fakeBrowser(); const budget = new RequestBudget({ totalMs: 40 });
  const observer = new BrowserObserver(fake.context, budget, new IdentityObserver('fixture'), ['https://example.test']);
  await observer.newPage(1); budget.arm();
  // Await the stop signal without sending traffic or manually invoking the deadline check.
  await new Promise(resolve => {
    const keeper = setTimeout(resolve, 100);
    budget.controller.signal.addEventListener('abort', () => { clearTimeout(keeper); resolve(); }, { once: true });
  });
  await observer.close(); budget.dispose();
  assert.equal(budget.reason, 'deadline'); assert.equal(fake.closed(), 1);
});

/** Cleanup errors cannot be swallowed by allSettled and later represented as a successful run. */
test('failed owned-page cleanup stops with a sanitized reason', async () => {
  const fake = fakeBrowser(); const { budget } = budgetFixture();
  // The raw transport message must never escape into the returned report.
  fake.page.close = async function failClose() { throw new Error('PRIVATE_TRANSPORT_DETAILS'); };
  const observer = new BrowserObserver(fake.context, budget, new IdentityObserver('fixture'), ['https://example.test']);
  await observer.newPage(1); await observer.close();
  assert.equal(budget.reason, 'cleanup_failed'); assert.equal(observer.cleanupSummary.closeErrors, 1);
  assert.equal(observer.cleanupSummary.pagesStillOpen, 1);
  assert.doesNotMatch(JSON.stringify(budget.report()), /PRIVATE_TRANSPORT_DETAILS/);
});

/** A vanished browser must not leave the runner waiting forever for a shutdown acknowledgement. */
test('lost browser acknowledgements have a finite, sanitized deadline', async () => {
  // This promise models a CDP close command whose target exits without acknowledging it.
  const neverAcknowledged = new Promise(() => {});
  await assert.rejects(withTimeout(neverAcknowledged, 20, 'browser_close_timeout'), /browser_close_timeout/);
  assert.equal(await withTimeout(Promise.resolve('acknowledged'), 20, 'browser_close_timeout'), 'acknowledged');
});
