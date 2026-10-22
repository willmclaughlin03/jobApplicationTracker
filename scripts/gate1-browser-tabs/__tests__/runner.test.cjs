'use strict';
/* global AbortController, AbortSignal, Headers, ReadableStream, Response, URL, clearTimeout, setTimeout */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { compileFunction } = require('node:vm');
const { QualificationError, RequestBudget, IdentityObserver, BrowserObserver, classifyRequest, validateBuild, checkBuild,
  summarizeDurations, waitUntil, waitForChecks, withTimeout, exerciseProfile, runProfiles, parseCli, main, TARGET, PROFILES, SCHEDULE, LIVE_APPROVAL } = require('../runner.cjs');

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

/** Model two concurrent navigations with injectable document dispatches and completed auth checks. */
function startupFixture(dispatch) {
  const fixture = budgetFixture(); const navigations = [];
  const observer = { budget: fixture.budget,
    /** Supply inert pages whose dispatch occurs only after both goto calls have started. */
    async newPage(tab) {
      return {
        /** Yield before reserving requests to expose differences between invocation and dispatch time. */
        async goto() {
          navigations.push({ tab, at: fixture.budget.clock() });
          await Promise.resolve();
          assert.equal(navigations.length, 2, 'both navigations must start before either dispatches');
          dispatch(tab, fixture);
          for (const kind of ['session', 'csrf']) {
            const record = fixture.budget.reserve(kind, tab); record.finished = true; record.durationMs = 1;
          }
        },
      };
    },
    /** All mocked requests finish within goto, so no protocol drain is needed. */
    async settled() {},
    /** Keep activation inert so startup observations can be tested without a browser. */
    async activate() {},
  };
  return { ...fixture, observer, navigations,
    schedule: { ...SCHEDULE, rounds: 0, observationMs: 0, slotMs: 0 } };
}

/** Simultaneous goto calls must not hide dispatch skew beyond the approved startup spread. */
test('startup spread uses document dispatch times rather than goto invocation times', async () => {
  /** Delay only the second dispatch while keeping both navigation calls concurrent. */
  const fixture = startupFixture((tab, { budget, advance }) => {
    if (tab === 2) advance(SCHEDULE.startupSpreadMs + 1);
    budget.reserve('document', tab).finished = true;
  });
  await assert.rejects(exerciseProfile(fixture.observer, { tabs: 2 }, 'https://example.test', fixture.schedule),
    { code: 'startup_spread' });
  assert.deepEqual(fixture.navigations, [{ tab: 1, at: 0 }, { tab: 2, at: 0 }]);
});

/** Accept the exact spread boundary using the first current-phase document for each tab only. */
test('startup spread ignores prior phases, neutral tabs and later document requests', async () => {
  /** Put the first dispatches at the boundary, then add a later request that must not replace them. */
  const fixture = startupFixture((tab, { budget, advance }) => {
    if (tab === 2) advance(SCHEDULE.startupSpreadMs);
    budget.reserve('document', tab).finished = true;
    if (tab === 2) {
      advance(SCHEDULE.startupSpreadMs + 1);
      budget.reserve('document', 1).finished = true;
    }
  });
  fixture.budget.reserve('document', 1).finished = true;
  fixture.advance(SCHEDULE.startupSpreadMs + 1);
  fixture.budget.reserve('document', 2).finished = true;
  fixture.budget.begin('startup', { app: 100, static: 100, session: 100 }, 100_000);
  fixture.budget.reserve('document', 0).finished = true;
  fixture.advance(SCHEDULE.startupSpreadMs + 1);
  const result = await exerciseProfile(fixture.observer, { tabs: 2 }, 'https://example.test', fixture.schedule);
  assert.equal(result.session.count, 2); assert.equal(result.csrf.count, 2);
});

/** A previous-phase record or malformed timestamp cannot substitute for a current document observation. */
test('startup requires a finite document reservation timestamp for every tab', async () => {
  for (const timestamp of [undefined, null, NaN, Infinity, '0']) {
    /** Omit the second document or corrupt its timestamp while leaving auth checks complete. */
    const fixture = startupFixture((tab, { budget }) => {
      if (tab === 2 && timestamp === undefined) return;
      const record = budget.reserve('document', tab); record.finished = true;
      if (tab === 2) record.startedMs = timestamp;
    });
    fixture.budget.reserve('document', 2).finished = true;
    fixture.budget.begin('startup', { app: 100, static: 100, session: 100 }, 100_000);
    await assert.rejects(exerciseProfile(fixture.observer, { tabs: 2 }, 'https://example.test', fixture.schedule),
      { code: 'missing_observation' }, `timestamp: ${String(timestamp)}`);
  }
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
  const headers = freshBuildHeaders();
  assert.equal(validateBuild(html, 200, headers), true);
  assert.throws(() => validateBuild(html, 302, new Headers()), /target_status/);
  assert.throws(() => validateBuild(html, 200, new Headers()), /cached_target/);
  assert.throws(() => validateBuild(html, 200, headers, 'different-build'), /build_mismatch/);
  assert.throws(() => validateBuild('<html></html>', 200, headers), /build_missing/);
  assert.throws(() => validateBuild('<script id="__NEXT_DATA__">{broken</script>', 200, headers), /build_schema/);
});

/** Model the static login response, with optional header deletion/overrides for invalid cases. */
function freshBuildHeaders(overrides = {}) {
  const headers = new Headers({ 'cache-control': 'public, max-age=0, must-revalidate', 'x-vercel-cache': 'MISS', age: '0' });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
}

/** Supply synthetic protection metadata without reading any real browser or credential. */
function protectionFixture(overrides = {}) {
  const cookie = { name: '_vercel_jwt', value: 'SYNTHETIC_PROTECTION_SENTINEL',
    domain: new URL(TARGET.immutableOrigin).hostname, path: '/', secure: true, httpOnly: true,
    expires: Date.now() / 1000 + 3600, ...overrides };
  return { cookie,
    /** Return the synthetic record only for the pinned build-probe URL. */
    async cookies(urls) { assert.deepEqual(urls, [`${TARGET.immutableOrigin}/login`]); return [cookie]; } };
}

