'use strict';

/** Local source-map diagnosis; preparation never mounts artifacts and execution requires fresh consent. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
/** Hash public code and aggregate receipts; never publish private per-file or comparison digests. */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
const previousFile = path.join(ROOT, '.tmp/gate1-absent-source-maps-d85af7e3/run-scan.js');
if (hash(fs.readFileSync(previousFile)) !== '9be4054d2554a03e4040d484ac3f658039b28177a854038b044bef3fe86b61cd') throw Error('provenance');
const previous = require(previousFile), { q, d, prior, copy } = previous;
const SCANNER = path.join(previous.CHECKOUT, 'scripts/gate1-build-artifact-privacy.js');
const SCANNER_SHA = 'e00cd82d330e9563ff8f12057291a3882724ae6fe54c36494c22b2c874073dc8';
const SCOPE = 'gate1_source_map_diagnostic_v2';
const KEY = `${prior.lib.fixed.sourceSha}.source-map-diagnostic-v2`;
const CONTAINER = 'gate1-source-map-d85af7e3-v2';
const CONFIRMATION = 'DIAGNOSE REMAINING SOURCE MAP REJECTION ONCE';
const OLD_APPROVAL = '4743f237306d0635825a30c18227e0389672401b9cd2d0b0d2d30185209d9dba';
const MANIFEST = previous.MANIFEST;
const LIMITS = Object.freeze({ operationMs: 90000, cleanupMs: 20000, linuxSeconds: 60,
  diagnosticMs: 45000, verificationMs: 15000, verificationBytes: 134217728,
  configFiles: 64, configBytes: 4194304, candidateBytes: 4194304, fileBytes: 4194304,
  inspectedBytes: 134217728, metadataCalls: 400000, linkBytes: 131072,
  references: 4096, referenceBytes: 4096, contextVisits: 200000, jsonWork: 1000000,
  reportBytes: 16384, inputBytes: 65536, stderrBytes: 8388608, cpus: 2, memoryBytes: 2147483648,
  tmpfsBytes: 33554432, hostFreeBytes: 268435456 });
const EXPECTED = Object.freeze({ ordinal: 19, entries: 3018, files: 2378, directories: 602, aliases: 38,
  logicalEntries: 4186, filePathMaps: 30, mappingReferences: 62669, mappedEntries: 89745, mappedPathBytes: 9434533 });
const PRIOR_MAP_COUNTS = Object.freeze({ sourceMapReferences: 3, sourceMapContexts: 3,
  missingLocalMapReferences: 2, missingLocalMapContexts: 2 });

