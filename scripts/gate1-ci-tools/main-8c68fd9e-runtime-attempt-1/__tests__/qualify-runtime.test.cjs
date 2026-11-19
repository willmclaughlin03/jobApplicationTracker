'use strict';
/* global describe, it, expect, jest, afterEach, __dirname, Buffer */

/** Mock controller stages and validate run-bound reports; no install, build, server or subprocess is invoked. */
const fs = require('node:fs');
const path = require('node:path');
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

/** Replace every effectful controller dependency with a bounded synthetic result. */
function operations() {
  return { node: '22.23.3', source: jest.fn().mockResolvedValue({ entries: [], routes: ['/login', '/admin'] }),
    run: jest.fn().mockResolvedValue(Buffer.from('10.9.9\n')), verify: jest.fn(), installed: () => ({ next: '16.3.3', react: '18.3.1', 'react-dom': '18.3.1', acorn: '8.15.0' }),
    prepareScratch: jest.fn(), isolate: jest.fn().mockResolvedValue({ runtime: runtime(), failure: null, accounting: 'known', serviceStopped: true }) };
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
});

describe('strict retained evidence', () => {
  it('rejects extra fields, identity drift, invented cleanup, wrong count and reordered cases', async () => {
    const good = await tool.qualify('/app', '/scratch', context(), operations());
    const changes = [r => { r.extra = 'private'; }, r => { r.source = 'f'.repeat(40); }, r => { r.serviceStopped = null; }, r => { r.childrenClosed = false; },
      r => { r.runtime.attempted = 5; }, r => { r.runtime.cases.reverse(); }, r => { r.runtime.cases[1].challenge = 'private'; }, r => { r.accounting = 'unknown'; }];
    for (const change of changes) { const value = JSON.parse(JSON.stringify(good)); change(value); expect(() => tool.validateReport(value, context())).toThrow('report_schema'); }
  });
  it('rejects a mismatch between missing evidence and known accounting', () => {
    expect(() => tool.validateReport({ ...tool.initialReport(context()), failure: 'isolation', accounting: 'known' }, context())).toThrow('report_schema');
  });
  it('verifies canonical bytes and an independently supplied digest without retaining raw content', async () => {
    const report = await tool.qualify('/app', '/scratch', context(), operations()), bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
    jest.spyOn(base, 'readBounded').mockReturnValue(bytes);
    expect(tool.verifyReport('/synthetic/report.json', base.sha(bytes), context())).toEqual(report);
    expect(() => tool.verifyReport('/synthetic/report.json', 'f'.repeat(64), context())).toThrow('report_digest');
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
