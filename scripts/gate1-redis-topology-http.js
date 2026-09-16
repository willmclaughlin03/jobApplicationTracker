/**
 * Bounded GATE-1 cross-deployment HTTP exercise. Import/default preparation is offline.
 * Coding approval is not live approval: credential creation and traffic require separate
 * authorization. A completed run needs review and cannot close GATE-1, prove a physical
 * instance restart, or qualify the unhosted future-v2 route. No .env files are loaded.
 */
const { performance } = require('node:perf_hooks');
const { z } = require('zod');
const { Gate1Error, requestBounded, sleep } = require('./gate1-shared-ip-load.js');

const PROFILE_ID = 'gate1-5cc0f9a-50d2e3e';
const TARGETS = Object.freeze([
  Object.freeze({ label: 'A',
    origin: 'https://job-application-tracker-1u5og2es9-track-the-app.vercel.app',
    deploymentId: 'dpl_3YVZFouJ9sJavy484DzWrwAW3qA1',
    gitSha: '5cc0f9af06c717feecb2ecbc6809a7bea9168556', nextBuildId: 'jTf6vCUyNRjB4Y2DBy_AR' }),
  Object.freeze({ label: 'B',
    origin: 'https://job-application-tracker-nuqbyqrs3-track-the-app.vercel.app',
    deploymentId: 'dpl_EAM6hNFabbt9WDsGQtQkXsioQEsw',
    gitSha: '50d2e3ee1caf6f159c84dcecae4fe48db970283f', nextBuildId: 'SC3Ve8-P9727CKvbY2rBC' }),
]);
const LIMITS = Object.freeze({ maxAppRequests: 410, successesPerTarget: 200,
  concurrency: 4, quietMs: 64000, boundaryMs: 45000, overallMs: 300000,
  requestMs: 10000, buildBytes: 1048576, sessionBytes: 8192 });
const ENV_NAMES = Object.freeze(['GATE1_TOPOLOGY_LIVE_ALLOWED', 'GATE1_TOPOLOGY_BYPASS_SECRET']);
const LIVE_FLAGS = Object.freeze(['--authorize-topology-traffic',
  '--attest-targets-and-config', '--attest-quiet-network']);
const PHASES = Object.freeze(['buildBefore', 'preflight', 'load', 'reject', 'recovery', 'buildAfter']);
const CODES = new Set(['configuration', 'cancelled', 'timeout', 'overall_deadline',
  'boundary_deadline', 'quiet_period', 'request_budget', 'wrong_target', 'redirect',
  'build_mismatch', 'response_size', 'response_shape', 'cookie_contract', 'cache_contract',
  'identity_mismatch', 'http_rejection', 'transport_error', 'unexpected_error']);
const secretSchema = z.string().min(16).max(1024).regex(/^[\x21-\x7e]+$/);
const anonymousSchema = z.object({ data: z.object({ user: z.null() }).strict(),
  error: z.null(), message: z.literal('Success') }).strict();
const rejectionSchema = z.object({ data: z.null(), error: z.literal('RATE_LIMIT_EXCEEDED'),
  message: z.literal('Rate limit exceeded. Please try again later.') }).strict();
let liveRunning = false;

/** Keep all failures within a fixed vocabulary; never attach provider errors or causes. */
class TopologyError extends Error {
  /** Accept an audited code only, so even configuration failures are safe to serialize. */
  constructor(code) { super(CODES.has(code) ? code : 'unexpected_error'); this.code = this.message; }
}

/** Preserve known runner/helper codes while discarding external messages, stacks and payloads. */
function errorCode(error) {
  return (error instanceof TopologyError || error instanceof Gate1Error) && CODES.has(error.code)
    ? error.code : 'unexpected_error';
}

/** Supply monotonic live time; the shared sleep helper owns cancellable timers/listeners. */
function monotonicNow() { return performance.now(); }
const REAL_CLOCK = Object.freeze({ now: monotonicNow, sleep });

/** Write a sanitized report to stdout; the CLI does not persist response bodies or credentials. */
function writeOutput(text) { process.stdout.write(`${text}\n`); }

