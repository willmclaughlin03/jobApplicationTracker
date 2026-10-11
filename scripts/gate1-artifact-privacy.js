'use strict';

/**
 * Offline-default, deployment-bound browser artifact privacy diagnostic.
 * A separately approved run reads login HTML, its script references and explicitly linked maps.
 * It never executes JavaScript, enumerates guessed URLs, fetches source-map sources or reads env files.
 * Coverage excludes lazy chunks, other routes, unlinked maps, server artifacts and logs.
 */
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { TextDecoder } = require('node:util');
const { z } = require('zod');
const { loginBuild } = require('./gate1-host-protection');

const LIMITS = Object.freeze({ htmlRequests: 4, assetRequests: 64, maxRequests: 68,
  maxProviderRequests: 0, maxConfigMutations: 0, concurrency: 1,
  requestMs: 10000, overallMs: 300000, htmlBytes: 1048576, assetBytes: 4194304,
  totalBytes: 41943040, headerBytes: 16384, inputBytes: 131072, reportBytes: 65536 });
const TARGETS = Object.freeze([
  Object.freeze({ environment: 'production', deploymentId: 'dpl_DazMBQ2wWdfB9U4ntGzVp18mXEYk',
    hostname: 'job-application-tracker-h4ly6ufvr-track-the-app.vercel.app',
    gitSha: '975a17898c8887a23fb62cb3f36305d1a416d8ad', nextBuildId: 'z2x35luO6lyz3q6Vwc--O' }),
  Object.freeze({ environment: 'preview', deploymentId: 'dpl_2G5y4AiwJZU2RhDBujm9ZFb6vkjh',
    hostname: 'job-application-tracker-pmpzlpery-track-the-app.vercel.app',
    gitSha: 'a4a576b32a20345ebd76f788fe415c239352974a', nextBuildId: 'datrYVSKClFsT83wNRj89' }),
]);
const LABELS = Object.freeze(['hmac_active_key', 'redis_token', 'supabase_service_role_key',
  'csrf_secret', 'secrets_probe_secret', 'source_probe_secret', 'restart_probe_secret']);
const ATTESTATIONS = Object.freeze(['sourceCodeReviewed', 'historicalTargetsReviewed',
  'protectionAccessApproved', 'privateComparisonValuesReviewed', 'credentialLoggingReviewed',
  'boundedContentAccessReviewed', 'coverageLimitationsReviewed']);
const CODES = new Set(['input', 'profile', 'approval', 'credentials', 'reservation', 'report_write',
  'cancelled', 'request_timeout', 'overall_deadline', 'transport', 'headers', 'encoding',
  'body_size', 'total_bytes', 'request_limit', 'incomplete_body', 'http_status', 'content_type',
  'build_mismatch', 'unsafe_reference', 'html_contract', 'no_scripts', 'reference_changed',
  'map_contract', 'sensitive_content', 'internal']);
const environmentSchema = z.enum(['production', 'preview']);
const comparisonSchema = z.object({ environment: environmentSchema, label: z.enum(LABELS) }).strict();
const profileSchema = z.object({ schemaVersion: z.literal(1),
  scope: z.literal('referenced_login_browser_artifacts_only'),
  runId: z.string().regex(/^[a-f0-9]{32}$/),
  targets: z.tuple(TARGETS.map((target) => z.object(Object.fromEntries(
    Object.entries(target).map(([key, value]) => [key, z.literal(value)]))).strict())),
  comparisons: z.array(comparisonSchema).min(2).max(14),
  attestations: z.object(Object.fromEntries(ATTESTATIONS.map((key) => [key, z.literal(true)]))).strict(),
}).strict();

/** Retain only reviewed failure codes across transport, parser and CLI error boundaries. */
class ArtifactError extends Error {
  /** Normalize code without preserving an underlying message or stack in evidence. */
  constructor(code) { super(CODES.has(code) ? code : 'internal'); this.code = this.message; }
}

/** Digest reviewed bytes for artifact attribution and offline approval binding. */
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

/** Reject control bytes without accepting invisible credential or URL separators. */
function hasControl(value) { return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127); }

/** Build a non-approved profile; comparison labels describe private inputs, never their values. */
function profileTemplate() {
  return { schemaVersion: 1, scope: 'referenced_login_browser_artifacts_only',
    runId: randomBytes(16).toString('hex'), targets: TARGETS.map((item) => ({ ...item })),
    comparisons: [{ environment: 'production', label: 'hmac_active_key' },
      { environment: 'production', label: 'redis_token' },
      { environment: 'preview', label: 'hmac_active_key' }],
    attestations: Object.fromEntries(ATTESTATIONS.map((key) => [key, false])) };
}

