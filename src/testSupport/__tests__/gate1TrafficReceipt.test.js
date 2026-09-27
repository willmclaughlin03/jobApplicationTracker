/** Offline contract/privacy tests: native HTTPS is denied; launcher children use fully mocked live execution. */
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { SCOPE, TARGET, SOURCE, LIMITS, REPORT_NAME, profileTemplate, parseProfile,
  trafficQuery, approvalId, preparation, reviewResponse, runTraffic } = require('../../../scripts/gate1-traffic-receipt');

const START = Date.parse('2026-09-27T18:00:00.000Z');
const TOKEN = 'synthetic_traffic_provider_token_only';
const PRIVATE = 'private-provider-response-sentinel';
const ADDRESS = '192.0.2.28';
const ROOT = path.resolve(__dirname, '../../..');
const CLI = path.join(ROOT, 'scripts/gate1-traffic-receipt.js');
const LAUNCHER = path.join(ROOT, 'scripts/run-gate1-traffic-receipt.ps1');
const ROLLUP = 'vercel_firewall_action_count_sum';
const temporary = [];
let nativeGuard;
beforeAll(() => { nativeGuard = jest.spyOn(https, 'request').mockImplementation(() => { throw new Error('Native HTTP forbidden'); }); });
afterEach(() => { expect(nativeGuard).not.toHaveBeenCalled(); jest.useRealTimers(); });
afterAll(() => {
  nativeGuard.mockRestore();
  for (const directory of temporary) {
    if (!path.resolve(directory).startsWith(path.join(ROOT, '.tmp', 'traffic-test-'))) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** Create a reviewed synthetic profile at a deterministic wall time; no real approval is asserted. */
function profile(time = START) {
  const value = profileTemplate(time);
  for (const key of Object.keys(value.attestations)) value.attestations[key] = true;
  return value;
}

/** Construct the fixed matching aggregate; mutations exercise conflicting provider data. */
function row(changes = {}) {
  return { waf_rule_id: SOURCE.ruleId, waf_action: 'log', request_hostname: TARGET.hostname,
    request_path: '/api/auth/session', [ROLLUP]: 1, ...changes };
}

/** Produce a CLI-compatible summary payload; optional data/statistics remain transient. */
function payload(summary = [], changes = {}) { return { summary, statistics: {}, ...changes }; }

/** Encode a synthetic provider body for the native stream seam, never a network response. */
function reply(value = payload(), changes = {}) {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), ...changes };
}

/** Model native request/response events, including cancellation, incomplete bodies and bounded failures. */
function transport(responder = () => reply()) {
  const calls = [], requests = [], responses = [];
  const requestImpl = jest.fn((options, receive) => {
    const request = new EventEmitter(); request.destroy = jest.fn(); requests.push(request);
    request.end = jest.fn((body) => {
      calls.push({ options, body });
      Promise.resolve().then(() => {
        const result = responder(options, body);
        if (result.hang) return;
        if (result.error) { request.emit('error', new Error(TOKEN)); return; }
        const response = new EventEmitter(); response.destroy = jest.fn(); responses.push(response);
        response.statusCode = result.status; response.complete = result.complete !== false;
        response.rawHeaders = result.rawHeaders || Object.entries(result.headers || {}).flat();
        receive(response);
        if (response.destroy.mock.calls.length || result.hangBody) return;
        if (result.earlyClose) { response.emit('close'); return; }
        for (const chunk of result.chunks || [Buffer.from(result.body || '')]) response.emit('data', chunk);
        if (result.aborted) response.emit('aborted'); else response.emit('end');
        response.emit('close');
      }).catch((error) => request.emit('error', error));
    });
    return request;
  });
  return { requestImpl, calls, requests, responses };
}

/** Execute only through mocked transport and clocks; explicit storage is reserved for filesystem fixtures. */
async function trial(responder, changes = {}) {
  const wire = transport(responder), selected = changes.profile || profile();
  const input = { profile: selected, approval: approvalId(selected), credentials: { providerToken: TOKEN }, ...changes.input };
  const result = await runTraffic(input, { requestImpl: wire.requestImpl, now: () => 0, wall: () => START, ...changes.deps });
  return { ...result, ...wire };
}

/** Assert every outcome retains scope limitations and discards secrets/private provider metadata. */
function expectPrivate(report) {
  const encoded = JSON.stringify(report);
  for (const value of [TOKEN, PRIVATE, ADDRESS, 'Bearer ']) expect(encoded).not.toContain(value);
  expect(Buffer.byteLength(encoded)).toBeLessThan(LIMITS.reportBytes);
  expect(report).toMatchObject({ gate1Status: 'open', appRequests: 0, configReads: 0, configMutations: 0,
    correlation: 'unqualified', completeness: 'unqualified', sourceAgreement: 'not_evaluated' });
}

/** Allocate isolated synthetic evidence within the approved worktree; never touch historical reservations. */
function fixtureDirectory() {
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(ROOT, '.tmp', 'traffic-test-'));
  temporary.push(directory); return directory;
}

