'use strict';
/* global __filename, process, Buffer, setTimeout, clearTimeout, AbortController */

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const c = require('./authentication-preparation-scoped-contract.cjs');
const n = require('./authentication-preparation-scoped-native-contract.cjs');
const s = require('./authentication-preparation-scoped.cjs');
const p = require('./authentication-preparation-scoped-postflight.cjs');
const native = require('./authentication-preparation-scoped-native.cjs');
const { ScopedProxy } = require('./authentication-preparation-scoped-proxy.cjs');
const COVERAGE = Object.freeze({ browserTrafficMeasured: false, hostedQualified: false, gate1Status: 'open', backgroundHttp: 'unknown' });

/** Print an in-memory invalid review; zero timestamps cannot authorize browser or listener activity. */
async function reviewTemplate() {
  return { ...await native.bindings(), scope: 'scoped-authentication-startup-review-v1', operator: 'Codex', owner: 'project-owner',
    directory: n.STARTUP_DIRECTORY, command: n.STARTUP_COMMAND, profile: n.STARTUP_PROFILE, artifacts: n.STARTUP_ARTIFACTS,
    limits: n.STARTUP_LIMITS, ports: n.PORTS, spki: n.SPKI, forwarding: 'closed', approvedAt: 0, expiresAt: 0 };
}

/** Read the exact separately approved bytes and recheck all current source/tool/TLS bindings without execution. */
async function loadReview(hash, deps = {}) {
  c.check(/^[a-f0-9]{64}$/.test(hash || ''), 'approval');
  const input = await (deps.read || p.readStartup)('execution-review.json');
  c.check(input.hash === hash, 'integrity'); n.validateStartupReview(input.record, (deps.clock || Date.now)());
  const binding = await (deps.bindings || native.bindings)();
  c.check(n.bindingSchema.safeParse(binding).success
    && Object.keys(binding).every(key => input.record[key] === binding[key]), 'integrity');
  return { review: input.record, reviewHash: hash, binding };
}

/** Consume the fixed empty review directory before activity; await each exclusive write and preserve partial artifacts. */
async function reserveArtifacts(state, io = fs) {
  state.check();
  c.check(path.resolve(await io.realpath(n.STARTUP_DIRECTORY)) === path.resolve(n.STARTUP_DIRECTORY), 'profile');
  const entries = await io.readdir(n.STARTUP_DIRECTORY); state.check();
  c.check(entries.length === 1 && entries[0] === 'execution-review.json', 'already_used');
  const marker = await io.open(path.join(n.STARTUP_DIRECTORY, 'worker-started'), 'wx'); state.reserved = true;
  try { await marker.writeFile('single-use\n'); await marker.sync(); } finally { await marker.close(); }
  state.check(); await io.mkdir(path.join(n.STARTUP_DIRECTORY, 'profiles'));
  state.check(); await io.mkdir(n.STARTUP_PROFILE);
  state.check(); await p.startupProfile(n.STARTUP_PROFILE, io); state.check();
}

/** Probe only a reviewed loopback endpoint; refusal proves absence, while timeout or missing visibility stays inconclusive. */
async function portAbsent(host, port) {
  c.check(['127.0.0.1', '127.0.0.2'].includes(host) && Number.isInteger(port) && port > 0 && port <= 65535, 'schema');
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); reject(new c.PreparationError('port_open')); });
    socket.once('timeout', () => { socket.destroy(); reject(new c.PreparationError('closure')); });
    socket.once('error', error => {
      socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(); else reject(new c.PreparationError('closure'));
    });
  });
}

/** Create the existing synthetic proxy with forwarding irreversibly closed for this diagnostic only. */
function startupProxy(budget, deps = {}) {
  c.check(budget instanceof n.NativeBudget && budget.root.mode === 'startup', 'approval');
  const proxy = new ScopedProxy(budget, { ...deps, synthetic: 'fixtures' });
  Object.defineProperty(proxy, 'forwarding', { value: false, writable: false });
  // The shared seal writes its flag. Keep its socket cleanup while denying any attempt to enable forwarding.
  Object.defineProperty(proxy, 'seal', { value: () => {
    for (const owner of proxy.sockets.values()) { owner.socket.destroy(); owner.upstream?.destroy(); }
  } });
  return proxy;
}

/** Supply native boundaries lazily; importing this module neither starts listeners nor reads authentication storage. */
function dependencies() {
  return { clock: Date.now, verify: input => loadReview(input.reviewHash), reserve: reserveArtifacts,
    absence: () => p.inspectProfileAbsence(n.STARTUP_PROFILE), probe: portAbsent, proxy: startupProxy,
    adapter: s.startupAdapters(), write: p.writeStartup, onCancel: native.dependencies().onCancel };
}

