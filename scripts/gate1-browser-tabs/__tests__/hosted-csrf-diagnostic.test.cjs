'use strict';
/* global __dirname, Buffer, setImmediate, structuredClone */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const fixture = require('../request-client-isolation.cjs');
const qualified = require('../full-isolation-qualification.cjs');
const d = require('../hosted-csrf-diagnostic.cjs');
const ACCOUNT = '11111111-2222-3333-4444-555555555555';
const SOURCE = 'a'.repeat(64);
const BUILD = 'offline-synthetic-build';
const NOW = 1793669000000;

/** Supply a synthetic reviewed manifest with explicit preparation consumption and no real identity. */
function plan(now = Date.now()) {
  const ledgerBefore = { actual: { application: 154, static: 157, session: 54 },
    conservative: { application: 155, static: 157, session: 54 } };
  return { approval: d.APPROVAL, readinessPolicy: d.POLICY, target: { ...d.TARGET }, buildId: BUILD,
    profile: d.PROFILE, profilePreparationApproved: true, approvedAt: now - 1000, expiresAt: now + 600000,
    sourceSet: SOURCE, preparationHashes: { 'build-attribution.json': SOURCE, 'authentication-preparation.json': SOURCE },
    ledgerBefore, ledgerCeiling: Object.fromEntries(['actual', 'conservative'].map(kind =>
      [kind, d.addCounts(ledgerBefore[kind], { application: 3, static: 0, session: 1 })])) };
}

/** Model fixed control-plane schemas with no provider call or raw credentials. */
function metadata(kind) {
  if (kind === 'project') return { id: d.TARGET.project, accountId: d.TARGET.team,
    targets: { production: { id: d.TARGET.deployment } }, autoAssignCustomDomains: true, pendingAlias: false };
  if (kind === 'alias') return { alias: d.TARGET.canonical, projectId: d.TARGET.project,
    deployment: { id: d.TARGET.deployment }, redirect: null };
  return { id: d.TARGET.deployment, projectId: d.TARGET.project, url: d.TARGET.generated, target: 'production',
    readyState: 'READY', meta: { githubCommitSha: d.TARGET.source }, gitSource: { sha: d.TARGET.source },
    aliasAssigned: true, alias: [d.TARGET.canonical] };
}

/** Construct bounded synthetic HTTP responses; tokens remain in memory and never use a signing secret. */
function response(endpoint, now = Date.now()) {
  const token = `${'a'.repeat(64)}.${Math.floor(now / 1000)}.${'b'.repeat(64)}`;
  const headers = [{ name: 'Cache-Control', value: endpoint === '/login' ? 'public, max-age=0, must-revalidate' : 'private, no-store' },
    { name: 'X-Vercel-Cache', value: 'MISS' }, { name: 'Content-Type', value: endpoint === '/login' ? 'text/html' : 'application/json; charset=utf-8' },
    { name: 'Date', value: new Date(now).toUTCString() }];
  if (endpoint === '/api/auth/csrf') headers.push({ name: 'Set-Cookie',
    value: `__Host-csrf-token=${token}; Max-Age=14400; Path=/; Secure; SameSite=Lax` });
  const body = endpoint === '/login' ? `<script id="__NEXT_DATA__" type="application/json">{"buildId":"${BUILD}"}</script>`
    : JSON.stringify(endpoint.endsWith('session') ? { data: { user: { id: ACCOUNT, email: 'PRIVATE_EMAIL' } }, error: null, message: 'Success' }
      : { data: null, error: null, message: 'CSRF token set' });
  return { status: 200, headers, body: Buffer.from(body), token };
}

/** Model browser cookie write-back for only the synthetic CSRF cookie. */
function cookies(value, now = Date.now()) {
  return [{ name: '__Host-csrf-token', value, domain: d.TARGET.canonical, path: '/', secure: true,
    httpOnly: false, sameSite: 'Lax', expires: now / 1000 + 14400 }];
}

/** Replace one synthetic header without losing the ability to explicitly test duplicates. */
function header(result, name, value) {
  result.headers = result.headers.filter(item => item.name.toLowerCase() !== name.toLowerCase());
  if (value !== null) result.headers.push({ name, value }); return result;
}

/** Model owned process/context/page objects, including active restored workers, without browser startup. */
function owner() {
  const keeper = new EventEmitter(); keeper.url = () => 'about:blank'; keeper.isClosed = () => false;
  const context = new EventEmitter(); context.pages = () => [keeper];
  context.serviceWorkers = () => [{ url() { throw new Error('Worker URLs must not be read'); } }];
  return { keeper, context, child: { exitCode: null }, closed: false, failed: false,
    browser: { version: () => qualified.PIN.version, isConnected: () => true } };
}

