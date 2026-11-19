'use strict';
/* global process, __dirname */

/** Fresh CI runtime qualification; preparation/verification modes never install, build or start anything. */
const fs = require('node:fs');
const path = require('node:path');
const base = require('../main-8c68fd9e-static-attempt-1/qualify-static.cjs');
const probe = require('./runtime-probe.cjs');
const isolation = require('./isolate-runtime.cjs');
const { RuntimeError } = require('./inspect-runtime.cjs');
const NAME = 'main-8c68fd9e-runtime-attempt-1';
const WORKFLOW = '.github/workflows/gate1-runtime.yml';
const STATIC_DIGEST = 'caf0c83c17ed131cc080e7453e1fde961c62026462e95be25d6c639257c97784';
const FILES = Object.freeze(['gate1-runtime.yml', 'README.md', 'qualify-runtime.cjs', 'inspect-runtime.cjs', 'isolate-runtime.cjs', 'runtime-probe.cjs', 'jest.config.cjs',
  '__tests__/qualify-runtime.test.cjs', '__tests__/inspect-runtime.test.cjs', '__tests__/isolate-runtime.test.cjs', '__tests__/runtime-probe.test.cjs', '__tests__/workflow-contract.test.cjs']);
const STAGES = Object.freeze(['identity', 'source', 'toolchain', 'install', 'build', 'runtime', 'verify', 'complete']);
const HASH = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/, INTEGER = /^[1-9]\d{0,14}$/;

/** Locate only the published manual workflow; the package has no alternate unbound workflow path. */
function workflowPath(root = __dirname) { return path.resolve(root, '../../..', WORKFLOW); }

/** Preview Git's LF text bytes on Windows only; guarded Linux execution hashes the actual checkout bytes. */
function profileBytes(filename) {
  const bytes = base.readBounded(filename, 1048576);
  return process.platform === 'win32' ? bytes.toString('utf8').replace(/\r\n/g, '\n') : bytes;
}

/** Bind all twelve new files plus the unchanged eight-file static dependency and all fixed budgets. */
function packageProfile(root = __dirname) {
  const dependencyRoot = path.resolve(root, '../main-8c68fd9e-static-attempt-1'), dependency = base.packageProfile(dependencyRoot);
  if (process.platform === 'win32') dependency.contract.files = Object.fromEntries(base.FILES.map(name => [name,
    base.sha(profileBytes(name === 'gate1-static.yml' ? base.workflowPath(dependencyRoot) : path.join(dependencyRoot, name)))]));
  if (base.sha(JSON.stringify(dependency.contract)) !== STATIC_DIGEST) throw new RuntimeError('tool_identity');
  const files = Object.fromEntries(FILES.map(name => [name, base.sha(profileBytes(name === 'gate1-runtime.yml' ? workflowPath(root) : path.join(root, name)))]));
  const contract = { schemaVersion: 1, name: NAME, repository: base.REPO, source: base.SOURCE, tree: base.TREE, lockSha256: base.LOCK, versions: base.VERSIONS,
    staticPackageDigest: STATIC_DIGEST, limits: base.LIMITS, runtimeLimits: probe.LIMITS, phaseLimits: isolation.PHASES, memoryBytes: isolation.MEMORY,
    serviceProperties: isolation.PROPERTIES, serviceStopMs: isolation.STOP_MS, cases: probe.CASES, workflow: WORKFLOW, files };
  return { packageDigest: base.sha(JSON.stringify(contract)), contract };
}

/** Bind an immutable workflow revision to one numbered first attempt; preparation grants no execution authority. */
function executionProfile(profile, workflowSha, runNumber) {
  if (!COMMIT.test(workflowSha || '') || !INTEGER.test(String(runNumber || ''))) throw new RuntimeError('approval');
  const contract = { packageDigest: profile.packageDigest, workflowSha, runNumber: String(runNumber), runAttempt: '1', repository: base.REPO, workflow: WORKFLOW };
  return { executionDigest: base.sha(JSON.stringify(contract)), contract };
}

