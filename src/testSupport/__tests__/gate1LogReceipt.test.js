/** Offline Log receipt lifecycle tests; native HTTPS is independently denied. */
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { LIMITS, CONFIG_LIMITS, TARGET, profileTemplate, parseProfile, approvalId, preparation,
  diagnosticRule, reviewEvents, reviewConfigResponse, runReceipt, runConfigCheck } = require('../../../scripts/gate1-log-receipt');

const START = Date.parse('2026-09-24T12:00:00.000Z');
const TOKEN = 'synthetic_log_receipt_provider_token';
const PRIVATE = 'private-log-receipt-fixture-sentinel';
const ADDRESS = '192.0.2.117';
const RULE_ID = 'rule_fixture_owned_log_receipt';
const CLI = path.resolve(__dirname, '../../../scripts/gate1-log-receipt.js');
const LAUNCHER = path.resolve(__dirname, '../../../scripts/run-gate1-log-receipt.ps1');
let nativeGuard;

beforeAll(() => { nativeGuard = jest.spyOn(https, 'request').mockImplementation(() => { throw new Error('Native HTTPS forbidden'); }); });
afterEach(() => { expect(nativeGuard).not.toHaveBeenCalled(); });
afterAll(() => { nativeGuard.mockRestore(); });

/** Detach synthetic JSON snapshots so mutation fixtures cannot rewrite earlier observations. */
function copy(value) { return JSON.parse(JSON.stringify(value)); }

/** Supply an explicitly attested profile without using a real account or credential. */
function profile(time = START, mode) {
  const result = profileTemplate(time, mode);
  for (const key of Object.keys(result.attestations)) result.attestations[key] = true;
  return result;
}

/** Preserve an unrelated existing policy across insertion and targeted removal. */
function baseline() {
  return { firewallEnabled: true, id: 'icfg_fixture_baseline', ownerId: TARGET.teamId,
    projectKey: TARGET.projectId, ips: [], changes: [], updatedAt: new Date(START).toISOString(),
    version: 3, rules: [{ id: 'rule_fixture_existing', name: PRIVATE, active: true, valid: true,
      conditionGroup: [{ conditions: [{ type: 'raw_path', op: 'eq', value: '/api/auth/session' },
        { type: 'method', op: 'eq', value: 'GET' }] }],
      action: { mitigate: { action: 'rate_limit', bypassSystem: false,
        rateLimit: { action: 'log', algo: 'fixed_window', keys: ['ip'], limit: 1000, window: 60 } } } }] };
}

/** Encode a synthetic provider response; data remains in test memory only. */
function jsonReply(value, status = 200) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

/** Build private Events values to prove only bounded match facts survive the runner. */
function event(state, changes = {}) {
  return { action: 'log', action_type: 'custom', count: 1, host: TARGET.hostname,
    public_ip: ADDRESS, ruleId: RULE_ID, ruleName: PRIVATE, isActive: false,
    startTime: new Date(START).toISOString(), endTime: new Date(START + state.elapsed).toISOString(), ...changes };
}

/**
 * Simulate the documented shared-draft control plane. Hooks can change state or
 * replace a reply before/after a mutation to exercise ambiguous outcomes safely.
 */
function fixture(options = {}) {
  const state = { active: baseline(), draft: null, versions: [], elapsed: 0,
    rule: null, providerCount: 0, appCount: 0, labels: [] };
  if (options.state) Object.assign(state, options.state);
  const calls = [], requests = [], responses = [];
  /** Resolve only the fixed trial routes; an unexpected request is a test failure. */
  function respond(call) {
    const url = new URL(call.options.path, `https://${call.options.hostname}`);
    let label;
    if (call.options.hostname === TARGET.hostname) { label = 'app'; state.appCount += 1; }
    else {
      state.providerCount += 1;
      if (url.pathname.endsWith('/events')) label = 'events';
      else if (call.options.method === 'GET') label = 'config';
      else if (call.options.method === 'POST') label = 'activate';
      else if (call.options.method === 'DELETE') label = 'discard';
      else if (call.options.method === 'PATCH') label = JSON.parse(call.body).action;
      else throw new Error('Unexpected fixture method');
    }
    call.label = label;
    state.labels.push(label);
    const overridden = options.before?.(call, state);
    if (overridden) return overridden;
    let reply;
    if (label === 'config') reply = jsonReply({ active: state.active, draft: state.draft, versions: state.versions });
    else if (label === 'rules.insert') {
      const patch = JSON.parse(call.body);
      state.rule = { ...copy(patch.value), id: RULE_ID, valid: true };
      state.draft = { ...copy(state.active), id: 'icfg_fixture_draft',
        rules: [...copy(state.active.rules), copy(state.rule)],
        changes: [{ action: 'rules.insert', id: RULE_ID, value: copy(patch.value) }] };
      reply = jsonReply({});
    } else if (label === 'rules.remove') {
      const patch = JSON.parse(call.body);
      if (patch.id !== RULE_ID) throw new Error('Fixture forbids removing an unrelated rule');
      state.draft = { ...copy(state.active), id: 'icfg_fixture_removal_draft',
        rules: state.active.rules.filter((rule) => rule.id !== patch.id),
        changes: [{ action: 'rules.remove', id: patch.id, value: null }] };
      reply = jsonReply({});
    } else if (label === 'activate') {
      if (!state.draft) throw new Error('Fixture forbids activating an absent draft');
      state.versions.push(copy(state.active));
      state.active = { ...copy(state.draft), id: `icfg_fixture_active_${state.active.version + 1}`,
        version: state.active.version + 1, updatedAt: new Date(START + state.elapsed).toISOString(), changes: [] };
      state.draft = null;
      reply = jsonReply(state.active);
    } else if (label === 'discard') {
      state.draft = null;
      reply = { status: 204, headers: {}, body: '' };
    } else if (label === 'app') {
      reply = { ...jsonReply(null), headers: { 'content-type': 'application/json',
        'cache-control': 'private, no-store' } };
    } else if (label === 'events') reply = jsonReply({ actions: [event(state)] });
    else throw new Error('Unexpected fixture route');
    return options.after?.(reply, call, state) || reply;
  }
  /** Implement native request events while keeping all request/response data local to this fixture. */
  const requestImpl = jest.fn((requestOptions, receive) => {
    const request = new EventEmitter();
    request.destroy = jest.fn(); requests.push(request);
    request.end = jest.fn((body) => {
      const call = { options: requestOptions, body }; calls.push(call);
      Promise.resolve().then(() => {
        const reply = respond(call);
        if (reply.hang) return;
        if (reply.error) { request.emit('error', new Error(`${PRIVATE} ${TOKEN}`)); return; }
        const response = new EventEmitter();
        response.destroy = jest.fn(); responses.push(response);
        response.statusCode = reply.status ?? 200;
        response.rawHeaders = reply.rawHeaders ?? Object.entries(reply.headers || {}).flat();
        response.complete = reply.complete !== false;
        receive(response);
        if (response.destroy.mock.calls.length || reply.hangBody) return;
        if (reply.earlyClose) { response.emit('close'); return; }
        for (const chunk of reply.chunks || [Buffer.from(reply.body || '')]) response.emit('data', chunk);
        if (reply.aborted) response.emit('aborted'); else response.emit('end');
        response.emit('close');
      }).catch((error) => request.emit('error', error));
    });
    return request;
  });
  /** Advance both clocks for settlement; no wall-clock wait or live polling is needed. */
  const sleep = jest.fn(async (ms) => { state.elapsed += ms; });
  return { state, calls, requests, responses, requestImpl, sleep,
    deps: { requestImpl, now: () => state.elapsed, wall: () => START + state.elapsed, sleep } };
}

/** Execute the approved envelope against synthetic transport, with optional validation/dependency faults. */
async function trial(options = {}, changes = {}) {
  const wire = fixture(options), selected = profile();
  const input = { profile: selected, approval: approvalId(selected),
    credentials: { providerToken: TOKEN }, ...changes.input };
  const report = await runReceipt(input, { ...wire.deps, ...changes.deps });
  return { ...wire, report };
}

/** Run only the separately approved read-only config operation against the native fixture boundary. */
async function configTrial(options = {}, changes = {}) {
  const wire = fixture(options), selected = profile(START, 'config_check');
  const input = { profile: selected, approval: approvalId(selected),
    credentials: { providerToken: TOKEN }, ...changes.input };
  const report = await runConfigCheck(input, { ...wire.deps, ...changes.deps });
  return { ...wire, report };
}