/** Retain bounded process metadata even after an attachment failure, never command lines or profile contents. */
function ownerRecord(owner) {
  if (!owner) return null;
  return { profile: n.STARTUP_PROFILE, pid: owner.child?.pid ?? null, port: owner.port ?? null,
    closedNormally: owner.closed === true, exitCode: owner.child?.exitCode ?? null };
}

/** Observe one startup window behind a closed proxy, preserving its first failure before independent cleanup. */
async function run(input, startedAt, deps = dependencies()) {
  n.validateStartupReview(input.review, startedAt, true);
  c.check(Number.isSafeInteger(startedAt) && startedAt <= deps.clock()
    && n.bindingSchema.safeParse(input.binding).success
    && Object.keys(input.binding).every(key => input.binding[key] === input.review[key]), 'approval');
  const root = new n.NativeLedger(startedAt, input.review.expiresAt, deps.clock, 'startup');
  const budget = new n.NativeBudget(root, n.STARTUP_CASE);
  const state = { reserved: false, check: () => root.check() };
  let proxy; let owner; let readyAt = null; let launchAt = null; let observationEndedAt = null;
  let windowTimer; let resolveWindow; let cleanup = true; let windowComplete = false;
  const window = new Promise(resolve => { resolveWindow = resolve; });
  /** Snapshot the end of observation on first failure and wake the waiter without replacing its attributed cause. */
  const stopped = () => {
    if (launchAt !== null && observationEndedAt === null) observationEndedAt = root.clock();
    proxy?.seal(); resolveWindow();
  };
  budget.abort.signal.addEventListener('abort', stopped, { once: true });
  const removeCancel = deps.onCancel?.(() => root.stop('cancelled')) || (() => {});
  const workTimer = setTimeout(() => root.stop('deadline'), Math.max(1, root.deadline - root.clock()));
  try {
    try {
      // Reservation is awaited directly: cancellation cannot abandon an in-progress marker/profile write.
      root.check(); await deps.reserve(state); root.check(); c.check(state.reserved, 'already_used');
      root.stage = 'preflight'; await s.step(budget, () => deps.verify(input));
      await s.step(budget, () => deps.absence());
      for (const port of n.PORTS) {
        root.charge({ listenerProbes: 1 });
        await s.step(budget, () => deps.probe(port === 18444 ? '127.0.0.2' : '127.0.0.1', port));
      }
      root.stage = 'proxy'; proxy = deps.proxy(budget); await s.step(budget, () => proxy.start());
      c.check(proxy.port === 18445 && proxy.forwarding === false, 'observation');
      root.stage = 'launch'; budget.launch();
      owner = { profile: n.STARTUP_PROFILE, restart: false, closed: false,
        /** Start the nonrenewable window at spawn, including controller attachment and target setup. */
        onSpawn: () => {
          root.check(); c.check(launchAt === null && Number.isSafeInteger(owner.child?.pid), 'operation');
          launchAt = root.clock(); budget.deadline = root.deadline = Math.min(root.deadline, launchAt + n.STARTUP_LIMITS.observationMs);
          windowTimer = setTimeout(() => {
            if (root.failure) return;
            if (readyAt === null) { root.stop('deadline'); return; }
            // A late Network-only slot cannot become complete evidence just because its pairing timer was cancelled.
            if (root.totals.records !== 0 || budget.inFlight !== 0) { root.stop('observation'); return; }
            observationEndedAt = root.clock(); windowComplete = true;
            owner.observer?.close(); proxy.seal(); resolveWindow();
          }, Math.max(1, budget.deadline - root.clock()));
        } };
      await s.step(budget, () => deps.adapter.launch(owner, proxy, budget), n.STARTUP_LIMITS.attachmentMs);
      c.check(launchAt !== null, 'observation'); root.stage = 'observe';
      await s.step(budget, () => deps.adapter.observe(owner, budget));
      c.check(owner.native?.pageReady === 2 && root.clock() < budget.deadline, 'observation');
      readyAt = root.clock(); root.stage = 'window'; await window;
      c.check(!root.failure && windowComplete, root.failure || 'observation');
    } catch (error) { root.stop(c.errorCode(error)); }
    finally {
      clearTimeout(windowTimer); clearTimeout(workTimer);
      if (launchAt !== null && observationEndedAt === null) observationEndedAt = root.clock();
      root.stage = 'closure'; proxy?.seal(); owner?.observer?.close();
      if (owner) {
        const closed = await s.cleanup(budget, () => deps.adapter.close(owner, budget), 15000);
        if (!closed || !owner.closed || owner.child?.exitCode !== 0) cleanup = false;
        else root.chrome--;
        // A failed normal close must still release the local controller; Chrome itself is never killed.
        owner.cdp?.close();
      }
      if (proxy && await s.cleanup(budget, async () => { await proxy.close(); return true; }) !== true) cleanup = false;
      if (root.chrome !== 0 || root.connections !== 0) cleanup = false;
      if (!cleanup) root.stop('closure');
    }
    c.check(state.reserved, root.failure || 'already_used'); root.stage = 'evidence';
    const outcome = root.failure === 'destination' && root.destinationReason
      && ['proxy', 'launch', 'observe', 'window'].includes(root.failureStage) ? 'rejection'
      : !root.failure && windowComplete && cleanup ? 'no_rejection_observed' : 'incomplete';
    const record = { ...input.binding, schemaVersion: 1, scope: 'scoped_authentication_startup_attempt',
      reviewHash: input.reviewHash, startedAt, completedAt: root.clock(), launchAt, readyAt, observationEndedAt,
      pagesReady: owner?.native?.pageReady || 0,
      outcome, firstFailure: root.failure, destinationReason: root.destinationReason, failureStage: root.failureStage,
      cleanup, owner: ownerRecord(owner), totals: { ...root.totals }, traffic: root.traffic(), proxy: proxy?.snapshot() || null, ...COVERAGE };
    n.validateStartupAttempt(record); c.check(root.clock() < root.end, 'expired');
    const attemptHash = await deps.write('attempt.json', record);
    c.check(root.clock() < root.end, 'expired');
    c.check(root.failure === record.firstFailure, root.failure || 'observation');
    return { scope: 'scoped_authentication_startup_worker', attemptHash };
  } finally {
    clearTimeout(windowTimer); clearTimeout(workTimer); removeCancel(); budget.abort.signal.removeEventListener('abort', stopped);
  }
}

