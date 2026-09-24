/** Offline access-boundary/privacy tests. Every live-mode transport is mocked or denied. */
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LIMITS, TARGET, profileTemplate, parseProfile, approvalId, preparation,
  runAccess } = require('../../../scripts/gate1-provider-access');

const START = Date.parse('2026-09-24T12:00:00.000Z');
const TOKEN = 'synthetic_provider_access_token_for_tests';
const PRIVATE = 'private-provider-error-sentinel';
const ADDRESS = '192.0.2.19';
const CLI = path.resolve(__dirname, '../../../scripts/gate1-provider-access.js');
const LAUNCHER = path.resolve(__dirname, '../../../scripts/run-gate1-provider-access.ps1');
let nativeGuard;

beforeAll(() => { nativeGuard = jest.spyOn(https, 'request').mockImplementation(() => { throw new Error('Native HTTP forbidden in tests'); }); });
afterEach(() => { expect(nativeGuard).not.toHaveBeenCalled(); });
afterAll(() => { nativeGuard.mockRestore(); });

/** Build a reviewed synthetic profile; time is fixed for unit tests and current for CLI fixtures. */
function profile(time = START) {
  const value = profileTemplate(time);
  value.attestations = { sourceCodeReviewed: true, credentialLoggingReviewed: true };
  return value;
}

/** Provide a valid empty query result; this fixture says nothing about actual provider data. */
function emptyReply() { return { headers: { 'content-type': 'application/json' }, body: '{"summary":[]}' }; }

/**
 * Mock the native request/response event boundary, including incomplete streams,
 * stalled DNS/body and raw errors. Captured credentials never leave test memory.
 */
function transport(responder = emptyReply) {
  const calls = [], requests = [], responses = [];
  const requestImpl = jest.fn((options, receive) => {
    const request = new EventEmitter();
    request.destroy = jest.fn();
    requests.push(request);
    request.end = jest.fn((body) => {
      calls.push({ options, body });
      Promise.resolve().then(() => {
        const result = responder(options, body);
        if (result.hang) return;
        if (result.error) { request.emit('error', new Error(PRIVATE)); return; }
        const response = new EventEmitter();
        responses.push(response);
        response.destroy = jest.fn();
        response.complete = result.complete !== false;
        response.statusCode = result.status ?? 200;
        response.rawHeaders = result.rawHeaders ?? Object.entries(result.headers || {}).flat();
        receive(response);
        if (response.destroy.mock.calls.length || result.hangBody) return;
        if (result.earlyClose) { response.emit('close'); return; }
        for (const chunk of result.chunks || [Buffer.from(result.body || '')]) response.emit('data', chunk);
        if (result.aborted) response.emit('aborted');
        else response.emit('end');
        response.emit('close');
      }).catch((error) => request.emit('error', error));
    });
    return request;
  });
  return { requestImpl, calls, requests, responses };
}

/** Run one in-memory fixture with explicit dependency seams; no native network is possible. */
async function trial(responder = emptyReply, changes = {}) {
  const wire = transport(responder), selected = profile();
  const input = { profile: selected, approval: approvalId(selected),
    credentials: { providerToken: TOKEN }, ...changes.input };
  const report = await runAccess(input, { requestImpl: wire.requestImpl, now: () => 0,
    wall: () => START, ...changes.deps });
  return { report, ...wire };
}

/** Assert the report cannot contain transient provider values, credentials, headers or synthetic markers. */
function expectPrivate(report) {
  const encoded = JSON.stringify(report);
  for (const forbidden of [TOKEN, PRIVATE, ADDRESS, 'gate1-source-', 'Bearer ', 'rawMessage']) {
    expect(encoded).not.toContain(forbidden);
  }
  expect(Buffer.byteLength(encoded)).toBeLessThan(LIMITS.reportBytes);
  expect(report).toMatchObject({ appRequests: 0, gate1Status: 'open',
    sourceAgreement: 'not_evaluated', correlation: 'unqualified', completeness: 'unqualified' });
}

