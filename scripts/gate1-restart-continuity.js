/**
 * GATE-1 controlled application restart harness. Default CLI execution is offline.
 * Live execution needs separate approval, explicit flags and process-only secrets.
 * This supervisor retains acknowledgements and OS exit events independently of A.
 * It neither sends hosted application traffic nor qualifies a Vercel restart.
 */
const { fork, execFileSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { z } = require('zod');
const { RestartError, failureCode, statsSchema, FAILURE_CODES } = require('./gate1-restart-transport.js');

const ROOT = path.resolve(__dirname, '..');
const APP_BASE = '0c9646521d9444871431cb788d91e121e5fbb815';
const HOSTED_REFERENCE = Object.freeze({ deploymentId: 'dpl_AaGEjVjtrjaiLbHqAyCKYfdFraU6',
  gitSha: 'ba8c398c5d0af2dba9c75305397b774f946b6b1e', nextBuildId: 'VjEJE3geVJngqDN7JymXV' });
const LIMITS = Object.freeze({ decisions: 402, concurrency: 4, clockReads: 2,
  maxRedisCommands: 806, quietMs: 64000, boundaryMs: 45000, overallMs: 300000,
  startupMs: 10000, commandMs: 4000, exitMs: 5000, ipcBytes: 32768 });
const APP_FILES = Object.freeze(['temporarySessionCeiling', 'temporarySessionRedisScript',
  'temporarySessionSecrets', 'temporarySessionSource', 'temporarySessionIdentity',
  'temporarySessionTelemetry', 'redis'].map((name) => `src/server/lib/${name}.js`)
  .concat(['src/shared/logger.js', 'package.json', 'package-lock.json']));
// Normalized source hashes make correspondence independent of Git history depth/CRLF.
const APP_HASHES = Object.freeze({
  'src/server/lib/temporarySessionCeiling.js': '02a9e149eb72211b1d1b66c05ebeed4823ab463de6324bdaba1fcda8c1e72233',
  'src/server/lib/temporarySessionRedisScript.js': '0432f292da4425472c15f81b8849406a89f35fb097c98f7d99047b929dc70e34',
  'src/server/lib/temporarySessionSecrets.js': '96f69368d3ba8f5c9bcd79a3c53efb1dd888a75ef92cbd5f68967a963e6d4d81',
  'src/server/lib/temporarySessionSource.js': '6b48f9d33eb4489de6aeabe739f62e12ec98c38d2ace21d42a915664b4bcb264',
  'src/server/lib/temporarySessionIdentity.js': 'bc41b44c8f206ec6f34acd2b7044d0ae913bc4e5dcaefada83cab8ec86f31ec0',
  'src/server/lib/temporarySessionTelemetry.js': 'ca3b16153accd047f5b4bf97c6ac8791296c70f0c7d5cf85e8ff0ba93854b6be',
  'src/server/lib/redis.js': '9218793a298873a6b75dc17926ca444793eccce4efee5a2c4769bcd304abd789',
  'src/shared/logger.js': 'a761bea853b22de294eb813ff43a0c0792d8c7047e0603c57ae14bb6e79b9de6',
  'package.json': 'b8964e0aa37caae2feef32cf99a1773d615c652f4eb273df456eae227d04a16a',
  'package-lock.json': 'f6af332dffbbbcbd8aca4b816201fa5756e25d2e7249e1cd2c0cd9c3343b9f1a',
});
const HARNESS_FILES = Object.freeze(['scripts/gate1-restart-continuity.js',
  'scripts/gate1-restart-worker.mjs', 'scripts/gate1-restart-transport.js',
  'scripts/run-gate1-restart-continuity.ps1',
  'src/testSupport/__tests__/gate1RestartContinuity.test.js',
  'src/testSupport/__tests__/gate1RestartTransport.test.js']);
const SDK_HASHES = Object.freeze({
  'nodejs.js': '696b078e13d46b2f0e8e36945466ce7f86b2e76f8607f6a50c781b7f0273e4e8',
  'nodejs.mjs': 'b0d53585b0035f1250d1cf96e89f28c43a9402414da6d839323bd40dfd9c61b5',
});
const LIVE_FLAGS = Object.freeze(['--live', '--attest-config-and-exclusive-source', '--authorize-child-termination']);
const SECRET_NAMES = Object.freeze(['TEMPORARY_SESSION_CEILING_LOCAL_HMAC_SECRET',
  'TEMPORARY_SESSION_CEILING_LOCAL_REDIS_SECRET']);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const decisionSchema = z.object({ id: z.number().int().min(1).max(402),
  allowed: z.boolean(), statusCode: z.union([z.literal(200), z.literal(429), z.literal(503)]),
  retryAfterSeconds: z.number().int().min(1).max(60).nullable() }).strict();
const readySchema = z.object({ type: z.literal('ready'), pid: z.number().int().positive(),
  runtime: z.string().regex(/^v22\.\d+\.\d+$/), digest: digestSchema }).strict();
const replySchema = z.discriminatedUnion('kind', [
  z.object({ type: z.literal('reply'), seq: z.number().int().positive(), kind: z.literal('decisions'),
    items: z.array(decisionSchema).min(1).max(4), stats: statsSchema }).strict(),
  z.object({ type: z.literal('reply'), seq: z.number().int().positive(), kind: z.literal('clock'),
    redisTime: z.tuple([z.number().int().min(0).max(1e11), z.number().int().min(0).max(999999)]),
    stats: statsSchema }).strict(),
]);
const fatalSchema = z.object({ type: z.literal('fatal'), code: z.enum(FAILURE_CODES),
  stats: statsSchema.nullable() }).strict();

/** Hashes public source/dependency bytes for attribution, never secret material. */
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

/** Executes fixed read-only Git queries, suppressing raw command errors. */
function git(args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim(); }
  catch { throw new RestartError('attribution'); }
}