/** Assert reports never persist provider payloads, IPs, credentials, or trial marker values. */
function expectPrivate(report, wire) {
  const encoded = JSON.stringify(report);
  for (const value of [TOKEN, PRIVATE, ADDRESS, 'Bearer ', '"public_ip"', '"conditionGroup"']) expect(encoded).not.toContain(value);
  const marker = wire?.state.rule?.conditionGroup?.[0]?.conditions?.find((condition) => condition.type === 'user_agent')?.value;
  if (marker) expect(encoded).not.toContain(marker);
  expect(Buffer.byteLength(encoded)).toBeLessThan(LIMITS.reportBytes);
  expect(report).toMatchObject({ gate1Status: 'open', sourceAgreement: 'not_evaluated', completeness: 'unqualified' });
}

/** Permit fixed schema field labels while rejecting provider values, unknown keys, and verbose validation errors. */
function expectConfigPrivate(value) {
  const encoded = JSON.stringify(value);
  for (const secret of [TOKEN, PRIVATE, ADDRESS, RULE_ID, 'Bearer ', '"public_ip"',
    'ZodError', 'invalid_type', 'unrecognized_keys', 'icfg_fixture_baseline', 'rule_fixture_existing']) {
    expect(encoded).not.toContain(secret);
  }
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(CONFIG_LIMITS.reportBytes);
}

describe('separately bounded configuration check', () => {
  it('prepares an explicitly separate mode with only its three required attestations', () => {
    const template = profileTemplate(START, 'config_check');
    expect(template).toMatchObject({ schemaVersion: 1, queryMode: 'config_check', ...TARGET });
    expect(template.attestations).toEqual({ sourceCodeReviewed: false,
      credentialLoggingReviewed: false, includedUsageHeadroom: false });
    expect(() => parseProfile(template)).toThrow();
    const selected = profile(START, 'config_check');
    const prepared = preparation(selected, START);
    expect(prepared).toMatchObject({ mode: 'prepare', liveApproved: false,
      scope: 'provider_firewall_config_check_only', appRequests: 0, providerRequests: 0,
      limits: CONFIG_LIMITS, approvalId: approvalId(selected) });
    expect(CONFIG_LIMITS).toMatchObject({ maxAppRequests: 0, maxProviderRequests: 1,
      maxEventsQueries: 0, maxConfigMutations: 0, requestMs: 10000, overallMs: 15000 });
    expect(approvalId(selected)).not.toBe(approvalId(profile()));
  });

  it.each(['sourceCodeReviewed', 'credentialLoggingReviewed', 'includedUsageHeadroom'])('requires the config-only %s attestation', (key) => {
    const selected = profile(START, 'config_check'); selected.attestations[key] = false;
    expect(() => parseProfile(selected)).toThrow();
  });

  it('sends exactly one fixed GET with no body, probe, Events lookup, draft update, or cleanup', async () => {
    const result = await configTrial();
    expect(result.state.labels).toEqual(['config']); expect(result.calls).toHaveLength(1);
    expect(result.state.appCount).toBe(0); expect(result.state.rule).toBeNull();
    expect(result.state.draft).toBeNull(); expect(result.state.active).toEqual(baseline());
    expect(result.state.versions).toEqual([]); expect(result.sleep).not.toHaveBeenCalled();
    const call = result.calls[0];
    expect(call.body).toBeUndefined();
    expect(call.options).toMatchObject({ protocol: 'https:', hostname: 'api.vercel.com', method: 'GET',
      port: 443, rejectUnauthorized: true, agent: false,
      path: `/v1/security/firewall/config?projectId=${TARGET.projectId}&teamId=${TARGET.teamId}` });
    expect(call.options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(call.options.headers).some((key) => /cookie|bypass|forwarded|real-ip/i.test(key))).toBe(false);
    expect(result.report).toMatchObject({ result: 'completed', scope: 'provider_firewall_config_check_only',
      appRequests: 0, providerRequests: 1, configMutations: 0, eventsQueries: 0,
      configurationCheck: { schemaCompatible: true }, gate1Status: 'open', sourceAgreement: 'not_evaluated' });
    expectConfigPrivate(result.report);
  });

  it.each([
    { active: null }, { draft: baseline() }, { active: { ...baseline(), ownerId: PRIVATE } },
    { active: { ...baseline(), firewallEnabled: false } },
  ])('only reports an incompatible or existing-draft configuration (%#)', async (state) => {
    const result = await configTrial({ state });
    expect(result.state.labels).toEqual(['config']); expect(result.state.rule).toBeNull();
    expect(result.state.appCount).toBe(0); expect(result.sleep).not.toHaveBeenCalled();
    expectConfigPrivate(result.report);
  });

  it('rejects both directions of cross-mode approval before transport', async () => {
    const full = profile(), checked = profile(START, 'config_check');
    const first = await configTrial({}, { input: { profile: full, approval: approvalId(full) } });
    expect(first.calls).toHaveLength(0); expectConfigPrivate(first.report);
    const second = await trial({}, { input: { profile: checked, approval: approvalId(checked) } });
    expect(second.calls).toHaveLength(0); expectPrivate(second.report, second);
    const third = await configTrial({}, { input: { approval: approvalId(full) } });
    expect(third.calls).toHaveLength(0); expectConfigPrivate(third.report);
  });

  it.each([START - 900001, START + 1])('refuses stale or future config-only profiles (%i)', async (time) => {
    const selected = profile(time, 'config_check');
    const result = await configTrial({}, { input: { profile: selected, approval: approvalId(selected) } });
    expect(result.calls).toHaveLength(0); expectConfigPrivate(result.report);
  });

  it.each([
    { credentials: { providerToken: 'too-short' } },
    { credentials: { providerToken: `${TOKEN}\r\nBad-Header: injected` } },
    { approval: '0'.repeat(64) },
    { endpoint: 'https://unapproved.example.test', maxProviderRequests: 999 },
  ])('rejects malformed or widened config-only authorization (%#)', async (input) => {
    const result = await configTrial({}, { input });
    expect(result.calls).toHaveLength(0); expectConfigPrivate(result.report);
  });

  it.each([401, 403, 429, 500])('does not retry or retain an HTTP %i error payload', async (status) => {
    const result = await configTrial({ after: () => jsonReply({ error: { code: PRIVATE, message: `${TOKEN} ${ADDRESS}` } }, status) });
    expect(result.state.labels).toEqual(['config']);
    expect(result.report).toMatchObject({ result: 'stopped', appRequests: 0, providerRequests: 1 });
    expectConfigPrivate(result.report);
  });

  it.each([
    ['redirect', { status: 307, headers: { location: `https://unapproved.example.test/${PRIVATE}` }, body: '' }],
    ['oversized body', { status: 200, headers: {}, body: 'x'.repeat(262145) }],
    ['oversized headers', { status: 200, rawHeaders: ['x-private', PRIVATE.repeat(1024)], body: '' }],
    ['encoded body', { status: 200, headers: { 'content-encoding': 'gzip' }, body: PRIVATE }],
    ['incomplete body', { status: 200, headers: {}, earlyClose: true }],
    ['transport error', { error: true }],
  ])('stops a config %s without follow-up requests', async (_label, replacement) => {
    const result = await configTrial({ after: () => replacement });
    expect(result.state.labels).toEqual(['config']);
    expect(result.report).toMatchObject({ result: 'stopped', appRequests: 0, providerRequests: 1 });
    expectConfigPrivate(result.report);
  });

  it('ends a stalled config request within ten seconds without reserving any mutation or retry', async () => {
    jest.useFakeTimers();
    try {
      const pending = configTrial({ after: () => ({ hang: true }) });
      await jest.advanceTimersByTimeAsync(10001);
      const result = await pending;
      expect(result.state.labels).toEqual(['config']);
      expect(result.requests[0].destroy).toHaveBeenCalled();
      expect(result.report).toMatchObject({ result: 'stopped', appRequests: 0, providerRequests: 1 });
      expectConfigPrivate(result.report);
    } finally { jest.useRealTimers(); }
  });

  it('does not dispatch an already cancelled config check', async () => {
    const controller = new AbortController(); controller.abort(PRIVATE);
    const result = await configTrial({}, { deps: { signal: controller.signal } });
    expect(result.calls).toHaveLength(0); expectConfigPrivate(result.report);
  });

  it('stops at the config-only fifteen-second overall boundary without a follow-up request', async () => {
    const result = await configTrial({ after: (reply, _call, state) => {
      state.elapsed += CONFIG_LIMITS.overallMs + 1; return reply;
    } });
    expect(result.state.labels).toEqual(['config']);
    expect(result.report).toMatchObject({ result: 'stopped', failure: 'deadline',
      appRequests: 0, providerRequests: 1, configMutations: 0, eventsQueries: 0 });
    expectConfigPrivate(result.report);
  });
});

