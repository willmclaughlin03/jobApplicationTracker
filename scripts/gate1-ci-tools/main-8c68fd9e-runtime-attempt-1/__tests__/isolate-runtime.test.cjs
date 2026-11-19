'use strict';
/* global describe, it, expect, jest, Buffer */

/** Pure service metadata and simulated manager/child exchanges; no systemd or child process is invoked. */
const path = require('node:path');
const { EventEmitter } = require('node:events');
const tool = require('../isolate-runtime.cjs');
const probe = require('../runtime-probe.cjs');
const staticInspector = require('../../main-8c68fd9e-static-attempt-1/inspect-compiled.cjs');

/** Bind all mocked service facts to one concrete Linux configuration. */
function config() { return { app: '/app', scratch: '/scratch', tooling: '/tools', node: '/node/bin/node', uid: 1001, gid: 1001, seconds: 360, unit: 'gate1-runtime-123-1.service' }; }

/** Independent fixture for systemd 255's property display, including significant empty values. */
function properties(c = config()) {
  return { ...tool.PROPERTIES, User: '1001', Group: '1001', LoadState: 'loaded', Type: 'exec', ActiveState: 'active', SubState: 'running',
    ControlGroup: '/system.slice/' + c.unit, CPUQuotaPerSecUSec: '4s', RuntimeMaxUSec: c.seconds === 360 ? '6min' : '5min 59s',
    TimeoutStopUSec: '5s', TimeoutStartUSec: '30s', WorkingDirectory: c.app, ReadOnlyPaths: `${c.app} ${c.tooling} /node/bin`, ReadWritePaths: `${c.scratch} ${c.app}/.next/cache` };
}

/** Serialize only fixture metadata as systemctl output, without any real command execution. */
function lines(values) { return Buffer.from(Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('')); }

/** Supply fixed sanitized static facts for progress/report validation. */
function facts() {
  return { nodeMiddleware: true, matcherPreserved: true, sourceRoutesPresent: true, pageCount: 2, buildId: 'synthetic',
    manifests: Object.fromEntries(staticInspector.NAMES.map(name => [name, 'a'.repeat(64)])), traceHash: 'b'.repeat(64), compiledFiles: 1,
    compiledBytes: 99, compiledClosureHash: 'c'.repeat(64), readerCandidates: 1 };
}

/** Build expected sanitized cases directly, independent of the response review implementation. */
function cases() {
  return probe.CASES.map((name, index) => {
    const positive = index === 1 || index === 2, n = positive ? 1 : 0;
    return { case: name, status: index === 5 ? 307 : 200, bodyNonempty: index !== 5, observation: positive, challengeMatched: positive ? true : null,
      nodeVersion: positive ? 'v22.23.3' : null, nativeReadCounts: { version: n, nodeVersion: n, releaseName: n }, noCookies: true,
      privateNoStore: positive || index === 3 || index === 5 ? true : null, loginRedirect: index === 5 ? true : null };
  });
}

/** Model the exact eight pre-request snapshots; no missing snapshot implies a zero count. */
function progress(index) {
  return { ...probe.emptyRuntime(), isolationVerified: true, stage: index === 0 ? 'isolation' : index === 1 ? 'startup' : 'requests',
    inspection: index === 0 ? null : facts(), serverStarted: index > 0, attempted: Math.max(0, index - 1), cases: cases().slice(0, Math.max(0, index - 2)),
    descriptorsRestored: index === 0 ? null : false, serverClosed: index === 0 ? null : false, nextClosed: index === 0 ? null : false };
}

/** Simulate a kernel-visible cgroup and namespace using only in-memory pseudo-file strings. */
function kernel() {
  const c = config(), root = '/sys/fs/cgroup/system.slice/' + c.unit;
  const values = { '/proc/self/cgroup': '0::/system.slice/' + c.unit, [`${root}/cpu.max`]: '400000 100000', [`${root}/memory.max`]: '6442450944',
    [`${root}/memory.swap.max`]: '0', [`${root}/pids.max`]: '256', '/proc/self/status': 'NoNewPrivs:\t1\nCapEff:\t0000\nCapBnd:\t0000\nSeccomp:\t2\n' };
  const io = { readFileSync: name => values[name], readlinkSync: () => 'net:[2]', readdirSync: () => ['lo'] };
  return { values, io, input: { unit: c.unit, hostNamespace: 'net:[1]' }, root };
}

