'use strict';
/* global structuredClone */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate } = require('node:timers/promises');
const vm = require('node:vm');
const p = require('../authentication-preparation-scoped-postflight.cjs');
const c = require('../authentication-preparation-scoped-contract.cjs');
const a = require('../authentication-preparation.cjs');
const d = require('../hosted-csrf-diagnostic.cjs');
const HASH = 'a'.repeat(64);

/** Construct an incomplete aggregate only; no real native result is fabricated or written. */
function startupRecord() {
  const n = require('../authentication-preparation-scoped-native-contract.cjs');
  const root = new n.NativeLedger(1000, 181000, () => 1000, 'startup'); new n.NativeBudget(root, n.STARTUP_CASE);
  return { ...Object.fromEntries(Object.keys(n.bindingSchema.shape).map(key => [key, HASH])), schemaVersion: 1,
    scope: 'scoped_authentication_startup_attempt', reviewHash: HASH, startedAt: 1000, completedAt: 1500,
    launchAt: null, observationEndedAt: null, readyAt: null, pagesReady: 0, outcome: 'incomplete',
    firstFailure: 'process_inspection', destinationReason: null, failureStage: 'preflight', cleanup: true,
    owner: null, totals: root.totals, traffic: root.traffic(), proxy: null,
    browserTrafficMeasured: false, hostedQualified: false, gate1Status: 'open', backgroundHttp: 'unknown' };
}

/** New metadata-only paths do not widen either the original native profile list or the live path validator. */
test('startup profile inspection is exact and process visibility remains independently mandatory', async () => {
  const n = require('../authentication-preparation-scoped-native-contract.cjs');
  const io = { lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }), realpath: async value => value, access: async () => {} };
  assert.equal(await p.startupProfile(n.STARTUP_PROFILE, io), true);
  for (const profile of [d.PROFILE, n.PROFILES[0], `${n.STARTUP_PROFILE}/other`]) await assert.rejects(p.startupProfile(profile, io), { code: 'profile' });
  await assert.rejects(p.nativeProfile(n.STARTUP_PROFILE, io), { code: 'profile' });
  await assert.rejects(p.profilePreserved(n.STARTUP_PROFILE, io), { code: 'profile' });
  assert.equal(await p.inspectProfileAbsence(n.STARTUP_PROFILE, async script => {
    assert.ok(script.includes(n.STARTUP_PROFILE.replaceAll('/', '\\'))); return { complete: true, matches: 0, uninspectable: 0 };
  }), true);
  await assert.rejects(p.inspectProfileAbsence(n.STARTUP_PROFILE, async () => ({ complete: true, matches: 0, uninspectable: 1 })), { code: 'process_inspection' });
  await assert.rejects(p.inspectProfileAbsence(n.STARTUP_PROFILE, async () => ({ complete: true, matches: 1, uninspectable: 0 })), { code: 'process_present' });
});

/** Bounded aggregate reads reject profile traversal, symlinks, oversized files and redirected parents before parsing. */
test('startup evidence reads never accept arbitrary names or redirected oversized files', async () => {
  const n = require('../authentication-preparation-scoped-native-contract.cjs'); const bytes = require('node:buffer').Buffer.from(JSON.stringify(startupRecord()));
  const io = { realpath: async file => file,
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: bytes.length }), readFile: async () => bytes };
  assert.equal((await p.readStartup('attempt.json', io)).record.scope, 'scoped_authentication_startup_attempt');
  for (const name of ['worker-started', '../attempt.json', 'profiles/startup/Cookies', 'native-qualification.json']) await assert.rejects(p.readStartup(name, io), { code: 'receipt' });
  await assert.rejects(p.readStartup('attempt.json', { ...io, realpath: async () => n.DIRECTORY }), { code: 'receipt' });
  for (const changed of [{ size: 16385 }, { size: 0 }, { isSymbolicLink: () => true }, { isFile: () => false }]) {
    await assert.rejects(p.readStartup('attempt.json', { ...io, lstat: async () => ({ ...await io.lstat(), ...changed }),
      readFile: () => assert.fail('invalid metadata must be rejected before reading') }), { code: 'receipt' });
  }
});

