'use strict';
/* global __dirname, Buffer, process, Headers, Response, AbortController, setTimeout, clearTimeout */

/** One guarded CLI-managed provider read. No CLI import or authorization access occurs during preparation. */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

// These nonsecret paths let a linked PR checkout use the preserved qualification workspace.
// CLI hashes remain mandatory for every location; this never accepts a credential override.
const ROOT = path.resolve(process.env.GATE1_REVIEW_WORKSPACE || path.join(__dirname, '../../..'));
const ZOD_PIN = Object.freeze({ file: 'node_modules/zod/index.cjs',
  sha256: '2a3455cecff4f7021c92d0a3e2e5fc170c0448dc5cc261160127e08f4888a9c2' });
// Bind both runners to the workspace copy covered by preparation, regardless of checkout-local modules.
const ZOD_ENTRY = require.resolve(path.join(ROOT, ZOD_PIN.file));
const { z } = require(ZOD_ENTRY);
const CLI = path.resolve(process.env.GATE1_VERCEL_CLI_DIST || path.join(os.homedir(),
  'AppData/Local/npm-cache/_npx/67eb4586ca667318/node_modules/vercel/dist'));
const TARGET = Object.freeze({ projectId: 'prj_b2nMrysMSJtpmqoeGx5g0WGgGuom',
  teamId: 'team_7o3efmwjZbMc2Bfy9qAzkc9q', hostname: 'job-application-tracker-kappa-seven.vercel.app',
  deploymentId: 'dpl_49owz1V7RHb16gkjdqFhnwJrzzDS', gitSha: '50c4a957f6a8d025b8e492ad2833c896b3d6b711',
  immutableHostname: 'job-application-tracker-4ermbh0vw-track-the-app.vercel.app',
  buildId: 'NkVOoraS7zEuaGAABtan4', aliasUpdatedAt: 1794770196744 });
const LIMITS = Object.freeze({ providerMs: 10000, childMs: 30000, responseBytes: 1048576,
  headerBytes: 16384, ipcBytes: 131072, outputBytes: 131072,
  builds: 64, outputs: 2048 });
const PINS = Object.freeze({
  'commands-bulk.js': 'bae746872766931dc9f8142fdb32cfdeaa7ec7c4a8216028550ba50504929975',
  'vc.js': 'a0459896d4698233bab881d308ade711a772cde6bcc845728731a38ef0348090',
  'index.js': 'c660c023b57fa4238257ea211741493ce5dbb329cc6ba4bb3ad7614ac6bfc5c5',
  'chunks/chunk-DECIQZZQ.js': '2ab9699b44b2692ae8087c3ae1787183d87bdfcb349bbace491c6095ba355b7f',
  'chunks/chunk-KREBNPHL.js': '68f2577a4f42085237bce5a1ae017dcbf6cf0387111476c16d5c06d339f70f99',
  'chunks/chunk-SM5JI6QM.js': 'b05c08c5c2cb36bcbb4efcc31095a1059301bf7090d6da39f304b0a486648244',
  'chunks/chunk-MY4MONOH.js': '2c82d2b22b436260ae3bd00fa9da86ef86174ba9e006d16b81da99cbf81f2a15',
});
const CODES = Object.freeze(['arguments', 'dependency_changed', 'request_not_allowed', 'request_budget',
  'existing_auth_unavailable', 'auth_refresh_disabled', 'transport', 'request_timeout', 'response_size',
  'response_headers', 'provider_status', 'provider_schema', 'cli_failed', 'child_timeout', 'child_failed',
  'child_protocol', 'output_limit', 'metadata_limit', 'attribution_conflict', 'internal']);

const UPSTREAM_FILE = path.join(ROOT, '.tmp/gate1-rollback-tools/build-attribution-49owz1V7-attempt-1/provider-read-child.cjs');
const UPSTREAM_SHA256 = 'fbd6ece0912c9c583ef1d7ca7a6fc81d2214d59932867a904fb067b432bc0e1b';
const upstream = require(UPSTREAM_FILE);
const REASONS = Object.freeze(['response_deployment_mismatch', 'response_project_mismatch',
  'build_deployment_mismatch', 'output_runtime_fields_disagree', 'output_node_runtime_mismatch',
  'duplicate_route_runtime_disagrees']);
