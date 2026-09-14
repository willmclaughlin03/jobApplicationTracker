/**
 * GATE-1 temporary-v1 shared-IP HTTP qualification tooling.
 * Importing this module performs no I/O. The caller must separately authorize live
 * provisioning, traffic, and owned-account deletion. This does not close GATE-1.
 */
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { z } = require('zod');
const {
  AUTH_COOKIE_STORAGE_KEY, EXPECTED_SUPABASE_URL, createDisposableCredentials,
} = require('./gate0-auth-evidence.js');

const TARGET = Object.freeze({
  origin: 'https://job-application-tracker-kappa-seven.vercel.app',
  deploymentId: 'dpl_67mvmPmnq9GArtsBaTL1nc1m9TB1',
  gitSha: '7ac94ff885f515f87c2f16fce98529d3bc3a51c8',
  nextBuildId: 'WjDE6P7t35Ab1eWqO48Z_',
});
const PROPOSED_PROFILE = Object.freeze({
  sessions: 50, cycles: 3, intervalMs: 31000, concurrency: 5,
  timeoutMs: 10000, setupTimeoutMs: 600000, durationMs: 180000,
  maxAppRequests: 302,
});
const ENV_NAMES = Object.freeze([
  'GATE1_SUPABASE_URL', 'GATE1_SUPABASE_PUBLISHABLE_KEY',
  'GATE1_SUPABASE_SECRET_KEY', 'GATE1_LIVE_ALLOWED',
]);
const CSRF_COOKIE = '__Host-csrf-token';
const cookieExpirations = new WeakMap();
const ROUTES = Object.freeze({ session: '/api/auth/session', csrf: '/api/auth/csrf' });
const RECONCILIATION_PAGE_SIZE = 50;
const ERROR_CODES = new Set([
  'configuration', 'cancelled', 'timeout', 'setup_deadline', 'duration_limit',
  'request_budget', 'wrong_target', 'redirect', 'build_mismatch', 'response_size',
  'response_shape', 'cookie_contract', 'cache_contract', 'identity_mismatch',
  'duplicate_session', 'http_rejection', 'transport_error', 'provisioning_failed',
  'sign_in_failed', 'cleanup_failed', 'ownership_unconfirmed', 'dependency_version',
  'run_marker_failed', 'reconciliation_failed', 'unexpected_error',
]);
const profileSchema = z.object({
  sessions: z.number().int().min(1).max(50),
  cycles: z.number().int().min(1).max(5),
  intervalMs: z.number().int().min(30000).max(120000),
  concurrency: z.number().int().min(1).max(10),
  timeoutMs: z.number().int().min(100).max(15000),
  setupTimeoutMs: z.number().int().min(1000).max(600000),
  durationMs: z.number().int().min(1000).max(300000),
  maxAppRequests: z.number().int().min(4).max(502),
}).strict();

/** Carry only an audited code across error boundaries; never preserve provider causes. */
class Gate1Error extends Error {
  /** Accept a known failure code and replace any unrecognized input with a static fallback. */
  constructor(code) {
    super(ERROR_CODES.has(code) ? code : 'unexpected_error');
    this.code = this.message;
  }
}

/** Reduce caught errors to a fixed vocabulary, excluding messages, stacks, and payloads. */
function failureCode(error) {
  return error instanceof Gate1Error && ERROR_CODES.has(error.code) ? error.code : 'unexpected_error';
}

/** Validate bounded profile inputs before services or network activity can be created. */
function validateProfile(input) {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) throw new Gate1Error('configuration');
  const profile = parsed.data;
  if (profile.concurrency > profile.sessions
    || profile.maxAppRequests !== 2 + profile.sessions * profile.cycles * 2
    || profile.durationMs <= (profile.cycles - 1) * profile.intervalMs) {
    throw new Gate1Error('configuration');
  }
  return Object.freeze(profile);
}

/** Read dedicated credential names from the supplied environment, never files or deployment fallbacks. */
function validateLiveEnvironment(env) {
  const schema = z.object({
    GATE1_SUPABASE_URL: z.literal(EXPECTED_SUPABASE_URL),
    GATE1_SUPABASE_PUBLISHABLE_KEY: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]+$/).max(1024),
    GATE1_SUPABASE_SECRET_KEY: z.string().regex(/^sb_secret_[A-Za-z0-9_-]+$/).max(1024),
    GATE1_LIVE_ALLOWED: z.literal('true'),
  });
  const result = schema.safeParse(env);
  if (!result.success) throw new Gate1Error('configuration');
  return result.data;
}

