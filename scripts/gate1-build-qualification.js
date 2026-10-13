'use strict';

/**
 * Owner-run, offline Docker qualification. Preparation reads reviewed inputs only.
 * Setup, build and inspection consume independent approvals; no deployments/retries.
 * The image bootstrap deliberately uses only Node built-ins until offline npm ci finishes.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { TextDecoder } = require('node:util');

const ROOT = path.resolve(__dirname, '..');
const SCOPE = 'gate1_docker_synthetic_qualification_v1';
const CONTEXT = 'desktop-linux';
const VOLUME = 'gate1-build-qualification-v1';
const CONTAINER = 'gate1-build-qualification-owner-v1';
const BASE_IMAGE = 'docker.io/library/amazonlinux@sha256:500790b3c980438d9d6cde6c149e59dda1992660941a814198b95ed56574fb96';
const NODE_ARCHIVE = 'node-v22.23.3-linux-x64.tar.gz';
const NODE_SHA = '1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af';
const VERSIONS = Object.freeze({ node: '22.23.3', npm: '10.9.9', next: '16.3.3', vercel: '50.33.1',
  '@vercel/next': '4.16.1', '@vercel/node': '5.6.16', '@vercel/static-build': '2.9.1', zod: '4.3.6' });
const TOOL_DEPS = Object.freeze(Object.fromEntries(['vercel', '@vercel/next', '@vercel/node', '@vercel/static-build', 'zod']
  .map((name) => [name, VERSIONS[name]])));
const FILES = Object.freeze(['gate1-build-qualification.js', 'run-gate1-build-qualification.ps1',
  'gate1-build-qualification.Dockerfile', 'gate1-build-artifact-privacy.js', 'run-gate1-build-artifact-privacy.ps1']);
const LIMITS = Object.freeze({ setupMs: 1800000, buildMs: 1800000, inspectMs: 135000,
  commandMs: 30000, inputMs: 10000, inputBytes: 65536, reportBytes: 8388608,
  logBytes: 8388608, sourceBytes: 134217728, archiveBytes: 1073741824,
  storageBytes: 8589934592, storageEntries: 250000, storagePollMs: 2000,
  cpus: 4, memoryBytes: 6442450944, pids: 256, tmpfsBytes: 536870912 });
const ATTESTATIONS = Object.freeze(['sourceReviewed', 'toolchainLockReviewed', 'cacheArchiveReviewed',
  'localSettingsReviewed', 'syntheticInputsReviewed', 'exclusiveVolumeControl', 'privateRetentionReviewed',
  'coverageLimitationsReviewed', 'monitoredStorageLimitAccepted']);
const SCAN_ATTESTATIONS = Object.freeze(['sourceCodeReviewed', 'newBuildProvenanceReviewed',
  'comparisonSelectionReviewed', 'exclusiveOutputControl', 'noEnvironmentFiles',
  'privateOutputAccessReviewed', 'coverageLimitationsReviewed']);
const LABELS = Object.freeze(['ceiling_hmac', 'redis_token', 'supabase_service_role', 'csrf_secret']);
const INPUT_NAMES = Object.freeze(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', 'CSRF_SECRET', 'TEMPORARY_SESSION_CEILING_SECRET_MODE',
  'TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON', 'TEMPORARY_SESSION_CEILING_UPSTASH_JSON']);
const SOURCE_ROOTS = Object.freeze(['src', 'public', 'patches', 'package.json', 'package-lock.json',
  'next.config.js', 'postcss.config.js', 'tailwind.config.js', 'jsconfig.json', 'tsconfig.json',
  'scripts/validate-build-env.js']);
const SETTINGS = Object.freeze({ projectId: 'prj_gate1_synthetic_local', orgId: 'team_gate1_synthetic_local',
  settings: { framework: 'nextjs', nodeVersion: '22.x', buildCommand: 'npm run build',
    installCommand: 'node -e "process.exit(0)"', devCommand: null, outputDirectory: null, rootDirectory: null } });
const CODES = new Set(['input', 'profile', 'source', 'forbidden', 'lock', 'artifact', 'approval', 'reservation',
  'persistence', 'child', 'deadline', 'stream_limit', 'storage', 'docker', 'toolchain', 'preparation', 'internal']);

/** Retain only fixed diagnostic codes, never raw child errors, filenames or input values. */
class QualificationError extends Error {
  /** Map unexpected errors to a stable non-sensitive failure category. */
  constructor(code) { super(CODES.has(code) ? code : 'internal'); this.code = this.message; }
}

/** Hash public source/toolchain contracts; private comparison values are never hashed into reports. */
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** Reject control characters in paths without relying on platform-specific path normalization. */
function hasControl(value) { return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127); }

/** Parse original UTF-8 JSON strictly, rejecting duplicate keys before schema normalization. */
function strictJson(bytes) {
  try {
    const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text), stack = [];
    const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) || [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '{' || token === '[') stack.push(token === '{' ? new Set() : null);
      else if (token === '}' || token === ']') stack.pop();
      else if (token.startsWith('"') && tokens[i + 1] === ':') {
        const key = JSON.parse(token), keys = stack[stack.length - 1];
        if (!keys || keys.has(key)) throw new Error();
        keys.add(key);
      }
      if (stack.length > 64) throw new Error();
    }
    return value;
  } catch { throw new QualificationError('input'); }
}

