'use strict';

// Operator diagnostic only. Live use requires separate operator approval.
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { z } = require('zod');

const LIMITS = Object.freeze({ maxRequests: 30, concurrency: 1, requestMs: 10000,
  overallMs: 300000, responseBytes: 1048576, headerBytes: 16384 });
const TARGET = Object.freeze({
  hostname: 'job-application-tracker-mxlx5brml-track-the-app.vercel.app',
  deploymentId: 'dpl_2hjZCj2WZ251FZUJsTyaRiVoq1mH',
  gitSha: '9fe633d48d177c4743733a78b37eaebcfce1b347',
  nextBuildId: 'q0zlIgmPLmJWCHTAV9jpK',
  buildAttribution: 'operator_supplied_not_yet_http_verified',
});
const CANONICAL = 'job-application-tracker-kappa-seven.vercel.app';
const INVENTORY_ID = 'gate1-host-delta-e50c5e9-9fe633d-20260923';
// Hash parsed JSON serialization so a Git LF/CRLF conversion does not change the fixed scope.
const INVENTORY_SHA256 = '716bde62775672217440fd52dc765fe712730128c64be985ae5da299d38d76bb';
const BATCH_SIZES = Object.freeze([30, 30, 30, 12]);
const TOTAL_HOSTS = 102;
const hostSchema = z.object({
  hostname: z.string().max(253).regex(/^job-application-tracker-[a-z0-9-]+\.vercel\.app$/),
  deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
  expected: z.enum(['public_login', 'gate_or_canonical_redirect']),
  knownBuildId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
  kind: z.enum(['alias', 'generated']),
  environment: z.enum(['production', 'preview']),
  recordedState: z.enum(['READY', 'ERROR']),
  coverageReason: z.enum(['new_alias', 'new_generated_url', 'reassigned_alias']),
}).strict();
const inventorySchema = z.object({
  schemaVersion: z.literal(1),
  inventoryId: z.literal(INVENTORY_ID),
  sourceArtifactSha256: z.literal('B262670685804B7D9657584F76EB42F60DF6EF062CB9B724FC1951D3742F430B'),
  acceptedLoginArtifactSha256: z.literal('8BEBDD76784960AF85608FB470F4064B1ADE2F302F4C67766B84E90B48263E41'),
  observedAt: z.literal('2026-09-23T00:03:19.226Z'),
  target: z.object({
    hostname: z.literal(TARGET.hostname), deploymentId: z.literal(TARGET.deploymentId),
    gitSha: z.literal(TARGET.gitSha), nextBuildId: z.literal(TARGET.nextBuildId),
    buildAttribution: z.literal(TARGET.buildAttribution),
  }).strict(),
  batches: z.array(z.object({
    id: z.number().int().min(1).max(4),
    hosts: z.array(hostSchema).min(1).max(LIMITS.maxRequests),
  }).strict()).length(4),
}).strict();
const CODES = new Set(['arguments', 'inventory', 'request_timeout', 'overall_deadline', 'cancelled',
  'transport_error', 'response_size', 'response_headers', 'response_encoding', 'response_incomplete',
  'build_mismatch', 'unexpected_public_login', 'unexpected_public_response', 'unresolved_response',
  'deployment_unavailable', 'unexpected_gate', 'request_budget', 'internal_error']);

/** Carry only fixed failure codes; never retain transport messages, URLs, headers or bodies. */
class HostError extends Error {
  /** Normalize an internal reason before it crosses the report boundary. */
  constructor(code) { super(CODES.has(code) ? code : 'internal_error'); this.code = this.message; }
}

/**
 * Read only the fixed sibling manifest and freeze its reviewed batches. Schema/digest failures
 * become an empty inventory, so preparation/CLI can report a sanitized failure before any HTTP.
 */
function loadBatches() {
  try {
    const text = fs.readFileSync(path.join(__dirname, 'gate1-host-protection-inventory.json'), 'utf8');
    if (Buffer.byteLength(text) > 65536) return Object.freeze([]);
    const decoded = JSON.parse(text);
    if (createHash('sha256').update(JSON.stringify(decoded)).digest('hex') !== INVENTORY_SHA256) {
      return Object.freeze([]);
    }
    const parsed = inventorySchema.safeParse(decoded);
    if (!parsed.success) return Object.freeze([]);
    for (const batch of parsed.data.batches) {
      batch.hosts.forEach(Object.freeze);
      Object.freeze(batch.hosts);
      Object.freeze(batch);
    }
    return Object.freeze(parsed.data.batches);
  } catch { return Object.freeze([]); }
}