/** Exercise the static route's exact policy while accepting harmless formatting and fresh CDN states. */
test('build freshness accepts revalidation policy and explicit fresh cache states', () => {
  const html = `<script id="__NEXT_DATA__">${JSON.stringify({ buildId: TARGET.build })}</script>`;
  for (const status of ['MISS', 'BYPASS', 'REVALIDATED', ' miss ']) {
    for (const age of [null, '0']) {
      assert.equal(validateBuild(html, 200, freshBuildHeaders({
        'cache-control': 'MUST-REVALIDATE, Public, max-age = 0', 'x-vercel-cache': status, age,
      })), true);
    }
  }
});

/** Deployment-cached login bytes may have a positive age, but must still identify the exact pinned build. */
test('static build attribution accepts cache hits only with the pinned build', () => {
  const html = `<script id="__NEXT_DATA__">${JSON.stringify({ buildId: TARGET.build })}</script>`;
  for (const status of ['HIT', ' hit ']) {
    for (const age of ['0', '11138', String(Number.MAX_SAFE_INTEGER)]) {
      const headers = freshBuildHeaders({ 'x-vercel-cache': status, age });
      assert.equal(validateBuild(html, 200, headers), true);
      assert.throws(() => validateBuild(html, 200, headers, 'different-build'), { code: 'build_mismatch' });
    }
  }
});

/** A HIT needs a present, numeric, unambiguous Age; coercion must not accept malformed cache evidence. */
test('static cache hits reject absent, malformed and unsafe ages', () => {
  const html = `<script id="__NEXT_DATA__">${JSON.stringify({ buildId: TARGET.build })}</script>`;
  for (const age of [null, '', '-1', '+1', '1.5', '1e3', '0x10', 'NaN', 'Infinity',
    '0, 1', '1 2', String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => validateBuild(html, 200, freshBuildHeaders({ 'x-vercel-cache': 'HIT', age })),
      { code: 'cached_target' });
  }
});

/** Missing, ambiguous, unexpected or stale cache evidence must not authorize even a correctly attributed build. */
test('build freshness rejects incomplete, conflicting and stale cache evidence', () => {
  const html = `<script id="__NEXT_DATA__">${JSON.stringify({ buildId: TARGET.build })}</script>`;
  const invalid = {
    'cache-control': [null, '', 'public', 'public, max-age=0', 'max-age=0, must-revalidate',
      'private, no-store', 'public, max-age=60, must-revalidate',
      'public, max-age=0, must-revalidate, max-age=60', 'public, max-age=0, must-revalidate, s-maxage=60',
      'public, max-age=0, must-revalidate, stale-while-revalidate=60',
      'public, max-age=0, must-revalidate, stale-if-error=60'],
    'x-vercel-cache': [null, '', 'stale', 'PRERENDER', 'UNKNOWN', 'MISS, HIT'],
    age: ['', '1', '-1', 'invalid', '0, 1'],
  };
  for (const [name, values] of Object.entries(invalid)) {
    for (const value of values) {
      assert.throws(() => validateBuild(html, 200, freshBuildHeaders({ [name]: value })),
        { code: 'cached_target' }, `${name}: ${value}`);
    }
  }
});

/** Stub every fetch so both target probes enforce the contract without sending hosted traffic. */
test('both login probes accept static cache hits and preserve cached_target on policy failure', async (t) => {
  const html = `<script id="__NEXT_DATA__">${JSON.stringify({ buildId: TARGET.build })}</script>`;
  let responseHeaders = freshBuildHeaders();
  /** Return only synthetic HTML; mock call records verify credentials, redirects and probe uniqueness. */
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(html, { headers: responseHeaders }));
  for (const origin of [TARGET.origin, TARGET.immutableOrigin]) {
    const { budget } = budgetFixture();
    responseHeaders = freshBuildHeaders({ 'x-vercel-cache': 'HIT', age: '11138' });
    await checkBuild(budget, origin, TARGET.build, protectionFixture());
    assert.equal(budget.reason, null); assert.equal(budget.records[0].finished, true);
    responseHeaders = freshBuildHeaders({ 'cache-control': null });
    await assert.rejects(checkBuild(budget, origin, TARGET.build, protectionFixture()), { code: 'cached_target' });
    assert.equal(budget.reason, 'cached_target'); assert.equal(budget.counts.app, 2);
    assert.equal(budget.records[1].finished, true); assert.equal(budget.records[1].status, 200);
  }
  const calls = fetchMock.mock.calls;
  /** Compare dispatched URLs to catch reused probe values within each origin. */
  assert.equal(new Set(calls.map(call => call.arguments[0])).size, 4);
  assert.notEqual(new URL(calls[0].arguments[0]).search, new URL(calls[2].arguments[0]).search);
  for (const [index, call] of calls.entries()) {
    const [rawUrl, options] = call.arguments; const url = new URL(rawUrl);
    assert.equal(url.origin, index < 2 ? TARGET.origin : TARGET.immutableOrigin);
    assert.equal(url.pathname, '/login'); assert.ok(url.searchParams.get('gate1_build'));
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['Cache-Control'], 'no-cache, no-store, max-age=0');
    assert.equal(options.headers.Pragma, 'no-cache');
    assert.equal(options.headers.Cookie, index < 2 ? undefined : '_vercel_jwt=SYNTHETIC_PROTECTION_SENTINEL');
  }
});

