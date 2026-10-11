'use strict';

/**
 * Offline-default GATE-1 historical build-output metadata inventory.
 * Mirrors the two GETs used by Vercel CLI 50.33.1 inspect, without its retries.
 * No application, artifact-content, log, configuration or pagination requests.
 */
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { TextDecoder } = require('node:util');
const { z } = require('zod');

const PROJECT = 'prj_b2nMrysMSJtpmqoeGx5g0WGgGuom';
const TEAM = 'team_7o3efmwjZbMc2Bfy9qAzkc9q';
const SCOPE = 'historical_build_output_metadata_only';
const LIMITS = Object.freeze({ maxAppRequests: 0, maxProviderRequests: 4,
  maxContentDownloads: 0, maxConfigMutations: 0, concurrency: 1,
  requestMs: 10000, overallMs: 60000, providerBytes: 1048576, totalBytes: 4194304,
  maxOutputEntries: 2000, headerBytes: 16384, inputBytes: 16384, reportBytes: 16384 });
const TARGETS = Object.freeze([
  Object.freeze({ environment: 'production', deploymentId: 'dpl_DazMBQ2wWdfB9U4ntGzVp18mXEYk',
    hostname: 'job-application-tracker-h4ly6ufvr-track-the-app.vercel.app',
    gitSha: '975a17898c8887a23fb62cb3f36305d1a416d8ad', nextBuildId: 'z2x35luO6lyz3q6Vwc--O' }),
  Object.freeze({ environment: 'preview', deploymentId: 'dpl_2G5y4AiwJZU2RhDBujm9ZFb6vkjh',
    hostname: 'job-application-tracker-pmpzlpery-track-the-app.vercel.app',
    gitSha: 'a4a576b32a20345ebd76f788fe415c239352974a', nextBuildId: 'datrYVSKClFsT83wNRj89' }),
]);
const ATTESTATIONS = Object.freeze(['sourceCodeReviewed', 'historicalTargetsReviewed',
  'providerReadAccessReviewed', 'credentialLoggingReviewed', 'metadataOnlyScopeReviewed',
  'coverageLimitationsReviewed']);
const CODES = new Set(['input', 'profile', 'approval', 'credentials', 'reservation', 'report_write',
  'cancelled', 'request_timeout', 'overall_deadline', 'transport', 'headers', 'encoding',
  'body_size', 'total_bytes', 'request_limit', 'incomplete_body', 'http_status', 'content_type',
  'provider_json', 'provider_schema', 'attribution', 'pagination', 'entry_limit', 'unsupported_output', 'internal']);
const profileSchema = z.object({ schemaVersion: z.literal(1), scope: z.literal(SCOPE),
  projectId: z.literal(PROJECT), teamId: z.literal(TEAM), runId: z.string().regex(/^[a-f0-9]{32}$/),
  targets: z.tuple(TARGETS.map((target) => z.object(Object.fromEntries(
    Object.entries(target).map(([key, value]) => [key, z.literal(value)]))).strict())),
  attestations: z.object(Object.fromEntries(ATTESTATIONS.map((key) => [key, z.literal(true)]))).strict(),
}).strict();
const inputSchema = z.object({ profile: z.unknown(), approval: z.string().regex(/^[a-f0-9]{64}$/),
  liveApproved: z.literal(true), credentials: z.object({
    providerToken: z.string().regex(/^[A-Za-z0-9_-]{20,512}$/),
  }).strict() }).strict();
const textSchema = z.string().min(1).max(4096).refine((value) =>
  [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));
const outputSchema = z.object({ path: textSchema, type: z.string().max(64).optional(),
  lambda: z.object({ functionName: textSchema, deployedTo: z.array(textSchema).max(128) }).nullable().optional(),
});
const buildSchema = z.object({ id: textSchema, deploymentId: z.string(),
  readyState: z.enum(['READY', 'ARCHIVED']), output: z.array(z.unknown()).max(LIMITS.maxOutputEntries) });

