'use strict';
/* global __dirname, Buffer, AbortController, setImmediate */
/** Offline orchestration tests use in-memory writes, fake children and synthetic projected diagnostics only. */
const { test, jest: mocks, afterEach } = require('@jest/globals');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const runner = require('../diagnose-builds.cjs');
const provider = require('../provider-read-child.cjs');
const upstream = require(path.join(provider.ROOT, '.tmp/gate1-rollback-tools/build-attribution-49owz1V7-attempt-1/observe-build.cjs'));
const { TARGET } = provider;
const MANIFEST = { packageDigest: 'b'.repeat(64) };
const SECRET = 'synthetic-sensitive-text-never-retain';

/** Reset mock state and timers between tests so no weakened boundary escapes its own fixture. */
afterEach(() => { mocks.restoreAllMocks(); mocks.useRealTimers(); });

/** Supply an independently specified safe receipt instead of calling the child projector to construct expectations. */
function metadata() {
  return { classification: 'conflict_identified', reason: 'output_node_runtime_mismatch', nodeMajors: [null, 24],
    nodeMajorSlotOrder: 'output_runtime_then_lambda_runtime', outputClassification: 'known_application_route',
    qualification: 'unqualified_metadata_only', historicalCause: 'not_proven_same_response' };
}

/** Model a single provider dispatch plus checkpoints without any application transport or evidence files. */
function harness({ mutate = () => {}, now, announcements = 1, failSave = -1 } = {}) {
  const calls = [], saves = [];
  let saveCalls = 0;
  return { calls, saves, get saveCalls() { return saveCalls; }, deps: {
    now,
    /** Announce the fake read exactly as a guarded child would, then return only synthetic metadata. */
    async provider(phase, deploymentId, timeoutMs, signal, onDispatch) {
      calls.push(phase); assert.equal(phase, 'builds'); assert.equal(deploymentId, TARGET.deploymentId);
      assert.ok(timeoutMs <= 30000); assert.equal(signal.aborted, false);
      for (let i = 0; i < announcements; i++) onDispatch();
      const value = metadata(); mutate(value); return value;
    },
    /** Keep all report snapshots in memory and optionally simulate one failed durability checkpoint. */
    save(report) {
      if (saveCalls++ === failSave) throw new Error(SECRET);
      saves.push(JSON.parse(JSON.stringify(report)));
    },
  } };
}

/** Identifying a conflict is still a qualification stop and cannot manufacture runtime or prior-response proof. */
test('records one conflict and stops without any application request', async () => {
  const h = harness(), report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.deepEqual(h.calls, ['builds']); assert.equal(report.providerAttempts, 1);
  assert.equal(report.providerDispatchAnnouncements, 1); assert.equal(report.applicationAttempts, 0);
  assert.equal(report.result, 'stopped'); assert.equal(report.failure, 'attribution_conflict');
  assert.deepEqual(report.observations[0].metadata, metadata());
  assert.equal(report.currentRuntime.status, 'not_observed'); assert.equal(report.currentRuntime.nodeVersion, null);
  assert.equal(report.exactManifestComparison, 'unqualified'); assert.equal(report.gate1Status, 'open');
  assert.equal(report.gate5aStatus, 'unpassed'); assert.equal(report.rollbackExecuted, false);
  assert.equal(report.runtimeProbeExecuted, false); assert.ok(report.historicalCause.startsWith('unknown'));
  assert.ok(!JSON.stringify(h.saves).includes(SECRET));
});

/** No reproduced conflict is inconclusive, including incomplete metadata, and never starts another read. */
test('a nonconflicting new sample cannot pass or erase the consumed attempt', async () => {
  const h = harness({ mutate: (m) => { m.classification = 'not_reproduced'; m.reason = null; m.nodeMajors = [];
    m.nodeMajorSlotOrder = 'not_applicable'; m.outputClassification = 'not_applicable'; } });
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.result, 'inconclusive'); assert.equal(report.failure, null);
  assert.equal(h.calls.length, 1); assert.equal(report.exactManifestComparison, 'unqualified');
});