/** Reject environment/credential paths before opening them, even through an ancestor alias. */
function safePath(location) {
  if (typeof location !== 'string' || !path.isAbsolute(location) || path.resolve(location) !== location ||
      /^[/\\]{2}/.test(location) || /[,"<>|]/.test(location) || hasControl(location) ||
      (process.platform === 'win32' && location.slice(2).includes(':'))) throw new QualificationError('profile');
  const parts = path.relative(path.parse(location).root, location).split(path.sep);
  let current = path.parse(location).root;
  for (const part of parts) {
    if (forbidden(part)) throw new QualificationError('forbidden');
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new QualificationError('forbidden');
  }
  return location;
}

/** Block names which can carry host credentials or environment files; never open their contents. */
function forbidden(name) {
  return /^(?:\.env(?:\..*)?|\.git|\.aws|\.ssh|\.codex|\.vercel|\.npmrc|\.netrc|auth\.json|credentials(?:\.json)?)$/i.test(name);
}

/** Read one regular single-link bounded public file with identity checks around the read. */
function publicFile(location, limit = LIMITS.reportBytes) {
  safePath(location);
  const before = fs.lstatSync(location);
  if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new QualificationError('artifact');
  const bytes = fs.readFileSync(location), after = fs.lstatSync(location);
  if (before.ino !== after.ino || before.size !== bytes.length || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs) throw new QualificationError('artifact');
  return bytes;
}

/** Hash large approved archives in bounded blocks instead of loading a cache into host memory. */
function fileHash(location) {
  safePath(location);
  const before = fs.lstatSync(location);
  if (!before.isFile() || before.nlink !== 1 || before.size > LIMITS.archiveBytes) throw new QualificationError('artifact');
  const fd = fs.openSync(location, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const hash = createHash('sha256'), block = Buffer.alloc(65536);
  let total = 0;
  try {
    let count;
    while ((count = fs.readSync(fd, block, 0, block.length, null))) { total += count; hash.update(block.subarray(0, count)); }
    const after = fs.fstatSync(fd);
    if (total !== before.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs) throw new QualificationError('artifact');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

/** Load Zod lazily: the immutable image bootstrap has no installed dependencies until setup finishes. */
function schema() {
  const { z } = require('zod');
  const hex = z.string().regex(/^[a-f0-9]{64}$/).refine((v) => !/^0+$/.test(v));
  return z.object({ schemaVersion: z.literal(1), scope: z.literal(SCOPE),
    source: z.object({ root: z.string().min(1).max(1024), gitSha: z.string().regex(/^[a-f0-9]{40}$/)
      .refine((v) => !/^0+$/.test(v)), lockSha256: hex }).strict(),
    artifacts: z.object({ root: z.string().min(1).max(1024), toolchainLockSha256: hex,
      cacheSha256: hex, nodeSha256: z.literal(NODE_SHA) }).strict(),
    settings: z.literal('reviewed_synthetic_local_project_v1'),
    inputs: z.literal('generated_synthetic_server_values_v1'),
    attestations: z.object(Object.fromEntries(ATTESTATIONS.map((key) => [key, z.literal(true)]))).strict(),
    inspectionAttestations: z.object(Object.fromEntries(SCAN_ATTESTATIONS.map((key) => [key, z.literal(true)]))).strict().optional(),
  }).strict();
}

/** Supply an intentionally unapproved template; no filesystem or Docker operation is necessary. */
function template() {
  return { schemaVersion: 1, scope: SCOPE,
    source: { root: path.resolve('REVIEWED_CLEAN_SOURCE'), gitSha: '0'.repeat(40), lockSha256: '0'.repeat(64) },
    artifacts: { root: path.resolve('REVIEWED_OFFLINE_ARTIFACTS'), toolchainLockSha256: '0'.repeat(64),
      cacheSha256: '0'.repeat(64), nodeSha256: NODE_SHA }, settings: 'reviewed_synthetic_local_project_v1',
    inputs: 'generated_synthetic_server_values_v1',
    attestations: Object.fromEntries(ATTESTATIONS.map((key) => [key, false])) };
}

/** Validate immutable profile selections; extra keys cannot introduce commands, mounts or network options. */
function parseProfile(value) {
  const parsed = schema().safeParse(value);
  if (!parsed.success) throw new QualificationError('profile');
  safePath(parsed.data.source.root); safePath(parsed.data.artifacts.root);
  return parsed.data;
}

/** Strip inherited provider credentials, Git hooks/config overrides and Node options from child environments. */
function hostEnvironment() {
  const names = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME'];
  return { ...Object.fromEntries(names.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
}

/** Supervise one child with monotonic deadline, bounded streams and group termination; discard raw stderr. */
function supervise(command, args, options = {}) {
  const { timeoutMs = LIMITS.commandMs, outputBytes = LIMITS.reportBytes, input, cwd = ROOT,
    env = hostEnvironment(), capture = true, outputFile, inputFile, uid, gid, poll } = options;
  return new Promise((resolve, reject) => {
    const started = performance.now(), chunks = [];
    let child, settled = false, size = 0, errSize = 0, timer, fd, inputStream;
    /** Kill the entire Linux process group, including descendants holding output pipes open. */
    function kill() {
      if (!child?.pid) return;
      try { if (process.platform === 'linux') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ }
    }
    /** Close persistent output and resolve only after clean exit; failures never return raw child text. */
    function finish(error) {
      if (settled) return; settled = true; clearInterval(timer);
      inputStream?.destroy(); kill();
      if (fd !== undefined) {
        try { fs.fsyncSync(fd); } catch { error = new QualificationError('persistence'); }
        try { fs.closeSync(fd); } catch { error = new QualificationError('persistence'); }
      }
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    }
    try {
      if (outputFile) fd = fs.openSync(outputFile, 'wx', 0o600);
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform === 'linux',
        stdio: ['pipe', 'pipe', 'pipe'], ...(uid === undefined ? {} : { uid, gid }) });
      child.once('error', () => finish(new QualificationError('child')));
      child.stdin.on('error', () => finish(new QualificationError('child')));
      child.stdout.on('data', (bytes) => {
        if (settled) return; size += bytes.length;
        if (size > outputBytes) return finish(new QualificationError('stream_limit'));
        try { if (fd !== undefined) fs.writeSync(fd, bytes); else if (capture) chunks.push(bytes); }
        catch { finish(new QualificationError('persistence')); }
      });
      child.stderr.on('data', (bytes) => {
        errSize += bytes.length;
        if (errSize > LIMITS.logBytes) finish(new QualificationError('stream_limit'));
      });
      child.once('close', (code, signal) => finish(code === 0 && !signal ? null : new QualificationError('child')));
      timer = setInterval(() => {
        if (performance.now() - started >= timeoutMs) return finish(new QualificationError('deadline'));
        try { if (poll) poll(); } catch { finish(new QualificationError('storage')); }
      }, Math.min(100, timeoutMs));
      if (inputFile) {
        inputStream = fs.createReadStream(inputFile);
        inputStream.on('error', () => finish(new QualificationError('artifact'))); inputStream.pipe(child.stdin);
      } else if (input && input.length > LIMITS.inputBytes) finish(new QualificationError('input'));
      else child.stdin.end(input);
    } catch { finish(new QualificationError('child')); }
  });
}

/** Run Git with fixed argument vectors; source operations never execute checked-in code. */
async function git(root, args, options = {}) {
  return supervise('git', ['-C', root, ...args], { ...options, cwd: ROOT });
}

/** Select reviewed application files only; exclude host configuration, generated output and Git metadata. */
function sourceSelection(tree) {
  const selected = [];
  for (const entry of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match) throw new QualificationError('source');
    const [, mode, , name] = match;
    if (!SOURCE_ROOTS.some((root) => name === root || name.startsWith(root + '/'))) continue;
    if (!['100644', '100755'].includes(mode) || name.split('/').some((part) => forbidden(part) ||
        ['..', 'node_modules', '.next', '.tmp'].includes(part)) ||
        /[\\:]/.test(name) || hasControl(name)) throw new QualificationError('forbidden');
    selected.push(name);
  }
  if (!['package.json', 'package-lock.json', 'next.config.js', 'scripts/validate-build-env.js'].every((name) => selected.includes(name))) {
    throw new QualificationError('source');
  }
  return selected;
}

/** Require registry-only locked packages with integrity; local/git/url aliases and mutable inputs are rejected. */
function checkLock(bytes, toolchain = false) {
  const lock = strictJson(bytes);
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') throw new QualificationError('lock');
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (!entry || typeof entry !== 'object' || !name.startsWith('node_modules/') || name.split('/').includes('..') || entry.link ||
        !/^https:\/\/registry\.npmjs\.org\/[^?#]+\.tgz$/.test(entry.resolved || '') ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity || '') || typeof entry.version !== 'string') throw new QualificationError('lock');
  }
  const expected = toolchain ? TOOL_DEPS : { next: VERSIONS.next };
  for (const [name, version] of Object.entries(expected)) {
    if (lock.packages['']?.dependencies?.[name] !== version || lock.packages[`node_modules/${name}`]?.version !== version) {
      throw new QualificationError('lock');
    }
  }
  return lock;
}

/** Validate npm cache tar, permitting bounded GNU long names for SHA-512 cache filenames but no links/PAX/devices. */
function checkCacheTar(location) {
  const fd = fs.openSync(safePath(location), 'r'), stat = fs.fstatSync(fd), header = Buffer.alloc(512);
  let offset = 0, entries = 0, ended = false, longName = null;
  try {
    while (offset + 512 <= stat.size) {
      if (fs.readSync(fd, header, 0, 512, offset) !== 512) throw new QualificationError('artifact');
      if (header.every((byte) => byte === 0)) { ended = true; break; }
      const name = header.subarray(0, 100).toString('utf8').split('\0')[0];
      const magic = header.subarray(257, 263).toString('ascii');
      const prefix = magic === 'ustar\0' ? header.subarray(345, 500).toString('utf8').split('\0')[0] : '';
      const length = header.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim();
      const type = header[156], sumText = header.subarray(148, 156).toString('ascii').replace(/\0/g, '').trim();
      const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
      const full = longName || (prefix ? prefix + '/' : '') + name;
      if (!/^[0-7]+$/.test(length) || !/^[0-7]+$/.test(sumText) || sum !== parseInt(sumText, 8) ||
          !['ustar\0', 'ustar '].includes(magic) || ++entries > LIMITS.storageEntries) {
        throw new QualificationError('artifact');
      }
      const size = parseInt(length, 8);
      if (type === 76) {
        if (longName || name !== '././@LongLink' || size < 2 || size > 1025) throw new QualificationError('artifact');
        const bytes = Buffer.alloc(size);
        if (fs.readSync(fd, bytes, 0, size, offset + 512) !== size || bytes[size - 1] !== 0) throw new QualificationError('artifact');
        try { longName = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)); }
        catch { throw new QualificationError('artifact'); }
        offset += 512 + Math.ceil(size / 512) * 512; continue;
      }
      if (![0, 48, 53].includes(type) || !/^_cacache(?:\/[A-Za-z0-9._/-]+)?\/?$/.test(full) ||
          full.split('/').some((part) => part === '..' || part === '.' || forbidden(part))) throw new QualificationError('artifact');
      longName = null;
      if (size > LIMITS.archiveBytes || (type === 53 && size !== 0)) throw new QualificationError('artifact');
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    if (!ended || !entries || longName || offset + 1024 > stat.size) throw new QualificationError('artifact');
    // Reject appended archives or data hidden after the first end marker.
    const block = Buffer.alloc(65536);
    while (offset < stat.size) {
      const count = fs.readSync(fd, block, 0, Math.min(block.length, stat.size - offset), offset);
      if (!count || block.subarray(0, count).some((byte) => byte !== 0)) throw new QualificationError('artifact');
      offset += count;
    }
  } finally { fs.closeSync(fd); }
}

/** Bind every executable plus the current execution dependency lock; no output directory is read. */
function executionIntegrity() {
  return Object.fromEntries([...FILES.map((name) => [name, sha(publicFile(path.join(__dirname, name)))]),
    ['package-lock.json', sha(publicFile(path.join(ROOT, 'package-lock.json')))]]);
}

/** Validate preparation without Docker or writes; source bytes come from the reviewed commit, never the worktree. */
async function prepare(value, dependencies = {}) {
  const p = parseProfile(value), runGit = dependencies.git || git, hashFile = dependencies.fileHash || fileHash;
  if ((await runGit(p.source.root, ['rev-parse', 'HEAD'])).toString().trim() !== p.source.gitSha ||
      (await runGit(p.source.root, ['status', '--porcelain=v1', '--untracked-files=all'])).length !== 0) throw new QualificationError('source');
  const tree = await runGit(p.source.root, ['ls-tree', '-r', '-z', p.source.gitSha]);
  const selected = sourceSelection(tree);
  const sourceManifest = tree.toString('utf8').split('\0').filter(Boolean).map((entry) => {
    const [, mode, oid, name] = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    return { mode, oid, name };
  }).filter((entry) => selected.includes(entry.name));
  const lock = await runGit(p.source.root, ['show', `${p.source.gitSha}:package-lock.json`]);
  if (sha(lock) !== p.source.lockSha256) throw new QualificationError('lock');
  checkLock(lock);
  const sourcePackage = strictJson(await runGit(p.source.root, ['show', `${p.source.gitSha}:package.json`]));
  if (sourcePackage.dependencies?.next !== VERSIONS.next) throw new QualificationError('lock');
  const toolLock = publicFile(path.join(p.artifacts.root, 'toolchain-lock.json'));
  if (sha(toolLock) !== p.artifacts.toolchainLockSha256) throw new QualificationError('lock');
  checkLock(toolLock, true);
  const manifestBytes = publicFile(path.join(p.artifacts.root, 'toolchain-package.json'));
  const manifest = strictJson(manifestBytes);
  if (manifest.private !== true || Object.keys(manifest).some((key) => !['name', 'version', 'private', 'dependencies'].includes(key)) ||
      JSON.stringify(Object.entries(manifest.dependencies || {}).sort()) !== JSON.stringify(Object.entries(TOOL_DEPS).sort())) throw new QualificationError('lock');
  if (hashFile(path.join(p.artifacts.root, NODE_ARCHIVE)) !== NODE_SHA ||
      hashFile(path.join(p.artifacts.root, 'npm-cache.tar')) !== p.artifacts.cacheSha256) throw new QualificationError('artifact');
  checkCacheTar(path.join(p.artifacts.root, 'npm-cache.tar'));
  const integrity = executionIntegrity();
  const contract = { scope: SCOPE, sourceSha: p.source.gitSha, lockSha256: p.source.lockSha256,
    artifacts: { ...p.artifacts, root: undefined, toolchainManifestSha256: sha(manifestBytes) }, integrity, settings: SETTINGS,
    inputs: INPUT_NAMES, labels: LABELS, limits: LIMITS, versions: VERSIONS,
    baseImage: BASE_IMAGE, volume: VOLUME, context: CONTEXT, sourceManifest, attestations: p.attestations };
  return { schemaVersion: 1, mode: 'prepare', gate1Status: 'open', binding: sha(JSON.stringify(contract)),
    setupApproval: sha(JSON.stringify({ stage: 'setup', contract })), contract, selected,
    inspectionAttestations: p.inspectionAttestations,
    artifactReads: 0, dockerOperations: 0, builds: 0, inspections: 0,
    storageEnforcement: 'monitored_threshold_not_hard_quota', setupApproved: false };
}

/** Resolve one registry shared by linked worktrees; changing execution worktree cannot reset consumed approvals. */
async function registryRoot() {
  const common = (await git(ROOT, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString().trim();
  return safePath(path.join(path.dirname(common), '.tmp/gate1-build-qualification'));
}

/** Persist JSON exclusively and fsync before continuing; inability to retain evidence is non-passing. */
function writeOnce(location, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > LIMITS.reportBytes) throw new QualificationError('persistence');
  let fd;
  try { fd = fs.openSync(location, 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  catch { throw new QualificationError('persistence'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Reserve each source/stage forever before side effects; no run ID exists to bypass this key. */
function reserve(root, sourceSha, stage, approval) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !['setup', 'build', 'inspect'].includes(stage)) throw new QualificationError('reservation');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { writeOnce(path.join(root, `${sourceSha}.${stage}.reservation.json`), { scope: SCOPE, stage, sourceSha, approval, consumed: true }); }
  catch { throw new QualificationError('reservation'); }
}

/** Load sanitized setup/build receipts; never read raw output while preparing another stage. */
function receipt(root, sourceSha, stage) {
  return strictJson(publicFile(path.join(root, `${sourceSha}.${stage}.receipt.json`)));
}

/** Bind a later stage to the exact setup image and, for inspection, the Linux-prepared scan profile. */
function stageReview(prepared, stage, setup, build) {
  if (!['build', 'inspect'].includes(stage) || setup.binding !== prepared.binding ||
      setup.result !== 'completed' || setup.persistenceFailure || setup.teardownUnconfirmed ||
      !/^sha256:[a-f0-9]{64}$/.test(setup.imageId || '') ||
      typeof setup.daemonId !== 'string' || !setup.daemonId || setup.daemonId.length > 128) throw new QualificationError('preparation');
  if (stage === 'inspect' && (build?.result !== 'completed' || build.persistenceFailure || build.teardownUnconfirmed || build.binding !== prepared.binding ||
      build.imageId !== setup.imageId || !/^[a-f0-9]{64}$/.test(build.inspection?.approvalId || ''))) throw new QualificationError('preparation');
  let inspection;
  if (stage === 'inspect') {
    if (!prepared.inspectionAttestations ||
        !SCAN_ATTESTATIONS.every((key) => prepared.inspectionAttestations[key] === true)) throw new QualificationError('approval');
    inspection = { ...build.inspection,
      profile: { ...build.inspection.profile, attestations: prepared.inspectionAttestations }, attestationsConfirmed: true };
  }
  const contract = { stage, binding: prepared.binding, sourceSha: prepared.contract.sourceSha,
    imageId: setup.imageId, daemonId: setup.daemonId, inspection };
  return { ...contract, approval: sha(JSON.stringify(contract)), authorized: false, gate1Status: 'open' };
}

/** Emit a fixed-name USTAR header; source members supply their reviewed mode and PAX path records use type 120. */
function tarHeader(name, size, mode = 0o600, type = 48) {
  if (!/^[A-Za-z0-9._/-]{1,99}$/.test(name) || name.split('/').includes('..') ||
      !Number.isSafeInteger(size) || size < 0 || size > 0o77777777777 ||
      ![0o600, 0o644, 0o755].includes(mode) || ![48, 120].includes(type)) throw new QualificationError('artifact');
  const header = Buffer.alloc(512);
  header.write(name); header.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(size.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
  header.fill(32, 148, 156); header[156] = type; header.write('ustar\0', 257); header.write('00', 263);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
}

/** Assemble only named reviewed files into an exclusive context tar, streaming archives to bound memory. */
function contextTar(location, members) {
  const fd = fs.openSync(location, 'wx', 0o600), block = Buffer.alloc(65536), hashes = {};
  try {
    for (const [name, value] of members) {
      const bytes = Buffer.isBuffer(value) ? value : null, size = bytes ? bytes.length : fs.statSync(value).size;
      fs.writeSync(fd, tarHeader(name, size));
      const hash = createHash('sha256'); let total = 0;
      if (bytes) { fs.writeSync(fd, bytes); hash.update(bytes); total = size; }
      else {
        const source = fs.openSync(value, 'r');
        try {
          let count;
          while ((count = fs.readSync(source, block, 0, block.length, null))) {
            total += count;
            if (total > size) throw new QualificationError('artifact');
            hash.update(block.subarray(0, count)); fs.writeSync(fd, block.subarray(0, count));
          }
        }
        finally { fs.closeSync(source); }
      }
      if (total !== size) throw new QualificationError('artifact');
      hashes[name] = hash.digest('hex');
      fs.writeSync(fd, Buffer.alloc((512 - size % 512) % 512));
    }
    fs.writeSync(fd, Buffer.alloc(1024)); fs.fsyncSync(fd); return hashes;
  } finally { fs.closeSync(fd); }
}

/** Write a bounded source tar from validated manifest OIDs, never checkout/archive conversions; options inject Git or tighter test limits. */
async function sourceArchive(root, manifest, location, options = {}) {
  const runGit = options.git || git, byteLimit = options.byteLimit ?? LIMITS.sourceBytes;
  const timeoutMs = options.timeoutMs ?? LIMITS.setupMs, started = performance.now();
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1024 || byteLimit > LIMITS.sourceBytes) throw new QualificationError('artifact');
  const fd = fs.openSync(location, 'wx', 0o600);
  let total = 1024;
  try {
    for (const { name, oid, mode } of manifest) {
      // PAX path lengths count UTF-8 bytes, preserving long names and non-ASCII source paths without truncation.
      const field = ` path=${name}\n`, fieldBytes = Buffer.byteLength(field);
      let length = fieldBytes + 1;
      while (length !== fieldBytes + String(length).length) length = fieldBytes + String(length).length;
      const extended = Buffer.from(String(length) + field), extendedPadding = (512 - extended.length % 512) % 512;
      const overhead = 1024 + extended.length + extendedPadding, available = byteLimit - total - overhead;
      if (available < 0) throw new QualificationError('stream_limit');
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) throw new QualificationError('deadline');
      const bytes = await runGit(root, ['cat-file', 'blob', oid], {
        outputBytes: available, timeoutMs: Math.min(LIMITS.commandMs, remaining) });
      const padding = (512 - bytes.length % 512) % 512;
      if (bytes.length + padding > available) throw new QualificationError('stream_limit');
      if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== oid) {
        throw new QualificationError('source');
      }
      for (const part of [tarHeader('PaxHeaders/source', extended.length, 0o600, 120), extended, Buffer.alloc(extendedPadding),
        tarHeader('source', bytes.length, mode === '100755' ? 0o755 : 0o644), bytes, Buffer.alloc(padding)]) {
        fs.writeFileSync(fd, part);
      }
      total += overhead + bytes.length + padding;
    }
    fs.writeFileSync(fd, Buffer.alloc(1024)); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/** Call the explicitly selected Linux engine, never ambient Docker contexts or implicit image pulls. */
async function docker(args, options = {}) { return supervise('docker', ['--context', CONTEXT, ...args], options); }

/** Construct a fixed isolated container; daemon logs are disabled and host directories are never mounted. */
function containerArgs(imageId, mode, sourceSha) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId) || !/^[a-f0-9]{40}$/.test(sourceSha) ||
      !['setup', 'build', 'inspect'].includes(mode)) throw new QualificationError('docker');
  return ['create', '--name', CONTAINER, '--pull=never', '--platform=linux/amd64', '--network=none', '--read-only',
    '--init', '--restart=no', '--log-driver=none', '--cpus=4', `--memory=${LIMITS.memoryBytes}`, `--memory-swap=${LIMITS.memoryBytes}`,
    `--pids-limit=${LIMITS.pids}`, '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=SETUID', '--cap-add=SETGID',
    '--security-opt=no-new-privileges', '--ulimit=nofile=4096:4096', '--ulimit=core=0:0',
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=${LIMITS.tmpfsBytes},mode=1777`,
    '--mount', `type=volume,src=${VOLUME},dst=/state,volume-nocopy`,
    '--mount', `type=volume,src=${VOLUME},dst=/opt/gate1/.tmp,volume-nocopy`,
    '--env', `NODE_PATH=/state/${sourceSha}/tools/node_modules`, '--entrypoint', '/usr/bin/timeout', '-i', imageId,
    '--signal=KILL', `${(mode === 'inspect' ? LIMITS.inspectMs : LIMITS[`${mode}Ms`]) / 1000}s`,
    '/opt/node-v22.23.3-linux-x64/bin/node', '/opt/gate1/scripts/gate1-build-qualification.js', `--inside-${mode}`];
}

/** Verify daemon identity and exclusive volume use before every mutation; a missing volume cannot be recreated later. */
async function engineCheck(runDocker, stage, expectedDaemon) {
  const info = strictJson(await runDocker(['info', '--format', '{{json .}}']));
  if (info.OSType !== 'linux' || !['x86_64', 'amd64'].includes(info.Architecture) ||
      typeof info.ID !== 'string' || !info.ID || (expectedDaemon && info.ID !== expectedDaemon)) throw new QualificationError('docker');
  if ((await runDocker(['ps', '-aq', '--filter', `volume=${VOLUME}`])).toString().trim() ||
      (await runDocker(['ps', '-aq', '--filter', `name=^/${CONTAINER}$`])).toString().trim()) throw new QualificationError('docker');
  const volumes = (await runDocker(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${VOLUME}$`])).toString().trim();
  if (!volumes) {
    if (stage !== 'setup') throw new QualificationError('preparation');
    await runDocker(['volume', 'create', '--label', `gate1.scope=${SCOPE}`, VOLUME]);
  } else {
    const volume = strictJson(await runDocker(['volume', 'inspect', VOLUME]));
    if (volume.length !== 1 || volume[0].Name !== VOLUME || volume[0].Driver !== 'local' ||
        Object.keys(volume[0].Options || {}).length || volume[0].Labels?.['gate1.scope'] !== SCOPE) throw new QualificationError('docker');
  }
  return info.ID;
}

/** Create the minimal image context from committed source and reviewed offline artifacts, without a package download. */
async function assembleImage(p, prepared, root, runDocker, timeoutMs) {
  const started = performance.now();
  /** Share the caller's remaining stage budget across raw blob reads and Docker assembly. */
  function remaining() {
    const value = timeoutMs - (performance.now() - started);
    if (value <= 0) throw new QualificationError('deadline');
    return value;
  }
  const base = strictJson(await runDocker(['image', 'inspect', BASE_IMAGE]));
  if (base.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(base[0].Id || '') ||
      base[0].Os !== 'linux' || base[0].Architecture !== 'amd64') throw new QualificationError('docker');
  const folder = path.join(root, p.source.gitSha + '.context'); fs.mkdirSync(folder, { mode: 0o700 });
  const sourceTar = path.join(folder, 'source.tar');
  await sourceArchive(p.source.root, prepared.contract.sourceManifest, sourceTar, { timeoutMs: remaining() });
  const members = [['Dockerfile', publicFile(path.join(__dirname, 'gate1-build-qualification.Dockerfile'))],
    ['source.tar', sourceTar], ['review.json', Buffer.from(JSON.stringify(prepared))],
    ['package-lock.json', publicFile(path.join(ROOT, 'package-lock.json'))],
    ...FILES.map((name) => ['execution/' + name, publicFile(path.join(__dirname, name))]),
    ...[NODE_ARCHIVE, 'npm-cache.tar', 'toolchain-package.json', 'toolchain-lock.json'].map((name) => [name, path.join(p.artifacts.root, name)])];
  const context = path.join(folder, 'context.tar'), iid = path.join(folder, 'image-id.txt');
  const hashes = contextTar(context, members);
  const expected = { [NODE_ARCHIVE]: NODE_SHA, 'npm-cache.tar': p.artifacts.cacheSha256,
    'toolchain-lock.json': p.artifacts.toolchainLockSha256,
    'toolchain-package.json': prepared.contract.artifacts.toolchainManifestSha256,
    'package-lock.json': prepared.contract.integrity['package-lock.json'],
    Dockerfile: prepared.contract.integrity['gate1-build-qualification.Dockerfile'],
    ...Object.fromEntries(FILES.map((name) => ['execution/' + name, prepared.contract.integrity[name]])) };
  if (Object.entries(expected).some(([name, digest]) => hashes[name] !== digest)) throw new QualificationError('approval');
  // Revalidate immediately before handing the context to Docker; source blobs are immutable Git objects.
  if ((await prepare(p)).binding !== prepared.binding) throw new QualificationError('approval');
  await runDocker(['build', '--network=none', '--pull=false', '--no-cache', '--build-arg',
    `QUALIFICATION_BASE=${base[0].Id}`, '--iidfile', iid, '-'],
    { timeoutMs: remaining(), inputFile: context, capture: false, outputBytes: LIMITS.logBytes,
      env: { ...hostEnvironment(), DOCKER_BUILDKIT: '0' } });
  const imageId = publicFile(iid, 128).toString().trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new QualificationError('docker');
  return imageId;
}

/** Stop/remove only a successfully created container ID and verify exit/OOM state before accepting a receipt. */
async function teardown(runDocker, containerId) {
  const state = strictJson(await runDocker(['inspect', '--format', '{{json .State}}', containerId]));
  if (state.Running) await runDocker(['kill', containerId]);
  const finalState = strictJson(await runDocker(['inspect', '--format', '{{json .State}}', containerId]));
  if (finalState.Running) throw new QualificationError('docker');
  await runDocker(['rm', containerId]);
  return !state.Running && finalState.ExitCode === 0 && finalState.OOMKilled === false && !finalState.Error;
}

/** Execute a single separately approved stage with durable host reservation and verified container teardown. */
async function execute(stage, envelope, dependencies = {}) {
  if (!['setup', 'build', 'inspect'].includes(stage) || !envelope ||
      Object.keys(envelope).sort().join(',') !== 'approval,authorized,profile' || envelope.authorized !== true ||
      !/^[a-f0-9]{64}$/.test(envelope.approval || '')) throw new QualificationError('approval');
  const prepared = await (dependencies.prepare || prepare)(envelope.profile), p = parseProfile(envelope.profile);
  const root = dependencies.root || await registryRoot(), runDocker = dependencies.docker || docker;
  const setup = stage === 'setup' ? null : receipt(root, p.source.gitSha, 'setup');
  const build = stage === 'inspect' ? receipt(root, p.source.gitSha, 'build') : null;
  const review = stage === 'setup' ? { approval: prepared.setupApproval } : stageReview(prepared, stage, setup, build);
  if (envelope.approval !== review.approval) throw new QualificationError('approval');
  reserve(root, p.source.gitSha, stage, envelope.approval);
  const lock = path.join(root, 'active.lock');
  writeOnce(lock, { stage, sourceSha: p.source.gitSha, approval: envelope.approval });
  let containerId, stopped = false;
  const started = performance.now(), ceiling = stage === 'inspect' ? LIMITS.inspectMs : LIMITS[`${stage}Ms`];
  /** Carry one stage budget across image assembly and the container, without resetting it between commands. */
  function remaining() {
    const value = ceiling - (performance.now() - started);
    if (value <= 0) throw new QualificationError('deadline');
    return value;
  }
  let result = { schemaVersion: 1, stage, binding: prepared.binding, result: 'stopped', gate1Status: 'open' };
  try {
    const daemonId = await engineCheck(runDocker, stage, setup?.daemonId);
    const imageId = stage === 'setup' ? await (dependencies.assembleImage || assembleImage)(p, prepared, root, runDocker, remaining()) : setup.imageId;
    const inspected = strictJson(await runDocker(['image', 'inspect', imageId]));
    if (inspected.length !== 1 || inspected[0].Id !== imageId || inspected[0].Os !== 'linux' || inspected[0].Architecture !== 'amd64') {
      throw new QualificationError('docker');
    }
    const created = (await runDocker(containerArgs(imageId, stage, p.source.gitSha))).toString().trim();
    if (!/^[a-f0-9]{64}$/.test(created)) throw new QualificationError('docker');
    containerId = created;
    const bytes = await runDocker(['start', '-ai', containerId], {
      timeoutMs: remaining(),
      input: Buffer.from(JSON.stringify({ binding: prepared.binding, stage, approval: envelope.approval,
        inspection: stage === 'inspect' ? review.inspection : null })) });
    const terminal = strictJson(bytes);
    if (terminal.binding !== prepared.binding || terminal.stage !== stage || terminal.gate1Status !== 'open' ||
        !['completed', 'stopped'].includes(terminal.result)) throw new QualificationError('child');
    result = { ...terminal, imageId, daemonId };
    if (terminal.persistenceFailure) result.result = 'stopped';
  } catch (error) { result.failure = error instanceof QualificationError ? error.code : 'internal'; }
  finally {
    if (containerId) {
      try {
        const cleanExit = await teardown(runDocker, containerId); stopped = true;
        if (!cleanExit) { result.result = 'stopped'; result.failure ||= 'child'; }
      } catch { result.result = 'stopped'; result.failure = 'docker'; result.teardownUnconfirmed = true; }
    } else stopped = true;
    try { writeOnce(path.join(root, `${p.source.gitSha}.${stage}.receipt.json`), result); }
    catch { result.result = 'stopped'; result.persistenceFailure = 'persistence'; }
    // A failed teardown keeps the global lock for owner review. Consumed reservations are never removed.
    if (stopped) { try { fs.unlinkSync(lock); } catch { result.result = 'stopped'; result.persistenceFailure = 'persistence'; } }
  }
  return result;
}

/** Count persistent volume entries/bytes without following links; this threshold is monitored, not a disk quota. */
function storageCheck(root) {
  const queue = [root]; let bytes = 0, entries = 0;
  while (queue.length) {
    const dir = fs.opendirSync(queue.pop());
    try {
      let entry;
      while ((entry = dir.readSync())) {
        if (++entries > LIMITS.storageEntries) throw new QualificationError('storage');
        const location = path.join(dir.path, entry.name);
        let stat;
        try { stat = fs.lstatSync(location); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        bytes += stat.size;
        if (bytes > LIMITS.storageBytes) throw new QualificationError('storage');
        if (stat.isDirectory() && !stat.isSymbolicLink()) queue.push(location);
      }
    } finally { dir.closeSync(); }
  }
}

/** Set ownership only in a newly created source copy, before dependency symlinks or app processes exist. */
function ownSource(root) {
  fs.chownSync(root, 1000, 1000);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const location = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new QualificationError('forbidden');
    if (entry.isDirectory()) ownSource(location); else fs.chownSync(location, 1000, 1000);
  }
}

/** Build a clean child environment from constants and generated values; inherit no provider authentication. */
function linuxEnvironment(sourceSha, values = {}) {
  return { PATH: '/opt/node-v22.23.3-linux-x64/bin:/usr/bin:/bin', HOME: '/tmp/home', TMPDIR: '/tmp',
    CI: '1', NEXT_TELEMETRY_DISABLED: '1', VERCEL_TELEMETRY_DISABLED: '1',
    npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    npm_config_logs_max: '0', npm_config_timing: 'false',
    npm_config_cache: `/state/${sourceSha}/cache`, ...values };
}

/** Verify installed package versions through the same resolution root used by the CLI, not only declarations. */
function actualVersions(folder) {
  const { createRequire } = require('node:module');
  const cli = path.join(folder, 'tools/node_modules/vercel/package.json');
  const resolve = createRequire(cli), actual = { node: process.versions.node,
    npm: strictJson(publicFile('/opt/node-v22.23.3-linux-x64/lib/node_modules/npm/package.json')).version,
    next: strictJson(publicFile(path.join(folder, 'app/node_modules/next/package.json'))).version,
    vercel: strictJson(publicFile(cli)).version };
  for (const name of Object.keys(TOOL_DEPS).filter((name) => name !== 'vercel' && name !== 'zod')) {
    actual[name] = strictJson(publicFile(resolve.resolve(`${name}/package.json`))).version;
  }
  actual.zod = strictJson(publicFile(path.join(folder, 'tools/node_modules/zod/package.json'))).version;
  if (JSON.stringify(actual) !== JSON.stringify(VERSIONS)) throw new QualificationError('toolchain');
  return actual;
}

/** Resolve the locked CLI's declared executable inside its package, without shell lookup or a mutable global install. */
function vercelEntry(folder) {
  const root = path.join(folder, 'tools/node_modules/vercel');
  const manifest = strictJson(publicFile(path.join(root, 'package.json'))), bin = manifest.bin?.vercel;
  if (typeof bin !== 'string' || !/^(?:\.\/)?dist\/[A-Za-z0-9_./-]+\.js$/.test(bin) || bin.split('/').includes('..')) {
    throw new QualificationError('toolchain');
  }
  const location = safePath(path.resolve(root, bin)), stat = fs.lstatSync(location);
  if (!location.startsWith(root + path.sep) || !stat.isFile() || stat.nlink !== 1) throw new QualificationError('toolchain');
  return location;
}

/** Generate synthetic canaries on Linux; retain values only in a root-owned private record outside output. */
function syntheticInputs() {
  const values = Object.fromEntries(LABELS.map((label) => [label, randomBytes(32).toString('base64url')]));
  return { comparisons: LABELS.map((label) => ({ label, value: values[label] })), env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://gate1-build.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'gate1-public-synthetic-anon',
    SUPABASE_SERVICE_ROLE_KEY: values.supabase_service_role, CSRF_SECRET: values.csrf_secret,
    TEMPORARY_SESSION_CEILING_SECRET_MODE: 'vercel',
    TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON: JSON.stringify({ schemaVersion: 1,
      active: { generation: 1, keyId: 'gate1-synthetic-key', key: values.ceiling_hmac }, previous: null }),
    TEMPORARY_SESSION_CEILING_UPSTASH_JSON: JSON.stringify({ schemaVersion: 1,
      url: 'https://synthetic-gate1.upstash.io', token: values.redis_token }) } };
}

/** Verify every transferred source blob and executable mode against the reviewed manifest before installing anything. */
function verifySource(root, manifest) {
  const expected = new Map(manifest.map((entry) => [entry.name, entry])), seen = new Set(), queue = [root];
  let total = 0;
  while (queue.length) {
    const dir = queue.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const location = path.join(dir, entry.name), relative = path.relative(root, location).split(path.sep).join('/');
      if (entry.isSymbolicLink() || forbidden(entry.name)) throw new QualificationError('forbidden');
      if (entry.isDirectory()) { queue.push(location); continue; }
      const spec = expected.get(relative);
      if (!spec || !entry.isFile()) throw new QualificationError('source');
      const bytes = publicFile(location, LIMITS.sourceBytes); total += bytes.length;
      if (total > LIMITS.sourceBytes || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== spec.oid) {
        throw new QualificationError('source');
      }
      if (process.platform === 'linux' && Boolean(fs.statSync(location).mode & 0o111) !== (spec.mode === '100755')) {
        throw new QualificationError('source');
      }
      seen.add(relative);
    }
  }
  if (seen.size !== expected.size) throw new QualificationError('source');
}

