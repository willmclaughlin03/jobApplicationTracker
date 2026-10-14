'use strict';

/** One separately approved metadata read. No build, scanner, downloader or arbitrary target selection. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const q = require('./gate1-build-qualification');
const ROOT = path.resolve(__dirname, '..');
const SCOPE = 'gate1_vercel_failure_diagnostic_v1';
const CONTAINER = 'gate1-vercel-diagnostic-owner-v1';
const LIMITS = Object.freeze({ fileBytes: 262144, inputBytes: 65536, reportBytes: 4096, stderrBytes: 8388608,
  jsonDepth: 16, jsonNodes: 4096, linuxSeconds: 20, operationMs: 60000, teardownMs: 20000, launcherMs: 120000 });
const ATTESTATIONS = Object.freeze(['codeAndProvenanceReviewed', 'oneSensitiveMetadataFileApproved',
  'exclusiveDaemonAndVolumeControl', 'finiteCategoriesAndConsumedFailureAccepted', 'privateRetentionReviewed']);
const RECEIPTS = Object.freeze({
  'setup.receipt': '37e0aba96b84d71346f656a220530dbdf011e3e24b09717fc27d73aa363c5f08',
  'build.receipt': '88479ea799581cd8c10ec7ad869544eeaf3fafbb22f9f7cd8c7a40b6ebcac5d3',
  'build.reservation': 'b15e2bfddd03e5f4881ca6be4e114d36ea4b8511395b81ed3d70cc82a5ec905f',
});
const EXECUTION_FILES = Object.freeze(['gate1-vercel-build-diagnostic.js', 'run-gate1-vercel-build-diagnostic.ps1',
  'gate1-build-qualification.js']);

/** Keep public errors constant; raw exceptions and generated metadata never become diagnostics. */
class DiagnosticError extends Error {
  /** Accept only internal categories used by the host supervisor. */
  constructor(code) {
    super(['input', 'approval', 'provenance', 'reservation', 'persistence', 'container', 'deadline'].includes(code) ? code : 'input');
    this.code = this.message;
  }
}

