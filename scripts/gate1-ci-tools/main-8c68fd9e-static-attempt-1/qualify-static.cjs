'use strict';
/* global process, Buffer, __dirname, setTimeout, clearTimeout */

/** Exact-source static CI qualification. Local preparation and report verification are read-only. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const inspector = require('./inspect-compiled.cjs');

const SOURCE = '8c68fd9e58f717ff766f39fe4c90325fc113e722';
const TREE = '20f38b86ff6e44ee38d504a8d899f33fc016134a';
const LOCK = 'f6af332dffbbbcbd8aca4b816201fa5756e25d2e7249e1cd2c0cd9c3343b9f1a';
const REPO = 'willmclaughlin03/jobApplicationTracker';
const NAME = 'main-8c68fd9e-static-attempt-1';
const WORKFLOW = '.github/workflows/gate1-static.yml';
const FILES = Object.freeze(['README.md', 'gate1-static.yml', 'qualify-static.cjs', 'inspect-compiled.cjs', 'jest.config.cjs', '__tests__/qualify-static.test.cjs', '__tests__/inspect-compiled.test.cjs', '__tests__/workflow-contract.test.cjs']);
const ROOTS = Object.freeze(['src', 'public', 'package.json', 'package-lock.json', 'next.config.js', 'postcss.config.js', 'tailwind.config.js', 'jsconfig.json', 'tsconfig.json', 'scripts/validate-build-env.js']);
const VERSIONS = Object.freeze({ node: '22.23.3', npm: '10.9.9', next: '16.3.3', react: '18.3.1', 'react-dom': '18.3.1', acorn: '8.15.0' });
const LIMITS = Object.freeze({ jobMs: 1800000, runMs: 1440000, installMs: 480000, buildMs: 720000, inspectMs: 120000, childMs: 30000, closeMs: 5000, streamBytes: 8388608, sourceBytes: 134217728, sourceFiles: 4096, reportBytes: 262144, artifactRetentionDays: 7 });
const CODES = Object.freeze(['approval', 'reservation', 'source_identity', 'source_content', 'source_inventory', 'tool_identity', 'node_version', 'npm_version', 'dependency_version', 'child_exit', 'child_spawn', 'deadline', 'stream_limit', 'cleanup', 'report_schema', 'report_digest', 'persistence', 'internal', ...inspector.CODES]);
const STAGES = Object.freeze(['identity', 'source', 'toolchain', 'install', 'build', 'inspect', 'complete']);
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const INTEGER = /^[1-9]\d{0,14}$/;

/** Fixed failure vocabulary prevents child messages or secret-bearing stacks entering evidence. */
class QualificationError extends Error {
  /** Accept a known category, retaining no arbitrary diagnostic payload. */
  constructor(code) { super(CODES.includes(code) ? code : 'internal'); this.code = this.message; }
}

/** Hash reviewed source, package or report bytes only. */
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/** Read a bounded regular file without following a final symlink. */
function readBounded(filename, cap = LIMITS.reportBytes) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > cap) throw new QualificationError('report_schema');
  const bytes = fs.readFileSync(filename);
  if (bytes.length > cap) throw new QualificationError('report_schema');
  return bytes;
}

/** Locate the adjacent preparation draft or repository workflow after publication; no files are changed. */
function workflowPath(root = __dirname) {
  const adjacent = path.join(root, 'gate1-static.yml');
  return fs.existsSync(adjacent) ? adjacent : path.resolve(root, '../../..', WORKFLOW);
}

/** Hash all eight logical files at their preparation or publication locations. */
function packageProfile(root = __dirname, workflow = workflowPath(root)) {
  const hashes = Object.fromEntries(FILES.map(name => [name, sha(readBounded(name === 'gate1-static.yml' ? workflow : path.join(root, name), 1048576))]));
  const contract = { schemaVersion: 1, name: NAME, repository: REPO, source: SOURCE, tree: TREE, lockSha256: LOCK, versions: VERSIONS, limits: LIMITS,
    inspectionLimits: inspector.CAPS, workflow: WORKFLOW, files: hashes, applicationProbeCount: 0, serverStarted: false };
  return { packageDigest: sha(JSON.stringify(contract)), contract };
}

