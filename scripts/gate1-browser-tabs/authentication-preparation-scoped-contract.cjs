'use strict';
/* global AbortController */

const { z } = require('zod');
const t = require('./authentication-preparation-traffic.cjs');
const a = require('./authentication-preparation.cjs');
const d = require('./hosted-csrf-diagnostic.cjs');
const { check, PreparationError, errorCode } = t;
const DECISION = 'authentication-preparation-scoped-v1';
const LIMITS = Object.freeze({ ...t.LIMITS, upstreamBytes: 8388608, downstreamBytes: 58720256,
  tunnelBytes: 67108864, httpConcurrent: 32, targetSessions: 16, records: 1024,
  events: 4096, pendingCommands: 64, connectHeaderBytes: 8192 });
const COVERAGE = Object.freeze({ browserTrafficMeasured: false, hostedQualified: false,
  gate1Status: 'open', backgroundHttp: 'unknown', serverOAuth: 'excluded',
  requestClientProxy: 'bypass', proxyMeasurement: 'connect_authority_and_payload_bytes' });
const KINDS = Object.freeze(['application', 'session', 'canonicalStatic', 'providerStatic', 'supabase', 'google', 'metadata']);
const CHECKS = Object.freeze(['identityBeforeRestart', 'identityAfterRestart', 'normalClosure',
  'independentProcessExit', 'profilePreserved', 'listenersClosed', 'targetReconciled', 'pageEventsPaired']);
const QUALIFICATION_CHECKS = Object.freeze(['targetBeforeResume', 'redirectReservations', 'persistentCookie',
  'requestClientAccess', 'requestClientWriteBack', 'requestClientCancellation', 'restoredWorkerBlocked',
  'transportOverflow', 'normalClosure', 'independentProcessExit', 'manualContextRecovery']);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();

/** Build a closed literal schema; rejected input is never interpolated into an error. */
function exact(value) { return z.object(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, z.literal(item)]))).strict(); }
/** Bound aggregate fields to their reviewed caps without accepting arbitrary evidence keys. */
function counters(keys, maximum = Number.MAX_SAFE_INTEGER) {
  return z.object(Object.fromEntries(keys.map(key => [key, integer.max(maximum)]))).strict();
}
const planSchema = z.object({ schemaVersion: z.literal(2), decision: z.literal(DECISION),
  approval: z.literal('scoped-authentication-preparation'), sourceSet: hash, decisionHash: hash,
  toolSet: hash, qualificationHash: hash, buildHash: z.literal(a.BUILD_HASH), target: exact(d.TARGET),
  buildId: z.literal(a.BUILD), profile: z.literal(d.PROFILE), limits: exact(LIMITS),
  ledgerBefore: z.object({ actual: exact(a.BASELINE.actual), conservative: exact(a.BASELINE.conservative) }).strict(),
  approvedAt: integer, expiresAt: integer }).strict();
const qualificationSchema = z.object({ schemaVersion: z.literal(2), scope: z.literal('scoped_authentication_native'),
  sourceSet: hash, decisionHash: hash, toolSet: hash, attemptHash: hash, completionHash: hash,
  phase: z.literal('passed'), checks: exact(Object.fromEntries(QUALIFICATION_CHECKS.map(key => [key, true]))),
  browserTrafficMeasured: z.literal(false), hostedQualified: z.literal(false) }).strict();
const ownerSchema = z.object({ profile: z.literal(d.PROFILE), pid: integer.positive(),
  port: integer.min(1).max(65535), closedNormally: z.literal(true), exitCode: z.literal(0) }).strict();
const trafficSchema = z.object({ counts: counters(KINDS), observed: integer, admitted: integer,
  acknowledged: integer, confirmed: integer, completed: integer, uncertain: integer,
  page: integer, requestClient: integer, inFlight: z.literal(0), retained: integer.max(LIMITS.records),
  unreservedObservations: z.literal(0), bodyBytes: integer.max(LIMITS.proxyBytes),
  events: integer.max(LIMITS.events), launches: z.literal(2), firstFailure: z.null() }).strict();