/** Replace native boundaries while exercising the real validators, budgets, orchestration and evidence projection. */
function harness(options = {}) {
  const calls = []; const writes = []; const owned = owner(); let budget; let release; let token;
  const deps = {
    /** Admit synthetic immutable inputs, with injectable preflight failure before output/native work. */
    async preflight() {
      calls.push('preflight'); if (options.preflightFailure) throw new d.DiagnosticError('package_mismatch');
      return { sources: { set: SOURCE }, history: { ...d.HISTORY } };
    },
    /** Reserve one in-memory receipt; test I/O failures without creating local evidence. */
    async reserve() {
      calls.push('reserve'); if (options.occupied) throw new d.DiagnosticError('evidence_already_exists');
      const handle = {
        /** Keep only sanitized output and simulate a rejected write. */
        async writeFile(text) { calls.push('write'); if (options.writeFailure) throw new Error('PRIVATE_WRITE'); writes.push(text); },
        /** Track handle cleanup even when another finalization step has failed. */
        async close() { calls.push('handle_close'); if (options.closeFailure) throw new Error('PRIVATE_CLOSE'); },
      };
      if (options.hangReserve) return new Promise(resolve => { release = () => resolve(handle); });
      return handle;
    },
    /** Defer native loading until prerequisites, reservation and metadata admission pass. */
    runtime() { calls.push('runtime'); return {}; },
    /** Return selected synthetic metadata and fail before/after cases when requested. */
    async metadata(kind) {
      calls.push('metadata_' + kind);
      if (options.metadataFailure && (options.metadataFailure === calls.filter(v => v.startsWith('metadata_')).length))
        throw new Error('PRIVATE_PROVIDER');
      const result = metadata(kind); if (options.metadataDrift && kind === 'alias') result.projectId = 'wrong'; return result;
    },
    /** Register proxy ownership before asynchronous work, as the real helper does. */
    async proxy(activeBudget, servers) { budget = activeBudget; calls.push('proxy'); const proxy = { port: 12345 }; servers.push(proxy); return proxy; },
    /** Reserve the sole launch/page and register the child before a potential attachment failure. */
    async launch(args) {
      calls.push('launch'); budget.count('launches'); budget.count('pages'); args.owners.push(owned);
      if (options.launchFailure) throw new Error('PRIVATE_LAUNCH');
      if (options.extraPage) owned.context.pages = () => [owned.keeper, {}];
      return owned;
    },
    /** Dispatch only synthetic fixed GETs, optionally resolving after the diagnostic timeout. */
    async request(activeOwner, endpoint) {
      assert.equal(activeOwner, owned); calls.push(endpoint);
      if (options.hangRequest) return new Promise(resolve => { release = () => resolve(response(endpoint)); });
      if (options.requestFailure) throw new Error('PRIVATE_RESPONSE');
      if (options.navigate) owned.keeper.emit('framenavigated');
      if (options.overflow) { for (let i = 0; i <= d.LIMITS.proxyConnections; i++) budget.count('proxyConnections'); }
      const result = response(endpoint); token = result.token;
      if (endpoint === '/login' && options.wrongBuild) result.body = Buffer.from('<script id="__NEXT_DATA__">{"buildId":"other"}</script>');
      if (endpoint.endsWith('session') && options.wrongAccount) result.body = Buffer.from('{"data":{"user":{"id":"PRIVATE_OTHER"}},"error":null,"message":"Success"}');
      if (endpoint.endsWith('csrf') && options.badCsrf) header(result, 'Set-Cookie', `__Host-csrf-token=${result.token}; Path=/; Secure; SameSite=Lax`);
      return result;
    },
    /** Read back synthetic in-memory cookies, never a profile file. */
    async cookies() { calls.push('cookies'); return cookies(token); },
    /** Cancel pending request-client work before normal browser cleanup. */
    async cancelRequests() { calls.push('cancel'); if (options.cancelFailure) throw new Error('PRIVATE_CANCEL'); },
    /** Model verified normal parent exit or an incomplete cleanup result. */
    async closeBrowser(activeOwner) {
      calls.push('browser_close'); if (options.browserFailure) return false;
      activeOwner.child.exitCode = 0; activeOwner.closed = true; return true;
    },
    /** Keep the rejecting proxy through browser cleanup, including late incoming overflow. */
    async closeProxy() {
      calls.push('proxy_close');
      if (options.cleanupOverflow) { budget.counts.proxyConnections = 200; try { budget.count('proxyConnections'); } catch { /* Rejection is expected. */ } }
      if (options.proxyFailure) throw new Error('PRIVATE_PROXY');
    },
    /** Verify directory preservation without opening authentication storage. */
    async profileExists() { return !options.missingProfile; },
    /** Return all fifteen original hashes or a controlled integrity mismatch. */
    async history() { return { ...d.HISTORY, ...(options.changedHistory ? { 'csrf-diagnostic.json': SOURCE } : {}) }; },
    /** Bind postflight to the reviewed source set. */
    async sources() { return { set: options.changedSources ? 'b'.repeat(64) : SOURCE }; },
  };
  return { deps, calls, writes, owned, release: () => release(), get budget() { return budget; } };
}

/** Flush asynchronous test continuations without real timers or provider access. */
function turn() { return new Promise(resolve => setImmediate(resolve)); }

test('inert import leaves native dependencies unloaded and all historical bindings intact', () => {
  assert.equal(Object.keys(d.HISTORY).length, 15); assert.equal(Object.keys(qualified.HISTORY).length, 14);
  assert.equal(d.HISTORY['browser-isolation-fixture-cft158-01.json'], 'f7f7a8fea52f058842d2a1e6a008823f452593c949684b41a51b5aa40fa8c647');
  assert.equal(d.SOURCE_FILES.length, 9);
  assert.equal(Object.keys(require.cache).some(key => key.includes('playwright-core')), false);
});

