'use strict';
/* global __dirname, AbortController, Buffer, setImmediate, structuredClone, process */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const b = require('../hosted-csrf-build-attribution.cjs');
const d = require('../hosted-csrf-diagnostic.cjs');
const SOURCE = 'a'.repeat(64);
const BUILD = 'synthetic-build-01';

/** Model the exact approval contract without writing a live manifest or authorizing native I/O. */
function plan(now = Date.now()) {
  return { approval: b.APPROVAL, target: { ...d.TARGET }, limits: { ...b.LIMITS }, approvedAt: now - 1000,
    expiresAt: now + 600000, sourceSet: SOURCE, ledgerBefore: structuredClone(d.BASELINE),
    ledgerCeiling: Object.fromEntries(['actual', 'conservative'].map(kind => [kind, d.addCounts(d.BASELINE[kind], b.INCREMENT)])) };
}

/** Supply only pinned provider identity with the legitimately absent project pendingAlias field. */
function metadata(kind) {
  if (kind === 'project') return { id: d.TARGET.project, accountId: d.TARGET.team,
    targets: { production: { id: d.TARGET.deployment } }, autoAssignCustomDomains: true };
  if (kind === 'alias') return { alias: d.TARGET.canonical, projectId: d.TARGET.project,
    deployment: { id: d.TARGET.deployment }, redirect: null };
  return { id: d.TARGET.deployment, projectId: d.TARGET.project, url: d.TARGET.generated, target: 'production',
    readyState: 'READY', meta: { githubCommitSha: d.TARGET.source }, gitSource: { sha: d.TARGET.source },
    aliasAssigned: true, alias: [d.TARGET.canonical] };
}

/** Construct anonymous HTML in memory; all network, cookie and identity strings are synthetic. */
function response() {
  return { status: 200, headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' },
    { name: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }, { name: 'X-Vercel-Cache', value: 'MISS' }],
  body: Buffer.from(`<html><script id="__NEXT_DATA__" type="application/json">{"buildId":"${BUILD}"}</script></html>`) };
}

/** Model verified frozen inputs separately from manifest data for meaningful preflight/postflight drift tests. */
function inputs() {
  return { manifestHash: 'b'.repeat(64), sources: { set: SOURCE,
    files: Object.fromEntries(b.SOURCE_FILES.map(name => [name, SOURCE])) }, history: { ...d.HISTORY }, tools: { ...d.VERCEL_HASHES } };
}

/** Inject all external boundaries and retain call order; tests can never reach native metadata or hosted HTTP. */
function harness() {
  const calls = []; const writes = []; const before = inputs(); const after = inputs(); const handles = [];
  const deps = {
    preflight: async () => { calls.push('preflight'); return before; },
    reserve: async () => {
      calls.push('reserve');
      const handle = { writeFile: async text => { calls.push('write'); writes.push(text); },
        sync: async () => { calls.push('sync'); }, close: async () => { calls.push('close'); } };
      handles.push(handle); return handle;
    },
    metadata: async kind => { calls.push(kind); return metadata(kind); },
    request: async () => { calls.push('login'); return response(); },
    cancel: async () => { calls.push('cancel'); return true; },
    integrity: async () => { calls.push('integrity'); return after; },
  };
  return { deps, calls, writes, before, after, handles };
}

/** Yield through queued promises without sleeping or contacting services. */
function flush() { return new Promise(resolve => setImmediate(resolve)); }

test('inert import preserves nine/six-file contracts and cannot execute from a preparation checkout', async () => {
  assert.equal(d.SOURCE_FILES.length, 9); assert.equal(b.SOURCE_FILES.length, 11);
  assert.deepEqual(b.SOURCE_FILES.slice(0, 9), d.SOURCE_FILES);
  await assert.rejects(b.main([]), { code: 'arguments' });
  await assert.rejects(b.main(['--execute-reviewed-manifest']), { code: 'execution_directory' });
  assert.equal(Object.keys(require.cache).some(name => /playwright-core[\\/](?:lib|index)/.test(name)), false);
});