/** Parent validation independently rejects raw fields or fabricated classification claims. */
test.each([
  (m) => { m.secret = SECRET; },
  (m) => { m.reason = SECRET; },
  (m) => { m.nodeMajors = [SECRET]; },
  (m) => { m.outputClassification = SECRET; },
  (m) => { m.nodeMajorSlotOrder = SECRET; },
  (m) => { m.outputClassification = 'not_applicable'; },
  (m) => { m.qualification = 'pass'; },
  (m) => { m.historicalCause = 'confirmed'; },
])('invalid provider receipt %# stops without retention', async (mutate) => {
  const h = harness({ mutate }), report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.failure, 'provider_schema'); assert.deepEqual(report.observations, []);
  assert.equal(h.calls.length, 1); assert.ok(!JSON.stringify(report).includes(SECRET));
});

/** Failure at any reservation-phase, dispatch, observation or terminal checkpoint is terminal and never retried. */
test.each([0, 1, 2, 3, 4])('checkpoint %s stops without a save retry', async (failSave) => {
  const h = harness({ failSave }), report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.failure, 'checkpoint'); assert.equal(h.saveCalls, failSave + 1);
  assert.equal(h.calls.length, failSave < 2 ? 0 : 1);
});

/** Zero or duplicate announcements cannot be accepted as the single authorized physical-dispatch proxy. */
test.each([0, 2])('rejects %s dispatch announcements', async (announcements) => {
  const h = harness({ announcements }), report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.failure, announcements ? 'request_budget' : 'child_protocol');
  assert.equal(h.calls.length, 1); assert.equal(report.applicationAttempts, 0);
});

/** A deadline expired before the first dispatch leaves the request count at zero. */
test('monotonic overall deadline blocks traffic', async () => {
  let clock = 0;
  const h = harness({ now: () => { clock += 45001; return clock; } });
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.failure, 'overall_deadline'); assert.equal(h.calls.length, 0);
});

/** An uncooperative transport is bounded by the outer deadline, with no surviving timers. */
test('stalled provider is cancelled at the overall deadline', async () => {
  mocks.useFakeTimers();
  const h = harness(); h.deps.provider = () => new Promise(() => {});
  const pending = runner.runWithAdapters(MANIFEST, h.deps);
  await mocks.advanceTimersByTimeAsync(45001);
  assert.equal((await pending).failure, 'overall_deadline'); assert.equal(mocks.getTimerCount(), 0);
});

/** Late callbacks cannot mutate a completed report or restart the single-read exercise. */
test('late dispatch after observation is rejected without changing accounting', async () => {
  const h = harness(); let dispatch;
  h.deps.provider = async (phase, id, timeout, signal, onDispatch) => {
    dispatch = onDispatch; onDispatch(); return metadata();
  };
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.throws(() => dispatch(), { code: 'request_budget' });
  assert.equal(report.providerDispatchAnnouncements, 1);
});

/** Model a filesystem in memory so reservation/checkpoint tests never create evidence artifacts. */
function fakeIo(existing = false, failAt = null) {
  const writes = [], data = [];
  let present = existing;
  /** Simulate a filesystem failure at a named reservation operation, after recording any attempted write. */
  function fail(point) { if (failAt === point) throw new Error('synthetic disk failure'); }
  return { writes, data,
    /** Report attempt-directory presence independently of open report handles. */
    existsSync() { return present; },
    /** Model exclusive directory creation, including a competing reservation after the initial check. */
    mkdirSync() {
      if (failAt === 'race') present = true;
      if (present) { const error = new Error(); error.code = 'EEXIST'; throw error; }
      fail('mkdir'); present = true;
    },
    /** Record partial profile/reservation writes before an injected failure. */
    writeFileSync(file, bytes, options) { writes.push({ file, bytes, options }); fail(path.basename(file)); },
    /** Model report creation failing before a sink can be returned. */
    openSync(file, flag) { writes.push({ file, flag }); fail('report.json'); return 1; },
    /** Keep truncation entirely in memory; write tests separately inject partial progress. */
    ftruncateSync() {},
    /** Capture synthetic checkpoint content and acknowledge the requested byte count. */
    writeSync(fd, bytes, offset, length) { data.push(bytes.toString()); return length; },
    /** Model a successful durability flush without touching a disk. */
    fsyncSync() {},
    /** Model releasing the synthetic report descriptor without changing reservation state. */
    closeSync() {},
  };
}