/** Produce a Linux-native draft without output access; its prospective digest does not assert owner attestations. */
function inspectionPreparation(prepared, folder) {
  const scanner = require('./gate1-build-artifact-privacy');
  const profile = { schemaVersion: 1, scope: scanner.SCOPE, runId: prepared.binding.slice(0, 32),
    environment: 'preview', outputRoot: path.join(folder, 'app/.vercel/output'),
    provenance: { gitSha: prepared.contract.sourceSha, lockSha256: prepared.contract.lockSha256,
      nodeVersion: VERSIONS.node, nextVersion: VERSIONS.next, vercelCliVersion: VERSIONS.vercel },
    comparisonLabels: LABELS, attestations: Object.fromEntries(scanner.ATTESTATIONS.map((key) => [key, false])) };
  // This hypothetical hash is reviewed with actual build provenance. Only later explicit owner assertions
  // can turn the draft into an inspection envelope; build completion never supplies those assertions.
  const prospective = scanner.preparation({ ...profile,
    attestations: Object.fromEntries(scanner.ATTESTATIONS.map((key) => [key, true])) });
  return { ...prospective, profile, mode: 'inspection_draft', attestationsConfirmed: false,
    nextStep: 'review_build_evidence_then_supply_inspection_attestations' };
}

/** Match later owner assertions to the Linux draft and revalidate its platform-native scanner digest before reads. */
function confirmInspection(draft, confirmed, scanner) {
  if (!confirmed || confirmed.attestationsConfirmed !== true || draft.attestationsConfirmed !== false) {
    throw new QualificationError('approval');
  }
  const profile = scanner.parseProfile(confirmed.profile);
  const unconfirmed = { ...confirmed, profile: { ...profile,
    attestations: Object.fromEntries(scanner.ATTESTATIONS.map((key) => [key, false])) }, attestationsConfirmed: false };
  if (JSON.stringify(unconfirmed) !== JSON.stringify(draft) || scanner.approvalId(profile) !== draft.approvalId) {
    throw new QualificationError('approval');
  }
  return profile;
}

