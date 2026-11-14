'use strict';
/* global __dirname, process, Buffer, AbortController, setTimeout, clearTimeout */

/** Offline-default build attribution; live execution needs the frozen digest and an unused evidence destination. */
const fs = require('node:fs');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const provider = require('./provider-read-child.cjs');
const identification = require(path.join(provider.ROOT, '.tmp/gate1-rollback-tools/post-main-f3d6eade-attempt-2/identify-redeployment.cjs'));
const runtime = require(path.join(provider.ROOT, '.tmp/gate1-rollback-tools/runtime-9LmYSk5o-attempt-1/observe-runtime.cjs'));
const { ROOT, TARGET, LIMITS, z, ReadError } = provider;
const SOURCE = '.tmp/worktrees/gate1-production-canary-f3d6eade';
const DIRECTORY = '.tmp/gate1-rollback/replacement-9LmYSk5o-build-attribution-attempt-1';
const FILES = ['observe-build.cjs', 'provider-read-child.cjs', '__tests__/observe-build.test.cjs', '__tests__/provider-read-child.test.cjs'];
const RUNTIME_DIGEST = 'bc105c8f1507023ea4d7ee2da86e9f14f4b635a9a33b19fe719677554c32fe2d';
const LOCAL_PINS = Object.freeze({
  '.tmp/gate1-rollback/replacement-9LmYSk5o-runtime-attempt-1/profile.json': '7ad03e10e46cf7ac61152fe0c76951633035145b46ec459ba49e0014c63f00e7',
  '.tmp/gate1-rollback/replacement-9LmYSk5o-runtime-attempt-1/reservation.json': '0cc23bd1e7e8040efb89cf2628eff84e1037deafbe9e13f45c354a36feee2b25',
  '.tmp/gate1-rollback/replacement-9LmYSk5o-runtime-attempt-1/report.json': '779572acf5c85d11c89ff94a923ddfda7058107a3f0d0710e2512a4db3e6ffd8',
});
const PROFILE = Object.freeze({ schemaVersion: 1, scope: 'bounded_build_attribution_only', target: TARGET,
  reviewedSource: SOURCE, operator: 'Codex', operationalOwner: 'Will',
  runtimeEvidence: { packageDigest: RUNTIME_DIGEST, nodeVersion: 'v22.23.5', isMainThread: true,
    scope: 'two_recorded_session_executions_only', observedAt: '2026-11-14T17:51:56.912Z' },
  sourceLockVersions: provider.VERSIONS, expectedNodeMajor: 22, sourceNodeEngine: '22.x',
  limits: { providerReads: 5, applicationRequests: 2, concurrency: 1, overallMs: 120000,
    providerMs: LIMITS.providerMs, childMs: LIMITS.childMs, applicationMs: 10000,
    responseBytes: LIMITS.responseBytes, headerBytes: LIMITS.headerBytes, ipcBytes: LIMITS.ipcBytes,
    discardedOutputBytes: LIMITS.outputBytes, reportBytes: 262144,
    events: LIMITS.events, eventTextBytes: LIMITS.eventTextBytes, lines: LIMITS.lines,
    builds: LIMITS.builds, outputs: LIMITS.outputs, routes: LIMITS.routes },
  sequence: ['alias_before', 'login_before', 'deployment', 'builds', 'events', 'login_after', 'alias_after'],
  providerOperations: Object.fromEntries(['alias_before', 'deployment', 'builds', 'events', 'alias_after'].map((phase) =>
    [phase, provider.operation({ phase, deploymentId: TARGET.deploymentId })])),
  applicationURL: `https://${TARGET.hostname}/login`,
  evidenceDirectory: DIRECTORY, evidenceFiles: ['profile.json', 'reservation.json', 'report.json'],
  noRetries: true, noRedirects: true, noAuthRefresh: true, noPagination: true, noStreaming: true,
  noCookiesSent: true, noPrivateInput: true,
  localEffects: ['exclusive three-file evidence reservation and sanitized checkpoints',
    'normal CLI device/session metadata writes; telemetry uploads disabled'],
  applicationEffects: ['two anonymous login GETs; normal logging and applicable limiter accounting; cookies discarded'],
  success: 'all seven phases validated on pinned target; bounded observations retained with explicit gaps; not Gate 1 qualification',
  stop: ['identity/build/alias drift', 'contradictory versions', 'invalid or capped metadata', 'HTTP or authentication failure',
    'budget/deadline/protocol failure', 'source/dependency drift', 'checkpoint failure or existing evidence'],
  limitations: ['source lock is not an installed-version observation', 'build logs are claims in a bounded sample',
    'provider routing/output summaries are not exact manifests', 'function runtime metadata is not execution proof',
    'sampled aliases do not exclude intervening routing changes', 'dispatch receipts are not a physical HTTP audit'],
  exclusions: ['runtime probe', 'fixture refresh', 'deployment', 'routing/configuration change', 'restart', 'rollback',
    'build/install', 'artifact scan', 'secret rotation', 'gate approval'],
  references: ['https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url',
    'https://vercel.com/docs/rest-api/deployments/get-deployment-events',
    'pinned Vercel 62.2.0 commands-bulk.js inspect: /v11/deployments/{id}/builds'],
});
const EXTRA_CODES = ['arguments', 'approval', 'source_changed', 'evidence_exists', 'checkpoint', 'overall_deadline',
  'identity_mismatch', 'alias_drift', 'login_contract', 'application_transport', 'cancelled'];
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