describe('allowlisted configuration schema facts', () => {
  it('projects compatibility without retaining config, rule, or history values', () => {
    const config = baseline(); config[PRIVATE] = { token: TOKEN, address: ADDRESS };
    const facts = reviewConfigResponse(jsonReply({ active: config, draft: null, versions: [{ [PRIVATE]: TOKEN }] }));
    expect(facts).toMatchObject({ basis: 'current_trial_reader_contract', jsonContentType: true,
      jsonValid: true, schemaCompatible: true, validationStage: 'compatible', failure: null, rootType: 'object',
      envelope: { active: 'object', draft: 'null', versions: 'array', unexpectedFields: false }, draft: null,
      active: { fields: { id: { type: 'string', valid: true }, version: { type: 'number', valid: true },
        ownerId: { type: 'string', valid: true }, projectKey: { type: 'string', valid: true } },
      rules: { entriesValid: true, idValid: true, activeValid: true, nameValid: true,
        conditionGroupsValid: true, idsUnique: true } } });
    expectConfigPrivate(facts);
  });

  it.each([
    ['active', undefined, 'missing'], ['active', null, 'null'], ['active', [], 'array'],
    ['draft', undefined, 'missing'], ['draft', PRIVATE, 'string'], ['versions', {}, 'object'],
  ])('identifies only the type of an incompatible %s envelope field (%#)', (key, value, type) => {
    const body = { active: baseline(), draft: null, versions: [] }; body[key] = value;
    const facts = reviewConfigResponse(jsonReply(body));
    expect(facts).toMatchObject({ schemaCompatible: false, failure: 'provider_schema', envelope: { [key]: type } });
    expectConfigPrivate(facts);
  });

  it('reports unknown envelope keys as a boolean without retaining their names', () => {
    const facts = reviewConfigResponse(jsonReply({ active: baseline(), draft: null, versions: [], [PRIVATE]: TOKEN }));
    expect(facts).toMatchObject({ validationStage: 'envelope', schemaCompatible: false,
      envelope: { unexpectedFields: true } });
    expectConfigPrivate(facts);
  });

  it.each([
    ['id', null, 'null'], ['version', '3', 'string'], ['updatedAt', 1790251200000, 'number'],
    ['ownerId', PRIVATE, 'string'], ['projectKey', PRIVATE, 'string'],
    ['firewallEnabled', false, 'boolean'], ['firewallEnabled', 'true', 'string'],
    ['changes', {}, 'object'], ['ips', null, 'null'], ['rules', {}, 'object'],
  ])('distinguishes the type from strict compatibility for %s (%#)', (key, value, type) => {
    const active = baseline(); active[key] = value;
    const facts = reviewConfigResponse(jsonReply({ active, draft: null, versions: [] }));
    expect(facts).toMatchObject({ schemaCompatible: false, validationStage: 'active_config',
      active: { fields: { [key]: { type, valid: false } } } });
    expectConfigPrivate(facts);
  });

  it('checks an existing draft independently without treating it as permission to mutate', async () => {
    const draft = { ...baseline(), projectKey: PRIVATE };
    const result = await configTrial({ state: { draft } });
    expect(result.state.labels).toEqual(['config']); expect(result.state.draft).toEqual(draft);
    expect(result.report.configurationCheck).toMatchObject({ schemaCompatible: false, validationStage: 'draft_config',
      draft: { fields: { projectKey: { type: 'string', valid: false } } } });
    expectConfigPrivate(result.report);
  });

  it.each([
    ['id', null, 'idValid'], ['active', 'true', 'activeValid'], ['name', null, 'nameValid'],
    ['conditionGroup', null, 'conditionGroupsValid'],
  ])('summarizes defective rule %s fields without exposing a rule index or value', (key, value, field) => {
    const active = baseline(); active.rules[0][key] = value;
    const facts = reviewConfigResponse(jsonReply({ active, draft: null, versions: [] }));
    expect(facts).toMatchObject({ schemaCompatible: false, active: { rules: { [field]: false } } });
    expectConfigPrivate(facts);
  });

  it('flags duplicate rule IDs without retaining those IDs', () => {
    const active = baseline(); active.rules.push(copy(active.rules[0]));
    const facts = reviewConfigResponse(jsonReply({ active, draft: null, versions: [] }));
    expect(facts).toMatchObject({ schemaCompatible: false, validationStage: 'duplicate_rule_ids',
      active: { rules: { idsUnique: false } } });
    expectConfigPrivate(facts);
  });

  it.each([
    ['string', PRIVATE], ['array', []], ['null', null], ['number', 7], ['boolean', true],
  ])('labels an unexpected JSON root %s without echoing the value', (type, body) => {
    const facts = reviewConfigResponse(jsonReply(body));
    expect(facts).toMatchObject({ rootType: type, schemaCompatible: false, validationStage: 'envelope' });
    expectConfigPrivate(facts);
  });

  it.each([
    ['http_status', { status: 403, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [PRIVATE]: TOKEN }) }],
    ['content_type', { status: 200, headers: { 'content-type': `text/plain; reason=${PRIVATE}` }, body: TOKEN }],
    ['json', { status: 200, headers: { 'content-type': 'application/json' }, body: `${PRIVATE}:${TOKEN}` }],
  ])('separates %s failures before inspecting provider structure', (validationStage, response) => {
    const facts = reviewConfigResponse(response);
    expect(facts).toMatchObject({ validationStage, rootType: 'not_evaluated' });
    expectConfigPrivate(facts);
  });

  it('retains the same safe baseline explanation while refusing a full trial with an incompatible config', async () => {
    const result = await trial({ state: { active: { ...baseline(), version: '3' } } });
    expect(result.state.labels).toEqual(['config']);
    expect(result.report).toMatchObject({ result: 'stopped', failure: 'provider_schema',
      baselineCheck: { validationStage: 'active_config', schemaCompatible: false,
        active: { fields: { version: { type: 'string', valid: false } } } } });
    expectPrivate(result.report, result);
  });
});

describe('Log receipt profile and offline approval', () => {
  it('requires explicit attestations and prepares without network or approval', () => {
    const template = profileTemplate(START);
    expect(Object.values(template.attestations)).toEqual([false, false, false, false, false]);
    expect(() => parseProfile(template)).toThrow();
    expect(preparation(profile(), START)).toMatchObject({ mode: 'prepare', liveApproved: false,
      appRequests: 0, providerRequests: 0, approvalId: approvalId(profile()), limits: LIMITS });
  });

  it.each(['sourceCodeReviewed', 'credentialLoggingReviewed', 'noConcurrentWafEdits',
    'includedUsageHeadroom', 'recoveryProcedureReviewed'])('refuses an unconfirmed %s attestation', (key) => {
    const selected = profile(); selected.attestations[key] = false;
    expect(() => parseProfile(selected)).toThrow();
  });

  it.each(['projectId', 'teamId', 'hostname'])('rejects a different fixed %s before transport', async (key) => {
    const selected = profile(); selected[key] = PRIVATE;
    const result = await trial({}, { input: { profile: selected } });
    expect(result.calls).toHaveLength(0); expectPrivate(result.report, result);
  });

  it('rejects a changed approval without entering the control plane', async () => {
    const result = await trial({}, { input: { approval: '0'.repeat(64) } });
    expect(result.calls).toHaveLength(0); expectPrivate(result.report, result);
  });

  it.each([START - LIMITS.profileAgeMs - 1, START + 1])('refuses a stale or future review (%i)', async (time) => {
    const selected = profile(time);
    const result = await trial({}, { input: { profile: selected, approval: approvalId(selected) } });
    expect(result.calls).toHaveLength(0); expect(result.report.failure).toBe('profile');
    expect(() => preparation(selected, START)).toThrow(); expectPrivate(result.report, result);
  });

  it.each(['short', 'x'.repeat(513), 'secret with spaces and punctuation!', 'x'.repeat(30) + '\r\nInjected: yes', null, 123])('rejects malformed credentials before native dispatch (%#)', async (providerToken) => {
      const result = await trial({}, { input: { credentials: { providerToken } } });
      expect(result.calls).toHaveLength(0); expect(result.report.failure).toBe('input');
      expectPrivate(result.report, result);
    });

  it('rejects additional caller-controlled operation fields instead of altering the fixed request', async () => {
    const result = await trial({}, { input: { endpoint: 'https://unapproved.example.test', maxProviderRequests: 999 } });
    expect(result.calls).toHaveLength(0); expect(result.report.failure).toBe('input');
    expectPrivate(result.report, result);
  });
});