/** Bind reviewed bytes to one future workflow revision and monotonically numbered first run. */
function executionProfile(profile, workflowSha, runNumber) {
  if (!COMMIT.test(workflowSha || '') || !INTEGER.test(String(runNumber || ''))) throw new QualificationError('approval');
  const contract = { packageDigest: profile.packageDigest, workflowSha, runNumber: String(runNumber), runAttempt: '1', repository: REPO, workflow: WORKFLOW };
  return { executionDigest: sha(JSON.stringify(contract)), contract };
}

/** Reject wrong workflow, repository, OS, rerun or approval before source installation. */
function validateContext(env, profile, platform = process.platform, arch = process.arch) {
  const expected = executionProfile(profile, env.GATE1_WORKFLOW_SHA, env.GATE1_RUN_NUMBER);
  if (platform !== 'linux' || arch !== 'x64' || env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      env.GITHUB_REPOSITORY !== REPO || env.GITHUB_WORKFLOW_SHA !== env.GATE1_WORKFLOW_SHA || env.GITHUB_RUN_NUMBER !== env.GATE1_RUN_NUMBER ||
      env.GITHUB_RUN_ATTEMPT !== '1' || env.GITHUB_WORKFLOW_REF !== `${REPO}/${WORKFLOW}@refs/heads/main` ||
      !INTEGER.test(env.GITHUB_RUN_ID || '') || env.GATE1_EXECUTION_DIGEST !== expected.executionDigest || env.GATE1_PACKAGE_DIGEST !== profile.packageDigest) throw new QualificationError('approval');
  return { packageDigest: profile.packageDigest, executionDigest: expected.executionDigest, workflowSha: env.GATE1_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID, runNumber: env.GITHUB_RUN_NUMBER, runAttempt: 1 };
}

/** Supply child processes only basic OS plumbing and explicit synthetic settings, never inherited secrets. */
function childEnvironment(scratch, install = false) {
  const base = { PATH: process.env.PATH || process.env.Path || '', HOME: scratch, TMPDIR: scratch, TEMP: scratch, TMP: scratch,
    CI: '1', NODE_DISABLE_COMPILE_CACHE: '1', NEXT_TELEMETRY_DISABLED: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    npm_config_cache: path.join(scratch, 'npm-cache'), npm_config_userconfig: path.join(scratch, 'empty-user.npmrc'),
    npm_config_globalconfig: path.join(scratch, 'empty-global.npmrc'), npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_update_notifier: 'false', npm_config_logs_max: '0', npm_config_fetch_retries: '0',
    NEXT_PUBLIC_SUPABASE_URL: 'https://ci-build.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'ci-build-only-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'ci-build-only-service-role-key', CSRF_SECRET: 'ci-build-only-secret-at-least-32-characters' };
  if (!install) base.NODE_ENV = 'production';
  if (process.platform === 'win32') for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) base[key] = process.env[key];
  return base;
}

