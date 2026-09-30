'use strict';

/**
 * Offline-default, separately approved Preview failure or Production success canary.
 * Four sequential HTTPS attempts maximum; no provider API, redirects, retries,
 * cookies, configuration mutation or secret reset. Credentials enter via stdin.
 * Reuses only the existing login HTML build parser; no inventory batch is run.
 */
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { z } = require('zod');
const { loginBuild } = require('./gate1-host-protection');

const LIMITS = Object.freeze({ maxAppRequests: 4, maxProviderRequests: 0,
  maxConfigMutations: 0, concurrency: 1, requestMs: 10000, overallMs: 60000,
  buildBytes: 1048576, sessionBytes: 8192, probeBytes: 1536, headerBytes: 16384,
  inputBytes: 16384, reportBytes: 16384, profileAgeMs: 900000 });
const CASE = 'both_application_secrets_missing';
const SUCCESS_CASE = 'production_secret_success_cache';
const PROJECT = 'prj_b2nMrysMSJtpmqoeGx5g0WGgGuom';
const TEAM = 'team_7o3efmwjZbMc2Bfy9qAzkc9q';
const ATTESTATIONS = ['sourceCodeReviewed', 'deploymentSnapshotReviewed', 'previewOverridesReviewed',
  'bothApplicationSecretsAbsent', 'productionCredentialsExcluded', 'explicitVercelModes',
  'probeConfigured', 'protectionAccessApproved', 'credentialLoggingReviewed',
  'noConcurrentDeploymentsOrConfigurationChanges', 'freshLoaderTrialReviewed'];
const SUCCESS_ATTESTATIONS = ['sourceCodeReviewed', 'deploymentSnapshotReviewed', 'actualProductionEnvironmentReviewed',
  'bothApplicationSecretsConfigured', 'applicationSecretsUnchanged', 'explicitVercelModes',
  'probeConfigured', 'productionProbeOptInReviewed', 'protectionAccessApproved', 'credentialLoggingReviewed',
  'noConcurrentDeploymentsOrConfigurationChanges', 'warmLoaderReuseScopeReviewed'];
const profileFields = { schemaVersion: z.literal(1),
  projectId: z.literal(PROJECT), teamId: z.literal(TEAM),
  hostname: z.string().max(253).regex(/^job-application-tracker-[a-z0-9]{1,63}-track-the-app\.vercel\.app$/),
  deploymentId: z.string().max(80).regex(/^dpl_[A-Za-z0-9]+$/),
  gitSha: z.string().regex(/^[a-f0-9]{40}$/), nextBuildId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  accessMode: z.literal('automation_bypass'), reviewedAt: z.string().datetime() };
const profileSchema = z.discriminatedUnion('caseId', [
  z.object({ ...profileFields, caseId: z.literal(CASE), environment: z.literal('preview'),
    attestations: z.object(Object.fromEntries(ATTESTATIONS.map((name) => [name, z.literal(true)]))).strict() }).strict(),
  z.object({ ...profileFields, caseId: z.literal(SUCCESS_CASE), environment: z.literal('production'),
    attestations: z.object(Object.fromEntries(SUCCESS_ATTESTATIONS.map((name) => [name, z.literal(true)]))).strict() }).strict(),
]);
const credentialsSchema = z.object({ probeSecret: z.string().regex(/^[a-f0-9]{64}$/),
  bypassSecret: z.string().min(16).max(512).regex(/^[\x21-\x7e]+$/) }).strict();
const CODES = new Set(['arguments', 'input', 'profile', 'approval', 'credentials', 'reservation',
  'local_evidence', 'cancelled', 'deadline', 'request_budget', 'transport', 'response_headers',
  'response_size', 'response_encoding', 'response_incomplete', 'redirect', 'cookie_contract',
  'build_mismatch', 'session_status', 'body_contract', 'cache_contract', 'probe_contract',
  'environment_mismatch', 'source_rejected', 'secret_contract', 'loader_already_initialized', 'loader_changed', 'internal']);
