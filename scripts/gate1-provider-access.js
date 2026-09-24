'use strict';

/**
 * Local, offline-by-default GATE-1 metrics-access diagnostic. Separate live
 * approval permits one provider query and zero application requests. This does
 * not call runDiscovery, qualify WAF data, or recover the earlier trial marker.
 */
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { z } = require('zod');
const { exchange, metricsQuery, reviewMetrics, readInput } = require('./gate1-source-discovery');

const TARGET = Object.freeze({ projectId: 'prj_b2nMrysMSJtpmqoeGx5g0WGgGuom',
  teamId: 'team_7o3efmwjZbMc2Bfy9qAzkc9q', hostname: 'job-application-tracker-kappa-seven.vercel.app' });
const LIMITS = Object.freeze({ maxAppRequests: 0, maxProviderRequests: 1, maxWafQueries: 1,
  concurrency: 1, requestMs: 10000, overallMs: 15000, providerBytes: 262144,
  headerBytes: 16384, inputBytes: 16384, reportBytes: 8192, queryWindowMs: 60000,
  profileAgeMs: 900000, rowLimit: 2 });
const API_PATH = `/metrics/v1?teamId=${TARGET.teamId}`;
const timestamp = z.string().max(24).datetime();
const profileSchema = z.object({ schemaVersion: z.literal(1),
  projectId: z.literal(TARGET.projectId), teamId: z.literal(TARGET.teamId),
  hostname: z.literal(TARGET.hostname), reviewedAt: timestamp,
  queryWindow: z.object({ start: timestamp, end: timestamp }).strict(),
  attestations: z.object({ sourceCodeReviewed: z.literal(true),
    credentialLoggingReviewed: z.literal(true) }).strict() }).strict();
const envelopeSchema = z.object({ profile: profileSchema,
  approval: z.string().regex(/^[a-f0-9]{64}$/),
  credentials: z.object({ providerToken: z.string().min(20).max(512)
    .regex(/^[A-Za-z0-9_-]+$/) }).strict() }).strict();
const FILES = Object.freeze(['gate1-provider-access.js', 'run-gate1-provider-access.ps1',
  'gate1-source-discovery.js', 'gate1-source-waf.js', 'gate1-host-protection.js']);
const CODES = new Set(['arguments', 'input', 'profile', 'approval', 'credentials',
  'request_budget', 'deadline', 'cancelled', 'transport', 'response_headers', 'response_size',
  'response_encoding', 'response_incomplete', 'redirect', 'cookie_contract',
  'provider_status', 'provider_schema', 'provider_ambiguous', 'unexpected_rows', 'internal']);
// Only exact literals are retained. CLI-derived status labels are not provider causes.
const ERROR_CODES = new Map(['forbidden', 'unauthorized', 'bad_request', 'payment_required', 'rate_limited']
  .flatMap((code) => [[code, code], [code.toUpperCase(), code]]));

/** Carry fixed failure codes only; arbitrary exception messages never reach output. */
class AccessError extends Error {
  /** Normalize the reason supplied by internal validation or transport boundaries. */
  constructor(code) { super(CODES.has(code) ? code : 'internal'); this.code = this.message; }
}

/** Create an unapproved offline template with a fixed preceding minute; now is a test seam. */
function profileTemplate(now = Date.now()) {
  const end = Math.floor(now / 1000) * 1000;
  return { schemaVersion: 1, ...TARGET, reviewedAt: new Date(now).toISOString(),
    queryWindow: { start: new Date(end - LIMITS.queryWindowMs).toISOString(), end: new Date(end).toISOString() },
    attestations: { sourceCodeReviewed: false, credentialLoggingReviewed: false } };
}

/** Validate and detach a fixed-scope profile; its minute must end at preparation, not an arbitrary date. */
function parseProfile(value) {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new AccessError('profile');
  const profile = parsed.data;
  const start = Date.parse(profile.queryWindow.start), end = Date.parse(profile.queryWindow.end);
  const reviewed = Date.parse(profile.reviewedAt);
  if (![start, end, reviewed].every(Number.isFinite) || end - start !== LIMITS.queryWindowMs
    || end % 1000 !== 0 || Math.floor(reviewed / 1000) * 1000 !== end) throw new AccessError('profile');
  return profile;
}

/** Refuse stale/future profiles at review and again before live dispatch; no query refresh is implicit. */
function requireFresh(profile, wall) {
  const age = wall - Date.parse(profile.reviewedAt);
  if (!Number.isFinite(wall) || age < 0 || age > LIMITS.profileAgeMs) throw new AccessError('profile');
}

