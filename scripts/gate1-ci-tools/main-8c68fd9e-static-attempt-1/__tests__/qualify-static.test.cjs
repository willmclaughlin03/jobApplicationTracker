'use strict';
/* global describe, it, expect, afterEach, jest, __dirname, Buffer */

/** Mock all process execution; real filesystem access is restricted to synthetic repo-local fixtures. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const tool = require('../qualify-static.cjs');
const inspect = require('../inspect-compiled.cjs');
const fixtureBase = path.resolve(__dirname, '../../../../.tmp/gate1-ci-tests');
const fixtures = [];
const hash = 'a'.repeat(64), workflowSha = 'b'.repeat(40);

/** Create a minimal approval context independent of CI environment variables. */
function context() { return { packageDigest: hash, executionDigest: 'c'.repeat(64), workflowSha, runId: '123456789', runNumber: '7', runAttempt: 1 }; }

/** Provide an independently shaped allowlisted static inspection result. */
function inspection() { return { nodeMiddleware: true, matcherPreserved: true, sourceRoutesPresent: true, pageCount: 35, buildId: 'synthetic', manifests: Object.fromEntries(inspect.NAMES.map(name => [name, hash])), traceHash: hash,
  compiledFiles: 1, compiledBytes: 100, compiledClosureHash: hash, readerCandidates: 1 }; }

/** Model the finite sequence with no Git, npm, build or application requests. */
function operations() {
  return { node: '22.23.3', source: jest.fn().mockResolvedValue({ entries: [], routes: ['/login'] }), verify: jest.fn(), installed: () => ({ ...tool.VERSIONS }),
    run: jest.fn().mockImplementation(async (_command, args) => args[0] === '--version' ? Buffer.from('10.9.9\n') : args.includes('--inspect') ? Buffer.from(JSON.stringify({ result: inspection() })) : Buffer.alloc(0)) };
}

/** Produce a genuine successful report from the mocked sequence for schema mutation tests. */
async function report() { return tool.qualify('/synthetic/app', '/synthetic/scratch', context(), operations()); }

/** Reserve a fixture directory under the approved local test scratch boundary. */
function fixture() { fs.mkdirSync(fixtureBase, { recursive: true }); const dir = fs.mkdtempSync(path.join(fixtureBase, 'static-runner-')); fixtures.push(dir); return dir; }

/** Model only process event/stream APIs used by the supervisor. */
function child() { const value = new EventEmitter(); value.stdout = new EventEmitter(); value.stderr = new EventEmitter(); value.stdin = new EventEmitter(); value.stdin.end = jest.fn(); value.kill = jest.fn(); value.pid = 987654; return value; }

/** Model Git's immutable outputs while reading only the selected nonsecret lockfile fixture. */
function gitFixture(overrides = {}) {
  const repo = path.resolve(__dirname, '../../../..');
  const selected = path.join(repo, '.tmp/worktrees/gate1-main-8c68fd9e-compiled/package-lock.json');
  const source = fs.existsSync(selected) ? selected : path.join(repo, 'package-lock.json');
  const lock = fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
  const raw = Array.from({ length: 362 }, (_item, index) => `100644 blob ${'d'.repeat(40)}\tsrc/fixture-${index}.js\0`).join('');
  return jest.fn(async (_command, args) => {
    if (args.includes('rev-parse')) return Buffer.from(overrides.identity ?? `${tool.SOURCE}\n${tool.TREE}\n`);
    if (args.includes('status')) return Buffer.from(overrides.status ?? '');
    if (args.includes('--name-only')) return Buffer.from(overrides.names ?? 'src/fixture.js\0package-lock.json\0');
    if (args.includes('ls-tree')) return Buffer.from(overrides.tree ?? raw);
    if (args.includes('show')) return Buffer.from(overrides.lock ?? lock);
    throw new Error('unexpected_git_fixture_command');
  });
}

/** Restore mocks/timers and delete only this suite's verified synthetic directories. */
afterEach(() => {
  jest.restoreAllMocks(); jest.useRealTimers();
  for (const dir of fixtures.splice(0)) {
    if (!path.resolve(dir).startsWith(fixtureBase + path.sep) || fs.lstatSync(dir).isSymbolicLink()) throw new Error('fixture_boundary');
    fs.rmSync(dir, { recursive: true, force: false });
  }
});

