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
const LINK_POLICY = 'internal_directory_aliases_v1';
const FILE_PATH_MAP_POLICY = 'inventoried_output_targets_v1';
const SOURCE_MAP_POLICY = 'emitted_inventory_v1';
const SOURCE_MAP_LIMITATIONS = Object.freeze(['absent_local_source_maps_not_inspected',
  'source_mapping_url_matches_are_syntactic_not_lexical']);
const LIMITS = Object.freeze({ maxAppRequests: 0, maxProviderRequests: 0, maxConfigMutations: 0,
  maxBuilds: 0, maxDeployments: 0, maxFiles: 25000, maxEntries: 50000, maxDepth: 64,
  fileBytes: 67108864, totalBytes: 1073741824, overallMs: 120000, concurrency: 1,
  inputBytes: 65536, reportBytes: 8388608, jsonNodes: 100000, inputMs: 10000,
  mappingReferences: 100000, mappedEntries: 200000, mappingPathBytes: 4096, mappedPathBytes: 67108864 });
const LABELS = Object.freeze(['ceiling_hmac', 'redis_token', 'supabase_service_role', 'csrf_secret',
  'secrets_probe', 'automation_bypass', 'synthetic_sentinel']);
const ATTESTATIONS = Object.freeze(['sourceCodeReviewed', 'newBuildProvenanceReviewed',
  'comparisonSelectionReviewed', 'exclusiveOutputControl', 'noEnvironmentFiles',
  'privateOutputAccessReviewed', 'coverageLimitationsReviewed']);
const CODES = new Set(['profile', 'input', 'approval', 'comparisons', 'reservation', 'report_write',
  'overall_deadline', 'entry_limit', 'file_limit', 'depth_limit', 'file_size', 'total_bytes',
  'forbidden_file', 'link', 'path', 'file_type', 'unreadable', 'changed', 'unsupported_format',
  'encoding', 'json', 'map_contract', 'external_map', 'config', 'findings', 'internal',
  'alias_target', 'alias_chain', 'alias_cycle']);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/).max(64);
