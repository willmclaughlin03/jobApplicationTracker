'use strict';
/* global structuredClone, queueMicrotask, AbortController */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setImmediate } = require('node:timers/promises');
const r = require('../authentication-preparation-scoped-native.cjs');
const n = require('../authentication-preparation-scoped-native-contract.cjs');
const c = require('../authentication-preparation-scoped-contract.cjs');
const d = require('../hosted-csrf-diagnostic.cjs');
const HASH = 'a'.repeat(64);

/** Supply pure in-memory review inputs and mock every filesystem/native boundary of the actual orchestrator. */
function fixture() {
  const binding = { sourceSet: HASH, decisionHash: HASH, toolSet: HASH, certificateHash: HASH, keyHash: HASH };
  const review = { ...binding, scope: 'scoped-authentication-native-execution-review-v1', operator: 'Codex', owner: 'project-owner',
    directory: n.DIRECTORY, command: 'node scripts/gate1-browser-tabs/authentication-preparation-scoped-native.cjs --execute-native <execution-review-sha256>',
    cases: structuredClone(n.CASES), limits: { ...n.LIMITS }, spki: n.SPKI, profiles: [...n.PROFILES], ports: [...n.PORTS], approvedAt: 0, expiresAt: 480000 };
  const input = { binding, review, reviewHash: HASH }; const state = { now: 1000, calls: [], writes: [], owners: 0, cancel: null };
  /** Build a case witness matrix from mock native outcomes, never from real browser execution. */
  const witnesses = item => Object.fromEntries(n.WITNESSES[item.id].map(key => [key, true]));
  const deps = { clock: () => state.now, verify: async () => { state.calls.push('verify'); }, preflight: async () => { state.calls.push('preflight'); },
    reserve: async value => { state.calls.push('reserve'); value.reserved = true; }, material: async () => ({ certificateHash: HASH, keyHash: HASH }),
    fixtures: () => ({ start: async () => { state.calls.push('listen'); }, close: async () => { state.calls.push('close-listeners'); } }),
    browserCase: async (item, root) => {
      state.calls.push(item.id); const budget = new n.NativeBudget(root, item); const owners = [];
      for (let index = 0; index < item.launches; index++) {
        budget.launch(); owners.push({ profile: n.profile(item.id), pid: ++state.owners, port: 20000 + state.owners, closedNormally: true, exitCode: 0 }); root.chrome--;
      }
      if (item.expected) budget.stop(item.expected); root.finishCase(budget);
      return { record: { id: item.id, mode: item.mode, launches: item.launches, outcome: 'passed', failure: item.expected,
        witnesses: witnesses(item), cleanup: true }, owners };
    }, transport: async () => { state.calls.push('transport'); return witnesses(n.CASES[8]); },
    write: async (name, record) => { state.writes.push({ name, record }); return HASH; },
    onCancel: cancel => { state.cancel = cancel; return () => { state.cancel = null; }; } };
  return { input, state, deps, run: () => r.run(input, 1000, deps) };
}

test('finite orchestration reserves once, executes the exact matrix and keeps hosted qualification false', async () => {
  const q = fixture(); const completion = await q.run(); assert.equal(completion.phase, 'passed');
  assert.deepEqual(q.state.calls.filter(value => n.CASES.some(item => item.id === value)), n.CASES.map(item => item.id));
  assert.equal(q.state.calls.filter(value => value === 'reserve').length, 1); assert.equal(q.state.writes.length, 1);
  const record = q.state.writes[0].record; n.validateAttempt(record); assert.equal(record.totals.launches, 11);
  assert.equal(record.browserTrafficMeasured, false); assert.equal(record.hostedQualified, false); assert.equal(record.backgroundHttp, 'unknown');
  assert.throws(() => d.validatePreparation(record)); assert.equal(q.state.cancel, null);
});