/** Failure on either preflight host must stop runProfiles before any browser page is created. */
test('both target cache-policy checks precede browser execution', async (t) => {
  for (const failingOrigin of [TARGET.origin, TARGET.immutableOrigin]) {
    /** Each subtest owns its mocks so production clocks and global fetch are restored afterward. */
    await t.test(failingOrigin === TARGET.origin ? 'canonical' : 'immutable', async (subtest) => {
      const originalCheck = RequestBudget.prototype.check; let skippedQuietPeriod = false;
      /** Advance only the preflight quiet period; retain the real deadline and budget guards. */
      subtest.mock.method(RequestBudget.prototype, 'check', function check() {
        if (this.phase === 'tabs_1' && !skippedQuietPeriod) {
          const clock = this.clock;
          /** Offset the monotonic clock so the real quiet wait completes without a long test delay. */
          this.clock = () => clock() + SCHEDULE.quietMs; skippedQuietPeriod = true;
        }
        return originalCheck.call(this);
      });
      const calls = [];
      /** Both cached responses have the correct build; only the selected host violates cache policy. */
      subtest.mock.method(globalThis, 'fetch', async (rawUrl) => {
        const origin = new URL(rawUrl).origin; calls.push(origin);
        return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ buildId: TARGET.build })}</script>`, {
          headers: freshBuildHeaders({ 'x-vercel-cache': 'HIT', age: '11138',
            ...(origin === failingOrigin ? { 'cache-control': null } : {}) }),
        });
      });
      const context = {
        ...protectionFixture(),
        /** Provide only the prepared blank context required by the live entry point. */
        pages() { return [{
          /** Identify the sole prepared page without reading any actual browser state. */
          url() { return 'about:blank'; },
        }]; },
        /** Model the required absence of service workers without starting a browser. */
        serviceWorkers() { return []; },
        /** Any attempted browser work would mean an invalid probe passed authorization. */
        newPage: subtest.mock.fn(() => { throw new Error('browser_must_not_start'); }),
      };
      const result = await runProfiles({ context, approvedProfiles: [1, 2, 4, 8],
        approval: LIVE_APPROVAL, approvedUserId: 'fixture-user' });
      assert.equal(result.reason, 'cached_target'); assert.equal(result.outcome, 'STOPPED');
      assert.equal(result.profiles.length, 0); assert.equal(context.newPage.mock.callCount(), 0);
      assert.deepEqual(calls, failingOrigin === TARGET.origin ? [TARGET.origin] : [TARGET.origin, TARGET.immutableOrigin]);
      assert.ok(result.records.every(record => record.observationComplete));
    });
  }
});

/** Reject absent, ambiguous, expired, unsafe and broad cookies before any network dispatch. */
test('protected probes fail closed on unusable authentication and export no credential data', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must_not_dispatch'); });
  const cases = [
    [null, 'protection_auth_missing'],
    [{ cookies: async () => [] }, 'protection_auth_missing'],
    [{ cookies: async () => [protectionFixture().cookie, protectionFixture().cookie] }, 'protection_auth_ambiguous'],
    [protectionFixture({ name: 'unknown_cookie' }), 'protection_auth_missing'],
    [protectionFixture({ domain: 'vercel.app' }), 'protection_auth_scope'],
    [protectionFixture({ domain: `.${new URL(TARGET.immutableOrigin).hostname}` }), 'protection_auth_scope'],
    [protectionFixture({ domain: new URL(TARGET.origin).hostname }), 'protection_auth_scope'],
    [protectionFixture({ path: '/login' }), 'protection_auth_scope'],
    [protectionFixture({ secure: false }), 'protection_auth_scope'],
    [protectionFixture({ httpOnly: false }), 'protection_auth_scope'],
    [protectionFixture({ partitionKey: 'https://example.invalid' }), 'protection_auth_scope'],
    [protectionFixture({ expires: Date.now() / 1000 - 1 }), 'protection_auth_expired'],
    [protectionFixture({ expires: Date.now() / 1000 + 2 }), 'protection_auth_expired'],
    [protectionFixture({ expires: NaN }), 'protection_auth_expired'],
    [protectionFixture({ value: 'SYNTHETIC; other=secret' }), 'protection_auth_value'],
    [protectionFixture({ value: 'SYNTHETIC\r\nX-Test: secret' }), 'protection_auth_value'],
    [protectionFixture({ value: '' }), 'protection_auth_value'],
    [protectionFixture({ value: 'x'.repeat(16_385) }), 'protection_auth_value'],
    [{ cookies: async () => { throw new Error('PRIVATE_COOKIE_ERROR'); } }, 'tool_failure'],
  ];
  for (const [context, code] of cases) {
    const { budget } = budgetFixture();
    await assert.rejects(checkBuild(budget, TARGET.immutableOrigin, TARGET.build, context), { code });
    assert.equal(budget.reason, code); assert.equal(budget.counts.app, 1);
    assert.equal(budget.records[0].finished, true);
    assert.doesNotMatch(JSON.stringify(budget.report()), /SYNTHETIC|PRIVATE|vercel_jwt|cookie.value/);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

/** Canonical probes must not even consult browser cookies; malformed/foreign destinations never dispatch. */
test('canonical remains anonymous and target variants cannot receive authentication', async (t) => {
  const context = { cookies: t.mock.fn(async () => { throw new Error('PRIVATE_MUST_NOT_READ'); }) };
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(
    `<script id="__NEXT_DATA__">{"buildId":"${TARGET.build}"}</script>`, { headers: freshBuildHeaders() }));
  await checkBuild(budgetFixture().budget, TARGET.origin, TARGET.build, context);
  assert.equal(context.cookies.mock.callCount(), 0);
  assert.equal(Object.hasOwn(fetchMock.mock.calls[0].arguments[1].headers, 'Cookie'), false);
  for (const origin of ['https://example.invalid', `${TARGET.immutableOrigin}/`,
    `${TARGET.immutableOrigin}/login`, TARGET.immutableOrigin.replace('https:', 'http:'),
    TARGET.immutableOrigin.replace('https://', 'https://user:secret@')]) {
    await assert.rejects(checkBuild(budgetFixture().budget, origin, TARGET.build, context), { code: 'unexpected_origin' });
  }
  assert.equal(fetchMock.mock.callCount(), 1); assert.equal(context.cookies.mock.callCount(), 0);
});

/** Reserve before asynchronous cookie access; exhaustion must not start lookup or a fetch. */
test('authenticated probes preserve synchronous cap reservation', async (t) => {
  const { budget } = budgetFixture(); budget.phaseLimits.app = 1;
  let release;
  const lookup = new Promise(resolve => { release = resolve; });
  const context = { cookies: t.mock.fn(() => lookup) };
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must_not_dispatch'); });
  const first = checkBuild(budget, TARGET.immutableOrigin, TARGET.build, context);
  const stopped = assert.rejects(first, { code: 'profile_budget' });
  assert.equal(budget.counts.app, 1);
  await assert.rejects(checkBuild(budget, TARGET.immutableOrigin, TARGET.build, context), { code: 'profile_budget' });
  release([protectionFixture().cookie]); await stopped;
  assert.equal(context.cookies.mock.callCount(), 1); assert.equal(fetchMock.mock.callCount(), 0);
});

/** Redirects and provider failures must neither consume response bodies nor expose Location/diagnostics. */
test('authenticated redirects are rejected without following or retaining their bodies', async (t) => {
  let reads = 0; let cancelled = 0;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return { status: 302, headers: new Headers({ location: 'https://example.invalid/PRIVATE_REDIRECT' }),
      body: { getReader() { reads++; throw new Error('PRIVATE_BODY'); }, async cancel() { cancelled++; } } };
  });
  const { budget } = budgetFixture();
  await assert.rejects(checkBuild(budget, TARGET.immutableOrigin, TARGET.build, protectionFixture()), { code: 'target_status' });
  assert.equal(fetchMock.mock.callCount(), 1); assert.equal(reads, 0); assert.equal(cancelled, 1);
  assert.doesNotMatch(JSON.stringify(budget.report()), /PRIVATE|SYNTHETIC|vercel_jwt|location/i);
});

/** Enforce one shared five-second signal across delayed cookie lookup, headers and response-body reads. */
test('probe deadline bounds authentication, fetch and body stalls without late dispatch', async (t) => {
  for (const stage of ['cookies', 'fetch', 'body']) {
    await t.test(stage, async (subtest) => {
      const controller = new AbortController();
      subtest.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 5000); return controller.signal; });
      let release; let cancelled = false;
      const pending = new Promise(resolve => { release = resolve; });
      const context = stage === 'cookies' ? { cookies: () => pending } : protectionFixture();
      const fetchMock = subtest.mock.method(globalThis, 'fetch', async () => {
        if (stage === 'fetch') return pending;
        return { status: 200, headers: freshBuildHeaders(), body: { getReader() { return {
          read: () => pending, cancel: async () => { cancelled = true; }, releaseLock() {},
        }; } } };
      });
      const { budget } = budgetFixture();
      const running = checkBuild(budget, TARGET.immutableOrigin, TARGET.build, context);
      const stopped = assert.rejects(running, { code: 'probe_timeout' });
      await new Promise(resolve => setTimeout(resolve, 10)); controller.abort(); await stopped;
      if (stage === 'cookies') release([protectionFixture().cookie]);
      else if (stage === 'fetch') release(new Response('late'));
      else release({ done: true });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(fetchMock.mock.callCount(), stage === 'cookies' ? 0 : 1);
      assert.equal(cancelled, stage === 'body'); assert.equal(budget.records[0].finished, true);
    });
  }
});

/** Oversized authenticated HTML must stop during streaming and cancel the reader. */
test('authenticated build body limit cancels streaming and keeps reports private', async (t) => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1_048_577)); },
    cancel() { cancelled = true; },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(stream, { headers: freshBuildHeaders() }));
  const { budget } = budgetFixture();
  await assert.rejects(checkBuild(budget, TARGET.immutableOrigin, TARGET.build, protectionFixture()), { code: 'body_limit' });
  assert.equal(cancelled, true); assert.equal(budget.reason, 'body_limit');
  assert.doesNotMatch(JSON.stringify(budget.report()), /SYNTHETIC|vercel_jwt|Cookie/);
});

/** Read current browser metadata on every probe so sign-out/expiry cannot reuse an earlier copied credential. */
test('each protected probe rechecks authentication and sends only the selected cookie', async (t) => {
  let calls = 0;
  const context = { async cookies() { calls++; return calls === 1
    ? [protectionFixture({ expires: -1 }).cookie, { name: 'app_session', value: 'PRIVATE_APP_COOKIE' }] : []; } };
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(
    `<script id="__NEXT_DATA__">{"buildId":"${TARGET.build}"}</script>`, { headers: freshBuildHeaders() }));
  const { budget } = budgetFixture();
  await checkBuild(budget, TARGET.immutableOrigin, TARGET.build, context);
  await assert.rejects(checkBuild(budget, TARGET.immutableOrigin, TARGET.build, context), { code: 'protection_auth_missing' });
  assert.equal(calls, 2); assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fetchMock.mock.calls[0].arguments[1].headers.Cookie, '_vercel_jwt=SYNTHETIC_PROTECTION_SENTINEL');
  assert.doesNotMatch(JSON.stringify(budget.report()), /PRIVATE|SYNTHETIC|vercel_jwt/);
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

/** Load the actual launcher with fake file/process/clock dependencies; no browser or filesystem mutations occur. */
async function nativeLaunchFixture(t, contents) {
  const runnerPath = require.resolve('../runner.cjs');
  const source = await readFile(runnerPath, 'utf8');
  const corePath = path.resolve('fixture-playwright-core');
  const profilePath = path.resolve('fixture-root', 'edge-fixture-test');
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  let now = 0; let reads = 0; const delays = [];
  /** End only the fake process when startup cleanup reaches its existing grace deadline. */
  child.kill = t.mock.fn(() => { child.exitCode = 0; });
  const connected = new Error('fixture_connected');
  /** Stop at the CDP boundary so tests inspect the chosen port without building a browser double. */
  const connectOverCDP = t.mock.fn(async () => { child.exitCode = 0; throw connected; });
  const fakeFs = {
    /** Profile setup is inert; all paths stay synthetic. */
    async mkdir() {},
    /** Return the owned fake profile for the launcher's existing cleanup path guard. */
    async mkdtemp() { return profilePath; },
    /** Resolve only the synthetic root and profile, without inspecting actual browser storage. */
    async realpath(value) { return value === profilePath ? profilePath : path.dirname(profilePath); },
    /** Replay partial writes or read errors, retaining the last result until the outer deadline. */
    async readFile(file, encoding) {
      assert.equal(file, path.join(profilePath, 'DevToolsActivePort')); assert.equal(encoding, 'utf8');
      const result = contents[Math.min(reads++, contents.length - 1)];
      if (result instanceof Error) throw result;
      return result;
    },
    /** Record cleanup without deleting any real paths. */
    rm: t.mock.fn(async () => {}),
  };
  const dependencies = new Map([
    ['node:fs/promises', fakeFs], ['node:child_process', { spawn: () => child }],
    ['node:perf_hooks', { performance: { now: () => now } }],
    // Advance only the host polling/cleanup clock; retain real acknowledgement timers.
    ['node:timers/promises', { setTimeout: async ms => { delays.push(ms); now += ms; } }],
    [path.join(corePath, 'package.json'), { name: 'playwright-core', version: '1.62.0-alpha-1783623505000' }],
    [corePath, { chromium: { connectOverCDP } }],
  ]);
  /** Substitute external effects while executing the full current module, including its internal launcher. */
  const fixtureRequire = name => dependencies.has(name) ? dependencies.get(name) : require(name);
  const launch = compileFunction(`${source}\nreturn launchNativeBrowser;`, ['require', 'module', '__dirname'],
    { filename: runnerPath })(fixtureRequire, { exports: {} }, path.dirname(runnerPath));
  return { connectOverCDP, connected, delays, child, fakeFs,
    /** Invoke the real startup/cleanup flow with the mocked local runtime. */
    run: () => launch({ corePath, browserPath: path.resolve('fixture-edge') }),
    /** Expose read count so a deadline test catches both early failure and unbounded retry. */
    reads: () => reads };
}

/** Empty/invalid partial writes and ENOENT must retry before connecting at either valid port boundary. */
test('native browser port polling retries not-ready content before connecting', async (t) => {
  for (const port of [1, 65535]) {
    const missing = Object.assign(new Error('fixture_missing'), { code: 'ENOENT' });
    const notReady = [missing, '', '\r\n', ' \n', '0\n', '-1\n', '65536\n', '1.5\n', 'NaN\n', 'Infinity\n', 'partial\n'];
    const fixture = await nativeLaunchFixture(t, [...notReady, `${port}\r\n/devtools/browser/fixture`]);
    await assert.rejects(fixture.run(), error => error === fixture.connected);
    assert.equal(fixture.reads(), notReady.length + 1);
    assert.deepEqual(fixture.delays, Array(notReady.length).fill(50));
    assert.deepEqual(fixture.connectOverCDP.mock.calls[0].arguments,
      [`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 5000 }]);
    assert.equal(fixture.connectOverCDP.mock.callCount(), 1);
    assert.equal(fixture.fakeFs.rm.mock.callCount(), 1);
  }
});