describe('approval and source identity', () => {
  it('hashes the repository workflow after publication without an adjacent draft', () => {
    const root = path.resolve(__dirname, '..'), workflow = path.resolve(root, '../../..', tool.WORKFLOW);
    expect(fs.existsSync(path.join(root, 'gate1-static.yml'))).toBe(false);
    expect(tool.workflowPath(root)).toBe(workflow);
    const profile = tool.packageProfile(root);
    expect(profile.contract.files['gate1-static.yml']).toBe(tool.sha(fs.readFileSync(workflow)));
    expect(profile.packageDigest).toBe(tool.packageProfile(root, workflow).packageDigest);
  });
  it('retains adjacent-workflow lookup for a local preparation layout', () => {
    const root = fixture(), workflow = path.join(root, 'gate1-static.yml');
    fs.writeFileSync(workflow, 'name: synthetic\n');
    expect(tool.workflowPath(root)).toBe(workflow);
  });
  it('binds the workflow revision and run number into different execution digests', () => {
    const profile = { packageDigest: hash };
    expect(tool.executionProfile(profile, workflowSha, '7').executionDigest).not.toBe(tool.executionProfile(profile, workflowSha, '8').executionDigest);
    expect(tool.executionProfile(profile, workflowSha, '7').executionDigest).not.toBe(tool.executionProfile(profile, 'd'.repeat(40), '7').executionDigest);
  });
  it.each(['0', '1e2', ' 7', '7;secret', '9999999999999999'])('rejects a noncanonical run number %s', number => { expect(() => tool.executionProfile({ packageDigest: hash }, workflowSha, number)).toThrow('approval'); });
  it.each(['GITHUB_RUN_ATTEMPT', 'GITHUB_RUN_NUMBER', 'GITHUB_WORKFLOW_SHA', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GATE1_PACKAGE_DIGEST', 'GATE1_EXECUTION_DIGEST', 'GITHUB_WORKFLOW_REF'])('rejects drift in %s before execution', field => {
    const profile = { packageDigest: hash }, execution = tool.executionProfile(profile, workflowSha, '7');
    const env = { GATE1_WORKFLOW_SHA: workflowSha, GATE1_RUN_NUMBER: '7', GATE1_PACKAGE_DIGEST: hash, GATE1_EXECUTION_DIGEST: execution.executionDigest,
      GITHUB_WORKFLOW_SHA: workflowSha, GITHUB_RUN_NUMBER: '7', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123', GITHUB_REPOSITORY: tool.REPO,
      GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: `${tool.REPO}/${tool.WORKFLOW}@refs/heads/main` };
    expect(tool.validateContext(env, profile, 'linux', 'x64')).toMatchObject({ runNumber: '7', runAttempt: 1 });
    env[field] = 'incorrect'; expect(() => tool.validateContext(env, profile, 'linux', 'x64')).toThrow('approval');
  });
  it('fails source drift before npm or build', async () => {
    const ops = operations(); ops.source.mockRejectedValue(new tool.QualificationError('source_identity'));
    const value = await tool.qualify('/app', '/scratch', context(), ops);
    expect(value).toMatchObject({ stage: 'source', failure: 'source_identity', result: 'stopped' }); expect(ops.run).not.toHaveBeenCalled();
  });
  it('hashes exact source bytes and rejects CRLF or missing-file drift', () => {
    const dir = fixture(), content = Buffer.from('a\nb\n'); fs.writeFileSync(path.join(dir, 'file.js'), 'a\r\nb\r\n');
    const oid = crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    expect(() => tool.verifyFiles(dir, [{ name: 'file.js', oid }])).toThrow('source_content');
    expect(() => tool.verifyFiles(dir, [{ name: 'missing.js', oid }])).toThrow('source_content');
  });
  it('derives index, API and dynamic routes without executing application code', () => {
    expect(tool.pageRoutes(['src/pages/index.js', 'src/pages/api/index.js', 'src/pages/admin/[id].jsx', 'src/pages/_app.js', 'src/shared/a.js'].map(name => ({ name })))).toEqual(['/', '/_app', '/admin/[id]', '/api']);
  });
  it('prepares committed attribution using read-only Git commands', async () => {
    const run = gitFixture(); expect(await tool.sourceProfile('/fixture', false, run)).toMatchObject({ selectedFileCount: 362 });
    expect(run.mock.calls).toHaveLength(5);
    expect(run.mock.calls.every(call => call[0] === 'git')).toBe(true);
    expect(JSON.stringify(run.mock.calls)).not.toMatch(/install|docker|curl|\.env/);
  });
  it.each([
    [{ identity: 'incorrect\nincorrect\n' }, 'source_identity'],
    [{ status: ' M src/middleware.js\n' }, 'source_content'],
    [{ names: '.env.local\0' }, 'source_inventory'],
    [{ names: 'patches/example.patch\0' }, 'source_inventory'],
    [{ tree: '120000 blob ' + 'd'.repeat(40) + '\tsrc/link.js\0' }, 'source_inventory'],
    [{ tree: '' }, 'source_inventory'],
    [{ lock: '{}' }, 'source_content'],
  ])('rejects source or hidden build-input drift %#', async (overrides, code) => {
    await expect(tool.sourceProfile('/fixture', false, gitFixture(overrides))).rejects.toThrow(code);
  });
});

