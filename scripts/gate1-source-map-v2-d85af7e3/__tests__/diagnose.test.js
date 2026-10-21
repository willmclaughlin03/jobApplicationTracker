'use strict';

/** Focused host mocks and isolated synthetic Linux fixtures; neither retained artifact volume is mounted. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const r = require('../diagnose');
const PRIVATE = 'synthetic-private-DO-NOT-RETAIN';
let prepared;
/** Cache one real public preparation for lifecycle mocks; mutation tests explicitly prepare afresh. */
function preparation() { return prepared || (prepared = r.prepare()); }

/** Build a strictly finite report with exact historical aggregate counts for host validation tests. */
function report(p, failure = null) {
  const verification = r.copy.lib.base(p.approval, 'verify');
  Object.assign(verification, { result: 'completed', equivalenceVerified: true, independentFiles: true, manifestSha256: r.MANIFEST });
  Object.assign(verification.counters, { entries: 3018, files: 2378, directories: 602, aliases: 38, entryVisits: 6036,
    metadataCalls: 132754, destinationVerifyBytes: 105247997, linkBytes: 1360, walks: 2 });
  return { schemaVersion: 1, approval: p.approval, result: failure ? 'stopped' : 'diagnosed', failure, verification,
    observation: failure ? null : { guard: 'target_nonfile', target: 'directory', form: 'source_mapping_reference', mapSuffix: true,
      context: { physical: false, alias: false, projected: true, independent: false } },
    historicalFailureCorroborated: !failure, inventoriesStable: !failure,
    counters: { configFilesRead: 1, candidateFilesRead: failure ? 0 : 1, configBytes: 100, candidateBytes: failure ? 0 : 50,
      inspectedBytes: 10000000, metadataCalls: 500, linkBytes: 1360, inventoryWalks: failure ? 2 : 3,
      references: failure ? 0 : 1, contextVisits: failure ? 0 : 1, jsonWork: 10, logicalEntries: 4186,
      sourceMapReferences: failure ? 0 : 1, sourceMapContexts: failure ? 0 : 1,
      missingLocalMapReferences: 0, missingLocalMapContexts: 0,
      filePathMaps: 30, mappingReferences: 62669, mappedEntries: 89745, mappedPathBytes: 9434533 },
    artifactPrivacy: 'unqualified', gate1Status: 'open' };
}

/** Own fixture receipts in this helper directory and verify the absolute cleanup boundary before deletion. */
function harness(t, options = {}) {
  const parent = path.dirname(__dirname), registry = fs.mkdtempSync(path.join(parent, 'fixture-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(registry)), parent); assert.ok(path.basename(registry).startsWith('fixture-'));
    fs.rmSync(registry, { recursive: true });
  });
  const p = preparation(), id = 'd'.repeat(64), calls = []; let active = false;
  const dependencies = { registry, prepare: () => p, readiness: async () => { if (options.readiness) throw Error(PRIVATE); },
    docker: async (args, limits) => {
      assert.deepEqual(args.slice(0, 2), ['--context', 'desktop-linux']);
      assert.ok(limits.timeoutMs > 0 && limits.timeoutMs <= r.LIMITS.operationMs);
      const a = args.slice(2); calls.push(a);
      assert.equal(JSON.parse(fs.readFileSync(path.join(registry, r.KEY + '.reservation.json'))).consumed, true);
      if (a[0] === 'create') { if (options.create) throw Error(PRIVATE); active = true; return Buffer.from(options.invalidId ? PRIVATE : id); }
      if (a[0] === 'inspect' && a[2] === '{{json .Mounts}}') return Buffer.from(JSON.stringify([
        { Destination: '/copy', Name: r.copy.VOLUME, Type: 'volume', RW: !!options.writable },
        ...(options.extraMount ? [{ Destination: '/evidence', Type: 'volume', Name: r.q.VOLUME, RW: false }] : []),
      ]));
      if (a[0] === 'ps' && a.some(s => s.startsWith('volume='))) return Buffer.from(options.attached ? 'e'.repeat(64) : id);
      if (a[0] === 'start') {
        assert.ok(limits.input.length <= 65536); assert.equal(limits.outputBytes, 16384);
        const value = report(p, options.failure), bytes = Buffer.from(options.invalidOutput ? PRIVATE : JSON.stringify(value));
        if (options.failure || options.process) {
          const error = Error(PRIVATE); try { error.report = limits.parseFailureReport(bytes); } catch { /* Discard invalid output. */ } throw error;
        }
        return bytes;
      }
      if (a[0] === 'inspect') {
        if (options.cleanup) throw Error(PRIVATE);
        return Buffer.from(JSON.stringify({ Running: !!options.running && active, ExitCode: options.exit || 0, OOMKilled: !!options.oom, Error: '' }));
      }
      if (a[0] === 'kill' || a[0] === 'rm') { active = false; return Buffer.from(id); }
      if (a[0] === 'ps') return Buffer.from(options.removalUnconfirmed ? id : '');
      throw Error('unexpected');
    } };
  return { prepared: p, registry, dependencies, calls };
}

