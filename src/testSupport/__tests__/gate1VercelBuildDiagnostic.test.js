/** Synthetic metadata and children, disposable host receipts and mocked Docker; never use retained Linux output. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const d = require('../../../scripts/gate1-vercel-build-diagnostic');
const q = require('../../../scripts/gate1-build-qualification');
const lib = d.readerLibrary();
const BASE = path.resolve(__dirname, '../../../.tmp/vercel-diagnostic-test-fixtures');
const LAUNCHER = path.resolve(__dirname, '../../../scripts/run-gate1-vercel-build-diagnostic.ps1');
const PRIVATE = 'synthetic-secret-do-not-export-12345';
const CID = 'c'.repeat(64), APPROVAL = 'a'.repeat(64);
const CONTRACT = { ...d.FIXED, target: lib.target, approval: APPROVAL };
const supervise = q.supervise;
const probe = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
  { stdio: 'ignore', timeout: 5000, windowsHide: true });
const windowsTest = probe && !probe.error && probe.status === 0 ? test : test.skip;
let folder, guards;

beforeEach(() => {
  fs.mkdirSync(BASE, { recursive: true }); folder = fs.mkdtempSync(path.join(BASE, 'fixture-'));
  guards = [http, https].map((module) => jest.spyOn(module, 'request').mockImplementation(() => { throw new Error('Network forbidden'); }));
  jest.spyOn(q, 'supervise').mockImplementation(() => { throw new Error('Real host command forbidden'); });
});
afterEach(() => {
  guards.forEach((guard) => expect(guard).not.toHaveBeenCalled()); jest.restoreAllMocks();
  const resolved = path.resolve(folder);
  if (!resolved.startsWith(BASE + path.sep) || resolved === BASE) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(resolved, { recursive: true, force: true });
});

/** Substitute public limits/dependency in memory to test module-load guards without running the CLI or changing files. */
function loadDiagnostic(limitChanges = {}, qualification = q) {
  const location = path.resolve(__dirname, '../../../scripts/gate1-vercel-build-diagnostic.js');
  const source = fs.readFileSync(location, 'utf8').replace(/const LIMITS = Object\.freeze\(\{[\s\S]*?\}\);/,
    `const LIMITS = Object.freeze(${JSON.stringify({ ...d.LIMITS, ...limitChanges })});`);
  const context = { module: { exports: {} }, __dirname: path.dirname(location), Buffer,
    require: (name) => name === './gate1-build-qualification' ? qualification : require(name) };
  runInNewContext(source, context, { filename: location });
  return context.module.exports;
}

/** Build metadata with private distractors; only finite categories may escape classification. */
function metadata(error = { name: 'NowBuildError', code: 'BUILD_UTILS_SPAWN_1' }) {
  return { cliVersion: '50.33.1', target: 'preview', error: { ...error, message: PRIVATE, stack: PRIVATE, argv: [PRIVATE] },
    builds: [{ debug: PRIVATE }], [PRIVATE]: PRIVATE };
}

/** Model only the fixed file/ancestors, rejecting all discovery and alternate content reads. */
function filesystem(value = metadata(), changes = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const dirs = ['/evidence', `/evidence/${d.FIXED.sourceSha}`, `/evidence/${d.FIXED.sourceSha}/app`,
    `/evidence/${d.FIXED.sourceSha}/app/.vercel`, `/evidence/${d.FIXED.sourceSha}/app/.vercel/output`];
  let position = 0;
  /** Create stable fake stat metadata, overriding selected fields to exercise filesystem rejection. */
  function stat(isFile, index = 1) {
    return { dev: 1, ino: index, mode: isFile ? 0o100644 : 0o40755, nlink: isFile ? 1 : 2,
      size: isFile ? bytes.length : 4096, mtimeMs: 10, ctimeMs: 20,
      isFile: () => isFile, isDirectory: () => !isFile, isSymbolicLink: () => false };
  }
  const fileStat = { ...stat(true, 10), ...changes.file };
  const io = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000, O_NONBLOCK: 0x800 },
    lstatSync: jest.fn((name) => {
      if (name === lib.target) return { ...fileStat };
      const index = dirs.indexOf(name);
      if (index === -1) throw new Error('Unexpected metadata path');
      return { ...stat(false, index + 1), ...(changes.ancestorIndex === index ? changes.ancestor : {}) };
    }),
    fstatSync: jest.fn(() => ({ ...fileStat, ...changes.opened })),
    openSync: jest.fn((name) => { if (name !== lib.target) throw new Error('Unexpected content path'); return 42; }),
    readSync: jest.fn((_fd, buffer, offset, length) => {
      const count = Math.min(length, bytes.length - position);
      bytes.copy(buffer, offset, position, position + count); position += count; return count;
    }),
    closeSync: jest.fn(),
  };
  return { io, dirs, fileStat, bytes };
}

/** Materialize byte-exact public receipt fixtures, independent of the actual retained evidence registry. */
function evidence() {
  const base = { schemaVersion: 1, stage: 'setup', binding: d.FIXED.qualificationBinding, result: 'completed', gate1Status: 'open',
    network: 'none', rawProcessStreamsRetained: false, historicalArtifactPrivacy: 'unverified', hostedAttribution: 'not_established', versions: q.VERSIONS };
  const setup = { ...base, imageId: d.FIXED.imageId, daemonId: d.FIXED.daemonId, containerExit: { exitCode: 0, oomKilled: false } };
  const build = { ...base, stage: 'build', result: 'stopped', failure: 'child', failingStep: 'vercel_build', exitCode: 1, signal: null,
    imageId: d.FIXED.imageId, daemonId: d.FIXED.daemonId, stageProcess: { exitCode: 1, signal: null }, containerExit: { exitCode: 1, oomKilled: false } };
  const reservation = { scope: q.SCOPE, stage: 'build', sourceSha: d.FIXED.sourceSha, approval: d.FIXED.failedBuildApproval, consumed: true };
  for (const [name, value] of [['setup.receipt', setup], ['build.receipt', build], ['build.reservation', reservation]]) {
    q.writeOnce(path.join(folder, `${d.FIXED.sourceSha}.${name}.json`), value);
  }
  return { setup, build, reservation };
}