/** Extract a frozen batch's hosts when constructing the complete allowlist. */
function batchHosts(batch) { return batch.hosts; }
const BATCHES = loadBatches();
const HOSTS = Object.freeze(BATCHES.flatMap(batchHosts));

/** Reject caller-supplied destinations, including cloned objects, before transport dispatch. */
function validateHost(host) {
  if (!HOSTS.includes(host)) throw new HostError('inventory');
  return host;
}

/** Validate disjoint fixed batches and the sole public build expectation before any work. */
function validateInventory() {
  if (BATCHES.length !== 4 || HOSTS.length !== TOTAL_HOSTS
    || new Set(HOSTS.map(hostnameOf)).size !== TOTAL_HOSTS) throw new HostError('inventory');
  for (let index = 0; index < BATCHES.length; index++) {
    if (BATCHES[index].id !== index + 1 || BATCHES[index].hosts.length !== BATCH_SIZES[index]) {
      throw new HostError('inventory');
    }
  }
  for (const host of HOSTS) {
    if ((host.expected === 'public_login') !== (host.hostname === CANONICAL)
      || host.knownBuildId !== (host.deploymentId === TARGET.deploymentId ? TARGET.nextBuildId : null)) {
      throw new HostError('inventory');
    }
  }
  if (HOSTS[0].hostname !== CANONICAL) throw new HostError('inventory');
}

/** Select one integer batch; missing/invalid selection cannot start a live traversal. */
function selectBatch(batch) {
  if (!Number.isInteger(batch) || batch < 1 || batch > BATCH_SIZES.length) throw new HostError('arguments');
  return BATCHES[batch - 1];
}

/** Extract the reviewed hostname when counting unique inventory entries. */
function hostnameOf(host) { return host.hostname; }

/** Retain selected singleton headers transiently; reject duplicates rather than silently combining them. */
function selectedHeaders(raw) {
  const names = new Set(['location', 'content-type', 'content-length', 'content-encoding',
    'x-vercel-id', 'x-vercel-error', 'server']);
  if (!Array.isArray(raw) || raw.length % 2 || raw.length > 200) throw new HostError('response_headers');
  const result = Object.create(null);
  let bytes = 0;
  for (let i = 0; i < raw.length; i += 2) {
    if (typeof raw[i] !== 'string' || typeof raw[i + 1] !== 'string') throw new HostError('response_headers');
    bytes += Buffer.byteLength(raw[i]) + Buffer.byteLength(raw[i + 1]) + 4;
    if (bytes > LIMITS.headerBytes) throw new HostError('response_headers');
    const name = raw[i].toLowerCase();
    if (!names.has(name)) continue;
    if (Object.hasOwn(result, name)) throw new HostError('response_headers');
    result[name] = raw[i + 1];
  }
  return result;
}

/**
 * Perform one anonymous HTTPS exchange. Native HTTPS has no redirect following, cookie jar,
 * proxy environment handling, or retry loop. Injectable transport supports strictly offline tests.
 * The absolute timer covers DNS, connection, headers and body; bounds cannot exceed approved limits.
 */
