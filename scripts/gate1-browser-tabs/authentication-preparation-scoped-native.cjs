'use strict';
/* global __filename, process, Buffer, setTimeout, clearTimeout, AbortController */

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { z } = require('zod');
const s = require('./authentication-preparation-scoped.cjs');
const c = require('./authentication-preparation-scoped-contract.cjs');
const n = require('./authentication-preparation-scoped-native-contract.cjs');
const f = require('./authentication-preparation-scoped-native-fixtures.cjs');
const p = require('./authentication-preparation-scoped-postflight.cjs');
const { ScopedProxy } = require('./authentication-preparation-scoped-proxy.cjs');
const workerSchema = s.QUALIFICATION_COMPLETION.omit({ scope: true, exitCode: true }).strict();
const stoppedWorkerSchema = n.stoppedSchema.pick({ phase: true, firstFailure: true })
  .extend({ receiptFinalized: z.literal(false) }).strict();

/** Derive current provenance read-only; the public TLS key is never account or production material. */
async function bindings() {
  const material = await f.certificate();
  return { ...await s.sourceHashes(), toolSet: await s.toolHashes(), certificateHash: material.certificateHash, keyHash: material.keyHash };
}

/** Emit an invalid-until-approved template in memory; never create execution inputs or grant approval. */
async function reviewTemplate() {
  return { ...await bindings(), scope: 'scoped-authentication-native-execution-review-v1', operator: 'Codex', owner: 'project-owner',
    directory: n.DIRECTORY, command: 'node scripts/gate1-browser-tabs/authentication-preparation-scoped-native.cjs --execute-native <execution-review-sha256>',
    cases: n.CASES, limits: n.LIMITS, spki: n.SPKI, profiles: n.PROFILES, ports: n.PORTS, approvedAt: 0, expiresAt: 0 };
}

/** Read only a separately approved expiring review and compare its exact bytes to the supplied digest. */
async function loadReview(hash, deps = {}) {
  c.check(/^[a-f0-9]{64}$/.test(hash || ''), 'approval');
  const input = await (deps.read || p.readNative)('execution-review.json');
  c.check(input.hash === hash, 'integrity'); n.validateReview(input.record, (deps.clock || Date.now)());
  const current = await (deps.bindings || bindings)();
  c.check(Object.keys(current).every(key => input.record[key] === current[key]) && n.bindingSchema.safeParse(current).success, 'integrity');
  return { review: input.record, reviewHash: hash, binding: current };
}

/** Reserve once after review: empty approved root, exclusive marker, then profiles, never recursive replacement. */
async function reserveArtifacts(state, io = fs) {
  state.check?.();
  c.check(path.resolve(await io.realpath(n.DIRECTORY)) === path.resolve(n.DIRECTORY), 'profile');
  const entries = await io.readdir(n.DIRECTORY);
  state.check?.();
  c.check(entries.length === 1 && entries[0] === 'execution-review.json', 'already_used');
  const marker = await io.open(path.join(n.DIRECTORY, 'worker-started'), 'wx'); state.reserved = true;
  try { await marker.writeFile('single-use\n'); await marker.sync(); } finally { await marker.close(); }
  state.check?.();
  await io.mkdir(path.join(n.DIRECTORY, 'profiles'));
  for (const profile of n.PROFILES) { state.check?.(); await io.mkdir(profile); await p.nativeProfile(profile, io); }
}

/** Probe both loopback addresses independently; checking 127.0.0.1 alone cannot verify the frame listener. */
async function listenersAbsent(probe = null) {
  const net = require('node:net');
  for (const port of n.PORTS) {
    const host = port === 18444 ? '127.0.0.2' : '127.0.0.1';
    if (probe) { await probe(host, port); continue; }
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      socket.setTimeout(1000); socket.once('connect', () => { socket.destroy(); reject(new c.PreparationError('port_open')); });
      socket.once('timeout', () => { socket.destroy(); reject(new c.PreparationError('closure')); });
      socket.once('error', error => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(); else reject(new c.PreparationError('closure')); });
    });
  }
}

