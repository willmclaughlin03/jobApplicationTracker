'use strict';
/* global Buffer, process, setInterval, clearInterval, __dirname */

/** One-shot offline qualification; --prepare is read-only and never invokes Docker. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const SOURCE = '24106d4e49fc26d5aabac99660f33ea89829d9c5';
const TREE = '00f6172d8b60b75b530c2c0e936672bcea1c37c6';
const LOCK = 'f6af332dffbbbcbd8aca4b816201fa5756e25d2e7249e1cd2c0cd9c3343b9f1a';
const NODE_SHA = '1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af';
const CACHE_SHA = '041659a5d51213b62dbb2bd7a74770ec8cf0ec1116ea0a1e7401eaf2c92163d1';
const BASE = 'docker.io/library/amazonlinux@sha256:500790b3c980438d9d6cde6c149e59dda1992660941a814198b95ed56574fb96';
const VERSIONS = Object.freeze({ node: '22.23.3', npm: '10.9.9', next: '16.3.3', react: '18.3.1', 'react-dom': '18.3.1', acorn: '8.15.0' });
const FILES = Object.freeze(['README.md', 'qualify-build.cjs', 'inspect-compiled.cjs', 'qualification.Dockerfile', 'source-archive.cjs', '__tests__/qualify-build.test.cjs', '__tests__/inspect-compiled.test.cjs', '__tests__/source-archive.test.cjs']);
const ROOTS = Object.freeze(['src', 'public', 'package.json', 'package-lock.json', 'next.config.js', 'postcss.config.js', 'tailwind.config.js', 'jsconfig.json', 'tsconfig.json', 'scripts/validate-build-env.js']);
const LIMITS = Object.freeze({ overallMs: 1800000, childMs: 30000, sourceBytes: 134217728, streamBytes: 8388608, reportBytes: 262144, storageBytes: 8589934592, entries: 250000, memoryBytes: 6442450944, pids: 256, cpus: 4, requests: 6 });
const NAME = 'gate1-main-24106d4e-compiled-attempt-2';
const ROOT = path.resolve(__dirname, '../../..');
const WORKTREE = path.join(ROOT, '.tmp/worktrees/gate1-main-24106d4e-compiled');
const INPUTS = path.join(ROOT, '.tmp/gate1-qualification-inputs-7f70e4eb');
const DEST = path.join(ROOT, '.tmp/gate1-build/main-24106d4e-compiled-attempt-2');
const CODES = new Set(['source', 'toolchain', 'input', 'approval', 'reservation', 'child', 'deadline', 'stream_limit', 'storage', 'docker', 'cleanup', 'persistence', 'artifact_path', 'artifact_cap', 'manifest', 'matcher', 'compiled_reader', 'runtime_read', 'http', 'http_cap', 'observation', 'cache_cookie', 'route', 'internal', 'archive_parser', 'archive_format', 'archive_path', 'archive_limit', 'archive_duplicate', 'archive_link', 'archive_extra', 'archive_missing', 'archive_content']);

/** Keep execution failures inside a fixed non-sensitive vocabulary. */
class QualificationError extends Error {
  /** Never retain an arbitrary exception message or stack in an evidence record. */
  constructor(code) { super(CODES.has(code) ? code : 'internal'); this.code = this.message; }
}