function requestHost(host, { requestImpl = https.request, signal,
  requestMs = LIMITS.requestMs, responseBytes = LIMITS.responseBytes } = {}) {
  validateHost(host);
  if (!Number.isInteger(requestMs) || requestMs < 1 || requestMs > LIMITS.requestMs
    || !Number.isInteger(responseBytes) || responseBytes < 1 || responseBytes > LIMITS.responseBytes) {
    throw new HostError('request_budget');
  }
  /** Own the request and response until completion, destroying both on any bounded failure. */
  return new Promise(function exchange(resolve, reject) {
    let request, response, settled = false, timer;
    /** Settle once and release cancellation/timer resources without leaking raw failures. */
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { request?.destroy(); response?.destroy(); reject(error); }
      else resolve(value);
    }
    /** Propagate external cancellation as a fixed code, excluding arbitrary signal reasons. */
    function abort() { finish(new HostError('cancelled')); }
    /** Enforce a wall-clock deadline even for a nonresponsive transport. */
    function timeout() { finish(new HostError('request_timeout')); }
    /** Hide errors from DNS, sockets, TLS and injected transports. */
    function transportError() { finish(new HostError('transport_error')); }
    /** Consume only a bounded identity-encoded body and selected headers in process memory. */
    function receive(incoming) {
      response = incoming;
      if (settled) { response.on('error', transportError); response.destroy(); return; }
      let headers, size = 0;
      const chunks = [];
      response.on('error', transportError);
      /** Reject a partial server response rather than treating partial HTML as evidence. */
      function incomplete() { finish(new HostError('response_incomplete')); }
      response.on('aborted', incomplete);
      try {
        headers = selectedHeaders(response.rawHeaders);
        if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
          throw new HostError('response_encoding');
        }
        const length = headers['content-length'];
        if (length !== undefined && (!/^\d{1,12}$/.test(length) || Number(length) > responseBytes)) {
          throw new HostError('response_size');
        }
      } catch (error) { finish(error instanceof HostError ? error : new HostError('response_headers')); return; }
      /** Count bytes before buffering so oversized/chunked replies cannot escape the cap. */
      function data(chunk) {
        if (settled) return;
        if (!Buffer.isBuffer(chunk)) { finish(new HostError('response_incomplete')); return; }
        size += chunk.length;
        if (size > responseBytes) { finish(new HostError('response_size')); return; }
        chunks.push(chunk);
      }
      /** Return transient response material only after the HTTP message is complete. */
      function end() {
        if (settled) return;
        if (!response.complete) { incomplete(); return; }
        finish(null, { status: response.statusCode, headers, text: Buffer.concat(chunks).toString('utf8') });
      }
      /** Treat socket closure before end as an incomplete exchange. */
      function close() { if (!settled) incomplete(); }
      response.on('data', data);
      response.on('end', end);
      response.on('close', close);
    }
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(timeout, requestMs);
    try {
      request = requestImpl({ protocol: 'https:', hostname: host.hostname, port: 443,
        path: '/login', method: 'GET', agent: false, rejectUnauthorized: true,
        maxHeaderSize: LIMITS.headerBytes,
        headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': 'Gate1HostProtection/1' } }, receive);
      request.on('error', transportError);
      request.end();
    } catch { transportError(); }
  });
}

/** Only retain the bounded platform correlation format, never arbitrary response strings. */
function correlation(value) {
  return typeof value === 'string' && value.length <= 192
    && /^[a-z0-9]{2,12}(?:::[a-z0-9]{2,12})*::[a-z0-9-]{1,160}$/i.test(value) ? value : null;
}

