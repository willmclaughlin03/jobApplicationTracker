'use strict';
/* global __dirname, process, Buffer, AbortController, setTimeout, clearTimeout */

/** Offline-default conflict diagnostic; only an exact separately approved digest can reserve a live attempt. */
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const provider = require('./provider-read-child.cjs');
const { ROOT, TARGET, LIMITS, z, ReadError } = provider;
const UPSTREAM_FILE = '.tmp/gate1-rollback-tools/build-attribution-49owz1V7-attempt-1/observe-build.cjs';
const SOURCE = '.tmp/worktrees/gate1-production-canary-50c4a957';
const DIRECTORY = '.tmp/gate1-rollback/replacement-49owz1V7-build-conflict-attempt-1';
const PRIOR_DIRECTORY = '.tmp/gate1-rollback/replacement-49owz1V7-build-attribution-attempt-1';
const PRIOR_DIGEST = 'f5ca16f68d6d6620524dfb37d59d52693fcb06c546cb6f168328c7b4e2aac714';
const FILES = ['README.md', 'diagnose-builds.cjs', 'provider-read-child.cjs',
  '__tests__/diagnose-builds.test.cjs', '__tests__/provider-read-child.test.cjs'];
const LOCAL_PINS = Object.freeze({
  [UPSTREAM_FILE]: '18e9ae7dbb45e03d664da99f5e5be8aafd5f0a40c5dbd9777ecc398aaa72ac78',
  [PRIOR_DIRECTORY + '/profile.json']: 'b51dad8b31467eb732121c2c743536eca27c0f730ceab530ece5611986512ebe',
  [PRIOR_DIRECTORY + '/reservation.json']: 'ef9db7f9f06febdbd25dd86c15a2aeb2b0fc04db51ff101dff98e99e6d6ca232',
  [PRIOR_DIRECTORY + '/report.json']: '10a43f54fe091760119e724939793971fb3819656dd692cf61686686e60a90c3',
});
// Bind the observer to its preserved manifest hash before its module body can execute.
if (hash(fs.readFileSync(path.join(ROOT, UPSTREAM_FILE))) !== LOCAL_PINS[UPSTREAM_FILE]) stop('dependency_changed');
const upstream = require(path.join(ROOT, UPSTREAM_FILE));
const PROFILE = Object.freeze({ schemaVersion: 1, scope: 'single_build_conflict_diagnostic_only', target: TARGET,
  reviewedSource: SOURCE, operator: 'Codex', operationalOwner: 'Will',
  priorAttempt: { evidenceDirectory: PRIOR_DIRECTORY, packageDigest: PRIOR_DIGEST,
    result: 'stopped', phase: 'builds', failure: 'attribution_conflict',
    finishedAt: '2026-11-15T23:12:08.200Z', disposition: 'consumed_no_replay',
    providerAttempts: 3, providerDispatchAnnouncements: 3, applicationAttempts: 1 },
  identificationEvidence: upstream.PROFILE.identificationEvidence,
  currentRuntime: upstream.PROFILE.currentRuntime,
  expectedNodeMajor: 22, sourceNodeEngine: '22.x',
  limits: { providerReads: 1, applicationRequests: 0, concurrency: 1, overallMs: 45000,
    providerMs: LIMITS.providerMs, childMs: LIMITS.childMs,
    responseBytes: LIMITS.responseBytes, headerBytes: LIMITS.headerBytes, ipcBytes: LIMITS.ipcBytes,
    discardedOutputBytes: LIMITS.outputBytes, reportBytes: 262144, builds: LIMITS.builds, outputs: LIMITS.outputs },
  sequence: ['builds'],
  providerOperations: { builds: provider.operation({ phase: 'builds', deploymentId: TARGET.deploymentId }) },
  evidenceDirectory: DIRECTORY, evidenceFiles: ['profile.json', 'reservation.json', 'report.json'],
  permittedMetadata: { classifications: ['conflict_identified', 'not_reproduced'], reasons: provider.REASONS,
    nodeMajors: 'zero slots for identity reasons; two nullable integers 0..999 for runtime reasons',
    nodeMajorSlotOrderByReason: provider.SLOT_ORDER_BY_REASON,
    outputClassifications: provider.OUTPUT_CLASSIFICATIONS,
    outputClassificationBasis: 'exact pinned route allowlist or _middleware spelling; never output.type alone',
    qualification: 'unqualified_metadata_only', historicalCause: 'not_proven_same_response' },
  noRetries: true, noRedirects: true, noAuthRefresh: true, noPagination: true, noStreaming: true,
  noCookiesSent: true, noPrivateInput: true,
  localEffects: ['exclusive three-file evidence reservation and sanitized checkpoints',
    'normal CLI device/session metadata writes; telemetry uploads disabled'],
  applicationEffects: [],
  success: 'one bounded metadata read yields a fixed classification; no qualification pass',
  conflictDisposition: 'stop with attribution_conflict and the fixed reason; return to owner decision',
  noConflictDisposition: 'inconclusive; historical cause remains unknown; no automatic retry or continuation',
  firmStoppingPoint: 'if application issue versus evidence-method limitation remains indistinguishable, return for a specific owner correction or qualification decision',
  runtimeFollowup: 'if identity remains sound, propose separately approved target-bound runtime verification; no automatic execution',
  stop: ['authentication/HTTP/transport failure', 'invalid/capped metadata', 'budget/deadline/protocol failure',
    'source/dependency drift', 'checkpoint failure or existing evidence'],
  limitations: ['fresh response cannot prove the cause of the discarded historical response',
    'no current alias or login bracket', 'no deployment metadata refresh',
    'function runtime metadata is not execution proof', 'no manifest or all-route qualification',
    'known-route classification is not execution proof; unrecognized output is not presumed harmless',
    'absent identity fields are not positive attribution; no fresh alias/deployment bracket is collected',
    'dispatch receipts are not an independent physical HTTP audit'],
  exclusions: ['application requests', 'event reads', 'runtime probe', 'fixture refresh', 'deployment',
    'routing/configuration change', 'restart', 'rollback', 'build/install', 'secret rotation', 'gate approval'],
});
const EXTRA_CODES = ['arguments', 'approval', 'source_changed', 'evidence_exists', 'checkpoint', 'overall_deadline', 'cancelled'];
const receiptSchema = z.object({ type: z.literal('receipt'), schemaVersion: z.literal(1),
  result: z.enum(['read', 'stopped']), failure: z.enum(provider.CODES).nullable(),
  nativeFetchCalls: z.number().int().min(0).max(1), adapterCalls: z.number().int().min(0).max(1),
  suppressedUserLookups: z.number().int().min(0).max(10), status: z.number().int().min(100).max(599).nullable(),
  cliExitCode: z.number().int().min(0).max(255).nullable(), metadata: z.unknown() }).strict();

