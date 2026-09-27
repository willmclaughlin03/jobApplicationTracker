'use strict';

/**
 * Offline-by-default historical firewall traffic reader. A separate live approval
 * permits one provider POST, no application/configuration calls. Public contract:
 * vercel/vercel c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb,
 * packages/cli/src/util/firewall/get-firewall-traffic.ts and commands/metrics/types.ts.
 * This adapter discovers aggregate visibility; it cannot qualify request receipts.
 */
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { isDeepStrictEqual } = require('node:util');
const { z } = require('zod');
const { exchange, readInput } = require('./gate1-source-discovery');

const SCOPE = 'historical_firewall_traffic_summary_only';
const TARGET = Object.freeze({ projectId: 'prj_b2nMrysMSJtpmqoeGx5g0WGgGuom',
  teamId: 'team_7o3efmwjZbMc2Bfy9qAzkc9q', hostname: 'job-application-tracker-kappa-seven.vercel.app' });
const SOURCE = Object.freeze({ sha256: '4403d08daef40c4aeed403a221f3c1948c505404c5bee8677c474eab34fa5581',
  trialId: '3a4ee48060b1b2562857b38077e4a799',
  ruleId: 'rule_gate1_log_receipt_3a4ee48060b1b2562857b38077e4a799_VcUuC5',
  queryWindow: Object.freeze({ start: '2026-09-27T16:42:07.926Z', end: '2026-09-27T16:42:39.357Z' }) });
const LIMITS = Object.freeze({ maxAppRequests: 0, maxProviderRequests: 1, maxTrafficQueries: 1,
  maxConfigReads: 0, maxConfigMutations: 0, concurrency: 1, requestMs: 45000, overallMs: 60000,
  providerBytes: 262144, headerBytes: 16384, inputBytes: 16384, reportBytes: 8192,
  profileAgeMs: 900000, retentionMs: 86400000, rowLimit: 2 });
const API_PATH = `/v2/observability/query?teamId=${TARGET.teamId}`;
const ROLLUP = 'vercel_firewall_action_count_sum';
const DIMENSIONS = Object.freeze(['waf_rule_id', 'waf_action', 'request_hostname', 'request_path']);
const ATTESTATIONS = Object.freeze(['sourceCodeReviewed', 'credentialLoggingReviewed', 'includedUsageHeadroom']);
const FILES = Object.freeze(['gate1-traffic-receipt.js', 'run-gate1-traffic-receipt.ps1',
  'gate1-source-discovery.js', 'gate1-source-waf.js', 'gate1-host-protection.js']);
const REPORT_NAME = `gate1-traffic-receipt-${SOURCE.sha256}.json`;
const CODES = new Set(['arguments', 'input', 'profile', 'retention', 'approval', 'credentials',
  'approval_consumed', 'local_evidence', 'request_budget', 'deadline', 'cancelled', 'transport',
  'response_headers', 'response_size', 'response_encoding', 'response_incomplete', 'redirect',
  'cookie_contract', 'provider_status', 'provider_schema', 'provider_ambiguous', 'internal']);
const ERROR_CODES = new Set(['forbidden', 'unauthorized', 'bad_request', 'payment_required', 'rate_limited']);
const sourceSchema = z.object({ sha256: z.literal(SOURCE.sha256), trialId: z.literal(SOURCE.trialId),
  ruleId: z.literal(SOURCE.ruleId), queryWindow: z.object({ start: z.literal(SOURCE.queryWindow.start),
    end: z.literal(SOURCE.queryWindow.end) }).strict() }).strict();
const profileSchema = z.object({ schemaVersion: z.literal(1), scope: z.literal(SCOPE),
  projectId: z.literal(TARGET.projectId), teamId: z.literal(TARGET.teamId), hostname: z.literal(TARGET.hostname),
  sourceEvidence: sourceSchema, reviewedAt: z.string().max(24).datetime(),
  attestations: z.object(Object.fromEntries(ATTESTATIONS.map((key) => [key, z.literal(true)]))).strict() }).strict();
const envelopeSchema = z.object({ profile: profileSchema, approval: z.string().regex(/^[a-f0-9]{64}$/),
  credentials: z.object({ providerToken: z.string().min(20).max(512).regex(/^[A-Za-z0-9_-]+$/) }).strict() }).strict();
const countSchema = z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  z.string().max(16).regex(/^(0|[1-9][0-9]*)$/).pipe(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER))]);
const rowFields = { waf_rule_id: z.string().max(256), waf_action: z.string().max(64),
  request_hostname: z.string().max(253), request_path: z.string().max(2048), [ROLLUP]: countSchema };