test('reservation is exclusive and records consumed no-replay state', () => {
  const io = fakeIo();
  const sink = runner.reserve(MANIFEST, io);
  assert.equal(io.writes.length, 3);
  assert.ok(io.writes.every((row) => (row.flag || row.options.flag) === 'wx'));
  assert.ok(io.writes.every((row) => path.dirname(row.file) === path.join(provider.ROOT, runner.PROFILE.evidenceDirectory)));
  assert.ok(io.writes[1].bytes.includes('reserved_no_replay'));
  sink.save({ safe: true }); sink.close();
  assert.deepEqual(JSON.parse(io.data[0]), { safe: true });
});

test('existing reservation blocks all file writes and dispatch', () => {
  const io = fakeIo(true);
  assert.throws(() => runner.reserve(MANIFEST, io), { code: 'evidence_exists' });
  assert.equal(io.writes.length, 0);
});

/** Provide an EventEmitter child whose entire protocol is driven by the test callback. */
function fakeFork(actions) {
  return (file, args, options) => {
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.execArgv, []);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    setImmediate(() => actions(child));
    return child;
  };
}

/** Return a valid sanitized provider receipt for parent-process protocol tests. */
function receipt() {
  return { type: 'receipt', schemaVersion: 1, result: 'read', failure: null,
    nativeFetchCalls: 1, adapterCalls: 1, suppressedUserLookups: 0, status: 200, cliExitCode: 0,
    metadata: metadata('builds') };
}

/** Compose reservation, orchestration and child IPC so a dispatch checkpoint failure keeps its consumed stop reason. */
test('dispatch checkpoint failure reports checkpoint and consumes the attempt', async () => {
  const io = fakeIo(), output = [], h = harness();
  const write = io.writeSync;
  let childRef;
  /** Fail only the first announced-dispatch write; earlier reservation checkpoints remain durable in memory. */
  mocks.spyOn(io, 'writeSync').mockImplementation((fd, bytes, offset, length) => {
    if (JSON.parse(bytes.toString()).providerDispatchAnnouncements === 1) throw new Error(SECRET);
    return write(fd, bytes, offset, length);
  });
  mocks.spyOn(io, 'closeSync');
  const code = await runner.main(['--execute', MANIFEST.packageDigest], {
    prepare: () => MANIFEST, verifySource: () => {}, output: (value) => output.push(value),
    reserve: (manifest, unused, state) => runner.reserve(manifest, io, state),
    /** Use the real parent IPC reader with a synthetic child, including late messages after the checkpoint failure. */
    provider(phase, deploymentId, timeoutMs, signal, onDispatch) {
      return runner.readProvider(phase, deploymentId, timeoutMs, signal, onDispatch, fakeFork((child) => {
        childRef = child;
        child.emit('message', { type: 'dispatch' }); child.emit('message', receipt()); child.emit('close', 0);
      }));
    },
  });
  const report = output.at(-1);
  assert.equal(code, 1); assert.equal(report.result, 'stopped'); assert.equal(report.failure, 'checkpoint');
  assert.equal(report.phase, 'builds'); assert.equal(report.providerAttempts, 1);
  assert.equal(report.providerDispatchAnnouncements, 1); assert.equal(report.applicationAttempts, 0);
  assert.deepEqual(report.observations, []); assert.deepEqual(h.calls, []);
  assert.equal(childRef.killed, true); assert.equal(io.writeSync.mock.calls.length, 3);
  assert.equal(io.closeSync.mock.calls.length, 1); assert.ok(!JSON.stringify(report).includes(SECRET));
  assert.throws(() => runner.reserve(MANIFEST, io), { code: 'evidence_exists' });
});