/** Hash source or reviewed package bytes; never use this on secret inputs. */
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/** Hash a regular archive in bounded blocks, rejecting symlinks and oversized inputs. */
function fileHash(filename, cap = 512 * 1024 * 1024) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > cap) throw new QualificationError('input');
  const fd = fs.openSync(filename, 'r'), hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536);
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/** Strip application credentials and Node/Git overrides from ordinary host children. */
function hostEnvironment() {
  const keys = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME'];
  return { ...Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    TEMP: path.join(ROOT, '.tmp'), TMP: path.join(ROOT, '.tmp'), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', NODE_DISABLE_COMPILE_CACHE: '1' };
}

/** Supervise a child with bounded streams and elapsed time; discard all raw stderr. */
function supervise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now(), output = [], spawnChild = options.spawn || spawn;
    let child, timer, done = false, outBytes = 0, errBytes = 0;
    /** Terminate only this child/group, retaining no error text. */
    function kill() {
      if (!child?.pid) return;
      try { if (process.platform === 'linux') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already stopped. */ }
    }
    /** Resolve after child closure or reject a bounded failure and terminate descendants. */
    function finish(error) {
      if (done) return; done = true; clearInterval(timer); kill();
      if (error) reject(error); else resolve(Buffer.concat(output));
    }
    try {
      child = spawnChild(command, args, { cwd: options.cwd || ROOT, env: options.env || hostEnvironment(), shell: false,
        windowsHide: true, detached: process.platform === 'linux', stdio: ['ignore', 'pipe', 'pipe'] });
      child.once('error', () => finish(new QualificationError('child')));
      child.stdout.on('data', bytes => {
        if (done) return;
        outBytes += bytes.length;
        if (outBytes > (options.cap || LIMITS.streamBytes)) return finish(new QualificationError('stream_limit'));
        if (options.capture !== false) output.push(bytes);
      });
      child.stderr.on('data', bytes => { errBytes += bytes.length; if (errBytes > LIMITS.streamBytes) finish(new QualificationError('stream_limit')); });
      child.once('close', (code, signal) => finish(code === 0 && !signal ? null : new QualificationError('child')));
      timer = setInterval(() => {
        if (performance.now() - start >= (options.timeoutMs || LIMITS.childMs)) return finish(new QualificationError('deadline'));
        try { options.poll?.(); } catch { finish(new QualificationError('storage')); }
      }, 100);
    } catch { finish(new QualificationError('child')); }
  });
}

/** Read committed Git bytes with fixed arguments; never invoke project hooks or code. */
function git(args, options = {}) {
  // Match checkout validation; archiveArguments supplies separate byte-preserving overrides for archive creation.
  return supervise('git', ['-C', WORKTREE, '-c', 'core.autocrlf=true', '-c', 'core.filemode=false', ...args], options);
}

/** Select ordinary application blobs and reject secret filenames before any content read. */
function sourceSelection(bytes) {
  const result = [];
  for (const line of bytes.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match) throw new QualificationError('source');
    const [, mode, oid, name] = match;
    if (!ROOTS.some(root => name === root || name.startsWith(root + '/'))) continue;
    if (!['100644', '100755'].includes(mode) || /[\\:]/.test(name) || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || name.split('/').some(part => part === '..' || part.startsWith('.env') || ['.git', '.vercel', 'node_modules', '.next'].includes(part))) throw new QualificationError('source');
    result.push({ name, oid, mode });
  }
  if (!result.length || result.length > 4096) throw new QualificationError('source');
  return result;
}

/** Derive source page names, including API routes, without reading application contents. */
function routesFromSource(manifest) {
  return manifest.filter(entry => /^src\/pages\/.+\.(js|jsx|ts|tsx)$/.test(entry.name)).map(entry => {
    const route = entry.name.replace(/^src\/pages/, '').replace(/\.(js|jsx|ts|tsx)$/, '').replace(/\/index$/, '');
    return route || '/';
  }).sort();
}

/** Verify the reviewed source/toolchain and compute a digest without writes, reservations or Docker. */
async function prepare(dependencies = {}) {
  if (!process.versions.node.startsWith('22.')) throw new QualificationError('toolchain');
  const runGit = dependencies.git || git;
  if ((await runGit(['rev-parse', 'HEAD'])).toString().trim() !== SOURCE ||
      (await runGit(['rev-parse', 'HEAD^{tree}'])).toString().trim() !== TREE ||
      (await runGit(['status', '--porcelain=v1', '--untracked-files=all'])).length) throw new QualificationError('source');
  if (fs.existsSync(DEST)) throw new QualificationError('reservation');
  const manifest = sourceSelection(await runGit(['ls-tree', '-r', '-z', SOURCE]));
  if (manifest.length !== 362) throw new QualificationError('source');
  const lockBytes = await runGit(['show', `${SOURCE}:package-lock.json`]);
  if (sha(lockBytes) !== LOCK) throw new QualificationError('source');
  const lock = JSON.parse(lockBytes);
  for (const name of ['next', 'react', 'react-dom', 'acorn']) if (lock.packages?.['node_modules/' + name]?.version !== VERSIONS[name]) throw new QualificationError('toolchain');
  if (fileHash(path.join(INPUTS, 'node-v22.23.3-linux-x64.tar.gz')) !== NODE_SHA || fileHash(path.join(INPUTS, 'npm-cache.tar')) !== CACHE_SHA) throw new QualificationError('input');
  const roots = ROOTS.filter(root => manifest.some(entry => entry.name === root || entry.name.startsWith(root + '/')));
  // Host-only reader: the disconnected container keeps its original extracted-source verification.
  const archiveTool = require('./source-archive.cjs');
  const { archive, verification } = await archiveTool.buildArchive(runGit, SOURCE, roots, manifest);
  const contract = { schemaVersion: 1, scope: 'local_compiled_middleware', source: SOURCE, tree: TREE, lockSha256: LOCK,
    versions: VERSIONS, hostNode: process.version, baseImage: BASE, nodeSha256: NODE_SHA, cacheSha256: CACHE_SHA,
    packageHashes: Object.fromEntries(FILES.map(name => [name, fileHash(path.join(__dirname, name), 1024 * 1024)])),
    sourceManifest: manifest, sourceArchiveSha256: sha(archive), sourceRoutes: routesFromSource(manifest), limits: LIMITS,
    destination: DEST, worktree: WORKTREE, inputs: INPUTS, checkoutPolicy: { autocrlf: true, filemode: false },
    archivePolicy: { autocrlf: false, eol: 'lf', comparison: 'exact_git_blob', parserSha256: archiveTool.PARSER_SHA256 }, archiveVerification: verification,
    network: 'none', requests: 6,
    gate1: 'open', hostedRuntime: 'unqualified', artifactPrivacy: 'not_evaluated' };
  return { digest: sha(JSON.stringify(contract)), contract, archive };
}