test('missing native witness is inconclusive and stops before any later case', async () => {
  const q = fixture(); const runCase = q.deps.browserCase;
  q.deps.browserCase = async (...args) => { const result = await runCase(...args); result.record.witnesses.contextLoss = false;
    throw new c.PreparationError('coverage_unqualified'); };
  const result = await q.run(); assert.equal(result.phase, 'inconclusive'); assert.equal(result.receiptFinalized, false);
  assert.equal(q.state.calls.includes('restored-worker'), false); assert.equal(q.state.writes[0].record.completedCases, 0);
});

test('subcase cleanup failure remains false in stopped evidence without replacing the first failure', async () => {
  const q = fixture(); q.deps.browserCase = async (_item, root) => {
    root.cleanupFailed = true; root.stop('observation'); throw new c.PreparationError('observation');
  };
  const result = await q.run(); assert.equal(result.firstFailure, 'observation'); assert.equal(q.state.writes[0].record.cleanup, false);
});

test('failed preflight cannot create a marker, profiles, listener or attempt receipt', async () => {
  const q = fixture(); q.deps.preflight = async () => { throw new c.PreparationError('process_present'); };
  await assert.rejects(q.run(), { code: 'process_present' }); assert.deepEqual(q.state.calls, ['verify']); assert.equal(q.state.writes.length, 0);
});

test('certificate drift between review and listener startup stops without listening', async () => {
  const q = fixture(); q.deps.material = async () => ({ certificateHash: 'b'.repeat(64), keyHash: HASH });
  const result = await q.run(); assert.equal(result.firstFailure, 'integrity'); assert.equal(q.state.calls.includes('listen'), false);
});

test('global cancellation and deadline abort future cases without refunding launches', async () => {
  for (const mode of ['cancel', 'deadline']) {
    const q = fixture(); const runCase = q.deps.browserCase;
    q.deps.browserCase = async (...args) => { const result = await runCase(...args);
      if (mode === 'cancel') q.state.cancel(); else q.state.now = 360000; return result; };
    const result = await q.run(); assert.equal(result.phase, 'stopped');
    assert.equal(q.state.writes[0].record.totals.launches, 3); assert.equal(q.state.calls.includes('restored-worker'), false);
  }
});

test('exclusive reservation precedes profiles and refuses existing artifacts without writes', async () => {
  const calls = []; const state = { reserved: false };
  const io = { realpath: async value => value, readdir: async () => ['execution-review.json'],
    open: async (file, mode) => { calls.push(['open', file, mode]); return { writeFile: async () => {}, sync: async () => {}, close: async () => {} }; },
    mkdir: async value => { calls.push(['mkdir', value]); }, lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }), access: async () => {} };
  await r.reserveArtifacts(state, io); assert.equal(state.reserved, true); assert.equal(calls[0][0], 'open'); assert.equal(calls[0][2], 'wx');
  assert.equal(calls.filter(item => item[0] === 'mkdir').length, 9);
  for (const names of [['execution-review.json', 'worker-started'], ['execution-review.json', 'profiles'], []]) {
    const untouched = []; await assert.rejects(r.reserveArtifacts({}, { ...io, readdir: async () => names,
      open: async () => { untouched.push(true); } }), { code: 'already_used' }); assert.equal(untouched.length, 0);
  }
});

test('review digest, tools and source bytes must all match before native dispatch', async () => {
  const q = fixture(); const deps = { clock: () => 1000, read: async () => ({ record: q.input.review, hash: HASH }), bindings: async () => q.input.binding };
  assert.equal((await r.loadReview(HASH, deps)).reviewHash, HASH);
  await assert.rejects(r.loadReview('invalid', deps), { code: 'approval' });
  for (const key of Object.keys(q.input.binding)) await assert.rejects(r.loadReview(HASH, { ...deps,
    bindings: async () => ({ ...q.input.binding, [key]: 'b'.repeat(64) }) }), { code: 'integrity' });
  await assert.rejects(r.loadReview('b'.repeat(64), deps), { code: 'integrity' });
});