/** Write an already-sanitized failure record to stderr without logging raw exceptions. */
function writeError(text) { process.stderr.write(`${text}\n`); }

/** Parse an exact profile acknowledgement; no URL, cookie, header or credential CLI overrides exist. */
function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some(notString)) throw new TopologyError('configuration');
  if (argv.length === 0) return 'prepare';
  if (argv.length === 1 && ['--prepare', '--dry-run', '--help'].includes(argv[0])) return argv[0].slice(2);
  const expected = new Map([['--live', null], ...LIVE_FLAGS.map(flagEntry),
    ['--profile', PROFILE_ID], ['--max-app-requests', String(LIMITS.maxAppRequests)]]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!expected.has(flag) || seen.has(flag)) throw new TopologyError('configuration');
    seen.add(flag);
    const value = expected.get(flag);
    if (value !== null && argv[++index] !== value) throw new TopologyError('configuration');
  }
  if (seen.size !== expected.size) throw new TopologyError('configuration');
  return 'live';
}

/** Reject non-string arguments before parsing, without stringifying an untrusted value. */
function notString(value) { return typeof value !== 'string'; }

/** Represent a required acknowledgement as a value-free CLI flag. */
function flagEntry(flag) { return [flag, null]; }

/** Validate only dedicated live environment names; the returned secret never enters the report. */
function liveSecret(env) {
  const parsed = z.object({ GATE1_TOPOLOGY_LIVE_ALLOWED: z.literal('true'),
    GATE1_TOPOLOGY_BYPASS_SECRET: secretSchema }).safeParse(env);
  if (!parsed.success) throw new TopologyError('configuration');
  return parsed.data.GATE1_TOPOLOGY_BYPASS_SECRET;
}

/** Describe the fixed procedure offline, including attribution gaps and separate access approval. */
function preparation() {
  return { mode: 'preparation', profileId: PROFILE_ID, targets: TARGETS, limits: LIMITS,
    gate1Status: 'open', hostedEvidence: 'not_executed', environmentNames: ENV_NAMES,
    liveArguments: ['--live', ...LIVE_FLAGS, '--profile', PROFILE_ID, '--max-app-requests', '410'],
    authorization: 'Separate approval required for live traffic and creation/use of automation access.',
    attribution: 'Recheck deployment/SHA/configuration before live approval. Expected B build was observed on canonical HTML with API alias attribution; both immutable hosts must pass build preflight.',
    configuration: 'Same HMAC key/generation and approved existing Upstash database/credentials; no rotation or reset.',
    source: 'One stable machine/network; close other app clients and arrange no other session traffic from that egress throughout both quiet periods and the boundary.',
    requests: { build: 4, preflight: 2, load: 400, rejection: 2, recovery: 2, total: 410 },
    sequence: ['build and anonymous preflight for each target', '64 seconds quiet',
      '200 successes each, combined concurrency <=4', 'sequential application 429 probe A then B within 45 seconds of first load dispatch',
      '64 seconds quiet', 'one anonymous recovery each', 'build recheck each'],
    access: 'Dedicated process-only bypass secret sent as a header to the two fixed origins; never in arguments, URLs, files or output. No cookie jar or redirect following.',
    stop: 'Any invalid response, attribution/cache/cookie mismatch, uncertain request, cancellation or deadline stops scheduling; in-flight attempts remain counted and are aborted without retry.',
    cleanup: 'Release owned timers/listeners and abort requests; Redis state expires naturally. No account operations or external configuration mutations.',
    evidenceLimits: ['Cross-deployment shared allowance only; no certified instance count or hosted restart.',
      'Only v1 is exercised; hosted future-v2 and GATE-1 remain open.',
      'Automation access can bypass platform security checks; this is not WAF/protection qualification.',
      'Build HTML does not attribute each individual session request; immutable origin/SHA attribution is separately reconciled.',
      'The 410 cap counts runner application requests, not downstream provider work or separately scoped management reads.'] };
}

/** Allocate independent aggregate counters; no response, cookie, source identity or key is retained. */
function targetCounters(target) {
  return { label: target.label, attempted: 0, validated: 0, buildBefore: false,
    preflight: 0, load: 0, reject: 0, recovery: 0, buildAfter: false };
}

