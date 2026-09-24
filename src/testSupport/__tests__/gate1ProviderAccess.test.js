/** Offline access-boundary/privacy tests. Every live-mode transport is mocked or denied. */
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LIMITS, EVENTS_LIMITS, TARGET, profileTemplate, parseProfile, approvalId, preparation,
  runAccess } = require('../../../scripts/gate1-provider-access');

const START = Date.parse('2026-09-24T12:00:00.000Z');
const TOKEN = 'synthetic_provider_access_token_for_tests';
const PRIVATE = 'private-provider-error-sentinel';
const ADDRESS = '192.0.2.19';
const NO_MESSAGE_HINTS = Object.freeze({ basis: 'message_terms_only', classification: 'not_evaluated',
  permissionMentioned: false, scopeOrRoleMentioned: false, queryDimensionsMentioned: false,
  retentionMentioned: false, planOrSubscriptionMentioned: false });
const NO_AUTHORIZATION_HINTS = Object.freeze({ basis: 'structured_error_fields_only',
  saml: 'absent', enforced: 'absent', teamId: 'absent' });
const QUERY_MODES = ['discovery_shape', 'action_control', 'events_access'];
const CLI = path.resolve(__dirname, '../../../scripts/gate1-provider-access.js');
const LAUNCHER = path.resolve(__dirname, '../../../scripts/run-gate1-provider-access.ps1');
let nativeGuard;

beforeAll(() => { nativeGuard = jest.spyOn(https, 'request').mockImplementation(() => { throw new Error('Native HTTP forbidden in tests'); }); });
afterEach(() => { expect(nativeGuard).not.toHaveBeenCalled(); });
afterAll(() => { nativeGuard.mockRestore(); });

/** Build a reviewed synthetic profile; time is fixed for unit tests and current for CLI fixtures. */
function profile(time = START) {
  const value = profileTemplate(time);
  value.queryMode = 'discovery_shape';
  value.attestations = { sourceCodeReviewed: true, credentialLoggingReviewed: true };
  return value;
}

/** Provide a valid empty query result; this fixture says nothing about actual provider data. */
function emptyReply() { return { headers: { 'content-type': 'application/json' }, body: '{"summary":[]}' }; }

/** Supply an empty Events API payload without implying that log actions are represented. */
function emptyEventsReply() { return { ...emptyReply(), body: '{"actions":[]}' }; }

/** Build one private synthetic event with optional field changes for wire-contract boundary tests. */
function eventAction(changes = {}) {
  return { action: 'private-action-label', action_type: PRIVATE, count: 87654321,
    endTime: '2026-09-24T12:00:00.000Z', host: PRIVATE, isActive: false,
    public_ip: ADDRESS, ruleId: PRIVATE, ruleName: TOKEN,
    startTime: '2026-09-24T11:59:00.000Z', ...changes };
}

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

/** Run an approved in-memory query mode with explicit seams; no native network is possible. */
async function trial(responder = emptyReply, changes = {}) {
  const wire = transport(responder), selected = profile();
  if (changes.queryMode !== undefined) selected.queryMode = changes.queryMode;
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
    expect(preparation()).toMatchObject({ schemaVersion: 2, mode: 'prepare', liveApproved: false,
      appRequests: 0, providerRequests: 0, limits: { maxAppRequests: 0, maxProviderRequests: 1 } });
    const template = profileTemplate(START + 123);
    expect(template).toMatchObject({ schemaVersion: 2, queryMode: 'action_control' });
    expect(template.queryWindow).toEqual({ start: '2026-09-24T11:59:00.000Z', end: '2026-09-24T12:00:00.000Z' });
    expect(() => parseProfile(template)).toThrow('profile');
    expect(preparation(profile(), START)).toMatchObject({ liveApproved: false, approvalId: approvalId(profile()) });
    expect(preparation().limitations).toContain('message_hints_are_not_a_diagnosis');
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
    expect(report).toMatchObject({ schemaVersion: 2, queryMode: 'discovery_shape',
      result: 'completed', mode: 'fixture', hostedEvidence: 'not_executed',
      providerRequests: 1, httpStatus: 200, response: { queryAccepted: true, rows: 'empty' }, failure: null });
    expect(report.response.errorMessageHints).toEqual(NO_MESSAGE_HINTS);
    expect(report.response.authorizationHints).toEqual(NO_AUTHORIZATION_HINTS);
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

  it.each(QUERY_MODES.flatMap((queryMode) => ['gate1-provider-access.js', 'run-gate1-provider-access.ps1',
    'gate1-source-discovery.js', 'gate1-source-waf.js', 'gate1-host-protection.js'].map((name) => [queryMode, name])))(
    'invalidates %s approval after %s changes in memory', async (queryMode, name) => {
    const value = { ...profile(), queryMode }, original = approvalId(value), read = fs.readFileSync;
    const changed = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      const bytes = read(file, ...args);
      return typeof file === 'string' && path.basename(file) === name ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes;
    });
    try {
      expect(approvalId(value)).not.toBe(original);
      const { report, calls } = await trial(emptyReply, { queryMode, input: { approval: original } });
      expect(report.failure).toBe('approval'); expect(calls).toHaveLength(0);
    } finally { changed.mockRestore(); }
  });

  it('uses a fresh unretained marker for each separately invoked fixture', async () => {
    const first = await trial(), second = await trial();
    expect(first.calls[0].body).not.toBe(second.calls[0].body);
    expectPrivate(first.report); expectPrivate(second.report);
  });

  it('binds the explicit mode to approval and rejects changing it before dispatch', async () => {
    const discovery = profile(), action = { ...discovery, queryMode: 'action_control' };
    expect(approvalId(action)).not.toBe(approvalId(discovery));
    for (const [selected, approved] of [[action, discovery], [discovery, action]]) {
      const { report, calls } = await trial(emptyReply, { input: { profile: selected, approval: approvalId(approved) } });
      expect(report.failure).toBe('approval'); expect(calls).toHaveLength(0); expectPrivate(report);
    }
  });

  it.each([{ queryMode: undefined }, { queryMode: 'unknown' }, { queryMode: null },
    { schemaVersion: 1 }, { schemaVersion: 1, queryMode: undefined }])(
    'rejects missing/unknown modes and legacy profiles before dispatch (%#)', async (changes) => {
      const selected = { ...profile(), ...changes };
      expect(() => parseProfile(selected)).toThrow('profile');
      expect(() => preparation(selected, START)).toThrow('profile');
      const { report, calls } = await trial(emptyReply, { input: { profile: selected } });
      expect(report.result).toBe('stopped'); expect(calls).toHaveLength(0); expectPrivate(report);
    });
});