/** Exclusive writes fsync and close; partial failures never delete or replace the consumed evidence. */
test('startup evidence writes are strict exclusive and preserve write sync and close failures', async () => {
  const n = require('../authentication-preparation-scoped-native-contract.cjs'); const record = startupRecord();
  for (const failure of [null, 'writeFile', 'sync', 'close']) {
    const calls = []; const io = { realpath: async file => file, open: async (file, mode) => {
      assert.equal(file, require('node:path').join(n.STARTUP_DIRECTORY, 'attempt.json')); assert.equal(mode, 'wx');
      return Object.fromEntries(['writeFile', 'sync', 'close'].map(name => [name, async () => { calls.push(name); if (name === failure) throw new Error('synthetic'); }]));
    } };
    if (failure) await assert.rejects(p.writeStartup('attempt.json', record, io), { code: 'receipt' });
    else assert.match(await p.writeStartup('attempt.json', record, io), /^[a-f0-9]{64}$/);
    assert.equal(calls.at(-1), 'close');
  }
  await assert.rejects(p.writeStartup('execution-review.json', record), { code: 'receipt' });
  await assert.rejects(p.writeStartup('attempt.json', { ...record, rawUrl: 'private' }), { code: 'receipt' });
  await assert.rejects(p.writeNative('attempt.json', record), { code: 'receipt' });
});

/** Keep metadata-only native profile checks separate from live wrapper acceptance. */
test('native closure paths never weaken exact live profile and evidence guards', async () => {
  const n = require('../authentication-preparation-scoped-native-contract.cjs'); const profile = n.PROFILES[0];
  assert.match(n.DIRECTORY, /scoped-native-02$/);
  const io = { lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }), realpath: async value => value, access: async () => {} };
  assert.equal(await p.nativeProfile(profile, io), true);
  await assert.rejects(p.profilePreserved(profile, io), { code: 'profile' });
  await assert.rejects(p.nativeProfile(d.PROFILE, io), { code: 'profile' });
  await assert.rejects(p.nativeProfile(`${profile}/other`, io), { code: 'profile' });
  await assert.rejects(p.nativeProfile(profile.replace('native-02', 'native-01'), io), { code: 'profile' });
  await assert.rejects(p.nativeProfile(n.STARTUP_PROFILE, io), { code: 'profile' });
  await assert.rejects(p.writeExclusive(require('node:path').join(n.DIRECTORY, 'attempt.json'), {}), { code: 'receipt' });
  await assert.rejects(p.writeNative('execution-review.json', {}), { code: 'receipt' });
  await assert.rejects(p.readNative('../attempt.json'), { code: 'receipt' });
  const calls = [];
  const owner = { profile, pid: 7, port: 24000, closedNormally: true, exitCode: 0 };
  assert.equal(await p.inspectNativeClosure(owner, { absence: async value => calls.push(value),
    portClosed: async value => calls.push(value), profile: async value => calls.push(value) }), true);
  assert.deepEqual(calls, [profile, 24000, profile]);
  await assert.rejects(p.inspectNativeClosure({ ...owner, exitCode: 1 }), { code: 'closure' });
});

/** Native writes require a strict categorical record and preserve any failed partial artifact. */
test('native exclusive completion writes require successful fsync and close', async () => {
  const n = require('../authentication-preparation-scoped-native-contract.cjs');
  const record = { scope: 'scoped_authentication_native', phase: 'passed', exitCode: 0, receiptFinalized: true,
    attemptHash: HASH, sourceSet: HASH, decisionHash: HASH, toolSet: HASH };
  for (const failure of [null, 'writeFile', 'sync', 'close']) {
    const calls = [];
    const io = { realpath: async value => value, open: async (file, mode) => {
      assert.equal(file, require('node:path').join(n.DIRECTORY, 'native-completion.json')); assert.equal(mode, 'wx');
      return Object.fromEntries(['writeFile', 'sync', 'close'].map(name => [name, async () => { calls.push(name); if (name === failure) throw new Error('synthetic'); }]));
    } };
    if (failure) await assert.rejects(p.writeNative('native-completion.json', record, io), { code: 'receipt' });
    else assert.match(await p.writeNative('native-completion.json', record, io), /^[a-f0-9]{64}$/);
    assert.equal(calls.at(-1), 'close');
  }
  // Reject an attempt to redirect the new writer into consumed evidence before any file is opened.
  for (const historical of [n.DIRECTORY.replace('native-02', 'native-01'), n.STARTUP_DIRECTORY]) {
    let opened = false;
    await assert.rejects(p.writeNative('native-completion.json', record, {
      realpath: async () => historical,
      /** Record unexpected opens so receipt error conversion cannot hide a realpath guard regression. */
      open: async () => { opened = true; throw new Error('unexpected open'); },
    }), { code: 'receipt' });
    assert.equal(opened, false, 'historical evidence must not be written');
  }
});