for (const [label, mutate, code] of [
  ['approval', p => { p.approval = null; }, 'execution_not_approved'],
  ['readiness', p => { p.readinessPolicy = 'legacy'; }, 'readiness_not_approved'],
  ['target', p => { p.target.deployment = 'old'; }, 'target_mismatch'],
  ['build', p => { p.buildId = null; }, 'build_missing'],
  ['profile', p => { p.profile = 'retained-edge'; }, 'profile_not_approved'],
  ['profile approval', p => { p.profilePreparationApproved = false; }, 'profile_not_approved'],
  ['expiry', p => { p.expiresAt = NOW; }, 'approval_expired'],
  ['future approval', p => { p.approvedAt = NOW + 1; }, 'approval_expired'],
  ['long approval', p => { p.expiresAt = NOW + 3600001; }, 'approval_expired'],
  ['source digest', p => { p.sourceSet = ''; }, 'source_mismatch'],
  ['preparation', p => { delete p.preparationHashes; }, 'preparation_missing'],
  ['reset ledger', p => { p.ledgerBefore.actual.application = 0; }, 'ledger_mismatch'],
  ['extra allowance', p => { p.ledgerCeiling.actual.application++; }, 'ledger_mismatch'],
  ['static allowance', p => { p.ledgerCeiling.actual.static++; }, 'ledger_mismatch'],
  ['session inclusion', p => { p.ledgerBefore.actual.session = 999; }, 'ledger_mismatch'],
]) test('plan rejects ' + label + ' before native work', () => {
  const input = plan(NOW); mutate(input); assert.throws(() => d.validatePlan(input, ACCOUNT, NOW), { code });
});

test('private identity is mandatory and cannot be a CLI arbitrary string', () => {
  for (const id of [undefined, '', 'PRIVATE_ACCOUNT', '-'.repeat(36)]) assert.throws(() => d.validatePlan(plan(NOW), id, NOW), { code: 'account_missing' });
});

test('preparation receipt accounting includes build and measured sign-in traffic', () => {
  const p = plan(NOW); const build = { phase: 'passed', target: d.TARGET, buildId: BUILD, requests: { application: 1, static: 0, session: 0 } };
  const auth = { phase: 'passed', target: d.TARGET, buildId: BUILD, profile: d.PROFILE, identityVerified: true,
    browserTrafficMeasured: true, closedNormally: true, independentProcessExitVerified: true,
    requests: { actual: { application: 4, static: 7, session: 2 }, conservative: { application: 4, static: 7, session: 2 } } };
  d.validatePreparation(p, build, auth);
  assert.throws(() => d.validatePreparation(p, build, { ...auth, browserTrafficMeasured: false }), { code: 'preparation_missing' });
  assert.throws(() => d.validatePreparation(p, build, { ...auth, independentProcessExitVerified: false }), { code: 'preparation_missing' });
  auth.requests.actual.application++;
  assert.throws(() => d.validatePreparation(p, build, auth), { code: 'ledger_mismatch' });
});

for (const kind of ['project', 'alias', 'deployment']) test('exact ' + kind + ' metadata admits only pinned identity', () => {
  assert.equal(d.validateMetadata(kind, metadata(kind)), true);
  const data = metadata(kind); if (kind === 'project') data.targets.production.id = 'old';
  else if (kind === 'alias') data.deployment.id = 'old'; else data.gitSource.sha = 'old';
  assert.throws(() => d.validateMetadata(kind, data), { code: 'metadata_mismatch' });
});

for (const [kind, mutate] of [
  ['project', x => { x.accountId = 'wrong-team'; }], ['project', x => { x.autoAssignCustomDomains = false; }],
  ['project', x => { x.pendingAlias = true; }], ['alias', x => { x.redirect = 'other'; }],
  ['alias', x => { x.projectId = 'other'; }], ['deployment', x => { x.meta.githubCommitSha = 'other'; }],
  ['deployment', x => { x.readyState = 'BUILDING'; }], ['deployment', x => { x.alias = []; }],
]) test('metadata rejects ' + kind + ' drift ' + mutate.toString(), () => {
  const data = metadata(kind); mutate(data); assert.throws(() => d.validateMetadata(kind, data), { code: 'metadata_mismatch' });
});

test('public login permits attributed static HIT but rejects stale, duplicate and wrong build', () => {
  const result = response('/login', NOW); header(result, 'X-Vercel-Cache', 'HIT'); header(result, 'Age', '21');
  assert.ok(Object.values(d.loginChecks(result, BUILD)).every(Boolean));
  assert.equal(d.loginChecks(result, 'wrong').build, false);
  header(result, 'X-Vercel-Cache', 'STALE'); assert.equal(d.loginChecks(result, BUILD).cacheStatus, false);
  header(result, 'X-Vercel-Cache', 'HIT'); header(result, 'Age', null); assert.equal(d.loginChecks(result, BUILD).age, false);
  result.headers.push({ name: 'Cache-Control', value: 'private, no-store' });
  assert.equal(d.loginChecks(result, BUILD).cachePolicy, false);
});

