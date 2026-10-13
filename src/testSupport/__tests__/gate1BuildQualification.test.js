/** Synthetic fixtures and mocked Docker only. No images, containers, downloads or application builds. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const q = require('../../../scripts/gate1-build-qualification');
const BASE = path.resolve(__dirname, '../../../.tmp/build-qualification-test-fixtures');
const PS = path.resolve(__dirname, '../../../scripts/run-gate1-build-qualification.ps1');
const SOURCE = 'a'.repeat(40), IMAGE = 'sha256:' + 'b'.repeat(64), CID = 'c'.repeat(64);
const PRIVATE = 'synthetic-private-test-value-12345';
// Probe Windows PowerShell once before registration so unavailable launchers skip only their subprocess checks.
const powershellProbe = process.platform === 'win32' && spawnSync('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
const windowsTest = powershellProbe && !powershellProbe.error && powershellProbe.status === 0 ? test : test.skip;
let folder, guards;

beforeEach(() => {
  fs.mkdirSync(BASE, { recursive: true }); folder = fs.mkdtempSync(path.join(BASE, 'fixture-'));
  guards = [http, https].map((module) => jest.spyOn(module, 'request').mockImplementation(() => { throw new Error('Network forbidden'); }));
});
afterEach(() => {
  guards.forEach((guard) => expect(guard).not.toHaveBeenCalled()); jest.restoreAllMocks();
  const target = path.resolve(folder);
  if (!target.startsWith(BASE + path.sep) || target === BASE) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(target, { recursive: true, force: true });
});

/** Hash only public fixture contracts so expected preparation digests stay deterministic. */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** Generate minimal registry-only npm lock fixtures; no dependency resolution or package download occurs. */
function lock(deps) {
  return { lockfileVersion: 3, packages: { '': { dependencies: deps },
    ...Object.fromEntries(Object.entries(deps).map(([name, version]) => [`node_modules/${name}`, {
      version, resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`,
      integrity: 'sha512-' + Buffer.alloc(64, 7).toString('base64') }])) } };
}

/** Construct a fully attested synthetic profile and local artifacts with injected Git and Node-archive hashing. */
function fixture() {
  const appLock = Buffer.from(JSON.stringify(lock({ next: q.VERSIONS.next })));
  const toolLock = Buffer.from(JSON.stringify(lock(q.TOOL_DEPS)));
  fs.writeFileSync(path.join(folder, 'toolchain-lock.json'), toolLock);
  fs.writeFileSync(path.join(folder, 'toolchain-package.json'), JSON.stringify({ private: true, dependencies: q.TOOL_DEPS }));
  const cache = path.join(folder, 'npm-cache.tar'); q.contextTar(cache, [['_cacache/content-v2/sha512/aa/fixture', Buffer.from('fixture')]]);
  const names = ['package.json', 'package-lock.json', 'next.config.js', 'scripts/validate-build-env.js', 'src/pages/index.js'];
  const tree = Buffer.from(names.map((name) => `100644 blob ${'d'.repeat(40)}\t${name}\0`).join('') +
    `100644 blob ${'e'.repeat(40)}\t.env.example\0` + `100644 blob ${'f'.repeat(40)}\t.codex/credentials.json\0`);
  const profile = { ...q.template(), source: { root: folder, gitSha: SOURCE, lockSha256: hash(appLock) },
    artifacts: { root: folder, nodeSha256: q.NODE_SHA, toolchainLockSha256: hash(toolLock), cacheSha256: q.fileHash(cache) },
    attestations: Object.fromEntries(q.ATTESTATIONS.map((key) => [key, true])) };
  const git = jest.fn(async (_root, args) => {
    if (args[0] === 'rev-parse') return Buffer.from(SOURCE + '\n');
    if (args[0] === 'status') return Buffer.alloc(0);
    if (args[0] === 'ls-tree') return tree;
    if (args[0] === 'show' && args[1].endsWith(':package-lock.json')) return appLock;
    if (args[0] === 'show' && args[1].endsWith(':package.json')) return Buffer.from(JSON.stringify({ dependencies: { next: q.VERSIONS.next } }));
    throw new Error('Unexpected Git fixture command');
  });
  const fileHash = jest.fn((location) => location.endsWith(q.NODE_ARCHIVE) ? q.NODE_SHA : q.fileHash(location));
  return { profile, git, fileHash, tree, appLock, toolLock };
}

/** Return fixed Docker metadata and stage output; every mutation is recorded without contacting an engine. */
function dockerFixture(prepared, stage, overrides = {}) {
  return jest.fn(async (args, options) => {
    if (overrides[args[0]]) return overrides[args[0]](args, options);
    if (args[0] === 'info') return Buffer.from(JSON.stringify({ OSType: 'linux', Architecture: 'x86_64', ID: 'fixture-daemon' }));
    if (args[0] === 'ps') return Buffer.alloc(0);
    if (args[0] === 'volume' && args[1] === 'ls') return Buffer.from(q.VOLUME);
    if (args[0] === 'volume' && args[1] === 'inspect') return Buffer.from(JSON.stringify([{ Name: q.VOLUME, Driver: 'local', Options: null, Labels: { 'gate1.scope': q.SCOPE } }]));
    if (args[0] === 'image') return Buffer.from(JSON.stringify([{ Id: IMAGE, Os: 'linux', Architecture: 'amd64' }]));
    if (args[0] === 'create') return Buffer.from(CID);
    if (args[0] === 'start') return Buffer.from(JSON.stringify({ stage, binding: prepared.binding, gate1Status: 'open', result: 'completed' }));
    if (args[0] === 'inspect') return Buffer.from(JSON.stringify({ Running: false, ExitCode: 0, OOMKilled: false, Error: '' }));
    if (args[0] === 'rm' || args[0] === 'kill') return Buffer.alloc(0);
    throw new Error('Unexpected Docker fixture command');
  });
}

/** Assemble a stage execution seam with disposable evidence storage and no real Docker assembly. */
async function executionFixture(stage = 'setup', overrides = {}) {
  const f = fixture();
  if (stage === 'inspect') f.profile.inspectionAttestations = Object.fromEntries(q.SCAN_ATTESTATIONS.map((key) => [key, true]));
  const prepared = await q.prepare(f.profile, f), root = path.join(folder, 'registry');
  const setup = { binding: prepared.binding, imageId: IMAGE, daemonId: 'fixture-daemon', result: 'completed' };
  const build = { ...setup, inspection: { approvalId: 'f'.repeat(64), profile: { fixture: true } } };
  fs.mkdirSync(root);
  if (stage !== 'setup') q.writeOnce(path.join(root, `${SOURCE}.setup.receipt.json`), setup);
  if (stage === 'inspect') q.writeOnce(path.join(root, `${SOURCE}.build.receipt.json`), build);
  const approval = stage === 'setup' ? prepared.setupApproval : q.stageReview(prepared, stage, setup, build).approval;
  const docker = dockerFixture(prepared, stage, overrides), assembleImage = jest.fn(async () => IMAGE);
  return { ...f, prepared, root, setup, build, docker, assembleImage,
    envelope: { profile: f.profile, approval, authorized: true },
    dependencies: { root, prepare: jest.fn(async () => prepared), docker, assembleImage } };
}

/** Model the fixed Linux failure contract without private inputs or access to retained qualification state. */
function terminalFailure(prepared, stage = 'build', changes = {}) {
  return { schemaVersion: 1, stage, binding: prepared.binding, result: 'stopped', gate1Status: 'open',
    network: 'none', rawProcessStreamsRetained: false, historicalArtifactPrivacy: 'unverified',
    hostedAttribution: 'not_established', versions: q.VERSIONS, failure: 'child', failingStep: 'preparation',
    exitCode: null, signal: null, ...changes };
}

/** Emit synthetic child JSON plus a stderr canary through the real supervisor; never invoke Docker or npm. */
function terminalChild(report, exitCode, options = {}) {
  const text = typeof report === 'string' ? report : JSON.stringify(report);
  return q.supervise(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(text)});
    process.stderr.write(${JSON.stringify(PRIVATE)}); process.exitCode=${exitCode};`], options);
}

test.each(['setup', 'build', 'inspect'])('%s retains validated nonzero terminal evidence and consumes approval once', async (stage) => {
  const f = await executionFixture(stage, {
    start: (_args, options) => terminalChild(terminalFailure(f.prepared, stage, {
      failure: 'preparation', exitCode: 23, signal: null,
    }), 1, options),
    inspect: () => Buffer.from(JSON.stringify({ Running: false, ExitCode: 1, OOMKilled: false, Error: '' })),
  });
  const result = await q.execute(stage, f.envelope, f.dependencies);
  expect(result).toMatchObject({ result: 'stopped', failure: 'preparation', failingStep: 'preparation',
    exitCode: 23, signal: null, stageProcess: { exitCode: 1, signal: null },
    containerExit: { exitCode: 1, oomKilled: false }, versions: q.VERSIONS, imageId: IMAGE });
  expect(JSON.parse(fs.readFileSync(path.join(f.root, `${SOURCE}.${stage}.receipt.json`)))).toEqual(result);
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  expect(fs.existsSync(path.join(f.root, 'active.lock'))).toBe(false);
  expect(f.docker).toHaveBeenCalledWith(['rm', CID]);
  f.docker.mockClear();
  await expect(q.execute(stage, f.envelope, f.dependencies)).rejects.toThrow('reservation');
  expect(f.docker).not.toHaveBeenCalled();
});

test.each([
  ['extra field', { debug: PRIVATE }], ['nested payload', { inspection: { profile: PRIVATE } }],
  ['binding', { binding: 'f'.repeat(64) }], ['stage', { stage: 'setup' }], ['schema', { schemaVersion: 2 }],
  ['failure', { failure: PRIVATE }], ['step', { failingStep: PRIVATE }], ['wrong-stage step', { failingStep: 'toolchain_install' }],
  ['negative exit', { exitCode: -1 }], ['large exit', { exitCode: 0x100000000 }],
  ['fractional exit', { exitCode: 1.5 }], ['string exit', { exitCode: PRIVATE }], ['signal', { signal: PRIVATE }],
  ['version', { versions: { ...q.VERSIONS, next: PRIVATE } }], ['completed', { result: 'completed' }],
  ['missing failure', { failure: undefined }], ['raw streams', { rawProcessStreamsRetained: true }],
])('failure report rejects %s before retaining any supplied text', (_label, changes) => {
  const binding = 'a'.repeat(64), bytes = Buffer.from(JSON.stringify(terminalFailure({ binding }, 'build', changes)));
  expect(() => q.failureReport(bytes, 'build', binding)).toThrow('child');
});

test('failure report rejects truncated, duplicated, invalid UTF-8 and oversized terminal bytes', () => {
  const binding = 'a'.repeat(64), text = JSON.stringify(terminalFailure({ binding }));
  for (const bytes of [Buffer.from(text.slice(0, -1)), Buffer.from(text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
    Buffer.concat([Buffer.from(text), Buffer.from([255])]), Buffer.alloc(q.LIMITS.reportBytes + 1)]) {
    expect(() => q.failureReport(bytes, 'build', binding)).toThrow();
  }
});

test.each(['truncated', 'extra', 'completed'])('nonzero %s output is discarded while the process status survives', async (kind) => {
  const f = await executionFixture('build', { start: (_args, options) => {
    const report = terminalFailure(f.prepared);
    if (kind === 'extra') report.debug = PRIVATE;
    if (kind === 'completed') report.result = 'completed';
    return terminalChild(kind === 'truncated' ? JSON.stringify(report).slice(0, -1) : report, 9, options);
  } });
  const result = await q.execute('build', f.envelope, f.dependencies);
  expect(result).toMatchObject({ result: 'stopped', failure: 'child', failingStep: 'container_start', exitCode: 9, signal: null });
  const persisted = fs.readFileSync(path.join(f.root, `${SOURCE}.build.receipt.json`), 'utf8');
  expect(JSON.parse(persisted)).toEqual(result); expect(persisted).not.toContain(PRIVATE);
  expect(result).not.toHaveProperty('versions'); expect(result).not.toHaveProperty('report');
});

test('a valid stopped receipt with zero process exit remains nonpassing', async () => {
  const f = await executionFixture('build', { start: (_args, options) => terminalChild(terminalFailure(f.prepared), 0, options) });
  expect(await q.execute('build', f.envelope, f.dependencies)).toMatchObject({ result: 'stopped', failure: 'child', failingStep: 'preparation' });
});

test.each(['deadline', 'stdout', 'stderr'])('%s cannot retain even a valid buffered failure report', async (kind) => {
  const report = terminalFailure({ binding: 'a'.repeat(64) }), parser = jest.fn((bytes) => q.failureReport(bytes, 'build', report.binding));
  const tail = kind === 'deadline' ? 'setInterval(()=>{},1000)' :
    kind === 'stdout' ? 'process.stdout.write("x".repeat(4096))' : 'process.stderr.write("x".repeat(8388609))';
  const error = await q.supervise(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(report))});${tail}`],
    { timeoutMs: kind === 'deadline' ? 250 : 10000, outputBytes: 2048, parseFailureReport: parser }).catch((failure) => failure);
  expect(error.code).toBe(kind === 'deadline' ? 'deadline' : 'stream_limit');
  expect(error).not.toHaveProperty('report'); expect(error).not.toHaveProperty('stdout'); expect(parser).not.toHaveBeenCalled();
});

test.each(['postinstall', 'vercel_build'])('build records %s exit metadata without retaining private child streams or retrying', async (step) => {
  const root = path.join(folder, 'tools/node_modules/vercel'); fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist/vc.js'), 'fixture');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ bin: { vercel: 'dist/vc.js' } }));
  const run = jest.fn(async (_command, args, options) => {
    expect(options).toMatchObject({ capture: false, env: { PRIVATE }, uid: 1000, gid: 1000 });
    if (step === 'vercel_build' && args[0] === 'run') return Buffer.alloc(0);
    // Linux UID/GID and synthetic build env stay at the mocked boundary; the emitting fixture runs on Windows too.
    return terminalChild(PRIVATE, 37, { capture: options.capture });
  });
  const error = await q.buildCommands(folder, () => ({ capture: false }), { PRIVATE }, run).catch((failure) => failure);
  expect(error).toMatchObject({ code: 'child', failingStep: step, exitCode: 37, signal: null });
  expect(run).toHaveBeenCalledTimes(step === 'postinstall' ? 1 : 2);
  expect(JSON.stringify(error)).not.toContain(PRIVATE);
  const report = terminalFailure({ binding: 'a'.repeat(64) });
  q.stopReport(report, error, 'preparation');
  expect(q.failureReport(Buffer.from(JSON.stringify(report)), 'build', report.binding)).toMatchObject({ failingStep: step, exitCode: 37 });
});

test('signals survive failure normalization and unknown errors cannot inject diagnostic strings', () => {
  const report = terminalFailure({ binding: 'a'.repeat(64) });
  q.stopReport(report, Object.assign(new q.QualificationError('child'), { exitCode: null, signal: 'SIGXCPU' }), 'vercel_build');
  expect(q.failureReport(Buffer.from(JSON.stringify(report)), 'build', report.binding).signal).toBe('SIGXCPU');
  q.stopReport(report, Object.assign(new Error(PRIVATE), { code: PRIVATE, failingStep: PRIVATE, signal: PRIVATE }), 'preparation');
  expect(report).toMatchObject({ failure: 'internal', failingStep: 'preparation', exitCode: null, signal: null });
  expect(JSON.stringify(report)).not.toContain(PRIVATE);
});

test('late failure retains diagnostics while success-only inspection payloads stay out of failure terminals', () => {
  const report = { ...terminalFailure({ binding: 'a'.repeat(64) }), result: 'completed', inspection: { private: PRIVATE }, inspectionReport: { private: PRIVATE } };
  q.stopReport(report, new q.QualificationError('persistence'), 'terminal_persistence');
  report.persistenceFailure = 'persistence';
  expect(q.failureReport(Buffer.from(JSON.stringify(report)), 'build', report.binding)).toMatchObject({
    result: 'stopped', failure: 'persistence', failingStep: 'terminal_persistence', persistenceFailure: 'persistence' });
  expect(report).not.toHaveProperty('inspection'); expect(report).not.toHaveProperty('inspectionReport');
});

test.each(['teardown', 'persistence', 'oom'])('retained failure diagnostics survive %s failure without allowing a retry', async (kind) => {
  const f = await executionFixture('build', {
    start: (_args, options) => terminalChild(terminalFailure(f.prepared, 'build', { failingStep: 'vercel_build', exitCode: 37 }), 1, options),
    inspect: () => {
      if (kind === 'teardown') throw new Error(PRIVATE);
      return Buffer.from(JSON.stringify({ Running: false, ExitCode: kind === 'oom' ? 137 : 1, OOMKilled: kind === 'oom', Error: '' }));
    },
  });
  if (kind === 'persistence') {
    const open = fs.openSync;
    jest.spyOn(fs, 'openSync').mockImplementation((location, ...args) => {
      if (String(location).endsWith('.build.receipt.json')) throw new Error(PRIVATE);
      return open(location, ...args);
    });
  }
  const result = await q.execute('build', f.envelope, f.dependencies);
  expect(result).toMatchObject({ result: 'stopped', failure: 'child', failingStep: 'vercel_build', exitCode: 37 });
  if (kind === 'teardown') expect(result.teardownUnconfirmed).toBe(true);
  if (kind === 'persistence') expect(result.persistenceFailure).toBe('persistence');
  if (kind === 'oom') expect(result.containerExit).toEqual({ exitCode: 137, oomKilled: true });
  expect(fs.existsSync(path.join(f.root, 'active.lock'))).toBe(kind === 'teardown');
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  await expect(q.execute('build', f.envelope, f.dependencies)).rejects.toThrow('reservation');
});

test('default template cannot attest to a real execution', async () => {
  expect(await q.main([])).toEqual(q.template());
  expect(() => q.parseProfile(q.template())).toThrow('profile');
});

test('preparation performs no writes, Docker mutations, build or scan and excludes host files', async () => {
  const f = fixture(), write = jest.spyOn(fs, 'writeFileSync'), mkdir = jest.spyOn(fs, 'mkdirSync');
  const prepared = await q.prepare(f.profile, f);
  expect(prepared).toMatchObject({ mode: 'prepare', dockerOperations: 0, artifactReads: 0, builds: 0, inspections: 0, setupApproved: false });
  expect(prepared.selected).not.toContain('.env.example');
  expect(prepared.selected).not.toContain('.codex/credentials.json');
  expect(JSON.stringify(prepared)).not.toContain(folder.replaceAll('\\', '\\\\'));
  expect(write).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
});

test.each(['source', 'artifacts', 'settings', 'inputs', 'attestations'])('reject incomplete %s provenance', async (field) => {
  const f = fixture(); delete f.profile[field];
  await expect(q.prepare(f.profile, f)).rejects.toThrow('profile'); expect(f.git).not.toHaveBeenCalled();
});

test.each(['extra', 'network', 'command', 'runId'])('reject unreviewed profile option %s', (field) => {
  const f = fixture(); f.profile[field] = 'unapproved';
  expect(() => q.parseProfile(f.profile)).toThrow('profile');
});

test('dirty source and a mismatched source revision cannot enter the context', async () => {
  const f = fixture(), original = f.git.getMockImplementation();
  f.git.mockImplementation((root, args) => args[0] === 'status' ? Buffer.from(' M src/pages/index.js') : original(root, args));
  await expect(q.prepare(f.profile, f)).rejects.toThrow('source');
  f.git.mockImplementation(() => Buffer.from('f'.repeat(40)));
  await expect(q.prepare(f.profile, f)).rejects.toThrow('source');
});

test.each(['src/.env', 'src/.aws/credentials', 'public/.ssh/key', 'src/.vercel/project.json', 'src/node_modules/pkg.js', 'src/../private'])('reject forbidden selected input %s', (name) => {
  const f = fixture();
  expect(() => q.sourceSelection(Buffer.concat([f.tree, Buffer.from(`100644 blob ${'a'.repeat(40)}\t${name}\0`)]))).toThrow('forbidden');
});

test('reject source symlinks before archive creation', () => {
  const f = fixture();
  expect(() => q.sourceSelection(Buffer.concat([f.tree, Buffer.from(`120000 blob ${'a'.repeat(40)}\tsrc/link\0`)]))).toThrow('forbidden');
});

test.each(['.env', '.env.local', '.aws', '.ssh', '.codex', '.vercel', 'auth.json'])('never open forbidden path segment %s', (name) => {
  const read = jest.spyOn(fs, 'readFileSync');
  expect(() => q.publicFile(path.join(folder, name, 'profile-fixture.json'))).toThrow('forbidden');
  expect(read).not.toHaveBeenCalled();
});

test.each(['git+https://example.invalid/pkg.git', 'file:../pkg', 'https://other.invalid/a.tgz'])('reject non-registry package source %s', (url) => {
  const value = lock(q.TOOL_DEPS); value.packages['node_modules/vercel'].resolved = url;
  expect(() => q.checkLock(JSON.stringify(value), true)).toThrow('lock');
});

test('reject missing integrity, loose versions and incomplete toolchain locks', () => {
  const value = lock(q.TOOL_DEPS); delete value.packages['node_modules/vercel'].integrity;
  expect(() => q.checkLock(JSON.stringify(value), true)).toThrow('lock');
  const mutable = lock({ ...q.TOOL_DEPS, vercel: '^50.33.1' });
  expect(() => q.checkLock(JSON.stringify(mutable), true)).toThrow('lock');
  expect(() => q.checkLock(JSON.stringify({ lockfileVersion: 3, packages: {} }), true)).toThrow('lock');
});

test('reject changed archive, source lock, toolchain lock and manifest scripts', async () => {
  const f = fixture();
  await expect(q.prepare(f.profile, { ...f, fileHash: () => '0'.repeat(64) })).rejects.toThrow('artifact');
  await expect(q.prepare({ ...f.profile, source: { ...f.profile.source, lockSha256: 'e'.repeat(64) } }, f)).rejects.toThrow('lock');
  await expect(q.prepare({ ...f.profile, artifacts: { ...f.profile.artifacts, toolchainLockSha256: 'e'.repeat(64) } }, f)).rejects.toThrow('lock');
  fs.writeFileSync(path.join(folder, 'toolchain-package.json'), JSON.stringify({ private: true, dependencies: q.TOOL_DEPS, scripts: { postinstall: 'unsafe' } }));
  await expect(q.prepare(f.profile, f)).rejects.toThrow('lock');
});

test.each(['{"schemaVersion":1,"schemaVersion":1}', '{"nested":{"a":1,"\\u0061":2}}', '{"schemaVersion":01}', '{"x":NaN}', '{"x":true,}'])('strict original JSON rejects %s', (json) => {
  expect(() => q.strictJson(json)).toThrow('input');
});

test('strict JSON preserves decimals for schema rejection instead of PowerShell normalization', () => {
  const f = fixture(), json = JSON.stringify(f.profile).replace('"schemaVersion":1', '"schemaVersion":1.5');
  expect(() => q.parseProfile(q.strictJson(json))).toThrow('profile');
  expect(q.strictJson('{"arr":[{"a":1},{"a":2}],"text":"{not a key}:"}').arr).toHaveLength(2);
});

test('execution file changes invalidate setup and later stage approval', async () => {
  const f = fixture(), prepared = await q.prepare(f.profile, f), original = fs.readFileSync;
  for (const name of q.FILES) {
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((location, ...args) => {
      const bytes = original(location, ...args);
      return String(location).endsWith(name) ? Buffer.from(bytes.toString().replace(/./, 'X')) : bytes;
    });
    expect((await q.prepare(f.profile, f)).setupApproval).not.toBe(prepared.setupApproval); spy.mockRestore();
  }
});

test.each(['setup', 'build', 'inspect'])('%s needs independent matching approval before Docker or reservation', async (stage) => {
  const f = await executionFixture(stage);
  await expect(q.execute(stage, { ...f.envelope, approval: '0'.repeat(64) }, f.dependencies)).rejects.toThrow('approval');
  expect(f.docker).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(f.root, `${SOURCE}.${stage}.reservation.json`))).toBe(false);
});

test('build never automatically starts inspection and all private process inputs stay off Docker arguments', async () => {
  const f = await executionFixture('build');
  const result = await q.execute('build', f.envelope, f.dependencies);
  expect(result.result).toBe('completed');
  const calls = f.docker.mock.calls.map(([args]) => args);
  expect(calls.filter((args) => args[0] === 'create')).toHaveLength(1);
  expect(calls.flat()).not.toContain('--inside-inspect');
  expect(JSON.stringify(calls)).not.toContain(PRIVATE);
  expect(fs.existsSync(path.join(f.root, `${SOURCE}.inspect.reservation.json`))).toBe(false);
});

test('persistent reservation prevents repeated execution from another runner instance', async () => {
  const f = await executionFixture();
  expect((await q.execute('setup', f.envelope, f.dependencies)).result).toBe('completed');
  f.docker.mockClear();
  await expect(q.execute('setup', f.envelope, { ...f.dependencies })).rejects.toThrow('reservation');
  expect(f.docker).not.toHaveBeenCalled();
});

test('global active lock excludes concurrent stages and preserves the consumed reservation', async () => {
  const f = await executionFixture(); q.writeOnce(path.join(f.root, 'active.lock'), { occupied: true });
  await expect(q.execute('setup', f.envelope, f.dependencies)).rejects.toThrow('persistence');
  expect(f.docker).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(path.join(f.root, `${SOURCE}.setup.reservation.json`))).consumed).toBe(true);
});

test('container creation conflict never kills or removes a container owned by another attempt', async () => {
  const f = await executionFixture('build', { create: () => { throw new q.QualificationError('docker'); } });
  expect((await q.execute('build', f.envelope, f.dependencies)).result).toBe('stopped');
  expect(f.docker.mock.calls.some(([args]) => ['kill', 'rm'].includes(args[0]))).toBe(false);
});

test('deadline kills only the created container by ID and retains consumed evidence', async () => {
  let running = true;
  const f = await executionFixture('build', {
    start: () => { throw new q.QualificationError('deadline'); },
    inspect: () => Buffer.from(JSON.stringify({ Running: running })),
    kill: (args) => { expect(args[1]).toBe(CID); running = false; return Buffer.alloc(0); },
  });
  expect(await q.execute('build', f.envelope, f.dependencies)).toMatchObject({ result: 'stopped', failure: 'deadline' });
  expect(f.docker).toHaveBeenCalledWith(['kill', CID]);
  expect(f.docker).toHaveBeenCalledWith(['rm', CID]);
  expect(fs.existsSync(path.join(f.root, `${SOURCE}.build.reservation.json`))).toBe(true);
});

test('unconfirmed termination is non-passing and keeps the global lock', async () => {
  const f = await executionFixture('build', { inspect: () => { throw new Error(PRIVATE); } });
  const result = await q.execute('build', f.envelope, f.dependencies);
  expect(result).toMatchObject({ result: 'stopped', teardownUnconfirmed: true });
  expect(fs.existsSync(path.join(f.root, 'active.lock'))).toBe(true);
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
});

test.each([{ ExitCode: 137, OOMKilled: true }, { ExitCode: 7, OOMKilled: false }, { Error: 'fixture' }])('container state %j cannot produce a passing receipt', async (state) => {
  const f = await executionFixture('build', { inspect: () => Buffer.from(JSON.stringify({ Running: false, ExitCode: 0, OOMKilled: false, ...state })) });
  expect(await q.execute('build', f.envelope, f.dependencies)).toMatchObject({ result: 'stopped', failure: 'child' });
  expect(f.docker).toHaveBeenCalledWith(['rm', CID]);
});

test('report persistence failure is non-passing without releasing the reservation', async () => {
  const f = await executionFixture(), original = fs.openSync;
  jest.spyOn(fs, 'openSync').mockImplementation((location, ...args) => {
    if (String(location).endsWith('.setup.receipt.json')) throw new Error(PRIVATE);
    return original(location, ...args);
  });
  expect(await q.execute('setup', f.envelope, f.dependencies)).toMatchObject({ result: 'stopped', persistenceFailure: 'persistence' });
  expect(fs.existsSync(path.join(f.root, `${SOURCE}.setup.reservation.json`))).toBe(true);
});

test('missing or replaced volume/daemon cannot silently replace prepared output', async () => {
  const f = await executionFixture('build', { info: () => Buffer.from(JSON.stringify({ ID: 'other', OSType: 'linux', Architecture: 'amd64' })) });
  expect((await q.execute('build', f.envelope, f.dependencies)).result).toBe('stopped');
  expect(f.docker.mock.calls.some(([args]) => args[0] === 'create')).toBe(false);
  const run = dockerFixture(f.prepared, 'build', { volume: (args) => args[1] === 'ls' ? Buffer.alloc(0) : Promise.reject(new Error()) });
  await expect(q.engineCheck(run, 'build', 'fixture-daemon')).rejects.toThrow('preparation');
});

test('image and Linux inspection-profile changes invalidate later stage review', async () => {
  const f = await executionFixture('inspect');
  expect(() => q.stageReview(f.prepared, 'build', { ...f.setup, imageId: 'node:latest' })).toThrow('preparation');
  const approval = q.stageReview(f.prepared, 'inspect', f.setup, f.build).approval;
  expect(q.stageReview(f.prepared, 'inspect', f.setup, { ...f.build, inspection: { ...f.build.inspection, approvalId: 'e'.repeat(64) } }).approval).not.toBe(approval);
  expect(() => q.stageReview(f.prepared, 'build', { ...f.setup, persistenceFailure: 'persistence' })).toThrow('preparation');
  expect(() => q.stageReview(f.prepared, 'inspect', f.setup, { ...f.build, teardownUnconfirmed: true })).toThrow('preparation');
});

test('post-build inspection assertions require owner input and do not silently authorize another setup', async () => {
  const f = await executionFixture('inspect');
  const without = { ...f.profile }; delete without.inspectionAttestations;
  const prepared = await q.prepare(without, f);
  expect(prepared.binding).toBe(f.prepared.binding); expect(prepared.setupApproval).toBe(f.prepared.setupApproval);
  expect(() => q.stageReview(prepared, 'inspect', f.setup, f.build)).toThrow('approval');
  expect(q.stageReview(f.prepared, 'inspect', f.setup, f.build).inspection).toMatchObject({ attestationsConfirmed: true,
    profile: { attestations: f.profile.inspectionAttestations } });
});

test('only explicit assertions for the exact draft can reach scanner inspection', () => {
  const scanner = require('../../../scripts/gate1-build-artifact-privacy');
  expect(q.SCAN_ATTESTATIONS).toEqual(scanner.ATTESTATIONS);
  const profile = { ...scanner.profileTemplate(), outputRoot: path.join(folder, '.vercel/output'),
    attestations: Object.fromEntries(scanner.ATTESTATIONS.map((key) => [key, true])) };
  const draft = { ...scanner.preparation(profile), profile: { ...profile,
    attestations: Object.fromEntries(scanner.ATTESTATIONS.map((key) => [key, false])) }, attestationsConfirmed: false };
  const confirmed = { ...draft, profile, attestationsConfirmed: true };
  expect(q.confirmInspection(draft, confirmed, scanner)).toEqual(profile);
  expect(() => q.confirmInspection(draft, draft, scanner)).toThrow('approval');
  expect(() => q.confirmInspection(draft, { ...confirmed, profile: { ...profile,
    outputRoot: path.join(folder, 'other/.vercel/output') } }, scanner)).toThrow('approval');
});

test('container contract enforces isolation and an independent Linux timeout with persistent storage', () => {
  const args = q.containerArgs(IMAGE, 'build', SOURCE);
  for (const option of ['--pull=never', '--network=none', '--read-only', '--log-driver=none', '--restart=no',
    '--cpus=4', '--memory=6442450944', '--memory-swap=6442450944', '--pids-limit=256', '/usr/bin/timeout', '--signal=KILL', '1800s']) expect(args).toContain(option);
  expect(args.some((arg) => arg.startsWith('type=bind'))).toBe(false);
  expect(args.some((arg) => arg.includes('docker.sock'))).toBe(false);
  expect(q.containerArgs(IMAGE, 'inspect', SOURCE)).toContain('135s');
  expect(() => q.containerArgs('node:latest', 'build', SOURCE)).toThrow('docker');
});

test('scanner dependency resolution is isolated from the build-writable application dependencies', () => {
  const args = q.containerArgs(IMAGE, 'inspect', SOURCE);
  expect(args).toContain(`NODE_PATH=/state/${SOURCE}/tools/node_modules`);
  expect(args).not.toContain(`NODE_PATH=/state/${SOURCE}/app/node_modules`);
  expect(q.TOOL_DEPS.zod).toBe('4.3.6');
});

test('synthetic values use existing names and comparisons exactly cover all server values', () => {
  const inputs = q.syntheticInputs();
  expect(inputs.comparisons.map((entry) => entry.label)).toEqual(q.LABELS);
  for (const ref of inputs.comparisons) expect(JSON.stringify(inputs.env)).toContain(ref.value);
  expect(inputs.env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://gate1-build.invalid');
  expect(inputs.env.SUPABASE_SERVICE_ROLE_KEY).not.toBe(q.syntheticInputs().env.SUPABASE_SERVICE_ROLE_KEY);
});

test('cache tar rejects traversal, links, extra archives and malformed checksums', () => {
  const f = fixture(), location = path.join(folder, 'npm-cache.tar'), valid = fs.readFileSync(location);
  expect(() => q.checkCacheTar(location)).not.toThrow();
  expect(() => q.tarHeader('../escape', 1)).toThrow('artifact');
  fs.writeFileSync(location, Buffer.concat([valid, Buffer.from('appended')]));
  expect(() => q.checkCacheTar(location)).toThrow('artifact');
  const corrupt = Buffer.from(valid); corrupt[156] = 50; fs.writeFileSync(location, corrupt);
  expect(() => q.checkCacheTar(location)).toThrow('artifact');
  expect(f.profile.artifacts.cacheSha256).toBe(hash(valid));
});

/** Build a bounded GNU long-name fixture, matching npm's 124-character SHA-512 cache basenames. */
function longNameTar(name, payloadType = 48) {
  const bytes = Buffer.from(name + '\0'), header = q.tarHeader('_cacache/placeholder', bytes.length);
  header.fill(0, 0, 100); header.write('././@LongLink'); header[156] = 76;
  header.write('ustar ', 257); header.write(' \0', 263);
  header.fill(32, 148, 156);
  header.write(header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  const payload = q.tarHeader('_cacache/truncated', 1); payload[156] = payloadType;
  payload.write('ustar ', 257); payload.write(' \0', 263);
  payload.fill(32, 148, 156);
  payload.write(payload.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512), payload,
    Buffer.from('x'), Buffer.alloc(511), Buffer.alloc(1024)]);
}

test('ordinary npm SHA-512 cache long names work, while long-name traversal and symlinks fail', () => {
  const location = path.join(folder, 'cache.tar'), name = '_cacache/content-v2/sha512/aa/bb/' + 'c'.repeat(124);
  fs.writeFileSync(location, longNameTar(name)); expect(() => q.checkCacheTar(location)).not.toThrow();
  fs.writeFileSync(location, longNameTar('_cacache/../../outside')); expect(() => q.checkCacheTar(location)).toThrow('artifact');
  fs.writeFileSync(location, longNameTar(name, 50)); expect(() => q.checkCacheTar(location)).toThrow('artifact');
});

/** Describe synthetic raw blob bytes using Git's object hash, including the source executable bit. */
function sourceMember(name, bytes, mode = '100644') {
  return { name, mode, oid: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
}

/** Inspect tar payloads independently of the writer, checking checksums and byte-counted PAX path records. */
function archiveMembers(bytes) {
  const members = new Map(); let nextPath;
  for (let offset = 0; offset < bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(header.toString('ascii', 124, 136), 8), type = header[156];
    expect(header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0))
      .toBe(parseInt(header.toString('ascii', 148, 156), 8));
    const payload = bytes.subarray(offset + 512, offset + 512 + size);
    expect(payload.length).toBe(size);
    if (type === 120) {
      for (let cursor = 0; cursor < payload.length; ) {
        const space = payload.indexOf(32, cursor), length = Number(payload.toString('ascii', cursor, space));
        expect(Number.isSafeInteger(length) && length > space - cursor + 1).toBe(true);
        expect(payload[cursor + length - 1]).toBe(10);
        const field = payload.toString('utf8', space + 1, cursor + length - 1);
        if (field.startsWith('path=')) nextPath = field.slice(5);
        cursor += length;
      }
    } else if (type === 48 || type === 0) {
      const name = nextPath ?? header.toString('utf8', 0, 100).split('\0')[0];
      expect(members.has(name)).toBe(false);
      members.set(name, { bytes: payload, mode: parseInt(header.toString('ascii', 100, 108), 8) });
      nextPath = undefined;
    } else expect([53, 103]).toContain(type); // Git archives also contain directory and global PAX headers.
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return members;
}

/** Read fixture Git objects or create a disposable synthetic repository, with the supervisor's isolated environment. */
async function sourceGit(args, input) {
  return q.supervise('git', ['-C', folder, ...args], { input });
}

test('source archive preserves literal placeholders, mixed newlines, binary bytes, long Unicode paths and executable modes', async () => {
  const entries = [
    { name: 'src/version.js', bytes: Buffer.from('$Format:%H$\n$Id$\r\nlast\rline\n'), mode: '100755' },
    { name: 'public/data.bin', bytes: Buffer.from([0, 255, 254, 13, 10, 128]) },
    { name: 'src/' + 'nested/'.repeat(35) + 'é' + 'x'.repeat(90) + '.js', bytes: Buffer.from('unicode path') },
    { name: 'src/empty file.js', bytes: Buffer.alloc(0) },
  ];
  const manifest = entries.map(({ name, bytes, mode }) => sourceMember(name, bytes, mode));
  const git = jest.fn(async (_root, args) => entries[manifest.findIndex((entry) => entry.oid === args[2])].bytes);
  const location = path.join(folder, 'source.tar');
  await q.sourceArchive(folder, manifest, location, { git });
  const members = archiveMembers(fs.readFileSync(location));
  expect([...members.keys()]).toEqual(entries.map((entry) => entry.name));
  entries.forEach((entry, index) => {
    expect(members.get(entry.name)).toEqual({ bytes: entry.bytes, mode: index === 0 ? 0o755 : 0o644 });
    expect(git.mock.calls[index].slice(0, 2)).toEqual([folder, ['cat-file', 'blob', manifest[index].oid]]);
  });
  expect(git).toHaveBeenCalledTimes(entries.length);
});

test('committed export attributes cannot transform or omit reviewed source blobs', async () => {
  await sourceGit(['init', '--quiet']);
  const text = Buffer.from('$Format:%H$\n$Id$\n'), binary = Buffer.from([0, 13, 10, 255]);
  const manifest = [sourceMember('src/version.js', text, '100755'), sourceMember('src/data.bin', binary)];
  for (const bytes of [text, binary]) await sourceGit(['hash-object', '-w', '--stdin'], bytes);
  const attributes = (await sourceGit(['hash-object', '-w', '--stdin'],
    Buffer.from('src/version.js export-subst text eol=crlf ident\nsrc/data.bin export-ignore\n'))).toString().trim();
  const subtree = (await sourceGit(['mktree'], Buffer.from(manifest.map((entry) =>
    `${entry.mode} blob ${entry.oid}\t${path.posix.basename(entry.name)}\n`).join('')))).toString().trim();
  const tree = (await sourceGit(['mktree'], Buffer.from(
    `100644 blob ${attributes}\t.gitattributes\n040000 tree ${subtree}\tsrc\n`))).toString().trim();
  const commit = (await sourceGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit-tree', tree, '-m', 'Synthetic archive regression'])).toString().trim();
  const legacy = archiveMembers(await sourceGit(['archive', '--format=tar', commit, '--', 'src']));
  expect(legacy.get('src/version.js').bytes.equals(text)).toBe(false);
  expect(legacy.get('src/version.js').bytes.toString()).toContain(commit);
  expect(legacy.has('src/data.bin')).toBe(false);
  const location = path.join(folder, 'source.tar');
  await q.sourceArchive(folder, manifest, location);
  const members = archiveMembers(fs.readFileSync(location));
  expect(members.get('src/version.js')).toEqual({ bytes: text, mode: 0o755 });
  expect(members.get('src/data.bin')).toEqual({ bytes: binary, mode: 0o644 });
  const extracted = path.join(folder, 'extracted'); fs.mkdirSync(path.join(extracted, 'src'), { recursive: true });
  for (const [name, member] of members) fs.writeFileSync(path.join(extracted, name), member.bytes, { mode: member.mode });
  expect(() => q.verifySource(extracted, manifest)).not.toThrow();
}, 30000);

test('source archive rejects changed blob bytes and closes the failed output', async () => {
  const manifest = [sourceMember('src/file.js', Buffer.from('reviewed'))], location = path.join(folder, 'source.tar');
  const git = jest.fn(async () => Buffer.from('changed'));
  await expect(q.sourceArchive(folder, manifest, location, { git })).rejects.toThrow('source');
  expect(fs.readFileSync(location).length).toBe(0);
  expect(() => fs.renameSync(location, path.join(folder, 'failed.tar'))).not.toThrow();
});

test.each([
  { byteLimit: 1536, count: 1, reads: 0 },
  { byteLimit: 3071, count: 1, reads: 1 },
  { byteLimit: 4096, count: 2, reads: 1 },
])('source archive caps headers, padding and cumulative bytes with %j', async ({ byteLimit, count, reads }) => {
  const bytes = Buffer.from('x'), git = jest.fn(async () => bytes);
  const manifest = Array.from({ length: count }, (_, index) => sourceMember(`src/file${index}.js`, bytes));
  await expect(q.sourceArchive(folder, manifest, path.join(folder, 'source.tar'), { git, byteLimit })).rejects.toThrow('stream_limit');
  expect(git).toHaveBeenCalledTimes(reads);
});

test('source archive accepts the exact byte limit and bounds each Git read', async () => {
  const bytes = Buffer.from('x'), git = jest.fn(async () => bytes), location = path.join(folder, 'source.tar');
  await q.sourceArchive(folder, [sourceMember('src/file.js', bytes)], location, { git, byteLimit: 3072, timeoutMs: 1000 });
  expect(fs.statSync(location).size).toBe(3072);
  expect(git.mock.calls[0][2].outputBytes).toBe(512);
  expect(git.mock.calls[0][2].timeoutMs).toBeGreaterThan(0);
  expect(git.mock.calls[0][2].timeoutMs).toBeLessThanOrEqual(1000);
});

test('source archive rejects oversized Git output, exhausted deadlines and attempts to raise the byte cap', async () => {
  const bytes = Buffer.alloc(513), git = jest.fn(async () => bytes), manifest = [sourceMember('src/file.js', bytes)];
  await expect(q.sourceArchive(folder, manifest, path.join(folder, 'oversized.tar'), { git, byteLimit: 3072 })).rejects.toThrow('stream_limit');
  git.mockClear();
  await expect(q.sourceArchive(folder, manifest, path.join(folder, 'deadline.tar'), { git, timeoutMs: 0 })).rejects.toThrow('deadline');
  await expect(q.sourceArchive(folder, manifest, path.join(folder, 'cap.tar'), { git, byteLimit: q.LIMITS.sourceBytes + 1 })).rejects.toThrow('artifact');
  expect(git).not.toHaveBeenCalled();
});

test('source verification detects changed, extra and missing exported blobs', () => {
  const root = path.join(folder, 'source'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'file.js'), 'original');
  const manifest = [{ name: 'file.js', mode: '100644', oid: createHash('sha1').update('blob 8\0original').digest('hex') }];
  expect(() => q.verifySource(root, manifest)).not.toThrow();
  fs.writeFileSync(path.join(root, 'file.js'), 'changed'); expect(() => q.verifySource(root, manifest)).toThrow('source');
  fs.writeFileSync(path.join(root, 'extra.js'), 'extra'); expect(() => q.verifySource(root, [])).toThrow('source');
});

test('context records hashes of the transferred bytes, including streamed archives', () => {
  const data = Buffer.from('reviewed fixture'), location = path.join(folder, 'source.tar'); fs.writeFileSync(location, data);
  const hashes = q.contextTar(path.join(folder, 'context.tar'), [['source.tar', location], ['execution/fixture.js', data]]);
  expect(hashes).toEqual({ 'source.tar': hash(data), 'execution/fixture.js': hash(data) });
});

test('child deadline, stderr and stdout limits stop synthetic commands without leaking values', async () => {
  await expect(q.supervise(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 })).rejects.toThrow('deadline');
  await expect(q.supervise(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(PRIVATE)})`], { outputBytes: 4 })).rejects.toThrow('stream_limit');
  await expect(q.supervise(process.execPath, ['-e', 'process.stderr.write("x".repeat(8388609))'])).rejects.toThrow('stream_limit');
  await expect(q.supervise(process.execPath, ['-e', 'process.exitCode=7'])).rejects.toThrow('child');
  const discarded = await q.supervise(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(PRIVATE)})`], { capture: false });
  expect(discarded.length).toBe(0);
});

test('bounded stdin validates original JSON and releases stream listeners', async () => {
  const stream = new PassThrough(), promise = q.readInput(stream);
  stream.end('{"a":1,"a":2}'); await expect(promise).rejects.toThrow('input');
  expect(stream.listenerCount('data')).toBe(0); expect(stream.listenerCount('end')).toBe(0);
  const oversized = new PassThrough(), second = q.readInput(oversized);
  oversized.end(Buffer.alloc(q.LIMITS.inputBytes + 1)); await expect(second).rejects.toThrow('input');
});

windowsTest('launcher template does not start Docker and preserves nonzero exits without exposing stderr', () => {
  const location = path.join(folder, 'run-gate1-build-qualification.ps1'); fs.copyFileSync(PS, location);
  fs.writeFileSync(path.join(folder, 'gate1-build-qualification.js'), `process.stderr.write(${JSON.stringify(PRIVATE)}); process.exitCode=7;`);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', location, '-Template'], { encoding: 'utf8', timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(7);
  expect(result.stdout + result.stderr).not.toContain(PRIVATE);
});

windowsTest.each(['{"schemaVersion":1,"schemaVersion":1}', '{"schemaVersion":1.5}', '{schemaVersion:1}', '{"schemaVersion":+1}'])('new launcher rejects original invalid JSON %s before Docker', (json) => {
  const location = path.join(folder, 'profile-fixture.json'); fs.writeFileSync(location, json);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', PS, '-ProfilePath', location],
    { encoding: 'utf8', timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Qualification stopped');
});

windowsTest('PowerShell preserves exact profile text through separate inspection confirmation', () => {
  const raw = '{\n "schemaVersion": 1, "reviewedText": "keep formatting"\n}', approval = 'e'.repeat(64);
  const location = path.join(folder, 'profile-fixture.json'); fs.writeFileSync(location, raw);
  const command = `
    . '${PS.replaceAll("'", "''")}' -ProfilePath '${location.replaceAll("'", "''")}' -Stage inspect -Execute -Approval '${approval}'
    $script:captured = @{}
    <# Capture only synthetic transport bytes; replace every Node/Docker operation. #>
    function Invoke-Gate1QualificationNode([string]$Mode, [string]$InputJson = '') {
      if ($Mode -ceq '--prepare-inspect') {
        $script:captured.prepare = $InputJson
        return @{ Json = '{"approval":"${approval}","gate1Status":"open"}'; ExitCode = 0 }
      }
      if ($Mode -cne '--inspect') { throw 'Unexpected mode.' }
      $script:captured.inspect = $InputJson
      return @{ Json = '{"result":"fixture"}'; ExitCode = 0 }
    }
    <# Simulate the exact owner confirmation without interactive prompting. #>
    function Read-Host([string]$Prompt) { return 'SCAN APPROVED OUTPUT ONCE' }
    $null = Invoke-Gate1BuildQualification
    ConvertTo-Json -InputObject $script:captured -Compress
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
  const captured = JSON.parse(result.stdout); expect(captured.prepare).toBe(raw); expect(captured.inspect).toContain(raw);
  expect(JSON.parse(captured.inspect)).toEqual({ profile: JSON.parse(raw), approval, authorized: true });
});