describe('finite qualification and toolchain', () => {
  it('issues only the three approved npm commands and static child with zero application probes', async () => {
    const ops = operations(), value = await tool.qualify('/app', '/scratch', context(), ops);
    expect(ops.run.mock.calls.map(call => call[1].slice(0, 2))).toEqual([['--version'], ['ci', '--no-audit'], ['run', 'build'], [expect.stringMatching(/qualify-static\.cjs$/), '--inspect']]);
    expect(value).toMatchObject({ result: 'complete_static_only', applicationProbeCount: 0, serverStarted: false, childrenClosed: true, gate1: 'open', gate5A: 'unpassed' });
    expect(ops.verify).toHaveBeenCalledTimes(3);
  });
  it('preserves observed non-22 Node version and stops before install', async () => {
    const ops = operations(); ops.node = '24.1.0'; const value = await tool.qualify('/app', '/scratch', context(), ops);
    expect(value).toMatchObject({ stage: 'toolchain', failure: 'node_version', versions: { node: '24.1.0' } }); expect(ops.run).not.toHaveBeenCalled();
  });
  it('rejects incorrect npm without installing', async () => {
    const ops = operations(); ops.run.mockResolvedValue(Buffer.from('11.0.0'));
    expect(await tool.qualify('/app', '/scratch', context(), ops)).toMatchObject({ failure: 'npm_version', versions: { npm: '11.0.0' } }); expect(ops.run).toHaveBeenCalledTimes(1);
  });
  it.each(['next', 'react', 'react-dom', 'acorn'])('rejects a conflicting installed %s before build', async key => {
    const ops = operations(); ops.installed = () => ({ ...tool.VERSIONS, [key]: '99.0.0' });
    expect(await tool.qualify('/app', '/scratch', context(), ops)).toMatchObject({ stage: 'install', failure: 'dependency_version', versions: { [key]: '99.0.0' } }); expect(ops.run).toHaveBeenCalledTimes(2);
  });
  it('stops after installation failure without retry or build', async () => {
    const ops = operations(); ops.run.mockImplementation(async (_command, args) => { if (args[0] === 'ci') throw new tool.QualificationError('child_exit'); return Buffer.from('10.9.9'); });
    expect(await tool.qualify('/app', '/scratch', context(), ops)).toMatchObject({ stage: 'install', failure: 'child_exit', result: 'stopped' }); expect(ops.run).toHaveBeenCalledTimes(2);
  });
  it('stops at build failure and never inspects output from a failed build', async () => {
    const ops = operations(); ops.run.mockImplementation(async (_command, args) => { if (args[0] === 'run') throw new tool.QualificationError('child_exit'); return args[0] === '--version' ? Buffer.from('10.9.9') : Buffer.alloc(0); });
    expect(await tool.qualify('/app', '/scratch', context(), ops)).toMatchObject({ stage: 'build', failure: 'child_exit', inspection: null }); expect(ops.run).toHaveBeenCalledTimes(3);
  });
  it('detects source modification by installation before starting the build', async () => {
    const ops = operations(); ops.verify.mockImplementation(() => { throw new tool.QualificationError('source_content'); });
    expect(await tool.qualify('/app', '/scratch', context(), ops)).toMatchObject({ stage: 'install', failure: 'source_content' }); expect(ops.run).toHaveBeenCalledTimes(2);
  });
  it('caps stage budgets and has no HTTP/server command', async () => {
    const ops = operations(); await tool.qualify('/app', '/scratch', context(), ops);
    expect(ops.run.mock.calls.map(call => call[2].timeoutMs)).toEqual([tool.LIMITS.childMs, tool.LIMITS.installMs, tool.LIMITS.buildMs, tool.LIMITS.inspectMs]);
    expect(ops.run.mock.calls[3][2].input).toBe('["/login"]');
  });
  it('keeps precise inspection category and bounded runtime major', async () => {
    const ops = operations(); ops.run.mockImplementation(async (_command, args) => args[0] === '--version' ? Buffer.from('10.9.9') : args.includes('--inspect') ? Buffer.from(JSON.stringify({ failure: 'runtime_conflict', detail: { output: 'middleware', runtime: 'node', runtimeMajor: 24 } })) : Buffer.alloc(0));
    expect(await tool.qualify('/app', '/scratch', context(), ops)).toMatchObject({ stage: 'inspect', failure: 'runtime_conflict', detail: { output: 'middleware', runtime: 'node', runtimeMajor: 24 } });
  });
  it('records uncertain child closure as a stop', async () => {
    const ops = operations(); ops.run.mockRejectedValue(new tool.QualificationError('cleanup'));
    expect(await tool.qualify('/app', '/scratch', context(), ops)).toMatchObject({ failure: 'cleanup', childrenClosed: false, result: 'stopped' });
  });
  it('discards raw exception messages, paths and secret-shaped version data', async () => {
    const ops = operations(); ops.source.mockRejectedValue(new Error('private-token /private/path'));
    const value = await tool.qualify('/app', '/scratch', context(), ops);
    expect(value.failure).toBe('internal'); expect(JSON.stringify(value)).not.toContain('private-token');
    expect(tool.safeVersions({ node: 'private-token' }).node).toBeNull();
    expect(tool.safeDetail({ detail: { output: '/private/path', runtime: 'private-token', runtimeMajor: 1000, extra: 'raw' } })).toEqual({});
  });
  it('constructs a synthetic child environment with no inherited application or GitHub credential', () => {
    const value = tool.childEnvironment('/scratch');
    expect(value).not.toHaveProperty('GITHUB_TOKEN'); expect(value).not.toHaveProperty('GITHUB_ENV'); expect(value).not.toHaveProperty('GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET');
    expect(value.NEXT_PUBLIC_SUPABASE_URL).toBe('https://ci-build.invalid'); expect(value.npm_config_fetch_retries).toBe('0');
    expect(tool.childEnvironment('/scratch', true)).not.toHaveProperty('NODE_ENV');
  });
});

