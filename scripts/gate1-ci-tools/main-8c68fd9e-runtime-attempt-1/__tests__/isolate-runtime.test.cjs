'use strict';
/* global describe, it, expect, jest, Buffer */

/** Pure service metadata and simulated manager/child exchanges; no systemd or child process is invoked. */
const path = require('node:path');
const { EventEmitter } = require('node:events');
const tool = require('../isolate-runtime.cjs');
const probe = require('../runtime-probe.cjs');
const staticInspector = require('../../main-8c68fd9e-static-attempt-1/inspect-compiled.cjs');
const base = require('../../main-8c68fd9e-static-attempt-1/qualify-static.cjs');

// Independent expected identifiers: each fixture mutates one effective property, never the implementation map.
const SERVICE_FAILURES = [
  ['PrivateNetwork', 'isolation_service_private_network'],
  ['PrivateTmp', 'isolation_service_private_tmp'],
  ['NoNewPrivileges', 'isolation_service_no_new_privileges'],
  ['ProtectSystem', 'isolation_service_protect_system'],
  ['ProtectHome', 'isolation_service_protect_home'],
  ['ProtectControlGroups', 'isolation_service_protect_control_groups'],
  ['CapabilityBoundingSet', 'isolation_service_capability_bounding_set'],
  ['AmbientCapabilities', 'isolation_service_ambient_capabilities'],
  ['RestrictAddressFamilies', 'isolation_service_restrict_address_families'],
  ['RestrictNamespaces', 'isolation_service_restrict_namespaces'],
  ['MemoryMax', 'isolation_service_memory_max'],
  ['MemorySwapMax', 'isolation_service_memory_swap_max'],
  ['TasksMax', 'isolation_service_tasks_max'],
  ['KillMode', 'isolation_service_kill_mode'],
  ['SendSIGKILL', 'isolation_service_send_sigkill'],
  ['Restart', 'isolation_service_restart'],
  ['LimitCORE', 'isolation_service_limit_core'],
  ['CollectMode', 'isolation_service_collect_mode'],
  ['User', 'isolation_service_user'],
  ['Group', 'isolation_service_group'],
  ['ActiveState', 'isolation_service_active_state'],
  ['SubState', 'isolation_service_sub_state'],
  ['LoadState', 'isolation_service_load_state'],
  ['Type', 'isolation_service_type'],
  ['ControlGroup', 'isolation_service_control_group'],
  ['CPUQuotaPerSecUSec', 'isolation_service_cpu_quota'],
  ['RuntimeMaxUSec', 'isolation_service_runtime_max'],
  ['TimeoutStopUSec', 'isolation_service_timeout_stop'],
  ['TimeoutStartUSec', 'isolation_service_timeout_start'],
  ['WorkingDirectory', 'isolation_service_working_directory'],
  ['ReadOnlyPaths', 'isolation_service_read_only_paths'],
  ['ReadWritePaths', 'isolation_service_read_write_paths'],
];

/** Bind all mocked service facts to one concrete Linux configuration. */
function config() { return { app: '/app', scratch: '/scratch', tooling: '/tools', node: '/node/bin/node', uid: 1001, gid: 1001, seconds: 360, unit: 'gate1-runtime-123-1.service' }; }

/** Independent fixture for systemd 255's property display, including significant empty values. */
function properties(c = config()) {
  return { ...tool.PROPERTIES, CollectMode: 'inactive-or-failed', ProtectHome: 'read-only', User: '1001', Group: '1001', LoadState: 'loaded', Type: 'exec', ActiveState: 'active', SubState: 'running',
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
  const mounts = ['/', '/home', '/root', '/run/user', c.app, c.tooling, path.posix.dirname(c.node), c.scratch, `${c.app}/.next/cache`];
  values['/proc/self/mountinfo'] = mounts.map((name, i) => {
    const parent = name === '/' ? '/' : mounts.filter(candidate => candidate !== name && name.startsWith(candidate === '/' ? '/' : candidate + '/'))
      .sort((a, b) => b.length - a.length)[0];
    return `${i + 1} ${mounts.indexOf(parent) + 1} 8:1 / ${name} ${i < 7 ? 'ro' : 'rw'},relatime - ext4 /dev/root rw\n`;
  }).join('');
  const io = { readFileSync: name => values[name], readlinkSync: () => 'net:[2]', readdirSync: () => ['lo'], realpathSync: name => name,
    lstatSync: () => ({ isDirectory: () => true }) };
  return { values, io, input: { unit: c.unit, hostNamespace: 'net:[1]' }, root, config: c };
}

/** Append explicit ID/parent/path/mode rows to a mocked kernel; distinct devices keep superblock fixtures consistent. */
function mountFixture(rows, c = config()) {
  const k = kernel(c);
  k.values['/proc/self/mountinfo'] += rows.map(([id, parentId, name, mode = 'rw', superMode = 'rw', device = '8:1']) =>
    `${id} ${parentId} ${device} / ${name} ${mode},relatime - ext4 ${device === '8:1' ? '/dev/root' : '/dev/synthetic'} ${superMode}\n`).join('');
  return k;
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
    if (args.includes('list-units') || args.includes('list-jobs')) return Buffer.alloc(0);
    return lines(properties());
  });
  const stop = jest.fn(async () => { finish?.(Buffer.alloc(0)); return true; });
  const ops = { run, fs: io, read, write, stop, signals, now: () => time, uid: 1001, gid: 1001, tooling: '/tools', node: '/node/bin/node',
    pause: async () => { time += 100; tick(); } };
  return { records, hash, signals, ops, get releaseAt() { return releaseAt; }, get time() { return time; }, advance: ms => { time += ms; },
    onTick: fn => { tick = fn; }, finish: () => finish(Buffer.alloc(0)), fail: code => reject(Object.assign(new Error(code), { code })),
    run: () => tool.runIsolated('/app', '/scratch', { runId: '123', executionDigest: 'e'.repeat(64) }, { entries: [], routes: [] }, 360000, ops) };
}

