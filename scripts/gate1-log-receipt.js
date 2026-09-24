'use strict';

/**
 * Offline-by-default ordinary Log receipt trial. A separately approved live run
 * owns one temporary rule, one anonymous request and one Events lookup. It never
 * qualifies source agreement. Native HTTPS and bounded stdin reuse discovery's
 * transport; credentials, configurations and event payloads remain transient.
 * A separate config-check profile permits only one read-only configuration GET
 * with sanitized validation facts; it cannot enter the rule lifecycle.
 */
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { isDeepStrictEqual } = require('node:util');
const { z } = require('zod');
const { exchange, readInput } = require('./gate1-source-discovery');

const TARGET = Object.freeze({ projectId: 'prj_b2nMrysMSJtpmqoeGx5g0WGgGuom',
  teamId: 'team_7o3efmwjZbMc2Bfy9qAzkc9q', hostname: 'job-application-tracker-kappa-seven.vercel.app' });
const LIMITS = Object.freeze({ maxAppRequests: 1, maxProviderRequests: 11,
  mainProviderRequests: 6, cleanupProviderRequests: 5, maxEventsQueries: 1,
  concurrency: 1, requestMs: 10000, mainMs: 120000, cleanupMs: 60000, overallMs: 180000,
  settlementMs: 30000, providerBytes: 262144, appBytes: 16384,
  headerBytes: 16384, inputBytes: 16384, reportBytes: 8192, profileAgeMs: 900000 });
const CONFIG_LIMITS = Object.freeze({ maxAppRequests: 0, maxProviderRequests: 1,
  maxEventsQueries: 0, maxConfigMutations: 0, concurrency: 1, requestMs: 10000,
  overallMs: 15000, providerBytes: 262144, headerBytes: 16384, inputBytes: 16384,
  reportBytes: 8192, profileAgeMs: 900000 });
const SCOPE = 'ordinary_log_receipt_trial_only';
const CONFIG_SCOPE = 'provider_firewall_config_check_only';
const CONFIG_PATH = `/v1/security/firewall/config?projectId=${TARGET.projectId}&teamId=${TARGET.teamId}`;
const DRAFT_PATH = `/v1/security/firewall/config/draft?projectId=${TARGET.projectId}&teamId=${TARGET.teamId}`;
const ACTIVATE_PATH = `/v1/security/firewall/config/draft/activate?projectId=${TARGET.projectId}&teamId=${TARGET.teamId}`;
const ATTESTATIONS = ['sourceCodeReviewed', 'credentialLoggingReviewed', 'noConcurrentWafEdits',
  'includedUsageHeadroom', 'recoveryProcedureReviewed'];
const CONFIG_ATTESTATIONS = ['sourceCodeReviewed', 'credentialLoggingReviewed', 'includedUsageHeadroom'];
const profileFields = { schemaVersion: z.literal(1),
  projectId: z.literal(TARGET.projectId), teamId: z.literal(TARGET.teamId), hostname: z.literal(TARGET.hostname),
  reviewedAt: z.string().max(24).datetime() };
const receiptProfileSchema = z.object({ ...profileFields,
  attestations: z.object(Object.fromEntries(ATTESTATIONS.map((key) => [key, z.literal(true)]))).strict(),
}).strict();
const configProfileSchema = z.object({ ...profileFields, queryMode: z.literal('config_check'),
  attestations: z.object(Object.fromEntries(CONFIG_ATTESTATIONS.map((key) => [key, z.literal(true)]))).strict(),
}).strict();
const profileSchema = z.union([receiptProfileSchema, configProfileSchema]);
const envelopeSchema = z.object({ profile: profileSchema, approval: z.string().regex(/^[a-f0-9]{64}$/),
  credentials: z.object({ providerToken: z.string().min(20).max(512).regex(/^[A-Za-z0-9_-]+$/) }).strict(),
}).strict();
const ruleIdSchema = z.string().regex(/^rule_[A-Za-z0-9_-]{1,128}$/);
const existingRuleSchema = z.object({ id: z.string().min(1).max(512), active: z.boolean(),
  name: z.string().max(4096), conditionGroup: z.array(z.unknown()) }).passthrough();
// Unknown policy fields are preserved for equality, never omitted by projection.
const configSchema = z.object({ id: z.string().min(1).max(512), version: z.number().int().nonnegative(),
  updatedAt: z.string().max(128), ownerId: z.literal(TARGET.teamId), projectKey: z.literal(TARGET.projectId),
  firewallEnabled: z.literal(true), changes: z.array(z.unknown()), ips: z.array(z.unknown()),
  rules: z.array(existingRuleSchema),
}).passthrough();
const snapshotSchema = z.object({ active: configSchema, draft: configSchema.nullable(),
  versions: z.array(z.unknown()) }).strict();
const eventString = z.string().max(4096);
const countSchema = z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().max(16).regex(/^(0|[1-9][0-9]*)$/).pipe(z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))]);
const eventsSchema = z.object({ actions: z.array(z.object({ action: eventString, action_type: eventString,
  count: countSchema, endTime: eventString, host: eventString,
  isActive: z.union([z.boolean(), z.enum(['true', 'false'])]), public_ip: eventString,
  ruleId: eventString.nullable(), ruleName: eventString.nullable(), startTime: eventString,
}).strict()) }).strict();
const FILES = ['gate1-log-receipt.js', 'run-gate1-log-receipt.ps1', 'gate1-source-discovery.js',
  'gate1-source-waf.js', 'gate1-host-protection.js'];
