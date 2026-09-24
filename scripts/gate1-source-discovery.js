'use strict';

/**
 * Small, separately approved GATE-1 discovery trial. Default CLI is offline.
 * No spoof cases, bypass, cookies, source comparison, retries or WAF mutations.
 * Native HTTPS counts actual attempts. Provider bodies/addresses stay transient.
 * The metrics adapter follows Vercel CLI 59.20.0 queryFirewallObservability;
 * this is a discovery adapter, not a documented completeness/receipt contract.
 */
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const { createHash, randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { z } = require('zod');
const { loginBuild } = require('./gate1-host-protection');
const { reviewSourceResponse, reviewWafEvidence } = require('./gate1-source-waf');

const PROJECT = 'prj_b2nMrysMSJtpmqoeGx5g0WGgGuom';
const HOST = 'job-application-tracker-kappa-seven.vercel.app';
const LIMITS = Object.freeze({ maxAppRequests: 3, maxProviderRequests: 6,
  maxWafQueries: 2, concurrency: 1, requestMs: 10000, overallMs: 180000,
  buildBytes: 1048576, sessionBytes: 8192, providerBytes: 262144,
  headerBytes: 16384, inputBytes: 16384, reportBytes: 32768,
  firstLookupAfterMs: 30000, secondLookupAfterMs: 90000 });
const PROFILE_FIELDS = { schemaVersion: 1, projectId: PROJECT, teamId: '',
  environment: 'production', hostname: HOST, deploymentId: '', gitSha: '',
  nextBuildId: '', immutableHostname: '', reviewedAt: '',
  attestations: { sourceCodeReviewed: false, probeConfigured: false,
    configurationUnchanged: false, noConcurrentDeployments: false,
    canonicalAccessWithoutBypass: false, providerReadAccess: false,
    credentialLoggingReviewed: false } };
const profileSchema = z.object({
  schemaVersion: z.literal(1), projectId: z.literal(PROJECT),
  teamId: z.string().max(80).regex(/^team_[A-Za-z0-9]+$/),
  environment: z.literal('production'), hostname: z.literal(HOST),
  deploymentId: z.string().max(80).regex(/^dpl_[A-Za-z0-9]+$/),
  gitSha: z.string().regex(/^[a-f0-9]{40}$/),
  nextBuildId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  immutableHostname: z.string().max(253)
    .regex(/^job-application-tracker-[a-z0-9]+-track-the-app\.vercel\.app$/),
  reviewedAt: z.string().datetime(),
  attestations: z.object(Object.fromEntries(Object.keys(PROFILE_FIELDS.attestations)
    .map((key) => [key, z.literal(true)]))).strict(),
}).strict();
const credentialsSchema = z.object({ probeSecret: z.string().regex(/^[a-f0-9]{64}$/),
  providerToken: z.string().min(20).max(512).regex(/^[A-Za-z0-9_-]+$/) }).strict();
const CODES = new Set(['arguments', 'profile', 'credentials', 'approval', 'input',
  'request_budget', 'deadline', 'cancelled', 'transport', 'response_headers',
  'response_size', 'response_encoding', 'response_incomplete', 'redirect', 'cookie_contract',
  'build_mismatch', 'session_status', 'cache_contract', 'body_contract', 'probe_contract',
  'provider_status', 'provider_schema', 'attribution', 'provider_ambiguous', 'internal']);
const SELECTED_HEADERS = new Set(['content-type', 'content-length', 'content-encoding',
  'cache-control', 'x-vercel-cache', 'x-gate1-source-probe', 'set-cookie']);

/** Fixed failure codes only; raw transport/provider errors never cross the report boundary. */
class DiscoveryError extends Error {
  /** Normalize an internal reason; caller-supplied values cannot become output. */
  constructor(code) { super(CODES.has(code) ? code : 'internal'); this.code = this.message; }
}

/** Validate and detach a local profile; false attestations/templates cannot authorize HTTP. */
function parseProfile(value) {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new DiscoveryError('profile');
  return parsed.data;
}

/** Bind operator selection to normalized target, fixed bounds and these runner/helper bytes. */
function approvalId(profile) {
  const digest = createHash('sha256').update(JSON.stringify({ profile: parseProfile(profile), limits: LIMITS }));
  for (const name of ['gate1-source-discovery.js', 'run-gate1-source-discovery.ps1',
    'gate1-source-waf.js', 'gate1-host-protection.js']) {
    digest.update(fs.readFileSync(path.join(__dirname, name)));
  }
  return digest.digest('hex');
}

/** Return a deliberately unusable template for local completion; no deployment is inferred. */
function profileTemplate() { return JSON.parse(JSON.stringify(PROFILE_FIELDS)); }

/** Produce a zero-traffic proposal, optionally bound to an operator-completed target profile. */
function preparation(profile = null) {
  const target = profile === null ? null : parseProfile(profile);
  return { schemaVersion: 1, mode: 'prepare', scope: 'waf_observation_discovery_only',
    gate1Status: 'open', liveApproved: false, appRequests: 0, providerRequests: 0,
    target, approvalId: target ? approvalId(target) : null, limits: LIMITS,
    sourceAgreement: 'not_evaluated', correlation: 'unqualified', completeness: 'unqualified',
    sequence: ['aliasBefore', 'deploymentBefore', 'buildBefore', 'session', 'buildAfter',
      'wafLookup1', 'wafLookup2_only_if_empty', 'aliasAfter', 'deploymentAfter'],
    nextStep: target ? 'review_profile_and_obtain_separate_live_approval' : 'complete_local_profile',
    limitations: ['aggregate_is_not_a_request_receipt', 'no_independent_source_comparison',
      'waf_source_semantics_unqualified', 'bypass_and_log_privacy_operator_attested_only',
      'alias_checks_do_not_exclude_transient_reassignment', 'no_spoof_or_alternate_host_cases'] };
}

/** Check raw response header bounds/singletons; keep only fields required for validation. */
function selectedHeaders(raw) {
  if (!Array.isArray(raw) || raw.length % 2 || raw.length > 256) throw new DiscoveryError('response_headers');
  const headers = Object.create(null);
  let size = 0;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index], value = raw[index + 1];
    if (typeof name !== 'string' || typeof value !== 'string') throw new DiscoveryError('response_headers');
    size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (size > LIMITS.headerBytes) throw new DiscoveryError('response_headers');
    const key = name.toLowerCase();
    if (!SELECTED_HEADERS.has(key)) continue;
    if (Object.hasOwn(headers, key)) throw new DiscoveryError('response_headers');
    headers[key] = value;
  }
  return headers;
}

