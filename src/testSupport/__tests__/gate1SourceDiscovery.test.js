/** Offline protocol, sequencing, privacy and launcher tests. No hosted requests. */
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { LIMITS, profileTemplate, parseProfile, approvalId, preparation, exchange,
  reviewMetrics, runDiscovery, readInput } = require('../../../scripts/gate1-source-discovery');

const START = Date.parse('2026-09-23T20:00:00.000Z');
const SECRET = 'a'.repeat(64);
const TOKEN = 'synthetic_provider_token_for_offline_test';
const PRIVATE = 'sensitive-provider-sentinel';
const SOURCE = '192.0.2.17';
const MARKER = `gate1-source-${'b'.repeat(32)}`;
const CLI = path.resolve(__dirname, '../../../scripts/gate1-source-discovery.js');
const LAUNCHER = path.resolve(__dirname, '../../../scripts/run-gate1-source-discovery.ps1');

/** Synthetic reviewed profile; none of its deployment or owner IDs targets a real deployment. */
function profile() {
  const value = profileTemplate();
  Object.assign(value, { teamId: 'team_Fixture', deploymentId: 'dpl_Fixture', gitSha: 'c'.repeat(40),
    immutableHostname: 'job-application-tracker-fixture-track-the-app.vercel.app',
    nextBuildId: 'FixtureBuild', reviewedAt: new Date(START).toISOString() });
  for (const key of Object.keys(value.attestations)) value.attestations[key] = true;
  return value;
}

/** Successful origin probe facts; synthetic raw addresses are never in this response header. */
function observation(marker) {
  return { schemaVersion: 1, scope: 'server_header_observation_only', marker,
    applicationRequestId: null, rawMetadataValid: true, trustedHeaderCount: 1,
    normalizedShape: 'scalar', rawNormalizedEqual: true, effectiveMode: 'vercel',
    sourceResolution: 'accepted', canonicalFamily: 4, sourceAgreement: 'not_evaluated' };
}

/** CLI-derived aggregate fixture with a transient IP and marker; no request receipt is implied. */
function aggregate(marker = MARKER, target = profile()) {
  return { summary: [{ dimensions: { clientUserAgent: marker, requestHostname: target.hostname,
    requestPath: '/api/auth/session', clientIp: SOURCE }, values: { value: 1 } }], series: [] };
}