/** Keep untrusted exceptions out of stdout/evidence; only the fixed shared vocabulary can leave this process. */
function failureCode(error) { return [...provider.CODES, ...EXTRA_CODES].includes(error?.code) ? error.code : 'internal'; }

/** Throw a sanitized local failure that the runner can classify without retaining payload text. */
function stop(code) { const error = new Error(code); error.code = code; throw error; }

/** Hash public source and approved evidence bytes for immutable package attribution; never hash credentials. */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }


/** Check the same clean source identity through the pinned upstream package without hosted I/O. */
function verifySource() { upstream.verifySource(); }

/** Bind the consumed attempt, exact upstream package/dependencies and all five approved files before any effects. */
function preparation() {
  provider.verifyPins();
  for (const [file, expected] of Object.entries(LOCAL_PINS)) {
    if (hash(fs.readFileSync(path.join(ROOT, file))) !== expected) stop('dependency_changed');
  }
  const upstreamManifest = upstream.preparation();
  if (upstreamManifest.packageDigest !== PRIOR_DIGEST) stop('dependency_changed');
  if (JSON.stringify(upstreamManifest.profile.target) !== JSON.stringify(TARGET)) stop('dependency_changed');
  const components = Object.fromEntries(FILES.map((file) => [file, hash(fs.readFileSync(path.join(__dirname, file)))]));
  const manifest = { profile: PROFILE, components, localDependencies: LOCAL_PINS, cliDependencies: provider.PINS,
    upstreamManifest, reviewWorkspace: ROOT, packageDirectory: __dirname, localNodeVersion: process.version };
  return { ...manifest, packageDigest: hash(JSON.stringify(manifest)) };
}

