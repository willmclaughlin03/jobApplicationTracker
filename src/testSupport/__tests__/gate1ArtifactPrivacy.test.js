/** Bounded diagnostic/privacy tests. All HTTP is mocked; no deployment or provider is contacted. */
const { EventEmitter } = require('node:events');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { LIMITS, TARGETS, ATTESTATIONS, ArtifactError, profileTemplate, parseProfile,
  approvalId, preparation, assetUrl, discoverScripts, scanText, inspectBody,
  createStore, runScan } = require('../../../scripts/gate1-artifact-privacy');

const PRIVATE = 'synthetic_private_comparison_ABCDEFG12345';
const BYPASS = 'synthetic_bypass_0123456789abcdef';
const CLI = path.resolve(__dirname, '../../../scripts/gate1-artifact-privacy.js');
const LAUNCHER = path.resolve(__dirname, '../../../scripts/run-gate1-artifact-privacy.ps1');
let nativeGuard;
beforeAll(() => { nativeGuard = jest.spyOn(https, 'request').mockImplementation(() => { throw new Error('Native network is forbidden'); }); });
afterEach(() => { expect(nativeGuard).not.toHaveBeenCalled(); jest.useRealTimers(); });
afterAll(() => { nativeGuard.mockRestore(); });

/** Construct a reviewed synthetic profile without writing files or using real credentials. */
function profile() {
  const value = profileTemplate();
  value.attestations = Object.fromEntries(ATTESTATIONS.map((key) => [key, true]));
  return value;
}

/** Match the exact reviewed comparison labels with transient test-only values. */
function envelope(selected = profile()) {
  return { profile: selected, approval: approvalId(selected), liveApproved: true,
    credentials: { production: BYPASS, preview: BYPASS },
    comparisons: selected.comparisons.map((ref) => ({ ...ref, value: PRIVATE })) };
}

/** Minimal Pages Router login HTML with correct deployment attribution and script references. */
function html(target, paths = ['/_next/static/chunks/app.js']) {
  return '<html><script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify({ page: '/login', buildId: target.nextBuildId }) + '</script>' +
    paths.map((file) => `<script src="${file}"></script>`).join('') + '</html>';
}

/** Successful fixed fixtures include an explicit map whose sources must never be fetched. */
function reply(url) {
  const target = TARGETS.find((entry) => entry.hostname === url.hostname);
  if (url.pathname === '/login') return { body: html(target), type: 'text/html' };
  if (url.pathname.endsWith('.map')) return { type: 'application/json', body: JSON.stringify({
    version: 3, sources: ['https://never-fetch.invalid/private.js'], mappings: '', sourcesContent: ['const n = 1;'] }) };
  return { type: 'application/javascript', body: 'const n = 1;\n//# sourceMappingURL=app.js.map' };
}

/** Model native request events, stream truncation and stalled phases; capture requests only in test memory. */
function transport(responder = reply) {
  const calls = [], requests = [], responses = [];
  const requestImpl = jest.fn((url, options, receive) => {
    const request = new EventEmitter(); request.destroy = jest.fn(); requests.push(request);
    request.end = jest.fn(() => {
      calls.push({ url, options });
      Promise.resolve().then(() => {
        const result = responder(url, calls.length);
        if (result.hang) return;
        if (result.error) { request.emit('error', new Error(PRIVATE)); return; }
        const response = new EventEmitter(); responses.push(response);
        response.destroy = jest.fn(); response.complete = result.complete !== false;
        response.statusCode = result.status ?? 200;
        response.rawHeaders = result.rawHeaders ?? ['content-type', result.type || 'text/html',
          ...Object.entries(result.headers || {}).flat()];
        receive(response);
        if (response.destroy.mock.calls.length || result.hangBody) return;
        if (result.closeEarly) { response.emit('close'); return; }
        for (const chunk of result.chunks || [Buffer.from(result.body || '')]) response.emit('data', chunk);
        if (result.aborted) response.emit('aborted'); else response.emit('end');
        response.emit('close');
      }).catch((error) => request.emit('error', error));
    });
    return request;
  });
  return { calls, requests, responses, requestImpl };
}

