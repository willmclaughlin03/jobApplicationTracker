'use strict';

/** Static subset of the merged attempt-2 inspector; never executes emitted code or sends HTTP. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MATCHER = '/((?!_next/static|_next/image|favicon.ico|api(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)';
const CAPS = Object.freeze({ file: 16777216, total: 134217728, files: 1024, nodes: 2000000, trace: 10000 });
const NAMES = Object.freeze(['server/functions-config-manifest.json', 'server/middleware-manifest.json', 'server/pages-manifest.json', 'routes-manifest.json', 'build-manifest.json']);
const CODES = Object.freeze(['artifact_path', 'artifact_missing', 'artifact_cap', 'artifact_read', 'manifest_json', 'manifest_shape', 'build_id', 'node_entry_missing', 'runtime_conflict', 'edge_entry_present', 'matcher', 'route_missing', 'route_unrecognized', 'trace_shape', 'reader_parse', 'reader_missing', 'reader_ambiguous']);

/** Carry only reviewed diagnostic enums/counts; arbitrary exception messages are never retained. */
class InspectionError extends Error {
  /** Attach a fixed category and independently validated context for the report wrapper. */
  constructor(code, detail = {}) { super(CODES.includes(code) ? code : 'artifact_read'); this.code = this.message; this.detail = detail; }
}

/** Hash approved artifact bytes for attribution, with no generated text in the result. */
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/** Reject traversal and symbolic links, including a linked root, before reading a bounded file. */
function containedFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || /[\\:]/.test(relative) || [...relative].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || path.posix.isAbsolute(relative)) throw new InspectionError('artifact_path');
  const base = path.resolve(root), absolute = path.resolve(base, relative);
  if (!absolute.startsWith(base + path.sep)) throw new InspectionError('artifact_path');
  try {
    if (fs.lstatSync(base).isSymbolicLink()) throw new InspectionError('artifact_path');
    let cursor = base;
    for (const part of path.relative(base, absolute).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new InspectionError('artifact_path');
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new InspectionError('artifact_path');
    if (stat.size > CAPS.file) throw new InspectionError('artifact_cap');
  } catch (error) { throw error instanceof InspectionError ? error : new InspectionError(error.code === 'ENOENT' ? 'artifact_missing' : 'artifact_read'); }
  return absolute;
}

/** Read a named manifest; only a fixed manifest label can be added to a failure. */
function jsonFile(root, name) {
  try {
    const bytes = fs.readFileSync(containedFile(root, name));
    if (bytes.length > CAPS.file) throw new InspectionError('artifact_cap');
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new InspectionError('manifest_json'); }
    return { value, hash: sha(bytes) };
  } catch (error) {
    const code = error instanceof InspectionError ? error.code : 'artifact_read';
    throw new InspectionError(code, { output: [...NAMES, 'server/middleware.js.nft.json'].includes(name) ? name : 'unrecognized' });
  }
}

/** Unwrap optional access without evaluating a generated expression. */
function unwrap(node) { return node?.type === 'ChainExpression' ? node.expression : node; }

/** Match the original non-computed property suffix and preserve its base expression. */
function memberBase(node, suffix) {
  let value = unwrap(node);
  for (const name of [...suffix].reverse()) {
    if (value?.type !== 'MemberExpression' || value.computed || value.property?.name !== name) return null;
    value = unwrap(value.object);
  }
  return value;
}

/** Count structural three-field readers under the original AST cap; this is not runtime proof. */
function findReaders(text, parse) {
  let ast;
  try { ast = parse(text, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch { throw new InspectionError('reader_parse'); }
  const queue = [ast]; let visited = 0, readers = 0;
  while (queue.length) {
    const node = queue.pop();
    if (!node || typeof node !== 'object') continue;
    if (++visited > CAPS.nodes) throw new InspectionError('artifact_cap');
    if (node.type === 'ObjectExpression' && node.properties?.length === 3) {
      const properties = node.properties.filter(p => p.type === 'Property' && !p.computed);
      const props = Object.fromEntries(properties.map(p => [p.key.name ?? p.key.value, p.value]));
      const fields = { version: ['version'], nodeVersion: ['versions', 'node'], releaseName: ['release', 'name'] };
      const bases = Object.entries(fields).map(([key, suffix]) => memberBase(props[key], suffix));
      if (bases.every(Boolean) && new Set(bases.map(base => text.slice(base.start, base.end))).size === 1) readers++;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const item of value) queue.push(item); }
      else if (value && typeof value === 'object') queue.push(value);
    }
    if (queue.length > CAPS.nodes) throw new InspectionError('artifact_cap');
  }
  return readers;
}

/** Extract only a recognized runtime family and bounded major, never arbitrary manifest text. */
function runtimeDetail(value) {
  if (value === 'nodejs') return { runtime: 'nodejs', runtimeMajor: null };
  if (value === 'edge') return { runtime: 'edge', runtimeMajor: null };
  const match = typeof value === 'string' && /^node(?:js)?([1-9]\d{0,2})(?:\.x)?$/.exec(value);
  return match ? { runtime: 'node', runtimeMajor: Number(match[1]) } : { runtime: 'unrecognized', runtimeMajor: null };
}