/** Reserve launch capacity before registering a browser for cleanup; own it before adapter launch can fail. */
async function launchOwned(context, restart = false) {
  const { budget, adapter, owners, proxy } = context;
  const owner = { profile: n.profile(context.item.id), restart, closed: false }; budget.launch(); owners.push(owner);
  await s.step(budget, () => adapter.launch(owner, proxy, budget), n.LIMITS.attachmentMs); return owner;
}

/** Stop observation only after its positive summary or an already stopped negative case, then close normally. */
async function closeOwned(context, owner) {
  if (owner.inspected) return;
  context.proxy.seal(); owner.observer?.close();
  const record = await s.cleanup(context.budget, () => context.adapter.close(owner, context.budget));
  c.check(record, 'closure');
  const inspected = await s.cleanup(context.budget, () => context.adapter.inspect(record));
  c.check(inspected === true, 'closure'); owner.inspected = true;
  context.root.chrome--; context.closures.push(record);
}

/** Wait for paired observer completion after a finite navigation, without issuing another HTTP request. */
async function settled(owner, budget) {
  await f.waitFor(() => budget.inFlight === 0, budget);
  await owner.observer.summary();
}

/** Navigate only a classified synthetic route; the real observer reserves each redirect hop. */
async function navigate(owner, budget, route) {
  n.classify(`${n.ORIGIN}${route}`, 'GET');
  const result = await owner.cdp.send('Page.navigate', { url: `${n.ORIGIN}${route}` }, owner.page.sessionId);
  c.check(!result.errorText, 'operation'); await settled(owner, budget);
}

/** Create a raw setup target only in the two explicit worker phases; no normal observer guard is weakened. */
async function workerPage(owner) {
  const existing = await owner.cdp.send('Target.getTargets');
  c.check(Array.isArray(existing.targetInfos) && existing.targetInfos.length <= 2
    && existing.targetInfos.every(target => target.type === 'browser'
      || (target.type === 'service_worker' && target.url === `${n.ORIGIN}/worker.js`)), 'observation');
  await owner.cdp.send('Target.setDiscoverTargets', { discover: true });
  const target = await owner.cdp.send('Target.createTarget', { url: 'about:blank' });
  const session = await owner.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  owner.page = { id: target.targetId, sessionId: session.sessionId };
}

/** Observe the restored worker's actual probe attempt before it encounters the already rejecting proxy. */
async function observeRestoredWorker(owner, budget) {
  owner.workerReady = new Set(); owner.workerProbeObserved = false; const tasks = new Set(); const sessions = new Set();
  let workerSession;
  const token = budget.reserve('application');
  /** Pause supported restored workers and enable their real Network stream before resuming them. */
  const onEvent = message => {
    if (owner.nativeClosing || budget.failure) return;
    try {
      const event = message.params || {};
      if (message.method === 'Target.attachedToTarget') {
        c.check(typeof event.sessionId === 'string' && sessions.size < 16 && !sessions.has(event.sessionId), 'observation'); sessions.add(event.sessionId);
        if (event.targetInfo?.type === 'page') { c.check(event.targetInfo.targetId === owner.page.id, 'observation'); return; }
        c.check(event.targetInfo?.type === 'service_worker' && event.targetInfo.url === `${n.ORIGIN}/worker.js`
          && event.waitingForDebugger === true && tasks.size < 16 && workerSession === undefined, 'observation');
        workerSession = event.sessionId; // Own the sole worker synchronously, before Network.enable can yield.
        const task = (async () => {
          await owner.cdp.send('Network.enable', {}, event.sessionId); budget.check(); owner.workerReady.add(event.sessionId);
          await owner.cdp.send('Runtime.runIfWaitingForDebugger', {}, event.sessionId); budget.acknowledge(token);
        })().catch(error => budget.stop(c.errorCode(error)));
        tasks.add(task); task.finally(() => tasks.delete(task));
      }
      if (message.method === 'Network.requestWillBeSent' && owner.workerReady.has(message.sessionId)) {
        c.check(event.request?.method === 'GET' && event.request.url === `${n.ORIGIN}/worker-probe`
          && !event.redirectResponse && !owner.workerProbeObserved, 'observation'); owner.workerProbeObserved = true;
      }
      if (message.method === 'Target.detachedFromTarget' || message.method === 'Inspector.detached') budget.stop('observation');
    } catch (error) { budget.stop(c.errorCode(error)); }
  };
  owner.cdp.on('event', onEvent);
  await owner.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
}