/** Exercise the actual scanner guards and filesystem reader in Linux tmpfs using only generated data. */
async function linuxFixtures(library, copyLibrary, source, baseContract) {
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = '/tmp/gate1-source-map-fixtures'; fs.mkdirSync(root, { mode: 0o700 });
  const lib = library(), outcomes = [], approval = '1'.repeat(64);
  /** Create eighteen sorted prefix files and one candidate, with no raw values in fixture results. */
  function fixture(name = 'z.js', content = '//# sourceMappingURL=missing.txt') {
    const base = fs.mkdtempSync(root + '/case-'), original = base + '/source/.vercel/output', copy = base + '/copy/.vercel/output';
    fs.mkdirSync(original, { recursive: true }); fs.mkdirSync(path.dirname(copy), { recursive: true });
    for (let i = 0; i < 17; i++) fs.writeFileSync(`${original}/${String(i).padStart(2, '0')}.json`, '{}');
    fs.writeFileSync(original + '/config.json', '{"version":3}');
    fs.mkdirSync(path.dirname(original + '/' + name), { recursive: true }); fs.writeFileSync(original + '/' + name, content);
    return { base, original, copy, name };
  }
  /** Add generated files only inside the fixture source; paths are never returned to the host. */
  function add(f, name, value) {
    const target = path.join(f.original, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value);
  }
  /** Supply one synthetic function mapping to exercise projected context and collision semantics. */
  function mapping(f, entries) { add(f, 'functions/a.func/.vc-config.json', JSON.stringify({ filePathMap: entries })); }
  /** Copy generated input and derive fixture expectations using the same frozen public inventory/prepass. */
  async function prepare(f) {
    const v = copyLibrary().operation(f.original, f.copy, approval, null, { limits: { initialFreeBytes: 0, minimumFreeBytes: 0 } });
    assert.equal(v.result, 'completed');
    const scanner = lib.compile(source, { charge() {}, node() {}, reference() {}, context() {}, capture() {} }, fs);
    const state = { limits: scanner.LIMITS, now: () => 0, started: 0, bytesRead: 0, bytesInspected: 0, decodedBytes: 0, inlineMaps: 0,
      directoryFindings: [], logicalEntries: 0, filePathMaps: 0, mappingReferences: 0, mappedEntries: 0, mappedPathBytes: 0,
      linkPolicy: 'internal_directory_aliases_v1', filePathMapPolicy: 'inventoried_output_targets_v1' };
    const inventory = await scanner.inventory(f.copy, state), files = inventory.filter(entry => !entry.directory && !entry.alias);
    const coverage = scanner.aliasCoverage(inventory, [], state); await scanner.prepareFilePathMaps(files, coverage, [], state);
    const expected = { ordinal: files.findIndex(entry => entry.relative === f.name) + 1 };
    for (const key of ['entries', 'files', 'directories', 'aliases']) expected[key] = v.counters[key];
    for (const key of ['logicalEntries', 'filePathMaps', 'mappingReferences', 'mappedEntries', 'mappedPathBytes']) expected[key] = state[key];
    return { ...baseContract, approval, outputRoot: f.copy, manifestSha256: v.manifestSha256, expected };
  }
  /** Suppress raw fixture exceptions and clean only the verified fixture directory. */
  async function check(name, fn, artifact, content) {
    const f = fixture(artifact, content);
    try { await fn(f); outcomes.push({ name, passed: true }); }
    catch { outcomes.push({ name, passed: false }); }
    finally { assert.equal(path.dirname(path.resolve(f.base)), root); fs.rmSync(f.base, { recursive: true }); }
  }
  /** Run one reader against a generated copy, with only stricter limits and deterministic mutation hooks. */
  async function run(f, options = {}, changeContract = {}) {
    return lib.diagnose({ ...await prepare(f), ...changeContract }, source, copyLibrary, options);
  }
  /** Check finite classification and ensure neither paths nor sentinel bytes are retained. */
  function diagnosed(v, guard, context = 'independent', target = 'not_resolved') {
    assert.equal(v.result, 'diagnosed'); assert.equal(v.observation.guard, guard); assert.equal(v.observation.target, target);
    assert.equal(v.observation.context[context], true); assert.equal(v.counters.candidateFilesRead, 1);
    assert.equal(v.historicalFailureCorroborated, true); assert.equal(v.inventoriesStable, true);
    assert.equal(v.observation.mapSuffix, context === 'independent' ? null : guard !== 'target_not_map_suffix');
    assert.equal(v.artifactPrivacy, 'unqualified'); assert.equal(v.gate1Status, 'open');
    for (const text of ['synthetic-private-DO-NOT-RETAIN', root, 'missing.map', 'z.js']) assert.ok(!JSON.stringify(v).includes(text));
  }
  const map = '{"version":3,"sources":[],"mappings":""}';
  await check('nineteenth physical file and absent non-map target', async f => {
    const c = await prepare(f); assert.equal(c.expected.ordinal, 19);
    const v = await lib.diagnose(c, source, copyLibrary); diagnosed(v, 'target_not_map_suffix', 'physical', 'absent');
    assert.equal(v.counters.configFilesRead, 0); assert.equal(v.counters.candidateBytes, fs.statSync(f.copy + '/z.js').size);
  });
  for (const [name, text, guard] of [
    ['remote syntax', 'https://example.invalid/synthetic-private-DO-NOT-RETAIN', 'reference_syntax'],
    ['protocol relative syntax', '//example.invalid/x.map', 'reference_syntax'],
    ['raw query', 'a.map?private', 'reference_syntax'],
    ['raw backslash', 'a\\b.map', 'reference_syntax'],
    ['malformed URI', '%ZZ', 'reference_encoding'],
    ['decoded query', 'x%3Fy.map', 'reference_decoded_syntax'],
    ['decoded control', 'x%00.map', 'reference_decoded_syntax'],
    ['decoded protocol relative', '%2f%2fexample.invalid/x.map', 'reference_decoded_syntax'],
  ]) await check(name, async f => diagnosed(await run(f), guard), 'z.js', '//# sourceMappingURL=' + text);
  await check('outside root resolution is distinguished', async f => diagnosed(await run(f), 'resolved_dot_prefix', 'physical', 'outside_root'), 'z.js', '//# sourceMappingURL=../../outside.map');
  await check('double-dot basename is distinguished from escape', async f => {
    add(f, '..named.map', map); diagnosed(await run(f), 'resolved_dot_prefix', 'physical', 'regular_file');
  }, 'z.js', '//# sourceMappingURL=..named.map');
  await check('non-map suffix also rejects an existing regular file', async f => diagnosed(await run(f), 'target_not_map_suffix', 'physical', 'regular_file'), 'z.js', '//# sourceMappingURL=00.json');
  await check('directory target is not confused with absent file', async f => {
    fs.mkdirSync(f.original + '/directory.map'); diagnosed(await run(f), 'target_nonfile', 'physical', 'directory');
  }, 'z.js', '//# sourceMappingURL=directory.map');
  await check('directory alias target uses metadata only', async f => {
    fs.mkdirSync(f.original + '/directory'); fs.symlinkSync('directory', f.original + '/alias.map');
    diagnosed(await run(f), 'target_nonfile', 'physical', 'directory_alias');
  }, 'z.js', '//# sourceMappingURL=alias.map');
  for (const section of [null, false, 0, '']) await check(`falsy indexed section ${JSON.stringify(section)}`, async f => {
    const v = await run(f); diagnosed(v, 'indexed_section_missing'); assert.equal(v.observation.form, 'standalone_indexed_map');
  }, 'z.map', JSON.stringify({ version: 3, sections: [section] }));
  await check('indexed url field is rejected regardless of value', async f => diagnosed(await run(f), 'indexed_section_url'), 'z.map', '{"version":3,"sections":[{"url":null}]}');
  await check('nested indexed url retains source-map guard ordering', async f => diagnosed(await run(f), 'indexed_section_url'), 'z.map', '{"version":3,"sections":[{"map":{"version":3,"sections":[{"url":"private"}]}}]}');
  for (const encoding of ['base64', 'percent']) await check(`inline indexed map ${encoding}`, async f => {
    const v = await run(f); diagnosed(v, 'indexed_section_url'); assert.equal(v.observation.form, 'inline_indexed_map');
  }, 'z.js', '//# sourceMappingURL=data:application/json' + (encoding === 'base64' ? ';base64,' + Buffer.from('{"version":3,"sections":[{"url":"private"}]}').toString('base64') : ',' + encodeURIComponent('{"version":3,"sections":[{"url":"private"}]}')));
  await check('alias-only failing location preserves iteration order', async f => {
    fs.symlinkSync('z.dir/sub', f.original + '/alias'); add(f, 'z.dir/x.map', map); fs.mkdirSync(f.original + '/x.map');
    diagnosed(await run(f), 'target_nonfile', 'alias', 'directory');
  }, 'z.dir/sub/app.js', '//# sourceMappingURL=../x.map');
  await check('projected-only failing location remains required', async f => {
    add(f, 'static/app.js.map', map); mapping(f, { 'app.js': '.vercel/output/static/app.js' });
    fs.mkdirSync(f.original + '/functions/a.func/app.js.map');
    diagnosed(await run(f), 'target_nonfile', 'projected', 'directory');
  }, 'static/app.js', '//# sourceMappingURL=app.js.map');
  await check('projected implicit directory is recognized', async f => {
    add(f, 'static/app.js.map', map); add(f, 'static/leaf.js', 'safe');
    mapping(f, { 'app.js': '.vercel/output/static/app.js', 'app.js.map/leaf.js': '.vercel/output/static/leaf.js' });
    diagnosed(await run(f), 'target_nonfile', 'projected', 'projected_directory');
  }, 'static/app.js', '//# sourceMappingURL=app.js.map');
  await check('overlapping physical and mapped origins are preserved', async f => {
    mapping(f, { 'app.js': '.vercel/output/functions/a.func/app.js' });
    const v = await run(f); diagnosed(v, 'target_not_map_suffix', 'physical', 'absent'); assert.equal(v.observation.context.projected, true);
  }, 'functions/a.func/app.js', '//# sourceMappingURL=missing.txt');
  await check('two accepted absences precede the first suffix rejection', async f => {
    const v = await run(f); diagnosed(v, 'target_not_map_suffix', 'physical', 'absent');
    for (const key of ['sourceMapReferences', 'sourceMapContexts']) assert.equal(v.counters[key], 3);
    for (const key of ['missingLocalMapReferences', 'missingLocalMapContexts']) assert.equal(v.counters[key], 2);
  }, 'z.js', '//# sourceMappingURL=first.map\n//# sourceMappingURL=second.map\n//# sourceMappingURL=missing.txt');
  await check('ordinary absent map remains inconclusive rather than rejected', async f => {
    const v = await run(f); assert.equal(v.failure, 'no_rejection'); assert.equal(v.observation, null);
    assert.equal(v.counters.missingLocalMapReferences, 1); assert.equal(v.counters.missingLocalMapContexts, 1);
  }, 'z.js', '//# sourceMappingURL=missing.map');
  await check('physical absence cannot hide a later projected directory', async f => {
    mapping(f, { 'app.js': '.vercel/output/static/app.js' }); fs.mkdirSync(f.original + '/functions/a.func/blocked.map');
    const v = await run(f); diagnosed(v, 'target_nonfile', 'projected', 'directory');
    assert.equal(v.counters.sourceMapReferences, 1); assert.equal(v.counters.sourceMapContexts, 2);
    assert.equal(v.counters.missingLocalMapReferences, 1); assert.equal(v.counters.missingLocalMapContexts, 1);
  }, 'static/app.js', '//# sourceMappingURL=blocked.map');
  await check('accepted alias and physical absences cannot hide a later alias escape', async f => {
    fs.symlinkSync('z.dir/sub', f.original + '/alias');
    const v = await run(f); diagnosed(v, 'resolved_dot_prefix', 'alias', 'outside_root');
    assert.equal(v.counters.missingLocalMapReferences, 1); assert.equal(v.counters.missingLocalMapContexts, 2);
    assert.equal(v.counters.sourceMapReferences, 2); assert.equal(v.counters.sourceMapContexts, 3);
  }, 'z.dir/sub/app.js', '//# sourceMappingURL=missing.map\n//# sourceMappingURL=../../missing.map');
  await check('known physical file ancestor is not an absent target', async f => {
    diagnosed(await run(f), 'target_nonfile', 'physical', 'file_ancestor');
  }, 'z.js', '//# sourceMappingURL=00.json/child.map');
  await check('projected file ancestor is not an absent target', async f => {
    add(f, 'static/block.js', 'safe'); mapping(f, { 'app.js': '.vercel/output/static/app.js', 'block.js': '.vercel/output/static/block.js' });
    const v = await run(f); diagnosed(v, 'target_nonfile', 'physical', 'file_ancestor');
  }, 'static/app.js', '//# sourceMappingURL=../functions/a.func/block.js/child.map');
  await check('explicit projected directory is recognized without opening it', async f => {
    fs.mkdirSync(f.original + '/static/dir'); mapping(f, { 'app.js': '.vercel/output/static/app.js', 'dir.map': '.vercel/output/static/dir' });
    diagnosed(await run(f), 'target_nonfile', 'projected', 'projected_directory');
  }, 'static/app.js', '//# sourceMappingURL=dir.map');
  await check('known alias descendant directory is not an absence', async f => {
    fs.mkdirSync(f.original + '/z.dir/child.map', { recursive: true }); fs.symlinkSync('z.dir', f.original + '/alias');
    diagnosed(await run(f), 'target_nonfile', 'physical', 'directory');
  }, 'z.js', '//# sourceMappingURL=alias/child.map');
  await check('containment guard wins before suffix classification', async f => {
    const v = await run(f); assert.equal(v.result, 'diagnosed'); assert.equal(v.observation.guard, 'resolved_dot_prefix');
    assert.equal(v.observation.target, 'outside_root'); assert.equal(v.observation.mapSuffix, false);
  }, 'z.js', '//# sourceMappingURL=../missing.txt');
  await check('raw syntax guard wins before decoding and suffix checks', async f => {
    diagnosed(await run(f), 'reference_syntax');
  }, 'z.js', '//# sourceMappingURL=%ZZ?private');
  await check('suffix guard wins before directory classification', async f => {
    fs.mkdirSync(f.original + '/directory'); diagnosed(await run(f), 'target_not_map_suffix', 'physical', 'directory');
  }, 'z.js', '//# sourceMappingURL=directory');
  for (const key of ['sourceMapReferences', 'sourceMapContexts', 'missingLocalMapReferences', 'missingLocalMapContexts']) {
    await check(`consumed counter bound ${key}`, async f => {
      const c = await prepare(f); c.priorSourceMapCounts = { ...c.priorSourceMapCounts, [key]: 0 };
      const v = await lib.diagnose(c, source, copyLibrary); assert.equal(v.failure, 'mapping_mismatch'); assert.equal(v.observation, null);
    }, 'z.js', '//# sourceMappingURL=missing.map\n//# sourceMappingURL=missing.txt');
  }
  await check('more references than the consumed scan cannot corroborate it', async f => {
    const v = await run(f); assert.equal(v.failure, 'mapping_mismatch'); assert.equal(v.observation, null);
  }, 'z.js', '//# sourceMappingURL=a.map\n//# sourceMappingURL=b.map\n//# sourceMappingURL=c.map\n//# sourceMappingURL=d.txt');
  await check('all covered locations stop inconclusively without inventing failure', async f => {
    add(f, 'static/app.js.map', map); mapping(f, { 'app.js': '.vercel/output/static/app.js', 'app.js.map': '.vercel/output/static/app.js.map' });
    const v = await run(f); assert.equal(v.failure, 'no_rejection'); assert.equal(v.observation, null);
  }, 'static/app.js', '//# sourceMappingURL=app.js.map');
  await check('first reference rejection prevents later classification', async f => {
    const v = await run(f); diagnosed(v, 'reference_syntax'); assert.equal(v.counters.references, 1);
  }, 'z.js', '//# sourceMappingURL=https://example.invalid/first\n//# sourceMappingURL=missing.map');
  await check('root relative static target is included in inventory', async f => {
    add(f, 'static/maps/x.map', map); const v = await run(f); assert.equal(v.failure, 'no_rejection');
  }, 'z.js', '//# sourceMappingURL=/maps/x.map');
  await check('regex string-literal match remains only predicate evidence', async f => diagnosed(await run(f), 'reference_syntax'), 'z.js', 'const s="//# sourceMappingURL=https://example.invalid/private";');
  await check('manifest mismatch prevents configuration and candidate reads', async f => {
    const v = await run(f, {}, { manifestSha256: '0'.repeat(64) }); assert.equal(v.failure, 'verification'); assert.equal(v.counters.candidateFilesRead, 0); assert.equal(v.counters.configFilesRead, 0);
  });
  await check('inventory count mismatch prevents candidate access', async f => {
    const c = await prepare(f); c.expected.files++; const v = await lib.diagnose(c, source, copyLibrary);
    assert.equal(v.failure, 'inventory_mismatch'); assert.equal(v.counters.candidateFilesRead, 0);
  });
  await check('mapping counter mismatch prevents candidate access', async f => {
    const c = await prepare(f); c.expected.mappedPathBytes++; const v = await lib.diagnose(c, source, copyLibrary);
    assert.equal(v.failure, 'mapping_mismatch'); assert.equal(v.counters.candidateFilesRead, 0);
  });
  await check('missing candidate ordinal stops without fallback', async f => {
    const c = await prepare(f); c.expected.ordinal = 9999; const v = await lib.diagnose(c, source, copyLibrary); assert.equal(v.failure, 'unexpected_ordinal');
  });
  await check('unrelated candidate parser failure remains inconclusive', async f => {
    const v = await run(f); assert.equal(v.failure, 'unexpected_guard'); assert.equal(v.observation, null);
  }, 'z.map', '{');
  await check('mutation after verification invalidates attribution', async f => {
    const v = await run(f, { afterVerification() { fs.appendFileSync(f.copy + '/00.json', ' '); } }); assert.equal(v.failure, 'changed'); assert.equal(v.counters.candidateFilesRead, 0);
  });
  await check('candidate mutation is caught before open', async f => {
    const v = await run(f, { beforeCandidate() { fs.appendFileSync(f.copy + '/z.js', ' '); } }); assert.equal(v.failure, 'changed'); assert.equal(v.counters.candidateFilesRead, 0);
  });
  await check('candidate replaced by outside symlink is never opened', async f => {
    const v = await run(f, { beforeCandidate() { fs.unlinkSync(f.copy + '/z.js'); fs.symlinkSync(f.original + '/z.js', f.copy + '/z.js'); } });
    assert.equal(v.result, 'stopped'); assert.equal(v.counters.candidateFilesRead, 0); assert.equal(v.observation, null);
  });
  await check('post-candidate mutation suppresses observed classification', async f => {
    const v = await run(f, { afterCandidate() { fs.appendFileSync(f.copy + '/00.json', ' '); } }); assert.equal(v.failure, 'changed'); assert.equal(v.observation, null);
  });
  await check('new hard link stops before candidate reading', async f => {
    const c = await prepare(f); fs.linkSync(f.copy + '/z.js', f.base + '/outside'); const v = await lib.diagnose(c, source, copyLibrary);
    assert.equal(v.result, 'stopped'); assert.equal(v.counters.candidateFilesRead, 0);
  });
  await check('outside alias cannot be followed by the diagnostic', async f => {
    const c = await prepare(f); fs.symlinkSync('../../outside', f.copy + '/bad'); const v = await lib.diagnose(c, source, copyLibrary);
    assert.equal(v.result, 'stopped'); assert.equal(v.counters.candidateFilesRead, 0);
  });
  for (const [name, limits] of [['deadline', { diagnosticMs: 0 }], ['metadata', { metadataCalls: 0 }],
    ['candidate bytes', { candidateBytes: 0 }], ['file size', { fileBytes: 0 }], ['combined bytes', { inspectedBytes: 0 }],
    ['verification bytes', { verificationBytes: 0 }], ['references', { references: 0 }], ['reference bytes', { referenceBytes: 0 }],
    ['context work', { contextVisits: 0 }]]) await check(`bounded ${name}`, async f => {
    const v = await run(f, { limits }); assert.equal(v.result, 'stopped'); assert.equal(v.observation, null);
  });
  await check('aggregate JSON work cap stops configuration parsing', async f => {
    mapping(f, { 'app.js': '.vercel/output/z.js' }); const v = await run(f, { limits: { jsonWork: 0 } }); assert.equal(v.failure, 'json_work'); assert.equal(v.counters.candidateFilesRead, 0);
  });
  for (const limits of [{ configFiles: 0 }, { configBytes: 0 }]) await check(`configuration cap ${Object.keys(limits)[0]}`, async f => {
    mapping(f, { 'app.js': '.vercel/output/z.js' }); const v = await run(f, { limits }); assert.equal(v.failure, 'configuration_limit');
  });
  for (const count of [64, 65]) await check(`configuration count boundary ${count}`, async f => {
    for (let i = 0; i < count; i++) add(f, `functions/f${i}.func/.vc-config.json`, '{}');
    const v = await run(f);
    if (count === 64) { diagnosed(v, 'target_not_map_suffix', 'physical', 'absent'); assert.equal(v.counters.configFilesRead, 64); }
    else { assert.equal(v.failure, 'configuration_limit'); assert.equal(v.counters.configFilesRead, 0); }
  });
  for (const extra of [0, 1]) await check(`candidate byte boundary ${extra ? 'above' : 'exact'}`, async f => {
    const suffix = '\n//# sourceMappingURL=missing.txt';
    fs.writeFileSync(f.original + '/z.js', ' '.repeat(baseContract.limits.candidateBytes - Buffer.byteLength(suffix) + extra) + suffix);
    const v = await run(f);
    if (extra) { assert.equal(v.failure, 'file_size'); assert.equal(v.counters.candidateFilesRead, 0); }
    else { diagnosed(v, 'target_not_map_suffix', 'physical', 'absent'); assert.equal(v.counters.candidateBytes, baseContract.limits.candidateBytes); }
  });
  await check('source hash drift refuses compilation before any filesystem call', async f => {
    const v = await lib.diagnose(await prepare(f), source + '\n', copyLibrary); assert.equal(v.failure, 'bootstrap'); assert.equal(v.counters.metadataCalls, 0);
  });
  await check('test limit seam cannot raise approved bounds', async f => {
    const v = await run(f, { limits: { candidateBytes: baseContract.limits.candidateBytes + 1 } }); assert.equal(v.failure, 'input');
  });
  return { schemaVersion: 1, outcomes, passed: outcomes.filter(v => v.passed).length, failed: outcomes.filter(v => !v.passed).length,
    nodeVersion: process.versions.node, retainedVolumesMounted: false, retainedContentReads: 0 };
}

