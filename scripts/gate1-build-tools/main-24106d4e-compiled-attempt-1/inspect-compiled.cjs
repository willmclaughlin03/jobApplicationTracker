'use strict';
/* global URL, process, setTimeout, clearTimeout */

/** Bounded local-output inspection; no hosted attribution or comprehensive privacy scan. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

const MATCHER = '/((?!_next/static|_next/image|favicon.ico|api(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)';
const HEADERS = Object.freeze({ key: 'x-gate1-middleware-probe-key', challenge: 'x-gate1-middleware-probe-challenge', observation: 'x-gate1-middleware-runtime' });
const CAPS = Object.freeze({ file: 16 * 1024 * 1024, total: 128 * 1024 * 1024, files: 1024, nodes: 2000000, body: 1024 * 1024, headers: 16384, httpMs: 10000 });
const CODES = new Set(['artifact_path', 'artifact_cap', 'manifest', 'matcher', 'compiled_reader', 'runtime_read', 'http', 'http_cap', 'observation', 'cache_cookie', 'route', 'cleanup']);

/** Map failures to a fixed category; never attach source, headers, bodies or stack text. */
class InspectionError extends Error {
  /** Accept only the fixed inspection vocabulary. */
  constructor(code) { super(CODES.has(code) ? code : 'manifest'); this.code = this.message; }
}

/** Hash approved local artifact bytes for later comparison, never credentials. */
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/** Resolve a regular file under a selected root while rejecting links and traversal escapes. */
function containedFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || /[\\:]/.test(relative) || [...relative].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || path.posix.isAbsolute(relative)) throw new InspectionError('artifact_path');
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new InspectionError('artifact_path');
  try {
    let cursor = path.resolve(root);
    for (const part of path.relative(root, absolute).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new InspectionError('artifact_path');
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > CAPS.file) throw new InspectionError('artifact_cap');
  } catch (error) { throw error instanceof InspectionError ? error : new InspectionError('artifact_path'); }
  return absolute;
}

/** Read a bounded manifest; JSON parse errors are fixed failures rather than raw diagnostics. */
function jsonFile(root, relative) {
  try {
    const bytes = fs.readFileSync(containedFile(root, relative));
    return { value: JSON.parse(bytes.toString('utf8')), hash: sha(bytes) };
  } catch (error) { throw error instanceof InspectionError ? error : new InspectionError('manifest'); }
}

/** Unwrap optional-chain nodes without interpreting or executing generated JavaScript. */
function unwrap(node) { return node?.type === 'ChainExpression' ? node.expression : node; }

/** Resolve a static member suffix and return the remaining AST base, rejecting computed access. */
function memberBase(node, suffix) {
  let value = unwrap(node);
  for (const name of [...suffix].reverse()) {
    if (value?.type !== 'MemberExpression' || value.computed || value.property?.name !== name) return null;
    value = unwrap(value.object);
  }
  return value;
}