/** Prepare a synthetic execution profile with all owner assertions, without approving any actual generated-output read. */
async function fixture(overrides = {}) {
  evidence();
  const selected = { ...d.template(), attestations: Object.fromEntries(d.ATTESTATIONS.map((key) => [key, true])) };
  const prepared = await d.prepare(selected, { root: folder, revision: 'b'.repeat(40) });
  const report = lib.classify(metadata(), { ...CONTRACT, approval: prepared.approval });
  const docker = jest.fn(async (fullArgs, options) => {
    expect(fullArgs.slice(0, 2)).toEqual(['--context', 'desktop-linux']);
    const args = fullArgs.slice(2);
    if (overrides[args[0]]) return overrides[args[0]](args, options);
    if (args[0] === 'info') return Buffer.from(JSON.stringify({ ID: d.FIXED.daemonId, OSType: 'linux', Architecture: 'x86_64' }));
    if (args[0] === 'ps') return Buffer.alloc(0);
    if (args[0] === 'volume') return Buffer.from(JSON.stringify([{ Name: q.VOLUME, Driver: 'local', Options: null, Labels: { 'gate1.scope': q.SCOPE } }]));
    if (args[0] === 'image') return Buffer.from(JSON.stringify([{ Id: d.FIXED.imageId, Os: 'linux', Architecture: 'amd64' }]));
    if (args[0] === 'create') return Buffer.from(CID);
    if (args[0] === 'start') return Buffer.from(JSON.stringify(report));
    if (args[0] === 'inspect') return Buffer.from(JSON.stringify({ Running: false, ExitCode: 0, OOMKilled: false, Error: '' }));
    if (args[0] === 'rm' || args[0] === 'kill') return Buffer.alloc(0);
    throw new Error('Unexpected Docker fixture command');
  });
  return { prepared, report, docker, envelope: { profile: selected, approval: prepared.approval, authorized: true },
    deps: { root: folder, prepare: jest.fn(async () => prepared), docker } };
}

/** Assert once-only evidence without reading or changing real qualification reservations. */
function consumed() {
  expect(JSON.parse(fs.readFileSync(path.join(folder, `${d.KEY}.reservation.json`))).consumed).toBe(true);
}

test.each(lib.codes)('normalizes exact code %s without exporting private distractors', (code) => {
  const report = lib.classify(metadata({ code }), CONTRACT);
  expect(report).toMatchObject({ outcome: 'reported_error', errorCode: code, codeExitStatus: null, codeSignal: null });
  expect(JSON.stringify(report)).not.toContain(PRIVATE);
  expect(d.validateReport(Buffer.from(JSON.stringify(report)), APPROVAL)).toEqual(report);
});

test.each(['1', '255', ...lib.signals])('normalizes BUILD_UTILS_SPAWN_%s with separate exitCode provenance', (suffix) => {
  const report = lib.classify(metadata({ code: `BUILD_UTILS_SPAWN_${suffix}`, exitCode: 17 }), CONTRACT);
  expect(report).toMatchObject({ errorCode: 'BUILD_UTILS_SPAWN', errorExitCode: 17,
    codeExitStatus: lib.signals.includes(suffix) ? null : Number(suffix), codeSignal: lib.signals.includes(suffix) ? suffix : null });
  expect(d.validateReport(Buffer.from(JSON.stringify(report)), APPROVAL)).toEqual(report);
});

test.each(['0', '256', '01', '1.0', '-1', 'SIGINT', '1\n', `1_${PRIVATE}`])('rejects unsupported spawn status %s', (suffix) => {
  const report = lib.classify(metadata({ code: `BUILD_UTILS_SPAWN_${suffix}` }), CONTRACT);
  expect(report).toMatchObject({ outcome: 'unrecognized_error', errorCode: 'unrecognized', codeExitStatus: null, codeSignal: null });
});

test.each([...lib.names, PRIVATE, null, [], {}])('classifies error name without string coercion %#', (name) => {
  const report = lib.classify(metadata({ name }), CONTRACT);
  expect(report.errorName).toBe(lib.names.includes(name) ? name : 'unrecognized');
  expect(JSON.stringify(report)).not.toContain(PRIVATE);
});

test.each([0, 255, -1, 256, 1.5, '1', PRIVATE, null, {}, []])('bounds own numeric exitCode %#', (exitCode) => {
  const report = lib.classify(metadata({ exitCode }), CONTRACT);
  expect(report.errorExitCode).toBe(Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null);
  expect(JSON.stringify(report)).not.toContain(PRIVATE);
});

test.each(lib.tools)('allows bare %s only, including a normalized spawn operation', (tool) => {
  const report = lib.classify(metadata({ path: tool, syscall: `spawn ${tool}` }), CONTRACT);
  expect(report).toMatchObject({ tool, operation: 'spawn', operationTool: tool });
  expect(d.validateReport(Buffer.from(JSON.stringify(report)), APPROVAL)).toEqual(report);
});

