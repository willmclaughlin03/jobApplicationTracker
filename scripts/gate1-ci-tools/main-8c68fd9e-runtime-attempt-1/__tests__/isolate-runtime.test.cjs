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
  return { ...tool.PROPERTIES, ProtectHome: 'read-only', User: '1001', Group: '1001', LoadState: 'loaded', Type: 'exec', ActiveState: 'active', SubState: 'running',
    ControlGroup: '/system.slice/' + c.unit, CPUQuotaPerSecUSec: '4s', RuntimeMaxUSec: c.seconds === 360 ? '6min' : '5min 59s',
    TimeoutStopUSec: '5s', TimeoutStartUSec: '30s', WorkingDirectory: c.app, ReadOnlyPaths: `${c.app} ${c.tooling} ${path.posix.dirname(c.node)}`, ReadWritePaths: `${c.scratch} ${c.app}/.next/cache` };
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

/** Simulate kernel-visible controls and mount permissions using only in-memory pseudo-file strings. */
function kernel(c = config()) {
  const root = '/sys/fs/cgroup/system.slice/' + c.unit;
  const values = { '/proc/self/cgroup': '0::/system.slice/' + c.unit, [`${root}/cpu.max`]: '400000 100000', [`${root}/memory.max`]: '6442450944',
    [`${root}/memory.swap.max`]: '0', [`${root}/pids.max`]: '256', '/proc/self/status': 'NoNewPrivs:\t1\nCapEff:\t0000\nCapBnd:\t0000\nSeccomp:\t2\n' };
  values['/proc/self/mountinfo'] = ['/', '/home', '/root', '/run/user', c.app, c.tooling, path.posix.dirname(c.node), c.scratch, `${c.app}/.next/cache`]
    .map((name, i) => `${i + 1} 0 8:1 / ${name} ${i < 7 ? 'ro' : 'rw'},relatime - ext4 /dev/root rw\n`).join('');
  const io = { readFileSync: name => values[name], readlinkSync: () => 'net:[2]', readdirSync: () => ['lo'], realpathSync: name => name,
    lstatSync: () => ({ isDirectory: () => true }) };
  return { values, io, input: { unit: c.unit, hostNamespace: 'net:[1]' }, root, config: c };
}