/** Exercise real stopService with a failed child and virtual collection delay; all manager/filesystem effects stay mocked. */
function failedService(primaryFailure, collectAfter) {
  const h = harness(), checks = [];
  let launched = false, stoppedAt = null;
  delete h.ops.stop;
  h.ops.pause = jest.fn(async () => { h.advance(50); });
  h.ops.run.mockImplementation(async (_command, args, options) => {
    if (args[1] === 'systemd-run') {
      launched = true;
      h.records.set('runtime.json', { inputHash: h.hash, runtime: { ...probe.emptyRuntime(), failure: primaryFailure } });
      throw Object.assign(new Error('child_exit'), { code: 'child_exit' });
    }
    checks.push({ args, at: h.time, timeoutMs: options.timeoutMs });
    if (args.includes('stop')) { stoppedAt ??= h.time; return Buffer.alloc(0); }
    if (args.includes('list-units')) return Buffer.from(launched && (stoppedAt === null || h.time - stoppedAt < collectAfter) ? 'owned unit row\n' : '');
    if (args.includes('show')) return lines({ LoadState: 'loaded', ActiveState: 'failed', SubState: 'failed' });
    if (args.includes('list-jobs')) return Buffer.alloc(0);
    throw new Error('unexpected manager command');
  });
  return { h, checks, get stoppedAt() { return stoppedAt; } };
}