test('protected cache checks reject CDN overrides, HIT, positive age and ambiguous headers', () => {
  for (const [name, value, key] of [['Cache-Control', 'public, max-age=1', 'privateNoStore'],
    ['CDN-Cache-Control', 'public, s-maxage=20', 'cacheOverrides'], ['X-Vercel-Cache', 'HIT', 'cacheStatus'], ['Age', '1', 'age']]) {
    const result = response('/api/auth/session', NOW); header(result, name, value);
    assert.equal(d.sessionChecks(result, ACCOUNT)[key], false);
  }
  const result = response('/api/auth/session', NOW); result.headers.push({ name: 'X-Vercel-Cache', value: 'MISS' });
  assert.equal(d.sessionChecks(result, ACCOUNT).cacheStatus, false);
});

test('CSRF success requires cookie-only token, write-back, attributes and independent clock checks', () => {
  const result = response('/api/auth/csrf', NOW); const stored = cookies(result.token, NOW);
  const checks = d.csrfChecks(result, stored, NOW, NOW + 200);
  assert.ok(Object.values(checks).every(Boolean)); assert.ok(Object.keys(checks).length >= 20);
  assert.equal(JSON.stringify(checks).includes(result.token), false);
  assert.equal(d.csrfChecks(result, [], NOW, NOW).cookieWriteback, false);
  assert.equal(d.csrfChecks(result, [...stored, ...stored], NOW, NOW).cookieWriteback, false);
  stored[0].value = 'PRIVATE_WRONG'; assert.equal(d.csrfChecks(result, stored, NOW, NOW).cookieWriteback, false);
});

for (const [label, transform, expected] of [
  ['domain', value => value + '; Domain=example.invalid', 'cookieHostOnly'],
  ['httpOnly', value => value + '; HttpOnly', 'cookieHttpOnly'],
  ['secure', value => value.replace('; Secure', ''), 'cookieSecure'],
  ['samesite', value => value.replace('SameSite=Lax', 'SameSite=None'), 'cookieSameSite'],
  ['path', value => value.replace('Path=/', 'Path=/api'), 'cookiePath'],
  ['age', value => value.replace('14400', '120'), 'cookieMaxAge'],
  ['duplicate attribute', value => value + '; Path=/', 'cookieAttributesUnique'],
  ['unexpected attribute', value => value + '; Partitioned', 'cookieAttributesKnown'],
  ['token shape', value => value.replace('a'.repeat(64), 'private'), 'tokenShape'],
]) test('CSRF isolates ' + label + ' failure', () => {
  const result = response('/api/auth/csrf', NOW); const h = result.headers.find(v => v.name === 'Set-Cookie'); h.value = transform(h.value);
  assert.equal(d.csrfChecks(result, cookies(result.token, NOW), NOW, NOW)[expected], false);
});

test('CSRF clocks and expiry never infer HMAC validity or pass stale tokens', () => {
  const result = response('/api/auth/csrf', NOW - 60000);
  let checks = d.csrfChecks(result, cookies(result.token, NOW - 60000), NOW, NOW);
  assert.equal(checks.tokenClock, false); assert.equal(checks.serverClock, false); assert.equal(checks.cookieExpiry, false);
  header(result, 'Date', new Date(NOW).toUTCString()); checks = d.csrfChecks(result, cookies(result.token, NOW), NOW, NOW);
  assert.equal(checks.tokenServerClock, false); assert.equal(Object.hasOwn(checks, 'signatureVerified'), false);
});

test('CSRF envelope and duplicate response cookie remain separate failures', () => {
  const result = response('/api/auth/csrf', NOW); result.body = Buffer.from(JSON.stringify({ data: result.token, error: null, message: 'CSRF token set' }));
  assert.equal(d.csrfChecks(result, cookies(result.token, NOW), NOW, NOW).envelope, false);
  result.headers.push({ ...result.headers.find(v => v.name === 'Set-Cookie') });
  assert.equal(d.csrfChecks(result, cookies(result.token, NOW), NOW, NOW).cookieHeaderUnique, false);
});

test('budget reserves before dispatch and latches excess including rejected cleanup traffic', () => {
  const b = new d.Budget(() => NOW); for (let i = 0; i < 3; i++) b.count('application');
  assert.throws(() => b.count('application'), { code: 'budget_exceeded' }); assert.equal(b.counts.application, 3);
  assert.throws(() => b.count('metadata'), { code: 'exercise_stopped' });
  const proxy = new d.Budget(() => NOW); proxy.halted = true;
  for (let i = 0; i < 201; i++) { try { proxy.count('proxyConnections'); } catch { /* Reject every connection. */ } }
  assert.equal(proxy.counts.proxyConnections, 201); assert.equal(proxy.firstFailure.code, 'budget_exceeded');
});

test('scoped readiness accepts restored workers but rejects page changes and wrong Chrome', () => {
  const owned = owner(); d.readiness(owned);
  owned.context.pages = () => [owned.keeper, {}]; assert.throws(() => d.readiness(owned), { code: 'readiness' });
  owned.context.pages = () => [owned.keeper]; owned.browser.version = () => 'Edge';
  assert.throws(() => d.readiness(owned), { code: 'toolchain_mismatch' });
});