/** An expired native pre-write stage stays expired even when its original operation resolves late. */
test('native deadline stages latch timeout and discard late settlements', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); let resolve; let called = false;
  const stage = p.deadlineStages(1005, () => 1000);
  const pending = stage(() => new Promise(done => { resolve = done; })); const rejected = assert.rejects(pending, { code: 'expired' });
  await setImmediate(); context.mock.timers.tick(5); await rejected; resolve(true); await setImmediate();
  await assert.rejects(stage(() => { called = true; }), { code: 'expired' }); assert.equal(called, false);
});

/** Construct aggregate synthetic evidence, never writing a real receipt or claiming native qualification. */
function fixture() {
  const budget = new c.ScopedBudget({ clock: () => 1000 }); budget.launch(); budget.launch();
  for (const [kind, source] of [['session', 'page'], ['session', 'requestClient'], ...Array.from({ length: 6 }, () => ['metadata', 'metadata'])]) {
    const token = budget.reserve(kind, source); budget.acknowledge(token); budget.confirm(token); budget.finish(token);
  }
  const plan = { sourceSet: HASH, decisionHash: HASH, toolSet: HASH, qualificationHash: HASH,
    buildHash: a.BUILD_HASH, buildId: a.BUILD, profile: d.PROFILE, approvedAt: 0, expiresAt: 3600000 };
  const owner = { profile: d.PROFILE, pid: 1, port: 12345, closedNormally: true, exitCode: 0 };
  const record = { ...plan, schemaVersion: 2, scope: 'scoped_authentication_preparation', decision: c.DECISION,
    planHash: HASH, target: { ...d.TARGET }, startedAt: 1000, completedAt: 1500, phase: 'passed', coverage: { ...c.COVERAGE },
    browserTrafficMeasured: false, hostedQualified: false, gate1Status: 'open', identityVerified: true,
    closedNormally: true, independentProcessExitVerified: true, checks: Object.fromEntries(c.CHECKS.map(key => [key, true])),
    owners: [owner, { ...owner, pid: 2, port: 12346 }], listenerPorts: [12347], traffic: budget.snapshot(),
    proxy: { connections: 1, concurrent: 0, overLimit: 0, denied: 0, tunnels: 1, forwardingClosed: true,
      upstream: { read: 1, admitted: 1, rejected: 0, written: 1 }, downstream: { read: 1, admitted: 1, rejected: 0, written: 1 } },
    requests: { actual: { application: 2, static: 0, session: 2 }, conservative: { application: 2, static: 0, session: 2 } } };
  delete record.approvedAt; delete record.expiresAt;
  const completion = { exitCode: 0, phase: 'passed', receiptFinalized: true, attemptHash: HASH, sourceSet: HASH, planHash: HASH };
  return { plan, record, completion };
}

/** Run real finalization with controlled stage promises, clock and timers; all evidence I/O remains synthetic. */
function deadlineFixture() {
  const f = fixture(); const calls = []; const timers = new Map(); const delays = []; const operations = {};
  const state = { now: 2000, bindings: 0 };
  /** Record stage entry and optionally delay or fail that stage to exercise deadline races. */
  async function stage(name) { calls.push(name); return operations[name]?.(); }
  const finalize = vm.runInNewContext(`(${p.finalize.toString()})`, {
    c, RESULT: p.RESULT,
    /** Allow synchronous receipt validation to consume time while retaining the real validation checks. */
    reviewAttempt: (...args) => { p.reviewAttempt(...args); operations.review?.(); },
    /** Keep only one stage timer active and expose its callback without waiting on wall time. */
    setTimeout: (callback, ms) => {
      assert.equal(timers.size, 0); const handle = {}; timers.set(handle, callback); delays.push(ms); return handle;
    },
    clearTimeout: handle => { timers.delete(handle); },
  });
  const deps = { clock: () => state.now, deadline: 3000,
    read: async () => { await stage('read'); return { record: f.record, hash: HASH }; },
    inspect: owner => stage(`owner${owner.pid}`), portClosed: () => stage('port'),
    write: async () => { await stage('write'); return HASH; }, unlink: () => stage('unlink') };
  /** Invoke the production flow with separate labels for its two binding checks. */
  const run = () => finalize(f.completion, f.plan, () => stage(`binding${++state.bindings}`), deps);
  return { ...f, state, deps, calls, timers, delays, operations, run };
}