/** Standalone Linux reader; evaluates only hash-checked public scanner functions, never artifact code. */
function diagnosticLibrary() {
  const fs = require('node:fs'), path = require('node:path'), { performance } = require('node:perf_hooks');
  const SCANNER_SHA = 'e00cd82d330e9563ff8f12057291a3882724ae6fe54c36494c22b2c874073dc8';
  const GUARDS = ['indexed_section_missing', 'indexed_section_url', 'reference_syntax', 'reference_encoding',
    'reference_decoded_syntax', 'resolved_dot_prefix', 'resolved_absolute', 'target_nonfile', 'target_not_map_suffix'];
  const TARGETS = ['not_resolved', 'outside_root', 'regular_file', 'directory', 'directory_alias', 'projected_directory', 'file_ancestor', 'absent'];
  const FORMS = ['standalone_indexed_map', 'inline_indexed_map', 'source_mapping_reference'];
  const FAILURES = ['input', 'bootstrap', 'verification', 'deadline', 'metadata', 'bytes', 'file_size',
    'configuration_limit', 'reference_limit', 'reference_size', 'context_limit', 'json_work', 'changed',
    'unexpected_guard', 'unexpected_ordinal', 'mapping_mismatch', 'inventory_mismatch', 'no_rejection', 'io', 'cleanup'];
  /** Carry finite categories only; filesystem, parser and artifact strings never cross the boundary. */
  class Stop extends Error {
    /** Restrict failure text to the reviewed vocabulary. */
    constructor(code) { super(FAILURES.includes(code) ? code : 'io'); this.code = this.message; }
  }
  /** Instrument exact public anchors without changing guard predicates, iteration order or mapped locations. */
  function compile(source, hooks, io) {
    if (require('node:crypto').createHash('sha256').update(source).digest('hex') !== SCANNER_SHA) throw new Stop('bootstrap');
    let text = source;
    /** Require a unique anchor so changed source cannot silently alter the observation contract. */
    function replace(old, value) {
      if (text.split(old).length !== 2) throw new Stop('bootstrap'); text = text.replace(old, value);
    }
    replace("const fs = require('node:fs');", 'const fs = diagnosticFs;');
    replace("const { z } = require('zod');", '');
    const first = text.indexOf('const hex = z.string()'), last = text.indexOf('/** Keep raw filesystem/schema messages');
    if (first < 0 || last <= first) throw new Stop('bootstrap'); text = text.slice(0, first) + text.slice(last);
    const store = text.indexOf('/** Create one immutable reservation/report outside the inspected tree; originals cannot be overwritten. */');
    if (store < 0) throw new Stop('bootstrap'); text = text.slice(0, store);
    replace('checkTime(state);\n  if (state.bytesInspected + length', 'checkTime(state); hooks.charge(length);\n  if (state.bytesInspected + length');
    replace('const item = stack.pop();', 'const item = stack.pop(); hooks.node();');
    replace('if (++literals > state.limits.jsonNodes)', 'hooks.node(); if (++literals > state.limits.jsonNodes)');
    replace('for (const section of map.sections) {', 'for (const section of map.sections) { hooks.node();');
    replace("if (!section || Object.hasOwn(section, 'url')) throw new ScanError('external_map');",
      "if (!section || Object.hasOwn(section, 'url')) throw (hooks.capture('indexed_section', { section }), new ScanError('external_map'));");
    replace('checkTime(state); const ref = match[1];', 'checkTime(state); const ref = match[1]; hooks.reference(ref);');
    replace("if (/[\\\\?#:]/.test(ref) || ref.startsWith('//')) throw new ScanError('external_map');",
      "if (/[\\\\?#:]/.test(ref) || ref.startsWith('//')) throw (hooks.capture('reference_syntax', {}), new ScanError('external_map'));");
    replace("try { local = decodeURIComponent(ref); } catch { throw new ScanError('external_map'); }",
      "try { local = decodeURIComponent(ref); } catch { throw (hooks.capture('reference_encoding', {}), new ScanError('external_map')); }");
    replace("if (/[\\\\?#:]/.test(local) || hasControl(local) || local.startsWith('//')) throw new ScanError('external_map');",
      "if (/[\\\\?#:]/.test(local) || hasControl(local) || local.startsWith('//')) throw (hooks.capture('reference_decoded_syntax', {}), new ScanError('external_map'));");
    replace('for (const location of locations) {', 'for (const location of locations) { hooks.context();');
    replace("if (relative.startsWith('..') || path.isAbsolute(relative) || !/\\.map$/i.test(relative)) {\n          throw new ScanError('external_map');",
      "if (relative.startsWith('..') || path.isAbsolute(relative) || !/\\.map$/i.test(relative)) {\n          throw (hooks.capture('reference_target', { location, relative }), new ScanError('external_map'));");
    replace("if (!emitted || !absentMapTarget(relative, knownFiles, state)) throw new ScanError('external_map');",
      "if (!emitted || !absentMapTarget(relative, knownFiles, state)) throw (hooks.capture('target_nonfile', { location, relative }), new ScanError('external_map'));");
    return new Function('require', 'diagnosticFs', 'hooks', `${text}\nreturn { inventory, aliasCoverage, prepareFilePathMaps, inspectFile, readStable, ScanError, LIMITS };`)(require, io, hooks);
  }
  /** Compare inventories including root identity and alias resolutions without retaining their names. */
  function same(a, b) {
    return a.rootStamp === b.rootStamp && a.length === b.length && a.every((entry, i) =>
      ['relative', 'stamp', 'directory', 'alias', 'target', 'targetRelative', 'targetStamp'].every(k => entry[k] === b[i][k]));
  }
  /** Classify the exact short-circuit predicate and location origins from in-memory inventory only. */
  function observe(kind, details, candidate, coverage, projected, originalLocations, tick) {
    let guard = kind, target = 'not_resolved', mapSuffix = null;
    const context = { physical: false, alias: false, projected: false, independent: true };
    let form = 'source_mapping_reference';
    if (kind === 'indexed_section') {
      guard = details.section ? 'indexed_section_url' : 'indexed_section_missing';
      form = /\.map$/i.test(candidate.relative) ? 'standalone_indexed_map' : 'inline_indexed_map';
    } else if (kind === 'reference_target' || kind === 'target_nonfile') {
      const name = details.relative;
      mapSuffix = /\.map$/i.test(name);
      guard = kind === 'target_nonfile' ? kind : name.startsWith('..') ? 'resolved_dot_prefix' :
        path.isAbsolute(name) ? 'resolved_absolute' : 'target_not_map_suffix';
      context.independent = false;
      context.physical = details.location === candidate.relative;
      context.alias = originalLocations.has(details.location) && !context.physical;
      context.projected = projected.get(details.location)?.relative === candidate.relative;
      if (!context.physical && !context.alias && !context.projected) throw new Stop('inventory_mismatch');
      const node = coverage.nodes.get(name);
      if (path.isAbsolute(name) || name === '..' || name.startsWith('../')) target = 'outside_root';
      else if (coverage.knownFiles.has(name)) target = 'regular_file';
      else if (node?.alias) target = 'directory_alias';
      else if (node?.directory) target = 'directory';
      else if (projected.get(name)?.directory) target = 'projected_directory';
      else {
        target = 'absent';
        for (const destination of projected.keys()) { tick(); if (destination.startsWith(name + path.sep)) { target = 'projected_directory'; break; } }
        if (target === 'absent') {
          let ancestor = path.dirname(name);
          while (ancestor !== '.') {
            tick(); if (coverage.knownFiles.has(ancestor)) { target = 'file_ancestor'; break; }
            ancestor = path.dirname(ancestor);
          }
        }
      }
    }
    if (!GUARDS.includes(guard)) throw new Stop('unexpected_guard');
    return { guard, target, form, context, mapSuffix };
  }
  /** Verify the copy, rebuild mapping contexts, and inspect only the historically selected physical file. */
  async function diagnose(contract, source, copyLibrary, options = {}) {
    const limits = { ...contract.limits }, now = options.now || (() => performance.now()), started = now();
    const result = { schemaVersion: 1, approval: contract.approval, result: 'stopped', failure: null,
      verification: null, observation: null, historicalFailureCorroborated: false, inventoriesStable: false,
      counters: { configFilesRead: 0, candidateFilesRead: 0, configBytes: 0, candidateBytes: 0, inspectedBytes: 0,
        metadataCalls: 0, linkBytes: 0, inventoryWalks: 0, references: 0, contextVisits: 0, jsonWork: 0,
        sourceMapReferences: 0, sourceMapContexts: 0, missingLocalMapReferences: 0, missingLocalMapContexts: 0,
        logicalEntries: 0, filePathMaps: 0, mappingReferences: 0, mappedEntries: 0, mappedPathBytes: 0 },
      artifactPrivacy: 'unqualified', gate1Status: 'open' };
    const c = result.counters; let candidate, coverage, projected, originalLocations, observed, phase = 'inventory', allowed = new Map(), state, bytes;
    /** Enforce one monotonic diagnostic deadline including its bounded fingerprint verification. */
    function tick() { if (now() - started >= limits.diagnosticMs) throw new Stop('deadline'); }
    /** Bound metadata calls and streaming directory visits before issuing filesystem operations. */
    function metadata() { tick(); if (c.metadataCalls >= limits.metadataCalls) throw new Stop('metadata'); c.metadataCalls++; }
    /** Charge raw, decoded and logical-name work; whole-copy verification has its own explicit budget. */
    function charge(length) { tick(); if (c.inspectedBytes + length > limits.inspectedBytes) throw new Stop('bytes'); c.inspectedBytes += length; }
    /** Bound aggregate JSON traversal, literal decoding and indexed source-map sections. */
    function node() { tick(); if (c.jsonWork >= limits.jsonWork) throw new Stop('json_work'); c.jsonWork++; }
    /** Bound matched reference work; inline bytes are additionally bounded by the candidate and decoded budgets. */
    function reference(value) {
      tick(); if (c.references >= limits.references) throw new Stop('reference_limit'); c.references++;
      if (Buffer.byteLength(value) > (value.startsWith('data:') ? limits.candidateBytes : limits.referenceBytes)) throw new Stop('reference_size');
    }
    /** Bound each reference/location resolution without changing the scanner's Set insertion order. */
    function context() { tick(); if (c.contextVisits >= limits.contextVisits) throw new Stop('context_limit'); c.contextVisits++; }
    /** Capture only a candidate source-map guard; failed configuration preparation remains inconclusive. */
    function capture(kind, details) {
      tick(); if (phase !== 'candidate' || observed) throw new Stop('unexpected_guard');
      observed = observe(kind, details, candidate, coverage, projected, originalLocations, tick);
    }
    const io = { constants: fs.constants, promises: {
      /** Preserve the frozen inventory and stable reader's before/after identity checks. */
      async lstat(...args) { metadata(); return fs.promises.lstat(...args); },
      /** Bound aggregate alias text; aliases are resolved in memory and never traversed on disk. */
      async readlink(...args) {
        metadata(); const value = await fs.promises.readlink(...args);
        if (c.linkBytes + value.length > limits.linkBytes) throw new Stop('bytes'); c.linkBytes += value.length; return value;
      },
      /** Stream physical directory entries with bounded work and guaranteed owned-handle closure. */
      async opendir(...args) {
        metadata(); const dir = await fs.promises.opendir(...args);
        return {
          /** Preserve native enumeration before the scanner's canonical physical-path sort. */
          async *[Symbol.asyncIterator]() {
            try { while (true) { metadata(); const entry = await dir.read(); if (!entry) break; yield entry; } }
            finally { await dir.close(); }
          },
        };
      },
      /** Allow content opens only for inventoried configurations or the one selected candidate. */
      async open(location, flags) {
        metadata(); const entry = allowed.get(location), config = phase === 'configuration';
        if (!entry || (!config && phase !== 'candidate') || flags !== (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)) throw new Stop('io');
        if (entry.size > limits.fileBytes || (!config && entry.size > limits.candidateBytes)) throw new Stop('file_size');
        if (config && (c.configFilesRead >= limits.configFiles || c.configBytes + entry.size > limits.configBytes)) throw new Stop('configuration_limit');
        if (!config && c.candidateFilesRead !== 0) throw new Stop('unexpected_ordinal');
        const handle = await fs.promises.open(location, flags); let offset = 0;
        if (config) c.configFilesRead++; else c.candidateFilesRead++;
        return {
          /** Preserve inode and timestamp checks after descriptor acquisition. */
          async stat() { metadata(); return handle.stat(); },
          /** Read only the inventoried size; the stable reader's final stat rejects observed growth. */
          async read(buffer, start, length, position) {
            tick(); if (offset === entry.size) return { bytesRead: 0 };
            metadata(); const value = await handle.read(buffer, start, Math.min(length, entry.size - offset), position);
            offset += value.bytesRead; c[config ? 'configBytes' : 'candidateBytes'] += value.bytesRead; return value;
          },
          /** Close owned descriptors even after an exhausted work budget. */
          async close() { try { await handle.close(); } catch { throw new Stop('cleanup'); } },
        };
      },
    } };
    try {
      if (process.platform !== 'linux') throw new Stop('input');
      for (const [key, value] of Object.entries(options.limits || {})) {
        if (!(key in limits) || !Number.isSafeInteger(value) || value < 0 || value > limits[key]) throw new Stop('input'); limits[key] = value;
      }
      const scanner = compile(source, { charge, node, reference, context, capture }, io);
      state = { limits: { ...scanner.LIMITS, overallMs: limits.diagnosticMs }, now, started, bytesRead: 0, bytesInspected: 0,
        decodedBytes: 0, inlineMaps: 0, directoryFindings: [], logicalEntries: 0, filePathMaps: 0, mappingReferences: 0, mappedEntries: 0,
        mappedPathBytes: 0, linkPolicy: 'internal_directory_aliases_v1', filePathMapPolicy: 'inventoried_output_targets_v1',
        sourceMapPolicy: 'emitted_inventory_v1', sourceMapReferences: 0, sourceMapContexts: 0,
        missingLocalMapReferences: 0, missingLocalMapContexts: 0 };
      const before = await scanner.inventory(contract.outputRoot, state); c.inventoryWalks++;
      result.verification = copyLibrary().operation(null, contract.outputRoot, contract.approval, contract.manifestSha256,
        { limits: { overallMs: limits.verificationMs, destinationVerifyBytes: limits.verificationBytes, entryVisits: 100000, metadataCalls: 500000 } });
      if (result.verification.result !== 'completed') throw new Stop('verification'); tick();
      for (const key of ['entries', 'files', 'directories', 'aliases']) {
        if (result.verification.counters[key] !== contract.expected[key]) throw new Stop('inventory_mismatch');
      }
      options.afterVerification?.();
      const verified = await scanner.inventory(contract.outputRoot, state); c.inventoryWalks++;
      if (!same(before, verified)) throw new Stop('changed');
      const files = before.filter(entry => !entry.directory && !entry.alias);
      candidate = files[contract.expected.ordinal - 1];
      if (!candidate || contract.expected.ordinal < 1 || !Number.isSafeInteger(contract.expected.ordinal)) throw new Stop('unexpected_ordinal');
      coverage = scanner.aliasCoverage(before, [], state);
      if (!coverage.knownFiles.has('config.json')) throw new Stop('inventory_mismatch');
      originalLocations = new Set(coverage.locations.get(candidate.relative));
      const configurations = files.filter(entry => path.basename(entry.relative) === '.vc-config.json');
      if (configurations.length > limits.configFiles || configurations.reduce((sum, entry) => sum + entry.size, 0) > limits.configBytes) throw new Stop('configuration_limit');
      phase = 'configuration'; allowed = new Map(configurations.map(entry => [entry.absolute, entry]));
      await scanner.prepareFilePathMaps(files, coverage, [], state); projected = coverage.projected;
      // Mirror the exact reviewed scanOutput name index, including implicit projected ancestors.
      state.sourceMapPaths = [...new Set([...before.map(entry => entry.relative),
        ...coverage.nodes.keys(), ...projected.keys()])].sort();
      if (state.sourceMapPaths.length > state.limits.maxEntries * 2 + state.limits.mappedEntries) throw new Stop('mapping_mismatch');
      tick();
      for (const key of ['logicalEntries', 'filePathMaps', 'mappingReferences', 'mappedEntries', 'mappedPathBytes']) {
        if (state[key] !== contract.expected[key]) throw new Stop('mapping_mismatch');
      }
      options.beforeCandidate?.(); phase = 'candidate'; allowed = new Map([[candidate.absolute, candidate]]);
      try {
        bytes = await scanner.readStable(candidate, state);
        scanner.inspectFile(bytes, candidate, coverage.knownFiles, [], state, coverage.locations.get(candidate.relative));
      } catch (error) {
        if (!(error instanceof scanner.ScanError && error.code === 'external_map' && observed)) throw error;
      } finally { bytes?.fill(0); bytes = undefined; }
      if (!observed) throw new Stop('no_rejection');
      // The selected candidate is a subset of the consumed scan; larger counters cannot corroborate it.
      for (const [key, maximum] of Object.entries(contract.priorSourceMapCounts)) {
        if (state[key] > maximum) throw new Stop('mapping_mismatch');
      }
      options.afterCandidate?.(); phase = 'inventory'; allowed.clear();
      const after = await scanner.inventory(contract.outputRoot, state); c.inventoryWalks++;
      if (!same(before, after)) throw new Stop('changed'); tick();
      result.observation = observed; result.inventoriesStable = true; result.historicalFailureCorroborated = true; result.result = 'diagnosed';
    } catch (error) {
      result.failure = error instanceof Stop ? error.code : error.code === 'changed' ? 'changed' : 'unexpected_guard';
    } finally {
      bytes?.fill(0);
      if (state) for (const key of ['logicalEntries', 'filePathMaps', 'mappingReferences', 'mappedEntries', 'mappedPathBytes',
        'sourceMapReferences', 'sourceMapContexts', 'missingLocalMapReferences', 'missingLocalMapContexts']) c[key] = state[key];
    }
    return result;
  }
  return { GUARDS, TARGETS, FORMS, FAILURES, compile, same, observe, diagnose };
}
const lib = diagnosticLibrary();

