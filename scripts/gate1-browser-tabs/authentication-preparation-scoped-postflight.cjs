'use strict';
/* global Buffer */

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
  try {
    const stat = await io.lstat(profile);
    c.check(stat.isDirectory() && !stat.isSymbolicLink()
      && path.resolve(await io.realpath(profile)) === path.resolve(profile), 'profile');
    await io.access(profile, constants.R_OK); return true;
  } catch { throw new c.PreparationError('profile'); }
}

/** Independently inventory all Chrome processes, refusing incomplete path/command-line visibility. */
async function inspectAbsence(readInventory = p.inventory) {
  const executable = fixture.fixtureExecutable('cft158').replaceAll('/', '\\').replaceAll("'", "''");
  const profile = d.PROFILE.replaceAll('/', '\\').replaceAll("'", "''");
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
  const bytes = Buffer.from(JSON.stringify(record) + '\n'); c.check(bytes.length <= c.LIMITS.receiptBytes, 'receipt');
  c.check(path.resolve(await io.realpath(DIRECTORY)) === path.resolve(DIRECTORY), 'receipt');
  let handle; let failed = false;
  try {
    handle = await io.open(file, 'wx'); await handle.writeFile(bytes); await handle.sync();
  } catch { failed = true; }
  finally { if (handle) { try { await handle.close(); } catch { failed = true; } } }
  c.check(!failed, 'receipt');
  return d.digest(bytes);
}

/** Recheck source/decision/plan/tool binding, OS closure and profile after worker exit before finalization. */
async function finalize(completion, plan, verifyBindings, deps = {}) {
  const clock = deps.clock || Date.now;
  const { record, hash } = await (deps.read || readAttempt)();
  c.check(hash === completion?.attemptHash, 'integrity'); reviewAttempt(record, completion, plan, clock());
  await verifyBindings(plan, record.planHash);
  for (const owner of record.owners) await (deps.inspect || inspectClosure)(owner);
  for (const port of record.listenerPorts) await (deps.portClosed || p.portClosed)(port);
  await verifyBindings(plan, record.planHash);
  reviewAttempt(record, completion, plan, clock());
  const finalHash = await (deps.write || writeExclusive)(RESULT, record);
  // Only a completed write is ours to remove; failed writes retain their partial artifacts.
  try {
    c.check(clock() < plan.expiresAt && clock() - record.startedAt < c.LIMITS.wholeMs, 'expired');
  } catch (error) {
    try { await (deps.unlink || fs.unlink)(RESULT); } catch { throw new c.PreparationError('receipt'); }
    throw error;
  }
  return { phase: 'passed', receiptFinalized: true, receiptHash: finalHash,
    browserTrafficMeasured: false, hostedQualified: false, gate1Status: 'open' };
}

module.exports = { DIRECTORY, ATTEMPT, RESULT, completionSchema, profilePreserved, inspectAbsence,
  inspectClosure, readAttempt, reviewAttempt, writeExclusive, finalize };