/** Run only generated fixtures in the pinned offline image; no volumes or host files are mounted. */
async function runLinux() {
  const p = preparation(), source = r.q.publicFile(r.SCANNER).toString();
  const code = `(${linuxFixtures.toString()})(${r.diagnosticLibrary.toString()},${r.copy.copyLibrary.toString()},${JSON.stringify(source)},${JSON.stringify(p.contract)})` +
    `.then(v=>{process.stdout.write(JSON.stringify(v)+'\\n');if(v.failed)process.exitCode=1;}).catch(()=>{process.stderr.write('Linux fixtures stopped.\\n');process.exitCode=1;});`;
  const input = Buffer.from(`eval(require('node:zlib').inflateSync(Buffer.from(${JSON.stringify(r.copy.packed(code))},'base64'),{maxOutputLength:262144}).toString());`);
  assert.ok(input.length <= 65536);
  const run = r.d.budgetRunner((a, o) => r.q.supervise('docker', a, o), 180000); let id;
  try {
    const name = 'gate1-source-map-synthetic-v2';
    assert.equal((await run(['ps', '-aq', '--filter', `name=^/${name}$`])).toString().trim(), '');
    id = (await run(['create', '--name', name, '--pull=never', '--platform=linux/amd64', '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--restart=no', '--log-driver=none', '--cpus=2', '--memory=2147483648',
      '--memory-swap=2147483648', '--pids-limit=32', '--ulimit=core=0:0', '--ulimit=nofile=256:256',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=33554432,mode=1777', '--entrypoint', '/usr/bin/timeout', '-i', p.contract.imageId,
      '--signal=KILL', '160s', '/usr/bin/env', '-i', '/opt/node-v22.23.3-linux-x64/bin/node', '--max-old-space-size=1536', '-'], { outputBytes: 128 })).toString().trim();
    assert.match(id, /^[a-f0-9]{64}$/);
    const mounts = JSON.parse((await run(['inspect', '--format', '{{json .Mounts}}', id])).toString());
    assert.equal(mounts.filter(m => m.Type !== 'tmpfs').length, 0);
    /** Accept only finite test status and public case names; suppress all raw child exceptions. */
    const parse = bytes => {
      const value = r.prior.lib.parse(bytes, 16384); assert.equal(value.schemaVersion, 1);
      assert.ok(Array.isArray(value.outcomes) && value.outcomes.length <= 100);
      assert.ok(value.outcomes.every(v => typeof v.name === 'string' && v.name.length < 110 && typeof v.passed === 'boolean'));
      assert.equal(value.retainedVolumesMounted, false); assert.equal(value.retainedContentReads, 0); return value;
    };
    let result;
    try { result = parse(await run(['start', '-ai', id], { input, outputBytes: 16384, parseFailureReport: parse })); }
    catch (error) { if (!error.report) throw error; result = error.report; }
    const state = await r.d.teardown(run, id); id = undefined;
    Object.assign(result, { containerRemoved: true, exitCode: state.exitCode, oomKilled: state.oomKilled });
    process.stdout.write(JSON.stringify(result) + '\n'); if (result.failed || !state.clean) process.exitCode = 1;
  } finally { if (id && /^[a-f0-9]{64}$/.test(id)) await r.d.teardown(r.d.budgetRunner((a, o) => r.q.supervise('docker', a, o), 20000), id); }
}