const statisticsSchema = z.object({ rowsRead: z.number().int().nonnegative().optional(),
  bytesRead: z.number().int().nonnegative().optional(), dbTimeSeconds: z.number().nonnegative().optional(),
  engineTimeSeconds: z.number().nonnegative().optional(), queryTable: z.string().max(4096).optional(),
  cacheEngineTimeSeconds: z.number().nonnegative().optional(), cacheDbTimeSeconds: z.number().nonnegative().optional() }).strict();
const responseSchema = z.object({ summary: z.array(z.object(rowFields).strict()).max(LIMITS.rowLimit),
  data: z.array(z.object({ ...rowFields, timestamp: z.string().min(1).max(128) }).strict()).max(LIMITS.rowLimit).optional(),
  statistics: statisticsSchema, orderBy: z.literal(ROLLUP).optional(), orderDirection: z.literal('desc').optional(),
  sampled: z.boolean().optional(), truncated: z.boolean().optional() }).strict();

/** Carry only fixed internal reasons; arbitrary provider/OS error messages never reach output. */
class TrafficError extends Error {
  /** Normalize a caller-supplied reason at each validation/transport boundary. */
  constructor(code) { super(CODES.has(code) ? code : 'internal'); this.code = this.message; }
}

/** Return a detached, deliberately unapproved profile; source facts are pinned, not caller file reads. */
function profileTemplate(now = Date.now()) {
  return { schemaVersion: 1, scope: SCOPE, ...TARGET, sourceEvidence: JSON.parse(JSON.stringify(SOURCE)),
    reviewedAt: new Date(now).toISOString(), attestations: Object.fromEntries(ATTESTATIONS.map((key) => [key, false])) };
}

/** Validate exact historical scope and true attestations; Zod strips no unknown input fields. */
function parseProfile(value) {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new TrafficError('profile');
  return parsed.data;
}

/** Require a fresh review and the entire remaining run inside conservative 24-hour retention. */
function requireFresh(profile, wall) {
  const age = wall - Date.parse(profile.reviewedAt);
  if (!Number.isFinite(wall) || age < 0 || age > LIMITS.profileAgeMs) throw new TrafficError('profile');
  if (wall <= Date.parse(SOURCE.queryWindow.end)
    || wall + LIMITS.overallMs - Date.parse(SOURCE.queryWindow.start) >= LIMITS.retentionMs) throw new TrafficError('retention');
}

/** Build the fixed CLI-style query; OData literals are compile-time facts, never user input. */
function trafficQuery() {
  return { scope: { type: 'project', ownerId: TARGET.teamId, projectIds: [TARGET.projectId] },
    metric: 'vercel.firewall_action.count', aggregation: 'sum',
    startTime: SOURCE.queryWindow.start, endTime: SOURCE.queryWindow.end,
    granularity: { hours: 1 }, groupBy: [...DIMENSIONS],
    filter: `(waf_rule_id eq '${SOURCE.ruleId}') and (request_hostname eq '${TARGET.hostname}') and (request_path eq '/api/auth/session') and (waf_action eq 'log')`,
    limit: LIMITS.rowLimit, orderBy: ROLLUP, orderDirection: 'desc' };
}

/** Describe the only allowed request; explicit teamId mirrors the CLI accountId transport. */
function operation() {
  return { endpoint: `https://api.vercel.com${API_PATH}`, method: 'POST', query: trafficQuery(), limits: LIMITS };
}

/** Bind approval to exact facts, query/limits and executable dependencies, without reading auth files. */
function approvalId(value) {
  const digest = createHash('sha256').update(JSON.stringify({ profile: parseProfile(value), operation: operation() }));
  for (const name of FILES) digest.update(name).update('\0').update(fs.readFileSync(path.join(__dirname, name))).update('\0');
  return digest.digest('hex');
}

/** Prepare a zero-traffic review; historical retention cannot be extended by refreshing the profile. */
function preparation(value = null, wall = Date.now()) {
  const profile = value === null ? null : parseProfile(value);
  if (profile) requireFresh(profile, wall);
  return { schemaVersion: 1, mode: 'prepare', scope: SCOPE, liveApproved: false, gate1Status: 'open',
    target: TARGET, sourceEvidence: SOURCE, profile, ...operation(),
    approvalId: profile ? approvalId(profile) : null, reservationName: REPORT_NAME,
    appRequests: 0, providerRequests: 0, configReads: 0, configMutations: 0,
    sourceAgreement: 'not_evaluated', correlation: 'unqualified', completeness: 'unqualified',
    nextStep: profile ? 'obtain_separate_live_approval' : 'complete_local_profile',
    limitations: ['aggregate_is_not_a_request_receipt', 'bucket_time_is_not_request_time',
      'account_access_unverified', 'empty_result_is_inconclusive', 'no_pagination_or_retry',
      'reservation_is_per_worktree_do_not_replay_elsewhere'] };
}