/** Reject arbitrary text, unknown keys and contradictory success or provenance before retaining any output. */
function validateReport(bytes, prepared) {
  const { z } = require('zod'), expected = prepared.contract.expected;
  /** Require bounded integer counts without coercion, negative zero or unsafe precision. */
  const count = max => z.number().int().min(0).max(max).refine(value => !Object.is(value, -0));
  const observation = z.object({ guard: z.enum(lib.GUARDS), target: z.enum(lib.TARGETS), form: z.enum(lib.FORMS), mapSuffix: z.boolean().nullable(),
    context: z.object({ physical: z.boolean(), alias: z.boolean(), projected: z.boolean(), independent: z.boolean() }).strict() }).strict();
  const value = z.object({ schemaVersion: z.literal(1), approval: z.literal(prepared.approval), result: z.enum(['stopped', 'diagnosed']),
    failure: z.enum(lib.FAILURES).nullable(), verification: z.unknown(), observation: observation.nullable(),
    historicalFailureCorroborated: z.boolean(), inventoriesStable: z.boolean(),
    counters: z.object({ configFilesRead: count(LIMITS.configFiles), candidateFilesRead: count(1), configBytes: count(LIMITS.configBytes),
      candidateBytes: count(LIMITS.candidateBytes), inspectedBytes: count(LIMITS.inspectedBytes), metadataCalls: count(LIMITS.metadataCalls),
      linkBytes: count(LIMITS.linkBytes), inventoryWalks: count(3), references: count(LIMITS.references), contextVisits: count(LIMITS.contextVisits),
      sourceMapReferences: count(LIMITS.references), sourceMapContexts: count(LIMITS.contextVisits),
      missingLocalMapReferences: count(LIMITS.references), missingLocalMapContexts: count(LIMITS.contextVisits),
      jsonWork: count(LIMITS.jsonWork), logicalEntries: count(50000), filePathMaps: count(100000), mappingReferences: count(100000),
      mappedEntries: count(200000), mappedPathBytes: count(67108864) }).strict(), artifactPrivacy: z.literal('unqualified'), gate1Status: z.literal('open')
  }).strict().parse(prior.lib.parse(bytes, LIMITS.reportBytes));
  if (value.verification !== null) {
    value.verification = copy.validateCopy(Buffer.from(JSON.stringify(value.verification)), prepared.approval, 'verify');
    const v = value.verification;
    if (v.result === 'completed' && v.manifestSha256 !== prepared.contract.manifestSha256) throw Error('report');
    if (v.counters.destinationVerifyBytes > LIMITS.verificationBytes || v.counters.entryVisits > 100000 ||
        v.counters.metadataCalls > 500000 || v.counters.walks > 2) throw Error('report');
  }
  const c = value.counters, o = value.observation;
  if ((value.result === 'diagnosed') !== (value.failure === null) ||
      (c.candidateFilesRead === 0 && c.candidateBytes !== 0) || (c.configFilesRead === 0 && c.configBytes !== 0) ||
      c.filePathMaps > c.mappingReferences || c.mappedEntries < c.filePathMaps || c.mappedPathBytes > c.inspectedBytes ||
      c.sourceMapReferences > c.references || c.sourceMapContexts > c.contextVisits ||
      (c.sourceMapContexts > 0 && c.sourceMapReferences === 0) ||
      c.missingLocalMapReferences > c.sourceMapReferences || c.missingLocalMapContexts > c.sourceMapContexts ||
      c.missingLocalMapReferences > c.missingLocalMapContexts ||
      (c.missingLocalMapReferences === 0) !== (c.missingLocalMapContexts === 0)) throw Error('report');
  if (value.result === 'diagnosed') {
    if (!o || !value.historicalFailureCorroborated || !value.inventoriesStable || value.verification?.result !== 'completed' ||
        c.candidateFilesRead !== 1 || c.inventoryWalks !== 3 || c.inspectedBytes < c.configBytes + c.candidateBytes) throw Error('report');
    for (const key of ['entries', 'files', 'directories', 'aliases']) if (value.verification.counters[key] !== expected[key]) throw Error('report');
    for (const key of ['logicalEntries', 'filePathMaps', 'mappingReferences', 'mappedEntries', 'mappedPathBytes']) if (c[key] !== expected[key]) throw Error('report');
    for (const [key, maximum] of Object.entries(prepared.contract.priorSourceMapCounts)) if (c[key] > maximum) throw Error('report');
    const independent = !['resolved_dot_prefix', 'resolved_absolute', 'target_nonfile', 'target_not_map_suffix'].includes(o.guard);
    if (o.context.independent !== independent || independent !== (o.target === 'not_resolved') ||
        independent === (o.context.physical || o.context.alias || o.context.projected) || (o.context.physical && o.context.alias) ||
        (o.guard.startsWith('indexed_section') !== (o.form !== 'source_mapping_reference')) ||
        (o.guard === 'resolved_absolute' && o.target !== 'outside_root') ||
        independent !== (o.mapSuffix === null) || (o.guard === 'target_not_map_suffix' && (o.mapSuffix !== false || o.target === 'outside_root')) ||
        (o.guard === 'target_nonfile' && (o.mapSuffix !== true || ['regular_file', 'outside_root', 'absent'].includes(o.target))) ||
        (o.form !== 'standalone_indexed_map' && c.references === 0) ||
        (o.form === 'source_mapping_reference' && c.sourceMapReferences === 0) ||
        (!independent && c.sourceMapContexts <= c.missingLocalMapContexts) ||
        (independent && o.form === 'source_mapping_reference' && c.sourceMapReferences <= c.missingLocalMapReferences)) throw Error('report');
  } else if (o || value.historicalFailureCorroborated || value.inventoriesStable) throw Error('report');
  return value;
}

