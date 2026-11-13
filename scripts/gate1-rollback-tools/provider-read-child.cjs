'use strict';
/* global __dirname, Buffer, process, Headers, Response, AbortController, setTimeout, clearTimeout */

/** One guarded CLI-managed provider read. Importing this module performs no I/O. */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

// These nonsecret paths let a linked PR checkout use the preserved qualification workspace.
// CLI hashes remain mandatory for every location; this never accepts a credential override.
const ROOT = path.resolve(process.env.GATE1_REVIEW_WORKSPACE || path.join(__dirname, '../..'));
const ZOD_PIN = Object.freeze({ file: 'node_modules/zod/index.cjs',
  sha256: '2a3455cecff4f7021c92d0a3e2e5fc170c0448dc5cc261160127e08f4888a9c2' });
// Bind both runners to the workspace copy covered by preparation, regardless of checkout-local modules.
const ZOD_ENTRY = require.resolve(path.join(ROOT, ZOD_PIN.file));
const { z } = require(ZOD_ENTRY);
const CLI = path.resolve(process.env.GATE1_VERCEL_CLI_DIST || path.join(os.homedir(),
  'AppData/Local/npm-cache/_npx/67eb4586ca667318/node_modules/vercel/dist'));
const TARGET = Object.freeze({ projectId: 'prj_b2nMrysMSJtpmqoeGx5g0WGgGuom',
  teamId: 'team_7o3efmwjZbMc2Bfy9qAzkc9q', hostname: 'job-application-tracker-kappa-seven.vercel.app' });
const LIMITS = Object.freeze({ providerMs: 10000, childMs: 30000, responseBytes: 1048576,
  headerBytes: 16384, ipcBytes: 16384, outputBytes: 32768 });
const PINS = Object.freeze({
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
  'child_protocol', 'output_limit', 'internal']);
const id = z.string().max(100).regex(/^dpl_[A-Za-z0-9]+$/);
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const host = z.string().max(253).regex(/^job-application-tracker-[a-z0-9-]+\.vercel\.app$/);
const major = z.string().regex(/^\d{1,3}\.x$/).nullable();
const inputSchema = z.object({ phase: z.enum(['alias_before', 'deployment', 'project', 'alias_after']),
  deploymentId: id.nullable() }).strict();
const aliasSchema = z.object({ hostname: z.literal(TARGET.hostname), projectId: z.literal(TARGET.projectId),
  deploymentId: id, updatedAt: stamp }).strict();
const deploymentSchema = z.object({ deploymentId: id, projectId: z.literal(TARGET.projectId),
  immutableHostname: host, target: z.literal('production'), readyState: z.literal('READY'), gitSha: sha,
  createdAt: stamp, readyAt: stamp, canonicalAliasListed: z.literal(true), configuredNodeMajor: major }).strict();
const projectSchema = z.object({ projectId: z.literal(TARGET.projectId), teamId: z.literal(TARGET.teamId),
  currentProductionDeploymentId: id, autoAssignCustomDomains: z.boolean(),
  lastRoutingJob: z.object({ status: z.enum(['succeeded', 'failed', 'pending', 'in-progress', 'unknown']),
    type: z.enum(['promote', 'rollback', 'unknown']), requestedAt: stamp.nullable() }).strict().nullable(),
  configuredNodeMajor: major, protection: z.enum(['all_except_custom_domains', 'all', 'preview', 'none', 'unknown']),
  rollingReleaseConfigured: z.boolean() }).strict();

/** Keep errors in a closed vocabulary so external text cannot enter evidence. */
class ReadError extends Error {
  /** Normalize boundary failures without retaining the underlying exception. */
  constructor(code) { super(CODES.includes(code) ? code : 'internal'); this.code = this.message; }
}

/** Parse a boundary value with Zod while discarding validation inputs and messages. */
function parse(schema, value, code = 'provider_schema') {
  const result = schema.safeParse(value);
  if (!result.success) throw new ReadError(code);
  return result.data;
}