const profileSchema = z.object({ schemaVersion: z.literal(1), scope: z.literal(SCOPE),
  runId: z.string().regex(/^[a-f0-9]{32}$/), environment: z.literal('preview'),
  outputRoot: z.string().min(1).max(1024).refine((s) => !hasControl(s)),
  linkPolicy: z.enum(['reject', LINK_POLICY]).optional(),
  filePathMapPolicy: z.enum(['reject', FILE_PATH_MAP_POLICY]).optional(),
  sourceMapPolicy: z.enum(['reject', SOURCE_MAP_POLICY]).optional(),
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
  if (p.filePathMapPolicy === FILE_PATH_MAP_POLICY && p.provenance.vercelCliVersion !== '50.33.1') throw new ScanError('profile');
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
  const integrity = ['gate1-build-artifact-privacy.js', 'run-gate1-build-artifact-privacy.ps1',
    'gate1-build-qualification.js', 'run-gate1-build-qualification.ps1',
    'gate1-build-qualification.Dockerfile', '../package-lock.json']
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

/** Prepare transient per-run comparison encodings; callers erase these private buffers after inspection. */
function compileComparisons(comparisons) {
  return comparisons.map(ref => ({ label: ref.label, forms: representations(ref.value).map(value => Buffer.from(value)) }));
}

/** Match byte strings and fixed ASCII patterns; cached encodings never enter reports or module state. */
function compareBytes(bytes, comparisons, compiled) {
  const labels = compiled ? compiled.filter(ref => ref.forms.some(value => bytes.includes(value))).map(ref => ref.label) :
    comparisons.filter(ref => representations(ref.value).some(value => bytes.includes(Buffer.from(value)))).map(ref => ref.label);
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
  const rootStat = await fs.promises.lstat(root);
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
      if (/[\\:]/.test(entry.name) || hasControl(entry.name)) throw new ScanError('path');
      const absolute = path.join(dir.absolute, entry.name);
      const relative = path.join(dir.relative, entry.name);
      const stat = await fs.promises.lstat(absolute);
      if (stat.dev !== rootStat.dev) throw new ScanError('path');
      if (stat.isSymbolicLink()) {
        if (state.linkPolicy !== LINK_POLICY) throw new ScanError('link');
        if (stat.size > Math.min(4096, state.limits.fileBytes)) throw new ScanError('file_size');
        const bytes = await fs.promises.readlink(absolute, { encoding: 'buffer' });
        if (bytes.length > Math.min(4096, state.limits.fileBytes)) throw new ScanError('file_size');
        charge(state, bytes.length, true);
        const target = decode(bytes);
        await checkAncestors(dir.absolute, state);
        if (stamp(await fs.promises.lstat(absolute)) !== stamp(stat)) throw new ScanError('changed');
        entries.push({ relative, absolute, directory: false, alias: true, target,
          stamp: stamp(stat), size: stat.size, mode: stat.mode & 0o777 });
        continue;
      }
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
  entries.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  entries.rootStamp = stamp(rootStat);
  entries.rootMode = rootStat.mode & 0o777;
  if (state.linkPolicy === LINK_POLICY) resolveAliases(entries, state);
  return entries;
}

/** Resolve relative targets against independently inventoried directories, never following a link on disk.
 * Each component is checked before processing the next (including '..'); no outside metadata is requested.
 */
function resolveAliases(entries, state) {
  const physical = new Map(entries.map((entry) => [entry.relative, entry]));
  for (const alias of entries.filter((entry) => entry.alias)) {
    checkTime(state);
    if (!alias.target || path.isAbsolute(alias.target) || /[\\:]/.test(alias.target) || hasControl(alias.target)) {
      throw new ScanError('alias_target');
    }
    const parts = alias.target.split('/');
    if (parts.length > state.limits.maxDepth) throw new ScanError('depth_limit');
    const resolved = path.dirname(alias.relative) === '.' ? [] : path.dirname(alias.relative).split(path.sep);
    for (const part of parts) {
      checkTime(state);
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!resolved.length) throw new ScanError('alias_target');
        resolved.pop();
      } else {
        if (forbidden(part)) throw new ScanError('forbidden_file');
        resolved.push(part);
        const target = physical.get(resolved.join(path.sep));
        if (target?.alias) throw new ScanError('alias_chain');
        if (!target?.directory) throw new ScanError('alias_target');
      }
      if (resolved.length > state.limits.maxDepth) throw new ScanError('depth_limit');
    }
    alias.targetRelative = resolved.join(path.sep);
    alias.targetStamp = alias.targetRelative ? physical.get(alias.targetRelative)?.stamp : entries.rootStamp;
    if (!alias.targetStamp) throw new ScanError('alias_target');
  }
}

/** Record only finite findings for physical names, link text and expanded logical paths; charge all bytes. */
function inspectPathText(text, comparisons, state, charged = false) {
  const bytes = Buffer.from(text.split(path.sep).join('/'));
  if (!charged) charge(state, bytes.length, true);
  const matches = compareBytes(bytes, comparisons, state.compiledComparisons);
  if ((matches.labels.length || matches.patterns.length) && state.directoryFindings.length >= state.limits.maxEntries) {
    throw new ScanError('entry_limit');
  }
  if (matches.labels.length || matches.patterns.length) state.directoryFindings.push({
    id: state.directoryFindings.length + 1, comparisonLabels: matches.labels, patterns: matches.patterns });
}

/** Expand a bounded logical directory graph without filesystem traversal; every logical file maps to one
 * physical inventory entry. Repeated directory ancestry rejects cycles, while independent aliases share reads.
 */