/** Write an exclusive durable JSON record; a partial destination remains consumed. */
function writeOnce(filename, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (bytes.length > LIMITS.reportBytes) throw new QualificationError('persistence');
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Monitor a fresh workspace's logical size/count; this is a polling limit, not a disk quota. */
function storageCheck(root) {
  const queue = [root]; let bytes = 0, entries = 0;
  while (queue.length) {
    const item = queue.pop(), stat = fs.lstatSync(item);
    if (++entries > LIMITS.entries || (bytes += stat.isFile() ? stat.size : 0) > LIMITS.storageBytes) throw new QualificationError('storage');
    if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of fs.readdirSync(item)) queue.push(path.join(item, name));
  }
}

/** Throttle full workspace walks while keeping the stated disk ceiling explicitly monitored. */
function storageMonitor(root) {
  let last = -Infinity;
  return () => { const now = performance.now(); if (now - last >= 2000) { storageCheck(root); last = now; } };
}

/** Fix Docker resource, network, mount and deadline settings; no host ports or credential mounts. */
function containerArgs(image, state, seconds, approval) {
  if (!/^[a-f0-9]{64}$/.test(approval || '') || !/^sha256:[a-f0-9]{64}$/.test(image) || !Number.isInteger(seconds) || seconds < 1 || seconds > 1800 || /[,\r\n]/.test(state)) throw new QualificationError('docker');
  return ['create', '--name', NAME, '--pull=never', '--platform=linux/amd64', '--network=none', '--read-only', '--init', '--restart=no',
    '--log-driver=none', '--cpus=4', '--memory=6442450944', '--memory-swap=6442450944', '--pids-limit=256',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--mount', `type=bind,source=${state},target=/state`,
    '--entrypoint=/usr/bin/timeout', image, '--signal=KILL', `${seconds}s`, '/opt/node-v22.23.3-linux-x64/bin/node', '/opt/qualification/qualify-build.cjs', '--inside', approval];
}

/** Reject configuration drift before the exact newly created container can start. */
function validateContainer(value, image, state, seconds, approval) {
  const host = value?.HostConfig, config = value?.Config;
  const args = containerArgs(image, state, seconds, approval);
  const command = args.slice(args.indexOf(image) + 1);
  const mounts = value?.Mounts;
  if (!host || !config || value.Image !== image || config.User !== '1000:1000' ||
    JSON.stringify(config.Entrypoint) !== JSON.stringify(['/usr/bin/timeout']) || JSON.stringify(config.Cmd) !== JSON.stringify(command) ||
    host.NetworkMode !== 'none' || !host.ReadonlyRootfs || host.Memory !== LIMITS.memoryBytes || host.MemorySwap !== LIMITS.memoryBytes ||
    host.NanoCpus !== 4000000000 || host.PidsLimit !== 256 || host.LogConfig?.Type !== 'none' || host.RestartPolicy?.Name !== 'no' ||
    host.Privileged || Object.keys(host.PortBindings || {}).length || host.CapAdd?.length || !host.CapDrop?.includes('ALL') ||
    !host.SecurityOpt?.some(option => option === 'no-new-privileges' || option === 'no-new-privileges=true') ||
    !Array.isArray(mounts) || mounts.length !== 1 || mounts[0].Type !== 'bind' || mounts[0].Destination !== '/state' || mounts[0].RW !== true) throw new QualificationError('docker');
  // Docker Desktop translates Windows source paths; compare its requested Mounts config as well.
  const requested = host.Mounts;
  const translated = state.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_match, drive) => drive.toLowerCase());
  const sources = [state, '/run/desktop/mnt/host/' + translated, '/host_mnt/' + translated];
  if (!sources.includes(mounts[0].Source) || !Array.isArray(requested) || requested.length !== 1 || !sources.includes(requested[0].Source) || requested[0].Target !== '/state') throw new QualificationError('docker');
  if (value.State?.Running) throw new QualificationError('docker');
  return true;
}