describe('fixed traffic scope and code-bound approval', () => {
  it('prepares offline with false attestations and a separate reservation', () => {
    const template = profileTemplate(START);
    expect(() => parseProfile(template)).toThrow('profile');
    expect(preparation()).toMatchObject({ liveApproved: false, appRequests: 0, providerRequests: 0,
      reservationName: REPORT_NAME, scope: SCOPE });
    expect(preparation(profile(), START).approvalId).toBe(approvalId(profile()));
    expect(REPORT_NAME).not.toContain('log-followup');
  });

  it('dispatches one exact POST and retains only aggregate evidence', async () => {
    const { report, calls } = await trial(() => reply(payload([row()])));
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toEqual({ protocol: 'https:', hostname: 'api.vercel.com', port: 443,
      path: `/v2/observability/query?teamId=${TARGET.teamId}`, method: 'POST', agent: false,
      rejectUnauthorized: true, maxHeaderSize: 16384,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(calls[0].body) } });
    expect(JSON.parse(calls[0].body)).toEqual({ scope: { type: 'project', ownerId: TARGET.teamId, projectIds: [TARGET.projectId] },
      metric: 'vercel.firewall_action.count', aggregation: 'sum', startTime: SOURCE.queryWindow.start,
      endTime: SOURCE.queryWindow.end, granularity: { hours: 1 },
      groupBy: ['waf_rule_id', 'waf_action', 'request_hostname', 'request_path'],
      filter: `(waf_rule_id eq '${SOURCE.ruleId}') and (request_hostname eq '${TARGET.hostname}') and (request_path eq '/api/auth/session') and (waf_action eq 'log')`,
      limit: 2, orderBy: ROLLUP, orderDirection: 'desc' });
    expect(report).toMatchObject({ result: 'completed', mode: 'fixture', hostedEvidence: 'not_executed',
      providerRequests: 1, trafficQueries: 1, httpStatus: 200,
      observation: { matchingSummary: true, count: 1, receipt: 'matching_aggregate_only' } });
    expectPrivate(report);
  });

  it.each([
    { teamId: 'team_other' }, { projectId: 'prj_other' }, { hostname: 'other.example' }, { scope: 'receipt_followup' },
    { sourceEvidence: { ...SOURCE, ruleId: 'other_rule' } }, { endpoint: PRIVATE },
    { sourceEvidence: { ...SOURCE, queryWindow: { ...SOURCE.queryWindow, start: '2026-09-27T16:00:00.000Z' } } },
    { sourceEvidence: { ...SOURCE, sha256: '0'.repeat(64) } },
    { attestations: { sourceCodeReviewed: true, credentialLoggingReviewed: true, includedUsageHeadroom: false } },
  ])('rejects changed input before any request (%#)', async (change) => {
    const { report, calls } = await trial(undefined, { input: { profile: { ...profile(), ...change } } });
    expect(calls).toHaveLength(0); expect(report.result).toBe('stopped'); expectPrivate(report);
  });

  it.each([{ approval: '0'.repeat(64) }, { credentials: { providerToken: 'short' } },
    { credentials: { providerToken: `${TOKEN}\n` } }, { credentials: { providerToken: TOKEN, secret: TOKEN } },
    { extra: PRIVATE }])('refuses bad approval or credentials (%#)', async (input) => {
    const { report, calls } = await trial(undefined, { input });
    expect(calls).toHaveLength(0); expect(report.result).toBe('stopped'); expectPrivate(report);
  });

  it.each([-LIMITS.profileAgeMs - 1, 1])('refuses stale/future profile %s', async (offset) => {
    const value = profile(START + offset);
    expect(() => preparation(value, START)).toThrow('profile');
    const { report, calls } = await trial(undefined, { profile: value });
    expect(report.failure).toBe('profile'); expect(calls).toHaveLength(0);
  });

  it.each([Date.parse(SOURCE.queryWindow.end), Date.parse(SOURCE.queryWindow.start) + LIMITS.retentionMs - LIMITS.overallMs,
    Date.parse(SOURCE.queryWindow.start) + LIMITS.retentionMs + 1])('refuses unusable historical retention at %s', async (time) => {
    const value = profile(time);
    expect(() => preparation(value, time)).toThrow('retention');
    const { report, calls } = await trial(undefined, { profile: value, deps: { wall: () => time } });
    expect(report.failure).toBe('retention'); expect(calls).toHaveLength(0);
  });

  it.each(['gate1-traffic-receipt.js', 'run-gate1-traffic-receipt.ps1', 'gate1-source-discovery.js',
    'gate1-source-waf.js', 'gate1-host-protection.js'])('invalidates approval after %s changes', async (name) => {
    const value = profile(), original = approvalId(value), read = fs.readFileSync;
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      const bytes = read(file, ...args);
      return path.basename(String(file)) === name ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes;
    });
    try {
      const { report, calls } = await trial(undefined, { input: { approval: original } });
      expect(report.failure).toBe('approval'); expect(calls).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
});