/** Normalize errors to fixed codes; provider messages and schema errors never enter reports. */
class InventoryError extends Error {
  /** Keep only an allowlisted reason at every error boundary. */
  constructor(code) { super(CODES.has(code) ? code : 'internal'); this.code = this.message; }
}

/** Hash local reviewed code/profile bytes for a consume-once approval, never credential values. */
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

/** Provide an offline, unapproved template; the owner must confirm each attestation. */
function profileTemplate() {
  return { schemaVersion: 1, scope: SCOPE, projectId: PROJECT, teamId: TEAM,
    runId: randomBytes(16).toString('hex'), targets: TARGETS.map((target) => ({ ...target })),
    attestations: Object.fromEntries(ATTESTATIONS.map((key) => [key, false])) };
}

/** Reject arbitrary hosts, extra fields, reordered targets and unconfirmed conditions. */
function parseProfile(value) {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new InventoryError('profile');
  return parsed.data;
}

/** Bind the profile and fixed limits to both executables and the dependency lock; no local helper imports. */
function approvalId(value) {
  const profile = parseProfile(value);
  const integrity = ['gate1-artifact-inventory.js', 'run-gate1-artifact-inventory.ps1', '../package-lock.json']
    .map((file) => sha256(fs.readFileSync(path.join(__dirname, file))));
  return sha256(JSON.stringify({ profile, limits: LIMITS, integrity }));
}

/** Construct only the pinned identity/build paths; Git metadata is explicitly requested for attribution. */
function operationPath(target, phase) {
  if (!TARGETS.some((item) => item.deploymentId === target.deploymentId) ||
    !['identity', 'outputs'].includes(phase)) throw new InventoryError('input');
  return phase === 'identity'
    ? `/v13/deployments/${target.deploymentId}?teamId=${TEAM}&withGitRepoInfo=true`
    : `/v11/deployments/${target.deploymentId}/builds?teamId=${TEAM}`;
}

/** Review metadata-only scope offline, without expiry-driven redeploys or any live authorization. */
function preparation(value) {
  const profile = parseProfile(value);
  return { schemaVersion: 1, mode: 'prepare', profile, approvalId: approvalId(profile), limits: LIMITS,
    liveApproved: false, appRequests: 0, providerRequests: 0, gate1Status: 'open',
    operations: TARGETS.flatMap((target) => ['identity', 'outputs'].map((phase) => ({
      environment: target.environment, phase, method: 'GET', endpoint: `https://api.vercel.com${operationPath(target, phase)}`,
    }))), nextStep: 'obtain_separate_live_approval', completeness: 'unqualified',
    artifactPrivacy: 'not_evaluated', compiledContentAccess: 'not_established' };
}

/** Identify unsupported continuation metadata without following it or retaining its value. */
function rejectPagination(value) {
  if (!value || typeof value !== 'object') return;
  const indicators = /^(pagination|next|nextPage|nextCursor|cursor|continuationToken|hasMore|truncated|isTruncated|partial|isPartial|links)$/i;
  if (Object.keys(value).some((key) => indicators.test(key))) throw new InventoryError('pagination');
}

/** Require identity evidence, rejecting all contradictory owner/SHA fields rather than choosing a fallback. */
function reviewIdentity(value, target) {
  const parsed = z.object({ id: z.literal(target.deploymentId), projectId: z.literal(PROJECT),
    url: z.literal(target.hostname), readyState: z.literal('READY'), version: z.literal(2),
    target: target.environment === 'production' ? z.literal('production') : z.null(),
    gitSource: z.object({ sha: z.literal(target.gitSha) }),
  }).safeParse(value);
  if (!parsed.success) throw new InventoryError('attribution');
  const owners = [];
  for (const key of ['ownerId', 'teamId']) if (Object.hasOwn(value, key)) owners.push(value[key]);
  if (Object.hasOwn(value, 'team')) owners.push(value.team?.id);
  if (!owners.length || owners.some((id) => id !== TEAM) || value.customEnvironment != null) throw new InventoryError('attribution');
  for (const key of ['githubCommitSha', 'gitlabCommitSha', 'bitbucketCommitSha', 'gitCommitSha']) {
    if (value.meta && Object.hasOwn(value.meta, key) && value.meta[key] !== target.gitSha) throw new InventoryError('attribution');
  }
  return { identityValidated: true, attribution: 'provider_deployment_identity_and_team',
    nextBuildIdEvidence: 'historical_profile_only_no_http_verification' };
}