function aliasCoverage(entries, comparisons, state) {
  const children = new Map(), knownFiles = new Set(), locations = new Map(), nodes = new Map(), logicalChildren = new Map();
  for (const entry of entries) {
    const parent = path.dirname(entry.relative) === '.' ? '' : path.dirname(entry.relative);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(entry);
    if (entry.alias) inspectPathText(entry.target, comparisons, state);
  }
  const queue = [{ physical: '', logical: '', ancestors: [''], depth: 0 }];
  let count = 0, files = 0;
  for (let head = 0; head < queue.length; head++) {
    checkTime(state);
    const dir = queue[head]; queue[head] = undefined;
    for (const entry of children.get(dir.physical) || []) {
      checkTime(state);
      if (count >= state.limits.maxEntries) throw new ScanError('entry_limit');
      state.logicalEntries = ++count;
      const relative = path.join(dir.logical, path.basename(entry.relative));
      if (dir.depth + 1 > state.limits.maxDepth) throw new ScanError('depth_limit');
      inspectPathText(relative, comparisons, state);
      nodes.set(relative, entry);
      if (!logicalChildren.has(dir.logical)) logicalChildren.set(dir.logical, []);
      logicalChildren.get(dir.logical).push(relative);
      if (entry.directory || entry.alias) {
        const target = entry.alias ? entry.targetRelative : entry.relative;
        if (dir.ancestors.includes(target)) throw new ScanError('alias_cycle');
        queue.push({ physical: target, logical: relative, ancestors: [...dir.ancestors, target], depth: dir.depth + 1 });
      } else {
        if (++files > state.limits.maxFiles) throw new ScanError('file_limit');
        knownFiles.add(relative);
        if (!locations.has(entry.relative)) locations.set(entry.relative, new Set());
        locations.get(entry.relative).add(relative);
      }
    }
  }
  state.logicalEntries = count;
  return { knownFiles, locations, nodes, children: logicalChildren };
}

/** Accept only canonical POSIX names for the pinned mapping contract; never normalize ambiguous input.
 * Keys are function-relative, values are repository-relative under the fixed output prefix.
 */
function mappingPath(value, state) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > state.limits.mappingPathBytes ||
      /[\\:%?#]/.test(value) || hasControl(value)) throw new ScanError('external_map');
  const parts = value.split('/');
  if (parts.length > state.limits.maxDepth) throw new ScanError('depth_limit');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new ScanError('external_map');
  if (parts.some(forbidden)) throw new ScanError('forbidden_file');
  return parts.join(path.sep);
}

/** Cover a function's effective mappings using the already expanded inventory, never filesystem targets.
 * Each projected descendant is bounded and inspected. Conflicting destinations and format changes stop;
 * virtual mappings are never recursively resolved, so they cannot create an unbounded mapping graph.
 */