/** Reject reruns, wrong source workflow or changed review digests before any reservation or installation. */
function validateContext(env, profile, platform = process.platform, arch = process.arch) {
  const approval = executionProfile(profile, env.GATE1_WORKFLOW_SHA, env.GATE1_RUN_NUMBER);
  if (platform !== 'linux' || arch !== 'x64' || env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== base.REPO || env.GITHUB_WORKFLOW_SHA !== env.GATE1_WORKFLOW_SHA ||
      env.GITHUB_RUN_NUMBER !== env.GATE1_RUN_NUMBER || env.GITHUB_RUN_ATTEMPT !== '1' || !INTEGER.test(env.GITHUB_RUN_ID || '') ||
      env.GITHUB_WORKFLOW_REF !== `${base.REPO}/${WORKFLOW}@refs/heads/main` || env.GATE1_PACKAGE_DIGEST !== profile.packageDigest || env.GATE1_EXECUTION_DIGEST !== approval.executionDigest) throw new RuntimeError('approval');
  return { packageDigest: profile.packageDigest, executionDigest: approval.executionDigest, workflowSha: env.GATE1_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID, runNumber: env.GITHUB_RUN_NUMBER, runAttempt: 1 };
}

/** Create a sanitized initial record; runtime accounting remains unknown until child evidence is available. */
function initialReport(context) {
  return { schemaVersion: 1, source: base.SOURCE, tree: base.TREE, lockSha256: base.LOCK, staticPackageDigest: STATIC_DIGEST, ...context,
    versions: base.safeVersions({}), stage: 'source', result: 'stopped', failure: null, runtime: null, accounting: 'unknown', serviceStopped: null,
    childrenClosed: true, artifactRetentionDays: 7, gate1: 'open', gate5A: 'unpassed' };
}

/** Strict report schema rejects arbitrary data, mismatched identities and incomplete success assertions. */
function validateReport(report, expected) {
  if (!probe.exactKeys(report, Object.keys(initialReport(expected))) || report.schemaVersion !== 1 || report.source !== base.SOURCE || report.tree !== base.TREE || report.lockSha256 !== base.LOCK ||
      report.staticPackageDigest !== STATIC_DIGEST || report.runAttempt !== 1 || !HASH.test(report.packageDigest || '') || !HASH.test(report.executionDigest || '') ||
      !COMMIT.test(report.workflowSha || '') || !INTEGER.test(report.runNumber || '') || !INTEGER.test(report.runId || '') ||
      !STAGES.includes(report.stage) || report.gate1 !== 'open' || report.gate5A !== 'unpassed' || report.artifactRetentionDays !== 7 || typeof report.childrenClosed !== 'boolean' ||
      report.serviceStopped !== null && typeof report.serviceStopped !== 'boolean' || !['known', 'unknown', 'last_attempt_uncertain'].includes(report.accounting) ||
      !probe.exactKeys(report.versions, Object.keys(base.VERSIONS)) || Object.values(report.versions).some(value => value !== null && (typeof value !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)))) throw new RuntimeError('report_schema');
  for (const key of ['packageDigest', 'executionDigest', 'workflowSha', 'runNumber', 'runId', 'runAttempt']) if (report[key] !== expected[key]) throw new RuntimeError('report_schema');
  if (report.runtime !== null) probe.validateRuntime(report.runtime);
  if ((report.runtime === null) !== (report.accounting === 'unknown')) throw new RuntimeError('report_schema');
  if (report.accounting === 'last_attempt_uncertain' && (report.result !== 'stopped' || report.runtime.stage !== 'requests' ||
      report.runtime.failure !== null || report.runtime.attempted !== report.runtime.cases.length + 1)) throw new RuntimeError('report_schema');
  if ((report.serviceStopped === false && (report.failure !== 'cleanup' || report.childrenClosed !== false)) ||
      (!report.childrenClosed && report.failure !== 'cleanup') || (report.runtime !== null && report.serviceStopped === null) ||
      (report.runtime?.failure === 'cleanup' && report.failure !== 'cleanup') ||
      (report.runtime?.failure && ![report.runtime.failure, 'cleanup', 'tool_identity'].includes(report.failure)) ||
      (!['runtime', 'verify', 'complete'].includes(report.stage) && (report.runtime !== null || report.serviceStopped !== null))) throw new RuntimeError('report_schema');
  if (report.result === 'complete_runtime_only') {
    base.validateVersions(report.versions);
    if (report.failure !== null || report.stage !== 'complete' || report.runtime === null || report.serviceStopped !== true || !report.childrenClosed) throw new RuntimeError('report_schema');
    probe.validateRuntime(report.runtime, true);
  } else if (report.result !== 'stopped' || !probe.CODES.includes(report.failure) || report.stage === 'complete') throw new RuntimeError('report_schema');
  return report;
}