/** Require cookie access and write-back at the server across three normally closed launches. */
async function lifecycle(context) {
  const { adapter, budget, fixtures } = context; const before = { ...fixtures.counts };
  const first = await launchOwned(context); await adapter.observe(first, budget); context.proxy.open();
  await navigate(first, budget, '/start');
  const redirects = [...first.observer.streams.values()].some(stream => stream.hops.length === 3 && stream.hops.every(hop => hop.finished));
  await s.step(budget, signal => adapter.manualSignIn(first, budget, signal), budget.limits.manualMs);
  await adapter.pageIdentity(first, budget); await settled(first, budget);
  const witnesses = { pageReady: first.native.pageReady === 2, frameReady: first.native.frameReady > 0,
    redirectHops: redirects && fixtures.counts.start === before.start + 1 && fixtures.counts.hop === before.hop + 1,
    cookieBefore: fixtures.counts.readyInitial === before.readyInitial + 1 && fixtures.counts.sessionInitial === before.sessionInitial + 1,
    contextLoss: first.native.contextLoss > 0, laterPoll: !budget.failure, cookieRestart: false, cookieWriteBack: false, cookieThird: false };
  await closeOwned(context, first);
  const second = await launchOwned(context, true);
  await s.step(budget, () => adapter.request(second, budget, '/api/auth/session'));
  witnesses.cookieRestart = fixtures.counts.sessionInitial === before.sessionInitial + 2;
  await s.step(budget, () => adapter.request(second, budget, '/api/native/writeback'));
  witnesses.cookieWriteBack = fixtures.counts.writeBack === before.writeBack + 1;
  await closeOwned(context, second);
  const third = await launchOwned(context); await adapter.observe(third, budget); context.proxy.open();
  await navigate(third, budget, '/ready'); witnesses.cookieThird = fixtures.counts.readyUpdated === before.readyUpdated + 1;
  await closeOwned(context, third); return witnesses;
}

/** Seed the worker in an explicit unobserved setup lane, then trigger it behind the closed proxy on restart. */
async function restoredWorker(context) {
  const { fixtures, budget } = context;
  const seed = await launchOwned(context); await workerPage(seed); fixtures.seed(budget); context.proxy.open();
  await seed.cdp.send('Page.navigate', { url: `${n.ORIGIN}/worker-seed` }, seed.page.sessionId);
  await f.waitFor(() => fixtures.seedTokens && [...fixtures.seedTokens.values()].every(entry => entry.used), budget);
  const ready = await seed.cdp.send('Runtime.evaluate', { expression: 'navigator.serviceWorker.ready.then(()=>true)', awaitPromise: true, returnByValue: true }, seed.page.sessionId);
  c.check(ready.result?.value === true && !ready.exceptionDetails, 'coverage_unqualified'); fixtures.finishSeed();
  await closeOwned(context, seed); const before = fixtures.counts.workerProbe;
  const restarted = await launchOwned(context); await workerPage(restarted);
  await observeRestoredWorker(restarted, budget);
  await restarted.cdp.send('ServiceWorker.enable', {}, restarted.page.sessionId);
  await restarted.cdp.send('ServiceWorker.startWorker', { scopeURL: `${n.ORIGIN}/` }, restarted.page.sessionId);
  await f.waitFor(() => restarted.native.workerObserved && restarted.workerProbeObserved && context.proxy.evidence.deniedFixture > 0, budget);
  const witnesses = { seeded: true, workerAttempt: restarted.native.workerObserved && restarted.workerProbeObserved,
    proxyDenied: context.proxy.evidence.deniedFixture > 0, originProbeZero: fixtures.counts.workerProbe === before };
  await closeOwned(context, restarted); return witnesses;
}

/** Cancel a real held context request and corroborate disposal with the fixture socket's close event. */
async function cancellation(context) {
  const { budget, fixtures, adapter } = context; const before = { ...fixtures.counts };
  const owner = await launchOwned(context, true);
  const pending = adapter.request(owner, budget, '/api/native/hold').then(() => false, () => true);
  await f.waitFor(() => fixtures.counts.held === before.held + 1, budget);
  budget.stop('cancelled'); const disposed = await s.cleanup(budget, async () => { await owner.cancelled; return true; });
  const rejected = await s.cleanup(budget, () => pending);
  await f.waitFor(() => fixtures.counts.heldClosed === before.heldClosed + 1, budget, 5000, true);
  return { held: true, disposed: disposed === true && rejected === true, socketClosed: true, uncertain: budget.snapshot().uncertain === 1 };
}