describe('report privacy and integrity', () => {
  it.each(['rawLog', 'path', 'stack', 'headers', 'credential'])('rejects extra report field %s', async key => {
    const value = await report(); value[key] = 'private'; expect(() => tool.validateReport(value, context())).toThrow('report_schema');
  });
  it.each(['source', 'tree', 'lockSha256', 'packageDigest', 'executionDigest', 'workflowSha', 'runId', 'runNumber'])('rejects wrong attribution %s', async key => {
    const value = await report(); value[key] = 'incorrect'; expect(() => tool.validateReport(value, context())).toThrow('report_schema');
  });
  it.each(['applicationProbeCount', 'serverStarted', 'childrenClosed', 'runAttempt'])('rejects incompatible success fact %s', async key => {
    const value = await report(); value[key] = key === 'serverStarted' ? true : key === 'childrenClosed' ? false : 2;
    expect(() => tool.validateReport(value, context())).toThrow('report_schema');
  });
  it('rejects arbitrary inspection fields and unknown manifest hashes', () => {
    expect(() => tool.validateInspection({ ...inspection(), rawText: 'private' })).toThrow('report_schema');
    const value = inspection(); value.manifests['arbitrary-path'] = hash; expect(() => tool.validateInspection(value)).toThrow('report_schema');
  });
  it('rejects unknown diagnostic values', async () => {
    const value = await report(); value.detail = { output: 'private-token' }; expect(() => tool.validateReport(value, context())).toThrow('report_schema');
    expect(() => tool.parseInspection(Buffer.from(JSON.stringify({ failure: 'reader_missing', detail: { output: 'private-token' } })))).toThrow('report_schema');
  });
  it('validates exact report bytes and rejects mutation, oversize and reservation overwrite', async () => {
    const file = path.join(fixture(), 'report.json'), value = await report(); const digest = tool.writeOnce(file, value);
    expect(tool.verifyReport(file, digest, context())).toEqual(value);
    expect(() => tool.writeOnce(file, value)).toThrow();
    fs.appendFileSync(file, ' '); expect(() => tool.verifyReport(file, digest, context())).toThrow('report_digest');
    expect(() => tool.writeOnce(path.join(path.dirname(file), 'large.json'), { data: 'x'.repeat(tool.LIMITS.reportBytes) })).toThrow('report_schema');
  });
  it('rejects malformed or oversized inspector output without exposing it', () => {
    expect(() => tool.parseInspection(Buffer.from('secret invalid json'))).toThrow('report_schema');
    expect(() => tool.parseInspection(Buffer.alloc(tool.LIMITS.reportBytes + 1))).toThrow('report_schema');
  });
  it('rejects hidden duplicate JSON keys even when the parsed value would pass', async () => {
    const value = await report(), file = path.join(fixture(), 'report.json');
    const bytes = Buffer.from(JSON.stringify(value, null, 2).replace('"schemaVersion": 1,', '"schemaVersion": "private-token",\n  "schemaVersion": 1,') + '\n');
    fs.writeFileSync(file, bytes);
    expect(() => tool.verifyReport(file, tool.sha(bytes), context())).toThrow('report_schema');
    const raw = '{"failure":"private-token","failure":"reader_missing","detail":{}}';
    expect(() => tool.parseInspection(Buffer.from(raw))).toThrow('report_schema');
  });
  it('rejects null report/diagnostic objects rather than accepting an incomplete record', async () => {
    expect(() => tool.validateReport(null, context())).toThrow('report_schema');
    const value = await report(); value.detail = null; expect(() => tool.validateReport(value, context())).toThrow('report_schema');
  });
});

