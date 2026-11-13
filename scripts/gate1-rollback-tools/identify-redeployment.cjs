'use strict';
/* global __dirname, Buffer, process, AbortController, setTimeout, clearTimeout */

/** Offline by default. A separately approved digest unlocks one bounded, non-replayable identification. */
const fs = require('node:fs');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const provider = require('./provider-read-child.cjs');
const { ROOT, CLI, ZOD_PIN, ZOD_ENTRY, z, TARGET, LIMITS, PINS, ReadError } = provider;
const SOURCE = '.tmp/worktrees/gate1-production-canary-f3c62a4d';
const GIT_SHA = 'f3c62a4d221fa39e920c0b5faecb61f1add7bab4';
const PREVIOUS = 'dpl_Hd8Lta3bGKjjhDwMkNfTQxazBZax';
const DIRECTORY = '.tmp/gate1-rollback/secret-redeploy-identification-attempt-1';
const FILES = ['identify-redeployment.cjs', 'provider-read-child.cjs',
  '__tests__/identify-redeployment.test.cjs', '__tests__/provider-read-child.test.cjs'];
const LOCAL_PINS = Object.freeze({
  'AGENTS.md': 'e3fa0d864535b53b4792ce2c322e8ee682569f1359f593b9c670eb54de749699',
  'docs/UIDesign/gate1-source-waf-evidence-amendment.md': '236292678c7110bdaba75aef8a0b27fe953a93a22345b7cfb407a00c34462f02',
  'docs/UIDesign/gate1-preproduction-continuation-amendment.md': '63db498d0fa05180d98da193d90b97eb64ab0de5c5cff9fbf6c00830b31d0395',
  'docs/UIDesign/error-pages-auth-correctness-remediation-plan.md': '4120e505e7d5c7c21c9b011a2b9b53665fdb7e249c96c884eaeeab0787eba64f',
  [`${SOURCE}/scripts/gate1-host-protection.js`]: '28530a121c834ed4cb8c68310ac6facc0d82f07ede4e1cdf35d76b7be1209e8b',
  [`${SOURCE}/scripts/gate1-shared-ip-load.js`]: '77afa409a05702b0782c1ebf7b7ebb044a31244ced0810cd6734432d2a699e4b',
  [`${SOURCE}/scripts/gate0-auth-evidence.js`]: 'b1e14a6c0ed25b611cb803a7d7600f39b474898b393c22da41b5432efec9b2a3',
  [`${SOURCE}/package-lock.json`]: 'eaed6549900522ba1d4a17891d180189f98c9cdad828137a597a69c272ba977b',
  '.tmp/gate1-rollback/canonical-redeployment-post-login-attempt-2/report.json': '65af70c6c42e54d48d5587b4a4cbac18e938eed52b137f3c93d66256e7693c3e',
  '.tmp/gate1-rollback/replacement-Hd8Lta3b-fixture-attempt-1/fixture-readiness.json': 'a5056af3dd32ec302ad59d79b870492d443f6fd15ced8796352ffa5edcc7417a',
  [ZOD_PIN.file]: ZOD_PIN.sha256,
});
const PROFILE = Object.freeze({ schemaVersion: 1, scope: 'canonical_secret_redeployment_identification_only',
  ...TARGET, previousDeploymentId: PREVIOUS, reviewedGitSha: GIT_SHA, reviewedSource: SOURCE,
  ownerAttestations: { basis: 'owner_reported_not_provider_verified', canonicalProductionRedeployed: true,
    onlyChangedSetting: 'GATE1_RESTART_PROBE_SECRET', restartProbeEnabled: true, matchingSecretSavedPrivately: true,
    otherChangesSinceSuccessfulFixture: 'none' },
  operator: 'Codex', operationalOwner: 'Will',
  limits: { providerReads: 4, applicationRequests: 1, concurrency: 1, overallMs: 120000,
    providerMs: LIMITS.providerMs, childMs: LIMITS.childMs, applicationMs: 10000,
    responseBytes: LIMITS.responseBytes, headerBytes: LIMITS.headerBytes, reportBytes: 32768 },
  sequence: ['alias_before', 'deployment', 'project', 'login', 'alias_after'],
  evidenceDirectory: DIRECTORY, evidenceFiles: ['profile.json', 'reservation.json', 'report.json'],
  noRetries: true, noRedirects: true, noCredentialEntry: true, noAuthRefresh: true,
  localEffects: ['exclusive evidence creation and sanitized checkpoints', 'normal CLI device/session metadata writes; telemetry uploads disabled'],
  applicationEffects: ['one anonymous login GET; normal logging and applicable limiter accounting; cookies discarded'],
  conclusionScope: 'sampled canonical deployment/source/build correspondence only',
  exclusions: ['runtime probe', 'fixture exercise', 'deployment', 'routing', 'rollback', 'gate approval'],
});
const EXTRA_CODES = ['approval', 'source_changed', 'evidence_exists', 'checkpoint', 'overall_deadline',
  'deployment_not_replaced', 'source_mismatch', 'identity_mismatch', 'routing_unsettled', 'alias_drift',
  'login_contract', 'application_transport', 'cancelled'];