/** Derive the sole permitted endpoint from a phase and already validated deployment ID. */
function operation(value) {
  const input = parse(inputSchema, value, 'arguments');
  if (input.phase === 'deployment') {
    if (!input.deploymentId) throw new ReadError('arguments');
    return `/v13/deployments/${input.deploymentId}?teamId=${TARGET.teamId}`;
  }
  if (input.phase === 'project') return `/v9/projects/${TARGET.projectId}?teamId=${TARGET.teamId}&rollbackInfo=true`;
  return `/v4/aliases/${TARGET.hostname}?projectId=${TARGET.projectId}&teamId=${TARGET.teamId}`;
}

/** Validate projected IPC metadata a second time in the parent process. */
function validateMetadata(phase, value) {
  return parse(phase === 'deployment' ? deploymentSchema : phase === 'project' ? projectSchema : aliasSchema, value);
}

/** Select only required identity/routing fields. Raw JSON, env values and user data are discarded. */
function projectMetadata(phase, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ReadError('provider_schema');
  if (phase.startsWith('alias_')) {
    if (raw.deployment?.id !== undefined && raw.deployment.id !== raw.deploymentId) throw new ReadError('provider_schema');
    return validateMetadata(phase, { hostname: raw.alias, projectId: raw.projectId,
      deploymentId: raw.deploymentId, updatedAt: raw.updatedAt });
  }
  if (phase === 'deployment') {
    const candidates = [raw.meta?.githubCommitSha, raw.meta?.gitlabCommitSha, raw.meta?.bitbucketCommitSha,
      raw.gitSource?.sha].filter((value) => value !== undefined && value !== null);
    if (!candidates.length || candidates.some((value) => !sha.safeParse(value).success || value !== candidates[0])) {
      throw new ReadError('provider_schema');
    }
    return validateMetadata(phase, { deploymentId: raw.id, projectId: raw.projectId, immutableHostname: raw.url,
      target: raw.target, readyState: raw.readyState, gitSha: candidates[0], createdAt: raw.createdAt,
      readyAt: raw.ready, canonicalAliasListed: Array.isArray(raw.alias) && raw.alias.includes(TARGET.hostname),
      configuredNodeMajor: raw.projectSettings?.nodeVersion ?? null });
  }
  const job = raw.lastAliasRequest;
  return validateMetadata(phase, { projectId: raw.id, teamId: raw.accountId,
    currentProductionDeploymentId: raw.targets?.production?.id, autoAssignCustomDomains: raw.autoAssignCustomDomains,
    lastRoutingJob: job == null ? null : {
      status: ['succeeded', 'failed', 'pending', 'in-progress'].includes(job.jobStatus) ? job.jobStatus : 'unknown',
      type: ['promote', 'rollback'].includes(job.type) ? job.type : 'unknown', requestedAt: job.requestedAt ?? null },
    configuredNodeMajor: raw.nodeVersion ?? null,
    protection: raw.ssoProtection == null ? 'none' :
      ['all_except_custom_domains', 'all', 'preview'].includes(raw.ssoProtection.deploymentType)
        ? raw.ssoProtection.deploymentType : 'unknown',
    rollingReleaseConfigured: raw.rollingRelease != null });
}

/** Check the loaded Zod entry and reviewed CLI bytes before any CLI import or authorization access. */
function verifyPins(read = fs.readFileSync) {
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
  } catch (error) { failure = guard?.state.failure || (error instanceof ReadError ? error.code : 'internal'); }
  const state = guard?.state;
  const receipt = { type: 'receipt', schemaVersion: 1, result: failure ? 'stopped' : 'read', failure,
    nativeFetchCalls: state?.nativeFetchCalls ?? 0, adapterCalls: state?.adapterCalls ?? 0,
    suppressedUserLookups: state?.suppressedUserLookups ?? 0, status: state?.status ?? null,
    cliExitCode: Number.isInteger(cliExitCode) ? cliExitCode : null, metadata: failure ? null : state.metadata };
  await new Promise((resolve) => process.send(receipt, resolve));
  return failure ? 1 : 0;
}

module.exports = { ROOT, CLI, ZOD_PIN, ZOD_ENTRY, z, TARGET, LIMITS, PINS, CODES, ReadError, parse, operation, validateMetadata,
  projectMetadata, verifyPins, childEnvironment, boundedJson, createGuard, installClientGuards };
if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(1));
}