if (process.argv.includes('--linux-fixtures')) runLinux().catch(() => { process.stderr.write('Synthetic source-map fixture supervision stopped.\n'); process.exitCode = 1; });
else {
  test('public preparation binds frozen staging source and consumed emitted-map evidence', () => {
    const p = preparation(); assert.equal(p.authorized, false); assert.equal(p.retainedContentReads, 0);
    assert.equal(p.approval, r.hash(JSON.stringify(p.contract))); assert.notEqual(p.approval, r.OLD_APPROVAL);
    assert.equal(p.contract.expected.ordinal, 19); assert.equal(p.contract.manifestSha256, r.MANIFEST);
    assert.equal(p.contract.preservation.mappingV3ReviewRecords, 9); assert.equal(p.contract.preservation.mappingV3ExecutionRecords, 6);
    assert.equal(p.contract.preservation.emittedMapReviewRecords, 17); assert.equal(p.contract.preservation.emittedMapExecutionRecords, 6);
    assert.equal(p.contract.scannerSourceCommit, 'b76b531e56f346bca88562d5d2b68e477a20eaca');
    assert.equal(p.contract.sourceMapPolicy, 'emitted_inventory_v1');
    assert.deepEqual(p.contract.priorSourceMapCounts, { sourceMapReferences: 3, sourceMapContexts: 3,
      missingLocalMapReferences: 2, missingLocalMapContexts: 2 });
    assert.equal(p.contract.policy.privateComparisonReads, 0); assert.ok(r.containerInput(p).length <= 65536);
  });
  test('serialized production bootstrap parses and binds only reviewed public code', () => {
    const p = preparation(), input = r.containerInput(p).toString();
    const match = /Buffer\.from\("([A-Za-z0-9+/=]+)",'base64'\)/.exec(input); assert.ok(match);
    const code = require('node:zlib').inflateSync(Buffer.from(match[1], 'base64')).toString();
    new (require('node:vm').Script)(code); assert.ok(!code.includes('comparisons.json'));
  });
  test('only copy read-only mount and pinned offline resource limits are present', () => {
    const args = r.containerArgs(); assert.equal(args.filter(s => s === '--mount').length, 1);
    assert.ok(args.includes(`type=volume,src=${r.copy.VOLUME},dst=/copy,readonly,volume-nocopy`));
    assert.ok(!args.some(s => s.includes(r.q.VOLUME)));
    for (const flag of ['--network=none', '--read-only', '--pull=never', '--cap-drop=ALL', '--log-driver=none', '--cpus=2', '--memory=2147483648']) assert.ok(args.includes(flag));
  });
  test('one diagnosis consumes reservation preserves report and prevents replay', async t => {
    const h = harness(t), v = await r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies);
    assert.equal(v.result, 'diagnosed'); assert.equal(v.lockReleased, true); assert.equal(v.artifactPrivacy, 'unqualified');
    assert.equal(h.calls.filter(a => a[0] === 'start').length, 1); assert.ok(!h.calls.some(a => a[0] === 'volume'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.registry, r.KEY + '.report.json'))).lockReleased, false);
    await assert.rejects(r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies));
  });
  test('concurrent submissions share one immutable reservation and start at most one reader', async t => {
    const h = harness(t), envelope = { approval: h.prepared.approval, confirmation: r.CONFIRMATION };
    const results = await Promise.allSettled([r.execute(envelope, h.dependencies), r.execute(envelope, h.dependencies)]);
    assert.equal(results.filter(v => v.status === 'fulfilled').length, 1); assert.equal(results.filter(v => v.status === 'rejected').length, 1);
    assert.equal(h.calls.filter(a => a[0] === 'create').length, 1); assert.equal(h.calls.filter(a => a[0] === 'start').length, 1);
  });
  for (const options of [{ readiness: true }, { writable: true }, { extraMount: true }, { attached: true }, { failure: 'verification' },
    { failure: 'mapping_mismatch' }, { process: true }, { invalidOutput: true }, { exit: 17 }, { oom: true }, { running: true }]) {
    test(`execution boundary stops without retry ${JSON.stringify(options)}`, async t => {
      const h = harness(t, options), v = await r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies);
      assert.equal(v.result, 'stopped'); assert.ok(!JSON.stringify(v).includes(PRIVATE));
      if (options.failure) assert.equal(v.diagnostic.failure, options.failure);
      assert.ok(h.calls.filter(a => a[0] === 'start').length <= 1);
      await assert.rejects(r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies));
    });
  }
  for (const options of [{ create: true }, { invalidId: true }, { cleanup: true }, { removalUnconfirmed: true }]) {
    test(`uncertainty preserves mutex ${JSON.stringify(options)}`, async t => {
      const h = harness(t, options), v = await r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies);
      assert.equal(v.teardownUnconfirmed, true); assert.equal(v.lockReleased, false); assert.ok(fs.existsSync(path.join(h.registry, 'active.lock')));
    });
  }
  for (const kind of ['reservation', 'report']) test(`persistence failure ${kind} prevents a success claim`, async t => {
    const h = harness(t); h.dependencies.persist = (file, value) => { if (file.endsWith(`.${kind}.json`)) throw Error(PRIVATE); r.copy.persist(file, value); };
    const v = await r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies);
    assert.equal(v.result, 'stopped'); assert.equal(v.persistenceFailure, true); assert.equal(v.lockReleased, false);
  });
  test('wrong approval extra keys and a foreign mutex cause zero Docker calls', async t => {
    const h = harness(t);
    for (const e of [{ approval: r.OLD_APPROVAL, confirmation: r.CONFIRMATION }, { approval: h.prepared.approval, confirmation: r.previous.CONFIRMATION },
      { approval: h.prepared.approval, confirmation: r.CONFIRMATION, root: PRIVATE }]) await assert.rejects(r.execute(e, h.dependencies));
    fs.writeFileSync(path.join(h.registry, 'active.lock'), 'foreign');
    await assert.rejects(r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies)); assert.equal(h.calls.length, 0);
  });
  test('changed mutex is preserved after durable reporting', async t => {
    const h = harness(t); h.dependencies.persist = (file, value) => { r.copy.persist(file, value); if (file.endsWith('.report.json')) fs.appendFileSync(path.join(h.registry, 'active.lock'), 'changed'); };
    const v = await r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies); assert.equal(v.lockReleased, false); assert.equal(v.persistenceFailure, true);
  });
  test('strict result validation suppresses arbitrary fields strings and false provenance', () => {
    const p = preparation(), base = report(p); assert.equal(r.validateReport(Buffer.from(JSON.stringify(base)), p).result, 'diagnosed');
    for (const change of [{ raw: PRIVATE }, { observation: { ...base.observation, guard: PRIVATE } }, { failure: PRIVATE },
      { artifactPrivacy: 'qualified' }, { historicalFailureCorroborated: false }, { verification: { ...base.verification, manifestSha256: '0'.repeat(64) } },
      { counters: { ...base.counters, candidateFilesRead: 2 } }, { counters: { ...base.counters, mappingReferences: 1 } },
      { counters: { ...base.counters, contextVisits: 0 } }, { observation: { ...base.observation, target: 'regular_file' } },
      { observation: { ...base.observation, guard: 'resolved_absolute', target: 'regular_file' } },
      { observation: { ...base.observation, context: { physical: false, alias: false, projected: false, independent: false } } }]) {
      assert.throws(() => r.validateReport(Buffer.from(JSON.stringify({ ...base, ...change })), p));
    }
    assert.throws(() => r.validateReport(Buffer.alloc(16385), p)); assert.throws(() => r.validateReport(Buffer.from('{"a":1,"a":2}'), p));
    assert.throws(() => r.validateReport(Buffer.from(JSON.stringify(base).replace('"references":1', '"references":-0')), p));
  });
  test('stopped reports cannot retain an observed but uncorroborated guard', () => {
    const p = preparation(), v = report(p, 'changed'); v.observation = report(p).observation;
    assert.throws(() => r.validateReport(Buffer.from(JSON.stringify(v)), p));
  });
  test('new observation fields reject raw text and contradictory suffix categories', () => {
    const p = preparation(), v = report(p);
    for (const observation of [{ ...v.observation, mapSuffix: PRIVATE }, { ...v.observation, reference: PRIVATE },
      { ...v.observation, mapSuffix: false }, { ...v.observation, target: 'absent' },
      { ...v.observation, guard: 'target_not_known_file' }, { ...v.observation, context: { ...v.observation.context, path: PRIVATE } },
      { ...v.observation, guard: 'target_not_map_suffix', mapSuffix: true },
      { ...v.observation, guard: 'reference_syntax', target: 'not_resolved', context: { physical: false, alias: false, projected: false, independent: true } }]) {
      assert.throws(() => r.validateReport(Buffer.from(JSON.stringify({ ...v, observation })), p));
    }
  });
  test('accepted absence counters retain their exact bounds and consistency', () => {
    const p = preparation(), v = report(p);
    Object.assign(v.counters, { references: 3, contextVisits: 3, sourceMapReferences: 3, sourceMapContexts: 3,
      missingLocalMapReferences: 2, missingLocalMapContexts: 2 });
    assert.equal(r.validateReport(Buffer.from(JSON.stringify(v)), p).result, 'diagnosed');
    for (const counters of [{ references: 2 }, { contextVisits: 2 }, { missingLocalMapReferences: 3 },
      { missingLocalMapContexts: 3 }, { missingLocalMapReferences: 0 }, { missingLocalMapContexts: 0 },
      { sourceMapReferences: 4, references: 4 }, { sourceMapContexts: 4, contextVisits: 4 },
      { missingLocalMapReferences: -0 }, { missingLocalMapContexts: PRIVATE }]) {
      assert.throws(() => r.validateReport(Buffer.from(JSON.stringify({ ...v, counters: { ...v.counters, ...counters } })), p));
    }
  });
  test('a reported guard requires its reached reference and rejecting context counters', () => {
    const p = preparation(), v = report(p);
    for (const counters of [{ sourceMapReferences: 0 }, { sourceMapContexts: 0 },
      { missingLocalMapReferences: 1, missingLocalMapContexts: 1 }]) {
      assert.throws(() => r.validateReport(Buffer.from(JSON.stringify({ ...v, counters: { ...v.counters, ...counters } })), p));
    }
    const independent = { ...v, observation: { guard: 'reference_syntax', target: 'not_resolved', form: 'source_mapping_reference', mapSuffix: null,
      context: { physical: false, alias: false, projected: false, independent: true } } };
    independent.counters = { ...v.counters, missingLocalMapReferences: 1, missingLocalMapContexts: 1 };
    assert.throws(() => r.validateReport(Buffer.from(JSON.stringify(independent)), p));
  });
  test('compilation refuses any scanner-byte drift before observations', () => {
    assert.throws(() => r.lib.compile('malicious private input', {}, {}));
    const source = fs.readFileSync(r.SCANNER, 'utf8'); r.lib.compile(source, {}, {});
    assert.throws(() => r.lib.compile(source + '\n', {}, {}));
  });
  test('unreachable absolute guard remains correctly classified in isolated metadata test', () => {
    const o = r.lib.observe('reference_target', { location: 'a.js', relative: '/outside.map' }, { relative: 'a.js' },
      { knownFiles: new Set(), nodes: new Map() }, new Map(), new Set(['a.js']), () => {});
    assert.equal(o.guard, 'resolved_absolute'); assert.equal(o.target, 'outside_root'); assert.equal(o.context.physical, true);
  });
  test('new test bytes change approval and consumed receipt drift stops preparation', t => {
    const before = preparation().approval, original = r.q.fileHash;
    t.mock.method(r.q, 'fileHash', file => file === __filename ? '0'.repeat(64) : original(file)); assert.notEqual(r.prepare().approval, before);
    t.mock.restoreAll(); t.mock.method(r.q, 'fileHash', file => file.endsWith('execution-evidence-index.json') ? '0'.repeat(64) : original(file)); assert.throws(() => r.prepare());
  });
  test('real child nonzero exit retains only schema-validated failure', async () => {
    const p = preparation(), v = report(p, 'verification');
    await assert.rejects(r.q.supervise(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(v))});process.exitCode=1;`],
      { timeoutMs: 10000, outputBytes: 16384, parseFailureReport: bytes => r.validateReport(bytes, p) }), e => e.report?.failure === 'verification');
  });
  test('real child arbitrary stdout and stderr are discarded on failure', async () => {
    const p = preparation();
    await assert.rejects(r.q.supervise(process.execPath, ['-e', `process.stdout.write('${PRIVATE}');process.stderr.write('${PRIVATE}');process.exitCode=1;`],
      { timeoutMs: 10000, outputBytes: 16384, parseFailureReport: bytes => r.validateReport(bytes, p) }), e => !e.report && !JSON.stringify(e).includes(PRIVATE));
  });
}
module.exports = { linuxFixtures, runLinux };
