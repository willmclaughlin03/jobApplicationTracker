'use strict';
/* global describe, it, expect, jest, afterEach, Buffer, process */

/** Offline contract tests; Docker/process transports and writes are mocked where exercised. */
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const tool = require('../qualify-build.cjs');

/** Build the expected container metadata independently of Docker or an actual image. */
function container() {
  const image = 'sha256:' + 'a'.repeat(64), approval = 'b'.repeat(64), state = 'C:\\repo\\.tmp\\state';
  const args = tool.containerArgs(image, state, 300, approval);
  return { image, approval, state, value: { Image: image, State: { Running: false },
    Config: { User: '1000:1000', Entrypoint: ['/usr/bin/timeout'], Cmd: args.slice(args.indexOf(image) + 1) },
    Mounts: [{ Type: 'bind', Source: state, Destination: '/state', RW: true }],
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Memory: 6442450944, MemorySwap: 6442450944, NanoCpus: 4000000000,
      PidsLimit: 256, LogConfig: { Type: 'none' }, RestartPolicy: { Name: 'no' }, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      Mounts: [{ Source: state, Target: '/state' }] } } };
}

/** Create bounded terminal facts without invoking the build inspector. */
function facts() {
  return { versions: tool.VERSIONS, nodeMiddleware: true, matcherPreserved: true, sourceRoutesPresent: true, pageCount: 35,
    manifests: Object.fromEntries(['server/functions-config-manifest.json', 'server/middleware-manifest.json', 'server/pages-manifest.json', 'routes-manifest.json', 'build-manifest.json'].map(name => [name, 'c'.repeat(64)])),
    traceSha256: 'd'.repeat(64), readerSha256: 'e'.repeat(64), compiledFiles: 4, compiledBytes: 5000,
    localBuildId: 'syntheticBuildId', compiledClosureSha256: 'f'.repeat(64) };
}

/** Construct an EventEmitter child; tests manually drive events instead of spawning processes. */
function childFixture() {
  const child = new EventEmitter(); child.pid = 0; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = jest.fn();
  return { child, spawn: jest.fn(() => child) };
}

/** Release mocked APIs after every case so no filesystem mutation or fake timer leaks. */
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe('source and approval boundaries', () => {
  it('selects committed application blobs while excluding unrelated evidence and configuration', () => {
    const oid = 'a'.repeat(40);
    const entries = [`100644 blob ${oid}\tsrc/pages/login.js`, `100644 blob ${oid}\tpackage-lock.json`, `100644 blob ${oid}\tdocs/note.md`, `100644 blob ${oid}\t.env.local`].join('\0');
    expect(tool.sourceSelection(Buffer.from(entries))).toEqual([{ mode: '100644', oid, name: 'src/pages/login.js' }, { mode: '100644', oid, name: 'package-lock.json' }]);
  });

  it.each(['src/.env.local', 'src/../outside', 'src/.vercel/config', 'src/bad\\path'])('rejects unsafe selected path %s', name => {
    expect(() => tool.sourceSelection(Buffer.from(`100644 blob ${'a'.repeat(40)}\t${name}`))).toThrow('source');
  });

  it('rejects committed symbolic links before reading their targets', () => {
    expect(() => tool.sourceSelection(Buffer.from(`120000 blob ${'a'.repeat(40)}\tsrc/link`))).toThrow('source');
  });

  it('maps source pages and API routes without changing dynamic segments', () => {
    expect(tool.routesFromSource(['src/pages/index.js', 'src/pages/api/auth/session.js', 'src/pages/item/[id].js'].map(name => ({ name })))).toEqual(['/', '/api/auth/session', '/item/[id]']);
  });

  it('stops preparation on source drift before archive hashing or any execution', async () => {
    const git = jest.fn().mockResolvedValue(Buffer.from('different-source'));
    const write = jest.spyOn(fs, 'writeFileSync');
    await expect(tool.prepare({ git })).rejects.toThrow('source');
    expect(git).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled();
  });

  it('does not offer an implicit default execution mode', async () => {
    await expect(tool.main([])).rejects.toThrow('input');
    await expect(tool.main(['--execute'])).rejects.toThrow('input');
  });

  it('builds an explicit synthetic environment with no inherited credential', () => {
    process.env.SYNTHETIC_TEST_PRIVATE_CREDENTIAL = 'do-not-forward';
    try {
      expect(tool.syntheticEnvironment()).not.toHaveProperty('SYNTHETIC_TEST_PRIVATE_CREDENTIAL');
      expect(tool.hostEnvironment()).not.toHaveProperty('SYNTHETIC_TEST_PRIVATE_CREDENTIAL');
      expect(tool.syntheticEnvironment()).toMatchObject({ npm_config_offline: 'true', VERCEL: '1', VERCEL_ENV: 'preview', NODE_ENV: 'production' });
    } finally { delete process.env.SYNTHETIC_TEST_PRIVATE_CREDENTIAL; }
  });

  it('reserves all evidence with exclusive creation and a durable write', () => {
    const open = jest.spyOn(fs, 'openSync').mockReturnValue(8);
    const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const sync = jest.spyOn(fs, 'fsyncSync').mockImplementation(() => {});
    const close = jest.spyOn(fs, 'closeSync').mockImplementation(() => {});
    tool.writeOnce('synthetic.json', { state: 'reserved_no_replay' });
    expect(open).toHaveBeenCalledWith('synthetic.json', 'wx', 0o600); expect(write).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(8); expect(close).toHaveBeenCalledWith(8);
  });

  it('never overwrites an existing reservation', () => {
    jest.spyOn(fs, 'openSync').mockImplementation(() => { throw new Error('EEXIST'); });
    const write = jest.spyOn(fs, 'writeFileSync');
    expect(() => tool.writeOnce('synthetic.json', {})).toThrow('EEXIST'); expect(write).not.toHaveBeenCalled();
  });
});

