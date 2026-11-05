'use strict';
/* global Buffer, setTimeout, clearTimeout */

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const c = require('./authentication-preparation-scoped-contract.cjs');
const p = require('./authentication-preparation-postflight.cjs');
const d = require('./hosted-csrf-diagnostic.cjs');
const fixture = require('./request-client-isolation.cjs');
const DIRECTORY = path.join(path.dirname(d.DIRECTORY), 'gate1-authentication-preparation-scoped-01');
const ATTEMPT = path.join(DIRECTORY, 'attempt.json');
const RESULT = path.join(DIRECTORY, 'scoped-preparation.json');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const completionSchema = z.object({ exitCode: z.literal(0), phase: z.literal('passed'),
  receiptFinalized: z.literal(true), attemptHash: hashSchema, sourceSet: hashSchema, planHash: hashSchema }).strict();

/** Verify only directory metadata/readability and realpath, never inspect authentication storage. */
async function profilePreserved(profile = d.PROFILE, io = fs) {
  c.check(profile === d.PROFILE, 'profile');
  return inspectProfileDirectory(profile, io);
}

/** Share metadata-only inspection after the caller has validated its separate live or synthetic path. */
async function inspectProfileDirectory(profile, io = fs) {
  try {
    const stat = await io.lstat(profile);
    c.check(stat.isDirectory() && !stat.isSymbolicLink()
      && path.resolve(await io.realpath(profile)) === path.resolve(profile), 'profile');
    await io.access(profile, constants.R_OK); return true;
  } catch { throw new c.PreparationError('profile'); }
}

/** Independently inventory all Chrome processes, refusing incomplete path/command-line visibility. */
async function inspectAbsence(readInventory = p.inventory) {
  return inspectProfileAbsence(d.PROFILE, readInventory);
}

/** Inspect the pinned executable or exact approved profile; no supplied shell text or storage is read. */
async function inspectProfileAbsence(profilePath, readInventory = p.inventory) {
  const n = require('./authentication-preparation-scoped-native-contract.cjs');
  c.check(profilePath === d.PROFILE || n.PROFILES.includes(profilePath), 'profile');
  const executable = fixture.fixtureExecutable('cft158').replaceAll('/', '\\').replaceAll("'", "''");
  const profile = profilePath.replaceAll('/', '\\').replaceAll("'", "''");
  const script = "$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process); "
    + "$p=@($all | Where-Object { $_.Name -eq 'chrome.exe' }); "
    + "$u=@($p | Where-Object { -not $_.ExecutablePath -or -not $_.CommandLine }); "
    + `$m=@($p | Where-Object { $_.ExecutablePath -eq '${executable}' -or ($_.CommandLine -and $_.CommandLine.Contains('${profile}')) }); `
    + '@{complete=$true;matches=$m.Count;uninspectable=$u.Count} | ConvertTo-Json -Compress';
  let result;
  try { result = await readInventory(script); } catch { throw new c.PreparationError('process_inspection'); }
  c.check(result?.complete === true && Number.isSafeInteger(result.matches)
    && result.matches >= 0 && result.uninspectable === 0, 'process_inspection');
  c.check(result.matches === 0, 'process_present'); return true;
}

/** Require normal child exit plus an independent inventory, listener refusal and preserved profile. */
async function inspectClosure(owner, deps = {}) {
  c.check(c.ownerSchema.safeParse(owner).success, 'closure');
  await (deps.absence || inspectAbsence)();
  await (deps.portClosed || p.portClosed)(owner.port);
  await (deps.profile || profilePreserved)(owner.profile); return true;
}

/** Read only fixed aggregate evidence, requiring bounded regular files and an unredirected parent. */
async function readAttempt(io = fs) {
  try {
    c.check(path.resolve(await io.realpath(DIRECTORY)) === path.resolve(DIRECTORY), 'receipt');
    const stat = await io.lstat(ATTEMPT);
    c.check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= c.LIMITS.receiptBytes, 'receipt');
    const bytes = await io.readFile(ATTEMPT); c.check(bytes.length <= c.LIMITS.receiptBytes, 'receipt');
    return { record: JSON.parse(bytes.toString('utf8')), hash: d.digest(bytes) };
  } catch { throw new c.PreparationError('receipt'); }
}