/** Exercise predetermined real failures; only the two named injected cases alter commands/event delivery. */
async function negativeCase(context) {
  const { item, adapter, budget, fixtures } = context;
  if (item.id === 'request-cancel') return cancellation(context);
  const owner = await launchOwned(context); await adapter.observe(owner, budget); context.proxy.open();
  const probes = fixtures.counts.workerProbe;
  if (item.id === 'manual-deadline') {
    try { await s.step(budget, signal => adapter.manualSignIn(owner, budget, signal), 5000); } catch { /* Exact failure checked below. */ }
    return { replacements: owner.native.replacements >= 2 && owner.native.replacements <= 16 && owner.native.contextReplacements >= 2,
      expired: budget.failure === 'deadline', noLatePass: budget.abort.signal.aborted };
  }
  if (item.id === 'missing-pair') {
    const pending = owner.cdp.send('Page.navigate', { url: `${n.ORIGIN}/ready` }, owner.page.sessionId).catch(() => null);
    await f.waitFor(() => !!budget.failure, budget, 6000, true); await s.cleanup(budget, () => pending);
    return { realEventWithheld: owner.native.realEventWithheld, networkSlot: budget.slots.size === 1,
      uncertain: budget.snapshot().unreservedObservations === 1, stoppedDispatch: budget.abort.signal.aborted };
  }
  await navigate(owner, budget, '/ready');
  if (item.id === 'protocol-error') {
    try { await owner.cdp.send('Runtime.evaluate', { expression: 42 }, owner.page.sessionId); } catch { /* Real error retained categorically. */ }
    return { nativeError: owner.native.nativeError, stoppedDispatch: budget.abort.signal.aborted };
  }
  if (item.id === 'detach') {
    try { await owner.cdp.send('Target.detachFromTarget', { sessionId: owner.page.sessionId }); } catch { /* Observation loss is expected. */ }
    await f.waitFor(() => !!budget.failure, budget, 5000, true);
    return { nativeDetach: owner.native.nativeDetach, stoppedDispatch: budget.abort.signal.aborted };
  }
  c.check(item.id === 'unsupported-worker', 'schema');
  await owner.cdp.send('Runtime.evaluate', { expression: "new Worker('/worker.js');true", returnByValue: true }, owner.page.sessionId).catch(() => null);
  await f.waitFor(() => !!budget.failure, budget, 5000, true);
  return { workerObserved: owner.native.workerObserved, originProbeZero: fixtures.counts.workerProbe === probes, stoppedDispatch: budget.abort.signal.aborted };
}

/** Run one case with a permanent local abort state; actual closure precedes every subsequent case. */
async function browserCase(item, root, fixtures, deps = {}) {
  const budget = new n.NativeBudget(root, item, item.id === 'manual-deadline' ? { manualMs: 5000 } : {});
  const adapter = (deps.adapters || s.syntheticAdapters)(item.id, item.id === 'lifecycle' ? 'recover' : item.id === 'manual-deadline' ? 'deadline' : null);
  const context = { item, root, budget, adapter, fixtures, owners: [], closures: [], proxy: null };
  let witnesses; let error; let cleanup = true;
  const abort = () => { context.proxy?.seal(); for (const owner of context.owners) if (owner.context) {
    owner.cancelled = owner.context.request.dispose({ reason: 'synthetic_stop' }).catch(() => { cleanup = false; });
  } };
  budget.abort.signal.addEventListener('abort', abort, { once: true });
  try {
    context.proxy = deps.proxy ? deps.proxy(budget) : new ScopedProxy(budget, { synthetic: 'fixtures' }); await s.step(budget, () => context.proxy.start());
    witnesses = await (item.id === 'lifecycle' ? lifecycle(context) : item.id === 'restored-worker' ? restoredWorker(context) : negativeCase(context));
    c.check(budget.failure === item.expected && Object.values(witnesses).every(value => value === true), 'coverage_unqualified');
  } catch (caught) { error = caught; root.stop(c.errorCode(caught)); }
  finally {
    context.proxy?.seal();
    for (const owner of context.owners) {
      if (owner.cancelled && await s.cleanup(budget, async () => { await owner.cancelled; return true; }) !== true) cleanup = false;
      try { await closeOwned(context, owner); } catch { cleanup = false; }
    }
    if (context.proxy && await s.cleanup(budget, async () => { await context.proxy.close(); return true; }) !== true) cleanup = false;
    budget.abort.signal.removeEventListener('abort', abort);
  }
  if (!cleanup) { root.cleanupFailed = true; root.stop(error ? c.errorCode(error) : 'closure'); throw error || new c.PreparationError('closure'); }
  root.finishCase(budget);
  if (error) throw error;
  c.check(budget.failure === item.expected, 'coverage_unqualified');
  return { record: { id: item.id, mode: item.mode, outcome: 'passed', failure: item.expected,
    launches: budget.launches, witnesses, cleanup }, owners: context.closures };
}

