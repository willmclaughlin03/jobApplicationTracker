'use strict';

// Operator diagnostic only. Live use requires separate operator approval.
const https = require('node:https');
const { performance } = require('node:perf_hooks');
const { z } = require('zod');

const LIMITS = Object.freeze({ maxRequests: 30, concurrency: 1, requestMs: 10000,
  overallMs: 300000, responseBytes: 1048576, headerBytes: 16384 });
const TARGET = Object.freeze({
  hostname: 'job-application-tracker-2us07txao-track-the-app.vercel.app',
  deploymentId: 'dpl_4YgmSZxMSs98BNqsx4Ncv27jPTpR',
  gitSha: 'e50c5e9046a2f9fa27b611d0c871739e851f9a77',
  nextBuildId: 'BFz2LBQGfVz3-Nkqc41GH',
  buildAttribution: 'operator_supplied_not_yet_http_verified',
});
const CANONICAL = 'job-application-tracker-kappa-seven.vercel.app';
// Authenticated GET /v4/aliases, 2026-09-21: 28 entries, pagination.next null.
// Only this canonical hostname is expected to expose the public login page.
const ALIASES = [
  [CANONICAL, TARGET.deploymentId],
  ['job-application-tracker-track-the-app.vercel.app', TARGET.deploymentId],
  ['job-application-tracker-git-main-track-the-app.vercel.app', TARGET.deploymentId],
  ['job-application-tracker-git-docs-gate1-res-647e64-track-the-app.vercel.app', 'dpl_5Bu3YhiBgQFHRbpyvdFyxQwfP28k'],
  ['job-application-tracker-git-fix-gate1-rest-79cdad-track-the-app.vercel.app', 'dpl_6QRMKaYQrJJdw5asEXU79ZTufhNK'],
  ['job-application-tracker-git-chore-gate1-re-23ae02-track-the-app.vercel.app', 'dpl_GuotfsqmgkoN3rHRwJHXWDi1HgQv'],
  ['job-application-tracker-git-fix-gate1-prob-622e20-track-the-app.vercel.app', 'dpl_EKAy6NcPvTNv2CnbV3Fo4JvDD2qW'],
  ['job-application-tracker-git-fix-gate1-prod-82351f-track-the-app.vercel.app', 'dpl_8zLJvK6VHT5x5g2xXUPNuc7TwDGo'],
  ['job-application-tracker-git-chore-gate1-re-7e5bf4-track-the-app.vercel.app', 'dpl_6UuQLARptGkoTL4TcZrfX8Jn4bjr'],
  ['job-application-tracker-git-fix-billing-st-0345aa-track-the-app.vercel.app', 'dpl_21Y9uiHQxny5rUn14yQnbza3kbya'],
  ['job-application-tracker-git-agent-billing-501301-track-the-app.vercel.app', 'dpl_DVphA6Wg37jrBojZDo1xA2wiAoWB'],
  ['job-application-tracker-git-chore-gate1-re-f1e169-track-the-app.vercel.app', 'dpl_BzbHGxr6EmKnPtvbQep9B4suWxxk'],
  ['job-application-tracker-git-chore-gate1-re-20d833-track-the-app.vercel.app', 'dpl_4YBWUAbbTgeWqp76ytoCwGSMLmHp'],
  ['job-application-tracker-git-fix-gate1-setu-965ee3-track-the-app.vercel.app', 'dpl_5UBjJgfY2uBWFpyJUjLfNBTPe9NB'],
  ['job-application-tracker-git-fix-gate1-setu-5517e8-track-the-app.vercel.app', 'dpl_9x3146VWovRnw2qNDoZ6rGECNbHW'],
  ['job-application-tracker-git-chore-gate1-sh-7a7360-track-the-app.vercel.app', 'dpl_92u4DaLeDGwH3YZ8x7uDMao5S4dN'],
  ['job-application-tracker-git-fix-applicatio-03a983-track-the-app.vercel.app', 'dpl_DNRuwKwjLmHvE7bPKtJYS4BnaNqA'],
  ['job-application-tracker-git-fix-royal-blue-f161bd-track-the-app.vercel.app', 'dpl_AwHP1o7fNdJoScwkVB8oG4myyz3Q'],
  ['job-application-tracker-git-fix-activity-c-95fd80-track-the-app.vercel.app', 'dpl_7a5vo4jEMB1xQ4U6rH3ybn9SCLn5'],
  ['job-application-tracker-git-fix-protected-b33cc1-track-the-app.vercel.app', 'dpl_EbYLvmeQsyn92fbFHFJBFQkj696e'],
  ['job-application-tracker-git-fix-protected-4fecff-track-the-app.vercel.app', 'dpl_3TshrUhPqkjw19qRt188er1VuGx5'],
  ['job-application-tracker-git-fix-protected-dc642a-track-the-app.vercel.app', 'dpl_5E5cdaArF2Sucmo1huNWW8NKHfzx'],
  ['job-application-tracker-git-fix-chunk6-cac-fb4427-track-the-app.vercel.app', 'dpl_8sfYMppxBVH2iri1n6hEFGLcwzWA'],
  ['job-application-tracker-git-fix-chunk6-cac-ef9fb1-track-the-app.vercel.app', 'dpl_2p59i4ab9daoHzLYGEWNUJQHZVwc'],
  ['job-application-tracker-git-fix-vercel-dom-f34bc5-track-the-app.vercel.app', 'dpl_3tnnBSjTiTnuJ4vxKbNswHQM5piK'],
  ['job-application-tracker-git-fix-deployed-a-31d988-track-the-app.vercel.app', 'dpl_CYiZgTaacFWXNpYcPikNFuG5jZNw'],
  ['job-application-tracker-git-staging-track-the-app.vercel.app', 'dpl_4To6uyRQAhXq5g7A8eREkRZy7DUB'],
  ['job-application-tracker-git-fix-upstash-no-4452ba-track-the-app.vercel.app', 'dpl_89DH3bxcUWkpDjHTcEc3mr8pduWA'],
];
const hostSchema = z.object({
  hostname: z.string().max(253).regex(/^job-application-tracker-[a-z0-9-]+\.vercel\.app$/),
  deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
  expected: z.enum(['public_login', 'gate_or_canonical_redirect']),
  knownBuildId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
}).strict();