/** Each pre-write stage must time out permanently, ignoring late resolution or rejection without creating artifacts. */
test('finalization bounds every pre-write stage and ignores late settlements', async () => {
  const stages = ['read', 'binding1', 'owner1', 'owner2', 'port', 'binding2'];
  for (const name of stages) {
    for (const late of ['resolve', 'reject']) {
      const f = deadlineFixture(); let resolve; let reject; let outcome;
      const held = new Promise((yes, no) => { resolve = yes; reject = no; }); f.operations[name] = () => held;
      const pending = f.run().then(() => { outcome = 'passed'; }, error => { outcome = error.code; });
      await setImmediate(); assert.deepEqual(f.calls, stages.slice(0, stages.indexOf(name) + 1));
      assert.equal(f.timers.size, 1); assert.equal(f.delays.at(-1), 1000);
      f.state.now = f.deps.deadline; [...f.timers.values()][0](); await setImmediate();
      assert.equal(outcome, 'expired'); assert.equal(f.timers.size, 0);
      const calls = [...f.calls]; f.state.now = 2000;
      if (late === 'resolve') resolve(); else reject(new c.PreparationError('operation'));
      await setImmediate(); await pending; assert.deepEqual(f.calls, calls);
    }
  }
});

/** All stages share the earliest absolute deadline and must release their timer on success or rejection. */
test('finalization clears settled stage timers and never renews the shared deadline', async () => {
  const stages = ['read', 'binding1', 'owner1', 'owner2', 'port', 'binding2'];
  for (const deadline of [undefined, 3500, 2500]) {
    const f = deadlineFixture(); f.plan.expiresAt = 3000; f.deps.deadline = deadline;
    for (const name of stages) f.operations[name] = () => { f.state.now += 50; };
    assert.equal((await f.run()).receiptFinalized, true); assert.equal(f.timers.size, 0);
    const remaining = Math.min(f.plan.expiresAt, deadline ?? f.plan.expiresAt) - 2000;
    assert.deepEqual(f.delays, stages.map((_name, index) => remaining - index * 50));
  }
  for (const name of stages) {
    const f = deadlineFixture(); f.operations[name] = () => { throw new c.PreparationError('integrity'); };
    await assert.rejects(f.run(), { code: 'integrity' }); assert.equal(f.timers.size, 0);
    assert.deepEqual(f.calls, stages.slice(0, stages.indexOf(name) + 1));
  }
});

/** Delayed timer delivery cannot authorize new work once the injected clock reaches the absolute deadline. */
test('expired entry, last binding check or synchronous receipt validation cannot start a write', async () => {
  const expired = deadlineFixture(); expired.state.now = expired.deps.deadline;
  await assert.rejects(expired.run(), { code: 'expired' }); assert.deepEqual(expired.calls, []);
  assert.equal(expired.timers.size, 0);
  const f = deadlineFixture(); f.operations.binding2 = () => { f.state.now = f.deps.deadline; };
  await assert.rejects(f.run(), { code: 'expired' }); assert.equal(f.timers.size, 0);
  assert.equal(f.calls.includes('write'), false); assert.equal(f.calls.includes('unlink'), false);
  const validating = deadlineFixture(); let reviews = 0;
  validating.operations.review = () => { if (++reviews === 2) validating.state.now = validating.deps.deadline; };
  await assert.rejects(validating.run(), { code: 'expired' }); assert.equal(validating.timers.size, 0);
  assert.equal(validating.calls.includes('write'), false); assert.equal(validating.calls.includes('unlink'), false);
});

/** Once writing starts, finalization waits for its result; only successful expired writes qualify for removal. */
test('an already-started write is not raced against the deadline or cancelled', async () => {
  for (const failure of [false, true]) {
    const f = deadlineFixture(); let resolve; let reject; let outcome;
    const held = new Promise((yes, no) => { resolve = yes; reject = no; }); f.operations.write = () => held;
    const pending = f.run().then(() => { outcome = 'passed'; }, error => { outcome = error.code; });
    await setImmediate(); assert.equal(f.calls.at(-1), 'write'); assert.equal(f.timers.size, 0);
    f.state.now = f.deps.deadline; await setImmediate(); assert.equal(outcome, undefined);
    if (failure) reject(new c.PreparationError('receipt')); else resolve();
    await pending; assert.equal(outcome, failure ? 'receipt' : 'expired');
    assert.equal(f.calls.includes('unlink'), !failure); assert.equal(f.timers.size, 0);
  }
});