/** Supply native boundaries only after an approved CLI review; construction never starts listeners or Chrome. */
function dependencies() {
  return { clock: Date.now, verify: input => loadReview(input.reviewHash), reserve: reserveArtifacts,
    preflight: async () => { await p.inspectProfileAbsence(n.PROFILES[0]); await listenersAbsent(); },
    fixtures: root => new f.Fixtures(root), material: f.certificate, browserCase,
    transport: f.transportProbes, write: p.writeNative,
    /** Attach cancellation before work and remove all process handlers after cleanup. */
    onCancel: cancel => {
      const message = value => { if (value?.cancel === true) cancel(); };
      process.on('message', message); process.on('SIGINT', cancel); process.on('SIGTERM', cancel); process.on('disconnect', cancel);
      return () => { process.removeListener('message', message); process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel); process.removeListener('disconnect', cancel); };
    } };
}

/** Execute exactly one finite matrix; expected negatives retain their charges and never reset the root clock. */
async function run(input, startedAt, deps = dependencies()) {
  n.validateReview(input.review, deps.clock());
  c.check(Number.isSafeInteger(startedAt) && startedAt >= input.review.approvedAt && startedAt <= deps.clock(), 'approval');
  const root = new n.NativeLedger(startedAt, input.review.expiresAt, deps.clock); const state = { reserved: false, check: () => root.check() };
  const results = []; const owners = []; let fixtures; let error; let cleanup = true;
  const removeCancel = deps.onCancel?.(() => root.stop('cancelled')) || (() => {});
  const timer = setTimeout(() => root.stop('deadline'), Math.max(1, root.deadline - root.clock()));
  const bounded = p.deadlineStages(root.deadline, root.clock);
  /** Cancellation is checked before and after every preflight stage, not merely after artifact reservation. */
  const stage = async operation => { root.check(); const value = await bounded(() => { root.check(); return operation(); }); root.check(); return value; };
  try {
    await stage(() => deps.verify(input)); await stage(() => deps.preflight());
    // Await reservation itself; a timed-out directory write may not be abandoned behind a race.
    root.check(); await deps.reserve(state); root.check(); fixtures = deps.fixtures(root);
    const material = await stage(() => deps.material());
    c.check(material.certificateHash === input.binding.certificateHash && material.keyHash === input.binding.keyHash, 'integrity');
    await stage(() => fixtures.start(material));
    for (const item of n.CASES) {
      root.check();
      if (item.id === 'transport') {
        await stage(() => fixtures.close());
        const witnesses = await deps.transport(root);
        results.push({ id: item.id, mode: item.mode, outcome: 'passed', failure: null, launches: 0, witnesses, cleanup: true });
      } else {
        const result = await deps.browserCase(item, root, fixtures); results.push(result.record); owners.push(...result.owners);
      }
    }
    n.qualificationChecks(results); await stage(() => deps.verify(input));
  } catch (caught) { error = caught; root.stop(c.errorCode(caught)); }
  finally {
    if (fixtures) {
      try { await p.deadlineStages(root.end, root.clock)(() => fixtures.close()); } catch { cleanup = false; }
    }
    clearTimeout(timer); removeCancel();
  }
  if (!cleanup || root.cleanupFailed || root.chrome !== 0 || root.connections !== 0) { cleanup = false; error ||= new c.PreparationError('closure'); }
  const common = { ...input.binding, schemaVersion: 1, scope: 'scoped_authentication_native_attempt', reviewHash: input.reviewHash,
    startedAt, completedAt: root.clock(), totals: { ...root.totals }, traffic: root.traffic(), browserTrafficMeasured: false, hostedQualified: false,
    gate1Status: 'open', backgroundHttp: 'unknown' };
  const record = error ? { ...common, phase: c.errorCode(error) === 'coverage_unqualified' ? 'inconclusive' : 'stopped',
    firstFailure: c.errorCode(error), completedCases: results.length, cleanup } : { ...common, phase: 'passed', cases: results,
    owners, checks: n.qualificationChecks(results) };
  n.validateAttempt(record);
  if (!state.reserved) throw error || new c.PreparationError('already_used');
  c.check(root.clock() < root.end, 'expired');
  const attemptHash = await deps.write('attempt.json', record);
  c.check(root.clock() < root.end, 'expired');
  if (error) return { phase: record.phase, firstFailure: record.firstFailure, receiptFinalized: false };
  return { phase: 'passed', receiptFinalized: true, attemptHash, sourceSet: input.binding.sourceSet,
    decisionHash: input.binding.decisionHash, toolSet: input.binding.toolSet };
}