/** Trusted callback failures preserve only the parent's allowlisted code, never arbitrary exception text. */
test.each(['checkpoint', 'overall_deadline', 'request_budget', 'not_allowlisted'])('sanitizes parent dispatch failure %s', async (code) => {
  const expected = code === 'not_allowlisted' ? 'internal' : code;
  await assert.rejects(runner.readProvider('builds', TARGET.deploymentId, 1000, new AbortController().signal,
    () => { throw Object.assign(new Error(SECRET), { code }); },
    fakeFork((child) => child.emit('message', { type: 'dispatch' }))), { code: expected, message: expected });
});

/** Untrusted metadata validation keeps ReadError classifications and cannot forge a parent checkpoint failure. */
test.each([
  [new provider.ReadError('provider_schema'), 'provider_schema'],
  [Object.assign(new Error(SECRET), { code: 'checkpoint' }), 'child_protocol'],
])('keeps child validation failure %s classified as %s', async (error, expected) => {
  mocks.spyOn(provider, 'validateMetadata').mockImplementation(() => { throw error; });
  await assert.rejects(runner.readProvider('builds', TARGET.deploymentId, 1000, new AbortController().signal,
    () => {}, fakeFork((child) => {
      child.emit('message', { type: 'dispatch' }); child.emit('message', receipt());
    })), { code: expected, message: expected });
});

test('child receipts require a dispatch announcement and successful process completion', async () => {
  let dispatched = 0;
  const value = await runner.readProvider('builds', TARGET.deploymentId, 1000, new AbortController().signal,
    () => { dispatched++; }, fakeFork((child) => {
      child.emit('message', { type: 'dispatch' }); child.emit('message', receipt()); child.emit('close', 0);
    }));
  assert.equal(dispatched, 1);
  assert.deepEqual(value, metadata('builds'));
});

test('failed child preserves bounded status/exit accounting without raw response fields', async () => {
  await assert.rejects(runner.readProvider('builds', TARGET.deploymentId, 1000, new AbortController().signal,
    () => {}, fakeFork((child) => {
      child.emit('message', { type: 'dispatch' });
      child.emit('message', { ...receipt(), result: 'stopped', failure: 'provider_status',
        status: 403, cliExitCode: 1, metadata: null });
      child.emit('close', 1);
    })), (error) => {
    assert.equal(error.code, 'provider_status');
    assert.equal(error.providerFacts.status, 403);
    assert.equal(error.providerFacts.cliExitCode, 1);
    assert.equal(error.providerFacts.metadata, undefined);
    return true;
  });
});

for (const [label, actions, code] of [
  ['missing receipt', (child) => child.emit('close', 0), 'child_failed'],
  ['receipt without dispatch', (child) => child.emit('message', receipt()), 'child_protocol'],
  ['duplicate dispatch', (child) => { child.emit('message', { type: 'dispatch' }); child.emit('message', { type: 'dispatch' }); }, 'child_protocol'],
  ['extra receipt fields', (child) => child.emit('message', { ...receipt(), secret: 'synthetic' }), 'child_protocol'],
  ['child error', (child) => child.emit('error', new Error('private')), 'child_failed'],
  ['timeout', () => {}, 'child_timeout'],
]) {
  test(`stops on ${label}`, async () => {
    await assert.rejects(runner.readProvider('builds', TARGET.deploymentId, 20, new AbortController().signal,
      () => {}, fakeFork(actions)), { code });
  });
}

/** Incorrect or absent authorization must never reach reservation, source execution or transport. */
test.each([['--execute', 'a'.repeat(64)], ['--execute'], ['--read'], ['--execute', 'not-a-digest']])('rejects unauthorized arguments %j', async (...args) => {
  const output = [], sideEffect = mocks.fn(() => { throw new Error('unexpected side effect'); });
  const code = await runner.main(args, { prepare: () => MANIFEST, output: (value) => output.push(value),
    verifySource: sideEffect, reserve: sideEffect, provider: sideEffect });
  assert.equal(code, 1); assert.equal(sideEffect.mock.calls.length, 0);
  assert.ok(['approval', 'arguments'].includes(output.at(-1).failure));
});