/** Only successful, finalized supervisor-observed worker exit can corroborate an on-disk attempt. */
function reviewAttempt(record, completion, plan, now = Date.now()) {
  c.check(completionSchema.safeParse(completion).success, 'worker_completion');
  c.validateReceipt(record);
  for (const key of ['sourceSet', 'decisionHash', 'toolSet', 'qualificationHash', 'buildHash', 'buildId', 'profile']) {
    c.check(record[key] === plan[key], 'integrity');
  }
  c.check(completion.sourceSet === record.sourceSet && completion.planHash === record.planHash, 'integrity');
  c.check(record.startedAt >= plan.approvedAt && record.completedAt <= now
    && now < plan.expiresAt && now - record.startedAt < c.LIMITS.wholeMs, 'expired');
  return true;
}

/** Exclusive writes preserve partial artifacts on failure; fsync and close must both succeed. */
async function writeExclusive(file, record, io = fs) {
  c.check([ATTEMPT, RESULT].includes(file), 'receipt');
  if (file === RESULT) c.validateReceipt(record); else c.validateAttempt(record);
  return writeBytesExclusive(file, record, DIRECTORY, io);
}

/** Fsync and close exclusive evidence writes; failed or partial files stay preserved for review. */
async function writeBytesExclusive(file, record, directory, io) {
  const bytes = Buffer.from(JSON.stringify(record) + '\n'); c.check(bytes.length <= c.LIMITS.receiptBytes, 'receipt');
  c.check(path.resolve(await io.realpath(directory)) === path.resolve(directory), 'receipt');
  let handle; let failed = false;
  try {
    handle = await io.open(file, 'wx'); await handle.writeFile(bytes); await handle.sync();
  } catch { failed = true; }
  finally { if (handle) { try { await handle.close(); } catch { failed = true; } } }
  c.check(!failed, 'receipt');
  return d.digest(bytes);
}

/** Validate synthetic profile metadata through a separate exact eight-profile policy. */
async function nativeProfile(profile, io = fs) {
  const n = require('./authentication-preparation-scoped-native-contract.cjs');
  c.check(n.PROFILES.includes(profile), 'profile'); return inspectProfileDirectory(profile, io);
}

/** Independently corroborate a native launch using normal exit, process inventory and its CDP listener. */
async function inspectNativeClosure(owner, deps = {}) {
  const n = require('./authentication-preparation-scoped-native-contract.cjs');
  c.check(n.ownerSchema.safeParse(owner).success, 'closure');
  await (deps.absence || inspectProfileAbsence)(owner.profile);
  await (deps.portClosed || p.portClosed)(owner.port);
  await (deps.profile || nativeProfile)(owner.profile); return true;
}

/** Read bounded aggregate native files only, rejecting redirected parents and symbolic links. */
async function readNative(name, io = fs) {
  const n = require('./authentication-preparation-scoped-native-contract.cjs');
  c.check(n.ARTIFACTS.includes(name) && name !== 'worker-started', 'receipt');
  try {
    c.check(path.resolve(await io.realpath(n.DIRECTORY)) === path.resolve(n.DIRECTORY), 'receipt');
    const file = path.join(n.DIRECTORY, name); const stat = await io.lstat(file);
    c.check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= n.LIMITS.receiptBytes, 'receipt');
    const bytes = await io.readFile(file); c.check(bytes.length <= n.LIMITS.receiptBytes, 'receipt');
    return { record: JSON.parse(bytes.toString('utf8')), hash: d.digest(bytes) };
  } catch { throw new c.PreparationError('receipt'); }
}