/** Supply only mocked I/O and a memory store; unit tests cannot reserve or execute a real trial. */
async function trial(responder = reply, input = envelope(), options = {}) {
  const wire = transport(responder), saved = [];
  const storeFactory = jest.fn(() => ({ save: (report) => { saved.push(report); return 'test-memory-report'; } }));
  const result = await runScan(input, { requestImpl: wire.requestImpl, storeFactory, now: () => 0,
    wall: () => Date.parse('2026-10-11T12:00:00Z'), ...options });
  return { ...result, ...wire, saved, storeFactory };
}

/** Assert fixed report fields never echo values, fetched source, unsafe URLs or transport messages. */
function expectPrivate(report) {
  const text = JSON.stringify(report);
  for (const value of [PRIVATE, BYPASS, 'never-fetch.invalid', 'https://attacker.invalid', 'RAW-PRIVATE-ERROR']) {
    expect(text).not.toContain(value);
  }
}

test('offline template requires attestations; reviewed approval binds target, scope, code and run ID', () => {
  expect(() => parseProfile(profileTemplate())).toThrow('profile');
  const p = profile(), prepared = preparation(p);
  expect(prepared).toMatchObject({ mode: 'prepare', liveApproved: false, appRequests: 0, providerRequests: 0 });
  const before = approvalId(p); p.runId = '1'.repeat(32); expect(approvalId(p)).not.toBe(before);
  p.targets[0].hostname = 'job-application-tracker-kappa-seven.vercel.app';
  expect(() => parseProfile(p)).toThrow('profile');
});

test('both deployments finish with matching before/after builds, hashes and conservative coverage', async () => {
  const result = await trial();
  expect(result.report).toMatchObject({ result: 'completed', appRequests: 8, htmlRequests: 4, assetRequests: 4,
    providerRequests: 0, configMutations: 0, validatedRequests: 8, unvalidatedAttempts: 0,
    artifactEvidence: 'selected_files_checked_no_findings', gate1Status: 'open',
    coverage: { allBrowserArtifacts: 'not_established', serverArtifacts: 'not_inspected', logs: 'not_inspected' } });
  expect(result.report.targets).toHaveLength(2);
  expect(result.report.targets.every((target) => target.buildBefore && target.buildAfter)).toBe(true);
  expect(result.report.files[0].sha256).toBe(createHash('sha256').update(html(TARGETS[0])).digest('hex'));
  expect(result.storeFactory).toHaveBeenCalledTimes(1); expect(result.saved).toHaveLength(1);
  expect(result.calls.every(({ url, options }) => TARGETS.some((target) => target.hostname === url.hostname) &&
    options.method === 'GET' && !url.search && options.headers['x-vercel-protection-bypass'] === BYPASS)).toBe(true);
  expect(result.calls.every(({ url }) => url.pathname === '/login' || url.pathname.startsWith('/_next/static/'))).toBe(true);
  expectPrivate(result.report);
});

test.each(['approval', 'liveApproved', 'credentials', 'comparisons'])('invalid %s stops before reservation/network', async (field) => {
  const input = envelope();
  if (field === 'approval') input.approval = '0'.repeat(64);
  if (field === 'liveApproved') input.liveApproved = false;
  if (field === 'credentials') input.credentials.production = BYPASS + '\r\nInjected: true';
  if (field === 'comparisons') input.comparisons.pop();
  const result = await trial(reply, input);
  expect(result.report.result).toBe('stopped'); expect(result.calls).toHaveLength(0);
  expect(result.storeFactory).not.toHaveBeenCalled(); expectPrivate(result.report);
});

test('wrong build and a later build change stop without accepting the target', async () => {
  for (const failingRequest of [1, 4]) {
    const result = await trial((url, count) => count === failingRequest ?
      { type: 'text/html', body: html({ ...TARGETS[0], nextBuildId: 'different' }) } : reply(url));
    expect(result.report.failure).toBe('build_mismatch'); expect(result.calls).toHaveLength(failingRequest);
    expect(result.report.artifactEvidence).toBe('unqualified');
  }
});