test.each(['open', 'read', 'write', 'mkdir'])('allows exact %s operation', (syscall) => {
  expect(lib.classify(metadata({ syscall }), CONTRACT)).toMatchObject({ operation: syscall, operationTool: 'missing' });
});

test.each(['name', 'code', 'exitCode', 'path', 'syscall', 'message', 'stack', 'stdout', 'stderr', 'argv', PRIVATE])(
  'never exports private metadata field %s', (key) => {
    const value = metadata({ [key]: PRIVATE });
    const report = lib.read(CONTRACT, filesystem(value).io);
    expect(JSON.stringify(report)).not.toContain(PRIVATE);
    expect(d.validateReport(Buffer.from(JSON.stringify(report)), APPROVAL)).toEqual(report);
  });

test.each(['cliVersion', 'target'])('mismatched %s stops error classification', (key) => {
  const report = lib.classify({ ...metadata(), [key]: PRIVATE }, CONTRACT);
  expect(report).toMatchObject({ outcome: 'provenance_mismatch', errorCode: 'missing', errorName: 'missing' });
  expect(JSON.stringify(report)).not.toContain(PRIVATE);
});

test.each([null, [], 1, 'text'])('rejects non-object root/error shape %#', (value) => {
  expect(lib.classify(value, CONTRACT).outcome).toBe('metadata_rejected');
  expect(lib.classify({ ...metadata(), error: value }, CONTRACT).outcome).toBe('metadata_rejected');
});

test('missing error and unrecognized generic errors stop without fallback', () => {
  const value = metadata(); delete value.error;
  expect(lib.read(CONTRACT, filesystem(value).io).outcome).toBe('no_error_record');
  expect(lib.classify(metadata({ name: 'Error' }), CONTRACT).outcome).toBe('unrecognized_error');
  expect(lib.classify(metadata({ path: `/usr/bin/${PRIVATE}`, syscall: `spawn /usr/bin/${PRIVATE}` }), CONTRACT))
    .toMatchObject({ tool: 'unrecognized', operation: 'unrecognized', operationTool: 'missing' });
});

test.each([
  Buffer.from('{"a":1,"a":2}'), Buffer.from('{"a":1,"\\u0061":2}'), Buffer.from('{"error":{"a":1,"a":2}}'),
  Buffer.from([0xff]), Buffer.from(`{"${PRIVATE}":`), Buffer.from('['.repeat(17) + '0' + ']'.repeat(17)),
  Buffer.from(JSON.stringify(Array(4096).fill(0))), Buffer.alloc(262145),
])('rejects malformed/duplicate/over-budget JSON privately %#', (bytes) => {
  expect(() => lib.parse(bytes)).toThrow('metadata_rejected');
  expect(lib.read(CONTRACT, filesystem(bytes).io).outcome).toBe('metadata_rejected');
});

test('accepts exact structural/byte caps and counts primitive/container nodes', () => {
  expect(lib.parse(Buffer.from('['.repeat(16) + '0' + ']'.repeat(16)))).toBeDefined();
  expect(lib.parse(Buffer.from(JSON.stringify(Array(4095).fill(0))))).toHaveLength(4095);
  expect(lib.parse(Buffer.from('"' + 'a'.repeat(262142) + '"'))).toHaveLength(262142);
});

test('opens only the fixed file with NOFOLLOW/NONBLOCK and closes the descriptor', () => {
  const f = filesystem(), report = lib.read(CONTRACT, f.io);
  expect(report.outcome).toBe('reported_error');
  expect(f.io.openSync).toHaveBeenCalledTimes(1);
  expect(f.io.openSync).toHaveBeenCalledWith(lib.target, f.io.constants.O_NOFOLLOW | f.io.constants.O_NONBLOCK);
  expect(f.io.lstatSync.mock.calls.every(([name]) => name === lib.target || f.dirs.includes(name))).toBe(true);
  expect(f.io.closeSync).toHaveBeenCalledWith(42);
});

test.each([
  ['symlink', { isSymbolicLink: () => true }], ['directory', { isFile: () => false }],
  ['special device', { isFile: () => false, mode: 0o20666 }], ['hardlink', { nlink: 2 }],
  ['cross-device', { dev: 2 }], ['oversize', { size: 262145 }], ['negative size', { size: -1 }],
])('rejects final-file %s before opening content', (_label, file) => {
  const f = filesystem(metadata(), { file });
  expect(lib.read(CONTRACT, f.io).outcome).toBe('metadata_rejected');
  expect(f.io.openSync).not.toHaveBeenCalled();
});

test.each([0, 1, 2, 3, 4])('rejects ancestor links/devices at depth %s', (ancestorIndex) => {
  for (const ancestor of [{ isSymbolicLink: () => true }, { isDirectory: () => false }, { dev: 2 }]) {
    const f = filesystem(metadata(), { ancestorIndex, ancestor });
    expect(lib.read(CONTRACT, f.io).outcome).toBe('metadata_rejected');
    expect(f.io.openSync).not.toHaveBeenCalled();
  }
});

test.each(['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'])('rejects opened-file %s substitution', (key) => {
  const f = filesystem(metadata(), { opened: { [key]: 999 } });
  expect(lib.read(CONTRACT, f.io).outcome).toBe('metadata_rejected');
  expect(f.io.readSync).not.toHaveBeenCalled();
  expect(f.io.closeSync).toHaveBeenCalled();
});

test.each(['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'])('rejects post-read %s change', (key) => {
  const f = filesystem();
  f.io.fstatSync.mockReturnValueOnce(f.fileStat).mockReturnValue({ ...f.fileStat, [key]: 999 });
  expect(lib.read(CONTRACT, f.io).outcome).toBe('metadata_rejected');
});