/** Find the exact three-field runtime-read object; string markers alone are never accepted. */
function findReaders(text, parse) {
  let ast;
  try { ast = parse(text, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch { throw new InspectionError('compiled_reader'); }
  const queue = [ast], readers = [];
  let count = 0;
  while (queue.length) {
    const node = queue.pop();
    if (!node || typeof node !== 'object') continue;
    if (++count > CAPS.nodes) throw new InspectionError('artifact_cap');
    if (node.type === 'ObjectExpression' && node.properties?.length === 3) {
      const props = Object.fromEntries(node.properties.filter(p => p.type === 'Property' && !p.computed).map(p => [p.key.name ?? p.key.value, p.value]));
      const fields = { version: ['version'], nodeVersion: ['versions', 'node'], releaseName: ['release', 'name'] };
      const bases = Object.entries(fields).map(([key, suffix]) => memberBase(props[key], suffix));
      if (bases.every(Boolean) && new Set(bases.map(base => text.slice(base.start, base.end))).size === 1) {
        readers.push(Object.fromEntries(Object.keys(fields).map(key => [key, { start: props[key].start, end: props[key].end }])));
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) queue.push(...value);
      else if (value && typeof value === 'object') queue.push(value);
    }
  }
  return readers;
}

/** Validate the emitted Node entry and original matcher, with explicit positive/negative route samples. */
function validateManifests(functions, middleware, pages, expectedRoutes) {
  const entry = functions?.functions?.['/_middleware'];
  if (entry?.runtime !== 'nodejs' || !middleware?.middleware || Object.keys(middleware.middleware).length !== 0) throw new InspectionError('manifest');
  if (!Array.isArray(entry.matchers) || entry.matchers.length !== 1 || entry.matchers[0].originalSource !== MATCHER || typeof entry.matchers[0].regexp !== 'string' || entry.matchers[0].regexp.length > 16384) throw new InspectionError('matcher');
  let matcher;
  try { matcher = new RegExp(entry.matchers[0].regexp); } catch { throw new InspectionError('matcher'); }
  for (const [name, expected] of [['/login', true], ['/admin', true], ['/billing', true], ['/', true], ['/api/auth/session', false], ['/api', false], ['/_next/static/a.js', false], ['/_next/image', false], ['/favicon.ico', false], ['/a.png', false], ['/apiary', true]]) {
    if (matcher.test(name) !== expected) throw new InspectionError('matcher');
  }
  if (!pages || Array.isArray(pages) || typeof pages !== 'object' || !Array.isArray(expectedRoutes) || expectedRoutes.length > 4096 || expectedRoutes.some(route => typeof route !== 'string')) throw new InspectionError('manifest');
  const known = new Set(expectedRoutes);
  if (expectedRoutes.some(route => !Object.hasOwn(pages, route)) || Object.keys(pages).some(route => !known.has(route) && !['/_app', '/_document', '/_error'].includes(route))) throw new InspectionError('route');
  return { nodeMiddleware: true, matcherPreserved: true, sourceRoutesPresent: true, pageCount: Object.keys(pages).length };
}

/** Inspect only declared middleware trace files and five named manifests; unsupported layouts stop. */
function inspect(app, expectedRoutes, parse) {
  const next = path.join(app, '.next');
  const buildId = fs.readFileSync(containedFile(next, 'BUILD_ID'), 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(buildId)) throw new InspectionError('manifest');
  const names = ['server/functions-config-manifest.json', 'server/middleware-manifest.json', 'server/pages-manifest.json', 'routes-manifest.json', 'build-manifest.json'];
  const manifests = names.map(name => jsonFile(next, name));
  const facts = validateManifests(manifests[0].value, manifests[1].value, manifests[2].value, expectedRoutes);
  const trace = jsonFile(next, 'server/middleware.js.nft.json');
  if (!Array.isArray(trace.value.files) || trace.value.files.length > 10000) throw new InspectionError('artifact_cap');
  const files = new Set([containedFile(next, 'server/middleware.js')]);
  for (const relative of trace.value.files) {
    // Trace references may legitimately ascend to application node_modules; every target stays in app.
    const absolute = containedFile(app, path.posix.normalize('.next/server/' + relative));
    if (absolute.startsWith(path.join(next, 'server') + path.sep) && absolute.endsWith('.js')) files.add(absolute);
  }
  if (files.size > CAPS.files) throw new InspectionError('artifact_cap');
  let total = 0;
  const readers = [], fingerprints = [];
  for (const filename of [...files].sort()) {
    const bytes = fs.readFileSync(filename);
    total += bytes.length;
    if (total > CAPS.total) throw new InspectionError('artifact_cap');
    const text = bytes.toString('utf8'), digest = sha(bytes);
    fingerprints.push({ filename, sha256: digest });
    for (const spans of findReaders(text, parse)) readers.push({ filename, sha256: digest, spans, text });
  }
  if (readers.length !== 1) throw new InspectionError('compiled_reader');
  return { facts, buildId, manifests: Object.fromEntries(names.map((name, i) => [name, manifests[i].hash])), traceHash: trace.hash,
    compiledFiles: files.size, compiledBytes: total, compiledClosureHash: sha(JSON.stringify(fingerprints.map(file => ({ path: path.relative(next, file.filename).split(path.sep).join('/'), sha256: file.sha256 })))), readers, fingerprints };
}

/** Count accesses to real native runtime properties only at the compiled reader's exact AST spans. */
function observeNativeReads(reader, native = process) {
  const counts = { version: 0, nodeVersion: 0, releaseName: 0 };
  const restores = [];
  const lines = [0];
  for (let index = 0; index < reader.text.length; index++) if (reader.text[index] === '\n') lines.push(index + 1);
  try {
    for (const [field, object, key] of [['version', native, 'version'], ['nodeVersion', native.versions, 'node'], ['releaseName', native.release, 'name']]) {
      const original = Object.getOwnPropertyDescriptor(object, key);
      if (!original?.configurable || !Object.hasOwn(original, 'value')) throw new InspectionError('runtime_read');
      /** Return the unchanged native value; inspect only the immediate caller location in memory. */
      function getter() {
        const previous = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
        try {
          const holder = {};
          Error.captureStackTrace(holder, getter);
          Error.prepareStackTrace = (_error, frames) => frames;
          const frame = holder.stack[0];
          const offset = lines[frame?.getLineNumber() - 1] + frame?.getColumnNumber() - 1;
          const span = reader.spans[field];
          if (frame?.getFileName() === reader.filename && offset >= span.start && offset < span.end) counts[field]++;
        } finally { if (previous) Object.defineProperty(Error, 'prepareStackTrace', previous); else delete Error.prepareStackTrace; }
        return original.value;
      }
      Object.defineProperty(object, key, { configurable: true, enumerable: original.enumerable, get: getter });
      restores.push(() => Object.defineProperty(object, key, original));
    }
  } catch (error) { for (const restore of restores.reverse()) restore(); throw error; }
  return {
    /** Reset counters immediately before each sequential request. */
    reset() { for (const key of Object.keys(counts)) counts[key] = 0; },
    /** Return counts only; no stack, source text or runtime-property values are retained here. */
    snapshot() { return { ...counts }; },
    /** Restore every native descriptor even when the smoke sequence fails. */
    restore() { for (const restore of restores.reverse()) restore(); },
  };
}

/** Send exactly one bounded loopback GET, without redirects, retries, cookies or connection pooling. */
function getLocal(request, transport = http.request) {
  return new Promise((resolve, reject) => {
    let req, response, timer, done = false, bytes = 0;
    /** Close the exchange and return only transient review inputs or a fixed failure. */
    function finish(error, value) {
      if (done) return; done = true; clearTimeout(timer);
      response?.destroy(); req?.destroy();
      if (error) reject(error); else resolve(value);
    }
    req = transport({ host: '127.0.0.1', port: 32147, path: request.path, method: 'GET', headers: request.headers,
      agent: false, maxHeaderSize: CAPS.headers }, incoming => {
      response = incoming;
      incoming.on('data', chunk => { bytes += chunk.length; if (bytes > CAPS.body) finish(new InspectionError('http_cap')); });
      incoming.once('aborted', () => finish(new InspectionError('http')));
      incoming.once('error', () => finish(new InspectionError('http')));
      incoming.once('end', () => finish(null, { status: incoming.statusCode, headers: incoming.headers, rawHeaders: incoming.rawHeaders, bodyBytes: bytes }));
    });
    req.once('error', () => finish(new InspectionError('http')));
    timer = setTimeout(() => finish(new InspectionError('http')), CAPS.httpMs);
    req.end();
  });
}

/** Validate response policy and correlated facts, retaining neither synthetic credential nor challenge. */
function reviewResponse(result, request, counts, nativeVersion) {
  const headers = result.headers;
  if (!headers || headers['set-cookie'] !== undefined) throw new InspectionError('cache_cookie');
  if (request.protected) {
    if (![307, 308].includes(result.status) || typeof headers.location !== 'string') throw new InspectionError('route');
    const destination = new URL(headers.location, 'http://127.0.0.1:32147');
    if (destination.origin !== 'http://127.0.0.1:32147' || destination.pathname !== '/login' || destination.search || destination.hash) throw new InspectionError('route');
  } else if (result.status !== 200 || result.bodyBytes === 0) throw new InspectionError('route');
  if (request.marked || request.protected) {
    const policy = String(headers['cache-control'] || '').split(',').map(x => x.trim().toLowerCase());
    if (!policy.includes('private') || !policy.includes('no-store') || policy.includes('public') || policy.some(x => /^(s-maxage|max-age)=/.test(x) && !x.endsWith('=0'))) throw new InspectionError('cache_cookie');
    for (const key of ['cdn-cache-control', 'vercel-cdn-cache-control']) if (headers[key] !== undefined && headers[key] !== 'no-store') throw new InspectionError('cache_cookie');
  }
  const rawCount = result.rawHeaders.filter((_value, index) => index % 2 === 0 && result.rawHeaders[index].toLowerCase() === HEADERS.observation).length;
  if (!request.observe) {
    if (rawCount !== 0 || headers[HEADERS.observation] !== undefined || Object.values(counts).some(x => x !== 0)) throw new InspectionError('observation');
    return { case: request.case, status: result.status, observation: false, noCookies: true };
  }
  let value;
  try { value = JSON.parse(headers[HEADERS.observation]); } catch { throw new InspectionError('observation'); }
  if (rawCount !== 1 || !value || Object.keys(value).sort().join(',') !== 'challenge,node22,nodeVersion,schemaVersion,scope' ||
    value.schemaVersion !== 1 || value.scope !== 'middleware' || value.challenge !== request.challenge ||
    !/^v22\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/.test(value.nodeVersion) || value.nodeVersion !== nativeVersion || value.node22 !== true ||
    Object.values(counts).some(count => count !== 1)) throw new InspectionError('runtime_read');
  return { case: request.case, status: result.status, observation: true, challengeMatched: true, nodeVersion: value.nodeVersion,
    node22: true, nativeReadCounts: counts, noCookies: true, privateNoStore: true };
}

module.exports = { CAPS, MATCHER, HEADERS, InspectionError, sha, containedFile, jsonFile, findReaders, validateManifests, inspect, observeNativeReads, getLocal, reviewResponse };