describe('isolation diagnostic regressions', () => {
  it.each(SERVICE_FAILURES)('attributes effective %s rejection to %s', (key, code) => {
    expect(tool.validateService(properties(), config())).toBe(true);
    expect(() => tool.validateService({ ...properties(), [key]: 'synthetic-private-value' }, config()))
      .toThrow(expect.objectContaining({ code, message: code }));
  });
  it('covers every requested service property with one distinct fixed identifier', () => {
    expect(SERVICE_FAILURES.map(([key]) => key).sort()).toEqual(tool.serviceNames().sort());
    expect(probe.SERVICE_CODES).toEqual(Object.fromEntries(SERVICE_FAILURES));
    expect(new Set(SERVICE_FAILURES.map(([, code]) => code)).size).toBe(32);
    expect(Object.isFrozen(probe.SERVICE_CODES)).toBe(true);
  });
  it.each([
    ['A=' + 'x'.repeat(16384), ['A'], 'isolation_service_metadata_size'],
    ['A=private\r\n', ['A'], 'isolation_service_metadata_encoding'],
    ['private', ['A'], 'isolation_service_metadata_format'],
    ['A=1\nA=2\n', ['A'], 'isolation_service_metadata_keys'],
    ['private=1\n', ['A'], 'isolation_service_metadata_keys'],
    ['A=1\n', ['A', 'B'], 'isolation_service_metadata_missing'],
  ])('classifies bounded property metadata %#', (value, allowed, code) => {
    expect(() => tool.parseProperties(Buffer.from(value), allowed)).toThrow(expect.objectContaining({ code, message: code }));
  });
  it('keeps configuration and direct property-shape failures distinct', () => {
    expect(() => tool.serviceArgs({ ...config(), uid: 0 })).toThrow(expect.objectContaining({ code: 'isolation_service_config' }));
    expect(() => tool.validateService({ ...properties(), arbitrary: 'private' }, config()))
      .toThrow(expect.objectContaining({ code: 'isolation_service_metadata_shape' }));
  });
  it.each([
    ['CPUQuotaPerSecUSec', 'isolation_service_cpu_quota'], ['RuntimeMaxUSec', 'isolation_service_runtime_max'],
    ['TimeoutStopUSec', 'isolation_service_timeout_stop'], ['TimeoutStartUSec', 'isolation_service_timeout_start'],
  ])('keeps malformed, out-of-range and incorrect %s durations property-specific', (key, code) => {
    for (const value of ['infinity', '7min', '1s']) {
      expect(() => tool.validateService({ ...properties(), [key]: value }, config())).toThrow(expect.objectContaining({ code }));
    }
  });
  it('preserves service short-circuit precedence before parsing later duration metadata', () => {
    const values = { ...properties(), User: 'private', CPUQuotaPerSecUSec: 'private' };
    expect(() => tool.validateService(values, config())).toThrow(expect.objectContaining({ code: 'isolation_service_user' }));
  });
  it.each([
    ['size', 'isolation_kernel_metadata_size'], ['namespace', 'isolation_network_namespace'], ['namespace-format', 'isolation_network_namespace'],
    ['interfaces', 'isolation_network_interfaces'], ['cgroup', 'isolation_cgroup_membership'], ['cpu', 'isolation_cpu_limit'],
    ['memory', 'isolation_memory_limit'], ['swap', 'isolation_swap_limit'], ['tasks', 'isolation_tasks_limit'],
    ['NoNewPrivs', 'isolation_no_new_privileges'], ['CapEff', 'isolation_effective_capabilities'],
    ['CapBnd', 'isolation_bounding_capabilities'], ['Seccomp', 'isolation_seccomp'],
  ])('identifies the kernel %s check as %s', (kind, code) => {
    const k = kernel();
    if (kind === 'size') k.values['/proc/self/cgroup'] = 'x'.repeat(16385);
    if (kind === 'namespace') k.io.readlinkSync = () => 'net:[1]';
    if (kind === 'namespace-format') k.io.readlinkSync = () => 'private';
    if (kind === 'interfaces') k.io.readdirSync = () => ['lo', 'eth0'];
    if (kind === 'cgroup') k.values['/proc/self/cgroup'] = '0::/private';
    if (kind === 'cpu') k.values[k.root + '/cpu.max'] = 'max 100000';
    if (kind === 'memory') k.values[k.root + '/memory.max'] = 'max';
    if (kind === 'swap') k.values[k.root + '/memory.swap.max'] = '1';
    if (kind === 'tasks') k.values[k.root + '/pids.max'] = 'max';
    if (['NoNewPrivs', 'CapEff', 'CapBnd', 'Seccomp'].includes(kind)) {
      k.values['/proc/self/status'] = k.values['/proc/self/status'].split('\n').filter(line => !line.startsWith(kind + ':')).join('\n');
    }
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code, message: code }));
  });
  it.each([
    ['file', 'isolation_path_run_user'], ['permission', 'isolation_path_run_user'], ['symlink', 'isolation_path_canonical'],
    ['empty', 'isolation_mount_table_input'], ['oversized', 'isolation_mount_table_input'], ['format', 'isolation_mount_table_format'],
    ['mount-options', 'isolation_mount_options'], ['super-options', 'isolation_mount_options'], ['missing', 'isolation_mount_missing'],
    ['run-user-parent', 'isolation_mount_run_user'], ['ambiguous', 'isolation_mount_ambiguous'], ['mode', 'isolation_mount_mode'],
    ['descendant', 'isolation_mount_descendant'],
  ])('identifies the mount/path %s check as %s', (kind, code) => {
    const k = kernel(), file = '/proc/self/mountinfo';
    if (kind === 'file') k.io.lstatSync = () => ({ isDirectory: () => false });
    if (kind === 'permission') k.io.lstatSync = () => { throw Object.assign(new Error('synthetic-private-value'), { code: 'EACCES' }); };
    if (kind === 'symlink') k.io.realpathSync = name => name === '/home' ? '/private' : name;
    if (kind === 'empty') k.values[file] = '';
    if (kind === 'oversized') k.values[file] = 'x'.repeat(262145);
    if (kind === 'format') k.values[file] = 'private';
    if (kind === 'mount-options') k.values[file] = k.values[file].replace('ro,relatime', 'ro,rw');
    if (kind === 'super-options') k.values[file] = k.values[file].replace('ext4 /dev/root rw', 'ext4 /dev/root ro,rw');
    if (kind === 'missing') k.values[file] = k.values[file].split('\n').filter(line => !line.includes(' / ro,') && !line.includes(' /home ro,')).join('\n');
    if (kind === 'run-user-parent') k.values[file] = k.values[file].split('\n').filter(line => !line.includes(' /run/user ')).join('\n');
    if (kind === 'ambiguous') k.values[file] += '10 2 8:1 / /home ro - ext4 /dev/root rw\n';
    if (kind === 'mode') k.values[file] = k.values[file].replace(' /home ro,', ' /home rw,');
    if (kind === 'descendant') k.values[file] += '10 2 8:1 / /home/private rw - ext4 /dev/root rw\n';
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code, message: code }));
  });
  it('keeps unexpected kernel I/O errors generic without inventing an observed check result', () => {
    const k = kernel(), error = Object.assign(new Error('synthetic-private-value'), { code: 'EACCES' });
    k.io.readlinkSync = () => { throw error; };
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(error);
    expect(probe.failureCode(error)).toBe('internal');
  });
  it.each([
    ['ready-deadline', 'isolation_ready_deadline'], ['ready-record', 'isolation_ready_record'],
    ['release-deadline', 'isolation_release_deadline'], ['release-race', 'isolation_release_race'],
  ])('stops before release for %s and retains only %s', async (kind, code) => {
    const h = harness(), original = h.ops.run.getMockImplementation();
    h.ops.run.mockImplementation(async (command, args, options) => {
      const result = original(command, args, options);
      if (args[1] === 'systemd-run') {
        if (kind === 'ready-deadline') h.records.delete('ready.json');
        if (kind === 'ready-record') h.records.set('ready.json', { inputHash: h.hash, kernelVerified: false });
      }
      if (args.includes('show')) {
        if (kind === 'release-deadline') h.advance(30000);
        if (kind === 'release-race') { h.finish(); await Promise.resolve(); }
      }
      return result;
    });
    expect(await h.run()).toEqual({ failure: code, serviceStopped: true, runtime: null, accounting: 'unknown' });
    expect(h.records.has('release.json')).toBe(false);
    expect(h.ops.stop).toHaveBeenCalledTimes(1);
  });
  it.each(['canonical', 'noncanonical', 'duplicate', 'unbound', 'extra', 'unknown', 'touched'])('trusts only canonical untouched bound child diagnostics: %s', async kind => {
    const h = harness(), original = h.ops.run.getMockImplementation();
    const record = { inputHash: h.hash, runtime: { ...probe.emptyRuntime(), failure: 'isolation_memory_limit' } };
    if (kind === 'unbound') record.inputHash = 'f'.repeat(64);
    if (kind === 'extra') record.private = 'synthetic-private-value';
    if (kind === 'unknown') record.runtime.failure = 'isolation_private_value';
    if (kind === 'touched') record.runtime.isolationVerified = true;
    let bytes = JSON.stringify(record, null, 2) + '\n';
    if (kind === 'noncanonical') bytes = JSON.stringify(record);
    if (kind === 'duplicate') bytes = bytes.replace('"failure":', '"failure": "isolation_memory_limit", "failure":');
    const bounded = jest.spyOn(base, 'readBounded').mockReturnValue(Buffer.from(bytes));
    const recordPath = jest.spyOn(probe, 'recordPath').mockImplementation((scratch, name) => path.join(scratch, name));
    h.ops.read = tool.readBoundRecord;
    h.ops.run.mockImplementation(async (command, args, options) => {
      if (args[1] === 'systemd-run') throw Object.assign(new Error('synthetic-private-value'), { code: 'child_exit' });
      return original(command, args, options);
    });
    try {
      const result = await h.run();
      expect(result).toEqual({ failure: kind === 'canonical' ? 'isolation_memory_limit' : 'child_exit', serviceStopped: true, runtime: null, accounting: 'unknown' });
      expect(JSON.stringify(result)).not.toContain('synthetic-private-value');
    } finally { bounded.mockRestore(); recordPath.mockRestore(); }
  });
  it.each([0, 150, 4950, 5000, 5050])('preserves specific diagnostics only when collection completes inside the unchanged bound: %s', async delay => {
    const { h } = failedService('isolation_memory_limit', delay);
    expect(await h.run()).toEqual({ failure: delay < 5000 ? 'isolation_memory_limit' : 'cleanup', serviceStopped: delay < 5000, runtime: null, accounting: 'unknown' });
    expect(h.records.has('release.json')).toBe(false);
  });
  it('identifies the effective service property without retaining its observed value', () => {
    expect(() => tool.validateService({ ...properties(), PrivateNetwork: 'synthetic-private-value' }, config()))
      .toThrow(expect.objectContaining({ code: 'isolation_service_private_network' }));
  });
  it('identifies the actual kernel memory guard', () => {
    const k = kernel(); k.values[k.root + '/memory.max'] = 'max';
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code: 'isolation_memory_limit' }));
  });
  it('retains a bound child diagnostic without turning unreleased accounting into zero', async () => {
    const { h } = failedService('isolation_memory_limit', 150);
    expect(await h.run()).toEqual({ failure: 'isolation_memory_limit', serviceStopped: true, runtime: null, accounting: 'unknown' });
  });
});