describe('one marked request and targeted cleanup', () => {
  it('uses fixed native routes, one probe, one Events lookup, and restores unrelated policy', async () => {
    const result = await trial();
    expect(result.state.labels).toEqual(['config', 'rules.insert', 'config', 'activate', 'config',
      'app', 'events', 'config', 'rules.remove', 'config', 'activate', 'config']);
    const provider = result.calls.filter((call) => call.options.hostname === 'api.vercel.com');
    const application = result.calls.filter((call) => call.options.hostname === TARGET.hostname);
    expect(provider).toHaveLength(11); expect(application).toHaveLength(1);
    for (const call of result.calls) {
      expect(call.options).toMatchObject({ protocol: 'https:', port: 443, agent: false, rejectUnauthorized: true });
      expect(Object.keys(call.options.headers).some((key) => /cookie|bypass|forwarded|real-ip/i.test(key))).toBe(false);
    }
    for (const call of provider) {
      expect(call.options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      const url = new URL(call.options.path, 'https://api.vercel.com');
      expect(url.searchParams.get('projectId')).toBe(TARGET.projectId);
      expect(url.searchParams.get('teamId')).toBe(TARGET.teamId);
      expect(['/v1/security/firewall/config', '/v1/security/firewall/config/draft',
        '/v1/security/firewall/config/draft/activate', '/v1/security/firewall/events']).toContain(url.pathname);
    }
    const probe = application[0];
    expect(probe.options.method).toBe('GET'); expect(probe.options.path).toBe('/api/auth/session');
    expect(probe.body).toBeUndefined(); expect(probe.options.headers.Authorization).toBeUndefined();
    const insertion = JSON.parse(result.calls.find((call) => call.label === 'rules.insert').body);
    expect(insertion).toMatchObject({ action: 'rules.insert', id: null,
      value: { active: true, action: { mitigate: { action: 'log' } } } });
    expect(insertion.value.action).toEqual({ mitigate: { action: 'log' } });
    expect(insertion.value.conditionGroup).toHaveLength(1);
    const conditions = insertion.value.conditionGroup[0].conditions;
    expect(conditions).toHaveLength(4);
    expect(conditions).toEqual(expect.arrayContaining([
      { type: 'host', op: 'eq', value: TARGET.hostname },
      { type: 'method', op: 'eq', value: 'GET' },
      { type: 'raw_path', op: 'eq', value: '/api/auth/session' },
    ]));
    const marker = conditions.find((condition) => condition.type === 'user_agent');
    expect(marker.op).toBe('eq');
    const userAgent = Object.entries(probe.options.headers).find(([key]) => key.toLowerCase() === 'user-agent')[1];
    expect(marker.value).toBe(userAgent);
    expect(result.sleep).toHaveBeenCalledTimes(1);
    expect(result.state.elapsed).toBeGreaterThanOrEqual(30000);
    const eventsUrl = new URL(result.calls.find((call) => call.label === 'events').options.path, 'https://api.vercel.com');
    expect([...eventsUrl.searchParams.keys()].sort()).toEqual(['endTimestamp', 'hosts', 'projectId', 'startTimestamp', 'teamId']);
    expect(eventsUrl.searchParams.get('hosts')).toBe(TARGET.hostname);
    expect(eventsUrl.searchParams.get('startTimestamp')).toBe(String(START));
    expect(eventsUrl.searchParams.get('endTimestamp')).toBe(String(START + LIMITS.settlementMs));
    expect(JSON.parse(result.calls.find((call) => call.label === 'rules.remove').body))
      .toEqual({ action: 'rules.remove', id: RULE_ID, value: null });
    expect(result.state.active.rules).toEqual(baseline().rules);
    expect(result.state.draft).toBeNull();
    expect(result.state.versions).toHaveLength(2);
    expect(result.report).toMatchObject({ result: 'completed', appRequests: 1, providerRequests: 11,
      mainProviderRequests: 6, cleanupProviderRequests: 5, eventsQueries: 1,
      cleanup: { status: 'restored', failure: null, restorationVerified: true },
      observation: { receipt: 'matching_log_summary_observed', timingQualified: false } });
    expectPrivate(result.report, result);
  });

  it.each([
    [], [event({ elapsed: 30000 }, { ruleId: 'rule_other' })],
    [event({ elapsed: 30000 }, { host: 'other.example.test' })],
    [event({ elapsed: 30000 }, { action: 'deny' })],
    [event({ elapsed: 30000 }), event({ elapsed: 30000 })],
  ].map((actions) => [actions]))('cleans up even when event matching is absent or ambiguous (%#)', async (actions) => {
    const result = await trial({ after: (reply, call) => call.label === 'events' ? jsonReply({ actions }) : reply });
    expect(result.state.appCount).toBe(1);
    expect(result.state.labels.filter((label) => label === 'events')).toHaveLength(1);
    expect(result.state.active.rules).toEqual(baseline().rules); expect(result.state.draft).toBeNull();
    expect(result.state.providerCount).toBe(11); expectPrivate(result.report, result);
  });

  it('uses a fresh marker on independent trials without retaining either value', async () => {
    const first = await trial(), second = await trial();
    const firstMarker = first.state.rule.conditionGroup[0].conditions.find((condition) => condition.type === 'user_agent').value;
    const secondMarker = second.state.rule.conditionGroup[0].conditions.find((condition) => condition.type === 'user_agent').value;
    expect(firstMarker).not.toBe(secondMarker);
    expectPrivate(first.report, first); expectPrivate(second.report, second);
  });
});

describe('preflight ownership and concurrent configuration changes', () => {
  it.each([[], [{ action: 'firewallEnabled', value: false }]].map((changes) => [changes]))('refuses any pre-existing draft (%#)', async (changes) => {
    const result = await trial({ state: { draft: { ...baseline(), changes } } });
    expect(result.state.labels).toEqual(['config']); expect(result.state.appCount).toBe(0);
    expect(result.state.draft).not.toBeNull(); expectPrivate(result.report, result);
  });

  it.each([
    { active: null }, { active: { ...baseline(), firewallEnabled: false } },
    { active: { ...baseline(), ownerId: 'team_wrong' } },
    { active: { ...baseline(), projectKey: 'prj_wrong' } },
  ])('does not mutate an invalid or different baseline (%#)', async (state) => {
    const result = await trial({ state });
    expect(result.state.labels).toEqual(['config']); expect(result.state.appCount).toBe(0);
    expectPrivate(result.report, result);
  });

  it.each(['draft', 'active', 'versions'])('rejects a missing %s envelope field without coercing absence', async (key) => {
    const result = await trial({ after: (reply, call) => {
      if (call.label !== 'config') return reply;
      const value = JSON.parse(reply.body); delete value[key]; return jsonReply(value);
    } });
    expect(result.state.labels).toEqual(['config']); expectPrivate(result.report, result);
  });

  it('does not publish or discard another editor\'s draft change', async () => {
    const result = await trial({ before: (call, state) => {
      if (call.label === 'config' && state.draft && state.labels.filter((label) => label === 'config').length === 2) {
        state.draft.changes.push({ action: 'firewallEnabled', value: false });
      }
    } });
    expect(result.state.labels).not.toContain('activate');
    expect(result.state.labels).not.toContain('discard');
    expect(result.state.labels).not.toContain('app');
    expect(result.state.draft.changes).toHaveLength(2); expectPrivate(result.report, result);
  });

  it('does not delete the created ID when its rule has been edited after the probe', async () => {
    const result = await trial({ after: (reply, call, state) => {
      if (call.label === 'events') state.active.rules.find((rule) => rule.id === RULE_ID).name = 'changed-by-other-editor';
      return reply;
    } });
    expect(result.state.appCount).toBe(1);
    expect(result.state.labels).not.toContain('rules.remove');
    expect(result.state.active.rules.some((rule) => rule.id === RULE_ID)).toBe(true);
    expect(result.state.providerCount).toBeLessThanOrEqual(11); expectPrivate(result.report, result);
  });
});

describe('ambiguous mutations and cleanup reserve', () => {
  it('discards only the owned unactivated draft after an ambiguous insertion', async () => {
    const result = await trial({ after: (reply, call) => call.label === 'rules.insert' ? { error: true } : reply });
    expect(result.state.labels).toEqual(['config', 'rules.insert', 'config', 'discard', 'config']);
    expect(result.state.appCount).toBe(0); expect(result.state.draft).toBeNull();
    expect(result.state.active.rules).toEqual(baseline().rules); expectPrivate(result.report, result);
  });

  it('does not blindly repeat an insertion that failed before changing state', async () => {
    const result = await trial({ before: (call) => call.label === 'rules.insert' ? { error: true } : undefined });
    expect(result.state.labels.filter((label) => label === 'rules.insert')).toHaveLength(1);
    expect(result.state.labels).not.toContain('app'); expect(result.state.labels).not.toContain('activate');
    expect(result.report.cleanup).toMatchObject({ status: 'cleanup_unresolved', restorationVerified: false });
    expect(result.state.draft).toBeNull(); expectPrivate(result.report, result);
  });

  it('removes the owned active rule when activation applied but its acknowledgement was lost', async () => {
    let failed = false;
    const result = await trial({ after: (reply, call) => {
      if (call.label === 'activate' && !failed) { failed = true; return { error: true }; }
      return reply;
    } });
    expect(result.state.appCount).toBe(0);
    expect(result.state.labels.filter((label) => label === 'rules.insert')).toHaveLength(1);
    expect(result.state.labels.filter((label) => label === 'rules.remove')).toHaveLength(1);
    expect(result.state.active.rules).toEqual(baseline().rules); expect(result.state.draft).toBeNull();
    expect(result.state.providerCount).toBeLessThanOrEqual(11); expectPrivate(result.report, result);
  });

  it.each([403, 429, 500])('reserves cleanup after an Events HTTP %i without another lookup', async (status) => {
    const result = await trial({ after: (reply, call) => call.label === 'events'
      ? jsonReply({ error: { code: 'forbidden', message: `${PRIVATE} ${TOKEN}` } }, status) : reply });
    expect(result.state.labels.filter((label) => label === 'events')).toHaveLength(1);
    expect(result.state.active.rules).toEqual(baseline().rules);
    expect(result.state.providerCount).toBe(11); expectPrivate(result.report, result);
  });

  it('uses the cleanup reserve after cancellation instead of reusing the aborted signal', async () => {
    const controller = new AbortController();
    const result = await trial({ after: (reply, call) => {
      if (call.label === 'app') controller.abort(PRIVATE);
      return reply;
    } }, { deps: { signal: controller.signal } });
    expect(result.state.appCount).toBe(1);
    expect(result.state.labels).not.toContain('events');
    expect(result.state.active.rules).toEqual(baseline().rules); expect(result.state.draft).toBeNull();
    expect(result.state.providerCount).toBeLessThanOrEqual(11); expectPrivate(result.report, result);
  });

  it('does not perform a late Events lookup when settlement consumes the main deadline', async () => {
    const result = await trial({ after: (reply, call, state) => {
      if (call.label === 'app') state.elapsed += 120001;
      return reply;
    } });
    expect(result.state.labels).not.toContain('events');
    expect(result.state.active.rules).toEqual(baseline().rules);
    expect(result.state.providerCount).toBeLessThanOrEqual(11); expectPrivate(result.report, result);
  });
});

describe('cleanup reconciliation for each mutation', () => {
  it('leaves an unconfirmed activation unresolved instead of racing it with draft deletion', async () => {
    const result = await trial({ before: (call) => call.label === 'activate' ? { error: true } : undefined });
    expect(result.state.labels).toEqual(['config', 'rules.insert', 'config', 'activate', 'config']);
    expect(result.state.draft).not.toBeNull(); expect(result.state.appCount).toBe(0);
    expect(result.report.cleanup).toMatchObject({ status: 'cleanup_unresolved', restorationVerified: false });
    expectPrivate(result.report, result);
  });

  it('recovers an owned draft when its insertion acknowledgement arrived but read-back failed', async () => {
    let configCount = 0;
    const result = await trial({ before: (call) => {
      if (call.label === 'config' && ++configCount === 2) return { error: true };
    } });
    expect(result.state.labels).toEqual(['config', 'rules.insert', 'config', 'config', 'discard', 'config']);
    expect(result.report.cleanup).toMatchObject({ status: 'restored', restorationVerified: true });
    expect(result.state.appCount).toBe(0); expectPrivate(result.report, result);
  });

  it('reconciles a removal that applied but lost its acknowledgement within five cleanup calls', async () => {
    const result = await trial({ after: (reply, call) => call.label === 'rules.remove' ? { error: true } : reply });
    expect(result.state.providerCount).toBe(11);
    expect(result.state.labels.filter((label) => label === 'rules.remove')).toHaveLength(1);
    expect(result.report.cleanup).toMatchObject({ status: 'restored', restorationVerified: true });
    expect(result.state.active.rules).toEqual(baseline().rules); expectPrivate(result.report, result);
  });

  it('does not retry a removal with an unknown effect', async () => {
    const result = await trial({ before: (call) => call.label === 'rules.remove' ? { error: true } : undefined });
    expect(result.state.labels.filter((label) => label === 'rules.remove')).toHaveLength(1);
    expect(result.state.labels.filter((label) => label === 'activate')).toHaveLength(1);
    expect(result.state.providerCount).toBeLessThanOrEqual(11);
    expect(result.report.cleanup).toMatchObject({ status: 'cleanup_unresolved', restorationVerified: false });
    expect(result.state.active.rules.some((rule) => rule.id === RULE_ID)).toBe(true);
    expectPrivate(result.report, result);
  });

  it.each([true, false])('checks the final state after removal activation loses its acknowledgement (applied=%s)', async (applied) => {
    let activationCount = 0;
    /** Identify only cleanup activation; the first activation must permit the single probe. */
    function failActivation(reply, call) {
      if (call.label === 'activate' && ++activationCount === 2) return { error: true };
      return reply;
    }
    const result = await trial(applied ? { after: failActivation }
      : { before: (call) => failActivation(undefined, call) });
    expect(result.state.providerCount).toBe(11);
    expect(result.state.labels.filter((label) => label === 'activate')).toHaveLength(2);
    expect(result.report.cleanup).toMatchObject({ status: applied ? 'restored' : 'cleanup_unresolved',
      restorationVerified: applied });
    expect(result.state.draft === null).toBe(applied); expectPrivate(result.report, result);
  });

  it.each([true, false])('verifies a lost draft-deletion acknowledgement without retrying (applied=%s)', async (applied) => {
    const result = await trial({
      before: (call) => !applied && call.label === 'discard' ? { error: true } : undefined,
      after: (reply, call) => call.label === 'rules.insert' || (applied && call.label === 'discard')
        ? { error: true } : reply,
    });
    expect(result.state.labels).toEqual(['config', 'rules.insert', 'config', 'discard', 'config']);
    expect(result.report.cleanup).toMatchObject({ status: applied ? 'restored' : 'cleanup_unresolved',
      restorationVerified: applied });
    expect(result.state.draft === null).toBe(applied); expectPrivate(result.report, result);
  });

  it.each([4, 5, 6])('cannot claim restoration when cleanup read %i fails', async (failingRead) => {
    let configCount = 0;
    const result = await trial({ before: (call) => {
      if (call.label === 'config' && ++configCount === failingRead) return { error: true };
    } });
    expect(result.report).toMatchObject({ result: 'stopped',
      cleanup: { status: 'cleanup_unresolved', restorationVerified: false } });
    expect(result.state.providerCount).toBeLessThanOrEqual(11);
    expect(result.state.appCount).toBe(1); expectPrivate(result.report, result);
  });
});

describe('strictly bounded native transport and cancellation', () => {
  it.each([
    ['redirect', { status: 302, headers: { location: 'https://unapproved.example.test' }, body: '' }],
    ['oversized body', { status: 200, headers: {}, body: 'x'.repeat(LIMITS.appBytes + 1) }],
    ['oversized header', { status: 200, rawHeaders: ['x-private', PRIVATE.repeat(1024)], body: '' }],
    ['encoded body', { status: 200, headers: { 'content-encoding': 'gzip' }, body: PRIVATE }],
    ['incomplete body', { status: 200, headers: {}, earlyClose: true }],
    ['aborted body', { status: 200, headers: {}, aborted: true }],
    ['non-success status', jsonReply({ reason: PRIVATE }, 401)],
  ])('stops after one application %s and still cleans up', async (_label, replacement) => {
    const result = await trial({ after: (reply, call) => call.label === 'app' ? replacement : reply });
    expect(result.state.appCount).toBe(1); expect(result.state.labels).not.toContain('events');
    expect(result.state.providerCount).toBe(10);
    expect(result.report.cleanup).toMatchObject({ status: 'restored', restorationVerified: true });
    expect(result.report.result).toBe('stopped'); expectPrivate(result.report, result);
  });

  it.each([
    ['oversized', { status: 200, headers: { 'content-type': 'application/json' }, body: 'x'.repeat(LIMITS.providerBytes + 1) }],
    ['invalid JSON', { status: 200, headers: { 'content-type': 'application/json' }, body: PRIVATE }],
    ['wrong media', { status: 200, headers: { 'content-type': 'text/html' }, body: PRIVATE }],
    ['unknown payload', jsonReply({ actions: [], private: PRIVATE })],
    ['redirect', { status: 307, headers: { location: `https://unapproved.example.test/${PRIVATE}` }, body: '' }],
  ])('does not retry an Events %s reply and retains only sanitized failure facts', async (_label, replacement) => {
    const result = await trial({ after: (reply, call) => call.label === 'events' ? replacement : reply });
    expect(result.state.providerCount).toBe(11); expect(result.state.appCount).toBe(1);
    expect(result.state.labels.filter((label) => label === 'events')).toHaveLength(1);
    expect(result.report.cleanup).toMatchObject({ status: 'restored', restorationVerified: true });
    expect(result.report.result).toBe('stopped'); expectPrivate(result.report, result);
  });

  it('aborts a stalled response after the existing request limit and spends only the cleanup reserve', async () => {
    jest.useFakeTimers();
    try {
      const pending = trial({ after: (reply, call) => call.label === 'events' ? { hang: true } : reply });
      await jest.advanceTimersByTimeAsync(LIMITS.requestMs + 1);
      const result = await pending;
      expect(result.state.providerCount).toBe(11); expect(result.state.appCount).toBe(1);
      expect(result.requests.some((request) => request.destroy.mock.calls.length > 0)).toBe(true);
      expect(result.report.cleanup).toMatchObject({ status: 'restored', restorationVerified: true });
      expect(result.report.result).toBe('stopped'); expectPrivate(result.report, result);
    } finally { jest.useRealTimers(); }
  });

  it('refuses a previously cancelled operation before the first provider request', async () => {
    const controller = new AbortController(); controller.abort(PRIVATE);
    const result = await trial({}, { deps: { signal: controller.signal } });
    expect(result.calls).toHaveLength(0); expectPrivate(result.report, result);
  });

  it('does not call Events when a fake or interrupted settlement did not actually elapse', async () => {
    const result = await trial({}, { deps: { sleep: jest.fn(async () => {}) } });
    expect(result.state.labels).not.toContain('events');
    expect(result.report.cleanup).toMatchObject({ status: 'restored', restorationVerified: true });
    expectPrivate(result.report, result);
  });

  it('does not spend beyond the independent cleanup deadline or claim restoration', async () => {
    const result = await trial({ after: (reply, call, state) => {
      if (call.label === 'config' && state.labels.includes('events')) state.elapsed += LIMITS.cleanupMs + 1;
      return reply;
    } });
    expect(result.state.labels).not.toContain('rules.remove');
    expect(result.state.providerCount).toBe(7);
    expect(result.report.cleanup).toMatchObject({ status: 'cleanup_unresolved', failure: 'deadline', restorationVerified: false });
    expectPrivate(result.report, result);
  });
});

describe('sanitized aggregate receipt classification', () => {
  const window = { start: START, end: START + 30000 };

  it('accepts documented native and canonical count/boolean representations without retaining raw rows', () => {
    for (const count of [1, '1']) {
      for (const isActive of [true, false, 'true', 'false']) {
        const reviewed = reviewEvents({ actions: [event({ elapsed: 30000 }, { count, isActive })] }, RULE_ID, window);
        expect(reviewed).toMatchObject({ count: 1, matchingRows: 1, receipt: 'matching_log_summary_observed',
          timingQualified: false, intervalOverlapsQuery: true });
        for (const value of [ADDRESS, PRIVATE, RULE_ID]) expect(JSON.stringify(reviewed)).not.toContain(value);
      }
    }
  });

  it.each(['01', '+1', '1.0', ' 1', '-1', '1e0', '9007199254740992', -1, 1.5, NaN])('rejects an unsafe count representation (%s)', (count) => {
    expect(() => reviewEvents({ actions: [event({ elapsed: 30000 }, { count })] }, RULE_ID, window)).toThrow();
  });

  it.each([
    { count: 0 }, { count: 2 }, { host: 'unrelated.example.test' }, { action: 'deny' },
    { startTime: String(START), endTime: String(START + 30000) },
    { startTime: new Date(START + 30001).toISOString(), endTime: new Date(START + 31000).toISOString() },
    { startTime: new Date(START + 1000).toISOString(), endTime: new Date(START).toISOString() },
  ])('keeps a rule match ambiguous when its receipt facts disagree (%#)', (changes) => {
    const reviewed = reviewEvents({ actions: [event({ elapsed: 30000 }, changes)] }, RULE_ID, window);
    expect(reviewed).toMatchObject({ receipt: 'ambiguous', timingQualified: false });
  });

  it('does not infer absence or request attribution from empty or unrelated summaries', () => {
    for (const actions of [[], [event({ elapsed: 30000 }, { ruleId: 'rule_unrelated' })]]) {
      expect(reviewEvents({ actions }, RULE_ID, window)).toMatchObject({ receipt: 'not_observed_in_trial',
        matchingRows: 0, matchingRuleObserved: false, timingQualified: false });
    }
    expect(reviewEvents({ actions: [event({ elapsed: 30000 }), event({ elapsed: 30000 })] }, RULE_ID, window))
      .toMatchObject({ receipt: 'ambiguous', cardinality: 'multiple_or_conflicting', count: 2 });
  });

  it('rejects caller-supplied weak rule markers rather than widening the exact four conditions', () => {
    expect(() => diagnosticRule('a'.repeat(32), 'common-agent')).toThrow();
    expect(() => diagnosticRule('invalid', `gate1-log-${'a'.repeat(48)}`)).toThrow();
  });
});

/** Run the real offline CLI with child-process network entry points denied before module loading. */
function offlineCli(args, input) {
  const script = `
    const denied = () => { process.stderr.write('fixture_network_blocked'); process.exit(91); };
    for (const name of ['node:https', 'node:http']) {
      require(name).request = denied; require(name).get = denied;
    }
    require('node:net').connect = denied; require('node:net').createConnection = denied;
    require('node:tls').connect = denied;
    process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
    require('node:module').runMain();`;
  return spawnSync(process.execPath, ['-e', script], { input, encoding: 'utf8', timeout: 10000, windowsHide: true });
}

/** Quote synthetic fixture data as PowerShell literals without enabling interpolation. */
function psLiteral(value) { return `'${value.replace(/'/g, "''")}'`; }

/**
 * Exercise the actual launcher and hidden-token helper with synthetic secure
 * input. Every Node invocation is replaced, so this fixture cannot run HTTP.
 * The temporary profile contains no credentials and is removed after the child.
 */
function launcherFixture(options = {}) {
  const directory = path.resolve(__dirname, '../../../.tmp');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `log-receipt-launcher-fixture-${randomUUID()}.json`);
  const selected = profile(Date.now(), options.configCheck ? 'config_check' : undefined), digest = approvalId(selected);
  const prepared = { ...preparation(selected), ...options.reviewChanges };
  if (options.limitChanges) prepared.limits = { ...prepared.limits, ...options.limitChanges };
  fs.writeFileSync(file, JSON.stringify(selected), { flag: 'wx' });
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    `. ${psLiteral(LAUNCHER)} -Live -ProfilePath ${psLiteral(file)} -Approval ${psLiteral(options.wrongApproval ? '0'.repeat(64) : digest)}`,
    '$script:sequence = [Collections.Generic.List[string]]::new()',
    '$script:fixtureViolation = $false; $script:liveEnvelopeValidated = $false; $script:reviewInput = $null',
    '<# Fail synthetic contract assertions without retaining any rejected value. #>',
    'function Assert-FixtureCondition([bool]$Condition) {',
    "  if (-not $Condition) { $script:fixtureViolation = $true; throw 'Fixture contract failed.' }",
    '}',
    '<# Suppress normal review display and ensure credentials never enter it. #>',
    'function Write-Host($Object) {',
    `  Assert-FixtureCondition (-not ([string]$Object).Contains(${psLiteral(TOKEN)}))`,
    '}',
    '<# Supply confirmation or synthetic SecureString, exercising the real token helper. #>',
    'function Read-Host([string]$Prompt, [switch]$AsSecureString) {',
    '  if ($AsSecureString) {',
    "    Assert-FixtureCondition (($script:sequence -join ',') -ceq 'review,confirmation')",
    "    $script:sequence.Add('hidden_token')",
    `    return ConvertTo-SecureString -String ${psLiteral(options.token || TOKEN)} -AsPlainText -Force`,
    '  }',
    "  Assert-FixtureCondition (($script:sequence -join ',') -ceq 'review')",
    "  $script:sequence.Add('confirmation')",
    `  return ${psLiteral(options.confirmation === undefined
      ? options.configCheck ? 'RUN CONFIG CHECK ONCE' : 'RUN LOG RECEIPT ONCE' : options.confirmation)}`,
    '}',
    '<# Intercept both child modes and validate credential isolation in the stdin envelope. #>',
    'function Invoke-Gate1ReceiptNode([string]$Mode, [string]$InputJson) {',
    '  Assert-FixtureCondition ($args.Count -eq 0)',
    `  Assert-FixtureCondition (-not $Mode.Contains(${psLiteral(TOKEN)}))`,
    "  if ($Mode -ceq '--review') {",
    '    Assert-FixtureCondition ($script:sequence.Count -eq 0)',
    `    Assert-FixtureCondition (-not $InputJson.Contains(${psLiteral(TOKEN)}))`,
    '    $script:reviewInput = $InputJson',
    "    $script:sequence.Add('review')",
    `    return @{ Json = ${psLiteral(JSON.stringify(prepared))}; ExitCode = ${options.reviewFailed ? 1 : 0} }`,
    '  }',
    "  Assert-FixtureCondition ($Mode -ceq '--live' -and ($script:sequence -join ',') -ceq 'review,confirmation,hidden_token')",
    '  $envelope = $InputJson | ConvertFrom-Json',
    '  Assert-FixtureCondition (@($envelope.PSObject.Properties).Count -eq 3)',
    '  Assert-FixtureCondition (@($envelope.credentials.PSObject.Properties).Count -eq 1)',
    `  Assert-FixtureCondition ($envelope.credentials.providerToken -ceq ${psLiteral(TOKEN)})`,
    `  Assert-FixtureCondition ($envelope.approval -ceq ${psLiteral(digest)})`,
    '  $roundTrip = ConvertTo-Json -InputObject $envelope.profile -Depth 8 -Compress',
    '  Assert-FixtureCondition ($roundTrip -ceq $script:reviewInput)',
    '  $script:liveEnvelopeValidated = $true',
    "  $script:sequence.Add('live_stdin')",
    "  return @{ Json = '{\"fixture\":true}'; ExitCode = 13 }",
    '}',
    '$threw = $false; $returnedExitCode = $null',
    'try { $result = Invoke-Gate1LogReceipt; $returnedExitCode = $result.ExitCode } catch { $threw = $true }',
    'ConvertTo-Json -Depth 4 -Compress -InputObject @{ sequence = @($script:sequence); threw = $threw;',
    '  fixtureViolation = $script:fixtureViolation; liveEnvelopeValidated = $script:liveEnvelopeValidated; returnedExitCode = $returnedExitCode }',
  ].join('\n');
  try {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  } finally { fs.unlinkSync(file); }
}