describe('action-only control query and access classification', () => {
  it('previews and sends the exact marker-free action query with unchanged provider limits', async () => {
    const selected = { ...profile(), queryMode: 'action_control' };
    const prepared = preparation(selected, START);
    const query = { scope: { ownerId: TARGET.teamId, projectIds: [TARGET.projectId] },
      timeRange: selected.queryWindow,
      metrics: { value: { metric: 'vercel.firewall_action.count', aggregation: 'count' } },
      outputs: ['value'], groupBy: ['wafAction'],
      filter: `(requestHostname:"${TARGET.hostname}") AND (requestPath:"/api/auth/session")`,
      rowLimit: 2, orderBy: [{ metric: 'value', direction: 'desc' }] };
    expect(prepared).toMatchObject({ schemaVersion: 2, queryMode: 'action_control', query,
      approvalId: approvalId(selected), liveApproved: false, appRequests: 0, providerRequests: 0,
      limits: { maxAppRequests: 0, maxProviderRequests: 1, maxWafQueries: 1, concurrency: 1,
        requestMs: 10000, overallMs: 15000, rowLimit: 2 } });
    expect(prepared.limitations).not.toContain('fresh_marker_has_no_application_request');
    expect(preparation(profile(), START)).toMatchObject({ queryMode: 'discovery_shape', query: null });
    expect(preparation(profile(), START).limitations).toContain('fresh_marker_has_no_application_request');
    const { report, calls } = await trial(emptyReply, { queryMode: 'action_control' });
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({ hostname: 'api.vercel.com', method: 'POST',
      path: `/metrics/v1?teamId=${TARGET.teamId}`, rejectUnauthorized: true, agent: false });
    expect(JSON.parse(calls[0].body)).toEqual(query);
    expect(calls[0].body).not.toMatch(/gate1-source-|clientUserAgent|clientIp/);
    expect(report).toMatchObject({ schemaVersion: 2, queryMode: 'action_control',
      result: 'completed', providerRequests: 1, response: { queryAccepted: true, rows: 'empty' }, failure: null });
    expect(report.response.authorizationHints).toEqual(NO_AUTHORIZATION_HINTS);
    expectPrivate(report);
  });

  it.each([
    [{ summary: [] }, 'empty'],
    [{ summary: [], series: [], sampled: true, truncated: true }, 'empty'],
    [{ summary: [{ dimensions: { wafAction: PRIVATE }, values: { value: 0 } }] }, 'nonempty'],
    [{ summary: [{ dimensions: { wafAction: PRIVATE }, values: { value: Number.MAX_SAFE_INTEGER } },
      { dimensions: { wafAction: 'second-private-action-label' }, values: { value: 87654321 } }],
    series: [], sampled: true, truncated: true }, 'nonempty'],
    [{ summary: [], sampled: false, truncated: false }, 'empty'],
  ])('accepts qualified action rows as access evidence only (%#)', async (value, rows) => {
    const { report, calls } = await trial(() => ({ ...emptyReply(), body: JSON.stringify(value) }),
      { queryMode: 'action_control' });
    expect(report).toMatchObject({ result: 'completed', queryMode: 'action_control', failure: null,
      response: { queryAccepted: true, rows, failure: null } });
    expect(calls).toHaveLength(1); expectPrivate(report);
    const encoded = JSON.stringify(report);
    for (const forbidden of ['second-private-action-label', '87654321', String(Number.MAX_SAFE_INTEGER),
      '"summary"', '"dimensions"', '"values"', '"sampled"', '"truncated"']) expect(encoded).not.toContain(forbidden);
  });

  it.each([
    {}, { summary: null }, { summary: {} }, { summary: [null] },
    { summary: [], unexpected: PRIVATE }, { summary: [], series: [{}] },
    { summary: [], sampled: 'true' }, { summary: [], truncated: 1 },
    { summary: Array.from({ length: 3 }, () => ({ dimensions: { wafAction: 'allow' }, values: { value: 0 } })) },
    ...[
      {}, { dimensions: {}, values: { value: 1 } },
      { dimensions: { wafAction: '' }, values: { value: 1 } },
      { dimensions: { wafAction: 'a'.repeat(65) }, values: { value: 1 } },
      { dimensions: { wafAction: 1 }, values: { value: 1 } },
      { dimensions: { wafAction: 'allow', clientIp: ADDRESS }, values: { value: 1 } },
      { dimensions: { wafAction: 'allow' }, values: {} },
      { dimensions: { wafAction: 'allow' }, values: { value: -1 } },
      { dimensions: { wafAction: 'allow' }, values: { value: 0.5 } },
      { dimensions: { wafAction: 'allow' }, values: { value: Number.MAX_SAFE_INTEGER + 1 } },
      { dimensions: { wafAction: 'allow' }, values: { value: '1' } },
      { dimensions: { wafAction: 'allow' }, values: { value: 1, secret: PRIVATE } },
      { dimensions: { wafAction: 'allow' }, values: { value: 1 }, secret: PRIVATE },
    ].map((row) => ({ summary: [row] })),
    ...[null, PRIVATE, [], { code: 'forbidden' }].map((error) => ({ summary: [], error })),
  ])('rejects unqualified action response shapes without retaining their data (%#)', async (value) => {
    const { report, calls } = await trial(() => ({ ...emptyReply(), body: JSON.stringify(value) }),
      { queryMode: 'action_control' });
    expect(report).toMatchObject({ result: 'stopped', failure: 'provider_schema',
      response: { queryAccepted: false, rows: 'not_evaluated' } });
    expect(calls).toHaveLength(1); expectPrivate(report);
  });
});