/** Build protocol-level fixtures from actual request options, keeping credentials in memory only. */
function reply(options, body) {
  const target = profile();
  let payload;
  if (options.path.startsWith('/v4/aliases/')) {
    payload = { alias: target.hostname, projectId: target.projectId, deploymentId: target.deploymentId,
      ignoredProviderField: PRIVATE };
  } else if (options.path.startsWith('/v13/deployments/')) {
    payload = { id: target.deploymentId, projectId: target.projectId, url: target.immutableHostname,
      readyState: 'READY', target: 'production', gitSource: { sha: target.gitSha }, ignoredProviderField: PRIVATE };
  } else if (options.path.startsWith('/metrics/v1')) {
    const query = JSON.parse(body);
    payload = aggregate(query.filter.match(/gate1-source-[a-f0-9]{32}/)[0], target);
  } else if (options.path === '/login') {
    return { headers: { 'content-type': 'text/html' }, body:
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ page: '/login', buildId: target.nextBuildId })}</script>` };
  } else if (options.path === '/api/auth/session') {
    return { headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store',
      'x-vercel-cache': 'BYPASS', 'x-gate1-source-probe': JSON.stringify(observation(options.headers['User-Agent'])) },
    body: JSON.stringify({ data: { user: null }, error: null, message: 'Success' }) };
  } else throw new Error('Unexpected fixture request');
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

/**
 * Mock native HTTPS at its sole dispatch seam. Simulates raw headers, chunks,
 * errors and incomplete streams; records options for isolation/budget assertions.
 */
function transport(responder = reply) {
  const calls = [], requests = [], responses = [];
  const requestImpl = jest.fn((options, receive) => {
    const request = new EventEmitter();
    request.destroy = jest.fn();
    requests.push(request);
    request.end = jest.fn((body) => {
      calls.push({ options, body });
      Promise.resolve().then(() => {
        const result = responder(options, body, calls.length);
        if (result.hang) return;
        if (result.error) { request.emit('error', new Error(PRIVATE)); return; }
        const response = new EventEmitter();
        responses.push(response);
        response.destroy = jest.fn();
        response.complete = result.complete !== false;
        response.statusCode = result.status ?? 200;
        response.rawHeaders = result.rawHeaders ?? Object.entries(result.headers || {}).flat();
        receive(response);
        if (response.destroy.mock.calls.length) return;
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

/** Execute one fixture trial with simulated polling time; no real timers, sockets or credentials. */
async function trial(responder = reply, changes = {}) {
  const wire = transport(responder);
  let elapsed = 0;
  const target = profile();
  const input = { profile: target, approval: approvalId(target),
    credentials: { probeSecret: SECRET, providerToken: TOKEN }, ...changes.input };
  const deps = { requestImpl: wire.requestImpl, now: () => elapsed,
    wall: () => START + elapsed, sleep: jest.fn(async (ms) => { elapsed += ms; }), ...changes.deps };
  const report = await runDiscovery(input, deps);
  return { report, ...wire, deps };
}

describe('GATE-1 source discovery profile and aggregate boundary', () => {
  it('defaults to an offline proposal and an unready template', () => {
    expect(preparation()).toMatchObject({ mode: 'prepare', liveApproved: false,
      appRequests: 0, providerRequests: 0, target: null, approvalId: null });
    expect(() => parseProfile(profileTemplate())).toThrow('profile');
    expect(preparation(profile()).approvalId).toMatch(/^[a-f0-9]{64}$/);
    const changed = profile(); changed.nextBuildId = 'Changed';
    expect(approvalId(changed)).not.toBe(approvalId(profile()));
  });

  it.each([
    { hostname: 'elsewhere.example' }, { projectId: 'prj_Another' },
    { teamId: 'team_Fixture&other=true' }, { environment: 'preview' },
    { immutableHostname: 'https://example.com/' }, { gitSha: 'abc123' },
    { nextBuildId: '../invalid' }, { secret: PRIVATE },
    { attestations: { ...profile().attestations, probeConfigured: false } },
  ])('rejects unreviewed profile changes (%#)', (change) => {
    expect(() => parseProfile({ ...profile(), ...change })).toThrow('profile');
  });

  it('retains candidate availability while explicitly refusing correlation or source proof', () => {
    const result = reviewMetrics(aggregate(), profile(), MARKER);
    expect(result).toMatchObject({ availability: 'aggregate_candidate', rows: 1, count: 1,
      markerMatched: true, sourceFieldPresent: true, sampled: null, truncated: null,
      sourceAgreement: 'not_evaluated', correlation: 'unqualified', completeness: 'unqualified',
      wafSourceSemantics: 'unqualified' });
    expect(JSON.stringify(result)).not.toContain(SOURCE);
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it.each(['sampled', 'truncated'])('stops even empty summaries declared %s', (key) => {
    expect(reviewMetrics({ summary: [], [key]: true }, profile(), MARKER).availability).toBe('ambiguous');
  });

  it.each([
    { summary: [], unknown: PRIVATE }, { summary: null }, { summary: [], series: [{}] },
    { ...aggregate(), summary: [{ ...aggregate().summary[0], values: { value: '1' } }] },
    { ...aggregate(), summary: [{ ...aggregate().summary[0], values: { value: 0 } }] },
    { ...aggregate(), summary: [{ ...aggregate().summary[0], values: { value: 1.5 } }] },
  ])('rejects unsupported provider shapes without numeric coercion (%#)', (value) => {
    expect(() => reviewMetrics(value, profile(), MARKER)).toThrow('provider_schema');
  });
});

describe('GATE-1 discovery sequence and report privacy', () => {
  it('dispatches only three app requests and five API calls for the first candidate', async () => {
    const { report, calls } = await trial();
    expect(report).toMatchObject({ mode: 'fixture', result: 'completed', appRequests: 3,
      providerRequests: 5, validatedAppRequests: 3, validatedProviderRequests: 5, wafQueries: 1,
      gate1Status: 'open', hostedEvidence: 'not_executed', sourceAgreement: 'not_evaluated', failure: null });
    expect(report.receipts.map((row) => row.phase)).toEqual(['aliasBefore', 'deploymentBefore',
      'buildBefore', 'session', 'buildAfter', 'wafLookup1', 'aliasAfter', 'deploymentAfter']);
    const apps = calls.filter(({ options }) => options.hostname === profile().hostname);
    expect(apps.map(({ options }) => options.path)).toEqual(['/login', '/api/auth/session', '/login']);
    for (const { options } of calls) {
      expect(options).toMatchObject({ protocol: 'https:', port: 443, agent: false, rejectUnauthorized: true });
      expect(Object.keys(options.headers).some((key) => /cookie|bypass|forwarded|real-ip/i.test(key))).toBe(false);
      if (options.hostname === 'api.vercel.com') {
        expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(options.path).toContain('teamId=team_Fixture');
        if (options.path.startsWith('/v13/')) expect(options.path).toContain('withGitRepoInfo=true');
      } else if (options.path === '/api/auth/session') expect(options.headers.Authorization).toBe(`Bearer ${SECRET}`);
      else expect(options.headers.Authorization).toBeUndefined();
    }
    const encoded = JSON.stringify(report);
    for (const forbidden of [SECRET, TOKEN, SOURCE, PRIVATE, 'gate1-source-', 'Bearer ']) expect(encoded).not.toContain(forbidden);
  });

  it('queries twice only for empty results, reusing the same window and never replaying the session', async () => {
    const { report, calls, deps } = await trial((options, body) => options.path.startsWith('/metrics/')
      ? { headers: { 'content-type': 'application/json' }, body: '{"summary":[]}' } : reply(options, body));
    expect(report).toMatchObject({ result: 'completed', appRequests: 3, providerRequests: 6, wafQueries: 2,
      waf: { availability: 'no_rows', correlation: 'unqualified', completeness: 'unqualified' } });
    const queries = calls.filter(({ options }) => options.path.startsWith('/metrics/'));
    expect(queries[0].body).toBe(queries[1].body);
    expect(JSON.parse(queries[0].body)).toMatchObject({ rowLimit: 2,
      scope: { ownerId: profile().teamId, projectIds: [profile().projectId] },
      metrics: { value: { metric: 'vercel.firewall_action.count', aggregation: 'count' } } });
    expect(deps.sleep.mock.calls.map((args) => args[0])).toEqual([30000, 60000]);
  });

  it.each(['count', 'rows', 'marker', 'ip', 'sampled', 'truncated'])('stops on %s ambiguity without a second query', async (change) => {
    const { report } = await trial((options, body) => {
      const result = reply(options, body);
      if (options.path.startsWith('/metrics/')) {
        const value = JSON.parse(result.body);
        if (change === 'count') value.summary[0].values.value = 2;
        if (change === 'rows') value.summary.push(value.summary[0]);
        if (change === 'marker') value.summary[0].dimensions.clientUserAgent = MARKER;
        if (change === 'ip') value.summary[0].dimensions.clientIp = PRIVATE;
        if (['sampled', 'truncated'].includes(change)) value[change] = true;
        result.body = JSON.stringify(value);
      }
      return result;
    });
    expect(report).toMatchObject({ result: 'stopped', failure: 'provider_ambiguous', wafQueries: 1,
      providerRequests: 3, stoppedPhase: 'wafLookup1' });
    expect(JSON.stringify(report)).not.toContain(PRIVATE);
  });

  it.each([
    ['aliasBefore', 1, 'attribution'], ['deploymentBefore', 2, 'attribution'],
    ['buildBefore', 3, 'build_mismatch'], ['session', 4, 'probe_contract'],
    ['buildAfter', 5, 'build_mismatch'], ['aliasAfter', 7, 'attribution'],
    ['deploymentAfter', 8, 'attribution'],
  ])('stops on %s drift without dispatching later phases', async (phase, attempt, code) => {
    const { report, calls } = await trial((options, body, index) => {
      const result = reply(options, body);
      if (index === attempt) {
        if (phase.startsWith('build')) result.body = result.body.replace('FixtureBuild', 'OtherBuild');
        else if (phase === 'session') result.headers['x-gate1-source-probe'] = '{}';
        else result.body = '{}';
      }
      return result;
    });
    expect(report).toMatchObject({ result: 'stopped', failure: code, stoppedPhase: phase });
    expect(calls).toHaveLength(attempt);
    expect(report.receipts.at(-1).validated).toBe(false);
  });

  it.each([301, 302, 307, 308, 429, 500])('never retries provider status %s', async (status) => {
    const { report, calls } = await trial(() => ({ status, headers: {}, body: PRIVATE }));
    expect(report).toMatchObject({ result: 'stopped', providerRequests: 1, appRequests: 0,
      failure: status < 400 ? 'redirect' : 'provider_status' });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain(PRIVATE);
  });

  it.each([
    { approval: 'd'.repeat(64) }, { credentials: { probeSecret: SECRET, providerToken: SECRET } },
    { credentials: { probeSecret: 'invalid', providerToken: TOKEN } },
    { profile: { ...profile(), reviewedAt: '2026-09-20T20:00:00.000Z' } },
  ])('rejects invalid or unapproved envelopes before any HTTP (%#)', async (input) => {
    const { report, calls } = await trial(reply, { input });
    expect(report.result).toBe('stopped');
    expect(calls).toHaveLength(0);
    expect(report.target).toBeNull();
  });

  it.each(['2026-09-20T20:00:00.000Z', '2026-09-23T21:00:00.000Z'])(
    'rejects an approved stale/future review before any HTTP (%#)', async (reviewedAt) => {
    const stale = { ...profile(), reviewedAt };
    const { report, calls } = await trial(reply, { input: { profile: stale, approval: approvalId(stale) } });
    expect(report.failure).toBe('profile');
    expect(calls).toHaveLength(0);
  });

  it('stops after polling exceeds the overall deadline', async () => {
    let elapsed = 0;
    const { report, calls } = await trial(reply, { deps: { now: () => elapsed, wall: () => START + elapsed,
      sleep: async () => { elapsed = LIMITS.overallMs; } } });
    expect(report).toMatchObject({ failure: 'deadline', stoppedPhase: 'wafWait', appRequests: 3, providerRequests: 2 });
    expect(calls).toHaveLength(5);
  });

  it('stops on wall-clock movement instead of querying an ambiguous time window', async () => {
    let offset = 0;
    const { report } = await trial((options, body) => { offset = 6000; return reply(options, body); },
      { deps: { wall: () => START + offset } });
    expect(report).toMatchObject({ failure: 'deadline', providerRequests: 1, appRequests: 0 });
  });

  it('cancels before dispatch with no credential-bearing request', async () => {
    const controller = new AbortController(); controller.abort(PRIVATE);
    const { report, calls } = await trial(reply, { deps: { signal: controller.signal } });
    expect(report.failure).toBe('cancelled'); expect(calls).toHaveLength(0);
  });
});

describe('GATE-1 native transport and bounded input', () => {
  const spec = { hostname: 'not-used.example', path: '/', method: 'GET', headers: {}, bytes: 10 };

  it.each([
    ['response_headers', { rawHeaders: ['Content-Type', 'text/plain', 'content-type', 'text/plain'] }],
    ['response_headers', { rawHeaders: ['Content-Type'] }],
    ['response_encoding', { headers: { 'content-encoding': 'gzip' } }],
    ['cookie_contract', { headers: { 'set-cookie': PRIVATE } }],
    ['response_size', { headers: { 'content-length': '11' } }],
    ['response_size', { chunks: [Buffer.alloc(6), Buffer.alloc(5)] }],
    ['response_incomplete', { complete: false, body: 'ok' }],
    ['response_incomplete', { earlyClose: true }],
    ['response_incomplete', { aborted: true }],
    ['response_incomplete', { headers: { 'content-length': '3' }, body: 'ok' }],
    ['transport', { error: true }],
  ])('rejects %s and destroys owned streams (%#)', async (code, response) => {
    const wire = transport(() => response);
    await expect(exchange(spec, { requestImpl: wire.requestImpl, timeoutMs: 1000 })).rejects.toThrow(code);
    expect(wire.requests[0].destroy).toHaveBeenCalled();
    if (wire.responses.length) expect(wire.responses[0].destroy).toHaveBeenCalled();
    expect(wire.requestImpl).toHaveBeenCalledTimes(1);
  });

  it('uses an absolute timeout even when DNS/headers never arrive', async () => {
    jest.useFakeTimers();
    try {
      const wire = transport(() => ({ hang: true }));
      const pending = exchange(spec, { requestImpl: wire.requestImpl, timeoutMs: 10 });
      const expected = expect(pending).rejects.toThrow('deadline');
      await jest.advanceTimersByTimeAsync(10);
      await expected;
      expect(wire.requests[0].destroy).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  it('cancels an in-flight request and ignores a later raw error', async () => {
    const wire = transport(() => ({ hang: true }));
    const controller = new AbortController();
    const pending = exchange(spec, { requestImpl: wire.requestImpl, timeoutMs: 1000, signal: controller.signal });
    controller.abort(PRIVATE);
    await expect(pending).rejects.toThrow('cancelled');
    expect(() => wire.requests[0].emit('error', new Error(PRIVATE))).not.toThrow();
    expect(wire.requests[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('contains synchronous transport failures', async () => {
    await expect(exchange(spec, { requestImpl: () => { throw new Error(PRIVATE); }, timeoutMs: 1000 }))
      .rejects.toThrow('transport');
  });

  it('bounds stdin and rejects malformed envelopes without retaining contents', async () => {
    const valid = new PassThrough(); const decoded = readInput(valid); valid.end('{"fixture":true}');
    expect(await decoded).toEqual({ fixture: true });
    for (const text of ['invalid-private-json', 'x'.repeat(LIMITS.inputBytes + 1)]) {
      const stream = new PassThrough(); const pending = readInput(stream); stream.end(text);
      await expect(pending).rejects.toThrow('input');
    }
  });
});

/** Quote synthetic fixture strings as literal PowerShell data, never as executable expressions. */
function psLiteral(value) { return `'${value.replace(/'/g, "''")}'`; }