const SELECTED = new Set(['content-type', 'content-length', 'content-encoding', 'set-cookie',
  'cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control', 'x-vercel-cache',
  'retry-after', 'x-gate1-secrets-probe']);
const BOUND_FILES = ['scripts/gate1-secrets-canary.js', 'scripts/run-gate1-secrets-canary.ps1',
  'scripts/gate1-host-protection.js', 'src/server/lib/gate1SecretsProbe.js',
  'src/server/lib/temporarySessionSecrets.js', 'src/server/lib/temporarySessionCeiling.js',
  'src/server/lib/temporarySessionSource.js', 'src/pages/api/auth/session.js',
  'src/server/middleware/withRateLimit.js', 'src/shared/response.js', 'src/shared/errors.js'];

/** Carries an allowlisted reason only; raw errors and input are never retained. */
class CanaryError extends Error {
  /** Normalize an internal code before it crosses any output boundary. */
  constructor(code) { super(CODES.has(code) ? code : 'internal'); this.code = this.message; }
}

/** Validates/detaches a credential-free immutable target; templates cannot dispatch. */
function parseProfile(value) {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new CanaryError('profile');
  return parsed.data;
}

/** Produces an unusable local template with no inferred deployment or approvals. */
function profileTemplate(caseId = CASE) {
  if (![CASE, SUCCESS_CASE].includes(caseId)) throw new CanaryError('profile');
  const success = caseId === SUCCESS_CASE;
  return { schemaVersion: 1, caseId, projectId: PROJECT, teamId: TEAM,
    environment: success ? 'production' : 'preview', hostname: '', deploymentId: '', gitSha: '', nextBuildId: '',
    accessMode: 'automation_bypass', reviewedAt: '',
    attestations: Object.fromEntries((success ? SUCCESS_ATTESTATIONS : ATTESTATIONS).map((name) => [name, false])) };
}

/** Maps a validated case to its evidence scope; no other qualification is implied. */
function evidenceScope(caseId) {
  return caseId === SUCCESS_CASE ? 'production_secret_success_cache_only' : 'preview_missing_secrets_only';
}

/** Binds target, limits and source bytes to review only from a clean, matching checkout. */
function approvalId(profile) {
  const parsed = parseProfile(profile);
  const root = path.resolve(__dirname, '..');
  /** Reads bounded Git state from the source checkout, independent of the caller's cwd. */
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 3000,
    maxBuffer: 65536, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    if (git(['rev-parse', 'HEAD']) !== parsed.gitSha) throw new CanaryError('profile');
    if (git(['status', '--porcelain', '--', ...BOUND_FILES]) !== '') throw new CanaryError('profile');
  } catch { throw new CanaryError('profile'); }
  const hash = createHash('sha256').update(JSON.stringify({ profile: parsed, limits: LIMITS }));
  for (const name of BOUND_FILES) hash.update(name).update(fs.readFileSync(path.resolve(root, name)));
  return hash.digest('hex');
}

/** Returns a zero-traffic proposal; neither review nor a digest is live approval. */
function preparation(value = null) {
  const profile = value === null ? null : parseProfile(value);
  const success = profile?.caseId === SUCCESS_CASE;
  return { schemaVersion: 1, mode: 'prepare', scope: evidenceScope(profile?.caseId),
    liveApproved: false, gate1Status: 'open', appRequests: 0, providerRequests: 0,
    profile, approvalId: profile ? approvalId(profile) : null, limits: LIMITS,
    sequence: ['buildBefore', 'probe1', 'probe2', 'buildAfter'],
    nextStep: profile ? 'obtain_separate_live_approval' : 'complete_local_profile',
    limitations: ['operator_attested_snapshot_with_runtime_environment_check', 'loader_identity_only',
      ...(success ? ['warm_first_loader_does_not_prove_initialization', 'no_missing_malformed_or_environment_isolation_evidence']
        : ['hmac_rejection_precedes_redis_validation', 'no_hosted_success_or_malformed_cases']),
      'no_independent_waf_evidence'] };
}