test('native supervisor strips real identity and rejects duplicate, malformed, nonzero or missing completion', async () => {
  assert.deepEqual(r.workerEnvironment({ GATE1_APPROVED_USER_ID: 'private', KEEP: 'ok', DEBUG: 'x' }), { KEEP: 'ok' });
  for (const mode of ['pass', 'duplicate', 'nonzero', 'missing', 'oversize', 'forgedExit', 'late']) {
    const q = fixture(); const message = await q.run(); let finalized = 0;
    const task = r.supervise(q.input, { clock: () => q.state.now,
      spawn: (_command, args, options) => {
        assert.equal(args[1], '--native-worker'); assert.equal(options.windowsHide, true); assert.equal('GATE1_APPROVED_USER_ID' in options.env, false);
        const child = new EventEmitter(); child.connected = true; child.send = (_value, callback) => callback();
        queueMicrotask(() => {
          if (mode !== 'missing') child.emit('message', mode === 'oversize' ? { private: 'x'.repeat(3000) }
            : mode === 'forgedExit' ? { ...message, exitCode: 0 } : message);
          if (mode === 'duplicate') child.emit('message', message);
          if (mode === 'late') q.state.now = 480000;
          child.emit('close', mode === 'nonzero' ? 1 : 0);
        }); return child;
      }, finalize: async (_message, _input, deadline, options) => {
        finalized++; assert.equal(deadline, 480000); assert.equal(options.startedAt, 1000); return 'passed';
      } });
    if (mode === 'pass') { assert.equal(await task, 'passed'); assert.equal(finalized, 1); }
    else { await assert.rejects(task); assert.equal(finalized, 0); }
  }
});

/** Real stopped worker results must retain their bounded first failure after the expected nonzero exit. */
test('native supervisor preserves stopped and inconclusive worker failure categories', async () => {
  for (const firstFailure of ['destination', 'coverage_unqualified']) {
    const q = fixture(); let finalized = false; let cancelled = 0;
    /** Stop the real orchestrator at a mocked browser boundary so its actual result shape crosses IPC. */
    q.deps.browserCase = async () => { throw new c.PreparationError(firstFailure); };
    const message = await q.run();
    assert.equal(message.phase, firstFailure === 'coverage_unqualified' ? 'inconclusive' : 'stopped');
    await assert.rejects(r.supervise(q.input, { clock: () => q.state.now,
      /** Emit the worker's bounded failure before its normal failure exit without spawning a process. */
      spawn: () => {
        const child = new EventEmitter(); child.connected = true;
        child.send = (_value, done) => { cancelled++; done(); };
        queueMicrotask(() => { child.emit('message', message); child.emit('close', 1); }); return child;
      }, finalize: async () => { finalized = true; } }), { code: firstFailure, message: firstFailure });
    assert.equal(finalized, false); assert.equal(cancelled, 0);
  }
});

/** Stopped results share successful completion's strict schema, byte cap and single-message boundary. */
test('native supervisor rejects malformed, oversized and duplicate stopped messages', async () => {
  const q = fixture(); const completion = await q.run();
  const stopped = { phase: 'stopped', firstFailure: 'destination', receiptFinalized: false };
  for (const messages of [[stopped, stopped], [stopped, completion], [completion, stopped],
    [{ ...stopped, phase: 'passed' }], [{ ...stopped, firstFailure: 'private failure' }],
    [{ ...stopped, receiptFinalized: true }], [{ ...stopped, private: 'details' }],
    [{ phase: 'stopped', receiptFinalized: false }], [{ ...stopped, firstFailure: 'x'.repeat(3000) }],
    [{ ...stopped, private: 'details' }, stopped]]) {
    let finalized = false; let cancelled = 0;
    await assert.rejects(r.supervise(q.input, { clock: () => q.state.now,
      /** Deliver invalid or conflicting IPC before exit; cancellation requests remain observable. */
      spawn: () => {
        const child = new EventEmitter(); child.connected = true;
        child.send = (_value, done) => { cancelled++; done(); };
        queueMicrotask(() => { for (const message of messages) child.emit('message', message); child.emit('close', 1); }); return child;
      }, finalize: async () => { finalized = true; } }), { code: 'worker_completion', message: 'worker_completion' });
    assert.equal(finalized, false); assert.ok(cancelled > 0);
  }
});