const CODES = new Set(['arguments', 'input', 'profile', 'approval', 'credentials', 'request_budget',
  'deadline', 'cancelled', 'transport', 'response_headers', 'response_size', 'response_encoding',
  'response_incomplete', 'redirect', 'cookie_contract', 'provider_status', 'provider_schema',
  'app_status', 'existing_draft', 'configuration_drift', 'rule_identity', 'approval_consumed',
  'mutation_unresolved', 'local_evidence', 'internal']);
const PHASES = Object.freeze({ baseline: ['GET', CONFIG_PATH], insert: ['PATCH', DRAFT_PATH],
  verifyDraft: ['GET', CONFIG_PATH], activate: ['POST', ACTIVATE_PATH], verifyActive: ['GET', CONFIG_PATH],
  inspectCleanup: ['GET', CONFIG_PATH], remove: ['PATCH', DRAFT_PATH], verifyRemoval: ['GET', CONFIG_PATH],
  activateRemoval: ['POST', ACTIVATE_PATH], verifyRestoration: ['GET', CONFIG_PATH],
  discard: ['DELETE', DRAFT_PATH], verifyDiscard: ['GET', CONFIG_PATH] });
const CLEANUP_PHASES = new Set(['inspectCleanup', 'remove', 'verifyRemoval', 'activateRemoval',
  'verifyRestoration', 'discard', 'verifyDiscard']);

/** Keep all failures in a fixed vocabulary; provider text never becomes a reason. */
class ReceiptError extends Error {
  /** Construct an allowlisted failure without retaining the original exception. */
  constructor(code) { super(CODES.has(code) ? code : 'internal'); this.code = this.message; }
}

/** Create an unapproved profile with only the attestations needed for the selected fixed operation. */
function profileTemplate(now = Date.now(), queryMode = 'log_receipt') {
  if (!z.enum(['log_receipt', 'config_check']).safeParse(queryMode).success) throw new ReceiptError('profile');
  const config = queryMode === 'config_check';
  return { schemaVersion: 1, ...(config ? { queryMode } : {}), ...TARGET, reviewedAt: new Date(now).toISOString(),
    attestations: Object.fromEntries((config ? CONFIG_ATTESTATIONS : ATTESTATIONS).map((key) => [key, false])) };
}

/** Validate and detach the fixed target and required operator attestations. */
function parseProfile(value) {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new ReceiptError('profile');
  return parsed.data;
}

/** Refuse future/stale approvals; preparation and live validation both call this. */
function requireFresh(profile, now) {
  const age = now - Date.parse(profile.reviewedAt);
  if (!Number.isFinite(age) || age < 0 || age > LIMITS.profileAgeMs) throw new ReceiptError('profile');
}

/** Bind a single profile to exact code, imported executable dependencies and budgets. */
function approvalId(value) {
  const profile = parseProfile(value);
  const operation = profile.queryMode === 'config_check'
    ? { scope: CONFIG_SCOPE, limits: CONFIG_LIMITS, method: 'GET', path: CONFIG_PATH, hostname: 'api.vercel.com' }
    : { scope: SCOPE, limits: LIMITS };
  const hash = createHash('sha256').update(JSON.stringify({ profile, ...operation }));
  for (const file of FILES) hash.update(file).update('\0').update(fs.readFileSync(path.join(__dirname, file))).update('\0');
  return hash.digest('hex');
}

/** Supply concrete offline review and manual recovery boundaries before live approval. */
function preparation(value = null, now = Date.now(), queryMode = 'log_receipt') {
  if (!z.enum(['log_receipt', 'config_check']).safeParse(queryMode).success) throw new ReceiptError('profile');
  const profile = value === null ? null : parseProfile(value);
  if (profile) requireFresh(profile, now);
  const config = profile ? profile.queryMode === 'config_check' : queryMode === 'config_check';
  if (config) return { schemaVersion: 1, mode: 'prepare', scope: CONFIG_SCOPE, queryMode: 'config_check',
    liveApproved: false, target: TARGET, profile, approvalId: profile ? approvalId(profile) : null,
    limits: CONFIG_LIMITS, appRequests: 0, providerRequests: 0, eventsQueries: 0, configMutations: 0,
    gate1Status: 'open', sourceAgreement: 'not_evaluated', correlation: 'unqualified', completeness: 'unqualified',
    application: null, rule: null, providerOrigin: 'https://api.vercel.com',
    endpoint: 'https://api.vercel.com/v1/security/firewall/config', method: 'GET',
    queryParameters: { projectId: TARGET.projectId, teamId: TARGET.teamId },
    limitations: ['configuration_read_only', 'current_trial_reader_contract_only',
      'schema_compatibility_is_not_write_authorization', 'no_log_action_or_source_evidence',
      'no_raw_configuration_or_validation_messages', 'no_retries_or_pagination'],
    nextStep: profile ? 'obtain_separate_live_approval' : 'complete_local_profile' };
  return { schemaVersion: 1, mode: 'prepare', scope: SCOPE, liveApproved: false,
    target: TARGET, profile, approvalId: profile ? approvalId(profile) : null, limits: LIMITS,
    appRequests: 0, providerRequests: 0, gate1Status: 'open', sourceAgreement: 'not_evaluated',
    correlation: 'unqualified', completeness: 'unqualified',
    application: { method: 'GET', path: '/api/auth/session', credentials: 'none' },
    rule: { action: 'log', conditions: ['host_eq', 'method_eq_GET', 'raw_path_eq_session', 'fresh_user_agent_eq'],
      equality: 'provider_case_insensitive', rateLimit: false },
    providerOrigin: 'https://api.vercel.com',
    lifecycle: ['read_config_refuse_draft', 'stage_verify_activate_verify', 'one_probe',
      'wait_30_seconds', 'one_events_lookup', 'inspect_remove_verify_activate_verify'],
    recovery: ['keep_waf_edit_freeze_until_restoration_verified', 'inspect_saved_trial_id_and_verified_rule_id',
      'if_unresolved_stop_and_review_current_config_with_owner', 'never_replay_or_bulk_restore',
      'remove_only_verified_owned_rule_or_discard_wholly_owned_draft_after_separate_recovery_review'],
    limitations: ['no_conditional_version_guard', 'cleanup_can_remain_unresolved',
      'hard_termination_can_prevent_cleanup', 'provider_history_may_retain_rule',
      'thirty_seconds_is_not_a_delivery_guarantee', 'aggregate_is_not_per_request_trace',
      'event_time_semantics_unqualified', 'no_pagination', 'no_paid_add_ons', 'included_usage_headroom_required'],
    nextStep: profile ? 'obtain_separate_live_approval' : 'complete_local_profile' };
}