/** Run one Linux stage from immutable image metadata; never accept host paths, commands or environment values. */
async function inside(stage, envelope) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() !== 0 ||
      !['setup', 'build', 'inspect'].includes(stage)) throw new QualificationError('docker');
  const prepared = strictJson(publicFile('/opt/gate1/review.json'));
  if (!envelope || envelope.stage !== stage || envelope.binding !== prepared.binding ||
      !/^[a-f0-9]{64}$/.test(envelope.approval || '') || !/^[a-f0-9]{40}$/.test(prepared.contract.sourceSha) ||
      JSON.stringify(executionIntegrity()) !== JSON.stringify(prepared.contract.integrity)) throw new QualificationError('approval');
  const sourceSha = prepared.contract.sourceSha, folder = `/state/${sourceSha}`, app = `${folder}/app`;
  const report = { schemaVersion: 1, stage, binding: prepared.binding, result: 'stopped', gate1Status: 'open',
    network: 'none', rawProcessStreamsRetained: false, historicalArtifactPrivacy: 'unverified', hostedAttribution: 'not_established' };
  const started = performance.now(), ceiling = stage === 'inspect' ? LIMITS.inspectMs : LIMITS[`${stage}Ms`];
  let lastPoll = -Infinity;
  /** Enforce the remaining stage deadline across children and periodically count the persistent volume. */
  function childOptions() {
    const remaining = ceiling - (performance.now() - started);
    if (remaining <= 0) throw new QualificationError('deadline');
    return { timeoutMs: remaining, capture: false, outputBytes: LIMITS.logBytes, cwd: app,
      env: linuxEnvironment(sourceSha), poll() {
        if (performance.now() - lastPoll >= LIMITS.storagePollMs) { storageCheck('/state'); lastPoll = performance.now(); }
      } };
  }
  try {
    if (stage === 'setup') {
      if (envelope.approval !== prepared.setupApproval) throw new QualificationError('approval');
      fs.mkdirSync(folder, { mode: 0o711 });
      writeOnce(`${folder}/setup.reservation.json`, { binding: prepared.binding, consumed: true });
      verifySource('/opt/source', prepared.contract.sourceManifest);
      fs.cpSync('/opt/source', app, { recursive: true, errorOnExist: true, force: false }); ownSource(app);
      fs.cpSync('/opt/toolchain', `${folder}/tools`, { recursive: true, errorOnExist: true, force: false });
      fs.cpSync('/opt/npm-cache', `${folder}/cache`, { recursive: true, errorOnExist: true, force: false });
      storageCheck('/state');
      fs.mkdirSync('/tmp/home', { mode: 0o777 });
      const npm = '/opt/node-v22.23.3-linux-x64/bin/npm';
      const args = ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'];
      await supervise(npm, args, { ...childOptions(), cwd: `${folder}/tools` });
      await supervise(npm, args, childOptions());
      // npm ran as root with lifecycle scripts disabled. Give only the app tree to the later unprivileged build.
      await supervise('/usr/bin/chown', ['-R', '-h', '1000:1000', app], childOptions());
      report.versions = actualVersions(folder);
      writeOnce(`${folder}/setup.receipt.json`, { binding: prepared.binding, versions: report.versions });
    } else {
      const setup = strictJson(publicFile(`${folder}/setup.receipt.json`));
      if (setup.binding !== prepared.binding) throw new QualificationError('preparation');
      report.versions = actualVersions(folder);
      writeOnce(`${folder}/${stage}.reservation.json`, { binding: prepared.binding, approval: envelope.approval, consumed: true });
      if (stage === 'build') {
        if (fs.existsSync(`${app}/.vercel`) || fs.existsSync(`${app}/.next`)) throw new QualificationError('preparation');
        const inputs = syntheticInputs();
        fs.mkdirSync(`${folder}/private`, { mode: 0o700 }); writeOnce(`${folder}/private/comparisons.json`, inputs.comparisons);
        fs.mkdirSync(`${app}/.vercel`, { mode: 0o755 });
        writeOnce(`${app}/.vercel/project.json`, SETTINGS); fs.chmodSync(`${app}/.vercel/project.json`, 0o644);
        fs.chownSync(`${app}/.vercel`, 1000, 1000);
        fs.mkdirSync('/tmp/home', { mode: 0o700 }); fs.chownSync('/tmp/home', 1000, 1000);
        // All lifecycle execution occurs in this separately approved, disconnected build stage.
        const env = linuxEnvironment(sourceSha, { ...inputs.env, NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview' });
        await supervise('/opt/node-v22.23.3-linux-x64/bin/npm', ['run', 'postinstall', '--offline'],
          { ...childOptions(), env, uid: 1000, gid: 1000 });
        await supervise(process.execPath, [vercelEntry(folder), 'build', '--standalone', '--target=preview'],
          { ...childOptions(), env, uid: 1000, gid: 1000 });
        report.inspection = inspectionPreparation(prepared, folder);
        writeOnce(`${folder}/build.receipt.json`, { binding: prepared.binding, inspection: report.inspection });
      } else {
        const build = strictJson(publicFile(`${folder}/build.receipt.json`));
        if (build.binding !== prepared.binding) throw new QualificationError('approval');
        const scanProfile = confirmInspection(build.inspection, envelope.inspection, require('./gate1-build-artifact-privacy'));
        const comparisons = strictJson(publicFile(`${folder}/private/comparisons.json`));
        const bytes = await supervise(process.execPath, [path.join(__dirname, 'gate1-build-artifact-privacy.js'), '--inspect'], {
          ...childOptions(), capture: true, outputBytes: LIMITS.reportBytes + 2,
          env: { ...linuxEnvironment(sourceSha), NODE_PATH: `${folder}/tools/node_modules` },
          input: Buffer.from(JSON.stringify({ profile: scanProfile, approval: build.inspection.approvalId,
            inspectionApproved: true, comparisons })) });
        report.inspectionReport = strictJson(bytes);
        if (report.inspectionReport.result !== 'completed' || report.inspectionReport.persistenceFailure ||
            report.inspectionReport.reportSaved !== true) throw new QualificationError('persistence');
      }
    }
    storageCheck('/state'); report.result = 'completed';
  } catch (error) { report.failure = error instanceof QualificationError ? error.code : 'internal'; }
  try { writeOnce(`${folder}/${stage}.terminal.json`, report); }
  catch { report.result = 'stopped'; report.persistenceFailure = 'persistence'; }
  return report;
}

/** Read bounded stdin without retaining parser diagnostics; late/partial input cannot hold a container indefinitely. */
function readInput(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false; const chunks = [];
    const timer = setTimeout(() => finish(new QualificationError('input')), LIMITS.inputMs);
    /** Detach listeners and release private bytes once a result or fixed error exists. */
    function finish(error, value) {
      if (done) return; done = true; clearTimeout(timer); stream.removeListener('data', data);
      stream.removeListener('end', end); stream.removeListener('error', failed); stream.pause(); chunks.length = 0;
      if (error) reject(error); else resolve(value);
    }
    /** Accumulate bounded input without writing it to arguments, environment variables or logs. */
    function data(bytes) { size += bytes.length; if (size > LIMITS.inputBytes) finish(new QualificationError('input')); else chunks.push(bytes); }
    /** Preserve strict original JSON validation before any profile fields are normalized. */
    function end() { try { finish(null, strictJson(Buffer.concat(chunks))); } catch { finish(new QualificationError('input')); } }
    /** Suppress raw stream failures at the private-input boundary. */
    function failed() { finish(new QualificationError('input')); }
    stream.on('data', data); stream.once('end', end); stream.once('error', failed);
  });
}