test('owned authenticated launch uses qualified no-bypass flags and refuses synthetic or other profiles', () => {
  const args = d.launchArguments(d.PROFILE, 12345);
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:12345')); assert.ok(args.includes('--proxy-bypass-list=<-loopback>'));
  assert.ok(args.includes('--disable-quic')); assert.ok(args.includes('--no-startup-window'));
  assert.throws(() => d.launchArguments('isolation-fixture-fake', 12345), { code: 'profile_path' });
});

test('successful sequence is exactly six metadata reads and three GETs, followed by normal cleanup', async () => {
  const h = harness(); const input = plan(); input.extra = 'PRIVATE_PLAN'; input.preparationHashes.extra = 'PRIVATE_PREPARATION';
  const record = await d.runDiagnostic(input, ACCOUNT, h.deps);
  assert.equal(record.phase, 'passed'); assert.equal(record.hostedQualified, false); assert.equal(record.independentProcessExitVerified, false);
  assert.equal(record.gate1Status, 'open'); assert.equal(record.counts.metadata, 6); assert.equal(record.counts.application, 3);
  assert.equal(record.counts.session, 1); assert.equal(record.counts.static, 0);
  assert.deepEqual(h.calls.filter(v => v.startsWith('/')), ['/login', '/api/auth/session', '/api/auth/csrf']);
  assert.deepEqual(record.ledgerAfter, input.ledgerCeiling); assert.equal(record.ownedBrowsersClosedNormally, true);
  assert.ok(h.calls.indexOf('cancel') < h.calls.indexOf('browser_close')); assert.ok(h.calls.indexOf('browser_close') < h.calls.indexOf('proxy_close'));
  assert.equal(h.owned.context.listenerCount('page'), 0); assert.equal(h.owned.keeper.listenerCount('framenavigated'), 0);
  assert.equal(h.writes.length, 1); assert.equal(h.calls.at(-1), 'handle_close');
  for (const sensitive of [ACCOUNT, 'PRIVATE_', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.']) assert.ok(!h.writes[0].includes(sensitive));
});

for (const [option, code, requests] of [
  ['metadataDrift', 'metadata_mismatch', 0], ['launchFailure', 'operation_failed', 0], ['extraPage', 'readiness', 0],
  ['requestFailure', 'operation_failed', 1], ['wrongBuild', 'login_contract', 1], ['wrongAccount', 'session_contract', 2],
  ['badCsrf', 'csrf_contract', 3], ['navigate', 'browser_activity', 1], ['overflow', 'budget_exceeded', 1],
  ['browserFailure', 'browser_cleanup', 3], ['proxyFailure', 'proxy_cleanup', 3], ['cancelFailure', 'request_cleanup', 3],
  ['missingProfile', 'profile_preservation', 3], ['changedHistory', 'history_mismatch', 3], ['changedSources', 'source_mismatch', 3],
  ['cleanupOverflow', 'budget_exceeded', 3],
]) test('orchestration stops on ' + option + ' and preserves sanitized failure evidence', async () => {
  const h = harness({ [option]: true }); const record = await d.runDiagnostic(plan(), ACCOUNT, h.deps);
  assert.equal(record.phase, 'stopped'); assert.equal(record.firstFailure.code, code);
  assert.equal(record.counts.application, requests); assert.equal(record.diagnosticChecksPassed, false);
  assert.ok(!h.writes[0].includes('PRIVATE_')); assert.equal(h.calls.at(-1), 'handle_close');
});

test('CSRF failure retains each subcheck and cannot start trailing metadata or checkout', async () => {
  const h = harness({ badCsrf: true }); const record = await d.runDiagnostic(plan(), ACCOUNT, h.deps);
  assert.equal(record.checks.csrf.cookieMaxAge, false); assert.equal(record.checks.csrf.cookieWriteback, true);
  assert.equal(record.counts.metadata, 3); assert.equal(record.counts.application, 3);
});

test('post-case metadata drift invalidates success without replaying requests', async () => {
  const h = harness({ metadataFailure: 4 }); const record = await d.runDiagnostic(plan(), ACCOUNT, h.deps);
  assert.equal(record.phase, 'stopped'); assert.equal(record.firstFailure.stage, 'metadata_after');
  assert.equal(record.counts.application, 3); assert.equal(record.counts.metadata, 4);
});

test('first case failure survives later cleanup failures', async () => {
  const h = harness({ wrongAccount: true, browserFailure: true, proxyFailure: true });
  const record = await d.runDiagnostic(plan(), ACCOUNT, h.deps);
  assert.equal(record.firstFailure.code, 'session_contract'); assert.deepEqual(record.cleanupFailures, ['browser_cleanup', 'proxy_cleanup']);
});

for (const [method, field, code] of [
  ['profileExists', 'profilePreserved', 'profile_preservation'],
  ['history', 'historyUnchanged', 'history_mismatch'],
  ['sources', 'sourcesUnchanged', 'source_mismatch'],
]) for (const failure of ['rejection', 'timeout']) test('postflight ' + method + ' ' + failure + ' preserves independent checks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); const calls = []; const recover = h.deps[method]; let release;
  for (const name of ['profileExists', 'history', 'sources']) {
    const original = h.deps[name];
    /** Record postflight order and inject one failure without touching files or provider state. */
    h.deps[name] = async () => {
      calls.push(name);
      if (name !== method) return original();
      if (failure === 'rejection') throw new Error('PRIVATE_POSTFLIGHT');
      return new Promise(resolve => { release = resolve; });
    };
  }
  const pending = d.runDiagnostic(plan(), ACCOUNT, h.deps); await turn();
  if (failure === 'timeout') { assert.equal(calls.at(-1), method); t.mock.timers.tick(1001); }
  const record = await pending;
  assert.deepEqual(calls, ['profileExists', 'history', 'sources']);
  for (const key of ['profilePreserved', 'historyUnchanged', 'sourcesUnchanged']) assert.equal(record[key], key !== field);
  assert.deepEqual(record.cleanupFailures, [code]); assert.equal(record.firstFailure.code, code);
  assert.equal(record.firstFailure.stage, 'cleanup'); assert.equal(record.phase, 'stopped');
  assert.equal(record.diagnosticChecksPassed, false); assert.equal(JSON.parse(h.writes[0])[field], false);
  assert.ok(!h.writes[0].includes('PRIVATE_')); assert.equal(h.calls.at(-1), 'handle_close');
  if (failure === 'timeout') {
    const snapshot = JSON.stringify(record); release(await recover()); await turn();
    assert.equal(JSON.stringify(record), snapshot); assert.equal(h.writes.length, 1);
  }
});

test('postflight rejections record every failure without replacing the first case failure', async () => {
  const h = harness({ wrongAccount: true });
  for (const method of ['profileExists', 'history', 'sources']) {
    /** Reject each independent postflight dependency to verify complete sanitized failure evidence. */
    h.deps[method] = async () => { throw new Error('PRIVATE_POSTFLIGHT'); };
  }
  const record = await d.runDiagnostic(plan(), ACCOUNT, h.deps);
  assert.deepEqual(record.cleanupFailures, ['profile_preservation', 'history_mismatch', 'source_mismatch']);
  for (const key of ['profilePreserved', 'historyUnchanged', 'sourcesUnchanged']) assert.equal(record[key], false);
  assert.equal(record.firstFailure.code, 'session_contract'); assert.equal(record.phase, 'stopped');
  assert.ok(!h.writes[0].includes('PRIVATE_')); assert.equal(h.calls.at(-1), 'handle_close');
});

for (const [options, code, calls] of [[{ preflightFailure: true }, 'package_mismatch', ['preflight']],
  [{ occupied: true }, 'evidence_already_exists', ['preflight', 'reserve']]]) test('admission failure precedes native work: ' + code, async () => {
  const h = harness(options); await assert.rejects(d.runDiagnostic(plan(), ACCOUNT, h.deps), { code }); assert.deepEqual(h.calls, calls);
});

for (const [options, code] of [[{ writeFailure: true }, 'evidence_write'], [{ closeFailure: true }, 'evidence_close'],
  [{ writeFailure: true, closeFailure: true }, 'evidence_write']]) test('receipt I/O failure rejects success: ' + code + JSON.stringify(options), async () => {
  const h = harness(options); await assert.rejects(d.runDiagnostic(plan(), ACCOUNT, h.deps), { code }); assert.equal(h.calls.at(-1), 'handle_close');
});

test('late request completion cannot mutate evidence or dispatch the next request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = harness({ hangRequest: true });
  const pending = d.runDiagnostic(plan(), ACCOUNT, h.deps); await turn();
  assert.ok(h.calls.includes('/login')); t.mock.timers.tick(5001); const record = await pending;
  const snapshot = JSON.stringify(record); h.release(); await turn();
  assert.equal(JSON.stringify(record), snapshot); assert.equal(record.firstFailure.code, 'operation_timeout');
  assert.equal(h.calls.filter(v => v.startsWith('/')).length, 1); assert.equal(h.writes.length, 1);
});

