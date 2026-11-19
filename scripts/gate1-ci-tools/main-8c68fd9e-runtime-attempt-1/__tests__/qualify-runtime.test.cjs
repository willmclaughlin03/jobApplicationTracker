'use strict';
/* global describe, it, expect, jest, afterEach, __dirname, Buffer */

/** Mock controller stages and validate run-bound reports; no install, build, server or subprocess is invoked. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tool = require('../qualify-runtime.cjs');
const probe = require('../runtime-probe.cjs');
const base = require('../../main-8c68fd9e-static-attempt-1/qualify-static.cjs');
const inspector = require('../../main-8c68fd9e-static-attempt-1/inspect-compiled.cjs');
const profile = { packageDigest: 'a'.repeat(64) };

/** Bind a synthetic first run to an immutable workflow and package without approving execution. */
function context() {
  return { packageDigest: profile.packageDigest, executionDigest: tool.executionProfile(profile, 'b'.repeat(40), '1').executionDigest,
    workflowSha: 'b'.repeat(40), runId: '123', runNumber: '1', runAttempt: 1 };
}

/** Construct only allowlisted Actions identity inputs; never read or log the host environment. */
function environment() {
  const c = context(); return { GATE1_WORKFLOW_SHA: c.workflowSha, GATE1_RUN_NUMBER: '1', GATE1_PACKAGE_DIGEST: c.packageDigest, GATE1_EXECUTION_DIGEST: c.executionDigest,
    GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: base.REPO, GITHUB_WORKFLOW_SHA: c.workflowSha,
    GITHUB_RUN_NUMBER: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123', GITHUB_WORKFLOW_REF: `${base.REPO}/${tool.WORKFLOW}@refs/heads/main` };
}

/** Supply a complete sanitized runtime fixture independent of controller control flow. */
function runtime() {
  return { ...probe.emptyRuntime(), stage: 'complete', attempted: 6, serverStarted: true, isolationVerified: true, sourceUnchanged: true, compiledUnchanged: true,
    descriptorsRestored: true, serverClosed: true, nextClosed: true,
    inspection: { nodeMiddleware: true, matcherPreserved: true, sourceRoutesPresent: true, pageCount: 2, buildId: 'fresh_build',
      manifests: Object.fromEntries(inspector.NAMES.map(name => [name, 'c'.repeat(64)])), traceHash: 'd'.repeat(64), compiledFiles: 1, compiledBytes: 123,
      compiledClosureHash: 'e'.repeat(64), readerCandidates: 1 },
    cases: probe.CASES.map((name, index) => {
      const positive = index === 1 || index === 2, count = positive ? 1 : 0;
      return { case: name, status: index === 5 ? 308 : 200, bodyNonempty: index !== 5, observation: positive, challengeMatched: positive ? true : null,
        nodeVersion: positive ? 'v22.23.3' : null, nativeReadCounts: { version: count, nodeVersion: count, releaseName: count }, noCookies: true,
        privateNoStore: positive || index === 3 || index === 5 ? true : null, loginRedirect: index === 5 ? true : null };
    }) };
}

/** Model second-request intent: one verified case, with transport and cleanup for the last intent unconfirmed. */
function requestIntent() {
  const value = runtime();
  return { ...value, stage: 'requests', attempted: 2, cases: value.cases.slice(0, 1), sourceUnchanged: false, compiledUnchanged: false,
    descriptorsRestored: false, serverClosed: false, nextClosed: false };
}

/** Replace every effectful controller dependency with a bounded synthetic result. */
function operations() {
  return { node: '22.23.3', source: jest.fn().mockResolvedValue({ entries: [], routes: ['/login', '/admin'] }),
    run: jest.fn().mockResolvedValue(Buffer.from('10.9.9\n')), verify: jest.fn(), installed: () => ({ next: '16.3.3', react: '18.3.1', 'react-dom': '18.3.1', acorn: '8.15.0' }),
    prepareScratch: jest.fn(), isolate: jest.fn().mockResolvedValue({ runtime: runtime(), failure: null, accounting: 'known', serviceStopped: true }) };
}

/** Load the real entry point in a synthetic Linux workspace; mock effects and retain serialized evidence for post-run checks. */
function executionHarness(failure = null) {
  const staticRoot = path.resolve(__dirname, '../../main-8c68fd9e-static-attempt-1'), dependency = base.packageProfile(staticRoot);
  dependency.contract.files = Object.fromEntries(base.FILES.map(name => [name,
    base.sha(tool.profileBytes(name === 'gate1-static.yml' ? base.workflowPath(staticRoot) : path.join(staticRoot, name)))]));
  const saved = new Map(), opened = new Map(); let nextFd = 10;
  const io = { realpathSync: name => name, existsSync: name => saved.has(name), mkdirSync: jest.fn(),
    lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    openSync: jest.fn(name => {
      if (saved.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const fd = nextFd++; opened.set(fd, name); saved.set(name, Buffer.alloc(0)); return fd;
    }),
    writeFileSync: jest.fn((target, bytes, options = {}) => {
      const name = typeof target === 'number' ? opened.get(target) : target;
      if (typeof target !== 'number' && options.flag === 'wx' && saved.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      saved.set(name, Buffer.from(bytes));
    }),
    fsyncSync: jest.fn(), closeSync: jest.fn(fd => opened.delete(fd)),
    linkSync: jest.fn((source, destination) => {
      if (saved.has(destination)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      saved.set(destination, saved.get(source));
    }),
    unlinkSync: jest.fn(name => { if (!saved.delete(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }) };
  jest.spyOn(fs, 'writeFileSync').mockImplementation(io.writeFileSync);
  const mockedBase = { ...base, packageProfile: jest.fn().mockReturnValue(dependency), readBounded: jest.fn().mockReturnValue(Buffer.from('synthetic-file')),
    sourceProfile: jest.fn().mockResolvedValue({ entries: [], routes: ['/login', '/admin'] }), verifyFiles: jest.fn(),
    supervise: jest.fn(async command => Buffer.from(command === 'git' ? context().workflowSha : base.VERSIONS.npm)),
    installedVersions: () => ({ ...base.VERSIONS }), childEnvironment: () => ({}), writeOnce: jest.fn(base.writeOnce) };
  const isolated = failure ? { runtime: null, accounting: 'unknown', failure, serviceStopped: failure !== 'cleanup' }
    : { runtime: runtime(), accounting: 'known', failure: null, serviceStopped: true };
  const isolate = jest.fn().mockResolvedValue(isolated), modules = { 'node:fs': io, 'node:path': path.posix,
    '../main-8c68fd9e-static-attempt-1/qualify-static.cjs': mockedBase, './runtime-probe.cjs': probe,
    './isolate-runtime.cjs': { ...require('../isolate-runtime.cjs'), environment: () => ({}), runIsolated: isolate },
    './inspect-runtime.cjs': require('../inspect-runtime.cjs') };
  const sandbox = { module: { exports: {} }, require: name => modules[name],
    __dirname: `/workspace/tooling/scripts/gate1-ci-tools/${tool.NAME}`,
    process: { platform: 'linux', arch: 'x64', versions: { node: base.VERSIONS.node } } };
  const source = fs.readFileSync(path.join(__dirname, '../qualify-runtime.cjs'), 'utf8');
  vm.runInNewContext(source, sandbox);
  const entry = sandbox.module.exports, current = entry.packageProfile(), env = { ...environment(), GITHUB_WORKSPACE: '/workspace',
    GATE1_PACKAGE_DIGEST: current.packageDigest, GATE1_EXECUTION_DIGEST: entry.executionProfile(current, context().workflowSha, '1').executionDigest };
  mockedBase.packageProfile.mockClear();
  /** Exercise the real CLI handler in a fresh VM with synthetic env/output, preserving the same mocked filesystem. */
  async function runCli() {
    const cli = { ...sandbox, module: { exports: {} }, require: name => modules[name],
      process: { ...sandbox.process, env, argv: ['node', 'qualify-runtime.cjs', '--run'], exitCode: 0 } };
    cli.require.main = cli.module;
    await new Promise(resolve => {
      cli.process.stdout = { write: jest.fn(resolve) }; cli.process.stderr = { write: jest.fn(resolve) };
      vm.runInNewContext(source, cli);
    });
    return cli.process;
  }
  return { entry, env, expected: entry.validateContext(env, current), base: mockedBase, dependency, saved, opened, io, isolate, isolated, runCli };
}

/** Restore spies so package identity and report readers cannot leak mocks into other tests. */
afterEach(() => jest.restoreAllMocks());

describe('package and one-run identity', () => {
  it('binds all twelve approved files and the unchanged static dependency', () => {
    const actual = tool.packageProfile(); expect(Object.keys(actual.contract.files)).toEqual(tool.FILES); expect(tool.FILES).toHaveLength(12);
    expect(actual.contract.staticPackageDigest).toBe('caf0c83c17ed131cc080e7453e1fde961c62026462e95be25d6c639257c97784');
    expect(actual.contract.source).toBe(base.SOURCE); expect(actual.contract.lockSha256).toBe(base.LOCK);
    expect(actual.packageDigest).toBe(base.sha(JSON.stringify(actual.contract)));
  });
  it('changes package identity when any new file changes and rejects static dependency drift', () => {
    const before = tool.packageProfile(), read = base.readBounded;
    const spy = jest.spyOn(base, 'readBounded').mockImplementation((filename, cap) => {
      const bytes = read(filename, cap); return filename.endsWith('runtime-attempt-1' + path.sep + 'README.md') ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes;
    });
    expect(tool.packageProfile().packageDigest).not.toBe(before.packageDigest); spy.mockRestore();
    jest.spyOn(base, 'packageProfile').mockReturnValue({ contract: { different: true }, packageDigest: 'f'.repeat(64) });
    expect(() => tool.packageProfile()).toThrow('tool_identity');
  });
  it('accepts only the reviewed Linux x64 manual context', () => { expect(tool.validateContext(environment(), profile, 'linux', 'x64')).toEqual(context()); });
  it.each([{ GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_RUN_NUMBER: '2' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/staging' },
    { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_WORKFLOW_SHA: 'c'.repeat(40) }, { GATE1_PACKAGE_DIGEST: 'c'.repeat(64) },
    { GATE1_EXECUTION_DIGEST: 'c'.repeat(64) }, { GITHUB_RUN_ID: '../123' }, { GITHUB_WORKFLOW_REF: 'wrong' }])('rejects mismatched identity %#', change => {
    expect(() => tool.validateContext({ ...environment(), ...change }, profile, 'linux', 'x64')).toThrow('approval');
  });
  it.each([['win32', 'x64'], ['linux', 'arm64']])('rejects %s/%s execution', (platform, arch) => { expect(() => tool.validateContext(environment(), profile, platform, arch)).toThrow('approval'); });
  it('binds the selected run number and workflow into distinct execution digests', () => {
    expect(tool.executionProfile(profile, 'b'.repeat(40), '2').executionDigest).not.toBe(context().executionDigest);
    expect(() => tool.executionProfile(profile, 'not-sha', '1')).toThrow('approval');
  });
});

describe('bounded controller sequence', () => {
  it('installs/builds once, isolates only after verification and leaves both gates open', async () => {
    const ops = operations(), report = await tool.qualify('/app', '/scratch', context(), ops);
    expect(report).toMatchObject({ result: 'complete_runtime_only', stage: 'complete', failure: null, gate1: 'open', gate5A: 'unpassed', serviceStopped: true });
    expect(ops.run.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['npm', ['--version']], ['npm', ['ci', '--no-audit', '--no-fund', '--include=dev']], ['npm', ['run', 'build']],
    ]);
    expect(ops.run.mock.calls.map(call => call[2].timeoutMs)).toEqual([30000, 480000, 720000]);
    expect(ops.isolate).toHaveBeenCalledTimes(1); expect(ops.isolate.mock.calls[0][4]).toBe(360000); expect(ops.verify).toHaveBeenCalledTimes(3);
    expect(ops.run.mock.calls[1][2].env.NODE_ENV).toBeUndefined(); expect(ops.run.mock.calls[2][2].env.NODE_ENV).toBe('production');
  });
  it.each([['source', 'source_identity'], ['node', 'node_version'], ['npm', 'npm_version'], ['install', 'child_exit'], ['build', 'stream_limit']])('stops on %s failure without later stages', async (stage, code) => {
    const ops = operations();
    if (stage === 'source') ops.source.mockRejectedValue({ code });
    if (stage === 'node') ops.node = '24.1.0';
    if (stage === 'npm') ops.run.mockResolvedValue(Buffer.from('10.0.0'));
    if (stage === 'install') ops.run.mockResolvedValueOnce(Buffer.from('10.9.9')).mockRejectedValueOnce({ code });
    if (stage === 'build') ops.run.mockResolvedValueOnce(Buffer.from('10.9.9')).mockResolvedValueOnce(Buffer.alloc(0)).mockRejectedValueOnce({ code });
    expect(await tool.qualify('/app', '/scratch', context(), ops)).toMatchObject({ result: 'stopped', failure: code, accounting: 'unknown', runtime: null });
    expect(ops.isolate).not.toHaveBeenCalled();
  });
  it('applies the shared controller deadline to source Git and later runtime stages', async () => {
    const ops = operations(); let time = 0; ops.now = () => time;
    ops.source.mockImplementation(async (_app, _bytes, run) => { time = base.LIMITS.runMs - 100; await run('git', ['read'], { timeoutMs: 30000 }); return { entries: [], routes: [] }; });
    ops.run.mockImplementation(async () => { time += 10; return Buffer.from('10.9.9'); });
    await tool.qualify('/app', '/scratch', context(), ops);
    expect(ops.run.mock.calls[0][2].timeoutMs).toBe(100); expect(ops.isolate.mock.calls[0][4]).toBeLessThan(100);
  });
  it('stops when the controller deadline is consumed and never manufactures runtime accounting', async () => {
    const ops = operations(); let time = 0; ops.now = () => time;
    ops.source.mockImplementation(async () => { time = base.LIMITS.runMs; return { entries: [], routes: [] }; });
    expect(await tool.qualify('/app', '/scratch', context(), ops)).toMatchObject({ failure: 'deadline', runtime: null, accounting: 'unknown' });
    expect(ops.run).not.toHaveBeenCalled();
  });
  it('retains interrupted runtime progress and cleanup failure distinctly', async () => {
    const ops = operations(); const partial = { ...probe.emptyRuntime(), isolationVerified: true };
    ops.isolate.mockResolvedValue({ runtime: partial, failure: 'cleanup', accounting: 'known', serviceStopped: false });
    expect(await tool.qualify('/app', '/scratch', context(), ops)).toMatchObject({ failure: 'cleanup', childrenClosed: false, serviceStopped: false, runtime: partial });
  });
  it('reports pending-file cleanup separately from valid complete child evidence', async () => {
    const ops = operations(), complete = runtime();
    ops.isolate.mockResolvedValue({ runtime: complete, failure: 'cleanup', accounting: 'known', serviceStopped: true });
    expect(await tool.qualify('/app', '/scratch', context(), ops)).toMatchObject({ result: 'stopped', failure: 'cleanup',
      childrenClosed: false, serviceStopped: true, accounting: 'known', runtime: complete });
  });
  it.each(['cancelled', 'cleanup'])('retains last-attempt uncertainty in a stopped %s report', async failure => {
    const ops = operations(), partial = requestIntent();
    ops.isolate.mockResolvedValue({ runtime: partial, failure, accounting: 'last_attempt_uncertain', serviceStopped: failure !== 'cleanup' });
    expect(await tool.qualify('/app', '/scratch', context(), ops)).toMatchObject({ result: 'stopped', failure,
      accounting: 'last_attempt_uncertain', runtime: partial, childrenClosed: failure !== 'cleanup' });
  });
});

describe('post-run package identity', () => {
  it.each([
    [null, 'read-error', 'tool_identity'], ['cleanup', 'read-error', 'cleanup'], ['isolation', 'read-error', 'tool_identity'],
    [null, 'dependency-drift', 'tool_identity'], ['cleanup', 'dependency-drift', 'cleanup'],
  ])('persists stopped evidence after %s qualification and %s', async (failure, variant, expectedFailure) => {
    const h = executionHarness(failure);
    h.base.packageProfile.mockReturnValueOnce(h.dependency).mockImplementationOnce(() => {
      if (variant === 'read-error') throw Object.assign(new Error('synthetic profile read failure'), { code: 'ENOENT' });
      return { contract: { changed: true } };
    });
    const result = await h.entry.execute(h.env), bytes = h.saved.get('/workspace/gate1-runtime-evidence/report.json'), report = JSON.parse(bytes);
    expect(result).toEqual({ result: 'stopped', stage: 'verify', failure: expectedFailure, reportSha256: base.sha(bytes), cleanupFailure: null });
    expect(h.entry.validateReport(report, h.expected)).toEqual(report);
    expect(report).toMatchObject({ result: 'stopped', stage: 'verify', failure: expectedFailure,
      serviceStopped: failure !== 'cleanup', childrenClosed: failure !== 'cleanup' });
    expect(() => h.entry.validateReport({ ...report, result: 'complete_runtime_only', stage: 'complete' }, h.expected)).toThrow('report_schema');
    expect(h.base.packageProfile).toHaveBeenCalledTimes(2); expect(h.base.writeOnce).toHaveBeenCalledTimes(2);
    expect(bytes.toString('utf8')).not.toContain('synthetic profile read failure');
  });
  it('continues to persist stopped evidence for a changed digest', async () => {
    const h = executionHarness();
    h.isolate.mockImplementationOnce(async () => { h.base.readBounded.mockReturnValue(Buffer.from('changed-file')); return h.isolated; });
    expect(await h.entry.execute(h.env)).toMatchObject({ result: 'stopped', stage: 'verify', failure: 'tool_identity' });
    expect(JSON.parse(h.saved.get('/workspace/gate1-runtime-evidence/report.json'))).toMatchObject({ result: 'stopped', failure: 'tool_identity' });
  });
  it('persists successful evidence only when the post-run identity remains unchanged', async () => {
    const h = executionHarness();
    expect(await h.entry.execute(h.env)).toMatchObject({ result: 'complete_runtime_only', stage: 'complete', failure: null });
    expect(h.entry.validateReport(JSON.parse(h.saved.get('/workspace/gate1-runtime-evidence/report.json')), h.expected)).toMatchObject({ result: 'complete_runtime_only' });
  });
});

describe('atomic report publication', () => {
  const filename = '/workspace/gate1-runtime-evidence/report.json', pending = '/workspace/gate1-runtime-evidence/.pending-report.json';
  it.each([null, 'cleanup'])('publishes only complete bytes with their matching hash after %s qualification', async failure => {
    const h = executionHarness(failure), write = h.io.writeFileSync.getMockImplementation(), link = h.io.linkSync.getMockImplementation();
    h.io.writeFileSync.mockImplementation((target, bytes, options) => {
      const name = typeof target === 'number' ? h.opened.get(target) : target;
      if (name.endsWith('report.json')) {
        write(target, Buffer.from('{'), options); expect(h.saved.has(filename)).toBe(false);
        expect(h.saved.get(pending).toString()).toBe('{');
      }
      write(target, bytes, options);
    });
    h.io.linkSync.mockImplementation((source, destination) => {
      expect(h.opened.size).toBe(0); expect(h.io.fsyncSync).toHaveBeenCalledTimes(1);
      h.entry.validateReport(JSON.parse(h.saved.get(source)), h.expected); link(source, destination);
    });
    const result = await h.entry.execute(h.env);
    expect(result).toMatchObject({ result: failure ? 'stopped' : 'complete_runtime_only', failure, reportSha256: base.sha(h.saved.get(filename)), cleanupFailure: null });
    expect(h.io.openSync).toHaveBeenCalledWith(pending, 'wx', 0o600); expect(h.io.linkSync).toHaveBeenCalledWith(pending, filename);
    expect(h.saved.has(pending)).toBe(false); expect(h.opened.size).toBe(0);
  });
  it.each([null, 'cleanup', 'isolation'])('retains the committed digest and reports pending cleanup separately after %s', async failure => {
    const h = executionHarness(failure);
    h.io.unlinkSync.mockImplementation(() => { throw Object.assign(new Error('private path'), { code: 'EACCES' }); });
    const result = await h.entry.execute(h.env), bytes = h.saved.get(filename), report = JSON.parse(bytes);
    expect(result).toEqual({ result: report.result, stage: report.stage, failure, reportSha256: base.sha(bytes), cleanupFailure: 'cleanup' });
    expect(h.entry.validateReport(report, h.expected)).toEqual(report);
    expect(h.saved.get(pending)).toEqual(bytes); expect(h.opened.size).toBe(0);
    expect(h.io.linkSync).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain('private path');
  });
  it('still rejects a failed link when pending cleanup also fails', async () => {
    const h = executionHarness(), error = Object.assign(new Error('link'), { code: 'EIO' });
    h.io.linkSync.mockImplementation(() => { throw error; });
    h.io.unlinkSync.mockImplementation(() => { throw Object.assign(new Error('unlink'), { code: 'EACCES' }); });
    await expect(h.entry.execute(h.env)).rejects.toBe(error);
    expect(h.saved.has(filename)).toBe(false); expect(h.saved.has(pending)).toBe(true); expect(h.opened.size).toBe(0);
  });
  it.each([[null, false], [null, true], ['cleanup', false]])('reports CLI cleanup and exits unsuccessfully for %s or unlink=%s', async (failure, unlink) => {
    const h = executionHarness(failure);
    if (unlink) h.io.unlinkSync.mockImplementation(() => { throw Object.assign(new Error('unlink'), { code: 'EACCES' }); });
    const cli = await h.runCli();
    expect(cli.stdout.write).toHaveBeenCalledTimes(1); expect(cli.stderr.write).not.toHaveBeenCalled();
    expect(JSON.parse(cli.stdout.write.mock.calls[0][0])).toMatchObject({ failure, cleanupFailure: unlink ? 'cleanup' : null,
      reportSha256: base.sha(h.saved.get(filename)) });
    expect(cli.exitCode).toBe(failure || unlink ? 1 : 0);
  });
  it.each(['write', 'flush', 'close', 'link'])('removes the owned pending file after a %s failure without exposing a report', async stage => {
    const h = executionHarness(), error = Object.assign(new Error('disk'), { code: 'EIO' }), write = h.io.writeFileSync.getMockImplementation();
    if (stage === 'write') h.io.writeFileSync.mockImplementation((target, bytes, options) => {
      const name = typeof target === 'number' ? h.opened.get(target) : target;
      if (name.endsWith('report.json')) { write(target, Buffer.from('{'), options); throw error; }
      write(target, bytes, options);
    });
    if (stage === 'flush') h.io.fsyncSync.mockImplementation(() => { throw error; });
    if (stage === 'close') h.io.closeSync.mockImplementationOnce(() => { throw error; });
    if (stage === 'link') h.io.linkSync.mockImplementation(() => { throw error; });
    await expect(h.entry.execute(h.env)).rejects.toBe(error);
    expect(h.saved.has(filename)).toBe(false); expect(h.saved.has(pending)).toBe(false); expect(h.opened.size).toBe(0);
    expect(h.io.unlinkSync).toHaveBeenCalledWith(pending);
  });
  it('reaches exclusive publication failure and preserves existing report bytes', async () => {
    const h = executionHarness(), original = Buffer.from('original report');
    h.isolate.mockImplementationOnce(async () => { h.saved.set(filename, original); return h.isolated; });
    await expect(h.entry.execute(h.env)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(h.io.linkSync).toHaveBeenCalledTimes(1); expect(h.io.linkSync).toHaveBeenCalledWith(pending, filename);
    expect(h.saved.get(filename)).toEqual(original); expect(h.saved.has(pending)).toBe(false); expect(h.opened.size).toBe(0);
  });
  it('does not remove or reuse a pending file owned by another attempt', async () => {
    const h = executionHarness(), original = Buffer.from('existing pending bytes');
    h.isolate.mockImplementationOnce(async () => { h.saved.set(pending, original); return h.isolated; });
    await expect(h.entry.execute(h.env)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(h.saved.get(pending)).toEqual(original); expect(h.saved.has(filename)).toBe(false);
    expect(h.io.unlinkSync).not.toHaveBeenCalled(); expect(h.io.linkSync).not.toHaveBeenCalled();
  });
});

describe('strict retained evidence', () => {
  it('rejects extra fields, identity drift, invented cleanup, wrong count and reordered cases', async () => {
    const good = await tool.qualify('/app', '/scratch', context(), operations());
    const changes = [r => { r.extra = 'private'; }, r => { r.source = 'f'.repeat(40); }, r => { r.serviceStopped = null; }, r => { r.childrenClosed = false; },
      r => { r.runtime.attempted = 5; }, r => { r.runtime.cases.reverse(); }, r => { r.runtime.cases[1].challenge = 'private'; }, r => { r.accounting = 'unknown'; },
      r => { r.accounting = 'last_attempt_uncertain'; }];
    for (const change of changes) { const value = JSON.parse(JSON.stringify(good)); change(value); expect(() => tool.validateReport(value, context())).toThrow('report_schema'); }
  });
  it('rejects a mismatch between missing evidence and known accounting', () => {
    expect(() => tool.validateReport({ ...tool.initialReport(context()), failure: 'isolation', accounting: 'known' }, context())).toThrow('report_schema');
  });
  it.each([1, 2, 6])('requires uncertainty for a stopped request-intent snapshot with %i attempts', attempted => {
    const partial = { ...requestIntent(), attempted, cases: runtime().cases.slice(0, attempted - 1) };
    const report = { ...tool.initialReport(context()), stage: 'runtime', failure: 'cancelled', runtime: partial, accounting: 'known', serviceStopped: true };
    expect(() => tool.validateReport(report, context())).toThrow('report_schema');
    report.accounting = 'last_attempt_uncertain'; expect(tool.validateReport(report, context())).toBe(report);
  });
  it.each(['zero', 'terminal-request', 'terminal-complete'])('preserves known accounting for %s evidence', variant => {
    const partial = variant === 'terminal-complete' ? runtime() : { ...requestIntent(), attempted: 0, cases: [] };
    if (variant === 'terminal-request') Object.assign(partial, { attempted: 1, failure: 'http', descriptorsRestored: true, serverClosed: true, nextClosed: true });
    const report = { ...tool.initialReport(context()), stage: 'runtime', failure: 'cancelled', runtime: partial, accounting: 'known', serviceStopped: true };
    if (partial.failure) report.failure = partial.failure;
    expect(tool.validateReport(report, context())).toBe(report);
  });
  it.each(['missing', 'no-intent', 'terminal-stage', 'terminal-failure'])('rejects uncertain accounting with %s evidence', variant => {
    const partial = requestIntent(), report = { ...tool.initialReport(context()), stage: 'runtime', failure: 'cancelled',
      runtime: partial, accounting: 'last_attempt_uncertain', serviceStopped: true };
    if (variant === 'missing') report.runtime = null;
    if (variant === 'no-intent') partial.attempted = partial.cases.length;
    if (variant === 'terminal-stage') partial.stage = 'cleanup';
    if (variant === 'terminal-failure') { partial.failure = 'cleanup'; report.failure = 'cleanup'; report.childrenClosed = false; }
    expect(() => tool.validateReport(report, context())).toThrow('report_schema');
  });
  it('verifies canonical bytes and an independently supplied digest without retaining raw content', async () => {
    const report = await tool.qualify('/app', '/scratch', context(), operations()), bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
    const read = jest.spyOn(base, 'readBounded').mockReturnValue(bytes);
    expect(tool.verifyReport('/synthetic/report.json', base.sha(bytes), context())).toEqual(report);
    expect(read).toHaveBeenCalledTimes(1); read.mockClear();
    expect(() => tool.verifyReport('/synthetic/report.json', 'f'.repeat(64), context())).toThrow('report_digest');
    expect(read).toHaveBeenCalledTimes(1); read.mockClear();
    expect(() => tool.verifyReport('/synthetic/report.json', 'not-a-digest', context())).toThrow('report_digest');
    expect(read).not.toHaveBeenCalled();
  });
  it('returns the authenticated stopped report even if a later read would claim success', async () => {
    const success = await tool.qualify('/app', '/scratch', context(), operations());
    const stopped = { ...success, stage: 'verify', result: 'stopped', failure: 'tool_identity' }, bytes = Buffer.from(JSON.stringify(stopped, null, 2) + '\n');
    const read = jest.spyOn(base, 'readBounded').mockReturnValueOnce(bytes).mockReturnValue(Buffer.from(JSON.stringify(success, null, 2) + '\n'));
    expect(tool.verifyReport('/synthetic/report.json', base.sha(bytes), context())).toEqual(stopped);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each(['malformed', 'duplicate-key', 'noncanonical', 'schema', 'identity'])('rejects authenticated %s bytes even if a later read would be valid', async variant => {
    const report = await tool.qualify('/app', '/scratch', context(), operations()), canonical = JSON.stringify(report, null, 2) + '\n';
    let text = canonical;
    if (variant === 'malformed') text = '{';
    if (variant === 'duplicate-key') text = canonical.replace('{', '{\n  "schemaVersion": 1,');
    if (variant === 'noncanonical') text = JSON.stringify(report) + '\n';
    if (variant === 'schema') text = JSON.stringify({ ...report, extra: true }, null, 2) + '\n';
    if (variant === 'identity') text = JSON.stringify({ ...report, runId: '124' }, null, 2) + '\n';
    const bytes = Buffer.from(text), read = jest.spyOn(base, 'readBounded').mockReturnValueOnce(bytes).mockReturnValue(Buffer.from(canonical));
    expect(() => tool.verifyReport('/synthetic/report.json', base.sha(bytes), context())).toThrow('report_schema');
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('exposes read-only preparation without invoking install, build or runtime', async () => {
    const source = jest.spyOn(base, 'sourceProfile').mockResolvedValue({ selectedFileCount: 362, selectedManifestSha256: 'c'.repeat(64) });
    const result = await tool.main(['--prepare', '/pinned-app']);
    expect(result.checkoutBytesQualified).toBe(false); expect(source).toHaveBeenCalledWith(path.resolve('/pinned-app'), false);
    expect(result).not.toHaveProperty('executionDigest');
  });
  it('documents all approved files with no production entrypoint in the Jest configuration', () => {
    const config = require('../jest.config.cjs'); expect(config.testMatch).toEqual(['**/__tests__/*.test.cjs']);
    expect(fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8')).toContain('Gate 1 remains OPEN');
  });
});