/** Self-contained Linux library: serialized source uses Node built-ins only, with an injectable filesystem for fixtures. */
function readerLibrary() {
  const { TextDecoder } = require('node:util');
  const limits = Object.freeze({ fileBytes: 262144, jsonDepth: 16, jsonNodes: 4096 });
  const fixed = Object.freeze({ sourceSha: '0e89e234b483b9dc6ab1c374b2064532af8fb789',
    failedBuildApproval: 'dfeb059430b7fa18eae6ef15689450d10651838ea8f859f06bade0654d8ee66a',
    qualificationBinding: 'b4cecd83cca0db031dd1dba608cad4790c04bc82afbe7d19f7c18b19a552a76f',
    imageId: 'sha256:66d5a93aae6cf3976dd976a10bbc1e90abd8025270dd1377f35895bea742556b',
    daemonId: 'd9e0f885-82f3-4431-9ac7-6c20e8435536' });
  const target = `/evidence/${fixed.sourceSha}/app/.vercel/output/builds.json`;
  const names = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'NowBuildError', 'BuildError', 'SystemError'];
  const codes = ['ENOENT', 'EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_REQUIRE_ESM',
    'ERR_DLOPEN_FAILED', 'NODEJS_DISCONTINUED_VERSION', 'INVALID_DEPLOYMENT_ID', 'INVALID_CRON_SECRET',
    'DUPLICATE_SERVICE_BUILDER_SRC', 'NOW_SANDBOX_WORKER_MAX_LAMBDA_SIZE', 'bad_request'];
  const signals = ['SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGPIPE'];
  const tools = ['git', 'node', 'npm', 'sh', 'python', 'python3', 'tar'];
  const outcomes = ['reported_error', 'metadata_absent', 'metadata_unreadable', 'metadata_rejected',
    'provenance_mismatch', 'no_error_record', 'unrecognized_error', 'container_failure'];

  /** Reject duplicate keys and bound structural work before returning parsed untrusted JSON; never expose parser text. */
  function parse(bytes, cap = limits.fileBytes) {
    try {
      if (!Buffer.isBuffer(bytes) || bytes.length > cap) throw new Error();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) || [];
      const stack = []; let nodes = 0;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '{' || token === '[') { stack.push(token === '{' ? new Set() : null); nodes++; }
        else if (token === '}' || token === ']') stack.pop();
        else if (token.startsWith('"') && tokens[i + 1] === ':') {
          const key = JSON.parse(token), keys = stack[stack.length - 1];
          if (!keys || keys.has(key)) throw new Error();
          keys.add(key);
        } else if (token !== ':' && token !== ',') nodes++;
        if (stack.length > limits.jsonDepth || nodes > limits.jsonNodes) throw new Error();
      }
      return JSON.parse(text);
    } catch { throw new Error('metadata_rejected'); }
  }

  /** Distinguish JSON objects from arrays/null at every metadata boundary. */
  function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

  /** Construct report attribution from the approved contract only; all diagnostic slots start empty. */
  function base(contract, outcome = 'metadata_rejected') {
    return { schemaVersion: 1, scope: 'gate1_vercel_failure_diagnostic_v1', ...fixed,
      approval: contract.approval, outcome, cliVersionMatches: false, targetMatches: false,
      errorName: 'missing', errorCode: 'missing', codeExitStatus: null, codeSignal: null,
      errorExitCode: null, tool: 'missing', operation: 'missing', operationTool: 'missing' };
  }

  /** Normalize an own property through exact finite strings, never coercing objects or echoing unknown values. */
  function category(error, key, allowed) {
    return Object.hasOwn(error, key) ? (allowed.includes(error[key]) ? error[key] : 'unrecognized') : 'missing';
  }

  /** Extract finite corroborating categories; a version/target mismatch prevents all error classification. */
  function classify(value, contract) {
    const report = base(contract);
    if (!object(value)) return report;
    report.cliVersionMatches = value.cliVersion === '50.33.1'; report.targetMatches = value.target === 'preview';
    if (!report.cliVersionMatches || !report.targetMatches) return { ...report, outcome: 'provenance_mismatch' };
    if (!Object.hasOwn(value, 'error')) return { ...report, outcome: 'no_error_record' };
    if (!object(value.error)) return report;
    const error = value.error;
    report.errorName = category(error, 'name', names); report.errorCode = category(error, 'code', codes);
    if (Object.hasOwn(error, 'code') && typeof error.code === 'string') {
      const match = /^BUILD_UTILS_SPAWN_([1-9][0-9]{0,2}|SIGKILL|SIGTERM|SIGABRT|SIGSEGV|SIGBUS|SIGILL|SIGFPE|SIGPIPE)$/.exec(error.code);
      if (match && match[0] === error.code && (signals.includes(match[1]) || Number(match[1]) <= 255)) {
        report.errorCode = 'BUILD_UTILS_SPAWN';
        if (signals.includes(match[1])) report.codeSignal = match[1]; else report.codeExitStatus = Number(match[1]);
      }
    }
    if (Object.hasOwn(error, 'exitCode') && Number.isInteger(error.exitCode) && error.exitCode >= 0 && error.exitCode <= 255) {
      report.errorExitCode = error.exitCode;
    }
    report.tool = category(error, 'path', tools);
    report.operation = category(error, 'syscall', ['open', 'read', 'write', 'mkdir']);
    if (Object.hasOwn(error, 'syscall') && tools.some((tool) => error.syscall === `spawn ${tool}`)) {
      report.operation = 'spawn'; report.operationTool = tools.find((tool) => error.syscall === `spawn ${tool}`);
    }
    // A recognized generic Error name alone does not establish a diagnostic cause.
    report.outcome = !['missing', 'unrecognized'].includes(report.errorCode) || report.errorExitCode !== null ||
      !['missing', 'unrecognized'].includes(report.tool) || !['missing', 'unrecognized'].includes(report.operation)
      ? 'reported_error' : 'unrecognized_error';
    return report;
  }

  /** Compare identity, type and modification metadata across lstat/fstat snapshots, including ancestors. */
  function same(a, b) {
    return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every((key) => a[key] === b[key]);
  }

  /** Read exactly one fixed content file without following links; no discovery, fallback or content hashes. */
  function read(contract, io = require('node:fs')) {
    const report = base(contract); let fd;
    try {
      if (!object(contract) || contract.target !== target || !/^[a-f0-9]{64}$/.test(contract.approval || '') ||
          Object.entries(fixed).some(([key, value]) => contract[key] !== value)) return { ...report, outcome: 'provenance_mismatch' };
      const ancestors = ['/evidence', `/evidence/${fixed.sourceSha}`, `/evidence/${fixed.sourceSha}/app`,
        `/evidence/${fixed.sourceSha}/app/.vercel`, `/evidence/${fixed.sourceSha}/app/.vercel/output`];
      const before = [];
      for (const name of ancestors) {
        const stat = io.lstatSync(name);
        if (!stat.isDirectory() || stat.isSymbolicLink() || before.length && stat.dev !== before[0].dev) return report;
        before.push(stat);
      }
      const stat = io.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== before[0].dev ||
          !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > limits.fileBytes || !io.constants.O_NOFOLLOW) return report;
      fd = io.openSync(target, io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK);
      if (!same(stat, io.fstatSync(fd))) return report;
      const bytes = Buffer.alloc(stat.size + 1); let count = 0;
      while (count < bytes.length) {
        const readCount = io.readSync(fd, bytes, count, bytes.length - count, null);
        if (!readCount) break;
        count += readCount;
      }
      if (count !== stat.size || !same(stat, io.fstatSync(fd)) || !same(stat, io.lstatSync(target)) ||
          ancestors.some((name, index) => !same(before[index], io.lstatSync(name)))) return report;
      const handle = fd; fd = undefined; io.closeSync(handle);
      return classify(parse(bytes.subarray(0, count)), contract);
    } catch (error) {
      return { ...report, outcome: error?.code === 'ENOENT' ? 'metadata_absent' :
        ['EACCES', 'EPERM'].includes(error?.code) ? 'metadata_unreadable' : 'metadata_rejected' };
    } finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { /* No data escapes a close failure. */ } } }
  }
  return { fixed, limits, target, names, codes, signals, tools, outcomes, parse, object, base, classify, read };
}