test('late reservation closes its consumed handle without metadata or browser work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = harness({ hangReserve: true });
  const pending = d.runDiagnostic(plan(), ACCOUNT, h.deps); const rejected = assert.rejects(pending, { code: 'operation_timeout' });
  await turn(); t.mock.timers.tick(5001); await rejected; h.release(); await turn();
  assert.deepEqual(h.calls, ['preflight', 'reserve', 'handle_close']);
});

test('response adapter disables redirects/retries, uses context cookies and disposes retained bodies', async () => {
  const b = new d.Budget(); const calls = []; const result = response('/api/auth/csrf');
  const owned = { context: { request: { async get(url, options) {
    calls.push({ url, options }); return { url: () => url, status: () => 200, headersArray: () => result.headers,
      body: async () => result.body, dispose: async () => { calls.push('dispose'); } };
  } } } };
  await d.request(owned, '/api/auth/csrf', b);
  assert.equal(calls[0].url, d.ORIGIN + '/api/auth/csrf'); assert.equal(calls[0].options.maxRetries, 0);
  assert.equal(calls[0].options.maxRedirects, 0); assert.equal(calls[0].options.timeout, 5000); assert.equal(calls[1], 'dispose');
  await assert.rejects(d.request(owned, '/api/billing/checkout', b), { code: 'response_schema' }); assert.equal(calls.length, 2);
});

