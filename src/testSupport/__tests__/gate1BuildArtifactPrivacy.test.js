/** Synthetic local artifacts only: forbid network and keep every disposable file in this worktree's .tmp. */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const scanner = require('../../../scripts/gate1-build-artifact-privacy');
const { ATTESTATIONS, LIMITS, ScanError, profileTemplate, parseProfile, approvalId, preparation,
  compareBytes, representations, runInspection, createStore } = scanner;
const BASE = path.resolve(__dirname, '../../../.tmp/build-artifact-test-fixtures');
const CLI = path.resolve(__dirname, '../../../scripts/gate1-build-artifact-privacy.js');
const PS = path.resolve(__dirname, '../../../scripts/run-gate1-build-artifact-privacy.ps1');
const PRIVATE = 'synthetic-private-sentinel-12345+/=';
const REFS = [{ label: 'synthetic_sentinel', value: PRIVATE }];
const BASE64_CASES = [['base64', 0], ['base64', 1], ['base64', 2],
  ['base64url', 0], ['base64url', 1], ['base64url', 2]];
let folder, output, guards;
beforeAll(() => {
  guards = [https, http].map((module) => jest.spyOn(module, 'request').mockImplementation(() => { throw new Error('Network forbidden'); }));
});
beforeEach(() => {
  fs.mkdirSync(BASE, { recursive: true }); folder = fs.mkdtempSync(path.join(BASE, 'fixture-'));
  output = path.join(folder, '.vercel/output'); fs.mkdirSync(output, { recursive: true });
  file('config.json', '{"version":3}'); file('static/app.js', 'self.fixture = true;');
  file('functions/session.func/index.js', 'module.exports = function handler() {};');
});
afterEach(() => {
  for (const guard of guards) expect(guard).not.toHaveBeenCalled();
  jest.restoreAllMocks();
  // All recursive deletion targets are resolved and confined to this suite's synthetic directory.
  const absolute = path.resolve(folder);
  if (!absolute.startsWith(BASE + path.sep) || absolute === BASE) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(absolute, { recursive: true, force: true });
  guards = [https, http].map((module) => jest.spyOn(module, 'request').mockImplementation(() => { throw new Error('Network forbidden'); }));
});
afterAll(() => { jest.restoreAllMocks(); });

/** Write only controlled fixture bytes; never discover or read actual output or environment files. */
function file(relative, bytes) {
  const location = path.join(output, relative); fs.mkdirSync(path.dirname(location), { recursive: true });
  fs.writeFileSync(location, bytes); return location;
}

/** Confirm synthetic inputs explicitly; the real template deliberately leaves every attestation false. */
function profile() {
  return { ...profileTemplate(), outputRoot: output, provenance: { gitSha: 'a'.repeat(40), lockSha256: 'b'.repeat(64),
    nodeVersion: '22.23.2', nextVersion: '16.3.3', vercelCliVersion: '50.33.1' },
    attestations: Object.fromEntries(ATTESTATIONS.map((key) => [key, true])) };
}

/** Bind approval to the actual implementation while keeping comparison strings transient and synthetic. */
function envelope(p = profile()) {
  return { profile: p, approval: approvalId(p), inspectionApproved: true, comparisons: REFS };
}

/** Use memory evidence storage so tests cannot consume real inspection approvals or overwrite evidence. */
async function trial(options = {}, input = envelope()) {
  const saved = [];
  const storeFactory = jest.fn(() => ({ save: (report) => saved.push(JSON.parse(JSON.stringify(report))) }));
  const report = await runInspection(input, { storeFactory, ...options });
  expect(JSON.stringify(report)).not.toContain(PRIVATE);
  return { report, saved, storeFactory };
}

/** Create an ordinary external map whose embedded sources can contain escaped test values. */
function map(content = 'const fixture = true;') {
  return { version: 3, sources: ['fixture.js'], names: [], mappings: '', sourcesContent: [content] };
}

