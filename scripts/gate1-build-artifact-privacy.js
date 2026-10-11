'use strict';

/**
 * Offline-default, owner-run inspection of one newly generated Build Output directory.
 * Never builds, deploys, imports artifact code, reads .env files, or uses a network API.
 * Preparation reads only reviewed executables; --inspect requires separate approval.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { TextDecoder } = require('node:util');
const { z } = require('zod');

const SCOPE = 'new_build_output_comparisons_only';
const LIMITS = Object.freeze({ maxAppRequests: 0, maxProviderRequests: 0, maxConfigMutations: 0,
  maxBuilds: 0, maxDeployments: 0, maxFiles: 25000, maxEntries: 50000, maxDepth: 64,
  fileBytes: 67108864, totalBytes: 1073741824, overallMs: 120000, concurrency: 1,
  inputBytes: 65536, reportBytes: 8388608, jsonNodes: 100000, inputMs: 10000 });
const LABELS = Object.freeze(['ceiling_hmac', 'redis_token', 'supabase_service_role', 'csrf_secret',
  'secrets_probe', 'automation_bypass', 'synthetic_sentinel']);
const ATTESTATIONS = Object.freeze(['sourceCodeReviewed', 'newBuildProvenanceReviewed',
  'comparisonSelectionReviewed', 'exclusiveOutputControl', 'noEnvironmentFiles',
  'privateOutputAccessReviewed', 'coverageLimitationsReviewed']);
const CODES = new Set(['profile', 'input', 'approval', 'comparisons', 'reservation', 'report_write',
  'overall_deadline', 'entry_limit', 'file_limit', 'depth_limit', 'file_size', 'total_bytes',
  'forbidden_file', 'link', 'path', 'file_type', 'unreadable', 'changed', 'unsupported_format',
  'encoding', 'json', 'map_contract', 'external_map', 'config', 'findings', 'internal']);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/).max(64);
const profileSchema = z.object({ schemaVersion: z.literal(1), scope: z.literal(SCOPE),
  runId: z.string().regex(/^[a-f0-9]{32}$/), environment: z.literal('preview'),
  outputRoot: z.string().min(1).max(1024).refine((s) => !hasControl(s)),
  provenance: z.object({ gitSha: z.string().regex(/^[a-f0-9]{40}$/), lockSha256: hex,
    nodeVersion: version, nextVersion: version, vercelCliVersion: version }).strict(),
  comparisonLabels: z.array(z.enum(LABELS)).min(1).max(LABELS.length)
    .refine((a) => new Set(a).size === a.length),
  attestations: z.object(Object.fromEntries(ATTESTATIONS.map((key) => [key, z.literal(true)]))).strict(),
}).strict();
const inputSchema = z.object({ profile: z.unknown(), approval: hex, inspectionApproved: z.literal(true),
  comparisons: z.array(z.object({ label: z.enum(LABELS), value: z.string().min(16).max(4096)
    .regex(/^[\x20-\x7e]+$/) }).strict()).min(1).max(LABELS.length) }).strict();

/** Keep raw filesystem/schema messages and artifact text out of every error boundary. */
class ScanError extends Error {
  /** Store only a fixed failure code; never accept paths or matched values. */
  constructor(code) { super(CODES.has(code) ? code : 'internal'); this.code = this.message; }
}

/** Fingerprint files and executable contracts; never publish a comparison-value digest. */
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** Reject path control characters without reflecting the supplied path in an error. */
function hasControl(value) { return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127); }

/** Create an unapproved template without opening or even listing the proposed output. */
function profileTemplate() {
  return { schemaVersion: 1, scope: SCOPE, runId: randomBytes(16).toString('hex'),
    environment: 'preview', outputRoot: path.resolve('QUALIFICATION_BUILD/.vercel/output'),
    provenance: { gitSha: '0'.repeat(40), lockSha256: '0'.repeat(64), nodeVersion: '22.0.0',
      nextVersion: '16.3.3', vercelCliVersion: '0.0.0' }, comparisonLabels: ['synthetic_sentinel'],
    attestations: Object.fromEntries(ATTESTATIONS.map((key) => [key, false])) };
}