/** Independently check closure after actual worker exit; stopped or missing worker evidence never bypasses cleanup inspection. */
async function finalize(worker, input, startedAt, deps = {}) {
  const clock = deps.clock || Date.now; const deadline = Math.min(startedAt + n.STARTUP_LIMITS.wholeMs, input.review.expiresAt);
  const stage = p.deadlineStages(deadline, clock);
  let failure = null; let attempt = null; let attemptHash = null; let listenerProbes = 0;
  const checks = { workerExited: false, bindings: false, normalClosure: false, processAbsent: false, listenersClosed: false, profilePreserved: false };
  /** Preserve the earliest postflight error, with cancellation authoritative over any provisional clean result. */
  const check = () => {
    if (deps.signal?.aborted) failure ||= 'cancelled';
    if (clock() >= deadline) failure ||= 'expired';
  };
  /** Attempt each independent read-only cleanup check even after a companion check fails; never retry a probe. */
  const inspect = async operation => {
    check(); try { const value = await stage(operation); check(); return value; }
    catch (error) { failure ||= c.errorCode(error); return false; }
  };
  await inspect(async () => {
    const result = await (deps.read || p.readStartup)('attempt.json'); n.validateStartupAttempt(result.record);
    const record = result.record;
    c.check(record.reviewHash === input.reviewHash && record.startedAt === startedAt && record.completedAt <= clock()
      && Object.keys(input.binding).every(key => record[key] === input.binding[key]), 'integrity');
    attempt = record; attemptHash = result.hash;
    checks.normalClosure = record.cleanup && record.owner?.closedNormally === true;
    c.check(n.startupWorkerSchema.safeParse(worker.message).success && worker.exitCode === 0
      && worker.valid && worker.message.attemptHash === result.hash, 'worker_completion');
    checks.workerExited = true; return true;
  });
  checks.bindings = await inspect(async () => { await (deps.verify || loadReview)(input.reviewHash); return true; }) === true;
  checks.processAbsent = await inspect(() => (deps.absence || p.inspectProfileAbsence)(n.STARTUP_PROFILE)) === true;
  checks.profilePreserved = await inspect(() => (deps.profile || p.startupProfile)(n.STARTUP_PROFILE)) === true;
  let portsClosed = true;
  const ports = [...n.PORTS, ...(attempt?.owner?.port ? [attempt.owner.port] : [])];
  for (const port of ports) {
    const absent = await inspect(async () => {
      c.check(listenerProbes < 5 && listenerProbes + (attempt?.totals.listenerProbes || 0) < n.STARTUP_LIMITS.listenerProbes, 'budget');
      listenerProbes++; await (deps.probe || portAbsent)(port === 18444 ? '127.0.0.2' : '127.0.0.1', port); return true;
    });
    if (absent !== true) portsClosed = false;
  }
  checks.listenersClosed = portsClosed && ports.length === 5;
  check(); if (!Object.values(checks).every(Boolean)) failure ||= 'closure';
  const outcome = !failure && attempt ? attempt.outcome : 'incomplete';
  const result = { ...input.binding, schemaVersion: 1, scope: 'scoped_authentication_startup_postflight',
    reviewHash: input.reviewHash, attemptHash, startedAt, completedAt: clock(), outcome,
    firstFailure: attempt?.firstFailure || null, destinationReason: attempt?.destinationReason || null,
    failureStage: attempt?.failureStage || null, postflightFailure: failure, checks, listenerProbes,
    finalization: 'requires_timely_supervisor_result', ...COVERAGE };
  // No trusted attempt means no replacement evidence file. Independent check results still return in memory.
  if (!attempt || clock() >= deadline) return { outcome: 'incomplete', receiptFinalized: false, postflightFailure: failure || 'receipt', checks, ...COVERAGE };
  n.validateStartupPostflight(result);
  const postflightHash = await (deps.write || p.writeStartup)('postflight.json', result);
  check();
  // A late/cancelled write stays preserved but cannot be accepted without this timely supervisor result.
  return { outcome: failure ? 'incomplete' : outcome, receiptFinalized: !deps.signal?.aborted && clock() < deadline,
    postflightHash, postflightFailure: failure, checks, ...COVERAGE };
}