/** Recognize a single login Next data record without executing page scripts or exposing its content. */
function loginBuild(response) {
  if (response.status !== 200 || !/^text\/html(?:\s*;|$)/i.test(response.headers['content-type'] || '')) return null;
  const records = [];
  // Skip comments and consume complete script elements, including quoted attribute values.
  const tags = /<!--[\s\S]*?-->|<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;
  for (const tag of response.text.matchAll(tags)) {
    if (tag[1] === undefined) continue;
    const attributes = Object.create(null);
    // Remove only a separate trailing solidus; keep slashes attached to unquoted values.
    const attributeText = tag[1].replace(/\s+\/$/, '');
    const attributeEnd = attributeText.replace(/\s+$/, '').length;
    const token = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
    let position = 0;
    while (position < attributeEnd) {
      token.lastIndex = position;
      const attribute = token.exec(attributeText);
      if (!attribute) return null;
      const key = attribute[1].toLowerCase();
      if (Object.hasOwn(attributes, key)) return null;
      attributes[key] = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      position = token.lastIndex;
    }
    if (attributes.id === '__NEXT_DATA__') {
      if (attributes.type?.toLowerCase() !== 'application/json') return null;
      records.push(tag[2]);
    }
  }
  if (records.length !== 1) return null;
  try {
    const parsed = z.object({ page: z.literal('/login'),
      buildId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).safeParse(JSON.parse(records[0]));
    return parsed.success ? parsed.data.buildId : null;
  } catch { return null; }
}

/**
 * Classify the observed response only. A recognized Vercel login redirect is an observed pattern,
 * not proof of protection on other routes or proof of source/WAF agreement. Query strings stay private.
 * References: https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication
 * and https://vercel.com/docs/errors/deployment_not_found .
 */
function classify(host, response) {
  validateHost(host);
  const { status, headers } = response;
  const vercelId = correlation(headers['x-vercel-id']);
  const platform = headers.server?.toLowerCase() === 'vercel' && vercelId !== null;
  const build = loginBuild(response);
  const receipt = { hostname: host.hostname, phase: 'login', status,
    classification: 'unresolved_response', vercelId, loginBuildRecognized: build !== null,
    knownBuildMatch: build === null || host.knownBuildId === null ? null : build === host.knownBuildId,
    expectedPatternObserved: false };
  if (build !== null) {
    if (host.expected !== 'public_login') receipt.classification = 'unexpected_public_login';
    else if (build !== host.knownBuildId) receipt.classification = 'build_mismatch';
    else if (platform) { receipt.classification = 'canonical_login'; receipt.expectedPatternObserved = true; }
  } else if ([301, 302, 303, 307, 308].includes(status) && platform) {
    let destination;
    try {
      const location = headers.location;
      if (typeof location !== 'string' || location.length > 4096 || /[\s\\]/.test(location)) throw new Error();
      destination = new URL(location, `https://${host.hostname}/login`);
    } catch { return receipt; }
    if (destination.protocol !== 'https:' || destination.username || destination.password
      || destination.port || destination.hash) return receipt;
    if (destination.hostname === 'vercel.com' && ['/login', '/sso-api'].includes(destination.pathname)) {
      receipt.classification = host.expected === 'public_login' ? 'unexpected_gate' : 'vercel_auth_redirect';
      receipt.expectedPatternObserved = host.expected !== 'public_login';
    } else if (host.expected !== 'public_login' && destination.hostname === CANONICAL
      && destination.pathname === '/login' && !destination.search) {
      receipt.classification = 'canonical_redirect'; receipt.expectedPatternObserved = true;
    }
  } else if (status === 404 && platform && headers['x-vercel-error'] === 'DEPLOYMENT_NOT_FOUND') {
    receipt.classification = 'deployment_unavailable';
  } else if (status >= 200 && status < 300) receipt.classification = 'unexpected_public_response';
  return receipt;
}

/**
 * Build a safe report even when the manifest cannot load. A null selection is an offline overview;
 * batch receipts never claim the other three batches ran or that this inventory closes GATE-1.
 */
function reportEnvelope(selected = null) {
  const inventory = selected ? selected.hosts : [];
  return { schemaVersion: 2, scope: 'selected_login_host_access_only', mode: 'prepare', result: 'prepared',
    gate1Status: 'open', hostedEvidence: 'not_executed', target: TARGET,
    limits: { ...LIMITS, maxRequests: selected ? inventory.length : 0 },
    inventoryId: INVENTORY_ID, inventorySha256: INVENTORY_SHA256,
    batch: selected ? selected.id : null, batchSizes: BATCH_SIZES, totalInventoryHosts: TOTAL_HOSTS,
    outsideSelectedBatch: TOTAL_HOSTS - inventory.length,
    inventory, inventorySource: 'authenticated_management_inventory_2026_09_23_delta_from_2026_09_22_login',
    coverage: { allHistoricalGeneratedUrls: false, allPreviews: false, sourceAndWafAgreement: false },
    requests: 0, responses: 0, expectedPatterns: 0, unvisited: inventory.length,
    receipts: [], failure: null, startedAt: null, finishedAt: null, elapsedMs: 0 };
}

/** Prepare only the overview or explicitly selected batch; no network or automatic progression. */
function preparation(batch = null) {
  validateInventory();
  return reportEnvelope(batch === null ? null : selectBatch(batch));
}

/** Round monotonic durations for sanitized reports. */
function rounded(value) { return Math.round(value * 1000) / 1000; }

/**
 * Traverse one frozen batch sequentially; unavailable ERROR hosts retain non-qualifying receipts
 * without stopping collection. Other unresolved or unexpected results stop the batch immediately.
 * Tests inject HTTPS rather than bypassing the transport. No automatic retries or re-runs exist.
 */
async function runLive({ batch, requestImpl = https.request, signal,
  requestMs = LIMITS.requestMs, overallMs = LIMITS.overallMs } = {}) {
  validateInventory();
  const selected = selectBatch(batch);
  const report = preparation(batch);
  report.mode = 'live'; report.result = 'stopped'; report.hostedEvidence = 'requires_review';
  report.startedAt = new Date().toISOString();
  const start = performance.now();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer;
  try {
    if (!Number.isInteger(overallMs) || overallMs < 1 || overallMs > LIMITS.overallMs
      || !Number.isInteger(requestMs) || requestMs < 1 || requestMs > LIMITS.requestMs) {
      throw new HostError('request_budget');
    }
    /** Cancel an in-flight request at the overall bound. */
    function deadline() { controller.abort(); }
    timer = setTimeout(deadline, overallMs);
    for (const host of selected.hosts) {
      if (controller.signal.aborted || performance.now() - start >= overallMs) throw new HostError('overall_deadline');
      if (combined.aborted) throw new HostError('cancelled');
      if (report.requests >= report.limits.maxRequests) throw new HostError('request_budget');
      const before = performance.now();
      report.requests++; report.unvisited--;
      try {
        const response = await requestHost(host, { requestImpl, signal: combined, requestMs });
        report.responses++;
        if (controller.signal.aborted || performance.now() - start >= overallMs) throw new HostError('overall_deadline');
        if (combined.aborted) throw new HostError('cancelled');
        const receipt = classify(host, response);
        receipt.durationMs = rounded(performance.now() - before);
        report.receipts.push(receipt);
        if (host.recordedState === 'ERROR' && receipt.classification === 'deployment_unavailable') {
          report.failure = 'deployment_unavailable';
          continue;
        }
        if (!receipt.expectedPatternObserved) throw new HostError(receipt.classification);
        report.expectedPatterns++;
      } catch (error) {
        const safeError = controller.signal.aborted ? new HostError('overall_deadline')
          : error instanceof HostError ? error : new HostError('internal_error');
        if (report.receipts.at(-1)?.hostname !== host.hostname) {
          report.receipts.push({ hostname: host.hostname, phase: 'login', status: null,
            classification: safeError.code, vercelId: null, loginBuildRecognized: false,
            knownBuildMatch: null, expectedPatternObserved: false, durationMs: rounded(performance.now() - before) });
        }
        throw safeError;
      }
    }
    // A fully visited batch with unavailable deployments still cannot claim successful qualification.
    if (report.failure === null) report.result = 'completed';
  } catch (error) { report.failure = error instanceof HostError ? error.code : 'internal_error'; }
  finally {
    clearTimeout(timer);
    report.elapsedMs = rounded(performance.now() - start);
    report.finishedAt = new Date().toISOString();
  }
  return report;
}

/**
 * Accept only --batch 1..4 and optional --live, once each. No flags prepares the overview;
 * --live without an explicit batch is rejected and never means "run all".
 */
function parseArguments(args) {
  let live = false, batch = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--live' && !live) live = true;
    else if (args[index] === '--batch' && batch === null && /^[1-4]$/.test(args[index + 1] || '')) {
      batch = Number(args[++index]);
    } else throw new HostError('arguments');
  }
  if (live && batch === null) throw new HostError('arguments');
  return { live, batch };
}

/** Emit only fixed report fields/codes, including manifest/argument failures, without raw exceptions. */
async function main(args) {
  let report;
  try {
    const options = parseArguments(args);
    report = options.live ? await runLive({ batch: options.batch }) : preparation(options.batch);
  } catch (error) {
    report = reportEnvelope(); report.result = 'stopped';
    report.failure = error instanceof HostError ? error.code : 'internal_error';
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.result === 'stopped' ? 1 : 0;
}

module.exports = { LIMITS, TARGET, CANONICAL, HOSTS, BATCHES, BATCH_SIZES, INVENTORY_ID, INVENTORY_SHA256,
  HostError, validateInventory, requestHost, classify, preparation, runLive, parseArguments };
if (require.main === module) void main(process.argv.slice(2));