/** Reserve fresh evidence without reusing/deleting it; latch directory presence in reservation before file writes. */
function reserve(manifest, io = fs, reservation = {}) {
  const dir = path.join(ROOT, DIRECTORY);
  let reportFd;
  try { io.mkdirSync(dir); reservation.evidenceMayExist = true; }
  catch (error) {
    if (error.code === 'EEXIST') reservation.evidenceMayExist = true;
    stop(error.code === 'EEXIST' ? 'evidence_exists' : 'checkpoint');
  }
  try {
    io.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    io.writeFileSync(path.join(dir, 'reservation.json'), JSON.stringify({ schemaVersion: 1,
      packageDigest: manifest.packageDigest, reservedAt: new Date().toISOString(), state: 'reserved_no_replay' }, null, 2) + '\n', { flag: 'wx' });
    reportFd = io.openSync(path.join(dir, 'report.json'), 'wx');
  } catch { stop('checkpoint'); }
  return {
    /** Flush each sanitized checkpoint before another dispatch can begin. */
    save(report) {
      try {
        const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
        if (bytes.length > PROFILE.limits.reportBytes) stop('checkpoint');
        io.ftruncateSync(reportFd, 0);
        let written = 0;
        while (written < bytes.length) {
          const count = io.writeSync(reportFd, bytes, written, bytes.length - written, written);
          if (count <= 0) stop('checkpoint');
          written += count;
        }
        io.fsyncSync(reportFd);
      } catch { stop('checkpoint'); }
    },
    /** Close the report handle without altering the reservation. */
    close() { io.closeSync(reportFd); },
  };
}

/** Run one hidden provider child and validate its strictly bounded dispatch/terminal receipts. */
function readProvider(phase, deploymentId, timeoutMs, signal, onDispatch, forkImpl = fork) {
  provider.operation({ phase, deploymentId });
  return new Promise((resolve, reject) => {
    let child, timer, receipt, messages = 0, announced = 0, done = false, outputBytes = 0;
    /** Tear down listeners/timers and kill an uncertain child on any failed boundary. */
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) child?.kill();
      error ? reject(error) : resolve(value);
    }
    /** Stop the child when the parent deadline or cancellation is reached. */
    function abort() { finish(new ReadError('child_timeout')); }
    /** Consume no CLI text. Even unexpected output is counted and discarded. */
    function discard(bytes) {
      outputBytes += bytes.length;
      if (outputBytes > LIMITS.outputBytes) finish(new ReadError('output_limit'));
    }
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, timeoutMs);
    try {
      child = forkImpl(path.join(__dirname, 'provider-read-child.cjs'), ['--read', phase, deploymentId || '-'], {
        cwd: path.join(ROOT, SOURCE), env: provider.childEnvironment(), execArgv: [], windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json' });
      child.stdout.on('data', discard);
      child.stderr.on('data', discard);
      child.on('error', () => finish(new ReadError('child_failed')));
      child.on('message', (message) => {
        if (done) return;
        try {
          if (++messages > 2 || Buffer.byteLength(JSON.stringify(message)) > LIMITS.ipcBytes) throw new ReadError('child_protocol');
          if (message?.type === 'dispatch') {
            if (receipt || announced || Object.keys(message).length !== 1) throw new ReadError('child_protocol');
            announced++;
            // Parent checkpoint/deadline failures use a broader allowlist than untrusted child messages.
            try { onDispatch(); }
            catch (error) {
              const code = failureCode(error);
              finish(Object.assign(new Error(code), { code }));
            }
          } else {
            if (receipt) throw new ReadError('child_protocol');
            receipt = provider.parse(receiptSchema, message, 'child_protocol');
            if (receipt.nativeFetchCalls !== announced || receipt.nativeFetchCalls > receipt.adapterCalls
              || (receipt.nativeFetchCalls === 0 && receipt.status !== null)) throw new ReadError('child_protocol');
            if (receipt.result === 'read') {
              if (receipt.failure || receipt.status !== 200 || announced !== 1 || receipt.adapterCalls !== 1 || receipt.cliExitCode !== 0) {
                throw new ReadError('child_protocol');
              }
              receipt.metadata = provider.validateMetadata(phase, receipt.metadata);
            } else if (!receipt.failure || receipt.metadata !== null) throw new ReadError('child_protocol');
          }
        } catch (error) { finish(error instanceof ReadError ? error : new ReadError('child_protocol')); }
      });
      child.on('close', (code) => {
        if (done) return;
        if (!receipt) { finish(new ReadError('child_failed')); return; }
        if (receipt.failure) {
          const error = new ReadError(receipt.failure);
          error.providerFacts = { schemaVersion: receipt.schemaVersion, result: receipt.result, failure: receipt.failure,
            nativeFetchCalls: receipt.nativeFetchCalls, adapterCalls: receipt.adapterCalls,
            suppressedUserLookups: receipt.suppressedUserLookups, status: receipt.status, cliExitCode: receipt.cliExitCode };
          finish(error); return;
        }
        if (code !== 0) { finish(new ReadError('child_failed')); return; }
        finish(null, receipt.metadata);
      });
    } catch { finish(new ReadError('child_failed')); }
  });
}


