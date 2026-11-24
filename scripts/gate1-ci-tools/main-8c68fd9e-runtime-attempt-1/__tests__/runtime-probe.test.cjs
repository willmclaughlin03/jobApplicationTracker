'use strict';
/* global describe, it, expect, afterEach, jest, __dirname, Buffer, setTimeout, process */

/** Offline response, lifecycle and evidence fixtures: no real HTTP client, listener or Next instance. */
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const tool = require('../runtime-probe.cjs');
const base = require('../../main-8c68fd9e-static-attempt-1/qualify-static.cjs');
const staticInspector = require('../../main-8c68fd9e-static-attempt-1/inspect-compiled.cjs');
const fixtureBase = path.resolve(__dirname, '../../../../.tmp/gate1-runtime-tests'), fixtures = [];

// The owner-reviewed vocabulary is independent of the exported map; added or misspelled codes fail this fixture.
const EXPECTED_ISOLATION_CODES = [
  'isolation_service_private_network', 'isolation_service_private_tmp', 'isolation_service_no_new_privileges',
  'isolation_service_protect_system', 'isolation_service_protect_home', 'isolation_service_protect_control_groups',
  'isolation_service_capability_bounding_set', 'isolation_service_ambient_capabilities', 'isolation_service_restrict_address_families',
  'isolation_service_restrict_namespaces', 'isolation_service_memory_max', 'isolation_service_memory_swap_max',
  'isolation_service_tasks_max', 'isolation_service_kill_mode', 'isolation_service_send_sigkill',
  'isolation_service_restart', 'isolation_service_limit_core', 'isolation_service_collect_mode',
  'isolation_service_user', 'isolation_service_group', 'isolation_service_active_state',
  'isolation_service_sub_state', 'isolation_service_load_state', 'isolation_service_type',
  'isolation_service_control_group', 'isolation_service_cpu_quota', 'isolation_service_runtime_max',
  'isolation_service_timeout_stop', 'isolation_service_timeout_start', 'isolation_service_working_directory',
  'isolation_service_read_only_paths', 'isolation_service_read_write_paths', 'isolation_service_config',
  'isolation_service_metadata_size', 'isolation_service_metadata_encoding', 'isolation_service_metadata_format',
  'isolation_service_metadata_keys', 'isolation_service_metadata_missing', 'isolation_service_metadata_shape',
  'isolation_kernel_metadata_size', 'isolation_network_namespace', 'isolation_network_interfaces',
  'isolation_cgroup_membership', 'isolation_cpu_limit', 'isolation_memory_limit',
  'isolation_swap_limit', 'isolation_tasks_limit', 'isolation_no_new_privileges',
  'isolation_effective_capabilities', 'isolation_bounding_capabilities', 'isolation_seccomp',
  'isolation_path_run_user', 'isolation_path_canonical', 'isolation_mount_table_input',
  'isolation_mount_options', 'isolation_mount_table_format', 'isolation_mount_missing',
  'isolation_mount_run_user', 'isolation_mount_ambiguous', 'isolation_mount_mode',
  'isolation_mount_descendant', 'isolation_ready_deadline', 'isolation_ready_record',
  'isolation_release_deadline', 'isolation_release_race', 'isolation_child_release_deadline',
  'isolation_child_release_record',
];

/** Allocate bounded protocol fixtures only below this suite's scratch boundary. */
function scratch() {
  fs.mkdirSync(fixtureBase, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixtureBase, 'protocol-')); fixtures.push(dir); return dir;
}

/** Supply independent sanitized inspection facts without reading any application build. */
function inspection() {
  return { facts: { nodeMiddleware: true, matcherPreserved: true, sourceRoutesPresent: true, pageCount: 2, buildId: 'synthetic',
    manifests: Object.fromEntries(staticInspector.NAMES.map(name => [name, 'd'.repeat(64)])), traceHash: 'e'.repeat(64),
    compiledFiles: 1, compiledBytes: 123, compiledClosureHash: 'f'.repeat(64), readerCandidates: 1 }, reader: {} };
}

/** Generate deterministic distinct challenges so test expectations are reproducible without storing real credentials. */
function cases() { let next = 0; return tool.smokeCases(() => Buffer.alloc(16, ++next)); }

/** Make a contract-correct transient response independently for each case. */
function response(item) {
  const positive = item.case.startsWith('authenticated'), protectedCase = item.case === 'protected_redirect';
  const headers = { 'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate', 'cdn-cache-control': 'no-store', 'vercel-cdn-cache-control': 'no-store' };
  if (positive) headers[tool.HEADERS.observation] = JSON.stringify({ schemaVersion: 1, scope: 'middleware', challenge: item.challenge, nodeVersion: 'v22.23.3', node22: true });
  if (protectedCase) headers.location = '/login';
  return { status: protectedCase ? 307 : 200, headers, rawHeaders: Object.entries(headers).flat(), bodyBytes: protectedCase ? 0 : 42 };
}

/** Supply exactly the expected reader counts, independently from the response reviewer. */
function counts(item) { const n = item.case.startsWith('authenticated') ? 1 : 0; return { version: n, nodeVersion: n, releaseName: n }; }