/** Default to a template; only explicit stage commands can mutate Docker or consume reservations. */
async function main(args) {
  if (!args.length || (args.length === 1 && args[0] === '--template')) return template();
  if (args.length !== 1 || !['--prepare', '--prepare-build', '--prepare-inspect', '--setup', '--build', '--inspect',
    '--inside-setup', '--inside-build', '--inside-inspect'].includes(args[0])) throw new QualificationError('input');
  const input = await readInput(), mode = args[0].slice(2);
  if (mode.startsWith('inside-')) return inside(mode.slice(7), input);
  if (mode.startsWith('prepare')) {
    const prepared = await prepare(input);
    if (mode === 'prepare') return prepared;
    const root = await registryRoot(), sourceSha = prepared.contract.sourceSha;
    return stageReview(prepared, mode === 'prepare-build' ? 'build' : 'inspect', receipt(root, sourceSha, 'setup'),
      mode === 'prepare-inspect' ? receipt(root, sourceSha, 'build') : undefined);
  }
  return execute(mode, input);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((report) => {
    const bytes = JSON.stringify(report);
    if (Buffer.byteLength(bytes) > LIMITS.reportBytes) throw new QualificationError('persistence');
    process.stdout.write(bytes + '\n');
    if (report.result === 'stopped' || report.persistenceFailure) process.exitCode = 1;
  }).catch(() => { process.stderr.write('Qualification stopped. Preserve reservations; no automatic retry.\n'); process.exitCode = 1; });
}

module.exports = { SCOPE, CONTEXT, VOLUME, CONTAINER, BASE_IMAGE, NODE_ARCHIVE, NODE_SHA, VERSIONS, TOOL_DEPS,
  FILES, LIMITS, ATTESTATIONS, SCAN_ATTESTATIONS, LABELS, SETTINGS, QualificationError, strictJson, safePath, forbidden, publicFile,
  fileHash, template, parseProfile, supervise, sourceSelection, checkLock, checkCacheTar, executionIntegrity,
  prepare, writeOnce, reserve, stageReview, tarHeader, contextTar, sourceArchive, containerArgs, engineCheck, execute,
  storageCheck, syntheticInputs, verifySource, vercelEntry, confirmInspection, readInput, main };