/** Construct the sole allowed ordinary rule; marker and trial ID are freshly random in live code. */
function diagnosticRule(trialId, marker) {
  if (!/^[a-f0-9]{32}$/.test(trialId) || !/^gate1-log-[a-f0-9]{48}$/.test(marker)) throw new ReceiptError('input');
  return { name: `gate1-log-receipt-${trialId}`, active: true, conditionGroup: [{ conditions: [
    { type: 'host', op: 'eq', value: TARGET.hostname }, { type: 'method', op: 'eq', value: 'GET' },
    { type: 'raw_path', op: 'eq', value: '/api/auth/session' }, { type: 'user_agent', op: 'eq', value: marker },
  ] }], action: { mitigate: { action: 'log' } } };
}

/** Compare all configuration policy fields, retaining unknown fields and nested metadata/order. */
function policy(config) {
  const { id: _id, version: _version, updatedAt: _updatedAt, changes: _changes, ...rest } = config;
  return rest;
}

/** Accept only an exact owned rule plus documented, successful validation metadata. */
function matchesRule(rule, expected) {
  if (!rule || !ruleIdSchema.safeParse(rule.id).success || rule.valid !== true) return false;
  const { id: _id, valid: _valid, validationErrors, ...rest } = rule;
  return (validationErrors === undefined || validationErrors === null
    || (Array.isArray(validationErrors) && validationErrors.length === 0)) && isDeepStrictEqual(rest, expected);
}

/** Establish one exact addition, with every baseline policy field and original rule order preserved. */
function addedRule(config, baseline, expected) {
  const additions = config.rules.filter((rule) => !baseline.rules.some((old) => old.id === rule.id));
  if (additions.length !== 1 || !matchesRule(additions[0], expected)) throw new ReceiptError('configuration_drift');
  const rule = additions[0];
  const restored = { ...config, rules: config.rules.filter((item) => item.id !== rule.id) };
  if (!isDeepStrictEqual(policy(restored), policy(baseline))) throw new ReceiptError('configuration_drift');
  return rule;
}

/** Require one recognized owned draft operation in addition to full policy equality. */
function requireChange(draft, action, rule, expected) {
  const change = draft.changes[0];
  if (draft.changes.length !== 1 || !change || Object.keys(change).sort().join(',') !== 'action,id,value'
    || change.action !== action) throw new ReceiptError('configuration_drift');
  if (action === 'rules.insert') {
    if ((change.id !== null && change.id !== rule.id)
      || (!isDeepStrictEqual(change.value, expected) && !isDeepStrictEqual(change.value, rule))) {
      throw new ReceiptError('configuration_drift');
    }
  } else if (change.id !== rule.id || change.value !== null) throw new ReceiptError('configuration_drift');
}

/** Parse only successful bounded JSON; full provider data stays inside the runner. */
function providerJson(response) {
  if (response.status !== 200) throw new ReceiptError('provider_status');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '')) throw new ReceiptError('provider_schema');
  try { return JSON.parse(response.body); } catch { throw new ReceiptError('provider_schema'); }
}

/** Classify JSON types using fixed vocabulary; no value or provider-selected key escapes. */
function valueType(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return ['object', 'string', 'number', 'boolean'].includes(typeof value) ? typeof value : 'other';
}

/** Read only an own field with a caller-fixed name; inherited fields never satisfy the contract. */
function ownValue(value, key) { return valueType(value) === 'object' && Object.hasOwn(value, key) ? value[key] : undefined; }

/** Aggregate existing-rule validation without retaining rule IDs, names, conditions or array indices. */
function ruleFacts(value) {
  if (!Array.isArray(value)) return null;
  const result = { entriesValid: true, idValid: true, activeValid: true, nameValid: true,
    conditionGroupsValid: true, idsUnique: null };
  const fields = { id: 'idValid', active: 'activeValid', name: 'nameValid', conditionGroup: 'conditionGroupsValid' };
  for (const rule of value) {
    if (valueType(rule) !== 'object') result.entriesValid = false;
    for (const [key, fact] of Object.entries(fields)) {
      if (!existingRuleSchema.shape[key].safeParse(ownValue(rule, key)).success) result[fact] = false;
    }
  }
  if (result.idValid) result.idsUnique = new Set(value.map((rule) => rule.id)).size === value.length;
  return result;
}