function coverFilePathMap(value, entry, coverage, comparisons, state, projected) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'filePathMap')) return;
  const map = value.filePathMap;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new ScanError('map_contract');
  const pairs = Object.entries(map);
  if (!pairs.length) return;
  const parent = path.dirname(entry.relative);
  if (entry.relative.split(path.sep)[0] !== 'functions' || !parent.endsWith('.func')) throw new ScanError('external_map');
  for (const [key, target] of pairs) {
    checkTime(state);
    if (state.mappingReferences >= state.limits.mappingReferences) throw new ScanError('entry_limit');
    state.mappingReferences++;
    const local = mappingPath(key, state);
    if (typeof target !== 'string' || !target.startsWith('.vercel/output/')) throw new ScanError('external_map');
    mappingPath(target, state);
    const source = mappingPath(target.slice(15), state), destination = path.join(parent, local);
    const queue = []; let head = 0;
    /** Reserve pending expansion and destination bytes before queue growth; duplicate visits still count. */
    function enqueue(sourceName, destinationName) {
      checkTime(state);
      if (state.mappedEntries + queue.length - head >= state.limits.mappedEntries) throw new ScanError('entry_limit');
      const logical = destinationName.split(path.sep).join('/');
      mappingPath(logical, state);
      const length = Buffer.byteLength(logical);
      if (state.mappedPathBytes + length > state.limits.mappedPathBytes) throw new ScanError('total_bytes');
      charge(state, length, true); state.mappedPathBytes += length;
      queue.push({ source: sourceName, destination: destinationName });
    }
    enqueue(source, destination);
    while (head < queue.length) {
      checkTime(state);
      state.mappedEntries++;
      const item = queue[head]; queue[head++] = undefined;
      const node = coverage.nodes.get(item.source);
      if (!node) throw new ScanError('external_map');
      inspectPathText(item.destination, comparisons, state, true);
      const directory = node.directory || node.alias;
      const identity = directory ? (node.alias ? node.targetRelative : node.relative) : node.relative;
      const existing = projected.get(item.destination) || coverage.nodes.get(item.destination);
      if (existing) {
        const existingDirectory = Boolean(existing.directory || existing.alias);
        const existingIdentity = existing.alias ? existing.targetRelative : existing.relative;
        if (existingDirectory !== Boolean(directory) || existingIdentity !== identity) throw new ScanError('external_map');
      }
      // Implicit parents may merge inventoried directories/aliases, but never a regular file.
      let ancestor = path.dirname(item.destination);
      while (ancestor !== '.' && ancestor !== parent) {
        const prior = projected.get(ancestor) || coverage.nodes.get(ancestor);
        if (prior && !prior.directory && !prior.alias) throw new ScanError('external_map');
        ancestor = path.dirname(ancestor);
      }
      projected.set(item.destination, { directory: Boolean(directory), relative: identity });
      if (directory) {
        for (const child of coverage.children.get(item.source) || []) {
          enqueue(child, path.join(item.destination, path.basename(child)));
        }
      } else {
        if (path.extname(node.relative).toLowerCase() !== path.extname(item.destination).toLowerCase() ||
            path.basename(item.destination) === '.vc-config.json' || path.basename(node.relative) === '.vc-config.json') {
          throw new ScanError('external_map');
        }
        coverage.knownFiles.add(item.destination);
        const locations = coverage.locations.get(node.relative);
        if (!locations) throw new ScanError('external_map');
        locations.add(item.destination);
      }
    }
  }
  state.filePathMaps++;
}

/** Read only inventoried function configurations before file inspection, to establish all mapped contexts.
 * The ordinary pass rereads/stamp-checks these files and retains their privacy findings; a failed prepass
 * remains unqualified. Empty directories are covered by inventory, name inspection and final mutation checks.
 */
async function prepareFilePathMaps(files, coverage, comparisons, state) {
  const projected = new Map();
  for (const entry of files.filter(item => path.basename(item.relative) === '.vc-config.json')) {
    const bytes = await readStable(entry, state);
    try {
      const value = scanJson(decode(bytes), { labels: new Set(), patterns: new Set() }, comparisons, state, false);
      for (const relative of coverage.locations.get(entry.relative) || []) {
        coverFilePathMap(value, { relative }, coverage, comparisons, state, projected);
      }
    } finally { bytes.fill(0); }
  }
  // Catch reversed insertion order too: a file cannot become the parent of any mapped entry.
  for (const relative of projected.keys()) {
    checkTime(state);
    let ancestor = path.dirname(relative);
    while (ancestor !== '.') {
      const prior = projected.get(ancestor) || coverage.nodes.get(ancestor);
      if (prior && !prior.directory && !prior.alias) throw new ScanError('external_map');
      ancestor = path.dirname(ancestor);
    }
  }
  coverage.projected = projected;
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
      const result = compareBytes(bytes, comparisons, state.compiledComparisons);
      result.labels.forEach((s) => findings.labels.add(s)); result.patterns.forEach((s) => findings.patterns.add(s));
    } else if (item.value && typeof item.value === 'object') {
      const pairs = Object.entries(item.value);
      if (pairs.length + stack.length + nodes > state.limits.jsonNodes) throw new ScanError('json');
      for (const [key, child] of pairs) {
        // Object keys can themselves contain encoded private data.
        const bytes = Buffer.from(key); charge(state, bytes.length, true);
        const result = compareBytes(bytes, comparisons, state.compiledComparisons);
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
    const result = compareBytes(bytes, comparisons, state.compiledComparisons);
    result.labels.forEach((s) => findings.labels.add(s)); result.patterns.forEach((s) => findings.patterns.add(s));
  }
  inspectJson(value, findings, comparisons, state);
  return value;
}