/** Exercise selector validation while replacing every child invocation and rejecting all prompts. */
function launcherSelectorFixture(args) {
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    `. ${psLiteral(LAUNCHER)} ${args.map((value) => /^-[A-Za-z]+$/.test(value) ? value : psLiteral(value)).join(' ')}`,
    '$script:modes = [Collections.Generic.List[string]]::new(); $script:prompted = $false',
    '<# Capture offline child selection without executing Node or permitting traffic. #>',
    'function Invoke-Gate1ReceiptNode([string]$Mode, [string]$InputJson) {',
    "  $script:modes.Add($Mode); return @{ Json = '{}'; ExitCode = 0 }",
    '}',
    '<# Any prompt is a failure for an offline selector. #>',
    "function Read-Host { $script:prompted = $true; throw 'Unexpected prompt.' }",
    '$threw = $false',
    'try { $null = Invoke-Gate1LogReceipt } catch { $threw = $true }',
    'ConvertTo-Json -Compress -InputObject @{ modes = @($script:modes); prompted = $script:prompted; threw = $threw }',
  ].join('\n');
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 10000, windowsHide: true });
}

describe('offline CLI and guarded PowerShell launcher', () => {
  it.each([[], ['--prepare'], ['--template'], ['--review']].map((args) => [args]))('keeps the real %j CLI mode offline', (args) => {
    const child = offlineCli(args, args[0] === '--review' ? `\uFEFF${JSON.stringify(profile(Date.now()))}` : undefined);
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('');
    const output = JSON.parse(child.stdout);
    if (args[0] === '--template') expect(Object.values(output.attestations)).toEqual([false, false, false, false, false]);
    else expect(output).toMatchObject({ mode: 'prepare', liveApproved: false, appRequests: 0, providerRequests: 0, gate1Status: 'open' });
    for (const value of [TOKEN, PRIVATE, ADDRESS]) expect(child.stdout).not.toContain(value);
    expect(Buffer.byteLength(child.stdout)).toBeLessThanOrEqual(LIMITS.reportBytes);
  });

  it.each([
    { args: ['--unknown', PRIVATE] },
    { args: ['--review'], input: PRIVATE },
    { args: ['--review'], input: 'x'.repeat(LIMITS.inputBytes + 1) },
  ])('rejects invalid offline input without echoing it (%#)', ({ args, input }) => {
    const child = offlineCli(args, input);
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1); expect(child.stdout).toBe('');
    expect(child.stderr).toContain('Do not rerun'); expect(child.stderr).not.toContain(PRIVATE);
    expect(child.stderr).not.toContain('fixture_network_blocked');
  });

  (process.platform === 'win32' ? it.each : it.skip.each)([
    { wrongApproval: true }, { reviewFailed: true },
    { reviewChanges: { providerOrigin: 'https://unapproved.example.test' } },
    { reviewChanges: { liveApproved: true } },
    { reviewChanges: { application: { method: 'POST', path: '/api/auth/session', credentials: 'none' } } },
    { reviewChanges: { rule: { action: 'deny', rateLimit: false } } },
    { limitChanges: { maxAppRequests: 2 } }, { limitChanges: { maxProviderRequests: 12 } },
    { limitChanges: { cleanupProviderRequests: 4 } }, { limitChanges: { unknownLimit: 1 } },
  ])('stops an invalid live review before confirmation or token entry (%#)', (options) => {
    const child = launcherFixture(options);
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toMatchObject({ sequence: ['review'], threw: true,
      fixtureViolation: false, liveEnvelopeValidated: false, returnedExitCode: null });
    expect(child.stdout + child.stderr).not.toContain(TOKEN);
  });

  (process.platform === 'win32' ? it.each : it.skip.each)(['', 'RUN ONCE', 'run log receipt once'])(
    'requires exact confirmation before requesting a token (%#)', (confirmation) => {
    const child = launcherFixture({ confirmation });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toMatchObject({ sequence: ['review', 'confirmation'], threw: true,
      fixtureViolation: false, liveEnvelopeValidated: false });
  });

  (process.platform === 'win32' ? it : it.skip)('uses hidden token entry after confirmation and passes only the exact stdin envelope', () => {
    const child = launcherFixture();
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toEqual({ sequence: ['review', 'confirmation', 'hidden_token', 'live_stdin'],
      threw: false, fixtureViolation: false, liveEnvelopeValidated: true, returnedExitCode: 13 });
    expect(child.stdout + child.stderr).not.toContain(TOKEN);
  });

  (process.platform === 'win32' ? it : it.skip)('rejects malformed hidden credentials without invoking live mode', () => {
    const child = launcherFixture({ token: 'invalid' });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toMatchObject({ sequence: ['review', 'confirmation', 'hidden_token'], threw: true,
      fixtureViolation: false, liveEnvelopeValidated: false });
  });
});

