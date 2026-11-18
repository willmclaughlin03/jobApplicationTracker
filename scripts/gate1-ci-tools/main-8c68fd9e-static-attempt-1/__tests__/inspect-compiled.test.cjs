'use strict';
/* global describe, it, expect, afterEach, jest, __dirname */

/** Synthetic static-output fixtures; generated text is never executed and no process is launched. */
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('acorn');
const tool = require('../inspect-compiled.cjs');
const fixtureBase = path.resolve(__dirname, '../../../../.tmp/gate1-ci-tests');
const fixtures = [];

/** Make one contained scratch application with only the inspector's required files. */
function fixture() {
  fs.mkdirSync(fixtureBase, { recursive: true });
  const app = fs.mkdtempSync(path.join(fixtureBase, 'static-inspector-')); fixtures.push(app);
  fs.mkdirSync(path.join(app, '.next/server'), { recursive: true });
  const values = manifests();
  for (const [name, value] of Object.entries({ 'server/functions-config-manifest.json': values.functions, 'server/middleware-manifest.json': values.middleware,
    'server/pages-manifest.json': values.pages, 'routes-manifest.json': {}, 'build-manifest.json': {}, 'server/middleware.js.nft.json': { files: [] } })) {
    fs.writeFileSync(path.join(app, '.next', name), JSON.stringify(value));
  }
  fs.writeFileSync(path.join(app, '.next/BUILD_ID'), 'synthetic_build_1');
  fs.writeFileSync(path.join(app, '.next/server/middleware.js'), reader());
  return app;
}

/** Supply the original matcher semantics and two known source routes independently of production code. */
function manifests() {
  return { functions: { functions: { '/_middleware': { runtime: 'nodejs', matchers: [{ originalSource: tool.MATCHER,
    regexp: '^/((?!_next/static|_next/image|favicon.ico|api(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)$' }] } } }, middleware: { middleware: {} }, pages: { '/login': 'pages/login.html', '/admin': 'pages/admin.js' } };
}

/** Produce a nonexecuted structural reader with a configurable common expression. */
function reader(base = 'runtime') { return `function r(){return {version:${base}.version,nodeVersion:${base}.versions?.node,releaseName:${base}.release?.name}}`; }

/** Remove only synthetic directories created by this suite after checking the absolute boundary. */
afterEach(() => {
  jest.restoreAllMocks();
  for (const dir of fixtures.splice(0)) {
    if (!path.resolve(dir).startsWith(fixtureBase + path.sep) || fs.lstatSync(dir).isSymbolicLink()) throw new Error('fixture_boundary');
    fs.rmSync(dir, { recursive: true, force: false });
  }
});