/** Coordinate mocked launcher completion, atomic record visibility and the parent watchdog on virtual time. */
function harness() {
  const records = new Map(), hash = 'd'.repeat(64), signals = new EventEmitter();
  let time = 1000, finish, reject, releaseAt = null, tick = () => {};
  const io = { readlinkSync: () => 'net:[1]', existsSync: name => records.has(path.basename(name)) };
  const read = jest.fn((name, inputHash, keys) => {
    const value = records.get(path.basename(name));
    if (!probe.exactKeys(value, ['inputHash', ...keys]) || value.inputHash !== inputHash) throw Object.assign(new Error('report_schema'), { code: 'report_schema' });
    return value;
  });
  const write = jest.fn((_scratch, name, value) => { records.set(name, value); if (name === 'release.json') releaseAt = value.at; return hash; });
  const run = jest.fn(async (_command, args) => {
    if (args[1] === 'systemd-run') {
      records.set('ready.json', { inputHash: hash, kernelVerified: true });
      return new Promise((resolve, fail) => { finish = resolve; reject = fail; });
    }
    if (args.includes('list-units')) return Buffer.alloc(0);
    return lines(properties());
  });
  const stop = jest.fn(async () => { finish?.(Buffer.alloc(0)); return true; });
  const ops = { run, fs: io, read, write, stop, signals, now: () => time, uid: 1001, gid: 1001, tooling: '/tools', node: '/node/bin/node',
    pause: async () => { time += 100; tick(); } };
  return { records, hash, signals, ops, get releaseAt() { return releaseAt; }, get time() { return time; }, advance: ms => { time += ms; },
    onTick: fn => { tick = fn; }, finish: () => finish(Buffer.alloc(0)), fail: code => reject(Object.assign(new Error(code), { code })),
    run: () => tool.runIsolated('/app', '/scratch', { runId: '123', executionDigest: 'e'.repeat(64) }, { entries: [], routes: [] }, 360000, ops) };
}

describe('service creation and effective readback', () => {
  it('uses a private unprivileged service with strict resource and filesystem bounds, cleared environment and pipes', () => {
    const args = tool.serviceArgs(config());
    for (const value of ['--pipe', '--wait', '--service-type=exec', '--expand-environment=no', '--uid=1001', '--gid=1001', '--property=PrivateNetwork=yes',
      '--property=MemoryMax=6442450944', '--property=MemorySwapMax=0', '--property=TasksMax=256', '--property=CPUQuota=400%', '--property=RuntimeMaxSec=360s',
      '--property=KillMode=control-group', '--property=Restart=no', '--property=ReadWritePaths=/scratch /app/.next/cache', '/usr/bin/env', '-i']) expect(args).toContain(value);
    expect(args).not.toContain('--scope'); expect(args.at(-3)).toBe('--child'); expect(args.some(value => /GITHUB_TOKEN|VERCEL_TOKEN|NODE_OPTIONS/.test(value))).toBe(false);
  });
  it.each([{ uid: 0 }, { gid: 0 }, { seconds: 361 }, { app: '/app/../escape' }, { scratch: '/scratch space' }, { unit: '../unit' }])('rejects unsafe service configuration %#', change => {
    expect(() => tool.serviceArgs({ ...config(), ...change })).toThrow('isolation');
  });
  it('accepts exact sets in either order and mixed minute/second display', () => {
    const c = { ...config(), seconds: 359 }, values = properties(c); values.RestrictAddressFamilies = 'AF_INET6 AF_INET'; values.ReadWritePaths = '/app/.next/cache /scratch';
    expect(tool.validateService(tool.parseProperties(lines(values), tool.serviceNames()), c)).toBe(true);
  });
  it.each(['infinity', '359000000', '5min 60s extra', '0.1s', '-1s', '7min'])('rejects unsupported duration %s', value => { expect(() => tool.duration(value)).toThrow('isolation'); });
  it.each([{ PrivateNetwork: 'no' }, { RestrictAddressFamilies: 'AF_INET AF_INET6 AF_UNIX' }, { RestrictAddressFamilies: 'AF_INET AF_INET' },
    { ReadWritePaths: '/scratch /app' }, { ActiveState: 'failed' }, { LoadState: 'not-found' }, { CPUQuotaPerSecUSec: '5s' }, { RuntimeMaxUSec: '5min' },
    { CapabilityBoundingSet: 'cap_net_admin' }, { ControlGroup: '/other' }, { User: 'root' }])('rejects weakened or unavailable metadata %#', change => {
    expect(() => tool.validateService({ ...properties(), ...change }, config())).toThrow('isolation');
  });
  it('rejects missing, duplicate, unexpected and oversized properties', () => {
    for (const value of ['A=1\nA=2\n', 'B=1\n', 'A=1\nB=2\n', 'A=' + 'x'.repeat(16384)]) expect(() => tool.parseProperties(Buffer.from(value), ['A'])).toThrow('isolation');
  });
  it('verifies actual kernel controls independently', () => { const k = kernel(); expect(tool.verifyKernel(k.input, k.io)).toBe(true); });
  it.each(['namespace', 'interfaces', 'cgroup', 'memory', 'swap', 'cpu', 'tasks', 'privileges'])('rejects kernel mismatch %s', kind => {
    const k = kernel();
    if (kind === 'namespace') k.io.readlinkSync = () => 'net:[1]';
    if (kind === 'interfaces') k.io.readdirSync = () => ['lo', 'eth0'];
    if (kind === 'cgroup') k.values['/proc/self/cgroup'] = '0::/';
    if (kind === 'memory') k.values[k.root + '/memory.max'] = 'max';
    if (kind === 'swap') k.values[k.root + '/memory.swap.max'] = '1';
    if (kind === 'cpu') k.values[k.root + '/cpu.max'] = 'max 100000';
    if (kind === 'tasks') k.values[k.root + '/pids.max'] = 'max';
    if (kind === 'privileges') k.values['/proc/self/status'] = 'NoNewPrivs:\t0\n';
    expect(() => tool.verifyKernel(k.input, k.io)).toThrow('isolation');
  });
});

