'use strict';
/* global URL */

const path = require('node:path');
const { z } = require('zod');
const c = require('./authentication-preparation-scoped-contract.cjs');
const d = require('./hosted-csrf-diagnostic.cjs');
const DIRECTORY = path.join(path.dirname(d.DIRECTORY), 'gate1-authentication-preparation-scoped-native-01');
const ORIGIN = 'https://127.0.0.1:18443';
const FRAME_ORIGIN = 'https://127.0.0.2:18444';
const SPKI = 'aiOImjtPc7gcEV9pd9ga1Uihkin8l7/rvDLRx5kZ7SA=';
const ID = '00000000-0000-4000-8000-000000000001';
const PROFILE_NAMES = Object.freeze(['lifecycle', 'restored-worker', 'request-cancel', 'manual-deadline',
  'protocol-error', 'detach', 'unsupported-worker', 'missing-pair']);
const PROFILES = Object.freeze(PROFILE_NAMES.map(name => path.join(DIRECTORY, 'profiles', name)));
const PORTS = Object.freeze([18443, 18444, 18445, 18446]);
const ARTIFACTS = Object.freeze(['execution-review.json', 'worker-started', 'attempt.json', 'native-completion.json', 'native-qualification.json']);
const ROUTES = Object.freeze(['/', '/login', '/start', '/hop', '/nav-a', '/nav-b', '/ready', '/worker-seed',
  '/worker.js', '/worker-probe', '/api/auth/session', '/api/native/writeback', '/api/native/hold', '/favicon.ico']);
const LIMITS = Object.freeze({ ...c.LIMITS, wholeMs: 480000, cleanupMs: 120000, manualMs: 15000,
  operationMs: 5000, restartMs: 5000, launches: 11, application: 128, session: 16, canonicalStatic: 32,
  providerStatic: 0, supabase: 0, google: 0, metadata: 0, proxyConnections: 256, proxyConcurrent: 8,
  proxyBytes: 65536, upstreamBytes: 4194304, downstreamBytes: 12582912, tunnelBytes: 16777216,
  httpConcurrent: 8, records: 256, events: 8192, pendingCommands: 32,
  commands: 2048, requestClient: 8, profiles: 8, concurrentChrome: 1,
  attachmentMs: 10000, manualDeadlineMs: 5000, transportMs: 2000, navigations: 16 });