/** Persistent unreadiness must still stop at the ten-second startup deadline and clean up. */
test('native browser port polling remains bounded by the startup deadline', async (t) => {
  for (const content of ['', 'invalid', Object.assign(new Error('fixture_missing'), { code: 'ENOENT' })]) {
    const fixture = await nativeLaunchFixture(t, [content]);
    await assert.rejects(fixture.run(), { code: 'browser_startup' });
    assert.equal(fixture.reads(), 200); assert.equal(fixture.connectOverCDP.mock.callCount(), 0);
    assert.ok(fixture.delays.every(ms => ms === 50));
    assert.equal(fixture.child.kill.mock.callCount(), 1); assert.equal(fixture.fakeFs.rm.mock.callCount(), 1);
  }
});

/** File failures other than ENOENT remain fatal instead of being masked as startup retries. */
test('native browser port polling propagates non-ENOENT read failures', async (t) => {
  const denied = Object.assign(new Error('fixture_denied'), { code: 'EACCES' });
  const fixture = await nativeLaunchFixture(t, [denied]);
  await assert.rejects(fixture.run(), error => error === denied);
  assert.equal(fixture.reads(), 1); assert.equal(fixture.connectOverCDP.mock.callCount(), 0);
  assert.equal(fixture.fakeFs.rm.mock.callCount(), 1);
});

