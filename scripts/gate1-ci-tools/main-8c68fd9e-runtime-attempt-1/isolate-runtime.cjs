'use strict';
/* global process, __dirname, setTimeout, AbortController */

/** One owned systemd service, verified before release; no Docker or host-wide firewall changes. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const base = require('../main-8c68fd9e-static-attempt-1/qualify-static.cjs');
const probe = require('./runtime-probe.cjs');
const { RuntimeError } = require('./inspect-runtime.cjs');
const MEMORY = 6442450944;
const PHASES = probe.PHASES;
const STOP_MS = 20000;
const PROPERTIES = Object.freeze({ PrivateNetwork: 'yes', PrivateTmp: 'yes', NoNewPrivileges: 'yes', ProtectSystem: 'strict', ProtectHome: 'read-only', ProtectControlGroups: 'yes',
  CapabilityBoundingSet: '', AmbientCapabilities: '', RestrictAddressFamilies: 'AF_INET AF_INET6', RestrictNamespaces: 'yes', MemoryMax: String(MEMORY), MemorySwapMax: '0', TasksMax: '256',
  KillMode: 'control-group', SendSIGKILL: 'yes', Restart: 'no', LimitCORE: '0' });

/** Validate the run identifier before deriving any service or cgroup name. */
function unitName(runId) {
  if (!/^[1-9]\d{0,14}$/.test(runId || '')) throw new RuntimeError('approval');
  return `gate1-runtime-${runId}-1.service`;
}

/** Extend the static synthetic environment explicitly, never forwarding hosted or Actions credentials. */
function environment(scratch) {
  return { ...base.childEnvironment(scratch), VERCEL: '1', VERCEL_ENV: 'preview', GATE1_RUNTIME_CHILD: '1',
    GATE1_MIDDLEWARE_RUNTIME_PROBE_ENABLED: 'true', GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET: 'a'.repeat(64) };
}

/** Build shell-free service arguments; only approved app/cache/scratch paths may be writable. */
function serviceArgs(config) {
  const { app, scratch, tooling, node, unit, uid, gid, seconds } = config;
  if (!/^gate1-runtime-[1-9]\d{0,14}-1\.service$/.test(unit) || !Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1 ||
      !Number.isInteger(seconds) || seconds < 1 || seconds > 360 || [app, scratch, tooling, node].some(value => typeof value !== 'string' || !value.startsWith('/') || /[\s%\\]/.test(value) ||
        [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || value.split('/').includes('..'))) throw new RuntimeError('isolation');
  return ['-n', 'systemd-run', '--quiet', '--wait', '--pipe', '--expand-environment=no', '--service-type=exec', `--unit=${unit}`, `--uid=${uid}`, `--gid=${gid}`,
    ...Object.entries(PROPERTIES).map(([key, value]) => `--property=${key}=${value}`), '--property=CPUQuota=400%', `--property=RuntimeMaxSec=${seconds}s`,
    '--property=TimeoutStopSec=5s', '--property=TimeoutStartSec=30s', `--property=WorkingDirectory=${app}`,
    `--property=ReadOnlyPaths=${app} ${tooling} ${path.posix.dirname(node)}`, `--property=ReadWritePaths=${scratch} ${app}/.next/cache`,
    '/usr/bin/env', '-i', ...Object.entries(environment(scratch)).map(([key, value]) => `${key}=${value}`), node,
    path.posix.join(tooling, 'scripts/gate1-ci-tools/main-8c68fd9e-runtime-attempt-1/runtime-probe.cjs'), '--child', app, scratch];
}

/** Parse only requested systemd metadata; duplicate/unexpected properties cannot qualify isolation. */
function parseProperties(bytes, allowed) {
  if (bytes.length > 16384 || [...bytes.toString('utf8')].some(char => (char.charCodeAt(0) < 32 && char !== '\n') || char.charCodeAt(0) === 127)) throw new RuntimeError('isolation');
  const result = {};
  for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
    const split = line.indexOf('=');
    if (split < 1) throw new RuntimeError('isolation');
    const key = line.slice(0, split);
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new RuntimeError('isolation');
    result[key] = line.slice(split + 1);
  }
  if (!probe.exactKeys(result, allowed)) throw new RuntimeError('isolation');
  return result;
}

