'use strict';
/* global describe, it, expect, jest, afterEach, Buffer */

/** Synthetic compiled-code and transport fixtures; no server, build or external request. */
const vm = require('node:vm');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { parse } = require('acorn');
const tool = require('../inspect-compiled.cjs');

/** Construct an independently shaped Node middleware manifest with the original exclusion policy. */
function manifests() {
  return { functions: { functions: { '/_middleware': { runtime: 'nodejs', matchers: [{ originalSource: tool.MATCHER,
    regexp: '^/((?!_next/static|_next/image|favicon.ico|api(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)$' }] } } }, middleware: { middleware: {} }, pages: { '/login': 'pages/login.html', '/admin': 'pages/admin.js' } };
}

/** Preserve exact locations in a synthetic compiled reader for getter-attribution tests. */
function readerFixture(base = 'runtime') {
  const text = `function reader(){return {version:${base}.version,nodeVersion:${base}.versions?.node,releaseName:${base}.release?.name};}\nreader();`;
  return { filename: '/synthetic/compiled.js', text, spans: tool.findReaders(text, parse)[0] };
}

/** Model only observable response fields; no fixture body or credential is retained by review. */
function response(request, version = 'v22.23.3') {
  const value = { schemaVersion: 1, scope: 'middleware', challenge: request.challenge, nodeVersion: version, node22: true };
  return { status: 200, bodyBytes: 50, headers: { 'cache-control': 'private, no-store', 'cdn-cache-control': 'no-store',
    'vercel-cdn-cache-control': 'no-store', [tool.HEADERS.observation]: JSON.stringify(value) }, rawHeaders: [tool.HEADERS.observation, JSON.stringify(value)] };
}