/** Preparation is read-only even with a valid package; default mode cannot execute a provider read. */
test('default mode only returns the prepared manifest', async () => {
  const output = [], reserve = mocks.fn();
  assert.equal(await runner.main([], { prepare: () => MANIFEST, output: (value) => output.push(value), reserve }), 0);
  assert.equal(output[0].liveExecuted, false); assert.equal(reserve.mock.calls.length, 0);
});

/** Partial writes consume the attempt; a second reservation cannot reuse or erase the failed first reservation. */
test.each(['profile.json', 'reservation.json', 'report.json', 'race'])('preserves no-replay after %s failure', async (point) => {
  const io = fakeIo(false, point), state = {};
  assert.throws(() => runner.reserve(MANIFEST, io, state), { code: point === 'race' ? 'evidence_exists' : 'checkpoint' });
  assert.equal(state.evidenceMayExist, true);
  assert.throws(() => runner.reserve(MANIFEST, io, {}), { code: 'evidence_exists' });
});

/** A consumed destination blocks the authorized orchestration before its first provider callback. */
test('authorized execution still refuses a consumed attempt', async () => {
  const io = fakeIo(true), providerCall = mocks.fn(), output = [];
  const code = await runner.main(['--execute', MANIFEST.packageDigest], { prepare: () => MANIFEST,
    verifySource: () => {}, reserve: (manifest, unused, state) => runner.reserve(manifest, io, state),
    provider: providerCall, output: (value) => output.push(value) });
  assert.equal(code, 1); assert.equal(output.at(-1).failure, 'evidence_exists');
  assert.equal(output.at(-1).evidenceMayExist, true); assert.equal(providerCall.mock.calls.length, 0);
});

/** Report writes tolerate short writes but reject zero progress, oversized evidence and sync failures. */
test('checkpoint writer handles partial writes and rejects broken disks', () => {
  const io = fakeIo(); let written = 0;
  io.writeSync = (fd, bytes, offset, length) => { const count = Math.min(3, length); written += count; return count; };
  const sink = runner.reserve(MANIFEST, io); sink.save({ safe: true });
  assert.equal(written, Buffer.byteLength(JSON.stringify({ safe: true }, null, 2) + '\n'));
  io.writeSync = () => 0; assert.throws(() => sink.save({ safe: true }), { code: 'checkpoint' });
  assert.throws(() => sink.save({ data: 'a'.repeat(262144) }), { code: 'checkpoint' });
  sink.close();
});