describe('progress, phases and separate service cleanup', () => {
  it('leaves absent progress unknown and accepts only a contiguous monotonic prefix', () => {
    const records = new Map(), io = { existsSync: file => records.has(path.basename(file)) }, read = file => ({ runtime: records.get(path.basename(file)) });
    expect(tool.recoverProgress('/scratch', 'hash', io, read)).toBe(null);
    records.set('progress-01.json', progress(1)); expect(() => tool.recoverProgress('/scratch', 'hash', io, read)).toThrow('report_schema');
    records.set('progress-00.json', progress(0)); expect(tool.recoverProgress('/scratch', 'hash', io, read)).toEqual(progress(1));
    records.set('progress-02.json', { ...progress(2), attempted: 2 }); expect(() => tool.recoverProgress('/scratch', 'hash', io, read)).toThrow('report_schema');
  });
  it('rejects a mutated or disappearing phase prefix', () => {
    const io = { existsSync: () => false };
    expect(() => tool.readPhases('/scratch', 'hash', [{ phase: 'inspect', at: 10 }], io)).toThrow('report_schema');
  });
  it('accepts an unloaded completed transient unit only after checking the cgroup is absent', async () => {
    const run = jest.fn().mockRejectedValueOnce({ code: 'child_exit' }).mockResolvedValueOnce(Buffer.alloc(0));
    const io = { statSync: jest.fn(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }) };
    expect(await tool.stopService(config(), run, io)).toBe(true); expect(io.statSync).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(2);
  });
  it.each(['populated', 'active', 'permission', 'timeout'])('does not claim service cleanup for %s', kind => {
    const run = jest.fn().mockResolvedValueOnce(Buffer.alloc(0)).mockResolvedValueOnce(Buffer.from('unit row'))
      .mockResolvedValueOnce(lines({ LoadState: 'loaded', ActiveState: kind === 'active' ? 'active' : 'inactive', SubState: kind === 'active' ? 'running' : 'dead' }));
    if (kind === 'timeout') run.mockReset().mockRejectedValue({ code: 'deadline' });
    const io = { statSync: () => { if (kind === 'permission') throw Object.assign(new Error('denied'), { code: 'EACCES' }); return { isDirectory: () => true }; }, readFileSync: () => 'populated 1\n' };
    return expect(tool.stopService(config(), run, io)).rejects.toThrow('cleanup');
  });
  it('releases only after both kernel-ready and effective metadata agree, then verifies terminal evidence and cleanup', async () => {
    const h = harness();
    h.onTick(() => {
      if (h.releaseAt === null) return;
      for (const [i, phase] of ['inspect', 'startup', 'requests', 'cleanup', 'recheck', 'complete'].entries()) h.records.set(`phase-0${i}.json`, { inputHash: h.hash, phase, at: h.releaseAt + i });
      for (let i = 0; i < 8; i++) h.records.set(`progress-0${i}.json`, { inputHash: h.hash, runtime: progress(i) });
      h.records.set('runtime.json', { inputHash: h.hash, runtime: { ...progress(7), stage: 'complete', cases: cases(), sourceUnchanged: true, compiledUnchanged: true,
        descriptorsRestored: true, serverClosed: true, nextClosed: true } }); h.finish();
    });
    const result = await h.run(); expect(result).toMatchObject({ failure: null, serviceStopped: true, accounting: 'known' });
    expect(result.runtime.cases).toHaveLength(6); expect(h.ops.stop).toHaveBeenCalledTimes(1); expect(h.signals.listenerCount('SIGTERM')).toBe(0);
  });
  it('does not launch when the owned name is already reserved', async () => {
    const h = harness(); h.ops.run.mockResolvedValue(Buffer.from('existing unit'));
    expect(await h.run()).toMatchObject({ failure: 'reservation', serviceStopped: null, runtime: null, accounting: 'unknown' });
    expect(h.ops.stop).not.toHaveBeenCalled(); expect(h.ops.run).toHaveBeenCalledTimes(1);
  });
  it('does not release a child after service readback fails', async () => {
    const h = harness(), original = h.ops.run.getMockImplementation();
    h.ops.run.mockImplementation((command, args, options) => args.includes('show') ? Promise.resolve(lines({ ...properties(), PrivateNetwork: 'no' })) : original(command, args, options));
    expect(await h.run()).toMatchObject({ failure: 'isolation', serviceStopped: true, accounting: 'unknown' });
    expect(h.records.has('release.json')).toBe(false);
  });
  it.each(['missing-phase', 'inspection-stall', 'total'])('stops the owned service on %s deadline', async kind => {
    const h = harness();
    h.onTick(() => {
      if (h.releaseAt === null) return;
      if (kind !== 'missing-phase') h.records.set('phase-00.json', { inputHash: h.hash, phase: 'inspect', at: h.releaseAt });
      h.advance(kind === 'total' ? 360000 : kind === 'inspection-stall' ? 120000 : 30000);
    });
    expect(await h.run()).toMatchObject({ failure: 'deadline', serviceStopped: true, accounting: 'unknown' }); expect(h.ops.stop).toHaveBeenCalledTimes(1);
  });
  it('handles cancellation with owned-service cleanup and removes listeners', async () => {
    const h = harness(); h.onTick(() => h.signals.emit('SIGTERM'));
    expect(await h.run()).toMatchObject({ failure: 'cancelled', serviceStopped: true }); expect(h.signals.listenerCount('SIGTERM')).toBe(0);
  });
  it('does not equate stream-overflow launcher exit with stopped service', async () => {
    const h = harness(); h.onTick(() => { h.fail('stream_limit'); });
    const result = await h.run(); expect(result.failure).not.toBe(null); expect(h.ops.stop).toHaveBeenCalledTimes(1);
  });
  it('keeps cleanup failure precedence even if recovery also fails', async () => {
    const h = harness(); h.onTick(() => h.signals.emit('SIGTERM'));
    h.ops.stop.mockImplementation(async () => { h.finish(); throw new Error('stop'); }); h.ops.recover = () => { throw new Error('bad record'); };
    expect(await h.run()).toMatchObject({ failure: 'cleanup', serviceStopped: false, runtime: null, accounting: 'unknown' });
  });
  it('recovers attempts from durable progress after child interruption', async () => {
    const h = harness();
    h.onTick(() => {
      for (let i = 0; i <= 3; i++) h.records.set(`progress-0${i}.json`, { inputHash: h.hash, runtime: progress(i) });
      h.signals.emit('SIGTERM');
    });
    const result = await h.run(); expect(result).toMatchObject({ failure: 'cancelled', accounting: 'known', runtime: { attempted: 2 } });
    expect(result.runtime.cases).toHaveLength(1);
  });
});