describe('strict flat summaries and private response handling', () => {
  it.each([0, 1, 2, Number.MAX_SAFE_INTEGER, '0', '1', '9007199254740991'])('accepts canonical safe count %s', async (count) => {
    const { report } = await trial(() => reply(payload([row({ [ROLLUP]: count })])));
    expect(report.result).toBe('completed'); expect(report.observation.count).toBe(Number(count)); expectPrivate(report);
  });
  it.each([null, true, '', '-1', '01', '1.0', '1e2', ' 1', '-0', '9007199254740992', -1, 1.2,
    Number.MAX_SAFE_INTEGER + 1])('refuses malformed count %s', async (count) => {
    const { report } = await trial(() => reply(payload([row({ [ROLLUP]: count })])));
    expect(report.failure).toBe('provider_schema'); expectPrivate(report);
  });
  it('keeps an empty summary inconclusive', async () => {
    const { report } = await trial();
    expect(report).toMatchObject({ result: 'completed', observation: { rows: 'empty', matchingSummary: false,
      count: null, receipt: 'not_observed_in_query', sampled: 'unknown', truncated: 'unknown' } }); expectPrivate(report);
  });
  it.each([payload([row(), row()]), payload([row({ waf_rule_id: PRIVATE })]), payload([row({ waf_action: 'deny' })]),
    payload([row({ request_hostname: PRIVATE })]), payload([row({ request_path: PRIVATE })]),
    payload([row()], { sampled: true }), payload([row()], { truncated: true }),
    payload([], { data: [{ ...row(), timestamp: '2026-09-27 16:00:00.000' }] }),
    payload([row()], { data: [{ ...row({ [ROLLUP]: 2 }), timestamp: PRIVATE }] }),
  ])('stops conflicting summaries without accepting a match (%#)', async (value) => {
    const { report, calls } = await trial(() => reply(value));
    expect(report.failure).toBe('provider_ambiguous'); expect(report.observation.matchingSummary).toBe(false);
    expect(calls).toHaveLength(1); expectPrivate(report);
  });
  it.each([null, [], {}, { summary: [] }, payload([row(), row(), row()]), payload([row({ client_ip: ADDRESS })]),
    payload([], { unknown: TOKEN }), payload([], { statistics: { surprise: PRIVATE } }),
    payload([], { summary: [{ dimensions: {}, values: { value: 1 } }] }),
    payload([], { orderBy: 'wrong' }), payload([], { sampled: 'false' }),
  ])('rejects unsupported provider schema (%#)', async (value) => {
    const { report } = await trial(() => reply(value)); expect(report.failure).toBe('provider_schema'); expectPrivate(report);
  });
  it('discards statistics and bucket timestamps without asserting request timing', async () => {
    const { report } = await trial(() => reply(payload([row()], { statistics: { queryTable: PRIVATE, rowsRead: 123 },
      data: [{ ...row(), timestamp: '2026-09-27 16:00:00.000' }], sampled: false, truncated: false })));
    expect(report.result).toBe('completed'); expectPrivate(report);
    expect(JSON.stringify(report)).not.toContain('16:00:00'); expect(report.observation).not.toHaveProperty('timingQualified');
  });
  it.each([400, 401, 402, 403, 404, 429, 500, 503])('records HTTP %s without raw text, retries or cause inference', async (status) => {
    const { report, calls } = await trial(() => reply({ error: { code: 'forbidden', message: `${PRIVATE} ${TOKEN} ${ADDRESS}` } }, { status }));
    expect(report).toMatchObject({ failure: 'provider_status', httpStatus: status, observation: { errorCode: 'forbidden' } });
    expect(calls).toHaveLength(1); expectPrivate(report);
  });
  it('discards unknown error codes', () => {
    expect(reviewResponse(reply({ error: { code: TOKEN } }, { status: 403 })).errorCode).toBeNull();
  });
  it.each(['null', '[', TOKEN])('rejects invalid or incompatible JSON %s', async (body) => {
    const { report } = await trial(() => reply(undefined, { body }));
    expect(report.failure).toBe('provider_schema'); expectPrivate(report);
  });
});

