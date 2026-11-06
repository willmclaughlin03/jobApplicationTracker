'use strict';
/* global Buffer, structuredClone, AbortController, process */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate } = require('node:timers/promises');
const path = require('node:path');
const q = require('../authentication-preparation-scoped-startup.cjs');
const n = require('../authentication-preparation-scoped-native-contract.cjs');
const c = require('../authentication-preparation-scoped-contract.cjs');
const p = require('../authentication-preparation-scoped-postflight.cjs');
const d = require('../hosted-csrf-diagnostic.cjs');
const HASH = 'a'.repeat(64);

/** Build only synthetic in-memory approval material; never save or execute an approval. */
function input() {
  const binding = Object.fromEntries(Object.keys(n.bindingSchema.shape).map(key => [key, HASH]));
  return { binding, reviewHash: HASH, review: { ...binding, scope: 'scoped-authentication-startup-review-v1',
    operator: 'Codex', owner: 'project-owner', directory: n.STARTUP_DIRECTORY, command: n.STARTUP_COMMAND,
    profile: n.STARTUP_PROFILE, artifacts: [...n.STARTUP_ARTIFACTS], limits: { ...n.STARTUP_LIMITS },
    ports: [...n.PORTS], spki: n.SPKI, forwarding: 'closed', approvedAt: 1, expiresAt: 181000 } };
}

/** Model socket ownership synchronously while exercising the real proxy's request/parser/CONNECT callbacks. */
class Socket extends EventEmitter {
  /** Track actual mock closure without opening any native socket. */
  constructor() { super(); this.destroyed = false; }
  /** Match the proxy timeout interface; timeout behavior is selected explicitly by each test. */
  setTimeout(_ms, callback) { this.timeout = callback; }
  /** Match CONNECT's pause boundary without forwarding data. */
  pause() {}
  /** Emit close once so the production proxy releases its real concurrency ledger. */
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}

/** Use production budgets/proxy and mocked OS boundaries; all evidence stays in memory. */
function fixture(context) {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const state = { calls: [], records: {}, budget: null, cancel: null, server: null, proxy: null, owner: null };
  const hooks = {};
  const deps = { clock: Date.now,
    reserve: async reservation => { state.calls.push('reserve'); reservation.reserved = true; await hooks.reserve?.(); },
    verify: async () => { state.calls.push('verify'); await hooks.verify?.(); },
    absence: async () => { state.calls.push('absence'); await hooks.absence?.(); return true; },
    probe: async (host, port) => { state.calls.push([host, port]); await hooks.probe?.(); },
    onCancel: callback => { state.cancel = callback; return () => { state.cancel = null; }; },
    proxy: budget => {
      state.budget = budget; state.calls.push('proxy');
      const server = new EventEmitter(); state.server = server;
      server.listen = (port, host, callback) => { assert.equal(port, 18445); assert.equal(host, '127.0.0.1'); callback(); };
      server.address = () => ({ port: 18445 }); server.close = callback => { state.calls.push('proxy-close'); callback(); };
      state.proxy = q.startupProxy(budget, { createServer: options => {
        assert.equal(options.maxHeaderSize, 8192); return server;
      }, connect: () => assert.fail('closed proxy must never connect upstream') });
      return state.proxy;
    },
    adapter: {
      launch: async (owner, proxy, budget) => {
        state.calls.push('launch'); state.owner = owner; state.budget = budget;
        assert.equal(proxy.forwarding, false); owner.child = { pid: 7, exitCode: null }; owner.port = 24000;
        budget.controller(); budget.command(); owner.onSpawn(); await hooks.launch?.(owner, budget);
      },
      observe: async (owner, budget) => {
        state.calls.push('observe'); owner.native = { pageReady: 2 };
        owner.observer = { close: () => state.calls.push('observer-close') }; await hooks.observe?.(owner, budget);
      },
      close: async (owner, budget) => {
        state.calls.push('close'); budget.command(true); await hooks.close?.(owner, budget);
        owner.closed = true; owner.child.exitCode = 0; return q.ownerRecord(owner);
      },
    },
    write: async (name, record) => { state.calls.push(name); state.records[name] = structuredClone(record); await hooks.write?.(name); return HASH; },
  };
  return { state, hooks, deps, input: input(), run: () => q.run(input(), 1000, deps) };
}