/** Report fixed field types and acceptance by the unchanged strict trial reader, never provider values. */
function configFacts(value) {
  if (valueType(value) !== 'object') return null;
  const fields = {};
  for (const [key, schema] of Object.entries(configSchema.shape)) {
    const field = ownValue(value, key);
    fields[key] = { type: valueType(field), valid: schema.safeParse(field).success };
  }
  return { fields, rules: ruleFacts(ownValue(value, 'rules')) };
}

/**
 * Separate transport/JSON/schema stages and preserve only fixed diagnostic facts.
 * The parsed snapshot is returned solely to the internal mutation guard; it is
 * never attached to reports. This does not relax nullable, scalar or identity
 * prerequisites merely because the provider SDK has a more permissive parser.
 */
function inspectConfigResponse(response) {
  const facts = { basis: 'current_trial_reader_contract', jsonContentType: false, jsonValid: false,
    schemaCompatible: null, validationStage: 'http_status', failure: 'provider_status',
    rootType: 'not_evaluated', envelope: null, active: null, draft: null };
  facts.jsonContentType = /^application\/json(?:\s*;|$)/i.test(response.headers?.['content-type'] || '');
  if (response.status !== 200) return { facts };
  facts.failure = 'provider_schema'; facts.schemaCompatible = false; facts.validationStage = 'content_type';
  if (!facts.jsonContentType) return { facts };
  let value;
  facts.validationStage = 'json';
  try { value = JSON.parse(response.body); facts.jsonValid = true; } catch { return { facts }; }
  facts.rootType = valueType(value); facts.validationStage = 'envelope';
  if (facts.rootType !== 'object') return { facts };
  facts.envelope = { active: valueType(ownValue(value, 'active')), draft: valueType(ownValue(value, 'draft')),
    versions: valueType(ownValue(value, 'versions')),
    unexpectedFields: Object.keys(value).some((key) => !['active', 'draft', 'versions'].includes(key)) };
  facts.active = configFacts(ownValue(value, 'active')); facts.draft = configFacts(ownValue(value, 'draft'));
  if (facts.envelope.unexpectedFields || facts.envelope.active === 'missing'
    || facts.envelope.draft === 'missing' || facts.envelope.versions !== 'array') return { facts };
  facts.validationStage = 'active_config';
  if (!configSchema.safeParse(value.active).success) return { facts };
  facts.validationStage = 'draft_config';
  if (value.draft !== null && !configSchema.safeParse(value.draft).success) return { facts };
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) { facts.validationStage = 'envelope'; return { facts }; }
  facts.validationStage = 'duplicate_rule_ids';
  if (facts.active.rules.idsUnique === false || facts.draft?.rules.idsUnique === false) return { facts };
  facts.schemaCompatible = true; facts.validationStage = 'compatible'; facts.failure = null;
  return { facts, value: parsed.data };
}

/** Public diagnostic projection deliberately excludes the internal parsed configuration. */
function reviewConfigResponse(response) { return inspectConfigResponse(response).facts; }

/** Validate the unchanged full-trial prerequisites, optionally recording sanitized initial-read facts. */
function snapshot(response, report) {
  const reviewed = inspectConfigResponse(response);
  if (report) report.baselineCheck = reviewed.facts;
  if (reviewed.facts.failure) throw new ReceiptError(reviewed.facts.failure);
  return reviewed.value;
}

/** Project receipt candidates only; ISO interval overlap is a fact, never request-level attribution. */
function reviewEvents(value, ruleId, window) {
  const parsed = eventsSchema.safeParse(value);
  if (!parsed.success) throw new ReceiptError('provider_schema');
  const rows = parsed.data.actions.filter((row) => row.ruleId === ruleId);
  const result = { schemaCompatible: true, rows: parsed.data.actions.length ? 'nonempty' : 'empty',
    matchingRows: rows.length, matchingRuleObserved: rows.length > 0, logActionObserved: false,
    hostMatch: null, count: null, cardinality: 'not_observed', timestampFormat: 'not_evaluated',
    intervalOverlapsQuery: null, timingQualified: false, receipt: 'not_observed_in_trial' };
  if (!rows.length) return result;
  result.logActionObserved = rows.some((row) => row.action === 'log');
  result.hostMatch = rows.every((row) => row.host === TARGET.hostname);
  const count = rows.reduce((sum, row) => sum + row.count, 0);
  result.count = Number.isSafeInteger(count) ? count : null;
  result.cardinality = rows.length === 1 && count === 1 ? 'single_summary_count_one' : 'multiple_or_conflicting';
  const times = rows.map((row) => [row.startTime, row.endTime].map((time) =>
    z.string().datetime({ offset: true }).safeParse(time).success ? Date.parse(time) : NaN));
  const supported = times.every(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start);
  result.timestampFormat = supported ? 'iso8601_interval' : 'unsupported_or_invalid';
  if (supported) result.intervalOverlapsQuery = times.every(([start, end]) => start <= window.end && end >= window.start);
  result.receipt = rows.length === 1 && result.hostMatch && rows[0].action === 'log' && count > 0
    && count === 1 && supported && result.intervalOverlapsQuery ? 'matching_log_summary_observed' : 'ambiguous';
  return result;
}