/** Bind the consumed emitted-map scan and unchanged public source; older receipts remain immutable. */
function verifyEvidence() {
  const base = path.dirname(previousFile), indexes = [
    ['review-index.json', 'b7c169a1649044e03ae10131f24995241d7f37060ed38a41ad22dae849154f2a', 17],
    ['execution-evidence-index.json', '4f8ebff2162d15df9a9cce5341352bba447c444b7f8d31b78462815f6ee13768', 6],
  ];
  for (const [name, digest, count] of indexes) {
    const file = path.join(base, name); if (q.fileHash(file) !== digest) throw Error('provenance');
    const index = prior.lib.parse(q.publicFile(file)); if (index.files?.length !== count) throw Error('provenance');
    for (const item of index.files) if (!path.resolve(item.file).startsWith(ROOT + path.sep) || q.fileHash(item.file) !== item.sha256) throw Error('provenance');
  }
  const p = previous.prepare(), terminal = prior.lib.parse(q.publicFile(path.join(base, 'execution-terminal.json')));
  previous.validateReport(Buffer.from(JSON.stringify(terminal.scan)), p);
  if (p.approval !== OLD_APPROVAL || terminal.approval !== OLD_APPROVAL || terminal.result !== 'stopped' ||
      terminal.scan.scan?.summary.scannerFailure !== 'external_map' || terminal.scan.scan.summary.counters.filesRecorded !== 18 ||
      terminal.scan.verification.result !== 'completed' || terminal.scan.bootstrapFailure !== null || terminal.exitCode !== 1 || terminal.oomKilled ||
      !terminal.lockReleased || terminal.persistenceFailure || terminal.teardownUnconfirmed) throw Error('provenance');
  for (const key of ['filePathMaps', 'mappingReferences', 'mappedEntries', 'mappedPathBytes']) if (terminal.scan.scan.mapping[key] !== EXPECTED[key]) throw Error('provenance');
  if (terminal.scan.scan.sourceMaps.sourceMapPolicy !== 'emitted_inventory_v1') throw Error('provenance');
  for (const [key, value] of Object.entries(PRIOR_MAP_COUNTS)) if (terminal.scan.scan.sourceMaps[key] !== value) throw Error('provenance');
  return { ...p.contract.preservation, emittedMapReviewRecords: 17, emittedMapExecutionRecords: 6 };
}

