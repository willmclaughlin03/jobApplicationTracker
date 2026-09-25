'use strict';

/**
 * Local, offline-by-default GATE-1 provider-access diagnostic. Separate live
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
// Events has no documented row-limit parameter; transport bytes bound its collection instead.
const EVENTS_LIMITS = Object.freeze({ ...LIMITS, rowLimit: null });
const API_PATH = `/metrics/v1?teamId=${TARGET.teamId}`;
const EVENTS_PATH = '/v1/security/firewall/events';
const queryModeSchema = z.enum(['discovery_shape', 'action_control', 'events_access']);
const timestamp = z.string().max(24).datetime();
const profileSchema = z.object({ schemaVersion: z.literal(2),
  queryMode: queryModeSchema,
  projectId: z.literal(TARGET.projectId), teamId: z.literal(TARGET.teamId),
  hostname: z.literal(TARGET.hostname), reviewedAt: timestamp,
  queryWindow: z.object({ start: timestamp, end: timestamp }).strict(),
  attestations: z.object({ sourceCodeReviewed: z.literal(true),
    credentialLoggingReviewed: z.literal(true) }).strict() }).strict();
const actionResponseSchema = z.object({ summary: z.array(z.object({
  dimensions: z.object({ wafAction: z.string().min(1).max(64) }).strict(),
  values: z.object({ value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
}).strict()).max(LIMITS.rowLimit), series: z.array(z.unknown()).length(0).optional(),
sampled: z.boolean().optional(), truncated: z.boolean().optional() }).strict();
// The REST examples quote scalars, while the SDK accepts native types and strings.
// Accept only canonical string forms, never SDK defaults for missing/null values.
// Contract: vercel.com/docs/rest-api/security/read-firewall-actions-by-project;
// vercel/sdk src/models/getsecurityfirewalleventsop.ts and src/types/primitives.ts.
const eventCountSchema = z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  z.string().max(16).regex(/^(0|[1-9][0-9]*)$/)
    .pipe(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER))]);
const eventStringSchema = z.string().max(4096);
const eventsResponseSchema = z.object({ actions: z.array(z.object({
  action: eventStringSchema, action_type: eventStringSchema, count: eventCountSchema,
  endTime: eventStringSchema, host: eventStringSchema,
  isActive: z.union([z.boolean(), z.enum(['true', 'false'])]),
  public_ip: eventStringSchema, ruleId: eventStringSchema.nullable(),
  ruleName: eventStringSchema.nullable(), startTime: eventStringSchema,
}).strict()) }).strict();
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
const MESSAGE_HINT_BYTES = 2048;
// Fixed vocabulary detects mentions only, including negated statements; it cannot establish a cause.
const MESSAGE_HINT_PATTERNS = Object.freeze({
  permissionMentioned: /\b(?:permissions?|forbidden|unauthori[sz]ed|authori[sz]ation|access[ \t]+denied|not[ \t]+authori[sz]ed)\b/i,
  scopeOrRoleMentioned: /\b(?:scope[ds]?|teams?|membership|roles?)\b/i,
  queryDimensionsMentioned: /\b(?:dimensions?|group[ \t]*by|clientIp|clientUserAgent|requestHostname|requestPath)\b/i,
  retentionMentioned: /\b(?:retention|retained|time[ \t]+range|time[ \t]+window|too[ \t]+old)\b/i,
  planOrSubscriptionMentioned: /\b(?:plans?|subscriptions?|observability|upgrade|entitlements?)\b/i,
});

/** Carry fixed failure codes only; arbitrary exception messages never reach output. */
class AccessError extends Error {
  /** Normalize the reason supplied by internal validation or transport boundaries. */
  constructor(code) { super(CODES.has(code) ? code : 'internal'); this.code = this.message; }
}