/** Wait once with cancellation; no polling, retry or new request is scheduled by this helper. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    /** Cancel the timer without exposing signal reasons. */
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new ReceiptError('cancelled')); }
    /** Remove the abort listener after the one fixed settling interval. */
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(done, ms + 1);
  });
}

/** Encode only runner-owned facts and bound every durable recovery/report checkpoint. */
function encodeReport(report) {
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > LIMITS.reportBytes) throw new ReceiptError('local_evidence');
  return encoded;
}

/** Reserve an approval exclusively before any live call; its checkpoint survives an interrupted process. */
function reserveTrial(report) {
  const directory = path.resolve(__dirname, '../.tmp');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `gate1-log-receipt-${report.approvalId}.json`);
  try { fs.writeFileSync(file, encodeReport(report), { flag: 'wx', mode: 0o600 }); }
  catch (error) { throw new ReceiptError(error.code === 'EEXIST' ? 'approval_consumed' : 'local_evidence'); }
  return file;
}

/** Update the sanitized local recovery record; never write a profile, marker, response or secret. */
function checkpoint(file, report) {
  if (!file) return;
  let descriptor;
  try {
    const encoded = encodeReport(report);
    // Same-directory replacement preserves the preceding valid record on a hard stop.
    const pending = `${file}.${randomBytes(8).toString('hex')}.pending`;
    descriptor = fs.openSync(pending, 'wx', 0o600);
    fs.writeFileSync(descriptor, encoded);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(pending, file);
  } catch { throw new ReceiptError('local_evidence'); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/**
 * Execute the approval-bound trial, with six provider calls for work and five
 * reserved for reconciliation/cleanup. Test seams replace native HTTPS/clocks;
 * fixture runs never write durable evidence. Cleanup has its own cancellation
 * boundary and cannot blindly restore a baseline or publish another draft.
 */
async function runReceipt(input, deps = {}) {
  const report = { schemaVersion: 1, mode: deps.requestImpl ? 'fixture' : 'live', scope: SCOPE,
    result: 'stopped', gate1Status: 'open', sourceAgreement: 'not_evaluated', correlation: 'unqualified',
    completeness: 'unqualified', hostedEvidence: deps.requestImpl ? 'not_executed' : 'requires_review',
    target: TARGET, limits: LIMITS, approvalId: null, trialId: null, ruleId: null,
    appRequests: 0, providerRequests: 0, mainProviderRequests: 0, cleanupProviderRequests: 0, eventsQueries: 0,
    receipts: [], observation: null, cleanup: { status: 'not_needed', failure: null, restorationVerified: false },
    failure: null, stoppedPhase: 'validation', recoveryPhase: 'not_started' };
  const now = deps.now || (() => performance.now()), wall = deps.wall || Date.now;
  const controller = new AbortController(), cleanupController = new AbortController();
  let timer, started, wallStart, previous, cleanupStart, cleaning = false, armed = false;
  let baseline, activeTrial, verifiedRule, expected, token, file, phase = 'validation', completed = false;
  let guardFailure, pendingMutation = null;
  const used = new Set();
  /** Stop main work; cleanup deliberately uses a distinct controller and remaining reserve. */
  function cancel() { controller.abort(); }
  deps.signal?.addEventListener('abort', cancel, { once: true });
  if (deps.signal?.aborted) cancel();
  /** Check both clocks and the phase deadline before and after every asynchronous boundary. */
  function remaining() {
    if (!cleaning && controller.signal.aborted) throw new ReceiptError(deps.signal?.aborted ? 'cancelled' : 'deadline');
    const current = now(), currentWall = wall();
    const elapsed = current - started;
    if (![current, currentWall, elapsed].every(Number.isFinite) || current < previous || elapsed < 0
      || Math.abs((currentWall - wallStart) - elapsed) > 5000) throw new ReceiptError('deadline');
    previous = current;
    const left = Math.min(LIMITS.overallMs - elapsed,
      cleaning ? LIMITS.cleanupMs - (current - cleanupStart) : LIMITS.mainMs - elapsed);
    if (left <= 0) throw new ReceiptError('deadline');
    return left;
  }
  /** Count physical attempts at native dispatch; destination, phase and body are built internally. */
  async function request(nextPhase, body, window) {
    phase = nextPhase;
    const app = phase === 'probe', events = phase === 'events';
    const selected = PHASES[phase];
    if (used.has(phase) || (cleaning !== CLEANUP_PHASES.has(phase)) || (!selected && !app && !events)) {
      throw new ReceiptError('request_budget');
    }
    used.add(phase);
    const query = events ? new URLSearchParams({ projectId: TARGET.projectId, teamId: TARGET.teamId,
      startTimestamp: window.start, endTimestamp: window.end, hosts: TARGET.hostname }) : null;
    const spec = { hostname: app ? TARGET.hostname : 'api.vercel.com',
      path: app ? '/api/auth/session' : events ? `/v1/security/firewall/events?${query}` : selected[1],
      method: app || events ? 'GET' : selected[0], bytes: app ? LIMITS.appBytes : LIMITS.providerBytes,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity',
        ...(app ? { 'User-Agent': expected.conditionGroup[0].conditions[3].value } : { Authorization: `Bearer ${token}` }) } };
    if (spec.body !== undefined) Object.assign(spec.headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(spec.body) });
    remaining();
    report.recoveryPhase = phase;
    // Durable intent precedes every mutation and the probe. Failure here stops main work.
    if (!cleaning) checkpoint(file, report);
    else {
      try { checkpoint(file, report); }
      catch { report.evidenceFailure = 'local_evidence'; }
    }
    const receipt = { phase, httpStatus: null };
    /** Guard the exact precomputed operation and capture only a numeric HTTP status. */
    function dispatch(options, receive) {
      try {
        remaining();
        if (options.hostname !== spec.hostname || options.path !== spec.path || options.method !== spec.method
          || options.protocol !== 'https:' || options.port !== 443 || options.rejectUnauthorized !== true
          || options.agent !== false || !isDeepStrictEqual(options.headers, spec.headers)) throw new ReceiptError('request_budget');
        if (app) {
          if (report.appRequests >= LIMITS.maxAppRequests) throw new ReceiptError('request_budget');
          report.appRequests += 1;
        } else {
          const key = cleaning ? 'cleanupProviderRequests' : 'mainProviderRequests';
          if (report.providerRequests >= LIMITS.maxProviderRequests || report[key] >= LIMITS[key]
            || (events && report.eventsQueries >= LIMITS.maxEventsQueries)) throw new ReceiptError('request_budget');
          report.providerRequests += 1; report[key] += 1;
          if (events) report.eventsQueries += 1;
        }
        if (spec.method !== 'GET') {
          pendingMutation = phase;
          report.pendingMutation = phase;
        }
        report.receipts.push(receipt);
      } catch (error) { guardFailure = error; throw error; }
      return (deps.requestImpl || https.request)(options, (incoming) => {
        if (Number.isInteger(incoming.statusCode) && incoming.statusCode >= 100 && incoming.statusCode <= 599) receipt.httpStatus = incoming.statusCode;
        receive(incoming);
      });
    }
    const response = await exchange(spec, { requestImpl: dispatch,
      signal: cleaning ? cleanupController.signal : controller.signal, timeoutMs: Math.min(LIMITS.requestMs, remaining()) });
    remaining();
    return response;
  }
  /** Clear uncertainty only after acknowledgement or readback of that operation's expected effect. */
  function resolvedMutation() { pendingMutation = null; report.pendingMutation = null; }
  /** Issue one mutation with no retry; a missing/invalid acknowledgement leaves its effect uncertain. */
  async function mutate(nextPhase, body) {
    const response = await request(nextPhase, body);
    if (nextPhase === 'discard') {
      if (response.status !== 204 || response.body !== '') throw new ReceiptError('provider_status');
    } else providerJson(response);
    resolvedMutation();
  }
  /** Validate a newly recovered provider rule ID before allowing it into recovery evidence or removal. */
  function ownRule(rule) {
    if (!matchesRule(rule, expected) || (verifiedRule && !isDeepStrictEqual(verifiedRule, rule))
      || rule.id.includes(token) || token.includes(rule.id)) throw new ReceiptError('rule_identity');
    verifiedRule = rule; report.ruleId = rule.id;
  }
  /** Reconcile uncertain mutations using the cleanup reserve and remove only fully recognized owned state. */
  async function cleanup() {
    cleaning = true; cleanupStart = now(); guardFailure = null;
    report.cleanup.status = 'cleanup_unresolved';
    const current = snapshot(await request('inspectCleanup'));
    if (isDeepStrictEqual(policy(current.active), policy(baseline))) {
      // An unchanged snapshot cannot rule out a timed-out write committing later.
      if (pendingMutation && (current.draft === null || pendingMutation !== 'insert')) throw new ReceiptError('mutation_unresolved');
      if (current.draft === null) { report.cleanup.status = 'restored'; report.cleanup.restorationVerified = true; return; }
      if (!isDeepStrictEqual(current.active, baseline)) throw new ReceiptError('configuration_drift');
      const rule = addedRule(current.draft, baseline, expected);
      ownRule(rule); requireChange(current.draft, 'rules.insert', rule, expected);
      resolvedMutation();
      // Even when acknowledgement is lost, spend the existing final read to check the effect.
      try { await mutate('discard'); } catch { /* No retry: verify the owned draft's disappearance. */ }
      const final = snapshot(await request('verifyDiscard'));
      if (final.draft !== null || !isDeepStrictEqual(final.active, baseline)) throw new ReceiptError('configuration_drift');
      resolvedMutation();
    } else {
      if (current.draft !== null) throw new ReceiptError('configuration_drift');
      if (pendingMutation && pendingMutation !== 'activate') throw new ReceiptError('mutation_unresolved');
      const rule = addedRule(current.active, baseline, expected);
      ownRule(rule);
      if (activeTrial && !isDeepStrictEqual(current.active, activeTrial)) throw new ReceiptError('configuration_drift');
      resolvedMutation();
      try { await mutate('remove', { action: 'rules.remove', id: rule.id, value: null }); }
      catch { /* Verify the effect within the reserved call budget before proceeding. */ }
      const staged = snapshot(await request('verifyRemoval'));
      if (!staged.draft || !isDeepStrictEqual(staged.active, current.active)
        || !isDeepStrictEqual(policy(staged.draft), policy(baseline))) throw new ReceiptError('configuration_drift');
      requireChange(staged.draft, 'rules.remove', rule, expected);
      resolvedMutation();
      try { await mutate('activateRemoval', {}); } catch { /* Only final readback can establish restoration. */ }
      const final = snapshot(await request('verifyRestoration'));
      if (final.draft !== null || !isDeepStrictEqual(policy(final.active), policy(baseline))) throw new ReceiptError('configuration_drift');
      resolvedMutation();
    }
    report.cleanup.status = 'restored'; report.cleanup.restorationVerified = true;
  }
  try {
    started = now(); previous = started; wallStart = wall(); remaining();
    timer = setTimeout(cancel, LIMITS.mainMs);
    const parsed = envelopeSchema.safeParse(input);
    if (!parsed.success) throw new ReceiptError('input');
    const profile = parseProfile(parsed.data.profile);
    if (profile.queryMode === 'config_check') throw new ReceiptError('profile');
    requireFresh(profile, wall());
    token = parsed.data.credentials.providerToken;
    if (JSON.stringify(profile).includes(token) || parsed.data.approval.includes(token)) throw new ReceiptError('credentials');
    if (parsed.data.approval !== approvalId(profile)) throw new ReceiptError('approval');
    report.approvalId = parsed.data.approval; report.trialId = randomBytes(16).toString('hex');
    report.startedAt = new Date(wallStart).toISOString();
    expected = diagnosticRule(report.trialId, `gate1-log-${randomBytes(24).toString('hex')}`);
    if (!deps.requestImpl) file = reserveTrial(report);
    const first = snapshot(await request('baseline'), report);
    if (first.draft !== null) throw new ReceiptError('existing_draft');
    baseline = first.active;
    if (baseline.rules.some((rule) => rule.name === expected.name)) throw new ReceiptError('rule_identity');
    armed = true; report.cleanup.status = 'cleanup_unresolved';
    await mutate('insert', { action: 'rules.insert', id: null, value: expected });
    const staged = snapshot(await request('verifyDraft'));
    if (!staged.draft || !isDeepStrictEqual(staged.active, baseline)) throw new ReceiptError('configuration_drift');
    ownRule(addedRule(staged.draft, baseline, expected));
    requireChange(staged.draft, 'rules.insert', verifiedRule, expected);
    await mutate('activate', {});
    const active = snapshot(await request('verifyActive'));
    if (active.draft !== null) throw new ReceiptError('configuration_drift');
    ownRule(addedRule(active.active, baseline, expected)); activeTrial = active.active;
    const probeStart = wall(), probe = await request('probe');
    report.appStatus = probe.status;
    if (probe.status !== 200) throw new ReceiptError('app_status');
    const sleepStart = now();
    phase = 'settlement';
    await (deps.sleep || delay)(LIMITS.settlementMs, controller.signal);
    remaining();
    if (now() - sleepStart < LIMITS.settlementMs) throw new ReceiptError('deadline');
    const window = { start: Math.floor(probeStart), end: Math.floor(wall()) };
    report.queryWindow = { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() };
    report.observation = reviewEvents(providerJson(await request('events', undefined, window)), verifiedRule.id, window);
    completed = true; report.stoppedPhase = null;
  } catch (error) {
    report.failure = failureCode(guardFailure || error); report.stoppedPhase = phase;
  } finally {
    clearTimeout(timer);
    if (armed) {
      try { await cleanup(); }
      catch (error) { report.cleanup.failure = failureCode(guardFailure || error); }
    }
    deps.signal?.removeEventListener('abort', cancel);
    token = null;
  }
  report.result = completed && report.cleanup.restorationVerified ? 'completed' : 'stopped';
  if (completed && !report.cleanup.restorationVerified) { report.failure = report.cleanup.failure; report.stoppedPhase = phase; }
  const elapsed = now() - started;
  if (Number.isFinite(elapsed) && elapsed >= 0) report.elapsedMs = Math.round(elapsed * 1000) / 1000;
  try { checkpoint(file, report); }
  catch { report.evidenceFailure = 'local_evidence'; report.result = 'stopped'; }
  if (file) report.reportPath = file;
  return report;
}