test('persistent storage monitor stops on the logical byte threshold without allocating a large file', () => {
  const location = path.join(folder, 'fixture.dat'); fs.writeFileSync(location, 'small'); const original = fs.lstatSync;
  jest.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
    const stat = original(target, ...args);
    if (target === location) stat.size = q.LIMITS.storageBytes + 1;
    return stat;
  });
  expect(() => q.storageCheck(folder)).toThrow('storage');
});

test('CLI executable comes from the locked local manifest and cannot escape its package', () => {
  const root = path.join(folder, 'tools/node_modules/vercel'); fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist/vc.js'), 'fixture');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ bin: { vercel: 'dist/vc.js' } }));
  expect(q.vercelEntry(folder)).toBe(path.join(root, 'dist/vc.js'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ bin: { vercel: 'dist/../../escape.js' } }));
  expect(() => q.vercelEntry(folder)).toThrow('toolchain');
});

test('preexisting volume with bind or remote options cannot impersonate the private local volume', async () => {
  const f = fixture(), prepared = await q.prepare(f.profile, f);
  const docker = dockerFixture(prepared, 'build', { volume: (args) => args[1] === 'ls' ? Buffer.from(q.VOLUME) :
    Buffer.from(JSON.stringify([{ Name: q.VOLUME, Driver: 'local', Options: { device: '/host' }, Labels: { 'gate1.scope': q.SCOPE } }])) });
  await expect(q.engineCheck(docker, 'build', 'fixture-daemon')).rejects.toThrow('docker');
  expect(docker.mock.calls.some(([args]) => args[0] === 'create')).toBe(false);
});