/** Embed a synthetic value at a byte offset; varied neighbors expose mixed-bit and padding assumptions. */
function embedded(value, encoding, offset, neighbor = 255) {
  return Buffer.concat([Buffer.alloc(offset, neighbor), Buffer.from(value),
    Buffer.from([neighbor]), Buffer.from('trailing-data')]).toString(encoding);
}

/** Run a disposable launcher copy with controlled stdout and a delayed exit code; no real scanner runs. */
function launcherFixture(stdout, exitCode) {
  const launcher = path.join(folder, 'run-gate1-build-artifact-privacy.ps1');
  fs.copyFileSync(PS, launcher);
  fs.writeFileSync(path.join(folder, 'gate1-build-artifact-privacy.js'), `
    process.stdout.end(${JSON.stringify(stdout)});
    process.stderr.end(${JSON.stringify(PRIVATE)});
    /** Exit after closing both pipes so the launcher must still wait for the actual status. */
    setTimeout(() => { process.exitCode = ${exitCode}; }, 100);
  `);
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', launcher, '-Template'],
    { encoding: 'utf8', timeout: 15000 });
}

test('default template and preparation do not list or open output', () => {
  expect(() => parseProfile(profileTemplate())).toThrow('profile');
  const p = profile(); p.outputRoot = path.join(folder, 'nonexistent/.vercel/output');
  const read = jest.spyOn(fs.promises, 'opendir');
  expect(preparation(p)).toMatchObject({ mode: 'prepare', inspectionApproved: false, artifactReads: 0,
    appRequests: 0, providerRequests: 0, nextStep: 'obtain_separate_content_inspection_approval' });
  expect(read).not.toHaveBeenCalled();
});

test.each(['outputRoot', 'environment', 'scope', 'provenance', 'comparisonLabels', 'attestations'])('invalid %s stops before reservation', async (field) => {
  const input = envelope(); input.profile[field] = 'invalid';
  const { report, storeFactory } = await trial({}, input);
  expect(report.failure).toBe('profile'); expect(storeFactory).not.toHaveBeenCalled();
});

test.each(['relative/.vercel/output', '//remote/.vercel/output', 'C:\\device:alternate\\.vercel\\output'])('reject unsafe root %s', (root) => {
  expect(() => parseProfile({ ...profile(), outputRoot: root })).toThrow('profile');
});

test('reject duplicate comparison labels and unknown profile keys', () => {
  expect(() => parseProfile({ ...profile(), comparisonLabels: ['synthetic_sentinel', 'synthetic_sentinel'] })).toThrow('profile');
  expect(() => parseProfile({ ...profile(), liveApproved: true })).toThrow('profile');
});

test('approval binds root, provenance, labels, executable bytes and fixed limits', () => {
  const p = profile(), digest = approvalId(p), original = fs.readFileSync;
  expect(approvalId({ ...p, outputRoot: path.join(folder, 'other/.vercel/output') })).not.toBe(digest);
  expect(approvalId({ ...p, provenance: { ...p.provenance, gitSha: 'c'.repeat(40) } })).not.toBe(digest);
  for (const suffix of ['gate1-build-artifact-privacy.js', 'run-gate1-build-artifact-privacy.ps1', 'package-lock.json']) {
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((name, ...args) =>
      String(name).endsWith(suffix) ? Buffer.from('reviewed-code-changed') : original(name, ...args));
    expect(approvalId(p)).not.toBe(digest); spy.mockRestore();
  }
});

test.each(['approval', 'inspectionApproved', 'comparisons'])('reject missing %s before opening output', async (key) => {
  const input = envelope(); delete input[key];
  const { report, storeFactory } = await trial({}, input);
  expect(report.failure).toBe('input'); expect(storeFactory).not.toHaveBeenCalled();
});

test('mismatched digest or comparison selection cannot inspect', async () => {
  const input = envelope(); input.approval = 'f'.repeat(64);
  expect((await trial({}, input)).report.failure).toBe('approval');
  input.approval = approvalId(input.profile); input.comparisons = [{ label: 'redis_token', value: PRIVATE }];
  expect((await trial({}, input)).report.failure).toBe('comparisons');
});