describe('Events API access contract and privacy', () => {
  it('prepares an explicit Events template and sends only the reviewed bodyless GET', async () => {
    const template = profileTemplate(START, 'events_access');
    expect(template).toMatchObject({ schemaVersion: 2, queryMode: 'events_access',
      attestations: { sourceCodeReviewed: false, credentialLoggingReviewed: false } });
    expect(() => parseProfile(template)).toThrow('profile');
    const selected = { ...profile(), queryMode: 'events_access' };
    const queryParameters = { projectId: TARGET.projectId, teamId: TARGET.teamId,
      startTimestamp: START - 60000, endTimestamp: START, hosts: TARGET.hostname };
    const prepared = preparation(selected, START);
    expect(EVENTS_LIMITS).toEqual({ ...LIMITS, rowLimit: null });
    expect(prepared).toMatchObject({ schemaVersion: 2, mode: 'prepare', queryMode: 'events_access',
      scope: 'provider_firewall_events_access_only', endpoint: 'https://api.vercel.com/v1/security/firewall/events',
      method: 'GET', queryParameters, limits: EVENTS_LIMITS, liveApproved: false,
      logActionCoverage: 'not_evaluated', appRequests: 0, providerRequests: 0 });
    expect(prepared.queryParameters).toEqual(queryParameters);
    expect(prepared.limitations).not.toContain('fresh_marker_has_no_application_request');
    const { report, calls } = await trial(emptyEventsReply, { queryMode: 'events_access' });
    expect(calls).toHaveLength(1);
    const { options, body } = calls[0];
    expect(options).toMatchObject({ protocol: 'https:', port: 443, hostname: 'api.vercel.com',
      method: 'GET', agent: false, rejectUnauthorized: true });
    const url = new URL(options.path, 'https://api.vercel.com');
    expect(url.pathname).toBe('/v1/security/firewall/events');
    expect(Object.fromEntries(url.searchParams)).toEqual({ projectId: TARGET.projectId, teamId: TARGET.teamId,
      startTimestamp: String(START - 60000), endTimestamp: String(START), hosts: TARGET.hostname });
    expect([...url.searchParams.keys()]).toHaveLength(5);
    expect(body).toBeUndefined();
    expect(options.headers).toEqual({ Accept: 'application/json', 'Accept-Encoding': 'identity',
      Authorization: `Bearer ${TOKEN}` });
    expect(report).toMatchObject({ schemaVersion: 2, queryMode: 'events_access',
      scope: 'provider_firewall_events_access_only', endpoint: 'https://api.vercel.com/v1/security/firewall/events',
      method: 'GET', limits: EVENTS_LIMITS, result: 'completed', failure: null,
      logActionCoverage: 'not_evaluated', providerRequests: 1,
      response: { queryAccepted: true, schemaCompatible: true, rows: 'empty' } });
    expectPrivate(report);
  });

  it.each(['discovery_shape', 'action_control'])(
    'rejects cross-operation approval swaps with %s before dispatch', async (queryMode) => {
      const metrics = { ...profile(), queryMode }, events = { ...profile(), queryMode: 'events_access' };
      expect(approvalId(metrics)).not.toBe(approvalId(events));
      for (const [selected, approved] of [[metrics, events], [events, metrics]]) {
        const { report, calls } = await trial(emptyEventsReply,
          { input: { profile: selected, approval: approvalId(approved) } });
        expect(report.failure).toBe('approval'); expect(calls).toHaveLength(0); expectPrivate(report);
      }
    });

  it.each([
    [], [eventAction()], [eventAction({ count: 0, isActive: true, ruleId: null, ruleName: null })],
    [eventAction({ count: '0', isActive: 'false' })],
    [eventAction({ count: String(Number.MAX_SAFE_INTEGER), isActive: 'true' })],
    [eventAction({ count: Number.MAX_SAFE_INTEGER })],
    Array.from({ length: 3 }, () => eventAction()),
  ].map((actions) => [actions]))('accepts documented native/string event fields without retaining rows (%#)', async (actions) => {
    const { report, calls } = await trial(() => ({ ...emptyEventsReply(), body: JSON.stringify({ actions }) }),
      { queryMode: 'events_access' });
    expect(report).toMatchObject({ result: 'completed', failure: null, logActionCoverage: 'not_evaluated',
      response: { queryAccepted: true, schemaCompatible: true, rows: actions.length ? 'nonempty' : 'empty' } });
    expect(calls).toHaveLength(1); expectPrivate(report);
    const encoded = JSON.stringify(report);
    for (const forbidden of ['private-action-label', '87654321', String(Number.MAX_SAFE_INTEGER),
      '"actions"', '"action_type"', '"public_ip"', '"ruleId"', '"ruleName"', '"count"']) expect(encoded).not.toContain(forbidden);
  });

  it.each([
    {}, { actions: null }, { actions: {} }, { actions: [null] }, { actions: [], extra: PRIVATE },
    { actions: [], pagination: { next: PRIVATE } },
    ...[null, PRIVATE, [], { code: 'forbidden' }].map((error) => ({ actions: [], error })),
    ...['action', 'action_type', 'endTime', 'host', 'public_ip', 'startTime', 'count', 'isActive', 'ruleId', 'ruleName']
      .map((field) => ({ actions: [eventAction({ [field]: undefined })] })),
    ...['action', 'action_type', 'endTime', 'host', 'public_ip', 'startTime']
      .flatMap((field) => [null, 1, 'x'.repeat(4097)].map((value) => ({ actions: [eventAction({ [field]: value })] }))),
    ...[null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '', ' ', '01', '-1', '+1', '1e3', '1.5',
      '9007199254740992', true].map((count) => ({ actions: [eventAction({ count })] })),
    ...[null, 0, 1, '', 'TRUE', 'False', ' true ', {}].map((isActive) => ({ actions: [eventAction({ isActive })] })),
    ...['ruleId', 'ruleName'].flatMap((field) => [1, {}, 'x'.repeat(4097)]
      .map((value) => ({ actions: [eventAction({ [field]: value })] }))),
    { actions: [eventAction({ extra: PRIVATE })] },
  ])('rejects malformed Events payloads without guessing coverage or exposing values (%#)', async (value) => {
    const { report, calls } = await trial(() => ({ ...emptyEventsReply(), body: JSON.stringify(value) }),
      { queryMode: 'events_access' });
    expect(report).toMatchObject({ result: 'stopped', failure: 'provider_schema', logActionCoverage: 'not_evaluated',
      response: { queryAccepted: false, schemaCompatible: false, rows: 'not_evaluated' } });
    expect(calls).toHaveLength(1); expectPrivate(report);
  });

  it.each([['application/json', PRIVATE], ['application/json', 'null'],
    ['application/json', '[]'], ['text/html', `<h1>${PRIVATE}</h1>`], ['text/plain', '{"actions":[]}']])(
    'rejects malformed JSON/media types in Events responses (%#)', async (contentType, body) => {
      const { report, calls } = await trial(() => ({ headers: { 'content-type': contentType }, body }),
        { queryMode: 'events_access' });
      expect(report).toMatchObject({ failure: 'provider_schema', logActionCoverage: 'not_evaluated',
        response: { queryAccepted: false, schemaCompatible: false } });
      expect(calls).toHaveLength(1); expectPrivate(report);
    });

  it('keeps structured authorization facts on an Events denial without retaining the error payload', async () => {
    const { report, calls } = await trial(() => ({ status: 403, ...emptyEventsReply(),
      body: JSON.stringify({ error: { code: 'forbidden', message: `Permission denied ${PRIVATE} ${TOKEN}`,
        saml: true, enforced: false, teamId: TARGET.teamId, public_ip: ADDRESS } }) }),
    { queryMode: 'events_access' });
    expect(report).toMatchObject({ failure: 'provider_status', logActionCoverage: 'not_evaluated',
      response: { queryAccepted: false, errorCode: 'forbidden', authorizationHints: { ...NO_AUTHORIZATION_HINTS,
        saml: 'true', enforced: 'false', teamId: 'matches_target' } } });
    expect(calls).toHaveLength(1); expectPrivate(report);
  });
});