/** Advance only the synthetic window after all immediately available mocked startup work has settled. */
async function observeWindow(context, fixture) {
  const pending = fixture.run(); await setImmediate(); context.mock.timers.tick(15000); return pending;
}

/** Exercise a real parser/request/authority guard without logging or retaining rejected synthetic inputs. */
function rejection(state, kind) {
  const socket = new Socket(); state.server.emit('connection', socket);
  if (kind === 'proxy_http_request') state.server.emit('request', { destroy: () => socket.destroy() }, { destroy: () => {} });
  else if (kind === 'proxy_parser_error') state.server.emit('clientError', new Error('synthetic private parser detail'), socket);
  else state.server.emit('connect', { method: 'CONNECT', url: 'synthetic-private.invalid:443' }, socket, Buffer.from('private-head'));
}

/** A complete window remains merely a startup observation and writes no qualification artifact. */
test('startup reserves before activity, waits the full spawn window and closes both owners', async context => {
  const f = fixture(context); let finished = false;
  const pending = f.run().then(value => { finished = true; return value; }); await setImmediate();
  assert.equal(f.state.calls[0], 'reserve'); assert.equal(f.state.proxy.forwarding, false);
  context.mock.timers.tick(14999); await setImmediate(); assert.equal(finished, false);
  context.mock.timers.tick(1); const result = await pending;
  assert.deepEqual(result, { scope: 'scoped_authentication_startup_worker', attemptHash: HASH });
  const record = f.state.records['attempt.json']; assert.equal(record.outcome, 'no_rejection_observed');
  assert.equal(record.observationEndedAt - record.launchAt, 15000); assert.equal(record.pagesReady, 2);
  assert.equal(record.cleanup, true); assert.equal(record.totals.listenerProbes, 4); assert.equal(record.totals.launches, 1);
  assert.deepEqual(Object.keys(f.state.records), ['attempt.json']); assert.equal(f.state.cancel, null);
  assert.throws(() => c.validateQualification(record, HASH, {}, {}), { code: 'coverage_unqualified' });
  assert.throws(() => n.validateAttempt(record), { code: 'receipt' });
  assert.throws(() => d.validatePreparation(record));
});

/** Closed forwarding must remain closed even if a caller mistakenly invokes the inherited open method. */
test('startup proxy rejects forwarding changes and counts allowed-authority denials without upstream activity', context => {
  const f = fixture(context); const root = new n.NativeLedger(1000, 181000, Date.now, 'startup');
  const budget = new n.NativeBudget(root, n.STARTUP_CASE); const proxy = f.deps.proxy(budget);
  assert.throws(() => proxy.open()); assert.throws(() => { proxy.forwarding = true; });
  const socket = new Socket(); f.state.server.emit('connection', socket);
  f.state.server.emit('connect', { method: 'CONNECT', url: '127.0.0.1:18443' }, socket, Buffer.from('denied'));
  assert.equal(budget.failure, null); assert.equal(proxy.snapshot().denied, 1);
  assert.equal(proxy.snapshot().upstream.rejected, 6); assert.equal(root.totals.upstreamBytes, 0); assert.equal(root.connections, 0);
});

for (const reason of ['proxy_http_request', 'proxy_parser_error', 'proxy_authority']) {
  /** Real proxy callbacks must survive adapter rejection, cleanup, late errors and strict serialization. */
  test(`startup attributes ${reason} at launch and preserves it through cleanup`, async context => {
    const f = fixture(context); f.hooks.launch = () => rejection(f.state, reason);
    f.hooks.close = () => { rejection(f.state, 'proxy_parser_error'); };
    await f.run(); const record = f.state.records['attempt.json'];
    assert.equal(record.outcome, 'rejection'); assert.equal(record.firstFailure, 'destination');
    assert.equal(record.destinationReason, reason); assert.equal(record.failureStage, 'launch'); assert.equal(record.cleanup, true);
    assert.equal(record.totals.commands, 2); assert.equal(record.totals.proxyConnections, 1);
    assert.equal(f.state.calls.includes('observe'), false); assert.doesNotMatch(JSON.stringify(record), /private|invalid|head/);
  });
}