/** Reset only test doubles, leaving native runtime descriptors untouched between fixtures. */
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe('compiled output acceptance', () => {
  it('requires a Node entry, preserved matcher and complete source page inventory', () => {
    const m = manifests();
    expect(tool.validateManifests(m.functions, m.middleware, m.pages, ['/login', '/admin'])).toMatchObject({ nodeMiddleware: true, matcherPreserved: true, pageCount: 2 });
  });

  it.each(['edge', 'node24', undefined])('rejects incompatible or missing runtime %s', runtime => {
    const m = manifests(); m.functions.functions['/_middleware'].runtime = runtime;
    expect(() => tool.validateManifests(m.functions, m.middleware, m.pages, ['/login'])).toThrow('manifest');
  });

  it('rejects an Edge middleware alongside the Node declaration', () => {
    const m = manifests(); m.middleware.middleware['/'] = {};
    expect(() => tool.validateManifests(m.functions, m.middleware, m.pages, ['/login', '/admin'])).toThrow('manifest');
  });

  it('rejects a widened emitted matcher even if its originalSource claim matches', () => {
    const m = manifests(); m.functions.functions['/_middleware'].matchers[0].regexp = '.*';
    expect(() => tool.validateManifests(m.functions, m.middleware, m.pages, ['/login', '/admin'])).toThrow('matcher');
  });

  it.each([{ routes: ['/login', '/admin', '/missing'] }, { routes: ['/login'] }])('rejects missing or unexpected application pages %#', ({ routes }) => {
    const m = manifests(); expect(() => tool.validateManifests(m.functions, m.middleware, m.pages, routes)).toThrow('route');
  });

  it.each([
    'const x="node:process version nodeVersion releaseName";',
    'function r(){return {version:"v22.23.3",nodeVersion:"22.23.3",releaseName:"node"}}',
    'function r(){return {version:a.version,nodeVersion:b.versions.node,releaseName:a.release.name}}',
    'function r(){return {version:a["version"],nodeVersion:a.versions.node,releaseName:a.release.name}}',
  ])('does not treat markers, constants or ambiguous bindings as native reads %#', text => {
    expect(tool.findReaders(text, parse)).toEqual([]);
  });

  it('accepts minified optional access structurally without assuming the import alias', () => {
    expect(tool.findReaders('function x(){return{version:a.default.version,nodeVersion:a.default.versions?.node,releaseName:a.default.release?.name}}', parse)).toHaveLength(1);
  });

  it('keeps multiple reader candidates ambiguous for the inspector', () => {
    expect(tool.findReaders(readerFixture().text + readerFixture('another').text, parse)).toHaveLength(2);
  });

  it('rejects unparseable generated code', () => {
    expect(() => tool.findReaders('function {', parse)).toThrow('compiled_reader');
  });

  it('attributes three real-property reads at the exact compiled spans and restores descriptors', () => {
    const reader = readerFixture();
    const runtime = { version: 'v22.23.3', versions: { node: '22.23.3' }, release: { name: 'node' } };
    const before = Object.getOwnPropertyDescriptor(runtime, 'version');
    const observer = tool.observeNativeReads(reader, runtime);
    try {
      expect(new vm.Script(reader.text, { filename: reader.filename }).runInNewContext({ runtime })).toEqual({ version: 'v22.23.3', nodeVersion: '22.23.3', releaseName: 'node' });
      expect(observer.snapshot()).toEqual({ version: 1, nodeVersion: 1, releaseName: 1 });
      observer.reset();
      expect(runtime.version).toBe('v22.23.3');
      expect(observer.snapshot()).toEqual({ version: 0, nodeVersion: 0, releaseName: 0 });
    } finally { observer.restore(); }
    expect(Object.getOwnPropertyDescriptor(runtime, 'version')).toEqual(before);
  });

  it('does not count another caller file using the same source text', () => {
    const reader = readerFixture(), runtime = { version: 'v22.23.3', versions: { node: '22.23.3' }, release: { name: 'node' } };
    const observer = tool.observeNativeReads(reader, runtime);
    try {
      new vm.Script(reader.text, { filename: '/synthetic/unrelated.js' }).runInNewContext({ runtime });
      expect(Object.values(observer.snapshot())).toEqual([0, 0, 0]);
    } finally { observer.restore(); }
  });

  it('restores earlier properties when a later native descriptor cannot be wrapped', () => {
    const runtime = { version: 'v22.23.3', versions: {}, release: { name: 'node' } };
    Object.defineProperty(runtime.versions, 'node', { value: '22.23.3', configurable: false });
    const before = Object.getOwnPropertyDescriptor(runtime, 'version');
    expect(() => tool.observeNativeReads(readerFixture(), runtime)).toThrow('runtime_read');
    expect(Object.getOwnPropertyDescriptor(runtime, 'version')).toEqual(before);
  });

  it.each(['../escape', '/absolute', 'C:\\private', 'file\nname'])('rejects artifact path %s before content access', name => {
    const read = jest.spyOn(fs, 'readFileSync');
    expect(() => tool.containedFile('/root', name)).toThrow('artifact_path');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('bounded observation review', () => {
  const request = { case: 'authenticated_1', observe: true, marked: true, challenge: 'b'.repeat(32) };
  const counts = { version: 1, nodeVersion: 1, releaseName: 1 };

  it('retains only correlated runtime facts and policy booleans', () => {
    const result = tool.reviewResponse(response(request), request, counts, 'v22.23.3');
    expect(result).toMatchObject({ nodeVersion: 'v22.23.3', node22: true, challengeMatched: true, privateNoStore: true });
    expect(JSON.stringify(result)).not.toContain(request.challenge);
  });

  it.each([
    value => { value.nodeVersion = 'v24.1.0'; },
    value => { value.nodeVersion = 'v022.23.3'; },
    value => { value.node22 = false; },
    value => { value.scope = 'api'; },
    value => { value.challenge = 'c'.repeat(32); },
    value => { value.unexpected = 'synthetic-private-data'; },
  ])('rejects conflicting, malformed or uncorrelated facts %#', mutate => {
    const r = response(request), value = JSON.parse(r.headers[tool.HEADERS.observation]); mutate(value);
    r.headers[tool.HEADERS.observation] = JSON.stringify(value);
    expect(() => tool.reviewResponse(r, request, counts, 'v22.23.3')).toThrow();
  });

  it.each([0, 2])('rejects a non-request-time or duplicated read count %s', count => {
    expect(() => tool.reviewResponse(response(request), request, { ...counts, version: count }, 'v22.23.3')).toThrow('runtime_read');
  });

  it.each(['set-cookie', 'cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control'])('rejects cookie or cache failure %s', header => {
    const r = response(request); r.headers[header] = header === 'set-cookie' ? ['synthetic=private'] : 'public, max-age=3600';
    expect(() => tool.reviewResponse(r, request, counts, 'v22.23.3')).toThrow('cache_cookie');
  });

  it('rejects duplicate observation headers instead of trusting normalization', () => {
    const r = response(request); r.rawHeaders.push(tool.HEADERS.observation.toUpperCase(), 'copied');
    expect(() => tool.reviewResponse(r, request, counts, 'v22.23.3')).toThrow('runtime_read');
  });

  it('rejects missing observations and negative-case disclosure', () => {
    const r = response(request); delete r.headers[tool.HEADERS.observation]; r.rawHeaders = [];
    expect(() => tool.reviewResponse(r, request, counts, 'v22.23.3')).toThrow('observation');
    expect(() => tool.reviewResponse(response(request), { case: 'baseline' }, { version: 0, nodeVersion: 0, releaseName: 0 }, 'v22.23.3')).toThrow('observation');
  });

  it('requires the protected redirect to remain on the local login origin', () => {
    const r = { status: 307, headers: { location: 'https://unexpected.invalid/login', 'cache-control': 'private, no-store' }, rawHeaders: [], bodyBytes: 0 };
    expect(() => tool.reviewResponse(r, { protected: true }, {}, 'v22.23.3')).toThrow('route');
  });

  it('caps bodies and destroys the exchange without retrying', async () => {
    const req = new EventEmitter(); req.destroy = jest.fn(); req.end = jest.fn();
    const res = new EventEmitter(); res.destroy = jest.fn();
    const transport = jest.fn((_options, receive) => { req.end.mockImplementation(() => { receive(res); res.emit('data', Buffer.alloc(tool.CAPS.body + 1)); }); return req; });
    await expect(tool.getLocal({ path: '/login', headers: {} }, transport)).rejects.toThrow('http_cap');
    expect(transport).toHaveBeenCalledTimes(1); expect(req.destroy).toHaveBeenCalled(); expect(res.destroy).toHaveBeenCalled();
    expect(transport.mock.calls[0][0]).toMatchObject({ host: '127.0.0.1', port: 32147, method: 'GET', agent: false, maxHeaderSize: 16384 });
  });

  it('ends a stalled exchange at its fixed deadline', async () => {
    jest.useFakeTimers();
    const req = new EventEmitter(); req.destroy = jest.fn(); req.end = jest.fn();
    const pending = tool.getLocal({ path: '/login' }, () => req);
    const assertion = expect(pending).rejects.toThrow('http');
    jest.advanceTimersByTime(10000); await assertion;
    expect(req.destroy).toHaveBeenCalledTimes(1);
  });
});