/** Only the independent copy is mounted; original comparison values and dependency volumes are unnecessary. */
function containerArgs() {
  return ['create', '--name', CONTAINER, '--pull=never', '--platform=linux/amd64', '--network=none', '--read-only',
    '--user=0:0', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--restart=no', '--log-driver=none',
    '--cpus=2', '--memory=2147483648', '--memory-swap=2147483648', '--pids-limit=32', '--ulimit=core=0:0', '--ulimit=nofile=256:256',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=33554432,mode=1777',
    '--mount', `type=volume,src=${copy.VOLUME},dst=/copy,readonly,volume-nocopy`,
    '--entrypoint', '/usr/bin/timeout', '-i', prior.lib.fixed.imageId, '--signal=KILL', '60s',
    '/usr/bin/env', '-i', '/opt/node-v22.23.3-linux-x64/bin/node', '--max-old-space-size=1536', '-'];
}

/** Produce a concrete unapproved contract from public source and receipts without Docker or artifact access. */
function prepare() {
  const preservation = verifyEvidence(); if (q.fileHash(SCANNER) !== SCANNER_SHA) throw Error('scanner');
  const contract = { schemaVersion: 1, scope: SCOPE, sourceSha: prior.lib.fixed.sourceSha, context: q.CONTEXT,
    daemonId: prior.lib.fixed.daemonId, imageId: prior.lib.fixed.imageId, originalBuildBinding: prior.lib.fixed.binding,
    volume: copy.VOLUME, outputRoot: copy.OUTPUT, manifestSha256: MANIFEST, helperSha256: q.fileHash(__filename),
    testsSha256: q.fileHash(path.join(__dirname, '__tests__/diagnose.test.js')), previousSha256: q.fileHash(previousFile),
    scannerSha256: SCANNER_SHA, scannerSourceCommit: 'b76b531e56f346bca88562d5d2b68e477a20eaca', scannerSourceBranch: 'staging',
    sourceMapPolicy: 'emitted_inventory_v1', priorSourceMapCounts: PRIOR_MAP_COUNTS, preservation, limits: LIMITS, expected: EXPECTED,
    mappingLimits: { references: 100000, visits: 200000, destinationBytes: 67108864, singlePathBytes: 4096 },
    verificationLimits: { overallMs: 15000, destinationVerifyBytes: 134217728, entryVisits: 100000, metadataCalls: 500000 },
    container: CONTAINER, containerArgs: containerArgs(), reservationKey: KEY, confirmation: CONFIRMATION,
    traversal: 'nineteenth_sorted_physical_file_with_original_alias_and_projected_location_order',
    instrumentation: 'exact_hash_checked_source_map_guard_observers_no_predicate_relaxation',
    policy: { copyReadOnly: true, fingerprintReadsWholeCopy: true, configurationPrepassIncluded: true,
      candidateCount: 1, privateComparisonReads: 0, originalVolumeMounted: false, referenceTargetsOpened: false,
      diagnosticTargetClassificationUsesInventoryOnly: true, acceptedAbsencesCountedBeforeFailure: true,
      suffixClassificationIsBooleanOnly: true, candidateCountsCannotExceedConsumedScanCounts: true,
      artifactCodeExecuted: false, rawStreamsRetained: false,
      pathsReferencesSnippetsAndIndividualHashesRetained: false, finiteCategoriesCountsAndExistingAggregateFingerprintOnly: true,
      preserveBothVolumes: true, exclusiveDaemonAndVolumesControlRequired: true, retainLockOnUncertainTeardown: true,
      downloads: 0, builds: 0, newCopies: 0, fullPrivacyScans: 0, retries: 0 },
    limitations: ['scanner_predicate_reproduction_not_operational_source_map_equivalence', 'regex_match_is_not_proof_of_lexical_comment',
      'indexed_section_target_base_not_resolved', 'no_content_privacy_qualification', 'first_rejection_only',
      'budget_or_mutation_or_inconclusive_result_stops_without_retry', 'host_storage_threshold_is_not_volume_quota'],
    executionRecords: ['execution-owner-approval.json', 'execution-terminal.json', 'execution-postflight.json', 'execution-evidence-index.json'],
    gate1Status: 'open' };
  const prepared = { schemaVersion: 1, authorized: false, approval: hash(JSON.stringify(contract)), contract, retainedContentReads: 0 };
  containerInput(prepared); return prepared;
}