/** Parse only bounded systemd display units needed by these sub-six-minute limits; unknown forms fail closed. */
function duration(value) {
  if (typeof value !== 'string' || value.length > 32 || !/^(?:\d{1,3}min(?: \d{1,2}s)?|\d{1,3}s)$/.test(value)) throw new RuntimeError('isolation');
  let seconds = 0;
  for (const match of value.matchAll(/(\d+)(min|s)/g)) seconds += Number(match[1]) * (match[2] === 'min' ? 60 : 1);
  if (seconds > 360) throw new RuntimeError('isolation');
  return seconds;
}

/** Compare exact set-valued metadata without accepting duplicates, inversions or extra permissions. */
function sameSet(actual, expected) {
  if (typeof actual !== 'string' || actual.length > 4096) return false;
  const values = actual === '' ? [] : actual.split(' '), wanted = expected === '' ? [] : expected.split(' ');
  return new Set(values).size === values.length && values.every(Boolean) && values.sort().join('|') === wanted.sort().join('|');
}

/** Enumerate every readback property; --all is required because empty capability sets are significant. */
function serviceNames() {
  return [...Object.keys(PROPERTIES), 'User', 'Group', 'LoadState', 'Type', 'ActiveState', 'SubState', 'ControlGroup', 'CPUQuotaPerSecUSec',
    'RuntimeMaxUSec', 'TimeoutStopUSec', 'TimeoutStartUSec', 'WorkingDirectory', 'ReadOnlyPaths', 'ReadWritePaths'];
}

/** Compare effective service metadata before releasing the child; kernel checks separately prove quotas. */
function validateService(values, config) {
  if (!probe.exactKeys(values, serviceNames())) throw new RuntimeError('isolation');
  for (const [key, expected] of Object.entries(PROPERTIES)) if (key === 'RestrictAddressFamilies' ? !sameSet(values[key], expected) : values[key] !== expected) throw new RuntimeError('isolation');
  if (values.User !== String(config.uid) || values.Group !== String(config.gid) || values.ActiveState !== 'active' || values.SubState !== 'running' ||
      values.LoadState !== 'loaded' || values.Type !== 'exec' || values.ControlGroup !== `/system.slice/${config.unit}` || duration(values.CPUQuotaPerSecUSec) !== 4 ||
      duration(values.RuntimeMaxUSec) !== config.seconds || duration(values.TimeoutStopUSec) !== 5 || duration(values.TimeoutStartUSec) !== 30 ||
      values.WorkingDirectory !== config.app || !sameSet(values.ReadOnlyPaths, `${config.app} ${config.tooling} ${path.posix.dirname(config.node)}`) ||
      !sameSet(values.ReadWritePaths, `${config.scratch} ${config.app}/.next/cache`)) throw new RuntimeError('isolation');
  return true;
}

/** Check the child's mount flags before readiness; only scratch/cache may override protected path trees. */
function verifyMounts(config, io = fs) {
  const protectedPaths = ['/home', '/root', config.app, config.tooling, path.posix.dirname(config.node)];
  // The runner contract does not provision /run/user; only confirmed absence makes this path optional.
  try {
    if (!io.lstatSync('/run/user').isDirectory()) throw new RuntimeError('isolation');
    protectedPaths.push('/run/user');
  } catch (error) { if (error.code !== 'ENOENT') throw new RuntimeError('isolation'); }
  const writablePaths = [config.scratch, `${config.app}/.next/cache`];
  for (const name of [...protectedPaths, ...writablePaths]) {
    if (!name.startsWith('/') || io.realpathSync(name) !== name) throw new RuntimeError('isolation');
  }
  const text = io.readFileSync('/proc/self/mountinfo', 'utf8');
  if (typeof text !== 'string' || !text.trim() || text.length > 262144) throw new RuntimeError('isolation');
  /** Decode kernel mount paths so escaped characters cannot hide a writable protected submount. */
  function decode(value) { return value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8))); }
  /** Compare whole path components; similarly named sibling directories are never write exceptions. */
  function within(name, root) { return name === root || name.startsWith(root === '/' ? '/' : root + '/'); }
  /** Require one unambiguous access mode from each per-mount and superblock option list. */
  function readOnly(options) {
    const modes = options.split(',').filter(value => value === 'ro' || value === 'rw');
    if (modes.length !== 1) throw new RuntimeError('isolation');
    return modes[0] === 'ro';
  }
  const mounts = text.trimEnd().split('\n').map(line => {
    const parts = line.split(' - '), fields = parts[0].split(' '), superFields = parts[1]?.split(' ');
    if (parts.length !== 2 || fields.length < 6 || superFields.length !== 3 || !fields[4].startsWith('/')) throw new RuntimeError('isolation');
    const mountReadOnly = readOnly(fields[5]), superReadOnly = readOnly(superFields[2]);
    return { name: decode(fields[4]), readOnly: mountReadOnly || superReadOnly };
  });
  for (const name of [...protectedPaths, ...writablePaths]) {
    const matches = mounts.filter(mount => within(name, mount.name)).sort((a, b) => b.name.length - a.name.length);
    if (!matches.length || (name === '/run/user' && matches[0].name !== name) || matches[0].name === matches[1]?.name ||
        matches[0].readOnly === writablePaths.includes(name)) throw new RuntimeError('isolation');
  }
  for (const mount of mounts) {
    if (protectedPaths.some(root => within(mount.name, root)) && !writablePaths.some(root => within(mount.name, root)) && !mount.readOnly) throw new RuntimeError('isolation');
  }
  return true;
}