for (const [name, mutate, code] of [
  ['approval', p => { delete p.approval; }, 'execution_not_approved'],
  ['expired', p => { p.expiresAt = Date.now() - 1; }, 'approval_expired'],
  ['future', p => { p.approvedAt = Date.now() + 60000; }, 'approval_expired'],
  ['long window', p => { p.expiresAt = p.approvedAt + 3600001; }, 'approval_expired'],
  ['target', p => { p.target.deployment = 'other'; }, 'target_mismatch'],
  ['extra destination', p => { p.target.extra = 'https://invalid.test'; }, 'target_mismatch'],
  ['missing source', p => { delete p.sourceSet; }, 'source_mismatch'],
  ['raised budget', p => { p.limits.application = 2; }, 'plan_schema'],
  ['missing budget', p => { delete p.limits; }, 'plan_schema'],
  ['reset consumption', p => { p.ledgerBefore.actual.application = 0; }, 'ledger_mismatch'],
  ['extra consumption', p => { p.ledgerCeiling.actual.application++; }, 'ledger_mismatch'],
  ['fraction', p => { p.ledgerBefore.actual.static += 0.5; }, 'ledger_mismatch'],
]) test('manifest rejects ' + name + ' before any external boundary', async () => {
  const h = harness(); const p = plan(); mutate(p);
  await assert.rejects(b.runAttribution(p, h.deps), { code }); assert.deepEqual(h.calls, []);
});

for (const [name, mutate, code] of [
  ['source', x => { x.sources.set = 'c'.repeat(64); }, 'source_mismatch'],
  ['history', x => { x.history[Object.keys(d.HISTORY)[0]] = 'c'.repeat(64); }, 'history_mismatch'],
  ['tool', x => { x.tools['vc.js'] = 'c'.repeat(64); }, 'toolchain_mismatch'],
  ['manifest', x => { x.manifestHash = 'c'.repeat(64); }, 'manifest_mismatch'],
]) {
  if (name !== 'manifest') test('preflight ' + name + ' mismatch suppresses reservation and traffic', async () => {
    const h = harness(); mutate(h.before);
    await assert.rejects(b.runAttribution(plan(), h.deps), { code }); assert.deepEqual(h.calls, ['preflight']);
  });
  test('postflight ' + name + ' mismatch invalidates attribution without replay', async () => {
    const h = harness(); mutate(h.after); const record = await b.runAttribution(plan(), h.deps);
    assert.equal(record.phase, 'stopped'); assert.equal(record.firstFailure.code, code);
    assert.equal(record.counts.application, 1); assert.equal(record.counts.metadata, 6);
    assert.equal(h.calls.filter(v => v === 'login').length, 1);
  });
}

test('success performs three checks, one GET, three checks, cleanup, integrity and durable bounded evidence', async () => {
  const h = harness(); const p = plan(); p.secret = 'PRIVATE_PLAN';
  const record = await b.runAttribution(p, h.deps);
  assert.deepEqual(h.calls, ['preflight', 'reserve', 'project', 'alias', 'deployment', 'login',
    'project', 'alias', 'deployment', 'cancel', 'integrity', 'write', 'sync', 'close']);
  assert.equal(record.phase, 'passed'); assert.equal(record.gate1Status, 'open'); assert.equal(record.buildId, BUILD);
  assert.equal(record.successfulMetadataResponses, 6); assert.equal(record.matchedMetadataResponses, 6);
  assert.deepEqual(record.requests, b.INCREMENT); assert.equal(record.counts.browsers, 0);
  assert.deepEqual(record.ledgerAfter, p.ledgerCeiling);
  assert.ok(Buffer.byteLength(h.writes[0]) <= 16384); assert.equal(h.writes[0].includes('PRIVATE_PLAN'), false);
});

for (const phase of ['before', 'after']) for (const kind of ['project', 'alias', 'deployment']) {
  test(phase + ' ' + kind + ' drift stops subsequent work', async () => {
    const h = harness(); let reads = 0;
    h.deps.metadata = async current => {
      reads++; h.calls.push(current); const data = metadata(current);
      if (current === kind && (phase === 'before' ? reads <= 3 : reads > 3)) data.projectId = data.id = 'other';
      return data;
    };
    const record = await b.runAttribution(plan(), h.deps);
    assert.equal(record.phase, 'stopped'); assert.equal(record.firstFailure.code, 'metadata_mismatch');
    assert.equal(record.counts.application, phase === 'before' ? 0 : 1);
    assert.equal(record.successfulMetadataResponses, record.counts.metadata);
    assert.equal(record.matchedMetadataResponses, record.counts.metadata - 1);
  });
}