/** Serialize reviewed public code only; both host and child suppress raw errors and retain finite reports. */
function containerInput(prepared) {
  const source = q.publicFile(SCANNER, 65536).toString(); if (hash(source) !== SCANNER_SHA) throw Error('scanner');
  const code = `(${diagnosticLibrary.toString()})().diagnose(${JSON.stringify({ ...prepared.contract, approval: prepared.approval })},` +
    `${JSON.stringify(source)},${copy.copyLibrary.toString()}).then(r=>{const s=JSON.stringify(r);` +
    `if(Buffer.byteLength(s)>16384)throw Error('report');process.stdout.write(s+'\\n');if(r.result!=='diagnosed')process.exitCode=1;})` +
    `.catch(()=>{process.stderr.write('Source-map diagnosis stopped.\\n');process.exitCode=1;});`;
  if (Buffer.byteLength(code) > 196608) throw Error('input');
  const input = Buffer.from(`eval(require('node:zlib').inflateSync(Buffer.from(${JSON.stringify(copy.packed(code))},'base64'),{maxOutputLength:196608}).toString());`);
  if (input.length > LIMITS.inputBytes) throw Error('input'); return input;
}

/** Check daemon, image, volumes, container absence and storage metadata without opening retained content. */
async function readiness(run, registryCheck = true) {
  const old = await previous.readiness(run, false);
  if ((await run(['ps', '-aq', '--filter', `name=^/${CONTAINER}$`], { outputBytes: 4096 })).toString().trim()) throw Error('container');
  if (registryCheck && ['active.lock', `${KEY}.reservation.json`, `${KEY}.report.json`].some(name => fs.existsSync(path.join(prior.REGISTRY, name)))) throw Error('reservation');
  const disk = fs.statfsSync(__dirname), available = disk.bavail * disk.bsize;
  if (old.daemonMemoryBytes < LIMITS.memoryBytes || !Number.isSafeInteger(available) || available < LIMITS.hostFreeBytes) throw Error('resources');
  return { ...old, sourceMapContainerAbsent: true, newReservationAbsent: registryCheck ? true : null,
    activeLockAbsent: registryCheck ? true : null, hostAvailableBytes: available, retainedContentReads: 0 };
}