/** Own one worker through its actual exit; IPC and operator cancellation never force-kill Chrome or reset the clock. */
async function supervise(input, deps = {}) {
  const clock = deps.clock || Date.now; const startedAt = clock(); n.validateStartupReview(input.review, startedAt, true);
  const end = startedAt + n.STARTUP_LIMITS.wholeMs; const signals = deps.signals || process;
  const cancellation = new AbortController(); let cancelWorker = () => {};
  /** Keep cancellation latched through worker cleanup and parent evidence writes. */
  const cancel = () => { cancellation.abort(); cancelWorker(); };
  signals.on('SIGINT', cancel); signals.on('SIGTERM', cancel);
  try {
    const worker = await new Promise((resolve, reject) => {
      const child = (deps.spawn || spawn)(process.execPath, [__filename, '--startup-worker', input.reviewHash, String(startedAt)],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: native.workerEnvironment() });
      let message = null; let valid = true; let finished = false;
      /** Send only a categorical cancellation request; the worker owns normal closure. */
      const stop = () => { if (child.connected) child.send({ cancel: true }, () => {}); };
      cancelWorker = stop;
      const workTimer = setTimeout(stop, Math.max(1, end - n.STARTUP_LIMITS.cleanupMs - clock()));
      /** Release parent event-loop references at expiry; the worker still owns normal Chrome closure. */
      const endTimer = setTimeout(() => {
        stop(); child.channel?.unref(); child.unref(); finish('expired');
      }, Math.max(1, end - clock()));
      /** Resolve only on real worker close; missing/duplicate IPC remains invalid for independent postflight. */
      function finish(error, exitCode) {
        if (finished) return; finished = true; clearTimeout(workTimer); clearTimeout(endTimer); cancelWorker = () => {};
        if (error) reject(new c.PreparationError(error)); else resolve({ message, valid, exitCode });
      }
      child.on('message', value => {
        if (finished) return;
        try {
          if (message || Buffer.byteLength(JSON.stringify(value)) > 1024 || !n.startupWorkerSchema.safeParse(value).success) { valid = false; stop(); }
          else message = value;
        } catch { valid = false; stop(); }
      });
      child.once('error', () => finish('worker_completion')); child.once('close', code => finish(null, code));
      if (cancellation.signal.aborted) stop();
    });
    return await (deps.finalize || finalize)(worker, input, startedAt, { clock, signal: cancellation.signal });
  } finally { signals.removeListener('SIGINT', cancel); signals.removeListener('SIGTERM', cancel); }
}

/** Gate native work behind the separately approved digest and supervisor IPC; hash/template commands are read-only. */
async function main(args) {
  if (args.length === 1 && args[0] === '--source-hash') return s.sourceHashes();
  if (args.length === 1 && args[0] === '--review-template') return reviewTemplate();
  const worker = args[0] === '--startup-worker';
  c.check((worker || args[0] === '--execute-startup') && args.length === (worker ? 3 : 2), 'arguments');
  if (worker) c.check(process.connected === true && /^\d{1,16}$/.test(args[2]), 'approval');
  const input = await loadReview(args[1]); if (!worker) return supervise(input);
  const result = await run(input, Number(args[2]));
  await new Promise((resolve, reject) => process.send(result, error => error ? reject(new c.PreparationError('worker_completion')) : resolve()));
  process.disconnect(); return result;
}

module.exports = { COVERAGE, reviewTemplate, loadReview, reserveArtifacts, portAbsent, startupProxy, dependencies,
  ownerRecord, run, finalize, supervise, main };
if (require.main === module) main(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n'); if (result.outcome === 'incomplete') process.exitCode = 1;
}, error => { process.stderr.write(JSON.stringify({ outcome: 'incomplete', receiptFinalized: false, firstFailure: c.errorCode(error), ...COVERAGE }) + '\n'); process.exitCode = 1; });