/** Convert fixed API alias metadata into immutable expectations; no external host input is accepted. */
function aliasTarget([hostname, deploymentId]) {
  return Object.freeze(hostSchema.parse({ hostname, deploymentId,
    expected: hostname === CANONICAL ? 'public_login' : 'gate_or_canonical_redirect',
    knownBuildId: deploymentId === TARGET.deploymentId ? TARGET.nextBuildId : null }));
}
const HOSTS = Object.freeze([
  ...ALIASES.map(aliasTarget),
  Object.freeze(hostSchema.parse({ hostname: TARGET.hostname, deploymentId: TARGET.deploymentId,
    expected: 'gate_or_canonical_redirect', knownBuildId: TARGET.nextBuildId })),
  Object.freeze(hostSchema.parse({ hostname: 'job-application-tracker-crnzr0il1-track-the-app.vercel.app',
    deploymentId: 'dpl_AaGEjVjtrjaiLbHqAyCKYfdFraU6', expected: 'gate_or_canonical_redirect',
    knownBuildId: 'VjEJE3geVJngqDN7JymXV' })),
]);
const CODES = new Set(['arguments', 'inventory', 'request_timeout', 'overall_deadline', 'cancelled',
  'transport_error', 'response_size', 'response_headers', 'response_encoding', 'response_incomplete',
  'build_mismatch', 'unexpected_public_login', 'unexpected_public_response', 'unresolved_response',
  'deployment_unavailable', 'unexpected_gate', 'request_budget', 'internal_error']);

/** Carry only fixed failure codes; never retain transport messages, URLs, headers or bodies. */
class HostError extends Error {
  /** Normalize an internal reason before it crosses the report boundary. */
  constructor(code) { super(CODES.has(code) ? code : 'internal_error'); this.code = this.message; }
}

/** Reject any caller-supplied target, including a copy with changed expectations, before dispatch. */
function validateHost(host) {
  if (!HOSTS.includes(host)) throw new HostError('inventory');
  return host;
}

/** Validate the complete frozen scope before either preparation or live work. */
function validateInventory() {
  if (HOSTS.length !== LIMITS.maxRequests || new Set(HOSTS.map(hostnameOf)).size !== HOSTS.length) {
    throw new HostError('inventory');
  }
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
    const token = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
    let position = 0;
    while (attributeText.slice(position).trim()) {
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

/** Build the fixed report envelope; preparation does not contact application hosts. */
function preparation() {
  validateInventory();
  return { schemaVersion: 1, scope: 'selected_login_host_access_only', mode: 'prepare', result: 'prepared',
    gate1Status: 'open', hostedEvidence: 'not_executed', target: TARGET, limits: LIMITS,
    inventory: HOSTS, inventorySource: 'authenticated_alias_api_2026_09_21_plus_two_immutable_hosts',
    coverage: { allHistoricalGeneratedUrls: false, allPreviews: false, sourceAndWafAgreement: false },
    requests: 0, responses: 0, expectedPatterns: 0, unvisited: HOSTS.length,
    receipts: [], failure: null, startedAt: null, finishedAt: null, elapsedMs: 0 };
}

/** Round monotonic durations for sanitized reports. */
function rounded(value) { return Math.round(value * 1000) / 1000; }

/**
 * Traverse the frozen inventory sequentially and stop on the first unresolved or unexpected result.
 * Tests inject HTTPS rather than bypassing the transport. No automatic retries or re-runs exist.
 */
async function runLive({ requestImpl = https.request, signal,
  requestMs = LIMITS.requestMs, overallMs = LIMITS.overallMs } = {}) {
  const report = preparation();
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
    for (const host of HOSTS) {
      if (controller.signal.aborted || performance.now() - start >= overallMs) throw new HostError('overall_deadline');
      if (combined.aborted) throw new HostError('cancelled');
      if (report.requests >= LIMITS.maxRequests) throw new HostError('request_budget');
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
    report.result = 'completed';
  } catch (error) { report.failure = error instanceof HostError ? error.code : 'internal_error'; }
  finally {
    clearTimeout(timer);
    report.elapsedMs = rounded(performance.now() - start);
    report.finishedAt = new Date().toISOString();
  }
  return report;
}

/** Accept only the explicit live flag; arbitrary hosts, paths, credentials and overrides are forbidden. */
function parseArguments(args) {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === '--live') return true;
  throw new HostError('arguments');
}

/** Emit only the report, including fixed failure codes for CLI errors; stdout is safe to persist. */
async function main(args) {
  let report;
  try { report = parseArguments(args) ? await runLive() : preparation(); }
  catch (error) {
    report = preparation(); report.result = 'stopped';
    report.failure = error instanceof HostError ? error.code : 'internal_error';
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.result === 'stopped' ? 1 : 0;
}

module.exports = { LIMITS, TARGET, CANONICAL, HOSTS, HostError, validateInventory,
  requestHost, classify, preparation, runLive, parseArguments };
if (require.main === module) void main(process.argv.slice(2));