/** Confirm kernel controls and effective mount permissions inside the child before publishing readiness. */
function verifyKernel(input, io = fs, config) {
  /** Limit pseudo-file contents in memory; none are copied to retained evidence. */
  const read = name => { const value = io.readFileSync(name, 'utf8'); if (value.length > 16384) throw new RuntimeError('isolation'); return value.trim(); };
  const namespace = io.readlinkSync('/proc/self/ns/net');
  if (!/^net:\[\d+\]$/.test(namespace) || namespace === input.hostNamespace || io.readdirSync('/sys/class/net').sort().join(',') !== 'lo') throw new RuntimeError('isolation');
  const group = read('/proc/self/cgroup');
  if (group !== `0::/system.slice/${input.unit}`) throw new RuntimeError('isolation');
  const root = `/sys/fs/cgroup/system.slice/${input.unit}`;
  const cpu = read(`${root}/cpu.max`).split(/\s+/).map(Number);
  if (cpu.length !== 2 || cpu.some(value => !Number.isSafeInteger(value) || value <= 0) || cpu[0] / cpu[1] !== 4 ||
      read(`${root}/memory.max`) !== String(MEMORY) || read(`${root}/memory.swap.max`) !== '0' || read(`${root}/pids.max`) !== '256') throw new RuntimeError('isolation');
  const status = read('/proc/self/status');
  if (!/^NoNewPrivs:\s+1$/m.test(status) || !/^CapEff:\s+0+$/m.test(status) || !/^CapBnd:\s+0+$/m.test(status) || !/^Seccomp:\s+2$/m.test(status)) throw new RuntimeError('isolation');
  verifyMounts(config, io);
  return true;
}

/** Read only canonical, input-bound child evidence; no application log parsing is involved. */
function readBoundRecord(filename, inputHash, keys) {
  probe.recordPath(path.dirname(filename), path.basename(filename));
  const value = probe.readJson(filename);
  if (!probe.exactKeys(value, ['inputHash', ...keys]) || value.inputHash !== inputHash) throw new RuntimeError('report_schema');
  return value;
}

/** Recover a contiguous progress prefix; its last request is journaled intent, and absence is unknown. */
function recoverProgress(scratch, inputHash, io = fs, read = readBoundRecord) {
  let last = null, gap = false;
  for (let index = 0; index < probe.LIMITS.progressFiles; index++) {
    const file = path.join(scratch, `progress-${String(index).padStart(2, '0')}.json`);
    if (!io.existsSync(file)) { gap = true; continue; }
    if (gap) throw new RuntimeError('report_schema');
    const value = probe.validateRuntime(read(file, inputHash, ['runtime']).runtime);
    if (value.attempted !== Math.max(0, index - 1) || value.serverStarted !== (index > 0) || value.failure !== null || !value.isolationVerified ||
        value.stage !== (index === 0 ? 'isolation' : index === 1 ? 'startup' : 'requests') || value.cases.length !== Math.max(0, index - 2) ||
        value.sourceUnchanged || value.compiledUnchanged || ['descriptorsRestored', 'serverClosed', 'nextClosed'].some(key => value[key] !== (index === 0 ? null : false)) ||
        (index === 0 && value.inspection !== null) || (last?.inspection && JSON.stringify(value.inspection) !== JSON.stringify(last.inspection)) ||
        (last && JSON.stringify(value.cases.slice(0, last.cases.length)) !== JSON.stringify(last.cases))) throw new RuntimeError('report_schema');
    last = value;
  }
  return last;
}