/** Check Git identity/cleanliness with the already reviewed read-only implementation. */
function verifySource() { identification.verifySource(); }

/** Inventory only tracked page/config/package sources; no env files, build artifact traversal or code execution. */
function sourceInventory() {
  verifySource();
  let files;
  try {
    files = execFileSync('git', ['-C', SOURCE, 'ls-files', '-z', '--', 'src/pages', 'src/middleware.js',
      'next.config.js', 'package.json', 'package-lock.json'], { cwd: ROOT, encoding: 'utf8', timeout: 10000,
      maxBuffer: 65536, windowsHide: true, env: { ...provider.childEnvironment(), GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean).sort();
  } catch { stop('source_changed'); }
  if (!files.length || files.length > 256 || files.some((file) => !/^(?:src\/pages\/[A-Za-z0-9_/[\]-]+\.js|src\/middleware\.js|next\.config\.js|package(?:-lock)?\.json)$/.test(file))) stop('source_changed');
  const entries = files.map((file) => {
    const location = path.join(ROOT, SOURCE, file);
    const stat = fs.lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4194304) stop('source_changed');
    return { file, sha256: hash(fs.readFileSync(location)) };
  });
  const pages = files.filter((file) => file.startsWith('src/pages/'));
  const routes = pages.map((file) => {
    const route = file.slice('src/pages'.length, -3);
    return route === '/index' ? '/' : route.replace(/\/index$/, '');
  }).sort();
  if (JSON.stringify(routes) !== JSON.stringify([...provider.ROUTES].sort())) stop('source_changed');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, SOURCE, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, SOURCE, 'package-lock.json'), 'utf8'));
  if (pkg.engines?.node !== '22.x') stop('source_changed');
  for (const [name, expected] of Object.entries(provider.VERSIONS)) {
    if (lock.packages?.[`node_modules/${name}`]?.version !== expected) stop('source_changed');
  }
  return { basis: 'tracked_source_only_not_built_manifests', entries, routes,
    currentLocalNextExists: fs.existsSync(path.join(ROOT, SOURCE, '.next')),
    currentLocalBuildOutputExists: fs.existsSync(path.join(ROOT, SOURCE, '.vercel/output')) };
}