/** Normalize a trusted internal/transport failure without retaining arbitrary messages. */
function failureCode(error) { return CODES.has(error?.code) ? error.code : CODES.has(error?.message) ? error.message : 'internal'; }

/**
 * Diagnose one fixed configuration GET under its own profile/approval/budget.
 * This sequencer has no mutation, application, Events, retry or cleanup branch;
 * even a compatible configuration ends the check without entering runReceipt.
 */
async function runConfigCheck(input, deps = {}) {
  const report = { schemaVersion: 1, mode: deps.requestImpl ? 'fixture' : 'live',
    scope: CONFIG_SCOPE, queryMode: 'config_check', result: 'stopped',
    gate1Status: 'open', sourceAgreement: 'not_evaluated', correlation: 'unqualified', completeness: 'unqualified',
    hostedEvidence: deps.requestImpl ? 'not_executed' : 'requires_review', target: TARGET,
    limits: CONFIG_LIMITS, approvalId: null, appRequests: 0, providerRequests: 0,
    eventsQueries: 0, configMutations: 0, endpoint: 'https://api.vercel.com/v1/security/firewall/config',
    method: 'GET', receipts: [], configurationCheck: null,
    cleanup: { status: 'not_needed', failure: null, restorationVerified: false },
    failure: null, stoppedPhase: 'validation' };
  const now = deps.now || (() => performance.now()), wall = deps.wall || Date.now;
  let started, wallStart, previous, file, guardFailure, phase = 'validation';
  /** Check cancellation and both clocks before dispatch and after the bounded response. */
  function remaining() {
    if (deps.signal?.aborted) throw new ReceiptError('cancelled');
    const current = now(), currentWall = wall();
    const elapsed = current - started;
    if (![current, currentWall, elapsed].every(Number.isFinite) || current < previous || elapsed < 0
      || elapsed >= CONFIG_LIMITS.overallMs || Math.abs((currentWall - wallStart) - elapsed) > 5000) throw new ReceiptError('deadline');
    previous = current;
    return CONFIG_LIMITS.overallMs - elapsed;
  }
  try {
    started = now(); previous = started; wallStart = wall(); remaining();
    const parsed = envelopeSchema.safeParse(input);
    if (!parsed.success) throw new ReceiptError('input');
    const profile = parseProfile(parsed.data.profile);
    if (profile.queryMode !== 'config_check') throw new ReceiptError('profile');
    requireFresh(profile, wall());
    const { approval, credentials } = parsed.data;
    if (JSON.stringify(profile).includes(credentials.providerToken) || approval.includes(credentials.providerToken)) throw new ReceiptError('credentials');
    if (approval !== approvalId(profile)) throw new ReceiptError('approval');
    report.approvalId = approval; report.startedAt = new Date(wallStart).toISOString();
    if (!deps.requestImpl) file = reserveTrial(report);
    phase = 'configCheck'; report.stoppedPhase = phase;
    checkpoint(file, report);
    const headers = { Accept: 'application/json', 'Accept-Encoding': 'identity', Authorization: `Bearer ${credentials.providerToken}` };
    const receipt = { phase, httpStatus: null };
    /** Count actual native dispatch and reject every operation except this exact single GET. */
    function dispatch(options, receive) {
      try {
        remaining();
        if (report.providerRequests >= CONFIG_LIMITS.maxProviderRequests
          || options.hostname !== 'api.vercel.com' || options.path !== CONFIG_PATH || options.method !== 'GET'
          || options.protocol !== 'https:' || options.port !== 443 || options.rejectUnauthorized !== true
          || options.agent !== false || !isDeepStrictEqual(options.headers, headers)) throw new ReceiptError('request_budget');
        report.providerRequests += 1; report.receipts.push(receipt);
      } catch (error) { guardFailure = error; throw error; }
      return (deps.requestImpl || https.request)(options, (incoming) => {
        if (Number.isInteger(incoming.statusCode) && incoming.statusCode >= 100 && incoming.statusCode <= 599) receipt.httpStatus = incoming.statusCode;
        receive(incoming);
      });
    }
    const response = await exchange({ hostname: 'api.vercel.com', path: CONFIG_PATH, method: 'GET',
      bytes: CONFIG_LIMITS.providerBytes, headers },
    { requestImpl: dispatch, signal: deps.signal, timeoutMs: Math.min(CONFIG_LIMITS.requestMs, remaining()) });
    remaining();
    report.configurationCheck = reviewConfigResponse(response);
    if (report.configurationCheck.failure) throw new ReceiptError(report.configurationCheck.failure);
    remaining(); report.result = 'completed'; report.stoppedPhase = null;
  } catch (error) {
    report.failure = failureCode(guardFailure || error); report.stoppedPhase = phase;
  }
  const elapsed = now() - started;
  if (Number.isFinite(elapsed) && elapsed >= 0) report.elapsedMs = Math.round(elapsed * 1000) / 1000;
  try { checkpoint(file, report); }
  catch { report.evidenceFailure = 'local_evidence'; report.result = 'stopped'; }
  if (file) report.reportPath = file;
  return report;
}