test('rejects final pathname and ancestor replacement after the read', () => {
  for (const target of [lib.target, `/evidence/${d.FIXED.sourceSha}/app`]) {
    const f = filesystem(), original = f.io.lstatSync.getMockImplementation(); let calls = 0;
    f.io.lstatSync.mockImplementation((name) => {
      const stat = original(name);
      if (name === target && ++calls > 1) return { ...stat, ino: 999 };
      return stat;
    });
    expect(lib.read(CONTRACT, f.io).outcome).toBe('metadata_rejected');
  }
});

test('rejects growth, truncation, missing NOFOLLOW and read errors without leaking raw text', () => {
  for (const delta of [-1, 1]) {
    const f = filesystem(); f.fileStat.size += delta;
    expect(lib.read(CONTRACT, f.io).outcome).toBe('metadata_rejected');
  }
  const f = filesystem(); f.io.constants.O_NOFOLLOW = 0;
  expect(lib.read(CONTRACT, f.io).outcome).toBe('metadata_rejected');
  expect(f.io.openSync).not.toHaveBeenCalled();
  const bad = filesystem(); bad.io.readSync.mockImplementation(() => { throw new Error(PRIVATE); });
  expect(JSON.stringify(lib.read(CONTRACT, bad.io))).not.toContain(PRIVATE);
  expect(bad.io.closeSync).toHaveBeenCalled();
});

test('a descriptor close failure cannot return classified metadata', () => {
  const f = filesystem(); f.io.closeSync.mockImplementation(() => { throw new Error(PRIVATE); });
  expect(lib.read(CONTRACT, f.io)).toMatchObject({ outcome: 'metadata_rejected', errorCode: 'missing' });
});

test.each([['ENOENT', 'metadata_absent'], ['EACCES', 'metadata_unreadable'], ['EPERM', 'metadata_unreadable'], ['ELOOP', 'metadata_rejected']])(
  'handles %s without fallback reads', (code, outcome) => {
    const f = filesystem(); f.io.lstatSync.mockImplementation(() => { throw Object.assign(new Error(PRIVATE), { code }); });
    const report = lib.read(CONTRACT, f.io);
    expect(report.outcome).toBe(outcome); expect(JSON.stringify(report)).not.toContain(PRIVATE);
    expect(f.io.openSync).not.toHaveBeenCalled(); expect(f.io.lstatSync).toHaveBeenCalledTimes(1);
  });

test.each(['target', ...Object.keys(d.FIXED)])('wrong reader contract %s cannot cause filesystem access', (key) => {
  const f = filesystem();
  expect(lib.read({ ...CONTRACT, [key]: PRIVATE }, f.io).outcome).toBe('provenance_mismatch');
  expect(f.io.lstatSync).not.toHaveBeenCalled(); expect(f.io.openSync).not.toHaveBeenCalled();
});

test.each([
  { debug: PRIVATE }, { approval: PRIVATE }, { sourceSha: PRIVATE }, { failedBuildApproval: PRIVATE }, { qualificationBinding: PRIVATE },
  { imageId: PRIVATE }, { daemonId: PRIVATE }, { errorCode: PRIVATE }, { codeExitStatus: 256 }, { codeSignal: 'SIGINT' },
  { errorExitCode: '1' }, { tool: PRIVATE }, { operation: PRIVATE }, { errorName: PRIVATE }, { cliVersionMatches: 'true' },
  { outcome: 'container_failure' }, { errorCode: 'ENOENT', codeExitStatus: 1 }, { codeSignal: 'SIGKILL', codeExitStatus: 1 },
  { operation: 'spawn', operationTool: 'missing' }, { outcome: 'metadata_absent' }, { cliVersionMatches: false },
  { outcome: 'unrecognized_error' },
])('host rejects malformed/extra/contradictory report fields %#', (changes) => {
  const report = { ...lib.classify(metadata(), CONTRACT), ...changes };
  expect(() => d.validateReport(Buffer.from(JSON.stringify(report)), APPROVAL)).toThrow();
});