const receiptSchema = z.object({ type: z.literal('receipt'), schemaVersion: z.literal(1),
  result: z.enum(['read', 'stopped']), failure: z.enum(provider.CODES).nullable(),
  nativeFetchCalls: z.number().int().min(0).max(1), adapterCalls: z.number().int().min(0).max(1),
  suppressedUserLookups: z.number().int().min(0).max(10), status: z.number().int().min(100).max(599).nullable(),
  cliExitCode: z.number().int().min(0).max(255).nullable(), metadata: z.unknown() }).strict();

/** Normalize all evidence failures to fixed codes, discarding external exceptions and payloads. */
function failureCode(error) {
  return [...provider.CODES, ...EXTRA_CODES].includes(error?.code) ? error.code : 'internal';
}

/** Throw an allowlisted parent failure, carrying no arbitrary messages or cause. */
function stop(code) { const error = new Error(code); error.code = code; throw error; }

/** Hash public source/evidence bytes. This function must never receive a credential. */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** Verify pinned local dependencies and freeze exact runner/test bytes into the approval digest. */
function preparation() {
  provider.verifyPins();
  for (const [file, expected] of Object.entries(LOCAL_PINS)) {
    if (hash(fs.readFileSync(path.join(ROOT, file))) !== expected) stop('dependency_changed');
  }
  const components = Object.fromEntries(FILES.map((file) => [file, hash(fs.readFileSync(path.join(__dirname, file)))]));
  const manifest = { profile: PROFILE, components, localDependencies: LOCAL_PINS, cliDependencies: PINS,
    reviewWorkspace: ROOT, validatorEntry: ZOD_ENTRY, cliDirectory: CLI, cliVersion: '62.2.0', localNodeVersion: process.version };
  return { ...manifest, packageDigest: hash(JSON.stringify(manifest)) };
}