describe('resource and cleanup boundaries', () => {
  it('fixes network isolation, resources, mounted state, digest and independent timeout', () => {
    const fixture = container();
    expect(tool.validateContainer(fixture.value, fixture.image, fixture.state, 300, fixture.approval)).toBe(true);
    const args = tool.containerArgs(fixture.image, fixture.state, 300, fixture.approval);
    expect(args).toContain('--network=none'); expect(args).toContain('--pull=never'); expect(args).not.toContain('--publish');
    expect(args.slice(-2)).toEqual(['--inside', fixture.approval]);
  });

  it.each([
    value => { value.HostConfig.NetworkMode = 'bridge'; },
    value => { value.HostConfig.Privileged = true; },
    value => { value.HostConfig.ReadonlyRootfs = false; },
    value => { value.HostConfig.Memory = 0; },
    value => { value.HostConfig.LogConfig.Type = 'json-file'; },
    value => { value.Mounts.push({ Type: 'bind', Destination: '/private', RW: false }); },
    value => { value.Config.User = 'root'; },
    value => { value.Config.Cmd.push('unexpected'); },
  ])('rejects Docker configuration drift before start %#', mutate => {
    const fixture = container(); mutate(fixture.value);
    expect(() => tool.validateContainer(fixture.value, fixture.image, fixture.state, 300, fixture.approval)).toThrow('docker');
  });

  it.each([0, 1801, NaN, 2.5])('rejects an unbounded independent timeout %s', seconds => {
    expect(() => tool.containerArgs('sha256:' + 'a'.repeat(64), 'safe', seconds, 'b'.repeat(64))).toThrow('docker');
  });

  /** No create attempt means no Docker lookup or cleanup side effect is needed. */
  it('skips Docker cleanup when creation was never attempted', async () => {
    const run = jest.fn();
    await expect(tool.cleanupContainer(run, false, false)).resolves.toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  /** A failed create can leave no container; successful absence must not mask the original failure. */
  it('returns without inspecting when the exact attempt container is absent', async () => {
    const run = jest.fn().mockResolvedValueOnce(Buffer.alloc(0));
    await expect(tool.cleanupContainer(run, true, false)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('docker', ['--context', 'desktop-linux', 'ps', '-aq', '--filter',
      'name=^/gate1-main-24106d4e-compiled-attempt-2$']);
  });

  /** A create timeout can leave a stopped container; inspect its state even without a successful create response. */
  it('verifies a stopped container left behind by a timed-out create', async () => {
    const run = jest.fn().mockResolvedValueOnce(Buffer.from('synthetic-container-id\n'))
      .mockResolvedValueOnce(Buffer.from('{"Running":false,"OOMKilled":false,"ExitCode":0}'));
    await expect(tool.cleanupContainer(run, true, false)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(2, 'docker', ['--context', 'desktop-linux', 'inspect', '--format',
      '{{json .State}}', 'gate1-main-24106d4e-compiled-attempt-2']);
  });

  /** A failed existence query cannot establish absence and must still fail cleanup. */
  it('propagates a failed container lookup instead of assuming absence', async () => {
    const error = new tool.QualificationError('child');
    const run = jest.fn().mockRejectedValueOnce(error);
    await expect(tool.cleanupContainer(run, true, false)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('kills a still-running attempt once and verifies that it stopped', async () => {
    const run = jest.fn().mockResolvedValueOnce(Buffer.from('synthetic-container-id\n'))
      .mockResolvedValueOnce(Buffer.from('{"Running":true,"OOMKilled":false,"ExitCode":0}'))
      .mockResolvedValueOnce(Buffer.alloc(0)).mockResolvedValueOnce(Buffer.from('{"Running":false,"OOMKilled":false,"ExitCode":137}'));
    await expect(tool.cleanupContainer(run, true, false)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(4); expect(run.mock.calls[2][1]).toContain('kill');
    expect(run.mock.calls.flat(3)).not.toContain('rm');
  });

  it.each([
    { Running: true, OOMKilled: false, ExitCode: 137 },
    { Running: false, OOMKilled: true, ExitCode: 137 },
    {},
  ])('does not assume cleanup from incomplete or conflicting Docker state %#', state => {
    const run = jest.fn().mockResolvedValueOnce(Buffer.from('synthetic-container-id\n'))
      .mockResolvedValue(Buffer.from(JSON.stringify(state)));
    return expect(tool.cleanupContainer(run, true, false)).rejects.toThrow('cleanup');
  });

  it('refuses a success result when its container exited nonzero', () => {
    const run = jest.fn().mockResolvedValueOnce(Buffer.from('synthetic-container-id\n'))
      .mockResolvedValue(Buffer.from('{"Running":false,"OOMKilled":false,"ExitCode":1}'));
    return expect(tool.cleanupContainer(run, true, true)).rejects.toThrow('cleanup');
  });

  it('caps child stdout and never exposes raw error output', async () => {
    const fixture = childFixture(), pending = tool.supervise('synthetic', [], { spawn: fixture.spawn, cap: 4 });
    const assertion = expect(pending).rejects.toThrow('stream_limit');
    fixture.child.stdout.emit('data', Buffer.from('private-output')); await assertion;
  });

  it('discards stderr on a nonzero child exit', async () => {
    const fixture = childFixture(), pending = tool.supervise('synthetic', [], { spawn: fixture.spawn });
    const assertion = expect(pending).rejects.toThrow('child');
    fixture.child.stderr.emit('data', Buffer.from('private-output')); fixture.child.emit('close', 1, null); await assertion;
  });

  it('returns captured data only after a successful child close', async () => {
    const fixture = childFixture(), pending = tool.supervise('synthetic', [], { spawn: fixture.spawn });
    fixture.child.stdout.emit('data', Buffer.from('safe')); fixture.child.emit('close', 0, null);
    await expect(pending).resolves.toEqual(Buffer.from('safe'));
  });
});

describe('sanitized result contract', () => {
  it('retains a fixed stopped category without treating it as a pass', () => {
    const report = { schemaVersion: 1, source: tool.SOURCE, gate1: 'open', result: 'stopped', step: 'inspect', failure: 'compiled_reader', requests: 0 };
    expect(tool.terminal(Buffer.from(JSON.stringify(report)))).toEqual(report);
  });

  it('rejects apparent success without complete observations and cleanup', () => {
    expect(() => tool.terminal(Buffer.from(JSON.stringify({ source: tool.SOURCE, gate1: 'open', result: 'complete_local_only', step: 'complete', requests: 6 })))).toThrow('persistence');
  });

  it('rejects arbitrary diagnostic fields nested in facts', () => {
    expect(() => tool.validateFacts({ ...facts(), rawHeaders: 'private' })).toThrow('persistence');
    const fixture = facts(); fixture.manifests['unrecognized/provider/path'] = 'a'.repeat(64);
    expect(() => tool.validateFacts(fixture)).toThrow('persistence');
  });

  it('rejects concrete non-22 toolchain facts', () => {
    expect(() => tool.validateFacts({ ...facts(), versions: { ...tool.VERSIONS, node: '24.1.0' } })).toThrow('persistence');
  });

  it('constructs exactly six fresh, non-cookie loopback cases without hidden readiness requests', () => {
    const cases = tool.smokeCases();
    expect(cases).toHaveLength(6); expect(new Set(cases.map(item => item.challenge)).size).toBe(6);
    expect(cases.filter(item => item.observe)).toHaveLength(2);
    expect(cases.map(item => item.path)).toEqual(['/login', '/login', '/login', '/login', '/login?scope=1', '/admin']);
    expect(cases.every(item => !Object.hasOwn(item.headers, 'cookie'))).toBe(true);
  });
});