/** A rejected provider operation is terminal; the runner discards exception text and never retries. */
test.each(['provider_status', 'existing_auth_unavailable', 'metadata_limit', 'transport'])('stops once on %s', async (code) => {
  const h = harness(); let attempts = 0;
  h.deps.provider = async () => { attempts++; throw Object.assign(new Error(SECRET), { code }); };
  const report = await runner.runWithAdapters(MANIFEST, h.deps);
  assert.equal(report.failure, code); assert.equal(attempts, 1); assert.equal(report.applicationAttempts, 0);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

/** Parent cancellation kills an unfinished child and clears its deadline instead of permitting a later dispatch. */
test('cancels a provider child and ignores late receipts', async () => {
  const controller = new AbortController(); let childRef;
  const pending = runner.readProvider('builds', TARGET.deploymentId, 1000, controller.signal, () => {},
    fakeFork((child) => { childRef = child; controller.abort(); child.emit('message', receipt()); child.emit('close', 0); }));
  await assert.rejects(pending, { code: 'child_timeout' }); assert.equal(childRef.killed, true);
});


/** Load fresh parent initialization with read-only mocks, recording whether the preserved observer is evaluated. */
function initializeParent(changed, events) {
  const source = fs.readFileSync(path.join(__dirname, '../diagnose-builds.cjs'), 'utf8');
  const observer = path.join(provider.ROOT, '.tmp/gate1-rollback-tools/build-attribution-49owz1V7-attempt-1/observe-build.cjs');
  const runtime = { __dirname: path.resolve(__dirname, '..'), module: { exports: {} },
    /** Keep the provider isolated and intercept only the observer's pin read and import. */
    require(name) {
      if (name === './provider-read-child.cjs') return provider;
      if (name === 'node:fs') return {
        /** Substitute changed observer bytes without writing to the preserved package. */
        readFileSync(file) {
          assert.equal(file, observer); events.push('read');
          return changed ? Buffer.from('changed observer') : fs.readFileSync(file);
        },
      };
      if (name === observer) { events.push('require'); return upstream; }
      return require(name);
    },
  };
  vm.runInNewContext(source, runtime);
  return runtime.module.exports;
}

/** Dependency drift must fail before the preserved observer's module body can perform any side effects. */
test('parent rejects changed observer bytes before importing it', () => {
  const events = [];
  assert.throws(() => initializeParent(true, events), { code: 'dependency_changed' });
  assert.deepEqual(events, ['read']);
});

/** The successful path retains the original target and imports the observer only after reading its pinned bytes. */
test('parent verifies the observer before importing valid bytes', () => {
  const events = [], initialized = initializeParent(false, events);
  assert.deepEqual(events, ['read', 'require']);
  assert.equal(initialized.PROFILE.target.deploymentId, TARGET.deploymentId);
});

/** Every consumed-attempt evidence file and preserved observer must remain exact before source checks or effects. */
test.each(Object.keys(runner.LOCAL_PINS))('changed provenance %s blocks execution', async (relativeFile) => {
  const read = fs.readFileSync, output = [], sideEffect = mocks.fn();
  const evidenceExists = fs.existsSync(path.join(provider.ROOT, runner.PROFILE.evidenceDirectory));
  const pinned = path.join(provider.ROOT, relativeFile);
  mocks.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => file === pinned ? Buffer.from('changed') : read(file, ...args));
  const result = await runner.main(['--execute', MANIFEST.packageDigest], {
    verifySource: sideEffect, reserve: sideEffect, provider: sideEffect, output: (value) => output.push(value),
  });
  assert.equal(result, 1); assert.equal(output.at(-1).failure, 'dependency_changed');
  assert.equal(output.at(-1).evidenceMayExist, evidenceExists); assert.equal(sideEffect.mock.calls.length, 0);
});

/** A changed source/upstream helper cannot inherit its consumed approval into the diagnostic package. */
test('changed upstream digest stops before reservation', async () => {
  mocks.spyOn(upstream, 'preparation').mockReturnValue({ packageDigest: 'a'.repeat(64) });
  const output = [], sideEffect = mocks.fn();
  const result = await runner.main(['--execute', MANIFEST.packageDigest], {
    verifySource: sideEffect, reserve: sideEffect, provider: sideEffect, output: (value) => output.push(value),
  });
  assert.equal(result, 1); assert.equal(output.at(-1).failure, 'dependency_changed');
  assert.equal(sideEffect.mock.calls.length, 0);
});

/** The five-file manifest changes when a diagnostic component changes, invalidating any previously approved digest. */
test.each(['README.md', '__tests__/diagnose-builds.test.cjs'])('changed local component %s changes the digest', (componentName) => {
  const base = runner.preparation();
  const read = fs.readFileSync;
  const component = path.resolve(__dirname, '..', componentName);
  mocks.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
    const bytes = read(file, ...args);
    return file === component ? Buffer.concat([Buffer.from(bytes), Buffer.from('\n// synthetic drift\n')]) : bytes;
  });
  assert.notEqual(runner.preparation().packageDigest, base.packageDigest);
});