/** Install/build once, then inspect and exercise the same output inside the verified runtime boundary. */
async function qualify(app, scratch, context, operations = {}) {
  const supervise = operations.run || base.supervise, verify = operations.verify || base.verifyFiles, now = operations.now || Date.now;
  const start = now(), report = initialReport(context), versions = { node: operations.node || process.versions.node };
  /** Every stage receives the lesser of its cap and the shared remaining deadline. */
  function timeout(cap) {
    const remaining = base.LIMITS.runMs - (now() - start);
    if (remaining <= 0) throw new RuntimeError('deadline');
    return Math.min(cap, remaining);
  }
  /** Apply the shared controller deadline to source-profile Git children as well as install/build commands. */
  function run(command, args, options = {}) {
    return supervise(command, args, { ...options, cap: Math.min(options.cap || base.LIMITS.streamBytes, base.LIMITS.streamBytes), timeoutMs: timeout(options.timeoutMs || base.LIMITS.childMs) });
  }
  try {
    const selected = await (operations.source || base.sourceProfile)(app, true, run);
    report.stage = 'toolchain'; base.validateVersions(versions, ['node']);
    const common = { cwd: app, env: base.childEnvironment(scratch) };
    versions.npm = (await run('npm', ['--version'], { ...common, timeoutMs: timeout(30000), capture: true, cap: 64 })).toString('utf8').trim();
    base.validateVersions(versions, ['npm']); report.stage = 'install';
    await run('npm', ['ci', '--no-audit', '--no-fund', '--include=dev'], { ...common, env: base.childEnvironment(scratch, true), timeoutMs: timeout(base.LIMITS.installMs) });
    Object.assign(versions, (operations.installed || base.installedVersions)(app)); base.validateVersions(versions); verify(app, selected.entries);
    report.stage = 'build';
    await run('npm', ['run', 'build'], { ...common, env: isolation.environment(scratch), timeoutMs: timeout(base.LIMITS.buildMs) });
    verify(app, selected.entries);
    report.stage = 'runtime';
    const runtimeScratch = path.join(scratch, 'runtime');
    if (operations.prepareScratch) operations.prepareScratch(runtimeScratch);
    else {
      fs.mkdirSync(runtimeScratch, { mode: 0o700 });
      const cache = path.join(app, '.next/cache');
      if (!fs.existsSync(cache)) fs.mkdirSync(cache);
      if (!fs.lstatSync(cache).isDirectory() || fs.lstatSync(cache).isSymbolicLink() || fs.realpathSync(cache) !== cache) throw new RuntimeError('artifact_path');
    }
    const result = await (operations.isolate || isolation.runIsolated)(app, runtimeScratch, context, selected, timeout(probe.LIMITS.runtimeMs));
    report.runtime = result.runtime; report.accounting = result.accounting; report.serviceStopped = result.serviceStopped;
    if (result.serviceStopped === false) report.childrenClosed = false;
    if (result.failure) throw new RuntimeError(result.failure);
    report.stage = 'verify'; verify(app, selected.entries); timeout(1);
    report.stage = 'complete'; report.result = 'complete_runtime_only';
  } catch (error) {
    report.failure = probe.failureCode(error);
    if (report.failure === 'cleanup') report.childrenClosed = false;
  }
  report.versions = base.safeVersions(versions);
  return validateReport(report, context);
}