/** Create an unapproved explicit-mode template with a fixed minute; defaults remain metrics action-control. */
function profileTemplate(now = Date.now(), queryMode = 'action_control') {
  if (!queryModeSchema.safeParse(queryMode).success) throw new AccessError('profile');
  const end = Math.floor(now / 1000) * 1000;
  return { schemaVersion: 2, queryMode, ...TARGET, reviewedAt: new Date(now).toISOString(),
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

/**
 * Derive the only permitted provider operation from a validated profile. Events
 * timestamps are epoch milliseconds and hosts is one scalar, matching Vercel's
 * fetchFirewallPersistentActions implementation in CLI 59.20.0 (verified
 * 2026-09-24). No arbitrary URLs or paging.
 */
function operationFor(profile) {
  if (profile?.queryMode !== 'events_access') {
    return { scope: 'provider_metrics_access_only', endpoint: 'https://api.vercel.com/metrics/v1',
      method: 'POST', path: API_PATH, limits: LIMITS };
  }
  const queryParameters = { projectId: profile.projectId, teamId: profile.teamId,
    startTimestamp: Date.parse(profile.queryWindow.start), endTimestamp: Date.parse(profile.queryWindow.end),
    hosts: profile.hostname };
  return { scope: 'provider_firewall_events_access_only', endpoint: `https://api.vercel.com${EVENTS_PATH}`,
    method: 'GET', path: `${EVENTS_PATH}?${new URLSearchParams(queryParameters)}`,
    limits: EVENTS_LIMITS, queryParameters };
}

/** Hash the exact operation, normalized profile, bounds and executable dependencies; never read auth files. */
function approvalId(profile) {
  const normalized = parseProfile(profile);
  const digest = createHash('sha256').update(JSON.stringify({ profile: normalized, operation: operationFor(normalized) }));
  for (const name of FILES) {
    digest.update(name).update('\0').update(fs.readFileSync(path.join(__dirname, name))).update('\0');
  }
  return digest.digest('hex');
}

/** Build the fixed action-only control for this profile; host/path filters remain, with no marker or app traffic. */
function actionQuery(profile) {
  return JSON.stringify({ scope: { ownerId: profile.teamId, projectIds: [profile.projectId] },
    timeRange: profile.queryWindow,
    metrics: { value: { metric: 'vercel.firewall_action.count', aggregation: 'count' } },
    outputs: ['value'], groupBy: ['wafAction'],
    filter: `(requestHostname:"${profile.hostname}") AND (requestPath:"/api/auth/session")`,
    rowLimit: LIMITS.rowLimit, orderBy: [{ metric: 'value', direction: 'desc' }] });
}

/** Return offline review facts and an approval identifier; preparation does not grant live permission. */
function preparation(value = null, now = Date.now()) {
  const profile = value === null ? null : parseProfile(value);
  if (profile) requireFresh(profile, now);
  const control = profile?.queryMode === 'action_control';
  const events = profile?.queryMode === 'events_access', operation = operationFor(profile);
  return { schemaVersion: 2, mode: 'prepare', scope: operation.scope,
    liveApproved: false, gate1Status: 'open', appRequests: 0, providerRequests: 0,
    target: TARGET, profile, approvalId: profile ? approvalId(profile) : null, limits: operation.limits,
    queryMode: profile?.queryMode ?? null, query: control ? JSON.parse(actionQuery(profile)) : null,
    endpoint: operation.endpoint, method: operation.method,
    ...(events ? { queryParameters: operation.queryParameters, logActionCoverage: 'not_evaluated' } : {}),
    sourceAgreement: 'not_evaluated', correlation: 'unqualified', completeness: 'unqualified',
    nextStep: profile ? 'obtain_separate_live_approval' : 'complete_local_profile',
    limitations: ['query_access_only',
      ...(events ? ['log_action_coverage_unverified', 'action_summaries_are_not_request_traces',
        'no_server_row_limit', 'response_processing_bounded_by_bytes', 'no_pagination']
        : control ? ['action_control_is_not_the_detailed_query', 'action_rows_do_not_establish_source_agreement',
        'not_an_exact_replay_of_the_prior_cli_query']
        : profile ? ['fresh_marker_has_no_application_request'] : []),
      'unknown_errors_remain_unclassified', 'message_hints_are_not_a_diagnosis',
      'missing_authorization_fields_are_inconclusive', 'no_deployment_attribution_checks'] };
}

/**
 * Project a transient error message to fixed mention flags for response review.
 * Non-string/oversized inputs are not scanned or coerced; unknown text stays
 * unclassified. No text, matches, provider keys or instructions escape this helper.
 */
function reviewMessageHints(message) {
  const hints = { basis: 'message_terms_only', classification: 'not_evaluated',
    permissionMentioned: false, scopeOrRoleMentioned: false, queryDimensionsMentioned: false,
    retentionMentioned: false, planOrSubscriptionMentioned: false };
  if (typeof message !== 'string') return hints;
  if (Buffer.byteLength(message, 'utf8') > MESSAGE_HINT_BYTES) {
    hints.classification = 'too_large';
    return hints;
  }
  hints.classification = 'unclassified';
  for (const [key, pattern] of Object.entries(MESSAGE_HINT_PATTERNS)) {
    hints[key] = pattern.test(message);
    if (hints[key]) hints.classification = 'recognized_terms';
  }
  return hints;
}

/** Project one own boolean field without coercion; absent and invalid types are distinct from false. */
function reviewBooleanField(value, field) {
  if (!Object.hasOwn(value, field)) return 'absent';
  if (value[field] === true) return 'true';
  return value[field] === false ? 'false' : 'invalid_type';
}

/** Retain only typed CLI-relevant authorization signals and team equality; no provider text or IDs escape. */
function reviewAuthorizationHints(error = {}) {
  return { basis: 'structured_error_fields_only', saml: reviewBooleanField(error, 'saml'),
    enforced: reviewBooleanField(error, 'enforced'),
    teamId: !Object.hasOwn(error, 'teamId') ? 'absent' : typeof error.teamId !== 'string' ? 'invalid_type'
      : error.teamId === TARGET.teamId ? 'matches_target' : 'different_target' };
}

/** Validate bounded action summaries and discard their labels/counts; sampling never establishes completeness. */
function reviewActionResponse(value) {
  const parsed = actionResponseSchema.safeParse(value);
  if (!parsed.success) throw new AccessError('provider_schema');
  return parsed.data.summary.length === 0 ? 'empty' : 'nonempty';
}

/**
 * Validate the bounded Events wire schema, then discard all action values,
 * including sources and rule names. Empty/nonempty establishes API access only.
 */
function reviewEventsResponse(value) {
  const parsed = eventsResponseSchema.safeParse(value);
  if (!parsed.success) throw new AccessError('provider_schema');
  return parsed.data.actions.length === 0 ? 'empty' : 'nonempty';
}

/**
 * Project transient provider JSON to bounded facts: exact allowlisted codes and
 * structured/wording hints, never text or unknown codes. Action rows establish
 * access only; detailed-query rows for the unused marker still stop the diagnostic.
 */
function reviewResponse(response, profile, marker) {
  const facts = { jsonContentType: /^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || ''),
    jsonValid: false, errorObjectPresent: false, errorCodePresent: false, errorMessagePresent: false,
    errorCode: null, errorMessageHints: reviewMessageHints(), queryAccepted: false, rows: 'not_evaluated',
    authorizationHints: reviewAuthorizationHints(),
    ...(profile.queryMode === 'events_access' ? { schemaCompatible: false } : {}),
    failure: response.status === 200 ? 'provider_schema' : 'provider_status' };
  let value;
  try { value = JSON.parse(response.body); facts.jsonValid = true; } catch { return facts; }
  if (!facts.jsonContentType || !value || typeof value !== 'object' || Array.isArray(value)) return facts;
  const error = value.error;
  if (Object.hasOwn(value, 'error')) {
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      facts.errorObjectPresent = true;
      facts.errorCodePresent = Object.hasOwn(error, 'code');
      facts.errorMessagePresent = Object.hasOwn(error, 'message');
      facts.errorCode = facts.errorCodePresent ? ERROR_CODES.get(error.code) || 'unrecognized' : null;
      if (facts.errorMessagePresent) facts.errorMessageHints = reviewMessageHints(error.message);
      facts.authorizationHints = reviewAuthorizationHints(error);
    }
    return facts;
  }
  if (response.status !== 200) return facts;
  try {
    if (profile.queryMode === 'events_access') {
      facts.rows = reviewEventsResponse(value);
      facts.schemaCompatible = true;
      facts.queryAccepted = true;
      facts.failure = null;
    } else if (profile.queryMode === 'action_control') {
      facts.rows = reviewActionResponse(value);
      facts.queryAccepted = true;
      facts.failure = null;
    } else {
      const metrics = reviewMetrics(value, profile, marker);
      facts.queryAccepted = true;
      facts.rows = metrics.rows === 0 ? 'empty' : 'unexpected';
      facts.failure = metrics.rows !== 0 ? 'unexpected_rows'
        : metrics.availability === 'no_rows' ? null : 'provider_ambiguous';
    }
  } catch { facts.failure = 'provider_schema'; }
  return facts;
}

