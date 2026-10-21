'use strict';

/** Step 1 tests verify immutable provenance and a closed execution boundary without Docker or artifact access. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const r = require('../diagnose');
let prepared;
/** Cache public preparation for isolation tests; provenance mutation tests explicitly prepare again. */
function preparation() { return prepared || (prepared = r.prepare()); }

test('draft binds the consumed v2 result without issuing an execution approval', () => {
  const p = preparation();
  assert.equal(p.stage, 'step1_scaffold'); assert.equal(p.approval, null);
  assert.equal(p.authorized, false); assert.equal(p.executionReady, false); assert.equal(p.retainedContentReads, 0);
  assert.equal(p.draftSha256, r.hash(JSON.stringify(p.contract))); assert.notEqual(p.draftSha256, r.OLD_APPROVAL);
  assert.equal(p.contract.preservation.lexicalBaselineReviewRecords, 12);
  assert.equal(p.contract.preservation.lexicalBaselineExecutionRecords, 6);
  assert.equal(p.contract.expected.ordinal, 19); assert.equal(p.contract.manifestSha256, r.MANIFEST);
  assert.equal(p.contract.expectedObservation.guard, 'target_not_map_suffix');
  assert.deepEqual(p.contract.priorSourceMapCounts, { sourceMapReferences: 3, sourceMapContexts: 3,
    missingLocalMapReferences: 2, missingLocalMapContexts: 2 });
  assert.equal(p.contract.parser.integrityVerified, false); assert.equal(p.contract.parser.loaded, false);
  assert.equal(p.contract.implementation.lexicalClassifier, false);
});

test('container and reservation identities cannot collide with the consumed reader', () => {
  assert.notEqual(r.SCOPE, r.previous.SCOPE); assert.notEqual(r.KEY, r.previous.KEY);
  assert.notEqual(r.CONTAINER, r.previous.CONTAINER); assert.notEqual(r.CONFIRMATION, r.previous.CONFIRMATION);
  const args = r.containerArgs(), old = r.previous.containerArgs();
  assert.equal(args[2], r.CONTAINER); assert.equal(old[2], r.previous.CONTAINER);
  assert.equal(args.filter(s => s === '--mount').length, 1);
  assert.ok(args.includes(`type=volume,src=${r.copy.VOLUME},dst=/copy,readonly,volume-nocopy`));
  for (const flag of ['--network=none', '--read-only', '--pull=never', '--cap-drop=ALL', '--log-driver=none', '--cpus=2', '--memory=2147483648']) assert.ok(args.includes(flag));
});

test('public preparation does not call Docker or the artifact reader', t => {
  t.mock.method(r.q, 'supervise', () => assert.fail('unexpected process'));
  t.mock.method(r.previous, 'diagnosticLibrary', () => assert.fail('unexpected reader'));
  assert.equal(r.prepare().executionReady, false);
});

test('execution stays closed even with a draft digest and dependency overrides', async () => {
  const calls = [], p = preparation();
  /** Record attempted side effects so the scaffold must reject before touching any dependency. */
  const blocked = () => { calls.push('side_effect'); throw Error('synthetic-private-DO-NOT-RETAIN'); };
  for (const approval of [r.OLD_APPROVAL, p.draftSha256, null]) {
    await assert.rejects(r.execute({ approval, confirmation: r.CONFIRMATION },
      { prepare: blocked, persist: blocked, docker: blocked, readiness: blocked, now: blocked }), /^Error: implementation_incomplete$/);
  }
  assert.deepEqual(calls, []);
});

test('readiness bootstrap and result validation cannot claim unfinished functionality', async () => {
  await assert.rejects(r.readiness(), /^Error: implementation_incomplete$/);
  assert.throws(() => r.containerInput(preparation()), /^Error: implementation_incomplete$/);
  assert.throws(() => r.validateReport(Buffer.from('synthetic-private-DO-NOT-RETAIN'), preparation()), /^Error: implementation_incomplete$/);
});

test('CLI routing exposes draft preparation but rejects operational commands', async () => {
  assert.deepEqual(await r.main(['--prepare']), preparation());
  await assert.rejects(r.main(['--readiness']), /^Error: implementation_incomplete$/);
  await assert.rejects(r.main(['--execute', preparation().draftSha256, r.CONFIRMATION]), /^Error: implementation_incomplete$/);
  await assert.rejects(r.main(['--unrecognized']), /^Error: input$/);
});

test('the unchanged bounded reader and mount verifier are reused by reference', () => {
  assert.equal(r.diagnosticLibrary, r.previous.diagnosticLibrary); assert.equal(r.verifyMounts, r.previous.verifyMounts);
  const library = r.diagnosticLibrary(), source = fs.readFileSync(r.SCANNER, 'utf8');
  library.compile(source, {}, {}); assert.throws(() => library.compile(source + '\n', {}, {}));
});

for (const suffix of ['gate1-source-map-v2-d85af7e3/diagnose.js', 'gate1-source-map-v2-d85af7e3/review-index.json',
  'gate1-source-map-v2-d85af7e3/execution-evidence-index.json', 'gate1-source-map-v2-d85af7e3/execution-terminal.json']) {
  test(`frozen baseline drift is rejected: ${path.basename(suffix)}`, t => {
    const original = r.q.fileHash;
    t.mock.method(r.q, 'fileHash', file => file.replaceAll('\\', '/').endsWith(suffix) ? '0'.repeat(64) : original(file));
    assert.throws(() => r.prepare(), /^Error: provenance$/);
  });
}

test('new scaffold bytes change only the draft binding', t => {
  const p = preparation(), original = r.q.fileHash;
  t.mock.method(r.q, 'fileHash', file => file === __filename ? '0'.repeat(64) : original(file));
  const next = r.prepare(); assert.notEqual(next.draftSha256, p.draftSha256); assert.equal(next.approval, null);
});

test('preparation and rejected calls leave no new execution evidence', () => {
  const base = path.dirname(__dirname);
  for (const name of ['execution-owner-approval.json', 'execution-terminal.json', 'execution-postflight.json', 'execution-evidence-index.json']) {
    assert.equal(fs.existsSync(path.join(base, name)), false);
  }
  for (const name of [r.KEY + '.reservation.json', r.KEY + '.report.json']) assert.equal(fs.existsSync(path.join(r.prior.REGISTRY, name)), false);
});