/** Reserve fresh runner-local state and preserve one report; no retry or destination reuse is supported. */
async function execute(env = process.env) {
  const workspace = fs.realpathSync(env.GITHUB_WORKSPACE || '.'), profile = packageProfile(), context = validateContext(env, profile);
  const tooling = path.join(workspace, 'tooling');
  if (path.resolve(__dirname) !== path.join(tooling, 'scripts/gate1-ci-tools', NAME)) throw new RuntimeError('tool_identity');
  const head = (await base.supervise('git', ['-c', 'core.hooksPath=/dev/null', '-C', tooling, 'rev-parse', 'HEAD'], { env: base.childEnvironment(workspace), capture: true, cap: 64 })).toString('utf8').trim();
  if (head !== context.workflowSha) throw new RuntimeError('tool_identity');
  const dest = path.join(workspace, 'gate1-runtime-evidence'), scratch = path.join(workspace, 'gate1-runtime-scratch');
  if (fs.existsSync(dest) || fs.existsSync(scratch)) throw new RuntimeError('reservation');
  fs.mkdirSync(dest, { mode: 0o700 }); base.writeOnce(path.join(dest, 'reservation.json'), { ...context, state: 'consumed_no_replay' });
  fs.mkdirSync(scratch, { mode: 0o700 });
  for (const name of ['empty-user.npmrc', 'empty-global.npmrc']) fs.writeFileSync(path.join(scratch, name), '', { flag: 'wx', mode: 0o600 });
  const report = await qualify(path.join(workspace, 'application'), scratch, context);
  try {
    if (packageProfile().packageDigest !== profile.packageDigest) throw new RuntimeError('tool_identity');
  } catch {
    report.stage = 'verify'; report.result = 'stopped';
    if (report.failure !== 'cleanup') report.failure = 'tool_identity';
  }
  validateReport(report, context);
  const pending = path.join(dest, '.pending-report.json');
  let fd = fs.openSync(pending, 'wx', 0o600), reportSha256;
  try {
    reportSha256 = base.writeOnce(fd, report);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.linkSync(pending, path.join(dest, 'report.json')); // Publish complete bytes atomically without replacing existing evidence.
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); }
    finally { fs.unlinkSync(pending); } // Only remove the pending file this attempt opened exclusively.
  }
  return { result: report.result, stage: report.stage, failure: report.failure, reportSha256 };
}

/** Verify one bounded byte snapshot against the run-bound hash, canonical JSON and expected report schema. */
function verifyReport(filename, digest, expected) {
  if (!HASH.test(digest || '')) throw new RuntimeError('report_digest');
  const bytes = base.readBounded(filename);
  if (base.sha(bytes) !== digest) throw new RuntimeError('report_digest');
  const text = bytes.toString('utf8'); let report;
  try { report = JSON.parse(text); } catch { throw new RuntimeError('report_schema'); }
  if (text !== JSON.stringify(report, null, 2) + '\n') throw new RuntimeError('report_schema');
  return validateReport(report, expected);
}

/** Expose read-only preparation/review modes separately from the guarded one-run CI entry point. */
async function main(args = process.argv.slice(2)) {
  if (args[0] === '--prepare' && args.length === 2) {
    const selected = await base.sourceProfile(path.resolve(args[1]), false);
    return { ...packageProfile(), selectedFileCount: selected.selectedFileCount, selectedManifestSha256: selected.selectedManifestSha256, checkoutBytesQualified: false };
  }
  if (args[0] === '--approval' && args.length === 3) return executionProfile(packageProfile(), args[1], args[2]);
  if (args[0] === '--run' && args.length === 1) return execute();
  if (args[0] === '--verify-report' && args.length === 7) {
    const profile = packageProfile(), approval = executionProfile(profile, args[3], args[4]);
    if (args[6] !== approval.executionDigest) throw new RuntimeError('approval');
    const expected = { packageDigest: profile.packageDigest, executionDigest: approval.executionDigest, workflowSha: args[3], runNumber: args[4], runId: args[5], runAttempt: 1 };
    const report = verifyReport(args[1], args[2], expected);
    return { result: report.result, stage: report.stage, failure: report.failure, reportSha256: args[2] };
  }
  if (args[0] === '--validate-upload' && args.length === 1) {
    const profile = packageProfile(), context = validateContext(process.env, profile), filename = path.join(fs.realpathSync(process.env.GITHUB_WORKSPACE), 'gate1-runtime-evidence/report.json');
    const reportSha256 = base.sha(base.readBounded(filename)); verifyReport(filename, reportSha256, context);
    return { reportSha256 };
  }
  throw new RuntimeError('approval');
}

if (require.main === module) main().then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.result === 'stopped') process.exitCode = 1;
}).catch(error => { process.stderr.write(JSON.stringify({ failure: probe.failureCode(error) }) + '\n'); process.exitCode = 1; });

module.exports = { SOURCE: base.SOURCE, NAME, WORKFLOW, STATIC_DIGEST, FILES, STAGES, workflowPath, profileBytes, packageProfile, executionProfile, validateContext,
  initialReport, validateReport, qualify, execute, verifyReport, main };