describe('same-path mount stacks', () => {
  it('accepts a read-only upper mount over a writable lower mount', () => {
    const k = kernel();
    k.values['/proc/self/mountinfo'] += '10 2 8:1 / /home/runner/example rw,relatime - ext4 /dev/root rw\n' +
      '11 10 8:1 / /home/runner/example ro,relatime - ext4 /dev/root rw\n';
    expect(tool.verifyKernel(k.input, k.io, k.config)).toBe(true);
  });
  it.each([
    [50, 70, 10], [50, 10, 70], [70, 50, 10], [70, 10, 50], [10, 50, 70], [10, 70, 50],
  ])('accepts three layers in row order %s / %s / %s with the smallest ID on top', (...order) => {
    const rows = { 50: [50, 2, '/home/runner/example'], 70: [70, 50, '/home/runner/example'], 10: [10, 70, '/home/runner/example', 'ro'] };
    const k = mountFixture(order.map(id => rows[id]));
    expect(tool.verifyKernel(k.input, k.io, k.config)).toBe(true);
  });
  it.each([
    ['two layers', [[10, 2, '/home/runner/example', 'ro'], [11, 10, '/home/runner/example']]],
    ['three layers', [[10, 2, '/home/runner/example'], [11, 10, '/home/runner/example', 'ro'], [12, 11, '/home/runner/example']]],
    ['upper row first', [[11, 10, '/home/runner/example'], [10, 2, '/home/runner/example', 'ro']]],
    ['uncovered mount', [[10, 2, '/home/runner/example']]],
  ])('rejects an exposed writable mount: %s', (_label, rows) => {
    const k = mountFixture(rows);
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code: 'isolation_mount_descendant' }));
  });
  it.each([
    ['per-mount', 'ro', 'rw'], ['superblock', 'rw', 'ro'], ['both', 'ro', 'ro'],
  ])('accepts effective read-only protection from %s flags', (_label, mode, superMode) => {
    const k = mountFixture([[10, 2, '/home/runner/example'], [11, 10, '/home/runner/example', mode, superMode, '8:2']]);
    expect(tool.verifyKernel(k.input, k.io, k.config)).toBe(true);
  });
  it('matches decoded paths when the raw kernel encodings differ', () => {
    const k = mountFixture([[10, 2, '/home/runner/escaped\\040path'], [11, 10, '/home/\\162unner/escaped\\040path', 'ro']]);
    expect(tool.verifyKernel(k.input, k.io, k.config)).toBe(true);
  });
  it.each(['self', 'outside-table'])('accepts the documented %s root-parent boundary', kind => {
    const k = mountFixture([[10, 2, '/home/runner/example'], [11, 10, '/home/runner/example', 'ro']]);
    if (kind === 'outside-table') k.values['/proc/self/mountinfo'] = k.values['/proc/self/mountinfo'].replace('1 1 8:1 / / ', '1 999 8:1 / / ');
    expect(tool.verifyKernel(k.input, k.io, k.config)).toBe(true);
  });
  it.each([
    ['unrelated rows', [[10, 2], [11, 2]]],
    ['disconnected extra row', [[10, 2], [11, 10], [12, 2]]],
    ['fork', [[10, 2], [11, 10], [12, 10]]],
    ['two-row cycle', [[10, 11], [11, 10]]],
    ['three-row cycle', [[10, 12], [11, 10], [12, 11]]],
    ['disconnected cycle', [[10, 2], [11, 10], [12, 13], [13, 12]]],
    ['non-root self-parent', [[10, 10], [11, 10]]],
    ['missing bottom parent', [[10, 999], [11, 10]]],
    ['unrelated bottom parent', [[10, 3], [11, 10]]],
  ])('does not exempt a writable row with an uncertain same-path relationship: %s', (_label, links) => {
    const k = mountFixture(links.map(([id, parentId], index) => [id, parentId, '/home/runner/example', index === 0 ? 'rw' : 'ro']));
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code: 'isolation_mount_descendant', message: 'isolation_mount_descendant' }));
  });
  it.each([
    ['missing ancestor', 999, '/home/runner'],
    ['self-parent ancestor', 12, '/home/runner'],
    ['cycle through another path', 10, '/home/runner'],
    ['sibling ancestor', 2, '/home/runner-other'],
    ['descendant ancestor', 2, '/home/runner/example/child'],
  ])('requires consistent known ancestry: %s', (_label, parentId, name) => {
    const k = mountFixture([[12, parentId, name, 'ro'], [10, 12, '/home/runner/example'], [11, 10, '/home/runner/example', 'ro']]);
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code: 'isolation_mount_descendant' }));
  });
  it('does not treat a chain through a different mountpoint as a same-path covering relationship', () => {
    const k = mountFixture([[10, 2, '/home/runner/example'], [12, 10, '/home/runner/example/child', 'ro'], [11, 12, '/home/runner/example', 'ro']]);
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code: 'isolation_mount_descendant' }));
  });
  it('rejects a root-parent link back into the descendant stack', () => {
    const k = mountFixture([[10, 2, '/home/runner/example'], [11, 10, '/home/runner/example', 'ro']]);
    k.values['/proc/self/mountinfo'] = k.values['/proc/self/mountinfo'].replace('1 1 8:1 / / ', '1 10 8:1 / / ');
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code: 'isolation_mount_descendant' }));
  });
  it.each(['0', '-1', '+10', '010', '1.0', '1e1', 'NaN', 'Infinity', '9007199254740992', '10x', ''])('rejects malformed or unsafe IDs: %s', invalid => {
    for (const field of [0, 1]) {
      const row = [10, 2, '/home/runner/example', 'ro']; row[field] = invalid;
      const k = mountFixture([row]);
      expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code: 'isolation_mount_table_format', message: 'isolation_mount_table_format' }));
    }
  });
  it.each([
    ['same path', [[10, 2, '/home/runner/example'], [10, 10, '/home/runner/example', 'ro']]],
    ['different path', [[10, 2, '/home/runner/example'], [10, 2, '/home/runner/other', 'ro']]],
    ['existing root ID', [[1, 2, '/home/runner/example', 'ro']]],
  ])('rejects duplicate IDs even when a row is read-only: %s', (_label, rows) => {
    const k = mountFixture(rows);
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code: 'isolation_mount_table_format' }));
  });
  it.each([10, 11])('still rejects a writable child attached to layer %s at a different path', parentId => {
    const k = mountFixture([[10, 2, '/home/runner/example'], [11, 10, '/home/runner/example', 'ro'], [12, parentId, '/home/runner/example/child']]);
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code: 'isolation_mount_descendant' }));
  });
  it.each(['/home', '/app', '/scratch', '/app/.next/cache', '/run/user'])('preserves covering-mount ambiguity at %s even for a proven stack', name => {
    const parentIds = { '/home': 2, '/app': 5, '/scratch': 8, '/app/.next/cache': 9, '/run/user': 4 };
    const k = mountFixture([[10, parentIds[name], name, 'ro']]);
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code: 'isolation_mount_ambiguous' }));
  });
  it('preserves missing /run/user own-mount rejection alongside a valid descendant stack', () => {
    const k = mountFixture([[10, 2, '/home/runner/example'], [11, 10, '/home/runner/example', 'ro']]);
    k.values['/proc/self/mountinfo'] = k.values['/proc/self/mountinfo'].split('\n').filter(line => !line.includes(' /run/user ')).join('\n');
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code: 'isolation_mount_run_user' }));
  });
  it('preserves nested scratch/cache write exceptions, their submounts and private temporary mounts', () => {
    const c = { ...config(), app: '/home/runner/app', scratch: '/home/runner/scratch', tooling: '/home/runner/tools', node: '/home/runner/node/bin/node' };
    const k = mountFixture([[10, 8, c.scratch + '/child'], [11, 9, c.app + '/.next/cache/child'], [12, 1, '/tmp'], [13, 1, '/var/tmp'],
      [14, 2, '/home/runner/example'], [15, 14, '/home/runner/example', 'ro']], c);
    expect(tool.verifyKernel(k.input, k.io, k.config)).toBe(true);
  });
  it.each(['/home/runner/app/.next/cache-other', '/home/runner/scratch-other'])('rejects an uncovered similarly named exception sibling: %s', name => {
    const c = { ...config(), app: '/home/runner/app', scratch: '/home/runner/scratch' };
    const k = mountFixture([[10, name.includes('/app/') ? 5 : 2, name]], c);
    expect(() => tool.verifyKernel(k.input, k.io, k.config)).toThrow(expect.objectContaining({ code: 'isolation_mount_descendant' }));
  });
});

