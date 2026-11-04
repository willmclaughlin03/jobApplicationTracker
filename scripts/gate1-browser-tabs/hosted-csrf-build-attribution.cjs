'use strict';
/* global __dirname, AbortController, Buffer, process, setTimeout, clearTimeout, structuredClone */

/** Single-use anonymous attribution preparation; import never reads files, credentials or the network. */
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFile } = require('node:child_process');
const d = require('./hosted-csrf-diagnostic.cjs');
const RESULT = path.join(d.DIRECTORY, 'build-attribution.json');
const MANIFEST = path.join(d.DIRECTORY, 'build-attribution-plan.json');
const APPROVAL = 'hosted-csrf-build-attribution-01';
const VERCEL = d.VERCEL;
const SOURCE_FILES = Object.freeze([...d.SOURCE_FILES, 'hosted-csrf-build-attribution.cjs',
  '__tests__/hosted-csrf-build-attribution.test.cjs']);
const LIMITS = Object.freeze({ wholeMs: 240000, cleanupMs: 20000, preflightMs: 30000, operationMs: 5000,
  metadataMs: 30000, metadataBytes: 2097152, bodyBytes: 1048576, headerBytes: 32768,
  planBytes: 16384, evidenceBytes: 16384, approvalWindowMs: 3600000, metadata: 6,
  application: 1, static: 0, session: 0, browsers: 0 });
const INCREMENT = Object.freeze({ application: 1, static: 0, session: 0 });
const CODES = new Set(['arguments', 'execution_directory', 'execution_not_approved', 'approval_expired', 'plan_schema',
  'target_mismatch', 'ledger_mismatch', 'source_mismatch', 'history_mismatch', 'toolchain_mismatch', 'manifest_mismatch',
  'debug_logging_enabled', 'evidence_already_exists', 'operation_failed', 'operation_timeout', 'work_deadline',
  'exercise_stopped', 'budget_exceeded', 'metadata_mismatch', 'response_schema', 'response_size', 'response_truncated',
  'redirect', 'build_missing', 'login_contract', 'request_cleanup', 'overall_deadline', 'evidence_size',
  'evidence_write', 'evidence_close']);

/** Use fixed local codes so provider, filesystem and HTTP error messages never become evidence. */
class AttributionError extends Error {
  /** Store a reviewed category rather than any rejected input. */
  constructor(code) { super(code); this.code = code; }
}

/** Fail an invariant without formatting sensitive input into the error. */
function check(ok, code) { if (!ok) throw new AttributionError(code); }

/** Admit only recognized local errors; native messages and caller-provided code strings are discarded. */
function errorCode(error) {
  return (error instanceof AttributionError || error instanceof d.DiagnosticError) && CODES.has(error.code)
    ? error.code : 'operation_failed';
}

/** Require the exact scalar fields of an approved object, rejecting hidden destinations or budgets. */
function equalObject(actual, expected) {
  return actual && Object.keys(actual).length === Object.keys(expected).length
    && Object.keys(expected).every(key => actual[key] === expected[key]);
}

/** Reject fractional, overflowing or inconsistent cumulative counters before dispatch. */
function validCounts(value) {
  return value && Object.keys(value).sort().join(',') === 'application,session,static'
    && Object.values(value).every(n => Number.isSafeInteger(n) && n >= 0) && value.session <= value.application;
}

/** Bind one short-lived approval to exact identity, code, resource ceilings and cumulative consumption. */
function validatePlan(plan, now = Date.now()) {
  check(plan?.approval === APPROVAL, 'execution_not_approved');
  check(equalObject(plan.target, d.TARGET), 'target_mismatch');
  check(equalObject(plan.limits, LIMITS), 'plan_schema');
  check(Number.isSafeInteger(plan.approvedAt) && Number.isSafeInteger(plan.expiresAt)
    && plan.approvedAt <= now && now < plan.expiresAt && plan.expiresAt - plan.approvedAt <= LIMITS.approvalWindowMs,
  'approval_expired');
  check(typeof plan.sourceSet === 'string' && /^[a-f0-9]{64}$/.test(plan.sourceSet), 'source_mismatch');
  for (const kind of ['actual', 'conservative']) {
    const before = plan.ledgerBefore?.[kind]; const ceiling = plan.ledgerCeiling?.[kind];
    check(validCounts(before) && validCounts(ceiling)
      && Object.keys(INCREMENT).every(key => before[key] >= d.BASELINE[kind][key])
      && equalObject(ceiling, d.addCounts(before, INCREMENT)), 'ledger_mismatch');
  }
  check(Object.keys(INCREMENT).every(key => plan.ledgerBefore.conservative[key] >= plan.ledgerBefore.actual[key]), 'ledger_mismatch');
}