/**
 * Execute one nonretrying HTTPS exchange built internally by the sequencer.
 * requestImpl is solely a mocked test seam. Absolute timeout covers DNS through
 * full body; streams are destroyed on cancellation/failure. No raw errors escape.
 */
function exchange(spec, { requestImpl = https.request, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let request, response, timer, settled = false;
    const chunks = [];
    /** Settle once, discard transient chunks and close owned streams on failure. */
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      chunks.length = 0;
      if (error) { request?.destroy(); response?.destroy(); reject(error); }
      else resolve(value);
    }
    /** Discard signal reasons, which can contain secrets. */
    function abort() { finish(new DiscoveryError('cancelled')); }
    /** Handle all native errors without serializing their message or request options. */
    function transportError() { finish(new DiscoveryError('transport')); }
    /** An incomplete HTTP message never becomes an observation. */
    function incomplete() { finish(new DiscoveryError('response_incomplete')); }
    /** Bound response headers and body before returning transient material to reviewers. */
    function receive(incoming) {
      response = incoming;
      response.on('error', transportError);
      if (settled) { response.destroy(); return; }
      response.on('aborted', incomplete);
      let headers, size = 0;
      try {
        headers = selectedHeaders(response.rawHeaders);
        if (response.statusCode >= 300 && response.statusCode < 400) throw new DiscoveryError('redirect');
        if (headers['set-cookie'] !== undefined) throw new DiscoveryError('cookie_contract');
        if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
          throw new DiscoveryError('response_encoding');
        }
        const length = headers['content-length'];
        if (length !== undefined && (!/^\d{1,12}$/.test(length) || Number(length) > spec.bytes)) {
          throw new DiscoveryError('response_size');
        }
      } catch (error) { finish(error instanceof DiscoveryError ? error : new DiscoveryError('response_headers')); return; }
      /** Count real bytes, including chunked responses, before allocating accumulated body. */
      function data(chunk) {
        if (settled) return;
        if (!Buffer.isBuffer(chunk)) { incomplete(); return; }
        size += chunk.length;
        if (size > spec.bytes) { finish(new DiscoveryError('response_size')); return; }
        chunks.push(chunk);
      }
      /** Reject partial or mismatched-length payloads; preserve text only in memory. */
      function end() {
        if (settled) return;
        if (!response.complete || (headers['content-length'] !== undefined
          && Number(headers['content-length']) !== size)) { incomplete(); return; }
        finish(null, { status: response.statusCode, headers, body: Buffer.concat(chunks).toString('utf8') });
      }
      /** Socket closure without an end event is a failed attempt. */
      function close() { if (!settled) incomplete(); }
      response.on('data', data);
      response.on('end', end);
      response.on('close', close);
    }
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new DiscoveryError('deadline')), timeoutMs);
    try {
      request = requestImpl({ protocol: 'https:', hostname: spec.hostname, port: 443,
        path: spec.path, method: spec.method, agent: false, rejectUnauthorized: true,
        maxHeaderSize: LIMITS.headerBytes, headers: spec.headers }, receive);
      request.on('error', transportError);
      if (settled) request.destroy();
      else request.end(spec.body);
    } catch { transportError(); }
  });
}