/** Recheck frozen upstream packages/evidence and current source; hash only the four approved new files. */
function preparation() {
  provider.verifyPins();
  const runtimeManifest = runtime.preparation();
  if (runtimeManifest.packageDigest !== RUNTIME_DIGEST) stop('dependency_changed');
  for (const [file, expected] of Object.entries(LOCAL_PINS)) {
    if (hash(fs.readFileSync(path.join(ROOT, file))) !== expected) stop('dependency_changed');
  }
  const inventory = sourceInventory();
  const components = Object.fromEntries(FILES.map((file) => [file, hash(fs.readFileSync(path.join(__dirname, file)))]));
  const manifest = { profile: PROFILE, components, localDependencies: LOCAL_PINS, cliDependencies: provider.PINS,
    runtimeManifest, sourceInventory: inventory, reviewWorkspace: ROOT, localNodeVersion: process.version };
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
            onDispatch();
          } else {
            if (receipt) throw new ReadError('child_protocol');
            receipt = provider.parse(receiptSchema, message, 'child_protocol');
            if (receipt.nativeFetchCalls !== announced) throw new ReadError('child_protocol');
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

/** Reconcile sanitized samples conservatively: every absent fact remains a named gap, including exact manifests. */
function assess(observations) {
  const deployment = observations.find((item) => item.phase === 'deployment').metadata;
  const builds = observations.find((item) => item.phase === 'builds').metadata;
  const events = observations.find((item) => item.phase === 'events').metadata;
  const gaps = ['exact_local_deployed_manifest_comparison_unqualified', 'all_route_execution_smoke_not_performed',
    'complete_installed_dependency_inventory_unqualified', 'build_log_completeness_unqualified',
    'complete_function_and_middleware_attribution_unqualified'];
  for (const [name, value] of Object.entries(events.versions)) if (value === null) gaps.push(`build_version_${name}_unobserved`);
  if (!deployment.routes.available) gaps.push('provider_routes_missing');
  if (deployment.routes.unrecognizedDestinations) gaps.push('provider_route_destinations_not_allowlisted');
  if (!builds.available || builds.buildCount === 0 || builds.outputCount === 0) gaps.push('provider_build_outputs_missing');
  if (builds.missingOutputLists) gaps.push('provider_build_outputs_incomplete');
  if (builds.unrecognizedOutputs) gaps.push('provider_output_paths_not_allowlisted');
  if (builds.outputs.some((item) => ['missing', 'other'].includes(item.runtime))) gaps.push('provider_output_runtime_incomplete');
  if (events.unrecognizedRouteRows) gaps.push('build_route_table_rows_not_allowlisted');
  if (!events.routeTable.length) gaps.push('build_route_table_unobserved');
  return { sourceLockVersions: provider.VERSIONS, buildLogVersionClaims: events.versions,
    exactManifestComparison: 'unqualified', gaps };
}

/** Execute one fixed sequential sample using injected transports; tests never need live credentials or networking. */
async function runWithAdapters(manifest, deps) {
  const now = deps.now || (() => performance.now());
  const start = now();
  const report = { schemaVersion: 1, scope: PROFILE.scope, mode: deps.mode || 'offline_fixture',
    result: 'running', packageDigest: manifest.packageDigest, startedAt: new Date().toISOString(), phase: 'reserved',
    providerAttempts: 0, providerDispatchAnnouncements: 0, applicationAttempts: 0, observations: [], failure: null,
    gate1Status: 'open', gate5aStatus: 'unpassed', rollbackExecuted: false, runtimeProbeExecuted: false,
    accounting: 'dispatch announcements are not an independent physical HTTP audit' };
  const controller = new AbortController();
  let rejectDeadline;
  const deadline = new Promise((resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectDeadline(Object.assign(new Error('overall_deadline'), { code: 'overall_deadline' })); }, PROFILE.limits.overallMs);
  let checkpointBroken = false;
  /** Test monotonic bounds before and after each operation, including deterministic test clocks. */
  function remaining() {
    const left = PROFILE.limits.overallMs - (now() - start);
    if (controller.signal.aborted || left <= 0) stop('overall_deadline');
    return left;
  }
  /** Persist sanitized state before another operation; checkpoint failure is terminal, with no save retry. */
  function save() {
    try { deps.save(report); } catch { checkpointBroken = true; stop('checkpoint'); }
  }
  /** Append only already validated metadata, never a raw provider/application response. */
  function observe(metadata) { report.observations.push({ phase: report.phase, observedAt: new Date().toISOString(), metadata }); save(); }
  /** Dispatch one provider child; require exactly one announcement and reject late/duplicate announcements. */
  async function read(phase) {
    remaining(); report.phase = phase;
    if (++report.providerAttempts > PROFILE.limits.providerReads) stop('request_budget');
    save();
    let announcements = 0;
    const metadata = await Promise.race([deps.provider(phase, TARGET.deploymentId,
      Math.min(LIMITS.childMs, remaining()), controller.signal, () => {
        remaining();
        if (++announcements !== 1) stop('request_budget');
        report.providerDispatchAnnouncements++; save();
      }), deadline]);
    remaining();
    if (announcements !== 1) stop('child_protocol');
    const safe = provider.validateMetadata(phase, metadata);
    if (phase.startsWith('alias_') && (safe.deploymentId !== TARGET.deploymentId || safe.updatedAt !== TARGET.aliasUpdatedAt)) stop('alias_drift');
    if (phase === 'deployment' && (safe.identity.deploymentId !== TARGET.deploymentId || safe.identity.gitSha !== TARGET.gitSha
      || safe.identity.immutableHostname !== TARGET.immutableHostname || safe.identity.readyAt < safe.identity.createdAt)) stop('identity_mismatch');
    if (phase === 'events') {
      for (const [name, value] of Object.entries(safe.versions)) {
        if (value !== null && ((provider.VERSIONS[name] && provider.VERSIONS[name] !== value)
          || (name === 'node' && value.split('.')[0] !== '22'))) stop('attribution_conflict');
      }
    }
    observe(safe); return safe;
  }
  /** Perform exactly one anonymous login GET and retain only the pinned, validated build ID. */
  async function login(phase) {
    remaining(); report.phase = phase;
    if (++report.applicationAttempts > PROFILE.limits.applicationRequests) stop('request_budget');
    save();
    const response = await Promise.race([deps.login(controller.signal, Math.min(PROFILE.limits.applicationMs, remaining())), deadline]);
    remaining();
    if (deps.loginBuild(response) !== TARGET.buildId) stop('login_contract');
    observe({ status: 200, buildId: TARGET.buildId, responseCookies: 'discarded' });
  }
  try {
    save();
    const before = await read('alias_before');
    await login('login_before');
    await read('deployment');
    await read('builds');
    await read('events');
    await login('login_after');
    const after = await read('alias_after');
    if (JSON.stringify(before) !== JSON.stringify(after)) stop('alias_drift');
    report.attribution = assess(report.observations);
    report.result = 'observed_with_gaps';
  } catch (error) { report.result = 'stopped'; report.failure = failureCode(error); }
  finally { clearTimeout(timer); controller.abort(); }
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
    const loginTransport = services.loginTransport || identification.reviewedLogin();
    sink = (services.reserve || reserve)(manifest, fs, reservation);
    const report = await runWithAdapters(manifest, { mode: 'live', provider: services.provider || readProvider,
      save: sink.save, ...loginTransport });
    output(report);
    return report.result === 'observed_with_gaps' ? 0 : 1;
  } catch (error) {
    output({ result: 'stopped', failure: failureCode(error), gate1Status: 'open', gate5aStatus: 'unpassed',
      evidenceMayExist: reservation.evidenceMayExist, rollbackExecuted: false });
    return 1;
  } finally { if (sink) { try { sink.close(); } catch { /* Preserve the reservation and never retry. */ } } }
}

module.exports = { PROFILE, FILES, LOCAL_PINS, preparation, sourceInventory, verifySource, reserve, readProvider,
  assess, runWithAdapters, failureCode, hash, main };
if (require.main === module) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