/** Require exactly the one reviewed read-only volume and exclusive attachment before the reader starts. */
async function verifyMounts(run, id) {
  const mounts = prior.lib.parse(await run(['inspect', '--format', '{{json .Mounts}}', id]), 8192);
  const volumes = mounts.filter(m => m.Type !== 'tmpfs');
  if (volumes.length !== 1 || volumes[0].Name !== copy.VOLUME || volumes[0].Destination !== '/copy' || volumes[0].Type !== 'volume' || volumes[0].RW !== false) throw Error('mount');
  const attached = (await run(['ps', '-aq', '--no-trunc', '--filter', `volume=${copy.VOLUME}`], { outputBytes: 4096 })).toString().trim();
  if (attached !== id) throw Error('exclusive');
}

/** Release only this attempt's unchanged ordinary lock after confirmed teardown and durable persistence. */
function releaseLock(lock, expected) {
  const current = fs.lstatSync(lock);
  if (current.isSymbolicLink() || !prior.lib.same(expected, current)) throw Error('lock'); fs.unlinkSync(lock);
}

/** Consume one distinct approval, retain validated failures, and preserve locks when cleanup is uncertain. */
async function execute(envelope, dependencies = {}) {
  if (!prior.lib.keys(envelope, ['approval', 'confirmation']) || envelope.confirmation !== CONFIRMATION) throw Error('approval');
  const prepared = (dependencies.prepare || prepare)(); if (prepared.approval !== envelope.approval) throw Error('approval');
  const registry = dependencies.registry || prior.REGISTRY, save = dependencies.persist || copy.persist;
  const docker = dependencies.docker || ((a, o) => q.supervise('docker', a, o));
  const run = d.budgetRunner(docker, LIMITS.operationMs, dependencies.now), lock = path.join(registry, 'active.lock');
  /** Address only this version's immutable reservation and terminal registry report. */
  const receipt = name => path.join(registry, `${KEY}.${name}.json`);
  q.safePath(registry); if (['reservation', 'report'].some(n => fs.existsSync(receipt(n)))) throw Error('reservation');
  save(lock, { scope: SCOPE, approval: prepared.approval }); const lockStat = fs.lstatSync(lock);
  const result = { schemaVersion: 1, scope: SCOPE, approval: prepared.approval, result: 'stopped', failureStep: null,
    diagnostic: null, exitCode: null, oomKilled: null, teardownUnconfirmed: false, persistenceFailure: false,
    lockReleased: false, volumesRetained: true, artifactPrivacy: 'unqualified', gate1Status: 'open' };
  let step = 'reservation', id, uncertain = false, reserved = false;
  try {
    save(receipt('reservation'), { scope: SCOPE, approval: prepared.approval, consumed: true }); reserved = true;
    step = 'readiness'; await (dependencies.readiness || readiness)(run, false);
    step = 'create'; uncertain = true;
    const created = (await run(containerArgs(), { outputBytes: 128 })).toString().trim();
    if (!/^[a-f0-9]{64}$/.test(created)) throw Error('container'); id = created; uncertain = false;
    step = 'mounts'; await verifyMounts(run, id);
    step = 'process';
    /** Validate stdout before retaining it, including reports accompanying a nonzero child exit. */
    const validate = bytes => validateReport(bytes, prepared);
    try { result.diagnostic = validate(await run(['start', '-ai', id], { input: containerInput(prepared), outputBytes: LIMITS.reportBytes,
      stderrBytes: LIMITS.stderrBytes, parseFailureReport: validate })); }
    catch (error) { if (error.report) result.diagnostic = validate(Buffer.from(JSON.stringify(error.report))); throw Error('process'); }
    if (result.diagnostic.result !== 'diagnosed') throw Error('diagnostic');
    step = 'teardown'; const state = await d.teardown(run, id); id = undefined;
    result.exitCode = state.exitCode; result.oomKilled = state.oomKilled; if (!state.clean) throw Error('exit');
    result.result = 'diagnosed';
  } catch { result.failureStep = step; if (!reserved) result.persistenceFailure = true; }
  finally {
    if (id) {
      try { const state = await d.teardown(d.budgetRunner(docker, LIMITS.cleanupMs, dependencies.now), id);
        result.exitCode = state.exitCode; result.oomKilled = state.oomKilled; id = undefined;
      } catch { uncertain = true; }
    }
    result.teardownUnconfirmed = uncertain;
    if (uncertain) { result.result = 'stopped'; result.failureStep = 'cleanup'; }
    try { save(receipt('report'), result); } catch { result.persistenceFailure = true; result.result = 'stopped'; }
    if (!result.persistenceFailure && !uncertain) {
      try { releaseLock(lock, lockStat); result.lockReleased = true; }
      catch { result.persistenceFailure = true; result.result = 'stopped'; }
    }
  }
  return result;
}

/** Separate public preparation and metadata readiness from exactly one explicitly authorized content read. */
async function main(args) {
  if (args.length === 1 && args[0] === '--prepare') return prepare();
  if (args.length === 1 && args[0] === '--readiness') { prepare(); return readiness(d.budgetRunner((a, o) => q.supervise('docker', a, o), 60000)); }
  if (args.length === 3 && args[0] === '--execute') return execute({ approval: args[1], confirmation: args[2] });
  throw Error('input');
}
if (require.main === module) main(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n'); if (result.result === 'stopped') process.exitCode = 1;
}).catch(() => { process.stderr.write('Source-map diagnostic stopped. Preserve evidence; no automatic retry.\n'); process.exitCode = 1; });
module.exports = { ROOT, SCANNER, SCANNER_SHA, SCOPE, KEY, CONTAINER, CONFIRMATION, OLD_APPROVAL, MANIFEST, LIMITS, EXPECTED, PRIOR_MAP_COUNTS,
  previous, copy, q, d, prior, hash, diagnosticLibrary, lib, validateReport, verifyEvidence, containerArgs, prepare, containerInput, readiness, verifyMounts, execute, main };