test('changed script references under the same build ID remain non-passing', async () => {
  const result = await trial((url, count) => count === 4 ?
    { type: 'text/html', body: html(TARGETS[0], ['/_next/static/chunks/other.js']) } : reply(url));
  expect(result.report.failure).toBe('reference_changed'); expect(result.calls).toHaveLength(4);
});

test.each([
  'https://attacker.invalid/private.js', '//attacker.invalid/private.js', '/api/auth/session',
  '/_next/static/../private.js', '/_next/static/%2e%2e/private.js', '/_next/static/app.js?secret=value',
  '/_next/static/app.js#fragment', '/_next/static/app.js&amp;x=1',
  'https://user:pass@job-application-tracker-h4ly6ufvr-track-the-app.vercel.app/_next/static/x.js',
  'http://job-application-tracker-h4ly6ufvr-track-the-app.vercel.app/_next/static/x.js',
  '/_next/static\\x.js', 'data:text/javascript,test',
])('unsafe reference is rejected before a credential-bearing asset request: %s', async (reference) => {
  expect(() => assetUrl(reference, `https://${TARGETS[0].hostname}/login`, 'script', TARGETS[0])).toThrow('unsafe_reference');
  const result = await trial(() => ({ type: 'text/html', body: html(TARGETS[0], [reference]) }));
  expect(result.report.failure).toBe('unsafe_reference'); expect(result.calls).toHaveLength(1); expectPrivate(result.report);
});

test('commented scripts are excluded, duplicate references deduplicated, modulepreloads discovered', () => {
  const body = html(TARGETS[0]) + '<!-- <script src="https://attacker.invalid/private.js"></script> -->' +
    '<link rel="preload" as="script" href="/_next/static/chunks/app.js">' +
    '<link rel="modulepreload" href="/_next/static/chunks/extra.js">';
  expect(discoverScripts(body, TARGETS[0])).toHaveLength(2);
  expect(() => discoverScripts('<script src="a" src="b"></script>', TARGETS[0])).toThrow('html_contract');
});

test('no scripts is incomplete; no advertised maps means not discovered, never absent or passed', async () => {
  const empty = await trial(() => ({ type: 'text/html', body: html(TARGETS[0], []) }));
  expect(empty.report.failure).toBe('no_scripts');
  const result = await trial((url) => url.pathname === '/login' ? reply(url) :
    { type: 'application/javascript', body: 'const a = 1;' });
  expect(result.report.result).toBe('completed'); expect(result.calls).toHaveLength(6);
  expect(result.report.targets.every((target) => target.sourceMaps === 'not_discovered')).toBe(true);
});

test.each(['raw', 'base64', 'base64url', 'uri', 'json'])('known comparison detection covers %s without retaining values', (representation) => {
  const secret = 'synthetic+private/value"with space';
  const variants = { raw: secret, base64: Buffer.from(secret).toString('base64'),
    base64url: Buffer.from(secret).toString('base64url'), uri: encodeURIComponent(secret), json: JSON.stringify(secret) };
  expect(scanText(variants[representation], [{ label: 'hmac_active_key', value: secret }])
    .comparisonLabels).toEqual(['hmac_active_key']);
});

test('secret in HTML/script/map stops and emits only a fixed finding label', async () => {
  for (const phase of ['html', 'script', 'map']) {
    const result = await trial((url) => {
      const base = reply(url);
      if (phase === 'html' && url.pathname === '/login') base.body += PRIVATE;
      if (phase === 'script' && url.pathname.endsWith('.js')) base.body += PRIVATE;
      if (phase === 'map' && url.pathname.endsWith('.map')) base.body = JSON.stringify({
        version: 3, mappings: '', sources: ['file'], sourcesContent: [PRIVATE] });
      return base;
    });
    expect(result.report.failure).toBe('sensitive_content'); expectPrivate(result.report);
    expect(result.report.artifactEvidence).toBe('findings_require_private_review');
    expect(result.report.files.at(-1).comparisonLabels).toContain('production:hmac_active_key');
  }
});