/** Fake the complete server lifecycle and collect pre-transport accounting snapshots. */
function harness() {
  const report = { ...tool.emptyRuntime(), stage: 'inspect', isolationVerified: true, inspection: inspection().facts }, progress = [];
  const server = new EventEmitter(), next = { prepare: jest.fn().mockResolvedValue(), getRequestHandler: jest.fn(), close: jest.fn().mockResolvedValue() };
  server.listening = false;
  server.listen = jest.fn((options, done) => { server.options = options; server.listening = true; done(); });
  server.close = jest.fn(done => { server.listening = false; done(); });
  let current;
  const observer = { reset: jest.fn(), restore: jest.fn(), snapshot: jest.fn(() => counts(current)) };
  const ops = { makeNext: jest.fn(() => next), createServer: jest.fn(() => server), observe: jest.fn(() => observer), nativeVersion: 'v22.23.3', cases,
    phase: jest.fn(), request: jest.fn(async item => { expect(progress.at(-1).attempted).toBe(report.attempted); current = item; return response(item); }) };
  return { report, progress, server, next, observer, ops,
    run: () => tool.smoke('/synthetic-app', inspection(), report, value => progress.push(JSON.parse(JSON.stringify(value))), ops) };
}

/** Restore mocked state and delete only verified synthetic protocol directories. */
afterEach(() => {
  jest.useRealTimers(); jest.restoreAllMocks();
  for (const dir of fixtures.splice(0)) {
    if (!path.resolve(dir).startsWith(fixtureBase + path.sep) || fs.lstatSync(dir).isSymbolicLink()) throw new Error('fixture_boundary');
    fs.rmSync(dir, { recursive: true, force: false });
  }
});

describe('exact evidence keys', () => {
  it.each(['buildId', 'traceHash', 'compiledClosureHash', 'manifest'])('rejects coerced inspection %s before invoking the static validator', field => {
    const facts = inspection().facts, validate = jest.spyOn(base, 'validateInspection');
    if (field === 'manifest') facts.manifests[staticInspector.NAMES[0]] = ['d'.repeat(64)];
    else facts[field] = field === 'buildId' ? 123 : [facts[field]];
    expect(() => tool.validateRuntime({ ...tool.emptyRuntime(), isolationVerified: true, inspection: facts })).toThrow('report_schema');
    expect(validate).not.toHaveBeenCalled();
  });
  it.each(['combined', 'missing', 'extra'])('rejects %s manifest keys before invoking the static validator', variant => {
    const facts = inspection().facts, keys = [...staticInspector.NAMES].sort(), validate = jest.spyOn(base, 'validateInspection');
    if (variant === 'combined') facts.manifests = Object.fromEntries([[keys[0] + '|' + keys[1], 'd'.repeat(64)], ...keys.slice(2).map(key => [key, 'd'.repeat(64)])]);
    if (variant === 'missing') delete facts.manifests[keys[0]];
    if (variant === 'extra') facts.manifests.extra = 'd'.repeat(64);
    expect(() => tool.validateRuntime({ ...tool.emptyRuntime(), isolationVerified: true, inspection: facts })).toThrow('report_schema');
    expect(validate).not.toHaveBeenCalled();
  });
  it('still delegates valid inspection records to the frozen validator', () => {
    const facts = inspection().facts, validate = jest.spyOn(base, 'validateInspection');
    tool.validateRuntime({ ...tool.emptyRuntime(), isolationVerified: true, inspection: facts });
    expect(validate).toHaveBeenCalledWith(facts);
    facts.traceHash = 'invalid';
    expect(() => tool.validateRuntime({ ...tool.emptyRuntime(), isolationVerified: true, inspection: facts })).toThrow('report_schema');
  });
  it.each([{ 'a|b': true }, { a: true }, { a: true, b: true, extra: true }])('rejects merged, missing or extra fields %#', value => {
    expect(tool.exactKeys(value, ['a', 'b'])).toBe(false);
  });
  it('rejects delimiter collisions even when the key counts match', () => {
    expect(tool.exactKeys({ a: true, 'b|c': true }, ['a|b', 'c'])).toBe(false);
  });
  it('does not count inherited fields in place of expected own fields', () => {
    const value = Object.assign(Object.create({ b: true }), { a: true, extra: true });
    expect(tool.exactKeys(value, ['a', 'b'])).toBe(false);
  });
  it('accepts the exact own fields regardless of order or a null prototype', () => {
    expect(tool.exactKeys({ b: true, a: true }, ['a', 'b'])).toBe(true);
    expect(tool.exactKeys(Object.assign(Object.create(null), { a: true, b: true }), ['a', 'b'])).toBe(true);
    expect(tool.exactKeys({}, [])).toBe(true);
  });
});