/** Review one returned listing and count entries; never infer absence, completeness or content access. */
function reviewOutputs(value, target, outcome, state) {
  rejectPagination(value);
  const wrapper = z.object({ builds: z.array(z.unknown()).max(LIMITS.maxOutputEntries) }).strict().safeParse(value);
  if (!wrapper.success) throw new InventoryError('provider_schema');
  const counts = { builds: 0, outputEntries: 0, staticJavaScript: 0, sourceMaps: 0,
    otherStatic: 0, functions: 0, unsupported: 0 };
  outcome.counts = counts;
  const ids = new Set();
  for (const item of wrapper.data.builds) {
    rejectPagination(item);
    if (Array.isArray(item?.output) && state.outputEntries + item.output.length > LIMITS.maxOutputEntries) throw new InventoryError('entry_limit');
    const parsed = buildSchema.safeParse(item);
    if (!parsed.success) throw new InventoryError('provider_schema');
    const build = parsed.data;
    if (build.deploymentId !== target.deploymentId) throw new InventoryError('attribution');
    if (ids.has(build.id)) throw new InventoryError('provider_schema');
    ids.add(build.id); counts.builds++;
    for (const entry of build.output) {
      rejectPagination(entry);
      state.outputEntries++; counts.outputEntries++;
      const output = outputSchema.safeParse(entry);
      if (!output.success) { counts.unsupported++; continue; }
      const file = output.data;
      if (file.type === 'lambda' && file.lambda) counts.functions++;
      else if (file.type === 'file' && !file.lambda) {
        if (/\.map$/i.test(file.path)) counts.sourceMaps++;
        else if (/\.(?:js|mjs|cjs)$/i.test(file.path)) counts.staticJavaScript++;
        else counts.otherStatic++;
      } else counts.unsupported++;
    }
  }
  outcome.listing = counts.outputEntries ? 'entries_returned' : 'empty_listing_returned';
  if (counts.unsupported) throw new InventoryError('unsupported_output');
  outcome.listingValidated = true;
}

/** Bound monotonic elapsed time across dispatch, parsing and final validation; cancellation stops further work. */
function remaining(state, deps) {
  if (deps.signal?.aborted) throw new InventoryError('cancelled');
  const current = deps.now();
  if (!Number.isFinite(current) || current < state.previous || current - state.started >= LIMITS.overallMs) throw new InventoryError('overall_deadline');
  state.previous = current;
  return LIMITS.overallMs - (current - state.started);
}