/** Validate every retained child fact so unexpected fields cannot become an opaque evidence dump. */
function validateFacts(facts) {
  const names = ['versions', 'nodeMiddleware', 'matcherPreserved', 'sourceRoutesPresent', 'pageCount', 'manifests', 'traceSha256', 'compiledFiles', 'compiledBytes', 'readerSha256', 'localBuildId', 'compiledClosureSha256', 'smoke'];
  if (!facts || Object.keys(facts).some(key => !names.includes(key)) || JSON.stringify(facts.versions) !== JSON.stringify(VERSIONS) ||
    facts.nodeMiddleware !== true || facts.matcherPreserved !== true || facts.sourceRoutesPresent !== true ||
    !Number.isInteger(facts.pageCount) || facts.pageCount < 1 || facts.pageCount > 4096 ||
    !Number.isInteger(facts.compiledFiles) || facts.compiledFiles < 1 || facts.compiledFiles > 1024 ||
    !Number.isInteger(facts.compiledBytes) || facts.compiledBytes < 1 || facts.compiledBytes > LIMITS.sourceBytes ||
    !/^[a-f0-9]{64}$/.test(facts.traceSha256) || !/^[a-f0-9]{64}$/.test(facts.readerSha256) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(facts.localBuildId) || !/^[a-f0-9]{64}$/.test(facts.compiledClosureSha256)) throw new QualificationError('persistence');
  const manifestNames = ['server/functions-config-manifest.json', 'server/middleware-manifest.json', 'server/pages-manifest.json', 'routes-manifest.json', 'build-manifest.json'];
  if (!facts.manifests || Object.keys(facts.manifests).sort().join('|') !== manifestNames.sort().join('|') || Object.values(facts.manifests).some(value => !/^[a-f0-9]{64}$/.test(value))) throw new QualificationError('persistence');
  if (facts.smoke !== undefined) {
    const cases = ['baseline', 'authenticated_1', 'authenticated_2', 'wrong_credential', 'query_excluded', 'protected_redirect'];
    if (!Array.isArray(facts.smoke) || facts.smoke.length !== 6) throw new QualificationError('persistence');
    for (const [index, entry] of facts.smoke.entries()) {
      const observed = index === 1 || index === 2;
      const keys = observed ? ['case', 'status', 'observation', 'challengeMatched', 'nodeVersion', 'node22', 'nativeReadCounts', 'noCookies', 'privateNoStore'] : ['case', 'status', 'observation', 'noCookies'];
      if (Object.keys(entry).sort().join('|') !== keys.sort().join('|') || entry.case !== cases[index] || entry.noCookies !== true || entry.observation !== observed ||
        (index === 5 ? ![307, 308].includes(entry.status) : entry.status !== 200)) throw new QualificationError('persistence');
      if (observed && (entry.challengeMatched !== true || entry.nodeVersion !== 'v' + VERSIONS.node || entry.node22 !== true || entry.privateNoStore !== true ||
        Object.keys(entry.nativeReadCounts || {}).sort().join('|') !== 'nodeVersion|releaseName|version' || Object.values(entry.nativeReadCounts).some(value => value !== 1))) throw new QualificationError('persistence');
    }
  }
}