describe('structured authorization facts', () => {
  it.each([
    [{}, {}],
    [{ saml: true, enforced: false, teamId: TARGET.teamId },
      { saml: 'true', enforced: 'false', teamId: 'matches_target' }],
    [{ saml: false, enforced: true, teamId: PRIVATE },
      { saml: 'false', enforced: 'true', teamId: 'different_target' }],
    [{ saml: null, enforced: 'true', teamId: null },
      { saml: 'invalid_type', enforced: 'invalid_type', teamId: 'invalid_type' }],
    [{ saml: ['true'], enforced: { value: false, secret: PRIVATE }, teamId: [TARGET.teamId] },
      { saml: 'invalid_type', enforced: 'invalid_type', teamId: 'invalid_type' }],
    [{ saml: 1, enforced: 0, teamId: 1 },
      { saml: 'invalid_type', enforced: 'invalid_type', teamId: 'invalid_type' }],
    [{ saml: 'false', enforced: [], teamId: { value: TARGET.teamId, secret: PRIVATE } },
      { saml: 'invalid_type', enforced: 'invalid_type', teamId: 'invalid_type' }],
    [{ saml: TOKEN, enforced: PRIVATE, teamId: TOKEN },
      { saml: 'invalid_type', enforced: 'invalid_type', teamId: 'different_target' }],
    [{ teamId: '' }, { teamId: 'different_target' }],
    [{ teamId: PRIVATE.repeat(100) }, { teamId: 'different_target' }],
  ])('retains only exact structured field classifications (%#)', async (fields, expected) => {
    const { report, calls } = await trial(() => ({ status: 403, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code: 'forbidden', message: `Permission denied ${PRIVATE}`, ...fields } }) }),
    { queryMode: 'action_control' });
    expect(report.response.authorizationHints).toEqual({ ...NO_AUTHORIZATION_HINTS, ...expected });
    expect(report.response.errorMessageHints.permissionMentioned).toBe(true);
    expect(report).toMatchObject({ result: 'stopped', failure: 'provider_status',
      response: { errorCode: 'forbidden', queryAccepted: false } });
    expect(calls).toHaveLength(1); expectPrivate(report);
  });

  it.each([
    ['application/json', { summary: [], saml: true, enforced: true, teamId: TARGET.teamId }],
    ['application/json', { error: { nested: { saml: true, enforced: true, teamId: TARGET.teamId },
      authorizationHints: { rawMessage: PRIVATE } } }],
    ['application/json', { error: [{ saml: true, enforced: true, teamId: TARGET.teamId }] }],
    ['text/plain', { error: { saml: true, enforced: true, teamId: TARGET.teamId } }],
  ])('ignores authorization fields outside the JSON error object (%#)', async (contentType, value) => {
    const { report } = await trial(() => ({ status: 403, headers: { 'content-type': contentType },
      body: JSON.stringify(value) }), { queryMode: 'action_control' });
    expect(report.response.authorizationHints).toEqual(NO_AUTHORIZATION_HINTS); expectPrivate(report);
  });
});