/** Require a canonical local Build Output root, excluding UNC/device paths and alternate streams. */
function parseProfile(value) {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new ScanError('profile');
  const p = parsed.data, root = p.outputRoot;
  if (!path.isAbsolute(root) || path.resolve(root) !== root || /^[/\\]{2}/.test(root) ||
      (process.platform === 'win32' && /:/.test(root.slice(2))) ||
      path.basename(root) !== 'output' || path.basename(path.dirname(root)) !== '.vercel') {
    throw new ScanError('profile');
  }
  return p;
}

/** Bind exact root/provenance/attestations/limits and local executables; no artifact access occurs. */
function approvalId(value) {
  const profile = parseProfile(value);
  const integrity = ['gate1-build-artifact-privacy.js', 'run-gate1-build-artifact-privacy.ps1', '../package-lock.json']
    .map((name) => sha256(fs.readFileSync(path.join(__dirname, name))));
  return sha256(JSON.stringify({ profile, limits: LIMITS, integrity }));
}

/** Return a concrete offline review; template placeholders cannot attest to a real build. */
function preparation(value) {
  const profile = parseProfile(value);
  return { schemaVersion: 1, mode: 'prepare', scope: SCOPE, profile, limits: LIMITS,
    approvalId: approvalId(profile), inspectionApproved: false, artifactReads: 0,
    appRequests: 0, providerRequests: 0, gate1Status: 'open',
    nextStep: 'obtain_separate_content_inspection_approval',
    historicalArtifactPrivacy: 'unverified', hostedAttribution: 'not_established' };
}

/** Expand private values for byte comparisons and echo guards, including every base64 byte alignment. */
function representations(value) {
  const raw = Buffer.from(value), forms = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value),
    raw.toString('base64'), raw.toString('base64url')];
  for (let shift = 0; shift < 3; shift++) {
    const shifted = Buffer.concat([Buffer.alloc(shift), raw]);
    // Keep only complete six-bit groups from value bytes, excluding neighbors and padding.
    const start = Math.ceil((shift * 8) / 6), end = Math.floor((shifted.length * 8) / 6);
    for (const encoding of ['base64', 'base64url']) forms.push(shifted.toString(encoding).slice(start, end));
  }
  return [...new Set(forms)];
}

/** Match byte strings and fixed ASCII patterns; record labels only, never snippets or offsets. */
function compareBytes(bytes, comparisons) {
  const labels = comparisons.filter((ref) => representations(ref.value)
    .some((s) => bytes.includes(Buffer.from(s)))).map((ref) => ref.label);
  const text = bytes.toString('latin1'), patterns = [];
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) patterns.push('private_key');
  if (/\b(?:sk_live_|sk_test_|sb_secret_)[A-Za-z0-9_-]{16,}/.test(text)) patterns.push('secret_token_pattern');
  if (/\b(?:redis|rediss):\/\/[^\s"'<>]*:[^\s"'<>]+@/i.test(text)) patterns.push('redis_credential_uri');
  return { labels, patterns };
}

/** Check monotonic deadline frequently; the launcher additionally kills a stalled child at 135 seconds. */
function checkTime(state) {
  if (state.now() - state.started >= state.limits.overallMs) throw new ScanError('overall_deadline');
}

/** Bound decoded data as well as physical reads; no map expansion can bypass the byte budget. */
function charge(state, length, decoded = false) {
  checkTime(state);
  if (state.bytesInspected + length > state.limits.totalBytes) throw new ScanError('total_bytes');
  state.bytesInspected += length;
  if (decoded) state.decodedBytes += length;
  else state.bytesRead += length;
}

/** Reject links in every ancestor, including the selected root; this never reads directory contents. */
async function checkAncestors(location, state) {
  const root = path.parse(location).root;
  const parts = path.relative(root, location).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    checkTime(state); current = path.join(current, part);
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink()) throw new ScanError('link');
    if (!stat.isDirectory()) throw new ScanError('path');
  }
}