const OUTPUT_CLASSIFICATIONS = Object.freeze(['known_application_route', 'middleware', 'unrecognized_output', 'not_applicable']);
const SLOT_ORDER_BY_REASON = Object.freeze({
  response_deployment_mismatch: 'not_applicable', response_project_mismatch: 'not_applicable',
  build_deployment_mismatch: 'not_applicable',
  output_runtime_fields_disagree: 'output_runtime_then_lambda_runtime',
  output_node_runtime_mismatch: 'output_runtime_then_lambda_runtime',
  duplicate_route_runtime_disagrees: 'previous_then_current_projected_runtime',
});
const inputSchema = z.object({ phase: z.literal('builds'), deploymentId: z.literal(TARGET.deploymentId) }).strict();
const metadataSchema = z.object({
  classification: z.enum(['conflict_identified', 'not_reproduced']),
  reason: z.enum(REASONS).nullable(),
  nodeMajors: z.array(z.number().int().min(0).max(999).nullable()).max(2),
  nodeMajorSlotOrder: z.enum(['not_applicable', 'output_runtime_then_lambda_runtime', 'previous_then_current_projected_runtime']),
  outputClassification: z.enum(OUTPUT_CLASSIFICATIONS),
  qualification: z.literal('unqualified_metadata_only'),
  historicalCause: z.literal('not_proven_same_response'),
}).strict();

/** Normalize failures to fixed codes; never retain an exception message or provider input. */
class ReadError extends Error {
  /** Keep only a shared error code so parent/child failures cannot expose payload text. */
  constructor(code) { super(CODES.includes(code) ? code : 'internal'); this.code = this.message; }
}

/** Validate a boundary value while discarding Zod's input-bearing error details. */
function parse(schema, value, code = 'provider_schema') {
  const result = schema.safeParse(value);
  if (!result.success) throw new ReadError(code);
  return result.data;
}

/** Allow only the already identified deployment's builds GET; no alias, events or login operations exist. */
function operation(value) {
  parse(inputSchema, value, 'arguments');
  return '/v11/deployments/' + TARGET.deploymentId + '/builds?teamId=' + TARGET.teamId;
}

/** Revalidate the closed receipt in the parent; reasons fix slot meaning and admissible output classes. */
function validateMetadata(phase, value) {
  if (phase !== 'builds') throw new ReadError('arguments');
  const safe = parse(metadataSchema, value);
  if (safe.nodeMajorSlotOrder !== (SLOT_ORDER_BY_REASON[safe.reason] || 'not_applicable')) {
    throw new ReadError('provider_schema');
  }
  if (safe.classification === 'not_reproduced') {
    if (safe.reason !== null || safe.nodeMajors.length || safe.outputClassification !== 'not_applicable') {
      throw new ReadError('provider_schema');
    }
  } else {
    if (!safe.reason) throw new ReadError('provider_schema');
    const runtimeReason = REASONS.slice(3).includes(safe.reason);
    if (safe.nodeMajors.length !== (runtimeReason ? 2 : 0)
      || (safe.outputClassification === 'not_applicable') === runtimeReason) throw new ReadError('provider_schema');
    const [first, second] = safe.nodeMajors;
    if (safe.reason === 'output_runtime_fields_disagree'
      && first !== null && second !== null && first === second) throw new ReadError('provider_schema');
    if (safe.reason === 'output_node_runtime_mismatch'
      && (safe.nodeMajors.includes(22) || (first !== null && second !== null && first !== second))) {
      throw new ReadError('provider_schema');
    }
    if (safe.reason === 'duplicate_route_runtime_disagrees'
      && (safe.nodeMajors.some((major) => major !== null && major !== 22)
        || (first === 22 && second === 22) || safe.outputClassification === 'unrecognized_output')) {
      throw new ReadError('provider_schema');
    }
  }
  return safe;
}

/** Retain a major only from a complete canonical, bounded Node token; all other strings become null. */
function nodeMajor(value) {
  if (typeof value !== 'string' || !/^nodejs(?:0|[1-9]\d{0,2})\.x$(?![\s\S])/.test(value)) return null;
  return Number(value.slice(6, -2));
}

/** Classify a bounded path using the pinned projector's exact allowlist; never retain paths or trust type labels. */
function classifyOutput(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length > 256) return 'unrecognized_output';
  const route = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
  if (upstream.ROUTES.includes(route)) return 'known_application_route';
  return ['_middleware', '/_middleware'].includes(rawPath) ? 'middleware' : 'unrecognized_output';
}