/** Parent cancellation, elapsed deadlines and child transport errors remain authoritative over a worker failure. */
test('native supervisor errors take precedence over a stopped worker result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const mode of ['SIGINT', 'SIGTERM', 'expired-close', 'expired-timer', 'cancelled-expired', 'child-error']) {
    const q = fixture(); const signals = new EventEmitter(); let child; let finalized = false;
    const pending = r.supervise(q.input, { clock: () => q.state.now, signals,
      /** Retain an in-memory child so each parent event can race its stopped message and exit deterministically. */
      spawn: () => { child = new EventEmitter(); child.connected = true; child.send = (_value, done) => done(); return child; },
      finalize: async () => { finalized = true; } });
    const code = mode.startsWith('expired') ? 'expired' : mode === 'child-error' ? 'worker_completion' : 'cancelled';
    const rejected = assert.rejects(pending, { code, message: code });
    child.emit('message', { phase: 'stopped', firstFailure: 'destination', receiptFinalized: false });
    if (mode.includes('expired')) q.state.now = 480000;
    if (mode === 'SIGINT' || mode === 'SIGTERM') signals.emit(mode);
    if (mode === 'cancelled-expired') signals.emit('SIGINT');
    if (mode === 'expired-timer') t.mock.timers.tick(479000);
    if (mode === 'child-error') child.emit('error', new Error('private worker error'));
    child.emit('close', 1); await rejected;
    assert.equal(finalized, false);
    assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
  }
});

test('operator cancellation between valid completion and zero exit prevents finalization and removes signal handlers', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const q = fixture(); const message = await q.run(); const signals = new EventEmitter(); let finalized = false; let cancelled = 0;
    await assert.rejects(r.supervise(q.input, { clock: () => q.state.now, signals,
      spawn: () => {
        const child = new EventEmitter(); child.connected = true; child.send = (_value, done) => { cancelled++; done(); };
        queueMicrotask(() => { child.emit('message', message); signals.emit(signal); child.emit('close', 0); }); return child;
      }, finalize: async () => { finalized = true; } }), { code: 'cancelled' });
    assert.equal(finalized, false); assert.equal(cancelled, 1);
    assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
  }
});