/** Compare filesystem identity/size/timestamps before and after reads and final inventory. */
function stamp(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(':');
}

/** Refuse environment/config credential files by name before opening them, including dot-env variants. */
function forbidden(name) {
  return /^(?:\.env(?:\..*)?|\.git|\.aws|\.codex|\.ssh|\.npmrc|\.netrc|auth\.json|credentials(?:\.json)?)$/i.test(name);
}

/** Inventory only regular single-link files; streams bound directory entries before allocation grows. */
async function inventory(root, state) {
  await checkAncestors(root, state);
  const entries = [], queue = [{ absolute: root, relative: '', depth: 0 }];
  let files = 0, bytes = 0;
  while (queue.length) {
    checkTime(state);
    const dir = queue.shift();
    if (dir.depth > state.limits.maxDepth) throw new ScanError('depth_limit');
    await checkAncestors(dir.absolute, state);
    const iterator = await fs.promises.opendir(dir.absolute);
    for await (const entry of iterator) {
      checkTime(state);
      if (entries.length >= state.limits.maxEntries) throw new ScanError('entry_limit');
      if (forbidden(entry.name)) throw new ScanError('forbidden_file');
      if (entry.name.includes(':') || hasControl(entry.name)) throw new ScanError('path');
      const absolute = path.join(dir.absolute, entry.name);
      const relative = path.join(dir.relative, entry.name);
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink()) throw new ScanError('link');
      if (!stat.isFile() && !stat.isDirectory()) throw new ScanError('file_type');
      if (stat.isFile()) {
        if (stat.nlink !== 1) throw new ScanError('link');
        files++; bytes += stat.size;
        if (files > state.limits.maxFiles) throw new ScanError('file_limit');
        if (stat.size > state.limits.fileBytes) throw new ScanError('file_size');
        if (bytes > state.limits.totalBytes) throw new ScanError('total_bytes');
      } else queue.push({ absolute, relative, depth: dir.depth + 1 });
      entries.push({ relative, absolute, directory: stat.isDirectory(), stamp: stamp(stat), size: stat.size, mode: stat.mode & 0o777 });
    }
  }
  return entries.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
}

/** Open the inventoried inode with no-follow when supported, cap reads, and reject any observed mutation. */
async function readStable(entry, state) {
  checkTime(state);
  await checkAncestors(path.dirname(entry.absolute), state);
  const before = await fs.promises.lstat(entry.absolute);
  if (before.isSymbolicLink() || before.nlink !== 1) throw new ScanError('link');
  if (!before.isFile() || stamp(before) !== entry.stamp) throw new ScanError('changed');
  const handle = await fs.promises.open(entry.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (stamp(await handle.stat()) !== entry.stamp) throw new ScanError('changed');
    const bytes = Buffer.alloc(entry.size), block = Buffer.alloc(65536);
    let offset = 0;
    while (true) {
      checkTime(state);
      const { bytesRead } = await handle.read(block, 0, block.length, null);
      if (!bytesRead) break;
      charge(state, bytesRead);
      if (offset + bytesRead > entry.size) throw new ScanError('changed');
      block.copy(bytes, offset, 0, bytesRead); offset += bytesRead;
    }
    await checkAncestors(path.dirname(entry.absolute), state);
    if (offset !== entry.size || stamp(await handle.stat()) !== entry.stamp ||
        stamp(await fs.promises.lstat(entry.absolute)) !== entry.stamp) throw new ScanError('changed');
    return bytes;
  } finally { await handle.close(); }
}

/** Decode only UTF-8 textual artifacts; invalid encodings remain non-passing. */
function decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ScanError('encoding'); }
}