/** Stream hashes only for named source/tool inputs; check cancellation between chunks. */
async function hashFile(file, signal) {
  const crypto = require('node:crypto'); const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

/** Extend the unchanged nine-file diagnostic contract with this helper/test; qualified six-file checks remain inside it. */
async function sourceHashes(signal) {
  const original = await d.sourceHashes(); const files = { ...original.files };
  for (const name of SOURCE_FILES.slice(d.SOURCE_FILES.length)) {
    check(!signal?.aborted, 'exercise_stopped'); files[name] = await hashFile(path.join(__dirname, name), signal);
  }
  return { files, set: d.digest(JSON.stringify(files)), diagnosticSet: original.set };
}

/** Verify only the runtime and guarded CLI needed here; no browser package is loaded or launched. */
async function toolHashes(signal) {
  check(process.version === 'v22.18.0', 'toolchain_mismatch');
  const pkg = (await d.readJson(path.join(path.dirname(VERCEL), '../package.json'))).data;
  check(pkg.name === 'vercel' && pkg.version === '62.2.0', 'toolchain_mismatch');
  const files = {};
  for (const [name, expected] of Object.entries(d.VERCEL_HASHES)) {
    check(!signal?.aborted, 'exercise_stopped'); files[name] = await hashFile(path.join(path.dirname(VERCEL), name), signal);
    check(files[name] === expected, 'toolchain_mismatch');
  }
  return files;
}

/** Read approval/source/history/tool integrity without requiring the not-yet-created build or authentication receipts. */
async function integrity(signal) {
  const manifest = await d.readJson(MANIFEST, LIMITS.planBytes);
  const sources = await sourceHashes(signal); check(!signal?.aborted, 'exercise_stopped');
  const history = await d.historyHashes(); check(!signal?.aborted, 'exercise_stopped');
  return { manifestHash: manifest.hash, sources, history, tools: await toolHashes(signal) };
}

/** Refuse execution outside the dedicated real directory or with unsafe debugging flags, before any output reservation. */
async function preflight(plan, signal) {
  check(path.resolve(__dirname) === path.resolve(d.DIRECTORY), 'execution_directory');
  const stat = await fs.lstat(d.DIRECTORY);
  check(stat.isDirectory() && !stat.isSymbolicLink()
    && path.resolve(await fs.realpath(d.DIRECTORY)) === path.resolve(d.DIRECTORY), 'execution_directory');
  check(!['DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'NODE_OPTIONS', 'NODE_DEBUG'].some(name => process.env[name]), 'debug_logging_enabled');
  const inputs = await integrity(signal); verifyInputs(inputs, plan); return inputs;
}

/** Verify every frozen dependency category; postflight also binds the exact original manifest bytes. */
function verifyInputs(inputs, plan, original) {
  check(inputs?.sources?.set === plan.sourceSet, 'source_mismatch');
  check(equalObject(inputs.history, d.HISTORY), 'history_mismatch');
  check(equalObject(inputs.tools, d.VERCEL_HASHES), 'toolchain_mismatch');
  check(typeof inputs.manifestHash === 'string' && /^[a-f0-9]{64}$/.test(inputs.manifestHash)
    && (!original || inputs.manifestHash === original.manifestHash), 'manifest_mismatch');
}

/** Bound a promise and release its timer; the timeout callback cancels the actual owned transport. */
async function bounded(action, milliseconds, cancel = () => {}) {
  check(milliseconds > 0, 'overall_deadline'); let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => { reject(new AttributionError('operation_timeout')); cancel(); }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Own one work clock and abort signal; stopped/late operations cannot reserve another dispatch. */
class Budget {
  /** Reserve twenty seconds for cancellation, integrity and receipt finalization. */
  constructor(clock = Date.now, startedAt = clock()) {
    this.clock = clock; this.startedAt = startedAt; this.workDeadline = startedAt + LIMITS.wholeMs - LIMITS.cleanupMs;
    this.controller = new AbortController(); this.firstFailure = null; this.halted = false;
    this.counts = { metadata: 0, application: 0, static: 0, session: 0, browsers: 0 };
  }
  /** Check both the failure latch and absolute clock immediately before dispatch and after each await. */
  check() { check(!this.halted && !this.controller.signal.aborted, 'exercise_stopped'); check(this.clock() < this.workDeadline, 'work_deadline'); }
  /** Charge a possible dispatch before transport entry; no failed/uncertain dispatch gets refunded. */
  count(kind) { this.check(); check(Object.hasOwn(this.counts, kind) && this.counts[kind] < LIMITS[kind], 'budget_exceeded'); this.counts[kind]++; }
  /** Preserve the first observed failure and immediately cancel owned in-flight network operations. */
  stop(error, stage) { this.firstFailure ||= { code: errorCode(error), stage }; this.halted = true; this.controller.abort(); }
  /** Bound each stage by its own cap and the remaining work window, with cancellation on timeout. */
  async step(action, maximum = LIMITS.operationMs) {
    this.check();
    const result = await bounded(() => { this.check(); return action(this.controller.signal); },
      Math.min(maximum, this.workDeadline - this.clock()), () => this.controller.abort());
    this.check(); return result;
  }
}

/** Track actual native close events independently of promise resolution; cleanup must observe every close. */
function own(resource, owners) {
  const owner = { closed: false, done: null };
  owner.done = new Promise(resolve => resource.once('close', () => { owner.closed = true; resolve(); }));
  owners.push(owner); return owner;
}

/** Reuse the exact guarded CLI arguments, adding abortable child ownership without refresh/retry/redirect paths. */
function metadata(kind, signal, owners, execute = execFile) {
  check(!signal.aborted, 'exercise_stopped');
  return new Promise((resolve, reject) => {
    const child = execute(process.execPath, d.metadataArguments(kind), { windowsHide: true, signal,
      timeout: LIMITS.metadataMs, maxBuffer: LIMITS.metadataBytes,
      env: { ...process.env, VERCEL_CLI_USE_NATIVE_BINARY: '0', VERCEL_TELEMETRY_DISABLED: '1', NO_UPDATE_NOTIFIER: '1' } },
    (error, stdout) => {
      if (error) { reject(new AttributionError('operation_failed')); return; }
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); }
      catch { reject(new AttributionError('response_schema')); }
    });
    own(child, owners);
  });
}

/** Convert bounded native raw headers without merging duplicates or retaining their values in evidence. */
function responseHeaders(response) {
  check(Array.isArray(response.rawHeaders) && response.rawHeaders.length % 2 === 0, 'response_schema');
  const headers = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2) headers.push({ name: response.rawHeaders[i], value: response.rawHeaders[i + 1] });
  d.headersOf({ headers }); return headers;
}

/** Read exactly one anonymous canonical response, aborting during streaming rather than after unbounded buffering. */
function requestLogin(signal, owners, transport = https.request) {
  check(!signal.aborted, 'exercise_stopped');
  return new Promise((resolve, reject) => {
    let request; let response; let timer; let settled = false; let size = 0; const chunks = [];
    /** Finish only once, cancel the socket and erase temporary chunks on every outcome. */
    function finish(error, value) {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      response?.destroy(); request?.destroy(); chunks.length = 0;
      if (error) reject(error); else resolve(value);
    }
    /** A caller timeout/stop destroys the actual request; it cannot merely abandon a pending promise. */
    function abort() { finish(new AttributionError('operation_timeout')); }
    signal.addEventListener('abort', abort, { once: true });
    try {
      request = transport(d.ORIGIN + '/login', { method: 'GET', agent: false, maxHeaderSize: LIMITS.headerBytes,
        headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache, no-store, max-age=0', Pragma: 'no-cache' } }, incoming => {
        response = incoming;
        if (settled || signal.aborted) { incoming.destroy(); return; }
        try {
          check(incoming.statusCode < 300 || incoming.statusCode >= 400, 'redirect');
          const headers = responseHeaders(incoming); const mapped = d.headersOf({ headers });
          const lengths = mapped.get('content-length');
          check(!lengths || (lengths.length === 1 && /^\d+$/.test(lengths[0]) && Number(lengths[0]) <= LIMITS.bodyBytes), 'response_size');
          check(!mapped.has('content-encoding') || equalObject(mapped.get('content-encoding'), ['identity']), 'response_schema');
          incoming.on('data', chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > LIMITS.bodyBytes) { finish(new AttributionError('response_size')); return; }
            chunks.push(chunk);
          });
          incoming.once('end', () => {
            if (settled) return;
            if (!incoming.complete || (lengths && size !== Number(lengths[0]))) { finish(new AttributionError('response_truncated')); return; }
            finish(null, { status: incoming.statusCode, headers, body: Buffer.concat(chunks, size) });
          });
          incoming.once('aborted', () => finish(new AttributionError('response_truncated')));
          incoming.once('error', () => finish(new AttributionError('response_truncated')));
        } catch (error) { finish(new AttributionError(errorCode(error))); }
      });
      own(request, owners);
      request.once('error', error => finish(new AttributionError(error.code === 'HPE_HEADER_OVERFLOW' ? 'response_size' : 'operation_failed')));
      request.once('close', () => { if (!settled) finish(new AttributionError('response_truncated')); });
      timer = setTimeout(abort, LIMITS.operationMs);
      if (signal.aborted) abort(); else request.end();
    } catch { finish(new AttributionError('operation_failed')); }
  });
}