/** Coordinate mocked launcher completion, atomic record visibility and the parent watchdog on virtual time. */
function harness() {
  const records = new Map(), hash = 'd'.repeat(64), signals = new EventEmitter();
  let time = 1000, finish, reject, releaseAt = null, tick = () => {};
  const io = { readlinkSync: () => 'net:[1]', existsSync: name => records.has(path.basename(name)),
    statSync: jest.fn(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }) };
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
      '--property=ProtectHome=read-only', '--property=MemoryMax=6442450944', '--property=MemorySwapMax=0', '--property=TasksMax=256', '--property=CPUQuota=400%', '--property=RuntimeMaxSec=360s',
      '--property=KillMode=control-group', '--property=Restart=no', '--property=ReadWritePaths=/scratch /app/.next/cache', '/usr/bin/env', '-i']) expect(args).toContain(value);
    expect(args).not.toContain('--scope'); expect(args.at(-3)).toBe('--child'); expect(args.some(value => /GITHUB_TOKEN|VERCEL_TOKEN|NODE_OPTIONS/.test(value))).toBe(false);
    expect(tool.serviceNames()).toContain('ProtectHome');
  });
  it.each([{ uid: 0 }, { gid: 0 }, { seconds: 361 }, { app: '/app/../escape' }, { scratch: '/scratch space' }, { unit: '../unit' }])('rejects unsafe service configuration %#', change => {
    expect(() => tool.serviceArgs({ ...config(), ...change })).toThrow('isolation');
  });
  it('accepts exact sets in either order and mixed minute/second display', () => {
    const c = { ...config(), seconds: 359 }, values = properties(c); values.RestrictAddressFamilies = 'AF_INET6 AF_INET'; values.ReadWritePaths = '/app/.next/cache /scratch';
    expect(tool.validateService(tool.parseProperties(lines(values), tool.serviceNames()), c)).toBe(true);
  });
  it.each(['infinity', '359000000', '5min 60s extra', '0.1s', '-1s', '7min'])('rejects unsupported duration %s', value => { expect(() => tool.duration(value)).toThrow('isolation'); });
  it.each([{ PrivateNetwork: 'no' }, { ProtectHome: 'no' }, { ProtectHome: 'yes' }, { ProtectHome: 'tmpfs' }, { RestrictAddressFamilies: 'AF_INET AF_INET6 AF_UNIX' }, { RestrictAddressFamilies: 'AF_INET AF_INET' },
    { ReadWritePaths: '/scratch /app' }, { ActiveState: 'failed' }, { LoadState: 'not-found' }, { CPUQuotaPerSecUSec: '5s' }, { RuntimeMaxUSec: '5min' },
    { CapabilityBoundingSet: 'cap_net_admin' }, { ControlGroup: '/other' }, { User: 'root' }])('rejects weakened or unavailable metadata %#', change => {
    expect(() => tool.validateService({ ...properties(), ...change }, config())).toThrow('isolation');
  });
  it('rejects missing, duplicate, unexpected and oversized properties', () => {
    for (const value of ['A=1\nA=2\n', 'B=1\n', 'A=1\nB=2\n', 'A=' + 'x'.repeat(16384)]) expect(() => tool.parseProperties(Buffer.from(value), ['A'])).toThrow('isolation');
  });
  it('verifies actual kernel controls independently', () => { const k = kernel(); expect(tool.verifyKernel(k.input, k.io, k.config)).toBe(true); });
  it('accepts an absent optional /run/user without resolving it or requiring its mount', () => {
    const k = kernel();
    k.io.lstatSync = jest.fn(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
    k.io.realpathSync = jest.fn(name => { if (name === '/run/user') throw new Error('absent'); return name; });
    k.values['/proc/self/mountinfo'] = k.values['/proc/self/mountinfo'].split('\n').filter(line => !line.includes(' /run/user ')).join('\n');
    expect(tool.verifyKernel(k.input, k.io, k.config)).toBe(true);
    expect(k.io.lstatSync).toHaveBeenCalledWith('/run/user'); expect(k.io.realpathSync).not.toHaveBeenCalledWith('/run/user');
  });
  it.each(['parent-only', 'permission', 'file'])('rejects unproven /run/user protection: %s', kind => {
    const k = kernel();
    if (kind === 'parent-only') k.values['/proc/self/mountinfo'] = k.values['/proc/self/mountinfo'].split('\n').filter(line => !line.includes(' /run/user ')).join('\n');
    if (kind === 'permission') k.io.lstatSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    if (kind === 'file') k.io.lstatSync = () => ({ isDirectory: () => false });
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow('isolation');
  });
  it.each(['/home', '/root', '/app', '/tools', '/node/bin', '/scratch', '/app/.next/cache'])('still requires %s when /run/user is absent', name => {
    const k = kernel();
    k.io.lstatSync = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
    k.io.realpathSync = value => { if (value === name) throw new Error('absent'); return value; };
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow();
  });
  it('preserves scratch and cache write exceptions nested under a protected home', () => {
    const c = { ...config(), app: '/home/runner/app', scratch: '/home/runner/scratch', tooling: '/home/runner/tools', node: '/home/runner/node/bin/node' }, k = kernel(c);
    expect(tool.serviceArgs(c)).toContain('--property=ReadWritePaths=/home/runner/scratch /home/runner/app/.next/cache');
    expect(tool.validateService(properties(c), c)).toBe(true); expect(tool.verifyKernel(k.input, k.io, c)).toBe(true);
  });
  it.each(['/home', '/root', '/run/user', '/app', '/tools', '/node/bin'])('rejects a writable protected mount at %s', name => {
    const k = kernel(); k.values['/proc/self/mountinfo'] = k.values['/proc/self/mountinfo'].replace(` ${name} ro,`, ` ${name} rw,`);
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow('isolation');
  });
  it.each(['/scratch', '/app/.next/cache'])('rejects a read-only approved write mount at %s', name => {
    const k = kernel(); k.values['/proc/self/mountinfo'] = k.values['/proc/self/mountinfo'].replace(` ${name} rw,`, ` ${name} ro,`);
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow('isolation');
  });
  it.each(['/home/runner/unapproved', '/app/.next/cache-other', '/home/runner/escaped\\040path'])('rejects an unexpected writable submount at %s', name => {
    const k = kernel(); k.values['/proc/self/mountinfo'] += `10 2 8:1 / ${name} rw - ext4 /dev/root rw\n`;
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow('isolation');
  });
  it.each(['missing', 'malformed', 'oversized', 'ambiguous', 'superblock', 'symlink'])('rejects unavailable or inconsistent mount facts: %s', kind => {
    const k = kernel();
    if (kind === 'missing') k.values['/proc/self/mountinfo'] = '';
    if (kind === 'malformed') k.values['/proc/self/mountinfo'] = 'invalid';
    if (kind === 'oversized') k.values['/proc/self/mountinfo'] = 'x'.repeat(262145);
    if (kind === 'ambiguous') k.values['/proc/self/mountinfo'] += '10 2 8:1 / /home ro - ext4 /dev/root rw\n';
    if (kind === 'superblock') k.values['/proc/self/mountinfo'] = k.values['/proc/self/mountinfo'].replace(/ext4 \/dev\/root rw/g, 'ext4 /dev/root ro');
    if (kind === 'symlink') k.io.realpathSync = name => name === '/home' ? '/elsewhere' : name;
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow('isolation');
  });
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
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow('isolation');
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
  it('ends an active journal scan at the first absent record and observes concurrent appends on the next poll', () => {
    const initial = { phase: 'inspect', at: 10 }, appended = [{ phase: 'startup', at: 11 }, { phase: 'requests', at: 12 }];
    const records = new Map([['phase-00.json', initial]]);
    const io = { existsSync: jest.fn(filename => {
      const name = path.basename(filename), exists = records.has(name);
      if (name === 'phase-01.json' && !exists) {
        records.set('phase-01.json', appended[0]); records.set('phase-02.json', appended[1]);
      }
      return exists;
    }) }, read = jest.fn(filename => records.get(path.basename(filename)));
    const first = tool.readPhases('/scratch', 'hash', [], io, read);
    expect(first).toEqual([initial]); expect(read).toHaveBeenCalledTimes(1);
    expect(io.existsSync).not.toHaveBeenCalledWith(path.join('/scratch', 'phase-02.json'));
    expect(tool.readPhases('/scratch', 'hash', first, io, read)).toEqual([initial, ...appended]);
  });
  it.each([0, 1, 4])('rejects a final journal gap at index %i after the producer stops', missing => {
    const records = new Map(['inspect', 'startup', 'requests', 'cleanup', 'recheck', 'complete']
      .map((phase, i) => [`phase-0${i}.json`, { phase, at: 10 + i }]));
    records.delete(`phase-0${missing}.json`);
    const io = { existsSync: filename => records.has(path.basename(filename)) }, read = filename => records.get(path.basename(filename));
    expect(() => tool.readPhases('/scratch', 'hash', [], io, read, true)).toThrow('report_schema');
  });
  it.each([false, true])('rejects mutated and disappearing observed prefixes with terminal=%s', terminal => {
    const previous = [{ phase: 'inspect', at: 10 }], filename = path.join('/scratch', 'phase-00.json');
    for (const value of [null, { phase: 'inspect', at: 11 }, { phase: 'startup', at: 10 }]) {
      const io = { existsSync: name => name === filename && value !== null }, read = () => value;
      expect(() => tool.readPhases('/scratch', 'hash', previous, io, read, terminal)).toThrow('report_schema');
    }
  });
  it('accepts an unloaded completed transient unit only after checking the cgroup is absent', async () => {
    const run = jest.fn().mockRejectedValueOnce({ code: 'child_exit' }).mockResolvedValueOnce(Buffer.alloc(0));
    const io = { statSync: jest.fn(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }) };
    expect(await tool.stopService(config(), run, io)).toBe(true); expect(io.statSync).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(2);
  });
  it.each(['absent', 'empty', 'populated', 'permission'])('checks the cgroup after a unit unloads between list and show: %s', async state => {
    const run = jest.fn().mockResolvedValueOnce(Buffer.alloc(0)).mockResolvedValueOnce(Buffer.from('unit row'))
      .mockResolvedValueOnce(lines({ LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead' }));
    const io = { statSync: jest.fn(() => {
      if (state === 'absent' || state === 'permission') throw Object.assign(new Error(state), { code: state === 'absent' ? 'ENOENT' : 'EACCES' });
      return { isDirectory: () => true };
    }), readFileSync: jest.fn(() => state === 'empty' ? 'populated 0\n' : 'populated 1\n') };
    const result = tool.stopService(config(), run, io);
    if (state === 'absent' || state === 'empty') await expect(result).resolves.toBe(true);
    else await expect(result).rejects.toThrow('cleanup');
    const group = '/sys/fs/cgroup/system.slice/' + config().unit;
    expect(io.statSync).toHaveBeenCalledWith(group); expect(run).toHaveBeenCalledTimes(3);
    if (state === 'empty' || state === 'populated') expect(io.readFileSync).toHaveBeenCalledWith(path.join(group, 'cgroup.events'), 'utf8');
    else expect(io.readFileSync).not.toHaveBeenCalled();
  });
  it.each([
    { LoadState: 'loaded', ActiveState: 'active', SubState: 'running' },
    { LoadState: 'not-found', ActiveState: 'active', SubState: 'running' },
    { LoadState: 'not-found', ActiveState: 'inactive', SubState: 'running' },
    { LoadState: 'not-found', ActiveState: 'failed', SubState: 'failed' },
    { LoadState: 'error', ActiveState: 'inactive', SubState: 'dead' },
  ])('rejects active or inconsistent unit metadata before checking the cgroup %#', async values => {
    const run = jest.fn().mockResolvedValueOnce(Buffer.alloc(0)).mockResolvedValueOnce(Buffer.from('unit row')).mockResolvedValueOnce(lines(values));
    const io = { statSync: jest.fn(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }) };
    await expect(tool.stopService(config(), run, io)).rejects.toThrow('cleanup'); expect(io.statSync).not.toHaveBeenCalled();
  });
  it.each(['child_exit', 'deadline', 'EACCES'])('propagates a show-command failure instead of treating it as an unloaded unit: %s', async code => {
    const error = Object.assign(new Error('metadata'), { code });
    const run = jest.fn().mockResolvedValueOnce(Buffer.alloc(0)).mockResolvedValueOnce(Buffer.from('unit row')).mockRejectedValueOnce(error);
    const io = { statSync: jest.fn() };
    await expect(tool.stopService(config(), run, io)).rejects.toBe(error); expect(io.statSync).not.toHaveBeenCalled();
  });
  it.each(['LoadState=not-found\nActiveState=inactive\n', 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nLoadState=not-found\n'])('rejects malformed unloaded metadata %#', async value => {
    const run = jest.fn().mockResolvedValueOnce(Buffer.alloc(0)).mockResolvedValueOnce(Buffer.from('unit row')).mockResolvedValueOnce(Buffer.from(value));
    const io = { statSync: jest.fn() };
    await expect(tool.stopService(config(), run, io)).rejects.toThrow('isolation'); expect(io.statSync).not.toHaveBeenCalled();
  });
  it.each(['populated', 'active', 'permission', 'timeout'])('does not claim service cleanup for %s', kind => {
    const run = jest.fn().mockResolvedValueOnce(Buffer.alloc(0)).mockResolvedValueOnce(Buffer.from('unit row'))
      .mockResolvedValueOnce(lines({ LoadState: 'loaded', ActiveState: kind === 'active' ? 'active' : 'inactive', SubState: kind === 'active' ? 'running' : 'dead' }));
    if (kind === 'timeout') run.mockReset().mockRejectedValue({ code: 'deadline' });
    const io = { statSync: () => { if (kind === 'permission') throw Object.assign(new Error('denied'), { code: 'EACCES' }); return { isDirectory: () => true }; }, readFileSync: () => 'populated 1\n' };
    return expect(tool.stopService(config(), run, io)).rejects.toThrow('cleanup');
  });
  it.each([null, 'input.json', 'ready.json', 'release.json', 'progress-07.json', 'phase-00.json', 'phase-05.json', 'runtime.json'])('verifies terminal evidence and reports pending cleanup separately for %s', async pending => {
    const h = harness();
    h.onTick(() => {
      if (h.releaseAt === null) return;
      for (const [i, phase] of ['inspect', 'startup', 'requests', 'cleanup', 'recheck', 'complete'].entries()) h.records.set(`phase-0${i}.json`, { inputHash: h.hash, phase, at: h.releaseAt + i });
      for (let i = 0; i < 8; i++) h.records.set(`progress-0${i}.json`, { inputHash: h.hash, runtime: progress(i) });
      h.records.set('runtime.json', { inputHash: h.hash, runtime: { ...progress(7), stage: 'complete', cases: cases(), sourceUnchanged: true, compiledUnchanged: true,
        descriptorsRestored: true, serverClosed: true, nextClosed: true } });
      if (pending) h.records.set('.pending-' + pending, {});
      h.finish();
    });
    const result = await h.run(); expect(result).toMatchObject({ failure: pending ? 'cleanup' : null, serviceStopped: true, accounting: 'known',
      runtime: { stage: 'complete', failure: null } });
    expect(result.runtime.attempted).toBe(6); expect(result.runtime.cases).toHaveLength(6);
    expect(h.ops.stop).toHaveBeenCalledTimes(1); expect(h.signals.listenerCount('SIGTERM')).toBe(0);
  });
  it.each([[1, 'http'], [1, 'cleanup']])('retains exact terminal attempts %i after journaled intent and %s', async (attempted, failure) => {
    const h = harness();
    h.onTick(() => {
      if (h.releaseAt === null) return;
      for (const [i, phase] of ['inspect', 'startup', 'requests', 'cleanup', 'stopped'].entries()) h.records.set(`phase-0${i}.json`, { inputHash: h.hash, phase, at: h.releaseAt + i });
      for (let i = 0; i <= 2; i++) h.records.set(`progress-0${i}.json`, { inputHash: h.hash, runtime: progress(i) });
      h.records.set('runtime.json', { inputHash: h.hash, runtime: { ...progress(2), attempted, stage: 'cleanup', failure,
        descriptorsRestored: true, serverClosed: failure !== 'cleanup', nextClosed: true } }); h.finish();
    });
    expect(await h.run()).toMatchObject({ failure, accounting: 'known', runtime: { attempted, cases: [] } });
  });
  it.each([0, 1, 3])('rejects terminal attempts %i that disagree with committed intent', async attempted => {
    const h = harness();
    h.onTick(() => {
      if (h.releaseAt === null) return;
      for (const [i, phase] of ['inspect', 'startup', 'requests', 'cleanup', 'stopped'].entries()) h.records.set(`phase-0${i}.json`, { inputHash: h.hash, phase, at: h.releaseAt + i });
      for (let i = 0; i <= 3; i++) h.records.set(`progress-0${i}.json`, { inputHash: h.hash, runtime: progress(i) });
      h.records.set('runtime.json', { inputHash: h.hash, runtime: { ...progress(3), attempted, cases: cases().slice(0, Math.min(attempted, 2)),
        stage: 'cleanup', failure: 'http', descriptorsRestored: true, serverClosed: true, nextClosed: true } }); h.finish();
    });
    expect(await h.run()).toMatchObject({ failure: 'report_schema', accounting: 'last_attempt_uncertain', runtime: { attempted: 2 } });
  });
  it.each([false, true])('validates the final journal after producer exit, including records beyond a gap: %s', gap => {
    const h = harness();
    h.onTick(() => {
      if (h.releaseAt === null) return;
      for (const [i, phase] of ['inspect', 'stopped'].entries()) h.records.set(`phase-0${i}.json`, { inputHash: h.hash, phase, at: h.releaseAt + i });
      if (gap) h.records.set('phase-03.json', { inputHash: h.hash, phase: 'stopped', at: h.releaseAt + 2 });
      h.records.set('progress-00.json', { inputHash: h.hash, runtime: progress(0) });
      h.records.set('runtime.json', { inputHash: h.hash, runtime: { ...progress(0), stage: 'inspect', failure: 'source_content' } });
      h.finish();
    });
    return expect(h.run()).resolves.toMatchObject({ failure: gap ? 'report_schema' : 'source_content', serviceStopped: true });
  });
  it('does not launch when the owned name is already reserved', async () => {
    const h = harness(); h.ops.run.mockResolvedValue(Buffer.from('existing unit'));
    expect(await h.run()).toMatchObject({ failure: 'reservation', serviceStopped: null, runtime: null, accounting: 'unknown' });
    expect(h.ops.stop).not.toHaveBeenCalled(); expect(h.ops.run).toHaveBeenCalledTimes(1);
  });
  it.each([{ PrivateNetwork: 'no' }, { ProtectHome: 'no' }, { ProtectHome: undefined }, { ReadWritePaths: '/scratch /app' }])('does not release a child after service readback fails %#', async change => {
    const h = harness(), original = h.ops.run.getMockImplementation();
    const values = { ...properties(), ...change }; if (values.ProtectHome === undefined) delete values.ProtectHome;
    h.ops.run.mockImplementation((command, args, options) => args.includes('show') ? Promise.resolve(lines(values)) : original(command, args, options));
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
  it.each(['transition', 'stall', 'future', 'total'])('uses the scan-start phase clock while retaining post-scan checks: %s', async kind => {
    const h = harness(), exists = h.ops.fs.existsSync, read = h.ops.read.getMockImplementation();
    let scanned = false, nextPoll = false, observedTransition = false;
    h.ops.read.mockImplementation((name, hash, keys) => {
      if (path.basename(name) === 'phase-01.json') observedTransition = true;
      return read(name, hash, keys);
    });
    h.ops.fs.existsSync = name => {
      const found = exists(name);
      if (path.basename(name) === 'phase-01.json' && !found && !scanned && h.records.has('phase-00.json')) {
        scanned = true; h.advance(kind === 'total' ? 360000 : 100);
        if (kind === 'transition' || kind === 'future') h.records.set('phase-01.json', { inputHash: h.hash, phase: 'startup', at: h.releaseAt + (kind === 'future' ? 120200 : 119999) });
      }
      return found;
    };
    h.onTick(() => {
      if (scanned) { nextPoll = true; if (kind === 'transition' && observedTransition) h.signals.emit('SIGTERM'); return; }
      h.records.set('phase-00.json', { inputHash: h.hash, phase: 'inspect', at: h.releaseAt }); h.advance(119899);
    });
    expect(await h.run()).toMatchObject({ failure: kind === 'transition' ? 'cancelled' : kind === 'future' ? 'report_schema' : 'deadline', serviceStopped: true });
    expect(nextPoll).toBe(kind !== 'total');
    if (kind === 'transition') expect(observedTransition).toBe(true);
  });
  it('accepts a phase timestamp published during the scan', async () => {
    const h = harness(), read = h.ops.read.getMockImplementation();
    h.records.set('phase-00.json', { inputHash: h.hash, phase: 'inspect', at: 1001 });
    h.ops.read.mockImplementation((name, hash, keys) => { if (path.basename(name) === 'phase-00.json') h.advance(1); return read(name, hash, keys); });
    h.onTick(() => h.signals.emit('SIGTERM'));
    expect(await h.run()).toMatchObject({ failure: 'cancelled', serviceStopped: true });
  });
  it('handles cancellation with owned-service cleanup and removes listeners', async () => {
    const h = harness(); h.onTick(() => h.signals.emit('SIGTERM'));
    expect(await h.run()).toMatchObject({ failure: 'cancelled', serviceStopped: true }); expect(h.signals.listenerCount('SIGTERM')).toBe(0);
  });
  it.each(['absent', 'empty', 'unloaded', 'loaded', 'active', 'failed', 'populated', 'metadata-error', 'permission'])('rechecks owned resources after launcher settlement: %s', async state => {
    jest.useFakeTimers();
    try {
      const h = harness(), original = h.ops.run.getMockImplementation(), checks = [];
      let stopping = false, settled = false;
      h.ops.run.mockImplementation(async (command, args, options) => {
        if (args[1] === 'systemd-run') { const value = await original(command, args, options); settled = true; return value; }
        if (stopping) {
          checks.push({ settled, timeoutMs: options.timeoutMs });
          if (state === 'metadata-error') throw Object.assign(new Error('metadata'), { code: 'child_exit' });
          if (args.includes('list-units')) return Buffer.from(['loaded', 'unloaded', 'active', 'failed'].includes(state) ? 'unit row' : '');
          return lines({ LoadState: state === 'unloaded' ? 'not-found' : 'loaded', ActiveState: state === 'active' ? 'active' : state === 'failed' ? 'failed' : 'inactive',
            SubState: state === 'active' ? 'running' : state === 'failed' ? 'failed' : 'dead' });
        }
        return original(command, args, options);
      });
      h.ops.stop.mockImplementation(async () => { stopping = true; return true; });
      h.ops.fs.statSync.mockImplementation(() => {
        if (state === 'absent' || state === 'unloaded' || state === 'permission') throw Object.assign(new Error(state), { code: state === 'permission' ? 'EACCES' : 'ENOENT' });
        return { isDirectory: () => true };
      });
      h.ops.fs.readFileSync = jest.fn(() => state === 'populated' ? 'populated 1\n' : 'populated 0\n');
      h.onTick(() => h.signals.emit('SIGTERM'));
      const pending = h.run(); await jest.advanceTimersByTimeAsync(0);
      expect(h.ops.stop).toHaveBeenCalledTimes(1); expect(checks).toEqual([]);
      h.advance(4000); h.finish();
      const valid = ['absent', 'empty', 'unloaded', 'loaded'].includes(state);
      expect(await pending).toMatchObject({ failure: valid ? 'cancelled' : 'cleanup', serviceStopped: valid });
      expect(checks.length).toBeGreaterThan(0); expect(checks.every(check => check.settled && check.timeoutMs === 1000)).toBe(true);
      if (valid || state === 'populated' || state === 'permission') expect(h.ops.fs.statSync).toHaveBeenCalledWith('/sys/fs/cgroup/system.slice/' + config().unit);
      expect(h.signals.listenerCount('SIGTERM')).toBe(0);
    } finally { jest.useRealTimers(); }
  });
  it('keeps cleanup failed when the launcher cannot settle within five seconds', async () => {
    jest.useFakeTimers();
    try {
      const h = harness(); h.onTick(() => h.signals.emit('SIGTERM')); h.ops.stop.mockResolvedValue(true);
      const pending = h.run(); await jest.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({ failure: 'cleanup', serviceStopped: false });
      expect(h.ops.fs.statSync).not.toHaveBeenCalled(); expect(h.signals.listenerCount('SIGTERM')).toBe(0); h.finish();
    } finally { jest.useRealTimers(); }
  });
  it('bounds a stalled final metadata check by the remaining launcher settlement allowance', async () => {
    jest.useFakeTimers();
    try {
      const h = harness(), original = h.ops.run.getMockImplementation(), checks = [];
      let stopping = false;
      h.ops.run.mockImplementation((command, args, options) => {
        if (stopping) { checks.push(options.timeoutMs); return new Promise(() => {}); }
        return original(command, args, options);
      });
      h.ops.stop.mockImplementation(async () => { stopping = true; return true; }); h.onTick(() => h.signals.emit('SIGTERM'));
      const pending = h.run(); await jest.advanceTimersByTimeAsync(0);
      h.advance(4000); h.finish(); await jest.advanceTimersByTimeAsync(0);
      expect(checks).toEqual([1000]); h.advance(1000); await jest.advanceTimersByTimeAsync(1000);
      expect(await pending).toMatchObject({ failure: 'cleanup', serviceStopped: false });
      expect(h.ops.fs.statSync).not.toHaveBeenCalled(); expect(h.signals.listenerCount('SIGTERM')).toBe(0);
    } finally { jest.useRealTimers(); }
  });
  it.each(['stopped', 'unloaded', 'child-exit', 'populated', 'stop-error', 'expired'])('retries one late owned-service stop within the final deadline: %s', async state => {
    const h = harness(), original = h.ops.run.getMockImplementation(), checks = []; let stopping = false, retried = false;
    h.ops.stop.mockImplementation(async () => { stopping = true; h.finish(); return true; });
    h.ops.run.mockImplementation(async (command, args, options) => {
      if (!stopping) return original(command, args, options);
      checks.push({ args, timeoutMs: options.timeoutMs });
      if (args.includes('stop')) {
        expect(args).toEqual(['-n', 'systemctl', 'stop', config().unit]); retried = true; h.advance(state === 'expired' ? 4900 : 100);
        if (state === 'stop-error' || state === 'child-exit') throw Object.assign(new Error('stop'), { code: state === 'child-exit' ? 'child_exit' : 'deadline' });
        return Buffer.alloc(0);
      }
      if (args.includes('list-units')) return Buffer.from(retried && ['unloaded', 'child-exit'].includes(state) ? '' : 'unit row');
      if (!retried) h.advance(100);
      return lines({ LoadState: 'loaded', ActiveState: retried ? 'inactive' : 'active', SubState: retried ? 'dead' : 'running' });
    });
    h.ops.fs.statSync.mockReturnValue({ isDirectory: () => true });
    h.ops.fs.readFileSync = jest.fn(() => state === 'populated' ? 'populated 1\n' : 'populated 0\n');
    h.onTick(() => h.signals.emit('SIGTERM'));
    const valid = ['stopped', 'unloaded', 'child-exit'].includes(state);
    expect(await h.run()).toMatchObject({ failure: valid ? 'cancelled' : 'cleanup', serviceStopped: valid });
    expect(checks.filter(check => check.args.includes('stop'))).toHaveLength(1);
    expect(checks.every(check => check.timeoutMs > 0 && check.timeoutMs <= 5000)).toBe(true);
    if (valid || state === 'populated') {
      expect(h.ops.fs.readFileSync).toHaveBeenCalledWith(path.join('/sys/fs/cgroup/system.slice/' + config().unit, 'cgroup.events'), 'utf8');
      expect(checks.at(-1).timeoutMs).toBe(4800);
    }
  });
  it('records cleanup failure when the final cgroup check consumes the deadline', async () => {
    const h = harness(); h.onTick(() => h.signals.emit('SIGTERM'));
    h.ops.fs.statSync.mockImplementation(() => { h.advance(5000); return { isDirectory: () => true }; });
    h.ops.fs.readFileSync = () => 'populated 0\n';
    expect(await h.run()).toMatchObject({ failure: 'cleanup', serviceStopped: false });
    expect(h.signals.listenerCount('SIGTERM')).toBe(0);
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
  it('preserves the original failure for an unpublished pending file', async () => {
    const h = harness();
    h.onTick(() => { h.records.set('.pending-phase-00.json', {}); h.signals.emit('SIGTERM'); });
    expect(await h.run()).toMatchObject({ failure: 'cancelled', serviceStopped: true, runtime: null, accounting: 'unknown' });
  });
  it.each([0, 1, 2, 3, 7])('recovers progress through slot %i without claiming its last request intent started', async last => {
    const h = harness();
    h.onTick(() => {
      for (let i = 0; i <= last; i++) h.records.set(`progress-0${i}.json`, { inputHash: h.hash, runtime: progress(i) });
      h.signals.emit('SIGTERM');
    });
    const result = await h.run();
    expect(result).toMatchObject({ failure: 'cancelled', accounting: last < 2 ? 'known' : 'last_attempt_uncertain', runtime: { attempted: Math.max(0, last - 1) } });
    expect(result.runtime.cases).toHaveLength(Math.max(0, last - 2));
  });
});