describe('six finite cases and privacy', () => {
  it('uses distinct fresh challenges, different valid-format wrong key, no cookies and the exact paths', () => {
    const items = cases(); expect(items.map(item => item.case)).toEqual(tool.CASES);
    expect(new Set(items.map(item => item.challenge)).size).toBe(6);
    expect(items.map(item => item.path)).toEqual(['/login', '/login', '/login', '/login', '/login', '/admin'].map((p, i) => i === 4 ? p + '?scope=1' : p));
    expect(items[0].headers).toEqual({}); expect(items[3].headers[tool.HEADERS.key]).toBe('c'.repeat(64));
    expect(items.some(item => 'cookie' in item.headers)).toBe(false);
  });
  it('rejects collisions without retrying random generation', () => {
    const random = jest.fn(() => Buffer.alloc(16)); expect(() => tool.smokeCases(random)).toThrow('observation'); expect(random).toHaveBeenCalledTimes(6);
  });
  it('accepts all six contracts and persists no raw input or response', () => {
    const values = cases().map(item => tool.reviewResponse(response(item), item, counts(item), 'v22.23.3'));
    expect(tool.validateCases(values)).toEqual(values);
    expect(JSON.stringify(values)).not.toMatch(/headers|challenge":|aaaaaaa|01010101|cache-control/);
  });
  it('rejects a response with native-count names merged into one field', () => {
    const item = cases()[1];
    expect(() => tool.reviewResponse(response(item), item, { 'nodeVersion|releaseName|version': 1 }, 'v22.23.3')).toThrow('runtime_read');
  });
  it('rejects retained evidence with native-count names merged into one field', () => {
    const values = cases().map(item => tool.reviewResponse(response(item), item, counts(item), 'v22.23.3'));
    values[1].nativeReadCounts = { 'nodeVersion|releaseName|version': 1 };
    expect(() => tool.validateCases(values)).toThrow('report_schema');
  });
  it.each([0, 1, 2, 3, 4, 5])('rejects cookies in case %i even if only raw metadata contains them', i => {
    const item = cases()[i], result = response(item); result.rawHeaders.push('Set-Cookie', 'synthetic');
    expect(() => tool.reviewResponse(result, item, counts(item), 'v22.23.3')).toThrow('cache_cookie');
  });
  it.each([0, 3, 4, 5])('rejects an observation on negative case %i', i => {
    const item = cases()[i], result = response(item); result.headers[tool.HEADERS.observation] = '{}';
    expect(() => tool.reviewResponse(result, item, counts(item), 'v22.23.3')).toThrow('observation');
  });
  it.each(['duplicate', 'malformed', 'stale', 'wrong-node', 'duplicate-json-key', 'raw-disagreement'])('rejects %s positive observations', variant => {
    const item = cases()[1], result = response(item), name = tool.HEADERS.observation;
    if (variant === 'duplicate') result.rawHeaders.push(name.toUpperCase(), result.headers[name]);
    if (variant === 'malformed') result.headers[name] = 'private raw';
    if (variant === 'stale') result.headers[name] = result.headers[name].replace(item.challenge, cases()[2].challenge);
    if (variant === 'wrong-node') result.headers[name] = result.headers[name].replace('v22.23.3', 'v24.1.0');
    if (variant === 'duplicate-json-key') result.headers[name] = result.headers[name].replace('{', '{"schemaVersion":1,');
    if (variant === 'raw-disagreement') result.rawHeaders[result.rawHeaders.indexOf(name) + 1] = '{}';
    expect(() => tool.reviewResponse(result, item, counts(item), 'v22.23.3')).toThrow('observation');
  });
  it.each(['public, private, no-store', 'private, max-age=20, no-store', 'private, s-maxage = 1, no-store', 'private', 'no-store'])('rejects unsafe cache directives: %s', value => {
    expect(tool.privateNoStore({ 'cache-control': value })).toBe(false);
  });
  it.each([
    'extension="x, private, no-store, y"',
    'private, extension="x, no-store, y"',
    'no-store, extension="x, private, y"',
    'private, no-store, extension="ordinary"',
    'extension="x, private, no-store',
  ])('rejects quoted cache values without recording private/no-store evidence: %s', value => {
    expect(tool.privateNoStore({ 'cache-control': value })).toBe(false);
    const item = cases()[1], result = response(item);
    result.headers['cache-control'] = value; result.rawHeaders = Object.entries(result.headers).flat();
    expect(() => tool.reviewResponse(result, item, counts(item), 'v22.23.3')).toThrow('cache_cookie');
  });
  it.each([
    'private, no-cache, no-store, max-age=0, must-revalidate',
    ' PRIVATE , No-Store , max-age = 0 , s-maxage=0 ',
  ])('accepts the unquoted cache policy: %s', value => {
    expect(tool.privateNoStore({ 'cache-control': value })).toBe(true);
  });
  it('rejects a CDN override, wrong status, empty login and incorrect native reads', () => {
    const item = cases()[1];
    for (const mutate of [r => { r.headers['cdn-cache-control'] = 'public'; }, r => { r.status = 302; }, r => { r.bodyBytes = 0; }]) {
      const result = response(item); mutate(result); expect(() => tool.reviewResponse(result, item, counts(item), 'v22.23.3')).toThrow();
    }
    expect(() => tool.reviewResponse(response(item), item, { version: 0, nodeVersion: 1, releaseName: 1 }, 'v22.23.3')).toThrow('runtime_read');
  });
  it.each(['https://elsewhere.invalid/login', '/login?next=admin', '/login#hash', 'http://user@127.0.0.1:32147/login', '/admin'])('rejects a protected redirect to %s', location => {
    const item = cases()[5], result = response(item); result.headers.location = location;
    expect(() => tool.reviewResponse(result, item, counts(item), 'v22.23.3')).toThrow('route');
  });
  it.each([
    ['missing', []],
    ['duplicate', ['location', '/login', 'location', '/login']],
    ['mixed-case duplicate', ['Location', '/login', 'lOcAtIoN', '/login']],
    ['conflicting duplicate', ['Location', '/login', 'LOCATION', 'https://elsewhere.invalid/login']],
  ])('rejects %s raw Location fields despite a valid normalized location', (_variant, fields) => {
    const item = cases()[5], result = response(item);
    result.rawHeaders = Object.entries(result.headers).filter(([name]) => name !== 'location').flat().concat(fields);
    expect(() => tool.reviewResponse(result, item, counts(item), 'v22.23.3')).toThrow('route');
  });
  it.each([
    [307, 'Location', '/login'],
    [308, 'lOcAtIoN', 'http://127.0.0.1:32147/login'],
  ])('accepts status %i with one %s field and a valid normalized location', (status, name, location) => {
    const item = cases()[5], result = response(item);
    result.status = status; result.headers.location = location;
    result.rawHeaders = Object.entries(result.headers).filter(([key]) => key !== 'location').flat().concat(name, location, 'X-Synthetic', 'LOCATION');
    expect(tool.reviewResponse(result, item, counts(item), 'v22.23.3')).toMatchObject({ status, loginRedirect: true });
  });
  it.each([200, 302])('rejects protected status %i even with one valid Location field', status => {
    const item = cases()[5], result = response(item); result.status = status;
    expect(() => tool.reviewResponse(result, item, counts(item), 'v22.23.3')).toThrow('route');
  });
});

describe('bounded transport without network', () => {
  it('uses a single unpooled GET and counts/discards the body', async () => {
    const req = new EventEmitter(), res = new EventEmitter(); req.destroy = jest.fn(); res.destroy = jest.fn();
    Object.assign(res, { statusCode: 200, headers: {}, rawHeaders: [] });
    const transport = jest.fn((_options, incoming) => { req.end = () => { incoming(res); res.emit('data', Buffer.alloc(7)); res.emit('end'); }; return req; });
    expect(await tool.getLocal(cases()[0], transport)).toEqual({ status: 200, headers: {}, rawHeaders: [], bodyBytes: 7 });
    expect(transport).toHaveBeenCalledTimes(1); expect(transport.mock.calls[0][0]).toMatchObject({ host: '127.0.0.1', port: 32147, agent: false, method: 'GET', maxHeaderSize: 16384 });
    expect(req.destroy).toHaveBeenCalledTimes(1); expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(req.maxHeadersCount).toBe(0);
  });
  it.each(['overflow', 'abort', 'error', 'premature-close', 'header-error', 'throw'])('closes owned ends on %s without retry', async variant => {
    const req = new EventEmitter(), res = new EventEmitter(); req.destroy = jest.fn(); res.destroy = jest.fn();
    const transport = jest.fn((_options, incoming) => {
      if (variant === 'throw') throw new Error('private');
      req.end = () => {
        if (variant === 'header-error') { req.emit('error', { code: 'HPE_HEADER_OVERFLOW' }); return; }
        incoming(res);
        if (variant === 'overflow') res.emit('data', Buffer.alloc(tool.LIMITS.bodyBytes + 1));
        else res.emit(variant === 'abort' ? 'aborted' : variant === 'premature-close' ? 'close' : 'error', new Error('private'));
      }; return req;
    });
    await expect(tool.getLocal(cases()[0], transport)).rejects.toThrow(variant === 'overflow' ? 'http_cap' : 'http');
    expect(transport).toHaveBeenCalledTimes(1);
    if (variant !== 'throw') expect(req.destroy).toHaveBeenCalledTimes(1);
  });
  it('times out a silent response and closes the request', async () => {
    jest.useFakeTimers(); const req = new EventEmitter(); req.end = jest.fn(); req.destroy = jest.fn();
    const pending = expect(tool.getLocal(cases()[0], () => req)).rejects.toThrow('http');
    await jest.advanceTimersByTimeAsync(10000); await pending; expect(req.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('same-process lifecycle and truthful cleanup', () => {
  it.each([0, -1, NaN, Infinity])('observes late rejection after an expired or invalid allowance %s', async ms => {
    let reject;
    const operation = new Promise((_resolve, fail) => { reject = fail; });
    await expect(tool.bounded(operation, ms, 'cleanup')).rejects.toThrow('cleanup');
    reject(new Error('synthetic late failure'));
    await new Promise(resolve => setTimeout(resolve, 0)); // An unhandled late rejection would fail the suite.
  });
  it('attempts and observes Next closure even after descriptor restoration consumes the cleanup budget', async () => {
    const h = harness(); let time = 0;
    h.ops.now = () => time;
    h.observer.restore.mockImplementation(() => { time = 5000; });
    h.next.close.mockRejectedValue(new Error('synthetic close rejection'));
    await expect(h.run()).rejects.toThrow('cleanup');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.next.close).toHaveBeenCalledTimes(1); expect(h.report.nextClosed).toBe(false);
  });
  it('records timely close settlement without claiming listener success', async () => {
    const h = harness(), listener = jest.fn().mockRejectedValue(new Error('synthetic listener failure'));
    h.next.close.mockImplementation(async () => { await Promise.allSettled([listener()]); });
    await h.run();
    expect(listener).toHaveBeenCalledTimes(1); expect(h.report.nextClosed).toBe(true);
  });
  it('keeps close rejection a cleanup failure while recording timely promise settlement', async () => {
    const h = harness(); h.next.close.mockRejectedValue(new Error('synthetic close rejection'));
    await expect(h.run()).rejects.toThrow('cleanup'); expect(h.report.nextClosed).toBe(true);
  });
  it('never upgrades nextClosed after a timed-out close later settles', async () => {
    jest.useFakeTimers(); const h = harness(); let finish;
    h.next.close.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = expect(h.run()).rejects.toThrow('cleanup');
    await jest.advanceTimersByTimeAsync(5000); await pending;
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(h.report.nextClosed).toBe(false);
  });
  it('makes exactly six attempts, then closes descriptors/server/Next and aborts the listen signal', async () => {
    const h = harness();
    await tool.smoke('/synthetic-app', inspection(), h.report, value => {
      if (value.stage === 'requests') {
        expect(h.report.attempted).toBe(value.attempted - 1);
        expect(h.ops.request).toHaveBeenCalledTimes(value.attempted - 1);
        expect(h.observer.reset).toHaveBeenCalledTimes(value.attempted);
      }
      tool.validateRuntime(value); h.progress.push(JSON.parse(JSON.stringify(value)));
    }, h.ops);
    expect(h.ops.request).toHaveBeenCalledTimes(6); expect(h.progress.map(p => p.attempted)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(h.report).toMatchObject({ attempted: 6, serverStarted: true, descriptorsRestored: true, serverClosed: true, nextClosed: true });
    expect(h.server.options.signal.aborted).toBe(true); expect(h.ops.phase.mock.calls).toEqual([['startup'], ['requests'], ['cleanup', false]]);
  });
  it('counts a failed transport attempt before invoking it, stops and still cleans up', async () => {
    const h = harness(); h.ops.request.mockRejectedValueOnce(new Error('private'));
    await expect(h.run()).rejects.toThrow('private'); expect(h.report.attempted).toBe(1); expect(h.report.cases).toEqual([]);
    expect(h.next.close).toHaveBeenCalledTimes(1); expect(h.observer.restore).toHaveBeenCalledTimes(1); expect(h.ops.request).toHaveBeenCalledTimes(1);
  });
  it('starts no request if progress persistence fails', async () => {
    const h = harness();
    await expect(tool.smoke('/app', inspection(), h.report, () => { throw new Error('persistence'); }, h.ops)).rejects.toThrow('persistence');
    expect(h.ops.request).not.toHaveBeenCalled(); expect(h.report.serverClosed).toBe(true);
  });
  it.each([1, 3])('preserves committed accounting and prior bytes when publication for attempt %i fails', async attempt => {
    const h = harness(), dir = scratch(), link = fs.linkSync;
    const previous = path.join(dir, `progress-0${attempt - 1}.json`), failed = path.join(dir, `progress-0${attempt}.json`);
    let previousBytes;
    jest.spyOn(fs, 'linkSync').mockImplementation((pending, filename) => {
      if (filename === failed) { previousBytes = fs.readFileSync(previous); throw new Error('disk'); }
      return link(pending, filename);
    });
    await expect(tool.smoke('/synthetic-app', inspection(), h.report, value => {
      tool.publish(dir, `progress-0${h.progress.length}.json`, value);
      h.progress.push(JSON.parse(JSON.stringify(value)));
    }, h.ops)).rejects.toThrow('persistence');
    expect(h.report.attempted).toBe(attempt - 1); expect(h.report.cases).toHaveLength(attempt - 1);
    expect(h.ops.request).toHaveBeenCalledTimes(attempt - 1); expect(h.observer.reset).toHaveBeenCalledTimes(attempt);
    expect(h.progress).toHaveLength(attempt); expect(h.progress.at(-1).attempted).toBe(attempt - 1);
    expect(previousBytes).toBeDefined(); expect(fs.readFileSync(previous)).toEqual(previousBytes);
    expect(fs.existsSync(failed)).toBe(false);
    expect(h.report).toMatchObject({ descriptorsRestored: true, serverClosed: true, nextClosed: true });
  });
  it('stops if the server emits an error while a response is in flight', async () => {
    const h = harness(); h.ops.request.mockImplementation(async item => { h.server.emit('error', new Error('private')); return response(item); });
    await expect(h.run()).rejects.toThrow('http'); expect(h.ops.request).toHaveBeenCalledTimes(1); expect(h.report.cases).toEqual([]);
  });
  it('shares thirty seconds across prepare and listen', async () => {
    jest.useFakeTimers(); const h = harness();
    h.next.prepare.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 29000)));
    h.server.listen.mockImplementation(() => {});
    const pending = expect(h.run()).rejects.toThrow('startup');
    await jest.advanceTimersByTimeAsync(30000); await pending;
    expect(h.ops.request).not.toHaveBeenCalled(); expect(h.next.close).toHaveBeenCalledTimes(1);
  });
  it('shares five seconds across both closures and attempts both when one stalls', async () => {
    jest.useFakeTimers(); const h = harness(); h.server.close.mockImplementation(() => {}); h.next.close.mockImplementation(() => new Promise(() => {}));
    const pending = expect(h.run()).rejects.toThrow('cleanup');
    await jest.advanceTimersByTimeAsync(5000); await pending;
    expect(h.report.serverClosed).toBe(false); expect(h.report.nextClosed).toBe(false); expect(h.next.close).toHaveBeenCalledTimes(1);
  });
  it('attempts Next closure after a descriptor restoration failure and destroys sockets', async () => {
    const h = harness(), socket = new EventEmitter(); socket.destroyed = false; socket.destroy = jest.fn(() => { socket.destroyed = true; });
    h.server.listen.mockImplementation((_options, done) => { h.server.emit('connection', socket); h.server.listening = true; done(); });
    h.observer.restore.mockImplementation(() => { throw new Error('private'); });
    await expect(h.run()).rejects.toThrow('cleanup'); expect(h.report.descriptorsRestored).toBe(false);
    expect(h.next.close).toHaveBeenCalledTimes(1); expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
  it.each([null, true, false])('preserves partial observer setup restoration fact %s', async restored => {
    const h = harness(); h.ops.observe.mockImplementation(() => { throw Object.assign(new Error('runtime_read'), { descriptorsRestored: restored }); });
    await expect(h.run()).rejects.toThrow(); expect(h.report.descriptorsRestored).toBe(restored);
    expect(h.report.serverClosed).toBe(null); expect(h.report.nextClosed).toBe(null); expect(h.ops.makeNext).not.toHaveBeenCalled();
  });
});

describe('fixed isolation diagnostics', () => {
  it('allows exactly the 67 approved guard identifiers and preserves the generic fallback', () => {
    expect([...tool.ISOLATION_CODES].sort()).toEqual([...EXPECTED_ISOLATION_CODES].sort());
    expect(tool.ISOLATION_CODES).toHaveLength(67);
    expect(new Set(tool.ISOLATION_CODES).size).toBe(67);
    expect(Object.isFrozen(tool.ISOLATION_CODES)).toBe(true);
    expect(tool.CODES.filter(code => code.startsWith('isolation_')).sort()).toEqual([...EXPECTED_ISOLATION_CODES].sort());
    expect(tool.failureCode({ code: 'isolation' })).toBe('isolation');
  });
  it.each(EXPECTED_ISOLATION_CODES)('publishes only %s from an allowlisted child failure', async code => {
    const dir = scratch(); tool.publish(dir, 'input.json', { synthetic: true });
    const makeNext = jest.fn(), inspect = jest.fn();
    const result = await tool.childMain('/app', dir, { validateInput: value => value, childFlag: '1', inspect,
      verifyKernel: () => { throw Object.assign(new Error('SYNTHETIC_SECRET_SENTINEL'), { code, privateMetadata: 'SYNTHETIC_SECRET_SENTINEL' }); },
      smoke: { makeNext } });
    expect(result).toEqual({ ...tool.emptyRuntime(), failure: code });
    const retained = tool.readJson(path.join(dir, 'runtime.json'));
    expect(retained).toEqual({ inputHash: base.sha(fs.readFileSync(path.join(dir, 'input.json'))), runtime: result });
    expect(JSON.stringify(retained)).not.toContain('SYNTHETIC_SECRET_SENTINEL');
    expect(inspect).not.toHaveBeenCalled(); expect(makeNext).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'ready.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'progress-00.json'))).toBe(false);
  });
  it.each(['isolation_SYNTHETIC_SECRET_SENTINEL', 'isolation_memory_limit SYNTHETIC_SECRET_SENTINEL', 'EACCES'])('sanitizes unknown child code %s to internal', async code => {
    const dir = scratch(); tool.publish(dir, 'input.json', { synthetic: true });
    const result = await tool.childMain('/app', dir, { validateInput: value => value, childFlag: '1',
      verifyKernel: () => { throw Object.assign(new Error('SYNTHETIC_SECRET_SENTINEL'), { code }); } });
    expect(result.failure).toBe('internal');
    expect(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8')).not.toContain('SYNTHETIC_SECRET_SENTINEL');
    expect(() => tool.validateRuntime({ ...tool.emptyRuntime(), failure: code })).toThrow('report_schema');
  });
  it('rejects extra diagnostic fields even beside an allowlisted code', () => {
    expect(() => tool.validateRuntime({ ...tool.emptyRuntime(), failure: 'isolation_memory_limit', details: 'SYNTHETIC_SECRET_SENTINEL' })).toThrow('report_schema');
  });
  it.each([
    ['absent', 'isolation_child_release_deadline'], ['late', 'isolation_child_release_deadline'],
    ['unbound', 'isolation_child_release_record'], ['unverified', 'isolation_child_release_record'],
    ['extra', 'isolation_child_release_record'], ['timestamp-type', 'isolation_child_release_record'],
    ['future', 'isolation_child_release_record'], ['noncanonical', 'report_schema'], ['duplicate', 'report_schema'],
  ])('stops on %s release evidence before inspection or Next startup', async (kind, code) => {
    const dir = scratch(); let time = 1000;
    tool.publish(dir, 'input.json', { deadline: 361000 });
    const inputHash = base.sha(fs.readFileSync(path.join(dir, 'input.json'))), inspect = jest.fn(), makeNext = jest.fn();
    const result = await tool.childMain('/app', dir, { validateInput: value => value, childFlag: '1', versions: base.VERSIONS,
      verifyKernel: jest.fn(), now: () => time, inspect, smoke: { makeNext }, pause: async () => {
        if (kind === 'absent') { time = 31000; return; }
        const release = { inputHash, serviceVerified: true, at: 1000 };
        if (kind === 'late') time = 31000;
        if (kind === 'unbound') release.inputHash = 'f'.repeat(64);
        if (kind === 'unverified') release.serviceVerified = false;
        if (kind === 'extra') release.private = 'SYNTHETIC_SECRET_SENTINEL';
        if (kind === 'timestamp-type') release.at = '1000';
        if (kind === 'future') release.at = 1001;
        if (kind === 'noncanonical' || kind === 'duplicate') {
          let bytes = JSON.stringify(release);
          if (kind === 'duplicate') bytes = bytes.replace('"at":', '"at":1000,"at":');
          fs.writeFileSync(path.join(dir, 'release.json'), bytes, { flag: 'wx' });
        } else tool.publish(dir, 'release.json', release);
      } });
    expect(result).toEqual({ ...tool.emptyRuntime(), failure: code });
    expect(inspect).not.toHaveBeenCalled(); expect(makeNext).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'progress-00.json'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8')).not.toContain('SYNTHETIC_SECRET_SENTINEL');
  });
});

describe('atomic protocol and strict evidence', () => {
  it('returns the committed digest after unlink failure and still refuses overwrite', () => {
    const dir = scratch(), filename = path.join(dir, 'ready.json'), pending = path.join(dir, '.pending-ready.json');
    const bytes = Buffer.from(JSON.stringify({ value: true }, null, 2) + '\n');
    jest.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw new Error('disk'); });
    expect(tool.publish(dir, 'ready.json', { value: true })).toBe(base.sha(bytes));
    expect(fs.readFileSync(filename)).toEqual(bytes); expect(fs.readFileSync(pending)).toEqual(bytes);
    expect(() => tool.publish(dir, 'ready.json', { value: false })).toThrow('persistence');
    expect(fs.readFileSync(filename)).toEqual(bytes);
  });
  it('never exposes a partial file and refuses overwrite/replay', () => {
    const dir = scratch(), write = fs.writeFileSync;
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation((fd, bytes) => { expect(fs.existsSync(path.join(dir, 'ready.json'))).toBe(false); return write(fd, bytes); });
    tool.publish(dir, 'ready.json', { value: true }); expect(tool.readJson(path.join(dir, 'ready.json'))).toEqual({ value: true });
    writeSpy.mockRestore();
    const original = fs.readFileSync(path.join(dir, 'ready.json')), link = jest.spyOn(fs, 'linkSync');
    expect(() => tool.publish(dir, 'ready.json', { value: false })).toThrow('persistence');
    expect(link).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith(path.join(dir, '.pending-ready.json'), path.join(dir, 'ready.json'));
    expect(link.mock.results[0]).toMatchObject({ type: 'throw', value: { code: 'EEXIST' } });
    expect(fs.readFileSync(path.join(dir, 'ready.json'))).toEqual(original);
    expect(tool.readJson(path.join(dir, 'ready.json'))).toEqual({ value: true });
  });
  it('leaves interrupted pending writes invisible and cannot replay them', () => {
    const dir = scratch(); const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('disk'); });
    expect(() => tool.publish(dir, 'ready.json', {})).toThrow('persistence'); write.mockRestore();
    expect(fs.existsSync(path.join(dir, 'ready.json'))).toBe(false); expect(fs.existsSync(path.join(dir, '.pending-ready.json'))).toBe(true);
    expect(() => tool.publish(dir, 'ready.json', {})).toThrow('persistence');
  });
  it.each(['../ready.json', '/ready.json', 'phase-99.json'])('rejects an unapproved record path %s', name => {
    expect(() => tool.publish(scratch(), name, {})).toThrow('persistence');
  });
  it('rejects link roots and oversized payloads before publication', () => {
    const dir = scratch(); expect(() => tool.publish(dir, 'ready.json', { extra: 'x'.repeat(base.LIMITS.reportBytes) })).toThrow('report_schema');
    jest.spyOn(fs, 'lstatSync').mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => true });
    expect(() => tool.publish(dir, 'ready.json', {})).toThrow('persistence');
  });
  it('rejects duplicate JSON keys and truncated JSON', () => {
    const dir = scratch(), filename = path.join(dir, 'runtime.json');
    for (const text of ['{"a":1,"a":2}', '{']) { fs.writeFileSync(filename, text); expect(() => tool.readJson(filename)).toThrow('report_schema'); }
  });
  it('accepts actual lifecycle order, including cleanup before recheck', () => {
    const phases = ['inspect', 'startup', 'requests', 'cleanup', 'recheck', 'complete'].map((phase, i) => ({ phase, at: 1000 + i }));
    expect(tool.validatePhases(phases, 999, 1010, 361000, true)).toBe('complete');
  });
  it.each([
    [[{ phase: 'requests', at: 1001 }], 1002, 'report_schema'],
    [[{ phase: 'inspect', at: 1000 }, { phase: 'startup', at: 121000 }], 121001, 'deadline'],
    [[{ phase: 'inspect', at: 1000 }, { phase: 'cleanup', at: 1001 }], 1002, 'report_schema'],
    [[{ phase: 'inspect', at: 900 }], 1002, 'report_schema'],
    [[], 31000, 'deadline'],
  ])('rejects missing, misordered or overdue phases %#', (records, now, code) => { expect(() => tool.validatePhases(records, 1000, now, 361000)).toThrow(code); });
  it('rejects a completed phase that exceeded its cap between polls', () => {
    const records = [{ phase: 'inspect', at: 1000 }, { phase: 'startup', at: 1001 }, { phase: 'requests', at: 31001 }];
    expect(() => tool.validatePhases(records, 999, 32000, 361000)).toThrow('deadline');
  });
  it('rejects inconsistent runtime assertions and arbitrary evidence fields', () => {
    for (const change of [{ attempted: 1 }, { cases: [{}] }, { stage: 'complete' }, { sourceUnchanged: true }, { extra: 'private' }, { serverStarted: true }]) {
      expect(() => tool.validateRuntime({ ...tool.emptyRuntime(), ...change })).toThrow('report_schema');
    }
  });
  it('does not load Next before kernel verification and keeps pre-release accounting unavailable to the parent', async () => {
    const dir = scratch(); tool.publish(dir, 'input.json', { synthetic: true });
    const makeNext = jest.fn(), verifyKernel = jest.fn(() => { throw Object.assign(new Error('isolation'), { code: 'isolation' }); });
    const report = await tool.childMain('/app', dir, { validateInput: value => value, childFlag: '1',
      verifyKernel, smoke: { makeNext } });
    expect(verifyKernel).toHaveBeenCalledWith({ synthetic: true }, fs, { app: '/app', scratch: dir, tooling: path.resolve(__dirname, '../../../..'), node: process.execPath });
    expect(report.failure).toBe('isolation'); expect(makeNext).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(dir, 'ready.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'progress-00.json'))).toBe(false);
  });
  it('retains expired startup and observed cleanup in stopped evidence without relaxing successful phases', async () => {
    jest.useFakeTimers();
    const dir = scratch(), input = { deadline: Date.now() + 360000, entries: [], routes: ['/login', '/admin'] };
    const inputHash = tool.publish(dir, 'input.json', input), h = harness();
    h.next.prepare.mockImplementation(() => new Promise(() => {}));
    const pending = tool.childMain('/synthetic-app', dir, { validateInput: value => value, childFlag: '1', verifyKernel: jest.fn(), versions: base.VERSIONS,
      verify: jest.fn(), inspect: () => inspection(), parse: jest.fn(), smoke: h.ops, pause: async () => {
        tool.publish(dir, 'release.json', { inputHash, serviceVerified: true, at: Date.now() });
      } });
    await jest.advanceTimersByTimeAsync(30000);
    const result = await pending;
    expect(result).toMatchObject({ stage: 'cleanup', failure: 'startup', attempted: 0, descriptorsRestored: true, serverClosed: null, nextClosed: true });
    expect(h.next.close).toHaveBeenCalledTimes(1); expect(h.ops.request).not.toHaveBeenCalled();
    const phases = Array.from({ length: 4 }, (_v, i) => {
      const { phase, at } = tool.readJson(path.join(dir, `phase-0${i}.json`)); return { phase, at };
    });
    expect(phases.map(value => value.phase)).toEqual(['inspect', 'startup', 'cleanup', 'stopped']);
    expect(phases[2].at - phases[1].at).toBe(30000);
    expect(() => tool.validatePhases(phases, phases[0].at, Date.now(), input.deadline, true)).toThrow('deadline');
    expect(tool.validatePhases(phases, phases[0].at, Date.now(), input.deadline, true, Date.now(), true)).toBe('stopped');
    expect(tool.readJson(path.join(dir, 'runtime.json'))).toEqual({ inputHash, runtime: result });
  });
  it.each([null, 'phase-00.json', 'phase-05.json', 'progress-02.json', 'runtime.json'])('preserves the full committed child lifecycle despite pending cleanup failure for %s', async pending => {
    const dir = scratch(), input = { deadline: Date.now() + 360000, entries: [], routes: ['/login', '/admin'] };
    const inputHash = tool.publish(dir, 'input.json', input), h = harness(), verify = jest.fn(), inspect = jest.fn(() => inspection()), recheck = jest.fn();
    const unlink = fs.unlinkSync;
    jest.spyOn(fs, 'unlinkSync').mockImplementation(filename => {
      if (pending && filename === path.join(dir, '.pending-' + pending)) throw new Error('disk');
      return unlink(filename);
    });
    h.ops.request.mockImplementation(async item => { h.observer.snapshot.mockReturnValue(counts(item)); return response(item); });
    const result = await tool.childMain('/synthetic-app', dir, { validateInput: value => value, childFlag: '1', verifyKernel: jest.fn(), versions: base.VERSIONS,
      verify, inspect, recheck, parse: jest.fn(), smoke: h.ops, pause: async () => {
        expect(tool.readJson(path.join(dir, 'ready.json'))).toEqual({ inputHash, kernelVerified: true });
        tool.publish(dir, 'release.json', { inputHash, serviceVerified: true, at: Date.now() });
      } });
    expect(result).toMatchObject({ stage: 'complete', failure: null, attempted: 6, sourceUnchanged: true, compiledUnchanged: true, descriptorsRestored: true });
    expect(h.ops.request).toHaveBeenCalledTimes(6); expect(verify).toHaveBeenCalledTimes(2); expect(recheck).toHaveBeenCalledTimes(1);
    expect(tool.readJson(path.join(dir, 'runtime.json'))).toEqual({ inputHash, runtime: result });
    const phases = Array.from({ length: 6 }, (_v, i) => tool.readJson(path.join(dir, `phase-0${i}.json`)).phase);
    expect(phases).toEqual(['inspect', 'startup', 'requests', 'cleanup', 'recheck', 'complete']);
    const isolation = require('../isolate-runtime.cjs');
    expect(isolation.recoverProgress(dir, inputHash)).toMatchObject({ attempted: 6, cases: result.cases.slice(0, 5) });
    if (pending) expect(fs.existsSync(path.join(dir, '.pending-' + pending))).toBe(true);
  });
  it('rejects an unbound release before inspecting or loading Next', async () => {
    const dir = scratch(); tool.publish(dir, 'input.json', { deadline: Date.now() + 360000 });
    const inspect = jest.fn();
    const result = await tool.childMain('/synthetic-app', dir, { validateInput: value => value, childFlag: '1', verifyKernel: jest.fn(), versions: base.VERSIONS, inspect,
      pause: async () => { tool.publish(dir, 'release.json', { inputHash: 'f'.repeat(64), serviceVerified: true, at: Date.now() }); } });
    expect(result.failure).toBe('isolation_child_release_record'); expect(inspect).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(dir, 'progress-00.json'))).toBe(false);
  });
  it('applies the installed Zod boundary before accepting an inventory', () => {
    const app = path.resolve(path.dirname(require.resolve('zod/package.json')), '../..');
    for (const input of [{}, { executionDigest: 'x', entries: [] }, { extra: 'private' }]) expect(() => tool.validateInput(input, app)).toThrow('source_inventory');
  });
});