/** Build one fixed receipt; reason determines the major-slot order and identity conflicts have no affected output. */
function conflict(reason, nodeMajors = [], outputClassification = 'not_applicable') {
  return validateMetadata('builds', { classification: 'conflict_identified', reason, nodeMajors,
    nodeMajorSlotOrder: SLOT_ORDER_BY_REASON[reason], outputClassification,
    qualification: 'unqualified_metadata_only', historicalCause: 'not_proven_same_response' });
}

/** Find the first conflict after the pinned projector rejects raw, preserving its guard order and Node grammar.
 * Raw IDs, paths and runtime strings stay local; only fixed categories and two bounded nullable majors leave.
 */
function classifyConflict(raw) {
  if (raw.deploymentId !== undefined && raw.deploymentId !== TARGET.deploymentId) return conflict('response_deployment_mismatch');
  if (raw.projectId !== undefined && raw.projectId !== TARGET.projectId) return conflict('response_project_mismatch');
  const projected = [];
  for (const build of raw.builds || []) {
    if (build.deploymentId !== undefined && build.deploymentId !== TARGET.deploymentId) return conflict('build_deployment_mismatch');
    for (const output of build.output || []) {
      const values = [output.runtime, output.lambda?.runtime];
      const runtimes = values.filter((value) => value != null);
      if (runtimes.length > 1 && runtimes[0] !== runtimes[1]) {
        return conflict('output_runtime_fields_disagree', values.map(nodeMajor), classifyOutput(output.path));
      }
      // Keep the upstream guard exactly: even a runtime on an unrecognized path must reject concrete non-22 Node.
      if (runtimes.some((value) => typeof value === 'string' && /^nodejs\d+\.x$/.test(value) && value !== 'nodejs22.x')) {
        return conflict('output_node_runtime_mismatch', values.map(nodeMajor), classifyOutput(output.path));
      }
      const outputClassification = classifyOutput(output.path);
      if (outputClassification === 'unrecognized_output') continue;
      const route = output.path.startsWith('/') ? output.path : '/' + output.path;
      const type = ['lambda', 'edge', 'middleware', 'file'].includes(output.type) ? output.type : 'other';
      const runtime = !runtimes.length ? 'missing' : ['nodejs22.x', 'edge'].includes(runtimes[0]) ? runtimes[0] : 'other';
      projected.push({ key: route + ':' + type, runtime, outputClassification });
    }
  }
  // Duplicate validation follows projection/schema checks for every output, matching the current authority.
  const previous = new Map();
  for (const row of projected) {
    if (row.runtime === 'missing') continue;
    if (previous.has(row.key) && previous.get(row.key) !== row.runtime) {
      return conflict('duplicate_route_runtime_disagrees',
        [nodeMajor(previous.get(row.key)), nodeMajor(row.runtime)], row.outputClassification);
    }
    previous.set(row.key, row.runtime);
  }
  throw new ReadError('provider_schema');
}

/** Classify only attribution_conflict from the exact pinned projector; other failures remain terminal.
 * A fresh non-conflicting sample is inconclusive and cannot explain or erase the discarded historical response.
 */
function projectMetadata(phase, raw) {
  if (phase !== 'builds') throw new ReadError('arguments');
  try { upstream.projectMetadata('builds', raw); }
  catch (error) {
    if (error instanceof upstream.ReadError && error.code === 'attribution_conflict') {
      try { return classifyConflict(raw); }
      catch { throw new ReadError('provider_schema'); }
    }
    throw new ReadError(error instanceof upstream.ReadError ? error.code : 'internal');
  }
  return validateMetadata(phase, { classification: 'not_reproduced', reason: null, nodeMajors: [],
    nodeMajorSlotOrder: 'not_applicable', outputClassification: 'not_applicable',
    qualification: 'unqualified_metadata_only', historicalCause: 'not_proven_same_response' });
}

/** Check the loaded Zod entry and reviewed CLI bytes before any CLI import or authorization access. */
function verifyPins(read = fs.readFileSync) {
  if (createHash('sha256').update(read(UPSTREAM_FILE)).digest('hex') !== UPSTREAM_SHA256) {
    throw new ReadError('dependency_changed');
  }
  if (createHash('sha256').update(read(ZOD_ENTRY)).digest('hex') !== ZOD_PIN.sha256) {
    throw new ReadError('dependency_changed');
  }
  for (const [name, expected] of Object.entries(PINS)) {
    const actual = createHash('sha256').update(read(path.join(CLI, name))).digest('hex');
    if (actual !== expected) throw new ReadError('dependency_changed');
  }
}