/** Require a minimal validated terminal; raw or arbitrary container output never becomes evidence. */
function terminal(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new QualificationError('persistence'); }
  if (!value || value.schemaVersion !== 1 || !['complete_local_only', 'stopped'].includes(value.result) || value.source !== SOURCE || value.gate1 !== 'open' ||
      typeof value.step !== 'string' || !['prepare', 'install', 'postinstall', 'build', 'inspect', 'smoke', 'complete'].includes(value.step) ||
      !Number.isInteger(value.requests) || value.requests < 0 || value.requests > 6 || (value.failure && !CODES.has(value.failure))) throw new QualificationError('persistence');
  const allowed = ['schemaVersion', 'source', 'result', 'step', 'gate1', 'failure', 'requests', 'facts', 'cleanup'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new QualificationError('persistence');
  if (value.facts !== undefined) validateFacts(value.facts);
  if (value.cleanup !== undefined && value.cleanup !== true) throw new QualificationError('persistence');
  if (value.result === 'stopped' && !CODES.has(value.failure)) throw new QualificationError('persistence');
  if (value.result === 'complete_local_only' && (value.failure || value.step !== 'complete' || value.cleanup !== true || value.requests !== 6 || !value.facts?.smoke)) throw new QualificationError('persistence');
  if (JSON.stringify(value).length > LIMITS.reportBytes) throw new QualificationError('persistence');
  return value;
}

/** Stop only the named attempt container and confirm closure; no retries or container removal. */
async function cleanupContainer(run, created, successful) {
  if (!created) return true;
  const prefix = ['--context', 'desktop-linux'];
  let state = JSON.parse(await run('docker', [...prefix, 'inspect', '--format', '{{json .State}}', NAME]));
  if (state.Running) {
    await run('docker', [...prefix, 'kill', NAME], { capture: false });
    state = JSON.parse(await run('docker', [...prefix, 'inspect', '--format', '{{json .State}}', NAME]));
  }
  if (state.Running !== false || state.OOMKilled !== false || (successful && state.ExitCode !== 0)) throw new QualificationError('cleanup');
  return true;
}

/** Run one explicitly approved local attempt; always verify that its exact container stopped. */
async function execute(approval) {
  const prepared = await prepare();
  if (!/^[a-f0-9]{64}$/.test(approval || '') || approval !== prepared.digest) throw new QualificationError('approval');
  const started = performance.now();
  /** Carry one shared deadline across image assembly, build, inspection and smoke. */
  function remaining() { const ms = LIMITS.overallMs - (performance.now() - started); if (ms <= 0) throw new QualificationError('deadline'); return ms; }
  /** Target only the named local Linux Docker engine, with no automatic start or pull. */
  function docker(args, options = {}) { return supervise('docker', ['--context', 'desktop-linux', ...args], { timeoutMs: Math.min(LIMITS.childMs, remaining()), ...options }); }
  const base = JSON.parse((await docker(['image', 'inspect', BASE])).toString());
  const baseDigests = [BASE, BASE.replace('docker.io/', ''), BASE.replace('docker.io/library/', '')];
  if (base.length !== 1 || base[0].Os !== 'linux' || base[0].Architecture !== 'amd64' || !base[0].RepoDigests?.some(digest => baseDigests.includes(digest))) throw new QualificationError('docker');
  if ((await docker(['ps', '-aq', '--filter', `name=^/${NAME}$`])).length) throw new QualificationError('reservation');
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.mkdirSync(DEST);
  writeOnce(path.join(DEST, 'profile.json'), { digest: prepared.digest, contract: prepared.contract });
  writeOnce(path.join(DEST, 'reservation.json'), { digest: prepared.digest, state: 'reserved_no_replay' });
  const report = { schemaVersion: 1, source: SOURCE, digest: prepared.digest, gate1: 'open', result: 'stopped', failure: null, containerStopped: false, terminal: null };
  let created = false;
  try {
    const context = path.join(DEST, 'context'), state = path.join(DEST, 'state');
    fs.mkdirSync(context); fs.mkdirSync(state);
    for (const name of ['node-v22.23.3-linux-x64.tar.gz', 'npm-cache.tar']) fs.copyFileSync(path.join(INPUTS, name), path.join(context, name), fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(context, 'source.tar'), prepared.archive, { flag: 'wx' });
    for (const name of ['qualify-build.cjs', 'inspect-compiled.cjs', 'qualification.Dockerfile']) fs.copyFileSync(path.join(__dirname, name), path.join(context, name), fs.constants.COPYFILE_EXCL);
    writeOnce(path.join(context, 'contract.json'), { digest: prepared.digest, contract: prepared.contract });
    if (fileHash(path.join(context, 'node-v22.23.3-linux-x64.tar.gz')) !== NODE_SHA || fileHash(path.join(context, 'npm-cache.tar')) !== CACHE_SHA ||
        fileHash(path.join(context, 'source.tar')) !== prepared.contract.sourceArchiveSha256) throw new QualificationError('input');
    for (const name of ['qualify-build.cjs', 'inspect-compiled.cjs', 'qualification.Dockerfile']) if (fileHash(path.join(context, name)) !== prepared.contract.packageHashes[name]) throw new QualificationError('input');
    await docker(['build', '--network=none', '--pull=false', '--no-cache', '--platform=linux/amd64', '--iidfile', path.join(context, 'image-id.txt'), '-f', path.join(context, 'qualification.Dockerfile'), context],
      { timeoutMs: remaining(), capture: false, poll: storageMonitor(DEST) });
    const image = fs.readFileSync(path.join(context, 'image-id.txt'), 'utf8').trim();
    created = true;
    const seconds = Math.floor(remaining() / 1000);
    await docker(containerArgs(image, state, seconds, prepared.digest));
    const inspection = JSON.parse(await docker(['inspect', NAME]));
    if (inspection.length !== 1) throw new QualificationError('docker');
    validateContainer(inspection[0], image, state, seconds, prepared.digest);
    const bytes = await docker(['start', '--attach', NAME], { timeoutMs: remaining(), cap: LIMITS.reportBytes, poll: storageMonitor(DEST) });
    report.terminal = terminal(bytes);
    report.result = report.terminal.result;
    report.failure = report.terminal.failure || null;
  } catch (error) { report.failure = CODES.has(error.code) ? error.code : 'internal'; }
  finally {
    // Cleanup has its own short allowance after the exercise deadline, and makes no application request.
    try {
      report.containerStopped = await cleanupContainer(supervise, created, report.result === 'complete_local_only');
    } catch { report.failure = 'cleanup'; }
    if (report.failure || !report.containerStopped) report.result = 'stopped';
    writeOnce(path.join(DEST, 'report.json'), report);
  }
  return report;
}