/** Hash normalized scope/window, bounds and executable script dependencies; reads code only, never auth files. */
function approvalId(profile) {
  const digest = createHash('sha256').update(JSON.stringify({ profile: parseProfile(profile), limits: LIMITS }));
  for (const name of FILES) {
    digest.update(name).update('\0').update(fs.readFileSync(path.join(__dirname, name))).update('\0');
  }
  return digest.digest('hex');
}

/** Return offline review facts and an approval identifier; preparation does not grant live permission. */
function preparation(value = null, now = Date.now()) {
  const profile = value === null ? null : parseProfile(value);
  if (profile) requireFresh(profile, now);
  return { schemaVersion: 1, mode: 'prepare', scope: 'provider_metrics_access_only',
    liveApproved: false, gate1Status: 'open', appRequests: 0, providerRequests: 0,
    target: TARGET, profile, approvalId: profile ? approvalId(profile) : null, limits: LIMITS,
    endpoint: 'https://api.vercel.com/metrics/v1', method: 'POST',
    sourceAgreement: 'not_evaluated', correlation: 'unqualified', completeness: 'unqualified',
    nextStep: profile ? 'obtain_separate_live_approval' : 'complete_local_profile',
    limitations: ['query_access_only', 'fresh_marker_has_no_application_request',
      'unknown_errors_remain_unclassified', 'no_deployment_attribution_checks'] };
}

/**
 * Project transient provider JSON to bounded facts. Only exact allowlisted codes
 * survive; messages and unknown codes never do. An empty 200 establishes query
 * access only, and unexpected rows for the unused marker stop the diagnostic.
 */
function reviewResponse(response, profile, marker) {
  const facts = { jsonContentType: /^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || ''),
    jsonValid: false, errorObjectPresent: false, errorCodePresent: false, errorMessagePresent: false,
    errorCode: null, queryAccepted: false, rows: 'not_evaluated',
    failure: response.status === 200 ? 'provider_schema' : 'provider_status' };
  let value;
  try { value = JSON.parse(response.body); facts.jsonValid = true; } catch { return facts; }
  if (!facts.jsonContentType || !value || typeof value !== 'object' || Array.isArray(value)) return facts;
  const error = value.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    facts.errorObjectPresent = true;
    facts.errorCodePresent = Object.hasOwn(error, 'code');
    facts.errorMessagePresent = Object.hasOwn(error, 'message');
    facts.errorCode = facts.errorCodePresent ? ERROR_CODES.get(error.code) || 'unrecognized' : null;
    return facts;
  }
  if (response.status !== 200) return facts;
  try {
    const metrics = reviewMetrics(value, profile, marker);
    facts.queryAccepted = true;
    facts.rows = metrics.rows === 0 ? 'empty' : 'unexpected';
    facts.failure = metrics.rows !== 0 ? 'unexpected_rows'
      : metrics.availability === 'no_rows' ? null : 'provider_ambiguous';
  } catch { facts.failure = 'provider_schema'; }
  return facts;
}

/**
 * Execute one provider-only query. All attempts pass through a fixed-authority
 * guard and counter. requestImpl/clock seams are for offline fixtures only;
 * production uses native HTTPS without retries, proxy settings or redirects.
 */