test('Production comparison values are also checked against Preview output', async () => {
  const input = envelope();
  input.comparisons.filter((ref) => ref.environment === 'preview').forEach((ref) => { ref.value = 'different_synthetic_preview_key'; });
  const result = await trial((url) => ({ ...reply(url),
    body: reply(url).body + (url.hostname === TARGETS[1].hostname ? PRIVATE : '') }), input);
  expect(result.report.failure).toBe('sensitive_content');
  expect(result.report.files.at(-1)).toMatchObject({ environment: 'preview', comparisonLabels: expect.arrayContaining(['production:hmac_active_key']) });
  expectPrivate(result.report);
});

test('JSON decoding finds mixed escaped secrets in map sourcesContent without fetching source paths', () => {
  const escaped = PRIVATE.replace('private', '\\u0070rivate');
  const map = '{"version":3,"mappings":"","sources":["private"],"sourcesContent":["' + escaped + '"]}';
  expect(inspectBody(map, 'map', [{ label: 'redis_token', value: PRIVATE }]).comparisonLabels).toContain('redis_token');
});

test.each(['-----BEGIN PRIVATE KEY-----', 'sk_live_0123456789abcdefghijkl', 'rediss://account:password@host'])('patterns raise a sanitized finding: %s', (value) => {
  expect(scanText(value, []).patterns).toHaveLength(1);
});

test('bypass echoes and malicious map links cannot leak credentials to another origin', async () => {
  const echo = await trial((url) => ({ ...reply(url), body: reply(url).body + BYPASS }));
  expect(echo.report.failure).toBe('sensitive_content'); expectPrivate(echo.report);
  const map = await trial((url) => url.pathname.endsWith('.js') ?
    { type: 'application/javascript', body: '//# sourceMappingURL=https://attacker.invalid/private.map' } : reply(url));
  expect(map.report.failure).toBe('unsafe_reference'); expect(map.calls).toHaveLength(2); expectPrivate(map.report);
});

test.each([301, 302, 401, 403, 404, 429, 500])('HTTP %s is counted once, never followed or retried', async (status) => {
  const result = await trial(() => ({ status, body: PRIVATE, headers: { location: 'https://attacker.invalid/' } }));
  expect(result.report.failure).toBe('http_status'); expect(result.report.appRequests).toBe(1);
  expect(result.report.receipts[0].status).toBe(status); expectPrivate(result.report);
});

test.each([
  ['headers', { rawHeaders: ['Content-Type', 'text/html', 'content-type', 'text/html'] }],
  ['headers', { headers: { 'x-ignored': 'x'.repeat(LIMITS.headerBytes) } }],
  ['encoding', { headers: { 'content-encoding': 'gzip' } }],
  ['content_type', { type: 'application/json' }],
  ['body_size', { headers: { 'content-length': String(LIMITS.htmlBytes + 1) } }],
  ['body_size', { chunks: [Buffer.alloc(LIMITS.htmlBytes + 1)] }],
  ['incomplete_body', { complete: false }], ['incomplete_body', { closeEarly: true }],
  ['incomplete_body', { aborted: true }], ['incomplete_body', { headers: { 'content-length': '1' } }],
  ['encoding', { chunks: [Buffer.from([0xc3, 0x28])] }], ['transport', { error: true }],
])('%s boundary destroys I/O and leaves no partial pass', async (reason, changes) => {
  const result = await trial((url) => ({ ...reply(url), ...changes }));
  expect(result.report.failure).toBe(reason); expect(result.calls).toHaveLength(1);
  expect(result.requests[0].destroy).toHaveBeenCalled(); expectPrivate(result.report);
});

test('invalid source map schema and unavailable linked maps are incomplete', async () => {
  for (const changes of [{ body: '{bad' }, { body: '{"version":3,"sections":[]}' }, { status: 404 }]) {
    const result = await trial((url) => ({ ...reply(url), ...(url.pathname.endsWith('.map') ? changes : {}) }));
    expect(result.report.result).toBe('stopped'); expect(result.calls).toHaveLength(3);
    expect(result.report.artifactEvidence).toBe('unqualified');
  }
});