/** Bound child lifetime/streams, kill its Linux process group on exit, and await final stream closure. */
function supervise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, closing, settled = false, failure = null, stdoutBytes = 0, stderrBytes = 0;
    const output = [], spawnChild = options.spawn || spawn;
    /** Kill only the child/group created here; no broad process enumeration or cleanup. */
    function kill() {
      try {
        if (options.kill) options.kill(child);
        else if (process.platform === 'linux' && child?.pid) process.kill(-child.pid, 'SIGKILL');
        else child?.kill('SIGKILL');
      } catch { /* Process may already have exited. */ }
    }
    /** Complete once, reporting failed closure distinctly from a command failure. */
    function finish(error) {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(closing);
      if (error) reject(error); else resolve(Buffer.concat(output));
    }
    /** Terminate the owned group once; replace the run deadline with a fixed allowance for final streams. */
    function terminate() {
      if (closing || settled) return;
      clearTimeout(timer);
      closing = setTimeout(() => finish(new QualificationError('cleanup')), LIMITS.closeMs);
      kill();
    }
    /** Preserve the first fixed error while requiring close within the existing cleanup allowance. */
    function stop(code) {
      if (failure || settled) return;
      failure = new QualificationError(code); terminate();
    }
    try {
      child = spawnChild(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, detached: process.platform === 'linux', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { finish(new QualificationError('child_spawn')); return; }
    timer = setTimeout(() => stop('deadline'), options.timeoutMs || LIMITS.childMs);
    child.stdout.on('data', chunk => { stdoutBytes += chunk.length; if (stdoutBytes > (options.cap || LIMITS.streamBytes)) stop('stream_limit'); else if (options.capture) output.push(Buffer.from(chunk)); });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > LIMITS.streamBytes) stop('stream_limit'); });
    child.once('error', () => stop('child_spawn'));
    child.stdin.on('error', () => stop('child_exit'));
    child.once('exit', code => { if (code === 0) terminate(); else stop('child_exit'); });
    child.once('close', code => { finish(failure || (code === 0 ? null : new QualificationError('child_exit'))); });
    child.stdin.end(options.input || undefined);
  });
}

/** Execute a bounded read-only Git operation with hooks and global configuration disabled. */
async function git(app, args, run = supervise) {
  return run('git', ['-c', 'core.hooksPath=/dev/null', '-C', app, ...args], { env: childEnvironment(path.join(app, '.tmp')), capture: true, cap: LIMITS.sourceBytes });
}

/** Derive the exact page inventory from committed paths without reading page source text. */
function pageRoutes(entries) {
  return entries.filter(entry => /^src\/pages\/.*\.(?:js|jsx|ts|tsx)$/.test(entry.name)).map(entry => {
    const route = '/' + entry.name.slice('src/pages/'.length).replace(/\.(?:js|jsx|ts|tsx)$/, '').replace(/(^|\/)index$/, '');
    return route.length > 1 ? route.replace(/\/$/, '') : route;
  }).sort();
}

/** Verify selected committed input bytes and reject links, missing files and lockfile drift. */
function verifyFiles(app, entries) {
  let total = 0;
  for (const entry of entries) {
    let filename;
    try { filename = inspector.containedFile(app, entry.name); } catch { throw new QualificationError('source_content'); }
    const bytes = fs.readFileSync(filename);
    total += bytes.length;
    if (total > LIMITS.sourceBytes || crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.oid) throw new QualificationError('source_content');
  }
  if (sha(fs.readFileSync(path.join(app, 'package-lock.json'))) !== LOCK) throw new QualificationError('source_content');
}

/** Bind commit/tree and clean checkout to the original selected-source roots; never inspect .env contents. */
async function sourceProfile(app, checkBytes = true, run = supervise) {
  const identity = (await git(app, ['rev-parse', 'HEAD', 'HEAD^{tree}'], run)).toString('utf8').trim().split(/\r?\n/);
  if (identity.length !== 2 || identity[0] !== SOURCE || identity[1] !== TREE) throw new QualificationError('source_identity');
  const status = (await git(app, ['-c', 'core.autocrlf=true', '-c', 'core.filemode=false', 'status', '--porcelain', '--untracked-files=all'], run)).toString('utf8');
  if (status.trim()) throw new QualificationError('source_content');
  const all = (await git(app, ['ls-tree', '-r', '--name-only', '-z', SOURCE], run)).toString('utf8').split('\0').filter(Boolean);
  if (all.some(name => name.split('/').some(part => part.startsWith('.env'))) || all.some(name => name.startsWith('patches/'))) throw new QualificationError('source_inventory');
  const raw = (await git(app, ['ls-tree', '-r', '-z', SOURCE, '--', ...ROOTS], run)).toString('utf8').split('\0').filter(Boolean);
  const entries = raw.map(line => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match || /[\\:]/.test(match[3]) || [...match[3]].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || match[3].split('/').some(part => part.startsWith('.env') || part === '..')) throw new QualificationError('source_inventory');
    return { name: match[3], oid: match[2] };
  });
  if (entries.length !== 362 || entries.length > LIMITS.sourceFiles || new Set(entries.map(entry => entry.name)).size !== entries.length) throw new QualificationError('source_inventory');
  const committedLock = await git(app, ['show', `${SOURCE}:package-lock.json`], run);
  if (sha(committedLock) !== LOCK) throw new QualificationError('source_content');
  if (checkBytes) verifyFiles(app, entries);
  return { entries, routes: pageRoutes(entries), selectedFileCount: entries.length, selectedManifestSha256: sha(JSON.stringify(entries)) };
}