async function runAccess(input, deps = {}) {
  const report = { schemaVersion: 1, mode: deps.requestImpl ? 'fixture' : 'live',
    scope: 'provider_metrics_access_only', result: 'stopped', gate1Status: 'open',
    sourceAgreement: 'not_evaluated', correlation: 'unqualified', completeness: 'unqualified',
    hostedEvidence: deps.requestImpl ? 'not_executed' : 'requires_review',
    target: TARGET, queryWindow: null, approvalId: null, limits: LIMITS,
    appRequests: 0, providerRequests: 0, httpStatus: null, response: null,
    failure: null, stoppedPhase: 'validation' };
  const now = deps.now || (() => performance.now()), wall = deps.wall || Date.now;
  let started, wallStart, previous, phase = 'validation';
  try {
    started = now(); previous = started; wallStart = wall();
    if (!Number.isFinite(started) || started < 0 || !Number.isFinite(wallStart)
      || !Number.isFinite(new Date(wallStart).getTime())) throw new AccessError('deadline');
    report.startedAt = new Date(wallStart).toISOString();
    /** Bound execution including validation/response review; detect cancellation and clock discontinuity. */
    function remaining() {
      if (deps.signal?.aborted) throw new AccessError('cancelled');
      const current = now(), currentWall = wall();
      if (!Number.isFinite(current) || !Number.isFinite(currentWall) || current < previous
        || current - started >= LIMITS.overallMs
        || Math.abs((currentWall - wallStart) - (current - started)) > 5000) throw new AccessError('deadline');
      previous = current;
      return LIMITS.overallMs - (current - started);
    }
    remaining();
    const parsed = envelopeSchema.safeParse(input);
    if (!parsed.success) throw new AccessError('input');
    const { credentials, approval } = parsed.data;
    const profile = parseProfile(parsed.data.profile);
    if (JSON.stringify(profile).includes(credentials.providerToken)
      || approval.includes(credentials.providerToken)) throw new AccessError('credentials');
    if (approval !== approvalId(profile)) throw new AccessError('approval');
    requireFresh(profile, wall());
    report.queryWindow = profile.queryWindow; report.approvalId = approval;
    // This value is only a provider query filter: no corresponding app request exists.
    const marker = `gate1-source-${randomBytes(16).toString('hex')}`;
    const body = metricsQuery(profile, marker, profile.queryWindow);
    /** Count actual dispatches and capture status only; no caller-selected host or follow-up is allowed. */
    function dispatch(options, receive) {
      remaining();
      if (report.providerRequests >= LIMITS.maxProviderRequests || options.hostname !== 'api.vercel.com'
        || options.protocol !== 'https:' || options.port !== 443 || options.method !== 'POST'
        || options.path !== API_PATH) throw new AccessError('request_budget');
      report.providerRequests += 1;
      return (deps.requestImpl || https.request)(options, (incoming) => {
        if (Number.isInteger(incoming.statusCode) && incoming.statusCode >= 100 && incoming.statusCode <= 599) {
          report.httpStatus = incoming.statusCode;
        }
        receive(incoming);
      });
    }
    phase = 'metricsAccess';
    const response = await exchange({ hostname: 'api.vercel.com', path: API_PATH, method: 'POST',
      bytes: LIMITS.providerBytes, body, headers: { Accept: 'application/json', 'Accept-Encoding': 'identity',
        Authorization: `Bearer ${credentials.providerToken}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body) } },
    { requestImpl: dispatch, signal: deps.signal, timeoutMs: Math.min(LIMITS.requestMs, remaining()) });
    remaining();
    if (report.httpStatus === null) throw new AccessError('provider_schema');
    report.response = reviewResponse(response, profile, marker);
    remaining();
    if (report.response.failure) throw new AccessError(report.response.failure);
    report.result = 'completed'; report.stoppedPhase = null;
  } catch (error) {
    report.failure = error instanceof AccessError ? error.code
      : CODES.has(error?.message) ? error.message : 'internal';
    report.stoppedPhase = phase;
  }
  if (Number.isFinite(started) && Number.isFinite(wallStart)) {
    const elapsed = now() - started, finished = new Date(wallStart + elapsed);
    if (Number.isFinite(elapsed) && elapsed >= 0 && Number.isFinite(finished.getTime())) {
      report.elapsedMs = Math.round(elapsed * 1000) / 1000;
      report.finishedAt = finished.toISOString();
    }
  }
  return report;
}

/** Save a runner-produced sanitized report once under local .tmp; exclusive creation preserves prior evidence. */
function saveReport(report) {
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > LIMITS.reportBytes) throw new AccessError('internal');
  const directory = path.resolve(__dirname, '../.tmp');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `gate1-provider-access-${Date.now()}-${randomBytes(8).toString('hex')}.json`);
  fs.writeFileSync(file, encoded, { flag: 'wx', mode: 0o600 });
  return file;
}

/** CLI modes are exact and offline by default; the live envelope and token are read from bounded stdin only. */
async function main(args) {
  try {
    if (args.length > 1 || (args.length && !['--prepare', '--template', '--review', '--live'].includes(args[0]))) {
      throw new AccessError('arguments');
    }
    if (args[0] !== '--live') {
      const value = args[0] === '--template' ? profileTemplate()
        : args[0] === '--review' ? preparation(await readInput()) : preparation();
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }
    const controller = new AbortController();
    /** Interrupt owned transport without retaining signal details or dispatching again. */
    function cancel() { controller.abort(); }
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    let report;
    try { report = await runAccess(await readInput(), { signal: controller.signal }); }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    const reportPath = saveReport(report);
    process.stdout.write(`${JSON.stringify({ reportPath, report }, null, 2)}\n`);
    process.exitCode = report.result === 'completed' ? 0 : 1;
  } catch {
    process.stderr.write('Provider access preparation/execution failed. No automatic retry was attempted.\n');
    process.exitCode = 1;
  }
}

module.exports = { LIMITS, TARGET, profileTemplate, parseProfile, approvalId, preparation, reviewResponse, runAccess };
if (require.main === module) void main(process.argv.slice(2));