test('asset budget includes map requests and stops before a sixty-fifth asset dispatch', async () => {
  const scripts = Array.from({ length: 65 }, (_, index) => `/_next/static/chunks/${index}.js`);
  const result = await trial((url) => url.pathname === '/login' ? { type: 'text/html', body: html(TARGETS[0], scripts) }
    : { type: 'application/javascript', body: 'const clean = 1;' });
  expect(result.report.failure).toBe('request_limit'); expect(result.report.assetRequests).toBe(64);
  expect(result.report.appRequests).toBe(65); expect(result.report.result).toBe('stopped');
});

test('aggregate byte limit stops in a streaming body without fetching more assets', async () => {
  const scripts = Array.from({ length: 12 }, (_, index) => `/_next/static/chunks/${index}.js`);
  const result = await trial((url) => url.pathname === '/login' ? { type: 'text/html', body: html(TARGETS[0], scripts) }
    : { type: 'application/javascript', chunks: [Buffer.alloc(LIMITS.assetBytes, 32)] });
  expect(result.report.failure).toBe('total_bytes'); expect(result.report.assetRequests).toBe(10);
});

test.each(['headers', 'body'])('ten-second deadline also bounds stalled %s', async (phase) => {
  jest.useFakeTimers();
  const pending = trial((url) => phase === 'headers' ? { hang: true } : { ...reply(url), hangBody: true });
  await jest.advanceTimersByTimeAsync(LIMITS.requestMs);
  const result = await pending; expect(result.report.failure).toBe('request_timeout');
  expect(result.calls).toHaveLength(1);
});

test('overall deadline includes parsing and cancellation never triggers another attempt', async () => {
  let time = 0;
  const result = await trial((url) => { time = LIMITS.overallMs; return reply(url); }, envelope(), { now: () => time });
  expect(result.report.failure).toBe('overall_deadline'); expect(result.calls).toHaveLength(1);
  const controller = new AbortController(); controller.abort();
  const cancelled = await trial(reply, envelope(), { signal: controller.signal });
  expect(cancelled.report.failure).toBe('cancelled'); expect(cancelled.calls).toHaveLength(0);
});

/** Reject metadata substrings and serialized field collisions before consuming approval or dispatching HTTP. */
test.each([
  'schemaVersion', 'gate1Status', 'approvalId', 'appRequests', 'report_write', 'port_wri',
  '"mode":"live"', '"result":"stopped"',
  '"appRequests":0', '"appRequests":1', '"appRequests":8', '"appRequests":68', '"appRequests": 68',
])('comparison colliding with required fallback metadata is rejected: %s', async (secret) => {
  const input = envelope();
  input.comparisons[0].value = secret;
  // This independent collision forces the old report into its unsafe fallback, including report_write.
  input.comparisons[1].value = 'not_inspected';
  const wire = transport(), save = jest.fn();
  const storeFactory = jest.fn(() => ({ save }));
  await expect(runScan(input, { requestImpl: wire.requestImpl, storeFactory })).rejects.toMatchObject({ code: 'input' });
  expect(storeFactory).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  expect(wire.requestImpl).not.toHaveBeenCalled();
});

/** Nulling a colliding approval ID must not introduce a different private value into the fallback JSON. */
test('comparison colliding with redacted approval metadata is rejected before reservation', async () => {
  const input = envelope();
  input.comparisons[0].value = input.approval;
  input.comparisons[1].value = '"approvalId":null';
  const wire = transport(), storeFactory = jest.fn();
  await expect(runScan(input, { requestImpl: wire.requestImpl, storeFactory })).rejects.toMatchObject({ code: 'input' });
  expect(storeFactory).not.toHaveBeenCalled(); expect(wire.requestImpl).not.toHaveBeenCalled();
});

/** The saved report uses indented JSON, so collisions absent from compact JSON still need a safe fallback. */
test('final echo guard also checks the serialized report saved by the store', async () => {
  const input = envelope();
  const secret = '"sha256": "' + createHash('sha256').update(html(TARGETS[0])).digest('hex');
  input.comparisons[0].value = secret;
  const result = await trial(reply, input);
  expect(result.report).toEqual({ schemaVersion: 1, mode: 'live', result: 'stopped', gate1Status: 'open',
    approvalId: input.approval, appRequests: 8, failure: 'report_write' });
  expect(result.saved).toHaveLength(1); expect(result.saved[0]).toBe(result.report);
  expect(result.reportPath).toBe('test-memory-report');
  expect(JSON.stringify(result.report)).not.toContain(secret);
  expect(JSON.stringify(result.saved[0], null, 2)).not.toContain(secret);
});