/** Stop before new work when a caller or phase deadline has aborted the supplied signal. */
function checkSignal(signal) {
  if (signal?.aborted) throw cancellationError(signal);
}

/** Preserve runner-owned deadline codes and classify ordinary AbortController reasons without exposing them. */
function cancellationError(signal) {
  const code = failureCode(signal.reason);
  return new Gate1Error(code === 'unexpected_error' ? 'cancelled' : code);
}

/** Wait for a visibility interval; remove the timer and listener on completion or cancellation. */
function sleep(ms, signal) {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    /** Release resources before settling this one scheduled wait. */
    function finish(error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve();
    }
    /** Convert an external cancellation to a safe code without retaining its reason. */
    function cancel() { finish(new Gate1Error('cancelled')); }
    const timer = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** Read a transient HTTP body with a byte cap; the request timeout also covers stalled streams. */
async function readBoundedBody(response, maxBytes, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  /** Release even a stalled mocked/native reader when the encompassing request is aborted. */
  function cancelReader() { reader.cancel().catch(() => {}); }
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    checkSignal(signal);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Gate1Error('response_size');
      chunks.push(Buffer.from(value));
    }
    checkSignal(signal);
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal.removeEventListener('abort', cancelReader);
    // Cancellation is best effort; it must not block a timeout or expose stream errors.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Send exactly one nonredirecting request with a timeout covering headers and body.
 * fetchImpl is injectable for offline tests; all returned content remains transient.
 */
async function requestBounded(url, init, { fetchImpl, signal, timeoutMs, maxBytes = 65536 }) {
  checkSignal(signal);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Gate1Error('timeout')), timeoutMs);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    /** Reject even a noncooperative transport, without copying an external abort reason. */
    onAbort = () => reject(new Gate1Error(controller.signal.aborted ? 'timeout' : 'cancelled'));
    combined.addEventListener('abort', onAbort, { once: true });
  });
  /** Consume the entire bounded response before releasing timeout protection. */
  async function exchange() {
    const response = await fetchImpl(url, { ...init, redirect: 'manual', signal: combined });
    if (combined.aborted) {
      response.body?.cancel().catch(() => {});
      checkSignal(combined);
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      response.body?.cancel().catch(() => {});
      throw new Gate1Error('redirect');
    }
    if (response.url && response.url !== url) {
      response.body?.cancel().catch(() => {});
      throw new Gate1Error('wrong_target');
    }
    const text = await readBoundedBody(response, maxBytes, combined);
    return { status: response.status, headers: response.headers, text };
  }
  try {
    return await Promise.race([exchange(), aborted]);
  } catch (error) {
    throw error instanceof Gate1Error ? error : new Gate1Error('transport_error');
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', onAbort);
  }
}

/** Serialize one fresh real session through the installed, version-pinned SSR primitives. */
function sessionCookieJar(session) {
  const packagePath = require.resolve('@supabase/ssr/package.json');
  if (require(packagePath).version !== '0.8.0') throw new Gate1Error('dependency_version');
  const { createChunks, stringToBase64URL } = require(path.join(path.dirname(packagePath), 'dist/main/utils'));
  const chunks = createChunks(AUTH_COOKIE_STORAGE_KEY, `base64-${stringToBase64URL(JSON.stringify(session))}`);
  if (chunks.length > 6) throw new Gate1Error('cookie_contract');
  return new Map(chunks.map(({ name, value }) => [name, value]));
}

/** Recognize only this deployment's auth chunks and production CSRF cookie. */
function allowedCookie(name) {
  return name === CSRF_COOKIE || name === AUTH_COOKIE_STORAGE_KEY
    || new RegExp(`^${AUTH_COOKIE_STORAGE_KEY}\\.[0-5]$`).test(name);
}

/**
 * Apply separate Set-Cookie fields atomically to one in-memory host-only jar.
 * Validate security attributes and expiry; never comma-split Expires dates.
 */