/** Require a complete successful JSON provider response; never return it in a report. */
function providerJson(response) {
  if (response.status !== 200) throw new DiscoveryError('provider_status');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '')) {
    throw new DiscoveryError('provider_schema');
  }
  try { return JSON.parse(response.body); } catch { throw new DiscoveryError('provider_schema'); }
}

/** Match the documented alias deployment/project fields; no metadata/body is retained. */
function reviewAlias(value, profile) {
  const parsed = z.object({ alias: z.literal(profile.hostname), deploymentId: z.literal(profile.deploymentId),
    projectId: z.literal(profile.projectId) }).safeParse(value);
  if (!parsed.success) throw new DiscoveryError('attribution');
}

/** Pin owner-visible deployment identity, ready state, URL and Git source; no fallback guesses. */
function reviewDeployment(value, profile) {
  const parsed = z.object({ id: z.literal(profile.deploymentId), projectId: z.literal(profile.projectId),
    url: z.literal(profile.immutableHostname), readyState: z.literal('READY'),
    target: z.literal('production'), gitSource: z.object({ sha: z.literal(profile.gitSha) }) }).safeParse(value);
  if (!parsed.success) throw new DiscoveryError('attribution');
}

/** Construct one exact marker/host/path aggregate query; two lookups reuse identical bytes. */
function metricsQuery(profile, marker, window) {
  return JSON.stringify({ scope: { ownerId: profile.teamId, projectIds: [profile.projectId] },
    timeRange: window, metrics: { value: { metric: 'vercel.firewall_action.count', aggregation: 'count' } },
    outputs: ['value'], groupBy: ['clientUserAgent', 'requestHostname', 'requestPath', 'clientIp'],
    filter: `(clientUserAgent:"${marker}") AND (requestHostname:"${profile.hostname}") AND (requestPath:"/api/auth/session")`,
    rowLimit: 2, orderBy: [{ metric: 'value', direction: 'desc' }] });
}

/**
 * Strictly project the CLI-derived summary shape. Unknown shapes stop discovery;
 * missing sampling/truncation metadata stays unknown. IP validation is transient,
 * and even a single count-one candidate never establishes source semantics.
 */
