'use strict';
/* global structuredClone */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate } = require('node:timers/promises');
const p = require('../authentication-preparation-scoped-postflight.cjs');
const c = require('../authentication-preparation-scoped-contract.cjs');
const a = require('../authentication-preparation.cjs');
const d = require('../hosted-csrf-diagnostic.cjs');
const HASH = 'a'.repeat(64);

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