/** Scan decoded JSON strings, including escaped map sources, with bounded node count/depth. */
function inspectJson(value, findings, comparisons, state) {
  const stack = [{ value, depth: 0 }]; let nodes = 0;
  while (stack.length) {
    checkTime(state);
    const item = stack.pop();
    if (++nodes > state.limits.jsonNodes || item.depth > state.limits.maxDepth) throw new ScanError('json');
    if (typeof item.value === 'string') {
      const bytes = Buffer.from(item.value); charge(state, bytes.length, true);
      const result = compareBytes(bytes, comparisons);
      result.labels.forEach((s) => findings.labels.add(s)); result.patterns.forEach((s) => findings.patterns.add(s));
    } else if (item.value && typeof item.value === 'object') {
      const pairs = Object.entries(item.value);
      if (pairs.length + stack.length + nodes > state.limits.jsonNodes) throw new ScanError('json');
      for (const [key, child] of pairs) {
        // Object keys can themselves contain encoded private data.
        const bytes = Buffer.from(key); charge(state, bytes.length, true);
        const result = compareBytes(bytes, comparisons);
        result.labels.forEach((s) => findings.labels.add(s)); result.patterns.forEach((s) => findings.patterns.add(s));
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
}

/** Validate source-map coverage without fetching sourceRoot/sources or external indexed sections. */
function validateMap(map, depth = 0) {
  if (!map || typeof map !== 'object' || map.version !== 3 || depth > 32) throw new ScanError('map_contract');
  if (Object.hasOwn(map, 'sections')) {
    if (!Array.isArray(map.sections) || map.sections.length > 10000 || Object.hasOwn(map, 'sources')) throw new ScanError('map_contract');
    for (const section of map.sections) {
      if (!section || Object.hasOwn(section, 'url')) throw new ScanError('external_map');
      validateMap(section.map, depth + 1);
    }
  } else if (!Array.isArray(map.sources) || map.sources.length > 100000 ||
    !map.sources.every((s) => typeof s === 'string') || typeof map.mappings !== 'string' ||
    (map.sourcesContent !== undefined && (!Array.isArray(map.sourcesContent) ||
      map.sourcesContent.length !== map.sources.length || !map.sourcesContent.every((s) => s === null || typeof s === 'string')))) {
    throw new ScanError('map_contract');
  }
}

/** Merge fixed labels and scan bounded source-map JSON; parse errors cannot emit input text. */
function scanJson(text, findings, comparisons, state, isMap) {
  let value;
  try { value = JSON.parse(text); } catch { throw new ScanError('json'); }
  if (isMap) validateMap(value);
  // JSON.parse discards earlier duplicate keys. Scan every decoded literal as well,
  // so an escaped value under an overwritten key cannot disappear from inspection.
  let literals = 0;
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/gs)) {
    if (++literals > state.limits.jsonNodes) throw new ScanError('json');
    const bytes = Buffer.from(JSON.parse(match[0])); charge(state, bytes.length, true);
    const result = compareBytes(bytes, comparisons);
    result.labels.forEach((s) => findings.labels.add(s)); result.patterns.forEach((s) => findings.patterns.add(s));
  }
  inspectJson(value, findings, comparisons, state);
  return value;
}

/** Resolve advertised local maps within the inventory, or inspect inline data maps without network access. */
function inspectMapLinks(text, entry, knownFiles, findings, comparisons, state) {
  const matches = text.matchAll(/(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL\s*=\s*([^\s*]+)/g);
  for (const match of matches) {
    checkTime(state); const ref = match[1];
    if (ref.startsWith('data:')) {
      const data = /^data:application\/json(?:;charset=utf-8)?(;base64)?,(.+)$/i.exec(ref);
      if (!data) throw new ScanError('map_contract');
      let bytes;
      if (data[1]) {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data[2])) throw new ScanError('map_contract');
        bytes = Buffer.from(data[2], 'base64');
        if (bytes.toString('base64').replace(/=+$/, '') !== data[2].replace(/=+$/, '')) throw new ScanError('map_contract');
      } else {
        try { bytes = Buffer.from(decodeURIComponent(data[2])); } catch { throw new ScanError('map_contract'); }
      }
      if (bytes.length > state.limits.fileBytes) throw new ScanError('file_size');
      charge(state, bytes.length, true);
      scanJson(decode(bytes), findings, comparisons, state, true); state.inlineMaps++;
    } else {
      if (/[\\?#:]/.test(ref) || ref.startsWith('//')) throw new ScanError('external_map');
      let local;
      try { local = decodeURIComponent(ref); } catch { throw new ScanError('external_map'); }
      if (/[\\?#:]/.test(local) || hasControl(local) || local.startsWith('//')) throw new ScanError('external_map');
      const relative = local.startsWith('/') ? path.join('static', local.slice(1)) : path.join(path.dirname(entry.relative), local);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !knownFiles.has(relative) || !/\.map$/i.test(relative)) {
        throw new ScanError('external_map');
      }
    }
  }
}

/** Classify raw files, not claimed deployed routes; no names/paths are retained in the public report. */
function category(relative) {
  if (/\.map$/i.test(relative)) return 'source_map';
  if (relative.split(path.sep)[0] === 'functions') return 'function';
  if (relative.split(path.sep)[0] === 'static') return 'static';
  return 'metadata_or_other';
}

/** Recognize binary signatures for raw-byte comparison only; archives and unknown formats stop. */
function binaryFormat(bytes, name) {
  const ext = path.extname(name).toLowerCase();
  return (ext === '.node' && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) ||
    (ext === '.wasm' && bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) ||
    (ext === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (['.jpg', '.jpeg'].includes(ext) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
    (ext === '.webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') ||
    (['.woff', '.woff2'].includes(ext) && ['wOFF', 'wOF2'].includes(bytes.toString('ascii', 0, 4))) ||
    (ext === '.ico' && bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])));
}

/** Compare all bytes, decode known text/maps, and distinguish opaque binary coverage from decoded coverage. */
function inspectFile(bytes, entry, knownFiles, comparisons, state) {
  const raw = compareBytes(bytes, comparisons);
  const findings = { labels: new Set(raw.labels), patterns: new Set(raw.patterns) };
  const nameBytes = Buffer.from(entry.relative.split(path.sep).join('/'));
  charge(state, nameBytes.length, true);
  const names = compareBytes(nameBytes, comparisons);
  names.labels.forEach((s) => findings.labels.add(s)); names.patterns.forEach((s) => findings.patterns.add(s));
  if (binaryFormat(bytes, entry.relative)) return { findings, format: 'binary_raw_only' };
  if (/\.(?:zip|gz|tgz|br|7z|tar|bz2|xz)$/i.test(entry.relative)) throw new ScanError('unsupported_format');
  const text = decode(bytes);
  if (text.includes('\0')) throw new ScanError('unsupported_format');
  if (/\.(?:map|json)$/i.test(entry.relative)) {
    const value = scanJson(text, findings, comparisons, state, /\.map$/i.test(entry.relative));
    if (entry.relative === 'config.json' && (!value || value.version !== 3)) throw new ScanError('config');
    // Function file mappings can reference deployable bytes outside the inspected directory.
    if (path.basename(entry.relative) === '.vc-config.json' && value && typeof value === 'object' &&
        Object.hasOwn(value, 'filePathMap') && Object.keys(value.filePathMap || {}).length) {
      throw new ScanError('external_map');
    }
  }
  if (/\.(?:[cm]?js|css|html)$/i.test(entry.relative)) inspectMapLinks(text, entry, knownFiles, findings, comparisons, state);
  return { findings, format: 'utf8_and_decoded_json' };
}

/** Enumerate before/after, inspect each file, and fingerprint relative paths privately with content hashes. */
async function scanOutput(profile, comparisons, state) {
  const before = await inventory(profile.outputRoot, state);
  const files = before.filter((entry) => !entry.directory);
  const knownFiles = new Set(files.map((entry) => entry.relative));
  if (!knownFiles.has('config.json')) throw new ScanError('config');
  const fingerprint = createHash('sha256');
  for (const entry of before.filter((item) => item.directory)) {
    const nameBytes = Buffer.from(entry.relative.split(path.sep).join('/')); charge(state, nameBytes.length, true);
    const names = compareBytes(nameBytes, comparisons);
    if (names.labels.length || names.patterns.length) {
      state.directoryFindings.push({ id: state.directoryFindings.length + 1,
        comparisonLabels: names.labels, patterns: names.patterns });
    }
    fingerprint.update(JSON.stringify([entry.relative.split(path.sep).join('/'), 'directory', entry.mode]) + '\n');
  }
  for (const entry of files) {
    const bytes = await readStable(entry, state);
    const contentHash = sha256(bytes);
    const { findings, format } = inspectFile(bytes, entry, knownFiles, comparisons, state);
    fingerprint.update(JSON.stringify([entry.relative.split(path.sep).join('/'), 'file', entry.mode, bytes.length, contentHash]) + '\n');
    state.files.push({ id: state.files.length + 1, category: category(entry.relative), bytes: bytes.length,
      sha256: contentHash, mode: entry.mode, format, comparisonLabels: [...findings.labels].sort(), patterns: [...findings.patterns].sort() });
    bytes.fill(0); checkTime(state);
  }
  const after = await inventory(profile.outputRoot, state);
  if (before.length !== after.length || before.some((entry, i) => entry.relative !== after[i].relative ||
      entry.directory !== after[i].directory || entry.stamp !== after[i].stamp)) throw new ScanError('changed');
  checkTime(state);
  return fingerprint.digest('hex');
}

/** Create one immutable reservation/report outside the inspected tree; originals cannot be overwritten. */
function createStore(approval) {
  const dir = path.resolve(__dirname, '../.tmp/gate1-build-artifact-privacy');
  fs.mkdirSync(dir, { recursive: true });
  const reservation = path.join(dir, `${approval}.reservation.json`);
  fs.writeFileSync(reservation, JSON.stringify({ schemaVersion: 1, approvalId: approval, consumed: true }), { flag: 'wx', mode: 0o600 });
  return {
    /** Save sanitized evidence once; never retry a scan when persistence fails. */
    save(report) {
      const bytes = JSON.stringify(report);
      if (Buffer.byteLength(bytes) > LIMITS.reportBytes) throw new ScanError('report_write');
      fs.writeFileSync(path.join(dir, `gate1-build-artifact-privacy-${approval}.json`), bytes, { flag: 'wx', mode: 0o600 });
    },
  };
}

/** Suppress accidental echoes in attribution and report fields, including encoded comparison strings. */
function hasEcho(report, comparisons) {
  const text = JSON.stringify(report);
  return comparisons.some((ref) => representations(ref.value).some((v) => text.includes(v)));
}

/** Execute only after separate content approval; fixture seams may reduce but never increase bounds. */
async function runInspection(input, options = {}) {
  let store, comparisons = [];
  const report = { schemaVersion: 1, mode: options.storeFactory ? 'fixture' : 'inspect', scope: SCOPE,
    result: 'stopped', gate1Status: 'open', artifactPrivacy: 'unqualified',
    historicalArtifactPrivacy: 'unverified', hostedAttribution: 'not_established',
    provenance: 'operator_attested_new_build_only', appRequests: 0, providerRequests: 0,
    builds: 0, deployments: 0, configMutations: 0, approvalId: null, failure: null,
    limits: LIMITS, files: [], directoryFindings: [], manifestSha256: null, bytesRead: 0, bytesInspected: 0,
    decodedBytes: 0, inlineMaps: 0, coverage: 'unqualified',
    limitations: ['supplied_comparisons_and_fixed_patterns_only', 'binary_contents_not_decompressed_or_decompiled',
      'external_map_sources_not_fetched', 'no_historical_or_hosted_equivalence',
      'exclusive_output_control_required', 'future_upload_requires_fresh_fingerprint_check'] };
  const limits = { ...LIMITS };
  const now = options.now || (() => performance.now());
  const state = { limits, now, started: now(), bytesRead: 0, bytesInspected: 0, decodedBytes: 0, inlineMaps: 0,
    files: report.files, directoryFindings: report.directoryFindings };
  try {
    if (options.limits) for (const [key, value] of Object.entries(options.limits)) {
      if (!(key in limits) || !Number.isSafeInteger(value) || value < 0 || value > limits[key]) throw new ScanError('input');
      limits[key] = value;
    }
    report.limits = limits;
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new ScanError('input');
    comparisons = parsed.data.comparisons;
    const profile = parseProfile(parsed.data.profile);
    if (comparisons.length !== profile.comparisonLabels.length || new Set(comparisons.map((r) => r.label)).size !== comparisons.length ||
        !comparisons.every((r) => profile.comparisonLabels.includes(r.label))) throw new ScanError('comparisons');
    if (hasEcho(profile, comparisons)) throw new ScanError('comparisons');
    if (parsed.data.approval !== approvalId(profile)) throw new ScanError('approval');
    report.approvalId = parsed.data.approval;
    try { store = (options.storeFactory || createStore)(report.approvalId); } catch { throw new ScanError('reservation'); }
    report.target = { environment: profile.environment, ...profile.provenance };
    report.startedAt = new Date().toISOString();
    report.manifestSha256 = await scanOutput(profile, comparisons, state);
    report.coverage = 'selected_directory_inventory_and_supported_representations';
    if (report.directoryFindings.length || report.files.some((f) => f.comparisonLabels.length || f.patterns.length)) throw new ScanError('findings');
    report.result = 'completed'; report.artifactPrivacy = 'no_matches_in_checked_representations';
  } catch (error) { report.failure = error instanceof ScanError ? error.code : 'unreadable'; }
  Object.assign(report, { bytesRead: state.bytesRead, bytesInspected: state.bytesInspected,
    decodedBytes: state.decodedBytes, inlineMaps: state.inlineMaps, elapsedMs: Math.round((now() - state.started) * 1000) / 1000 });
  let output = report;
  if (hasEcho(report, comparisons)) output = { schemaVersion: 1, scope: SCOPE, result: 'stopped', gate1Status: 'open', failure: 'private_output_suppressed' };
  if (store) {
    try { output.reportSaved = true; store.save(output); }
    catch { output.reportSaved = false; output.persistenceFailure = 'report_write'; }
  }
  return output;
}

/** Bound stdin privately with an input deadline; never serialize parser exceptions or payloads. */
async function readInput() {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const timer = setTimeout(() => finish(new ScanError('input')), LIMITS.inputMs);
    /** Remove stream listeners and discard input references once a fixed result is available. */
    function finish(error, result) {
      clearTimeout(timer); process.stdin.removeListener('data', data); process.stdin.removeListener('end', end);
      process.stdin.removeListener('error', failed); process.stdin.pause(); chunks.length = 0;
      if (error) reject(error); else resolve(result);
    }
    /** Accumulate bounded bytes; private input never reaches diagnostic output. */
    function data(chunk) {
      size += chunk.length;
      if (size > LIMITS.inputBytes) finish(new ScanError('input')); else chunks.push(chunk);
    }
    /** Parse the complete envelope without printing invalid input. */
    function end() {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new ScanError('input')); }
    }
    /** Replace stream errors with the fixed input failure. */
    function failed() { finish(new ScanError('input')); }
    process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.once('error', failed);
  });
}

/** Default to an unapproved template; a preparation can never accidentally start content inspection. */
async function main(args) {
  if (args.length > 1 || (args.length && !['--template', '--prepare', '--inspect'].includes(args[0]))) throw new ScanError('input');
  if (!args.length || args[0] === '--template') return profileTemplate();
  const input = await readInput();
  return args[0] === '--prepare' ? preparation(input) : runInspection(input);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((report) => {
    const text = JSON.stringify(report);
    if (Buffer.byteLength(text) > LIMITS.reportBytes) throw new ScanError('report_write');
    process.stdout.write(text + '\n');
    if (report.result === 'stopped' || report.persistenceFailure) process.exitCode = 1;
  }).catch(() => { process.stderr.write('Artifact preparation/inspection failed; preserve any consumed reservation.\n'); process.exitCode = 1; });
}

module.exports = { SCOPE, LIMITS, LABELS, ATTESTATIONS, ScanError, profileTemplate, parseProfile,
  approvalId, preparation, compareBytes, representations, inventory, readStable,
  inspectFile, scanOutput, runInspection, createStore, main };