/** A first work failure cannot be replaced by destination callbacks fired during cleanup. */
test('startup keeps cancellation ahead of late destination attribution', async context => {
  const f = fixture(context); f.hooks.observe = () => f.state.cancel(); f.hooks.close = () => rejection(f.state, 'proxy_authority');
  await f.run(); const record = f.state.records['attempt.json'];
  assert.equal(record.firstFailure, 'cancelled'); assert.equal(record.failureStage, 'observe');
  assert.equal(record.destinationReason, null); assert.equal(record.outcome, 'incomplete');
});

/** Attribution and cleanup are separate facts; a close error cannot erase the rejecting guard. */
test('startup preserves rejection when normal closure fails and still closes the proxy', async context => {
  const f = fixture(context); f.hooks.launch = () => rejection(f.state, 'proxy_authority');
  f.hooks.close = () => { throw new c.PreparationError('closure'); };
  await f.run(); const record = f.state.records['attempt.json'];
  assert.equal(record.firstFailure, 'destination'); assert.equal(record.destinationReason, 'proxy_authority');
  assert.equal(record.cleanup, false); assert.equal(record.owner.closedNormally, false); assert.ok(f.state.calls.includes('proxy-close'));
});

/** Insufficient readiness, cancelled cleanup, budget exhaustion and attachment expiry remain incomplete. */
test('startup rejects one ready page without waiting for a clean window', async context => {
  const f = fixture(context); f.hooks.observe = owner => { owner.native.pageReady = 1; };
  await f.run(); assert.equal(f.state.records['attempt.json'].outcome, 'incomplete');
  assert.equal(f.state.records['attempt.json'].firstFailure, 'observation');
});

/** Cancellation remains authoritative while normal cleanup is already in progress. */
test('startup cancellation during cleanup cannot produce a clean observation', async context => {
  const f = fixture(context); f.hooks.close = () => f.state.cancel(); await observeWindow(context, f);
  assert.equal(f.state.records['attempt.json'].firstFailure, 'cancelled');
  assert.equal(f.state.records['attempt.json'].failureStage, 'closure'); assert.equal(f.state.records['attempt.json'].cleanup, true);
});

/** The attachment timeout starts cleanup even while an adapter promise never settles. */
test('startup attachment stalls do not renew the window or work deadline', async context => {
  const f = fixture(context); f.hooks.launch = () => new Promise(() => {});
  const pending = f.run(); await setImmediate(); context.mock.timers.tick(10000); await pending;
  assert.equal(f.state.records['attempt.json'].firstFailure, 'deadline'); assert.equal(f.state.calls.includes('observe'), false);
  assert.ok(f.state.calls.includes('close')); assert.equal(f.state.records['attempt.json'].observationEndedAt, 11000);
});

/** Target setup cannot finish after the spawn-relative fifteen seconds even if it returns a late value. */
test('startup late readiness is rejected at the observation boundary', async context => {
  const f = fixture(context);
  f.hooks.launch = () => { context.mock.timers.tick(9999); };
  f.hooks.observe = async () => { context.mock.timers.tick(5001); };
  await f.run(); assert.equal(f.state.records['attempt.json'].outcome, 'incomplete');
  assert.equal(f.state.records['attempt.json'].readyAt, null);
});

/** Reservation failures never permit sockets or Chrome, and failed consumed reservations retain their evidence. */
test('startup preflight failure stays consumed with zero launches and no listener', async context => {
  const f = fixture(context); f.hooks.absence = () => { throw new c.PreparationError('process_inspection'); };
  await f.run(); const record = f.state.records['attempt.json'];
  assert.equal(record.firstFailure, 'process_inspection'); assert.equal(record.totals.launches, 0); assert.equal(record.proxy, null);
  assert.equal(f.state.calls.includes('proxy'), false);
});