/** Require bounded semantic versions and the approved exact versions, preserving major guards. */
function validateVersions(actual, keys = Object.keys(VERSIONS)) {
  for (const key of keys) {
    if (typeof actual[key] !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(actual[key]) || actual[key] !== VERSIONS[key]) throw new QualificationError(key === 'node' ? 'node_version' : key === 'npm' ? 'npm_version' : 'dependency_version');
  }
}

/** Read installed package metadata only; never execute a dependency to discover its version. */
function installedVersions(app) {
  return Object.fromEntries(['next', 'react', 'react-dom', 'acorn'].map(name => {
    const filename = inspector.containedFile(app, `node_modules/${name}/package.json`);
    return [name, JSON.parse(fs.readFileSync(filename, 'utf8')).version];
  }));
}

/** Preserve only allowlisted runtime values when a conflicting toolchain is observed. */
function safeVersions(actual) {
  return Object.fromEntries(Object.keys(VERSIONS).map(key => [key, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(actual[key] || '') ? actual[key] : null]));
}

/** Copy fixed diagnostic facts, excluding arbitrary paths, raw runtimes, messages and stacks. */
function safeDetail(error) {
  const value = error.detail || {}, result = {};
  if (['middleware', 'known_application_route', 'unrecognized', ...inspector.NAMES, 'server/middleware.js.nft.json'].includes(value.output)) result.output = value.output;
  if (['nodejs', 'node', 'edge', 'unrecognized'].includes(value.runtime)) result.runtime = value.runtime;
  if (value.runtimeMajor === null || (Number.isInteger(value.runtimeMajor) && value.runtimeMajor >= 1 && value.runtimeMajor <= 999)) result.runtimeMajor = value.runtimeMajor;
  return result;
}

/** Require a closed object schema rather than copying arbitrary inspector/application output. */
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

/** Validate the entire sanitized static result before it can be serialized or accepted. */
function validateInspection(value) {
  const keys = ['nodeMiddleware', 'matcherPreserved', 'sourceRoutesPresent', 'pageCount', 'buildId', 'manifests', 'traceHash', 'compiledFiles', 'compiledBytes', 'compiledClosureHash', 'readerCandidates'];
  if (!exactKeys(value, keys) || value.nodeMiddleware !== true || value.matcherPreserved !== true || value.sourceRoutesPresent !== true || value.readerCandidates !== 1 ||
      !Number.isInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > 4099 || !/^[A-Za-z0-9_-]{1,64}$/.test(value.buildId || '') ||
      !exactKeys(value.manifests, inspector.NAMES) || Object.values(value.manifests).some(hash => !HASH.test(hash)) || !HASH.test(value.traceHash) || !HASH.test(value.compiledClosureHash) ||
      !Number.isInteger(value.compiledFiles) || value.compiledFiles < 1 || value.compiledFiles > inspector.CAPS.files || !Number.isInteger(value.compiledBytes) || value.compiledBytes < 1 || value.compiledBytes > inspector.CAPS.total) throw new QualificationError('report_schema');
  return value;
}