test('host rejects duplicated, invalid UTF-8, truncated and over-cap reports', () => {
  const text = JSON.stringify(lib.classify(metadata(), CONTRACT));
  for (const bytes of [Buffer.from(text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
    Buffer.concat([Buffer.from(text), Buffer.from([255])]), Buffer.from(text.slice(0, -1)), Buffer.alloc(4097)]) {
    expect(() => d.validateReport(bytes, APPROVAL)).toThrow();
  }
});

test('host rejects invented metadata matches and a reported error without diagnostic categories', () => {
  for (const report of [
    { ...lib.base(CONTRACT, 'metadata_absent'), cliVersionMatches: true },
    { ...lib.base(CONTRACT, 'metadata_unreadable'), targetMatches: true },
    { ...lib.base(CONTRACT), targetMatches: true },
    { ...lib.base(CONTRACT, 'reported_error'), cliVersionMatches: true, targetMatches: true },
  ]) expect(() => d.validateReport(Buffer.from(JSON.stringify(report)), APPROVAL)).toThrow();
});

test('preparation binds exact public receipts/code and keeps implementation revision separate', async () => {
  evidence();
  const result = await d.prepare(d.template(), { root: folder, revision: 'b'.repeat(40) });
  expect(result).toMatchObject({ authorized: false, retainedOutputReads: 0, dockerOperations: 0,
    contract: { sourceSha: d.FIXED.sourceSha, implementationBase: 'b'.repeat(40), evidence: d.RECEIPTS } });
  expect(result.approval).toBe(d.hash(JSON.stringify(result.contract)));
  expect(Object.keys(result.contract.integrity)).toEqual(d.EXECUTION_FILES);
  expect(q.supervise).not.toHaveBeenCalled();
});

test.each(['setup.receipt', 'build.receipt', 'build.reservation'])('changed %s bytes invalidate provenance', async (name) => {
  evidence(); fs.appendFileSync(path.join(folder, `${d.FIXED.sourceSha}.${name}.json`), ' ');
  await expect(d.prepare(d.template(), { root: folder, revision: 'b'.repeat(40) })).rejects.toThrow('provenance');
});

test.each(['sourceSha', 'approval', 'imageId', 'daemonId', 'binding', 'consumed'])('forged evidence %s fails exact hashes', (key) => {
  evidence();
  const location = path.join(folder, `${d.FIXED.sourceSha}.build.reservation.json`);
  const value = JSON.parse(fs.readFileSync(location)); value[key] = PRIVATE;
  fs.writeFileSync(location, JSON.stringify(value));
  expect(() => d.verifyEvidence(folder)).toThrow('provenance');
});

test.each(d.EXECUTION_FILES)('execution bytes bind %s into approval', async (name) => {
  evidence();
  const options = { root: folder, revision: 'b'.repeat(40) };
  const initial = await d.prepare(d.template(), options);
  const read = (location, cap) => location.endsWith(name) ? Buffer.concat([q.publicFile(location, cap), Buffer.from('\n')]) : q.publicFile(location, cap);
  if (name === 'gate1-build-qualification.js') await expect(d.prepare(d.template(), { ...options, read })).rejects.toThrow('provenance');
  else expect((await d.prepare(d.template(), { ...options, read })).approval).not.toBe(initial.approval);
});

test.each([{ path: lib.target }, { runId: PRIVATE }, { sourceSha: PRIVATE }, { attestations: {} }, { schemaVersion: 2 }])(
  'profile rejects arbitrary selectors and missing assertions %#', (changes) => {
    expect(() => d.profile({ ...d.template(), ...changes })).toThrow('input');
  });

test('template and invalid/default modes cannot access Docker or retained output', async () => {
  expect(await d.main([])).toEqual(d.template());
  await expect(d.main(['--inside-read'])).rejects.toThrow('input');
  expect(q.supervise).not.toHaveBeenCalled();
});

test.each(['fileBytes', 'jsonDepth', 'jsonNodes', 'stderrBytes'])('module load rejects declared %s drift before host commands', (key) => {
  expect(() => loadDiagnostic({ [key]: d.LIMITS[key] + 1 })).toThrow('provenance');
  expect(q.supervise).not.toHaveBeenCalled();
});

test('module load rejects supervisor stderr enforcement drift', () => {
  const qualification = { ...q, LIMITS: { ...q.LIMITS, logBytes: q.LIMITS.logBytes + 1 } };
  expect(() => loadDiagnostic({}, qualification)).toThrow('provenance');
  expect(q.supervise).not.toHaveBeenCalled();
});

test('container timeout follows the declared Linux seconds', () => {
  const changed = loadDiagnostic({ linuxSeconds: 7 });
  const args = changed.containerArgs();
  expect(args.slice(args.indexOf('--signal=KILL'), args.indexOf('--signal=KILL') + 2)).toEqual(['--signal=KILL', '7s']);
  expect(q.supervise).not.toHaveBeenCalled();
});

test('isolated Docker arguments fix every resource, mount, runtime and network control', () => {
  const args = d.containerArgs();
  expect(args).toEqual(['create', '--name', d.CONTAINER, '--pull=never', '--platform=linux/amd64', '--network=none', '--read-only',
    '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--restart=no', '--log-driver=none',
    '--cpus=1', '--memory=134217728', '--memory-swap=134217728', '--pids-limit=32', '--ulimit=core=0:0',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=8388608,mode=1777', '--mount',
    `type=volume,src=${q.VOLUME},dst=/evidence,readonly,volume-nocopy`, '--entrypoint', '/usr/bin/timeout', '-i',
    d.FIXED.imageId, '--signal=KILL', '20s', '/usr/bin/env', '-i', '/opt/node-v22.23.3-linux-x64/bin/node', '-']);
  expect(args).not.toContain('--env'); expect(args.join(' ')).not.toContain('type=bind');
  expect(d.readerInput(CONTRACT).length).toBeLessThanOrEqual(65536);
});

test('successful diagnostic persists sanitized evidence and consumes only its own namespace', async () => {
  const f = await fixture(), old = Object.fromEntries(Object.keys(d.RECEIPTS).map((name) =>
    [name, d.hash(fs.readFileSync(path.join(folder, `${d.FIXED.sourceSha}.${name}.json`)))]));
  const result = await d.execute(f.envelope, f.deps);
  expect(result).toMatchObject({ result: 'completed', outcome: 'reported_error', report: f.report, teardownUnconfirmed: false });
  consumed(); expect(fs.existsSync(path.join(folder, 'active.lock'))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(folder, `${d.KEY}.report.json`)))).toEqual(result);
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  for (const [name, digest] of Object.entries(old)) expect(d.hash(fs.readFileSync(path.join(folder, `${d.FIXED.sourceSha}.${name}.json`)))).toBe(digest);
  const start = f.docker.mock.calls.find(([args]) => args[2] === 'start');
  expect(start[1].input.toString()).not.toContain(PRIVATE); expect(start[1].outputBytes).toBe(4096);
  f.docker.mockClear(); await expect(d.execute(f.envelope, f.deps)).rejects.toThrow('reservation');
  expect(f.docker).not.toHaveBeenCalled();
});