/** Pins source correspondence and exact SDK implementation; live also needs a clean reviewed commit. */
function collectAttribution({ requireClean = false } = {}) {
  try {
    if (!/^v22\./.test(process.version)) throw new RestartError('attribution');
    for (const [name, expected] of Object.entries(APP_HASHES)) {
      if (sha256(fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n')) !== expected) {
        throw new RestartError('attribution');
      }
    }
    if (requireClean) {
      git(['ls-files', '--error-unmatch', '--', ...HARNESS_FILES]);
      if (git(['status', '--porcelain', '--', ...APP_FILES, ...HARNESS_FILES])) {
        throw new RestartError('attribution');
      }
    }
    const files = {};
    for (const name of [...APP_FILES, ...HARNESS_FILES]) {
      files[name] = sha256(fs.readFileSync(path.join(ROOT, name)));
    }
    const sdkDirectory = path.dirname(require.resolve('@upstash/redis'));
    for (const [name, expected] of Object.entries(SDK_HASHES)) {
      if (sha256(fs.readFileSync(path.join(sdkDirectory, name))) !== expected) {
        throw new RestartError('attribution');
      }
    }
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    if (lock.packages['node_modules/@upstash/redis'].version !== '1.36.2') {
      throw new RestartError('attribution');
    }
    const gitSha = git(['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(gitSha)) throw new RestartError('attribution');
    return { gitSha, appBase: APP_BASE, runtime: process.version, sdkVersion: '1.36.2',
      execution: 'native_source_modules', files, digest: sha256(JSON.stringify(files)),
      hostedReference: HOSTED_REFERENCE, hostedCorrespondence: 'reviewed_source_only' };
  } catch { throw new RestartError('attribution'); }
}

/** Creates one immutable child configuration; excludes inherited logging, preload and hosted credentials. */
function freezeChildEnvironment(env, source) {
  const result = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP']) {
    if (typeof env[name] === 'string') result[name] = env[name];
  }
  for (const name of SECRET_NAMES) {
    if (typeof env[name] !== 'string' || !env[name].length
      || Buffer.byteLength(env[name]) > 8192) throw new RestartError('configuration');
    result[name] = env[name];
  }
  return Object.freeze({ ...result, NODE_ENV: 'test', TEMPORARY_SESSION_CEILING_SOURCE_MODE: 'local',
    TEMPORARY_SESSION_CEILING_SECRET_MODE: 'local', GATE1_RESTART_CHILD: '1',
    GATE1_RESTART_SOURCE: source });
}

/** Waits without blocking Node; cancellation clears the pending timer/listener. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    /** Releases listener/timer for either completion or cancellation. */
    function finish(error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    }
    /** Converts cancellation into a fixed diagnostic. */
    function abort() { finish(new RestartError('cancelled')); }
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Bounds one promise and ensures its deadline timer is released. */
function bounded(promise, ms, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RestartError(code)), ms);
  })]).finally(() => clearTimeout(timer));
}

/**
 * Owns a directly spawned child handle. Only this handle can be terminated; an exit
 * event plus stream closure, never PID existence or kill() return value, confirms death.
 * Source/log streams are discarded; strictly validated IPC is the evidence channel.
 */