/** Exhausting actual relevant-event capacity leaves four command slots available for cleanup only. */
test('startup event exhaustion stops work and retains bounded counters', async context => {
  const f = fixture(context); f.hooks.observe = (_owner, budget) => { for (let index = 0; index <= 128; index++) budget.event(); };
  await f.run(); const record = f.state.records['attempt.json'];
  assert.equal(record.firstFailure, 'budget'); assert.equal(record.totals.events, 128); assert.equal(record.cleanup, true);
});

/** A Network event near the end cannot hide an unpaired HTTP observation behind window cleanup. */
test('startup rejects an unpaired HTTP slot at the end of an otherwise ready window', async context => {
  const f = fixture(context); const pending = f.run(); await setImmediate();
  context.mock.timers.tick(14999); f.state.budget.observeSlot(); context.mock.timers.tick(1); await pending;
  const record = f.state.records['attempt.json']; assert.equal(record.outcome, 'incomplete');
  assert.equal(record.firstFailure, 'observation'); assert.equal(record.failureStage, 'window');
  assert.equal(record.traffic.unreservedObservations, 1); assert.equal(record.totals.records, 1);
});

/** A cancellation during an awaited exclusive write preserves the bytes but cannot emit a valid worker completion. */
test('startup cancellation during evidence writing does not finalize the worker result', async context => {
  const f = fixture(context); f.hooks.write = () => f.state.cancel();
  await assert.rejects(observeWindow(context, f), { code: 'cancelled' });
  assert.ok(f.state.records['attempt.json']); assert.equal(f.state.cancel, null);
});

/** Build a tiny filesystem double that cannot touch real execution paths. */
function reservationIo(entries = ['execution-review.json']) {
  const calls = []; const io = { realpath: async file => file, readdir: async () => entries,
    open: async (file, mode) => { calls.push([path.basename(file), mode]); return {
      writeFile: async () => calls.push('write'), sync: async () => calls.push('sync'), close: async () => calls.push('close') }; },
    mkdir: async file => calls.push(path.basename(file)), lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }), access: async () => {} };
  return { calls, io };
}

/** Existing markers, partial profiles and redirected directories cannot be reused or replaced. */
test('startup reservation fsyncs its marker before profiles and rejects consumed or redirected roots', async () => {
  const f = reservationIo(); const state = { reserved: false, check: () => {} };
  await q.reserveArtifacts(state, f.io); assert.equal(state.reserved, true);
  assert.deepEqual(f.calls, [['worker-started', 'wx'], 'write', 'sync', 'close', 'profiles', 'startup']);
  for (const entries of [[], ['execution-review.json', 'worker-started'], ['execution-review.json', 'profiles']]) {
    const denied = reservationIo(entries); await assert.rejects(q.reserveArtifacts({ check: () => {} }, denied.io), { code: 'already_used' });
    assert.equal(denied.calls.length, 0);
  }
  f.io.realpath = async () => n.DIRECTORY; await assert.rejects(q.reserveArtifacts(state, f.io), { code: 'profile' });
});

/** A cancelled or failed marker fsync remains consumed without proceeding to profile creation. */
test('startup does not abandon reservation writes when cancellation arrives', async () => {
  const f = reservationIo(); let cancelled = false;
  f.io.open = async () => ({ writeFile: async () => { cancelled = true; }, sync: async () => f.calls.push('sync'), close: async () => f.calls.push('close') });
  const state = { reserved: false, check: () => c.check(!cancelled, 'cancelled') };
  await assert.rejects(q.reserveArtifacts(state, f.io), { code: 'cancelled' });
  assert.equal(state.reserved, true); assert.deepEqual(f.calls, ['sync', 'close']);
});