const proxySchema = z.object({ connections: integer.max(LIMITS.proxyConnections), concurrent: z.literal(0),
  overLimit: integer, denied: integer, tunnels: integer.max(LIMITS.proxyConnections),
  upstream: counters(['read', 'admitted', 'rejected', 'written']),
  downstream: counters(['read', 'admitted', 'rejected', 'written']), forwardingClosed: z.literal(true) }).strict();
const receiptSchema = z.object({ schemaVersion: z.literal(2), scope: z.literal('scoped_authentication_preparation'),
  decision: z.literal(DECISION), decisionHash: hash, sourceSet: hash, toolSet: hash, qualificationHash: hash,
  planHash: hash, buildHash: z.literal(a.BUILD_HASH), target: exact(d.TARGET), buildId: z.literal(a.BUILD),
  profile: z.literal(d.PROFILE), startedAt: integer, completedAt: integer, phase: z.literal('passed'),
  coverage: exact(COVERAGE), browserTrafficMeasured: z.literal(false), hostedQualified: z.literal(false),
  gate1Status: z.literal('open'), identityVerified: z.literal(true), closedNormally: z.literal(true),
  independentProcessExitVerified: z.literal(true), checks: exact(Object.fromEntries(CHECKS.map(key => [key, true]))),
  owners: z.array(ownerSchema).length(2), listenerPorts: z.array(integer.min(1).max(65535)).length(1),
  traffic: trafficSchema, proxy: proxySchema,
  requests: z.object({ actual: counters(['application', 'static', 'session']),
    conservative: counters(['application', 'static', 'session']) }).strict() }).strict();
const failureCode = z.enum(['arguments', 'approval', 'expired', 'target', 'identity', 'schema', 'integrity',
  'coverage_unqualified', 'destination', 'budget', 'deadline', 'stopped', 'observation', 'operation',
  'cancelled', 'closure', 'process_inspection', 'process_present', 'port_open', 'receipt', 'already_used',
  'toolchain', 'profile', 'debug_logging', 'fixture', 'worker_completion']);
const stoppedSchema = z.object({ schemaVersion: z.literal(2), scope: z.literal('scoped_authentication_preparation'),
  phase: z.literal('stopped'), decision: z.literal(DECISION), decisionHash: hash, sourceSet: hash, planHash: hash,
  startedAt: integer, completedAt: integer, coverage: exact(COVERAGE), firstFailure: failureCode,
  traffic: trafficSchema.extend({ inFlight: integer.max(LIMITS.httpConcurrent), launches: integer.max(2),
    unreservedObservations: integer.max(LIMITS.httpConcurrent),
    events: integer.max(LIMITS.events + 1), firstFailure: failureCode }).strict(),
  proxy: proxySchema.extend({ concurrent: integer.max(LIMITS.proxyConcurrent), forwardingClosed: z.boolean() }).strict().nullable(),
  checks: z.object(Object.fromEntries(CHECKS.map(key => [key, z.boolean()]))).strict(),
  browserTrafficMeasured: z.literal(false), hostedQualified: z.literal(false), gate1Status: z.literal('open') }).strict();

