'use strict';
/* global Buffer */

/** Independent, read-only closure inspection plus exclusive OFFLINE receipt finalization. */
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { check, PreparationError } = require('./authentication-preparation-traffic.cjs');
const fixture = require('./request-client-isolation.cjs');
const d = require('./hosted-csrf-diagnostic.cjs');
const ROOT = 'C:/Users/willm/job-application-tracker';
const DIRECTORY = path.join(ROOT, '.tmp/gate1-authentication-preparation-offline-01');
const PROFILE = path.join(DIRECTORY, 'synthetic-profile');
const ATTEMPT = path.join(DIRECTORY, 'attempt.json');
const RESULT = path.join(DIRECTORY, 'postflight.json');
const CHECKS = Object.freeze(['observationBeforeNavigation', 'redirectReserved', 'destinationBlocked',
  'syntheticIdentityBeforeRestart', 'syntheticIdentityAfterRestart', 'normalClosure',
  'profilePreserved', 'localListenersClosed']);

/** Execute only a fixed process inventory command; native output is parsed privately and never echoed. */
function inventory(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 5000, maxBuffer: 2048 }, (error, stdout) => {
        if (error) { reject(new PreparationError('process_inspection')); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new PreparationError('process_inspection')); }
      });
  });
}

/** A closed CDP/listener port must explicitly refuse connection; timeouts and other errors are inconclusive. */
function portClosed(port) {
  check(Number.isInteger(port) && port > 0 && port <= 65535, 'schema');
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); reject(new PreparationError('port_open')); });
    socket.once('timeout', () => { socket.destroy(); reject(new PreparationError('closure')); });
    socket.once('error', error => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(new PreparationError('closure'));
    });
  });
}

/**
 * Inspect matching executable/profile processes in a separate PowerShell process.
 * Missing command-line/path visibility is inconclusive. PID reuse is never absence proof.
 */
async function inspectBrowserAbsence(readInventory = inventory) {
  const executable = fixture.fixtureExecutable('cft158').replaceAll('/', '\\').replaceAll("'", "''");
  const profile = PROFILE.replaceAll('/', '\\').replaceAll("'", "''");
  const script = "$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process); "
    + "$p=@($all | Where-Object { $_.Name -eq 'chrome.exe' }); "
    + "$u=@($p | Where-Object { -not $_.ExecutablePath -or -not $_.CommandLine }); "
    + `$m=@($p | Where-Object { $_.ExecutablePath -eq '${executable}' -or ($_.CommandLine -and $_.CommandLine.Contains('${profile}')) }); `
    + '@{complete=$true;matches=$m.Count;uninspectable=$u.Count} | ConvertTo-Json -Compress';
  let result;
  try { result = await readInventory(script); } catch { throw new PreparationError('process_inspection'); }
  check(result?.complete === true && Number.isSafeInteger(result.matches) && result.matches >= 0
    && result.uninspectable === 0, 'process_inspection');
  check(result.matches === 0, 'process_present');
  return true;
}

/** Combine an independent executable/profile inventory with the specific owned CDP port check. */
async function inspectProcessClosure(owner, readInventory = inventory, inspectPort = portClosed) {
  check(Number.isSafeInteger(owner?.pid) && owner.pid > 0 && owner.profile === PROFILE, 'schema');
  await inspectBrowserAbsence(readInventory);
  await inspectPort(owner.port);
  return true;
}

/** Reject truncated/oversized evidence before JSON parsing; never open profile storage. */
async function readAttempt(file = ATTEMPT) {
  check(file === ATTEMPT, 'receipt');
  const stat = await fs.lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 16384, 'receipt');
  const bytes = await fs.readFile(file); check(bytes.length <= 16384, 'receipt');
  try { return { record: JSON.parse(bytes.toString('utf8')), hash: d.digest(bytes) }; }
  catch { throw new PreparationError('receipt'); }
}