describe('unchanged static acceptance boundary', () => {
  it('inspects a declared Node closure and retains only hashes/counts/fixed facts', () => {
    const app = fixture(), result = tool.inspect(app, ['/login', '/admin'], parse);
    expect(result).toMatchObject({ nodeMiddleware: true, matcherPreserved: true, sourceRoutesPresent: true, readerCandidates: 1, compiledFiles: 1, pageCount: 2 });
    expect(Object.keys(result.manifests)).toEqual(tool.NAMES);
    expect(JSON.stringify(result)).not.toContain(app);
    expect(JSON.stringify(result)).not.toContain('runtime.version');
    expect(result.compiledClosureHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('supports minified optional access without assuming the import alias', () => {
    expect(tool.findReaders(reader('a.default'), parse)).toBe(1);
  });
  it.each([
    'const x="node:process version nodeVersion releaseName";',
    'const x={version:"v22.23.3",nodeVersion:"22.23.3",releaseName:"node"};',
    'const x={version:a.version,nodeVersion:b.versions.node,releaseName:a.release.name};',
    'const x={version:a["version"],nodeVersion:a.versions.node,releaseName:a.release.name};',
  ])('rejects markers, constants and differing/computed bases %#', text => { expect(tool.findReaders(text, parse)).toBe(0); });
  it('requires the same emitted matcher behavior', () => {
    const value = manifests(); value.functions.functions['/_middleware'].matchers[0].regexp = '.*';
    expect(() => tool.validateManifests(value.functions, value.middleware, value.pages, ['/login', '/admin'])).toThrow('matcher');
  });
  it('requires exactly one reader in the complete declared emitted closure', () => {
    const app = fixture();
    fs.writeFileSync(path.join(app, '.next/server/other.js'), reader('other'));
    fs.writeFileSync(path.join(app, '.next/server/middleware.js.nft.json'), JSON.stringify({ files: ['other.js'] }));
    expect(() => tool.inspect(app, ['/login', '/admin'], parse)).toThrow('reader_ambiguous');
  });
});

describe('actionable sanitized stops', () => {
  it('distinguishes a missing Node declaration from a runtime conflict', () => {
    const m = manifests(); delete m.functions.functions['/_middleware'];
    expect(() => tool.validateManifests(m.functions, m.middleware, m.pages, ['/login'])).toThrow('node_entry_missing');
  });
  it.each([['nodejs24.x', 'node', 24], ['node22', 'node', 22], ['edge', 'edge', null], ['private-token', 'unrecognized', null], [undefined, 'unrecognized', null]])('retains only runtime family and major for %s', (input, runtime, runtimeMajor) => {
    const m = manifests(); m.functions.functions['/_middleware'].runtime = input;
    let error; try { tool.validateManifests(m.functions, m.middleware, m.pages, ['/login']); } catch (caught) { error = caught; }
    expect(error.code).toBe('runtime_conflict');
    expect(error.detail).toEqual({ output: 'middleware', runtime, runtimeMajor });
  });
  it('distinguishes an Edge entry alongside the Node declaration', () => {
    const m = manifests(); m.middleware.middleware['/'] = {};
    expect(() => tool.validateManifests(m.functions, m.middleware, m.pages, ['/login'])).toThrow('edge_entry_present');
  });
  it('labels a missing known route without retaining its name', () => {
    const m = manifests(); let error;
    try { tool.validateManifests(m.functions, m.middleware, m.pages, ['/login', '/admin', '/private-fixture']); } catch (caught) { error = caught; }
    expect(error.code).toBe('route_missing'); expect(error.detail).toEqual({ output: 'known_application_route' });
    expect(JSON.stringify(error)).not.toContain('private-fixture');
  });
  it('labels an unexpected output without retaining its name', () => {
    const m = manifests(); m.pages['/private-fixture'] = 'secret-path'; let error;
    try { tool.validateManifests(m.functions, m.middleware, m.pages, ['/login', '/admin']); } catch (caught) { error = caught; }
    expect(error.code).toBe('route_unrecognized'); expect(error.detail).toEqual({ output: 'unrecognized' });
  });
  it.each([['const x=1;', 'reader_missing'], ['function {', 'reader_parse']])('distinguishes absent and unparseable readers %#', (text, code) => {
    const app = fixture(); fs.writeFileSync(path.join(app, '.next/server/middleware.js'), text);
    expect(() => tool.inspect(app, ['/login', '/admin'], parse)).toThrow(code);
  });
  it('identifies missing named manifest without exposing a filesystem path', () => {
    const app = fixture(); fs.unlinkSync(path.join(app, '.next/routes-manifest.json'));
    let error; try { tool.inspect(app, ['/login', '/admin'], parse); } catch (caught) { error = caught; }
    expect(error.code).toBe('artifact_missing'); expect(error.detail).toEqual({ output: 'routes-manifest.json' });
    expect(JSON.stringify(error)).not.toContain(app);
  });
  it('stops on invalid manifest JSON', () => {
    const app = fixture(); fs.writeFileSync(path.join(app, '.next/build-manifest.json'), 'private invalid json');
    expect(() => tool.inspect(app, ['/login', '/admin'], parse)).toThrow('manifest_json');
  });
  it('does not accept unsupported trace layout', () => {
    const app = fixture(); fs.writeFileSync(path.join(app, '.next/server/middleware.js.nft.json'), '{}');
    expect(() => tool.inspect(app, ['/login', '/admin'], parse)).toThrow('trace_shape');
  });
});

describe('bounded paths and data', () => {
  it.each(['../escape', '/absolute', 'C:\\private', 'file\nname'])('rejects unsafe input before any read: %s', name => {
    const read = jest.spyOn(fs, 'readFileSync');
    expect(() => tool.containedFile('/root', name)).toThrow('artifact_path'); expect(read).not.toHaveBeenCalled();
  });
  it('rejects symlinks including a linked root without reading content', () => {
    jest.spyOn(fs, 'lstatSync').mockReturnValue({ isSymbolicLink: () => true });
    const read = jest.spyOn(fs, 'readFileSync');
    expect(() => tool.containedFile('/root', 'file.js')).toThrow('artifact_path'); expect(read).not.toHaveBeenCalled();
  });
  it('retains the original per-file byte cap', () => {
    jest.spyOn(fs, 'lstatSync').mockReturnValue({ isSymbolicLink: () => false });
    jest.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true, size: tool.CAPS.file + 1 });
    expect(() => tool.containedFile('/root', 'file.js')).toThrow('artifact_cap');
  });
  it('rejects malformed or escaped trace paths', () => {
    const app = fixture(); fs.writeFileSync(path.join(app, '.next/server/middleware.js.nft.json'), JSON.stringify({ files: ['../../../escape.js'] }));
    expect(() => tool.inspect(app, ['/login', '/admin'], parse)).toThrow('artifact_path');
  });
  it('rejects a trace exceeding the retained entry cap', () => {
    const app = fixture(); fs.writeFileSync(path.join(app, '.next/server/middleware.js.nft.json'), JSON.stringify({ files: Array(tool.CAPS.trace + 1).fill('middleware.js') }));
    expect(() => tool.inspect(app, ['/login', '/admin'], parse)).toThrow('artifact_cap');
  });
});