test.each(['metadata_absent', 'metadata_unreadable', 'metadata_rejected', 'provenance_mismatch', 'no_error_record', 'unrecognized_error'])(
  '%s consumes the attempt without fallback or retry', async (outcome) => {
    const f = await fixture({ start: () => Buffer.from(JSON.stringify({ ...lib.base({ approval: f.prepared.approval }, outcome),
      cliVersionMatches: ['no_error_record', 'unrecognized_error'].includes(outcome), targetMatches: ['no_error_record', 'unrecognized_error'].includes(outcome) })) });
    expect((await d.execute(f.envelope, f.deps)).outcome).toBe(outcome); consumed();
    expect(f.docker.mock.calls.filter(([args]) => args[2] === 'start')).toHaveLength(1);
  });

test.each(['authorization', 'digest', 'attestation', 'extra'])('rejects missing %s before creating any files or Docker command', async (kind) => {
  const f = await fixture();
  if (kind === 'authorization') f.envelope.authorized = false;
  if (kind === 'digest') f.envelope.approval = 'e'.repeat(64);
  if (kind === 'attestation') f.envelope.profile.attestations[d.ATTESTATIONS[0]] = false;
  if (kind === 'extra') f.envelope.runId = PRIVATE;
  await expect(d.execute(f.envelope, f.deps)).rejects.toThrow('approval');
  expect(f.docker).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(folder, 'active.lock'))).toBe(false);
});

test('a foreign active lock is preserved without consumption or Docker access', async () => {
  const f = await fixture(), location = path.join(folder, 'active.lock'); fs.writeFileSync(location, PRIVATE);
  await expect(d.execute(f.envelope, f.deps)).rejects.toThrow();
  expect(fs.readFileSync(location, 'utf8')).toBe(PRIVATE); expect(f.docker).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(folder, `${d.KEY}.reservation.json`))).toBe(false);
});

test.each([`volume=${q.VOLUME}`, `name=^/${q.CONTAINER}$`, `name=^/${d.CONTAINER}$`])('occupied %s is never removed', async (filter) => {
  const f = await fixture({ ps: (args) => Buffer.from(args.includes(filter) ? CID : '') });
  expect((await d.execute(f.envelope, f.deps)).result).toBe('stopped'); consumed();
  expect(f.docker.mock.calls.some(([args]) => ['create', 'kill', 'rm', 'start'].includes(args[2]))).toBe(false);
});

test.each(['info', 'image', 'volume'])('wrong %s provenance stops before container creation', async (command) => {
  const f = await fixture({ [command]: () => Buffer.from('{}') });
  expect((await d.execute(f.envelope, f.deps)).result).toBe('stopped'); consumed();
  expect(f.docker.mock.calls.some(([args]) => args[2] === 'create')).toBe(false);
});

test.each(['throw', 'malformed'])('uncertain create %s keeps the lock and never removes by name', async (kind) => {
  const f = await fixture({ create: () => { if (kind === 'throw') throw new Error(PRIVATE); return Buffer.from(PRIVATE); } });
  const report = await d.execute(f.envelope, f.deps);
  expect(report).toMatchObject({ result: 'stopped', teardownUnconfirmed: true, report: null }); consumed();
  expect(fs.existsSync(path.join(folder, 'active.lock'))).toBe(true);
  expect(f.docker.mock.calls.some(([args]) => ['rm', 'kill'].includes(args[2]))).toBe(false);
  expect(JSON.stringify(report)).not.toContain(PRIVATE);
});

test.each(['inspect', 'rm', 'verification'])('uncertain teardown %s preserves the mutex', async (command) => {
  const overrides = command === 'verification' ? { ps: (args) => Buffer.from(args.includes(`id=${CID}`) ? CID : '') }
    : { [command]: () => { throw new Error(PRIVATE); } };
  const f = await fixture(overrides), report = await d.execute(f.envelope, f.deps);
  expect(report).toMatchObject({ result: 'stopped', teardownUnconfirmed: true, report: null }); consumed();
  expect(fs.existsSync(path.join(folder, 'active.lock'))).toBe(true); expect(JSON.stringify(report)).not.toContain(PRIVATE);
});

test.each([{ ExitCode: 1 }, { OOMKilled: true }, { Error: PRIVATE }])('non-passing container state discards the otherwise valid report %#', async (changes) => {
  const f = await fixture({ inspect: () => Buffer.from(JSON.stringify({ Running: false, ExitCode: 0, OOMKilled: false, Error: '', ...changes })) });
  const report = await d.execute(f.envelope, f.deps);
  expect(report).toMatchObject({ result: 'stopped', outcome: 'container_failure', report: null });
  expect(JSON.stringify(report)).not.toContain(PRIVATE); consumed();
  expect(fs.existsSync(path.join(folder, 'active.lock'))).toBe(false);
});

test('running child is killed only by its created ID and cannot pass', async () => {
  let count = 0;
  const f = await fixture({ inspect: () => Buffer.from(JSON.stringify({ Running: ++count === 1, ExitCode: 0, OOMKilled: false, Error: '' })) });
  expect((await d.execute(f.envelope, f.deps)).result).toBe('stopped');
  expect(f.docker).toHaveBeenCalledWith(['--context', 'desktop-linux', 'kill', CID], expect.any(Object));
  expect(f.docker).toHaveBeenCalledWith(['--context', 'desktop-linux', 'rm', CID], expect.any(Object));
});