/** Projects bounded singleton response headers; all other response fields are discarded. */
function selectedHeaders(raw) {
  if (!Array.isArray(raw) || raw.length % 2 || raw.length > 256) throw new CanaryError('response_headers');
  const headers = Object.create(null);
  let bytes = 0;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i], value = raw[i + 1];
    if (typeof name !== 'string' || typeof value !== 'string') throw new CanaryError('response_headers');
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > LIMITS.headerBytes) throw new CanaryError('response_headers');
    const key = name.toLowerCase();
    if (!SELECTED.has(key)) continue;
    if (Object.hasOwn(headers, key)) throw new CanaryError('response_headers');
    headers[key] = value;
  }
  return headers;
}

/**
 * Executes one internally constructed GET; native HTTPS cannot redirect/retry.
 * Request/body timeout includes DNS and streams. Test requestImpl is a fixture
 * seam; onDispatch counts once immediately before transport creation. Errors
 * destroy owned streams and discard raw messages, credential headers and bytes.
 */
function exchange(spec, { requestImpl = https.request, signal, timeoutMs, onDispatch }) {
  return new Promise((resolve, reject) => {
    let request, response, timer, settled = false;
    const chunks = [];
    /** Settles once and cleans listeners/buffers; destroys streams on rejection. */
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      chunks.length = 0;
      if (error) { request?.destroy(); response?.destroy(); reject(error); }
      else resolve(value);
    }
    /** Drops cancellation reasons, which may contain caller secrets. */
    function abort() { finish(new CanaryError('cancelled')); }
    /** Converts native exceptions to one fixed code without retaining messages. */
    function transportError() { finish(new CanaryError('transport')); }
    /** Marks early stream closure or length disagreement as incomplete evidence. */
    function incomplete() { finish(new CanaryError('response_incomplete')); }
    /** Reviews headers before reading a bounded transient body from incoming. */
    function receive(incoming) {
      response = incoming;
      response.on('error', transportError);
      if (settled) { response.destroy(); return; }
      response.on('aborted', incomplete);
      let headers, size = 0;
      try {
        headers = selectedHeaders(response.rawHeaders);
        if (!Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) throw new CanaryError('response_headers');
        if (response.statusCode >= 300 && response.statusCode < 400) throw new CanaryError('redirect');
        if (headers['set-cookie'] !== undefined) throw new CanaryError('cookie_contract');
        if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') throw new CanaryError('response_encoding');
        const length = headers['content-length'];
        if (length !== undefined && (!/^\d{1,12}$/.test(length) || Number(length) > spec.bytes)) throw new CanaryError('response_size');
      } catch (error) { finish(error instanceof CanaryError ? error : new CanaryError('response_headers')); return; }
      /** Bounds actual bytes before accumulating a chunk; never persists raw bodies. */
      function data(chunk) {
        if (settled) return;
        if (!Buffer.isBuffer(chunk)) { incomplete(); return; }
        size += chunk.length;
        if (size > spec.bytes) { finish(new CanaryError('response_size')); return; }
        chunks.push(chunk);
      }
      /** Requires full completion and declared-length agreement before review. */
      function end() {
        if (settled) return;
        if (!response.complete || (headers['content-length'] !== undefined && Number(headers['content-length']) !== size)) { incomplete(); return; }
        finish(null, { status: response.statusCode, headers, text: Buffer.concat(chunks).toString('utf8') });
      }
      /** Fails a socket close that arrives without a completed end event. */
      function close() { if (!settled) incomplete(); }
      response.on('data', data); response.on('end', end); response.on('close', close);
    }
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new CanaryError('deadline')), timeoutMs);
    try {
      onDispatch();
      request = requestImpl({ protocol: 'https:', hostname: spec.hostname, port: 443,
        path: spec.path, method: 'GET', agent: false, rejectUnauthorized: true,
        maxHeaderSize: LIMITS.headerBytes, headers: spec.headers }, receive);
      request.on('error', transportError);
      if (settled) request.destroy(); else request.end();
    } catch (error) { finish(error instanceof CanaryError ? error : new CanaryError('transport')); }
  });
}