function reviewMetrics(value, profile, marker) {
  const parsed = z.object({ summary: z.array(z.object({
    dimensions: z.object({ clientUserAgent: z.string().max(256), requestHostname: z.string().max(253),
      requestPath: z.string().max(256), clientIp: z.string().max(64) }).strict(),
    values: z.object({ value: z.number().int().min(1).max(1000000) }).strict(),
  }).strict()).max(2), series: z.array(z.unknown()).length(0).optional(),
  sampled: z.boolean().optional(), truncated: z.boolean().optional() }).strict().safeParse(value);
  if (!parsed.success) throw new DiscoveryError('provider_schema');
  const rows = parsed.data.summary;
  const matched = rows.every((row) => row.dimensions.clientUserAgent === marker
    && row.dimensions.requestHostname === profile.hostname && row.dimensions.requestPath === '/api/auth/session'
    && isIP(row.dimensions.clientIp) !== 0);
  const count = rows.reduce((total, row) => total + row.values.value, 0);
  const disposition = reviewWafEvidence({ kind: 'aggregate', queryAccepted: true,
    markerMatched: rows.length > 0 && matched, rows: rows.length, count,
    sampled: parsed.data.sampled ?? null, truncated: parsed.data.truncated ?? null });
  // A declared partial/sampled empty result cannot be classified as simple absence.
  if (parsed.data.sampled === true || parsed.data.truncated === true) disposition.availability = 'ambiguous';
  return { ...disposition, rows: rows.length, count, markerMatched: rows.length > 0 && matched,
    sourceFieldPresent: rows.length > 0 && rows.every((row) => isIP(row.dimensions.clientIp) !== 0),
    sampled: parsed.data.sampled ?? null, truncated: parsed.data.truncated ?? null,
    wafSourceSemantics: 'unqualified' };
}

/** Cancellable sequential polling delay; no provider call occurs while waiting. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    /** Stop without retaining the caller's abort reason. */
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DiscoveryError('cancelled')); }
    /** Release the listener after the fixed delay. */
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(done, ms);
  });
}

/**
 * Run exactly one approved baseline; deps are offline test seams. All HTTP goes
 * through exchange and is counted before dispatch. Wall/monotonic clocks must
 * agree within five seconds. Configuration/privacy attestations are not evidence.
 */