/** Reject scope changes, duplicate comparison labels or a target with no comparison coverage. */
function parseProfile(value) {
  const result = profileSchema.safeParse(value);
  if (!result.success) throw new ArtifactError('profile');
  const profile = result.data;
  const keys = profile.comparisons.map((entry) => `${entry.environment}:${entry.label}`);
  if (new Set(keys).size !== keys.length || TARGETS.some((target) =>
    !profile.comparisons.some((entry) => entry.environment === target.environment))) throw new ArtifactError('profile');
  return profile;
}

/** Bind approval to all executable diagnostic dependencies; no credentials or secret hashes enter it. */
function approvalId(value) {
  const profile = parseProfile(value);
  // loginBuild is independent of the host runner's optional, local-only inventory.
  const files = ['gate1-artifact-privacy.js', 'run-gate1-artifact-privacy.ps1', 'gate1-host-protection.js'];
  const integrity = files.map((name) => sha256(fs.readFileSync(path.join(__dirname, name))));
  return sha256(JSON.stringify({ profile, limits: LIMITS, integrity }));
}

/** Review locally; immutable target binding has no arbitrary fifteen-minute evidence expiry. */
function preparation(value) {
  const profile = parseProfile(value);
  return { schemaVersion: 1, mode: 'prepare', profile, approvalId: approvalId(profile), limits: LIMITS,
    liveApproved: false, appRequests: 0, providerRequests: 0, gate1Status: 'open',
    nextStep: 'obtain_separate_live_approval',
    coverage: 'login_html_referenced_scripts_and_explicitly_linked_maps_only' };
}