/** Build a minimal child environment without copying app credentials, proxy/debug settings or Node hooks. */
function childEnvironment(source = process.env) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    const actual = Object.keys(source).find((name) => name.toLowerCase() === key.toLowerCase());
    if (actual && typeof source[actual] === 'string') env[key] = source[actual];
  }
  return { ...env, TEMP: path.join(ROOT, '.tmp'), TMP: path.join(ROOT, '.tmp'), CI: '1', NO_COLOR: '1',
    GATE1_REVIEW_WORKSPACE: ROOT, GATE1_VERCEL_CLI_DIST: CLI,
    // Resolve dependencies for external checkouts without inheriting an arbitrary NODE_PATH.
    NODE_PATH: path.join(ROOT, 'node_modules'),
    NO_UPDATE_NOTIFIER: '1',
    VERCEL_TELEMETRY_DISABLED: '1', VERCEL_GUIDANCE_DISABLED: '1', VERCEL_CLI_USE_NATIVE_BINARY: '0',
    NODE_DISABLE_COMPILE_CACHE: '1' };
}

/** Read one bounded provider body under an abort signal, then discard it after projection. */
async function boundedJson(response, signal) {
  let headerBytes = 0;
  for (const [key, value] of response.headers) headerBytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 4;
  if (headerBytes > LIMITS.headerBytes || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    throw new ReadError('response_headers');
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d{1,12}$/.test(length) || Number(length) > LIMITS.responseBytes)) throw new ReadError('response_size');
  const reader = response.body?.getReader();
  if (!reader) throw new ReadError('provider_schema');
  const chunks = [];
  let size = 0;
  /** Cancel a stalled stream when the fixed request deadline expires. */
  function cancel() { void reader.cancel().catch(() => {}); }
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new ReadError('request_timeout');
      const { value, done } = await reader.read();
      if (signal.aborted) throw new ReadError('request_timeout');
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.responseBytes) throw new ReadError('response_size');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ReadError('provider_schema'); }
  } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}); }
}

