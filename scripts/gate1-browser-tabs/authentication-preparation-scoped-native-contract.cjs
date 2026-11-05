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
  completedCases: integer.max(9), cleanup: z.boolean(), totals: totalsSchema, traffic: trafficSchema,
  browserTrafficMeasured: z.literal(false), hostedQualified: z.literal(false), gate1Status: z.literal('open'), backgroundHttp: z.literal('unknown') }).strict();

/** Reject normalization tricks and all non-fixture requests before any dispatch is reserved. */
function classify(raw, method) {
  let url; try { url = new URL(raw); } catch { throw new c.PreparationError('destination'); }
  c.check(method === 'GET' && !url.username && !url.password && !url.search && !url.hash
    && raw === `${url.origin}${url.pathname}` && ((url.origin === ORIGIN && ROUTES.includes(url.pathname))
      || (url.origin === FRAME_ORIGIN && ['/frame', '/favicon.ico'].includes(url.pathname))), 'destination');
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
  constructor(startedAt, expiresAt, clock = Date.now) {
    this.clock = clock; this.startedAt = startedAt; this.end = Math.min(startedAt + LIMITS.wholeMs, expiresAt);
    this.deadline = this.end - LIMITS.cleanupMs; this.failure = null; this.active = null; this.chrome = 0; this.connections = 0; this.budgets = [];
    this.cleanupFailed = false;
    this.totals = Object.fromEntries(Object.keys(totalsSchema.shape).map(key => [key, 0]));
  }
  /** Latch a global violation and abort the currently active case immediately. */
  stop(code) { if (!this.failure) this.failure = code; this.active?.stop(code); }
  /** Reject every new operation after the original work deadline or global failure. */
  check() { if (this.clock() >= this.deadline) this.stop('deadline'); c.check(!this.failure, this.failure || 'stopped'); }
  /** Reserve cumulative counters atomically; overflowing reservations are denied without refunding earlier work. */
  charge(changes) {
    this.check(); const next = { ...this.totals };
    for (const [key, amount] of Object.entries(changes)) { c.check(Number.isSafeInteger(amount) && amount >= 0 && Object.hasOwn(next, key), 'schema'); next[key] += amount; }
    if (!totalsSchema.safeParse(next).success) { this.stop('budget'); throw new c.PreparationError('budget'); }
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
    c.check(CASES.includes(item) && !root.active && root.budgets.length < 16, 'schema');
    super({ clock: root.clock, limits: { ...LIMITS, ...limits } });
    c.check(Object.entries(this.limits).every(([key, value]) => Object.hasOwn(LIMITS, key) && value <= LIMITS[key] && value >= 0), 'budget');
    this.root = root; this.item = item; root.active = this; root.budgets.push(this);
    this.startedAt = root.startedAt; this.deadline = root.deadline; this.end = root.end;
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
    if (cleanup) { c.check(this.root.totals.commands < LIMITS.commands && this.clock() < this.end, 'budget'); this.root.totals.commands++; }
    else this.root.charge({ commands: 1 });
  }
  /** Preserve global connection concurrency even when transport subcases stop independently. */
  connection() {
    this.require(this.root.connections < LIMITS.proxyConcurrent, 'budget'); this.root.charge({ proxyConnections: 1 }); this.root.connections++;
  }
  /** Release an actually closed connection only; cumulative admission is permanent. */
  connectionClosed() { this.root.connections--; }
  /** Reserve directional and combined encrypted payload at the same forwarding boundary. */
  tunnel(direction, bytes) { this.root.charge({ [`${direction}Bytes`]: bytes, tunnelBytes: bytes }); }
}

module.exports = { DIRECTORY, ORIGIN, FRAME_ORIGIN, SPKI, ID, PROFILE_NAMES, PROFILES, PORTS, ARTIFACTS, ROUTES,
  LIMITS, CASES, WITNESSES, bindingSchema, reviewSchema, ownerSchema, totalsSchema, attemptSchema, stoppedSchema,
  classify, profile, validateReview, qualificationChecks, validateAttempt, NativeLedger, NativeBudget };