test.each(['reservation', 'report'])('%s persistence failure stops with durable evidence retained', async (name) => {
  const f = await fixture();
  f.deps.writeOnce = (location, value) => { d.writeOnce(location, value); if (location.endsWith(`${d.KEY}.${name}.json`)) throw new Error(PRIVATE); };
  const report = await d.execute(f.envelope, f.deps);
  expect(report.result).toBe('stopped'); consumed(); expect(JSON.stringify(report)).not.toContain(PRIVATE);
  if (name === 'report') { expect(report.persistenceFailure).toBe(true); expect(fs.existsSync(path.join(folder, 'active.lock'))).toBe(true); }
});

test('lock identity replacement is not removed', async () => {
  const f = await fixture();
  f.deps.writeOnce = (location, value) => {
    d.writeOnce(location, value);
    if (location.endsWith(`${d.KEY}.report.json`)) {
      fs.renameSync(path.join(folder, 'active.lock'), path.join(folder, 'old.lock'));
      fs.writeFileSync(path.join(folder, 'active.lock'), PRIVATE);
    }
  };
  expect((await d.execute(f.envelope, f.deps)).persistenceFailure).toBe(true);
  expect(fs.readFileSync(path.join(folder, 'active.lock'), 'utf8')).toBe(PRIVATE);
});