/** Saved provenance describes the stopped, consumed attempt and keeps current runtime unobserved. */
test('binds the exact stopped attempt and preserves its target and evidence bytes', () => {
  const prior = runner.PROFILE.priorAttempt;
  const directory = path.join(provider.ROOT, prior.evidenceDirectory);
  const profile = JSON.parse(fs.readFileSync(path.join(directory, 'profile.json'), 'utf8'));
  const reservation = JSON.parse(fs.readFileSync(path.join(directory, 'reservation.json'), 'utf8'));
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
  for (const file of ['profile.json', 'reservation.json', 'report.json']) {
    assert.equal(runner.hash(fs.readFileSync(path.join(directory, file))), runner.LOCAL_PINS[prior.evidenceDirectory + '/' + file]);
  }
  assert.equal(profile.packageDigest, prior.packageDigest); assert.equal(report.packageDigest, prior.packageDigest);
  assert.equal(reservation.packageDigest, prior.packageDigest); assert.equal(reservation.state, 'reserved_no_replay');
  for (const key of ['result', 'phase', 'failure', 'finishedAt', 'providerAttempts', 'providerDispatchAnnouncements', 'applicationAttempts']) {
    assert.equal(prior[key], report[key]);
  }
  assert.deepEqual(TARGET, profile.profile.target);
  assert.equal(runner.PROFILE.currentRuntime.status, 'not_observed');
  assert.equal(runner.PROFILE.expectedNodeMajor, 22); assert.equal(runner.PROFILE.sourceNodeEngine, '22.x');
  assert.deepEqual(runner.PROFILE.sequence, ['builds']); assert.equal(runner.PROFILE.limits.providerReads, 1);
  assert.equal(runner.PROFILE.limits.applicationRequests, 0);
  assert.equal(runner.PROFILE.evidenceDirectory, '.tmp/gate1-rollback/replacement-49owz1V7-build-conflict-attempt-1');
});

/** Read-only preparation preserves both unused destinations and the consumed evidence retained in the operator workspace. */
test('offline preparation is stable, complete and preserves execution evidence', () => {
  const destination = path.join(provider.ROOT, runner.PROFILE.evidenceDirectory);
  /** Snapshot only the known sanitized evidence files so publication tests cannot erase or rewrite consumed records. */
  function evidenceSnapshot() {
    if (!fs.existsSync(destination)) return null;
    return { names: fs.readdirSync(destination).sort(), hashes: Object.fromEntries(
      ['profile.json', 'reservation.json', 'report.json'].map((name) =>
        [name, runner.hash(fs.readFileSync(path.join(destination, name)))])) };
  }
  const before = evidenceSnapshot();
  const a = runner.preparation(), b = runner.preparation();
  assert.equal(a.packageDigest, b.packageDigest); assert.equal(Object.keys(a.components).length, 5);
  assert.equal(a.upstreamManifest.packageDigest, runner.PROFILE.priorAttempt.packageDigest);
  assert.equal(a.upstreamManifest.sourceInventory.entries.length, 39);
  assert.equal(a.upstreamManifest.sourceInventory.routes.length, 35);
  assert.equal(a.upstreamManifest.sourceInventory.currentLocalNextExists, false);
  assert.equal(a.upstreamManifest.sourceInventory.currentLocalBuildOutputExists, false);
  assert.deepEqual(evidenceSnapshot(), before);
});

/** Publication binds its own path and bytes; the consumed local approval cannot reserve evidence or authorize this copy. */
test('tracked publication cannot inherit the consumed local approval', async () => {
  const consumedDigest = 'abf74f5a5a02a155d43ae559ea1ea5065c4138b0d6d32c44e6a116012153215c';
  const manifest = runner.preparation(), output = [], sideEffect = mocks.fn();
  assert.notEqual(manifest.packageDigest, consumedDigest);
  const code = await runner.main(['--execute', consumedDigest], { prepare: () => manifest,
    verifySource: sideEffect, reserve: sideEffect, provider: sideEffect, output: (value) => output.push(value) });
  assert.equal(code, 1); assert.equal(output.at(-1).failure, 'approval');
  assert.equal(sideEffect.mock.calls.length, 0);
});