const lib = readerLibrary();
// Refuse approval contracts whose declared limits differ from reader or supervisor enforcement.
if (['fileBytes', 'jsonDepth', 'jsonNodes'].some((key) => LIMITS[key] !== lib.limits[key]) ||
    LIMITS.stderrBytes !== q.LIMITS.logBytes) throw new DiagnosticError('provenance');
const FIXED = lib.fixed;
const KEY = `${FIXED.sourceSha}.vercel-diagnostic.${FIXED.failedBuildApproval}`;

/** Hash public code/contracts only, never the generated file or its fields. */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** Reject extra profile keys and require explicit booleans; preparation permits unapproved templates. */
function profile(value) {
  const { z } = require('zod');
  const parsed = z.object({ schemaVersion: z.literal(1), scope: z.literal(SCOPE),
    attestations: z.object(Object.fromEntries(ATTESTATIONS.map((key) => [key, z.boolean()]))).strict() }).strict().safeParse(value);
  if (!parsed.success) throw new DiagnosticError('input');
  return parsed.data;
}

/** Return a no-effects template; no existing output or Docker state is consulted. */
function template() {
  return { schemaVersion: 1, scope: SCOPE, attestations: Object.fromEntries(ATTESTATIONS.map((key) => [key, false])) };
}

/** Resolve shared host evidence from Git's common directory; no caller-controlled registry or run identifier. */
async function registryRoot() {
  const bytes = await q.supervise('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { outputBytes: 2048 });
  const common = bytes.toString().trim();
  if (!path.isAbsolute(common) || path.basename(common) !== '.git') throw new DiagnosticError('provenance');
  return q.safePath(path.join(path.dirname(common), '.tmp/gate1-build-qualification'));
}

/** Verify exact retained public receipts and their consistent failed-run attribution without touching Linux output. */
function verifyEvidence(root, read = q.publicFile) {
  const records = {};
  for (const [name, digest] of Object.entries(RECEIPTS)) {
    const bytes = read(path.join(root, `${FIXED.sourceSha}.${name}.json`), 65536);
    if (hash(bytes) !== digest) throw new DiagnosticError('provenance');
    records[name] = lib.parse(bytes, 65536);
  }
  const setup = records['setup.receipt'], build = records['build.receipt'], reservation = records['build.reservation'];
  if ([setup, build].some((item) => item.binding !== FIXED.qualificationBinding || item.imageId !== FIXED.imageId ||
      item.daemonId !== FIXED.daemonId || item.persistenceFailure || item.teardownUnconfirmed) || setup.result !== 'completed' ||
      build.result !== 'stopped' || build.failingStep !== 'vercel_build' || build.exitCode !== 1 ||
      reservation.sourceSha !== FIXED.sourceSha || reservation.approval !== FIXED.failedBuildApproval || reservation.consumed !== true) {
    throw new DiagnosticError('provenance');
  }
  return { ...RECEIPTS };
}

/** Produce fixed Docker arguments; source, image, mount, runtime and resource limits cannot be supplied by a caller. */
function containerArgs() {
  return ['create', '--name', CONTAINER, '--pull=never', '--platform=linux/amd64', '--network=none', '--read-only',
    '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--restart=no', '--log-driver=none',
    '--cpus=1', '--memory=134217728', '--memory-swap=134217728', '--pids-limit=32', '--ulimit=core=0:0',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=8388608,mode=1777',
    '--mount', `type=volume,src=${q.VOLUME},dst=/evidence,readonly,volume-nocopy`,
    '--entrypoint', '/usr/bin/timeout', '-i', FIXED.imageId, '--signal=KILL', `${LIMITS.linuxSeconds}s`,
    '/usr/bin/env', '-i', '/opt/node-v22.23.3-linux-x64/bin/node', '-'];
}

/** Prepare a digest over actual execution bytes and public evidence; injected seams exist solely for synthetic tests. */
async function prepare(value, dependencies = {}) {
  profile(value);
  const root = dependencies.root || await registryRoot();
  const evidence = verifyEvidence(root, dependencies.read);
  const read = dependencies.read || q.publicFile;
  const integrity = Object.fromEntries(EXECUTION_FILES.map((name) => [name, hash(read(path.join(__dirname, name), 65536))]));
  if (integrity['gate1-build-qualification.js'] !== 'dd665377170f160f7edb012d2cabde690730b8622f49a19ff353345e2dca4736') {
    throw new DiagnosticError('provenance');
  }
  const revision = (dependencies.revision || (await q.supervise('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { outputBytes: 128 })).toString().trim());
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new DiagnosticError('provenance');
  const contract = { schemaVersion: 1, scope: SCOPE, ...FIXED, target: lib.target, implementationBase: revision,
    integrity, readerSourceSha256: hash(readerLibrary.toString()), evidence, limits: LIMITS, context: q.CONTEXT, containerArgs: containerArgs(),
    reportEnums: { names: lib.names, codes: lib.codes, signals: lib.signals, tools: lib.tools, outcomes: lib.outcomes },
    attestationsRequired: ATTESTATIONS, confirmation: 'READ APPROVED VERCEL FAILURE METADATA ONCE' };
  const approval = hash(JSON.stringify(contract));
  if (readerInput({ ...FIXED, target: lib.target, approval }).length > LIMITS.inputBytes) throw new DiagnosticError('input');
  return { schemaVersion: 1, mode: 'prepare', gate1Status: 'open', authorized: false, approval, contract,
    retainedOutputReads: 0, dockerOperations: 0 };
}

/** Deliver approved standalone source through stdin, with a literal contract and no package or metadata evaluation. */
function readerInput(contract) {
  const code = `'use strict';\nconst library = (${readerLibrary.toString()})();\n` +
    `const report = library.read(${JSON.stringify(contract)});\n` +
    `const output = JSON.stringify(report); if (Buffer.byteLength(output) > 4095) process.exitCode = 1; else process.stdout.write(output + '\\n');\n`;
  const bytes = Buffer.from(code);
  if (bytes.length > LIMITS.inputBytes) throw new DiagnosticError('input');
  return bytes;
}

/** Independently validate exact Linux report keys, literals and related statuses before any report persistence. */
function validateReport(bytes, approval) {
  const { z } = require('zod');
  const empty = lib.base({ approval });
  const parsed = z.object({ ...Object.fromEntries(Object.entries(empty)
    .filter(([key]) => !['outcome', 'cliVersionMatches', 'targetMatches', 'errorName', 'errorCode', 'codeExitStatus',
      'codeSignal', 'errorExitCode', 'tool', 'operation', 'operationTool'].includes(key)).map(([key, value]) => [key, z.literal(value)])),
  outcome: z.enum(lib.outcomes.filter((value) => value !== 'container_failure')), cliVersionMatches: z.boolean(), targetMatches: z.boolean(),
  errorName: z.enum([...lib.names, 'missing', 'unrecognized']), errorCode: z.enum([...lib.codes, 'BUILD_UTILS_SPAWN', 'missing', 'unrecognized']),
  codeExitStatus: z.number().int().min(1).max(255).nullable(), codeSignal: z.enum(lib.signals).nullable(),
  errorExitCode: z.number().int().min(0).max(255).nullable(), tool: z.enum([...lib.tools, 'missing', 'unrecognized']),
  operation: z.enum(['open', 'read', 'write', 'mkdir', 'spawn', 'missing', 'unrecognized']),
  operationTool: z.enum([...lib.tools, 'missing']) }).strict().safeParse(lib.parse(bytes, LIMITS.reportBytes));
  if (!parsed.success) throw new DiagnosticError('container');
  const report = parsed.data;
  const classified = ['reported_error', 'unrecognized_error'].includes(report.outcome);
  const meaningful = !['missing', 'unrecognized'].includes(report.errorCode) || report.errorExitCode !== null ||
    !['missing', 'unrecognized'].includes(report.tool) || !['missing', 'unrecognized'].includes(report.operation);
  if (classified && (!report.cliVersionMatches || !report.targetMatches) ||
      classified && meaningful !== (report.outcome === 'reported_error') ||
      ['metadata_absent', 'metadata_unreadable'].includes(report.outcome) && (report.cliVersionMatches || report.targetMatches) ||
      report.outcome === 'metadata_rejected' && report.cliVersionMatches !== report.targetMatches ||
      report.errorCode === 'BUILD_UTILS_SPAWN' && ((report.codeExitStatus === null) === (report.codeSignal === null)) ||
      report.errorCode !== 'BUILD_UTILS_SPAWN' && (report.codeExitStatus !== null || report.codeSignal !== null) ||
      (report.operation === 'spawn') !== (report.operationTool !== 'missing') ||
      report.outcome === 'provenance_mismatch' && report.cliVersionMatches && report.targetMatches ||
      report.outcome === 'no_error_record' && (!report.cliVersionMatches || !report.targetMatches)) throw new DiagnosticError('container');
  if (!classified && Object.keys(empty).some((key) => !['outcome', 'cliVersionMatches', 'targetMatches'].includes(key) && report[key] !== empty[key])) {
    throw new DiagnosticError('container');
  }
  return report;
}

/** Persist only bounded public host contracts; exclusive fsync preserves consumed attempts across failures. */
function writeOnce(location, value) {
  if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.reportBytes) throw new DiagnosticError('persistence');
  q.safePath(location); q.writeOnce(location, value);
}

/** Inspect fixed Docker metadata only; reject other users of the volume or either reserved container name. */
async function readiness(run) {
  const info = lib.parse(await run(['info', '--format', '{{json .}}']), 65536);
  if (info.ID !== FIXED.daemonId || info.OSType !== 'linux' || !['x86_64', 'amd64'].includes(info.Architecture)) throw new DiagnosticError('container');
  for (const filter of [`volume=${q.VOLUME}`, `name=^/${q.CONTAINER}$`, `name=^/${CONTAINER}$`]) {
    if ((await run(['ps', '-aq', '--filter', filter])).toString().trim()) throw new DiagnosticError('container');
  }
  const volume = lib.parse(await run(['volume', 'inspect', q.VOLUME]), 65536);
  if (!Array.isArray(volume) || volume.length !== 1 || volume[0].Name !== q.VOLUME || volume[0].Driver !== 'local' ||
      Object.keys(volume[0].Options || {}).length || volume[0].Labels?.['gate1.scope'] !== q.SCOPE) throw new DiagnosticError('container');
  const image = lib.parse(await run(['image', 'inspect', FIXED.imageId]), 65536);
  if (!Array.isArray(image) || image.length !== 1 || image[0].Id !== FIXED.imageId || image[0].Os !== 'linux' ||
      image[0].Architecture !== 'amd64') throw new DiagnosticError('container');
}

/** Bound all commands in a phase by one monotonic budget, always using the explicit Docker context. */
function budgetRunner(run, budgetMs, now = () => performance.now()) {
  const started = now();
  return async (args, options = {}) => {
    const remaining = budgetMs - (now() - started);
    if (remaining <= 0) throw new DiagnosticError('deadline');
    return run(['--context', q.CONTEXT, ...args], { outputBytes: 65536, ...options, timeoutMs: remaining });
  };
}

/** Confirm removal of only the ID returned by our create; uncertain identity or teardown must keep the mutex. */
async function teardown(run, id) {
  let state = lib.parse(await run(['inspect', '--format', '{{json .State}}', id]), 4096);
  const wasRunning = state.Running;
  if (typeof wasRunning !== 'boolean') throw new DiagnosticError('container');
  if (wasRunning) await run(['kill', id]);
  state = lib.parse(await run(['inspect', '--format', '{{json .State}}', id]), 4096);
  if (state.Running !== false || typeof state.OOMKilled !== 'boolean' || !Number.isInteger(state.ExitCode) ||
      state.ExitCode < 0 || state.ExitCode > 255 || typeof state.Error !== 'string') throw new DiagnosticError('container');
  await run(['rm', id]);
  if ((await run(['ps', '-aq', '--no-trunc', '--filter', `id=${id}`])).toString().trim()) throw new DiagnosticError('container');
  return { clean: !wasRunning && state.ExitCode === 0 && state.OOMKilled === false && state.Error === '',
    exitCode: state.ExitCode, oomKilled: state.OOMKilled };
}

/** Consume one separate diagnostic approval, supervise the fixed reader and retain only validated sanitized evidence. */
async function execute(envelope, dependencies = {}) {
  if (!lib.object(envelope) || Object.keys(envelope).sort().join(',') !== 'approval,authorized,profile' || envelope.authorized !== true ||
      !/^[a-f0-9]{64}$/.test(envelope.approval || '')) throw new DiagnosticError('approval');
  const selected = profile(envelope.profile);
  if (!ATTESTATIONS.every((key) => selected.attestations[key] === true)) throw new DiagnosticError('approval');
  const prepared = await (dependencies.prepare || prepare)(selected);
  if (prepared.approval !== envelope.approval) throw new DiagnosticError('approval');
  const root = dependencies.root || await registryRoot(), persist = dependencies.writeOnce || writeOnce;
  q.safePath(root);
  const lock = path.join(root, 'active.lock'), reservation = path.join(root, `${KEY}.reservation.json`);
  if (fs.existsSync(reservation) || fs.existsSync(path.join(root, `${KEY}.report.json`))) throw new DiagnosticError('reservation');
  // Never remove a lock whose exclusive creation failed, including a partial write/fsync failure.
  persist(lock, { scope: SCOPE, approval: prepared.approval, sourceSha: FIXED.sourceSha });
  const lockStat = fs.lstatSync(lock);
  let containerId, createAttempted = false, removed = false, reserved = false;
  const runDocker = dependencies.docker || ((args, options) => q.supervise('docker', args, options));
  const run = budgetRunner(runDocker, LIMITS.operationMs, dependencies.now);
  let result = { schemaVersion: 1, scope: SCOPE, ...FIXED, approval: prepared.approval, gate1Status: 'open',
    result: 'stopped', outcome: 'container_failure', report: null, containerExit: null,
    teardownUnconfirmed: false, persistenceFailure: false, rawStreamsRetained: false };
  try {
    persist(reservation, { scope: SCOPE, ...FIXED, approval: prepared.approval, consumed: true });
    reserved = true;
    await readiness(run);
    createAttempted = true;
    const created = (await run(containerArgs(), { outputBytes: 128 })).toString().trim();
    if (!/^[a-f0-9]{64}$/.test(created)) throw new DiagnosticError('container');
    containerId = created;
    const output = await run(['start', '-ai', containerId], { outputBytes: LIMITS.reportBytes,
      input: readerInput({ ...FIXED, target: lib.target, approval: prepared.approval }) });
    result.report = validateReport(output, prepared.approval); result.outcome = result.report.outcome;
    result.result = 'completed';
  } catch {
    result.result = 'stopped'; result.outcome = 'container_failure';
    if (!reserved) result.persistenceFailure = true;
  }
  finally {
    if (containerId) {
      try {
        const state = await teardown(budgetRunner(runDocker, LIMITS.teardownMs, dependencies.now), containerId);
        removed = true; result.containerExit = { exitCode: state.exitCode, oomKilled: state.oomKilled };
        if (!state.clean) { result.result = 'stopped'; result.outcome = 'container_failure'; result.report = null; }
      } catch { result.teardownUnconfirmed = true; }
    } else if (createAttempted) result.teardownUnconfirmed = true;
    if (result.teardownUnconfirmed) { result.result = 'stopped'; result.outcome = 'container_failure'; result.report = null; }
    try { persist(path.join(root, `${KEY}.report.json`), result); }
    catch { result.persistenceFailure = true; result.result = 'stopped'; }
    // Keep the lock on persistence failure or unknown create/teardown state for explicit owner recovery.
    if (!result.persistenceFailure && (!createAttempted || removed)) {
      try {
        const current = fs.lstatSync(lock);
        if (current.ino !== lockStat.ino || current.dev !== lockStat.dev || current.ctimeMs !== lockStat.ctimeMs || current.isSymbolicLink()) {
          result.persistenceFailure = true; result.result = 'stopped';
        } else fs.unlinkSync(lock);
      } catch { result.persistenceFailure = true; result.result = 'stopped'; }
    }
  }
  return result;
}

/** Default and preparation have no Docker effects; only the explicit execution envelope can consume approval. */
async function main(args) {
  if (!args.length || args.length === 1 && args[0] === '--template') return template();
  if (args.length !== 1 || !['--prepare', '--execute'].includes(args[0])) throw new DiagnosticError('input');
  const input = await q.readInput();
  return args[0] === '--prepare' ? prepare(input) : execute(input);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((report) => {
    const bytes = JSON.stringify(report);
    if (Buffer.byteLength(bytes) > (report.mode === 'prepare' ? LIMITS.inputBytes : LIMITS.reportBytes)) throw new DiagnosticError('persistence');
    process.stdout.write(bytes + '\n');
    if (report.result === 'stopped') process.exitCode = 1;
  }).catch(() => { process.stderr.write('Diagnostic stopped. Preserve evidence and reservations; no automatic retry.\n'); process.exitCode = 1; });
}

module.exports = { SCOPE, CONTAINER, LIMITS, ATTESTATIONS, RECEIPTS, EXECUTION_FILES, FIXED, KEY,
  DiagnosticError, readerLibrary, hash, profile, template, registryRoot, verifyEvidence, containerArgs, prepare,
  readerInput, validateReport, writeOnce, readiness, budgetRunner, teardown, execute, main };