/** Model an owned manual/debug lifecycle without opening windows, reading auth files or mutating the filesystem. */
async function manualLifecycleFixture(t, { holdConnect = false, refuseExit = false, unsafePath = false, failDebug = false } = {}) {
  const runnerPath = require.resolve('../runner.cjs'); const source = await readFile(runnerPath, 'utf8');
  const corePath = path.resolve('fixture-playwright-core'); const root = path.resolve('fixture-owned-root');
  const profilePath = path.join(root, 'edge-fixture-owned');
  const children = []; let now = 0; let connected = false; let releaseConnect;
  const connectionGate = new Promise(resolve => { releaseConnect = resolve; });
  const page = { async close() {}, url() { return 'about:blank'; } };
  const context = { async newPage() { return page; }, pages() { return [page]; } };
  const browser = {
    isConnected() { return connected; }, contexts() { return [context]; },
    async close() { connected = false; },
    /** A graceful CDP close ends only the latest owned process. */
    async newBrowserCDPSession() { return { async send(command) {
      assert.equal(command, 'Browser.close');
      if (!refuseExit) children.at(-1).exitCode = 0;
      connected = false;
    } }; },
  };
  const connectOverCDP = t.mock.fn(async (_url, options) => {
    assert.deepEqual(options, { noDefaults: true, timeout: 5000 });
    if (holdConnect) await connectionGate;
    connected = true; return browser;
  });
  const spawnMock = t.mock.fn((_executable, args) => {
    const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
    child.kill = t.mock.fn(() => { if (!refuseExit) child.signalCode = 'SIGTERM'; });
    children.push(child);
    if (failDebug && args.includes('--remote-debugging-port=0')) child.exitCode = 1;
    return child;
  });
  const fakeFs = {
    async mkdir() {}, mkdtemp: t.mock.fn(async () => profilePath),
    /** Refuse cleanup if the owned directory resolves somewhere else. */
    async realpath(value) { return value === profilePath
      ? (unsafePath ? path.resolve('unrelated-profile') : profilePath) : root; },
    /** The launcher may inspect only its own CDP bootstrap file, never stored browser credentials. */
    readFile: t.mock.fn(async file => {
      assert.equal(file, path.join(profilePath, 'DevToolsActivePort')); return '43210\n/devtools/browser/fixture';
    }),
    rm: t.mock.fn(async () => {}),
  };
  const dependencies = new Map([
    ['node:fs/promises', fakeFs], ['node:child_process', { spawn: spawnMock }],
    ['node:perf_hooks', { performance: { now: () => now } }],
    ['node:timers/promises', { setTimeout: async ms => { now += ms; } }],
    [path.join(corePath, 'package.json'), { name: 'playwright-core', version: '1.62.0-alpha-1783623505000' }],
    [corePath, { chromium: { connectOverCDP } }],
  ]);
  /** Reuse the real launcher with only OS/process dependencies replaced. */
  const fixtureRequire = name => dependencies.has(name) ? dependencies.get(name) : require(name);
  const launch = compileFunction(`${source}\nreturn launchNativeBrowser;`, ['require', 'module', '__dirname'],
    { filename: runnerPath })(fixtureRequire, { exports: {} }, path.dirname(runnerPath));
  return { children, spawnMock, fakeFs, connectOverCDP, releaseConnect,
    run: () => launch({ corePath, browserPath: path.resolve('fixture-edge'), manualFirst: true }) };
}