/** Validate the expiring scope before I/O; expected identity stays entirely in caller memory. */
function validatePlan(plan, identity, now = Date.now()) {
  check(planSchema.safeParse(plan).success, 'schema');
  check(z.string().uuid().safeParse(identity).success, 'identity');
  check(plan.approvedAt <= now && now < plan.expiresAt && plan.expiresAt - plan.approvedAt <= 3600000, 'expired');
  return true;
}
/** Bind a distinct qualification to externally reviewed bytes, rejecting old or hand-edited historical receipts. */
function validateQualification(record, digest, plan, review) {
  check(qualificationSchema.safeParse(record).success, 'coverage_unqualified');
  check(review && review.qualificationHash === digest && digest === plan.qualificationHash
    && review.sourceSet === plan.sourceSet && review.decisionHash === plan.decisionHash
    && review.toolSet === plan.toolSet && review.completionHash === record.completionHash
    && record.sourceSet === plan.sourceSet && record.decisionHash === plan.decisionHash
    && record.toolSet === plan.toolSet, 'integrity');
  return true;
}
/** Reject malformed/private receipt fields and enforce arithmetic independently of worker assertions. */
function validateReceipt(record) {
  check(receiptSchema.safeParse(record).success, 'receipt');
  const q = record.traffic; const c = q.counts;
  check(KINDS.every(key => c[key] <= LIMITS[key]) && c.session <= c.application, 'budget');
  const total = KINDS.filter(key => key !== 'session').reduce((sum, key) => sum + c[key], 0);
  check(q.admitted === total && q.observed === total && q.completed === total && q.confirmed === total
    && q.uncertain === 0 && q.acknowledged === total && q.page + q.requestClient + c.metadata === total
    && q.requestClient === 1 && c.session >= 2 && c.metadata === 6, 'observation');
  const increment = { application: c.application, static: c.canonicalStatic + c.providerStatic, session: c.session };
  for (const kind of ['actual', 'conservative']) {
    check(Object.keys(increment).every(key => record.requests[kind][key] === increment[key]), 'receipt');
  }
  const p = record.proxy;
  check(p.tunnels >= 1 && p.tunnels <= p.connections && p.upstream.admitted <= LIMITS.upstreamBytes
    && p.downstream.admitted <= LIMITS.downstreamBytes
    && p.upstream.admitted + p.downstream.admitted <= LIMITS.tunnelBytes, 'budget');
  for (const direction of [p.upstream, p.downstream]) check(direction.read === direction.admitted + direction.rejected
    && direction.written <= direction.admitted, 'receipt');
  check(record.owners[0].pid !== record.owners[1].pid && record.completedAt >= record.startedAt, 'closure');
  return true;
}

/** Stopped evidence retains charged/uncertain attempts and partial cleanup without claiming success. */
function validateAttempt(record) {
  if (record?.phase === 'passed') return validateReceipt(record);
  check(stoppedSchema.safeParse(record).success, 'receipt');
  const q = record.traffic;
  check(q.firstFailure === record.firstFailure && KINDS.every(key => q.counts[key] <= LIMITS[key])
    && q.counts.session <= q.counts.application && q.completed <= q.admitted
    && q.confirmed <= q.admitted && q.acknowledged <= q.admitted && q.uncertain <= q.admitted
    && q.observed >= q.admitted && record.completedAt >= record.startedAt, 'receipt');
  return true;
}