test('scoped receipt validates its own boundary and the strict hosted consumer still rejects it', () => {
  const f = fixture(); assert.equal(p.reviewAttempt(f.record, f.completion, f.plan, 2000), true);
  assert.throws(() => d.validatePreparation({ buildId: a.BUILD },
    { phase: 'passed', target: d.TARGET, buildId: a.BUILD, requests: { application: 1, static: 0, session: 0 } }, f.record), { code: 'preparation_missing' });
});

test('malformed, private or inconsistent evidence cannot be finalized', () => {
  for (const mutate of [record => { record.userId = 'private'; }, record => { record.traffic.counts.session++; },
    record => { record.browserTrafficMeasured = true; }, record => { record.proxy.upstream.read++; },
    record => { record.traffic.completed--; }, record => { record.target.deployment = 'drift'; }]) {
    const f = fixture(); mutate(f.record); assert.throws(() => p.reviewAttempt(f.record, f.completion, f.plan, 2000));
  }
  for (const changes of [{ exitCode: 1 }, { receiptFinalized: false }, { sourceSet: 'b'.repeat(64) }, { private: 'value' }]) {
    const f = fixture(); assert.throws(() => p.reviewAttempt(f.record, { ...f.completion, ...changes }, f.plan, 2000));
  }
});

test('missing/unreadable/symlink profiles and incomplete process visibility are failures', async () => {
  for (const kind of ['missing', 'unreadable', 'symlink', 'file']) {
    const io = { lstat: async () => {
      if (kind === 'missing') throw new Error('private path');
      return { isDirectory: () => kind !== 'file', isSymbolicLink: () => kind === 'symlink' };
    }, realpath: async value => value, access: async () => { if (kind === 'unreadable') throw new Error('private path'); } };
    await assert.rejects(p.profilePreserved(d.PROFILE, io), { code: 'profile' });
  }
  for (const value of [{ complete: false, matches: 0, uninspectable: 0 }, { complete: true, matches: 0, uninspectable: 1 },
    { complete: true, matches: 1, uninspectable: 0 }]) await assert.rejects(p.inspectAbsence(async () => value));
});

test('independent postflight checks both owners, every listener and bindings twice before exclusive write', async () => {
  const f = fixture(); const calls = [];
  const result = await p.finalize(f.completion, f.plan, async () => { calls.push('binding'); }, {
    clock: () => 2000, read: async () => ({ record: f.record, hash: HASH }), inspect: async () => { calls.push('owner'); },
    portClosed: async () => { calls.push('port'); }, write: async (file, record) => {
      assert.equal(file, p.RESULT); assert.equal(record.browserTrafficMeasured, false); calls.push('write'); return HASH;
    },
    unlink: async () => { assert.fail('successful finalization must retain RESULT'); },
  });
  assert.deepEqual(calls, ['binding', 'owner', 'owner', 'port', 'binding', 'write']); assert.equal(result.receiptFinalized, true);
});

test('changed source/decision, open listener or altered attempt bytes prevents final write', async () => {
  for (const failure of ['hash', 'bindings', 'listener']) {
    const f = fixture(); let writes = 0; let unlinks = 0;
    await assert.rejects(p.finalize(f.completion, f.plan, async () => { if (failure === 'bindings') throw new c.PreparationError('integrity'); }, {
      clock: () => 2000, read: async () => ({ record: f.record, hash: failure === 'hash' ? 'b'.repeat(64) : HASH }),
      inspect: async () => {}, portClosed: async () => { if (failure === 'listener') throw new c.PreparationError('port_open'); },
      write: async () => { writes++; },
      unlink: async () => { unlinks++; },
    })); assert.equal(writes, 0); assert.equal(unlinks, 0);
  }
});

test('partial write, failed sync and failed close preserve failure instead of finalized success', async () => {
  for (const phase of ['writeFile', 'sync', 'close']) {
    const f = fixture(); let closed = false;
    const handle = { writeFile: async () => {}, sync: async () => {}, close: async () => { closed = true; } };
    handle[phase] = async () => { if (phase === 'close') closed = true; throw new Error('private disk error'); };
    const io = { realpath: async value => value, open: async (file, mode) => {
      assert.equal(file, p.ATTEMPT); assert.equal(mode, 'wx'); return handle;
    } };
    await assert.rejects(p.writeExclusive(p.ATTEMPT, f.record, io), { code: 'receipt' }); assert.equal(closed, true);
  }
});