describe('service creation and effective readback', () => {
  it('uses a private unprivileged service with strict resource and filesystem bounds, cleared environment and pipes', () => {
    const args = tool.serviceArgs(config());
    for (const value of ['--pipe', '--wait', '--service-type=exec', '--expand-environment=no', '--uid=1001', '--gid=1001', '--property=PrivateNetwork=yes',
      '--property=ProtectHome=read-only', '--property=MemoryMax=6442450944', '--property=MemorySwapMax=0', '--property=TasksMax=256', '--property=CPUQuota=400%', '--property=RuntimeMaxSec=360s',
      '--property=KillMode=control-group', '--property=Restart=no', '--property=ReadWritePaths=/scratch /app/.next/cache', '/usr/bin/env', '-i']) expect(args).toContain(value);
    expect(args).not.toContain('--scope'); expect(args.at(-3)).toBe('--child'); expect(args.some(value => /GITHUB_TOKEN|VERCEL_TOKEN|NODE_OPTIONS/.test(value))).toBe(false);
    expect(tool.serviceNames()).toContain('ProtectHome');
  });
  it('creates and independently verifies the explicit failed-unit collection policy', () => {
    expect(tool.serviceArgs(config()).filter(value => value.startsWith('--property=CollectMode='))).toEqual(['--property=CollectMode=inactive-or-failed']);
    expect(tool.serviceNames()).toContain('CollectMode');
    expect(tool.validateService(tool.parseProperties(lines(properties()), tool.serviceNames()), config())).toBe(true);
  });
  it.each([null, '', 'inactive', 'unknown'])('rejects missing or incorrect effective CollectMode: %s', value => {
    const values = properties();
    if (value === null) delete values.CollectMode;
    else values.CollectMode = value;
    expect(() => tool.validateService(tool.parseProperties(lines(values), tool.serviceNames()), config())).toThrow('isolation');
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
    const k = kernel(); k.values['/proc/self/mountinfo'] += `10 ${name.startsWith('/app/') ? 5 : 2} 8:1 / ${name} rw - ext4 /dev/root rw\n`;
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
    const run = jest.fn().mockResolvedValue(Buffer.alloc(0)).mockRejectedValueOnce({ code: 'child_exit' });
    const io = { statSync: jest.fn(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }) };
    expect(await tool.stopService(config(), run, io)).toBe(true); expect(io.statSync).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(3);
  });
  it.each(['absent', 'empty', 'populated', 'permission'])('checks the cgroup after a unit unloads between list and show: %s', async state => {
    const run = jest.fn().mockResolvedValueOnce(Buffer.alloc(0)).mockResolvedValueOnce(Buffer.from('unit row'))
      .mockResolvedValueOnce(lines({ LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead' })).mockResolvedValue(Buffer.alloc(0));
    const io = { statSync: jest.fn(() => {
      if (state === 'absent' || state === 'permission') throw Object.assign(new Error(state), { code: state === 'absent' ? 'ENOENT' : 'EACCES' });
      return { isDirectory: () => true };
    }), readFileSync: jest.fn(() => state === 'empty' ? 'populated 0\n' : 'populated 1\n') };
    const result = tool.stopService(config(), run, io);
    if (state === 'absent' || state === 'empty') await expect(result).resolves.toBe(true);
    else await expect(result).rejects.toThrow('cleanup');
    const group = '/sys/fs/cgroup/system.slice/' + config().unit;
    expect(io.statSync).toHaveBeenCalledWith(group); expect(run).toHaveBeenCalledTimes(4);
    if (state === 'empty' || state === 'populated') expect(io.readFileSync).toHaveBeenCalledWith(path.join(group, 'cgroup.events'), 'utf8');
    else expect(io.readFileSync).not.toHaveBeenCalled();
  });
  it.each([
    ['loaded', null], ['loaded', 'start waiting'], ['loaded', 'restart waiting'], ['loaded', 'start running'],
    ['unlisted', null], ['unlisted', 'start waiting'], ['unloaded', null], ['unloaded', 'start waiting'],
  ])('requires no owned job before accepting a %s unit with job=%s', async (state, job) => {
    const c = config(), jobs = [`31 unrelated.service start waiting`, ...(job ? [`32 ${c.unit} ${job}`] : [])];
    const run = jest.fn(async (_command, args) => {
      if (args.includes('list-units')) return Buffer.from(state === 'unlisted' ? '' : 'unit row');
      if (args.includes('show')) return lines({ LoadState: state === 'unloaded' ? 'not-found' : 'loaded', ActiveState: 'inactive', SubState: 'dead' });
      if (args.includes('list-jobs')) return Buffer.from(jobs.filter(row => row.split(' ')[1] === args.at(-1)).join('\n'));
      return Buffer.alloc(0);
    });
    const io = { statSync: jest.fn(() => ({ isDirectory: () => true })), readFileSync: jest.fn(() => 'populated 0\n') };
    if (job) await expect(tool.stopService(c, run, io)).rejects.toThrow('cleanup');
    else {
      await expect(tool.stopService(c, run, io)).resolves.toBe(true);
      expect(io.readFileSync).toHaveBeenCalledWith(path.join('/sys/fs/cgroup/system.slice/' + c.unit, 'cgroup.events'), 'utf8');
    }
    expect(run).toHaveBeenCalledWith('sudo', ['-n', 'systemctl', 'list-jobs', '--full', '--no-legend', '--no-pager', c.unit],
      expect.objectContaining({ capture: true, cap: 16384, timeoutMs: expect.any(Number) }));
  });
  it.each(['child_exit', 'deadline', 'stream_limit', 'EACCES'])('does not accept stopped service when listing jobs fails: %s', async code => {
    const error = Object.assign(new Error('jobs'), { code }), io = { statSync: jest.fn() };
    const run = jest.fn(async (_command, args) => { if (args.includes('list-jobs')) throw error; return Buffer.alloc(0); });
    await expect(tool.stopService(config(), run, io)).rejects.toBe(error);
    expect(io.statSync).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce(lines({ LoadState: 'loaded', ActiveState: kind === 'active' ? 'active' : 'inactive', SubState: kind === 'active' ? 'running' : 'dead' })).mockResolvedValue(Buffer.alloc(0));
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
  it.each(['isolation', 'node_version', 'dependency_version', 'persistence'])('retains validated pre-release %s while leaving accounting unknown', async failure => {
    const h = harness(), original = h.ops.run.getMockImplementation();
    h.ops.run.mockImplementation(async (command, args, options) => {
      if (args[1] !== 'systemd-run') return original(command, args, options);
      h.records.set('runtime.json', { inputHash: h.hash, runtime: { ...probe.emptyRuntime(), failure } });
      h.records.set('progress-00.json', { inputHash: h.hash, runtime: progress(0) }); // Unreleased progress is never request evidence.
      throw Object.assign(new Error('child_exit'), { code: 'child_exit' });
    });
    expect(await h.run()).toMatchObject({ failure, runtime: null, accounting: 'unknown', serviceStopped: true });
    expect(h.records.has('release.json')).toBe(false);
  });
  it.each(['missing', 'unbound', 'extra', 'category', 'success', 'released', 'requests'])('preserves child_exit for %s pre-release evidence', async variant => {
    const h = harness(), original = h.ops.run.getMockImplementation();
    h.ops.run.mockImplementation(async (command, args, options) => {
      if (args[1] !== 'systemd-run') return original(command, args, options);
      const record = { inputHash: h.hash, runtime: { ...probe.emptyRuntime(), failure: 'isolation' } };
      if (variant === 'unbound') record.inputHash = 'f'.repeat(64);
      if (variant === 'extra') record.extra = true;
      if (variant === 'category') record.runtime.failure = 'untrusted';
      if (variant === 'success') record.runtime.failure = null;
      if (variant === 'released') record.runtime.isolationVerified = true;
      if (variant === 'requests') record.runtime.attempted = 1;
      if (variant !== 'missing') h.records.set('runtime.json', record);
      throw Object.assign(new Error('child_exit'), { code: 'child_exit' });
    });
    expect(await h.run()).toMatchObject({ failure: 'child_exit', runtime: null, accounting: 'unknown', serviceStopped: true });
  });
  it.each(['valid', 'unbound', 'success', 'cleanup-overrun', 'total', 'phase-gap'])('recovers only stopped startup-timeout cleanup evidence: %s', async variant => {
    const h = harness();
    h.onTick(() => {
      const timings = [0, 1, 30001, variant === 'cleanup-overrun' ? 35001 : 30002];
      ['inspect', 'startup', 'cleanup', 'stopped'].forEach((phase, i) => {
        if (variant !== 'phase-gap' || i !== 2) h.records.set(`phase-0${i}.json`, { inputHash: h.hash, phase, at: h.releaseAt + timings[i] });
      });
      h.records.set('progress-00.json', { inputHash: h.hash, runtime: progress(0) });
      h.records.set('runtime.json', { inputHash: variant === 'unbound' ? 'f'.repeat(64) : h.hash, runtime: {
        ...progress(0), stage: 'cleanup', inspection: facts(), failure: variant === 'success' ? null : 'startup', descriptorsRestored: true, nextClosed: true,
      } });
      h.advance(variant === 'total' ? 360000 : 36000); h.finish();
    });
    const result = await h.run();
    expect(result).toMatchObject({ failure: variant === 'valid' ? 'startup' : 'deadline', accounting: 'known', serviceStopped: true });
    expect(result.runtime.descriptorsRestored).toBe(variant === 'valid' ? true : null);
    expect(result.runtime.nextClosed).toBe(variant === 'valid' ? true : null);
  });
  it.each([[{ PrivateNetwork: 'no' }, 'isolation_service_private_network'], [{ ProtectHome: 'no' }, 'isolation_service_protect_home'],
    [{ ProtectHome: undefined }, 'isolation_service_metadata_missing'], [{ ReadWritePaths: '/scratch /app' }, 'isolation_service_read_write_paths']])('does not release a child after service readback fails %#', async (change, failure) => {
    const h = harness(), original = h.ops.run.getMockImplementation();
    const values = { ...properties(), ...change }; if (values.ProtectHome === undefined) delete values.ProtectHome;
    h.ops.run.mockImplementation((command, args, options) => args.includes('show') ? Promise.resolve(lines(values)) : original(command, args, options));
    expect(await h.run()).toMatchObject({ failure, serviceStopped: true, accounting: 'unknown' });
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
  it.each([['isolation', 0], ['isolation', 150], ['dependency_version', 0], ['dependency_version', 150],
    ['isolation', 4950], ['isolation', 5000], ['isolation', 5050], ['isolation', Infinity]])(
    'preserves %s only after failed-unit collection within the deadline (%s ms)', async (primaryFailure, collectAfter) => {
      const f = failedService(primaryFailure, collectAfter), { h, checks } = f;
      const result = await h.run(), collected = collectAfter < 5000;
      expect(result).toEqual({ failure: collected ? primaryFailure : 'cleanup', serviceStopped: collected, runtime: null, accounting: 'unknown' });
      expect(h.time - f.stoppedAt).toBe(collected ? collectAfter : 5000);
      expect(h.ops.run.mock.calls.filter(([, args]) => args[1] === 'systemd-run')).toHaveLength(1);
      expect(checks.filter(check => check.args.includes('stop'))).toHaveLength(1);
      expect(checks.every(check => !check.args.includes('reset-failed') && check.timeoutMs > 0)).toBe(true);
      const polls = checks.filter(check => check.args.includes('list-units') && check.at > f.stoppedAt);
      expect(polls.length).toBe(collected ? collectAfter / 50 : 99);
      expect(polls.every(check => check.timeoutMs === 5000 - (check.at - f.stoppedAt))).toBe(true);
      expect(h.records.has('release.json')).toBe(false);
      expect(h.signals.listenerCount('SIGTERM')).toBe(0); expect(h.signals.listenerCount('SIGINT')).toBe(0);
    });
  it('also verifies an empty retained cgroup throughout failed-unit collection', async () => {
    const { h } = failedService('isolation', 150);
    h.ops.fs.statSync.mockReturnValue({ isDirectory: () => true });
    h.ops.fs.readFileSync = jest.fn(() => 'populated 0\n');
    expect(await h.run()).toEqual({ failure: 'isolation', serviceStopped: true, runtime: null, accounting: 'unknown' });
    expect(h.ops.fs.readFileSync.mock.calls.every(([name]) => name === path.join('/sys/fs/cgroup/system.slice/' + config().unit, 'cgroup.events'))).toBe(true);
    expect(h.ops.fs.readFileSync).toHaveBeenCalledTimes(5);
  });
  it('bounds a stalled collection pause and observes its late rejection', async () => {
    jest.useFakeTimers();
    try {
      const f = failedService('isolation', 150), { h } = f, pause = h.ops.pause.getMockImplementation();
      let rejectPause;
      h.ops.pause.mockImplementation(() => f.stoppedAt === null ? pause() : new Promise((_resolve, reject) => { rejectPause = reject; }));
      const pending = h.run(); await jest.advanceTimersByTimeAsync(0);
      expect(rejectPause).toEqual(expect.any(Function));
      const commands = h.ops.run.mock.calls.length;
      h.advance(5000); await jest.advanceTimersByTimeAsync(5000);
      expect(await pending).toEqual({ failure: 'cleanup', serviceStopped: false, runtime: null, accounting: 'unknown' });
      rejectPause(new Error('late pause rejection')); await jest.advanceTimersByTimeAsync(0);
      expect(h.ops.run).toHaveBeenCalledTimes(commands);
      expect(jest.getTimerCount()).toBe(0); expect(h.signals.listenerCount('SIGTERM')).toBe(0);
    } finally { jest.useRealTimers(); }
  });
  it.each(['populated', 'queued-job', 'metadata-error', 'permission'])('fails cleanup when %s appears while collection is pending', async fault => {
    const f = failedService('isolation', 150), { h } = f, original = h.ops.run.getMockImplementation();
    h.ops.run.mockImplementation((command, args, options) => {
      if (f.stoppedAt !== null && h.time > f.stoppedAt) {
        if (fault === 'metadata-error' && args.includes('show')) return Promise.reject(Object.assign(new Error('unavailable'), { code: 'child_exit' }));
        if (fault === 'queued-job' && args.includes('list-jobs')) return Promise.resolve(Buffer.from('owned job\n'));
      }
      return original(command, args, options);
    });
    h.ops.fs.statSync.mockImplementation(() => {
      if (fault === 'permission' && f.stoppedAt !== null && h.time > f.stoppedAt) throw Object.assign(new Error('unavailable'), { code: 'EACCES' });
      return { isDirectory: () => true };
    });
    h.ops.fs.readFileSync = jest.fn(() => fault === 'populated' && f.stoppedAt !== null && h.time > f.stoppedAt ? 'populated 1\n' : 'populated 0\n');
    expect(await h.run()).toEqual({ failure: 'cleanup', serviceStopped: false, runtime: null, accounting: 'unknown' });
    expect(h.time - f.stoppedAt).toBe(50);
    expect(h.ops.run.mock.calls.filter(([, args]) => args.includes('stop'))).toHaveLength(2);
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
          if (args.includes('list-jobs')) return Buffer.alloc(0);
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
      expect(checks.length).toBeGreaterThan(0); expect(checks[0].timeoutMs).toBe(1000);
      expect(checks.every(check => check.settled && check.timeoutMs > 0 && check.timeoutMs <= 1000)).toBe(true);
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
  it.each(['list-units', 'list-jobs'])('bounds stalled final %s by the remaining launcher settlement allowance', async query => {
    jest.useFakeTimers();
    try {
      const h = harness(), original = h.ops.run.getMockImplementation(), checks = [];
      let stopping = false;
      h.ops.run.mockImplementation((command, args, options) => {
        if (stopping) {
          if (args.includes(query)) { checks.push(options.timeoutMs); return new Promise(() => {}); }
          return Promise.resolve(Buffer.alloc(0));
        }
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
      if (args.includes('list-jobs')) return Buffer.alloc(0);
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
  it.each(['cleared', 'persistent', 'metadata-error'])('rechecks owned jobs after the bounded cleanup retry: %s', async state => {
    const h = harness(), original = h.ops.run.getMockImplementation(), jobChecks = []; let stopping = false, retried = false;
    h.ops.stop.mockImplementation(async () => { stopping = true; h.finish(); return true; });
    h.ops.run.mockImplementation(async (command, args, options) => {
      if (!stopping) return original(command, args, options);
      if (args.includes('stop')) { retried = true; return Buffer.alloc(0); }
      if (args.includes('list-units')) return Buffer.from('unit row');
      if (args.includes('show')) return lines({ LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead' });
      expect(args).toEqual(['-n', 'systemctl', 'list-jobs', '--full', '--no-legend', '--no-pager', config().unit]);
      jobChecks.push(options.timeoutMs); h.advance(100);
      if (state === 'metadata-error') throw Object.assign(new Error('jobs'), { code: 'child_exit' });
      return Buffer.from(retried && state === 'cleared' ? '' : `32 ${config().unit} start waiting\n`);
    });
    h.ops.fs.statSync.mockReturnValue({ isDirectory: () => true }); h.ops.fs.readFileSync = jest.fn(() => 'populated 0\n');
    h.onTick(() => h.signals.emit('SIGTERM'));
    expect(await h.run()).toMatchObject({ failure: state === 'cleared' ? 'cancelled' : 'cleanup', serviceStopped: state === 'cleared' });
    expect(h.ops.run.mock.calls.filter(([, args]) => args.includes('stop'))).toHaveLength(1);
    expect(jobChecks).toEqual([5000, 4900]);
    if (state === 'cleared') expect(h.ops.fs.readFileSync).toHaveBeenCalledWith(path.join('/sys/fs/cgroup/system.slice/' + config().unit, 'cgroup.events'), 'utf8');
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