for (const [status, bytes, code] of [[302, 10, 'redirect'], [200, d.LIMITS.jsonBytes + 1, 'response_size']])
  test('response adapter rejects redirect/oversize and still disposes', async () => {
    let disposed = false; const owned = { context: { request: { async get(url) {
      return { url: () => url, status: () => status, headersArray: () => [], body: async () => Buffer.alloc(bytes),
        dispose: async () => { disposed = true; } };
    } } } };
    await assert.rejects(d.request(owned, '/api/auth/session', new d.Budget()), { code }); assert.equal(disposed, true);
  });

test('bounded evidence rejects overflow and maps unknown native errors to a fixed category', () => {
  assert.throws(() => d.encodeEvidence({ synthetic: 'x'.repeat(d.LIMITS.evidenceBytes) }), { code: 'evidence_size' });
  assert.equal(d.errorCode(new Error('PRIVATE_SECRET')), 'operation_failed');
  assert.equal(d.errorCode({ code: 'csrf_contract', message: 'PRIVATE_SECRET' }), 'operation_failed');
});

test('CLI refuses preparation checkout before reading a manifest or loading a browser', async () => {
  await assert.rejects(d.main(['--execute-reviewed-manifest']), { code: 'execution_directory' });
  await assert.rejects(d.main([]), { code: 'arguments' });
});

test('native launcher registers ownership before attachment failure and uses hidden pinned Chrome', async () => {
  const code = await fs.readFile(path.join(__dirname, '../hosted-csrf-diagnostic.cjs'), 'utf8'); const calls = [];
  const child = new EventEmitter(); child.exitCode = null;
  const mockFs = { realpath: async value => value, stat: async () => ({ mtimeMs: Date.now() + 1, size: 20 }), readFile: async () => '12345\n' };
  const sandbox = { module: { exports: {} }, __dirname: d.DIRECTORY, Buffer, process: { env: {} }, structuredClone,
    require(name) {
      if (name === 'node:fs/promises') return mockFs;
      if (name === 'node:child_process') return { spawn(executable, args, options) { calls.push({ executable, args, options }); return child; } };
      if (name === './request-client-isolation.cjs') return fixture;
      if (name === './full-isolation-qualification.cjs') return qualified;
      if (name === './page-lifecycle-diagnostic.cjs') return require('../page-lifecycle-diagnostic.cjs');
      return require(name);
    },
  };
  vm.runInNewContext(code, sandbox); const owners = []; const budget = new d.Budget();
  const runtime = { chromium: { async connectOverCDP() { throw new Error('PRIVATE_ATTACH'); } } };
  await assert.rejects(sandbox.module.exports.launch({ runtime, proxy: { port: 12344 }, budget, owners }));
  assert.equal(owners.length, 1); assert.equal(owners[0].child, child); assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].executable, fixture.fixtureExecutable('cft158')); assert.equal(budget.counts.launches, 1);
});

test('metadata client guard refuses refresh, redirects, retries, alternate API and second dispatch', async () => {
  const calls = [];
  /** Stand in for the pinned CLI client without constructing its credentials or transport. */
  class Client {
    /** Keep only a synthetic authentication marker for the validity guard. */
    constructor() { this.authConfig = { synthetic: true }; this.apiUrl = 'https://api.vercel.com'; }
    /** Record original transport options to verify the wrapper restricts every dispatch. */
    async fetch(url, options) { await this.ensureAuthorized(); calls.push({ url, options }); return {}; }
  }
  const endpoint = `/v9/projects/${d.TARGET.project}?teamId=${d.TARGET.team}`;
  d.guardMetadataClient(Client, value => value.synthetic === true, endpoint);
  const client = new Client();
  assert.throws(() => client.fetch(endpoint, { method: 'POST' }), /metadata_dispatch_refused/);
  assert.throws(() => client.fetch('https://other.invalid', { method: 'GET' }), /metadata_dispatch_refused/);
  client.apiUrl = 'https://other.invalid'; assert.throws(() => client.fetch(endpoint, { method: 'GET' }), /metadata_dispatch_refused/);
  client.apiUrl = 'https://api.vercel.com';
  await client.fetch(endpoint, { method: 'GET', redirect: 'follow', retry: { retries: 10 } });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.redirect, 'manual');
  assert.deepEqual(calls[0].options.retry, { retries: 0 }); assert.equal(calls[0].options.bailOn429, true);
  assert.equal(calls[0].options.useCurrentTeam, false); assert.equal(calls[0].options.accountId, undefined);
  assert.throws(() => client.fetch(endpoint, { method: 'GET' }), /metadata_dispatch_refused/);
  client.authConfig = {}; await assert.rejects(client.ensureAuthorized(), /metadata_auth_unavailable/);
  await assert.rejects(client.reauthenticate(), /metadata_auth_unavailable/);
});