describe('single physical attempt, bounded streams and cancellation', () => {
  it.each([
    [{ status: 302, headers: { location: `https://example.invalid/${TOKEN}` } }, 'redirect'],
    [{ headers: { 'content-type': 'text/html' } }, 'provider_schema'],
    [{ headers: { 'set-cookie': TOKEN } }, 'cookie_contract'],
    [{ headers: { 'content-encoding': 'gzip' } }, 'response_encoding'],
    [{ headers: { 'content-length': String(LIMITS.providerBytes + 1) } }, 'response_size'],
    [{ body: 'x'.repeat(LIMITS.providerBytes + 1) }, 'response_size'],
    [{ rawHeaders: ['content-type', 'application/json', 'Content-Type', 'application/json'] }, 'response_headers'],
    [{ rawHeaders: ['unknown', 'x'.repeat(LIMITS.headerBytes)] }, 'response_headers'],
    [{ complete: false }, 'response_incomplete'], [{ earlyClose: true }, 'response_incomplete'],
    [{ aborted: true }, 'response_incomplete'], [{ error: true }, 'transport'],
    [{ headers: { 'content-length': '1000' } }, 'response_incomplete'],
  ])('stops a bounded transport failure (%#)', async (change, expected) => {
    const { report, calls } = await trial(() => reply(undefined, change));
    expect(report.failure).toBe(expected); expect(calls).toHaveLength(1); expectPrivate(report);
  });
  it.each(['hang', 'hangBody'])('destroys a stalled %s at the request deadline', async (key) => {
    jest.useFakeTimers();
    const pending = trial(() => reply(undefined, { [key]: true }));
    await jest.advanceTimersByTimeAsync(LIMITS.requestMs);
    const { report, requests } = await pending;
    expect(report.failure).toBe('deadline'); expect(requests[0].destroy).toHaveBeenCalled(); expectPrivate(report);
  });
  it('cancels before dispatch', async () => {
    const controller = new AbortController(); controller.abort(TOKEN);
    const { report, calls } = await trial(undefined, { deps: { signal: controller.signal } });
    expect(report.failure).toBe('cancelled'); expect(calls).toHaveLength(0); expectPrivate(report);
  });
  it('cancels an in-flight request without replay', async () => {
    const controller = new AbortController();
    const pending = trial(() => ({ hang: true }), { deps: { signal: controller.signal } });
    controller.abort(TOKEN);
    const { report, calls, requests } = await pending;
    expect(report.failure).toBe('cancelled'); expect(calls).toHaveLength(1); expect(requests[0].destroy).toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -1])('rejects an invalid monotonic clock %s', async (clock) => {
    const { report, calls } = await trial(undefined, { deps: { now: () => clock } });
    expect(report.result).toBe('stopped'); expect(calls).toHaveLength(0);
  });
  it('rejects deadline expiry after response before accepting the summary', async () => {
    let tick = 0;
    const { report } = await trial(() => { tick = LIMITS.overallMs; return reply(payload([row()])); },
      { deps: { now: () => tick, wall: () => START + tick } });
    expect(report.failure).toBe('deadline'); expect(report.observation).toBeNull();
  });
  it('rejects a backwards clock before dispatch', async () => {
    let calls = 0;
    const { report, calls: wire } = await trial(undefined, { deps: { now: () => calls++ === 0 ? 10 : 0 } });
    expect(report.failure).toBe('deadline'); expect(wire).toHaveLength(0);
  });
});