/** Classify absence using only inventoried names, including implicit projected parents. Binary
 * searches avoid expanding every parent; known file ancestors cannot masquerade as absent targets.
 */
function absentMapTarget(relative, knownFiles, state) {
  const names = state.sourceMapPaths;
  if (!Array.isArray(names)) throw new ScanError('external_map');
  for (const query of [relative, relative + path.sep]) {
    let low = 0, high = names.length;
    while (low < high) {
      checkTime(state); const middle = Math.floor((low + high) / 2);
      if (names[middle] < query) low = middle + 1; else high = middle;
    }
    if (names[low] === relative || (query !== relative && names[low]?.startsWith(query))) return false;
  }
  let ancestor = path.dirname(relative);
  while (ancestor !== '.') {
    checkTime(state);
    if (knownFiles.has(ancestor)) return false;
    ancestor = path.dirname(ancestor);
  }
  return true;
}

/** Parse each physical file's references once. Inline data is context-independent; every logical
 * destination still resolves each external reference against the complete inventory, with deadline checks.
 */
function inspectMapLinks(text, entry, knownFiles, findings, comparisons, state, locations = [entry.relative]) {
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
      const emitted = state.sourceMapPolicy === SOURCE_MAP_POLICY;
      if (emitted && ++state.sourceMapReferences > state.limits.totalBytes) throw new ScanError('total_bytes');
      if (/[\\?#:]/.test(ref) || ref.startsWith('//')) throw new ScanError('external_map');
      let local;
      try { local = decodeURIComponent(ref); } catch { throw new ScanError('external_map'); }
      if (/[\\?#:]/.test(local) || hasControl(local) || local.startsWith('//')) throw new ScanError('external_map');
      let missingReference = false;
      for (const location of locations) {
        checkTime(state);
        const relative = local.startsWith('/') ? path.join('static', local.slice(1)) : path.join(path.dirname(location), local);
        if (emitted) {
          const bytes = Buffer.from(relative.split(path.sep).join('/'));
          charge(state, bytes.length, true);
          if (++state.sourceMapContexts > state.limits.totalBytes) throw new ScanError('total_bytes');
          const result = compareBytes(bytes, comparisons, state.compiledComparisons);
          result.labels.forEach(s => findings.labels.add(s)); result.patterns.forEach(s => findings.patterns.add(s));
          bytes.fill(0);
        }
        if (relative.startsWith('..') || path.isAbsolute(relative) || !/\.map$/i.test(relative)) {
          throw new ScanError('external_map');
        }
        if (!knownFiles.has(relative)) {
          if (!emitted || !absentMapTarget(relative, knownFiles, state)) throw new ScanError('external_map');
          state.missingLocalMapContexts++;
          if (!missingReference) { state.missingLocalMapReferences++; missingReference = true; }
        }
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
function inspectFile(bytes, entry, knownFiles, comparisons, state, locations) {
  const raw = compareBytes(bytes, comparisons, state.compiledComparisons);
  const findings = { labels: new Set(raw.labels), patterns: new Set(raw.patterns) };
  const nameBytes = Buffer.from(entry.relative.split(path.sep).join('/'));
  charge(state, nameBytes.length, true);
  const names = compareBytes(nameBytes, comparisons, state.compiledComparisons);
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
        Object.hasOwn(value, 'filePathMap') && Object.keys(value.filePathMap || {}).length &&
        state.filePathMapPolicy !== FILE_PATH_MAP_POLICY) {
      throw new ScanError('external_map');
    }
  }
  if (/\.(?:[cm]?js|css|html)$/i.test(entry.relative)) inspectMapLinks(text, entry, knownFiles, findings, comparisons, state, locations);
  return { findings, format: 'utf8_and_decoded_json' };
}

/** Enumerate before/after, inspect each file, and fingerprint relative paths privately with content hashes. */
async function scanOutput(profile, comparisons, state) {
  const before = await inventory(profile.outputRoot, state);
  const files = before.filter((entry) => !entry.directory && !entry.alias);
  const coverage = state.linkPolicy === LINK_POLICY || state.filePathMapPolicy === FILE_PATH_MAP_POLICY ? aliasCoverage(before, comparisons, state) : null;
  if (state.filePathMapPolicy === FILE_PATH_MAP_POLICY) await prepareFilePathMaps(files, coverage, comparisons, state);
  const knownFiles = coverage?.knownFiles || new Set(files.map((entry) => entry.relative));
  if (state.sourceMapPolicy === SOURCE_MAP_POLICY) {
    // At most the existing logical-entry and mapped-visit caps; no new filesystem enumeration.
    state.sourceMapPaths = [...new Set([...before.map(entry => entry.relative),
      ...(coverage?.nodes.keys() || []), ...(coverage?.projected?.keys() || [])])].sort();
    if (state.sourceMapPaths.length > state.limits.maxEntries * 2 + state.limits.mappedEntries) throw new ScanError('entry_limit');
    checkTime(state);
  }
  if (!knownFiles.has('config.json')) throw new ScanError('config');
  const fingerprint = createHash('sha256');
  for (const entry of before.filter((item) => item.alias)) {
    fingerprint.update(JSON.stringify([entry.relative.split(path.sep).join('/'), 'directory_alias',
      entry.target, entry.targetRelative.split(path.sep).join('/')]) + '\n');
  }
  for (const entry of before.filter((item) => item.directory)) {
    if (!coverage) inspectPathText(entry.relative, comparisons, state);
    fingerprint.update(JSON.stringify([entry.relative.split(path.sep).join('/'), 'directory', entry.mode]) + '\n');
  }
  for (const entry of files) {
    const bytes = await readStable(entry, state);
    const contentHash = sha256(bytes);
    entry.contentHash = contentHash;
    const { findings, format } = inspectFile(bytes, entry, knownFiles, comparisons, state, coverage?.locations.get(entry.relative));
    fingerprint.update(JSON.stringify([entry.relative.split(path.sep).join('/'), 'file', entry.mode, bytes.length, contentHash]) + '\n');
    state.files.push({ id: state.files.length + 1, category: category(entry.relative), bytes: bytes.length,
      sha256: contentHash, mode: entry.mode, format, comparisonLabels: [...findings.labels].sort(), patterns: [...findings.patterns].sort() });
    bytes.fill(0); checkTime(state);
  }
  const after = await inventory(profile.outputRoot, state);
  if (before.rootStamp !== after.rootStamp || before.length !== after.length || before.some((entry, i) => entry.relative !== after[i].relative ||
      entry.directory !== after[i].directory || entry.stamp !== after[i].stamp || entry.target !== after[i].target ||
      entry.targetRelative !== after[i].targetRelative || entry.targetStamp !== after[i].targetStamp)) throw new ScanError('changed');
  checkTime(state);
  if (state.filePathMapPolicy === FILE_PATH_MAP_POLICY) {
    // Match the independent-copy manifest from these exact scanned bytes, closing the gap between
    // preverification and scan inventory without another content read or disclosure of individual hashes.
    const copyFingerprint = createHash('sha256');
    copyFingerprint.update(JSON.stringify(['', 'directory', before.rootMode]) + '\n');
    for (const entry of before) {
      checkTime(state);
      copyFingerprint.update(JSON.stringify([entry.relative.split(path.sep).join('/'),
        entry.alias ? 'alias' : entry.directory ? 'directory' : 'file', entry.mode,
        entry.directory || entry.alias ? null : entry.size, entry.alias ? entry.target : null, entry.contentHash || null]) + '\n');
    }
    state.inspectedCopyManifestSha256 = copyFingerprint.digest('hex');
  }
  state.aliasesVerified = before.filter((entry) => entry.alias).length;
  state.mappingsVerified = state.mappingReferences;
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
    mappingReferences: 0, mappedEntries: 0, mappedPathBytes: 0, filePathMaps: 0, mappingsVerified: 0,
    sourceMapReferences: 0, sourceMapContexts: 0, missingLocalMapReferences: 0, missingLocalMapContexts: 0,
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
    state.linkPolicy = profile.linkPolicy || 'reject';
    state.filePathMapPolicy = profile.filePathMapPolicy || 'reject';
    state.sourceMapPolicy = profile.sourceMapPolicy || 'reject';
    if (state.sourceMapPolicy === SOURCE_MAP_POLICY) {
      report.sourceMapPolicy = SOURCE_MAP_POLICY;
      report.limitations.push(...SOURCE_MAP_LIMITATIONS);
    }
    if (state.filePathMapPolicy === FILE_PATH_MAP_POLICY) report.filePathMapPolicy = FILE_PATH_MAP_POLICY;
    if (state.linkPolicy === LINK_POLICY) Object.assign(report, { linkPolicy: LINK_POLICY, aliasesVerified: 0, logicalEntries: 0 });
    if (comparisons.length !== profile.comparisonLabels.length || new Set(comparisons.map((r) => r.label)).size !== comparisons.length ||
        !comparisons.every((r) => profile.comparisonLabels.includes(r.label))) throw new ScanError('comparisons');
    if (hasEcho(profile, comparisons)) throw new ScanError('comparisons');
    if (parsed.data.approval !== approvalId(profile)) throw new ScanError('approval');
    state.compiledComparisons = compileComparisons(comparisons);
    report.approvalId = parsed.data.approval;
    try { store = (options.storeFactory || createStore)(report.approvalId); } catch { throw new ScanError('reservation'); }
    report.target = { environment: profile.environment, ...profile.provenance };
    report.startedAt = new Date().toISOString();
    report.manifestSha256 = await scanOutput(profile, comparisons, state);
    report.coverage = 'selected_directory_inventory_and_supported_representations';
    if (report.directoryFindings.length || report.files.some((f) => f.comparisonLabels.length || f.patterns.length)) throw new ScanError('findings');
    report.result = 'completed'; report.artifactPrivacy = 'no_matches_in_checked_representations';
  } catch (error) { report.failure = error instanceof ScanError ? error.code : 'unreadable'; }
  finally { for (const ref of state.compiledComparisons || []) for (const bytes of ref.forms) bytes.fill(0); }
  Object.assign(report, { bytesRead: state.bytesRead, bytesInspected: state.bytesInspected,
    decodedBytes: state.decodedBytes, inlineMaps: state.inlineMaps, elapsedMs: Math.round((now() - state.started) * 1000) / 1000 });
  if (report.linkPolicy) Object.assign(report, { aliasesVerified: state.aliasesVerified || 0, logicalEntries: state.logicalEntries || 0 });
  if (report.filePathMapPolicy) Object.assign(report, { filePathMaps: state.filePathMaps,
    mappingReferences: state.mappingReferences, mappedEntries: state.mappedEntries, mappedPathBytes: state.mappedPathBytes,
    mappingsVerified: state.mappingsVerified,
    inspectedCopyManifestSha256: state.inspectedCopyManifestSha256 || null });
  if (report.sourceMapPolicy) Object.assign(report, { sourceMapReferences: state.sourceMapReferences,
    sourceMapContexts: state.sourceMapContexts, missingLocalMapReferences: state.missingLocalMapReferences,
    missingLocalMapContexts: state.missingLocalMapContexts,
    sourceMapAvailability: report.coverage === 'unqualified' ? 'unqualified' :
      state.missingLocalMapContexts ? 'absent_local_targets' : 'all_matched_targets_present' });
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

module.exports = { SCOPE, LINK_POLICY, FILE_PATH_MAP_POLICY, SOURCE_MAP_POLICY, SOURCE_MAP_LIMITATIONS, LIMITS, LABELS, ATTESTATIONS, ScanError, profileTemplate, parseProfile,
  approvalId, preparation, compareBytes, representations, inventory, readStable,
  inspectFile, scanOutput, runInspection, createStore, main };