test('metadata preload selects the API command without the parser-incompatible launcher flag', () => {
  for (const kind of ['project', 'alias', 'deployment']) {
    const args = d.metadataArguments(kind); assert.equal(args[0], '--import');
    assert.equal(args[3], 'api'); assert.ok(!args.includes('--disable-binary'));
    const preload = decodeURIComponent(args[1].slice('data:text/javascript,'.length));
    assert.ok(preload.includes('chunk-DECIQZZQ.js')); assert.ok(preload.includes('retry: { retries: 0 }'));
    assert.ok(!preload.includes(ACCOUNT)); assert.ok(!preload.includes('readFile'));
    assert.ok(args.includes('--non-interactive')); assert.ok(!args.includes('--paginate'));
  }
  assert.throws(() => d.metadataArguments('unreviewed'), { code: 'metadata_mismatch' });
  assert.equal(Object.keys(d.VERCEL_HASHES).length, 3);
});

for (const nativePreference of [undefined, '1', 'true'])
  test('metadata child forces JavaScript despite inherited native preference: ' + nativePreference, async () => {
    const code = await fs.readFile(path.join(__dirname, '../hosted-csrf-diagnostic.cjs'), 'utf8'); const calls = [];
    const inherited = Object.freeze({ SYNTHETIC_PRESERVED: 'unchanged', VERCEL_TELEMETRY_DISABLED: '0',
      NO_UPDATE_NOTIFIER: '0', ...(nativePreference === undefined ? {} : { VERCEL_CLI_USE_NATIVE_BINARY: nativePreference }) });
    const sandbox = { module: { exports: {} }, __dirname: d.DIRECTORY, Buffer,
      process: { env: inherited, execPath: 'synthetic-node' },
      /** Replace process execution while reusing inert dependencies; no CLI, credentials or transport are loaded. */
      require(name) {
        if (name === 'node:child_process') return {
          /** Capture the actual child boundary and return synthetic JSON without starting a process. */
          execFile(file, args, options, callback) { calls.push({ file, args, options }); callback(null, '{}'); },
        };
        if (name === './request-client-isolation.cjs') return fixture;
        if (name === './full-isolation-qualification.cjs') return qualified;
        if (name === './page-lifecycle-diagnostic.cjs') return require('../page-lifecycle-diagnostic.cjs');
        return require(name);
      },
    };
    vm.runInNewContext(code, sandbox);
    for (const kind of ['project', 'alias', 'deployment']) await sandbox.module.exports.nativeDependencies().metadata(kind);
    assert.equal(calls.length, 3);
    for (const { file, args, options } of calls) {
      assert.equal(file, 'synthetic-node'); assert.equal(args[0], '--import'); assert.equal(args[3], 'api');
      assert.ok(!args.includes('--disable-binary')); assert.ok(!args.includes('--paginate'));
      assert.equal(options.env.VERCEL_CLI_USE_NATIVE_BINARY, '0');
      assert.equal(options.env.VERCEL_TELEMETRY_DISABLED, '1'); assert.equal(options.env.NO_UPDATE_NOTIFIER, '1');
      assert.equal(options.env.SYNTHETIC_PRESERVED, 'unchanged'); assert.notEqual(options.env, inherited);
      assert.equal(options.windowsHide, true); assert.equal(options.timeout, 30000); assert.equal(options.maxBuffer, 2097152);
    }
    assert.equal(inherited.VERCEL_CLI_USE_NATIVE_BINARY, nativePreference);
    assert.equal(inherited.VERCEL_TELEMETRY_DISABLED, '0'); assert.equal(inherited.NO_UPDATE_NOTIFIER, '0');
  });

test('source manifest hashes all nine preparation files and preserves the six qualified source hashes', async () => {
  const sources = await d.sourceHashes(); const previous = await qualified.sourceHashes();
  for (const name of qualified.SOURCE_FILES) assert.equal(sources.files[name], previous.files[name]);
  assert.equal(Object.keys(sources.files).length, 9); assert.match(sources.set, /^[a-f0-9]{64}$/);
});

test('missing approval prerequisites stop before preflight, receipt or native I/O', async () => {
  for (const field of ['buildId', 'profile', 'approval', 'preparationHashes']) {
    const h = harness(); const input = plan(); delete input[field];
    await assert.rejects(d.runDiagnostic(input, ACCOUNT, h.deps)); assert.deepEqual(h.calls, []);
  }
});

test('cleanup claim without an observed closed owner cannot pass', async () => {
  const h = harness(); h.deps.closeBrowser = async () => true;
  const record = await d.runDiagnostic(plan(), ACCOUNT, h.deps);
  assert.equal(record.phase, 'stopped'); assert.equal(record.firstFailure.code, 'browser_cleanup');
  assert.equal(record.ownedBrowsersClosedNormally, false);
});

test('valueless SameSite produces a subcheck failure instead of throwing', () => {
  const result = response('/api/auth/csrf', NOW); const value = result.headers.find(v => v.name === 'Set-Cookie');
  value.value = value.value.replace('SameSite=Lax', 'SameSite');
  assert.equal(d.csrfChecks(result, cookies(result.token, NOW), NOW, NOW).cookieSameSite, false);
});