test('clean complete inventory retains fingerprints but no names or overclaims', async () => {
  file('static/unreferenced.js.map', JSON.stringify(map()));
  const { report, saved } = await trial();
  expect(report).toMatchObject({ result: 'completed', failure: null, gate1Status: 'open', reportSaved: true,
    artifactPrivacy: 'no_matches_in_checked_representations', historicalArtifactPrivacy: 'unverified',
    hostedAttribution: 'not_established', appRequests: 0, providerRequests: 0, builds: 0, deployments: 0 });
  expect(report.files).toHaveLength(4); expect(report.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.files.find((f) => f.category === 'source_map')).toBeDefined();
  expect(JSON.stringify(report)).not.toContain('session.func'); expect(JSON.stringify(report)).not.toContain(output.replaceAll('\\', '\\\\'));
  expect(saved).toHaveLength(1);
  expect(report.bytesInspected).toBe(report.bytesRead + report.decodedBytes);
});

test('fingerprint is stable across runs and changes for path or content changes', async () => {
  const first = (await trial()).report.manifestSha256;
  expect((await trial()).report.manifestSha256).toBe(first);
  file('static/app.js', 'changed'); const second = (await trial()).report.manifestSha256;
  expect(second).not.toBe(first);
  fs.renameSync(path.join(output, 'static/app.js'), path.join(output, 'static/renamed.js'));
  expect((await trial()).report.manifestSha256).not.toBe(second);
});

test.each(representations(PRIVATE))('detect privately supplied representation without retaining it: %s', async (encoded) => {
  file('static/app.js', `/* ${encoded} */`);
  const { report } = await trial();
  expect(report.failure).toBe('findings'); expect(report.result).toBe('stopped');
  expect(report.files.some((f) => f.comparisonLabels.includes('synthetic_sentinel'))).toBe(true);
  expect(JSON.stringify(report)).not.toContain(encoded);
});

test('aligned fragments retain only complete base64 characters from the value bytes', () => {
  expect(representations('PRIVATE')).toEqual(expect.arrayContaining(['UFJJVkFUR', 'BSSVZBVE', 'QUklWQVRF']));
});

test.each(BASE64_CASES)('detect embedded %s values at byte offset %i with trailing data', async (encoding, offset) => {
  for (const value of [PRIVATE, 'PRIVATE', 'synthetic-???-secret->>>-12345']) {
    for (const neighbor of [0, 255]) {
      const encoded = embedded(value, encoding, offset, neighbor);
      expect(representations(value).some((form) => encoded.includes(form))).toBe(true);
      expect(compareBytes(Buffer.from(encoded), [{ label: 'synthetic_sentinel', value }]))
        .toEqual({ labels: ['synthetic_sentinel'], patterns: [] });
    }
  }
  const encoded = embedded(PRIVATE, encoding, offset);
  file('static/app.js', `/* ${encoded} */`);
  const { report } = await trial();
  expect(report).toMatchObject({ failure: 'findings', result: 'stopped' });
  expect(report.files.some((f) => f.comparisonLabels.includes('synthetic_sentinel'))).toBe(true);
  expect(JSON.stringify(report)).not.toContain(encoded);
});

test('JSON-escaped private input and fixed credential patterns produce only labels', async () => {
  const value = 'synthetic-quote-"-and-slash-\\-012345';
  const input = envelope(); input.comparisons = [{ label: 'synthetic_sentinel', value }];
  file('functions/session.func/private.json', JSON.stringify({ token: value }));
  file('static/patterns.js', '/* -----BEGIN PRIVATE KEY----- sk_test_12345678901234567890 redis://user:password@redis.invalid */');
  const { report } = await trial({}, input);
  expect(report.failure).toBe('findings'); expect(JSON.stringify(report)).not.toContain(value);
  expect(report.files.flatMap((f) => f.patterns)).toEqual(expect.arrayContaining(['private_key', 'secret_token_pattern', 'redis_credential_uri']));
});