/** Recheck source cleanliness using Git without locks or writes, immediately before evidence reservation. */
function verifySource() {
  const options = { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536,
    env: { ...provider.childEnvironment(), GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    const head = execFileSync('git', ['-C', SOURCE, 'rev-parse', 'HEAD'], options).trim();
    const status = execFileSync('git', ['-C', SOURCE, 'status', '--porcelain', '--untracked-files=normal'], options).trim();
    if (head !== GIT_SHA || status) stop('source_changed');
  } catch { stop('source_changed'); }
}

/** Reuse only the pure bounded request function and login parser, independent of their historical target inventories. */
function reviewedLogin() {
  const { loginBuild } = require(path.join(ROOT, SOURCE, 'scripts/gate1-host-protection.js'));
  const { requestBounded } = require(path.join(ROOT, SOURCE, 'scripts/gate1-shared-ip-load.js'));
  return {
    loginBuild,
    /** Dispatch one bounded anonymous GET. fetchImpl is an offline seam; no load/provisioning functions run. */
    async login(signal, requestMs, fetchImpl = globalThis.fetch) {
      try {
        const response = await requestBounded(`https://${TARGET.hostname}/login`, {
          method: 'GET', headers: { Accept: 'text/html', 'Accept-Encoding': 'identity' }, credentials: 'omit',
        }, { fetchImpl, signal, timeoutMs: Math.floor(requestMs), maxBytes: LIMITS.responseBytes });
        let bytes = 0;
        for (const [key, value] of response.headers) bytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 4;
        if (bytes > LIMITS.headerBytes) stop('response_headers');
        return { status: response.status, text: response.text,
          headers: { 'content-type': response.headers.get('content-type') || '' } };
      } catch (error) {
        if (error?.code === 'response_headers') throw error;
        stop(error?.code === 'timeout' ? 'request_timeout' : 'application_transport');
      }
    },
  };
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

/** Execute the fixed sequence with injected transports/checkpoints, allowing fully offline behavioral tests. */
async function runWithAdapters(manifest, deps) {
  const now = deps.now || (() => performance.now());
  const start = now();
  const report = { schemaVersion: 1, scope: PROFILE.scope, mode: deps.mode || 'offline_fixture',
    result: 'running', packageDigest: manifest.packageDigest, startedAt: new Date().toISOString(), phase: 'reserved',
    providerAttempts: 0, providerDispatchAnnouncements: 0, applicationAttempts: 0, observations: [], failure: null,
    gate1Status: 'open', gate5aStatus: 'unpassed', rollbackExecuted: false, runtimeProbeExecuted: false,
    accounting: 'dispatch announcements bound requests; no independent physical HTTP audit' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROFILE.limits.overallMs);
  let checkpointBroken = false;
  /** Check the monotonic deadline before and after each operation. */
  function remaining() {
    const left = PROFILE.limits.overallMs - (now() - start);
    if (controller.signal.aborted || left <= 0) stop('overall_deadline');
    return left;
  }
  /** A failed checkpoint prohibits all later dispatches and is not silently retried. */
  function save() {
    try { deps.save(report); }
    catch { checkpointBroken = true; stop('checkpoint'); }
  }
  /** Save one safe observation before testing relationships with the preceding samples. */
  function observe(metadata) {
    report.observations.push({ phase: report.phase, observedAt: new Date().toISOString(), metadata });
    save();
  }
  /** Count a provider attempt and persist its intent before creating the child. */
  async function read(phase, deploymentId = null) {
    remaining();
    report.phase = phase;
    if (++report.providerAttempts > PROFILE.limits.providerReads) stop('request_budget');
    save();
    const metadata = provider.validateMetadata(phase, await deps.provider(phase, deploymentId,
      Math.min(LIMITS.childMs, remaining()), controller.signal, () => { report.providerDispatchAnnouncements++; }));
    remaining();
    observe(metadata);
    return metadata;
  }
  try {
    save();
    const before = await read('alias_before');
    if (before.deploymentId === PREVIOUS || before.updatedAt <= 1794442548053) stop('deployment_not_replaced');
    const deployment = await read('deployment', before.deploymentId);
    if (deployment.deploymentId !== before.deploymentId || deployment.readyAt < deployment.createdAt) stop('identity_mismatch');
    if (deployment.gitSha !== GIT_SHA) stop('source_mismatch');
    const project = await read('project', before.deploymentId);
    if (project.currentProductionDeploymentId !== before.deploymentId) stop('identity_mismatch');
    if (project.rollingReleaseConfigured || (project.lastRoutingJob && project.lastRoutingJob.status !== 'succeeded')) stop('routing_unsettled');
    report.phase = 'login';
    report.applicationAttempts++;
    save();
    const response = await deps.login(controller.signal, Math.min(PROFILE.limits.applicationMs, remaining()));
    remaining();
    const buildId = deps.loginBuild(response);
    if (!buildId || !/^[A-Za-z0-9_-]{1,128}$/.test(buildId)) stop('login_contract');
    observe({ status: 200, buildId, cookies: 'not_sent_or_retained' });
    const after = await read('alias_after', before.deploymentId);
    if (JSON.stringify(after) !== JSON.stringify(before)) stop('alias_drift');
    report.candidate = { deploymentId: before.deploymentId, gitSha: deployment.gitSha, buildId,
      immutableHostname: deployment.immutableHostname, canonicalHostname: TARGET.hostname, aliasUpdatedAt: before.updatedAt };
    report.result = 'identified';
  } catch (error) {
    report.result = 'stopped'; report.failure = failureCode(error);
    if (error instanceof ReadError && error.providerFacts) report.providerFailure = error.providerFacts;
  }
  finally { clearTimeout(timer); controller.abort(); }
  report.elapsedMs = Math.ceil(now() - start);
  report.finishedAt = new Date().toISOString();
  if (!checkpointBroken) {
    try { save(); } catch { report.result = 'stopped'; report.failure = 'checkpoint'; }
  }
  return report;
}

/** Default preparation is read-only. Live mode verifies its exact approval before reserving any evidence. */
async function main(args) {
  let sink;
  const reservation = { evidenceMayExist: false };
  try {
    reservation.evidenceMayExist = fs.existsSync(path.join(ROOT, DIRECTORY));
    if (!(args.length === 0 || (args.length === 1 && args[0] === '--prepare')
      || (args.length === 2 && args[0] === '--execute' && /^[a-f0-9]{64}$/.test(args[1])))) stop('arguments');
    const manifest = preparation();
    if (args[0] !== '--execute') {
      process.stdout.write(JSON.stringify({ mode: 'prepare', liveExecuted: false, ...manifest }, null, 2) + '\n');
      return 0;
    }
    if (args[1] !== manifest.packageDigest) stop('approval');
    verifySource();
    const loginTransport = reviewedLogin();
    sink = reserve(manifest, fs, reservation);
    const report = await runWithAdapters(manifest, { mode: 'live', provider: readProvider, save: sink.save,
      ...loginTransport });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.result === 'identified' ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ result: 'stopped', failure: failureCode(error), gate1Status: 'open',
      gate5aStatus: 'unpassed', evidenceMayExist: reservation.evidenceMayExist, rollbackExecuted: false }) + '\n');
    return 1;
  } finally { if (sink) { try { sink.close(); } catch { /* No further traffic or replay follows close failure. */ } } }
}

module.exports = { PROFILE, FILES, LOCAL_PINS, preparation, verifySource, reviewedLogin, reserve, readProvider,
  runWithAdapters, failureCode, hash, main };
if (require.main === module) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