/** Require the same Node entry, matcher samples and complete page inventory as the merged inspector. */
function validateManifests(functions, middleware, pages, expectedRoutes) {
  const entry = functions?.functions?.['/_middleware'];
  if (!entry) throw new InspectionError('node_entry_missing', { output: 'middleware' });
  if (entry.runtime !== 'nodejs') throw new InspectionError('runtime_conflict', { output: 'middleware', ...runtimeDetail(entry.runtime) });
  if (!middleware?.middleware || Array.isArray(middleware.middleware) || typeof middleware.middleware !== 'object') throw new InspectionError('manifest_shape');
  if (Object.keys(middleware.middleware).length) throw new InspectionError('edge_entry_present', { output: 'middleware', runtime: 'edge', runtimeMajor: null });
  if (!Array.isArray(entry.matchers) || entry.matchers.length !== 1 || entry.matchers[0].originalSource !== MATCHER || typeof entry.matchers[0].regexp !== 'string' || entry.matchers[0].regexp.length > 16384) throw new InspectionError('matcher');
  let matcher;
  try { matcher = new RegExp(entry.matchers[0].regexp); } catch { throw new InspectionError('matcher'); }
  for (const [name, expected] of [['/login', true], ['/admin', true], ['/billing', true], ['/', true], ['/api/auth/session', false], ['/api', false], ['/_next/static/a.js', false], ['/_next/image', false], ['/favicon.ico', false], ['/a.png', false], ['/apiary', true]]) {
    if (matcher.test(name) !== expected) throw new InspectionError('matcher');
  }
  if (!pages || Array.isArray(pages) || typeof pages !== 'object' || !Array.isArray(expectedRoutes) || expectedRoutes.length > 4096 || expectedRoutes.some(route => typeof route !== 'string')) throw new InspectionError('manifest_shape');
  const missing = expectedRoutes.find(route => !Object.hasOwn(pages, route));
  if (missing !== undefined) throw new InspectionError('route_missing', { output: 'known_application_route' });
  if (Object.keys(pages).some(route => !expectedRoutes.includes(route) && !['/_app', '/_document', '/_error'].includes(route))) throw new InspectionError('route_unrecognized', { output: 'unrecognized' });
  return { nodeMiddleware: true, matcherPreserved: true, sourceRoutesPresent: true, pageCount: Object.keys(pages).length };
}

/** Inspect the declared closure once; return hashes/counts only, never code, paths or AST spans. */
function inspect(app, expectedRoutes, parse) {
  const next = path.join(app, '.next');
  const buildId = fs.readFileSync(containedFile(next, 'BUILD_ID'), 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(buildId)) throw new InspectionError('build_id');
  const manifests = NAMES.map(name => jsonFile(next, name));
  const facts = validateManifests(manifests[0].value, manifests[1].value, manifests[2].value, expectedRoutes);
  const trace = jsonFile(next, 'server/middleware.js.nft.json');
  if (!Array.isArray(trace.value.files)) throw new InspectionError('trace_shape');
  if (trace.value.files.length > CAPS.trace) throw new InspectionError('artifact_cap');
  const files = new Set([containedFile(next, 'server/middleware.js')]);
  for (const relative of trace.value.files) {
    if (typeof relative !== 'string' || relative.length > 1024 || /[\\:]/.test(relative) || [...relative].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || path.posix.isAbsolute(relative)) throw new InspectionError('artifact_path');
    const absolute = containedFile(app, path.posix.normalize('.next/server/' + relative));
    if (absolute.startsWith(path.join(next, 'server') + path.sep) && absolute.endsWith('.js')) files.add(absolute);
  }
  if (files.size > CAPS.files) throw new InspectionError('artifact_cap');
  let total = 0, readers = 0; const fingerprints = [];
  for (const filename of [...files].sort()) {
    const bytes = fs.readFileSync(filename);
    total += bytes.length;
    if (bytes.length > CAPS.file || total > CAPS.total) throw new InspectionError('artifact_cap');
    fingerprints.push({ path: path.relative(next, filename).split(path.sep).join('/'), sha256: sha(bytes) });
    readers += findReaders(bytes.toString('utf8'), parse);
  }
  if (readers === 0) throw new InspectionError('reader_missing', { output: 'middleware' });
  if (readers !== 1) throw new InspectionError('reader_ambiguous', { output: 'middleware' });
  return { ...facts, buildId, manifests: Object.fromEntries(NAMES.map((name, i) => [name, manifests[i].hash])), traceHash: trace.hash,
    compiledFiles: files.size, compiledBytes: total, compiledClosureHash: sha(JSON.stringify(fingerprints)), readerCandidates: readers };
}

module.exports = { MATCHER, CAPS, NAMES, CODES, InspectionError, sha, containedFile, jsonFile, findReaders, runtimeDetail, validateManifests, inspect };