/**
 * Dot-source the real launcher but replace its child process and hidden prompts.
 * This exercises live envelope/approval sequencing without launching live Node.
 * The sole temporary file is a synthetic profile removed after the subprocess.
 */
function launcherFixture(approvalMatches) {
  const directory = path.resolve(__dirname, '../../../.tmp');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `source-discovery-fixture-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(profile()), { flag: 'wx' });
  const digest = approvalId(profile());
  const script = [
    `. ${psLiteral(LAUNCHER)} -Live -ProfilePath ${psLiteral(file)} -Approval ${psLiteral(approvalMatches ? digest : '0'.repeat(64))}`,
    '$script:promptCount = 0; $script:dispatchCount = 0',
    '# Synthetic hidden-input replacement; no actual credentials are requested.',
    'function Read-Gate1DiscoverySecret([string]$Prompt) {',
    '  $script:promptCount++',
    `  if ($script:promptCount -eq 1) { return ${psLiteral(SECRET)} }`,
    `  return ${psLiteral(TOKEN)}`,
    '}',
    '# Replaces every subprocess call; no native HTTP or live Node is invoked.',
    'function Invoke-Gate1DiscoveryNode([string]$Mode, [string]$InputJson) {',
    `  if ($Mode -eq '--review') { return @{ Json = ${psLiteral(JSON.stringify(preparation(profile())))}; ExitCode = 0 } }`,
    '  $script:dispatchCount++',
    '  $envelope = $InputJson | ConvertFrom-Json',
    `  if ($Mode -ne '--live' -or $envelope.approval -cne ${psLiteral(digest)} -or`,
    `    $envelope.credentials.probeSecret -cne ${psLiteral(SECRET)} -or`,
    `    $envelope.credentials.providerToken -cne ${psLiteral(TOKEN)} -or`,
    `    $envelope.profile.nextBuildId -cne 'FixtureBuild') { throw 'Fixture envelope failed.' }`,
    '  return @{ Json = \'{"fixture":true}\'; ExitCode = 13 }',
    '}',
    'try {',
    '  $result = Invoke-Gate1SourceDiscovery',
    '  if ($script:promptCount -ne 2 -or $script:dispatchCount -ne 1) { throw "Fixture sequence failed." }',
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

describe('GATE-1 discovery CLI and PowerShell offline modes', () => {
  it('prepares, templates and reviews without networking or credential prompts', () => {
    for (const mode of ['--prepare', '--template', '--review']) {
      const child = spawnSync(process.execPath, [CLI, mode], { encoding: 'utf8',
        input: mode === '--review' ? JSON.stringify(profile()) : undefined });
      expect(child.status).toBe(0);
      const output = JSON.parse(child.stdout);
      if (mode === '--template') expect(output).toEqual(profileTemplate());
      else expect(output).toMatchObject({ mode: 'prepare', appRequests: 0, providerRequests: 0, liveApproved: false });
    }
  });

  it('rejects unknown modes and extra secret-like arguments without echoing them', () => {
    const child = spawnSync(process.execPath, [CLI, '--live', PRIVATE], { encoding: 'utf8' });
    expect(child.status).toBe(1);
    expect(child.stdout + child.stderr).not.toContain(PRIVATE);
  });

  (process.platform === 'win32' ? it : it.skip)('PowerShell default and template modes are offline', () => {
    for (const args of [[], ['-Template']]) {
      const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', LAUNCHER, ...args], { encoding: 'utf8' });
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout);
      if (args.length) expect(result).toEqual(profileTemplate());
      else expect(result).toMatchObject({ mode: 'prepare', appRequests: 0, providerRequests: 0 });
    }
  });

  (process.platform === 'win32' ? it : it.skip)('PowerShell refuses live without a reviewed profile before hidden prompts', () => {
    const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', LAUNCHER, '-Live'], { encoding: 'utf8' });
    expect(child.status).toBe(1);
    expect(child.stdout).not.toContain('Report');
    expect(child.stderr).toContain('No automatic retry');
  });

  (process.platform === 'win32' ? it : it.skip)('PowerShell uses a credential envelope only after matching review and preserves failure exit codes', () => {
    const child = launcherFixture(true);
    expect(child.status).toBe(13);
    expect(JSON.parse(child.stdout)).toEqual({ fixture: true });
    expect(child.stdout + child.stderr).not.toContain(SECRET);
    expect(child.stdout + child.stderr).not.toContain(TOKEN);
  });

  (process.platform === 'win32' ? it : it.skip)('PowerShell rejects a mismatched approval before prompting or live dispatch', () => {
    const child = launcherFixture(false);
    expect(child.status).toBe(9);
    expect(child.stdout.trim()).toBe('stopped_before_prompts');
  });
});