/** Check exact row dimensions; mismatches and duplicates cannot become matching aggregate evidence. */
function matches(row) {
  return row.waf_rule_id === SOURCE.ruleId && row.waf_action === 'log'
    && row.request_hostname === TARGET.hostname && row.request_path === '/api/auth/session';
}

/** Project bounded provider JSON to fixed facts; raw bodies, statistics and arbitrary strings stay transient. */
function reviewResponse(response) {
  const observation = { jsonValid: false, schemaCompatible: false, queryAccepted: false,
    errorCode: null, rows: 'not_evaluated', matchingSummary: false, count: null,
    sampled: 'unknown', truncated: 'unknown', receipt: 'unqualified', failure: null };
  const contentType = response.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ...observation, failure: response.status === 200 ? 'provider_schema' : 'provider_status' };
  }
  let value;
  try { value = JSON.parse(response.body); } catch {
    return { ...observation, failure: response.status === 200 ? 'provider_schema' : 'provider_status' };
  }
  observation.jsonValid = true;
  if (response.status !== 200) {
    if (ERROR_CODES.has(value?.error?.code)) observation.errorCode = value.error.code;
    return { ...observation, failure: 'provider_status' };
  }
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) return { ...observation, failure: 'provider_schema' };
  const data = parsed.data;
  observation.schemaCompatible = true; observation.queryAccepted = true;
  observation.rows = data.summary.length ? 'nonempty' : 'empty';
  observation.sampled = data.sampled === undefined ? 'unknown' : data.sampled;
  observation.truncated = data.truncated === undefined ? 'unknown' : data.truncated;
  const series = data.data || [];
  // Even two identical rows would be ambiguous: the exact dimensions admit one group.
  if (data.sampled === true || data.truncated === true || data.summary.length > 1 || series.length > 1
    || !data.summary.every(matches) || !series.every(matches)
    || (series.length && (!data.summary.length || series[0][ROLLUP] !== data.summary[0][ROLLUP]))) {
    return { ...observation, receipt: 'ambiguous', failure: 'provider_ambiguous' };
  }
  if (!data.summary.length) return { ...observation, receipt: 'not_observed_in_query' };
  observation.count = data.summary[0][ROLLUP];
  observation.matchingSummary = observation.count > 0;
  observation.receipt = observation.matchingSummary ? 'matching_aggregate_only' : 'zero_count_summary';
  return observation;
}

/** Bound serialized runner-created evidence; this helper never accepts provider payloads. */
function encodeReport(report) {
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > LIMITS.reportBytes) throw new TrafficError('local_evidence');
  return encoded;
}