/** Build an explicit synthetic environment; never inherit host or provider secrets. */
function syntheticEnvironment() {
  return { PATH: '/opt/node-v22.23.3-linux-x64/bin:/usr/bin:/bin', HOME: '/state/home', TMPDIR: '/state/tmp', TEMP: '/state/tmp', TMP: '/state/tmp',
    CI: '1', NODE_ENV: 'production', NODE_DISABLE_COMPILE_CACHE: '1', NEXT_TELEMETRY_DISABLED: '1', npm_config_cache: '/state/cache',
    npm_config_userconfig: '/state/empty-user.npmrc', npm_config_globalconfig: '/state/empty-global.npmrc', npm_config_offline: 'true',
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    NEXT_PUBLIC_SUPABASE_URL: 'https://ci-build.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'ci-build-only-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'ci-build-only-service-role-key', CSRF_SECRET: 'ci-build-only-secret-at-least-32-characters',
    VERCEL: '1', VERCEL_ENV: 'preview', GATE1_MIDDLEWARE_RUNTIME_PROBE_ENABLED: 'true', GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET: 'a'.repeat(64) };
}

/** Verify extracted source against committed blob IDs, rejecting unexpected or missing files. */
function verifySource(root, manifest) {
  const expected = new Map(manifest.map(entry => [entry.name, entry])), queue = [root]; let bytes = 0, found = 0;
  while (queue.length) {
    const item = queue.pop(), stat = fs.lstatSync(item);
    if (stat.isSymbolicLink()) throw new QualificationError('source');
    if (stat.isDirectory()) { for (const name of fs.readdirSync(item)) queue.push(path.join(item, name)); continue; }
    const name = path.relative(root, item).split(path.sep).join('/'), entry = expected.get(name);
    if (!entry || !stat.isFile() || (bytes += stat.size) > LIMITS.sourceBytes || name.split('/').some(part => part.startsWith('.env'))) throw new QualificationError('source');
    const content = fs.readFileSync(item);
    const oid = crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    if (oid !== entry.oid) throw new QualificationError('source');
    found++;
  }
  if (found !== expected.size) throw new QualificationError('source');
}