const CASES = Object.freeze([
  { id: 'lifecycle', launches: 3, expected: null, mode: 'native' },
  { id: 'restored-worker', launches: 2, expected: null, mode: 'native' },
  { id: 'request-cancel', launches: 1, expected: 'cancelled', mode: 'native' },
  { id: 'manual-deadline', launches: 1, expected: 'deadline', mode: 'native' },
  { id: 'protocol-error', launches: 1, expected: 'observation', mode: 'injected_command' },
  { id: 'detach', launches: 1, expected: 'observation', mode: 'native' },
  { id: 'unsupported-worker', launches: 1, expected: 'observation', mode: 'native' },
  { id: 'missing-pair', launches: 1, expected: 'observation', mode: 'withheld_real_event' },
  { id: 'transport', launches: 0, expected: null, mode: 'native_and_controlled_callbacks' },
].map(Object.freeze));
const WITNESSES = Object.freeze({
  lifecycle: ['pageReady', 'frameReady', 'redirectHops', 'cookieBefore', 'cookieRestart', 'cookieWriteBack', 'cookieThird', 'contextLoss', 'laterPoll'],
  'restored-worker': ['seeded', 'workerAttempt', 'proxyDenied', 'originProbeZero'],
  'request-cancel': ['held', 'disposed', 'socketClosed', 'uncertain'],
  'manual-deadline': ['replacements', 'expired', 'noLatePass'],
  'protocol-error': ['nativeError', 'stoppedDispatch'], detach: ['nativeDetach', 'stoppedDispatch'],
  'unsupported-worker': ['workerObserved', 'originProbeZero', 'stoppedDispatch'],
  'missing-pair': ['realEventWithheld', 'networkSlot', 'uncertain', 'stoppedDispatch'],
  transport: ['headBeforeConnect', 'upstreamOverflow', 'downstreamOverflow', 'combinedOverflow', 'socketBackpressure',
    'idleClosure', 'preConnectTimeout', 'pendingClosed', 'lateCallbackBlocked'],
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
const destinationReasonSchema = z.enum(['proxy_http_request', 'proxy_parser_error', 'proxy_owner_missing',
  'proxy_owner_reused', 'proxy_method', 'proxy_authority', 'fixture_closing', 'fixture_host',
  'fixture_transfer_encoding', 'fixture_content_length', 'fixture_body', 'route_url', 'route_method',
  'route_credentials', 'route_query_fragment', 'route_normalization', 'route_origin_path',
  'request_client_owner', 'request_client_route']);
const bindingSchema = z.object({ sourceSet: hash, decisionHash: hash, toolSet: hash, certificateHash: hash, keyHash: hash }).strict();
const reviewSchema = bindingSchema.extend({ scope: z.literal('scoped-authentication-native-execution-review-v1'),
  operator: z.literal('Codex'), owner: z.literal('project-owner'), directory: z.literal(DIRECTORY),
  command: z.literal('node scripts/gate1-browser-tabs/authentication-preparation-scoped-native.cjs --execute-native <execution-review-sha256>'),
  cases: z.tuple(CASES.map(item => c.exact(item))), limits: c.exact(LIMITS), spki: z.literal(SPKI),
  profiles: z.tuple(PROFILES.map(value => z.literal(value))), ports: z.tuple(PORTS.map(value => z.literal(value))),
  approvedAt: integer, expiresAt: integer }).strict();
const ownerSchema = z.object({ profile: z.enum(PROFILES), pid: integer.positive(), port: integer.min(1).max(65535),
  closedNormally: z.literal(true), exitCode: z.literal(0) }).strict();
const totalsSchema = z.object({ application: integer.max(128), session: integer.max(16), canonicalStatic: integer.max(32),
  providerStatic: z.literal(0), supabase: z.literal(0), google: z.literal(0), metadata: z.literal(0),
  requestClient: integer.max(8), records: integer.max(256), events: integer.max(8192), commands: integer.max(2048),
  launches: integer.max(11), proxyConnections: integer.max(256), upstreamBytes: integer.max(4194304),
  downstreamBytes: integer.max(12582912), tunnelBytes: integer.max(16777216), proxyBytes: integer.max(65536),
  fixtureRequests: integer.max(160), fixtureSession: integer.max(16), fixtureProbe: integer.max(160) }).strict();
const trafficSchema = z.object(Object.fromEntries(['observed', 'admitted', 'acknowledged', 'confirmed', 'completed',
  'uncertain', 'unreservedObservations', 'page', 'requestClient'].map(key => [key, integer.max(256)]))).strict();
const caseSchemas = CASES.map(item => z.object({ id: z.literal(item.id), mode: z.literal(item.mode),
  outcome: z.literal('passed'), failure: z.literal(item.expected), launches: z.literal(item.launches),
  witnesses: c.exact(Object.fromEntries(WITNESSES[item.id].map(key => [key, true]))),
  cleanup: z.literal(true) }).strict());
const attemptSchema = bindingSchema.extend({ schemaVersion: z.literal(1), scope: z.literal('scoped_authentication_native_attempt'),
  reviewHash: hash, startedAt: integer, completedAt: integer, phase: z.literal('passed'),
  cases: z.tuple(caseSchemas), owners: z.array(ownerSchema).length(11), totals: totalsSchema, traffic: trafficSchema,
  checks: c.exact(Object.fromEntries(c.QUALIFICATION_CHECKS.map(key => [key, true]))),
  browserTrafficMeasured: z.literal(false), hostedQualified: z.literal(false), gate1Status: z.literal('open'), backgroundHttp: z.literal('unknown') }).strict();
const stoppedSchema = bindingSchema.extend({ schemaVersion: z.literal(1), scope: z.literal('scoped_authentication_native_attempt'),
  reviewHash: hash, startedAt: integer, completedAt: integer, phase: z.enum(['stopped', 'inconclusive']),
  firstFailure: z.enum(['approval', 'expired', 'integrity', 'budget', 'deadline', 'observation', 'operation', 'cancelled',
    'closure', 'process_inspection', 'process_present', 'port_open', 'receipt', 'already_used', 'toolchain', 'profile',
    'fixture', 'worker_completion', 'coverage_unqualified', 'destination', 'schema', 'identity', 'stopped', 'arguments', 'target', 'debug_logging']),
  destinationReason: destinationReasonSchema.nullable().optional(),
  completedCases: integer.max(9), cleanup: z.boolean(), totals: totalsSchema, traffic: trafficSchema,
  browserTrafficMeasured: z.literal(false), hostedQualified: z.literal(false), gate1Status: z.literal('open'), backgroundHttp: z.literal('unknown') }).strict();

const STARTUP_DIRECTORY = path.join(path.dirname(d.DIRECTORY), 'gate1-authentication-preparation-scoped-startup-01');
const STARTUP_PROFILE = path.join(STARTUP_DIRECTORY, 'profiles', 'startup');
const STARTUP_ARTIFACTS = Object.freeze(['execution-review.json', 'worker-started', 'attempt.json', 'postflight.json']);
const STARTUP_COMMAND = 'node scripts/gate1-browser-tabs/authentication-preparation-scoped-startup.cjs --execute-startup <execution-review-sha256>';
const STARTUP_CASE = Object.freeze({ id: 'startup', launches: 1 });
const STARTUP_LIMITS = Object.freeze({ ...LIMITS, wholeMs: 180000, cleanupMs: 120000, observationMs: 15000,
  manualMs: 0, metadataMs: 0, launches: 1, profiles: 1, pages: 2, targetSessions: 2,
  application: 0, session: 0, canonicalStatic: 0, requestClient: 0, navigations: 0,
  proxyConnections: 16, proxyConcurrent: 4, proxyBytes: 0, upstreamBytes: 0, downstreamBytes: 0, tunnelBytes: 0,
  records: 8, events: 128, pendingCommands: 8, commands: 64, cleanupCommands: 4,
  controllerConnections: 2, listenerProbes: 9 });
const startupTotalsSchema = z.object({
  ...Object.fromEntries(Object.keys(totalsSchema.shape).map(key => [key, integer.max(STARTUP_LIMITS[key] || 0)])),
  controllerConnections: integer.max(2), listenerProbes: integer.max(4), cleanupCommands: integer.max(4),
}).strict();
const startupStageSchema = z.enum(['reservation', 'preflight', 'proxy', 'launch', 'observe', 'window', 'closure', 'evidence']);
const startupOutcomeSchema = z.enum(['rejection', 'no_rejection_observed', 'incomplete']);
const startupReviewSchema = bindingSchema.extend({ scope: z.literal('scoped-authentication-startup-review-v1'),
  operator: z.literal('Codex'), owner: z.literal('project-owner'), directory: z.literal(STARTUP_DIRECTORY),
  command: z.literal(STARTUP_COMMAND), profile: z.literal(STARTUP_PROFILE), limits: c.exact(STARTUP_LIMITS),
  artifacts: z.tuple(STARTUP_ARTIFACTS.map(value => z.literal(value))), spki: z.literal(SPKI),
  ports: z.tuple(PORTS.map(value => z.literal(value))), forwarding: z.literal('closed'),
  approvedAt: integer, expiresAt: integer }).strict();
const startupOwnerSchema = z.object({ profile: z.literal(STARTUP_PROFILE), pid: integer.positive().nullable(),
  port: integer.min(1).max(65535).nullable(), closedNormally: z.boolean(), exitCode: integer.nullable() }).strict();
const startupTrafficSchema = z.object(Object.fromEntries(Object.keys(trafficSchema.shape).map(key =>
  [key, ['observed', 'unreservedObservations'].includes(key) ? integer.max(8) : z.literal(0)]))).strict();
const startupDirectionSchema = z.object({ read: integer, rejected: integer, admitted: z.literal(0), written: z.literal(0) }).strict();
const startupProxySchema = z.object({ connections: integer.max(16), concurrent: integer.max(4), overLimit: integer,
  denied: integer, tunnels: z.literal(0), upstream: startupDirectionSchema, downstream: startupDirectionSchema,
  forwardingClosed: z.literal(true) }).strict();
const startupCoverage = { browserTrafficMeasured: z.literal(false), hostedQualified: z.literal(false),
  gate1Status: z.literal('open'), backgroundHttp: z.literal('unknown') };
const startupAttemptSchema = bindingSchema.extend({ schemaVersion: z.literal(1), scope: z.literal('scoped_authentication_startup_attempt'),
  reviewHash: hash, startedAt: integer, completedAt: integer, launchAt: integer.nullable(), observationEndedAt: integer.nullable(),
  readyAt: integer.nullable(), pagesReady: integer.max(2), outcome: startupOutcomeSchema,
  firstFailure: stoppedSchema.shape.firstFailure.nullable(), destinationReason: destinationReasonSchema.nullable(),
  failureStage: startupStageSchema.nullable(), cleanup: z.boolean(), owner: startupOwnerSchema.nullable(),
  totals: startupTotalsSchema, traffic: startupTrafficSchema, proxy: startupProxySchema.nullable(), ...startupCoverage }).strict();
const startupWorkerSchema = z.object({ scope: z.literal('scoped_authentication_startup_worker'), attemptHash: hash }).strict();
const startupPostflightSchema = bindingSchema.extend({ schemaVersion: z.literal(1), scope: z.literal('scoped_authentication_startup_postflight'),
  reviewHash: hash, attemptHash: hash, startedAt: integer, completedAt: integer, outcome: startupOutcomeSchema,
  firstFailure: stoppedSchema.shape.firstFailure.nullable(), destinationReason: destinationReasonSchema.nullable(),
  failureStage: startupStageSchema.nullable(), postflightFailure: stoppedSchema.shape.firstFailure.nullable(),
  finalization: z.literal('requires_timely_supervisor_result'),
  checks: z.object(Object.fromEntries(['workerExited', 'bindings', 'normalClosure', 'processAbsent', 'listenersClosed',
    'profilePreserved'].map(key => [key, z.boolean()]))).strict(), listenerProbes: integer.max(5), ...startupCoverage }).strict();

/** Bind the single startup observation to its exact smaller envelope and a real expiring owner review. */
function validateStartupReview(review, now = Date.now(), starting = false) {
  c.check(startupReviewSchema.safeParse(review).success, 'approval');
  c.check(review.approvedAt > 0 && review.approvedAt <= now && now < review.expiresAt
    && review.expiresAt - review.approvedAt <= 3600000
    && (!starting || review.expiresAt - now >= STARTUP_LIMITS.wholeMs), 'expired'); return review;
}

/** Reject contradictory or private startup evidence; a diagnostic result never satisfies native qualification. */
function validateStartupAttempt(record) {
  c.check(startupAttemptSchema.safeParse(record).success, 'receipt');
  c.check(record.completedAt >= record.startedAt && record.completedAt - record.startedAt < STARTUP_LIMITS.wholeMs
    && (record.firstFailure === null) === (record.failureStage === null)
    && (record.destinationReason === null || record.firstFailure === 'destination'), 'receipt');
  const { launchAt, readyAt, observationEndedAt, owner, proxy } = record;
  c.check((launchAt === null || (launchAt >= record.startedAt && launchAt <= record.completedAt && owner && owner.pid !== null))
    && (readyAt === null || (launchAt !== null && readyAt >= launchAt && readyAt < launchAt + STARTUP_LIMITS.observationMs))
    && (observationEndedAt === null || (launchAt !== null && observationEndedAt >= launchAt && observationEndedAt <= record.completedAt)), 'receipt');
  c.check(record.traffic.observed <= record.totals.records && record.traffic.unreservedObservations <= record.totals.records
    && (readyAt === null || record.pagesReady === 2)
    && record.totals.cleanupCommands <= record.totals.commands
    && record.totals.commands - record.totals.cleanupCommands <= 60, 'receipt');
  if (owner?.closedNormally) c.check(owner.pid !== null && owner.port !== null && owner.exitCode === 0, 'closure');
  if (proxy) c.check(proxy.connections === record.totals.proxyConnections
    && proxy.upstream.read === proxy.upstream.rejected && proxy.downstream.read === proxy.downstream.rejected, 'receipt');
  if (record.cleanup) c.check((!owner || owner.closedNormally) && (!proxy || proxy.concurrent === 0), 'closure');
  if (record.outcome === 'rejection') c.check(record.firstFailure === 'destination' && record.destinationReason !== null
    && ['proxy', 'launch', 'observe', 'window'].includes(record.failureStage), 'receipt');
  if (record.outcome === 'no_rejection_observed') c.check(record.firstFailure === null && record.cleanup && owner?.closedNormally
    && record.totals.launches === 1 && record.totals.controllerConnections >= 1 && record.totals.listenerProbes === 4
    && record.pagesReady === 2 && readyAt !== null && launchAt !== null && observationEndedAt !== null
    && record.totals.records === 0 && record.traffic.unreservedObservations === 0
    && observationEndedAt >= launchAt + STARTUP_LIMITS.observationMs && proxy !== null, 'receipt');
  return record;
}

/** Completed postflight requires every independent check; incomplete results retain the original observation separately. */
function validateStartupPostflight(record) {
  c.check(startupPostflightSchema.safeParse(record).success && record.completedAt >= record.startedAt
    && record.completedAt - record.startedAt < STARTUP_LIMITS.wholeMs
    && (record.firstFailure === null) === (record.failureStage === null)
    && (record.destinationReason === null || record.firstFailure === 'destination'), 'receipt');
  if (record.outcome !== 'incomplete') c.check(Object.values(record.checks).every(Boolean)
    && record.listenerProbes === 5 && record.postflightFailure === null, 'receipt');
  if (record.outcome === 'rejection') c.check(record.firstFailure === 'destination' && record.destinationReason !== null, 'receipt');
  if (record.outcome === 'no_rejection_observed') c.check(record.firstFailure === null, 'receipt');
  return record;
}

/** Stop an optional native owner before throwing; only fixed reasons can enter retained attribution. */
function requireDestination(value, reason, owner = null) {
  if (value) return;
  c.check(destinationReasonSchema.safeParse(reason).success
    && (owner === null || owner instanceof NativeLedger || owner instanceof NativeBudget), 'schema');
  owner?.destination(reason); throw new c.PreparationError('destination');
}

/** Reject the unchanged fixture policy; an optional native owner latches the exact guard before callback sanitization. */
function classify(raw, method, owner = null) {
  let url; try { url = new URL(raw); } catch { requireDestination(false, 'route_url', owner); }
  requireDestination(method === 'GET', 'route_method', owner);
  requireDestination(!url.username && !url.password, 'route_credentials', owner);
  requireDestination(!url.search && !url.hash, 'route_query_fragment', owner);
  requireDestination(raw === `${url.origin}${url.pathname}`, 'route_normalization', owner);
  requireDestination((url.origin === ORIGIN && ROUTES.includes(url.pathname))
    || (url.origin === FRAME_ORIGIN && ['/frame', '/favicon.ico'].includes(url.pathname)), 'route_origin_path', owner);
  return url.pathname === '/api/auth/session' ? 'session' : ['/worker.js', '/favicon.ico'].includes(url.pathname) ? 'canonicalStatic' : 'application';
}

/** Require exact native paths; this never accepts the live profile or arbitrary synthetic roots. */
function profile(name) { c.check(PROFILE_NAMES.includes(name), 'profile'); return PROFILES[PROFILE_NAMES.indexOf(name)]; }
/** Bind every scalar, case and byte digest to a short-lived explicit owner review. */
function validateReview(review, now = Date.now()) {
  c.check(reviewSchema.safeParse(review).success, 'approval');
  c.check(review.approvedAt <= now && now < review.expiresAt && review.expiresAt - review.approvedAt <= 3600000, 'expired'); return review;
}
/** Derive qualification only from the complete predetermined witness matrix and cleanup. */
function qualificationChecks(results) {
  c.check(z.tuple(caseSchemas).safeParse(results).success, 'coverage_unqualified');
  return Object.fromEntries(c.QUALIFICATION_CHECKS.map(key => [key, true]));
}
/** Independently validate successful evidence, provenance and the exact profile launch sequence. */
function validateAttempt(record) {
  const passed = record?.phase === 'passed';
  c.check((passed ? attemptSchema : stoppedSchema).safeParse(record).success, 'receipt');
  if (!passed && record.destinationReason != null) c.check(record.firstFailure === 'destination', 'receipt');
  c.check(record.completedAt >= record.startedAt && record.completedAt - record.startedAt < LIMITS.wholeMs
    && record.totals.session <= record.totals.application
    && record.totals.tunnelBytes === record.totals.upstreamBytes + record.totals.downstreamBytes, 'receipt');
  const traffic = record.traffic;
  c.check(traffic.completed <= traffic.admitted && traffic.confirmed <= traffic.admitted
    && traffic.acknowledged <= traffic.admitted && traffic.uncertain <= traffic.admitted
    && traffic.admitted === traffic.page + traffic.requestClient
    && traffic.admitted + traffic.unreservedObservations <= record.totals.records, 'receipt');
  if (passed) {
    qualificationChecks(record.cases);
    const sequence = CASES.flatMap(item => Array.from({ length: item.launches }, () => profile(item.id)));
    c.check(record.totals.launches === 11 && record.owners.every((owner, index) => owner.profile === sequence[index]), 'closure');
    c.check(new Set(record.owners.map(owner => owner.pid)).size === 11, 'closure');
  }
  return record;
}

/** Keep one cumulative envelope across permanently stopped case budgets; no expected failure resets it. */
class NativeLedger {
  /** Start the original supervisor clock, leaving the final 120 seconds for cleanup and postflight. */
  constructor(startedAt, expiresAt, clock = Date.now, mode = 'qualification') {
    c.check(['qualification', 'startup'].includes(mode), 'schema'); this.mode = mode;
    this.limits = mode === 'startup' ? STARTUP_LIMITS : LIMITS;
    this.totalsSchema = mode === 'startup' ? startupTotalsSchema : totalsSchema;
    this.stage = 'reservation'; this.failureStage = null;
    this.clock = clock; this.startedAt = startedAt; this.end = Math.min(startedAt + this.limits.wholeMs, expiresAt);
    this.deadline = this.end - this.limits.cleanupMs; this.failure = null; this.active = null; this.chrome = 0; this.connections = 0; this.budgets = [];
    this.cleanupFailed = false; this.destinationReason = null;
    this.totals = Object.fromEntries(Object.keys(this.totalsSchema.shape).map(key => [key, 0]));
  }
  /** Promote an active case's original cause through generic stops before cleanup retires its attribution. */
  stop(code) {
    const failure = code === 'stopped' ? this.active?.failure || code : code;
    if (!this.failure || (this.failure === 'stopped' && code === 'stopped')) {
      this.failure = failure;
      this.failureStage ||= this.stage;
      this.destinationReason = failure === 'destination'
        ? this.destinationReason || (this.active?.failure === 'destination' ? this.active.destinationReason : null) : null;
    }
    this.active?.stop(failure);
  }
  /** Attribute a root guard before abort callbacks; an earlier root or case failure keeps its original meaning. */
  destination(reason) {
    c.check(destinationReasonSchema.safeParse(reason).success, 'schema');
    if (!this.failure && !this.active?.failure) this.destinationReason = reason;
    this.stop('destination');
  }
  /** Reject every new operation after the original work deadline or global failure. */
  check() { if (this.clock() >= this.deadline) this.stop('deadline'); c.check(!this.failure, this.failure || 'stopped'); }
  /** Reserve cumulative counters atomically; overflowing reservations are denied without refunding earlier work. */
  charge(changes) {
    this.check(); const next = { ...this.totals };
    for (const [key, amount] of Object.entries(changes)) { c.check(Number.isSafeInteger(amount) && amount >= 0 && Object.hasOwn(next, key), 'schema'); next[key] += amount; }
    if (!this.totalsSchema.safeParse(next).success) { this.stop('budget'); throw new c.PreparationError('budget'); }
    this.totals = next;
  }
  /** Release only concurrency after verified cleanup, never cumulative charges or failed HTTP uncertainty. */
  finishCase(budget) { c.check(this.active === budget && this.chrome === 0 && this.connections === 0, 'closure'); this.active = null; }
  /** Aggregate reservations and uncertainty independently from actual fixture observations, including stopped cases. */
  traffic() {
    const result = Object.fromEntries(Object.keys(trafficSchema.shape).map(key => [key, 0]));
    for (const budget of this.budgets) { const snapshot = budget.snapshot(); for (const key of Object.keys(result)) result[key] += snapshot[key]; }
    return result;
  }
}

/** Reuse live request accounting with a distinct per-case abort state and the shared native envelope. */
class NativeBudget extends c.ScopedBudget {
  /** Accept only a frozen case and smaller declared transport/manual limits. */
  constructor(root, item, limits = {}) {
    c.check(root instanceof NativeLedger && (root.mode === 'startup' ? item === STARTUP_CASE : CASES.includes(item))
      && !root.active && root.budgets.length < (root.mode === 'startup' ? 1 : 16), 'schema');
    super({ clock: root.clock, limits: { ...root.limits, ...limits } });
    c.check(Object.entries(this.limits).every(([key, value]) => Object.hasOwn(root.limits, key) && value <= root.limits[key] && value >= 0), 'budget');
    this.root = root; this.item = item; root.active = this; root.budgets.push(this);
    this.destinationReason = null;
    this.startedAt = root.startedAt; this.deadline = root.deadline; this.end = root.end;
    // The sole startup case propagates immediately so failure stage/reason precede cleanup callbacks.
    if (root.mode === 'startup') this.abort.signal.addEventListener('abort', () => root.stop(this.failure), { once: true });
  }
  /** Latch this active case's first guard before synchronous abort handlers; retired budgets cannot supply attribution. */
  destination(reason) {
    c.check(destinationReasonSchema.safeParse(reason).success, 'schema');
    if (!this.failure && !this.root.failure && this.root.active === this) this.destinationReason = reason;
    this.stop('destination');
  }
  /** Every active callback shares the overall deadline, including callbacks after expected local failures. */
  check() { this.root.check(); super.check(); }
  /** Keep event storage bounded across all browser launches and cases. */
  event() { this.root.charge({ events: 1 }); super.event(); }
  /** Charge parsed bodies separately from encrypted tunnel bytes. */
  body(bytes) { this.root.charge({ proxyBytes: bytes }); super.body(bytes); }
  /** Charge retained storage at the first real event, including a permanently unpaired Network slot. */
  observeSlot() { this.root.charge({ records: 1 }); return super.observeSlot(); }
  /** Count each explicit or page reservation once, with the session subset included atomically. */
  reserve(kind, source = 'page', slot = null) {
    this.check(); const changes = { [kind]: 1, ...(!slot ? { records: 1 } : {}) };
    if (kind === 'session') changes.application = 1;
    if (source === 'requestClient') changes.requestClient = 1;
    this.root.charge(changes); return super.reserve(kind, source, slot);
  }
  /** Refuse a second concurrent Chrome and excess case launches before spawning. */
  launch() {
    this.check(); this.require(this.root.chrome === 0 && this.launches < this.item.launches, 'budget');
    this.root.charge({ launches: 1 }); this.root.chrome++; super.launch();
  }
  /** Count raw CDP commands before their transport sends; cleanup commands retain the same ceiling. */
  command(cleanup = false) {
    if (cleanup) {
      c.check(this.root.totals.commands < this.root.limits.commands && this.clock() < this.end, 'budget');
      if (this.root.mode === 'startup') {
        c.check(this.root.totals.cleanupCommands < this.root.limits.cleanupCommands, 'budget'); this.root.totals.cleanupCommands++;
      }
      this.root.totals.commands++;
    }
    else {
      if (this.root.mode === 'startup') this.require(this.root.totals.commands < this.root.limits.commands - this.root.limits.cleanupCommands, 'budget');
      this.root.charge({ commands: 1 });
    }
  }
  /** Charge a startup controller before opening its socket, including the one permitted normal-close recovery. */
  controller(cleanup = false) {
    c.check(this.root.mode === 'startup' && this.clock() < this.end, 'approval');
    c.check(this.root.totals.controllerConnections < this.root.limits.controllerConnections, 'budget');
    if (!cleanup) this.root.check(); this.root.totals.controllerConnections++;
  }
  /** Preserve global connection concurrency even when transport subcases stop independently. */
  connection() {
    this.require(this.root.connections < this.root.limits.proxyConcurrent, 'budget'); this.root.charge({ proxyConnections: 1 }); this.root.connections++;
  }
  /** Release an actually closed connection only; cumulative admission is permanent. */
  connectionClosed() { this.root.connections--; }
  /** Reserve directional and combined encrypted payload at the same forwarding boundary. */
  tunnel(direction, bytes) { this.root.charge({ [`${direction}Bytes`]: bytes, tunnelBytes: bytes }); }
}

module.exports = { DIRECTORY, ORIGIN, FRAME_ORIGIN, SPKI, ID, PROFILE_NAMES, PROFILES, PORTS, ARTIFACTS, ROUTES,
  LIMITS, CASES, WITNESSES, bindingSchema, reviewSchema, ownerSchema, totalsSchema, attemptSchema, stoppedSchema,
  destinationReasonSchema, requireDestination, classify, profile, validateReview, qualificationChecks, validateAttempt, NativeLedger, NativeBudget };
Object.assign(module.exports, { STARTUP_DIRECTORY, STARTUP_PROFILE, STARTUP_ARTIFACTS, STARTUP_COMMAND, STARTUP_CASE, STARTUP_LIMITS,
  startupReviewSchema, startupOwnerSchema, startupTotalsSchema, startupAttemptSchema, startupWorkerSchema, startupPostflightSchema,
  validateStartupReview, validateStartupAttempt, validateStartupPostflight });