/** Ordinary sign-in must have neither a debugging switch, CDP connection nor credential-file read. */
test('manual sign-in opens only a fresh owned profile without automation attached', async (t) => {
  const fixture = await manualLifecycleFixture(t); const manual = await fixture.run();
  const args = fixture.spawnMock.mock.calls[0].arguments[1];
  assert.equal(args.some(arg => /remote-debugging|enable-automation/.test(arg)), false);
  assert.ok(args.includes('--new-window')); assert.ok(args.at(-1).startsWith('data:text/html'));
  assert.equal(fixture.connectOverCDP.mock.callCount(), 0); assert.equal(fixture.fakeFs.readFile.mock.callCount(), 0);
  assert.deepEqual(manual.status(), { phase: 'manual', processExited: false, manualExitClean: false, automationAttached: false });
  await assert.rejects(manual.attachAfterManualSignIn(), { code: 'manual_browser_still_open' });
  assert.equal(fixture.spawnMock.mock.callCount(), 1); assert.equal(fixture.children[0].kill.mock.callCount(), 0);
  await manual.close(); assert.equal(fixture.fakeFs.rm.mock.callCount(), 1);
});

/** A clean owner exit allows exactly one restart on the identical profile, retaining its browser-managed state. */
test('clean manual exit reuses the owned profile once and cleanup is idempotent', async (t) => {
  const fixture = await manualLifecycleFixture(t); const manual = await fixture.run();
  fixture.children[0].exitCode = 0; assert.equal(manual.status().manualExitClean, true);
  const native = await manual.attachAfterManualSignIn();
  const [first, second] = fixture.spawnMock.mock.calls.map(call => call.arguments[1]);
  assert.equal(first[0], second[0]); assert.equal(fixture.fakeFs.mkdtemp.mock.callCount(), 1);
  assert.ok(second.includes('--no-startup-window')); assert.ok(second.includes('--remote-debugging-port=0'));
  assert.equal(fixture.fakeFs.rm.mock.callCount(), 0); assert.equal(fixture.children[0].kill.mock.callCount(), 0);
  assert.equal(native.status().automationAttached, true);
  await assert.rejects(manual.attachAfterManualSignIn(), { code: 'manual_phase_required' });
  await Promise.all([manual.close(), native.close()]);
  assert.equal(fixture.fakeFs.rm.mock.callCount(), 1); assert.equal(manual.status().phase, 'closed');
  assert.doesNotMatch(JSON.stringify(manual.status()), /fixture-owned-root|user-data-dir|cookie|43210/);
});

/** Nonzero and forced exits cannot be treated as successful cookie-flushing manual shutdowns. */
test('manual crash or forced termination blocks restart and preserves profile until cleanup', async (t) => {
  for (const failure of ['nonzero', 'signal']) {
    const fixture = await manualLifecycleFixture(t); const manual = await fixture.run();
    if (failure === 'nonzero') fixture.children[0].exitCode = 1;
    else fixture.children[0].signalCode = 'SIGTERM';
    await assert.rejects(manual.attachAfterManualSignIn(), { code: 'manual_exit_unclean' });
    assert.equal(fixture.spawnMock.mock.callCount(), 1); assert.equal(fixture.fakeFs.rm.mock.callCount(), 0);
    await manual.close();
  }
});

/** Concurrent attach requests cannot duplicate the owned process or perform overlapping profile access. */
test('manual restart latches before asynchronous attachment and supports cancellation cleanup', async (t) => {
  const fixture = await manualLifecycleFixture(t, { holdConnect: true }); const manual = await fixture.run();
  fixture.children[0].exitCode = 0;
  const attaching = manual.attachAfterManualSignIn();
  const stopped = assert.rejects(attaching, { code: 'browser_closed' });
  await assert.rejects(manual.attachAfterManualSignIn(), { code: 'manual_phase_required' });
  const closing = manual.close(); fixture.releaseConnect();
  await stopped; await closing;
  assert.equal(fixture.spawnMock.mock.callCount(), 2); assert.equal(fixture.fakeFs.rm.mock.callCount(), 1);
});

/** A live process or changed resolved path must prevent recursive deletion. */
test('manual lifecycle cleanup refuses live processes and unrelated profile paths', async (t) => {
  for (const options of [{ refuseExit: true }, { unsafePath: true }]) {
    const fixture = await manualLifecycleFixture(t, options); const manual = await fixture.run();
    await assert.rejects(manual.close(), { code: options.refuseExit ? 'browser_close_timeout' : 'cleanup_path' });
    assert.equal(fixture.fakeFs.rm.mock.callCount(), 0);
    await assert.rejects(manual.attachAfterManualSignIn(), { code: 'manual_phase_required' });
  }
});

/** A cleanup problem cannot replace the primary startup failure with private filesystem diagnostics. */
test('failed manual restart retains its original stop reason and a separate cleanup failure', async (t) => {
  const fixture = await manualLifecycleFixture(t, { unsafePath: true, failDebug: true }); const manual = await fixture.run();
  fixture.children[0].exitCode = 0;
  await assert.rejects(manual.attachAfterManualSignIn(), error => {
    assert.equal(error.code, 'browser_startup'); assert.equal(error.cleanupFailure, 'cleanup_path');
    assert.doesNotMatch(JSON.stringify(error), /fixture-owned-root|unrelated-profile/); return true;
  });
  assert.equal(fixture.fakeFs.rm.mock.callCount(), 0);
});