/** Strictly validate aggregate offline evidence; arbitrary extra private fields are rejected, not copied. */
function reviewAttempt(record, completion, now = Date.now()) {
  const keys = ['schemaVersion', 'scope', 'phase', 'startedAt', 'completedAt', 'sourceSet', 'checks', 'owners',
    'listenerPorts', 'pageTraffic', 'requests', 'proxy', 'firstFailure', 'browserTrafficMeasured', 'hostedQualified'];
  check(record && Object.keys(record).sort().join() === keys.sort().join(), 'receipt');
  check(completion?.exitCode === 0 && completion.receiptFinalized === true
    && completion.phase === 'passed' && /^[a-f0-9]{64}$/.test(completion.attemptHash), 'worker_completion');
  check(record.schemaVersion === 1 && record.scope === 'synthetic_loopback_only' && record.phase === 'passed'
    && record.firstFailure === null && record.browserTrafficMeasured === false && record.hostedQualified === false, 'receipt');
  check(Number.isSafeInteger(record.startedAt) && Number.isSafeInteger(record.completedAt)
    && record.completedAt >= record.startedAt && now >= record.completedAt && now - record.startedAt < 180000, 'expired');
  check(/^[a-f0-9]{64}$/.test(record.sourceSet) && record.sourceSet === completion.sourceSet, 'integrity');
  check(record.checks && Object.keys(record.checks).sort().join() === [...CHECKS].sort().join()
    && CHECKS.every(key => record.checks[key] === true), 'receipt');
  check(Array.isArray(record.owners) && record.owners.length === 2, 'closure');
  for (const owner of record.owners) {
    check(Object.keys(owner).sort().join() === 'closedNormally,exitCode,pid,port,profile'
      && owner.profile === PROFILE && owner.exitCode === 0 && owner.closedNormally === true
      && Number.isSafeInteger(owner.pid) && owner.pid > 0
      && Number.isInteger(owner.port) && owner.port > 0 && owner.port <= 65535, 'closure');
  }
  check(Array.isArray(record.listenerPorts) && record.listenerPorts.length === 2
    && record.listenerPorts.every(port => Number.isInteger(port) && port > 0 && port <= 65535), 'receipt');
  check(Array.isArray(record.pageTraffic) && record.pageTraffic.length === 2, 'observation');
  for (const item of record.pageTraffic) check(Object.keys(item).sort().join()
    === 'allowed,blocked,browserTrafficMeasured,coverage,pairedPageEvents'
    && item.pairedPageEvents === true && item.browserTrafficMeasured === false && item.coverage === 'page_http_only'
    && Number.isSafeInteger(item.allowed) && item.allowed >= 0 && item.allowed <= 12
    && Number.isSafeInteger(item.blocked) && item.blocked >= 0 && item.blocked <= 1, 'observation');
  check(record.pageTraffic[0].allowed >= 3 && record.pageTraffic[0].blocked === 0
    && record.pageTraffic[1].allowed === 0 && record.pageTraffic[1].blocked === 1, 'observation');
  check(Object.keys(record.requests || {}).sort().join() === 'actual,conservative', 'receipt');
  for (const kind of ['actual', 'conservative']) {
    const counts = record.requests[kind];
    check(Object.keys(counts || {}).sort().join() === 'application,session,static'
      && Number.isSafeInteger(counts.application) && counts.application >= 4 && counts.application <= 12
      && counts.session === 2 && counts.static === 0, 'receipt');
  }
  check(JSON.stringify(record.requests.actual) === JSON.stringify(record.requests.conservative), 'receipt');
  check(Object.keys(record.proxy || {}).sort().join() === 'connections,denied,forwarded,readyBeforeForwarding'
    && record.proxy.readyBeforeForwarding === true && Number.isSafeInteger(record.proxy.denied) && record.proxy.denied >= 0
    && Number.isSafeInteger(record.proxy.connections) && record.proxy.connections <= 128 && record.proxy.connections >= 1
    && record.proxy.forwarded === record.pageTraffic[0].allowed
    && record.requests.actual.application === record.proxy.forwarded + 1, 'observation');
  return true;
}

/** Write immutable evidence exclusively; a partial write is retained and can never count as completion. */
async function writeExclusive(file, record) {
  check([ATTEMPT, RESULT].includes(file), 'receipt');
  const bytes = Buffer.from(JSON.stringify(record) + '\n'); check(bytes.length <= 16384, 'receipt');
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return d.digest(bytes);
}

/**
 * Called by the supervising process only after the worker exits successfully. Repeat actual
 * OS/socket checks and source verification before producing a scoped, explicitly non-hosted receipt.
 */
async function finalizeOffline(completion, verifySources, deps = {}) {
  const read = deps.read || readAttempt; const inspect = deps.inspect || inspectProcessClosure;
  const closed = deps.portClosed || portClosed; const write = deps.write || writeExclusive;
  const { record, hash } = await read(); check(hash === completion.attemptHash, 'integrity');
  reviewAttempt(record, completion);
  check(await verifySources() === record.sourceSet, 'integrity');
  for (const owner of record.owners) await inspect(owner);
  for (const port of record.listenerPorts) await closed(port);
  check(Date.now() - record.startedAt < 180000, 'expired');
  const final = { schemaVersion: 1, scope: 'synthetic_loopback_only', phase: 'passed', attemptHash: hash,
    sourceSet: record.sourceSet, checks: record.checks, completedAt: Date.now(),
    closedNormally: true, independentProcessExitVerified: true, browserTrafficMeasured: false,
    identityVerified: false, hostedQualified: false, gate1Status: 'open',
    limitation: 'page_http_only_browser_background_unqualified' };
  await write(RESULT, final);
  return final;
}

/** There is no live receipt writer while coverage is unresolved, regardless of asserted booleans. */
function finalizeAuthentication() { throw new PreparationError('coverage_unqualified'); }

module.exports = { DIRECTORY, PROFILE, ATTEMPT, RESULT, CHECKS, inventory, portClosed,
  inspectBrowserAbsence, inspectProcessClosure, readAttempt, reviewAttempt, writeExclusive, finalizeOffline, finalizeAuthentication };
