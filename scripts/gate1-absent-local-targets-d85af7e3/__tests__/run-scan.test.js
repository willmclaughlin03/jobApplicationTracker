'use strict';

/** Synthetic filesystem fixtures and mocked execution only; retained artifact volumes are never mounted. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const r = require('../run-scan');
const PRIVATE = 'synthetic-private-DO-NOT-RETAIN';
let preparedCache;
/** Reuse one verified preparation for synthetic cases; the drift regression explicitly re-prepares. */
function preparationFixture() { return preparedCache ||= r.prepare(); }
/** Read the frozen contract only after the current preparation verifies its immutable evidence index. */
function previousPrepared() {
  preparationFixture();
  return r.prior.lib.parse(r.q.publicFile(path.join(r.ROOT, '.tmp/gate1-absent-source-maps-d85af7e3/prepared.json')));
}

/** Build a complete synthetic verification and projected scan, with realistic unqualified failure state. */
function report(p, failure = null) {
  const verification = r.copy.lib.base(p.approval, 'verify');
  Object.assign(verification, { result: 'completed', failure: null, equivalenceVerified: true,
    independentFiles: true, manifestSha256: p.contract.copyManifestSha256 });
  Object.assign(verification.counters, { entries: 3, files: 1, directories: 1, aliases: 1,
    entryVisits: 6, metadataCalls: 100, destinationVerifyBytes: 12, linkBytes: 6, walks: 2 });
  const fullCoverage = !failure || failure === 'findings';
  return { verification, bootstrapFailure: null, scan: {
    summary: { schemaVersion: 1, scope: r.SCOPE, approval: p.approval, scannerApproval: p.contract.scannerApproval,
      scannerResult: failure ? 'stopped' : 'completed', scannerFailure: failure,
      coverage: fullCoverage ? 'selected_directory_inventory_and_supported_representations' : 'unqualified',
      artifactPrivacy: failure ? 'unqualified' : 'no_matches_in_checked_representations', gate1Status: 'open',
      manifestSha256: fullCoverage ? 'a'.repeat(64) : null, reportSaved: true,
      counters: { filesRecorded: 1, filesWithFindings: failure === 'findings' ? 1 : 0, pathsWithFindings: 0,
        aliasesVerified: fullCoverage ? 1 : 0, logicalEntries: 5, bytesRead: 12, bytesInspected: 24, decodedBytes: 12, inlineMaps: 0 },
      comparisonLabels: failure === 'findings' ? ['csrf_secret'] : [], patterns: [], scannerPersistenceFailure: null },
    mapping: { filePathMapPolicy: r.scanner.FILE_PATH_MAP_POLICY, filePathMaps: 1, mappingReferences: 2,
      mappedEntries: 3, mappedPathBytes: 12, mappingsVerified: fullCoverage ? 2 : 0, inspectedCopyManifestSha256: fullCoverage ? p.contract.copyManifestSha256 : null },
    sourceMaps: { sourceMapPolicy: r.scanner.SOURCE_MAP_POLICY_V2, sourceMapReferences: 1, sourceMapContexts: 2,
      missingLocalMapReferences: 1, missingLocalMapContexts: 1,
      sourceMapAvailability: fullCoverage ? 'absent_local_targets' : 'unqualified', limitations: [...r.scanner.SOURCE_MAP_LIMITATIONS] },
  } };
}