/** CLI input is bounded stdin only, offline by default; signal cancellation still reserves cleanup time. */
async function main(args) {
  try {
    if (args.length > 1 || (args.length && !['--prepare', '--template', '--config-prepare', '--config-template', '--review', '--live'].includes(args[0]))) throw new ReceiptError('arguments');
    if (args[0] !== '--live') {
      const value = args[0] === '--template' ? profileTemplate()
        : args[0] === '--config-template' ? profileTemplate(Date.now(), 'config_check')
        : args[0] === '--config-prepare' ? preparation(null, Date.now(), 'config_check')
        : args[0] === '--review' ? preparation(await readInput()) : preparation();
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return;
    }
    const controller = new AbortController();
    /** Request graceful main cancellation; never abort the independent cleanup reserve. */
    function cancel() { controller.abort(); }
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    let report;
    try {
      const input = await readInput();
      report = await (input?.profile?.queryMode === 'config_check' ? runConfigCheck : runReceipt)(input, { signal: controller.signal });
    }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    process.stdout.write(encodeReport(report));
    process.exitCode = report.result === 'completed' ? 0 : 1;
  } catch {
    process.stderr.write('Log receipt preparation/execution failed. Do not rerun; inspect the local recovery report before further WAF edits.\n');
    process.exitCode = 1;
  }
}

module.exports = { LIMITS, CONFIG_LIMITS, TARGET, profileTemplate, parseProfile, approvalId, preparation,
  diagnosticRule, reviewEvents, reviewConfigResponse, runReceipt, runConfigCheck };
if (require.main === module) void main(process.argv.slice(2));