/** Requires private/no-store and rejects CDN overrides, retry metadata and cache hits. */
function reviewCache(headers) {
  const directives = (headers['cache-control'] || '').toLowerCase().split(',').map((part) => part.trim());
  if (!directives.includes('private') || !directives.includes('no-store')
    || directives.some((part) => !['private', 'no-store', 'no-cache', 'must-revalidate'].includes(part))
    || headers['cdn-cache-control'] !== undefined || headers['vercel-cdn-cache-control'] !== undefined
    || headers['retry-after'] !== undefined || !['MISS', 'BYPASS'].includes(headers['x-vercel-cache'])) {
    throw new CanaryError('cache_contract');
  }
  return { private: true, noStore: true, vercelCache: headers['x-vercel-cache'] };
}

const observationSchema = z.object({ schemaVersion: z.literal(2), scope: z.literal('secret_loader_observation_only'),
  environment: z.enum(['preview', 'production']),
  contextScope: z.literal('loader'), marker: z.string().regex(/^gate1-secrets-[a-f0-9]{32}$/),
  effectiveMode: z.enum(['not_observed', 'invalid', 'local', 'vercel']),
  sourceResolution: z.enum(['not_attempted', 'accepted', 'rejected']),
  canonicalFamily: z.union([z.literal(4), z.literal(6), z.null()]), loaderReached: z.boolean(),
  loaderStateBefore: z.object({ hasCachedPair: z.boolean(), permanentFailure: z.boolean() }).strict().nullable(),
  loader: z.object({ loaderId: z.string().regex(/^[a-f0-9]{32}$/).nullable(),
    validationAttempts: z.number().int().min(0).max(2), effectiveMode: z.enum(['not_attempted', 'invalid', 'local', 'vercel']),
    validationStage: z.enum(['not_attempted', 'mode', 'payloads', 'hmac', 'redis', 'complete']),
    hmacInput: z.enum(['not_read', 'missing', 'present']), redisInput: z.enum(['not_read', 'missing', 'present']),
    hasCachedPair: z.boolean(), permanentFailure: z.boolean() }).strict().nullable(),
  identityAttempted: z.boolean(), redisAttempted: z.boolean(), scriptAttempted: z.boolean(),
  allowed: z.boolean(), reason: z.string().max(64).nullable(),
}).strict();

/**
 * Validates the case-specific body, environment and loader facts, not merely status. Provider content
 * stays transient; return only fixed facts and the nonsecret loader identifier.
 * firstId null permits warm success but requires fresh failure; otherwise requires memoized reuse.
 */