describe('provider-only scope and approval', () => {
  it('prepares offline and generates an unapproved fixed-minute template', () => {
    expect(preparation()).toMatchObject({ mode: 'prepare', liveApproved: false,
      appRequests: 0, providerRequests: 0, limits: { maxAppRequests: 0, maxProviderRequests: 1 } });
    const template = profileTemplate(START + 123);
    expect(template.queryWindow).toEqual({ start: '2026-09-24T11:59:00.000Z', end: '2026-09-24T12:00:00.000Z' });
    expect(() => parseProfile(template)).toThrow('profile');
    expect(preparation(profile(), START)).toMatchObject({ liveApproved: false, approvalId: approvalId(profile()) });
  });

  it('sends exactly one provider POST with pinned owner/project and the original query shape', async () => {
    const { report, calls } = await trial();
    expect(calls).toHaveLength(1);
    const { options, body } = calls[0];
    expect(options).toMatchObject({ protocol: 'https:', port: 443, hostname: 'api.vercel.com',
      path: `/metrics/v1?teamId=${TARGET.teamId}`, method: 'POST', agent: false, rejectUnauthorized: true });
    expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(options.headers['Content-Length']).toBe(Buffer.byteLength(body));
    expect(Object.keys(options.headers).some((key) => /cookie|bypass|forwarded|real-ip/i.test(key))).toBe(false);
    const query = JSON.parse(body);
    expect(query).toEqual({ scope: { ownerId: TARGET.teamId, projectIds: [TARGET.projectId] },
      timeRange: profile().queryWindow, metrics: { value: { metric: 'vercel.firewall_action.count', aggregation: 'count' } },
      outputs: ['value'], groupBy: ['clientUserAgent', 'requestHostname', 'requestPath', 'clientIp'],
      filter: expect.stringMatching(/^\(clientUserAgent:"gate1-source-[a-f0-9]{32}"\) AND /),
      rowLimit: 2, orderBy: [{ metric: 'value', direction: 'desc' }] });
    expect(query.filter).toContain(`(requestHostname:"${TARGET.hostname}") AND (requestPath:"/api/auth/session")`);
    expect(report).toMatchObject({ result: 'completed', mode: 'fixture', hostedEvidence: 'not_executed',
      providerRequests: 1, httpStatus: 200, response: { queryAccepted: true, rows: 'empty' }, failure: null });
    expectPrivate(report);
  });

  it.each([
    { projectId: 'prj_other' }, { teamId: 'team_other' }, { hostname: 'other.example' },
    { endpoint: 'https://other.example' }, { attestations: { sourceCodeReviewed: false, credentialLoggingReviewed: true } },
    { deploymentId: 'dpl_Unexpected' },
  ])('rejects changed scope or unreviewed profiles before dispatch (%#)', async (change) => {
    const { report, calls } = await trial(emptyReply, { input: { profile: { ...profile(), ...change } } });
    expect(calls).toHaveLength(0); expect(report.result).toBe('stopped'); expectPrivate(report);
  });

  it.each([
    { approval: '0'.repeat(64) }, { credentials: { providerToken: 'short' } },
    { credentials: { providerToken: TOKEN, probeSecret: 'a'.repeat(64) } },
    { credentials: { providerToken: `${TOKEN}\n` } }, { extra: PRIVATE },
  ])('rejects invalid or mismatched live envelopes before dispatch (%#)', async (input) => {
    const { report, calls } = await trial(emptyReply, { input });
    expect(calls).toHaveLength(0); expect(report.result).toBe('stopped'); expectPrivate(report);
  });

  it.each([-60001, -59999, 0])('rejects a query window of %s milliseconds', (offset) => {
    const value = profile(); value.queryWindow.start = new Date(START + offset).toISOString();
    expect(() => parseProfile(value)).toThrow('profile');
  });

  it('refuses a shifted minute even if duration remains correct', () => {
    const value = profile();
    value.queryWindow.start = new Date(START - 120000).toISOString();
    value.queryWindow.end = new Date(START - 60000).toISOString();
    expect(() => parseProfile(value)).toThrow('profile');
  });

  it.each([-LIMITS.profileAgeMs - 1, 1])('rejects approved stale/future profiles (%s ms)', async (offset) => {
    const value = profile(START + offset);
    expect(() => preparation(value, START)).toThrow('profile');
    const { report, calls } = await trial(emptyReply, { input: { profile: value, approval: approvalId(value) } });
    expect(report.failure).toBe('profile'); expect(calls).toHaveLength(0);
  });

  it.each(['gate1-provider-access.js', 'run-gate1-provider-access.ps1', 'gate1-source-discovery.js',
    'gate1-source-waf.js', 'gate1-host-protection.js'])('invalidates approval after %s changes in memory', async (name) => {
    const value = profile(), original = approvalId(value), read = fs.readFileSync;
    const changed = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      const bytes = read(file, ...args);
      return typeof file === 'string' && path.basename(file) === name ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes;
    });
    try {
      expect(approvalId(value)).not.toBe(original);
      const { report, calls } = await trial(emptyReply, { input: { approval: original } });
      expect(report.failure).toBe('approval'); expect(calls).toHaveLength(0);
    } finally { changed.mockRestore(); }
  });

  it('uses a fresh unretained marker for each separately invoked fixture', async () => {
    const first = await trial(), second = await trial();
    expect(first.calls[0].body).not.toBe(second.calls[0].body);
    expectPrivate(first.report); expectPrivate(second.report);
  });
});