/** Verify the owned cgroup and unit; after launcher settlement, only unloaded or inactive/dead units qualify. */
async function verifyServiceStopped(config, command, io, requireUnloaded = false) {
  const listed = await command(listArgs(config.unit));
  if (listed.toString('utf8').trim()) {
    const values = parseProperties(await command(['show', config.unit, '--all', '--property=LoadState,ActiveState,SubState']), ['LoadState', 'ActiveState', 'SubState']);
    // A transient unit can unload between list and show; its cgroup must still be verified below.
    const inactive = values.ActiveState === 'inactive' && values.SubState === 'dead';
    const unloaded = values.LoadState === 'not-found' && inactive;
    const stopped = values.LoadState === 'loaded' && (inactive || (values.ActiveState === 'failed' && values.SubState === 'failed'));
    if (!(unloaded || (stopped && (!requireUnloaded || inactive)))) throw new RuntimeError('cleanup');
  }
  const group = `/sys/fs/cgroup/system.slice/${config.unit}`;
  try {
    if (!io.statSync(group).isDirectory() || !/^populated 0$/m.test(io.readFileSync(path.join(group, 'cgroup.events'), 'utf8'))) throw new RuntimeError('cleanup');
  } catch (error) { if (error.code !== 'ENOENT') throw new RuntimeError('cleanup'); }
  return true;
}

/** Stop exactly the reserved unit and prove its cgroup empty; launcher exit alone is never cleanup evidence. */
async function stopService(config, run = base.supervise, io = fs, now = Date.now) {
  const deadline = now() + STOP_MS;
  /** Use one cleanup deadline, including failed stop and subsequent metadata verification. */
  async function command(args) {
    if (now() >= deadline) throw new RuntimeError('cleanup');
    return run('sudo', ['-n', 'systemctl', ...args], { env: base.childEnvironment(config.scratch), timeoutMs: Math.min(10000, deadline - now()), capture: true, cap: 16384 });
  }
  try { await command(['stop', config.unit]); }
  catch (error) { if (error.code !== 'child_exit') throw new RuntimeError('cleanup'); }
  await verifyServiceStopped(config, command, io);
  if (now() >= deadline) throw new RuntimeError('cleanup');
  return true;
}

/** List only the owned unit; unlike show, an unloaded transient unit is a successful empty query. */
function listArgs(unit) { return ['list-units', '--all', '--full', '--plain', '--no-legend', '--no-pager', unit]; }

/** Read the immutable observed prefix; terminal scans also reject gaps once the producer has stopped. */
function readPhases(scratch, inputHash, previous, io = fs, read = readBoundRecord, terminal = false) {
  const records = [];
  let gap = false;
  for (let index = 0; index < probe.PHASE_FILES; index++) {
    const filename = path.join(scratch, `phase-${String(index).padStart(2, '0')}.json`);
    if (!io.existsSync(filename)) {
      if (!terminal) break; // Later slots may appear while the producer appends; revisit them next poll.
      gap = true; continue;
    }
    if (gap) throw new RuntimeError('report_schema');
    const { phase, at } = read(filename, inputHash, ['phase', 'at']);
    records.push({ phase, at });
  }
  if (records.length < previous.length || JSON.stringify(records.slice(0, previous.length)) !== JSON.stringify(previous)) throw new RuntimeError('report_schema');
  return records;
}