function createPeer(label, env, digest, signal, { spawnChild = fork } = {}) {
  const child = spawnChild(path.join(__dirname, 'gate1-restart-worker.mjs'), ['--worker', label], {
    cwd: ROOT, env: { ...env, GATE1_RESTART_DIGEST: digest }, execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  let failure = null;
  let readyValue = null;
  let lastStats = null;
  let pending = null;
  let sequence = 0;
  let expectedExit = false;
  let exitValue = null;
  let closeValue = false;
  let resolveReady;
  let rejectReady;
  let resolveClose;
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  readyPromise.catch(() => {});
  const closed = new Promise((resolve) => { resolveClose = resolve; });

  /** Latches protocol/lifecycle failure and releases any waiting controller. */
  function fail(code) {
    failure ??= new RestartError(code);
    rejectReady(failure);
    if (pending) { pending.reject(failure); pending = null; }
  }
  /** Rejects malformed, unsolicited or duplicated messages without retaining their fields. */
  function receive(message) {
    try {
      if (JSON.stringify(message).length > LIMITS.ipcBytes) throw new RestartError('protocol');
      if (message?.type === 'fatal') {
        const fatal = fatalSchema.parse(message);
        lastStats = fatal.stats;
        fail(fatal.code);
      } else if (message?.type === 'ready' && !readyValue && !expectedExit) {
        const value = readySchema.parse(message);
        if (value.pid !== child.pid || value.digest !== digest) throw new RestartError('attribution');
        readyValue = value;
        resolveReady(value);
      } else {
        const value = replySchema.parse(message);
        if (!pending || value.seq !== pending.seq || value.kind !== pending.kind
          || value.stats.failure || value.stats.active) throw new RestartError('protocol');
        const waiter = pending;
        pending = null;
        lastStats = value.stats;
        waiter.resolve(value);
      }
    } catch (error) { fail(failureCode(error)); }
  }
  /** Cancellation stops dispatch; caller's finally block confirms process cleanup. */
  function abort() { fail('cancelled'); }
  child.on('message', receive);
  child.on('error', () => fail('process_exit'));
  child.on('exit', (code, exitSignal) => {
    exitValue = { code: Number.isInteger(code) ? code : null,
      signal: ['SIGKILL', 'SIGTERM', 'SIGINT'].includes(exitSignal) ? exitSignal : null };
    if (!expectedExit) fail('process_exit');
  });
  child.on('close', () => { closeValue = true; resolveClose(); });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  /** Sends one bounded command and pairs it with exactly one typed response. */
  async function request(kind, ids) {
    if (failure) throw failure;
    if (!readyValue || pending || expectedExit || exitValue) throw new RestartError('protocol');
    const seq = ++sequence;
    const promise = new Promise((resolve, reject) => { pending = { seq, kind, resolve, reject }; });
    // A synchronous IPC send error may reject before bounded() installs its handler.
    promise.catch(() => {});
    try {
      child.send({ kind, seq, ...(ids ? { ids } : {}) }, (error) => { if (error) fail('process_exit'); });
      return await bounded(promise, LIMITS.commandMs, 'deadline');
    } catch (error) { fail(failureCode(error)); throw failure; }
  }
  /** Confirms this exact child's OS exit before returning; reused numeric PIDs are never targeted. */
  async function terminate() {
    expectedExit = true;
    try {
      if (!exitValue && !closeValue && !child.kill('SIGKILL')) throw new RestartError('cleanup');
      await bounded(closed, LIMITS.exitMs, 'cleanup');
      if (!exitValue) throw new RestartError('cleanup');
      return { pid: child.pid, ...exitValue, exitObserved: true, closed: true };
    } finally { signal?.removeEventListener('abort', abort); }
  }
  return { label, ready: () => bounded(readyPromise, LIMITS.startupMs, 'deadline'), request,
    terminate, getStats: () => lastStats, assertHealthy: () => { if (failure) throw failure; } };
}

/** Checks aggregate transport accounting without storing provider request data. */
function verifyStats(stats, decisions, timeReads) {
  if (!statsSchema.safeParse(stats).success || stats.failure || stats.active || stats.retriesBlocked
    || stats.fetchAttempts !== stats.forwarded || stats.evalsha !== decisions || stats.time !== timeReads
    || stats.eval !== stats.noscript || stats.commands !== stats.evalsha + stats.eval + stats.time) {
    throw new RestartError('protocol');
  }
}

/**
 * Drives one fixed trial. Injected lifecycle/clock seams serve offline tests only;
 * the live CLI always supplies real OS children, monotonic time and unchanged source.
 */
async function runTrial({ launch, attribution, checkAttribution = () => attribution,
  now = () => performance.now(), wait = sleep, signal, mode = 'offline' }) {
  const started = now();
  const controller = new AbortController();
  const overallTimer = setTimeout(() => controller.abort(), LIMITS.overallMs);
  const activeSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const report = { schemaVersion: 1, scope: 'controlled_application_restart_only', mode,
    result: 'stopped', gate1Status: 'open', hostedEvidence: 'not_executed',
    restartEvidence: 'not_qualified', futureV2Evidence: 'not_executed',
    review: 'requires_review', limits: LIMITS, attribution,
    sourceAdapter: 'local_socket_fixture', configuration: 'supervisor_frozen_process_inputs',
    startedAt: new Date().toISOString(), attempted: 0, acknowledged: 0, validated: 0,
    unvalidatedAttempts: 0, lifecycle: [], receipts: [], transport: {}, quietPeriodsMs: [],
    boundaryDurationMs: null, redisBoundaryMs: null, failure: null, cleanup: 'pending' };
  const peers = [];
  const terminated = new Set();
  let boundaryStart = null;
  let phase = 'startA';

  /** Checks both cancellation and the original consumption's conservative deadline. */
  function checkpoint(inBoundary = false) {
    const elapsed = now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= LIMITS.overallMs
      || activeSignal.aborted) throw new RestartError('deadline');
    if (inBoundary && (now() - boundaryStart < 0 || now() - boundaryStart >= LIMITS.boundaryMs)) {
      throw new RestartError('deadline');
    }
    for (const peer of peers) peer.assertHealthy();
  }
  /** Starts and attributes one child; B's call site follows confirmed termination of A. */
  async function start(label) {
    checkpoint(label === 'B');
    const peer = launch(label, activeSignal);
    peers.push(peer);
    report.lifecycle.push({ actor: label, event: 'spawn_requested', elapsedMs: now() - started });
    const ready = readySchema.parse(await peer.ready());
    if (ready.digest !== attribution.digest) throw new RestartError('attribution');
    report.lifecycle.push({ actor: label, event: 'ready', pid: ready.pid,
      runtime: ready.runtime, elapsedMs: now() - started });
    checkpoint(label === 'B');
    return peer;
  }
  /** Retains OS-confirmed exit/status in the supervisor before proceeding. */
  async function terminate(peer) {
    const exit = await peer.terminate();
    if (exit.exitObserved !== true || exit.closed !== true) throw new RestartError('cleanup');
    terminated.add(peer);
    report.lifecycle.push({ actor: peer.label, event: 'exit_confirmed', ...exit, elapsedMs: now() - started });
  }
  /** Waits out the original Redis representation naturally, without touching stored keys. */
  async function quiet() {
    const beginning = now();
    await wait(LIMITS.quietMs, activeSignal);
    const duration = now() - beginning;
    if (duration < LIMITS.quietMs) throw new RestartError('clock');
    report.quietPeriodsMs.push(duration);
    checkpoint();
  }
  /** Records every dispatched ID before sending; missing acknowledgements remain uncertain. */
  async function decisions(peer, count, expected, inBoundary = true) {
    for (let offset = 0; offset < count; offset += LIMITS.concurrency) {
      checkpoint(inBoundary);
      const length = Math.min(LIMITS.concurrency, count - offset);
      if (report.attempted + length > LIMITS.decisions) throw new RestartError('budget');
      const ids = Array.from({ length }, (_, index) => report.attempted + index + 1);
      report.attempted += length;
      const reply = replySchema.parse(await peer.request('decisions', ids));
      if (reply.kind !== 'decisions' || reply.items.length !== ids.length
        || reply.items.some((item, index) => item.id !== ids[index])) throw new RestartError('protocol');
      report.acknowledged += reply.items.length;
      report.transport[peer.label] = reply.stats;
      for (const item of reply.items) {
        const valid = item.statusCode === expected && item.allowed === (expected === 200)
          && (expected === 429 ? item.retryAfterSeconds !== null : item.retryAfterSeconds === null);
        report.receipts.push({ actor: peer.label, phase, ...item, validated: valid });
        if (valid) report.validated += 1;
      }
      checkpoint(inBoundary);
      if (reply.items.some((item) => item.statusCode !== expected
        || item.allowed !== (expected === 200)
        || (expected === 429 ? item.retryAfterSeconds === null : item.retryAfterSeconds !== null))) {
        throw new RestartError('decision');
      }
    }
  }
  /** Reads Redis time through the same guarded client without inspecting state or TTL. */
  async function clock(peer) {
    checkpoint(true);
    const reply = replySchema.parse(await peer.request('clock'));
    if (reply.kind !== 'clock') throw new RestartError('protocol');
    report.transport[peer.label] = reply.stats;
    checkpoint(true);
    return reply.redisTime[0] * 1000 + reply.redisTime[1] / 1000;
  }
  try {
    const a = await start('A');
    phase = 'initialQuiet';
    await quiet();
    boundaryStart = now();
    phase = 'clockBefore';
    const redisBefore = await clock(a);
    phase = 'consumeA';
    await decisions(a, 200, 200);
    verifyStats(report.transport.A, 200, 1);
    a.assertHealthy();
    phase = 'terminateA';
    await terminate(a);
    checkpoint(true);
    phase = 'startB';
    const b = await start('B');
    phase = 'consumeB';
    await decisions(b, 200, 200);
    phase = 'reject401';
    await decisions(b, 1, 429);
    phase = 'clockAfter';
    const redisAfter = await clock(b);
    report.redisBoundaryMs = redisAfter - redisBefore;
    report.boundaryDurationMs = now() - boundaryStart;
    if (report.redisBoundaryMs < 0 || report.redisBoundaryMs >= LIMITS.boundaryMs) {
      throw new RestartError('clock');
    }
    verifyStats(report.transport.B, 201, 1);
    phase = 'recoveryQuiet';
    await quiet();
    phase = 'recovery';
    await decisions(b, 1, 200, false);
    verifyStats(report.transport.B, 202, 1);
    phase = 'terminateB';
    await terminate(b);
    checkpoint();
    if (checkAttribution().digest !== attribution.digest) throw new RestartError('attribution');
    checkpoint();
    report.result = 'completed';
    report.restartEvidence = mode === 'live' ? 'requires_review' : 'not_executed';
  } catch (error) {
    report.failure = failureCode(error);
    report.stoppedPhase = phase;
  } finally {
    let clean = true;
    for (const peer of peers) {
      if (!terminated.has(peer)) {
        try { await terminate(peer); } catch { clean = false; }
      }
      const stats = peer.getStats?.();
      if (stats) report.transport[peer.label] = stats;
    }
    clearTimeout(overallTimer);
    report.cleanup = clean ? 'confirmed' : 'unconfirmed';
    if (!clean) { report.result = 'stopped'; report.failure = 'cleanup'; report.restartEvidence = 'not_qualified'; }
    report.unvalidatedAttempts = report.attempted - report.validated;
    report.elapsedMs = now() - started;
    report.finishedAt = new Date().toISOString();
  }
  return report;
}

/** Defaults to an offline proposal; only the exact live acknowledgement set can start children. */
async function runCli(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 0) return { schemaVersion: 1, mode: 'prepare', scope: 'controlled_application_restart_only',
    gate1Status: 'open', restartEvidence: 'not_executed', limits: LIMITS,
    liveFlags: LIVE_FLAGS, requiredEnvironmentNames: ['GATE1_RESTART_LIVE_ALLOWED', ...SECRET_NAMES],
    requirement: 'Separate live approval; committed reviewed harness; existing approved database and unchanged HMAC',
    attribution: collectAttribution() };
  if (argv.length !== LIVE_FLAGS.length || LIVE_FLAGS.some((flag) => !argv.includes(flag))
    || env.GATE1_RESTART_LIVE_ALLOWED !== '1') throw new RestartError('configuration');
  const attribution = collectAttribution({ requireClean: true });
  // One reserved documentation-range fixture remains private and constant across A/B.
  const source = `2001:db8:${randomBytes(12).toString('hex').match(/.{4}/g).join(':')}`;
  const childEnv = freezeChildEnvironment(env, source);
  const controller = new AbortController();
  /** Cancels a trial on operator interruption; runTrial still confirms child cleanup. */
  function interrupt() { controller.abort(); }
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    return await runTrial({ mode: 'live', attribution, signal: controller.signal,
      checkAttribution: () => collectAttribution({ requireClean: true }),
      launch: (label, signal) => createPeer(label, childEnv, attribution.digest, signal) });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (require.main === module) {
  runCli().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.result === 'stopped') process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ result: 'stopped', failure: failureCode(error), gate1Status: 'open' })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { LIMITS, APP_FILES, HARNESS_FILES, LIVE_FLAGS, SECRET_NAMES, ROOT,
  collectAttribution, freezeChildEnvironment, createPeer, runTrial, runCli, verifyStats };