/** Exercise the current selfCheck with synthetic browser work while retaining real budget reports and error sanitization. */
async function selfCheckFixture(t, { stopped = false, cleanupFailure, closeFixture } = {}) {
  const runnerPath = require.resolve('../runner.cjs');
  const source = await readFile(runnerPath, 'utf8');
  const fixture = { origin: 'http://127.0.0.1:1234', counts: new Map([['/redirect', 1]]),
    /** Let tests observe or hold fixture shutdown without opening a listening socket. */
    close: t.mock.fn(closeFixture || (async () => {})) };
  let loaded;
  const native = { context: {},
    /** Model both a fixed runner error and an OS failure carrying private diagnostic text. */
    close: t.mock.fn(async () => {
      if (cleanupFailure === 'known') throw new loaded.QualificationError('cleanup_path');
      if (cleanupFailure === 'unknown') throw new Error('PRIVATE_PROFILE_PATH');
    }) };
  /** Supply only the observer operations selfCheck needs so its report and finally flow remain real. */
  class FixtureObserver {
    /** Keep the real budget available for the synthetic redirect check. */
    constructor(_context, budget) {
      this.budget = budget; this.visibility = [];
      this.cleanupSummary = { closeErrors: 0, pagesStillOpen: 0 };
    }
    /** No actual browser resources exist in this report-focused fixture. */
    async close() {}
    /** Model a redirect cap failure after earlier checks have already produced report data. */
    async newPage() {
      return {
        /** Simulate the original redirect consuming its one permitted dispatch. */
        goto: async () => { this.budget.counts.app = stopped ? 0 : 1; this.budget.stop('profile_budget'); },
      };
    }
  }
  const replacements = {
    /** Cookie transport is exercised by the actual native fixture; keep report tests synthetic and effect-free. */
    verifyProtectionFixture: async () => {},
    /** Replace only external fixture setup; no socket or browser is launched. */
    startFixture: async () => fixture,
    /** Supply owned cleanup with selectable failure behavior. */
    launchNativeBrowser: async () => native,
    /** Populate a completed profile while leaving selfCheck's validation/report logic intact. */
    exerciseProfile: async observer => { observer.budget.counts.session = 6; return { fixtureMetric: 42 }; },
    BrowserObserver: FixtureObserver,
  };
  // Rebind collaborators in an isolated module instance without modifying the function under test.
  loaded = compileFunction(`${source}\n
    startFixture = replacements.startFixture;
    verifyProtectionFixture = replacements.verifyProtectionFixture;
    launchNativeBrowser = replacements.launchNativeBrowser;
    exerciseProfile = replacements.exerciseProfile;
    BrowserObserver = replacements.BrowserObserver;
    return { selfCheck, QualificationError };`, ['require', 'module', '__dirname', 'replacements'],
  { filename: runnerPath })(require, { exports: {} }, path.dirname(runnerPath), replacements);
  return { run: loaded.selfCheck, native, fixture };
}

/** Preserve existing stop reasons and record sanitized cleanup failures for both stopped and otherwise successful runs. */
test('self-check preserves stop reasons and reports sanitized native cleanup failures', async (t) => {
  for (const stopped of [true, false]) {
    for (const cleanupFailure of [undefined, 'known', 'unknown']) {
      const fixture = await selfCheckFixture(t, { stopped, cleanupFailure });
      const result = await fixture.run({});
      const expectedCleanup = cleanupFailure === 'known' ? 'cleanup_path'
        : cleanupFailure === 'unknown' ? 'tool_failure' : undefined;
      assert.equal(result.outcome, stopped || cleanupFailure ? 'STOPPED' : 'PASS');
      assert.equal(result.reason, stopped ? 'redirect_cap_failed' : expectedCleanup);
      assert.equal(result.cleanupFailure, expectedCleanup);
      assert.equal(Object.hasOwn(result, 'cleanupFailure'), Boolean(cleanupFailure));
      assert.equal(result.scope, 'loopback_fixture_only'); assert.equal(result.hostedRequests, 0);
      assert.equal(result.checks.length, stopped ? 3 : 4);
      assert.deepEqual(result.checks[0].metrics, { fixtureMetric: 42 });
      assert.equal((stopped ? result.measurements[0] : result.measurements).dispatched.session, 6);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROFILE_PATH|Error:|stack/);
      assert.equal(fixture.native.close.mock.callCount(), 1); assert.equal(fixture.fixture.close.mock.callCount(), 1);
    }
  }
});