/** Allocate only a confined synthetic registry and mock every Docker effect and output. */
function harness(t, options = {}) {
  const parent = path.dirname(__dirname), registry = fs.mkdtempSync(path.join(parent, 'fixture-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(registry)), parent); assert.ok(path.basename(registry).startsWith('fixture-')); fs.rmSync(registry, { recursive: true }); });
  const prepared = preparationFixture(), id = 'd'.repeat(64), calls = []; let active = false;
  const dependencies = { registry, prepare: () => prepared, readiness: async () => { if (options.readiness) throw Error(PRIVATE); },
    docker: async (args, limits) => {
      assert.deepEqual(args.slice(0, 2), ['--context', 'desktop-linux']); assert.ok(limits.timeoutMs > 0 && limits.timeoutMs <= r.LIMITS.operationMs);
      const a = args.slice(2); calls.push(a);
      assert.equal(JSON.parse(fs.readFileSync(path.join(registry, r.KEY + '.reservation.json'))).consumed, true);
      if (a[0] === 'create') { if (options.create) throw Error(PRIVATE); active = true; return Buffer.from(options.invalidId ? PRIVATE : id); }
      if (a[0] === 'inspect' && a[2] === '{{json .Mounts}}') return Buffer.from(JSON.stringify([
        { Destination: '/copy', Name: r.copy.VOLUME, Type: 'volume', RW: !!options.writable },
        { Destination: '/evidence', Name: r.q.VOLUME, Type: 'volume', RW: !!options.originalWritable },
        ...(options.extraMount ? [{ Destination: '/extra', Name: 'extra', Type: 'volume', RW: false }] : []),
      ]));
      if (a[0] === 'ps' && a.some(s => s.startsWith('volume='))) return Buffer.from(options.attached ? 'e'.repeat(64) : id);
      if (a[0] === 'start') {
        assert.ok(limits.input.length <= r.LIMITS.inputBytes); assert.equal(limits.outputBytes, r.LIMITS.reportBytes);
        const value = report(prepared, options.failure);
        if (options.bootstrapFailure) { value.scan = null; value.bootstrapFailure = options.bootstrapFailure; }
        const bytes = Buffer.from(options.invalidOutput ? PRIVATE : JSON.stringify(value));
        if (options.failure || options.process || options.bootstrapFailure) { const error = Error(PRIVATE); try { error.report = limits.parseFailureReport(bytes); } catch { /* Discard malformed output. */ } throw error; }
        return bytes;
      }
      if (a[0] === 'inspect') { if (options.cleanup) throw Error(PRIVATE); return Buffer.from(JSON.stringify({ Running: !!options.running && active, ExitCode: options.exit || (options.bootstrapFailure ? 1 : 0), OOMKilled: !!options.oom, Error: '' })); }
      if (a[0] === 'kill') { active = false; return Buffer.from(id); }
      if (a[0] === 'rm') { active = false; return Buffer.from(id); }
      if (a[0] === 'ps') return Buffer.from(options.removalUnconfirmed ? id : '');
      throw Error('unexpected');
    } };
  return { prepared, registry, dependencies, calls };
}

/** Evaluate the unchanged scanner with Linux path rules and a read-only whitelist of public code bytes.
 * Approval checks run the real schema and hash logic; artifact reads and all writes are unavailable.
 */
function linuxApprovalScanner(contract) {
  const base = '/synthetic-public-scanner/scripts', scannerModule = { exports: {} };
  const inputs = new Map(contract.files.map((name, index) => [path.posix.resolve(base, name),
    fs.readFileSync(path.resolve(index === 0 ? r.CHECKOUT : r.COMPANION_CHECKOUT, 'scripts', name))]));
  /** Restrict the scanner filesystem to the approval-bound implementation and companion files. */
  function publicRequire(name) {
    if (name === 'node:path') return path.posix;
    if (name === 'node:fs') return {
      /** Serve a public whitelisted implementation file; reject every artifact or writable filesystem API. */
      readFileSync(file) { assert.ok(inputs.has(file)); return inputs.get(file); },
    };
    return require(name);
  }
  vm.runInNewContext(inputs.get(base + '/gate1-build-artifact-privacy.js').toString(),
    { require: publicRequire, module: scannerModule, exports: scannerModule.exports, __dirname: base, process: { platform: 'linux' }, Buffer }, { timeout: 2000 });
  return scannerModule.exports;
}

/** Run the serialized bootstrap against in-memory comparisons and injected failures, capturing only test output.
 * The real scanner approval check runs; no Docker process or artifact filesystem is available.
 */
async function bootstrapFixture(prepared, failure) {
  const contract = { ...prepared.contract, approval: prepared.approval }, real = linuxApprovalScanner(contract);
  const state = { comparisonReads: 0, scannerCalls: 0, stdout: '', stderr: '', exitCode: 0, comparisonBuffer: null };
  const comparisons = [{ label: 'synthetic_sentinel', value: PRIVATE }];
  const fakeQ = {
    /** Return only synthetic comparison bytes and count reads before any stage failure. */
    publicFile() { if (failure === 'comparison_read') throw Error(PRIVATE); state.comparisonReads++;
      state.comparisonBuffer = Buffer.from(JSON.stringify(comparisons)); return state.comparisonBuffer; },
    /** Exercise both successful parsing and zeroing after parser exceptions. */
    strictJson(bytes) { if (failure === 'comparison_parse') throw Error(PRIVATE); return JSON.parse(bytes.toString()); },
  };
  const processStub = { stdout: {
    /** Capture only synthetic stdout for privacy and schema assertions. */
    write(text) { state.stdout += text; },
  }, stderr: {
    /** Capture synthetic stderr to assert that private exceptions never escape. */
    write(text) { state.stderr += text; },
  },
  /** Record child status without changing the host test runner's exit code. */
  set exitCode(value) { state.exitCode = value; } };
  const run = vm.runInNewContext('(' + r.scanMain.toString() + ')', { Buffer, process: processStub,
    /** Expose only the synthetic comparison reader expected by the serialized bootstrap. */
    require(name) { assert.equal(name, '/tmp/gate1-mapping-scan/scripts/gate1-build-qualification'); return fakeQ; } }, { timeout: 2000 });
  const scanner = { approvalId: failure === 'scanner_approval' ? () => '0'.repeat(64) : real.approvalId,
    representations: real.representations,
    /** Count execution and throw a private synthetic error only at the selected seam. */
    async runInspection() { state.scannerCalls++; if (failure === 'scanner_execution') throw Error(PRIVATE); return {}; } };
  /** Validate the stage boundary without writing scanner code or accessing image files. */
  const stage = () => { if (failure === 'scanner_stage') throw Error(PRIVATE); return scanner; };
  /** Supply a bounded synthetic summary or deliberately inject private/oversized projected output. */
  const schemas = () => ({ project() {
    if (failure === 'report_validation') throw Error(PRIVATE);
    const value = report(prepared).scan;
    if (failure === 'report_privacy') value.private = PRIVATE;
    if (failure === 'report_oversize') value.padding = 'x'.repeat(r.LIMITS.reportBytes);
    return value;
  } });
  await run(contract, '', () => ({ operation: () => report(prepared).verification }), stage, schemas, () => {});
  return { ...state, value: JSON.parse(state.stdout) };
}

/** Exercise real Linux links and the actual scanner/bootstrap using synthetic data in isolated tmpfs. */
async function linuxFixtures(scanner, library, scanMain, stage, schemas, baseSchemas, source, baseContract, oldContract) {
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = '/tmp/gate1-map-fixtures'; fs.mkdirSync(root, { mode: 0o700 });
  const outcomes = [], privateValue = 'synthetic-private-DO-NOT-RETAIN';
  /** Write only a case's synthetic bytes and create their ordinary parents. */
  function put(f, name, bytes) { const p = path.join(f.output, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p; }
  /** Start every case with a canonical output, one function and an ordinary shared package. */
  function fixture() {
    const base = fs.mkdtempSync(root + '/case-'), output = base + '/.vercel/output'; fs.mkdirSync(output, { recursive: true });
    const f = { base, output };
    put(f, 'config.json', '{"version":3}'); put(f, 'shared/pkg/app.js', 'safe'); put(f, 'functions/a.func/index.js', 'safe');
    fs.symlinkSync('pkg', output + '/shared/alias', 'dir');
    put(f, 'functions/a.func/.vc-config.json', JSON.stringify({ filePathMap: { vendor: '.vercel/output/shared/alias' } }));
    return f;
  }
  /** Opt in to the exact new mapping policy with synthetic comparisons only. */
  function profile(f) { return { ...baseContract.profile, outputRoot: f.output, comparisonLabels: ['synthetic_sentinel'] }; }
  /** Run the real scanner with memory-only receipts; never consume a retained-output reservation. */
  async function scan(f, options = {}) {
    const p = profile(f), value = await scanner.runInspection({ profile: p, approval: scanner.approvalId(p), inspectionApproved: true,
      comparisons: [{ label: 'synthetic_sentinel', value: privateValue }] }, { storeFactory: () => ({ save() {} }), ...options });
    assert.ok(!JSON.stringify(value).includes(privateValue)); return value;
  }
  /** Retain fixed fixture names and booleans; do not retain exceptions or synthetic content. */
  async function check(name, action) {
    const f = fixture(); let passed = false;
    try { await action(f); passed = true; } catch { /* Finite fixture failure only. */ }
    finally { assert.equal(path.dirname(f.base), root); assert.ok(path.basename(f.base).startsWith('case-')); fs.rmSync(f.base, { recursive: true }); }
    outcomes.push({ name, passed });
  }
  await check('exact prepared approval matches Linux without replacement', async () => {
    assert.equal(scanner.approvalId(baseContract.profile), baseContract.scannerApproval);
  });
  await check('consumed v3 prepared approval rejects revised scanner', async () => {
    assert.notEqual(scanner.approvalId(oldContract.profile), oldContract.scannerApproval);
  });
  await check('reordered profile preserves normalized approval', async () => {
    const reordered = Object.fromEntries(Object.entries(baseContract.profile).reverse());
    assert.equal(scanner.approvalId(reordered), baseContract.scannerApproval);
  });
  await check('changed policy still changes scanner approval', async () => {
    assert.notEqual(scanner.approvalId({ ...baseContract.profile, filePathMapPolicy: 'reject' }), baseContract.scannerApproval);
    assert.notEqual(scanner.approvalId({ ...baseContract.profile, sourceMapPolicy: 'reject' }), baseContract.scannerApproval);
  });
  await check('directory alias maps and descendants complete', async f => { const v = await scan(f); assert.equal(v.result, 'completed'); assert.equal(v.mappingsVerified, 1); assert.equal(v.aliasesVerified, 1); });
  await check('copy manifest equals scanned-byte manifest', async f => {
    const v = await scan(f), verified = library().operation(null, f.output, '1'.repeat(64), v.inspectedCopyManifestSha256);
    assert.equal(verified.result, 'completed'); assert.equal(verified.manifestSha256, v.inspectedCopyManifestSha256);
  });
  await check('nested logical aliases and shared descendants', async f => {
    fs.mkdirSync(f.output + '/shared/branch'); fs.symlinkSync('../pkg', f.output + '/shared/branch/nested', 'dir');
    put(f, 'functions/a.func/.vc-config.json', JSON.stringify({ filePathMap: { vendor: '.vercel/output/shared/branch', other: '.vercel/output/shared/alias' } }));
    assert.equal((await scan(f)).result, 'completed');
  });
  await check('empty ordinary directory and alias', async f => {
    fs.mkdirSync(f.output + '/empty'); fs.symlinkSync('empty', f.output + '/empty-alias', 'dir');
    put(f, 'functions/a.func/.vc-config.json', JSON.stringify({ filePathMap: { empty: '.vercel/output/empty-alias' } }));
    assert.equal((await scan(f)).result, 'completed');
  });
  for (const target of ['../outside', '/outside', 'missing', 'shared/alias/../pkg']) await check('reject target ' + target, async f => {
    put(f, 'functions/a.func/.vc-config.json', JSON.stringify({ filePathMap: { vendor: '.vercel/output/' + target } }));
    assert.equal((await scan(f)).result, 'stopped');
  });
  await check('directory alias cycle stops', async f => { fs.symlinkSync('../..', f.output + '/shared/pkg/cycle', 'dir'); assert.equal((await scan(f)).failure, 'alias_cycle'); });
  await check('escaping alias stops without outside contents', async f => {
    fs.symlinkSync('../../../outside', f.output + '/shared/escape', 'dir'); assert.equal((await scan(f)).failure, 'alias_target');
  });
  await check('external hard link remains rejected', async f => {
    fs.linkSync(f.output + '/shared/pkg/app.js', f.base + '/external.js'); assert.equal((await scan(f)).failure, 'link');
  });
  await check('ancestor symlink remains rejected', async f => {
    fs.symlinkSync('.vercel', f.base + '/linked', 'dir'); const output = f.output; f.output = f.base + '/linked/.vercel/output';
    assert.equal((await scan(f)).failure, 'link'); f.output = output;
  });
  await check('FIFO type stops without reading it', async f => {
    const child = require('node:child_process').spawnSync('/usr/bin/mkfifo', [f.output + '/shared/pkg/pipe']); assert.equal(child.status, 0);
    assert.equal((await scan(f)).failure, 'file_type');
  });
  await check('mapped secret contents remain findings', async f => { put(f, 'shared/pkg/app.js', privateValue); assert.equal((await scan(f)).failure, 'findings'); });
  await check('composed mapped logical name remains private', async f => {
    const target = 'private-DO-NOT-RETAIN'; put(f, 'shared/pkg/' + target, 'safe');
    put(f, 'functions/a.func/.vc-config.json', JSON.stringify({ filePathMap: { synthetic: '.vercel/output/shared/pkg' } }));
    const p = profile(f), value = await scanner.runInspection({ profile: p, approval: scanner.approvalId(p), inspectionApproved: true,
      comparisons: [{ label: 'synthetic_sentinel', value: 'synthetic/private-DO-NOT-RETAIN' }] }, { storeFactory: () => ({ save() {} }) });
    assert.equal(value.failure, 'findings'); assert.ok(!JSON.stringify(value).includes(target));
  });
  await check('missing projected map is explicitly counted', async f => {
    put(f, 'shared/pkg/app.js', '//# sourceMappingURL=app.js.map'); put(f, 'shared/pkg/app.js.map', '{"version":3,"sources":[],"mappings":""}');
    put(f, 'functions/a.func/.vc-config.json', JSON.stringify({ filePathMap: { 'app.js': '.vercel/output/shared/pkg/app.js' } }));
    const v = await scan(f); assert.equal(v.result, 'completed'); assert.equal(v.missingLocalMapContexts, 1); assert.equal(v.sourceMapAvailability, 'absent_local_targets');
  });
  await check('mapped source map descendants have complete coverage', async f => {
    put(f, 'shared/pkg/app.js', '//# sourceMappingURL=app.js.map'); put(f, 'shared/pkg/app.js.map', '{"version":3,"sources":[],"mappings":""}');
    assert.equal((await scan(f)).result, 'completed');
  });
  await check('missing mapped descendant after inventory stops', async f => {
    const original = fs.promises.open; let changed = false;
    try { fs.promises.open = async (...args) => { if (!changed && args[0].endsWith('.vc-config.json')) { changed = true; fs.unlinkSync(f.output + '/shared/pkg/app.js'); } return original(...args); };
      assert.equal((await scan(f)).result, 'stopped');
    } finally { fs.promises.open = original; }
  });
  await check('alias mutation after inventory stops', async f => {
    const original = fs.promises.open; let changed = false;
    try { fs.promises.open = async (...args) => { if (!changed) { changed = true; fs.unlinkSync(f.output + '/shared/alias'); fs.symlinkSync('branch', f.output + '/shared/alias', 'dir'); } return original(...args); };
      assert.equal((await scan(f)).result, 'stopped');
    } finally { fs.promises.open = original; }
  });
  for (const limits of [{ mappingReferences: 0 }, { mappedEntries: 1 }, { mappingPathBytes: 1 }, { totalBytes: 1 }, { maxDepth: 1 }]) await check('bounded mapping ' + Object.keys(limits)[0], async f => { assert.equal((await scan(f, { limits })).result, 'stopped'); });
  await check('actual serialized bootstrap verifies and scans synthetic output', async f => {
    const expected = await scan(f), p = profile(f), comparisonSource = f.base + '/comparisons.json';
    fs.writeFileSync(comparisonSource, JSON.stringify([{ label: 'synthetic_sentinel', value: privateValue }]));
    // Hash the prepared schema-ordered profile as the host does; do not replace it with a runtime approval.
    const scannerApproval = require('node:crypto').createHash('sha256').update(JSON.stringify({ profile: p,
      limits: baseContract.scannerLimits, integrity: baseContract.integrity })).digest('hex');
    const contract = { ...baseContract, profile: p, comparisonSource, copyManifestSha256: expected.inspectedCopyManifestSha256, scannerApproval };
    const original = process.stdout.write; let output = '';
    try { process.stdout.write = text => { output += text; return true; }; await scanMain(contract, source, library, stage, schemas, baseSchemas); }
    finally { process.stdout.write = original; }
    const result = JSON.parse(output); assert.equal(result.scan.summary.scannerResult, 'completed');
    assert.equal(result.scan.mapping.inspectedCopyManifestSha256, expected.inspectedCopyManifestSha256); assert.ok(!output.includes(privateValue));
  });
  await check('postverification content changes fail scan manifest binding', async f => {
    const expected = await scan(f); put(f, 'shared/pkg/app.js', 'changed content'); const actual = await scan(f);
    const contract = { ...baseContract, profile: profile(f), copyManifestSha256: expected.inspectedCopyManifestSha256 };
    // Bind fixture attribution so the only mismatch is the aggregate of the exact scanned bytes.
    contract.scannerApproval = actual.approvalId; actual.mode = 'inspect';
    assert.throws(() => schemas(contract, baseSchemas).project(actual));
  });
  await check('absent physical alias and projected maps all counted', async f => {
    put(f, 'shared/pkg/app.js', '//# sourceMappingURL=absent');
    const v = await scan(f);
    assert.equal(v.result, 'completed'); assert.equal(v.missingLocalMapReferences, 1);
    assert.equal(v.sourceMapContexts, 3); assert.equal(v.missingLocalMapContexts, 3);
    assert.equal(v.sourceMapAvailability, 'absent_local_targets');
    assert.ok(v.limitations.includes('absent_local_source_maps_not_inspected'));
    const contract = { ...baseContract, profile: profile(f), scannerApproval: v.approvalId,
      copyManifestSha256: v.inspectedCopyManifestSha256 }; v.mode = 'inspect';
    assert.equal(schemas(contract, baseSchemas).project(v).sourceMaps.missingLocalMapContexts, 3);
  });
  await check('default strict policy still stops on missing maps', async f => {
    put(f, 'shared/pkg/app.js', '//# sourceMappingURL=absent');
    const p = { ...profile(f), sourceMapPolicy: 'reject' };
    const v = await scanner.runInspection({ profile: p, approval: scanner.approvalId(p), inspectionApproved: true,
      comparisons: [{ label: 'synthetic_sentinel', value: privateValue }] }, { storeFactory: () => ({ save() {} }) });
    assert.equal(v.failure, 'external_map'); assert.equal(v.sourceMapPolicy, undefined);
  });
  for (const kind of ['physical', 'alias', 'projected', 'implicit', 'file_parent']) await check('non-file map target ' + kind, async f => {
    if (kind === 'physical') { fs.mkdirSync(f.output + '/shared/pkg/occupied'); put(f, 'shared/pkg/app.js', '//# sourceMappingURL=occupied'); }
    if (kind === 'alias') { fs.mkdirSync(f.output + '/shared/empty'); fs.symlinkSync('../empty', f.output + '/shared/pkg/occupied', 'dir'); put(f, 'shared/pkg/app.js', '//# sourceMappingURL=occupied'); }
    if (kind === 'projected') { fs.mkdirSync(f.output + '/shared/empty'); put(f, 'functions/a.func/.vc-config.json', JSON.stringify({ filePathMap: { 'occupied': '.vercel/output/shared/empty' } })); put(f, 'functions/a.func/index.js', '//# sourceMappingURL=occupied'); }
    if (kind === 'implicit') { put(f, 'functions/a.func/.vc-config.json', JSON.stringify({ filePathMap: { 'occupied/child.js': '.vercel/output/shared/pkg/app.js' } })); put(f, 'functions/a.func/index.js', '//# sourceMappingURL=occupied'); }
    if (kind === 'file_parent') put(f, 'shared/pkg/app.js', '//# sourceMappingURL=app.js/absent');
    assert.equal((await scan(f)).failure, 'external_map');
  });
  for (const ref of ['https://outside.invalid/a.map', '//outside.invalid/a.map', '../../../../outside.map',
    '%2e%2e/%2e%2e/%2e%2e/%2e%2e/outside.map', 'bad%GG.map', 'bad%00.map',
    'bad%5cname.map', 'missing.map?query', 'missing.map#fragment']) await check('unsafe map reference ' + ref, async f => {
    put(f, 'shared/pkg/app.js', '//# sourceMappingURL=' + ref); assert.equal((await scan(f)).failure, 'external_map');
  });
  await check('later projected directory still stops after physical absence', async f => {
    put(f, 'shared/pkg/app.js', '//# sourceMappingURL=absent');
    fs.mkdirSync(f.output + '/functions/a.func/vendor', { recursive: true });
    fs.mkdirSync(f.output + '/functions/a.func/vendor/absent');
    // Avoid a mapping conflict by projecting only the referencing file into the existing directory.
    put(f, 'functions/a.func/.vc-config.json', JSON.stringify({ filePathMap: { 'vendor/app.js': '.vercel/output/shared/pkg/app.js' } }));
    const v = await scan(f); assert.equal(v.failure, 'external_map'); assert.ok(v.missingLocalMapContexts > 0);
    assert.equal(v.sourceMapAvailability, 'unqualified');
  });
  for (const kind of ['raw', 'inline', 'emitted_map', 'malformed', 'indexed_url', 'resolved_reference']) await check('missing map retains ' + kind + ' checks', async f => {
    put(f, 'shared/pkg/app.js', '//# sourceMappingURL=absent');
    const map = { version: 3, sources: ['synthetic.js'], mappings: '', sourcesContent: [privateValue] };
    let expected = 'findings';
    if (kind === 'raw') put(f, 'shared/other.txt', privateValue);
    if (kind === 'inline') put(f, 'shared/other.js', '//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64'));
    if (kind === 'emitted_map') put(f, 'shared/unreferenced.map', JSON.stringify(map));
    if (kind === 'malformed') { put(f, 'shared/unreferenced.map', '{'); expected = 'json'; }
    if (kind === 'indexed_url') { put(f, 'shared/unreferenced.map', '{"version":3,"sections":[{"url":"absent"}]}'); expected = 'external_map'; }
    if (kind === 'resolved_reference') put(f, 'shared/pkg/app.js', '//# sourceMappingURL=' + [...privateValue].map(c => '%' + c.charCodeAt(0).toString(16)).join('') + '.map');
    assert.equal((await scan(f)).failure, expected);
  });
  await check('creating absent target during scanning invalidates inventory', async f => {
    put(f, 'shared/pkg/app.js', '//# sourceMappingURL=absent');
    const original = fs.promises.open; let changed = false;
    try { fs.promises.open = async (...args) => { if (!changed && args[0].endsWith('/app.js')) { changed = true; put(f, 'shared/pkg/absent', '{"version":3,"sources":[],"mappings":""}'); } return original(...args); };
      const v = await scan(f); assert.equal(v.failure, 'changed'); assert.equal(v.sourceMapAvailability, 'unqualified');
    } finally { fs.promises.open = original; }
  });
  for (const ref of ['missing.map', 'missing.js', 'missing', 'missing%2Ecss', '/maps/missing']) {
    await check('V2 verifies absence across real alias and projected contexts ' + ref, async f => {
      put(f, 'shared/pkg/app.js', '//# sourceMappingURL=' + ref);
      const v = await scan(f); assert.equal(v.result, 'completed');
      assert.equal(v.sourceMapContexts, 3); assert.equal(v.missingLocalMapContexts, 3);
      assert.equal(v.sourceMapPolicy, 'emitted_inventory_v2');
      assert.ok(v.limitations.includes('absent_local_source_maps_not_inspected'));
    });
  }
  for (const ref of ['present.js', 'present']) await check('V2 rejects existing non-map target ' + ref, async f => {
    put(f, 'shared/pkg/' + ref, 'safe'); put(f, 'shared/pkg/app.js', '//# sourceMappingURL=' + ref);
    assert.equal((await scan(f)).failure, 'external_map');
  });
  await check('V1 continues rejecting absent non-map targets', async f => {
    put(f, 'shared/pkg/app.js', '//# sourceMappingURL=missing.js');
    const p = { ...profile(f), sourceMapPolicy: scanner.SOURCE_MAP_POLICY };
    const v = await scanner.runInspection({ profile: p, approval: scanner.approvalId(p), inspectionApproved: true,
      comparisons: [{ label: 'synthetic_sentinel', value: privateValue }] }, { storeFactory: () => ({ save() {} }) });
    assert.equal(v.failure, 'external_map'); assert.equal(v.sourceMapPolicy, 'emitted_inventory_v1');
  });
  await check('later projected file target stops after physical absence', async f => {
    put(f, 'shared/pkg/app.js', '//# sourceMappingURL=../target');
    // Physical and alias siblings resolve identically here; the projected context resolves separately.
    put(f, 'functions/a.func/target', 'safe');
    const v = await scan(f); assert.equal(v.failure, 'external_map');
    assert.ok(v.missingLocalMapContexts > 0); assert.equal(v.sourceMapAvailability, 'unqualified');
  });
  await check('V2 resolved names consume the exact existing scanner budget', async f => {
    put(f, 'shared/pkg/app.js', '//# sourceMappingURL=missing');
    const v = await scan(f); assert.equal(v.result, 'completed');
    assert.equal((await scan(f, { limits: { totalBytes: v.bytesInspected } })).result, 'completed');
    assert.equal((await scan(f, { limits: { totalBytes: v.bytesInspected - 1 } })).failure, 'total_bytes');
  });
  for (const ref of ['../..', '/..', '../../unused/..']) await check('output root cannot masquerade as absent ' + ref, async f => {
    put(f, 'shared/pkg/app.js', '//# sourceMappingURL=' + ref);
    assert.equal((await scan(f)).failure, 'external_map');
  });
  return { schemaVersion: 1, outcomes, passed: outcomes.filter(v => v.passed).length, failed: outcomes.filter(v => !v.passed).length,
    nodeVersion: process.versions.node, retainedVolumeMounted: false, retainedOutputReads: 0 };
}

/** Exercise actual capacity ceilings with synthetic files, seven maximum-length comparisons and finite metrics.
 * Each group owns only its tmpfs fixtures; full scans must meet the approved 90-second/1-GiB acceptance margin.
 */
async function capacityFixtures(scanner, contract, kind) {
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = '/tmp/gate1-capacity-fixtures'; fs.mkdirSync(root, { mode: 0o700 });
  const outcomes = [];
  const comparisons = scanner.LABELS.map((label, i) => ({ label, value: String.fromCharCode(65 + i).repeat(4096) }));
  for (const delta of [-1, 0, 1]) {
    const started = performance.now(), base = fs.mkdtempSync(root + '/case-'), output = base + '/.vercel/output';
    let passed = false, report;
    /** Write exclusively within this synthetic output; ordinary files never contain private inputs. */
    function put(name, bytes) { const file = path.join(output, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
    try {
      put('config.json', '{"version":3}');
      const inline = Buffer.from('{"version":3,"sources":[],"mappings":""}').toString('base64');
      put('shared/pkg/app.js', 'safe;\n//# sourceMappingURL=data:application/json;base64,' + inline);
      fs.symlinkSync('pkg', output + '/shared/alias', 'dir');
      for (const file of ['a.js', 'b.js', 'c.js']) put('shared/expand/' + file, 'safe');
      const specialChildren = kind === 'expansion' ? 3 + delta : 1;
      for (let i = 0; i < specialChildren; i++) put('shared/special/' +
        (kind === 'paths' ? (delta < 0 ? 'ap.js' : delta > 0 ? 'appx.js' : 'app.js') : i + '.js'), 'safe');
      const references = kind === 'references' ? 100000 + delta : kind === 'expansion' ? 50000 : 100000;
      for (let start = 0; start < references; start += 2500) {
        const parent = 'functions/f' + String(start / 2500).padStart(3, '0') + '.func', mapping = {};
        for (let i = start; i < Math.min(start + 2500, references); i++) {
          let key = 'p' + String(i).padStart(6, '0') + (kind === 'references' ? '.js' : '');
          let target = kind === 'references' ? 'shared/pkg/app.js' : kind === 'expansion' ? 'shared/expand' : 'shared/alias';
          if (kind === 'paths') {
            // Two destinations per reference: 2*parentLength+7. These lengths sum to exactly 64 MiB.
            const length = 332 + (i < 4432 ? 1 : 0);
            key = 'x'.repeat(160) + '/' + 'y'.repeat(length - parent.length - 1 - 161 - key.length) + key;
          }
          if (i === references - 1 && delta !== 0 && kind !== 'references') target = 'shared/special';
          mapping[key] = '.vercel/output/' + target;
        }
        put(parent + '/.vc-config.json', JSON.stringify({ filePathMap: mapping }));
      }
      const profile = { ...contract.profile, outputRoot: output, comparisonLabels: scanner.LABELS };
      report = await scanner.runInspection({ profile, approval: scanner.approvalId(profile), inspectionApproved: true, comparisons },
        { storeFactory: () => ({ save() {} }) });
      assert.equal(report.result, delta > 0 ? 'stopped' : 'completed');
      if (delta > 0) {
        assert.equal(report.failure, kind === 'paths' ? 'total_bytes' : 'entry_limit');
        assert.equal(report.mappingsVerified, 0); assert.equal(report.inspectedCopyManifestSha256, null);
      } else {
        assert.equal(report.mappingReferences, references); assert.equal(report.mappingsVerified, references);
        if (kind === 'expansion') assert.equal(report.mappedEntries, 200000 + delta);
        if (kind === 'paths') { assert.equal(report.mappedEntries, 200000); assert.equal(report.mappedPathBytes, 67108864 + delta); }
        assert.ok(report.inspectedCopyManifestSha256); assert.equal(report.inlineMaps, 1);
      }
      assert.ok(report.mappedPathBytes <= report.decodedBytes);
      assert.ok(!comparisons.some(ref => scanner.representations(ref.value).some(value => JSON.stringify(report).includes(value))));
      assert.ok(performance.now() - started <= 90000); assert.ok(process.resourceUsage().maxRSS <= 1048576);
      passed = true;
    } catch { /* Retain only the fixed case and counters, never exceptions, paths or fixture contents. */ }
    finally { assert.equal(path.dirname(base), root); assert.ok(path.basename(base).startsWith('case-')); fs.rmSync(base, { recursive: true }); }
    outcomes.push({ name: kind + (delta < 0 ? '_below' : delta > 0 ? '_above' : '_exact'), passed,
      elapsedMs: Math.ceil(performance.now() - started), peakRssKiB: process.resourceUsage().maxRSS,
      mappingReferences: report?.mappingReferences || 0, mappedEntries: report?.mappedEntries || 0, mappedPathBytes: report?.mappedPathBytes || 0,
      scannerFailure: report?.failure || null });
    if (!passed) break;
  }
  return { schemaVersion: 1, outcomes, passed: outcomes.filter(v => v.passed).length, failed: outcomes.filter(v => !v.passed).length,
    nodeVersion: process.versions.node, retainedVolumeMounted: false, retainedOutputReads: 0 };
}

/** Use the pinned image with only public Zod mounted read-only; all artifacts and comparisons are synthetic. */
async function runLinux(kind) {
  const p = preparationFixture(), source = r.q.publicFile(path.join(r.CHECKOUT, 'scripts/gate1-build-artifact-privacy.js')).toString();
  const contract = { ...p.contract, approval: p.approval };
  const fixtures = kind ? `(${capacityFixtures.toString()})(scanner,contract,${JSON.stringify(kind)})` :
    `(${linuxFixtures.toString()})(scanner,${r.copy.copyLibrary.toString()},${r.scanMain.toString()},stageScanner,` +
    `${r.reportSchemas.toString()},${r.copy.scanAdapter.reportSchemas.toString()},source,contract,` +
    `${JSON.stringify({ profile: previousPrepared().contract.profile, scannerApproval: previousPrepared().contract.scannerApproval })})`;
  const code = `const contract=${JSON.stringify(contract)},source=${JSON.stringify(source)},stageScanner=(${r.copy.stageScanner.toString()});` +
    `let stage='scanner_stage';Promise.resolve().then(async()=>{const scanner=stageScanner(contract,source,'/tmp/gate1-map-fixture-scanner');stage='fixtures';return ` + fixtures +
    `;}).then(v=>{process.stdout.write(JSON.stringify(v)+'\\n');if(v.failed)process.exitCode=1;}).catch(e=>{process.stdout.write(JSON.stringify({schemaVersion:1,bootstrapFailure:stage,category:['implementation','approval','MODULE_NOT_FOUND'].includes(e.code||e.message)?(e.code||e.message):'fixture_setup'})+'\\n');process.exitCode=1;});`;
  assert.ok(Buffer.byteLength(code) <= 262144, 'fixture_code_limit');
  const input = Buffer.from(`eval(require('node:zlib').inflateSync(Buffer.from(${JSON.stringify(r.copy.packed(code))},'base64'),{maxOutputLength:262144}).toString());`);
  assert.ok(input.length <= 65536, 'fixture_input_limit');
  const run = r.d.budgetRunner((a, o) => r.q.supervise('docker', a, o), 180000), name = 'gate1-absent-local-target-synthetic-v2' + (kind ? '-' + kind : ''); let id;
  try {
    assert.equal((await run(['ps', '-aq', '--filter', `name=^/${name}$`])).toString().trim(), '');
    id = (await run(['create', '--name', name, '--pull=never', '--platform=linux/amd64', '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--restart=no', '--log-driver=none', '--cpus=2', '--memory=2147483648',
      '--memory-swap=2147483648', '--pids-limit=32', '--ulimit=core=0:0', '--ulimit=nofile=256:256',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=134217728,mode=1777',
      '--mount', `type=bind,src=${path.join(r.ROOT, 'node_modules/zod')},dst=/deps/zod,readonly`,
      '--entrypoint', '/usr/bin/timeout', '-i', p.contract.imageId, '--signal=KILL', '160s', '/usr/bin/env', '-i', 'NODE_PATH=/deps',
      '/opt/node-v22.23.3-linux-x64/bin/node', '--max-old-space-size=1536', '-'], { outputBytes: 128 })).toString().trim();
    assert.match(id, /^[a-f0-9]{64}$/);
    /** Accept only finite fixture outcomes and fixed runtime fields, never exception messages. */
    const parse = bytes => {
      const v = r.prior.lib.parse(bytes, 16384); assert.equal(v.schemaVersion, 1);
      if (['scanner_stage', 'fixtures'].includes(v.bootstrapFailure) && ['implementation', 'approval', 'MODULE_NOT_FOUND', 'fixture_setup'].includes(v.category)) return v;
      assert.ok(Array.isArray(v.outcomes) && v.outcomes.length <= 100);
      assert.ok(v.outcomes.every(item => typeof item.name === 'string' && item.name.length < 110 && typeof item.passed === 'boolean'));
      assert.equal(v.passed, v.outcomes.filter(item => item.passed).length); assert.equal(v.failed, v.outcomes.filter(item => !item.passed).length);
      assert.equal(v.retainedVolumeMounted, false); assert.equal(v.retainedOutputReads, 0); return v;
    };
    let result;
    try { result = parse(await run(['start', '-ai', id], { input, outputBytes: 16384, parseFailureReport: parse })); }
    catch (error) { if (!error.report) throw error; result = error.report; }
    const state = await r.d.teardown(run, id); id = undefined;
    Object.assign(result, { containerRemoved: true, exitCode: state.exitCode, oomKilled: state.oomKilled });
    process.stdout.write(JSON.stringify(result) + '\n'); if (result.failed || result.bootstrapFailure || !state.clean) process.exitCode = 1;
  } finally { if (id && /^[a-f0-9]{64}$/.test(id)) await r.d.teardown(r.d.budgetRunner((a, o) => r.q.supervise('docker', a, o), 20000), id); }
}

if (process.argv.includes('--linux-fixtures') || process.argv.some(arg => /^--linux-capacity-(references|expansion|paths)$/.test(arg))) {
  const capacity = process.argv.find(arg => arg.startsWith('--linux-capacity-'))?.slice('--linux-capacity-'.length);
  runLinux(capacity).catch(error => {
    const category = error.code === 'ERR_ASSERTION' ? (['fixture_code_limit', 'fixture_input_limit'].includes(error.message) ? error.message : 'fixture_assertion') :
      ['input', 'provenance', 'companions', 'scanner', 'process', 'unreadable'].includes(error.message) ? error.message : 'fixture_supervision';
    process.stderr.write(JSON.stringify({ category, assertion: error.code === 'ERR_ASSERTION' ? error.operator : null }) + '\n'); process.exitCode = 1;
  });
}
else {
  test('prepared profile and approval match real Linux schema order without runtime replacement', () => {
    const p = preparationFixture(), scanner = linuxApprovalScanner(p.contract);
    assert.equal(scanner.approvalId(p.contract.profile), p.contract.scannerApproval);
    assert.equal(p.contract.preservation.mappingV1ExecutionRecords, 6);
    assert.equal(p.contract.preservation.mappingV1ReviewRecords, 9);
    assert.notEqual(r.KEY, r.previous.KEY); assert.notEqual(r.CONTAINER, r.previous.CONTAINER);
    assert.notEqual(r.CONFIRMATION, r.previous.CONFIRMATION);
    assert.deepEqual(r.normalizeProfile(Object.fromEntries(Object.entries(p.contract.profile).reverse())), p.contract.profile);
    for (const profile of [{ ...p.contract.profile, filePathMapPolicy: 'reject' },
      { ...p.contract.profile, sourceMapPolicy: 'reject' },
      { ...p.contract.profile, runId: '0'.repeat(32) }]) assert.notEqual(scanner.approvalId(profile), p.contract.scannerApproval);
    assert.throws(() => r.normalizeProfile({ ...p.contract.profile, outputRoot: '/elsewhere/.vercel/output' }));
    assert.throws(() => r.normalizeProfile({ ...p.contract.profile, extra: PRIVATE }));
  });
  test('consumed V1 scan contract stops at approval before comparisons while V2 proceeds', async () => {
    const old = await bootstrapFixture(previousPrepared());
    assert.equal(old.value.bootstrapFailure, 'scanner_approval'); assert.equal(old.comparisonReads, 0); assert.equal(old.scannerCalls, 0);
    const p = preparationFixture(), current = await bootstrapFixture(p);
    assert.equal(current.value.bootstrapFailure, null); assert.equal(current.comparisonReads, 1); assert.equal(current.scannerCalls, 1);
    assert.equal(current.exitCode, 0); r.validateReport(Buffer.from(current.stdout), p);
  });
  for (const failure of r.BOOTSTRAP_FAILURES) test('bootstrap retains only finite stage ' + failure, async t => {
    const h = harness(t, { bootstrapFailure: failure }), captured = await bootstrapFixture(h.prepared, failure);
    assert.equal(captured.value.bootstrapFailure, failure); assert.equal(captured.value.scan, null); assert.equal(captured.exitCode, 1);
    assert.ok(!captured.stdout.includes(PRIVATE)); assert.equal(captured.stderr, '');
    if (captured.comparisonBuffer) assert.ok(captured.comparisonBuffer.every(byte => byte === 0));
    r.validateReport(Buffer.from(captured.stdout), h.prepared);
    const terminal = await r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies);
    assert.equal(terminal.result, 'stopped'); assert.equal(terminal.scan.bootstrapFailure, failure);
    assert.equal(terminal.exitCode, 1); assert.equal(terminal.artifactPrivacy, 'unqualified');
    assert.equal(terminal.lockReleased, true); assert.equal(h.calls.filter(args => args[0] === 'start').length, 1);
    await assert.rejects(r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies));
    assert.ok(!JSON.stringify(terminal).includes(PRIVATE));
  });
  test('oversized projected report is suppressed and inconsistent failure stages are rejected', async () => {
    const p = preparationFixture(), captured = await bootstrapFixture(p, 'report_oversize');
    assert.equal(captured.value.bootstrapFailure, 'report_privacy'); assert.ok(Buffer.byteLength(captured.stdout) < r.LIMITS.reportBytes);
    r.validateReport(Buffer.from(captured.stdout), p);
    const value = report(p); value.bootstrapFailure = 'scanner_stage';
    assert.throws(() => r.validateReport(Buffer.from(JSON.stringify(value)), p));
    value.scan = null; value.verification = r.copy.lib.base(p.approval, 'verify');
    assert.throws(() => r.validateReport(Buffer.from(JSON.stringify(value)), p));
    value.verification = report(p).verification; value.bootstrapFailure = 'bootstrap';
    assert.throws(() => r.validateReport(Buffer.from(JSON.stringify(value)), p));
  });
  test('preparation binds new scanner policy original comparisons and completed classification evidence', () => {
    const p = preparationFixture(); assert.equal(p.authorized, false); assert.equal(p.retainedOutputReads, 0); assert.equal(p.privateComparisonReads, 0);
    assert.notEqual(p.approval, r.OLD_APPROVAL); assert.equal(p.approval, r.hash(JSON.stringify(p.contract)));
    assert.equal(p.contract.profile.filePathMapPolicy, r.scanner.FILE_PATH_MAP_POLICY);
    assert.equal(p.contract.profile.sourceMapPolicy, r.scanner.SOURCE_MAP_POLICY_V2);
    assert.equal(p.contract.preservation.sourceMapDiagnosticExecutionRecords, 6);
    assert.equal(p.contract.preservation.classificationExecutionRecords, 6); assert.ok(r.containerInput(p).length <= r.LIMITS.inputBytes);
    assert.equal(p.contract.policy.originalArtifactTreeRead, false); assert.equal(p.contract.policy.originalSyntheticComparisonReadBytes, 65536);
  });
  test('real container mounts only original and copy read-only under bounded offline constraints', () => {
    const args = r.containerArgs(); assert.equal(args.filter(value => value === '--mount').length, 2);
    for (const value of [`type=volume,src=${r.copy.VOLUME},dst=/copy,readonly,volume-nocopy`,
      `type=volume,src=${r.q.VOLUME},dst=/evidence,readonly,volume-nocopy`, '--network=none', '--read-only', '--pull=never', '--log-driver=none', '--cpus=2', '--memory=2147483648', '150s']) assert.ok(args.includes(value));
  });
  test('successful attempt consumes one reservation and retains final lock state separately', async t => {
    const h = harness(t), v = await r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies);
    assert.equal(v.result, 'completed'); assert.equal(v.artifactPrivacy, 'no_matches_in_checked_representations'); assert.equal(v.lockReleased, true);
    assert.equal(h.calls.filter(a => a[0] === 'start').length, 1); assert.ok(!h.calls.some(a => a[0] === 'volume'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.registry, r.KEY + '.report.json'))).lockReleased, false);
    await assert.rejects(r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies));
  });
  for (const options of [{ readiness: true }, { writable: true }, { originalWritable: true }, { extraMount: true }, { attached: true },
    { failure: 'external_map' }, { failure: 'findings' }, { process: true }, { invalidOutput: true }, { exit: 17 }, { oom: true }, { running: true }]) {
    test(`failure stops without retry ${JSON.stringify(options)}`, async t => {
      const h = harness(t, options), v = await r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies);
      assert.equal(v.result, 'stopped'); assert.equal(v.artifactPrivacy, 'unqualified'); assert.ok(!JSON.stringify(v).includes(PRIVATE));
      if (options.failure) assert.equal(v.scan.scan.summary.scannerFailure, options.failure);
      await assert.rejects(r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies));
    });
  }
  for (const options of [{ create: true }, { invalidId: true }, { cleanup: true }, { removalUnconfirmed: true }]) test(`uncertain cleanup keeps lock ${JSON.stringify(options)}`, async t => {
    const h = harness(t, options), v = await r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies);
    assert.equal(v.teardownUnconfirmed, true); assert.equal(v.lockReleased, false); assert.ok(fs.existsSync(path.join(h.registry, 'active.lock')));
  });
  for (const kind of ['reservation', 'report']) test(`persistence failure ${kind} cannot qualify privacy`, async t => {
    const h = harness(t); h.dependencies.persist = (file, value) => { if (file.endsWith(`.${kind}.json`)) throw Error(PRIVATE); r.copy.persist(file, value); };
    const v = await r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies);
    assert.equal(v.result, 'stopped'); assert.equal(v.persistenceFailure, true); assert.equal(v.lockReleased, false); assert.equal(v.artifactPrivacy, 'unqualified');
  });
  test('old consent unknown input and foreign locks never start Docker', async t => {
    const h = harness(t);
    for (const envelope of [{ approval: r.OLD_APPROVAL, confirmation: r.CONFIRMATION }, { approval: h.prepared.approval, confirmation: r.previous.CONFIRMATION },
      { approval: h.prepared.approval, confirmation: r.CONFIRMATION, outputRoot: PRIVATE }]) await assert.rejects(r.execute(envelope, h.dependencies));
    fs.writeFileSync(path.join(h.registry, 'active.lock'), 'foreign'); await assert.rejects(r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies));
    assert.equal(h.calls.length, 0);
  });
  test('changed lock identity prevents qualification', async t => {
    const h = harness(t); h.dependencies.persist = (file, value) => { r.copy.persist(file, value); if (file.endsWith('.report.json')) fs.appendFileSync(path.join(h.registry, 'active.lock'), 'changed'); };
    const v = await r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies);
    assert.equal(v.result, 'stopped'); assert.equal(v.persistenceFailure, true); assert.equal(v.artifactPrivacy, 'unqualified'); assert.equal(v.lockReleased, false);
  });
  test('strict schemas reject private fields mismatched manifests incomplete coverage and overreads', () => {
    const p = preparationFixture(), base = report(p); assert.equal(r.validateReport(Buffer.from(JSON.stringify(base)), p).scan.summary.scannerResult, 'completed');
    const patches = [v => { v.raw = PRIVATE; }, v => { v.scan.mapping.raw = PRIVATE; },
      v => { v.verification.manifestSha256 = '0'.repeat(64); }, v => { v.scan.mapping.inspectedCopyManifestSha256 = '0'.repeat(64); },
      v => { v.scan.mapping.mappingsVerified = 1; }, v => { v.scan.mapping.mappingReferences = r.scanner.LIMITS.mappingReferences + 1; },
      v => { v.scan.summary.counters.filesRecorded = 2; }, v => { v.scan.summary.counters.aliasesVerified = 0; },
      v => { v.verification.counters.destinationVerifyBytes = r.LIMITS.verificationBytes + 1; },
      v => { v.verification.counters.entryVisits = 100001; }, v => { v.verification.counters.metadataCalls = 500001; },
      v => { v.scan = null; }, v => { v.bootstrapFailure = PRIVATE; }];
    for (const patch of patches) { const v = structuredClone(base); patch(v); assert.throws(() => r.validateReport(Buffer.from(JSON.stringify(v)), p)); }
    assert.throws(() => r.validateReport(Buffer.alloc(r.LIMITS.reportBytes + 1), p)); assert.throws(() => r.validateReport(Buffer.from('{"a":1,"a":2}'), p));
  });
  test('capacity summaries accept exact ceilings and reject invalid byte or work counters', () => {
    const p = preparationFixture(), value = report(p), m = value.scan.mapping, c = value.scan.summary.counters;
    Object.assign(m, { mappingReferences: 100000, mappingsVerified: 100000, mappedEntries: 200000, mappedPathBytes: 67108864 });
    c.decodedBytes = m.mappedPathBytes; c.bytesInspected = c.bytesRead + c.decodedBytes;
    r.validateReport(Buffer.from(JSON.stringify(value)), p);
    for (const [key, maximum] of [['mappingReferences', 100000], ['mappedEntries', 200000], ['mappedPathBytes', 67108864]]) {
      for (const invalid of [-1, 0.5, maximum + 1, null, PRIVATE]) {
        const bad = structuredClone(value); bad.scan.mapping[key] = invalid;
        assert.throws(() => r.validateReport(Buffer.from(JSON.stringify(bad)), p));
      }
    }
    const bad = structuredClone(value); bad.scan.mapping.mappedPathBytes = 67108864;
    bad.scan.summary.counters.decodedBytes--; bad.scan.summary.counters.bytesInspected--;
    assert.throws(() => r.validateReport(Buffer.from(JSON.stringify(bad)), p));
  });
  test('capacity reservation failure preserves a valid stopped report without claiming coverage', async t => {
    const h = harness(t, { failure: 'total_bytes' });
    const terminal = await r.execute({ approval: h.prepared.approval, confirmation: r.CONFIRMATION }, h.dependencies);
    assert.equal(terminal.scan.scan.summary.scannerFailure, 'total_bytes');
    assert.equal(terminal.scan.scan.mapping.mappingsVerified, 0); assert.equal(terminal.artifactPrivacy, 'unqualified');
    assert.equal(terminal.lockReleased, true); assert.equal(h.calls.filter(args => args[0] === 'start').length, 1);
    assert.equal(h.prepared.contract.scannerLimits.mappingReferences, 100000);
    assert.equal(h.prepared.contract.scannerLimits.mappedEntries, 200000);
    assert.equal(h.prepared.contract.scannerLimits.mappedPathBytes, 67108864);
    assert.equal(h.prepared.contract.preservation.mappingV2ExecutionRecords, 6);
  });
  test('implementation drift changes digest while altered evidence stops preparation', t => {
    const before = r.prepare().approval, original = r.q.fileHash;
    t.mock.method(r.q, 'fileHash', file => file === __filename ? '0'.repeat(64) : original(file)); assert.notEqual(r.prepare().approval, before);
    t.mock.restoreAll(); t.mock.method(r.q, 'fileHash', file => file.endsWith('execution-evidence-index.json') ? '0'.repeat(64) : original(file)); assert.throws(() => r.prepare());
  });
  test('historical plan resolves only its exact preserved snapshot while current plan remains approval-bound', t => {
    const plan = path.join(r.ROOT, 'docs/UIDesign/error-pages-auth-correctness-remediation-plan.md');
    const snapshot = path.join(r.ROOT, '.tmp/gate1-absent-source-maps-d85af7e3/prior-plan-snapshot.md'), original = r.q.fileHash;
    const reference = { file: plan, sha256: '76e4ec58629085b020d11047b740dafb8530d9621f799cfdc7db4b16e7e2176c' };
    r.verifyRecord(reference); assert.throws(() => r.verifyRecord({ ...reference, sha256: '0'.repeat(64) }));
    const before = r.prepare().approval;
    t.mock.method(r.q, 'fileHash', file => file === plan ? '0'.repeat(64) : original(file));
    r.verifyRecord(reference); assert.throws(() => r.prepare());
    t.mock.restoreAll(); t.mock.method(r.q, 'fileHash', file => file === r.AMENDMENT ? '0'.repeat(64) : original(file));
    assert.notEqual(r.prepare().approval, before);
    t.mock.restoreAll(); t.mock.method(r.q, 'fileHash', file => file === snapshot ? '0'.repeat(64) : original(file));
    assert.throws(() => r.verifyRecord(reference)); assert.throws(() => r.prepare());
  });
  test('snapshot substitution cannot mask unrelated receipt drift or paths outside the repository', () => {
    assert.throws(() => r.verifyRecord({ file: __filename, sha256: '76e4ec58629085b020d11047b740dafb8530d9621f799cfdc7db4b16e7e2176c' }));
    assert.throws(() => r.verifyRecord({ file: path.resolve(r.ROOT, '../foreign'), sha256: '0'.repeat(64) }));
    assert.throws(() => r.verifyRecord({ file: __filename, sha256: 'not-a-digest' }));
    const p = preparationFixture(); assert.equal(p.contract.scannerSourceBranch, 'staging');
    assert.equal(p.contract.scannerBaseCommit, '59383771fb1a63c7caf5c890134f4c9f82ace99a');
  });
  test('real failed child preserves only a validated bounded summary', async () => {
    const p = preparationFixture(), v = report(p, 'external_map');
    await assert.rejects(r.q.supervise(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(v))});process.exitCode=1;`],
      { timeoutMs: 10000, outputBytes: r.LIMITS.reportBytes, parseFailureReport: bytes => r.validateReport(bytes, p) }), error => error.report?.scan.summary.scannerFailure === 'external_map');
  });
  test('missing-map projection never drops the explicit limitation or accepts inconsistent counters', () => {
    const p = preparationFixture(), good = report(p);
    assert.equal(r.validateReport(Buffer.from(JSON.stringify(good)), p).scan.sourceMaps.sourceMapAvailability, 'absent_local_targets');
    const patches = [v => { delete v.scan.sourceMaps; }, v => { v.scan.sourceMaps.raw = PRIVATE; },
      v => { v.scan.sourceMaps.limitations = []; }, v => { v.scan.sourceMaps.sourceMapPolicy = 'reject'; },
      v => { v.scan.sourceMaps.sourceMapPolicy = 'emitted_inventory_v1'; },
      v => { v.scan.sourceMaps.sourceMapAvailability = 'all_matched_targets_present'; },
      v => { v.scan.sourceMaps.missingLocalMapContexts = 3; }, v => { v.scan.sourceMaps.missingLocalMapReferences = 0; },
      v => { v.scan.sourceMaps.sourceMapReferences = 0; }, v => { v.scan.sourceMaps.sourceMapContexts = 0; },
      v => { v.scan.sourceMaps.sourceMapReferences = -1; }, v => { v.scan.sourceMaps.sourceMapContexts = 0.5; },
      v => { v.scan.sourceMaps.sourceMapContexts = p.contract.scannerLimits.totalBytes + 1; }];
    for (const patch of patches) { const value = structuredClone(good); patch(value); assert.throws(() => r.validateReport(Buffer.from(JSON.stringify(value)), p)); }
    const failed = report(p, 'external_map'); failed.scan.sourceMaps.sourceMapAvailability = 'absent_local_targets';
    assert.throws(() => r.validateReport(Buffer.from(JSON.stringify(failed)), p));
  });
  test('pinned image companions remain exact and do not silently follow the current checkout', t => {
    const p = preparationFixture(), old = previousPrepared(), original = r.q.fileHash;
    assert.deepEqual(p.contract.integrity.slice(1), old.contract.integrity.slice(1));
    assert.notEqual(r.COMPANION_CHECKOUT, r.CHECKOUT);
    assert.equal(p.contract.companionSource, 'verified_pinned_image_bytes');
    t.mock.method(r.q, 'fileHash', file => file === path.join(r.COMPANION_CHECKOUT, 'scripts/gate1-build-qualification.js') ? '0'.repeat(64) : original(file));
    assert.throws(() => r.prepare());
  });
}
module.exports = { linuxFixtures, runLinux };
