'use strict';
/* global describe, it, expect, afterEach, jest, __dirname */

/** Synthetic compiled text and native-shaped objects exercise attribution without starting the application. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse } = require('acorn');
const tool = require('../inspect-runtime.cjs');
const staticInspector = require('../../main-8c68fd9e-static-attempt-1/inspect-compiled.cjs');
const fixtureBase = path.resolve(__dirname, '../../../../.tmp/gate1-runtime-tests');
const fixtures = [];

/** Supply unchanged native-shaped data; no global process properties are patched by these tests. */
function native() { return { version: 'v22.23.3', versions: { node: '22.23.3' }, release: { name: 'node' } }; }

/** Create a source-mapped synthetic reader and its independently parsed spans for stack attribution. */
function reader(filename = 'synthetic-reader.cjs', text = '(function read(){return {version:n.version,nodeVersion:n.versions.node,releaseName:n.release.name}})') {
  return { filename, text, spans: tool.findReaderSpans(text, parse)[0] };
}

/** Build the minimal declared output accepted by the frozen static inspector. */
function fixture() {
  fs.mkdirSync(fixtureBase, { recursive: true });
  const app = fs.mkdtempSync(path.join(fixtureBase, 'reader-')); fixtures.push(app);
  fs.mkdirSync(path.join(app, '.next/server'), { recursive: true });
  const values = { 'server/functions-config-manifest.json': { functions: { '/_middleware': { runtime: 'nodejs', matchers: [{ originalSource: staticInspector.MATCHER,
    regexp: '^/((?!_next/static|_next/image|favicon.ico|api(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)$' }] } } },
  'server/middleware-manifest.json': { middleware: {} }, 'server/pages-manifest.json': { '/login': 'pages/login.html', '/admin': 'pages/admin.js' },
  'routes-manifest.json': {}, 'build-manifest.json': {}, 'server/middleware.js.nft.json': { files: [] } };
  for (const [name, value] of Object.entries(values)) fs.writeFileSync(path.join(app, '.next', name), JSON.stringify(value));
  fs.writeFileSync(path.join(app, '.next/BUILD_ID'), 'fresh_synthetic_build');
  fs.writeFileSync(path.join(app, '.next/server/middleware.js'), reader().text);
  return app;
}

/** Restore mocks and remove only this suite's verified synthetic directories. */
afterEach(() => {
  jest.restoreAllMocks();
  for (const dir of fixtures.splice(0)) {
    if (!path.resolve(dir).startsWith(fixtureBase + path.sep) || fs.lstatSync(dir).isSymbolicLink()) throw new Error('fixture_boundary');
    fs.rmSync(dir, { recursive: true, force: false });
  }
});

describe('same-build static/private agreement', () => {
  it('keeps spans private and reinspects the same manifests and closure', () => {
    const app = fixture(), result = tool.inspect(app, ['/login', '/admin'], parse);
    expect(result.facts).toEqual(staticInspector.inspect(app, ['/login', '/admin'], parse));
    expect(result.reader.spans).toEqual(reader().spans);
    expect(JSON.stringify(result.facts)).not.toMatch(/n\.version|synthetic-reader|spans/);
    expect(tool.recheck(app, ['/login', '/admin'], parse, result.facts)).toBe(true);
    fs.appendFileSync(path.join(app, '.next/server/middleware.js'), '\n;');
    expect(() => tool.recheck(app, ['/login', '/admin'], parse, result.facts)).toThrow('source_content');
  });
  it('rejects multiple structural readers', () => {
    const app = fixture(); fs.appendFileSync(path.join(app, '.next/server/middleware.js'), ';' + reader().text);
    expect(() => tool.inspect(app, ['/login', '/admin'], parse)).toThrow('reader_ambiguous');
  });
  it('rejects disagreement between the static fingerprint and private scan', () => {
    const app = fixture(), result = staticInspector.inspect(app, ['/login', '/admin'], parse);
    jest.spyOn(staticInspector, 'inspect').mockReturnValue({ ...result, compiledClosureHash: 'f'.repeat(64) });
    expect(() => tool.inspect(app, ['/login', '/admin'], parse)).toThrow('reader_ambiguous');
  });
  it.each(['const a="version nodeVersion releaseName";', '({version:"v22.23.3",nodeVersion:"22.23.3",releaseName:"node"})',
    '({version:a.version,nodeVersion:b.versions.node,releaseName:a.release.name})'])('ignores false structural markers %#', text => {
    expect(tool.findReaderSpans(text, parse)).toEqual([]);
  });
  it('rejects unparseable code before any instrumentation', () => { expect(() => tool.findReaderSpans('function {', parse)).toThrow('reader_parse'); });
});