describe('provider response classification and privacy', () => {
  it.each(['forbidden', 'FORBIDDEN', 'unauthorized', 'UNAUTHORIZED', 'bad_request',
    'BAD_REQUEST', 'payment_required', 'PAYMENT_REQUIRED', 'rate_limited', 'RATE_LIMITED'])(
    'retains only the exact allowlisted code %s from a failed response', async (code) => {
      const { report, calls } = await trial(() => ({ status: 403, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { code, message: `${PRIVATE} ${TOKEN} ${ADDRESS}`, metadata: PRIVATE } }) }));
      expect(report).toMatchObject({ result: 'stopped', failure: 'provider_status', httpStatus: 403,
        response: { jsonValid: true, errorObjectPresent: true, errorCodePresent: true,
          errorMessagePresent: true, errorCode: code.toLowerCase(), queryAccepted: false } });
      expect(calls).toHaveLength(1); expectPrivate(report);
    });

  it.each([PRIVATE, `forbidden ${PRIVATE}`, ' Forbidden', 'Forbidden', { value: PRIVATE }, null, 403])(
    'classifies unknown codes without echoing arbitrary values (%#)', async (code) => {
      const { report } = await trial(() => ({ status: 403, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { code, message: PRIVATE } }) }));
      expect(report.response.errorCode).toBe('unrecognized'); expectPrivate(report);
    });

  it('records an error object without fabricating an absent code', async () => {
    const { report } = await trial(() => ({ status: 403, headers: { 'content-type': 'application/json' },
      body: '{"error":{"message":"private-provider-error-sentinel"}}' }));
    expect(report.response).toMatchObject({ errorObjectPresent: true, errorCodePresent: false, errorCode: null });
    expectPrivate(report);
  });

  it.each([400, 401, 402, 403, 404, 429, 500, 503])('never retries or changes scope after HTTP %s', async (status) => {
    const { report, calls } = await trial(() => ({ status, headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(report).toMatchObject({ result: 'stopped', httpStatus: status, providerRequests: 1, failure: 'provider_status' });
    expect(calls).toHaveLength(1); expectPrivate(report);
  });

  it.each([
    ['html', 'text/html', `<h1>${PRIVATE}</h1>`, false],
    ['invalid JSON', 'application/json', PRIVATE, false],
    ['non-object JSON', 'application/json', 'null', true],
  ])('records the response shape for a 403 with %s', async (_name, type, body, jsonValid) => {
    const { report } = await trial(() => ({ status: 403, headers: { 'content-type': type }, body }));
    expect(report.response).toMatchObject({ jsonValid, queryAccepted: false, errorObjectPresent: false });
    expectPrivate(report);
  });

  it.each(['{}', '{"summary":[],"unexpected":"private-provider-error-sentinel"}',
    '{"error":{"code":"forbidden","message":"private-provider-error-sentinel"}}', 'null', '[]', PRIVATE])(
    'rejects HTTP 200 without the qualified metrics shape (%#)', async (body) => {
      const { report, calls } = await trial(() => ({ headers: { 'content-type': 'application/json' }, body }));
      expect(report).toMatchObject({ result: 'stopped', failure: 'provider_schema', response: { queryAccepted: false } });
      expect(calls).toHaveLength(1); expectPrivate(report);
    });

  it('requires the JSON media type even for a syntactically valid success body', async () => {
    const { report } = await trial(() => ({ headers: { 'content-type': 'text/plain' }, body: '{"summary":[]}' }));
    expect(report).toMatchObject({ failure: 'provider_schema', response: { jsonValid: true, queryAccepted: false } });
  });

  it.each(['sampled', 'truncated'])('stops on an explicitly %s result', async (field) => {
    const { report, calls } = await trial(() => ({ ...emptyReply(), body: JSON.stringify({ summary: [], [field]: true }) }));
    expect(report).toMatchObject({ result: 'stopped', failure: 'provider_ambiguous' });
    expect(calls).toHaveLength(1); expectPrivate(report);
  });

  it('stops on unexpected rows for the unused marker without retaining the source', async () => {
    const { report, calls } = await trial((_options, body) => ({ ...emptyReply(), body: JSON.stringify({ summary: [{
      dimensions: { clientUserAgent: JSON.parse(body).filter.match(/gate1-source-[a-f0-9]{32}/)[0],
        requestHostname: TARGET.hostname, requestPath: '/api/auth/session', clientIp: ADDRESS }, values: { value: 1 },
    }] }) }));
    expect(report).toMatchObject({ result: 'stopped', failure: 'unexpected_rows',
      response: { queryAccepted: true, rows: 'unexpected' } });
    expect(calls).toHaveLength(1); expectPrivate(report);
  });
});

describe('bounded transport, cancellation and deadlines', () => {
  it.each([301, 302, 307, 308])('captures HTTP %s but never follows its Location', async (status) => {
    const { report, calls } = await trial(() => ({ status, headers: { location: `https://${PRIVATE}/` } }));
    expect(report).toMatchObject({ failure: 'redirect', httpStatus: status, providerRequests: 1 });
    expect(calls).toHaveLength(1); expectPrivate(report);
  });

  it.each([
    ['response_headers', { rawHeaders: ['Content-Type', 'application/json', 'content-type', 'application/json'] }],
    ['response_headers', { rawHeaders: ['X-Untrusted', PRIVATE.repeat(2000)] }],
    ['response_encoding', { headers: { 'content-encoding': 'gzip' } }],
    ['cookie_contract', { headers: { 'set-cookie': PRIVATE } }],
    ['response_size', { headers: { 'content-length': String(LIMITS.providerBytes + 1) } }],
    ['response_size', { chunks: [Buffer.alloc(LIMITS.providerBytes), Buffer.from(PRIVATE)] }],
    ['response_incomplete', { complete: false, body: PRIVATE }],
    ['response_incomplete', { earlyClose: true }],
    ['response_incomplete', { aborted: true }],
    ['response_incomplete', { headers: { 'content-length': '3' }, body: 'ok' }],
    ['transport', { error: true }],
  ])('stops on %s with one attempt and closes owned streams (%#)', async (failure, reply) => {
    const { report, calls, requests, responses } = await trial(() => reply);
    expect(report).toMatchObject({ result: 'stopped', failure, providerRequests: 1 });
    expect(calls).toHaveLength(1); expect(requests[0].destroy).toHaveBeenCalled();
    if (responses.length) expect(responses[0].destroy).toHaveBeenCalled();
    expectPrivate(report);
  });

  it.each(['hang', 'hangBody'])('expires the absolute request deadline during %s', async (kind) => {
    jest.useFakeTimers();
    try {
      const pending = trial(() => ({ [kind]: true }));
      await jest.advanceTimersByTimeAsync(LIMITS.requestMs);
      const { report, calls, requests } = await pending;
      expect(report.failure).toBe('deadline'); expect(calls).toHaveLength(1);
      expect(requests[0].destroy).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  it('rejects an already cancelled run before dispatch', async () => {
    const controller = new AbortController(); controller.abort(PRIVATE);
    const { report, calls } = await trial(emptyReply, { deps: { signal: controller.signal } });
    expect(report.failure).toBe('cancelled'); expect(calls).toHaveLength(0); expectPrivate(report);
  });

  it('cancels an in-flight request and tolerates late raw transport errors', async () => {
    const controller = new AbortController(), wire = transport(() => ({ hang: true })), value = profile();
    const pending = runAccess({ profile: value, approval: approvalId(value), credentials: { providerToken: TOKEN } },
      { requestImpl: wire.requestImpl, signal: controller.signal, now: () => 0, wall: () => START });
    controller.abort(PRIVATE);
    const report = await pending;
    expect(report.failure).toBe('cancelled'); expect(wire.calls).toHaveLength(1);
    expect(wire.requests[0].destroy).toHaveBeenCalledTimes(1);
    expect(() => wire.requests[0].emit('error', new Error(PRIVATE))).not.toThrow();
    expectPrivate(report);
  });

  it.each(['overall', 'wall', 'backwards'])('stops on %s clock failure without another query', async (kind) => {
    let elapsed = 0, wallOffset = 0;
    const { report, calls } = await trial(() => {
      if (kind === 'overall') elapsed = LIMITS.overallMs;
      if (kind === 'wall') wallOffset = 6000;
      if (kind === 'backwards') elapsed = -1;
      return emptyReply();
    }, { deps: { now: () => elapsed, wall: () => START + elapsed + wallOffset } });
    expect(report.failure).toBe('deadline'); expect(calls).toHaveLength(1); expectPrivate(report);
  });

  it('contains a synchronous native failure without retaining its message', async () => {
    const { report } = await trial(emptyReply, { deps: { requestImpl: () => { throw new Error(PRIVATE); } } });
    expect(report).toMatchObject({ failure: 'transport', providerRequests: 1 }); expectPrivate(report);
  });
});

/** Run the real Node CLI with a hard native-network denial installed before loading it. */
function cliFixture(args, input) {
  const script = `require('node:https').request = () => { throw new Error('NETWORK_DISALLOWED'); };
    process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
    require('node:module').runMain();`;
  return spawnSync(process.execPath, ['-e', script], { input, encoding: 'utf8', timeout: 10000, windowsHide: true });
}

/** Quote fixture strings as PowerShell literal data; no shell interpolation is permitted. */
function psLiteral(value) { return `'${value.replace(/'/g, "''")}'`; }

/**
 * Exercise actual launcher sequencing with one fake hidden prompt and a mocked
 * Node child. A synthetic JSON profile is created exclusively and removed.
 */
function launcherFixture(matches, reviewFailed = false) {
  const directory = path.resolve(__dirname, '../../../.tmp');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `provider-access-fixture-${randomUUID()}.json`);
  const selected = profile(Date.now()), digest = approvalId(selected);
  fs.writeFileSync(file, JSON.stringify(selected), { flag: 'wx' });
  const script = [
    `. ${psLiteral(LAUNCHER)} -Live -ProfilePath ${psLiteral(file)} -Approval ${psLiteral(matches ? digest : '0'.repeat(64))}`,
    '$script:promptCount = 0; $script:dispatchCount = 0',
    '# Replaces secret entry with synthetic data; no real token is requested.',
    `function Read-Gate1AccessToken { $script:promptCount++; return ${psLiteral(TOKEN)} }`,
    '# Replaces every child launch; this fixture cannot invoke live Node or HTTP.',
    'function Invoke-Gate1AccessNode([string]$Mode, [string]$InputJson) {',
    `  if ($Mode -eq '--review') { return @{ Json = ${psLiteral(JSON.stringify(preparation(selected)))}; ExitCode = ${reviewFailed ? 1 : 0} } }`,
    '  $script:dispatchCount++',
    '  $envelope = $InputJson | ConvertFrom-Json',
    `  if ($Mode -ne '--live' -or $envelope.approval -cne ${psLiteral(digest)} -or`,
    `    $envelope.credentials.providerToken -cne ${psLiteral(TOKEN)} -or`,
    "    @($envelope.credentials.PSObject.Properties).Count -ne 1) { throw 'Fixture envelope failed.' }",
    '  return @{ Json = \'{"fixture":true}\'; ExitCode = 13 }',
    '}',
    'try {',
    '  $result = Invoke-Gate1ProviderAccess',
    '  if ($script:promptCount -ne 1 -or $script:dispatchCount -ne 1) { throw "Fixture sequence failed." }',
    '  Write-Output $result.Json; exit $result.ExitCode',
    '} catch {',
    '  if ($script:promptCount -eq 0 -and $script:dispatchCount -eq 0) { Write-Output "stopped_before_prompts"; exit 9 }',
    '  Write-Output "fixture_failed"; exit 8',
    '}',
  ].join('\n');
  try {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  } finally { fs.unlinkSync(file); }
}

describe('real CLI and mocked PowerShell launcher', () => {
  it.each([[], ['--prepare'], ['--template'], ['--review']].map((args) => [args]))('keeps mode %j offline', (args) => {
    const selected = profile(Date.now());
    const child = cliFixture(args, args[0] === '--review' ? `\uFEFF${JSON.stringify(selected)}` : undefined);
    expect(child.status).toBe(0); expect(child.stderr).toBe('');
    const output = JSON.parse(child.stdout);
    if (args[0] === '--template') expect(output.attestations.sourceCodeReviewed).toBe(false);
    else expect(output).toMatchObject({ mode: 'prepare', appRequests: 0, providerRequests: 0, liveApproved: false });
  });

  it.each([['--live', PRIVATE], ['--unknown']].map((args) => [args]))('rejects extra/unknown arguments without echo (%#)', (args) => {
    const child = cliFixture(args);
    expect(child.status).toBe(1); expect(child.stdout + child.stderr).not.toContain(PRIVATE);
    expect(child.stderr).toContain('No automatic retry');
  });

  it.each([PRIVATE, 'x'.repeat(LIMITS.inputBytes + 1)])('rejects invalid/oversized stdin without echo (%#)', (input) => {
    const child = cliFixture(['--review'], input);
    expect(child.status).toBe(1); expect(child.stdout).toBe(''); expect(child.stderr).not.toContain(PRIVATE);
  });

  it('persists a sanitized stopped report for invalid approval with zero dispatch', () => {
    const child = cliFixture(['--live'], JSON.stringify({ profile: profile(Date.now()), approval: '0'.repeat(64),
      credentials: { providerToken: TOKEN } }));
    expect(child.status).toBe(1); expect(child.stderr).toBe('');
    const { reportPath, report } = JSON.parse(child.stdout);
    try {
      expect(path.dirname(reportPath)).toBe(path.resolve(__dirname, '../../../.tmp'));
      expect(report).toMatchObject({ failure: 'approval', appRequests: 0, providerRequests: 0 });
      expect(JSON.parse(fs.readFileSync(reportPath, 'utf8'))).toEqual(report);
      expectPrivate(report);
    } finally { fs.unlinkSync(reportPath); }
  });

  (process.platform === 'win32' ? it : it.skip)('PowerShell default/template modes require no credentials', () => {
    for (const args of [[], ['-Template']]) {
      const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', LAUNCHER, ...args],
        { encoding: 'utf8', timeout: 10000, windowsHide: true });
      expect(child.status).toBe(0);
      const output = JSON.parse(child.stdout);
      if (args.length) expect(output.attestations.sourceCodeReviewed).toBe(false);
      else expect(output).toMatchObject({ mode: 'prepare', appRequests: 0, providerRequests: 0 });
    }
  });

  (process.platform === 'win32' ? it : it.skip)('PowerShell rejects live without a reviewed profile', () => {
    const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', LAUNCHER, '-Live'],
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(child.status).toBe(1); expect(child.stderr).toContain('No automatic retry');
  });

  (process.platform === 'win32' ? it : it.skip)('PowerShell delivers a real offline review over stdin', () => {
    const directory = path.resolve(__dirname, '../../../.tmp');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `provider-access-fixture-${randomUUID()}.json`);
    const selected = profile(Date.now());
    fs.writeFileSync(file, JSON.stringify(selected), { flag: 'wx' });
    try {
      const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', LAUNCHER, '-ProfilePath', file],
        { encoding: 'utf8', timeout: 10000, windowsHide: true });
      expect(child.status).toBe(0); expect(child.stderr).toBe('');
      expect(JSON.parse(child.stdout)).toMatchObject({ mode: 'prepare', liveApproved: false,
        approvalId: approvalId(selected), appRequests: 0, providerRequests: 0 });
    } finally { fs.unlinkSync(file); }
  });

  (process.platform === 'win32' ? it : it.skip)('PowerShell prompts once after review and preserves the stopped exit code', () => {
    const child = launcherFixture(true);
    expect(child.status).toBe(13); expect(JSON.parse(child.stdout)).toEqual({ fixture: true });
    expect(child.stdout + child.stderr).not.toContain(TOKEN);
  });

  (process.platform === 'win32' ? it.each : it.skip.each)([[false, false], [true, true]])(
    'PowerShell stops before prompts for approval/review failure (%#)', (matches, reviewFailed) => {
      const child = launcherFixture(matches, reviewFailed);
      expect(child.status).toBe(9); expect(child.stdout.trim()).toBe('stopped_before_prompts');
    });
});