/** After producer shutdown, report leftover links beside published records; preserve unpublished interrupted writes. */
function verifyPublicationCleanup(scratch, io = fs) {
  const names = ['input.json', 'ready.json', 'release.json', 'runtime.json',
    ...Array.from({ length: probe.LIMITS.progressFiles }, (_value, index) => `progress-${String(index).padStart(2, '0')}.json`),
    ...Array.from({ length: probe.PHASE_FILES }, (_value, index) => `phase-${String(index).padStart(2, '0')}.json`)];
  if (names.some(name => io.existsSync(path.join(scratch, '.pending-' + name)) && io.existsSync(path.join(scratch, name)))) throw new RuntimeError('cleanup');
}

/** Launch once, verify/release once, monitor phase deadlines and always attempt owned service cleanup. */
async function runIsolated(app, scratch, context, selected, remainingMs, operations = {}) {
  const run = operations.run || base.supervise, io = operations.fs || fs, now = operations.now || Date.now;
  const pause = operations.pause || (() => new Promise(resolve => setTimeout(resolve, 50)));
  const seconds = Math.min(360, Math.floor(remainingMs / 1000));
  const config = { app, scratch, tooling: operations.tooling || path.resolve(__dirname, '../../..'), node: operations.node || process.execPath, unit: unitName(context.runId),
    uid: operations.uid ?? process.getuid(), gid: operations.gid ?? process.getgid(), seconds };
  const input = { executionDigest: context.executionDigest, unit: config.unit, hostNamespace: io.readlinkSync('/proc/self/ns/net'), deadline: now() + seconds * 1000,
    entries: selected.entries, routes: selected.routes };
  const args = serviceArgs(config);
  const write = operations.write || probe.publish;
  const inputHash = write(scratch, 'input.json', input);
  const options = { env: base.childEnvironment(scratch), capture: true, cap: 16384 };
  let runtime = null, failure = null, serviceStopped = null, launched = false, released = false, finished = false, childFailure = null;
  let accounting = 'unknown';
  let pending, phases = [], releaseAt, cancelled = false;
  const abort = new AbortController(), signals = operations.signals || process;
  /** Cancellation terminates the owned launcher; finally still stops/verifies the independently managed service. */
  function cancel() { cancelled = true; abort.abort(); }
  /** Bound manager commands by the remaining overall deadline as well as their own metadata allowance. */
  async function metadata(args) {
    if (cancelled) throw new RuntimeError('cancelled');
    if (now() >= input.deadline) throw new RuntimeError('deadline');
    return run('sudo', ['-n', 'systemctl', ...args], { ...options, timeoutMs: Math.min(10000, input.deadline - now()) });
  }
  signals.on('SIGINT', cancel); signals.on('SIGTERM', cancel);
  try {
    if ((await metadata(listArgs(config.unit))).toString('utf8').trim()) throw new RuntimeError('reservation');
    if (cancelled) throw new RuntimeError('cancelled');
    if (now() >= input.deadline) throw new RuntimeError('deadline');
    launched = true;
    // Attach rejection handling immediately: service startup is concurrent with its bounded readiness handshake.
    pending = run('sudo', args, { env: options.env, timeoutMs: input.deadline - now(),
      spawn: (command, argv, settings) => spawn(command, argv, { ...settings, signal: abort.signal }) })
      .then(() => { finished = true; }, error => { childFailure = probe.failureCode(error); finished = true; });
    const readyDeadline = Math.min(input.deadline, now() + 30000);
    while (!finished) {
      if (cancelled) throw new RuntimeError('cancelled');
      if (now() >= input.deadline) throw new RuntimeError('deadline');
      if (!released) {
        if (now() >= readyDeadline) throw new RuntimeError('isolation');
        if (io.existsSync(path.join(scratch, 'ready.json'))) {
          const ready = (operations.read || readBoundRecord)(path.join(scratch, 'ready.json'), inputHash, ['kernelVerified']);
          if (ready.kernelVerified !== true) throw new RuntimeError('isolation');
          const names = serviceNames();
          validateService(parseProperties(await metadata(['show', config.unit, '--all', `--property=${names.join(',')}`]), names), config);
          if (cancelled) throw new RuntimeError('cancelled');
          if (now() >= readyDeadline || finished) throw new RuntimeError('isolation');
          releaseAt = now(); write(scratch, 'release.json', { inputHash, serviceVerified: true, at: releaseAt }); released = true;
        }
      }
      if (released) {
        const phaseNow = now();
        phases = readPhases(scratch, inputHash, phases, io, operations.read || readBoundRecord);
        probe.validatePhases(phases, releaseAt, now(), input.deadline, false, phaseNow);
      }
      await pause();
    }
    if (cancelled) throw new RuntimeError('cancelled');
    if (!released) throw new RuntimeError(childFailure || 'isolation');
    phases = readPhases(scratch, inputHash, phases, io, operations.read || readBoundRecord, true);
    const terminal = probe.validatePhases(phases, releaseAt, now(), input.deadline, true);
    const record = (operations.read || readBoundRecord)(path.join(scratch, 'runtime.json'), inputHash, ['runtime']);
    const candidate = probe.validateRuntime(record.runtime, !record.runtime.failure);
    if ((terminal === 'complete') !== (candidate.failure === null)) throw new RuntimeError('report_schema');
    const progress = (operations.recover || recoverProgress)(scratch, inputHash, io, operations.read || readBoundRecord);
    if (!progress || candidate.attempted !== progress.attempted || candidate.cases.length < progress.cases.length ||
        (progress.inspection && JSON.stringify(candidate.inspection) !== JSON.stringify(progress.inspection)) ||
        JSON.stringify(candidate.cases.slice(0, progress.cases.length)) !== JSON.stringify(progress.cases)) throw new RuntimeError('report_schema');
    runtime = candidate; accounting = 'known';
    failure = childFailure === 'cleanup' ? 'cleanup' : runtime.failure || childFailure;
  } catch (error) {
    failure = childFailure === 'cleanup' ? 'cleanup' : probe.failureCode(error);
    if (failure === 'report_schema' && ['stream_limit', 'child_spawn', 'deadline'].includes(childFailure)) failure = childFailure;
  }
  finally {
    abort.abort();
    if (launched) {
      try { serviceStopped = await (operations.stop || stopService)(config, run, io, now); }
      catch { serviceStopped = false; failure = 'cleanup'; }
    }
    if (pending) {
      const deadline = now() + 5000;
      /** Share the launcher settlement bound with final metadata reads, including after cancellation. */
      function cleanupMetadata(args) {
        const remaining = deadline - now();
        if (remaining <= 0) throw new RuntimeError('cleanup');
        return run('sudo', ['-n', 'systemctl', ...args], { ...options, timeoutMs: remaining });
      }
      /** Capture the remaining bound before starting verification, so expiry cannot leave an unobserved rejection. */
      function verifyStopped() {
        const remaining = deadline - now();
        if (remaining <= 0) throw new RuntimeError('cleanup');
        return probe.bounded(verifyServiceStopped(config, cleanupMetadata, io, true), remaining, 'cleanup');
      }
      /** Retry only this unit after late registration; stop and recheck share the original settlement deadline. */
      async function stopAndVerify() {
        const remaining = deadline - now();
        try { await probe.bounded(cleanupMetadata(['stop', config.unit]), remaining, 'cleanup'); }
        catch (error) { if (error.code !== 'child_exit') throw error; }
        await verifyStopped();
      }
      try {
        await probe.bounded(pending, 5000, 'cleanup');
        try { await verifyStopped(); }
        catch { await stopAndVerify(); }
        if (now() >= deadline) { failure = 'cleanup'; serviceStopped = false; }
      } catch { failure = 'cleanup'; serviceStopped = false; }
    }
    signals.removeListener('SIGINT', cancel); signals.removeListener('SIGTERM', cancel);
  }
  if (!runtime) {
    try {
      runtime = (operations.recover || recoverProgress)(scratch, inputHash, io, operations.read || readBoundRecord);
      if (runtime) accounting = runtime.attempted > 0 ? 'last_attempt_uncertain' : 'known';
    }
    catch { if (failure !== 'cleanup') failure = 'report_schema'; }
  }
  try { verifyPublicationCleanup(scratch, io); }
  catch { failure = 'cleanup'; }
  return { runtime, failure, serviceStopped, accounting };
}

module.exports = { MEMORY, PHASES, STOP_MS, PROPERTIES, unitName, environment, serviceArgs, parseProperties, duration, sameSet, serviceNames, validateService,
  verifyKernel, readBoundRecord, recoverProgress, listArgs, readPhases, stopService, runIsolated };