/** Recheck just the committed files after install/build; generated dependencies/output are expected extras. */
function verifySelectedSource(root, manifest) {
  for (const entry of manifest) {
    const filename = path.join(root, entry.name), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.sourceBytes) throw new QualificationError('source');
    const bytes = fs.readFileSync(filename);
    if (crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.oid) throw new QualificationError('source');
  }
}

/** Construct the six finite loopback cases; challenges are fresh and never retained in reports. */
function smokeCases() {
  const { HEADERS } = require('./inspect-compiled.cjs');
  const cases = [
    { case: 'baseline', path: '/login' },
    { case: 'authenticated_1', path: '/login', observe: true, marked: true },
    { case: 'authenticated_2', path: '/login', observe: true, marked: true },
    { case: 'wrong_credential', path: '/login', marked: true },
    { case: 'query_excluded', path: '/login?scope=1' },
    { case: 'protected_redirect', path: '/admin', protected: true },
  ];
  return cases.map(item => {
    const challenge = crypto.randomBytes(16).toString('hex');
    return { ...item, challenge, headers: item.case === 'baseline' ? {} : {
      [HEADERS.key]: (item.case === 'wrong_credential' ? 'c' : 'a').repeat(64), [HEADERS.challenge]: challenge } };
  });
}

/** Exercise a production server entirely inside the network-disabled container, restoring instrumentation. */
async function smoke(app, inspection, report) {
  const inspector = require('./inspect-compiled.cjs'), http = require('node:http');
  const nativeVersion = process.version, observer = inspector.observeNativeReads(inspection.readers[0]);
  let next, server;
  const sockets = new Set();
  try {
    next = require(path.join(app, 'node_modules/next'))({ dev: false, dir: app, hostname: '127.0.0.1', port: 32147 });
    await next.prepare();
    server = http.createServer(next.getRequestHandler());
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(32147, '127.0.0.1', resolve); });
    const results = [];
    for (const request of smokeCases()) {
      observer.reset(); report.requests++;
      const result = await inspector.getLocal(request);
      results.push(inspector.reviewResponse(result, request, observer.snapshot(), nativeVersion));
    }
    for (const file of inspection.fingerprints) if (fileHash(file.filename) !== file.sha256) throw new QualificationError('source');
    return results;
  } finally {
    observer.restore();
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (next) await next.close();
    // A cleanup failure intentionally takes precedence over an earlier smoke failure.
    // eslint-disable-next-line no-unsafe-finally
    if (server?.listening) throw new QualificationError('cleanup');
  }
}