test('escaped map sources and indexed inline maps are inspected without fetching sources', async () => {
  const escaped = [...PRIVATE].map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  file('static/hidden.map', JSON.stringify(map(PRIVATE)).replace(PRIVATE, escaped));
  const indexed = { version: 3, sections: [{ offset: { line: 0, column: 0 }, map: map(PRIVATE) }] };
  file('static/app.js', '//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(indexed)).toString('base64'));
  const { report } = await trial();
  expect(report.failure).toBe('findings'); expect(report.inlineMaps).toBe(1);
  expect(report.files.filter((f) => f.comparisonLabels.length)).toHaveLength(2);
});

test('URI-encoded inline source map is decoded', async () => {
  file('static/app.js', '//# sourceMappingURL=data:application/json,' + encodeURIComponent(JSON.stringify(map(PRIVATE))));
  expect((await trial()).report.failure).toBe('findings');
});

test('duplicate JSON keys cannot hide an escaped earlier private value', async () => {
  const encoded = [...PRIVATE].map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  file('functions/session.func/duplicate.json', '{"key":"' + encoded + '","key":"public"}');
  expect((await trial()).report.failure).toBe('findings');
});

test.each(['MAP', 'JSON'])('mixed-case %s extension still receives decoded comparisons', async (extension) => {
  const encoded = [...PRIVATE].map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  file('static/fixture.' + extension, JSON.stringify(map(PRIVATE)).replace(PRIVATE, encoded));
  expect((await trial()).report.failure).toBe('findings');
});

test('private comparison in an artifact filename is detected without returning the filename', async () => {
  const filename = encodeURIComponent(PRIVATE) + '.js';
  file('static/' + filename, 'safe contents');
  const { report } = await trial();
  expect(report.failure).toBe('findings'); expect(JSON.stringify(report)).not.toContain(filename);
});

test('empty directory layout participates in the output fingerprint', async () => {
  const before = (await trial()).report.manifestSha256;
  fs.mkdirSync(path.join(output, 'empty'));
  expect((await trial()).report.manifestSha256).not.toBe(before);
});

test('sensitive names of empty directories are findings even without contained files', async () => {
  fs.mkdirSync(path.join(output, encodeURIComponent(PRIVATE)));
  const { report } = await trial();
  expect(report.failure).toBe('findings');
  expect(report.directoryFindings).toEqual([{ id: 1, comparisonLabels: ['synthetic_sentinel'], patterns: [] }]);
});

test('advertised local maps are present in complete inventory, including root-relative static links', async () => {
  file('static/app.js', '//# sourceMappingURL=/maps/app.js.map');
  file('static/maps/app.js.map', JSON.stringify(map()));
  expect((await trial()).report.result).toBe('completed');
});

test.each(['https://private.invalid/source.map', '//private.invalid/source.map', '../../../../outside.map',
  '%2e%2e/%2e%2e/%2e%2e/outside.map', 'missing.map', '%2f%2fprivate.invalid/map.map'])('unbounded map reference stops: %s', async (ref) => {
  file('static/app.js', '//# sourceMappingURL=' + ref);
  expect((await trial()).report.failure).toBe('external_map');
});

test.each(['data:text/html;base64,abcd', 'data:application/json;base64,%%%', 'data:application/json,%GG'])('invalid inline maps stop: %s', async (ref) => {
  file('static/app.js', '//# sourceMappingURL=' + ref);
  expect((await trial()).report.failure).toBe('map_contract');
});

test.each([{ version: 2 }, { version: 3, sources: ['x'], mappings: '', sourcesContent: [] },
  { version: 3, sections: [{ url: 'private.invalid' }] }])('incompatible map contract cannot pass', async (value) => {
  file('static/app.map', JSON.stringify(value));
  expect(['map_contract', 'external_map']).toContain((await trial()).report.failure);
});

test.each(['.env', '.env.production', '.ENV.local', '.npmrc', 'auth.json'])('forbidden %s is rejected without opening contents', async (name) => {
  file(name, 'must never be read'); const open = jest.spyOn(fs.promises, 'open');
  expect((await trial()).report.failure).toBe('forbidden_file'); expect(open).not.toHaveBeenCalled();
});

test('ancestor junctions are rejected before a file can be opened', async () => {
  const linked = path.join(folder, 'linked');
  fs.symlinkSync(path.join(folder, '.vercel'), linked, process.platform === 'win32' ? 'junction' : 'dir');
  const p = profile(); p.outputRoot = path.join(linked, '.vercel/output');
  const open = jest.spyOn(fs.promises, 'open');
  expect((await trial({}, envelope(p))).report.failure).toBe('link'); expect(open).not.toHaveBeenCalled();
});

test('directory links and multiply linked files are refused', async () => {
  fs.symlinkSync(path.join(output, 'static'), path.join(output, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await trial()).report.failure).toBe('link');
  fs.unlinkSync(path.join(output, 'alias'));
  fs.linkSync(path.join(output, 'static/app.js'), path.join(output, 'static/hardlink.js'));
  expect((await trial()).report.failure).toBe('link');
});

test('unreadable file errors cannot expose paths or exception contents', async () => {
  jest.spyOn(fs.promises, 'open').mockRejectedValue(new Error(PRIVATE + output));
  const { report } = await trial(); expect(report.failure).toBe('unreadable');
  expect(report.manifestSha256).toBeNull();
});

test('file changed between enumeration and open stops without accepting a stale fingerprint', async () => {
  const real = fs.promises.open;
  jest.spyOn(fs.promises, 'open').mockImplementation(async (location, ...args) => {
    if (String(location).endsWith('app.js')) fs.appendFileSync(location, 'changed');
    return real.call(fs.promises, location, ...args);
  });
  expect((await trial()).report.failure).toBe('changed');
});

test('file changed during reading is rejected by descriptor/post-read identity checks', async () => {
  const real = fs.promises.open;
  jest.spyOn(fs.promises, 'open').mockImplementation(async (location, ...args) => {
    const handle = await real.call(fs.promises, location, ...args);
    if (String(location).endsWith('app.js')) {
      const original = handle.read.bind(handle); let changed = false;
      handle.read = async (...readArgs) => {
        const result = await original(...readArgs);
        if (!changed) { changed = true; fs.appendFileSync(location, 'changed'); }
        return result;
      };
    }
    return handle;
  });
  expect((await trial()).report.failure).toBe('changed');
});

test('new files appearing after scanning are rejected by final inventory', async () => {
  const real = fs.promises.opendir; let rootVisits = 0;
  jest.spyOn(fs.promises, 'opendir').mockImplementation(async (location, ...args) => {
    if (location === output && ++rootVisits === 2) file('static/new.js', 'new');
    return real.call(fs.promises, location, ...args);
  });
  const { report } = await trial(); expect(report.failure).toBe('changed'); expect(report.manifestSha256).toBeNull();
});

test.each([['maxFiles', 2, 'file_limit'], ['maxEntries', 1, 'entry_limit'], ['fileBytes', 1, 'file_size'],
  ['totalBytes', 1, 'total_bytes'], ['overallMs', 0, 'overall_deadline'], ['maxDepth', 0, 'depth_limit'],
  ['jsonNodes', 0, 'json']])('enforce %s without declaring completeness', async (key, value, failure) => {
  const { report } = await trial({ limits: { [key]: value } });
  expect(report.failure).toBe(failure); expect(report.artifactPrivacy).toBe('unqualified');
  expect(report.coverage).toBe('unqualified');
});

test('fixture overrides cannot expand operational limits', async () => {
  expect((await trial({ limits: { maxFiles: LIMITS.maxFiles + 1 } })).report.failure).toBe('input');
});

test('decoded map expansion consumes the shared byte budget', async () => {
  file('static/app.map', JSON.stringify(map('x'.repeat(1024))));
  const physical = [path.join(output, 'config.json'), path.join(output, 'static/app.js'),
    path.join(output, 'static/app.map'), path.join(output, 'functions/session.func/index.js')]
    .reduce((n, item) => n + fs.statSync(item).size, 0);
  expect((await trial({ limits: { totalBytes: physical } })).report.failure).toBe('total_bytes');
});

test.each(['archive.zip', 'archive.gz', 'archive.br', 'archive.tar'])('archives are not silently skipped: %s', async (name) => {
  file('static/' + name, 'content'); expect((await trial()).report.failure).toBe('unsupported_format');
});

test('known binaries receive explicit raw-byte coverage and still detect a sentinel', async () => {
  file('static/image.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255]));
  let report = (await trial()).report;
  expect(report.result).toBe('completed'); expect(report.files.some((f) => f.format === 'binary_raw_only')).toBe(true);
  file('static/image.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(PRIVATE)]));
  report = (await trial()).report; expect(report.failure).toBe('findings');
});

test('unknown binary and invalid UTF-8 cannot pass', async () => {
  file('static/unknown.bin', Buffer.from([0, 1, 2])); expect((await trial()).report.failure).toBe('unsupported_format');
  file('static/unknown.bin', Buffer.from([255, 255])); expect((await trial()).report.failure).toBe('encoding');
});

test.each(['missing', 'wrong_version', 'invalid_json'])('invalid Build Output config stops: %s', async (condition) => {
  if (condition === 'missing') fs.unlinkSync(path.join(output, 'config.json'));
  else file('config.json', condition === 'wrong_version' ? '{"version":2}' : '{');
  expect(['config', 'json']).toContain((await trial()).report.failure);
});

test('function config with external file mappings cannot report a clean scan', async () => {
  file('functions/session.func/.vc-config.json', JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.js',
    filePathMap: { 'mapped.js': 'src/private-build-input.js' } }));
  const { report, saved } = await trial();
  expect(report).toMatchObject({ result: 'stopped', failure: 'external_map', artifactPrivacy: 'unqualified',
    coverage: 'unqualified', manifestSha256: null, reportSaved: true });
  expect(saved).toEqual([report]); expect(JSON.stringify(report)).not.toContain('src/private-build-input.js');
});

test.each([{}, { filePathMap: {} }])('function config without mapped files remains supported: %j', async (mapping) => {
  file('functions/session.func/.vc-config.json', JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.js', ...mapping }));
  const { report } = await trial();
  expect(report).toMatchObject({ result: 'completed', failure: null,
    artifactPrivacy: 'no_matches_in_checked_representations' });
});

test('inspection approval is consumed before content access and cannot be retried', async () => {
  const used = new Set(); const storeFactory = jest.fn((id) => {
    if (used.has(id)) throw new Error('consumed'); used.add(id); return { save: jest.fn() };
  });
  const input = envelope(); const first = await runInspection(input, { storeFactory });
  expect(first.result).toBe('completed');
  const open = jest.spyOn(fs.promises, 'opendir');
  const second = await runInspection(input, { storeFactory });
  expect(second.failure).toBe('reservation'); expect(open).not.toHaveBeenCalled();
});

test('storage uses exclusive creation for reservation and report without paths in public results', () => {
  jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
  const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  createStore('a'.repeat(64)).save({ schemaVersion: 1 });
  expect(write).toHaveBeenCalledTimes(2);
  for (const call of write.mock.calls) expect(call[2]).toEqual({ flag: 'wx', mode: 0o600 });
});

test('report persistence failure retains completed terminal evidence without inviting another scan', async () => {
  const { report } = await trial({ storeFactory: () => ({ save: () => { throw new Error(PRIVATE); } }) });
  expect(report).toMatchObject({ result: 'completed', reportSaved: false, persistenceFailure: 'report_write' });
});

test('secret echo in supplied provenance is rejected before content access', async () => {
  const input = envelope(); input.comparisons = [{ label: 'synthetic_sentinel', value: input.profile.provenance.gitSha }];
  const { report, storeFactory } = await trial({}, input);
  expect(report.failure).toBe('comparisons'); expect(storeFactory).not.toHaveBeenCalled();
  expect(JSON.stringify(report)).not.toContain(input.profile.provenance.gitSha);
});

test.each(BASE64_CASES)('reject embedded %s profile echoes at byte offset %i before content access', async (encoding, offset) => {
  const encoded = embedded(PRIVATE, encoding, offset), p = profile();
  p.outputRoot = path.join(folder, encoded, '.vercel/output');
  const open = jest.spyOn(fs.promises, 'opendir');
  const { report, storeFactory } = await trial({}, envelope(p));
  expect(report.failure).toBe('comparisons');
  expect(storeFactory).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  expect(JSON.stringify(report)).not.toContain(encoded);
});

test.each(BASE64_CASES)('suppress embedded %s report echoes at byte offset %i before saving', async (encoding, offset) => {
  const encoded = embedded(PRIVATE, encoding, offset);
  jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(encoded);
  const { report, saved } = await trial();
  expect(report).toEqual({ schemaVersion: 1, scope: scanner.SCOPE, result: 'stopped',
    gate1Status: 'open', failure: 'private_output_suppressed', reportSaved: true });
  expect(saved).toEqual([report]); expect(JSON.stringify(report)).not.toContain(encoded);
});

test('CLI defaults to unapproved template and invalid input has a fixed private-safe error', () => {
  const result = spawnSync(process.execPath, [CLI], { encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout).attestations.sourceCodeReviewed).toBe(false);
  const invalid = spawnSync(process.execPath, [CLI, '--prepare'], { encoding: 'utf8', timeout: 10000, input: PRIVATE });
  expect(invalid.status).toBe(1); expect(invalid.stderr).not.toContain(PRIVATE);
});

test('scanner imports no network/deployment process primitive', () => {
  const code = fs.readFileSync(CLI, 'utf8');
  expect(code).not.toMatch(/require\(['"](?:node:)?(?:https?|net|tls|child_process)['"]\)/);
  expect(code).not.toMatch(/\bfetch\(/);
  expect(new ScanError(PRIVATE).message).toBe('internal');
  expect(compareBytes(Buffer.from(PRIVATE), REFS)).toEqual({ labels: ['synthetic_sentinel'], patterns: [] });
});

(process.platform === 'win32' ? test : test.skip)('PowerShell parses and defaults to preparation without private prompts', () => {
  const command = `$errors = $null; $tokens = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${PS.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors); if ($errors.Count) { exit 1 }; & '${PS.replaceAll("'", "''")}' -Template`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 15000 });
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout).scope).toBe(scanner.SCOPE);
});

(process.platform === 'win32' ? test : test.skip)('PowerShell refuses wrong approval before hidden input', () => {
  const p = profile(), location = path.join(folder, 'profile-fixture.json'); fs.writeFileSync(location, JSON.stringify(p));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-File', PS, '-ProfilePath', location, '-Inspect', '-Approval', 'f'.repeat(64)],
    { encoding: 'utf8', timeout: 15000 });
  expect(result.status).toBe(1); expect(result.stderr).toContain('Artifact preparation/inspection failed');
});

(process.platform === 'win32' ? test : test.skip).each([
  ['unquoted keys', '"environment":', 'environment:'],
  ['single-quoted strings', '"preview"', "'preview'"],
  ['leading-plus numbers', '"schemaVersion":1,', '"schemaVersion":+1,'],
])('PowerShell rejects profile JSON with %s before preparation', (_name, original, replacement) => {
  const location = path.join(folder, 'profile-fixture.json');
  const raw = JSON.stringify(profile()).replace(original, replacement);
  expect(() => JSON.parse(raw)).toThrow(); fs.writeFileSync(location, raw);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', PS, '-ProfilePath', location],
    { encoding: 'utf8', timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
  expect(result.stdout).toBe(''); expect(result.stderr).toContain('Artifact preparation/inspection failed');
});

(process.platform === 'win32' ? test : test.skip).each([1, 2])('PowerShell preserves profile text in both handoffs with %i comparisons', (count) => {
  const p = profile(); p.comparisonLabels = ['synthetic_sentinel', 'redis_token'].slice(0, count);
  const raw = '\r\n' + JSON.stringify(p, null, 2).replace('"schemaVersion": 1,', '"schemaVersion": 1e0,')
    .replace('"preview"', '"pre\\u0076iew"') + '\r\n\t';
  const location = path.join(folder, 'profile-fixture.json'), review = preparation(p);
  const value = 'synthetic-quote-"-and-slash-\\-012345';
  fs.writeFileSync(location, raw);
  const command = `
    . '${PS.replaceAll("'", "''")}' -ProfilePath '${location.replaceAll("'", "''")}' -Inspect -Approval '${review.approvalId}'
    $script:prepareInput = $null; $script:inspectInput = $null; $script:labels = @()
    <# Capture transport inputs and return a synthetic review/result without inspecting any output. #>
    function Invoke-Gate1BuildArtifactNode([string]$Mode, [string]$InputJson = '') {
      if ($Mode -ceq '--prepare') {
        $script:prepareInput = $InputJson
        return @{ Json = '${JSON.stringify(review).replaceAll("'", "''")}'; ExitCode = 0 }
      }
      if ($Mode -cne '--inspect') { throw 'Unexpected fixture mode.' }
      $script:inspectInput = $InputJson
      return @{ Json = '{"result":"fixture"}'; ExitCode = 0 }
    }
    <# Confirm only this mocked inspection flow; no interactive approval or real scan occurs. #>
    function Read-Host { return 'SCAN APPROVED OUTPUT ONCE' }
    <# Record selected labels and supply synthetic comparison text to exercise JSON escaping. #>
    function Read-Gate1BuildComparison([string]$Label) {
      $script:labels += $Label
      return '${value.replaceAll("'", "''")}'
    }
    $result = Invoke-Gate1BuildArtifactPrivacy
    ConvertTo-Json -Depth 10 -Compress -InputObject @{
      prepareInput = $script:prepareInput; inspectInput = $script:inspectInput; labels = $script:labels; result = $result.Json
    }
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
  const captured = JSON.parse(result.stdout);
  expect(captured.prepareInput).toBe(raw); expect(captured.inspectInput).toContain(raw);
  expect(captured.labels).toEqual(p.comparisonLabels); expect(JSON.parse(captured.result)).toEqual({ result: 'fixture' });
  expect(JSON.parse(captured.inspectInput)).toEqual({ profile: p, approval: review.approvalId, inspectionApproved: true,
    comparisons: p.comparisonLabels.map((label) => ({ label, value })) });
});

(process.platform === 'win32' ? test : test.skip).each(['', ' \t\r\n', PRIVATE])('PowerShell preserves failed child status with invalid stdout: %j', (stdout) => {
  const result = launcherFixture(stdout, 23);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(23);
  expect(result.stdout.split(/\r?\n/)[0]).toBe('{}');
  expect(result.stdout).toContain('Scan stopped.');
  expect(result.stdout + result.stderr).not.toContain(PRIVATE);
});

(process.platform === 'win32' ? test : test.skip).each(['', ' \t\r\n', PRIVATE])('PowerShell rejects successful child with invalid stdout: %j', (stdout) => {
  const result = launcherFixture(stdout, 0);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
  expect(result.stdout).toBe(''); expect(result.stderr).toContain('Artifact preparation/inspection failed');
  expect(result.stdout + result.stderr).not.toContain(PRIVATE);
});

(process.platform === 'win32' ? test : test.skip).each([0, 23])('PowerShell preserves valid JSON and delayed child exit code %i', (exitCode) => {
  const stdout = JSON.stringify({ result: exitCode === 0 ? 'completed' : 'stopped' });
  const result = launcherFixture(stdout, exitCode);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(exitCode);
  expect(result.stdout.split(/\r?\n/)[0]).toBe(stdout);
  expect(result.stdout + result.stderr).not.toContain(PRIVATE);
});

test('per-file hash represents inspected bytes without reading any private artifact', async () => {
  const { report } = await trial();
  expect(report.files.some((f) => f.sha256 === createHash('sha256').update('self.fixture = true;').digest('hex'))).toBe(true);
});