for (const [name, body] of [
  ['missing', '<html></html>'], ['duplicate script', response().body.toString().repeat(2)],
  ['malformed JSON', '<script id="__NEXT_DATA__">{</script>'],
  ['invalid build', '<script id="__NEXT_DATA__">{"buildId":"has spaces"}</script>'],
  ['missing build', '<script id="__NEXT_DATA__">{}</script>'],
  ['numeric build', '<script id="__NEXT_DATA__">{"buildId":42}</script>'],
  ['duplicate key', '<script id="__NEXT_DATA__">{"buildId":"one","buildId":"two"}</script>'],
  ['escaped duplicate key', '<script id="__NEXT_DATA__">{"buildId":"one","\\u0062uildId":"two"}</script>'],
  ['duplicate id attribute', '<script id="other" id="__NEXT_DATA__">{"buildId":"one"}</script>'],
  ['data-id only', '<script data-id="__NEXT_DATA__">{"buildId":"one"}</script>'],
  ['unquoted id', '<script id=__NEXT_DATA__>{"buildId":"one"}</script>'],
  ['comment-only data', '<!--' + response().body.toString() + '-->'],
  ['template-only data', '<template>' + response().body.toString() + '</template>'],
  ['textarea-only data', '<textarea>' + response().body.toString() + '</textarea>'],
  ['plaintext data', '<plaintext>' + response().body.toString()],
]) test('rejects ' + name + ' without retaining HTML or trailing metadata', async () => {
  const h = harness(); h.deps.request = async () => ({ ...response(), body: Buffer.from(body) });
  const record = await b.runAttribution(plan(), h.deps);
  assert.equal(record.firstFailure.code, 'build_missing'); assert.equal(record.counts.metadata, 3);
  assert.equal(record.counts.application, 1); assert.equal(record.buildId, undefined);
});

for (const [name, value] of [['Content-Type', 'application/json'], ['Cache-Control', 'private, no-store'],
  ['X-Vercel-Cache', 'STALE'], ['Age', '3']]) test('public login rejects ' + name + ' contract failure', () => {
  const r = response(); r.headers = r.headers.filter(h => h.name !== name); r.headers.push({ name, value });
  assert.throws(() => b.loginAttribution(r), { code: 'login_contract' });
});

test('static HIT requires valid age and remains attribution rather than fresh-origin evidence', () => {
  const r = response(); r.headers[2].value = 'HIT';
  assert.throws(() => b.loginAttribution(r), { code: 'login_contract' });
  r.headers.push({ name: 'Age', value: '21' }); assert.equal(b.loginAttribution(r).buildId, BUILD);
  r.headers.push({ name: 'Cache-Control', value: 'private' });
  assert.throws(() => b.loginAttribution(r), { code: 'login_contract' });
});

test('failed and uncertain dispatches remain charged; unknown native details are redacted', async () => {
  for (const kind of ['metadata', 'request']) {
    const h = harness(); h.deps[kind] = async () => { throw new Error('PRIVATE_NATIVE_ERROR'); };
    const record = await b.runAttribution(plan(), h.deps);
    assert.equal(record.firstFailure.code, 'operation_failed');
    assert.equal(record.counts.metadata, kind === 'metadata' ? 1 : 3);
    assert.equal(record.counts.application, kind === 'metadata' ? 0 : 1);
    assert.equal(record.successfulMetadataResponses, kind === 'metadata' ? 0 : 3);
    assert.equal(h.writes[0].includes('PRIVATE_NATIVE_ERROR'), false);
  }
});