describe('read-only config CLI and hidden-input launcher separation', () => {
  (process.platform === 'win32' ? it.each : it.skip.each)([
    [['-ConfigTemplate'], '--config-template'], [['-ConfigCheck'], '--config-prepare'],
  ])('selects only its offline child mode for %j', (args, expectedMode) => {
    const child = launcherSelectorFixture(args);
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toEqual({ modes: [expectedMode], prompted: false, threw: false });
  });

  (process.platform === 'win32' ? it.each : it.skip.each)([
    ['-ConfigCheck', '-Template'], ['-ConfigTemplate', '-Template'], ['-ConfigCheck', '-ConfigTemplate'],
    ['-ConfigCheck', '-Live'], ['-ConfigTemplate', '-Live'],
    ['-ConfigCheck', '-ProfilePath', 'fixture.json'], ['-ConfigTemplate', '-ProfilePath', 'fixture.json'],
    ['-ConfigCheck', '-Approval', '0'.repeat(64)], ['-ConfigTemplate', '-Approval', '0'.repeat(64)],
  ].map((args) => [args]))('rejects conflicting selector arguments %j before any child or prompt', (args) => {
    const child = launcherSelectorFixture(args);
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toEqual({ modes: [], prompted: false, threw: true });
  });

  it.each(['--config-template', '--config-prepare', '--review'])('keeps %s config preparation offline', (mode) => {
    const selected = profile(Date.now(), 'config_check');
    const child = offlineCli([mode], mode === '--review' ? JSON.stringify(selected) : undefined);
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('');
    const output = JSON.parse(child.stdout);
    if (mode === '--config-template') {
      expect(output.queryMode).toBe('config_check'); expect(Object.values(output.attestations)).toEqual([false, false, false]);
    } else {
      expect(output).toMatchObject({ mode: 'prepare', queryMode: 'config_check', liveApproved: false,
        scope: 'provider_firewall_config_check_only', configMutations: 0, eventsQueries: 0,
        appRequests: 0, providerRequests: 0 });
    }
    expectConfigPrivate(output);
  });

  (process.platform === 'win32' ? it : it.skip)('requires the config confirmation and passes hidden credentials only through stdin', () => {
    const child = launcherFixture({ configCheck: true });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toEqual({ sequence: ['review', 'confirmation', 'hidden_token', 'live_stdin'],
      threw: false, fixtureViolation: false, liveEnvelopeValidated: true, returnedExitCode: 13 });
    expect(child.stdout + child.stderr).not.toContain(TOKEN);
  });

  (process.platform === 'win32' ? it.each : it.skip.each)(['RUN LOG RECEIPT ONCE', 'RUN ONCE', '', 'run config check once'])(
    'refuses an unrelated or inexact config confirmation (%#)', (confirmation) => {
      const child = launcherFixture({ configCheck: true, confirmation });
      expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('');
      expect(JSON.parse(child.stdout)).toMatchObject({ sequence: ['review', 'confirmation'], threw: true,
        fixtureViolation: false, liveEnvelopeValidated: false });
    });

  (process.platform === 'win32' ? it.each : it.skip.each)([
    { wrongApproval: true }, { reviewFailed: true },
    { reviewChanges: { queryMode: 'ordinary_log_receipt' } },
    { reviewChanges: { scope: 'ordinary_log_receipt_trial_only' } },
    { reviewChanges: { method: 'PATCH' } },
    { reviewChanges: { endpoint: 'https://api.vercel.com/v1/security/firewall/config/draft' } },
    { reviewChanges: { application: { method: 'GET', path: '/api/auth/session', credentials: 'none' } } },
    { reviewChanges: { rule: { action: 'log' } } },
    { reviewChanges: { configMutations: 1 } },
    { reviewChanges: { eventsQueries: 1 } },
    { limitChanges: { maxAppRequests: 1 } }, { limitChanges: { maxProviderRequests: 2 } },
    { limitChanges: { maxConfigMutations: 1 } }, { limitChanges: { maxEventsQueries: 1 } },
    { limitChanges: { cleanupProviderRequests: 5 } },
  ])('rejects a widened or mismatched config review before requesting approval or credentials (%#)', (options) => {
    const child = launcherFixture({ ...options, configCheck: true });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toMatchObject({ sequence: ['review'], threw: true,
      fixtureViolation: false, liveEnvelopeValidated: false });
    expect(child.stdout + child.stderr).not.toContain(TOKEN);
  });
});