/** Reject unknown fields and inconsistent success, attribution, request or cleanup assertions. */
function validateReport(report, expected) {
  const keys = ['schemaVersion', 'source', 'tree', 'lockSha256', 'packageDigest', 'executionDigest', 'workflowSha', 'runId', 'runNumber', 'runAttempt', 'versions', 'stage', 'result', 'failure', 'detail', 'inspection', 'applicationProbeCount', 'serverStarted', 'childrenClosed', 'artifactRetentionDays', 'gate1', 'gate5A'];
  if (!exactKeys(report, keys) || report.schemaVersion !== 1 || report.source !== SOURCE || report.tree !== TREE || report.lockSha256 !== LOCK ||
      report.gate1 !== 'open' || report.gate5A !== 'unpassed' || report.applicationProbeCount !== 0 || report.serverStarted !== false ||
      typeof report.childrenClosed !== 'boolean' || report.artifactRetentionDays !== 7 || !STAGES.includes(report.stage) || report.runAttempt !== 1 ||
      !INTEGER.test(report.runId) || !INTEGER.test(report.runNumber) || !COMMIT.test(report.workflowSha) || !HASH.test(report.packageDigest) || !HASH.test(report.executionDigest) ||
      !exactKeys(report.versions, Object.keys(VERSIONS)) || Object.values(report.versions).some(value => value !== null && !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) ||
      !exactKeys(report.detail, Object.keys(safeDetail({ detail: report.detail })))) throw new QualificationError('report_schema');
  for (const key of ['packageDigest', 'executionDigest', 'workflowSha', 'runId', 'runNumber', 'runAttempt']) if (report[key] !== expected[key]) throw new QualificationError('report_schema');
  if (JSON.stringify(safeDetail({ detail: report.detail })) !== JSON.stringify(report.detail)) throw new QualificationError('report_schema');
  if (report.inspection !== null) validateInspection(report.inspection);
  if (report.result === 'complete_static_only') {
    validateVersions(report.versions);
    if (report.failure !== null || report.stage !== 'complete' || !report.childrenClosed || report.inspection === null || Object.keys(report.detail).length) throw new QualificationError('report_schema');
  } else if (report.result !== 'stopped' || !CODES.includes(report.failure) || report.stage === 'complete') throw new QualificationError('report_schema');
  return report;
}

/** Parse a capped child report with fixed failures; no raw process output is retained. */
function parseInspection(bytes) {
  if (bytes.length > LIMITS.reportBytes) throw new QualificationError('report_schema');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new QualificationError('report_schema'); }
  if (bytes.toString('utf8').trim() !== JSON.stringify(value)) throw new QualificationError('report_schema');
  if (exactKeys(value, ['result']) && value.result) return validateInspection(value.result);
  if (exactKeys(value, ['failure', 'detail']) && inspector.CODES.includes(value.failure) && JSON.stringify(safeDetail({ detail: value.detail })) === JSON.stringify(value.detail)) throw new inspector.InspectionError(value.failure, value.detail);
  throw new QualificationError('report_schema');
}

/** Write one exclusive evidence file only after serialization and its byte cap succeed. */
function writeOnce(filename, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (bytes.length > LIMITS.reportBytes) throw new QualificationError('report_schema');
  fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
  return sha(bytes);
}