test('body/header/provider/plan canaries never appear in evidence', async () => {
  const h = harness(); const r = response(); r.headers.push({ name: 'Set-Cookie', value: 'PRIVATE_COOKIE' });
  r.body = Buffer.from(r.body.toString().replace('</html>', '<div>PRIVATE_BODY</div></html>'));
  h.deps.request = async () => r;
  h.deps.metadata = async kind => ({ ...metadata(kind), private: 'PRIVATE_PROVIDER' });
  const p = plan(); p.private = 'PRIVATE_PLAN';
  assert.equal((await b.runAttribution(p, h.deps)).phase, 'passed');
  assert.equal(h.writes[0].includes('PRIVATE_'), false);
  assert.equal(b.errorCode({ code: 'login_contract', message: 'PRIVATE_ERROR' }), 'operation_failed');
  assert.throws(() => b.encodeEvidence({ extra: 'x'.repeat(16384) }), { code: 'evidence_size' });
});

test('occupied output is never overwritten and prevents all provider/application traffic', async () => {
  const h = harness(); h.deps.reserve = async () => { throw Object.assign(new Error('PRIVATE_PATH'), { code: 'EEXIST' }); };
  await assert.rejects(b.runAttribution(plan(), h.deps), { code: 'evidence_already_exists' });
  assert.deepEqual(h.calls, ['preflight']); assert.equal(h.writes.length, 0);
});

for (const operation of ['writeFile', 'sync', 'close']) test('evidence ' + operation + ' failure cannot return a pass', async () => {
  const h = harness(); const reserve = h.deps.reserve;
  h.deps.reserve = async () => {
    const handle = await reserve(); handle[operation] = async () => { h.calls.push(operation + '_failed'); throw new Error('PRIVATE_IO'); }; return handle;
  };
  await assert.rejects(b.runAttribution(plan(), h.deps), { code: operation === 'close' ? 'evidence_close' : 'evidence_write' });
  assert.ok(h.calls.includes(operation === 'close' ? 'close_failed' : 'close'));
});

test('first failure survives cleanup and finalization errors', async () => {
  const h = harness(); const reserve = h.deps.reserve;
  h.deps.request = async () => { throw new b.AttributionError('response_size'); };
  h.deps.cancel = async () => false;
  h.deps.reserve = async () => { const handle = await reserve(); handle.close = async () => { throw new Error('PRIVATE'); }; return handle; };
  await assert.rejects(b.runAttribution(plan(), h.deps), error => {
    assert.equal(error.code, 'evidence_close'); assert.equal(error.firstFailure.code, 'response_size'); return true;
  });
  const receipt = JSON.parse(h.writes[0]); assert.equal(receipt.phase, 'stopped');
  assert.deepEqual(receipt.cleanupFailures, ['request_cleanup']);
});

test('cleanup requires observed transport closure, not a truthy result', async () => {
  const h = harness(); h.deps.cancel = async () => 'closed';
  const record = await b.runAttribution(plan(), h.deps);
  assert.equal(record.phase, 'stopped'); assert.equal(record.firstFailure.code, 'request_cleanup');
});

test('absolute work deadline and expired approval prevent the next dispatch', async () => {
  for (const expireApproval of [true, false]) {
    const h = harness(); let now = Date.now(); const p = plan(now); h.deps.clock = () => now;
    if (expireApproval) p.expiresAt = now + 1000;
    h.deps.metadata = async kind => { now += expireApproval ? 1001 : 220001; return metadata(kind); };
    const record = await b.runAttribution(p, h.deps);
    assert.equal(record.counts.metadata, 1); assert.equal(record.counts.application, 0);
    assert.equal(record.firstFailure.code, expireApproval ? 'approval_expired' : 'work_deadline');
  }
});

test('timeout cancels the in-flight operation; late completion cannot dispatch or mutate the receipt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); let complete; let signal;
  h.deps.request = current => { signal = current; return new Promise(resolve => { complete = resolve; }); };
  const pending = b.runAttribution(plan(), h.deps); await flush();
  t.mock.timers.tick(5000); const record = await pending; const written = h.writes[0];
  assert.equal(signal.aborted, true); assert.equal(record.firstFailure.code, 'operation_timeout');
  assert.equal(record.counts.metadata, 3); complete(response()); await flush();
  assert.equal(h.writes[0], written); assert.equal(record.buildId, undefined);
});

test('late output reservation closes its handle and never starts metadata', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); let complete; let closed = false;
  h.deps.reserve = () => new Promise(resolve => { complete = resolve; });
  const pending = b.runAttribution(plan(), h.deps); const rejected = assert.rejects(pending, { code: 'operation_timeout' });
  await flush(); t.mock.timers.tick(5000); await rejected;
  complete({ close: async () => { closed = true; } }); await flush();
  assert.equal(closed, true); assert.deepEqual(h.calls, ['preflight']);
});