/** Reserve once per source/operation before dispatch; existing records, including failed runs, block replay. */
function reserve(report, directory) {
  let descriptor;
  try {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, REPORT_NAME);
    descriptor = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(descriptor, encodeReport(report)); fs.fsyncSync(descriptor);
    return file;
  } catch (error) { throw new TrafficError(error.code === 'EEXIST' ? 'approval_consumed' : 'local_evidence'); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** Replace only our reserved report atomically; a failed write leaves the preceding reservation intact. */
function checkpoint(file, report) {
  if (!file) return;
  let descriptor;
  try {
    const pending = `${file}.${randomBytes(8).toString('hex')}.pending`;
    descriptor = fs.openSync(pending, 'wx', 0o600);
    fs.writeFileSync(descriptor, encodeReport(report)); fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(pending, file);
  } catch { throw new TrafficError('local_evidence'); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** Execute a separately approved POST; test seams substitute transport/clocks and optional fixture storage. */
async function runTraffic(input, deps = {}) {
  const fixture = typeof deps.requestImpl === 'function';
  const report = { schemaVersion: 1, mode: fixture ? 'fixture' : 'live', scope: SCOPE,
    result: 'stopped', gate1Status: 'open', hostedEvidence: fixture ? 'not_executed' : 'requires_review',
    sourceAgreement: 'not_evaluated', correlation: 'unqualified', completeness: 'unqualified',
    target: TARGET, sourceEvidence: SOURCE, limits: LIMITS, approvalId: null,
    appRequests: 0, providerRequests: 0, trafficQueries: 0, configReads: 0, configMutations: 0,
    httpStatus: null, observation: null, failure: null, stoppedPhase: 'validation', dispatchState: 'not_started' };
  const now = deps.now || (() => performance.now()), wall = deps.wall || Date.now;
  let started, wallStart, previous, file, guardFailure, phase = 'validation';
  /** Bound validation, storage, dispatch and review; clock drift/cancellation stops without retries. */
  function remaining() {
    if (deps.signal?.aborted) throw new TrafficError('cancelled');
    const current = now(), currentWall = wall(), elapsed = current - started;
    if (![current, currentWall, elapsed].every(Number.isFinite) || current < previous || elapsed < 0
      || elapsed >= LIMITS.overallMs || Math.abs(currentWall - wallStart - elapsed) > 5000) throw new TrafficError('deadline');
    previous = current; return LIMITS.overallMs - elapsed;
  }
  try {
    started = now(); previous = started; wallStart = wall();
    if (!Number.isFinite(started) || started < 0 || !Number.isFinite(wallStart)
      || !Number.isFinite(new Date(wallStart).getTime())) throw new TrafficError('deadline');
    remaining();
    const parsed = envelopeSchema.safeParse(input);
    if (!parsed.success) throw new TrafficError('input');
    const { profile, approval, credentials } = parsed.data;
    requireFresh(profile, wall());
    if (JSON.stringify({ profile, approval, query: trafficQuery() }).includes(credentials.providerToken)) throw new TrafficError('credentials');
    if (approval !== approvalId(profile)) throw new TrafficError('approval');
    if (!fixture && deps.evidenceDirectory !== undefined) throw new TrafficError('input');
    remaining();
    report.approvalId = approval; report.startedAt = new Date(wallStart).toISOString();
    report.dispatchState = 'reserved';
    if (!fixture || deps.evidenceDirectory) file = reserve(report,
      fixture ? deps.evidenceDirectory : path.resolve(__dirname, '../.tmp'));
    const body = JSON.stringify(trafficQuery());
    const headers = { Accept: 'application/json', 'Accept-Encoding': 'identity',
      Authorization: `Bearer ${credentials.providerToken}`, 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body) };
    phase = 'historicalTraffic'; report.stoppedPhase = phase;
    /** Count the physical attempt, restricting authority, TLS, method, headers and operation before native dispatch. */
    function dispatch(options, receive) {
      try {
        remaining(); requireFresh(profile, wall());
        if (report.providerRequests !== 0 || options.hostname !== 'api.vercel.com'
          || options.path !== API_PATH || options.method !== 'POST' || options.protocol !== 'https:'
          || options.port !== 443 || options.agent !== false || options.rejectUnauthorized !== true
          || options.maxHeaderSize !== LIMITS.headerBytes || !isDeepStrictEqual(options.headers, headers)) throw new TrafficError('request_budget');
        report.dispatchState = 'dispatch_pending'; checkpoint(file, report);
        remaining(); requireFresh(profile, wall());
        report.providerRequests += 1; report.trafficQueries += 1;
      } catch (error) { guardFailure = error; throw error; }
      return (deps.requestImpl || https.request)(options, (incoming) => {
        if (Number.isInteger(incoming.statusCode) && incoming.statusCode >= 100 && incoming.statusCode <= 599) report.httpStatus = incoming.statusCode;
        receive(incoming);
      });
    }
    const response = await exchange({ hostname: 'api.vercel.com', path: API_PATH, method: 'POST',
      body, headers, bytes: LIMITS.providerBytes },
    { requestImpl: dispatch, signal: deps.signal, timeoutMs: Math.min(LIMITS.requestMs, remaining()) });
    remaining(); report.dispatchState = 'response_received';
    report.observation = reviewResponse(response);
    if (report.observation.failure) throw new TrafficError(report.observation.failure);
    remaining(); report.result = 'completed'; report.stoppedPhase = null;
  } catch (error) {
    const reason = guardFailure || error;
    report.failure = CODES.has(reason?.code) ? reason.code : 'internal'; report.stoppedPhase = phase;
  }
  const elapsed = now() - started;
  if (Number.isFinite(elapsed) && elapsed >= 0) report.elapsedMs = Math.round(elapsed * 1000) / 1000;
  try { checkpoint(file, report); }
  catch { report.evidenceFailure = 'local_evidence'; report.result = 'stopped'; }
  return { reportPath: file || null, report };
}

/** Parse exact offline/live CLI modes; credentials enter bounded stdin only, with signal cancellation. */
async function main(args) {
  try {
    if (args.length > 1 || (args.length && !['--prepare', '--template', '--review', '--live'].includes(args[0]))) throw new TrafficError('arguments');
    if (args[0] !== '--live') {
      const result = args[0] === '--template' ? profileTemplate()
        : args[0] === '--review' ? preparation(await readInput()) : preparation();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return;
    }
    const controller = new AbortController();
    /** Interrupt the owned exchange, discarding signal reasons and never replaying an attempt. */
    function cancel() { controller.abort(); }
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    let result;
    try { result = await runTraffic(await readInput(), { signal: controller.signal }); }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.report.result === 'completed' ? 0 : 1;
  } catch {
    process.stderr.write('Traffic receipt preparation/execution failed. No automatic retry was attempted.\n');
    process.exitCode = 1;
  }
}

module.exports = { SCOPE, TARGET, SOURCE, LIMITS, REPORT_NAME, profileTemplate, parseProfile,
  trafficQuery, approvalId, preparation, reviewResponse, runTraffic };
if (require.main === module) void main(process.argv.slice(2));