function reviewProbe(response, marker, firstId = null, caseId = CASE) {
  if (![CASE, SUCCESS_CASE].includes(caseId)) throw new CanaryError('profile');
  const success = caseId === SUCCESS_CASE;
  if (response.status !== (success ? 200 : 503)) throw new CanaryError('session_status');
  const cache = reviewCache(response.headers);
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '')) throw new CanaryError('body_contract');
  let body, observation;
  try { body = JSON.parse(response.text); } catch { throw new CanaryError('body_contract'); }
  const bodySchema = success
    ? z.object({ data: z.object({ user: z.null() }).strict(), error: z.null(), message: z.literal('Success') }).strict()
    : z.object({ data: z.null(), error: z.literal('SERVICE_UNAVAILABLE'),
      message: z.literal('Service temporarily unavailable. Please try again later.') }).strict();
  if (!bodySchema.safeParse(body).success) {
    throw new CanaryError('body_contract');
  }
  const raw = response.headers['x-gate1-secrets-probe'];
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > LIMITS.probeBytes) throw new CanaryError('probe_contract');
  try { observation = observationSchema.parse(JSON.parse(raw)); } catch { throw new CanaryError('probe_contract'); }
  if (observation.marker !== marker) throw new CanaryError('probe_contract');
  if (observation.environment !== (success ? 'production' : 'preview')) throw new CanaryError('environment_mismatch');
  if (observation.effectiveMode !== 'vercel' || observation.sourceResolution !== 'accepted'
    || ![4, 6].includes(observation.canonicalFamily)) throw new CanaryError('source_rejected');
  const loader = observation.loader, before = observation.loaderStateBefore;
  if (!observation.loaderReached || !loader || !before || !loader.loaderId
    || loader.effectiveMode !== 'vercel' || loader.validationAttempts !== 1) throw new CanaryError('secret_contract');
  if (firstId !== null && loader.loaderId !== firstId) throw new CanaryError('loader_changed');
  if (success) {
    if (!observation.allowed || observation.reason !== null || !observation.identityAttempted
      || !observation.redisAttempted || !observation.scriptAttempted || loader.validationStage !== 'complete'
      || loader.hmacInput !== 'present' || loader.redisInput !== 'present'
      || !loader.hasCachedPair || loader.permanentFailure || before.permanentFailure
      || (firstId !== null && !before.hasCachedPair)) throw new CanaryError('secret_contract');
    return { cache, environment: 'production', loaderId: loader.loaderId, sourceAccepted: true, secretMode: 'vercel',
      validationStage: 'complete', bothInputsPresent: true, validationAttempts: 1,
      hasCachedPair: true, permanentFailure: false, downstreamAttempted: true,
      cacheStateBefore: before.hasCachedPair ? 'cached_pair' : 'uninitialized' };
  }
  if (observation.allowed || observation.reason !== 'secret_unavailable'
    || observation.identityAttempted || observation.redisAttempted || observation.scriptAttempted
    || loader.effectiveMode !== 'vercel' || loader.validationStage !== 'hmac'
    || loader.hmacInput !== 'missing' || loader.redisInput !== 'missing'
    || loader.hasCachedPair || !loader.permanentFailure || loader.validationAttempts !== 1) {
    throw new CanaryError('secret_contract');
  }
  if (firstId === null && (before.hasCachedPair || before.permanentFailure)) throw new CanaryError('loader_already_initialized');
  if (firstId !== null && (before.hasCachedPair || !before.permanentFailure)) throw new CanaryError('secret_contract');
  return { cache, environment: 'preview', loaderId: loader.loaderId, sourceAccepted: true, secretMode: 'vercel',
    validationStage: 'hmac', bothInputsMissing: true, validationAttempts: 1,
    hasCachedPair: false, permanentFailure: true, downstreamAttempted: false,
    cacheStateBefore: firstId === null ? 'uninitialized' : 'permanent_failure' };
}

/** Resolves the shared checkout's ignored evidence directory across linked worktrees. */
function evidenceDirectory() {
  try {
    const root = path.resolve(__dirname, '..');
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root, encoding: 'utf8', timeout: 3000, maxBuffer: 4096, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const absolute = path.resolve(root, common);
    if (path.basename(absolute) !== '.git') throw new Error();
    return path.join(path.dirname(absolute), '.tmp', 'gate1-secrets-canary');
  } catch { throw new CanaryError('local_evidence'); }
}

/**
 * Reserves this deployment/case once across worktrees before HTTP. Never removes
 * reservations after failure. Reports contain projected facts only; atomic
 * replacement preserves the previous checkpoint if an update fails.
 * directory is a local storage seam used solely by isolated filesystem tests.
 */