async function runDiscovery(input, deps = {}) {
  const report = { schemaVersion: 1, mode: deps.requestImpl ? 'fixture' : 'live',
    scope: 'waf_observation_discovery_only', result: 'stopped', gate1Status: 'open',
    sourceAgreement: 'not_evaluated', correlation: 'unqualified', completeness: 'unqualified',
    hostedEvidence: deps.requestImpl ? 'not_executed' : 'requires_review',
    target: null, approvalId: null, limits: LIMITS, appRequests: 0, providerRequests: 0,
    validatedAppRequests: 0, validatedProviderRequests: 0, wafQueries: 0, receipts: [],
    observation: null, waf: null, queryWindow: null, failure: null, stoppedPhase: 'validation' };
  const now = deps.now || (() => performance.now()), wall = deps.wall || Date.now;
  const sleep = deps.sleep || delay;
  let started, wallStart, previous, phase = 'validation';
  try {
    const parsed = z.object({ profile: profileSchema, approval: z.string().regex(/^[a-f0-9]{64}$/),
      credentials: credentialsSchema }).strict().safeParse(input);
    if (!parsed.success) throw new DiscoveryError('input');
    const { profile, credentials, approval } = parsed.data;
    if (credentials.probeSecret === credentials.providerToken
      || JSON.stringify(profile).includes(credentials.probeSecret)
      || JSON.stringify(profile).includes(credentials.providerToken)) throw new DiscoveryError('credentials');
    if (approval !== approvalId(profile)) throw new DiscoveryError('approval');
    started = now(); wallStart = wall(); previous = started;
    if (!Number.isFinite(started) || !Number.isFinite(wallStart) || started < 0
      || wallStart - Date.parse(profile.reviewedAt) > 86400000
      || Date.parse(profile.reviewedAt) - wallStart > 5000) throw new DiscoveryError('profile');
    report.target = profile; report.approvalId = approval;
    report.startedAt = new Date(wallStart).toISOString();
    /** Enforce cancellation, monotonic deadline and bounded wall-clock drift at each boundary. */
    function remaining() {
      if (deps.signal?.aborted) throw new DiscoveryError('cancelled');
      const current = now(), currentWall = wall();
      if (!Number.isFinite(current) || !Number.isFinite(currentWall) || current < previous
        || current - started >= LIMITS.overallMs
        || Math.abs((currentWall - wallStart) - (current - started)) > 5000) throw new DiscoveryError('deadline');
      previous = current;
      return LIMITS.overallMs - (current - started);
    }
    const marker = `gate1-source-${randomBytes(16).toString('hex')}`;
    /** Count a physical attempt once, without replay; reviewers receive only transient response. */
    async function request(kind, nextPhase, spec, reviewer) {
      phase = nextPhase;
      const timeoutMs = Math.min(LIMITS.requestMs, remaining());
      const key = kind === 'app' ? 'appRequests' : 'providerRequests';
      if (report[key] >= (kind === 'app' ? LIMITS.maxAppRequests : LIMITS.maxProviderRequests)) {
        throw new DiscoveryError('request_budget');
      }
      report[key] += 1;
      const begin = now();
      const response = await exchange(spec, { requestImpl: deps.requestImpl, signal: deps.signal, timeoutMs });
      remaining();
      const receipt = { phase, status: response.status, durationMs: Math.round((now() - begin) * 1000) / 1000, validated: false };
      report.receipts.push(receipt);
      const result = reviewer(response);
      receipt.validated = true;
      report[kind === 'app' ? 'validatedAppRequests' : 'validatedProviderRequests'] += 1;
      return result;
    }
    /** Send API credentials only to the fixed provider authority with a counted read/query method. */
    async function provider(nextPhase, route, reviewer, body) {
      return request('provider', nextPhase, { hostname: 'api.vercel.com',
        path: `${route}${route.includes('?') ? '&' : '?'}teamId=${profile.teamId}`, method: body ? 'POST' : 'GET',
        bytes: LIMITS.providerBytes, body, headers: { Accept: 'application/json',
          'Accept-Encoding': 'identity', Authorization: `Bearer ${credentials.providerToken}`,
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) } },
      (response) => reviewer(providerJson(response)));
    }
    /** Check alias plus immutable deployment; both before and after observations are mandatory. */
    async function attribution(suffix) {
      await provider(`alias${suffix}`, `/v4/aliases/${profile.hostname}`, (value) => reviewAlias(value, profile));
      await provider(`deployment${suffix}`, `/v13/deployments/${profile.deploymentId}?withGitRepoInfo=true`, (value) => reviewDeployment(value, profile));
    }
    /** Anonymous login build checks do not carry either credential or a cookie jar. */
    async function build(nextPhase) {
      await request('app', nextPhase, { hostname: profile.hostname, path: '/login', method: 'GET', bytes: LIMITS.buildBytes,
        headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': 'Gate1SourceDiscovery/1' } },
      (response) => {
        if (loginBuild({ ...response, text: response.body }) !== profile.nextBuildId) throw new DiscoveryError('build_mismatch');
      });
    }
    await attribution('Before');
    await build('buildBefore');
    const sentWall = wall();
    report.observation = await request('app', 'session', { hostname: profile.hostname,
      path: '/api/auth/session', method: 'GET', bytes: LIMITS.sessionBytes,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity',
        Authorization: `Bearer ${credentials.probeSecret}`, 'x-gate1-source-diagnostic': '1', 'User-Agent': marker } },
    (response) => reviewSourceResponse(response, marker));
    const received = now(), receivedWall = wall();
    report.queryWindow = { start: new Date(Math.floor(sentWall / 1000) * 1000 - 2000).toISOString(),
      end: new Date(Math.ceil(receivedWall / 1000) * 1000 + 2000).toISOString() };
    await build('buildAfter');
    const query = metricsQuery(profile, marker, report.queryWindow);
    for (const waitMs of [LIMITS.firstLookupAfterMs, LIMITS.secondLookupAfterMs]) {
      phase = 'wafWait';
      const wait = Math.max(0, received + waitMs - now());
      if (wait >= remaining()) throw new DiscoveryError('deadline');
      await sleep(wait, deps.signal);
      remaining();
      if (report.wafQueries >= LIMITS.maxWafQueries) throw new DiscoveryError('request_budget');
      report.wafQueries += 1;
      report.waf = await provider(`wafLookup${report.wafQueries}`, '/metrics/v1',
        (value) => reviewMetrics(value, profile, marker), query);
      if (report.waf.availability === 'ambiguous' || report.waf.availability === 'unavailable') {
        throw new DiscoveryError('provider_ambiguous');
      }
      if (report.waf.availability === 'aggregate_candidate') break;
    }
    await attribution('After');
    remaining();
    report.result = 'completed'; report.stoppedPhase = null;
  } catch (error) {
    report.failure = error instanceof DiscoveryError ? error.code
      : CODES.has(error?.message) ? error.message : 'internal';
    report.stoppedPhase = phase;
  }
  if (Number.isFinite(started) && Number.isFinite(wallStart)) {
    const elapsed = now() - started;
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      report.elapsedMs = Math.round(elapsed * 1000) / 1000;
      report.finishedAt = new Date(wallStart + elapsed).toISOString();
    }
  }
  return report;
}