/** Exercise final metadata collisions after clean mocked HTTP; persist only the stopped outcome. */
test.each(['comparison', 'credential'])('final %s echo saves and returns a minimal failure report', async (source) => {
  const input = envelope();
  const secret = createHash('sha256').update(html(TARGETS[0])).digest('hex');
  if (source === 'comparison') input.comparisons[0].value = secret;
  else input.credentials.production = secret;
  const result = await trial(reply, input);
  expect(result.report).toEqual({ schemaVersion: 1, mode: 'live', result: 'stopped', gate1Status: 'open',
    approvalId: input.approval, appRequests: 8, failure: 'report_write' });
  expect(result.storeFactory).toHaveBeenCalledTimes(1); expect(result.saved).toHaveLength(1);
  expect(result.saved[0]).toBe(result.report); expect(result.reportPath).toBe('test-memory-report');
  expect(result.calls).toHaveLength(8);
  expect(JSON.stringify(result.report)).not.toContain(secret); expectPrivate(result.report);
});

/** Approval metadata can itself overlap private inputs; neither saved nor returned reports may echo it. */
test.each(['comparison', 'credential'])('fallback omits an approval ID containing a private %s', async (source) => {
  const input = envelope();
  const secret = input.approval.slice(0, 16);
  if (source === 'comparison') input.comparisons[0].value = secret;
  else input.credentials.production = secret;
  const result = await trial(reply, input);
  expect(result.report).toEqual({ schemaVersion: 1, mode: 'live', result: 'stopped', gate1Status: 'open',
    approvalId: null, appRequests: 8, failure: 'report_write' });
  expect(result.saved).toHaveLength(1); expect(result.saved[0]).toBe(result.report);
  expect(result.reportPath).toBe('test-memory-report');
  expect(JSON.stringify(result.report)).not.toContain(secret); expectPrivate(result.report);
});

/** Cancellation still consumes a reservation; a metadata collision must leave a saved zero-request outcome. */
test('final echo guard saves a stopped report after cancellation', async () => {
  const input = envelope(); input.comparisons[0].value = 'not_inspected';
  const controller = new AbortController(); controller.abort();
  const result = await trial(reply, input, { signal: controller.signal });
  expect(result.report).toEqual({ schemaVersion: 1, mode: 'live', result: 'stopped', gate1Status: 'open',
    approvalId: input.approval, appRequests: 0, failure: 'report_write' });
  expect(result.saved).toHaveLength(1); expect(result.saved[0]).toBe(result.report);
  expect(result.reportPath).toBe('test-memory-report'); expect(result.calls).toHaveLength(0);
  expect(JSON.stringify(result.report)).not.toContain(input.comparisons[0].value);
});

test('reservation reuse rejects before network; exclusive evidence writes retain original bytes', async () => {
  const writes = [];
  const mkdir = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
  const write = jest.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
    if (writes.some((entry) => entry.file === file)) throw new Error(PRIVATE);
    writes.push({ file, data, options });
  });
  try {
    const store = createStore('f'.repeat(64));
    expect(() => createStore('f'.repeat(64))).toThrow('reservation');
    store.save({ result: 'stopped' }); expect(() => store.save({ result: 'completed' })).toThrow('report_write');
    expect(writes.every((entry) => entry.options.flag === 'wx')).toBe(true);
    expect(writes[1].data).toContain('stopped');
  } finally { write.mockRestore(); mkdir.mockRestore(); }
  const result = await trial(reply, envelope(), { storeFactory: () => { throw new ArtifactError('reservation'); } });
  expect(result.report.failure).toBe('reservation'); expect(result.calls).toHaveLength(0);
});

test('offline CLI never needs credentials and rejects invalid arguments without echo', () => {
  const result = spawnSync(process.execPath, [CLI, '--template'], { encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout).attestations.sourceCodeReviewed).toBe(false);
  const invalid = spawnSync(process.execPath, [CLI, PRIVATE], { encoding: 'utf8', timeout: 10000 });
  expect(invalid.status).toBe(1); expect(invalid.stdout + invalid.stderr).not.toContain(PRIVATE);
});