/** Receipt accounting and byte caps are independently enforced before any untrusted metadata can be retained. */
test.each([
  ['impossible counts', (child) => {
    child.emit('message', { type: 'dispatch' }); child.emit('message', { ...receipt(), adapterCalls: 0 });
  }, 'child_protocol'],
  ['oversized IPC', (child) => child.emit('message', { value: 'a'.repeat(provider.LIMITS.ipcBytes) }), 'child_protocol'],
  ['oversized discarded output', (child) => child.stdout.emit('data', Buffer.alloc(provider.LIMITS.outputBytes + 1)), 'output_limit'],
  ['successful receipt with nonzero exit', (child) => {
    child.emit('message', { type: 'dispatch' }); child.emit('message', receipt()); child.emit('close', 1);
  }, 'child_failed'],
])('rejects %s', async (label, actions, code) => {
  await assert.rejects(runner.readProvider('builds', TARGET.deploymentId, 1000, new AbortController().signal,
    () => {}, fakeFork(actions)), { code });
});

/** Even direct adapter entry cannot fork a child for an unapproved phase or historical deployment. */
test('readProvider validates the operation before creating a process', () => {
  const fork = mocks.fn();
  assert.throws(() => runner.readProvider('events', TARGET.deploymentId, 1000, new AbortController().signal, () => {}, fork), { code: 'arguments' });
  assert.throws(() => runner.readProvider('builds', 'dpl_other', 1000, new AbortController().signal, () => {}, fork), { code: 'arguments' });
  assert.equal(fork.mock.calls.length, 0);
});

/** Source drift at the final pre-reservation check blocks an otherwise exact approved digest with no side effects. */
test('source drift after preparation prevents reservation and dispatch', async () => {
  const output = [], sideEffect = mocks.fn();
  const code = await runner.main(['--execute', MANIFEST.packageDigest], {
    prepare: () => MANIFEST, output: (value) => output.push(value), reserve: sideEffect, provider: sideEffect,
    verifySource: () => { throw Object.assign(new Error(SECRET), { code: 'source_changed' }); },
  });
  assert.equal(code, 1); assert.equal(output.at(-1).failure, 'source_changed');
  assert.equal(sideEffect.mock.calls.length, 0); assert.ok(!JSON.stringify(output).includes(SECRET));
});

/** New target pins, bounded scope and stopping decisions cannot inherit the historical deployment's observations. */
test('pins the replacement and documents finite follow-up without executing it', () => {
  assert.equal(TARGET.deploymentId, 'dpl_49owz1V7RHb16gkjdqFhnwJrzzDS');
  assert.equal(TARGET.buildId, 'NkVOoraS7zEuaGAABtan4');
  assert.equal(TARGET.gitSha, '50c4a957f6a8d025b8e492ad2833c896b3d6b711');
  assert.equal(runner.PROFILE.identificationEvidence.packageDigest,
    '34482f3c9c006a4b7e3b5563d5087d63d5828abc7794323e8885163402c129bc');
  assert.equal(runner.PROFILE.identificationEvidence.configuredNodeMajor, '22.x');
  assert.equal(runner.PROFILE.identificationEvidence.rootDirectory, 'repository_root');
  assert.deepEqual(runner.PROFILE.limits, { providerReads: 1, applicationRequests: 0, concurrency: 1,
    overallMs: 45000, providerMs: 10000, childMs: 30000, responseBytes: 1048576, headerBytes: 16384,
    ipcBytes: 131072, discardedOutputBytes: 131072, reportBytes: 262144, builds: 64, outputs: 2048 });
  assert.ok(runner.FILES.includes('README.md')); assert.equal(runner.FILES.length, 5);
  assert.ok(runner.PROFILE.firmStoppingPoint.includes('owner correction or qualification decision'));
  assert.ok(runner.PROFILE.runtimeFollowup.includes('separately approved'));
  assert.deepEqual(runner.PROFILE.permittedMetadata.outputClassifications,
    ['known_application_route', 'middleware', 'unrecognized_output', 'not_applicable']);
});