/** Execute only one builds read with injected adapters; retain sanitized diagnosis without qualifying any gate. */
async function runWithAdapters(manifest, deps) {
  const now = deps.now || (() => performance.now());
  const start = now();
  const report = { schemaVersion: 1, scope: PROFILE.scope, mode: deps.mode || 'offline_fixture',
    result: 'running', packageDigest: manifest.packageDigest, startedAt: new Date().toISOString(), phase: 'reserved',
    providerAttempts: 0, providerDispatchAnnouncements: 0, applicationAttempts: 0, observations: [], failure: null,
    gate1Status: 'open', gate5aStatus: 'unpassed', rollbackExecuted: false, runtimeProbeExecuted: false,
    currentRuntime: PROFILE.currentRuntime, exactManifestComparison: 'unqualified',
    historicalCause: 'unknown_fresh_sample_cannot_establish_prior_response',
    accounting: 'dispatch announcements are not an independent physical HTTP audit' };
  const controller = new AbortController();
  let rejectDeadline, checkpointBroken = false, acceptingDispatch = true;
  const deadline = new Promise((resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(Object.assign(new Error('overall_deadline'), { code: 'overall_deadline' }));
  }, PROFILE.limits.overallMs);
  /** Enforce monotonic bounds both before dispatch and after receiving the one permitted observation. */
  function remaining() {
    const left = PROFILE.limits.overallMs - (now() - start);
    if (controller.signal.aborted || left <= 0) stop('overall_deadline');
    return left;
  }
  /** A failed evidence checkpoint is terminal; never retry that write or allow another dispatch. */
  function save() {
    try { deps.save(report); } catch { checkpointBroken = true; acceptingDispatch = false; stop('checkpoint'); }
  }
  try {
    save(); remaining(); report.phase = 'builds';
    if (++report.providerAttempts > PROFILE.limits.providerReads) stop('request_budget');
    save();
    let announcements = 0;
    const metadata = await Promise.race([deps.provider('builds', TARGET.deploymentId,
      Math.min(LIMITS.childMs, remaining()), controller.signal, () => {
        if (!acceptingDispatch) stop('request_budget');
        remaining();
        if (++announcements !== 1) stop('request_budget');
        report.providerDispatchAnnouncements++; save();
      }), deadline]);
    acceptingDispatch = false; remaining();
    if (announcements !== 1) stop('child_protocol');
    const safe = provider.validateMetadata('builds', metadata);
    report.observations.push({ phase: 'builds', observedAt: new Date().toISOString(), metadata: safe });
    save();
    if (safe.classification === 'conflict_identified') {
      report.result = 'stopped'; report.failure = 'attribution_conflict';
    } else report.result = 'inconclusive';
  } catch (error) { report.result = 'stopped'; report.failure = failureCode(error); }
  finally { acceptingDispatch = false; clearTimeout(timer); controller.abort(); }
  report.elapsedMs = Math.ceil(now() - start); report.finishedAt = new Date().toISOString();
  if (!checkpointBroken) {
    try { save(); } catch { report.result = 'stopped'; report.failure = 'checkpoint'; }
  }
  return report;
}

/** Default invocation is preparation only; wrong authorization cannot reserve evidence or invoke a transport. */
async function main(args, services = {}) {
  let sink;
  const reservation = { evidenceMayExist: false };
  const prepare = services.prepare || preparation;
  const output = services.output || ((value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n'));
  try {
    reservation.evidenceMayExist = fs.existsSync(path.join(ROOT, DIRECTORY));
    if (!(args.length === 0 || (args.length === 1 && args[0] === '--prepare')
      || (args.length === 2 && args[0] === '--execute' && /^[a-f0-9]{64}$/.test(args[1])))) stop('arguments');
    const manifest = prepare();
    if (args[0] !== '--execute') { output({ mode: 'prepare', liveExecuted: false, ...manifest }); return 0; }
    if (args[1] !== manifest.packageDigest) stop('approval');
    (services.verifySource || verifySource)();
    sink = (services.reserve || reserve)(manifest, fs, reservation);
    const report = await runWithAdapters(manifest, { mode: 'live', provider: services.provider || readProvider,
      save: sink.save });
    output(report);
    // A diagnostic never exits as a qualification pass, including when no conflict recurs.
    return 1;
  } catch (error) {
    output({ result: 'stopped', failure: failureCode(error), gate1Status: 'open', gate5aStatus: 'unpassed',
      evidenceMayExist: reservation.evidenceMayExist, rollbackExecuted: false });
    return 1;
  } finally { if (sink) { try { sink.close(); } catch { /* Preserve the reservation and never retry. */ } } }
}

module.exports = { PROFILE, FILES, LOCAL_PINS, preparation, verifySource, reserve, readProvider,
  runWithAdapters, failureCode, hash, main };
if (require.main === module) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