/**
 * Model only the runner's durable writes in memory. Native HTTPS is replaced by
 * the same closed fixture transport, so production persistence paths can be
 * tested without creating evidence files or contacting Vercel.
 */
function durableFixture(wire, failRename = () => false) {
  const records = new Map(), descriptors = new Map(), writes = [], spies = [];
  const openRead = fs.openSync.bind(fs), closeRead = fs.closeSync.bind(fs);
  let nextDescriptor = 50000;
  spies.push(jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {}));
  spies.push(jest.spyOn(fs, 'writeFileSync').mockImplementation((destination, encoded, options) => {
    const file = typeof destination === 'number' ? descriptors.get(destination) : destination;
    if (options?.flag === 'wx' && records.has(file)) throw Object.assign(new Error(PRIVATE), { code: 'EEXIST' });
    if (!file) throw new Error(PRIVATE);
    records.set(file, encoded); writes.push(encoded);
  }));
  spies.push(jest.spyOn(fs, 'openSync').mockImplementation((file, flags) => {
    if (flags === 'r') return openRead(file, flags);
    expect(flags).toBe('wx');
    if (records.has(file)) throw new Error(PRIVATE);
    const descriptor = nextDescriptor++; descriptors.set(descriptor, file); return descriptor;
  }));
  spies.push(jest.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
    if (descriptors.has(descriptor)) descriptors.delete(descriptor);
    else closeRead(descriptor);
  }));
  spies.push(jest.spyOn(fs, 'fsyncSync').mockImplementation(() => {}));
  spies.push(jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (failRename()) throw new Error(PRIVATE);
    records.set(to, records.get(from)); records.delete(from);
  }));
  nativeGuard.mockImplementation(wire.requestImpl);
  /** Exercise production persistence with an in-memory network fixture and fixed clocks. */
  async function run() {
    const selected = profile();
    return runReceipt({ profile: selected, approval: approvalId(selected), credentials: { providerToken: TOKEN } },
      { ...wire.deps, requestImpl: undefined });
  }
  /** Restore all file mocks and reinstate the suite's independent native-network denial. */
  function restore() {
    for (const spy of spies.reverse()) spy.mockRestore();
    nativeGuard.mockReset();
    nativeGuard.mockImplementation(() => { throw new Error('Native HTTPS forbidden'); });
  }
  return { records, writes, run, restore };
}