/** Recheck independent closure and exact bytes after actual worker completion, before creating qualification. */
async function finalize(message, input, deadline, deps = {}) {
  const clock = deps.clock || Date.now; const bounded = p.deadlineStages(deadline, clock);
  /** Keep explicit operator cancellation authoritative through read-only checks and awaited evidence writes. */
  const check = () => { c.check(!deps.signal?.aborted, 'cancelled'); c.check(clock() < deadline, 'expired'); };
  /** A late completed check cannot authorize the next stage after cancellation. */
  const stage = async operation => { check(); const value = await bounded(() => { check(); return operation(); }); check(); return value; };
  const completion = { ...message, scope: 'scoped_authentication_native', exitCode: 0 };
  c.check(s.QUALIFICATION_COMPLETION.safeParse(completion).success, 'worker_completion');
  const read = deps.read || p.readNative; const write = deps.write || p.writeNative;
  const { record, hash } = await stage(() => read('attempt.json')); n.validateAttempt(record);
  c.check(record.phase === 'passed' && hash === completion.attemptHash && record.reviewHash === input.reviewHash
    && record.startedAt >= input.review.approvedAt && record.completedAt <= clock()
    && clock() - record.startedAt < n.LIMITS.wholeMs && record.startedAt === deps.startedAt, 'integrity');
  c.check(Object.keys(input.binding).every(key => record[key] === input.binding[key])
    && ['sourceSet', 'decisionHash', 'toolSet'].every(key => completion[key] === input.binding[key]), 'integrity');
  await stage(() => (deps.verify || loadReview)(input.reviewHash));
  for (const owner of record.owners) await stage(() => (deps.inspect || p.inspectNativeClosure)(owner));
  await stage(() => (deps.listeners || listenersAbsent)());
  await stage(() => (deps.verify || loadReview)(input.reviewHash));
  // Started writes are awaited; partial failures are preserved and cannot trigger a replacement write.
  const completionHash = await write('native-completion.json', completion);
  check();
  const result = { schemaVersion: 2, scope: 'scoped_authentication_native', phase: 'passed',
    sourceSet: record.sourceSet, decisionHash: record.decisionHash, toolSet: record.toolSet,
    attemptHash: hash, completionHash, checks: n.qualificationChecks(record.cases), browserTrafficMeasured: false, hostedQualified: false };
  const receiptHash = await write('native-qualification.json', result);
  try { check(); } catch (error) {
    try { await (deps.unlink || fs.unlink)(path.join(n.DIRECTORY, 'native-qualification.json')); }
    catch { throw new c.PreparationError('receipt'); }
    throw error;
  }
  return { phase: 'passed', receiptFinalized: true, receiptHash, browserTrafficMeasured: false, hostedQualified: false, gate1Status: 'open' };
}

/** Strip the real expected identity from the synthetic worker as well as the owned Chrome environment. */
function workerEnvironment(env = process.env) { const result = s.childEnvironment(env); delete result.GATE1_APPROVED_USER_ID; return result; }