/** Current bindings and exact input bytes must agree before a reviewed command can consume its path. */
test('startup review rejects drift, expiry, extra keys and invalid templates', async () => {
  const f = input(); const deps = { clock: () => 1000, read: async () => ({ record: f.review, hash: HASH }), bindings: async () => f.binding };
  assert.deepEqual(await q.loadReview(HASH, deps), f);
  await assert.rejects(q.loadReview('b'.repeat(64), deps), { code: 'integrity' });
  for (const key of Object.keys(f.binding)) {
    await assert.rejects(q.loadReview(HASH, { ...deps, bindings: async () => ({ ...f.binding, [key]: 'b'.repeat(64) }) }), { code: 'integrity' });
  }
  for (const update of [{ approvedAt: 0, expiresAt: 0 }, { expiresAt: 1000 }, { approvedAt: 1001 }, { expiresAt: 3600002 }, { force: true }]) {
    assert.throws(() => n.validateStartupReview({ ...f.review, ...update }, 1000));
  }
  assert.throws(() => n.validateStartupReview({ ...f.review, expiresAt: 180999 }, 1000, true), { code: 'expired' });
  await assert.rejects(q.main(['--startup-worker', HASH, '1000']), { code: 'approval' });
  await assert.rejects(q.main(['--execute-native', HASH]), { code: 'arguments' });
});

/** Reuse a completed mocked observation for independent supervisor tests without native execution. */
async function postflightFixture(context) {
  const f = fixture(context); const message = await observeWindow(context, f); const calls = []; const controller = new AbortController();
  const hooks = {}; const worker = { message, valid: true, exitCode: 0 };
  const deps = { clock: Date.now, signal: controller.signal,
    read: async () => { await hooks.read?.(); return { record: f.state.records['attempt.json'], hash: HASH }; },
    verify: async () => { calls.push('bindings'); await hooks.verify?.(); },
    absence: async () => { calls.push('absence'); await hooks.absence?.(); return true; },
    profile: async () => { calls.push('profile'); await hooks.profile?.(); return true; },
    probe: async (host, port) => { calls.push([host, port]); await hooks.probe?.(port); },
    write: async (name, record) => { f.state.records[name] = structuredClone(record); await hooks.write?.(); return HASH; },
  };
  return { ...f, worker, calls, controller, postHooks: hooks, finalize: () => q.finalize(worker, f.input, 1000, deps), postDeps: deps };
}

/** The parent checks the exact profile, executable absence and every fixed/CDP listener only after worker exit. */
test('startup independent postflight preserves narrow outcome and five probes', async context => {
  const f = await postflightFixture(context); const result = await f.finalize();
  assert.equal(result.outcome, 'no_rejection_observed'); assert.equal(result.receiptFinalized, true);
  assert.deepEqual(f.calls, ['bindings', 'absence', 'profile', ['127.0.0.1', 18443], ['127.0.0.2', 18444],
    ['127.0.0.1', 18445], ['127.0.0.1', 18446], ['127.0.0.1', 24000]]);
  assert.equal(f.state.records['postflight.json'].listenerProbes, 5);
  assert.throws(() => c.validateReceipt(f.state.records['postflight.json']), { code: 'receipt' });
});

for (const boundary of ['absence', 'profile', 'probe', 'verify', 'read']) {
  /** A single unavailable check prevents completion while independent companion cleanup checks still run. */
  test(`startup postflight ${boundary} failure cannot become a clean result`, async context => {
    const f = await postflightFixture(context); f.postHooks[boundary] = () => { throw new c.PreparationError(boundary === 'absence' ? 'process_inspection' : 'closure'); };
    const result = await f.finalize(); assert.equal(result.outcome, 'incomplete'); assert.ok(f.calls.includes('absence')); assert.ok(f.calls.includes('profile'));
    if (boundary === 'read') assert.equal(f.state.records['postflight.json'], undefined);
  });
}

/** Worker success cannot be inferred from a valid receipt alone or a nonzero/duplicate-IPC completion. */
test('startup malformed worker completion still gets independent closure checks and stays incomplete', async context => {
  const f = await postflightFixture(context); f.worker.valid = false;
  const result = await f.finalize(); assert.equal(result.outcome, 'incomplete'); assert.equal(result.checks.workerExited, false);
  assert.ok(f.calls.includes('absence')); assert.equal(f.state.records['postflight.json'].postflightFailure, 'worker_completion');
});