/** Keep native outputs distinct from live receipts and approval inputs; never create an approval. */
async function writeNative(name, record, io = fs) {
  const n = require('./authentication-preparation-scoped-native-contract.cjs');
  c.check(['attempt.json', 'native-completion.json', 'native-qualification.json'].includes(name), 'receipt');
  if (name === 'attempt.json') n.validateAttempt(record);
  else if (name === 'native-completion.json') c.check(require('./authentication-preparation-scoped.cjs').QUALIFICATION_COMPLETION.safeParse(record).success, 'worker_completion');
  else c.check(c.qualificationSchema.safeParse(record).success, 'coverage_unqualified');
  return writeBytesExclusive(path.join(n.DIRECTORY, name), record, n.DIRECTORY, io);
}

/** Share a latched absolute deadline for pre-write stages; late callbacks cannot authorize later work. */
function deadlineStages(deadline, clock = Date.now) {
  let expired = false;
  /** Latch expiry even when an operation settles before its timer callback is delivered. */
  function checkDeadline() { if (clock() >= deadline) expired = true; c.check(!expired, 'expired'); }
  /** Bound one read-only pre-write operation; exclusive writes must be awaited separately. */
  return async function stage(operation) {
    checkDeadline(); let timer;
    try {
      const value = await Promise.race([Promise.resolve().then(() => {
        checkDeadline(); return operation();
      }), new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new c.PreparationError('expired')); }, Math.max(1, deadline - clock()));
      })]);
      checkDeadline(); return value;
    } finally { clearTimeout(timer); }
  };
}

/** Recheck source/decision/plan/tool binding, OS closure and profile after worker exit before finalization. */
async function finalize(completion, plan, verifyBindings, deps = {}) {
  const clock = deps.clock || Date.now;
  const deadline = Math.min(plan.expiresAt, deps.deadline ?? plan.expiresAt);
  let timedOut = false;
  /** Bound a pre-write operation by the shared deadline, latch timeout and release its timer on every settlement. */
  async function beforeWrite(operation) {
    c.check(!timedOut && clock() < deadline, 'expired');
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          c.check(!timedOut && clock() < deadline, 'expired'); return operation();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => { timedOut = true; reject(new c.PreparationError('expired')); },
            Math.max(1, deadline - clock()));
        }),
      ]);
      c.check(!timedOut && clock() < deadline, 'expired'); return result;
    } finally { clearTimeout(timer); }
  }
  const { record, hash } = await beforeWrite(() => (deps.read || readAttempt)());
  c.check(hash === completion?.attemptHash, 'integrity'); reviewAttempt(record, completion, plan, clock());
  await beforeWrite(() => verifyBindings(plan, record.planHash));
  for (const owner of record.owners) await beforeWrite(() => (deps.inspect || inspectClosure)(owner));
  for (const port of record.listenerPorts) await beforeWrite(() => (deps.portClosed || p.portClosed)(port));
  await beforeWrite(() => verifyBindings(plan, record.planHash));
  reviewAttempt(record, completion, plan, clock());
  c.check(!timedOut && clock() < deadline, 'expired');
  const finalHash = await (deps.write || writeExclusive)(RESULT, record);
  // Only a completed write is ours to remove; failed writes retain their partial artifacts.
  try {
    c.check(clock() < deadline && clock() - record.startedAt < c.LIMITS.wholeMs, 'expired');
  } catch (error) {
    try { await (deps.unlink || fs.unlink)(RESULT); } catch { throw new c.PreparationError('receipt'); }
    throw error;
  }
  return { phase: 'passed', receiptFinalized: true, receiptHash: finalHash,
    browserTrafficMeasured: false, hostedQualified: false, gate1Status: 'open' };
}

module.exports = { DIRECTORY, ATTEMPT, RESULT, completionSchema, profilePreserved, inspectAbsence,
  inspectClosure, readAttempt, reviewAttempt, writeExclusive, finalize, inspectProfileAbsence,
  nativeProfile, inspectNativeClosure, readNative, writeNative, deadlineStages };