describe('durable operation reservation and evidence failures', () => {
  it('prevents concurrent execution and profile refresh replay', async () => {
    const directory = fixtureDirectory();
    const first = trial(undefined, { deps: { evidenceDirectory: directory } });
    const second = await trial(undefined, { profile: profile(START + 1),
      deps: { evidenceDirectory: directory, wall: () => START + 1 } });
    const completed = await first;
    expect(completed.report.result).toBe('completed'); expect(second.report.failure).toBe('approval_consumed');
    expect(second.calls).toHaveLength(0);
    const before = fs.readFileSync(completed.reportPath);
    const third = await trial(undefined, { deps: { evidenceDirectory: directory } });
    expect(third.report.failure).toBe('approval_consumed'); expect(fs.readFileSync(completed.reportPath)).toEqual(before);
    expect(JSON.parse(before).mode).toBe('fixture'); expectPrivate(JSON.parse(before));
  });
  it('retains a consumed reservation after a transport failure', async () => {
    const directory = fixtureDirectory();
    const first = await trial(() => ({ error: true }), { deps: { evidenceDirectory: directory } });
    expect(first.report.failure).toBe('transport');
    const next = await trial(undefined, { deps: { evidenceDirectory: directory } });
    expect(next.calls).toHaveLength(0); expect(next.report.failure).toBe('approval_consumed');
  });
  it('refuses dispatch when the initial reservation write fails', async () => {
    const directory = fixtureDirectory();
    const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error(TOKEN); });
    let result;
    try { result = await trial(undefined, { deps: { evidenceDirectory: directory } }); } finally { spy.mockRestore(); }
    expect(result.report.failure).toBe('local_evidence'); expect(result.calls).toHaveLength(0); expectPrivate(result.report);
    expect(fs.existsSync(path.join(directory, REPORT_NAME))).toBe(true);
  });
  it('refuses dispatch when its checkpoint fails', async () => {
    const directory = fixtureDirectory();
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error(TOKEN); });
    let result;
    try { result = await trial(undefined, { deps: { evidenceDirectory: directory } }); } finally { spy.mockRestore(); }
    expect(result.report.failure).toBe('local_evidence'); expect(result.report.evidenceFailure).toBe('local_evidence');
    expect(result.calls).toHaveLength(0); expectPrivate(result.report);
    expect(JSON.parse(fs.readFileSync(path.join(directory, REPORT_NAME))).dispatchState).toBe('reserved');
  });
  it('marks a final evidence-write failure non-passing and preserves the pending checkpoint', async () => {
    const directory = fixtureDirectory(), rename = fs.renameSync; let count = 0;
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      if (++count === 2) throw new Error(TOKEN); return rename(...args);
    });
    let result;
    try { result = await trial(undefined, { deps: { evidenceDirectory: directory } }); } finally { spy.mockRestore(); }
    expect(result.report.result).toBe('stopped'); expect(result.report.evidenceFailure).toBe('local_evidence');
    expect(result.calls).toHaveLength(1); expectPrivate(result.report);
    expect(JSON.parse(fs.readFileSync(result.reportPath)).dispatchState).toBe('dispatch_pending');
  });
});

/** Quote only test-owned literal paths for PowerShell; never shell-encode user credentials. */
function psLiteral(value) { return `'${value.replace(/'/g, "''")}'`; }