function applyCookies(jar, headers, now = Date.now()) {
  const fields = headers.getSetCookie();
  if (fields.length > 14) throw new Gate1Error('cookie_contract');
  const next = new Map(jar);
  const expirations = new Map(cookieExpirations.get(jar));
  let csrfWritten = false;
  for (const field of fields) {
    if (field.length > 8192) throw new Gate1Error('cookie_contract');
    const [pair, ...parts] = field.split(';').map(part => part.trim());
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (separator < 1 || !allowedCookie(name) || !/^[A-Za-z0-9._~%+=/-]*$/.test(value)) {
      throw new Gate1Error('cookie_contract');
    }
    const attributes = new Map();
    for (const part of parts) {
      const equals = part.indexOf('=');
      const key = (equals < 0 ? part : part.slice(0, equals)).toLowerCase();
      if (attributes.has(key)) throw new Gate1Error('cookie_contract');
      attributes.set(key, equals < 0 ? '' : part.slice(equals + 1));
    }
    if (attributes.has('domain') || !attributes.has('secure') || attributes.get('path') !== '/'
      || attributes.get('samesite')?.toLowerCase() !== 'lax'
      || (name !== CSRF_COOKIE && !attributes.has('httponly'))
      || (name === CSRF_COOKIE && attributes.has('httponly'))) throw new Gate1Error('cookie_contract');
    const maxAge = attributes.get('max-age');
    const expires = attributes.get('expires');
    if ((maxAge !== undefined && (!/^-?\d+$/.test(maxAge) || !Number.isSafeInteger(Number(maxAge))))
      || (expires !== undefined && !Number.isFinite(Date.parse(expires)))) throw new Gate1Error('cookie_contract');
    const expired = maxAge !== undefined ? Number(maxAge) <= 0
      : expires !== undefined && Date.parse(expires) <= now;
    if (expired) { next.delete(name); expirations.delete(name); }
    else {
      next.set(name, value);
      const expiry = maxAge !== undefined ? now + Number(maxAge) * 1000
        : expires !== undefined ? Date.parse(expires) : null;
      if (expiry === null) expirations.delete(name); else expirations.set(name, expiry);
    }
    if (name === CSRF_COOKIE && !expired && value) csrfWritten = true;
  }
  if (next.size > 8) throw new Gate1Error('cookie_contract');
  jar.clear();
  for (const [name, value] of next) jar.set(name, value);
  cookieExpirations.set(jar, expirations);
  return { writes: fields.length, csrfWritten };
}