/** Validate one bounded worker result; only a timely successful completion with zero exit may finalize. */
async function supervise(input, deps = {}) {
  const clock = deps.clock || Date.now; const startedAt = clock(); const deadline = Math.min(startedAt + n.LIMITS.wholeMs, input.review.expiresAt);
  const signals = deps.signals || process; const cancellation = new AbortController(); let cancelWorker = () => {};
  /** Explicit cancellation remains latched even after worker completion and throughout independent finalization. */
  const cancelUser = () => { cancellation.abort(); cancelWorker(); };
  signals.on('SIGINT', cancelUser); signals.on('SIGTERM', cancelUser);
  try {
    const message = await new Promise((resolve, reject) => {
      const child = (deps.spawn || spawn)(process.execPath, [__filename, '--native-worker', input.reviewHash, String(startedAt)],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: workerEnvironment() });
      let completion; let stopped = null; let invalid = false; let finished = false;
      /** IPC cancellation never force-kills Chrome; the original end clock remains authoritative. */
      const cancel = () => { if (child.connected) child.send({ cancel: true }, () => {}); };
      cancelWorker = cancel;
      const workTimer = setTimeout(cancel, Math.max(1, deadline - n.LIMITS.cleanupMs - clock()));
      const endTimer = setTimeout(() => { cancel(); finish('expired'); }, Math.max(1, deadline - clock()));
      /** Finish once and remove worker timers; operator signals remain active until finalization settles. */
      function finish(error, code) {
        if (finished) return; finished = true; clearTimeout(workTimer); clearTimeout(endTimer);
        cancelWorker = () => {};
        if (cancellation.signal.aborted) reject(new c.PreparationError('cancelled'));
        else if (error || clock() >= deadline) reject(new c.PreparationError(error || 'expired'));
        else if (!invalid && stopped) reject(new c.PreparationError(stopped));
        else if (invalid || code !== 0 || !completion) reject(new c.PreparationError('worker_completion'));
        else resolve(completion);
      }
      child.on('message', value => {
        if (finished) return;
        try {
          if (completion || stopped || Buffer.byteLength(JSON.stringify(value)) > 2048) {
            invalid = true; cancel();
          } else if (stoppedWorkerSchema.safeParse(value).success) stopped = value.firstFailure;
          else if (!workerSchema.safeParse(value).success) {
            invalid = true; cancel();
          } else completion = value;
        } catch { invalid = true; cancel(); }
      });
      child.once('error', () => finish('worker_completion'));
      child.once('close', code => finish(null, code));
    });
    c.check(!cancellation.signal.aborted, 'cancelled');
    return await (deps.finalize || finalize)(message, input, deadline, { clock, startedAt, signal: cancellation.signal });
  } finally { signals.removeListener('SIGINT', cancelUser); signals.removeListener('SIGTERM', cancelUser); }
}

/** Only the explicit native command plus separately approved digest may spawn; offline template/hash are read-only. */
async function main(args) {
  if (args.length === 1 && args[0] === '--review-template') return reviewTemplate();
  if (args.length === 1 && args[0] === '--source-hash') return s.sourceHashes();
  const worker = args[0] === '--native-worker';
  c.check((worker || args[0] === '--execute-native') && args.length === (worker ? 3 : 2), 'arguments');
  if (worker) c.check(process.connected === true && /^\d{1,16}$/.test(args[2]), 'approval');
  const input = await loadReview(args[1]);
  if (!worker) return supervise(input);
  const result = await run(input, Number(args[2]));
  await new Promise((resolve, reject) => process.send(result, error => error ? reject(new c.PreparationError('worker_completion')) : resolve()));
  process.disconnect(); if (result.phase !== 'passed') process.exitCode = 1; return result;
}

module.exports = { bindings, reviewTemplate, loadReview, reserveArtifacts, listenersAbsent, launchOwned, closeOwned,
  settled, navigate, workerPage, observeRestoredWorker, lifecycle, restoredWorker, cancellation, negativeCase, browserCase,
  dependencies, run, finalize, workerEnvironment, supervise, main };
if (require.main === module) main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'),
  error => { process.stderr.write(JSON.stringify({ phase: 'stopped', firstFailure: c.errorCode(error) }) + '\n'); process.exitCode = 1; });
