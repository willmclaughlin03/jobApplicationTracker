const net = require('node:net');
const { PROFILE_ID, TARGETS, LIMITS, LIVE_FLAGS, TopologyError, parseArguments,
  liveSecret, preparation, verifyBuild, verifySession, summarizeDurations,
  runTopology, createOfflineFixture, runCli } = require('../../../scripts/gate1-redis-topology-http.js');

const SENTINEL = 'SYNTHETIC_PRIVATE_ACCESS_SENTINEL';

/** Supply synthetic dedicated names only; tests never consult real environment values. */
function environment() {
  return { GATE1_TOPOLOGY_LIVE_ALLOWED: 'true', GATE1_TOPOLOGY_BYPASS_SECRET: SENTINEL };
}

/** Build the exact live acknowledgements for mocked CLI dispatch, without authorizing real traffic. */
function liveArguments() {
  return ['--live', ...LIVE_FLAGS, '--profile', PROFILE_ID, '--max-app-requests', '410'];
}

/** Build transient v1 responses for focused validation of cache, identity and platform impostors. */
function sessionResponse({ status = 200, body, headers = {} } = {}) {
  return { status, text: JSON.stringify(body || (status === 429
    ? { data: null, error: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded. Please try again later.' }
    : { data: { user: null }, error: null, message: 'Success' })),
  headers: new Headers({ 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store', 'x-vercel-cache': 'MISS',
    ...(status === 429 ? { 'retry-after': '60' } : {}), ...headers }) };
}

/** Adapt a validation fixture to native Response semantics consumed by the shared HTTP helper. */
function nativeResponse(response) {
  return new Response(response.text, { status: response.status, headers: response.headers });
}

/**
 * Instrument the synthetic allowance with bounded calls and injectable faults. Hooks observe
 * only test credentials; native networking is trapped below. Virtual time permits full budgets
 * without waiting, while native fake timers cover genuinely stalled header/body operations.
 */
function harness({ beforeFetch, afterFetch, sleepDelta = 0 } = {}) {
  const base = createOfflineFixture();
  const calls = [];
  const sleeps = [];
  let offset = 0;
  let active = 0;
  let maxActive = 0;
  /** Return synthetic elapsed time including deliberate timeout injections. */
  function now() { return base.clock.now() + offset; }
  /** Advance only test time; no external clock, file or provider participates. */
  function advance(ms) { offset += ms; }
  /** Record the quiet period and optionally simulate an early or late wakeup. */
  async function pause(ms, signal) {
    sleeps.push({ ms, started: now(), calls: calls.length });
    await base.clock.sleep(ms, signal);
    offset += sleepDelta;
  }
  /** Track actual outstanding operations and exact target URLs around injected response failures. */
  async function fetchImpl(url, init) {
    const call = { number: calls.length + 1, url, init, started: now() };
    calls.push(call);
    active++; maxActive = Math.max(active, maxActive);
    try {
      await beforeFetch?.(call);
      const response = await base.fetchImpl(url, init);
      return await afterFetch?.(response, call) || response;
    } finally { active--; }
  }
  /** Report worker concurrency without exposing it to the runner's scheduling decisions. */
  function concurrency() { return maxActive; }
  return { options: { fetchImpl, clock: { now, sleep: pause }, bypassSecret: SENTINEL, dryRun: true },
    calls, sleeps, advance, concurrency };
}

/** Create a controllable promise to test pending headers, body reads and late completions. */
function deferred() {
  let resolve;
  /** Capture the promise resolver without any scheduled work or network calls. */
  const promise = new Promise(function capture(done) { resolve = done; });
  return { promise, resolve };
}

/** Fail immediately if any test or dependency attempts real HTTP/socket I/O. */
beforeEach(function forbidNetwork() {
  jest.spyOn(globalThis, 'fetch').mockImplementation(function rejectFetch() { throw new Error('Real network forbidden'); });
  jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(function rejectSocket() { throw new Error('Real socket forbidden'); });
});

/** Release each test's mocks and fake timers so offline tests cannot affect subsequent suites. */
afterEach(function restoreRuntime() { jest.restoreAllMocks(); jest.useRealTimers(); });

/** Check authorization and CLI boundaries before exercising any request orchestration. */
describe('fixed scope, authorization and CLI', function configurationTests() {
  /** Defaults/help/dry run must remain usable with zero authorization or secret access. */
  test('preparation and dry run are explicitly offline', async function offlineModes() {
    const output = jest.fn();
    /** Any credential lookup in preparation or dry run is an accidental access failure. */
    const unreadableEnv = new Proxy({}, { get: function refuseRead() { throw new Error(SENTINEL); } });
    for (const argv of [[], ['--help'], ['--prepare'], ['--dry-run']]) {
      expect(await runCli(argv, unreadableEnv, { output })).toBe(0);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(net.Socket.prototype.connect).not.toHaveBeenCalled();
    const report = JSON.parse(output.mock.calls.at(-1)[0]);
    expect(report).toMatchObject({ result: 'completed', mode: 'dry-run', hostedEvidence: 'not_executed', gate1Status: 'open' });
    expect(preparation().requests.total).toBe(410);
    expect(JSON.stringify(output.mock.calls)).not.toContain(SENTINEL);
  });

  /** A partial acknowledgement or broadened target/budget must never enter live dispatch. */
  test('accepts only the fixed profile and every explicit live acknowledgement', function strictArguments() {
    expect(parseArguments(liveArguments())).toBe('live');
    for (const args of [['--live'], ['--dry-run', '--live'], ['--prepare', '--authorize-topology-traffic'],
      [...liveArguments(), '--live'], [...liveArguments(), '--url', 'https://wrong.invalid'],
      liveArguments().filter(function omitQuiet(value) { return value !== '--attest-quiet-network'; }),
      liveArguments().map(function changeBudget(value) { return value === '410' ? '412' : value; }),
      liveArguments().map(function changeProfile(value) { return value === PROFILE_ID ? 'other' : value; }),
      ['--live', SENTINEL], [null], null]) {
      expect(function parseBad() { parseArguments(args); }).toThrow('configuration');
    }
    expect(Object.isFrozen(TARGETS)).toBe(true);
    expect(Object.isFrozen(TARGETS[0])).toBe(true);
    expect(Object.isFrozen(LIMITS)).toBe(true);
  });

  /** Prevent credential fallback, header injection and an environment-only accidental live run. */
  test('requires dedicated credentials and redacts rejected arguments/environment', async function secrets() {
    expect(liveSecret(environment())).toBe(SENTINEL);
    for (const env of [{}, { VERCEL_TOKEN: SENTINEL },
      { ...environment(), GATE1_TOPOLOGY_LIVE_ALLOWED: 'false' },
      { ...environment(), GATE1_TOPOLOGY_BYPASS_SECRET: 'short' },
      { ...environment(), GATE1_TOPOLOGY_BYPASS_SECRET: `${SENTINEL}\r\nInjected: yes` }]) {
      expect(function rejectEnvironment() { liveSecret(env); }).toThrow('configuration');
    }
    const output = jest.fn(); const errors = jest.fn();
    expect(await runCli(['--live', SENTINEL], environment(), { output, errors })).toBe(1);
    expect(await runCli(liveArguments(), {}, { output, errors })).toBe(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(SENTINEL);
    expect(output).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  /** Mock live dispatch still owns SIGINT/SIGTERM cleanup and never upgrades evidence to pass. */
  test('mock live success releases signal listeners and requires review', async function liveSeam() {
    const fixture = harness(); const output = jest.fn();
    const before = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
    const code = await runCli(liveArguments(), environment(), { fetchImpl: fixture.options.fetchImpl,
      clock: fixture.options.clock, output });
    expect(code).toBe(0);
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ mode: 'live', result: 'completed', hostedEvidence: 'requires_review' });
    expect(process.listeners('SIGINT')).toEqual(before[0]);
    expect(process.listeners('SIGTERM')).toEqual(before[1]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  /** Concurrent CLI starts must not overlap live profiles or release another invocation's listeners. */
  test('refuses duplicate live runs and cancels the owned run safely', async function duplicateAndCancel() {
    const pending = deferred(); const entered = deferred(); const output = jest.fn(); const errors = jest.fn();
    /** Hold a request open to exercise simultaneous CLI dispatch without a real socket. */
    function stalledFetch() { entered.resolve(); return pending.promise; }
    const before = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
    const first = runCli(liveArguments(), environment(), { fetchImpl: stalledFetch, output, errors });
    await entered.promise;
    expect(await runCli(liveArguments(), environment(), { fetchImpl: stalledFetch, output, errors })).toBe(1);
    const listener = process.listeners('SIGINT').find(function owned(value) { return !before[0].includes(value); });
    listener();
    expect(await first).toBe(1);
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ failure: 'cancelled', appRequests: 1, unvalidatedAttempts: 1 });
    pending.resolve(new Response('late synthetic response'));
    expect(process.listeners('SIGINT')).toEqual(before[0]);
    expect(process.listeners('SIGTERM')).toEqual(before[1]);
  });
});

/** Validate protocol behavior against both shared and independent fake allowances. */
describe('request sequence and evidence limits', function protocolTests() {
  /** A complete run must use every counted request exactly once and leave no timers/listeners. */
  test('runs the exact 410-request protocol with global concurrency four and quiet periods', async function successfulProtocol() {
    jest.useFakeTimers();
    const fixture = harness(); const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const report = await runTopology({ ...fixture.options, signal: controller.signal });
    expect(report).toMatchObject({ result: 'completed', appRequests: 410, validatedRequests: 410,
      unvalidatedAttempts: 0, failure: null, quietPeriodsMs: [64000, 64000], gate1Status: 'open',
      evidenceScope: 'cross_deployment_v1_shared_allowance_only', restartEvidence: 'not_executed',
      futureV2Evidence: 'not_executed', wafEvidence: 'not_qualified_by_this_run' });
    expect(report.counts).toEqual(TARGETS.map(function expectedCount(target) {
      return { label: target.label, attempted: 205, validated: 205, buildBefore: true,
        preflight: 1, load: 200, reject: 1, recovery: 1, buildAfter: true };
    }));
    expect(fixture.concurrency()).toBe(4);
    expect(fixture.calls).toHaveLength(410);
    expect(fixture.sleeps.map(function quietCalls(value) { return value.calls; })).toEqual([4, 406]);
    expect(report.boundaryDurationMs).toBeLessThan(45000);
    expect(report.receipts).toHaveLength(6);
    expect(report.durations.load.count).toBe(400);
    for (const call of fixture.calls) {
      const parsed = new URL(call.url);
      expect(TARGETS.map(function origin(target) { return target.origin; })).toContain(parsed.origin);
      expect(['/login', '/api/auth/session']).toContain(parsed.pathname);
      expect(parsed.search).toBe('');
      expect(call.init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'manual' });
      expect(Object.keys(call.init.headers).sort()).toEqual(['Accept', 'x-vercel-protection-bypass']);
      expect(call.init.headers['x-vercel-protection-bypass']).toBe(SENTINEL);
    }
    expect(fixture.calls[404].url).toBe(`${TARGETS[0].origin}/api/auth/session`);
    expect(fixture.calls[405].url).toBe(`${TARGETS[1].origin}/api/auth/session`);
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
  });

  /** Independent per-deployment quotas would allow probe 401; the runner must reject that evidence. */
  test('does not pass independent counters or continue recovery after a missing rejection', async function independentCounters() {
    const fixture = harness({
      /** Simulate a fresh independent allowance on the first post-400 probe. */
      afterFetch: function independentResponse(response, call) {
        return call.number === 405 ? nativeResponse(sessionResponse()) : response;
      },
    });
    const report = await runTopology(fixture.options);
    expect(report).toMatchObject({ result: 'stopped', failure: 'http_rejection', stoppedPhase: 'reject', appRequests: 405 });
    expect(report.counts.map(function loadCount(count) { return count.load; })).toEqual([200, 200]);
    expect(fixture.sleeps).toHaveLength(1);
  });

  /** Transport uncertainty after a decision cannot be retried or silently replaced to reach 400. */
  test('counts lost responses, stops scheduling and sanitizes provider errors', async function lostResponse() {
    const fixture = harness({
      /** Throw only after the mock decision has happened, modeling a lost HTTP response. */
      afterFetch: function lose(response, call) {
        if (call.number === 5) throw new Error(`${SENTINEL} raw-source cookie=private`);
        return response;
      },
    });
    const report = await runTopology(fixture.options);
    expect(report).toMatchObject({ result: 'stopped', failure: 'transport_error', stoppedPhase: 'load' });
    expect(report.appRequests).toBeGreaterThanOrEqual(5);
    expect(report.appRequests).toBeLessThanOrEqual(8);
    expect(report.unvalidatedAttempts).toBeGreaterThanOrEqual(1);
    expect(report.receipts).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
    expect(fixture.sleeps).toHaveLength(1);
  });

  /** A changed build at the end invalidates a seemingly good boundary instead of passing stale attribution. */
  test('stops on post-run build drift', async function buildDrift() {
    const fixture = harness({
      /** Change the first final build response without changing earlier session results. */
      afterFetch: function wrongBuild(response, call) {
        return call.number === 409 ? new Response('<script id="__NEXT_DATA__">{"buildId":"different","page":"/login"}</script>',
          { headers: { 'content-type': 'text/html' } }) : response;
      },
    });
    const report = await runTopology(fixture.options);
    expect(report).toMatchObject({ result: 'stopped', failure: 'build_mismatch', appRequests: 409, stoppedPhase: 'buildAfter' });
  });

  /** The first failure can abort siblings, but never start a replacement wave. */
  test.each([['redirect', 302], ['http_rejection', 503]])('stops on %s during preflight', async function badPreflight(code, status) {
    const fixture = harness({
      /** Return a platform/login redirect or unavailable response before the counted phase. */
      afterFetch: function unavailable(response, call) {
        return call.number === 3 ? new Response(SENTINEL, { status, headers: { location: 'https://wrong.invalid' } }) : response;
      },
    });
    const report = await runTopology(fixture.options);
    expect(report).toMatchObject({ result: 'stopped', failure: code, appRequests: 3 });
    expect(fixture.sleeps).toHaveLength(0);
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
  });

  /** Even valid-looking HTML cannot establish attribution if the transport reports another URL. */
  test.each([['url', 'https://wrong.invalid/login', 'wrong_target'], ['redirected', true, 'redirect']])(
    'rejects mismatched transport %s without forwarding the credential', async function transportAttribution(property, value, code) {
      const fixture = harness({
        /** Override response metadata only; the runner must reject before its second dispatch. */
        afterFetch: function changedAttribution(response) { Object.defineProperty(response, property, { value }); return response; },
      });
      const report = await runTopology(fixture.options);
      expect(report).toMatchObject({ failure: code, appRequests: 1 });
      expect(fixture.calls[0].url).toBe(`${TARGETS[0].origin}/login`);
      expect(fixture.calls).toHaveLength(1);
      expect(JSON.stringify(report)).not.toContain(SENTINEL);
    });
});

/** Timeouts must cover request bodies and pending fetches as well as the count phase and quiet periods. */
describe('deadlines, cancellation and cleanup', function deadlineTests() {
  /** Boundary time includes both sequential probes; a fast first probe cannot mask a late second probe. */
  test.each([5, 405, 406])('rejects an elapsed 45-second window at request %i', async function expiredBoundary(number) {
    let fixture;
    fixture = harness({
      /** Move the monotonic clock past the deadline before returning the selected response. */
      afterFetch: function makeLate(response, call) { if (call.number === number) fixture.advance(45000); return response; },
    });
    const report = await runTopology(fixture.options);
    expect(report).toMatchObject({ result: 'stopped', failure: 'boundary_deadline' });
    expect(report.appRequests).toBeLessThanOrEqual(number === 5 ? 8 : number);
    expect(fixture.sleeps).toHaveLength(1);
  });

  /** No counted traffic may follow a short quiet period or an exhausted overall budget. */
  test.each([[-1, 'quiet_period'], [300000, 'overall_deadline']])('rejects quiet-period delta %i', async function invalidQuiet(delta, code) {
    const fixture = harness({ sleepDelta: delta });
    expect(await runTopology(fixture.options)).toMatchObject({ result: 'stopped', failure: code, appRequests: 4 });
  });

  /** Cancellation before entry must not leak a timer or send an authentication header. */
  test('already-aborted input sends zero requests', async function alreadyCancelled() {
    jest.useFakeTimers();
    const fixture = harness(); const controller = new AbortController(); controller.abort(new Error(SENTINEL));
    expect(await runTopology({ ...fixture.options, signal: controller.signal })).toMatchObject({ failure: 'cancelled', appRequests: 0 });
    expect(fixture.calls).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  /** A native request timeout releases the runner even if a transport ignores AbortSignal. */
  test('bounds stalled headers and ignores a late response', async function stalledHeaders() {
    jest.useFakeTimers();
    const waiting = deferred(); const fixture = harness(); let captured;
    /** Retain a synthetic request signal while deliberately failing to settle on abort. */
    function stall(_url, init) { captured = init.signal; return waiting.promise; }
    const pending = runTopology({ ...fixture.options, fetchImpl: stall });
    await jest.advanceTimersByTimeAsync(LIMITS.requestMs);
    const report = await pending;
    expect(report).toMatchObject({ failure: 'timeout', appRequests: 1, unvalidatedAttempts: 1 });
    expect(captured.aborted).toBe(true);
    waiting.resolve(new Response('late'));
    await jest.advanceTimersByTimeAsync(0);
    expect(report.validatedRequests).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  /** A body that never finishes is subject to the same end-to-end timeout and stream cancellation. */
  test('bounds stalled body streams and cancels the reader', async function stalledBody() {
    jest.useFakeTimers(); const cancelled = jest.fn(); const fixture = harness();
    /** Produce a response whose stream remains open until requestBounded cancels it. */
    function hangingBody() { return Promise.resolve(new Response(new ReadableStream({ cancel: cancelled }),
      { headers: { 'content-type': 'text/html' } })); }
    const pending = runTopology({ ...fixture.options, fetchImpl: hangingBody });
    await jest.advanceTimersByTimeAsync(LIMITS.requestMs);
    expect(await pending).toMatchObject({ failure: 'timeout', appRequests: 1 });
    expect(cancelled).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  /** Inject an overall clock boundary while a cooperative quiet wait is pending. */
  test('overall timer cancels a pending quiet wait', async function overallTimer() {
    jest.useFakeTimers(); const fixture = harness(); const entered = deferred();
    /** Sleep until cancellation to verify that the whole-run timer releases the quiet phase. */
    function waitForAbort(_ms, signal) {
      entered.resolve();
      /** Reject this fake wait on the runner-owned abort signal, releasing its listener. */
      return new Promise(function cancellableWait(_resolve, reject) {
        /** Resolve the quiet wait's cancellation boundary without external error text. */
        function aborted() { reject(new TopologyError('cancelled')); }
        signal.addEventListener('abort', aborted, { once: true });
      });
    }
    const pending = runTopology({ ...fixture.options, clock: { ...fixture.options.clock, sleep: waitForAbort } });
    await entered.promise;
    await jest.advanceTimersByTimeAsync(LIMITS.overallMs);
    expect(await pending).toMatchObject({ failure: 'overall_deadline', appRequests: 4 });
    expect(jest.getTimerCount()).toBe(0);
  });
});

/** Focused response-contract tests distinguish application outcomes from similarly numbered edge responses. */
describe('response validation and bounded output', function responseTests() {
  /** Validate the deployed anonymous envelope and exact bounded application rejection. */
  test('accepts only the expected anonymous and rejection responses', function validResponses() {
    expect(function anonymous() { verifySession(sessionResponse(), false); }).not.toThrow();
    expect(function rejected() { verifySession(sessionResponse({ status: 429 }), true); }).not.toThrow();
    expect(summarizeDurations([9, 1, 5])).toEqual({ count: 3, minMs: 1, p50Ms: 5, p95Ms: 9, maxMs: 9 });
  });

  /** Unsafe cache/cookie behavior must stop even when status and JSON otherwise look valid. */
  test.each([
    [{ 'cache-control': 'private, no-store, public' }, 'cache_contract'],
    [{ 'cache-control': 'private, no-store, s-maxage=60' }, 'cache_contract'],
    [{ 'cache-control': 'private, no-store, max-age=bad' }, 'cache_contract'],
    [{ 'cache-control': 'no-store' }, 'cache_contract'],
    [{ 'x-vercel-cache': 'HIT' }, 'cache_contract'],
    [{ 'x-vercel-cache': '' }, 'cache_contract'],
    [{ 'set-cookie': `session=${SENTINEL}` }, 'cookie_contract'],
    [{ 'content-type': 'text/html' }, 'response_shape'],
    [{ 'retry-after': '1' }, 'response_shape'],
  ])('rejects invalid success headers %j', function invalidHeaders(headers, code) {
    expect(function checkHeaders() { verifySession(sessionResponse({ headers }), false); }).toThrow(code);
  });

  /** Platform 429s and unbounded Retry-After values must not be mistaken for a Redis boundary. */
  test.each(['0', '62', '1.5', 'Wed, 01 Jan 2030 00:00:00 GMT', '1, 2', ''])('rejects Retry-After %s', function invalidRetry(value) {
    expect(function checkRetry() { verifySession(sessionResponse({ status: 429, headers: { 'retry-after': value } }), true); }).toThrow('response_shape');
  });

  /** Strict parsing keeps personalized data and provider messages out of successful evidence. */
  test('rejects identities, malformed JSON and wrong application error codes', function invalidBodies() {
    expect(function authenticated() { verifySession(sessionResponse({ body: {
      data: { user: { id: SENTINEL } }, error: null, message: 'Success' } }), false); }).toThrow('identity_mismatch');
    expect(function providerRejection() { verifySession(sessionResponse({ status: 429,
      body: { data: null, error: 'EDGE_THROTTLED', message: SENTINEL } }), true); }).toThrow('response_shape');
    expect(function malformed() { verifySession({ ...sessionResponse(), text: SENTINEL }, false); }).toThrow('response_shape');
    expect(function extraData() { verifySession(sessionResponse({ body: {
      data: { user: null }, error: null, message: 'Success', secret: SENTINEL } }), false); }).toThrow('response_shape');
  });

  /** Reject missing/ambiguous embedded build data instead of searching arbitrary HTML for an expected string. */
  test.each(['', '<script id="__NEXT_DATA__">not-json</script>',
    `<script id="__NEXT_DATA__">{"buildId":"${TARGETS[0].nextBuildId}","page":"/other"}</script>`])(
    'rejects invalid build HTML', function invalidBuild(text) {
      expect(function checkBuild() { verifyBuild({ status: 200, text,
        headers: new Headers({ 'content-type': 'text/html' }) }, TARGETS[0]); }).toThrow('build_mismatch');
    });

  /** The helper's byte cap must end an oversized response before any subsequent target request. */
  test('stops on oversized bodies without printing their contents', async function oversizedBody() {
    const fixture = harness();
    /** Return an oversized in-memory document; no real bytes are downloaded. */
    function largeBody() { return Promise.resolve(new Response(`${SENTINEL}${'x'.repeat(LIMITS.buildBytes)}`,
      { headers: { 'content-type': 'text/html' } })); }
    const report = await runTopology({ ...fixture.options, fetchImpl: largeBody });
    expect(report).toMatchObject({ failure: 'response_size', appRequests: 1 });
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
  });
});