/** Cancellation during parent reads or fsync must not be rewritten into a finalized clean observation. */
test('startup cancellation during finalization preserves provisional bytes without accepting them', async context => {
  const f = await postflightFixture(context); f.postHooks.write = () => f.controller.abort();
  const result = await f.finalize(); assert.equal(result.outcome, 'incomplete'); assert.equal(result.receiptFinalized, false);
  assert.equal(result.postflightFailure, 'cancelled');
  assert.equal(f.state.records['postflight.json'].finalization, 'requires_timely_supervisor_result');
});

/** Cancellation during a parent binding check still permits bounded independent cleanup but prevents a clean result. */
test('startup cancellation during parent reads is latched through independent inspection', async context => {
  const f = await postflightFixture(context); f.postHooks.verify = () => f.controller.abort();
  const result = await f.finalize(); assert.equal(result.outcome, 'incomplete'); assert.equal(result.receiptFinalized, false);
  assert.ok(f.calls.includes('absence')); assert.ok(f.calls.includes('profile'));
  assert.equal(f.state.records['postflight.json'].postflightFailure, 'cancelled');
});

/** A late awaited evidence write remains preserved but receives no timely supervisor finalization. */
test('startup expiry during postflight fsync cannot issue a finalized result', async context => {
  const f = await postflightFixture(context); f.postHooks.write = () => context.mock.timers.tick(165000);
  const result = await f.finalize(); assert.equal(result.outcome, 'incomplete'); assert.equal(result.receiptFinalized, false);
  assert.equal(result.postflightFailure, 'expired'); assert.ok(f.state.records['postflight.json']);
});

/** Model one IPC child; no subprocess, package, browser or hosted boundary is invoked. */
test('startup supervisor waits for actual worker close and rejects duplicate IPC as completion', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const child = new EventEmitter(); child.connected = true; let cancellations = 0; child.send = () => { cancellations++; };
  const signals = new EventEmitter(); let finalized = false;
  const pending = q.supervise(input(), { clock: Date.now, signals, spawn: (exe, args, options) => {
    assert.equal(exe, process.execPath); assert.equal(args[1], '--startup-worker'); assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']); assert.equal(options.env.GATE1_APPROVED_USER_ID, undefined); return child;
  }, finalize: async worker => { finalized = true; assert.equal(worker.valid, false); assert.equal(worker.exitCode, 0); return { outcome: 'incomplete' }; } });
  child.emit('message', { scope: 'scoped_authentication_startup_worker', attemptHash: HASH });
  child.emit('message', { scope: 'scoped_authentication_startup_worker', attemptHash: HASH });
  await setImmediate(); assert.equal(finalized, false); assert.equal(cancellations, 1); child.emit('close', 0);
  assert.equal((await pending).outcome, 'incomplete'); assert.equal(signals.listenerCount('SIGINT'), 0);
});

/** Source or private-field substitutions cannot pass either diagnostic evidence validator. */
test('startup receipts reject private keys, contradictory claims and qualification promotion', async context => {
  const f = await postflightFixture(context); await f.finalize(); const attempt = f.state.records['attempt.json'];
  for (const update of [{ url: 'private' }, { firstFailure: 'destination' }, { destinationReason: 'raw-host' },
    { pagesReady: 1 }, { cleanup: false }, { readyAt: null }, { readyAt: 16000 }, { browserTrafficMeasured: true }, { hostedQualified: true }]) {
    assert.throws(() => n.validateStartupAttempt({ ...attempt, ...update }));
  }
  const postflight = f.state.records['postflight.json'];
  assert.throws(() => n.validateStartupPostflight({ ...postflight, checks: { ...postflight.checks, processAbsent: false } }));
  assert.throws(() => n.validateStartupPostflight({ ...postflight, finalization: 'passed' }));
  await assert.rejects(p.writeStartup('native-qualification.json', attempt), { code: 'receipt' });
});
