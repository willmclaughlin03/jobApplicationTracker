'use strict';

/** One local, approval-bound troubleshooting attempt; never a qualification retry or artifact scanner. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { performance } = require('node:perf_hooks');
const SOURCE = '0e89e234b483b9dc6ab1c374b2064532af8fb789';
const IMAGE = 'sha256:66d5a93aae6cf3976dd976a10bbc1e90abd8025270dd1377f35895bea742556b';
const DAEMON = 'd9e0f885-82f3-4431-9ac7-6c20e8435536';
const BINDING = 'b4cecd83cca0db031dd1dba608cad4790c04bc82afbe7d19f7c18b19a552a76f';
const FAILED = 'dfeb059430b7fa18eae6ef15689450d10651838ea8f859f06bade0654d8ee66a';
const DIAGNOSTIC = 'd211085a4fe7623d364b4ececc313e6a95d2b32c87947ba8a21a9bf28084a1ef';
const PRIOR = '4eaf0aae995a391892f81e0a412bf54f72702548f2b20033eb9cf0df7bf0ccb8';
const SCOPE = 'gate1_font_failure_observation_v1';
const VOLUME = 'gate1-font-failure-observation-0e89e234-v1';
const NAME = 'gate1-font-failure-observation-0e89e234-owner-v1';
const KEY = SOURCE + '.font-failure-observation-v1';
const PHRASE = 'OBSERVE ORIGINAL OFFLINE FONT FAILURE AND SAFE COMMAND BANNERS ONCE';
const ROOT = process.platform === 'linux' ? '/opt/gate1' : path.resolve(__dirname, '../..');
const CHECKOUT = path.join(ROOT, '.tmp/worktrees/gate1-qualification-main-0e89e234-lf');
const QFILE = process.platform === 'linux' ? '/opt/gate1/scripts/gate1-build-qualification.js' : path.join(CHECKOUT, 'scripts/gate1-build-qualification.js');
const QHASH = 'dd665377170f160f7edb012d2cabde690730b8622f49a19ff353345e2dca4736';
const FOLDER = `/state/${SOURCE}`;
const APP = FOLDER + '/app';
const NODE = '/opt/node-v22.23.3-linux-x64/bin/node';
const NPM = '/opt/node-v22.23.3-linux-x64/bin/npm';
const LIMITS = Object.freeze({ stageMs: 1800000, attemptMs: 3900000, cleanupMs: 90000,
  streamBytes: 8388608, stageStreamBytes: 16777216, lineBytes: 16384, reportBytes: 32768,
  inputBytes: 65536, storageBytes: 8589934592, storageEntries: 250000,
  cpus: 4, memoryBytes: 6442450944, pids: 256, tmpfsBytes: 536870912, headroomBytes: 21474836480 });
const COMMANDS = Object.freeze({ toolchain_install: [NPM, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
  application_install: [NPM, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
  postinstall: [NPM, 'run', 'postinstall', '--offline'],
  vercel_build: [NODE, FOLDER + '/tools/node_modules/vercel/dist/vc.js', 'build', '--standalone', '--target=preview'] });
const ENV_NAMES = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CSRF_SECRET'];
const CODES = ['ENOTCACHED', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EACCES', 'ENOENT'];
const STEPS = ['preparation', 'toolchain_install', 'application_install', 'ownership', 'versions', 'postinstall', 'vercel_build', 'storage'];
const OBSERVED_COMMANDS = ['node scripts/validate-build-env.js', 'npm run build:preflight && next build'];
const FONT_TITLE = 'Error: next/font: error:';
const FONT_MESSAGE = 'Failed to fetch Inter from Google Fonts.';

/** Hash public bytes for review identities; raw build streams are never hashed or persisted. */
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
/** Use fixed failure codes, keeping exceptions and operating-system messages out of reports. */
function fail(code) { throw Object.assign(new Error('Reproduction stopped'), { safeCode: code }); }
/** Load only the byte-verified original helper; requiring it does not execute its command-line entry point. */
function qualification() {
  if (sha(fs.readFileSync(QFILE)) !== QHASH) fail('integrity');
  return require(QFILE);
}
/** Read reviewed regular public files through the original path/identity guard. */
function readPublic(q, file, limit = 8388608) { return q.publicFile(file, limit); }
/** Check exact object keys, rejecting appended output fields before any retention. */
function keys(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort());
}
/** Build a public diagnostic dictionary only from verified original source and immutable locks. */
function catalog(q, root, manifest, toolLock) {
  const locations = {}, modules = new Set(), literals = new Set();
  let total = 0;
  for (const item of manifest) {
    const bytes = readPublic(q, path.join(root, item.name)); total += bytes.length;
    if (total > 134217728 || crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== item.oid) fail('source');
    if (!/\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(item.name)) continue;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    locations[item.name] = text.split('\n').length;
    for (const match of text.matchAll(/(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*(?:\(\s*)?)["']([^"'\r\n\\]{1,200})["']/g)) modules.add(match[1]);
    for (const match of text.matchAll(/\b(?:Error|TypeError|RangeError)\s*\(\s*['"]([ A-Za-z0-9_.,:;!?()/-]{4,240})['"]/g)) literals.add(match[1]);
  }
  for (const lock of [q.strictJson(readPublic(q, path.join(root, 'package-lock.json'))), toolLock]) {
    for (const name of Object.keys(lock.packages || {})) if (name.includes('node_modules/')) modules.add(name.slice(name.lastIndexOf('node_modules/') + 13));
  }
  return { locations, modules: [...modules].sort(), literals: [...literals].sort() };
}
/** Remove only terminal SGR styling; reject every other control sequence rather than interpreting it. */
function cleanLines(bytes) {
  // eslint-disable-next-line no-control-regex -- Remove only literal terminal SGR control bytes.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (lines.some(line => Buffer.byteLength(line) > LIMITS.lineBytes)) fail('line_limit');
  // eslint-disable-next-line no-control-regex -- Drop lines containing other terminal/control bytes.
  return lines.map(line => /[\x00-\x08\x0b-\x1f\x7f]/.test(line) ? '' : line);
}
/** Map only original source locations; absolute, generated, dependency and unknown paths are never exported. */
function location(line, dictionary) {
  const escaped = APP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalized = line.trim().replace(new RegExp(escaped + '/', 'g'), '');
  const m = /(?:^|[ (])(?:\.\/)?([A-Za-z0-9_./-]+\.(?:jsx?|tsx?|mjs|cjs))(?::(\d{1,7})(?::(\d{1,5}))?)?(?:[) ]|$)/.exec(normalized);
  if (!m || !Object.hasOwn(dictionary.locations, m[1])) return null;
  const row = m[2] ? Number(m[2]) : null, column = m[3] ? Number(m[3]) : null;
  if (row !== null && (row < 1 || row > dictionary.locations[m[1]])) return null;
  if (column !== null && (column < 1 || column > 16384)) return null;
  return { file: m[1], line: row, column };
}
/** Generate additional deny strings for the known synthetic inputs; this is defense in depth, not arbitrary decoding. */
function secretVariants(values) {
  const result = new Set();
  for (const value of values) for (const text of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1),
    Buffer.from(value).toString('hex'), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'),
    [...value].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')]) result.add(text);
  return [...result];
}
/** Construct messages from fixed templates/public dictionary entries; never return a raw line or code frame. */
function candidate(line, dictionary) {
  let m;
  if ((m = /^(?:Error: )?(?:Module not found: )?(?:Cannot find module|Cannot find package|Can't resolve) ['"]([^'"\r\n]+)['"](?:\.)?$/.exec(line)) && dictionary.modules.includes(m[1])) {
    return { kind: 'missing_module', detail: m[1] };
  }
  if ((m = /^(?:[x×✖✘] )?(?:SyntaxError: |Error: )?(Unexpected token|Expected token) ['"]?([{}()[\]:;,<>+=*/?!.-])['"]?[.,]?$/.exec(line))) {
    return { kind: 'syntax', detail: m[1] + ' ' + m[2] };
  }
  if ((m = /^(?:npm (?:error|ERR!) code |Error: |(?:Error: )?\w+ )?(ENOTCACHED|ENETUNREACH|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EACCES|ENOENT)(?:$|[ :])/.exec(line))) {
    return { kind: 'system_code', detail: m[1] };
  }
  if ((m = /^(?:Error|TypeError|RangeError): (.+)$/.exec(line)) && dictionary.literals.includes(m[1])) {
    return { kind: 'public_source_error', detail: m[1] };
  }
  return null;
}
/** Render a validated candidate without unknown values; identical logic is used by host validation. */
function message(item) {
  if (item.kind === 'missing_module') return 'Cannot resolve public module reference: ' + item.detail;
  if (item.kind === 'syntax') return item.detail;
  if (item.kind === 'system_code') return 'Reported system/cache code: ' + item.detail;
  if (item.kind === 'preflight') return 'Missing required build environment variables: ' + item.detail;
  if (item.kind === 'public_source_error') return item.detail;
  if (item.kind === 'font_fetch') return FONT_MESSAGE;
  fail('report');
}
/** Retain only deduplicated public npm banners per stream; display proves neither completion nor failure. */
function observations(bytes, stream, secrets) {
  const result = [], denied = secretVariants(secrets);
  for (const line of cleanLines(bytes)) {
    const detail = OBSERVED_COMMANDS.find(command => line.trim() === '> ' + command);
    if (!detail || result.some(item => item.detail === detail)) continue;
    const item = { kind: 'command', detail, stream };
    if (denied.some(value => JSON.stringify(item).includes(value))) fail('unsafe_output');
    result.push(item);
  }
  return result;
}
/** Independently reject forged/duplicate observation fields on the host; two commands times two streams bounds retention. */
function validObservations(items) {
  return Array.isArray(items) && items.length <= OBSERVED_COMMANDS.length * 2 && items.every(item =>
    keys(item, ['kind', 'detail', 'stream']) && item.kind === 'command' && OBSERVED_COMMANDS.includes(item.detail) &&
    ['stdout', 'stderr'].includes(item.stream)) && new Set(items.map(item => item.stream + ':' + item.detail)).size === items.length;
}
/** Select the first recognized error per stream, preserving uncertainty about cross-stream and unknown earlier errors. */
function extract(bytes, stream, dictionary, secrets) {
  const lines = cleanLines(bytes), denied = secretVariants(secrets);
  let currentLocation = null, currentAt = -99, observedCommand = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const loc = location(line, dictionary);
    if (loc) { currentLocation = loc; currentAt = i; }
    if (line === '> node scripts/validate-build-env.js') observedCommand = 'node scripts/validate-build-env.js';
    if (line === '> npm run build:preflight && next build') observedCommand = 'npm run build:preflight && next build';
    // Next 16.3.3 prints this source-less issue's title immediately before its description, with only SGR styling.
    let found = line === FONT_TITLE ? (lines[i + 1]?.trim() === FONT_MESSAGE ? { kind: 'font_fetch', detail: 'Inter' } : null) : candidate(line, dictionary);
    if (line === 'Missing required build environment variables:') {
      const names = []; let j = i + 1;
      while (j < lines.length && /^- /.test(lines[j].trim())) { names.push(lines[j].trim().slice(2)); j++; }
      if (names.length && names.length <= 4 && new Set(names).size === names.length && names.every(n => ENV_NAMES.includes(n))) {
        found = { kind: 'preflight', detail: names.join(', ') };
        observedCommand = 'node scripts/validate-build-env.js';
      }
    }
    if (!found) continue;
    let sourceLocation = found.kind === 'font_fetch' ? location(lines[i - 1] || '', dictionary) : i - currentAt <= 8 ? currentLocation : null;
    if (!sourceLocation && found.kind !== 'font_fetch') for (const next of lines.slice(i + 1, i + 9)) { sourceLocation = location(next, dictionary); if (sourceLocation) break; }
    const result = { ...found, message: message(found), stream, observedCommand, sourceLocation };
    const serialized = JSON.stringify(result);
    if (denied.some(value => serialized.includes(value))) fail('unsafe_output');
    return result;
  }
  return null;
}
/** Validate reconstructed diagnostic text again on the host without accepting raw error strings. */
function validDiagnostic(item, dictionary) {
  if (!keys(item, ['kind', 'detail', 'message', 'stream', 'observedCommand', 'sourceLocation']) ||
      !['stdout', 'stderr'].includes(item.stream) || ![null, 'node scripts/validate-build-env.js', 'npm run build:preflight && next build'].includes(item.observedCommand)) return false;
  if (typeof item.detail !== 'string' || item.detail.length > 300) return false;
  const allowed = (item.kind === 'missing_module' && dictionary.modules.includes(item.detail)) ||
    (item.kind === 'public_source_error' && dictionary.literals.includes(item.detail)) ||
    (item.kind === 'system_code' && CODES.includes(item.detail)) ||
    (item.kind === 'font_fetch' && item.detail === 'Inter') ||
    (item.kind === 'syntax' && /^(?:Unexpected token|Expected token) [{}()[\]:;,<>+=*/?!.-]$/.test(item.detail)) ||
    (item.kind === 'preflight' && item.detail.split(', ').length <= 4 && item.detail.split(', ').every(n => ENV_NAMES.includes(n)));
  if (!allowed || item.message !== message(item)) return false;
  const loc = item.sourceLocation;
  return loc === null || (keys(loc, ['file', 'line', 'column']) && Object.hasOwn(dictionary.locations, loc.file) &&
    (loc.line === null || (Number.isInteger(loc.line) && loc.line >= 1 && loc.line <= dictionary.locations[loc.file])) &&
    (loc.column === null || (Number.isInteger(loc.column) && loc.column >= 1 && loc.column <= 16384)));
}
/** Capture both streams privately, kill descendants on every stop and release raw buffers after safe extraction. */
function capture(command, args, options) {
  return new Promise(resolve => {
    const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
    let child, finished = false, timer;
    const started = performance.now();
    /** Terminate the Linux process group; Windows synthetic fixtures have no descendant processes. */
    function kill() { try { if (child?.pid) { if (process.platform === 'linux') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } } catch { /* Gone. */ } }
    /** Emit only fixed state and validated diagnostics, including when a process fails normally. */
    function finish(reason, code = null, signal = null) {
      if (finished) return; finished = true; clearInterval(timer); kill();
      const diagnostics = [], observed = [];
      if (reason === 'closed' && code !== 0) {
        try { for (const stream of ['stdout', 'stderr']) {
          const bytes = Buffer.concat(chunks[stream]);
          observed.push(...observations(bytes, stream, options.secrets || []));
          const item = extract(bytes, stream, options.dictionary, options.secrets || []);
          if (item) diagnostics.push(item);
        } } catch { reason = 'unsafe_output'; diagnostics.length = 0; observed.length = 0; }
      }
      for (const stream of ['stdout', 'stderr']) { for (const bytes of chunks[stream]) bytes.fill(0); chunks[stream].length = 0; }
      resolve({ reason, exitCode: Number.isInteger(code) && code >= 0 && code <= 255 ? code : null,
        signal: [null, 'SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGSEGV', 'SIGINT', 'SIGBUS', 'SIGILL'].includes(signal) ? signal : 'unknown', sizes, diagnostics, observations: observed });
    }
    try {
      child = (options.spawn || spawn)(command, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
        detached: process.platform === 'linux', stdio: ['ignore', 'pipe', 'pipe'], ...(options.uid === undefined ? {} : { uid: options.uid, gid: options.gid }) });
      child.once('error', () => finish('spawn'));
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
        if (finished) return;
        sizes[stream] += bytes.length; options.budget.bytes += bytes.length;
        if (sizes[stream] > (options.streamLimit || LIMITS.streamBytes) || options.budget.bytes > (options.stageLimit || LIMITS.stageStreamBytes)) return finish('stream_limit');
        chunks[stream].push(Buffer.from(bytes));
      });
      child.once('close', (code, signal) => finish('closed', code, signal));
      timer = setInterval(() => {
        if (performance.now() - started >= options.timeoutMs) return finish('deadline');
        try { options.poll?.(); } catch { finish('storage'); }
      }, Math.min(100, options.timeoutMs));
    } catch { finish('spawn'); }
  });
}
/** Provide the original Linux environment, never inheriting host variables or provider authentication. */
function linuxEnvironment(values = {}) {
  return { PATH: '/opt/node-v22.23.3-linux-x64/bin:/usr/bin:/bin', HOME: '/tmp/home', TMPDIR: '/tmp', CI: '1',
    NEXT_TELEMETRY_DISABLED: '1', VERCEL_TELEMETRY_DISABLED: '1', npm_config_offline: 'true', npm_config_audit: 'false',
    npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_logs_max: '0', npm_config_timing: 'false',
    npm_config_cache: FOLDER + '/cache', ...values };
}
/** Transfer only an original source copy to the build UID, before dependency symlinks exist. */
function ownSource(root) {
  const stat = fs.lstatSync(root); if (stat.isSymbolicLink()) fail('source'); fs.chownSync(root, 1000, 1000);
  if (stat.isDirectory()) for (const name of fs.readdirSync(root)) ownSource(path.join(root, name));
}
/** Check all eight actual versions using the CLI's original module-resolution root. */
function versions(q) {
  const cli = FOLDER + '/tools/node_modules/vercel/package.json';
  const resolve = require('node:module').createRequire(cli);
  const actual = { node: process.versions.node, npm: q.strictJson(readPublic(q, '/opt/node-v22.23.3-linux-x64/lib/node_modules/npm/package.json')).version,
    next: q.strictJson(readPublic(q, APP + '/node_modules/next/package.json')).version, vercel: q.strictJson(readPublic(q, cli)).version };
  for (const name of ['@vercel/next', '@vercel/node', '@vercel/static-build']) actual[name] = q.strictJson(readPublic(q, resolve.resolve(name + '/package.json'))).version;
  actual.zod = q.strictJson(readPublic(q, FOLDER + '/tools/node_modules/zod/package.json')).version;
  if (JSON.stringify(actual) !== JSON.stringify(q.VERSIONS)) fail('versions');
  return actual;
}
/** Run only the reviewed preparation or build in the fresh volume; raw child streams never reach Docker attach. */
async function inside(envelope) {
  const q = qualification(), { stage, digest, contract } = envelope;
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() !== 0 ||
      !['prepare', 'build'].includes(stage) || sha(JSON.stringify(contract)) !== digest || contract.scope !== SCOPE) fail('approval');
  const original = q.strictJson(readPublic(q, '/opt/gate1/review.json'));
  if (original.binding !== BINDING || original.contract.sourceSha !== SOURCE) fail('integrity');
  const dictionary = catalog(q, '/opt/source', original.contract.sourceManifest, q.strictJson(readPublic(q, '/opt/toolchain/package-lock.json')));
  if (sha(JSON.stringify(dictionary)) !== contract.catalogSha256) fail('integrity');
  const report = { scope: SCOPE, sourceSha: SOURCE, approval: digest, stage, result: 'stopped', failingStep: 'preparation',
    versions: null, children: [], failure: null, rawStreamsRetained: false, gate1Status: 'open' };
  const started = performance.now(), budget = { bytes: 0 }; let lastPoll = -Infinity, secrets = [];
  /** Enforce one shared stage budget and record only safe command observations. */
  async function run(step, command, args, cwd, env, uid) {
    report.failingStep = step;
    const remaining = LIMITS.stageMs - (performance.now() - started); if (remaining <= 0) fail('deadline');
    const result = await capture(command, args, { cwd, env, uid, gid: uid, dictionary, secrets, budget, timeoutMs: remaining,
      poll() { if (performance.now() - lastPoll >= 2000) { q.storageCheck('/state'); lastPoll = performance.now(); } } });
    report.children.push({ step, ...result });
    if (result.reason !== 'closed' || result.exitCode !== 0 || result.signal) fail('child');
  }
  try {
    if (stage === 'prepare') {
      if (fs.readdirSync('/state').length) fail('occupied');
      fs.mkdirSync(FOLDER, { mode: 0o711 });
      q.verifySource('/opt/source', original.contract.sourceManifest);
      fs.cpSync('/opt/source', APP, { recursive: true, force: false, errorOnExist: true }); ownSource(APP);
      fs.cpSync('/opt/toolchain', FOLDER + '/tools', { recursive: true, force: false, errorOnExist: true });
      fs.cpSync('/opt/npm-cache', FOLDER + '/cache', { recursive: true, force: false, errorOnExist: true });
      q.storageCheck('/state'); fs.mkdirSync('/tmp/home', { mode: 0o777 });
      for (const step of ['toolchain_install', 'application_install']) await run(step, COMMANDS[step][0], COMMANDS[step].slice(1), step === 'toolchain_install' ? FOLDER + '/tools' : APP, linuxEnvironment());
      await run('ownership', '/usr/bin/chown', ['-R', '-h', '1000:1000', APP], APP, linuxEnvironment());
      report.failingStep = 'versions'; report.versions = versions(q);
      q.writeOnce(FOLDER + '/reproduction-prepared.json', { scope: SCOPE, approval: digest, versions: report.versions });
    } else {
      const setup = q.strictJson(readPublic(q, FOLDER + '/reproduction-prepared.json'));
      if (!keys(setup, ['scope', 'approval', 'versions']) || setup.scope !== SCOPE || setup.approval !== digest || JSON.stringify(setup.versions) !== JSON.stringify(q.VERSIONS)) fail('preparation');
      report.failingStep = 'versions'; report.versions = versions(q);
      if (fs.existsSync(APP + '/.vercel') || fs.existsSync(APP + '/.next')) fail('occupied');
      const inputs = q.syntheticInputs(); secrets = inputs.comparisons.map(item => item.value);
      fs.mkdirSync(FOLDER + '/private', { mode: 0o700 }); q.writeOnce(FOLDER + '/private/comparisons.json', inputs.comparisons);
      fs.mkdirSync(APP + '/.vercel', { mode: 0o755 }); q.writeOnce(APP + '/.vercel/project.json', q.SETTINGS);
      fs.chmodSync(APP + '/.vercel/project.json', 0o644); fs.chownSync(APP + '/.vercel', 1000, 1000);
      fs.mkdirSync('/tmp/home', { mode: 0o700 }); fs.chownSync('/tmp/home', 1000, 1000);
      const env = linuxEnvironment({ ...inputs.env, NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview' });
      await run('postinstall', NPM, ['run', 'postinstall', '--offline'], APP, env, 1000);
      report.failingStep = 'versions';
      if (q.vercelEntry(FOLDER) !== COMMANDS.vercel_build[1]) fail('versions');
      await run('vercel_build', NODE, COMMANDS.vercel_build.slice(1), APP, env, 1000);
    }
    report.failingStep = 'storage'; q.storageCheck('/state'); report.result = 'completed'; report.failingStep = null;
  } catch (error) { report.failure = ['child', 'deadline', 'occupied', 'versions', 'preparation'].includes(error.safeCode) ? error.safeCode : 'internal'; }
  return report;
}
/** Validate nested process status and diagnostics before a host file or chat-visible result can contain them. */
function validateReport(value, stage, digest, dictionary, q) {
  if (!keys(value, ['scope', 'sourceSha', 'approval', 'stage', 'result', 'failingStep', 'versions', 'children', 'failure', 'rawStreamsRetained', 'gate1Status']) ||
      value.scope !== SCOPE || value.sourceSha !== SOURCE || value.approval !== digest || value.stage !== stage ||
      !['completed', 'stopped'].includes(value.result) || value.rawStreamsRetained !== false || value.gate1Status !== 'open' ||
      ![null, ...STEPS].includes(value.failingStep) || ![null, 'child', 'deadline', 'occupied', 'versions', 'preparation', 'internal'].includes(value.failure) ||
      (value.versions !== null && JSON.stringify(value.versions) !== JSON.stringify(q.VERSIONS)) || !Array.isArray(value.children)) fail('report');
  const sequence = stage === 'prepare' ? ['toolchain_install', 'application_install', 'ownership'] : ['postinstall', 'vercel_build'];
  if (value.children.length > sequence.length) fail('report');
  let total = 0;
  for (const [i, child] of value.children.entries()) {
    if (!keys(child, ['step', 'reason', 'exitCode', 'signal', 'sizes', 'diagnostics', 'observations']) || child.step !== sequence[i] ||
        !['closed', 'spawn', 'deadline', 'storage', 'stream_limit', 'unsafe_output'].includes(child.reason) ||
        !(child.exitCode === null || (Number.isInteger(child.exitCode) && child.exitCode >= 0 && child.exitCode <= 255)) ||
        ![null, 'SIGKILL', 'SIGTERM', 'SIGABRT', 'SIGSEGV', 'SIGINT', 'SIGBUS', 'SIGILL', 'unknown'].includes(child.signal) ||
        !keys(child.sizes, ['stdout', 'stderr']) || !Object.values(child.sizes).every(n => Number.isSafeInteger(n) && n >= 0 && n <= LIMITS.stageStreamBytes * 2) ||
        !Array.isArray(child.diagnostics) || child.diagnostics.length > 2 || !child.diagnostics.every(d => validDiagnostic(d, dictionary)) ||
        !validObservations(child.observations)) fail('report');
    total += child.sizes.stdout + child.sizes.stderr;
    const success = child.reason === 'closed' && child.exitCode === 0 && child.signal === null;
    if ((child.diagnostics.length || child.observations.length) && (child.reason !== 'closed' || child.exitCode === 0)) fail('report');
    if (i < value.children.length - 1 && !success) fail('report');
    if (value.result === 'completed' && !success) fail('report');
    if (!success && value.failingStep !== child.step) fail('report');
    if (child.reason !== 'stream_limit' && (child.sizes.stdout > LIMITS.streamBytes || child.sizes.stderr > LIMITS.streamBytes)) fail('report');
  }
  if (total > LIMITS.stageStreamBytes * 2 || (value.result === 'completed' &&
      (value.children.length !== sequence.length || value.versions === null || value.failure !== null || value.failingStep !== null)) ||
      (value.result === 'stopped' && (value.failure === null || value.failingStep === null))) fail('report');
  return value;
}
/** Recheck fixed public inputs and preservation records without mounting or reading retained generated output. */
async function prepare() {
  const q = qualification();
  const gitEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter(n => process.env[n]).map(n => [n, process.env[n]]));
  Object.assign(gitEnv, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' });
  const gitOptions = { cwd: CHECKOUT, env: gitEnv };
  if ((await q.supervise('git', ['rev-parse', 'HEAD'], gitOptions)).toString().trim() !== SOURCE ||
      (await q.supervise('git', ['status', '--porcelain=v1', '--untracked-files=all'], gitOptions)).length) fail('source');
  const prior = path.join(ROOT, '.tmp/gate1-qualification-review-0e89e234');
  const manifestBytes = readPublic(q, path.join(prior, 'source-manifest.json'));
  if (sha(manifestBytes) !== '28674a265962cd0a0119210fb621f7891997712fadbc61aa74058923ab8cd920') fail('source');
  const inputs = path.join(ROOT, '.tmp/gate1-qualification-inputs-7f70e4eb');
  const hashes = { 'node-v22.23.3-linux-x64.tar.gz': '1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af',
    'npm-cache.tar': '041659a5d51213b62dbb2bd7a74770ec8cf0ec1116ea0a1e7401eaf2c92163d1',
    'toolchain-lock.json': '149e57f6898ce7b087783fbd7597b59f13afd333f3ed22232dac125218a83bae',
    'toolchain-package.json': '9be46e160b38869b7a96472c06551181a910fdef3c2c4f21963bdb0bc605f88f',
    'acquisition-receipt.json': '87e4b9ab149937b7a23c8351e4d5e3f73d46911dea510b41637737eea55c7ffb' };
  for (const [name, hash] of Object.entries(hashes)) if (q.fileHash(path.join(inputs, name)) !== hash) fail('inputs');
  const preservation = readPublic(q, path.join(prior, 'evidence-preservation.json'));
  if (sha(preservation) !== '16250b9fee5ccdc842adb4cab8debfdec29038348b5edf3280ab7388be3dc931') fail('evidence');
  const evidence = Object.fromEntries(q.strictJson(preservation).hashedPublicEvidence.map(item => [item.path, item.sha256]));
  const registry = path.join(ROOT, '.tmp/gate1-build-qualification');
  for (const [name, hash] of Object.entries({
    [SOURCE + '.setup.receipt.json']: '37e0aba96b84d71346f656a220530dbdf011e3e24b09717fc27d73aa363c5f08',
    [SOURCE + '.setup.reservation.json']: 'ed5a7403b7bf28af88bc243cc34080b110f29cfc1b185182af85a4608116746e',
    [SOURCE + '.build.receipt.json']: '88479ea799581cd8c10ec7ad869544eeaf3fafbb22f9f7cd8c7a40b6ebcac5d3',
    [SOURCE + '.build.reservation.json']: 'b15e2bfddd03e5f4881ca6be4e114d36ea4b8511395b81ed3d70cc82a5ec905f',
    [SOURCE + '.vercel-diagnostic.' + FAILED + '.report.json']: '165f21d422e26109b50adb864fc98cb8d0939c6802ce4f5b9992a4b253d80398',
    [SOURCE + '.vercel-diagnostic.' + FAILED + '.reservation.json']: '9c2b0ef7a366cf12bc5251adbdde3930fdf7a9fa3c83ed1e123304f254df70d1',
    [SOURCE + '.troubleshooting-reproduction-v1.report.json']: 'd23e87405ac843a1249da579b1ef751caa017c1fa69f2412c25999633d0f8301',
    [SOURCE + '.troubleshooting-reproduction-v1.reservation.json']: 'fdae42a8f358b16ae0dbaea1b8645d1298528e35f2ec5f26d65dd7764cce15fe' })) evidence[path.join(registry, name)] = hash;
  for (const [file, hash] of Object.entries(evidence)) if (q.fileHash(file) !== hash) fail('evidence');
  const dictionary = catalog(q, CHECKOUT, q.strictJson(manifestBytes), q.strictJson(readPublic(q, path.join(inputs, 'toolchain-lock.json'))));
  const code = readPublic(q, __filename, LIMITS.inputBytes), testHash = q.fileHash(path.join(__dirname, '__tests__/reproduce.test.js'));
  const contract = { schemaVersion: 1, scope: SCOPE, sourceSha: SOURCE, originalBinding: BINDING,
    consumedBuildApproval: FAILED, consumedDiagnosticApproval: DIAGNOSTIC, consumedReproductionApproval: PRIOR, helperRevision: 'local_bytes_sha256',
    helperSha256: sha(code), testSha256: testHash, qualificationHelperSha256: QHASH,
    sourceManifestSha256: sha(manifestBytes), cachedInputs: hashes, preservedEvidence: evidence,
    catalogSha256: sha(JSON.stringify(dictionary)), versions: q.VERSIONS, settings: q.SETTINGS,
    context: 'desktop-linux', imageId: IMAGE, daemonId: DAEMON, freshVolume: VOLUME, containerName: NAME,
    commands: COMMANDS, sourcePath: '/opt/source', workspace: FOLDER, commandsCwd: APP,
    toolchainInstallCwd: FOLDER + '/tools', limits: LIMITS, syntheticInputs: 'original_generator_fresh_values',
    network: 'none', rawStreamsRetained: false, attempts: 1, reservationKey: KEY,
    policy: { name: 'fixed_templates_public_references_only_v1', buffering: 'Linux supervisor memory only; no raw file or Docker log',
      rawStreams: 'stdout and stderr separately; 8 MiB each per child; 16 MiB aggregate per stage, 32 MiB per attempt',
      report: '32 KiB per container and host result; first recognized candidate and at most two deduplicated command banners per stream of failing child',
      text: 'reconstructed fixed template plus exact public dictionary entry; never raw lines, environment dumps or code frames',
      locations: 'original source path, valid line and optional column; generated/dependency/foreign locations omitted',
      secrets: 'fresh generated comparison values; exact, URL, JSON-escaped, hex, base64/base64url and Unicode-escaped deny checks on reconstructed candidates',
      chunks: 'decode complete bounded per-stream buffer strictly as UTF-8; CRLF and SGR normalization; multiline preflight names and adjacent production Inter title/summary only',
      unsafe: 'invalid UTF-8, overlong line or secret match suppresses all diagnostics and observations for that child; stream overflow/deadline stops child and suppresses partial output',
      limits: 'arbitrary encodings/covert channels are not proven safe; no raw text permitted; unsupported error formats may remain inconclusive; RAM secure erasure and host swap excluded',
      generatedFiles: 'new build files and private comparison values stay in retained new volume, uninspected and not exported',
      access: 'Linux root supervisor only for raw buffers; private comparison directory 0700; host sanitized files owner-local (Windows inherited ACL)',
      chat: 'validated child step, fixed observed command banners (not completion or failing-command evidence), first recognized candidate per stream, public source location, exit/signal and uncertainty only' },
    unknownOutput: 'discard_and_report_inconclusive',
    crossStreamOrder: 'not_established', originalVolumeMounted: false, download: false, artifactInspection: false,
    retention: 'new_volume_private_and_sanitized_host_records_until_separately_reviewed_cleanup',
    confirmation: PHRASE, gate1Status: 'open' };
  const digest = sha(JSON.stringify(contract));
  if (Buffer.byteLength('globalThis.__gate1Envelope=' + JSON.stringify({ stage: 'prepare', digest, contract }) + ';\n') + code.length > LIMITS.inputBytes) fail('input');
  return { contract, digest, dictionary, code };
}
/** Fix isolation independently of caller input; mount only the new volume and clear inherited container environment. */
function containerArgs(stage) {
  if (!['prepare', 'build'].includes(stage)) fail('stage');
  return ['create', '--name', NAME, '--pull=never', '--platform=linux/amd64', '--network=none', '--read-only', '--init',
    '--restart=no', '--log-driver=none', '--cpus=4', '--memory=6442450944', '--memory-swap=6442450944', '--pids-limit=256',
    '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=SETUID', '--cap-add=SETGID',
    '--security-opt=no-new-privileges', '--ulimit=nofile=4096:4096', '--ulimit=core=0:0',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=536870912,mode=1777', '--mount', `type=volume,src=${VOLUME},dst=/state,volume-nocopy`,
    '--mount', `type=volume,src=${VOLUME},dst=/opt/gate1/.tmp,volume-nocopy`, '--entrypoint', '/usr/bin/timeout', '-i', IMAGE,
    '--signal=KILL', `${Math.ceil((LIMITS.stageMs + 20000) / 1000)}s`, '/usr/bin/env', '-i', 'PATH=/opt/node-v22.23.3-linux-x64/bin:/usr/bin:/bin', NODE, '-'];
}
/** Confirm the created container's enforced controls before starting any package process. */
async function verifyContainer(q, docker, cid) {
  const state = q.strictJson(await docker(['inspect', cid]));
  if (state.length !== 1 || state[0].Id !== cid || state[0].Image !== IMAGE || state[0].State?.Running !== false) fail('container');
  const actual = state[0], h = actual.HostConfig;
  if (!h || h.NetworkMode !== 'none' || h.ReadonlyRootfs !== true || h.LogConfig?.Type !== 'none' || h.RestartPolicy?.Name !== 'no' ||
      h.Memory !== LIMITS.memoryBytes || h.MemorySwap !== LIMITS.memoryBytes || h.NanoCpus !== 4000000000 || h.PidsLimit !== LIMITS.pids ||
      h.Privileged !== false || h.Init !== true || h.Binds?.length || h.Devices?.length ||
      JSON.stringify(h.CapDrop) !== '["ALL"]' || JSON.stringify([...(h.CapAdd || [])].sort()) !== '["CHOWN","DAC_OVERRIDE","SETGID","SETUID"]' ||
      JSON.stringify(h.SecurityOpt) !== '["no-new-privileges"]' || !h.Tmpfs || Object.keys(h.Tmpfs).length !== 1 ||
      h.Tmpfs['/tmp'] !== 'rw,nosuid,nodev,size=536870912,mode=1777' ||
      !Array.isArray(actual.Mounts) || actual.Mounts.length !== 2 || actual.Mounts.some(m =>
        m.Type !== 'volume' || m.Name !== VOLUME || m.RW !== true || !['/state', '/opt/gate1/.tmp'].includes(m.Destination)) ||
      JSON.stringify(actual.Config?.Entrypoint) !== '["/usr/bin/timeout"]' ||
      JSON.stringify(actual.Config?.Cmd) !== JSON.stringify(containerArgs('build').slice(containerArgs('build').indexOf(IMAGE) + 1))) fail('container');
  const u = Object.fromEntries((h.Ulimits || []).map(v => [v.Name, [v.Soft, v.Hard]]));
  if (JSON.stringify(u.nofile) !== '[4096,4096]' || JSON.stringify(u.core) !== '[0,0]') fail('container');
}
/** Check the daemon, historical volume and fresh target names without allowing automatic reuse. */
async function readiness(q, docker) {
  if (await q.engineCheck(docker, 'build', DAEMON) !== DAEMON) fail('docker');
  const info = q.strictJson(await docker(['info', '--format', '{{json .}}']));
  if (info.NCPU < 4 || info.MemTotal < LIMITS.memoryBytes) fail('capacity');
  for (const id of [IMAGE, 'sha256:13e3c60e25fce0419b3679d52ae83bae18a52cf7fded8a557e038812e658d273']) {
    const data = q.strictJson(await docker(['image', 'inspect', '--format', '{{json .}}', id]));
    if (data.Id !== id || data.Os !== 'linux' || data.Architecture !== 'amd64') fail('image');
  }
  for (const name of [NAME, 'gate1-reproduction-0e89e234-owner-v1', 'gate1-vercel-diagnostic-owner-v1']) if ((await docker(['ps', '-aq', '--filter', `name=^/${name}$`])).toString().trim()) fail('occupied');
  if ((await docker(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${VOLUME}$`])).toString().trim()) fail('occupied');
  const disk = fs.statfsSync(ROOT); if (disk.bavail * disk.bsize < LIMITS.headroomBytes) fail('capacity');
  const capacity = (await q.supervise('wsl.exe', ['-d', 'docker-desktop', '-e', 'df', '-B1', '/mnt/host/wsl/docker-desktop-data/isocache'])).toString();
  const row = capacity.trim().split('\n').at(-1).trim().split(/\s+/);
  if (row.length !== 6 || !/^\d+$/.test(row[3]) || Number(row[3]) < LIMITS.headroomBytes) fail('capacity');
}
/** Stop and remove only a returned container ID; ambiguous creation or teardown retains the lock for review. */
async function cleanup(q, docker, cid) {
  if (!/^[a-f0-9]{64}$/.test(cid || '')) fail('teardown');
  const end = performance.now() + LIMITS.cleanupMs;
  /** Bound the complete cleanup rather than resetting a deadline for every Docker command. */
  function remaining() { const ms = end - performance.now(); if (ms <= 0) fail('teardown'); return Math.min(30000, ms); }
  await docker(['kill', cid], { timeoutMs: remaining(), capture: false }).catch(() => {});
  const state = q.strictJson(await docker(['inspect', '--format', '{{json .State}}', cid], { timeoutMs: remaining() }));
  if (state.Running !== false || !Number.isInteger(state.ExitCode) || typeof state.OOMKilled !== 'boolean') fail('teardown');
  await docker(['rm', '-f', cid], { timeoutMs: remaining(), capture: false });
  if ((await docker(['ps', '-aq', '--filter', `id=${cid}`], { timeoutMs: remaining() })).toString().trim()) fail('teardown');
  return { exitCode: state.ExitCode, oomKilled: state.OOMKilled };
}
/** Execute exactly one newly authorized attempt; existing qualification/diagnostic reservations are read-only evidence. */
async function execute(digest, phrase, deps = {}) {
  const q = (deps.qualification || qualification)(), prepared = await (deps.prepare || prepare)();
  if (digest !== prepared.digest || phrase !== PHRASE) fail('approval');
  const review = deps.review || q.strictJson(readPublic(q, path.join(__dirname, 'execution-contract.json')));
  if (JSON.stringify(review) !== JSON.stringify(prepared.contract)) fail('approval');
  const baseDocker = deps.docker || ((args, options) => q.supervise('docker', ['--context', 'desktop-linux', ...args], options));
  await (deps.readiness || readiness)(q, baseDocker);
  const registry = deps.registry || path.join(ROOT, '.tmp/gate1-build-qualification'), lock = path.join(registry, 'active.lock');
  const reservation = path.join(registry, KEY + '.reservation.json'), output = path.join(registry, KEY + '.report.json');
  q.safePath(registry);
  if (fs.existsSync(lock) || fs.existsSync(reservation) || fs.existsSync(output)) fail('consumed');
  q.writeOnce(lock, { scope: SCOPE, approval: digest });
  let uncertain = false, cid = null, persistence = false, cleanupAttempted = false;
  const report = { scope: SCOPE, sourceSha: SOURCE, approval: digest, result: 'stopped', stages: [],
    failure: null, teardownUnconfirmed: false, persistenceFailure: false, gate1Status: 'open' };
  const end = performance.now() + LIMITS.attemptMs;
  /** Share the host attempt deadline across all Docker operations; teardown has its own single budget. */
  function docker(args, options = {}) {
    const remaining = end - performance.now(); if (remaining <= 0) fail('deadline');
    return baseDocker(args, { ...options, timeoutMs: Math.min(options.timeoutMs || 30000, remaining) });
  }
  try {
    q.writeOnce(reservation, { scope: SCOPE, sourceSha: SOURCE, originalBuildApproval: FAILED, consumedReproductionApproval: PRIOR, approval: digest, consumed: true });
    await docker(['volume', 'create', '--driver', 'local', '--label', `gate1.scope=${SCOPE}`, VOLUME]);
    const volume = q.strictJson(await docker(['volume', 'inspect', VOLUME]));
    if (volume.length !== 1 || volume[0].Name !== VOLUME || volume[0].Driver !== 'local' || Object.keys(volume[0].Options || {}).length || volume[0].Labels?.['gate1.scope'] !== SCOPE) fail('volume');
    for (const stage of ['prepare', 'build']) {
      if ((await docker(['ps', '-aq', '--filter', `volume=${VOLUME}`])).toString().trim()) fail('occupied');
      uncertain = true;
      cleanupAttempted = false;
      cid = (await docker(containerArgs(stage))).toString().trim();
      if (!/^[a-f0-9]{64}$/.test(cid)) fail('create');
      await (deps.verifyContainer || verifyContainer)(q, docker, cid);
      const prefix = 'globalThis.__gate1Envelope=' + JSON.stringify({ stage, digest, contract: prepared.contract }) + ';\n';
      const input = Buffer.concat([Buffer.from(prefix), prepared.code]);
      if (input.length > LIMITS.inputBytes) fail('input');
      const timeoutMs = Math.min(LIMITS.stageMs + 30000, end - performance.now()); if (timeoutMs <= 0) fail('deadline');
      let terminal; let attachExit = { exitCode: 0, signal: null };
      try {
        const bytes = await docker(['start', '--attach', '--interactive', cid], { timeoutMs, input, outputBytes: LIMITS.reportBytes,
          parseFailureReport(bytes) { return validateReport(q.strictJson(bytes), stage, digest, prepared.dictionary, q); } });
        terminal = validateReport(q.strictJson(bytes), stage, digest, prepared.dictionary, q);
      } catch (error) {
        if (error.code === 'child' && error.report) { terminal = error.report; attachExit = { exitCode: error.exitCode ?? null, signal: error.signal ?? null }; }
        else throw error;
      }
      const retainedStage = { stage, terminal, attachExit, containerExit: null, controlsVerifiedBeforeStart: true };
      report.stages.push(retainedStage);
      cleanupAttempted = true;
      const exit = await cleanup(q, baseDocker, cid); retainedStage.containerExit = exit; cid = null; uncertain = false;
      if (terminal.result !== 'completed' || exit.exitCode !== 0 || exit.oomKilled || attachExit.exitCode !== 0 || attachExit.signal) fail('stage');
    }
    report.result = 'completed';
  } catch (error) { report.failure = ['stage', 'deadline', 'input', 'create', 'volume', 'occupied'].includes(error.safeCode) ? error.safeCode : 'execution'; }
  finally {
    if (cid && !cleanupAttempted) try { await cleanup(q, baseDocker, cid); uncertain = false; } catch { uncertain = true; }
    report.teardownUnconfirmed = uncertain;
    try {
      if ((await baseDocker(['ps', '-aq', '--filter', `volume=${VOLUME}`], { timeoutMs: 30000 })).toString().trim()) { uncertain = true; report.teardownUnconfirmed = true; }
      for (const [file, hash] of Object.entries(prepared.contract.preservedEvidence)) if (q.fileHash(file) !== hash) fail('evidence');
      q.writeOnce(output, report);
    } catch { persistence = true; }
    if (!uncertain && !persistence) {
      try { const held = q.strictJson(readPublic(q, lock)); if (held.scope !== SCOPE || held.approval !== digest) fail('lock'); fs.unlinkSync(lock); }
      catch { persistence = true; }
    }
  }
  report.persistenceFailure = persistence;
  if (persistence || uncertain) report.result = 'stopped';
  return report;
}
/** Expose preparation separately; execution demands both the reviewed digest and distinct owner phrase. */
async function main(args) {
  if (globalThis.__gate1Envelope) return inside(globalThis.__gate1Envelope);
  if (args.length === 1 && args[0] === '--prepare') {
    const prepared = await prepare(), q = qualification();
    q.writeOnce(path.join(__dirname, 'execution-contract.json'), prepared.contract);
    q.writeOnce(path.join(__dirname, 'preparation-result.json'), { digest: prepared.digest, helperSha256: prepared.contract.helperSha256,
      preservedEvidenceFiles: Object.keys(prepared.contract.preservedEvidence).length, sourceFilesVerified: 344,
      containersStarted: 0, builds: 0, downloads: 0, retainedOutputReads: 0, approved: false });
    return { result: 'prepared', digest: prepared.digest, approved: false };
  }
  if (args.length === 3 && args[0] === '--execute') return execute(args[1], args[2]);
  fail('arguments');
}

if (require.main === module || globalThis.__gate1Envelope) {
  main(process.argv.slice(2)).then(report => {
    const bytes = JSON.stringify(report); if (Buffer.byteLength(bytes) > LIMITS.reportBytes) fail('report');
    process.stdout.write(bytes + '\n');
    if (report.result === 'stopped' || report.persistenceFailure) process.exitCode = 1;
  }).catch(() => { process.stderr.write('Reproduction stopped; preserve evidence and approvals.\n'); process.exitCode = 1; });
}

module.exports = { sha, keys, catalog, cleanLines, location, secretVariants, candidate, extract, validDiagnostic, observations, validObservations, capture,
  linuxEnvironment, validateReport, containerArgs, readiness, cleanup, verifyContainer, execute, prepare, main, qualification,
  SOURCE, IMAGE, DAEMON, VOLUME, NAME, KEY, PHRASE, PRIOR, LIMITS, COMMANDS, SCOPE };