/**
 * Execute one provider-only query. All attempts pass through a fixed-authority
 * guard and counter. requestImpl/clock seams are for offline fixtures only;
 * production uses native HTTPS without retries, proxy settings or redirects.
 */
async function runAccess(input, deps = {}) {
  const report = { schemaVersion: 2, mode: deps.requestImpl ? 'fixture' : 'live',
    scope: 'provider_metrics_access_only', result: 'stopped', gate1Status: 'open',
    sourceAgreement: 'not_evaluated', correlation: 'unqualified', completeness: 'unqualified',
    hostedEvidence: deps.requestImpl ? 'not_executed' : 'requires_review',
    target: TARGET, queryMode: null, queryWindow: null, approvalId: null, limits: LIMITS,
    appRequests: 0, providerRequests: 0, httpStatus: null, response: null,
    failure: null, stoppedPhase: 'validation' };
  const now = deps.now || (() => performance.now()), wall = deps.wall || Date.now;
  let started, wallStart, previous, phase = 'validation';
  // exchange normalizes dispatch exceptions to transport; retain local guard codes separately.
  let guardFailure = null;
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
    const operation = operationFor(profile);
    const events = profile.queryMode === 'events_access';
    report.scope = operation.scope; report.limits = operation.limits;
    report.endpoint = operation.endpoint; report.method = operation.method;
    if (events) report.logActionCoverage = 'not_evaluated';
    report.queryMode = profile.queryMode;
    report.queryWindow = profile.queryWindow; report.approvalId = approval;
    // This value is only a provider query filter: no corresponding app request exists.
    const marker = profile.queryMode === 'discovery_shape' ? `gate1-source-${randomBytes(16).toString('hex')}` : null;
    const body = events ? undefined : profile.queryMode === 'action_control' ? actionQuery(profile)
      : metricsQuery(profile, marker, profile.queryWindow);
    /** Count actual dispatches and capture status only; no caller-selected host or follow-up is allowed. */
    function dispatch(options, receive) {
      try {
        remaining();
        if (report.providerRequests >= LIMITS.maxProviderRequests || options.hostname !== 'api.vercel.com'
          || options.protocol !== 'https:' || options.port !== 443 || options.method !== operation.method
          || options.path !== operation.path) throw new AccessError('request_budget');
      } catch (error) {
        guardFailure = error instanceof AccessError ? error : new AccessError('internal');
        throw guardFailure;
      }
      report.providerRequests += 1;
      return (deps.requestImpl || https.request)(options, (incoming) => {
        if (Number.isInteger(incoming.statusCode) && incoming.statusCode >= 100 && incoming.statusCode <= 599) {
          report.httpStatus = incoming.statusCode;
        }
        receive(incoming);
      });
    }
    phase = events ? 'eventsAccess' : 'metricsAccess';
    const response = await exchange({ hostname: 'api.vercel.com', path: operation.path, method: operation.method,
      bytes: LIMITS.providerBytes, body, headers: { Accept: 'application/json', 'Accept-Encoding': 'identity',
        Authorization: `Bearer ${credentials.providerToken}`,
        ...(events ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) } },
    { requestImpl: dispatch, signal: deps.signal, timeoutMs: Math.min(LIMITS.requestMs, remaining()) });
    remaining();
    if (report.httpStatus === null) throw new AccessError('provider_schema');
    report.response = reviewResponse(response, profile, marker);
    remaining();
    if (report.response.failure) throw new AccessError(report.response.failure);
    report.result = 'completed'; report.stoppedPhase = null;
  } catch (error) {
    report.failure = guardFailure ? guardFailure.code : error instanceof AccessError ? error.code
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
    if (args.length > 1 || (args.length && !['--prepare', '--template', '--events-template', '--review', '--live'].includes(args[0]))) {
      throw new AccessError('arguments');
    }
    if (args[0] !== '--live') {
      const value = args[0] === '--template' ? profileTemplate()
        : args[0] === '--events-template' ? profileTemplate(Date.now(), 'events_access')
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

module.exports = { LIMITS, EVENTS_LIMITS, TARGET, profileTemplate, parseProfile, approvalId, preparation, reviewResponse, runAccess };
if (require.main === module) void main(process.argv.slice(2));