/** Format only validated in-memory cookie pairs for the pinned application origin. */
function cookieHeader(jar, now = Date.now()) {
  const expirations = cookieExpirations.get(jar);
  for (const [name, expiry] of expirations || []) {
    if (expiry <= now) { jar.delete(name); expirations.delete(name); }
  }
  for (const [name, value] of jar) {
    if (!allowedCookie(name) || typeof value !== 'string' || !/^[A-Za-z0-9._~%+=/-]*$/.test(value)) {
      throw new Gate1Error('cookie_contract');
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Persist only ownership tags before provisioning so interrupted runs retain a recovery marker. */
function persistRunMarker(runMarker) {
  const directory = path.join(__dirname, '..', '.tmp', 'gate1-runs');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${runMarker}.json`),
    JSON.stringify({ gate1_qualification: true, gate1_run: runMarker }),
    { flag: 'wx', mode: 0o600, flush: true });
}

/**
 * Construct live services after explicit CLI approval and environment validation.
 * Persist the private run marker before any create; reconcile uncertain receipts through
 * bounded provider pages before deletion. Injected persistence keeps tests off disk.
 */
function createLiveServices(profileInput, env, fetchImpl = globalThis.fetch, {
  persistMarker = persistRunMarker,
} = {}) {
  const profile = validateProfile(profileInput);
  const credentials = validateLiveEnvironment(env);
  for (const name of ['@supabase/supabase-js', '@supabase/auth-js']) {
    if (require(`${name}/package.json`).version !== '2.90.1') throw new Gate1Error('dependency_version');
  }
  if (require('@supabase/ssr/package.json').version !== '0.8.0') throw new Gate1Error('dependency_version');
  const { createClient } = require('@supabase/supabase-js');
  const owned = new Map();
  const runMarker = randomUUID();
  const uncertainEmails = new Set();
  let markerPersisted = false;
  const stats = { createAttempts: 0, signInAttempts: 0, deleteAttempts: 0,
    created: 0, deleted: 0, cleanupFailed: 0, unconfirmedCreates: 0,
    reconciliationAttempts: 0, reconciled: 0, reconciliationFailed: 0 };
  let cleaning = false;

  /** Limit each SDK operation to one exact method/URL; disable implicit SDK retries and redirects. */
  function clientFor(operation, endpoint, signal) {
    let requested = false;
    let transportFailure;
    /** Supply a one-use bounded fetch to the SDK, keeping credentials on the pinned provider only. */
    async function providerFetch(url, init) {
      const method = operation === 'list' ? 'GET' : operation === 'delete' ? 'DELETE' : 'POST';
      if (requested || url !== `${EXPECTED_SUPABASE_URL}${endpoint}` || init?.method !== method) {
        transportFailure = new Gate1Error('wrong_target');
        throw transportFailure;
      }
      checkSignal(signal);
      requested = true;
      stats[operation === 'create' ? 'createAttempts' : operation === 'signIn' ? 'signInAttempts'
        : operation === 'list' ? 'reconciliationAttempts' : 'deleteAttempts']++;
      try {
        // Let an already-dispatched create settle within its request timeout so graceful cancellation
        // does not discard a returned ownership receipt. No subsequent create/sign-in starts after abort.
        const response = await requestBounded(url, init, { fetchImpl,
          signal: operation === 'create' ? undefined : signal, timeoutMs: profile.timeoutMs });
        return new Response(response.text, { status: response.status, headers: response.headers });
      } catch (error) {
        transportFailure = error;
        throw error;
      }
    }
    const client = createClient(EXPECTED_SUPABASE_URL,
      operation === 'signIn' ? credentials.GATE1_SUPABASE_PUBLISHABLE_KEY : credentials.GATE1_SUPABASE_SECRET_KEY, {
        auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
        global: { fetch: providerFetch },
      });
    return { client, requested: () => requested, failure: () => transportFailure };
  }

  /** Create then sign in one owned account; retain ownership before any fallible sign-in or serialization. */
  async function provision(signal) {
    checkSignal(signal);
    if (cleaning || stats.createAttempts >= profile.sessions) throw new Gate1Error('request_budget');
    if (!markerPersisted) {
      try { await persistMarker(runMarker); markerPersisted = true; }
      catch { throw new Gate1Error('run_marker_failed'); }
      checkSignal(signal);
    }
    const disposable = createDisposableCredentials();
    const admin = clientFor('create', '/auth/v1/admin/users', signal);
    let created;
    try {
      created = await admin.client.auth.admin.createUser({ ...disposable, email_confirm: true,
        app_metadata: { gate1_qualification: true, gate1_run: runMarker } });
    } catch {
      if (admin.requested()) { uncertainEmails.add(disposable.email); stats.unconfirmedCreates++; }
      throw admin.failure() || new Gate1Error('provisioning_failed');
    }
    const user = created.data?.user;
    if (!z.string().uuid().safeParse(user?.id).success
      || user?.app_metadata?.gate1_qualification !== true
      || user?.app_metadata?.gate1_run !== runMarker || owned.has(user.id)) {
      if (admin.requested()) { uncertainEmails.add(disposable.email); stats.unconfirmedCreates++; }
      throw admin.failure() || new Gate1Error('ownership_unconfirmed');
    }
    owned.set(user.id, true);
    stats.created++;
    if (created.error) throw new Gate1Error('provisioning_failed');
    checkSignal(signal);
    const signIn = clientFor('signIn', '/auth/v1/token?grant_type=password', signal);
    let signedIn;
    try { signedIn = await signIn.client.auth.signInWithPassword(disposable); }
    catch { throw signIn.failure() || new Gate1Error('sign_in_failed'); }
    const session = signedIn.data?.session;
    if (signedIn.error || !session) throw signIn.failure() || new Gate1Error('sign_in_failed');
    if (session.user?.id !== user.id || signedIn.data.user?.id !== user.id) throw new Gate1Error('identity_mismatch');
    if (typeof session.access_token !== 'string' || !session.access_token
      || typeof session.refresh_token !== 'string' || !session.refresh_token
      || !Number.isFinite(session.expires_at)
      || session.expires_at * 1000 <= Date.now() + profile.durationMs + profile.setupTimeoutMs) {
      throw new Gate1Error('sign_in_failed');
    }
    return { userId: user.id, session, jar: sessionCookieJar(session) };
  }

  /** Send one allowed application GET with this session's jar and no forwarded-source headers. */
  async function request(route, jar, signal) {
    if (route !== '/login' && !Object.values(ROUTES).includes(route)) throw new Gate1Error('wrong_target');
    const headers = jar?.size ? { Cookie: cookieHeader(jar) } : {};
    return requestBounded(`${TARGET.origin}${route}`, { method: 'GET', headers },
      { fetchImpl, signal, timeoutMs: profile.timeoutMs, maxBytes: route === '/login' ? 1048576 : 65536 });
  }

  /**
   * Scan once before deleting so our deletions cannot shift provider pagination.
   * Reserve one delete per attempted create within the existing total request budget;
   * retain each confirmed ID immediately, even when a later page is invalid or fails.
   */
  async function reconcile() {
    const maxPages = Math.min(profile.sessions,
      profile.sessions * 3 - stats.createAttempts * 2 - stats.signInAttempts);
    for (let page = 1; page <= maxPages; page++) {
      const admin = clientFor('list', `/auth/v1/admin/users?page=${page}&per_page=${RECONCILIATION_PAGE_SIZE}`);
      const result = await admin.client.auth.admin.listUsers({ page, perPage: RECONCILIATION_PAGE_SIZE });
      if (result.error || !Array.isArray(result.data?.users)
        || result.data.users.length > RECONCILIATION_PAGE_SIZE) throw new Gate1Error('reconciliation_failed');
      for (const user of result.data.users) {
        if (user?.app_metadata?.gate1_qualification !== true || user.app_metadata.gate1_run !== runMarker) continue;
        if (!z.string().uuid().safeParse(user.id).success) { stats.reconciliationFailed = 1; continue; }
        if (owned.has(user.id)) continue;
        if (!uncertainEmails.has(user.email) || stats.created >= stats.createAttempts) {
          stats.reconciliationFailed = 1;
          continue;
        }
        owned.set(user.id, true);
        uncertainEmails.delete(user.email);
        stats.created++; stats.reconciled++; stats.unconfirmedCreates--;
      }
      // Avoid the pinned SDK's truncated numeric Link parsing; walk bounded pages ourselves.
      if (stats.unconfirmedCreates === 0 || result.data.users.length < RECONCILIATION_PAGE_SIZE) return;
    }
    throw new Gate1Error('reconciliation_failed');
  }

  /**
   * Reconcile uncertain creates, then delete confirmed owned IDs once with at most five workers.
   * SIGINT stops setup/load but not cleanup. Hard process termination cannot guarantee remote cleanup;
   * the persisted run marker identifies ownership for separately approved recovery.
   */
  async function cleanup() {
    if (cleaning) return;
    cleaning = true;
    if (stats.unconfirmedCreates) {
      try { await reconcile(); } catch { stats.reconciliationFailed = 1; }
    }
    const pending = [...owned.keys()];
    let cursor = 0;
    /** Drain distinct owned receipts; never allow a failure to skip another known account. */
    async function worker() {
      while (cursor < pending.length) {
        const userId = pending[cursor++];
        try {
          const admin = clientFor('delete', `/auth/v1/admin/users/${userId}`);
          const result = await admin.client.auth.admin.deleteUser(userId);
          if (result.error) throw new Gate1Error('cleanup_failed');
          owned.delete(userId);
          stats.deleted++;
        } catch { stats.cleanupFailed++; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(5, pending.length) }, worker));
  }

  /** Expose only aggregate lifecycle counts; owned IDs and credentials stay in the service closure. */
  function snapshot() { return { ...stats, ownedRemaining: owned.size }; }
  return { provision, request, cleanup, snapshot };
}

/** Create an abortable phase budget tied to external cancellation; dispose its timer in finally. */
function phaseSignal(parent, ms, code) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Gate1Error(code)), ms);
  return { signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    dispose: () => clearTimeout(timer) };
}

/** Parse transient v1 JSON; malformed or non-JSON responses never reach the evidence document. */
function responseJson(response) {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Gate1Error('response_shape');
  }
  try { return JSON.parse(response.text); } catch { throw new Gate1Error('response_shape'); }
}

/** Check actual Next build identity, distinct from operator-attested deployment and Git identifiers. */
function verifyBuild(response) {
  if (response.status !== 200) throw new Gate1Error('build_mismatch');
  const script = response.text.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  try {
    if (!script || JSON.parse(script[1]).buildId !== TARGET.nextBuildId) throw new Error();
  } catch { throw new Gate1Error('build_mismatch'); }
}

/** Summarize automated request durations without retaining bodies, account labels, or raw headers. */
function summarizeDurations(values) {
  if (!values.length) return { count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  const ordered = [...values].sort((a, b) => a - b);
  /** Round a bounded monotonic measurement for compact, reproducible JSON output. */
  function rounded(value) { return Math.round(value * 100) / 100; }
  return { count: values.length, minMs: rounded(ordered[0]),
    p50Ms: rounded(ordered[Math.ceil(ordered.length * 0.5) - 1]),
    p95Ms: rounded(ordered[Math.ceil(ordered.length * 0.95) - 1]), maxMs: rounded(ordered.at(-1)) };
}

/**
 * Exercise independent sessions with mount plus bounded visibility events, then always clean up.
 * services own all external effects. Injected clocks/services make dry runs entirely offline.
 * Every attempted request is counted, with no retries or background polling.
 */
async function runProfile(profileInput, services, { signal, dryRun = false,
  clock = { now: () => performance.now(), sleep } } = {}) {
  const profile = validateProfile(profileInput);
  const report = {
    schemaVersion: 1, mode: dryRun ? 'dry_run' : 'live', gate1Status: 'open',
    result: 'stopped', target: TARGET, profile,
    attribution: { deploymentAndGit: 'operator_attestation_required', buildBefore: false, buildAfter: false },
    startedAt: new Date().toISOString(), preparedSessions: 0, distinctSessions: 0,
    completedCycles: 0, appRequests: 0, maxObservedConcurrency: 0,
    requests: { build: 0, session: 0, csrf: 0 }, statusCounts: {}, failureCounts: {},
    identityMatches: 0, identityMismatches: 0, csrfExceptions: 0, cookieWrites: 0,
    cache: { privateNoStore: 0, invalid: 0, MISS: 0, HIT: 0, STALE: 0, OTHER: 0 },
    provider: {}, durations: {},
    evidenceLimits: ['http_clients_only', 'shared_egress_requires_separate_proof',
      'browser_ui_not_measured', 'waf_topology_cardinality_cost_not_measured',
      'provider_504_cause_not_inferred', 'prior_browser_durations_remain_unmeasured'],
  };
  const durations = { build: [], session: [], csrf: [] };
  const sessions = [];
  const userIds = new Set();
  const accessTokens = new Set();
  const refreshTokens = new Set();
  const jars = new Set();
  let active = 0;
  let stopped = false;
  let setup;
  let load;

  /** Record a safe failure once at its owning operation and prevent further scheduled load. */
  function stop(error) {
    const code = failureCode(error);
    report.failureCounts[code] = (report.failureCounts[code] || 0) + 1;
    stopped = true;
  }

  /** Reserve budget before awaiting I/O; track all settled requests, including failed transport. */
  async function request(kind, state, requestSignal) {
    checkSignal(requestSignal);
    if (report.appRequests >= profile.maxAppRequests) throw new Gate1Error('request_budget');
    report.appRequests++;
    report.requests[kind]++;
    active++;
    report.maxObservedConcurrency = Math.max(report.maxObservedConcurrency, active);
    const start = clock.now();
    try {
      const response = await services.request(kind === 'build' ? '/login' : ROUTES[kind], state?.jar, requestSignal);
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        throw new Gate1Error('response_shape');
      }
      const key = `${kind}_${response.status}`;
      report.statusCounts[key] = (report.statusCounts[key] || 0) + 1;
      return response;
    } finally {
      active--;
      durations[kind].push(Math.max(0, clock.now() - start));
    }
  }

  /** Validate cache isolation before consuming personalized JSON or applying a cookie mutation. */
  function checkCache(response) {
    const policy = response.headers.get('cache-control')?.toLowerCase().split(',').map(part => part.trim()) || [];
    const cache = response.headers.get('x-vercel-cache');
    report.cache[['MISS', 'HIT', 'STALE'].includes(cache) ? cache : 'OTHER']++;
    if (!policy.includes('private') || !policy.includes('no-store')
      || policy.includes('public') || cache === 'HIT' || cache === 'STALE') {
      report.cache.invalid++;
      throw new Gate1Error('cache_contract');
    }
    report.cache.privateNoStore++;
  }

  /** Run a session check then CSRF priming in the same jar, preserving accepted 503 exceptions. */
  async function visit(state, cycle, requestSignal) {
    if (stopped) return;
    const remaining = state.lastCheck === null ? 0 : state.lastCheck + profile.intervalMs - clock.now();
    if (remaining > 0) await clock.sleep(remaining, requestSignal);
    checkSignal(requestSignal);
    if (stopped) return;
    state.lastCheck = clock.now();
    const response = await request('session', state, requestSignal);
    checkCache(response);
    if (response.status !== 200) throw new Gate1Error('http_rejection');
    const body = responseJson(response);
    if (body?.error !== null || body?.data?.user?.id !== state.userId) {
      report.identityMismatches++;
      throw new Gate1Error('identity_mismatch');
    }
    report.identityMatches++;
    report.cookieWrites += applyCookies(state.jar, response.headers).writes;
    // The mounted v1 client starts its throttle on session completion; visibility starts it on dispatch.
    if (cycle === 0) state.lastCheck = clock.now();
    if (stopped) return;
    const csrf = await request('csrf', state, requestSignal);
    checkCache(csrf);
    const csrfBody = responseJson(csrf);
    const cookies = applyCookies(state.jar, csrf.headers);
    report.cookieWrites += cookies.writes;
    if (csrf.status === 503 && csrfBody?.error === 'SERVICE_UNAVAILABLE'
      && csrf.headers.get('retry-after') === '5') {
      report.csrfExceptions++;
      return;
    }
    if (csrf.status !== 200) throw new Gate1Error('http_rejection');
    if (csrfBody?.error !== null || !cookies.csrfWritten) throw new Gate1Error('response_shape');
  }

  try {
    checkSignal(signal);
    setup = phaseSignal(signal, profile.setupTimeoutMs, 'setup_deadline');
    verifyBuild(await request('build', null, setup.signal));
    report.attribution.buildBefore = true;
    for (let index = 0; index < profile.sessions; index++) {
      checkSignal(setup.signal);
      const state = await services.provision(setup.signal);
      if (!state?.userId || state.session?.user?.id !== state.userId || !(state.jar instanceof Map)
        || !state.session.access_token || !state.session.refresh_token) throw new Gate1Error('identity_mismatch');
      if (userIds.has(state.userId) || accessTokens.has(state.session.access_token)
        || refreshTokens.has(state.session.refresh_token) || jars.has(state.jar)) throw new Gate1Error('duplicate_session');
      userIds.add(state.userId);
      accessTokens.add(state.session.access_token);
      refreshTokens.add(state.session.refresh_token);
      jars.add(state.jar);
      sessions.push({ ...state, lastCheck: null });
      report.preparedSessions++;
      report.distinctSessions = userIds.size;
    }
    setup.dispose();
    load = phaseSignal(signal, profile.durationMs, 'duration_limit');
    const loadStarted = clock.now();
    for (let cycle = 0; cycle < profile.cycles && !stopped; cycle++) {
      let cursor = 0;
      /** Schedule one session at a time per worker; each session has at most one outstanding request. */
      async function worker() {
        while (cursor < sessions.length && !stopped) {
          const state = sessions[cursor++];
          try {
            if (clock.now() - loadStarted >= profile.durationMs) throw new Gate1Error('duration_limit');
            await visit(state, cycle, load.signal);
          } catch (error) { stop(load.signal.aborted ? cancellationError(load.signal) : error); }
        }
      }
      await Promise.all(Array.from({ length: profile.concurrency }, worker));
      if (!stopped) report.completedCycles++;
    }
    if (!stopped) {
      verifyBuild(await request('build', null, load.signal));
      report.attribution.buildAfter = true;
    }
  } catch (error) {
    stop(load?.signal.aborted ? cancellationError(load.signal)
      : setup?.signal.aborted ? cancellationError(setup.signal) : error);
  } finally {
    setup?.dispose();
    load?.dispose();
    try { await services.cleanup(); } catch { stop(new Gate1Error('cleanup_failed')); }
    const lifecycle = services.snapshot();
    for (const key of ['createAttempts', 'signInAttempts', 'deleteAttempts', 'created', 'deleted',
      'cleanupFailed', 'unconfirmedCreates', 'ownedRemaining', 'reconciliationAttempts',
      'reconciled', 'reconciliationFailed']) {
      const value = lifecycle[key];
      report.provider[key] = Number.isSafeInteger(value) && value >= 0 && value <= 50 ? value : null;
    }
    if (Object.values(report.provider).some(value => value === null) || report.provider.cleanupFailed
      || report.provider.unconfirmedCreates || report.provider.ownedRemaining) stop(new Gate1Error('cleanup_failed'));
    if (report.provider.reconciliationFailed) stop(new Gate1Error('reconciliation_failed'));
    for (const state of sessions) { state.jar.clear(); state.session = null; state.userId = null; }
    userIds.clear(); accessTokens.clear(); refreshTokens.clear(); jars.clear();
  }
  report.durations = Object.fromEntries(Object.entries(durations).map(([kind, values]) => [kind, summarizeDurations(values)]));
  report.durationSource = dryRun ? 'synthetic_clock' : 'automated_monotonic_http';
  report.finishedAt = new Date().toISOString();
  report.result = stopped ? 'stopped' : report.csrfExceptions ? 'completed_with_exceptions' : 'completed';
  report.hostedEvidence = dryRun ? 'not_executed' : 'requires_review';
  return report;
}

/**
 * Supply synthetic services and virtual time for an entirely network-free dry run.
 * Fixtures exercise separate auth jars and refreshed Set-Cookie handling, without claiming hosted evidence.
 */
function createOfflineServices(profileInput) {
  const profile = validateProfile(profileInput);
  const owned = new Map();
  const stats = { createAttempts: 0, signInAttempts: 0, deleteAttempts: 0,
    created: 0, deleted: 0, cleanupFailed: 0, unconfirmedCreates: 0, ownedRemaining: 0,
    reconciliationAttempts: 0, reconciled: 0, reconciliationFailed: 0 };
  let now = 0;
  const clock = { now: () => now,
    /** Advance simulated time only; no timer, DNS lookup, socket, or provider client is used. */
    sleep: async (ms, signal) => { checkSignal(signal); now += ms; } };
  /** Issue distinct synthetic credentials through the same installed SSR serializer. */
  async function provision(signal) {
    checkSignal(signal);
    const ordinal = ++stats.createAttempts;
    if (ordinal > profile.sessions) throw new Gate1Error('request_budget');
    const userId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
    const session = { user: { id: userId }, access_token: `synthetic-access-${ordinal}`,
      refresh_token: `synthetic-refresh-${ordinal}`, expires_at: 9999999999 };
    const jar = sessionCookieJar(session);
    owned.set(userId, cookieHeader(jar));
    stats.created++; stats.signInAttempts++;
    return { userId, session, jar };
  }
  /** Answer only allowlisted fake requests and match each request's auth cookie to its own user. */
  async function request(route, jar, signal) {
    checkSignal(signal);
    now += 1;
    const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'private, no-store',
      'x-vercel-cache': 'MISS' });
    if (route === '/login') return { status: 200, headers,
      text: `<script id="__NEXT_DATA__">${JSON.stringify({ buildId: TARGET.nextBuildId })}</script>` };
    if (!Object.values(ROUTES).includes(route)) throw new Gate1Error('wrong_target');
    const authJar = new Map([...jar].filter(([name]) => name !== CSRF_COOKIE));
    const userId = [...owned].find(([, cookie]) => cookie === cookieHeader(authJar))?.[0];
    if (!userId) throw new Gate1Error('identity_mismatch');
    if (route === ROUTES.csrf) headers.append('set-cookie', `${CSRF_COOKIE}=synthetic-${now}; Path=/; Secure; SameSite=Lax; Max-Age=14400`);
    return { status: 200, headers, text: JSON.stringify({ data: route === ROUTES.session ? { user: { id: userId } } : null, error: null }) };
  }
  /** Delete only this mock pool's receipts, mirroring the aggregate live lifecycle. */
  async function cleanup() { stats.deleteAttempts += owned.size; stats.deleted += owned.size; owned.clear(); }
  /** Return safe mock counters; no synthetic identifiers are included in dry-run output. */
  function snapshot() { return { ...stats, ownedRemaining: owned.size }; }
  return { services: { provision, request, cleanup, snapshot }, clock };
}

module.exports = { TARGET, PROPOSED_PROFILE, ENV_NAMES, CSRF_COOKIE, ROUTES, Gate1Error,
  failureCode, validateProfile, validateLiveEnvironment, requestBounded, sessionCookieJar,
  applyCookies, cookieHeader, createLiveServices, runProfile, createOfflineServices, sleep };
