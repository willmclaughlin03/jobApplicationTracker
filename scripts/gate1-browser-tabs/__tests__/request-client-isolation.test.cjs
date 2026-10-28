'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { IsolationError, FixtureBudget, bounded, isolationArguments, loopbackOrigin, classifyWorker,
  summarizeWorkers, classifyProxyLine, startFixtureServer, startRejectingProxy, closeServer, requestFixture, closeOwned, main } = require('../request-client-isolation.cjs');

/** Create generous local-only test limits without a browser or filesystem mutation. */
function testBudget(overrides = {}, clock = Date.now) {
  return new FixtureBudget({ wholeMs: 10000, launches: 2, fixtureRequests: 10, proxyConnections: 10, ...overrides }, clock);
}

/** Exercise a proxy rejection through loopback TCP and return no submitted request bytes. */
async function proxyExchange(port, line) {
  return bounded(() => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1'); let response = '';
    socket.once('connect', () => socket.write(`${line}\r\nHost: synthetic.invalid\r\n\r\n`));
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.once('end', () => { socket.destroy(); resolve(response); });
    socket.once('error', reject);
  }), 2000);
}

/**
 * Hold native listen until the test releases it, reproducing startup after cleanup.
 * Keep the real server for loopback assertions and always close it, even on failure.
 */
function delayedStartup(t, start, budget, servers) {
  const listen = net.Server.prototype.listen; let server; let resume; let released = false;
  t.mock.method(net.Server.prototype, 'listen', function (...args) {
    server = this; resume = () => listen.apply(this, args); return this;
  });
  const startup = start(budget, servers);
  t.after(async () => {
    if (!released) resume();
    await startup.catch(() => {});
    await closeServer({ server, sockets: new Set() });
  });
  return { startup, server, release: () => { released = true; resume(); } };
}

test('proxy arguments contain exactly one proxy and subtract implicit bypasses', () => {
  assert.deepEqual(isolationArguments(8001), ['--proxy-server=http://127.0.0.1:8001', '--proxy-bypass-list=<-loopback>']);
  assert.deepEqual(isolationArguments(8001, 'http://127.0.0.1:8002'), ['--proxy-server=http://127.0.0.1:8001', '--proxy-bypass-list=<-loopback>;127.0.0.1:8002']);
});

test('invalid ports cannot inject a fallback or extra command-line option', () => {
  for (const port of [0, -1, 65536, 1.5, '8080', '8080,direct://', NaN]) assert.throws(() => isolationArguments(port), /invalid_proxy_port/);
});

test('seed bypass permits only the exact synthetic loopback origin', () => {
  assert.equal(loopbackOrigin('http://127.0.0.1:1234').host, '127.0.0.1:1234');
  for (const origin of ['https://example.invalid', 'http://127.0.0.1.example.invalid:1234', 'http://localhost:1234',
    'http://user:secret@127.0.0.1:1234', 'http://127.0.0.1:1234/path', 'http://127.0.0.1:1234/?x=1', 'http://127.0.0.1:1234/#x']) {
    assert.throws(() => isolationArguments(1234, origin), /invalid_fixture_origin/);
  }
});