/** Run the finite install/build/inspection sequence; failed children never advance to another stage. */
async function qualify(app, scratch, context, operations = {}) {
  const run = operations.run || supervise, source = operations.source || sourceProfile, verify = operations.verify || verifyFiles;
  const versions = { node: (operations.node || process.versions.node) };
  const report = { schemaVersion: 1, source: SOURCE, tree: TREE, lockSha256: LOCK, ...context, versions: safeVersions(versions), stage: 'source', result: 'stopped', failure: null,
    detail: {}, inspection: null, applicationProbeCount: 0, serverStarted: false, childrenClosed: true, artifactRetentionDays: 7, gate1: 'open', gate5A: 'unpassed' };
  const start = Date.now();
  /** Bound every stage by both its own allowance and the shared controller deadline. */
  function timeout(ms) { const remaining = LIMITS.runMs - (Date.now() - start); if (remaining <= 0) throw new QualificationError('deadline'); return Math.min(ms, remaining); }
  try {
    const selected = await source(app, true, run);
    report.stage = 'toolchain'; validateVersions(versions, ['node']);
    const common = { cwd: app, env: childEnvironment(scratch) };
    versions.npm = (await run('npm', ['--version'], { ...common, timeoutMs: timeout(LIMITS.childMs), capture: true, cap: 64 })).toString('utf8').trim();
    validateVersions(versions, ['npm']);
    report.stage = 'install';
    await run('npm', ['ci', '--no-audit', '--no-fund', '--include=dev'], { ...common, env: childEnvironment(scratch, true), timeoutMs: timeout(LIMITS.installMs) });
    Object.assign(versions, (operations.installed || installedVersions)(app)); validateVersions(versions); verify(app, selected.entries);
    report.stage = 'build';
    await run('npm', ['run', 'build'], { ...common, timeoutMs: timeout(LIMITS.buildMs) });
    verify(app, selected.entries);
    report.stage = 'inspect';
    report.inspection = parseInspection(await run(process.execPath, [path.join(__dirname, 'qualify-static.cjs'), '--inspect', app],
      { ...common, timeoutMs: timeout(LIMITS.inspectMs), capture: true, cap: LIMITS.reportBytes, input: JSON.stringify(selected.routes) }));
    verify(app, selected.entries);
    report.stage = 'complete'; report.result = 'complete_static_only';
  } catch (error) {
    report.failure = CODES.includes(error.code) ? error.code : 'internal'; report.detail = safeDetail(error);
    if (report.failure === 'cleanup') report.childrenClosed = false;
  }
  report.versions = safeVersions(versions);
  return validateReport(report, context);
}

/** Execute only on the approved GitHub runner, with exclusive evidence and scratch reservations. */
async function execute(env = process.env) {
  const workspace = fs.realpathSync(env.GITHUB_WORKSPACE || '.');
  const workflow = path.join(workspace, 'tooling', WORKFLOW);
  if (path.resolve(__dirname) !== path.join(workspace, 'tooling', 'scripts', 'gate1-ci-tools', NAME)) throw new QualificationError('tool_identity');
  const profile = packageProfile(__dirname, workflow), context = validateContext(env, profile);
  const head = (await git(path.join(workspace, 'tooling'), ['rev-parse', 'HEAD'])).toString('utf8').trim();
  if (head !== context.workflowSha) throw new QualificationError('tool_identity');
  const dest = path.join(workspace, 'gate1-static-evidence'), scratch = path.join(workspace, 'gate1-static-scratch');
  if (fs.existsSync(dest) || fs.existsSync(scratch)) throw new QualificationError('reservation');
  fs.mkdirSync(dest);
  writeOnce(path.join(dest, 'reservation.json'), { ...context, state: 'consumed_no_replay' });
  fs.mkdirSync(scratch);
  for (const name of ['empty-user.npmrc', 'empty-global.npmrc']) fs.writeFileSync(path.join(scratch, name), '', { flag: 'wx', mode: 0o600 });
  const report = await qualify(path.join(workspace, 'application'), scratch, context);
  if (packageProfile(__dirname, workflow).packageDigest !== profile.packageDigest) {
    report.result = 'stopped'; report.stage = 'inspect'; report.failure = 'tool_identity'; report.detail = {};
  }
  validateReport(report, context);
  const reportSha256 = writeOnce(path.join(dest, 'report.json'), report);
  return { result: report.result, stage: report.stage, failure: report.failure, reportSha256 };
}