/** Extract one narrowly formed Next data element; reject duplicate/malformed IDs before reusing the public cache policy. */
function loginAttribution(response) {
  check(Buffer.isBuffer(response?.body) && response.body.length <= LIMITS.bodyBytes, 'response_size');
  const headers = d.headersOf(response); const types = headers.get('content-type');
  check(types?.length === 1 && /^text\/html(?:\s*;\s*charset=utf-8)?$/i.test(types[0]), 'login_contract');
  const html = response.body.toString('utf8')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(template|textarea|title|style|noscript|xmp|iframe|noembed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<plaintext\b[\s\S]*$/gi, '');
  const candidates = [];
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = [...script[1].matchAll(/(?:^|\s)([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)];
    const ids = attrs.filter(attr => attr[1].toLowerCase() === 'id');
    if (!ids.some(attr => (attr[2] ?? attr[3] ?? attr[4]) === '__NEXT_DATA__')) continue;
    check(ids.length === 1 && ids[0][4] === undefined, 'build_missing');
    let data; try { data = JSON.parse(script[2]); } catch { throw new AttributionError('build_missing'); }
    let depth = 0; let buildKeys = 0;
    for (const token of script[2].matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)) {
      if (token[0] === '{' || token[0] === '[') depth++;
      else if (token[0] === '}' || token[0] === ']') depth--;
      else if (depth === 1 && /^\s*:/.test(script[2].slice(token.index + token[0].length))
        && JSON.parse(token[0]) === 'buildId') buildKeys++;
    }
    check(buildKeys === 1, 'build_missing');
    check(typeof data?.buildId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.buildId), 'build_missing');
    candidates.push(data.buildId);
  }
  check(candidates.length === 1, 'build_missing');
  const checks = d.loginChecks(response, candidates[0]);
  check(Object.values(checks).every(value => value === true), 'login_contract');
  return { buildId: candidates[0], checks: { ...checks, contentType: true, uniqueBuild: true } };
}