test('worker classification does not expose identifiers or confuse suffix origins', () => {
  const origin = 'http://127.0.0.1:1234';
  for (const [raw, expected] of [[origin + '/sw.js', 'fixture'], ['chrome-extension://private-id/private-path', 'extension'],
    ['https://private.invalid/private?q=secret', 'other_web'], ['data:text/javascript,private', 'other'], ['bad URL', 'unparseable']])
    assert.equal(classifyWorker(raw, origin), expected);
  const result = summarizeWorkers([{ url: () => 'chrome-extension://private-id/file' }, { url: () => origin + '/sw.js' }], origin);
  assert.equal(result.fixture, 1); assert.equal(result.extension, 1);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('proxy classifications use exact fixture targets and retain no raw line', () => {
  const origin = 'http://127.0.0.1:1234';
  assert.equal(classifyProxyLine(`GET ${origin}/probe?kind=worker HTTP/1.1`, origin), 'worker');
  assert.equal(classifyProxyLine(`GET ${origin}/probe?kind=page HTTP/1.1`, origin), 'page');
  assert.equal(classifyProxyLine('CONNECT 127.0.0.1:1234 HTTP/1.1', origin), 'fixtureConnect');
  assert.equal(classifyProxyLine('CONNECT private.invalid:443 HTTP/1.1', origin), 'other');
  assert.equal(classifyProxyLine('GET http://127.0.0.1:9999/probe?kind=page HTTP/1.1', origin), 'other');
});

test('budget latches failure and rejects a third launch', () => {
  const budget = testBudget(); budget.count('launches'); budget.count('launches');
  assert.throws(() => budget.count('launches'), /launches_budget/);
  assert.equal(budget.counts.launches, 3);
  assert.throws(() => budget.count('fixtureRequests'), /launches_budget/);
  assert.equal(budget.counts.fixtureRequests, 0);
});

test('deadline stops exactly at the boundary', () => {
  let now = 100; const budget = testBudget({ wholeMs: 10 }, () => now);
  now = 109; budget.check(); now = 110; assert.throws(() => budget.check(), /fixture_deadline/);
});

test('bounded operations propagate results and reject stalled work', async () => {
  assert.equal(await bounded(async () => 42, 100), 42);
  await assert.rejects(bounded(() => new Promise(() => {}), 5, 'synthetic_timeout'), /synthetic_timeout/);
  await assert.rejects(bounded(async () => { throw new IsolationError('synthetic_failure'); }, 100), /synthetic_failure/);
});

for (const [name, start] of [
  ['fixture', startFixtureServer],
  ['proxy', (budget, servers) => startRejectingProxy(budget, 'http://127.0.0.1:1234', servers)],
]) {
  test(`${name} registers before listening and preserves ownership on success`, async t => {
    const servers = []; const pending = delayedStartup(t, start, testBudget(), servers);
    assert.equal(servers.length, 1);
    assert.equal(servers[0].server, pending.server);
    assert.equal(pending.server.listening, false);
    pending.release();
    const resource = await pending.startup;
    assert.equal(resource, servers[0]);
    assert.equal(resource.server.listening, true);
    await closeServer(resource);
    assert.equal(resource.server.listening, false);
    assert.equal(resource.sockets.size, 0);
  });

  test(`${name} closes startup that finishes after bounded timeout and cleanup`, async t => {
    const servers = []; const budget = testBudget(); const pending = delayedStartup(t, start, budget, servers);
    await assert.rejects(bounded(() => pending.startup, 5, 'fixture_deadline').catch(error => {
      // Mirror runFixture's failure latch before its finally block cleans owned servers.
      budget.failure = error.code; throw error;
    }), /fixture_deadline/);
    for (const resource of servers) await closeServer(resource);
    pending.release();
    await assert.rejects(pending.startup, /fixture_deadline/);
    assert.equal(pending.server.listening, false);
    assert.equal(servers[0].sockets.size, 0);
  });

  test(`${name} does not create a server after the fixture has stopped`, async () => {
    const servers = []; const budget = testBudget(); budget.failure = 'fixture_deadline';
    await assert.rejects(start(budget, servers), /fixture_deadline/);
    assert.equal(servers.length, 0);
  });
}

test('rejecting proxy blocks HTTP and CONNECT without opening an upstream socket', async () => {
  const budget = testBudget(); const origin = 'http://127.0.0.1:1234'; const proxy = await startRejectingProxy(budget, origin);
  try {
    assert.match(await proxyExchange(proxy.port, `GET ${origin}/probe?kind=page HTTP/1.1`), /^HTTP\/1.1 502/);
    assert.match(await proxyExchange(proxy.port, 'CONNECT 127.0.0.1:1234 HTTP/1.1'), /^HTTP\/1.1 502/);
    assert.deepEqual(proxy.counts, { page: 1, worker: 0, fixtureConnect: 1, other: 0 });
    assert.equal(budget.counts.proxyConnections, 2);
  } finally { await closeServer(proxy); }
  assert.equal(proxy.server.listening, false); assert.equal(proxy.sockets.size, 0);
});

test('request client uses only the fixed loopback origin, no redirects/retries, and disposes', async () => {
  let disposed = 0; let calls = 0;
  const context = { request: { get: async (url, options) => {
    calls++; assert.equal(url, 'http://127.0.0.1:1234/api/check');
    assert.deepEqual(options, { maxRedirects: 0, maxRetries: 0, timeout: 5000 });
    return { status: () => 200, json: async () => ({ synthetic: true, cookiePresent: true }), dispose: async () => { disposed++; } };
  } } };
  assert.deepEqual(await requestFixture(context, 'http://127.0.0.1:1234', '/api/check'), { cookiePresent: true });
  assert.equal(calls, 1); assert.equal(disposed, 1);
  await assert.rejects(requestFixture(context, 'https://example.invalid', '/api/check'), /invalid_fixture_origin/);
  await assert.rejects(requestFixture(context, 'http://127.0.0.1:1234', '/billing/checkout'), /fixture_endpoint/);
  assert.equal(calls, 1);
});

test('failed fixture response is disposed and cannot be treated as valid cookies', async () => {
  let disposed = false;
  const context = { request: { get: async () => ({ status: () => 401, dispose: async () => { disposed = true; } }) } };
  await assert.rejects(requestFixture(context, 'http://127.0.0.1:1234', '/api/check'), /fixture_request_status/);
  assert.equal(disposed, true);
});

test('cleanup sends normal Browser.close and never kills or removes a profile', async () => {
  const child = { exitCode: null, kill: () => { throw new Error('kill must not be called'); } };
  const calls = []; const owner = { child, closed: false, browser: { isConnected: () => true,
    newBrowserCDPSession: async () => ({ send: async method => { calls.push(method); child.exitCode = 0; } }) } };
  assert.equal(await closeOwned(owner, {}), true); assert.deepEqual(calls, ['Browser.close']);
  assert.equal(await closeOwned(owner, {}), true); assert.equal(calls.length, 1);
});

test('CLI refuses arbitrary profiles, targets, or an unapproved default run', async () => {
  await assert.rejects(main([]), /local_fixture_argument_required/);
  await assert.rejects(main(['--fixture', '--profile=saved']), /local_fixture_argument_required/);
  await assert.rejects(main(['--hosted']), /local_fixture_argument_required/);
});