test('reservation completing at the work deadline closes the acquired handle without dispatch', async () => {
  const h = harness(); let now = Date.now(); const p = plan(now); const reserve = h.deps.reserve;
  h.deps.clock = () => now;
  h.deps.reserve = async () => { const handle = await reserve(); now += 220000; return handle; };
  await assert.rejects(b.runAttribution(p, h.deps), { code: 'work_deadline' });
  assert.deepEqual(h.calls, ['preflight', 'reserve', 'close']);
});

/** Model native request/response events, checking transport options without opening sockets. */
function transportHarness(options = {}) {
  const request = new EventEmitter(); const incoming = new EventEmitter(); const calls = [];
  incoming.statusCode = options.status ?? 200; incoming.complete = options.complete ?? true;
  incoming.rawHeaders = options.headers || response().headers.flatMap(h => [h.name, h.value]);
  incoming.destroy = () => { calls.push('response_destroy'); };
  let closed = false;
  request.destroy = () => { calls.push('request_destroy'); if (!closed) { closed = true; request.emit('close'); } };
  request.end = () => { calls.push('end'); };
  let callback;
  return { request, incoming, calls,
    transport: (url, config, handler) => {
      calls.push('transport'); assert.equal(url, d.ORIGIN + '/login'); assert.equal(config.method, 'GET');
      assert.equal(config.agent, false); assert.equal(config.maxHeaderSize, 32768);
      assert.equal(config.headers['Accept-Encoding'], 'identity');
      assert.equal(Object.keys(config.headers).some(name => /cookie|authorization/i.test(name)), false);
      callback = handler; return request;
    },
    respond: () => callback(incoming),
  };
}

test('native transport streams within limits, preserves duplicate headers, closes and fetches no assets', async () => {
  const h = transportHarness(); const owners = []; const controller = new AbortController();
  const pending = b.requestLogin(controller.signal, owners, h.transport); h.respond();
  h.incoming.emit('data', response().body); h.incoming.emit('end'); const result = await pending;
  assert.equal(result.body.toString(), response().body.toString());
  assert.equal(owners.length, 1); assert.equal(owners[0].closed, true);
  assert.equal(h.calls.filter(v => v === 'end').length, 1);
});

for (const [name, options, emit, code] of [
  ['redirect', { status: 302 }, () => {}, 'redirect'],
  ['header overflow', { headers: ['X-Large', 'x'.repeat(32769)] }, () => {}, 'response_size'],
  ['claimed large body', { headers: ['Content-Length', '1048577'] }, () => {}, 'response_size'],
  ['duplicate length', { headers: ['Content-Length', '1', 'Content-Length', '1'] }, () => {}, 'response_size'],
  ['compressed body', { headers: ['Content-Encoding', 'gzip'] }, () => {}, 'response_schema'],
  ['stream overflow', {}, h => h.incoming.emit('data', Buffer.alloc(1048577)), 'response_size'],
  ['incomplete response', { complete: false }, h => h.incoming.emit('end'), 'response_truncated'],
  ['wrong length', { headers: ['Content-Length', '3'] }, h => h.incoming.emit('end'), 'response_truncated'],
  ['aborted response', {}, h => h.incoming.emit('aborted'), 'response_truncated'],
  ['stream error', {}, h => h.incoming.emit('error', new Error('PRIVATE')), 'response_truncated'],
]) test('native transport aborts ' + name + ' without following or retrying', async () => {
  const h = transportHarness(options); const owners = [];
  const pending = b.requestLogin(new AbortController().signal, owners, h.transport);
  const rejected = assert.rejects(pending, { code }); h.respond(); emit(h); await rejected;
  assert.equal(owners[0].closed, true); assert.equal(h.calls.filter(v => v === 'transport').length, 1);
});

test('stalled native response destroys the socket at five seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = transportHarness(); const owners = [];
  const pending = b.requestLogin(new AbortController().signal, owners, h.transport);
  const rejected = assert.rejects(pending, { code: 'operation_timeout' }); h.respond();
  t.mock.timers.tick(5000); await rejected; assert.equal(owners[0].closed, true);
});

