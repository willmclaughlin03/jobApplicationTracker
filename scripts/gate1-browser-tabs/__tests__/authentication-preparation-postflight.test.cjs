'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../authentication-preparation-postflight.cjs');
const HASH = 'a'.repeat(64);

/** Model only the bounded synthetic evidence schema, with no real identity or browser storage. */
function evidence() {
  const now = Date.now();
  const owner = { pid: 123, port: 12345, profile: p.PROFILE, closedNormally: true, exitCode: 0 };
  return { schemaVersion: 1, scope: 'synthetic_loopback_only', phase: 'passed', startedAt: now - 1000,
    completedAt: now - 1, sourceSet: HASH, checks: Object.fromEntries(p.CHECKS.map(key => [key, true])),
    owners: [{ ...owner }, { ...owner, pid: 124 }], listenerPorts: [20001, 20002],
    pageTraffic: [{ allowed: 3, blocked: 0, pairedPageEvents: true, browserTrafficMeasured: false, coverage: 'page_http_only' },
      { allowed: 0, blocked: 1, pairedPageEvents: true, browserTrafficMeasured: false, coverage: 'page_http_only' }],
    requests: { actual: { application: 4, session: 2, static: 0 }, conservative: { application: 4, session: 2, static: 0 } },
    proxy: { connections: 3, denied: 1, forwarded: 3, readyBeforeForwarding: true }, firstFailure: null,
    browserTrafficMeasured: false, hostedQualified: false };
}

/** Model successful worker exit independently from the preliminary on-disk phase. */
function completion() { return { exitCode: 0, receiptFinalized: true, phase: 'passed', attemptHash: HASH, sourceSet: HASH }; }

test('valid scoped evidence cannot imply authenticated or browser-wide qualification', () => {
  assert.equal(p.reviewAttempt(evidence(), completion()), true);
  assert.throws(() => p.finalizeAuthentication({ browserTrafficMeasured: true }), { code: 'coverage_unqualified' });
});

for (const [name, mutate] of Object.entries({
  missingCheck: value => { delete value.checks.redirectReserved; },
  forgedCoverage: value => { value.browserTrafficMeasured = true; },
  hostedPass: value => { value.hostedQualified = true; },
  identityLeak: value => { value.userId = 'synthetic-private'; },
  cookieLeak: value => { value.pageTraffic[0].cookie = 'synthetic-private'; },
  partial: value => { delete value.owners; },
  forceKilled: value => { value.owners[0].exitCode = null; },
  wrongProfile: value => { value.owners[0].profile = 'personal-profile'; },
  missingPair: value => { value.pageTraffic[0].pairedPageEvents = false; },
  extraDispatch: value => { value.proxy.forwarded++; },
  hiddenRetry: value => { value.requests.actual.application++; },
  missingRequest: value => { value.requests.actual.session = 1; },
  failure: value => { value.firstFailure = 'cancelled'; },
  expired: value => { value.startedAt -= 180000; },
  invalidPort: value => { value.listenerPorts[0] = 0; },
})) test(`reject preliminary evidence: ${name}`, () => {
  const value = evidence(); mutate(value); assert.throws(() => p.reviewAttempt(value, completion()));
});

test('passed file alone cannot replace a successful and finalized worker completion', () => {
  for (const patch of [{ exitCode: 1 }, { receiptFinalized: false }, { phase: 'stopped' }, { sourceSet: 'b'.repeat(64) }])
    assert.throws(() => p.reviewAttempt(evidence(), { ...completion(), ...patch }));
});

test('independent inspection failure or missing privileges is inconclusive, never absence', async () => {
  for (const result of [null, {}, { complete: true, matches: 0, uninspectable: 1 }, { complete: true, matches: -1, uninspectable: 0 }])
    await assert.rejects(p.inspectBrowserAbsence(async () => result), { code: 'process_inspection' });
  await assert.rejects(p.inspectBrowserAbsence(async () => { throw new Error('private command line'); }), { code: 'process_inspection' });
  await assert.rejects(p.inspectBrowserAbsence(async () => ({ complete: true, matches: 1, uninspectable: 0 })), { code: 'process_present' });
});

test('independent closure checks profile/executable inventory and the owned port', async () => {
  const ports = []; let command;
  assert.equal(await p.inspectProcessClosure(evidence().owners[0], async value => {
    command = value; return { complete: true, matches: 0, uninspectable: 0 };
  }, async port => ports.push(port)), true);
  assert.ok(command.includes('ExecutablePath')); assert.ok(command.includes('CommandLine')); assert.deepEqual(ports, [12345]);
  await assert.rejects(p.inspectProcessClosure(evidence().owners[0], async () => ({ complete: true, matches: 0, uninspectable: 0 }),
    async () => { throw new Error('port open'); }));
});

test('finalizer independently checks all closure facts and writes only the fixed offline receipt', async () => {
  const record = evidence(); const inspected = []; const ports = []; const written = [];
  const result = await p.finalizeOffline(completion(), async () => HASH, {
    read: async () => ({ record, hash: HASH }), inspect: async owner => inspected.push(owner.pid),
    portClosed: async port => ports.push(port), write: async (file, output) => written.push({ file, output }),
  });
  assert.deepEqual(inspected, [123, 124]); assert.deepEqual(ports, record.listenerPorts);
  assert.equal(written[0].file, p.RESULT); assert.equal(result.independentProcessExitVerified, true);
  assert.equal(result.browserTrafficMeasured, false); assert.equal(result.identityVerified, false);
  assert.equal(result.hostedQualified, false); assert.equal(result.gate1Status, 'open');
});

test('hash drift and failed closure prevent any final receipt write', async () => {
  for (const mode of ['hash', 'source', 'process', 'socket']) {
    let writes = 0;
    await assert.rejects(p.finalizeOffline(completion(), async () => mode === 'source' ? 'b'.repeat(64) : HASH, {
      read: async () => ({ record: evidence(), hash: mode === 'hash' ? 'b'.repeat(64) : HASH }),
      inspect: async () => { if (mode === 'process') throw new Error('inspection failed'); },
      portClosed: async () => { if (mode === 'socket') throw new Error('socket open'); }, write: async () => { writes++; },
    }));
    assert.equal(writes, 0);
  }
});

test('write failure is never converted into receiptFinalized success', async () => {
  await assert.rejects(p.finalizeOffline(completion(), async () => HASH, {
    read: async () => ({ record: evidence(), hash: HASH }), inspect: async () => {}, portClosed: async () => {},
    write: async () => { throw new Error('partial write'); },
  }));
});