describe('durable approval and recovery evidence', () => {
  it('consumes one approval exclusively and persists only sanitized recovery facts', async () => {
    const wire = fixture(), storage = durableFixture(wire);
    try {
      const first = await storage.run();
      expect(first).toMatchObject({ result: 'completed', appRequests: 1, providerRequests: 11,
        cleanup: { restorationVerified: true } });
      expect(nativeGuard).toHaveBeenCalledTimes(12);
      expect(JSON.parse(storage.records.get(first.reportPath))).toMatchObject({
        result: 'completed', ruleId: RULE_ID, cleanup: { restorationVerified: true } });
      for (const encoded of storage.writes) {
        expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(LIMITS.reportBytes);
        expectPrivate(JSON.parse(encoded), wire);
      }
      const second = await storage.run();
      expect(second).toMatchObject({ result: 'stopped', failure: 'approval_consumed', appRequests: 0, providerRequests: 0 });
      expect(nativeGuard).toHaveBeenCalledTimes(12);
      expectPrivate(second, wire);
    } finally { storage.restore(); }
  });

  it('stops before transport when a recovery checkpoint cannot be saved', async () => {
    const wire = fixture(), storage = durableFixture(wire, () => true);
    try {
      const report = await storage.run();
      expect(report).toMatchObject({ result: 'stopped', failure: 'local_evidence', appRequests: 0, providerRequests: 0 });
      expect(nativeGuard).not.toHaveBeenCalled();
      expectPrivate(report, wire);
      expect(() => JSON.parse(storage.records.get(report.reportPath))).not.toThrow();
    } finally { storage.restore(); }
  });

  it('preserves the prior valid record and still cleans its draft when persistence fails after insertion', async () => {
    const wire = fixture(), storage = durableFixture(wire, () => wire.state.labels.includes('rules.insert'));
    try {
      const report = await storage.run();
      expect(report).toMatchObject({ result: 'stopped', failure: 'local_evidence', appRequests: 0,
        providerRequests: 5, cleanup: { status: 'restored', restorationVerified: true }, evidenceFailure: 'local_evidence' });
      expect(nativeGuard).toHaveBeenCalledTimes(5);
      expect(wire.state.labels).toEqual(['config', 'rules.insert', 'config', 'discard', 'config']);
      const saved = JSON.parse(storage.records.get(report.reportPath));
      expect(saved.result).toBe('stopped');
      expect(saved.cleanup.restorationVerified).toBe(false);
      for (const encoded of storage.writes) expectPrivate(JSON.parse(encoded), wire);
      expectPrivate(report, wire);
    } finally { storage.restore(); }
  });
});