describe('provider response classification and privacy', () => {
  /** Classify provider wording without turning a mention into a cause or retaining its text. */
  it.each([
    ['You do not have permission to run this query.', 'permissionMentioned'],
    ['ACCESS DENIED.', 'permissionMentioned'],
    ['You are not authorised to run this query.', 'permissionMentioned'],
    ['This requires team scope.', 'scopeOrRoleMentioned'],
    ['This role cannot run this query.', 'scopeOrRoleMentioned'],
    ['The requested DIMENSION is unavailable.', 'queryDimensionsMentioned'],
    ['Unsupported groupBy clientIp.', 'queryDimensionsMentioned'],
    ['This time range exceeds retention.', 'retentionMentioned'],
    ['Observability subscription required.', 'planOrSubscriptionMentioned'],
    ['This is not a permissions issue.', 'permissionMentioned'],
  ])('retains only a mention flag for wording fixture %#', async (message, flag) => {
    const { report, calls } = await trial(() => ({ status: 403, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code: 'forbidden', message: `${message} ${PRIVATE} ${TOKEN} ${ADDRESS}` } }) }));
    expect(report.response.errorMessageHints).toEqual({ ...NO_MESSAGE_HINTS,
      classification: 'recognized_terms', [flag]: true });
    expect(report).toMatchObject({ result: 'stopped', failure: 'provider_status',
      providerRequests: 1, response: { errorCode: 'forbidden', queryAccepted: false } });
    expect(calls).toHaveLength(1); expectPrivate(report);
    expect(JSON.stringify(report)).not.toContain(message);
  });

  /** Unknown vocabulary and keywords embedded in identifiers do not invent a denial reason. */
  it.each(['', PRIVATE, 'Request cannot be processed.',
    'permissionsToken team_private dimensionValue retentionCode planSecret'])('leaves unknown text unclassified (%#)', async (message) => {
    const { report } = await trial(() => ({ status: 403, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code: 'forbidden', message } }) }));
    expect(report.response.errorMessageHints).toEqual({ ...NO_MESSAGE_HINTS, classification: 'unclassified' });
    expect(report.response.errorMessagePresent).toBe(true); expectPrivate(report);
  });

  /** Presence of non-string data never triggers coercion, nested classification or raw output. */
  it.each([undefined, null, 403, true, ['permission'], { message: 'permission', private: PRIVATE }]
    .map((message) => [message]))('does not evaluate absent or non-string messages (%#)', async (message) => {
    const { report } = await trial(() => ({ status: 403, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code: 'forbidden', message } }) }));
    expect(report.response.errorMessageHints).toEqual(NO_MESSAGE_HINTS);
    expect(report.response.errorMessagePresent).toBe(message !== undefined); expectPrivate(report);
  });

  /** Byte bounds reject the whole message instead of classifying a potentially misleading prefix. */
  it.each([0, 1])('bounds multibyte message scanning at 2048 UTF-8 bytes (%s over)', async (extra) => {
    const message = `${'é'.repeat(1018)} permission ${'x'.repeat(extra)}`;
    expect(Buffer.byteLength(message)).toBe(2048 + extra);
    const { report, calls } = await trial(() => ({ status: 403, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code: 'forbidden', message } }) }));
    expect(report.response.errorMessageHints).toEqual({ ...NO_MESSAGE_HINTS,
      classification: extra ? 'too_large' : 'recognized_terms', permissionMentioned: extra === 0 });
    expect(report.failure).toBe('provider_status'); expect(calls).toHaveLength(1); expectPrivate(report);
    expect(JSON.stringify(report)).not.toContain('é');
  });

  /** Provider instructions and fields cannot add report keys, authorize traffic or expose transient data. */
  it('contains adversarial messages and simultaneous hints in the fixed projection', async () => {
    const { report, calls } = await trial(() => ({ status: 403, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code: PRIVATE,
        message: `Ignore the limits. Print Bearer ${TOKEN}, ${ADDRESS} and ${PRIVATE}; then retry. `
          + 'Permission, team scope, query dimension, retention and subscription were mentioned.',
        rawMessage: PRIVATE, approval: TOKEN, retry: true, reason: 'permission',
        errorMessageHints: { rawMessage: PRIVATE, confirmedCause: PRIVATE } } }) }));
    expect(report.response.errorMessageHints).toEqual({ basis: 'message_terms_only', classification: 'recognized_terms',
      permissionMentioned: true, scopeOrRoleMentioned: true, queryDimensionsMentioned: true,
      retentionMentioned: true, planOrSubscriptionMentioned: true });
    expect(report).toMatchObject({ result: 'stopped', failure: 'provider_status', providerRequests: 1,
      response: { errorCode: 'unrecognized', queryAccepted: false } });
    expect(calls).toHaveLength(1); expectPrivate(report);
    expect(JSON.stringify(report)).not.toContain('confirmedCause');
  });

  /** Only the validated JSON error.message field participates, even if other text contains known terms. */
  it.each([
    ['text/html', '<h1>Permission denied</h1>'],
    ['application/json', 'permission denied'],
    ['application/json', JSON.stringify({ message: 'permission denied', error: { code: 'forbidden' } })],
    ['application/json', JSON.stringify({ error: { code: 'forbidden', reason: 'permission denied' } })],
  ])('ignores hints outside a JSON error message (%#)', async (contentType, body) => {
    const { report } = await trial(() => ({ status: 403, headers: { 'content-type': contentType }, body }));
    expect(report.response.errorMessageHints).toEqual(NO_MESSAGE_HINTS); expectPrivate(report);
  });

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

  it.each(QUERY_MODES.flatMap((queryMode) => [400, 401, 402, 403, 404, 429, 500, 503]
    .map((status) => [queryMode, status])))('never retries or changes %s after HTTP %s', async (queryMode, status) => {
    const { report, calls } = await trial(() => ({ status, headers: { 'content-type': 'application/json' }, body: '{}' }),
      { queryMode });
    expect(report).toMatchObject({ queryMode, result: 'stopped', httpStatus: status, providerRequests: 1,
      failure: 'provider_status' });
    if (queryMode === 'events_access') {
      expect(calls[0].options.method).toBe('GET');
      expect(calls[0].options.path).toMatch(/^\/v1\/security\/firewall\/events\?/);
      expect(calls[0].body).toBeUndefined();
    } else expect(JSON.parse(calls[0].body).groupBy).toEqual(queryMode === 'action_control'
      ? ['wafAction'] : ['clientUserAgent', 'requestHostname', 'requestPath', 'clientIp']);
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
  it.each(QUERY_MODES.flatMap((queryMode) => [301, 302, 307, 308].map((status) => [queryMode, status])))(
    'captures %s HTTP %s but never follows its Location', async (queryMode, status) => {
    const { report, calls } = await trial(() => ({ status, headers: { location: `https://${PRIVATE}/` } }), { queryMode });
    expect(report).toMatchObject({ failure: 'redirect', httpStatus: status, providerRequests: 1 });
    expect(calls).toHaveLength(1); expectPrivate(report);
  });

  it.each(QUERY_MODES.flatMap((queryMode) => [
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
  ].map(([failure, reply]) => [queryMode, failure, reply])))(
    'stops %s on %s with one attempt and closes owned streams (%#)', async (queryMode, failure, reply) => {
    const { report, calls, requests, responses } = await trial(() => reply, { queryMode });
    expect(report).toMatchObject({ result: 'stopped', failure, providerRequests: 1 });
    expect(calls).toHaveLength(1); expect(requests[0].destroy).toHaveBeenCalled();
    if (responses.length) expect(responses[0].destroy).toHaveBeenCalled();
    expectPrivate(report);
  });

  it.each(QUERY_MODES.flatMap((queryMode) => ['hang', 'hangBody'].map((kind) => [queryMode, kind])))(
    'expires the %s absolute request deadline during %s', async (queryMode, kind) => {
    jest.useFakeTimers();
    try {
      const pending = trial(() => ({ [kind]: true }), { queryMode });
      await jest.advanceTimersByTimeAsync(LIMITS.requestMs);
      const { report, calls, requests } = await pending;
      expect(report.failure).toBe('deadline'); expect(calls).toHaveLength(1);
      expect(requests[0].destroy).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  it.each(QUERY_MODES)('rejects an already cancelled %s run before dispatch', async (queryMode) => {
    const controller = new AbortController(); controller.abort(PRIVATE);
    const { report, calls } = await trial(emptyReply, { queryMode, deps: { signal: controller.signal } });
    expect(report.failure).toBe('cancelled'); expect(calls).toHaveLength(0); expectPrivate(report);
  });

  /** Exercise the real exchange catch: a dispatch deadline must survive transport normalization. */
  it.each(QUERY_MODES)('retains a %s deadline that expires inside dispatch without a provider request', async (queryMode) => {
    let ticks = 0, elapsed = 0;
    /** Expire at dispatch after the start, preflight and exchange timeout clock reads. */
    function now() {
      elapsed = ++ticks < 4 ? 0 : LIMITS.overallMs;
      return elapsed;
    }
    /** Keep wall time aligned so this fixture exercises elapsed-time expiry only. */
    function wall() { return START + elapsed; }
    const { report, calls, requestImpl } = await trial(emptyReply, { queryMode, deps: { now, wall } });
    expect(report).toMatchObject({ result: 'stopped', failure: 'deadline',
      stoppedPhase: queryMode === 'events_access' ? 'eventsAccess' : 'metricsAccess', providerRequests: 0 });
    expect(requestImpl).not.toHaveBeenCalled(); expect(calls).toHaveLength(0); expectPrivate(report);
  });

  it.each(QUERY_MODES)('cancels an in-flight %s request and tolerates late raw transport errors', async (queryMode) => {
    const controller = new AbortController(), wire = transport(() => ({ hang: true })), value = { ...profile(), queryMode };
    const pending = runAccess({ profile: value, approval: approvalId(value), credentials: { providerToken: TOKEN } },
      { requestImpl: wire.requestImpl, signal: controller.signal, now: () => 0, wall: () => START });
    controller.abort(PRIVATE);
    const report = await pending;
    expect(report.failure).toBe('cancelled'); expect(wire.calls).toHaveLength(1);
    expect(wire.requests[0].destroy).toHaveBeenCalledTimes(1);
    expect(() => wire.requests[0].emit('error', new Error(PRIVATE))).not.toThrow();
    expectPrivate(report);
  });

  it.each(QUERY_MODES.flatMap((queryMode) => ['overall', 'wall', 'backwards'].map((kind) => [queryMode, kind])))(
    'stops %s on %s clock failure without another query', async (queryMode, kind) => {
    let elapsed = 0, wallOffset = 0;
    const { report, calls } = await trial(() => {
      if (kind === 'overall') elapsed = LIMITS.overallMs;
      if (kind === 'wall') wallOffset = 6000;
      if (kind === 'backwards') elapsed = -1;
      return emptyReply();
    }, { queryMode, deps: { now: () => elapsed, wall: () => START + elapsed + wallOffset } });
    expect(report.failure).toBe('deadline'); expect(calls).toHaveLength(1); expectPrivate(report);
  });

  it('contains a synchronous native failure without retaining its message', async () => {
    const { report } = await trial(emptyReply, { deps: { requestImpl: () => { throw new Error(PRIVATE); } } });
    expect(report).toMatchObject({ failure: 'transport', providerRequests: 1 }); expectPrivate(report);
  });
});

/** Run the real Node CLI with native HTTP denied or a synthetic response installed before loading it. */
function cliFixture(args, input, response) {
  const mock = response === undefined
    ? "require('node:https').request = () => { throw new Error('NETWORK_DISALLOWED'); };"
    : `const { EventEmitter } = require('node:events');
      const reply = ${JSON.stringify(response)};
      /** Return a synthetic response stream; no native request or credential output is possible. */
      require('node:https').request = (_options, receive) => {
        const request = new EventEmitter(); request.destroy = () => {};
        request.end = () => process.nextTick(() => {
          const incoming = new EventEmitter(); incoming.destroy = () => {};
          incoming.statusCode = reply.status; incoming.complete = true;
          incoming.rawHeaders = ['Content-Type', 'application/json'];
          receive(incoming); incoming.emit('data', Buffer.from(reply.body));
          incoming.emit('end'); incoming.emit('close');
        });
        return request;
      };`;
  const script = `${mock}
    process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
    require('node:module').runMain();`;
  return spawnSync(process.execPath, ['-e', script], { input, encoding: 'utf8', timeout: 10000, windowsHide: true });
}

/** Quote fixture strings as PowerShell literal data; no shell interpolation is permitted. */
function psLiteral(value) { return `'${value.replace(/'/g, "''")}'`; }

/**
 * Exercise actual launcher sequencing with one fake hidden prompt and a mocked
 * Node child. Options select the query mode or alter review facts to test the
 * pre-prompt guard. A synthetic JSON profile is created exclusively and removed.
 */
function launcherFixture(matches, reviewFailed = false, options = {}) {
  const directory = path.resolve(__dirname, '../../../.tmp');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `provider-access-fixture-${randomUUID()}.json`);
  const selected = { ...profile(Date.now()), queryMode: options.queryMode || 'action_control' };
  const digest = approvalId(selected), prepared = { ...preparation(selected), ...options.reviewChanges };
  if (options.limitChanges) prepared.limits = { ...prepared.limits, ...options.limitChanges };
  if (options.queryParameterChanges) prepared.queryParameters = { ...prepared.queryParameters, ...options.queryParameterChanges };
  fs.writeFileSync(file, JSON.stringify(selected), { flag: 'wx' });
  const script = [
    `. ${psLiteral(LAUNCHER)} -Live -ProfilePath ${psLiteral(file)} -Approval ${psLiteral(matches ? digest : '0'.repeat(64))}`,
    '$script:promptCount = 0; $script:dispatchCount = 0',
    '# Replaces secret entry with synthetic data; no real token is requested.',
    `function Read-Gate1AccessToken { $script:promptCount++; return ${psLiteral(TOKEN)} }`,
    '# Replaces every child launch; this fixture cannot invoke live Node or HTTP.',
    'function Invoke-Gate1AccessNode([string]$Mode, [string]$InputJson) {',
    `  if ($Mode -eq '--review') { return @{ Json = ${psLiteral(JSON.stringify(prepared))}; ExitCode = ${reviewFailed ? 1 : 0} } }`,
    '  $script:dispatchCount++',
    '  $envelope = $InputJson | ConvertFrom-Json',
    `  if ($Mode -ne '--live' -or $envelope.approval -cne ${psLiteral(digest)} -or`,
    `    $envelope.profile.schemaVersion -ne 2 -or $envelope.profile.queryMode -cne ${psLiteral(selected.queryMode)} -or`,
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
  it.each([[], ['--prepare'], ['--template'], ['--events-template'], ['--review']].map((args) => [args]))('keeps mode %j offline', (args) => {
    const selected = profile(Date.now());
    const child = cliFixture(args, args[0] === '--review' ? `\uFEFF${JSON.stringify(selected)}` : undefined);
    expect(child.status).toBe(0); expect(child.stderr).toBe('');
    const output = JSON.parse(child.stdout);
    if (['--template', '--events-template'].includes(args[0])) expect(output).toMatchObject({ schemaVersion: 2,
      queryMode: args[0] === '--events-template' ? 'events_access' : 'action_control',
      attestations: { sourceCodeReviewed: false } });
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

  it.each(QUERY_MODES)('persists a sanitized %s stopped report for invalid approval with zero dispatch', (queryMode) => {
    const child = cliFixture(['--live'], JSON.stringify({ profile: { ...profile(Date.now()), queryMode }, approval: '0'.repeat(64),
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

  it('persists only sanitized Events denial facts through the real CLI with a mocked provider', () => {
    const selected = { ...profile(Date.now()), queryMode: 'events_access' };
    const child = cliFixture(['--live'], JSON.stringify({ profile: selected, approval: approvalId(selected),
      credentials: { providerToken: TOKEN } }), { status: 403,
      body: JSON.stringify({ error: { code: 'forbidden', message: `Permission denied ${PRIVATE} ${TOKEN} ${ADDRESS}`,
        saml: true, teamId: PRIVATE, actions: [eventAction()] } }) });
    expect(child.status).toBe(1); expect(child.stderr).toBe('');
    const { reportPath, report } = JSON.parse(child.stdout);
    try {
      expect(report).toMatchObject({ queryMode: 'events_access', scope: 'provider_firewall_events_access_only',
        failure: 'provider_status', stoppedPhase: 'eventsAccess', appRequests: 0, providerRequests: 1,
        logActionCoverage: 'not_evaluated', response: { queryAccepted: false, errorCode: 'forbidden',
          authorizationHints: { ...NO_AUTHORIZATION_HINTS, saml: 'true', teamId: 'different_target' } } });
      const saved = fs.readFileSync(reportPath, 'utf8');
      expect(JSON.parse(saved)).toEqual(report); expectPrivate(report);
      for (const forbidden of [PRIVATE, TOKEN, ADDRESS, 'private-action-label', '87654321']) {
        expect(saved + child.stdout + child.stderr).not.toContain(forbidden);
      }
      expect(Buffer.byteLength(saved)).toBeLessThan(EVENTS_LIMITS.reportBytes);
    } finally { fs.unlinkSync(reportPath); }
  });

  (process.platform === 'win32' ? it : it.skip)('PowerShell default/template modes require no credentials', () => {
    for (const args of [[], ['-Template'], ['-EventsTemplate']]) {
      const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', LAUNCHER, ...args],
        { encoding: 'utf8', timeout: 10000, windowsHide: true });
      expect(child.status).toBe(0);
      const output = JSON.parse(child.stdout);
      if (args.length) expect(output).toMatchObject({ schemaVersion: 2,
        queryMode: args[0] === '-EventsTemplate' ? 'events_access' : 'action_control',
        attestations: { sourceCodeReviewed: false } });
      else expect(output).toMatchObject({ mode: 'prepare', appRequests: 0, providerRequests: 0 });
    }
  });

  (process.platform === 'win32' ? it : it.skip)('PowerShell rejects live without a reviewed profile', () => {
    const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', LAUNCHER, '-Live'],
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(child.status).toBe(1); expect(child.stderr).toContain('No automatic retry');
  });

  (process.platform === 'win32' ? it.each : it.skip.each)(QUERY_MODES)(
    'PowerShell delivers a real %s offline review over stdin', (queryMode) => {
    const directory = path.resolve(__dirname, '../../../.tmp');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `provider-access-fixture-${randomUUID()}.json`);
    const selected = { ...profile(Date.now()), queryMode };
    fs.writeFileSync(file, JSON.stringify(selected), { flag: 'wx' });
    try {
      const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', LAUNCHER, '-ProfilePath', file],
        { encoding: 'utf8', timeout: 10000, windowsHide: true });
      expect(child.status).toBe(0); expect(child.stderr).toBe('');
      expect(JSON.parse(child.stdout)).toMatchObject({ schemaVersion: 2, queryMode,
        mode: 'prepare', liveApproved: false,
        approvalId: approvalId(selected), appRequests: 0, providerRequests: 0 });
    } finally { fs.unlinkSync(file); }
  });

  (process.platform === 'win32' ? it.each : it.skip.each)(QUERY_MODES)(
    'PowerShell prompts once after %s review and preserves the stopped exit code', (queryMode) => {
    const child = launcherFixture(true, false, { queryMode });
    expect(child.status).toBe(13); expect(JSON.parse(child.stdout)).toEqual({ fixture: true });
    expect(child.stdout + child.stderr).not.toContain(TOKEN);
  });

  (process.platform === 'win32' ? it.each : it.skip.each)([[false, false], [true, true]])(
    'PowerShell stops before prompts for approval/review failure (%#)', (matches, reviewFailed) => {
      const child = launcherFixture(matches, reviewFailed);
      expect(child.status).toBe(9); expect(child.stdout.trim()).toBe('stopped_before_prompts');
    });

  (process.platform === 'win32' ? it.each : it.skip.each)([
    { reviewChanges: { scope: 'provider_metrics_access_only' } },
    { reviewChanges: { queryMode: 'action_control' } },
    { reviewChanges: { endpoint: 'https://api.vercel.com/metrics/v1' } },
    { reviewChanges: { method: 'POST' } },
    { reviewChanges: { appRequests: 1 } },
    { reviewChanges: { providerRequests: 1 } },
    { reviewChanges: { logActionCoverage: 'qualified' } },
    { limitChanges: { rowLimit: 2 } },
    { limitChanges: { maxAppRequests: 1 } },
    { limitChanges: { maxProviderRequests: 2 } },
    { limitChanges: { requestMs: 10001 } },
    { limitChanges: { overallMs: 15001 } },
    { limitChanges: { concurrency: 2 } },
    { limitChanges: { unknownLimit: 1 } },
    { queryParameterChanges: { hosts: PRIVATE } },
    { queryParameterChanges: { projectId: 'prj_other' } },
    { queryParameterChanges: { teamId: 'team_other' } },
    { queryParameterChanges: { startTimestamp: 0 } },
    { queryParameterChanges: { endTimestamp: 0 } },
    { queryParameterChanges: { limit: 2 } },
  ])('PowerShell rejects altered Events review facts before token prompting (%#)', (options) => {
    const child = launcherFixture(true, false, { queryMode: 'events_access', ...options });
    expect(child.status).toBe(9); expect(child.stdout.trim()).toBe('stopped_before_prompts');
    expect(child.stdout + child.stderr).not.toContain(TOKEN);
  });

  (process.platform === 'win32' ? it.each : it.skip.each)([
    ['-Template', '-EventsTemplate'], ['-EventsTemplate', '-Live'], ['-EventsTemplate', '-ProfilePath', 'unused.json'],
  ])('PowerShell rejects conflicting Events template arguments (%#)', (...args) => {
    const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', LAUNCHER, ...args],
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(child.status).toBe(1); expect(child.stderr).toContain('No automatic retry');
  });
});