test('monotonic operation budget shrinks across commands and teardown receives a separate budget', async () => {
  let time = 0; const child = jest.fn(async () => Buffer.alloc(0));
  const run = d.budgetRunner(child, 60000, () => time);
  await run(['info']); time = 59999; await run(['ps']); time = 60001;
  await expect(run(['create'])).rejects.toThrow('deadline');
  expect(child.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([60000, 1]);
  const cleanup = d.budgetRunner(child, 20000, () => time); await cleanup(['rm', CID]);
  expect(child.mock.calls[2][1].timeoutMs).toBe(20000);
});

test.each(['nonzero', 'timeout', 'stdout', 'stderr', 'malformed'])('real synthetic child %s cannot leak or promote output', async (kind) => {
  const f = await fixture({ start: (_args, options) => {
    const text = JSON.stringify(f.report);
    const script = kind === 'nonzero' ? `process.stdout.write(${JSON.stringify(text)});process.stderr.write(${JSON.stringify(PRIVATE)});process.exitCode=1;`
      : kind === 'timeout' ? `process.stdout.write(${JSON.stringify(text)});setInterval(()=>{},1000);`
        : kind === 'stdout' ? `process.stdout.write(${JSON.stringify(PRIVATE)}.repeat(1000));`
          : kind === 'stderr' ? `process.stdout.write(${JSON.stringify(text)});process.stderr.write('x'.repeat(8388609));`
            : `process.stdout.write(${JSON.stringify(PRIVATE)});`;
    return supervise(process.execPath, ['-e', script], { ...options, input: undefined, timeoutMs: kind === 'timeout' ? 150 : 5000 });
  } });
  const report = await d.execute(f.envelope, f.deps);
  expect(report).toMatchObject({ result: 'stopped', outcome: 'container_failure', report: null }); consumed();
  expect(JSON.stringify(report)).not.toContain(PRIVATE); expect(fs.existsSync(path.join(folder, 'active.lock'))).toBe(false);
});

test('serialized public Linux reader is standalone with built-ins only and no filesystem access for wrong target', async () => {
  // Deliberately invalid contract guarantees this child cannot read even a synthetic target.
  // Obtain production source outside Jest's Babel transform; transformed function.toString() can refer to Babel helpers.
  const modulePath = path.resolve(__dirname, '../../../scripts/gate1-vercel-build-diagnostic.js');
  const input = await supervise(process.execPath, ['-e',
    `process.stdout.write(require(${JSON.stringify(modulePath)}).readerInput(${JSON.stringify({ ...CONTRACT, target: '/forbidden' })}));`],
  { outputBytes: 65536 });
  const bytes = await supervise(process.execPath, ['-'], { input, outputBytes: 4096 });
  expect(d.validateReport(bytes, APPROVAL).outcome).toBe('provenance_mismatch');
});

/** Run the real launcher against a disposable supervisor with chosen stdout/exit status; no Docker or retained evidence is used. */
function launcherResult(mode, output, exitCode) {
  const location = path.join(folder, 'run-gate1-vercel-build-diagnostic.ps1');
  const profilePath = path.join(folder, 'profile-fixture.json');
  fs.copyFileSync(LAUNCHER, location); fs.writeFileSync(profilePath, '{}');
  fs.writeFileSync(path.join(folder, 'gate1-vercel-build-diagnostic.js'), `
    process.stdin.resume();
    if (${JSON.stringify(mode)} === '--execute' && process.argv[2] === '--prepare') {
      process.stdout.write(${JSON.stringify(JSON.stringify({ approval: APPROVAL, gate1Status: 'open' }))});
    } else {
      process.stdout.write(${JSON.stringify(output)});
      process.stderr.write(${JSON.stringify(PRIVATE)});
      process.exitCode = ${exitCode};
    }
  `);
  const args = mode === '--template' ? '-Template'
    : `-ProfilePath '${profilePath.replace(/'/g, "''")}'${mode === '--execute' ? ` -Execute -Approval '${APPROVAL}'` : ''}`;
  const script = `
    $ProgressPreference = 'SilentlyContinue'
    <# Supply only the synthetic fixture's confirmation so the real execution handoff is exercised. #>
    function Read-Host { return 'READ APPROVED VERCEL FAILURE METADATA ONCE' }
    & '${location.replace(/'/g, "''")}' ${args}
    exit $LASTEXITCODE`;
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
}

windowsTest('launcher preserves stopped supervisor JSON and exit code 1 during execution', () => {
  const json = '{ "result": "stopped", "teardownUnconfirmed": true, "persistenceFailure": true }\n';
  const result = launcherResult('--execute', json, 1);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
  expect(result.stdout).toBe(json + '\r\n'); expect(result.stderr).toBe('');
});

windowsTest.each(['--template', '--prepare', '--execute'])('launcher preserves successful %s output and exit code', (mode) => {
  const json = '{ "result": "completed", "gate1Status": "open" }\n';
  const result = launcherResult(mode, json, 0);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  expect(result.stdout).toBe(json + '\r\n'); expect(result.stderr).toBe('');
});

windowsTest.each([
  ['--execute', '', 0], ['--execute', '', 1],
  ['--execute', ' \r\n\t', 0], ['--execute', ' \r\n\t', 1],
  ['--execute', '{"result":"stopped",', 0], ['--execute', '{"result":"stopped",', 1],
  ['--template', '{"result":"stopped"}', 1], ['--prepare', '{"result":"stopped"}', 1],
  ['--execute', '{"result":"stopped"}', 2], ['--execute', '{"result":"completed"}', 1],
  ['--execute', '{}', 1], ['--execute', 'null', 1], ['--execute', '{"result":"Stopped"}', 1],
  ['--execute', '[]', 1], ['--execute', '[{"result":"stopped"}]', 1],
  ['--execute', '[{"result":"completed"},{"result":"stopped"}]', 1],
  ['--execute', '"stopped"', 1], ['--execute', '1', 1], ['--execute', 'true', 1],
])('launcher rejects invalid output or unexpected nonzero status %#', (mode, json, exitCode) => {
  const result = launcherResult(mode, json, exitCode);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Diagnostic stopped. Preserve evidence and reservations; no automatic retry.');
  expect(result.stderr).not.toContain(PRIVATE);
});

windowsTest('launcher preserves duplicate keys and numeric types in its original JSON handoff', async () => {
  const location = path.join(folder, 'profile-fixture.json');
  const original = '{"schemaVersion":1,"schemaVersion":1,"scope":"fixture","number":1.0}'; fs.writeFileSync(location, original);
  const script = `. '${LAUNCHER.replace(/'/g, "''")}'; $ProfilePath = '${location.replace(/'/g, "''")}';
    function Invoke-Gate1DiagnosticNode([string]$Mode,[string]$InputJson='') { return @{Json=$InputJson;ExitCode=0} }
    $result = Invoke-Gate1VercelDiagnostic; [Console]::Out.Write($result.Json)`;
  const bytes = await supervise('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeoutMs: 10000 });
  expect(bytes.toString()).toBe(original);
});

windowsTest('launcher requires exact digest and confirmation before any execution handoff', async () => {
  const location = path.join(folder, 'profile-fixture.json'); fs.writeFileSync(location, JSON.stringify(d.template()));
  const script = `. '${LAUNCHER.replace(/'/g, "''")}'; $ProfilePath='${location.replace(/'/g, "''")}'; $Execute=$true; $Approval='${APPROVAL}';
    function Invoke-Gate1DiagnosticNode([string]$Mode,[string]$InputJson='') {
      if($Mode -eq '--execute'){throw 'Execution forbidden'}
      return @{Json='{"approval":"${APPROVAL}","gate1Status":"open"}';ExitCode=0}
    }
    function Read-Host { return 'wrong' }
    try { Invoke-Gate1VercelDiagnostic; exit 2 } catch { if($_.Exception.Message -ne 'Not confirmed.'){exit 3}; exit 0 }`;
  await expect(supervise('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 10000 })).resolves.toEqual(Buffer.alloc(0));
});

windowsTest('launcher forwards original approved JSON and refuses a mismatched digest before prompting', async () => {
  const location = path.join(folder, 'profile-fixture.json');
  const original = '{"schemaVersion":1,"schemaVersion":1,"number":1.0}'; fs.writeFileSync(location, original);
  const script = `. '${LAUNCHER.replace(/'/g, "''")}'; $ProfilePath='${location.replace(/'/g, "''")}'; $Execute=$true; $Approval='${APPROVAL}';
    function Invoke-Gate1DiagnosticNode([string]$Mode,[string]$InputJson='') {
      if($Mode -eq '--execute'){return @{Json=$InputJson;ExitCode=0}}
      return @{Json='{"approval":"${APPROVAL}","gate1Status":"open"}';ExitCode=0}
    }
    function Read-Host { return 'READ APPROVED VERCEL FAILURE METADATA ONCE' }
    [Console]::Out.Write((Invoke-Gate1VercelDiagnostic).Json)
    $Approval='${'b'.repeat(64)}'; function Read-Host { throw 'Must not prompt' }
    try { Invoke-Gate1VercelDiagnostic; exit 2 } catch { if($_.Exception.Message -ne 'Approval mismatch.'){exit 3} }; exit 0`;
  const bytes = await supervise('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeoutMs: 10000 });
  expect(bytes.toString()).toBe(`{"profile":${original},"approval":"${APPROVAL}","authorized":true}`);
});

windowsTest('launcher rejects invalid UTF-8 profiles without echoing their contents', async () => {
  const location = path.join(folder, 'profile-fixture.json'); fs.writeFileSync(location, Buffer.concat([Buffer.from(PRIVATE), Buffer.from([255])]));
  const script = `. '${LAUNCHER.replace(/'/g, "''")}';
    try { $null=Read-Gate1DiagnosticProfile '${location.replace(/'/g, "''")}'; exit 2 } catch { [Console]::Out.Write('rejected') }`;
  const bytes = await supervise('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 10000 });
  expect(bytes.toString()).toBe('rejected');
});