/** Fetch one pinned provider response with real streaming caps and deadlines, discarding private buffers. */
function exchange(target, phase, token, state, deps, receipt) {
  return new Promise((resolve, reject) => {
    let request, response, timer, done = false, bytes = 0;
    const chunks = [];
    /** Settle once, destroy owned I/O on failure and erase retained byte buffers on every exit. */
    function finish(error, value) {
      if (done) return;
      done = true; clearTimeout(timer); deps.signal?.removeEventListener('abort', abort);
      chunks.forEach((chunk) => chunk.fill(0));
      if (error) { request?.destroy(); response?.destroy(); reject(error); } else resolve(value);
    }
    /** Abort without serializing caller or provider exception details. */
    function abort() { finish(new InventoryError('cancelled')); }
    try {
      const left = remaining(state, deps);
      if (state.report.providerRequests >= LIMITS.maxProviderRequests) throw new InventoryError('request_limit');
      const apiPath = operationPath(target, phase);
      timer = setTimeout(() => finish(new InventoryError(left <= LIMITS.requestMs ? 'overall_deadline' : 'request_timeout')),
        Math.min(left, LIMITS.requestMs));
      deps.signal?.addEventListener('abort', abort, { once: true });
      state.report.providerRequests++;
      request = deps.requestImpl(new URL(`https://api.vercel.com${apiPath}`), {
        method: 'GET', agent: false, maxHeaderSize: LIMITS.headerBytes,
        headers: { accept: 'application/json', 'accept-encoding': 'identity', authorization: `Bearer ${token}` },
      }, (incoming) => {
        response = incoming;
        if (done) { response.destroy(); return; }
        response.on('error', () => finish(new InventoryError('transport')));
        response.on('aborted', () => finish(new InventoryError('incomplete_body')));
        response.on('close', () => { if (!done) finish(new InventoryError('incomplete_body')); });
        try {
          const headers = Object.create(null), raw = response.rawHeaders;
          if (!Array.isArray(raw) || raw.length % 2) throw new InventoryError('headers');
          let headerBytes = 0;
          for (let index = 0; index < raw.length; index += 2) {
            if (typeof raw[index] !== 'string' || typeof raw[index + 1] !== 'string') throw new InventoryError('headers');
            headerBytes += Buffer.byteLength(raw[index]) + Buffer.byteLength(raw[index + 1]) + 4;
            const key = raw[index].toLowerCase();
            if (['content-type', 'content-encoding', 'content-length', 'link', 'content-range', 'x-next-cursor'].includes(key)) {
              if (Object.hasOwn(headers, key)) throw new InventoryError('headers');
              headers[key] = raw[index + 1];
            }
          }
          if (headerBytes > LIMITS.headerBytes) throw new InventoryError('headers');
          if (Number.isInteger(response.statusCode) && response.statusCode >= 100 && response.statusCode <= 599) receipt.status = response.statusCode;
          if (receipt.status !== 200) throw new InventoryError('http_status');
          if (['link', 'content-range', 'x-next-cursor'].some((key) => Object.hasOwn(headers, key))) throw new InventoryError('pagination');
          if (headers['content-encoding'] && headers['content-encoding'].toLowerCase() !== 'identity') throw new InventoryError('encoding');
          if ((headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new InventoryError('content_type');
          if (headers['content-length'] !== undefined && (!/^\d+$/.test(headers['content-length']) || Number(headers['content-length']) > LIMITS.providerBytes)) throw new InventoryError('body_size');
          response.on('data', (chunk) => {
            if (done) return;
            const buffer = Buffer.from(chunk); bytes += buffer.length;
            state.report.bytesReceived += buffer.length; receipt.bytesReceived = bytes;
            if (bytes > LIMITS.providerBytes || state.report.bytesReceived > LIMITS.totalBytes) {
              buffer.fill(0); finish(new InventoryError(bytes > LIMITS.providerBytes ? 'body_size' : 'total_bytes')); return;
            }
            chunks.push(buffer);
          });
          response.on('end', () => {
            if (done) return;
            if (!response.complete || (headers['content-length'] !== undefined && Number(headers['content-length']) !== bytes)) {
              finish(new InventoryError('incomplete_body')); return;
            }
            const body = Buffer.concat(chunks);
            let text;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
            catch { body.fill(0); finish(new InventoryError('encoding')); return; }
            body.fill(0);
            try { const value = JSON.parse(text); text = null; finish(null, value); }
            catch { text = null; finish(new InventoryError('provider_json')); }
          });
        } catch (error) { finish(error instanceof InventoryError ? error : new InventoryError('internal')); }
      });
      request.on('error', () => finish(new InventoryError('transport')));
      request.end();
    } catch (error) { finish(error instanceof InventoryError ? error : new InventoryError('transport')); }
  });
}

/** Exclusively consume approval before dispatch; never remove a reservation or overwrite its report. */
function createStore(approval) {
  if (!/^[a-f0-9]{64}$/.test(approval)) throw new InventoryError('reservation');
  const directory = path.resolve(__dirname, '../.tmp/gate1-artifact-inventory');
  const reportPath = path.join(directory, `gate1-artifact-inventory-${approval}.json`);
  try {
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(reportPath)) throw new InventoryError('reservation');
    fs.writeFileSync(path.join(directory, `${approval}.reservation.json`), JSON.stringify({
      schemaVersion: 1, approvalId: approval, consumed: true,
    }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch { throw new InventoryError('reservation'); }
  return {
    /** Persist one bounded, sanitized outcome; write failure leaves the approval consumed. */
    save(report) {
      const encoded = JSON.stringify(report, null, 2) + '\n';
      if (Buffer.byteLength(encoded) > LIMITS.reportBytes) throw new InventoryError('report_write');
      try { fs.writeFileSync(reportPath, encoded, { flag: 'wx', mode: 0o600 }); }
      catch { throw new InventoryError('report_write'); }
      return reportPath;
    },
  };
}

/** Detect even accidental fixed-metadata/credential collisions before printing or saving a report. */
function hasEcho(value, token) {
  if (typeof token !== 'string' || token.length < 20) return false;
  return [token, Buffer.from(token).toString('base64'), Buffer.from(token).toString('base64url')]
    .some((secret) => JSON.stringify(value, null, 2).includes(secret));
}

/** Execute the four-GET budget, with injectable transport/storage exclusively for offline tests. */
async function runInventory(value, options = {}) {
  const deps = { requestImpl: https.request, storeFactory: createStore,
    now: () => performance.now(), wall: Date.now, ...options };
  const report = { schemaVersion: 1, mode: options.requestImpl ? 'fixture' : 'live', scope: SCOPE,
    result: 'stopped', gate1Status: 'open', hostedEvidence: options.requestImpl ? 'not_executed' : 'requires_review',
    artifactPrivacy: 'not_evaluated', completeness: 'unqualified', sourceAgreement: 'not_evaluated',
    compiledContentAccess: 'not_established', nextBuildIdEvidence: 'historical_profile_only',
    approvalId: null, limits: LIMITS, targets: [], receipts: [], appRequests: 0, providerRequests: 0,
    contentDownloads: 0, configMutations: 0, bytesReceived: 0, failure: null, stoppedPhase: 'validation' };
  const state = { report, started: deps.now(), previous: 0, outputEntries: 0 };
  state.previous = state.started;
  let store, phase = 'validation';
  const token = value?.credentials?.providerToken;
  try {
    remaining(state, deps);
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) throw new InventoryError('input');
    const input = parsed.data, profile = parseProfile(input.profile);
    if (input.approval !== approvalId(profile)) throw new InventoryError('approval');
    const reviewed = preparation(profile);
    if (hasEcho(reviewed, token)) throw new InventoryError('credentials');
    report.approvalId = input.approval;
    report.startedAt = new Date(deps.wall()).toISOString();
    store = deps.storeFactory(input.approval);
    for (const target of profile.targets) {
      const outcome = { ...target, identityValidated: false, listingValidated: false,
        listing: 'not_evaluated', counts: null, completeness: 'unqualified',
        sourceMapAbsence: 'not_established', compiledContentAccess: 'not_established' };
      report.targets.push(outcome);
      for (const operation of ['identity', 'outputs']) {
        phase = `${target.environment}_${operation}`;
        remaining(state, deps);
        const receipt = { environment: target.environment, phase: operation, status: null,
          bytesReceived: 0, validated: false };
        report.receipts.push(receipt);
        const start = deps.now();
        try {
          const response = await exchange(target, operation, token, state, deps, receipt);
          remaining(state, deps);
          if (operation === 'identity') Object.assign(outcome, reviewIdentity(response, target));
          else reviewOutputs(response, target, outcome, state);
          remaining(state, deps); receipt.validated = true;
        } finally { receipt.durationMs = Math.max(0, Math.round((deps.now() - start) * 1000) / 1000); }
      }
    }
    remaining(state, deps); report.result = 'completed'; report.stoppedPhase = null;
  } catch (error) {
    report.failure = error instanceof InventoryError ? error.code : 'internal'; report.stoppedPhase = phase;
  }
  report.outputEntries = state.outputEntries;
  report.elapsedMs = Math.max(0, Math.round((deps.now() - state.started) * 1000) / 1000);
  report.validatedRequests = report.receipts.filter((receipt) => receipt.validated).length;
  report.unvalidatedAttempts = report.providerRequests - report.validatedRequests;
  // A fixed fallback excludes arbitrary profile/provider fields, even for deliberately colliding input.
  const output = hasEcho(report, token) ? { schemaVersion: 1, result: 'stopped', gate1Status: 'open',
    failure: 'credentials', providerRequests: report.providerRequests, appRequests: 0 } : report;
  if (hasEcho(output, token)) throw new InventoryError('credentials');
  let reportPath = null;
  if (store) {
    try { reportPath = store.save(output); }
    catch { output.reportWrite = 'report_write'; }
  }
  return { reportPath: hasEcho(reportPath, token) || !output.approvalId ? null : reportPath, report: output };
}

/** Read a bounded private stdin envelope with a deadline; input and JSON exceptions never escape. */
function readInput() {
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const chunks = [];
    /** Release listeners and erase buffers once after parse or failure. */
    function finish(error, value) {
      if (done) return;
      done = true; clearTimeout(timer); process.stdin.removeListener('data', data);
      process.stdin.removeListener('end', end); process.stdin.removeListener('error', failed);
      process.stdin.pause(); chunks.forEach((chunk) => chunk.fill(0));
      if (error) reject(error); else resolve(value);
    }
    /** Cap bytes before retaining input that could contain a token. */
    function data(chunk) {
      size += chunk.length;
      if (size > LIMITS.inputBytes) finish(new InventoryError('input')); else chunks.push(Buffer.from(chunk));
    }
    /** Parse transient input once and zero the temporary joined buffer. */
    function end() {
      const body = Buffer.concat(chunks);
      try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))); }
      catch { finish(new InventoryError('input')); }
      finally { body.fill(0); }
    }
    /** Replace stdin errors and timeouts with a fixed reason. */
    function failed() { finish(new InventoryError('input')); }
    const timer = setTimeout(failed, 5000);
    process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.once('error', failed);
    process.stdin.resume();
  });
}