/** Create native dependencies lazily; only a separately approved invocation can reserve output or contact services. */
function nativeDependencies() {
  const owners = [];
  return { preflight, integrity, reserve: () => fs.open(RESULT, 'wx'),
    metadata: (kind, signal) => metadata(kind, signal, owners), request: signal => requestLogin(signal, owners),
    cancel: async () => { await Promise.all(owners.map(owner => owner.done)); return owners.every(owner => owner.closed); } };
}

/** Serialize only local fields with a cap compatible with the diagnostic's existing preparation reader. */
function encodeEvidence(record) {
  const text = JSON.stringify(record, null, 2) + '\n'; check(Buffer.byteLength(text) <= LIMITS.evidenceBytes, 'evidence_size'); return text;
}

/** Run the reviewed sequence once; failures suppress later traffic and keep the consumed evidence path. */
async function runAttribution(input, deps = nativeDependencies()) {
  const plan = structuredClone(input); const budget = new Budget(deps.clock, deps.startedAt);
  validatePlan(plan, budget.startedAt);
  const inputs = await budget.step(signal => deps.preflight(plan, signal),
    LIMITS.preflightMs - (budget.clock() - budget.startedAt)); verifyInputs(inputs, plan);
  let destination; let reservationExpired = false;
  try {
    destination = await budget.step(async () => {
      const handle = await deps.reserve();
      if (reservationExpired || budget.controller.signal.aborted) { await handle.close(); throw new AttributionError('operation_timeout'); }
      destination = handle; return handle;
    });
  } catch (error) {
    reservationExpired = true; budget.controller.abort();
    if (destination) {
      try { await bounded(() => destination.close(), 1000); }
      catch { /* Preserve the reservation failure; the consumed path must never be retried. */ }
    }
    throw new AttributionError(error?.code === 'EEXIST' ? 'evidence_already_exists' : errorCode(error));
  }
  const record = { schemaVersion: 1, scope: 'anonymous_login_build_attribution', phase: 'running', gate1Status: 'open',
    operator: 'Codex agent', operationalOwner: 'Project owner', target: d.TARGET, limits: LIMITS,
    sourceSet: plan.sourceSet, manifestHash: inputs.manifestHash,
    sourceHashes: Object.fromEntries(SOURCE_FILES.map(name => [name, inputs.sources.files[name]])),
    priorEvidenceHashes: { ...d.HISTORY }, toolHashes: { ...d.VERCEL_HASHES }, metadata: [], checks: {}, cleanupFailures: [],
    startedAt: new Date(budget.startedAt).toISOString(), successfulMetadataResponses: 0, historicalBackgroundTrafficMeasured: false };
  let stage = 'metadata_before'; let finalizationError;
  try {
    for (const phase of ['before', 'after']) {
      stage = 'metadata_' + phase;
      for (const kind of ['project', 'alias', 'deployment']) {
        validatePlan(plan, budget.clock());
        const data = await budget.step(signal => { budget.count('metadata'); return deps.metadata(kind, signal); }, LIMITS.metadataMs);
        record.successfulMetadataResponses++;
        d.validateMetadata(kind, data); record.metadata.push({ phase, kind, matches: true });
      }
      if (phase === 'before') {
        stage = 'login'; validatePlan(plan, budget.clock());
        const response = await budget.step(signal => { budget.count('application'); return deps.request(signal); });
        const result = loginAttribution(response); record.buildId = result.buildId; record.checks = result.checks;
      }
    }
    budget.check(); record.phase = 'passed';
  } catch (error) { budget.stop(error, stage); record.phase = 'stopped'; }
  finally {
    budget.halted = true; budget.controller.abort();
    const deadline = Math.min(budget.startedAt + LIMITS.wholeMs, budget.clock() + LIMITS.cleanupMs);
    /** Record cleanup failures independently without replacing the first case failure. */
    function failed(error) { const code = errorCode(error); record.cleanupFailures.push(code); budget.stop(new AttributionError(code), 'cleanup'); }
    try {
      check(await bounded(() => deps.cancel(), Math.min(5000, deadline - budget.clock())) === true, 'request_cleanup');
      record.ownedResourcesClosed = true;
    } catch { record.ownedResourcesClosed = false; failed(new AttributionError('request_cleanup')); }
    const postflight = new AbortController();
    try {
      const after = await bounded(() => deps.integrity(postflight.signal), Math.min(10000, deadline - budget.clock() - 5000), () => postflight.abort());
      verifyInputs(after, plan, inputs); record.integrityUnchanged = true;
    } catch (error) { record.integrityUnchanged = false; failed(error); }
    finally { postflight.abort(); }
    record.counts = { ...budget.counts };
    record.requests = { application: budget.counts.application, static: 0, session: 0 };
    record.matchedMetadataResponses = record.metadata.length;
    record.ledgerBefore = Object.fromEntries(['actual', 'conservative'].map(kind => [kind, { ...plan.ledgerBefore[kind] }]));
    record.ledgerAfter = Object.fromEntries(['actual', 'conservative'].map(kind => [kind, d.addCounts(plan.ledgerBefore[kind], record.requests)]));
    record.dispatchAccounting = 'reserved_before_transport_not_proof_of_server_receipt';
    record.finalizationStartedAt = new Date(budget.clock()).toISOString(); record.elapsedBeforeFinalizationMs = budget.clock() - budget.startedAt;
    if (budget.clock() >= deadline) failed(new AttributionError('overall_deadline'));
    record.firstFailure = budget.firstFailure; if (record.firstFailure) record.phase = 'stopped';
    try {
      await bounded(async () => { await destination.writeFile(encodeEvidence(record)); await destination.sync(); },
        Math.min(3000, deadline - budget.clock() - 1000));
    } catch (error) { finalizationError = new AttributionError(errorCode(error) === 'evidence_size' ? 'evidence_size' : 'evidence_write'); }
    finally {
      try { await bounded(() => destination.close(), Math.min(1000, deadline - budget.clock())); }
      catch { finalizationError ||= new AttributionError('evidence_close'); }
    }
  }
  if (finalizationError) {
    // A partial or apparently passed file is unusable if the process reports a finalization error.
    finalizationError.firstFailure = record.firstFailure || { code: finalizationError.code, stage: 'evidence' };
    throw finalizationError;
  }
  check(budget.clock() < budget.startedAt + LIMITS.wholeMs, 'overall_deadline');
  return record;
}

