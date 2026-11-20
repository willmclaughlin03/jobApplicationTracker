'use strict';
/* global process */

/** Private runtime attribution adapter; the consumed static inspector stays unchanged. */
const fs = require('node:fs');
const path = require('node:path');
const base = require('../main-8c68fd9e-static-attempt-1/inspect-compiled.cjs');

/** Carry only a fixed category across the evidence boundary, never stack/source text. */
class RuntimeError extends Error {
  /** Construct a bounded runtime failure; callers allowlist the category before retention. */
  constructor(code) { super(code); this.code = code; }
}

/** Reproduce the frozen inspector's private member matcher without altering its public package. */
function memberBase(node, suffix) {
  /** Unwrap optional access syntactically without evaluating compiled code. */
  const unwrap = value => value?.type === 'ChainExpression' ? value.expression : value;
  let value = unwrap(node);
  for (const name of [...suffix].reverse()) {
    if (value?.type !== 'MemberExpression' || value.computed || value.property?.name !== name) return null;
    value = unwrap(value.object);
  }
  return value;
}

/** Find private member spans using the same structural contract and traversal caps as static inspection. */
function findReaderSpans(text, parse) {
  let ast;
  try { ast = parse(text, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch { throw new RuntimeError('reader_parse'); }
  const queue = [ast], readers = [];
  let visited = 0;
  while (queue.length) {
    const node = queue.pop();
    if (!node || typeof node !== 'object') continue;
    if (++visited > base.CAPS.nodes) throw new RuntimeError('artifact_cap');
    if (node.type === 'ObjectExpression' && node.properties?.length === 3) {
      const properties = node.properties.filter(p => p.type === 'Property' && !p.computed);
      const props = Object.fromEntries(properties.map(p => [p.key.name ?? p.key.value, p.value]));
      const fields = { version: ['version'], nodeVersion: ['versions', 'node'], releaseName: ['release', 'name'] };
      const bases = Object.entries(fields).map(([key, suffix]) => memberBase(props[key], suffix));
      if (bases.every(Boolean) && new Set(bases.map(value => text.slice(value.start, value.end))).size === 1) {
        readers.push(Object.fromEntries(Object.keys(fields).map(key => [key, { start: props[key].start, end: props[key].end }])));
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const item of value) queue.push(item); }
      else if (value && typeof value === 'object') queue.push(value);
    }
    if (queue.length > base.CAPS.nodes) throw new RuntimeError('artifact_cap');
  }
  return readers;
}

/** Qualify this build, then independently recover private spans and prove closure agreement in memory. */
function inspect(app, routes, parse) {
  const facts = base.inspect(app, routes, parse), next = path.join(app, '.next');
  const trace = base.jsonFile(next, 'server/middleware.js.nft.json');
  if (trace.hash !== facts.traceHash) throw new RuntimeError('source_content');
  const files = new Set([base.containedFile(next, 'server/middleware.js')]);
  for (const relative of trace.value.files) {
    if (typeof relative !== 'string' || relative.length > 1024 || /[\\:]/.test(relative) || path.posix.isAbsolute(relative) || [...relative].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new RuntimeError('artifact_path');
    const filename = base.containedFile(app, path.posix.normalize('.next/server/' + relative));
    if (filename.startsWith(path.join(next, 'server') + path.sep) && filename.endsWith('.js')) files.add(filename);
  }
  if (files.size > base.CAPS.files) throw new RuntimeError('artifact_cap');
  const fingerprints = [], readers = [];
  let bytes = 0;
  for (const filename of [...files].sort()) {
    const data = fs.readFileSync(base.containedFile(next, path.relative(next, filename).split(path.sep).join('/')));
    bytes += data.length;
    if (data.length > base.CAPS.file || bytes > base.CAPS.total) throw new RuntimeError('artifact_cap');
    const text = data.toString('utf8'), sha256 = base.sha(data);
    fingerprints.push({ path: path.relative(next, filename).split(path.sep).join('/'), sha256 });
    for (const spans of findReaderSpans(text, parse)) readers.push({ filename, text, spans });
  }
  if (readers.length !== 1 || files.size !== facts.compiledFiles || bytes !== facts.compiledBytes || base.sha(JSON.stringify(fingerprints)) !== facts.compiledClosureHash) throw new RuntimeError('reader_ambiguous');
  return { facts, reader: readers[0] };
}

/** Reinspect the same output after execution; any identity, manifest or closure drift rejects the result. */
function recheck(app, routes, parse, before) {
  if (JSON.stringify(base.inspect(app, routes, parse)) !== JSON.stringify(before)) throw new RuntimeError('source_content');
  return true;
}

/** Count only immediate native getters whose callers lie within this build's exact compiled spans. */
function observeNativeReads(reader, native = process) {
  const counts = { version: 0, nodeVersion: 0, releaseName: 0 }, restores = [], lines = [0];
  let restored = false, unavailable = false;
  for (let index = 0; index < reader.text.length; index++) {
    const char = reader.text[index];
    if (char === '\r' && reader.text[index + 1] === '\n') index++;
    if (char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029') lines.push(index + 1);
  }
  /** Attempt every restoration even after one fails; restoration cannot silently become a pass. */
  function restore() {
    if (restored) return;
    let failed = false;
    for (const entry of [...restores].reverse()) {
      try { Object.defineProperty(entry.object, entry.key, entry.original); } catch { failed = true; }
    }
    restored = !failed;
    if (failed) throw new RuntimeError('cleanup');
  }
  try {
    for (const [field, object, key] of [['version', native, 'version'], ['nodeVersion', native.versions, 'node'], ['releaseName', native.release, 'name']]) {
      const original = Object.getOwnPropertyDescriptor(object, key);
      if (!original?.configurable || !Object.hasOwn(original, 'value')) throw new RuntimeError('runtime_read');
      /** Preserve the actual native value, retaining only an attributable count or method-failure flag. */
      function getter() {
        const previous = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
        try {
          const holder = {};
          Error.captureStackTrace(holder, getter);
          Error.prepareStackTrace = (_error, frames) => frames;
          const frame = holder.stack[0];
          if (!frame) unavailable = true;
          else if (frame.getFileName() === reader.filename) {
            const line = frame.getLineNumber(), column = frame.getColumnNumber();
            const offset = lines[line - 1] + column - 1, span = reader.spans[field];
            if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1 || !Number.isInteger(offset)) unavailable = true;
            else if (offset >= span.start && offset < span.end) counts[field]++;
          }
        } catch { unavailable = true; }
        finally {
          try { if (previous) Object.defineProperty(Error, 'prepareStackTrace', previous); else delete Error.prepareStackTrace; }
          catch { unavailable = true; }
        }
        return original.value;
      }
      Object.defineProperty(object, key, { configurable: true, enumerable: original.enumerable, get: getter });
      restores.push({ object, key, original });
    }
  } catch (error) {
    const failure = new RuntimeError(error.code === 'runtime_read' ? 'runtime_read' : 'internal');
    try { restore(); failure.descriptorsRestored = true; }
    catch { failure.code = 'cleanup'; failure.descriptorsRestored = false; }
    throw failure;
  }
  return {
    /** Clear request counts only; an earlier instrumentation failure remains disqualifying. */
    reset() { for (const key of Object.keys(counts)) counts[key] = 0; },
    /** Snapshot bounded counts without retaining any native stack or source information. */
    snapshot() { if (unavailable) throw new RuntimeError('runtime_read'); return { ...counts }; },
    restore,
  };
}

module.exports = { RuntimeError, findReaderSpans, inspect, recheck, observeNativeReads };