/** Exact CLI modes: no arguments produce a template; only --live may consume a reviewed approval. */
async function main(args) {
  try {
    if (args.length > 1 || (args.length && !['--template', '--prepare', '--live'].includes(args[0]))) throw new InventoryError('input');
    if (!args.length || args[0] === '--template') { process.stdout.write(JSON.stringify(profileTemplate(), null, 2) + '\n'); return; }
    if (args[0] === '--prepare') { process.stdout.write(JSON.stringify(preparation(await readInput()), null, 2) + '\n'); return; }
    const controller = new AbortController();
    /** Cancel only owned transport on process signals, without retry or provider logging. */
    function cancel() { controller.abort(); }
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      const result = await runInventory(await readInput(), { signal: controller.signal });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exitCode = result.report.result === 'completed' ? 0 : 1;
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  } catch { process.stderr.write('Inventory preparation/execution failed. Preserve any reservation; do not rerun automatically.\n'); process.exitCode = 1; }
}

module.exports = { LIMITS, TARGETS, PROJECT, TEAM, ATTESTATIONS, InventoryError,
  profileTemplate, parseProfile, approvalId, preparation, operationPath, reviewIdentity,
  reviewOutputs, exchange, createStore, runInventory };
if (require.main === module) void main(process.argv.slice(2));