/** Shared synchronous reservation ledger; all asynchronous actors see one permanent stop and abort signal. */
class ScopedBudget {
  /** Initialize bounded in-memory records and a work deadline leaving cleanup time untouched. */
  constructor({ clock = Date.now, limits = LIMITS } = {}) {
    this.clock = clock; this.limits = Object.freeze({ ...limits }); this.startedAt = clock();
    this.deadline = this.startedAt + limits.wholeMs - limits.cleanupMs;
    this.end = this.startedAt + limits.wholeMs; this.failure = null; this.abort = new AbortController();
    this.counts = Object.fromEntries(KINDS.map(key => [key, 0])); this.records = new Map(); this.slots = new Set();
    this.observed = 0; this.events = 0; this.inFlight = 0; this.launches = 0; this.bodyBytes = 0;
  }
  /** Abort all owned work on first failure, preserving that category through cleanup. */
  stop(code) { if (!this.failure) { this.failure = errorCode(new PreparationError(code)); this.abort.abort(); } }
  /** Refuse late work even if a rejected operation subsequently resolves. */
  check() {
    if (this.failure) throw new PreparationError('stopped');
    if (this.clock() >= this.deadline) { this.stop('deadline'); throw new PreparationError('deadline'); }
  }
  /** Latch failed assertions so callback callers cannot catch and then continue dispatching. */
  require(value, code) { if (!value) { this.stop(code); throw new PreparationError(code); } }
  /** Bound all relevant protocol events before storing or handling their payloads. */
  event() { this.check(); this.require(++this.events <= this.limits.events, 'observation'); }
  /** Charge parsed request body bytes separately from encrypted proxy transport accounting. */
  body(bytes) {
    this.check(); this.require(Number.isSafeInteger(bytes) && bytes >= 0
      && this.bodyBytes + bytes <= this.limits.proxyBytes, 'budget'); this.bodyBytes += bytes;
  }
  /** Reserve shared HTTP capacity at the first observed event, even if its paired Fetch event is missing. */
  observeSlot() {
    this.check(); this.require(this.inFlight < this.limits.httpConcurrent, 'budget');
    const slot = {}; this.slots.add(slot); this.inFlight++; return slot;
  }
  /** Reserve a hop and its session/application subset atomically before any dispatch. */
  reserve(kind, source = 'page', slot = null) {
    this.check(); this.observed++;
    this.require(KINDS.includes(kind) && ['page', 'requestClient', 'metadata'].includes(source), 'schema');
    this.require((kind === 'metadata') === (source === 'metadata'), 'schema');
    this.require(!slot || (source === 'page' && this.slots.has(slot)), 'observation');
    const keys = kind === 'session' ? ['application', 'session'] : [kind];
    this.require(this.records.size < this.limits.records && (slot || this.inFlight < this.limits.httpConcurrent)
      && keys.every(key => this.counts[key] < this.limits[key]), 'budget');
    const id = this.records.size + 1;
    for (const key of keys) this.counts[key]++;
    this.records.set(id, { source, acknowledged: false, confirmed: false, completed: false });
    if (slot) this.slots.delete(slot); else this.inFlight++;
    return id;
  }
  /** Record a continuation acknowledgement, which alone does not prove a response. */
  acknowledge(id) { this.check(); const item = this.records.get(id); this.require(item && !item.acknowledged, 'observation'); item.acknowledged = true; }
  /** Record a response or redirect independently of continuation acknowledgement ordering. */
  confirm(id) { this.check(); const item = this.records.get(id); this.require(item && !item.confirmed, 'observation'); item.confirmed = true; }
  /** Complete only once; failures remain reserved and uncertain rather than being refunded. */
  finish(id, succeeded = true) {
    this.check();
    const item = this.records.get(id); this.require(item && !item.completed, 'observation');
    if (!succeeded) { this.stop('operation'); return; }
    item.completed = true; this.inFlight--;
  }
  /** Count launches before creating native processes. */
  launch() { this.check(); this.require(this.launches < this.limits.launches, 'budget'); this.launches++; }
  /** Export only aggregate categories; ephemeral correlation identifiers never leave memory. */
  snapshot() {
    const records = [...this.records.values()];
    return { counts: { ...this.counts }, observed: this.observed, admitted: records.length,
      acknowledged: records.filter(item => item.acknowledged).length,
      confirmed: records.filter(item => item.confirmed).length, completed: records.filter(item => item.completed).length,
      uncertain: records.filter(item => !item.completed || !item.confirmed).length,
      page: records.filter(item => item.source === 'page').length,
      requestClient: records.filter(item => item.source === 'requestClient').length,
      unreservedObservations: this.slots.size, bodyBytes: this.bodyBytes,
      inFlight: this.inFlight, retained: records.length, events: this.events, launches: this.launches, firstFailure: this.failure };
  }
}

module.exports = { DECISION, LIMITS, COVERAGE, KINDS, CHECKS, QUALIFICATION_CHECKS,
  exact, validatePlan, validateQualification, validateReceipt, validateAttempt, ScopedBudget, ownerSchema,
  planSchema, qualificationSchema, receiptSchema, stoppedSchema, check, PreparationError, errorCode };