/** A rejected native cleanup must still wait for the fixture socket shutdown before returning its report. */
test('self-check awaits fixture shutdown after native cleanup fails', async (t) => {
  let release; let started;
  const shutdown = new Promise(resolve => { release = resolve; });
  const closing = new Promise(resolve => { started = resolve; });
  const fixture = await selfCheckFixture(t, { cleanupFailure: 'unknown',
    /** Signal entry into fixture.close, then hold it pending until the assertion releases shutdown. */
    closeFixture: async () => { started(); await shutdown; } });
  let settled = false;
  const result = fixture.run({}).finally(() => { settled = true; });
  await closing;
  try { assert.equal(settled, false); } finally { release(); }
  const report = await result;
  assert.equal(report.reason, 'tool_failure'); assert.equal(report.cleanupFailure, 'tool_failure');
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

/** Setup failures must name the rejected operation while retaining cleanup ownership of any created page. */
test('browser setup failures expose fixed operation codes and preserve owned cleanup', async () => {
  const cases = [
    ['newPage', 'page_create_failed'],
    ['addInitScript', 'visibility_observer_install_failed'],
    ['newCDPSession', 'page_cdp_attach_failed'],
    ['Network.enable', 'browser_network_enable_failed'],
    ['Network.setCacheDisabled', 'browser_cache_disable_failed'],
    ['Emulation.setFocusEmulationEnabled', 'browser_focus_reset_failed'],
    ['Target.setAutoAttach', 'browser_child_guard_failed'],
    ['Fetch.enable', 'browser_request_guard_failed'],
  ];
  for (const [operation, code] of cases) {
    const fake = fakeBrowser(); const { budget } = budgetFixture();
    const privateError = new Error('PRIVATE_BROWSER_URL_AND_COOKIE'); privateError.code = 'PRIVATE_PROVIDER_CODE';
    /** Reject the selected synthetic operation without ever contacting a browser or reading state. */
    async function rejectOperation() { throw privateError; }
    if (operation === 'newPage' || operation === 'newCDPSession') fake.context[operation] = rejectOperation;
    else if (operation === 'addInitScript') fake.page.addInitScript = rejectOperation;
    else {
      const send = fake.protocol.send;
      /** Keep earlier setup commands successful so each protocol failure boundary is exercised independently. */
      fake.protocol.send = async function sendWithFailure(command, params) {
        if (command === operation) throw privateError;
        return send(command, params);
      };
    }
    const observer = new BrowserObserver(fake.context, budget, new IdentityObserver('fixture'), ['https://example.test']);
    await assert.rejects(observer.newPage(1), { code, message: code });
    budget.stop(code); await observer.close();
    assert.equal(fake.closed(), operation === 'newPage' ? 0 : 1);
    assert.equal(observer.cleanupSummary.closeErrors, 0); assert.equal(observer.cleanupSummary.pagesStillOpen, 0);
    assert.equal(budget.counts.app, 0); assert.equal(budget.reason, code);
    assert.doesNotMatch(JSON.stringify(budget.report()), /PRIVATE|stack|example\.test/);
  }
});

/** Supply visibility-only scalars and injectable rejections; no DOM, credentials or native input is used. */
function visibilityFailureFixture(failure, error = new Error('PRIVATE_VISIBILITY_DETAILS')) {
  const fake = fakeBrowser(); const calls = []; let waits = 0; let reads = 0;
  /** Return the selected scalar or fail at its named boundary, recording only fixed test operation names. */
  async function operation(name, value) {
    calls.push(name);
    if (failure === name) throw error;
    return value;
  }
  const neutral = {
    /** Model native activation of the neutral tab without changing an actual window. */
    bringToFront() { return operation('neutral'); },
  };
  /** Model native activation of the observed tab. */
  fake.page.bringToFront = function bringToFront() { return operation('activate'); };
  /** Keep the existing hidden/visible deadlines and polling settings observable in the mock. */
  fake.page.waitForFunction = function waitForFunction(_predicate, _argument, options) {
    const hidden = waits++ === 0;
    assert.deepEqual(options, hidden ? { polling: 20, timeout: 1000 } : { timeout: 1000 });
    return operation(hidden ? 'hidden' : 'visible');
  };
  /** Supply only the pre/post scalar visibility state expected by the existing observer. */
  fake.page.evaluate = function evaluate() {
    return reads++ === 0 ? operation('before', { state: 'hidden', length: 1 })
      : operation('after', { length: 2, last: { state: 'visible', trusted: true } });
  };
  return { ...fake, neutral, calls };
}

/** A browser rejection at any visibility boundary must remain identifiable without retaining private diagnostics. */
test('visibility failures report the exact operation and never fabricate a transition', async () => {
  const cases = [
    ['neutral', 'visibility_neutral_activation_failed'], ['hidden', 'visibility_hidden_wait_failed'],
    ['before', 'visibility_before_read_failed'], ['activate', 'visibility_tab_activation_failed'],
    ['visible', 'visibility_visible_wait_failed'], ['after', 'visibility_after_read_failed'],
  ];
  for (const [operation, code] of cases) {
    const fake = visibilityFailureFixture(operation); const { budget } = budgetFixture();
    const observer = new BrowserObserver(fake.context, budget, new IdentityObserver('fixture'), ['https://example.test']);
    await observer.newPage(1);
    await assert.rejects(observer.activate(fake.page, fake.neutral, 1), { code, message: code });
    budget.stop(code); await observer.close();
    assert.equal(fake.calls.at(-1), operation); assert.equal(observer.visibility.length, 0);
    assert.equal(fake.closed(), 1); assert.equal(budget.counts.app, 0);
    assert.doesNotMatch(JSON.stringify(budget.report()), /PRIVATE|stack/);
  }
});

/** Diagnostic wrapping cannot replace a recognized guard error or add extra operations to a successful transition. */
test('visibility diagnostics preserve known guards and successful native-operation order', async () => {
  const known = new QualificationError('deadline');
  for (const failure of [undefined, 'hidden']) {
    const fake = visibilityFailureFixture(failure, known); const { budget } = budgetFixture();
    const observer = new BrowserObserver(fake.context, budget, new IdentityObserver('fixture'), ['https://example.test']);
    await observer.newPage(1);
    if (failure) await assert.rejects(observer.activate(fake.page, fake.neutral, 1), error => error === known);
    else {
      await observer.activate(fake.page, fake.neutral, 1);
      assert.deepEqual(fake.calls, ['neutral', 'hidden', 'before', 'activate', 'visible', 'after']);
      assert.equal(observer.visibility.length, 1); assert.equal(observer.visibility[0].visibleEventTrusted, true);
    }
    await observer.close(); assert.equal(fake.closed(), 1);
  }
});

/** Run the real profile orchestration with in-memory build/wait substitutes; failed navigation must prevent later profiles. */
test('profile reports preserve operation codes, earlier stop reasons and cleanup without retrying', async () => {
  const runnerPath = require.resolve('../runner.cjs'); const source = await readFile(runnerPath, 'utf8');
  for (const failure of ['unknown', 'known', 'earlier_stop']) {
    const fake = fakeBrowser(); let budget; let probes = 0; let navigations = 0; let loaded;
    /** Supply the required blank keeper without inspecting or opening any real page. */
    fake.context.pages = () => [{ url: () => 'about:blank' }];
    /** No workers exist in this synthetic context. */
    fake.context.serviceWorkers = () => [];
    /** Fail before any actual request, optionally after a separate guard has already stopped the budget. */
    fake.page.goto = async function goto() {
      navigations++;
      if (failure === 'earlier_stop') budget.stop('identity_mismatch');
      if (failure === 'known') throw new loaded.QualificationError('request_latency');
      throw new Error('PRIVATE_NAVIGATION_URL');
    };
    const replacements = {
      /** Count preflight calls without fetching hosted URLs or supplying any request bodies. */
      async checkBuild(current) { budget = current; probes++; },
      /** Skip only the synthetic quiet period; keep the real budget stop check. */
      async waitUntil(current) { current.check(); },
    };
    loaded = compileFunction(`${source}\ncheckBuild = replacements.checkBuild; waitUntil = replacements.waitUntil;
      return { runProfiles, QualificationError };`, ['require', 'module', '__dirname', 'replacements'],
    { filename: runnerPath })(require, { exports: {} }, path.dirname(runnerPath), replacements);
    const report = await loaded.runProfiles({ context: fake.context, approvedProfiles: [1, 2, 4, 8],
      approval: LIVE_APPROVAL, approvedUserId: 'fixture' });
    assert.equal(report.outcome, 'STOPPED');
    assert.equal(report.reason, failure === 'known' ? 'request_latency'
      : failure === 'earlier_stop' ? 'identity_mismatch' : 'startup_navigation_failed');
    assert.equal(report.profiles.length, 0); assert.equal(probes, 2); assert.equal(navigations, 1);
    assert.equal(fake.closed(), 1); assert.equal(budget.timer?._destroyed, true);
    assert.deepEqual(report.dispatched, { app: 0, static: 0, session: 0 });
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|stack/);
  }
});

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