/** Create a bounded timing bucket for one known phase. */
function phaseBucket(phase) { return [phase, []]; }

/** Summarize a bounded collection of monotonic durations in milliseconds. */
function summarizeDurations(values) {
  if (!values.length) return { count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  const sorted = [...values].sort(numericOrder);
  return { count: sorted.length, minMs: rounded(sorted[0]),
    p50Ms: rounded(sorted[Math.ceil(sorted.length * 0.5) - 1]),
    p95Ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]), maxMs: rounded(sorted.at(-1)) };
}

/** Sort numeric measurements without coercing or retaining external values. */
function numericOrder(left, right) { return left - right; }

/** Round validated elapsed times to three decimal places for stable reports. */
function rounded(value) { return Math.round(value * 1000) / 1000; }

/** Check bounded HTML without executing scripts; require one actual Next data record for /login. */
function verifyBuild(response, target) {
  if (response.status !== 200) throw new TopologyError('http_rejection');
  if (!/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new TopologyError('response_shape');
  const matches = [...response.text.matchAll(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let data;
  try { data = matches.length === 1 ? JSON.parse(matches[0][1]) : null; } catch { /* Reject without retaining the body. */ }
  if (data?.buildId !== target.nextBuildId || data?.page !== '/login') throw new TopologyError('build_mismatch');
}

/** Require the anonymous application contract and private/MISS cache behavior, never a platform 429. */
function verifySession(response, reject) {
  if (response.status !== (reject ? 429 : 200)) throw new TopologyError('http_rejection');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new TopologyError('response_shape');
  const policy = (response.headers.get('cache-control') || '').toLowerCase().split(',').map(trim);
  if (!policy.includes('private') || !policy.includes('no-store')
    || policy.some(unsafeCacheDirective) || response.headers.get('x-vercel-cache') !== 'MISS') {
    throw new TopologyError('cache_contract');
  }
  if (response.headers.has('set-cookie')) throw new TopologyError('cookie_contract');
  let body;
  try { body = JSON.parse(response.text); } catch { throw new TopologyError('response_shape'); }
  if (!reject && body?.data?.user != null) throw new TopologyError('identity_mismatch');
  if (!(reject ? rejectionSchema : anonymousSchema).safeParse(body).success) throw new TopologyError('response_shape');
  const retry = response.headers.get('retry-after');
  if (reject ? !/^[1-9]\d?$/.test(retry || '') || Number(retry) > 61 : retry !== null) {
    throw new TopologyError('response_shape');
  }
}

/** Normalize one cache directive for comparison without including it in reports. */
function trim(value) { return value.trim(); }

/** Reject shared/public caching and positive or malformed age allowances even beside no-store. */
function unsafeCacheDirective(value) {
  return /^public(?:\s*=|$)/.test(value)
    || /^(?:s-maxage|max-age|stale-while-revalidate|stale-if-error)\b/.test(value)
      && !/^(?:s-maxage|max-age|stale-while-revalidate|stale-if-error)\s*=\s*0$/.test(value);
}

/** Retain only a bounded Vercel correlation shape for preflight/probe/recovery, otherwise mark unobserved. */
function correlationId(headers) {
  const value = headers.get('x-vercel-id');
  return /^[a-z]{3}\d(?:::[a-z]{3}\d)?::[A-Za-z0-9-]{1,120}$/.test(value || '') ? value : null;
}

/**
 * Run the fixed protocol using an explicitly injected transport. CLI live dispatch supplies
 * native fetch only after all approvals/credentials are acknowledged. Mock clock/fetch seams
 * exercise failures without I/O. Every attempt is counted before dispatch, including uncertainty.
 */
async function runTopology({ fetchImpl, bypassSecret, clock = REAL_CLOCK, signal, dryRun = true }) {
  if (typeof fetchImpl !== 'function' || typeof clock?.now !== 'function'
    || typeof clock?.sleep !== 'function' || !secretSchema.safeParse(bypassSecret).success
    || typeof dryRun !== 'boolean') throw new TopologyError('configuration');
  const controller = new AbortController();
  let failure = null;
  let phase = 'buildBefore';
  let boundaryStart = null;
  let boundaryTimer;
  let overallTimer;
  let lastNow = -Infinity;
  const times = Object.fromEntries(PHASES.map(phaseBucket));
  const report = { schemaVersion: 1, profileId: PROFILE_ID, mode: dryRun ? 'dry-run' : 'live',
    result: 'stopped', gate1Status: 'open', hostedEvidence: dryRun ? 'not_executed' : 'requires_review',
    evidenceScope: 'cross_deployment_v1_shared_allowance_only', restartEvidence: 'not_executed',
    futureV2Evidence: 'not_executed', wafEvidence: 'not_qualified_by_this_run',
    targets: TARGETS, limits: LIMITS, counts: TARGETS.map(targetCounters), appRequests: 0,
    validatedRequests: 0, unvalidatedAttempts: 0, receipts: [], quietPeriodsMs: [],
    boundaryDurationMs: null, durationSource: dryRun ? 'synthetic_clock' : 'monotonic_http',
    attribution: dryRun ? 'synthetic' : 'operator_attested_deployment_sha_configuration_and_egress',
    startedAt: new Date().toISOString() };

  /** Validate monotonic finite readings so injected or broken clocks cannot silently bypass deadlines. */
  function now() {
    const value = clock.now();
    if (!Number.isFinite(value) || value < lastNow) throw new TopologyError('configuration');
    lastNow = value;
    return value;
  }
  const started = now();

  /** Latch the first sanitized failure and synchronously prevent subsequent scheduling. */
  function stop(error) {
    if (failure === null) { failure = errorCode(error); controller.abort(new TopologyError(failure)); }
  }

  /** External abort reasons are untrusted; convert them to a fixed cancellation code. */
  function cancel() { stop(new TopologyError('cancelled')); }

  /** Wall timers cover stalled requests/sleeps in addition to monotonic checks at every phase boundary. */
  function overallExpired() { stop(new TopologyError('overall_deadline')); }

  /** Keep the entire 400-response/rejection phase inside one shared 45-second deadline. */
  function boundaryExpired() { stop(new TopologyError('boundary_deadline')); }

  /** Enforce clocks even if the event loop has delayed a timer callback. */
  function check() {
    if (failure !== null) throw new TopologyError(failure);
    if (signal?.aborted) { cancel(); throw new TopologyError('cancelled'); }
    const timestamp = now();
    if (timestamp - started >= LIMITS.overallMs) throw new TopologyError('overall_deadline');
    if (boundaryStart !== null && timestamp - boundaryStart >= LIMITS.boundaryMs) throw new TopologyError('boundary_deadline');
    return timestamp;
  }

  /** Dispatch one fixed-route GET; validation and accounting finish before a worker can schedule again. */
  async function visit(targetIndex, visitPhase) {
    const requestStarted = check();
    const target = TARGETS[targetIndex];
    if (!target || !PHASES.includes(visitPhase)) throw new TopologyError('wrong_target');
    if (report.appRequests >= LIMITS.maxAppRequests) throw new TopologyError('request_budget');
    const count = report.counts[targetIndex];
    const build = visitPhase === 'buildBefore' || visitPhase === 'buildAfter';
    const url = `${target.origin}${build ? '/login' : '/api/auth/session'}`;
    const remaining = Math.min(LIMITS.requestMs, LIMITS.overallMs - (requestStarted - started),
      boundaryStart === null ? Infinity : LIMITS.boundaryMs - (requestStarted - boundaryStart));
    report.appRequests++; count.attempted++;
    try {
      const response = await requestBounded(url, { method: 'GET', credentials: 'omit',
        headers: { Accept: build ? 'text/html' : 'application/json',
          'x-vercel-protection-bypass': bypassSecret } },
      { fetchImpl, signal: controller.signal, timeoutMs: remaining,
        maxBytes: build ? LIMITS.buildBytes : LIMITS.sessionBytes });
      check();
      if (build) verifyBuild(response, target); else verifySession(response, visitPhase === 'reject');
      count.validated++; report.validatedRequests++;
      if (build) count[visitPhase] = true; else count[visitPhase]++;
      if (!build && visitPhase !== 'load') report.receipts.push({ target: target.label, phase: visitPhase,
        status: response.status, vercelId: correlationId(response.headers),
        retryAfterSeconds: visitPhase === 'reject' ? Number(response.headers.get('retry-after')) : null });
    } catch (error) {
      // A deadline may have elapsed before its timer callback. Preserve that stop reason.
      let stoppedError = error;
      try { check(); } catch (deadlineError) { stoppedError = deadlineError; }
      stop(stoppedError);
      throw new TopologyError(failure);
    } finally {
      const elapsed = clock.now() - requestStarted;
      if (Number.isFinite(elapsed) && elapsed >= 0) times[visitPhase].push(elapsed);
    }
  }

  /** Enforce actual elapsed quiet time; an early-resolving sleep cannot authorize the next request. */
  async function quiet() {
    const before = check();
    await clock.sleep(LIMITS.quietMs, controller.signal);
    const elapsed = check() - before;
    if (elapsed < LIMITS.quietMs) throw new TopologyError('quiet_period');
    report.quietPeriodsMs.push(rounded(elapsed));
  }

  let cursor = 0;
  /** Four shared workers alternate fixed targets, giving exactly 200 load attempts to each on success. */
  async function worker() {
    while (failure === null && cursor < LIMITS.successesPerTarget * TARGETS.length) {
      const ordinal = cursor++;
      try { await visit(ordinal % TARGETS.length, 'load'); } catch (error) { stop(error); }
    }
  }

  try {
    signal?.addEventListener('abort', cancel, { once: true });
    overallTimer = setTimeout(overallExpired, LIMITS.overallMs);
    check();
    for (let index = 0; index < TARGETS.length; index++) await visit(index, phase);
    phase = 'preflight';
    for (let index = 0; index < TARGETS.length; index++) await visit(index, phase);
    phase = 'quietBefore'; await quiet();
    phase = 'load'; boundaryStart = check();
    boundaryTimer = setTimeout(boundaryExpired, LIMITS.boundaryMs);
    await Promise.all(Array.from({ length: LIMITS.concurrency }, worker));
    check();
    phase = 'reject';
    for (let index = 0; index < TARGETS.length; index++) await visit(index, phase);
    report.boundaryDurationMs = rounded(check() - boundaryStart);
    clearTimeout(boundaryTimer); boundaryStart = null;
    phase = 'quietRecovery'; await quiet();
    phase = 'recovery';
    for (let index = 0; index < TARGETS.length; index++) await visit(index, phase);
    phase = 'buildAfter';
    for (let index = 0; index < TARGETS.length; index++) await visit(index, phase);
    check();
    if (report.appRequests !== LIMITS.maxAppRequests || report.validatedRequests !== LIMITS.maxAppRequests
      || report.counts.some(incompleteTarget)) throw new TopologyError('request_budget');
    report.result = 'completed';
  } catch (error) { stop(error); }
  finally {
    clearTimeout(overallTimer); clearTimeout(boundaryTimer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
  report.failure = failure;
  report.stoppedPhase = failure === null ? null : phase;
  report.unvalidatedAttempts = report.appRequests - report.validatedRequests;
  report.durations = Object.fromEntries(Object.entries(times).map(summarizePhase));
  report.elapsedMs = rounded(Math.max(0, lastNow - started));
  report.finishedAt = new Date().toISOString();
  return report;
}

/** Refuse completion unless both independently checked targets met every protocol phase. */
function incompleteTarget(count) {
  return count.attempted !== 205 || count.validated !== 205 || !count.buildBefore || !count.buildAfter
    || count.preflight !== 1 || count.load !== 200 || count.reject !== 1 || count.recovery !== 1;
}

/** Convert one phase's bounded transient duration array to aggregates only. */
function summarizePhase([phase, values]) { return [phase, summarizeDurations(values)]; }

/**
 * Model one shared rolling allowance for dry-run sequencing only. This is deliberately not
 * evidence about Lua, Upstash or hosting. Time and responses remain entirely in memory.
 */
function createOfflineFixture() {
  let timestamp = 0;
  let lastAllowed = -Infinity;
  let allowed = 0;
  /** Expose synthetic monotonic time without reading wall-clock or provider state. */
  function now() { return timestamp; }
  /** Advance a quiet period instantly, respecting cancellation without creating timers. */
  async function pause(ms, signal) {
    if (signal?.aborted) throw new TopologyError('cancelled');
    timestamp += ms;
  }
  /** Serve only pinned build/session URLs, rejecting unintended traffic without a network fallback. */
  async function fetchImpl(url, init) {
    if (init.signal.aborted) throw new TopologyError('cancelled');
    const target = TARGETS.find(matchesOrigin);
    /** Match the complete permitted path, not a prefix that could contain credentials or a query. */
    function matchesOrigin(candidate) {
      return url === `${candidate.origin}/login` || url === `${candidate.origin}/api/auth/session`;
    }
    if (!target) throw new TopologyError('wrong_target');
    timestamp += 1;
    if (url === `${target.origin}/login`) return new Response(
      `<script id="__NEXT_DATA__">${JSON.stringify({ buildId: target.nextBuildId, page: '/login' })}</script>`,
      { headers: { 'content-type': 'text/html', 'x-vercel-cache': 'HIT' } });
    if (timestamp - lastAllowed >= 61000) allowed = 0;
    const reject = allowed >= 400;
    if (!reject) { allowed++; lastAllowed = timestamp; }
    return new Response(JSON.stringify(reject
      ? { data: null, error: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded. Please try again later.' }
      : { data: { user: null }, error: null, message: 'Success' }),
    { status: reject ? 429 : 200, headers: { 'content-type': 'application/json',
      'cache-control': 'private, no-store', 'x-vercel-cache': 'MISS', ...(reject ? { 'retry-after': '60' } : {}) } });
  }
  return { fetchImpl, clock: { now, sleep: pause }, bypassSecret: 'synthetic-offline-access', dryRun: true };
}

/**
 * Dispatch preparation/dry-run without reading credential values. Live requires the fixed
 * acknowledgements plus dedicated process environment; it neither creates access nor mutates
 * providers. Injected transports/output keep CLI safety tests offline. Own graceful-signal cleanup.
 */
async function runCli(argv = process.argv.slice(2), env = process.env,
  { fetchImpl, clock = REAL_CLOCK, output = writeOutput, errors = writeError } = {}) {
  let ownsLive = false;
  let controller;
  /** Convert either graceful process signal into cancellation of the one owned live run. */
  function cancel() { controller?.abort(); }
  try {
    const mode = parseArguments(argv);
    if (mode === 'help') {
      output('GATE-1 topology: --prepare (default), --dry-run (offline), --live (separate approval required). Use --prepare for exact arguments, targets, limits and access requirements.');
      return 0;
    }
    if (mode === 'prepare') { output(JSON.stringify(preparation(), null, 2)); return 0; }
    let report;
    if (mode === 'dry-run') report = await runTopology(createOfflineFixture());
    else {
      const bypassSecret = liveSecret(env);
      if (liveRunning) throw new TopologyError('configuration');
      liveRunning = true; ownsLive = true;
      controller = new AbortController();
      process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
      report = await runTopology({ fetchImpl: fetchImpl || globalThis.fetch, bypassSecret,
        clock, signal: controller.signal, dryRun: false });
    }
    output(JSON.stringify(report, null, 2));
    return report.result === 'completed' ? 0 : 1;
  } catch (error) {
    errors(JSON.stringify({ result: 'refused_or_failed', code: errorCode(error), gate1Status: 'open' }));
    return 1;
  } finally {
    if (ownsLive) {
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      liveRunning = false;
    }
  }
}

/** Set the CLI exit status after all owned timers/listeners have been released. */
function finished(code) { process.exitCode = code; }

/** Keep even output-stream failures behind a static top-level boundary. */
function failed() { process.exitCode = 1; process.stderr.write('GATE-1 topology runner failed.\n'); }

if (require.main === module) runCli().then(finished).catch(failed);

module.exports = { PROFILE_ID, TARGETS, LIMITS, ENV_NAMES, LIVE_FLAGS, TopologyError,
  parseArguments, liveSecret, preparation, verifyBuild, verifySession, summarizeDurations,
  runTopology, createOfflineFixture, runCli };