test('PowerShell launcher parses offline and preparation does not prompt or invoke live mode', () => {
  if (process.platform !== 'win32') return;
  const quoted = LAUNCHER.replace(/'/g, "''");
  const syntax = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseFile('${quoted}',[ref]$tokens,[ref]$errors); if($errors.Count){exit 1}`],
  { encoding: 'utf8', timeout: 10000 });
  expect(syntax.status).toBe(0);
  const offline = spawnSync('powershell.exe', ['-NoProfile', '-File', LAUNCHER, '-Template'], { encoding: 'utf8', timeout: 15000 });
  expect(offline.status).toBe(0); expect(JSON.parse(offline.stdout).scope).toBe('referenced_login_browser_artifacts_only');
  const review = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `. '${quoted}'; $result = Invoke-Gate1ArtifactNode '--prepare' ([Console]::In.ReadToEnd()); Write-Output $result.Json; exit $result.ExitCode`],
  { input: JSON.stringify(profile()), encoding: 'utf8', timeout: 15000 });
  expect(review.status).toBe(0);
  expect(JSON.parse(review.stdout)).toMatchObject({ mode: 'prepare', liveApproved: false, appRequests: 0, providerRequests: 0 });
});

/** A harmless invalid executable in the child cwd must not override Node, even with session command shadows. */
test.each(['none', 'alias', 'function'])('PowerShell resolves the Node application with a %s shadow', (shadow) => {
  if (process.platform !== 'win32') return;
  const root = path.resolve(__dirname, '../../../.tmp');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'artifact-node-test-'));
  const decoy = path.join(directory, 'node.exe');
  const quoted = LAUNCHER.replace(/'/g, "''");
  const setup = shadow === 'alias' ? 'Set-Alias -Name node.exe -Value Write-Output' : shadow === 'function' ?
    "<# Fail if command resolution selects this session function instead of the application. #>\nfunction node.exe { throw 'Unexpected function invocation.' }" : '';
  try {
    fs.writeFileSync(decoy, 'test-only invalid executable', { flag: 'wx' });
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `. '${quoted}'; ${setup}\n$result = Invoke-Gate1ArtifactNode '--template'; Write-Output $result.Json; exit $result.ExitCode`],
    { cwd: directory, encoding: 'utf8', timeout: 15000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ scope: 'referenced_login_browser_artifacts_only',
      attestations: { sourceCodeReviewed: false } });
  } finally {
    if (fs.existsSync(decoy)) fs.unlinkSync(decoy);
    fs.rmdirSync(directory);
  }
});

/** Missing applications and an injected relative resolution must fail before any child Process is allocated. */
test.each(['missing', 'relative'])('PowerShell rejects a %s Node application before starting a child', (resolution) => {
  if (process.platform !== 'win32') return;
  const quoted = LAUNCHER.replace(/'/g, "''");
  const setup = resolution === 'missing' ? "$env:PATH = ''" : `
    <# Model a bad resolver result; the launcher must reject its non-absolute Source. #>
    function Get-Command { param($Name, $CommandType, $ErrorAction) [pscustomobject]@{ Source = 'node.exe' } }
  `;
  const script = `
    . '${quoted}'
    ${setup}
    $script:processCreated = $false
    <# Observe process allocation without allowing this negative test to start a child. #>
    function New-Object {
      param($TypeName)
      if ($TypeName -eq 'Diagnostics.Process') { $script:processCreated = $true; throw 'Unexpected child process.' }
      Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName
    }
    try { $null = Invoke-Gate1ArtifactNode '--template'; exit 2 }
    catch {
      @{ processCreated = $script:processCreated; errorType = $_.Exception.GetType().Name; message = $_.Exception.Message } |
        ConvertTo-Json -Compress
      exit 0
    }
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  const failure = JSON.parse(result.stdout);
  expect(failure.processCreated).toBe(false);
  if (resolution === 'missing') expect(failure.errorType).toBe('CommandNotFoundException');
  else expect(failure.message).toBe('Node runtime must resolve to an absolute path.');
});