/** Read bounded stdin JSON with a deadline; never read credentials from files, argv or env. */
function readInput(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => fail(), 15000);
    /** Clear listeners and buffered bytes before resolving or rejecting. */
    function cleanup() { clearTimeout(timer); stream.removeListener('data', data); stream.removeListener('end', end); stream.removeListener('error', fail); stream.pause(); }
    /** Reject with no content, including malformed or oversized credential envelopes. */
    function fail() { cleanup(); chunks.length = 0; reject(new DiscoveryError('input')); }
    /** Bound bytes before collecting a stdin chunk. */
    function data(chunk) { size += Buffer.byteLength(chunk); if (size > LIMITS.inputBytes) fail(); else chunks.push(Buffer.from(chunk)); }
    /** Parse JSON transiently and discard the raw credential buffer. */
    function end() {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''))); } catch { reject(new DiscoveryError('input')); }
      chunks.forEach((chunk) => chunk.fill(0)); chunks.length = 0;
    }
    stream.on('data', data); stream.on('end', end); stream.on('error', fail);
    stream.resume();
  });
}

/** Persist only our projected live report using a unique, non-overwriting local filename. */
function saveReport(report) {
  const encoded = JSON.stringify(report, null, 2);
  if (Buffer.byteLength(encoded) > LIMITS.reportBytes) throw new DiscoveryError('internal');
  const directory = path.resolve(__dirname, '../.tmp');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `gate1-source-discovery-${Date.now()}-${randomBytes(8).toString('hex')}.json`);
  fs.writeFileSync(file, `${encoded}\n`, { flag: 'wx', mode: 0o600 });
  return file;
}

/** CLI modes are exact and offline by default; live takes an approved envelope via stdin only. */
async function main(args) {
  try {
    if (args.length > 1 || (args.length && !['--prepare', '--template', '--review', '--live'].includes(args[0]))) {
      throw new DiscoveryError('arguments');
    }
    if (args[0] === '--live') {
      const controller = new AbortController();
      /** Stop outstanding I/O on operator interruption without another request. */
      function cancel() { controller.abort(); }
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      let report;
      try { report = await runDiscovery(await readInput(), { signal: controller.signal }); }
      finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
      const reportPath = saveReport(report);
      process.stdout.write(`${JSON.stringify({ reportPath, report }, null, 2)}\n`);
      process.exitCode = report.result === 'completed' ? 0 : 1;
    } else {
      const value = args[0] === '--template' ? profileTemplate()
        : args[0] === '--review' ? preparation(await readInput()) : preparation();
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    }
  } catch {
    process.stderr.write('Discovery preparation/execution failed. No automatic retry was attempted.\n');
    process.exitCode = 1;
  }
}

module.exports = { LIMITS, profileTemplate, parseProfile, approvalId, preparation,
  exchange, reviewAlias, reviewDeployment, metricsQuery, reviewMetrics, runDiscovery, readInput };
if (require.main === module) void main(process.argv.slice(2));