/** Revalidate a retained report against a separately approved identity and a separately supplied hash. */
function verifyReport(filename, digest, expected) {
  if (!HASH.test(digest || '')) throw new QualificationError('report_digest');
  const bytes = readBounded(filename);
  if (sha(bytes) !== digest) throw new QualificationError('report_digest');
  let report;
  try { report = JSON.parse(bytes.toString('utf8')); } catch { throw new QualificationError('report_schema'); }
  if (bytes.toString('utf8') !== JSON.stringify(report, null, 2) + '\n') throw new QualificationError('report_schema');
  return validateReport(report, expected);
}

/** Read a bounded route list from the controller, inspect in this child, and emit sanitized JSON only. */
async function inspectChild(app) {
  const bytes = [];
  let length = 0;
  for await (const chunk of process.stdin) { length += chunk.length; if (length > LIMITS.reportBytes) throw new QualificationError('report_schema'); bytes.push(chunk); }
  let routes;
  try { routes = JSON.parse(Buffer.concat(bytes).toString('utf8')); } catch { throw new QualificationError('report_schema'); }
  if (!Array.isArray(routes) || routes.length > 4096 || routes.some(route => typeof route !== 'string' || route.length > 256 || !route.startsWith('/'))) throw new QualificationError('report_schema');
  validateVersions(installedVersions(app), ['next', 'react', 'react-dom', 'acorn']);
  const parse = createRequire(path.join(path.resolve(app), 'package.json'))('acorn').parse;
  try { return { result: validateInspection(inspector.inspect(app, routes, parse)) }; }
  catch (error) { return { failure: inspector.CODES.includes(error.code) ? error.code : 'artifact_read', detail: safeDetail(error) }; }
}

/** Dispatch explicit modes; preparation never installs, builds, starts a server or creates evidence. */
async function main(args = process.argv.slice(2)) {
  if (args[0] === '--prepare' && args.length === 2) {
    const selected = await sourceProfile(path.resolve(args[1]), false);
    return { ...packageProfile(), selectedFileCount: selected.selectedFileCount, selectedManifestSha256: selected.selectedManifestSha256, checkoutBytesQualified: false };
  }
  if (args[0] === '--approval' && args.length === 3) return executionProfile(packageProfile(), args[1], args[2]);
  if (args[0] === '--run' && args.length === 1) return execute();
  if (args[0] === '--inspect' && args.length === 2) return inspectChild(args[1]);
  if (args[0] === '--verify-report' && args.length === 7) {
    const profile = packageProfile(), execution = executionProfile(profile, args[3], args[4]);
    const expected = { packageDigest: profile.packageDigest, executionDigest: execution.executionDigest, workflowSha: args[3], runNumber: args[4], runId: args[5], runAttempt: 1 };
    if (args[6] !== execution.executionDigest) throw new QualificationError('approval');
    const report = verifyReport(args[1], args[2], expected);
    return { result: report.result, stage: report.stage, failure: report.failure, reportSha256: args[2] };
  }
  if (args[0] === '--validate-upload' && args.length === 1) {
    const workspace = fs.realpathSync(process.env.GITHUB_WORKSPACE), profile = packageProfile(__dirname, path.join(workspace, 'tooling', WORKFLOW));
    const context = validateContext(process.env, profile), filename = path.join(workspace, 'gate1-static-evidence/report.json');
    const reportSha256 = sha(readBounded(filename));
    verifyReport(filename, reportSha256, context);
    return { reportSha256 };
  }
  throw new QualificationError('approval');
}

if (require.main === module) main().then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.result === 'stopped') process.exitCode = 1;
}).catch(error => { process.stderr.write(JSON.stringify({ failure: CODES.includes(error.code) ? error.code : 'internal' }) + '\n'); process.exitCode = 1; });

module.exports = { SOURCE, TREE, LOCK, REPO, NAME, WORKFLOW, FILES, ROOTS, VERSIONS, LIMITS, CODES, QualificationError, sha, readBounded, workflowPath, packageProfile, executionProfile, validateContext,
  childEnvironment, supervise, pageRoutes, verifyFiles, sourceProfile, validateVersions, installedVersions, safeVersions, safeDetail, validateInspection, validateReport, parseInspection, writeOnce, qualify, verifyReport, main };