/** Guard a single native fetch, count dispatch before sending, and replace its body with safe metadata. */
function createGuard(input, nativeFetch, emit = () => {}, requestMs = LIMITS.providerMs) {
  const endpoint = operation(input);
  const state = { nativeFetchCalls: 0, adapterCalls: 0, suppressedUserLookups: 0, status: null, metadata: null, failure: null };
  /** Latch a fixed failure so a later nominal CLI success cannot hide it. */
  function fail(code) { state.failure ||= code; throw new ReadError(code); }
  /** Dispatch at most once to the exact HTTPS URL with manual redirects and no body/cookies. */
  async function guardedFetch(url, options = {}) {
    if (state.failure) fail(state.failure);
    if (String(url) !== `https://api.vercel.com${endpoint}` || (options.method || 'GET') !== 'GET'
      || options.body != null || new Headers(options.headers).has('cookie')) fail('request_not_allowed');
    if (state.nativeFetchCalls !== 0) fail('request_budget');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestMs);
    let onAbort;
    const aborted = new Promise((resolve, reject) => {
      /** Reject noncooperative transports as well as native abort-aware fetches. */
      onAbort = () => reject(new ReadError('request_timeout'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    /** Keep body collection inside the same deadline as connection and headers. */
    async function exchange() {
      const response = await nativeFetch(url, { ...options, redirect: 'manual', signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); fail('request_timeout'); }
      state.status = response.status;
      if (response.status !== 200) { void response.body?.cancel().catch(() => {}); fail('provider_status'); }
      const metadata = projectMetadata(input.phase, await boundedJson(response, controller.signal));
      if (controller.signal.aborted) fail('request_timeout');
      state.metadata = metadata;
      return new Response(JSON.stringify(metadata), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    try {
      emit({ type: 'dispatch' });
      state.nativeFetchCalls++;
      return await Promise.race([exchange(), aborted]);
    } catch (error) {
      fail(controller.signal.aborted ? 'request_timeout' : error instanceof ReadError ? error.code : 'transport');
    } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); }
  }
  return { endpoint, state, fetch: guardedFetch, fail };
}

/** Use the CLI's auth loading and _fetch while disabling retries, refresh and unapproved user lookup traffic. */
function installClientGuards(Client, isValidAccessToken, guard) {
  /** Check authorization already loaded by the CLI without retrieving, copying or printing a token. */
  Client.prototype.ensureAuthorized = async function ensureAuthorized() {
    if (!isValidAccessToken(this.authConfig)) guard.fail('existing_auth_unavailable');
  };
  /** Reject every operation outside this child and call the CLI transport exactly once. */
  Client.prototype.fetch = async function fetch(url, options = {}) {
    if (url === '/v2/user') { guard.state.suppressedUserLookups++; throw new ReadError('request_not_allowed'); }
    if (url !== guard.endpoint || (options.method || 'GET') !== 'GET' || options.body != null) guard.fail('request_not_allowed');
    if (guard.state.adapterCalls !== 0) guard.fail('request_budget');
    guard.state.adapterCalls++;
    this.reauthenticate = async function reauthenticate() { guard.fail('auth_refresh_disabled'); };
    const response = await this._fetch(url, { ...options, useCurrentTeam: false, redirect: 'manual' });
    return options.json === false ? response : response.json();
  };
  /** Explicitly disable the retry adapter even if a future path calls it. */
  Client.prototype.retry = async function retry() { guard.fail('request_not_allowed'); };
}

/** Run only as a forked private child. Raw CLI output is discarded and only a strict IPC receipt leaves. */
async function main(args) {
  if (args.length !== 3 || args[0] !== '--read' || typeof process.send !== 'function') return 1;
  let guard;
  let failure = null;
  let cliExitCode = null;
  let discardedBytes = 0;
  /** Suppress all CLI stdout/stderr, bounding even discarded output without retaining its bytes. */
  function discard(chunk, encoding, callback) {
    discardedBytes += Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined);
    if (discardedBytes > LIMITS.outputBytes) {
      failure = 'output_limit';
      throw new ReadError(failure);
    }
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) done();
    return true;
  }
  process.stdout.write = discard;
  process.stderr.write = discard;
  try {
    const input = parse(inputSchema, { phase: args[1], deploymentId: args[2] === '-' ? null : args[2] }, 'arguments');
    verifyPins();
    guard = createGuard(input, globalThis.fetch.bind(globalThis), (event) => process.send(event));
    globalThis.fetch = guard.fetch;
    /** Block alternate Node HTTP transports, including CLI maintenance outside the approved fetch. */
    function blockedTransport() { guard.fail('request_not_allowed'); }
    for (const protocol of ['node:http', 'node:https']) {
      const transport = require(protocol);
      transport.request = blockedTransport;
      transport.get = blockedTransport;
    }
    require('node:module').syncBuiltinESMExports();
    const { Client, isValidAccessToken } = await import(pathToFileURL(path.join(CLI, 'chunks/chunk-DECIQZZQ.js')).href);
    installClientGuards(Client, isValidAccessToken, guard);
    process.argv = [process.execPath, path.join(CLI, 'vc.js'), 'api', guard.endpoint, '--method', 'GET', '--raw', '--non-interactive'];
    const { cliPromise } = await import(pathToFileURL(path.join(CLI, 'index.js')).href);
    cliExitCode = await cliPromise;
    failure = failure || guard.state.failure || (cliExitCode !== 0 || !guard.state.metadata ? 'cli_failed' : null);
  } catch (error) { failure = failure || guard?.state.failure || (error instanceof ReadError ? error.code : 'internal'); }
  const state = guard?.state;
  const receipt = { type: 'receipt', schemaVersion: 1, result: failure ? 'stopped' : 'read', failure,
    nativeFetchCalls: state?.nativeFetchCalls ?? 0, adapterCalls: state?.adapterCalls ?? 0,
    suppressedUserLookups: state?.suppressedUserLookups ?? 0, status: state?.status ?? null,
    cliExitCode: Number.isInteger(cliExitCode) ? cliExitCode : null, metadata: failure ? null : state.metadata };
  await new Promise((resolve) => process.send(receipt, resolve));
  return failure ? 1 : 0;
}

module.exports = { ROOT, CLI, ZOD_PIN, ZOD_ENTRY, z, TARGET, LIMITS, PINS, CODES, REASONS, OUTPUT_CLASSIFICATIONS, SLOT_ORDER_BY_REASON,
  UPSTREAM_FILE, UPSTREAM_SHA256, ReadError, parse, operation, validateMetadata, projectMetadata,
  verifyPins, childEnvironment, boundedJson, createGuard, installClientGuards };
if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(1));
}