/** Restrict every credential-bearing request to a pinned origin and ASCII static asset path. */
function assetUrl(reference, base, kind, target) {
  if (typeof reference !== 'string' || reference.length > 2048 ||
    hasControl(reference) || /[\s\\%?#&]/.test(reference) || reference.startsWith('//') ||
    reference.split('/').some((part) => part === '.' || part === '..')) throw new ArtifactError('unsafe_reference');
  let url;
  try { url = new URL(reference, base); } catch { throw new ArtifactError('unsafe_reference'); }
  if (url.origin !== `https://${target.hostname}` || url.username || url.password ||
    !/^\/_next\/static\/[A-Za-z0-9_./-]+$/.test(url.pathname) || url.pathname.includes('//') ||
    !url.pathname.endsWith(kind === 'map' ? '.map' : '.js')) throw new ArtifactError('unsafe_reference');
  return url.href;
}

/** Parse conservative HTML attributes; malformed/duplicate syntax cannot silently expand coverage. */
function attributes(text) {
  const result = Object.create(null);
  const remaining = text.replace(/\s+\/$/, '').trimEnd();
  const tokens = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
  let position = 0;
  while (position < remaining.length) {
    tokens.lastIndex = position;
    const match = tokens.exec(remaining);
    if (!match) throw new ArtifactError('html_contract');
    const key = match[1].toLowerCase();
    if (Object.hasOwn(result, key)) throw new ArtifactError('html_contract');
    result[key] = match[2] ?? match[3] ?? match[4] ?? '';
    position = tokens.lastIndex;
  }
  return result;
}

/** Discover script tags and script preloads without executing JS or following ordinary navigation. */
function discoverScripts(text, target) {
  const urls = new Set();
  const tags = /<!--[\s\S]*?-->|<(script|style|textarea|title)\b((?:[^>"']|"[^"]*"|'[^']*')*)>[\s\S]*?<\/\1\s*>|<link\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  for (const match of text.matchAll(tags)) {
    if (!match[1] && match[3] === undefined) continue;
    if (match[1] && match[1].toLowerCase() !== 'script') continue;
    const attrs = attributes(match[2] ?? match[3]);
    const script = match[1] !== undefined;
    const preload = attrs.rel?.toLowerCase() === 'modulepreload' ||
      (attrs.rel?.toLowerCase() === 'preload' && attrs.as?.toLowerCase() === 'script');
    const reference = script ? attrs.src : preload ? attrs.href : undefined;
    if (reference !== undefined) urls.add(assetUrl(reference, `https://${target.hostname}/login`, 'script', target));
  }
  if (!urls.size) throw new ArtifactError('no_scripts');
  return [...urls].sort();
}

/** Follow only explicitly advertised source-map locations; never guess .map or fetch sources. */
function discoverMaps(text, headers, base, target) {
  const refs = [headers.sourcemap, headers['x-sourcemap']].filter((value) => value !== undefined);
  for (const match of text.matchAll(/(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL\s*=\s*([^\s*]+)/g)) refs.push(match[1]);
  return [...new Set(refs.map((ref) => assetUrl(ref, base, 'map', target)))];
}

/** Compare defined representations plus conservative credential patterns; never emit matched text. */
function scanText(text, references) {
  const labels = [];
  for (const ref of references) {
    const variants = [ref.value, JSON.stringify(ref.value).slice(1, -1), encodeURIComponent(ref.value),
      Buffer.from(ref.value).toString('base64'), Buffer.from(ref.value).toString('base64url')];
    if (variants.some((value) => text.includes(value))) labels.push(ref.label);
  }
  const patterns = [];
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) patterns.push('private_key');
  if (/\b(?:sk_live_|sk_test_|sb_secret_)[A-Za-z0-9_-]{16,}/.test(text)) patterns.push('secret_token_pattern');
  if (/\b(?:redis|rediss):\/\/[^\s"'<>]*:[^\s"'<>]+@/i.test(text)) patterns.push('redis_credential_uri');
  return { comparisonLabels: [...new Set(labels)], patterns };
}

/** Scan embedded map sources as decoded JSON strings too; do not resolve sourceRoot or source paths. */
function inspectBody(text, kind, references) {
  const findings = scanText(text, references);
  if (kind === 'map') {
    let map;
    try { map = JSON.parse(text); } catch { throw new ArtifactError('map_contract'); }
    if (!map || map.version !== 3 || !Array.isArray(map.sources) || map.sources.length > 10000 ||
      !map.sources.every((value) => typeof value === 'string') || typeof map.mappings !== 'string' || map.sections ||
      (map.sourcesContent !== undefined && (!Array.isArray(map.sourcesContent) ||
        map.sourcesContent.length !== map.sources.length || !map.sourcesContent.every((value) => value === null || typeof value === 'string')))) {
      throw new ArtifactError('map_contract');
    }
    for (const content of map.sourcesContent || []) {
      if (content === null) continue;
      const embedded = scanText(content, references);
      findings.comparisonLabels.push(...embedded.comparisonLabels); findings.patterns.push(...embedded.patterns);
    }
  }
  return { comparisonLabels: [...new Set(findings.comparisonLabels)], patterns: [...new Set(findings.patterns)] };
}

/** Validate transient private inputs against the approved label list; no raw schema errors escape. */
function parseInput(value) {
  const secret = z.string().min(8).max(8192).refine((text) => !hasControl(text));
  const parsed = z.object({ profile: z.unknown(), approval: z.string().regex(/^[a-f0-9]{64}$/),
    liveApproved: z.literal(true),
    credentials: z.object({ production: z.string().regex(/^[A-Za-z0-9_-]{16,512}$/),
      preview: z.string().regex(/^[A-Za-z0-9_-]{16,512}$/) }).strict(),
    comparisons: z.array(comparisonSchema.extend({ value: secret }).strict()).min(2).max(14),
  }).strict().safeParse(value);
  if (!parsed.success) throw new ArtifactError('input');
  const input = parsed.data; input.profile = parseProfile(input.profile);
  if (input.approval !== approvalId(input.profile)) throw new ArtifactError('approval');
  if (JSON.stringify(input.comparisons.map(({ environment, label }) => ({ environment, label }))) !==
    JSON.stringify(input.profile.comparisons)) throw new ArtifactError('credentials');
  return input;
}

/** Apply real wall-clock transport deadlines and byte/header caps even while DNS or body stalls. */
function exchange(url, credential, kind, state, deps) {
  return new Promise((resolve, reject) => {
    let request, response, done = false, timer;
    const chunks = [];
    let bytes = 0;
    const cap = kind === 'html' ? LIMITS.htmlBytes : LIMITS.assetBytes;
    const left = LIMITS.overallMs - (deps.now() - state.started);
    /** End once, destroy owned I/O and discard private buffers on failed responses. */
    function finish(error, value) {
      if (done) return;
      done = true; clearTimeout(timer); deps.signal?.removeEventListener('abort', abort);
      if (error) { request?.destroy(); response?.destroy(); chunks.forEach((chunk) => chunk.fill(0)); reject(error); }
      else resolve(value);
    }
    /** Map cancellation to a fixed reason instead of persisting caller-provided signal data. */
    function abort() { finish(new ArtifactError('cancelled')); }
    if (deps.signal?.aborted) return abort();
    if (left <= 0) return finish(new ArtifactError('overall_deadline'));
    timer = setTimeout(() => finish(new ArtifactError(left <= LIMITS.requestMs ? 'overall_deadline' : 'request_timeout')),
      Math.min(LIMITS.requestMs, left));
    deps.signal?.addEventListener('abort', abort, { once: true });
    try {
      request = deps.requestImpl(new URL(url), { method: 'GET', agent: false, maxHeaderSize: LIMITS.headerBytes,
        headers: { 'accept-encoding': 'identity', 'x-vercel-protection-bypass': credential,
          accept: kind === 'html' ? 'text/html' : '*/*' } }, (received) => {
        response = received;
        if (done) { response.destroy(); return; }
        response.on('error', () => finish(new ArtifactError('transport')));
        response.on('aborted', () => finish(new ArtifactError('incomplete_body')));
        response.on('close', () => { if (!done) finish(new ArtifactError('incomplete_body')); });
        const headers = Object.create(null), raw = response.rawHeaders || [];
        let size = 0;
        for (let index = 0; index < raw.length; index += 2) {
          size += Buffer.byteLength(String(raw[index])) + Buffer.byteLength(String(raw[index + 1])) + 4;
          const key = String(raw[index]).toLowerCase();
          if (['content-type', 'content-encoding', 'content-length', 'sourcemap', 'x-sourcemap'].includes(key)) {
            if (Object.hasOwn(headers, key)) return finish(new ArtifactError('headers'));
            headers[key] = String(raw[index + 1]);
          }
        }
        if (raw.length % 2 || size > LIMITS.headerBytes) return finish(new ArtifactError('headers'));
        state.receipt.status = response.statusCode;
        if (response.statusCode !== 200) return finish(new ArtifactError('http_status'));
        if (headers['content-encoding'] && headers['content-encoding'].toLowerCase() !== 'identity') return finish(new ArtifactError('encoding'));
        if (headers['content-length'] && (!/^\d+$/.test(headers['content-length']) || Number(headers['content-length']) > cap)) return finish(new ArtifactError('body_size'));
        const type = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const accepted = kind === 'html' ? ['text/html'] : kind === 'map' ? ['application/json', 'application/octet-stream', 'text/plain']
          : ['application/javascript', 'text/javascript', 'application/x-javascript'];
        if (!accepted.includes(type)) return finish(new ArtifactError('content_type'));
        response.on('data', (chunk) => {
          if (done) return;
          const buffer = Buffer.from(chunk); bytes += buffer.length; state.report.bytesReceived += buffer.length;
          if (bytes > cap || state.report.bytesReceived > LIMITS.totalBytes) {
            buffer.fill(0); finish(new ArtifactError(bytes > cap ? 'body_size' : 'total_bytes')); return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (done) return;
          if (!response.complete || (headers['content-length'] && Number(headers['content-length']) !== bytes)) return finish(new ArtifactError('incomplete_body'));
          const body = Buffer.concat(chunks);
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
            const result = { text, sha256: sha256(body), bytes, headers, status: 200 };
            body.fill(0); chunks.forEach((chunk) => chunk.fill(0)); finish(null, result);
          } catch { body.fill(0); finish(new ArtifactError('encoding')); }
        });
      });
      request.on('error', () => finish(new ArtifactError('transport')));
      request.end();
    } catch { finish(new ArtifactError('transport')); }
  });
}

/** Persist a consume-once approval reservation and exclusive report, without retaining response bodies. */
function createStore(approval) {
  if (!/^[a-f0-9]{64}$/.test(approval)) throw new ArtifactError('reservation');
  const directory = path.resolve(__dirname, '../.tmp/gate1-artifact-privacy');
  fs.mkdirSync(directory, { recursive: true });
  const reservation = path.join(directory, `${approval}.reservation.json`);
  const reportPath = path.join(directory, `gate1-artifact-privacy-${approval}.json`);
  try { fs.writeFileSync(reservation, JSON.stringify({ schemaVersion: 1, approvalId: approval, consumed: true }), { flag: 'wx', mode: 0o600 }); }
  catch { throw new ArtifactError('reservation'); }
  return {
    /** Write at most one bounded sanitized outcome; a failed write never releases the reservation. */
    save(report) {
      const encoded = JSON.stringify(report, null, 2);
      if (Buffer.byteLength(encoded) > LIMITS.reportBytes) throw new ArtifactError('report_write');
      try { fs.writeFileSync(reportPath, encoded + '\n', { flag: 'wx', mode: 0o600 }); }
      catch { throw new ArtifactError('report_write'); }
      return reportPath;
    },
  };
}

/** Execute the exact two-target scope with injectable offline transport and monotonic clock seams. */
async function runScan(value, options = {}) {
  const deps = { requestImpl: https.request, now: () => performance.now(), wall: () => Date.now(),
    storeFactory: createStore, ...options };
  const report = { schemaVersion: 1, mode: 'live', scope: 'referenced_login_browser_artifacts_only',
    result: 'stopped', gate1Status: 'open', hostedEvidence: 'requires_review', artifactEvidence: 'unqualified',
    attribution: 'operator_bound_historical_targets_with_http_build_checks',
    coverage: { allBrowserArtifacts: 'not_established', serverArtifacts: 'not_inspected', logs: 'not_inspected',
      discovery: 'login_script_tags_script_preloads_and_explicit_map_links',
      comparisons: 'supplied_values_raw_json_escaped_uri_encoded_base64_and_base64url_plus_fixed_patterns' },
    approvalId: null, targets: [], limits: LIMITS, appRequests: 0, htmlRequests: 0, assetRequests: 0,
    providerRequests: 0, configMutations: 0, bytesReceived: 0, receipts: [], files: [], failure: null };
  let input, store;
  const state = { report, started: deps.now(), receipt: null };
  /** Reserve an attempt before sending; all failures remain counted and no retry path exists. */
  async function fetchFile(url, target, kind, phase) {
    if (deps.signal?.aborted) throw new ArtifactError('cancelled');
    if (deps.now() - state.started >= LIMITS.overallMs) throw new ArtifactError('overall_deadline');
    const count = kind === 'html' ? 'htmlRequests' : 'assetRequests';
    if (report[count] >= LIMITS[count] || report.appRequests >= LIMITS.maxRequests) throw new ArtifactError('request_limit');
    report[count]++; report.appRequests++;
    const receipt = { id: report.appRequests, environment: target.environment, phase, kind, status: null, validated: false };
    report.receipts.push(receipt); state.receipt = receipt;
    const started = deps.now();
    try {
      return await exchange(url, input.credentials[target.environment], kind, state, deps);
    } finally { receipt.durationMs = Math.max(0, Math.round((deps.now() - started) * 1000) / 1000); }
  }
  /** Record only content hashes and fixed finding labels; raw asset paths and snippets stay private. */
  function inspect(response, kind, target) {
    // Compare every supplied value on both targets: a Production value leaking into Preview matters too.
    const references = input.comparisons.map((ref) => ({ label: `${ref.environment}:${ref.label}`, value: ref.value }));
    for (const environment of ['production', 'preview']) references.push({
      label: `${environment}:automation_bypass`, value: input.credentials[environment] });
    const findings = inspectBody(response.text, kind, references);
    report.files.push({ id: state.receipt.id, environment: target.environment, kind,
      sha256: response.sha256, bytes: response.bytes, ...findings });
    if (findings.comparisonLabels.length || findings.patterns.length) throw new ArtifactError('sensitive_content');
  }
  try {
    input = parseInput(value);
    report.approvalId = input.approval;
    report.comparisonLabels = input.profile.comparisons;
    report.startedAt = new Date(deps.wall()).toISOString();
    store = deps.storeFactory(input.approval);
    for (const target of input.profile.targets) {
      const outcome = { ...target, buildBefore: false, buildAfter: false, scriptsDiscovered: 0,
        mapsDiscovered: 0, sourceMaps: 'not_discovered' };
      report.targets.push(outcome);
      const loginUrl = `https://${target.hostname}/login`;
      const before = await fetchFile(loginUrl, target, 'html', 'buildBefore');
      if (loginBuild(before) !== target.nextBuildId) throw new ArtifactError('build_mismatch');
      outcome.buildBefore = true; inspect(before, 'html', target);
      const scripts = discoverScripts(before.text, target);
      outcome.scriptsDiscovered = scripts.length; state.receipt.validated = true;
      const queue = scripts.map((url) => ({ url, kind: 'script' }));
      const seen = new Set(scripts);
      for (let index = 0; index < queue.length; index++) {
        const entry = queue[index];
        const response = await fetchFile(entry.url, target, entry.kind, 'artifact');
        inspect(response, entry.kind, target);
        if (entry.kind === 'script') {
          for (const url of discoverMaps(response.text, response.headers, entry.url, target)) {
            if (!seen.has(url)) { seen.add(url); queue.push({ url, kind: 'map' }); outcome.mapsDiscovered++; }
          }
        }
        state.receipt.validated = true;
        if (entry.kind === 'map') outcome.sourceMaps = 'linked_maps_inspected_only';
      }
      const after = await fetchFile(loginUrl, target, 'html', 'buildAfter');
      if (loginBuild(after) !== target.nextBuildId) throw new ArtifactError('build_mismatch');
      outcome.buildAfter = true; inspect(after, 'html', target);
      if (JSON.stringify(discoverScripts(after.text, target)) !== JSON.stringify(scripts)) throw new ArtifactError('reference_changed');
      state.receipt.validated = true;
    }
    if (deps.now() - state.started >= LIMITS.overallMs) throw new ArtifactError('overall_deadline');
    report.result = 'completed'; report.artifactEvidence = 'selected_files_checked_no_findings';
  } catch (error) {
    report.failure = error instanceof ArtifactError ? error.code : 'internal';
    if (report.failure === 'sensitive_content') report.artifactEvidence = 'findings_require_private_review';
  }
  report.elapsedMs = Math.max(0, Math.round((deps.now() - state.started) * 1000) / 1000);
  report.validatedRequests = report.receipts.filter((receipt) => receipt.validated).length;
  report.unvalidatedAttempts = report.appRequests - report.validatedRequests;
  // Final guard catches accidental echoes even in otherwise validated metadata.
  if (input && [...input.comparisons.map((ref) => ref.value), ...Object.values(input.credentials)]
    .some((secret) => JSON.stringify(report).includes(secret))) throw new ArtifactError('report_write');
  return { reportPath: store ? store.save(report) : null, report };
}

/** Accept bounded stdin only, with a deadline and fixed errors; no credential arguments or env-file reads. */
async function readInput() {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    /** Release input listeners and retained byte buffers after parsing or rejection. */
    function finish(error) {
      clearTimeout(timer); process.stdin.removeListener('data', data); process.stdin.removeListener('end', end);
      process.stdin.removeListener('error', failed); process.stdin.pause();
      if (error) reject(error);
      chunks.forEach((chunk) => chunk.fill(0));
    }
    /** Enforce the envelope byte cap before retaining another input chunk. */
    function data(chunk) {
      size += chunk.length;
      if (size > LIMITS.inputBytes) finish(new ArtifactError('input'));
      else chunks.push(Buffer.from(chunk));
    }
    /** Parse once; never surface a JSON error that might quote private input. */
    function end() {
      try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); finish(); resolve(parsed); }
      catch { finish(new ArtifactError('input')); }
    }
    /** Collapse stdin failures to the fixed input reason. */
    function failed() { finish(new ArtifactError('input')); }
    const timer = setTimeout(failed, 5000);
    process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.once('error', failed);
    process.stdin.resume();
  });
}

/** CLI defaults to an offline template; only the explicit live mode can consume approval or use HTTP. */
async function main(args) {
  try {
    if (args.length > 1 || (args.length && !['--template', '--prepare', '--live'].includes(args[0]))) throw new ArtifactError('input');
    if (!args.length || args[0] === '--template') { process.stdout.write(JSON.stringify(profileTemplate(), null, 2) + '\n'); return; }
    if (args[0] === '--prepare') { process.stdout.write(JSON.stringify(preparation(await readInput()), null, 2) + '\n'); return; }
    const controller = new AbortController();
    /** Cancel owned I/O on process signals without retaining external signal data. */
    function cancel() { controller.abort(); }
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
      const result = await runScan(await readInput(), { signal: controller.signal });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exitCode = result.report.result === 'completed' ? 0 : 1;
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  } catch { process.stderr.write('Artifact diagnostic failed. Preserve any reservation; do not rerun automatically.\n'); process.exitCode = 1; }
}

module.exports = { LIMITS, TARGETS, LABELS, ATTESTATIONS, ArtifactError, profileTemplate, parseProfile,
  approvalId, preparation, assetUrl, discoverScripts, discoverMaps, scanText, inspectBody,
  exchange, createStore, runScan };
if (require.main === module) void main(process.argv.slice(2));