test('operator cancellation remains connected during independent finalization', async () => {
  const q = fixture(); const message = await q.run(); const signals = new EventEmitter();
  await assert.rejects(r.supervise(q.input, { clock: () => q.state.now, signals,
    spawn: () => {
      const child = new EventEmitter(); child.connected = true; child.send = () => assert.fail('exited worker');
      queueMicrotask(() => { child.emit('message', message); child.emit('close', 0); }); return child;
    }, finalize: async (_message, _input, _deadline, deps) => {
      signals.emit('SIGINT'); assert.equal(deps.signal.aborted, true); throw new c.PreparationError('cancelled');
    } }), { code: 'cancelled' });
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

/** Run real native finalization using exclusively in-memory attempts, write handles and process witnesses. */
async function finalizerFixture() {
  const q = fixture(); const message = await q.run(); const record = q.state.writes[0].record; const calls = [];
  q.state.now = 2000;
  const deps = { startedAt: 1000, clock: () => q.state.now, read: async () => ({ record, hash: HASH }),
    verify: async () => { calls.push('verify'); }, inspect: async () => { calls.push('inspect'); }, listeners: async () => { calls.push('listeners'); },
    write: async name => { calls.push(name); return HASH; }, unlink: async file => { calls.push(['unlink', file]); } };
  return { ...q, message, record, calls, finalDeps: deps, finalize: () => r.finalize(message, q.input, 3000, deps) };
}

test('native finalizer independently inspects all owners before writing completion and qualification', async () => {
  const q = await finalizerFixture(); assert.equal((await q.finalize()).phase, 'passed');
  assert.deepEqual(q.calls, ['verify', ...Array(11).fill('inspect'), 'listeners', 'verify', 'native-completion.json', 'native-qualification.json']);
  for (const mutation of [value => { value.record.owners[0].profile = d.PROFILE; }, value => { value.record.checks.manualContextRecovery = false; },
    value => { value.record.cases[0].witnesses.contextLoss = false; }, value => { value.message.attemptHash = 'b'.repeat(64); },
    value => { value.finalDeps.startedAt = 999; }]) {
    const invalid = await finalizerFixture(); mutation(invalid); await assert.rejects(invalid.finalize());
    assert.equal(invalid.calls.includes('native-qualification.json'), false);
  }
});

test('started writes are awaited, failed partials preserved and late completed qualification removed', async () => {
  for (const phase of ['hold', 'failed', 'late']) {
    const q = await finalizerFixture(); let release; let entered = false; const base = q.finalDeps.write;
    q.finalDeps.write = async name => {
      await base(name); if (name === 'native-qualification.json') {
        entered = true;
        if (phase === 'hold') await new Promise(resolve => { release = resolve; });
        if (phase === 'failed') throw new c.PreparationError('receipt');
        q.state.now = 3000;
      } return HASH;
    };
    const pending = q.finalize(); const rejected = assert.rejects(pending);
    if (phase === 'hold') { while (!entered) await setImmediate(); q.state.now = 3000; await setImmediate();
      assert.equal(q.calls.some(item => Array.isArray(item)), false); release(); }
    await rejected; assert.equal(q.calls.some(item => Array.isArray(item)), phase !== 'failed');
  }
});

test('finalization cancellation stops later stages and removes only a completed qualification write', async () => {
  for (const phase of ['inspect', 'native-completion.json', 'native-qualification.json', 'partial']) {
    const q = await finalizerFixture(); const controller = new AbortController(); q.finalDeps.signal = controller.signal;
    if (phase === 'inspect') q.finalDeps.inspect = async () => { controller.abort(); };
    else {
      const write = q.finalDeps.write;
      q.finalDeps.write = async name => {
        await write(name);
        if (name === phase || (phase === 'partial' && name === 'native-qualification.json')) {
          controller.abort(); if (phase === 'partial') throw new c.PreparationError('receipt');
        } return HASH;
      };
    }
    await assert.rejects(q.finalize(), { code: phase === 'partial' ? 'receipt' : 'cancelled' });
    assert.equal(q.calls.some(item => Array.isArray(item)), phase === 'native-qualification.json');
    if (phase === 'inspect' || phase === 'native-completion.json') assert.equal(q.calls.includes('native-qualification.json'), false);
  }
});

/** Failed removal must report the leftover receipt categorically; successful removal retains the final check error. */
test('qualification cleanup categorizes unlink failures after cancellation or expiration', async () => {
  for (const reason of ['cancelled', 'expired']) for (const unlinkFails of [false, true]) {
    const q = await finalizerFixture(); const controller = new AbortController(); q.finalDeps.signal = controller.signal;
    const write = q.finalDeps.write; let artifactPresent = false; let unlinks = 0;
    /** Model a completed qualification write before cancellation or expiration invalidates it. */
    q.finalDeps.write = async name => {
      const hash = await write(name);
      if (name === 'native-qualification.json') {
        artifactPresent = true;
        if (reason === 'cancelled') controller.abort(); else q.state.now = 3000;
      }
      return hash;
    };
    /** Remove only the qualification artifact, retaining it when the injected filesystem boundary fails. */
    q.finalDeps.unlink = async file => {
      assert.equal(file, path.join(n.DIRECTORY, 'native-qualification.json')); unlinks++;
      if (unlinkFails) throw Object.assign(new Error('private filesystem details'), { code: 'EACCES' });
      artifactPresent = false;
    };
    const code = unlinkFails ? 'receipt' : reason;
    await assert.rejects(q.finalize(), { code, message: code });
    assert.equal(unlinks, 1); assert.equal(artifactPresent, unlinkFails);
  }
});

/** Model only the restored-worker protocol stream; no browser, socket or profile is created. */
async function workerFixture() {
  const root = new n.NativeLedger(0, 480000, () => 1000); const budget = new n.NativeBudget(root, n.CASES[1]);
  const cdp = new EventEmitter(); const calls = []; const owner = { cdp, page: { id: 'page' } };
  cdp.send = async (method, _params, session) => { calls.push([method, session]); return {}; };
  await r.observeRestoredWorker(owner, budget);
  const attached = { method: 'Target.attachedToTarget', params: { sessionId: 'worker-session', waitingForDebugger: true,
    targetInfo: { type: 'service_worker', targetId: 'worker', url: `${n.ORIGIN}/worker.js` } } };
  const probe = { method: 'Network.requestWillBeSent', sessionId: 'worker-session', params: { request: { method: 'GET', url: `${n.ORIGIN}/worker-probe` } } };
  return { root, budget, cdp, calls, owner, attached, probe };
}

test('restored-worker discovery cannot qualify a probe; Network observation precedes resume and uncertainty stays charged', async () => {
  const q = await workerFixture();
  q.cdp.emit('event', { method: 'Target.targetCreated', params: { targetInfo: q.attached.params.targetInfo } });
  assert.equal(q.owner.workerProbeObserved, false); assert.equal(q.owner.workerReady.size, 0);
  q.cdp.emit('event', q.attached); await setImmediate();
  assert.deepEqual(q.calls.slice(1), [['Network.enable', 'worker-session'], ['Runtime.runIfWaitingForDebugger', 'worker-session']]);
  assert.equal(q.owner.workerProbeObserved, false); q.cdp.emit('event', q.probe); assert.equal(q.owner.workerProbeObserved, true);
  assert.equal(q.budget.snapshot().uncertain, 1); assert.equal(q.root.totals.application, 1);
  q.budget.stop('cancelled'); assert.equal(q.budget.snapshot().uncertain, 1);
});

test('restored-worker setup rejects wrong, unpaused, duplicate and extra targets before resuming', async () => {
  for (const mode of ['url', 'type', 'unpaused', 'page', 'duplicate', 'extra']) {
    const q = await workerFixture(); let release;
    q.cdp.send = async (method, _params, session) => {
      q.calls.push([method, session]); if (method === 'Network.enable') await new Promise(resolve => { release = resolve; }); return {};
    };
    const event = structuredClone(q.attached);
    if (mode === 'url') event.params.targetInfo.url = `${n.ORIGIN}/ready`;
    if (mode === 'type') event.params.targetInfo.type = 'shared_worker';
    if (mode === 'unpaused') event.params.waitingForDebugger = false;
    if (mode === 'page') event.params.targetInfo = { type: 'page', targetId: 'foreign' };
    q.cdp.emit('event', event);
    if (mode === 'duplicate' || mode === 'extra') {
      if (mode === 'extra') { event.params.sessionId = 'other-session'; event.params.targetInfo.targetId = 'other-worker'; }
      q.cdp.emit('event', event);
    }
    assert.equal(q.budget.failure, 'observation'); release?.(); await setImmediate();
    assert.equal(q.calls.some(([method]) => method === 'Runtime.runIfWaitingForDebugger'), false);
    assert.equal(q.owner.workerReady.size, 0); assert.equal(q.budget.snapshot().uncertain, 1);
  }
});

test('cancellation or detachment during restored-worker initialization cannot resume late', async () => {
  for (const mode of ['cancel', 'detach']) {
    const q = await workerFixture(); let release;
    q.cdp.send = async method => { q.calls.push([method]); if (method === 'Network.enable') await new Promise(resolve => { release = resolve; }); return {}; };
    q.cdp.emit('event', q.attached);
    if (mode === 'cancel') q.budget.stop('cancelled'); else q.cdp.emit('event', { method: 'Target.detachedFromTarget' });
    release(); await setImmediate();
    assert.equal(q.calls.some(([method]) => method === 'Runtime.runIfWaitingForDebugger'), false);
    assert.equal(q.owner.workerReady.size, 0); assert.equal(q.owner.workerProbeObserved, false);
  }
});

test('frame listener postflight checks the second loopback address and native CLI rejects ungated execution', async () => {
  const ports = []; await r.listenersAbsent(async (...args) => ports.push(args)); assert.deepEqual(ports[1], ['127.0.0.2', 18444]);
  for (const args of [[], ['--force'], ['--execute-native'], ['--native-worker', HASH, '1000'], ['--execute-native', 'invalid']]) await assert.rejects(r.main(args));
});

test('cancellation during preflight prevents artifact reservation and late profile creation', async () => {
  const q = fixture(); q.deps.preflight = async () => { q.state.cancel(); };
  await assert.rejects(q.run(), { code: 'cancelled' }); assert.equal(q.state.calls.includes('reserve'), false);
  const calls = []; let checks = 0;
  await assert.rejects(r.reserveArtifacts({ check: () => { if (++checks > 2) throw new c.PreparationError('deadline'); } }, {
    realpath: async value => value, readdir: async () => ['execution-review.json'],
    open: async () => ({ writeFile: async () => {}, sync: async () => {}, close: async () => {} }),
    mkdir: async value => calls.push(value),
  }), { code: 'deadline' }); assert.equal(calls.length, 0);
});

/** A denied launch reservation has no browser to close; proxy cleanup must not become a false browser closure failure. */
test('exhausted launch budget skips browser cleanup and still closes the proxy', async () => {
  const root = new n.NativeLedger(0, 480000, () => 1000); const calls = [];
  root.totals.launches = n.LIMITS.launches;
  const proxy = { start: async () => {}, seal: () => {}, close: async () => { calls.push('proxy-close'); } };
  const adapter = {
    /** Record any forbidden launch attempt after the shared reservation ceiling has been reached. */
    launch: async () => { calls.push('launch'); },
    /** Match normal cleanup's rejection of an owner with no successfully exited child process. */
    close: async () => { calls.push('close'); throw new c.PreparationError('closure'); },
  };
  await assert.rejects(r.browserCase(n.CASES[0], root, {}, { proxy: () => proxy, adapters: () => adapter }), { code: 'budget' });
  assert.deepEqual(calls, ['proxy-close']); assert.equal(root.cleanupFailed, false); assert.equal(root.failure, 'budget');
  assert.equal(root.totals.launches, n.LIMITS.launches); assert.equal(root.budgets[0].launches, 0);
  assert.equal(root.chrome, 0); assert.equal(root.active, null);
});

test('failed native launch remains owned for normal closure and cannot start a second browser', async () => {
  const root = new n.NativeLedger(0, 480000, () => 1000); const calls = [];
  const proxy = { start: async () => {}, seal: () => {}, close: async () => {}, open: () => {} };
  const adapter = { launch: async owner => { calls.push('launch'); owner.child = { pid: 77, exitCode: null }; owner.port = 24567;
    throw new c.PreparationError('observation'); },
  close: async owner => { calls.push('close'); owner.closed = true; owner.child.exitCode = 0;
    return { profile: owner.profile, pid: 77, port: 24567, closedNormally: true, exitCode: 0 }; },
  inspect: async () => { calls.push('inspect'); return true; } };
  await assert.rejects(r.browserCase(n.CASES[0], root, {}, { proxy: () => proxy, adapters: () => adapter }), { code: 'observation' });
  assert.deepEqual(calls, ['launch', 'close', 'inspect']); assert.equal(root.totals.launches, 1); assert.equal(root.chrome, 0);
});