/** Read only the fixed reviewed manifest in the execution directory; preparation creates neither it nor an execution copy. */
async function main(args) {
  check(args.length === 1 && args[0] === '--execute-reviewed-manifest', 'arguments');
  check(path.resolve(__dirname) === path.resolve(d.DIRECTORY), 'execution_directory');
  const startedAt = Date.now(); const initial = await bounded(() => d.readJson(MANIFEST, LIMITS.planBytes), LIMITS.preflightMs);
  const deps = nativeDependencies(); deps.startedAt = startedAt;
  const originalPreflight = deps.preflight;
  /** Bind the parsed manifest to the exact bytes rechecked by preflight, preventing a read-to-use replacement. */
  deps.preflight = async (plan, signal) => {
    const inputs = await originalPreflight(plan, signal); check(inputs.manifestHash === initial.hash, 'manifest_mismatch'); return inputs;
  };
  const record = await runAttribution(initial.data, deps);
  process.stdout.write(JSON.stringify({ phase: record.phase, firstFailure: record.firstFailure, counts: record.counts,
    completedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt,
    gate1Status: 'open', receiptFinalized: true }) + '\n');
  if (record.phase !== 'passed') process.exitCode = 1;
}

module.exports = { RESULT, MANIFEST, APPROVAL, SOURCE_FILES, LIMITS, INCREMENT, AttributionError, errorCode,
  validatePlan, sourceHashes, toolHashes, preflight, verifyInputs, Budget, metadata, requestLogin,
  loginAttribution, nativeDependencies, encodeEvidence, runAttribution, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(JSON.stringify({ stopCode: errorCode(error), firstFailure: error.firstFailure || null, receiptFinalized: false }) + '\n');
  process.exitCode = 1;
});