describe('child supervision', () => {
  it('discards build stdout and stderr and closes descendants on normal exit', async () => {
    const value = child(), kill = jest.fn(), promise = tool.supervise('npm', ['run', 'build'], { spawn: () => value, kill });
    value.stdout.emit('data', Buffer.from('private output')); value.stderr.emit('data', Buffer.from('private error')); value.emit('exit', 0); value.emit('close', 0);
    expect(await promise).toEqual(Buffer.alloc(0)); expect(kill).toHaveBeenCalledTimes(1);
  });
  it('kills descendants on successful exit but captures final stdout and waits for close', async () => {
    jest.useFakeTimers(); const value = child(), kill = jest.fn(), settled = jest.fn();
    const promise = tool.supervise('node', [], { spawn: () => value, kill, capture: true, timeoutMs: 10 });
    promise.then(settled, settled);
    value.stdout.emit('data', Buffer.from('before')); value.emit('exit', 0);
    expect(kill).toHaveBeenCalledTimes(1); expect(kill).toHaveBeenCalledWith(value);
    jest.advanceTimersByTime(10); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    value.stdout.emit('data', Buffer.from('after')); value.emit('close', 0);
    expect(await promise).toEqual(Buffer.from('beforeafter')); expect(kill).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  });
  it('bounds missing close after successful exit by the cleanup allowance', async () => {
    jest.useFakeTimers(); const value = child(), kill = jest.fn(), settled = jest.fn();
    const promise = tool.supervise('node', [], { spawn: () => value, kill });
    const check = expect(promise).rejects.toThrow('cleanup'); promise.then(settled, settled);
    value.emit('exit', 0); expect(kill).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(tool.LIMITS.closeMs - 1); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1); await check; expect(jest.getTimerCount()).toBe(0);
  });
  it.each(['stdout', 'stderr'])('rejects final %s overflow after successful exit', async stream => {
    jest.useFakeTimers(); const value = child(), kill = jest.fn();
    const promise = tool.supervise('node', [], { spawn: () => value, kill, cap: 4, capture: true });
    const check = expect(promise).rejects.toThrow('stream_limit'); value.emit('exit', 0);
    value[stream].emit('data', Buffer.alloc(stream === 'stdout' ? 5 : tool.LIMITS.streamBytes + 1)); value.emit('close', 0);
    await check; expect(kill).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  });
  it('does not extend the exit cleanup allowance when final output overflows', async () => {
    jest.useFakeTimers(); const value = child(), kill = jest.fn();
    const promise = tool.supervise('node', [], { spawn: () => value, kill, cap: 4 });
    const check = expect(promise).rejects.toThrow('cleanup'); value.emit('exit', 0);
    jest.advanceTimersByTime(tool.LIMITS.closeMs - 1); value.stdout.emit('data', Buffer.from('12345'));
    jest.advanceTimersByTime(1); await check; expect(kill).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  });
  it.each([[1, 1], [null, null], [1, 0], [0, 1]])('rejects exit %s and close %s after draining streams', async (exitCode, closeCode) => {
    jest.useFakeTimers(); const value = child(), kill = jest.fn(), settled = jest.fn();
    const promise = tool.supervise('node', [], { spawn: () => value, kill });
    const check = expect(promise).rejects.toThrow('child_exit'); promise.then(settled, settled);
    value.emit('exit', exitCode); expect(kill).toHaveBeenCalledTimes(1);
    await Promise.resolve(); expect(settled).not.toHaveBeenCalled(); value.emit('close', closeCode);
    await check; expect(kill).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  });
  it('kills on stream overflow and waits for closure', async () => {
    const value = child(), kill = jest.fn(), promise = tool.supervise('node', [], { spawn: () => value, kill, cap: 4, capture: true });
    const check = expect(promise).rejects.toThrow('stream_limit'); value.stdout.emit('data', Buffer.from('12345')); expect(kill).toHaveBeenCalled(); value.emit('close', null); await check;
  });
  it('reports a timeout only after the child closes', async () => {
    jest.useFakeTimers(); const value = child(), kill = jest.fn(), promise = tool.supervise('npm', [], { spawn: () => value, kill, timeoutMs: 10 });
    const check = expect(promise).rejects.toThrow('deadline'); jest.advanceTimersByTime(10); expect(kill).toHaveBeenCalled(); value.emit('close', null); await check;
  });
  it('does not claim cleanup when a killed child never closes', async () => {
    jest.useFakeTimers(); const value = child(), promise = tool.supervise('npm', [], { spawn: () => value, kill: jest.fn(), timeoutMs: 10 });
    const check = expect(promise).rejects.toThrow('cleanup'); jest.advanceTimersByTime(10 + tool.LIMITS.closeMs); await check;
  });
  it('maps synchronous spawn failure to a fixed category', async () => {
    await expect(tool.supervise('npm', [], { spawn: () => { throw new Error('private spawn error'); } })).rejects.toThrow('child_spawn');
  });
  it('caps stderr as well as stdout without exposing the error body', async () => {
    const value = child(), promise = tool.supervise('npm', [], { spawn: () => value, kill: jest.fn() });
    const check = expect(promise).rejects.toThrow('stream_limit'); value.stderr.emit('data', Buffer.alloc(tool.LIMITS.streamBytes + 1)); value.emit('close', 1); await check;
  });
});