/** Test the actual launcher with fake Node/token/confirmation functions; subprocesses cannot send HTTP. */
function launcherFixture({ mutation = '', confirmation = 'RUN TRAFFIC RECEIPT ONCE', reserved = false } = {}) {
  const directory = fixtureDirectory(), file = path.join(directory, 'profile.json');
  const selected = profile(), prepared = preparation(selected, START);
  fs.writeFileSync(file, JSON.stringify(selected));
  const preparedJson = Buffer.from(JSON.stringify(prepared)).toString('base64');
  const script = `
    . ${psLiteral(LAUNCHER)}
    $script:prepared = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${preparedJson}')) | ConvertFrom-Json
    ${mutation}
    $script:tokenCalls = 0; $script:liveCalls = 0
    function Invoke-Gate1TrafficNode([string]$Mode, [string]$InputJson = '') {
      if ($Mode -ceq '--review') { return @{ Json = ($script:prepared | ConvertTo-Json -Depth 12); ExitCode = 0 } }
      if ($Mode -cne '--live') { throw 'Unexpected mode' }
      $envelope = $InputJson | ConvertFrom-Json
      if ($envelope.credentials.providerToken -cne '${TOKEN}') { throw 'Missing synthetic token' }
      $script:liveCalls++; return @{ Json = '{}'; ExitCode = 0 }
    }
    function Read-Gate1TrafficToken { $script:tokenCalls++; return '${TOKEN}' }
    function Read-Host { return ${psLiteral(confirmation)} }
    function Test-Path { return $${reserved ? 'true' : 'false'} }
    $ProfilePath = ${psLiteral(file)}; $Live = $true; $Template = $false; $Approval = '${prepared.approvalId}'
    $failed = $false
    try { $null = Invoke-Gate1TrafficReceipt } catch { $failed = $true }
    @{ failed = $failed; tokenCalls = $script:tokenCalls; liveCalls = $script:liveCalls } | ConvertTo-Json -Compress
  `;
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
  expect(child.stderr).not.toContain(TOKEN); expect(child.stdout).not.toContain(TOKEN);
  return JSON.parse(child.stdout);
}

// This launcher uses Windows PowerShell; retain its checks on Windows without spawning it in Linux CI.
(process.platform === 'win32' ? describe : describe.skip)('PowerShell confirmation and independent scope checks', () => {
  it('permits only the confirmed reviewed operation through mocked stdin', () => {
    expect(launcherFixture()).toEqual({ failed: false, tokenCalls: 1, liveCalls: 1 });
  });
  it.each(['', 'yes', 'run traffic receipt once', 'RUN TRAFFIC RECEIPT ONCE '])('refuses confirmation %s before token entry', (confirmation) => {
    expect(launcherFixture({ confirmation })).toEqual({ failed: true, tokenCalls: 0, liveCalls: 0 });
  });
  it('refuses an existing reservation before prompting', () => {
    expect(launcherFixture({ reserved: true })).toEqual({ failed: true, tokenCalls: 0, liveCalls: 0 });
  });
  it.each([
    "$script:prepared.query.filter = 'true'", "$script:prepared.query.scope.ownerId = 'team_other'",
    "$script:prepared.query.startTime = '2026-09-27T16:00:00.000Z'", '$script:prepared.query.limit = 100',
    "$script:prepared.query.groupBy += 'client_ip'", '$script:prepared.limits.maxProviderRequests = 2',
    '$script:prepared.limits.maxAppRequests = 1', "$script:prepared.endpoint = 'https://example.invalid'",
    "$script:prepared.method = 'GET'", '$script:prepared.liveApproved = $true',
    "$script:prepared.sourceEvidence.sha256 = 'wrong'", "$script:prepared.reservationName = 'other.json'",
    "$script:prepared.approvalId = ('0' * 64)",
  ])('refuses mutated review before secret entry (%#)', (mutation) => {
    expect(launcherFixture({ mutation })).toEqual({ failed: true, tokenCalls: 0, liveCalls: 0 });
  });
});

/** Keep Node CLI safety checks active on every platform, independent of the Windows launcher. */
describe('Node CLI offline modes and argument validation', () => {
  it.each([[[]], [['--prepare']], [['--template']]])('keeps Node mode %j offline', (args) => {
    const child = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
    const value = JSON.parse(child.stdout);
    if (args[0] === '--template') expect(Object.values(value.attestations)).toEqual([false, false, false]);
    else expect(value).toMatchObject({ liveApproved: false, providerRequests: 0, appRequests: 0, query: trafficQuery() });
  });
  it('rejects extra CLI arguments before credential input', () => {
    const child = spawnSync(process.execPath, [CLI, '--live', TOKEN], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
    expect(child.stderr).not.toContain(TOKEN); expect(child.stdout).toBe('');
  });
});