describe('exact caller attribution and restoration', () => {
  it('returns original values, counts only exact spans, resets, and restores descriptors and stack preparation', () => {
    const n = native(), r = reader(), before = Object.getOwnPropertyDescriptors(n), stackBefore = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    const observer = tool.observeNativeReads(r, n);
    try {
      const read = vm.runInNewContext(r.text, { n }, { filename: r.filename });
      expect(read()).toEqual({ version: 'v22.23.3', nodeVersion: '22.23.3', releaseName: 'node' });
      expect(observer.snapshot()).toEqual({ version: 1, nodeVersion: 1, releaseName: 1 });
      observer.reset(); expect(observer.snapshot()).toEqual({ version: 0, nodeVersion: 0, releaseName: 0 });
      expect(Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')).toEqual(stackBefore);
    } finally { observer.restore(); }
    expect(Object.getOwnPropertyDescriptors(n)).toEqual(before); observer.restore();
  });
  it.each(['wrong-file', 'wrong-span'])('does not count %s accesses or unrelated high source lines', variant => {
    const n = native(), r = reader(), observer = tool.observeNativeReads(r, n);
    try {
      const text = variant === 'wrong-file' ? '\n'.repeat(500) + r.text : '(function(){return n.version})';
      vm.runInNewContext(text, { n }, { filename: variant === 'wrong-file' ? 'elsewhere.cjs' : r.filename })();
      expect(observer.snapshot()).toEqual({ version: 0, nodeVersion: 0, releaseName: 0 });
    } finally { observer.restore(); }
  });
  it('treats unavailable stack machinery as sticky failure while preserving values', () => {
    const n = native(), r = reader(), observer = tool.observeNativeReads(r, n);
    const capture = jest.spyOn(Error, 'captureStackTrace').mockImplementation(() => { throw new Error('private'); });
    try {
      expect(n.version).toBe('v22.23.3'); observer.reset(); expect(() => observer.snapshot()).toThrow('runtime_read');
    } finally { capture.mockRestore(); observer.restore(); }
  });
  it('restores earlier descriptors after partial setup fails and reports verified restoration', () => {
    const n = native(), original = Object.getOwnPropertyDescriptor(n, 'version');
    Object.defineProperty(n.versions, 'node', { configurable: false });
    try { tool.observeNativeReads(reader(), n); throw new Error('expected_failure'); }
    catch (error) { expect(error).toMatchObject({ code: 'runtime_read', descriptorsRestored: true }); }
    expect(Object.getOwnPropertyDescriptor(n, 'version')).toEqual(original);
  });
  it('reports restoration failure and still attempts every other descriptor', () => {
    const n = native(), observer = tool.observeNativeReads(reader(), n);
    Object.defineProperty(n.versions, 'node', { configurable: false });
    expect(() => observer.restore()).toThrow('cleanup');
    expect(Object.getOwnPropertyDescriptor(n, 'version').value).toBe('v22.23.3');
    expect(Object.getOwnPropertyDescriptor(n.release, 'name').value).toBe('node');
  });
  it('does not label a failed partial restoration successful', () => {
    const n = native(); Object.defineProperty(n.release, 'name', { configurable: false });
    const define = Object.defineProperty;
    jest.spyOn(Object, 'defineProperty').mockImplementation((object, key, descriptor) => {
      if (object === n && key === 'version' && Object.hasOwn(descriptor, 'value')) throw new Error('restore');
      return define(object, key, descriptor);
    });
    try { tool.observeNativeReads(reader(), n); throw new Error('expected_failure'); }
    catch (error) { expect(error).toMatchObject({ code: 'cleanup', descriptorsRestored: false }); }
    expect(Object.getOwnPropertyDescriptor(n.versions, 'node').value).toBe('22.23.3');
  });
});