function createStore(profile, approval, directory = evidenceDirectory()) {
  try {
    profile = parseProfile(profile);
    if (!/^[a-f0-9]{64}$/.test(approval)) throw new CanaryError('approval');
    fs.mkdirSync(directory, { recursive: true });
    // Refuse redirected evidence storage, including symlinked ancestors.
    for (let current = path.resolve(directory); ; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error();
      if (path.dirname(current) === current) break;
    }
    const reservation = path.join(directory, `${profile.deploymentId}-${profile.caseId}.reservation.json`);
    let fd;
    try { fd = fs.openSync(reservation, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new CanaryError('reservation'); throw error; }
    try {
      fs.writeFileSync(fd, JSON.stringify({ deploymentId: profile.deploymentId, caseId: profile.caseId, approvalId: approval }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const reportPath = path.join(directory, `gate1-secrets-canary-${profile.deploymentId}-${approval}.json`);
    fs.writeFileSync(reportPath, '{}\n', { flag: 'wx', mode: 0o600 });
    /** Atomically checkpoints only a bounded sanitized report; no raw input is accepted. */
    function save(report) {
      const encoded = JSON.stringify(report, null, 2) + '\n';
      if (Buffer.byteLength(encoded) > LIMITS.reportBytes) throw new CanaryError('local_evidence');
      const temporary = `${reportPath}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        const file = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(file, encoded); fs.fsyncSync(file); } finally { fs.closeSync(file); }
        // Retry transient file locks with at most four 25 ms waits, preserving the previous checkpoint.
        for (let attempt = 0; ; attempt += 1) {
          try { fs.renameSync(temporary, reportPath); break; }
          catch (error) {
            if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
          }
        }
      } catch { throw new CanaryError('local_evidence'); }
      finally { try { fs.unlinkSync(temporary); } catch { /* Only our owned temporary file. */ } }
    }
    return { reportPath, save };
  } catch (error) { throw error instanceof CanaryError ? error : new CanaryError('local_evidence'); }
}

/** Executes one approved sequence; dependency seams mark reports as fixtures, never hosted evidence. */
async function runCanary(input, deps = {}) {
  const fixture = typeof deps.requestImpl === 'function';
  const report = { schemaVersion: 1, mode: fixture ? 'fixture' : 'live', scope: 'preview_missing_secrets_only',
    result: 'stopped', gate1Status: 'open', hostedEvidence: fixture ? 'not_executed' : 'requires_review',
    secretEvidence: 'unqualified', initializationEvidence: 'not_observed', sourceAgreement: 'not_evaluated', wafEvidence: 'not_qualified_by_this_run',
    target: null, approvalId: null, limits: LIMITS, appRequests: 0, providerRequests: 0, configMutations: 0,
    validatedRequests: 0, unvalidatedAttempts: 0, receipts: [], observations: [],
    failure: null, stoppedPhase: 'validation', dispatchState: 'not_started',
    attribution: 'operator_attested_snapshot_with_runtime_environment_and_http_build_checks' };
  const now = deps.now ?? (() => performance.now()), wall = deps.wall ?? Date.now;
  let phase = 'validation', store, start, wallStart, previous;
  try {
    const parsed = z.object({ profile: profileSchema, approval: z.string().regex(/^[a-f0-9]{64}$/),
      liveApproved: z.literal(true), credentials: credentialsSchema }).strict().safeParse(input);
    if (!parsed.success) throw new CanaryError('input');
    const { profile, approval, credentials } = parsed.data;
    report.scope = evidenceScope(profile.caseId);
    if (credentials.probeSecret === credentials.bypassSecret
      || JSON.stringify(profile).includes(credentials.probeSecret) || JSON.stringify(profile).includes(credentials.bypassSecret)) {
      throw new CanaryError('credentials');
    }
    if (approval !== approvalId(profile)) throw new CanaryError('approval');
    start = now(); previous = start; wallStart = wall();
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(wallStart)) throw new CanaryError('deadline');
    /** Rechecks monotonic/absolute bounds and profile age before/after every boundary. */
    function remaining() {
      if (deps.signal?.aborted) throw new CanaryError('cancelled');
      const current = now(), currentWall = wall(), age = currentWall - Date.parse(profile.reviewedAt);
      if (!Number.isFinite(current) || !Number.isFinite(currentWall) || current < previous
        || current - start >= LIMITS.overallMs || Math.abs(currentWall - wallStart - (current - start)) > 5000) throw new CanaryError('deadline');
      if (age < 0 || age > LIMITS.profileAgeMs) throw new CanaryError('profile');
      previous = current;
      return LIMITS.overallMs - (current - start);
    }
    remaining();
    report.target = profile; report.approvalId = approval; report.startedAt = new Date(wallStart).toISOString();
    store = fixture ? (deps.store ?? { reportPath: null,
      /** Fixture default intentionally retains no filesystem evidence. */
      save() {} }) : createStore(profile, approval);
    /** Saves projected evidence; any filesystem exception blocks further dispatch. */
    function checkpoint() {
      try { store.save(report); } catch { throw new CanaryError('local_evidence'); }
    }
    checkpoint();
    /** Runs one fixed path and records only response status, duration and validated facts. */
    async function request(nextPhase, marked = false, firstId = null) {
      phase = nextPhase;
      const marker = `gate1-secrets-${randomBytes(16).toString('hex')}`;
      const headers = { Accept: marked ? 'application/json' : 'text/html',
        'Accept-Encoding': 'identity', 'User-Agent': marked ? marker : 'gate1-secrets-canary',
        'x-vercel-protection-bypass': credentials.bypassSecret };
      if (marked) { headers.Authorization = `Bearer ${credentials.probeSecret}`; headers['x-gate1-secrets-diagnostic'] = '1'; }
      report.stoppedPhase = phase; report.dispatchState = 'dispatch_pending';
      checkpoint();
      remaining();
      const begin = previous;
      const response = await exchange({ hostname: profile.hostname, path: marked ? '/api/auth/session' : '/login',
        bytes: marked ? LIMITS.sessionBytes : LIMITS.buildBytes, headers }, {
        requestImpl: deps.requestImpl, signal: deps.signal, timeoutMs: Math.min(LIMITS.requestMs, remaining()),
        /** Count a conservative attempt immediately before native HTTPS creation. */
        onDispatch() {
          remaining();
          if (report.appRequests >= LIMITS.maxAppRequests) throw new CanaryError('request_budget');
          report.appRequests += 1; report.dispatchState = 'attempted';
        },
      });
      report.dispatchState = 'response_received';
      remaining();
      const receipt = { phase, status: response.status, durationMs: Math.round((previous - begin) * 1000) / 1000, validated: false };
      report.receipts.push(receipt);
      let observation;
      if (marked) {
        observation = reviewProbe(response, marker, firstId, profile.caseId);
        // Even schema-valid provider fields cannot echo the supplied credentials.
        const projected = JSON.stringify(observation);
        if (projected.includes(credentials.probeSecret) || projected.includes(credentials.bypassSecret)) throw new CanaryError('probe_contract');
        report.observations.push({ phase, ...observation });
      } else if (loginBuild(response) !== profile.nextBuildId) throw new CanaryError('build_mismatch');
      receipt.validated = true; report.validatedRequests += 1;
      checkpoint();
      return observation;
    }
    await request('buildBefore');
    const first = await request('probe1', true);
    await request('probe2', true, first.loaderId);
    await request('buildAfter');
    remaining();
    report.result = 'completed';
    report.secretEvidence = profile.caseId === SUCCESS_CASE
      ? 'validated_pair_and_same_loader_cache_reuse_observed' : 'missing_both_and_same_loader_failure_observed';
    if (profile.caseId === SUCCESS_CASE) report.initializationEvidence = first.cacheStateBefore === 'uninitialized'
      ? 'observed_on_probe1' : 'already_cached_on_probe1';
    report.stoppedPhase = null;
  } catch (error) {
    report.failure = error instanceof CanaryError ? error.code : 'internal';
    report.stoppedPhase = phase;
  }
  report.unvalidatedAttempts = report.appRequests - report.validatedRequests;
  if (Number.isFinite(start)) {
    // Include failed-request time, but never let a failed final clock read escape reporting.
    try {
      const final = now();
      if (!Number.isFinite(final) || final < previous) throw new CanaryError('deadline');
      report.elapsedMs = Math.round((final - start) * 1000) / 1000;
    } catch {
      report.elapsedMs = null;
      if (report.result === 'completed') {
        report.result = 'stopped'; report.secretEvidence = 'unqualified'; report.initializationEvidence = 'not_observed';
        report.failure = 'deadline'; report.stoppedPhase = 'report';
      }
    }
  }
  if (store) {
    try { store.save(report); }
    catch {
      // Keep the original diagnosis when final persistence also fails.
      report.finalCheckpoint = 'failed';
      if (report.result === 'completed' || report.failure === null) {
        report.failure = 'local_evidence'; report.stoppedPhase = 'report';
      }
      report.result = 'stopped'; report.secretEvidence = 'unqualified'; report.initializationEvidence = 'not_observed';
    }
  }
  return { reportPath: store?.reportPath ?? null, report };
}

/** Reads bounded, timed stdin only; BOM is accepted and temporary byte buffers are cleared. */
function readInput(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, settled = false;
    const timer = setTimeout(fail, 15000);
    /** Clears listeners and wipes buffered input after any terminal result. */
    function cleanup() {
      clearTimeout(timer); stream.removeListener('data', data); stream.removeListener('end', end);
      stream.removeListener('error', fail); stream.pause(); chunks.forEach((chunk) => chunk.fill(0)); chunks.length = 0;
    }
    /** Rejects input without echoing its contents or transport errors. */
    function fail() { if (settled) return; settled = true; cleanup(); reject(new CanaryError('input')); }
    /** Bounds each incoming chunk before storing a private copy. */
    function data(chunk) {
      size += Buffer.byteLength(chunk);
      if (size > LIMITS.inputBytes) fail(); else chunks.push(Buffer.from(chunk));
    }
    /** Parses transient JSON and releases all listener/buffer state. */
    function end() {
      if (settled) return;
      try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')); settled = true; cleanup(); resolve(value); }
      catch { fail(); }
    }
    stream.on('data', data); stream.on('end', end); stream.on('error', fail); stream.resume();
  });
}

/** Exact offline-default CLI; only --live accepts a separately approved credential envelope. */
async function main(args) {
  try {
    if (args.length > 1 || (args.length && !['--prepare', '--template', '--template-production', '--review', '--live'].includes(args[0]))) throw new CanaryError('arguments');
    if (args[0] !== '--live') {
      const value = args[0] === '--template-production' ? profileTemplate(SUCCESS_CASE)
        : args[0] === '--template' ? profileTemplate() : args[0] === '--review' ? preparation(await readInput()) : preparation();
      process.stdout.write(JSON.stringify(value, null, 2) + '\n'); return;
    }
    const controller = new AbortController();
    /** Cancels owned I/O without starting another attempt or retaining a signal reason. */
    function cancel() { controller.abort(); }
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
      const result = await runCanary(await readInput(), { signal: controller.signal });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exitCode = result.report.result === 'completed' ? 0 : 1;
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  } catch { process.stderr.write('Canary preparation/execution failed. Do not rerun automatically.\n'); process.exitCode = 1; }
}

module.exports = { LIMITS, CASE, SUCCESS_CASE, CanaryError, profileTemplate, parseProfile, approvalId, preparation,
  selectedHeaders, exchange, reviewProbe, evidenceDirectory, createStore, runCanary, readInput };
if (require.main === module) void main(process.argv.slice(2));