/** Execute within the fixed isolated image; commands and output paths cannot be supplied by a caller. */
async function inside(approval) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node !== VERSIONS.node || process.getuid() !== 1000) throw new QualificationError('toolchain');
  const envelope = JSON.parse(fs.readFileSync('/opt/qualification/contract.json', 'utf8'));
  if (approval !== envelope.digest || sha(JSON.stringify(envelope.contract)) !== envelope.digest || envelope.contract.source !== SOURCE) throw new QualificationError('approval');
  for (const name of ['qualify-build.cjs', 'inspect-compiled.cjs']) if (fileHash(path.join('/opt/qualification', name)) !== envelope.contract.packageHashes[name]) throw new QualificationError('input');
  const report = { schemaVersion: 1, source: SOURCE, gate1: 'open', result: 'stopped', step: 'prepare', requests: 0 };
  const env = syntheticEnvironment(), app = '/state/app', started = performance.now();
  const originalOut = process.stdout.write.bind(process.stdout), originalErr = process.stderr.write.bind(process.stderr);
  let discarded = 0;
  /** Suppress ordinary framework output; raw local logs are not a retained diagnostic surface. */
  function discard(chunk, encoding, callback) {
    discarded += Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined);
    if (discarded > LIMITS.streamBytes) throw new QualificationError('stream_limit');
    if (typeof encoding === 'function') encoding(); else callback?.(); return true;
  }
  process.stdout.write = discard; process.stderr.write = discard;
  const monitor = storageMonitor('/state');
  /** Bound each process by the remaining local time and monitored workspace budget. */
  function options() {
    const remaining = LIMITS.overallMs - (performance.now() - started);
    if (remaining <= 0) throw new QualificationError('deadline');
    return { cwd: app, env, timeoutMs: remaining, capture: false, poll: monitor };
  }
  try {
    if (fs.readdirSync('/state').length) throw new QualificationError('reservation');
    verifySource('/opt/source', envelope.contract.sourceManifest);
    for (const name of ['home', 'tmp']) fs.mkdirSync('/state/' + name);
    for (const name of ['empty-user.npmrc', 'empty-global.npmrc']) fs.writeFileSync('/state/' + name, '', { flag: 'wx' });
    fs.cpSync('/opt/source', app, { recursive: true, errorOnExist: true, force: false });
    fs.cpSync('/opt/npm-cache', '/state/cache', { recursive: true, errorOnExist: true, force: false });
    verifySource(app, envelope.contract.sourceManifest);
    // Runtime code receives only the synthetic allowlist, including the explicitly synthetic probe setting.
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    report.step = 'install';
    const npm = '/opt/node-v22.23.3-linux-x64/bin/npm';
    const npmVersion = (await supervise(npm, ['--version'], { ...options(), capture: true, cap: 128 })).toString().trim();
    if (npmVersion !== VERSIONS.npm) throw new QualificationError('toolchain');
    await supervise(npm, ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--include=dev'], options());
    for (const name of ['next', 'react', 'react-dom', 'acorn']) {
      if (JSON.parse(fs.readFileSync(path.join(app, 'node_modules', name, 'package.json'), 'utf8')).version !== VERSIONS[name]) throw new QualificationError('toolchain');
    }
    if (fileHash(path.join(app, 'package-lock.json')) !== LOCK) throw new QualificationError('source');
    report.step = 'postinstall';
    await supervise(npm, ['run', 'postinstall', '--offline'], options());
    report.step = 'build';
    await supervise(npm, ['run', 'build'], options());
    verifySelectedSource(app, envelope.contract.sourceManifest);
    report.step = 'inspect';
    const inspector = require('./inspect-compiled.cjs');
    const inspection = inspector.inspect(app, envelope.contract.sourceRoutes, require(path.join(app, 'node_modules/acorn')).parse);
    report.facts = { versions: VERSIONS, ...inspection.facts, manifests: inspection.manifests, traceSha256: inspection.traceHash,
      compiledFiles: inspection.compiledFiles, compiledBytes: inspection.compiledBytes, readerSha256: inspection.readers[0].sha256,
      localBuildId: inspection.buildId, compiledClosureSha256: inspection.compiledClosureHash };
    report.step = 'smoke';
    report.facts.smoke = await smoke(app, inspection, report);
    verifySelectedSource(app, envelope.contract.sourceManifest);
    if (fileHash(path.join(app, 'package-lock.json')) !== LOCK) throw new QualificationError('source');
    storageCheck('/state');
    report.step = 'complete'; report.cleanup = true; report.result = 'complete_local_only';
  } catch (error) { report.failure = CODES.has(error.code) ? error.code : 'internal'; }
  finally { process.stdout.write = originalOut; process.stderr.write = originalErr; }
  originalOut(JSON.stringify(report) + '\n');
  // Exit closes any framework worker left after next.close; the host separately verifies container termination.
  process.exit(0);
}

/** Dispatch only explicit preparation/execution modes; errors are sanitized at the process boundary. */
async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--prepare') {
    const prepared = await prepare();
    return { digest: prepared.digest, source: SOURCE, tree: TREE, versions: VERSIONS, files: FILES, sourceFiles: prepared.contract.sourceManifest.length, archiveVerification: prepared.contract.archiveVerification, sourceArchiveSha256: prepared.contract.sourceArchiveSha256, status: 'prepared_only', gate1: 'open' };
  }
  if (args.length === 2 && args[0] === '--execute') return execute(args[1]);
  if (args.length === 2 && args[0] === '--inside') return inside(args[1]);
  throw new QualificationError('input');
}

if (require.main === module) main().then(result => { if (result) process.stdout.write(JSON.stringify(result) + '\n'); }).catch(error => {
  process.stderr.write(JSON.stringify({ result: 'stopped', failure: CODES.has(error.code) ? error.code : 'internal', gate1: 'open' }) + '\n'); process.exitCode = 1;
});

module.exports = { SOURCE, TREE, LOCK, VERSIONS, FILES, LIMITS, BASE, QualificationError, sha, fileHash, hostEnvironment, supervise, sourceSelection,
  routesFromSource, prepare, writeOnce, storageCheck, containerArgs, validateContainer, validateFacts, terminal, cleanupContainer, syntheticEnvironment, verifySource, smokeCases, main };