test('pre-aborted transport cannot dispatch; later abort destroys an active request', async () => {
  const controller = new AbortController(); controller.abort(); const h = transportHarness();
  assert.throws(() => b.requestLogin(controller.signal, [], h.transport), { code: 'exercise_stopped' });
  assert.deepEqual(h.calls, []);
  const active = new AbortController(); const owners = [];
  const pending = b.requestLogin(active.signal, owners, h.transport);
  const rejected = assert.rejects(pending, { code: 'operation_timeout' }); active.abort(); await rejected;
  assert.equal(owners[0].closed, true);
});

test('native parser overflow maps to a fixed size category without raw errors', async () => {
  const h = transportHarness();
  const pending = b.requestLogin(new AbortController().signal, [], h.transport);
  const rejected = assert.rejects(pending, { code: 'response_size' });
  h.request.emit('error', { code: 'HPE_HEADER_OVERFLOW', message: 'PRIVATE_HEADER' }); await rejected;
});

test('metadata transport retains fixed guarded CLI, timeout, stream limits and abort ownership', async () => {
  const owners = []; const controller = new AbortController(); let callback; const child = new EventEmitter();
  const pending = b.metadata('project', controller.signal, owners, (exe, args, options, done) => {
    assert.equal(exe, process.execPath); assert.deepEqual(args, d.metadataArguments('project'));
    assert.equal(args.includes('--disable-binary'), false); assert.equal(options.signal, controller.signal);
    assert.equal(options.timeout, 30000); assert.equal(options.maxBuffer, 2097152); assert.equal(options.windowsHide, true);
    assert.equal(options.env.VERCEL_CLI_USE_NATIVE_BINARY, '0'); assert.equal(options.env.VERCEL_TELEMETRY_DISABLED, '1');
    callback = done; return child;
  });
  child.emit('close'); callback(null, JSON.stringify(metadata('project')));
  assert.deepEqual(await pending, metadata('project')); assert.equal(owners[0].closed, true);
});

test('native preflight uses source/history/tool checks without any build/profile dependency', async () => {
  const code = await fs.readFile(path.join(__dirname, '../hosted-csrf-build-attribution.cjs'), 'utf8'); const reads = [];
  const mockD = { ...d, readJson: async file => {
    reads.push(file); return { hash: 'b'.repeat(64), data: file.endsWith('package.json') ? { name: 'vercel', version: '62.2.0' } : plan() };
  }, sourceHashes: async () => ({ files: Object.fromEntries(d.SOURCE_FILES.map(name => [name, SOURCE])), set: SOURCE }),
  historyHashes: async () => ({ ...d.HISTORY }) };
  const sandbox = { module: { exports: {} }, __dirname: d.DIRECTORY, Buffer, AbortController,
    process: { version: 'v22.18.0', env: {} },
    require(name) {
      if (name === './hosted-csrf-diagnostic.cjs') return mockD;
      if (name === 'node:fs/promises') return { lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }), realpath: async p => p };
      if (name === 'node:fs') return { createReadStream: file => { reads.push(file); return [Buffer.from('synthetic')]; } };
      if (name === 'node:crypto') return { createHash: () => ({ update() {}, digest: () => SOURCE }) };
      return require(name);
    },
  };
  vm.runInNewContext(code, sandbox); const isolated = sandbox.module.exports;
  // Exact hashes deliberately fail at the first CLI file, after no profile or prerequisite receipt reads.
  const p = plan(); const computed = await isolated.sourceHashes(); p.sourceSet = computed.set;
  await assert.rejects(isolated.preflight(p, new AbortController().signal), { code: 'toolchain_mismatch' });
  assert.equal(reads.some(file => /authentication-preparation|build-attribution\.json|profile-01/.test(file)), false);
});

test('source hashing binds eleven files while preserving all qualified source and historical receipt bytes', async () => {
  const sources = await b.sourceHashes(); assert.equal(Object.keys(sources.files).length, 11);
  assert.equal(sources.set, d.digest(JSON.stringify(sources.files)));
  assert.equal(sources.diagnosticSet, (await d.sourceHashes()).set);
  assert.deepEqual(await d.historyHashes(), d.HISTORY);
});