/** Mock write phases to prove final validation includes fsync/close and removes only the completed RESULT. */
test('expiry during a successful write removes RESULT before rejecting and preserves ATTEMPT', async () => {
  for (const limit of ['expiresAt', 'wholeMs']) {
    for (const phase of ['writeFile', 'sync', 'close']) {
      const f = fixture(); let now = 2000; const calls = [];
      const artifacts = new Map([[p.ATTEMPT, 'attempt']]);
      const expiredAt = limit === 'expiresAt' ? 3000 : f.record.startedAt + c.LIMITS.wholeMs;
      if (limit === 'expiresAt') f.plan.expiresAt = expiredAt;
      const handle = {};
      for (const step of ['writeFile', 'sync', 'close']) {
        /** Model elapsed I/O time without touching authentication evidence on disk. */
        handle[step] = async bytes => {
          calls.push(step);
          if (step === 'writeFile') artifacts.set(p.RESULT, bytes);
          if (step === phase) now = expiredAt;
        };
      }
      const io = { realpath: async value => value, open: async () => handle };
      await assert.rejects(p.finalize(f.completion, f.plan, async () => {}, {
        clock: () => now, read: async () => ({ record: f.record, hash: HASH }),
        inspect: async () => {}, portClosed: async () => {},
        write: (file, record) => p.writeExclusive(file, record, io),
        /** Require awaited cleanup of the completed result while keeping the attempt artifact intact. */
        unlink: async file => {
          assert.equal(file, p.RESULT); assert.equal(artifacts.has(file), true);
          await setImmediate(); artifacts.delete(file); calls.push('unlink');
        },
      }), { code: 'expired' });
      assert.deepEqual(calls, ['writeFile', 'sync', 'close', 'unlink']);
      assert.deepEqual([...artifacts], [[p.ATTEMPT, 'attempt']]);
    }
  }
});

/** A rejected exclusive write retains existing/partial evidence even if the deadline also elapsed. */
test('finalization preserves RESULT on open, write, sync or close failure', async () => {
  for (const phase of ['open', 'writeFile', 'sync', 'close']) {
    const f = fixture(); let now = 2000; let closed = false; let unlinks = 0;
    const artifacts = new Map([[p.ATTEMPT, 'attempt']]);
    if (phase === 'open') artifacts.set(p.RESULT, 'existing');
    const handle = {};
    for (const step of ['writeFile', 'sync', 'close']) {
      /** Retain bytes from failed writes and always observe handle closure through writeExclusive. */
      handle[step] = async () => {
        if (step === 'writeFile') artifacts.set(p.RESULT, 'partial');
        if (step === 'close') closed = true;
        if (step === phase) { now = f.plan.expiresAt; throw new Error('private disk error'); }
      };
    }
    const io = { realpath: async value => value, open: async () => {
      if (phase === 'open') { now = f.plan.expiresAt; throw new Error('existing artifact'); }
      return handle;
    } };
    await assert.rejects(p.finalize(f.completion, f.plan, async () => {}, {
      clock: () => now, read: async () => ({ record: f.record, hash: HASH }),
      inspect: async () => {}, portClosed: async () => {},
      write: (file, record) => p.writeExclusive(file, record, io),
      unlink: async file => { unlinks++; artifacts.delete(file); },
    }), { code: 'receipt' });
    assert.equal(unlinks, 0);
    assert.equal(artifacts.get(p.ATTEMPT), 'attempt');
    assert.equal(artifacts.get(p.RESULT), phase === 'open' ? 'existing' : 'partial');
    assert.equal(closed, phase !== 'open');
  }
});

/** Removal errors must fail finalization without exposing native filesystem details. */
test('failed cleanup of an expired completed result reports a receipt failure', async () => {
  const f = fixture(); let now = 2000; let unlinked = false;
  await assert.rejects(p.finalize(f.completion, f.plan, async () => {}, {
    clock: () => now, read: async () => ({ record: f.record, hash: HASH }),
    inspect: async () => {}, portClosed: async () => {},
    write: async () => { now = f.plan.expiresAt; return HASH; },
    unlink: async file => {
      assert.equal(file, p.RESULT); unlinked = true; throw new Error('private disk error');
    },
  }), { code: 'receipt', message: 'receipt' });
  assert.equal(unlinked, true);
});

test('receipt arithmetic is checked independently of worker assertions', () => {
  const f = fixture(); const record = structuredClone(f.record);
  record.requests.actual.application++; assert.throws(() => c.validateReceipt(record), { code: 'receipt' });
  const unknown = structuredClone(f.record); unknown.coverage.backgroundHttp = 'zero';
  assert.throws(() => c.validateReceipt(unknown), { code: 'receipt' });
});
