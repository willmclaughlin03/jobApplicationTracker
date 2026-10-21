'use strict';

/** Step 1 scaffold: preserve the consumed reader and prepare a distinct, non-executable lexical proposal. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
/** Hash public code and sanitized receipts; individual artifact hashes are never produced here. */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
const previousFile = path.join(ROOT, '.tmp/gate1-source-map-v2-d85af7e3/diagnose.js');
const PREVIOUS_SHA = '67a2a584ffa128b972cfee7466148725dc6aa6ca066f76c369905529f9a91a19';
if (hash(fs.readFileSync(previousFile)) !== PREVIOUS_SHA) throw Error('provenance');
const previous = require(previousFile), { q, d, prior, copy } = previous;
const SCANNER = previous.SCANNER, SCANNER_SHA = previous.SCANNER_SHA;
const SCOPE = 'gate1_source_map_lexical_v1';
const KEY = `${prior.lib.fixed.sourceSha}.source-map-lexical-v1`;
const CONTAINER = 'gate1-source-map-lexical-d85af7e3-v1';
const CONFIRMATION = 'CLASSIFY REJECTED SOURCE MAP MARKER ONCE';
const OLD_APPROVAL = '65adfb84162427fa018af6c885a5fe9c4bd8d667a1708fdae63cf8972b3323b1';
const REVIEW_INDEX_SHA = 'bef647f7bc774c5be1c23eda7331bf77d734c7229c44f6576c7afc6f493f9c5b';
const EXECUTION_INDEX_SHA = '161c2a0d3ae141c046e20a9c65a3faec0569ec7ea199bbc407f4e123268f00d6';
const MANIFEST = previous.MANIFEST, LIMITS = previous.LIMITS, EXPECTED = previous.EXPECTED;
const PRIOR_MAP_COUNTS = previous.PRIOR_MAP_COUNTS;
const BLOCKERS = Object.freeze(['lexical_classifier_not_implemented', 'parser_provenance_not_bound',
  'lexical_validation_pending', 'execution_review_incomplete']);

/** Reverify the frozen v2 indexes and diagnosed baseline; only public code and sanitized receipts are read. */
function verifyEvidence() {
  if (q.fileHash(previousFile) !== PREVIOUS_SHA) throw Error('provenance');
  const base = path.dirname(previousFile);
  for (const [name, digest, count] of [['review-index.json', REVIEW_INDEX_SHA, 12],
    ['execution-evidence-index.json', EXECUTION_INDEX_SHA, 6]]) {
    const file = path.join(base, name);
    if (q.fileHash(file) !== digest) throw Error('provenance');
    const index = prior.lib.parse(q.publicFile(file));
    if (index.files?.length !== count || index.approval !== OLD_APPROVAL) throw Error('provenance');
    for (const item of index.files) {
      if (!path.resolve(item.file).startsWith(ROOT + path.sep) || q.fileHash(item.file) !== item.sha256) throw Error('provenance');
    }
  }
  const p = previous.prepare(), terminal = prior.lib.parse(q.publicFile(path.join(base, 'execution-terminal.json')));
  if (p.approval !== OLD_APPROVAL || terminal.approval !== OLD_APPROVAL || terminal.scope !== previous.SCOPE ||
      terminal.result !== 'diagnosed' || terminal.failureStep !== null || terminal.exitCode !== 0 || terminal.oomKilled !== false ||
      terminal.lockReleased !== true || terminal.persistenceFailure !== false || terminal.teardownUnconfirmed !== false ||
      terminal.volumesRetained !== true) throw Error('provenance');
  const diagnostic = previous.validateReport(Buffer.from(JSON.stringify(terminal.diagnostic)), p), o = diagnostic.observation;
  if (diagnostic.result !== 'diagnosed' || o.guard !== 'target_not_map_suffix' || o.target !== 'absent' ||
      o.form !== 'source_mapping_reference' || o.mapSuffix !== false || o.context.physical !== true ||
      o.context.alias || o.context.projected || o.context.independent) throw Error('provenance');
  for (const [key, count] of Object.entries(PRIOR_MAP_COUNTS)) if (diagnostic.counters[key] !== count) throw Error('provenance');
  return { ...p.contract.preservation, lexicalBaselineReviewRecords: 12, lexicalBaselineExecutionRecords: 6 };
}

/** Reuse the bounded Linux reader unchanged; this factory performs no reads until its reader is called. */
const diagnosticLibrary = previous.diagnosticLibrary;

/** Keep the reviewed mount/resources but reserve a distinct container name; construction has no Docker effects. */
function containerArgs() {
  const args = previous.containerArgs();
  if (args[0] !== 'create' || args[1] !== '--name' || args[2] !== previous.CONTAINER) throw Error('provenance');
  args[2] = CONTAINER; return args;
}

/** Bind the scaffold and evidence as a draft only; no digest here can authorize retained-content execution. */
function prepare() {
  const preservation = verifyEvidence();
  if (q.fileHash(SCANNER) !== SCANNER_SHA) throw Error('scanner');
  const contract = { schemaVersion: 1, scope: SCOPE, stage: 'step1_scaffold', executionReady: false,
    sourceSha: prior.lib.fixed.sourceSha, scannerSourceCommit: 'b76b531e56f346bca88562d5d2b68e477a20eaca',
    scannerSourceBranch: 'staging', scannerSha256: SCANNER_SHA, originalBuildBinding: prior.lib.fixed.binding,
    context: q.CONTEXT, daemonId: prior.lib.fixed.daemonId, imageId: prior.lib.fixed.imageId,
    volume: copy.VOLUME, outputRoot: copy.OUTPUT, manifestSha256: MANIFEST,
    helperSha256: q.fileHash(__filename), testsSha256: q.fileHash(path.join(__dirname, '__tests__/diagnose.test.js')),
    previousSha256: PREVIOUS_SHA, consumedBaselineApproval: OLD_APPROVAL,
    baselineReviewIndexSha256: REVIEW_INDEX_SHA, baselineExecutionIndexSha256: EXECUTION_INDEX_SHA, preservation,
    expected: EXPECTED, priorSourceMapCounts: PRIOR_MAP_COUNTS,
    expectedObservation: { guard: 'target_not_map_suffix', target: 'absent', form: 'source_mapping_reference', mapSuffix: false,
      context: { physical: true, alias: false, projected: false, independent: false } },
    container: CONTAINER, containerArgs: containerArgs(), reservationKey: KEY, proposedConfirmation: CONFIRMATION,
    inheritedReaderLimits: LIMITS,
    parser: { proposedPackage: 'acorn', proposedVersion: '8.15.0', integrityVerified: false, sourceSha256: null, loaded: false },
    implementation: { evidenceVerification: true, boundedReaderReused: true, lifecycleAdapted: true,
      lexicalClassifier: false, executableBootstrap: false, lexicalReportValidator: false },
    policy: { implementationOnly: true, executionDisabled: true, preserveConsumedEvidence: true,
      preserveBothVolumes: true, privateComparisonReads: 0, artifactCodeExecuted: false,
      retainedContentReads: 0, dockerCallsDuringPreparation: 0, downloads: 0, builds: 0, newCopies: 0, fullPrivacyScans: 0 },
    blockers: BLOCKERS, artifactPrivacy: 'unqualified', gate1Status: 'open' };
  return { schemaVersion: 1, stage: 'step1_scaffold', authorized: false, executionReady: false, approval: null,
    draftSha256: hash(JSON.stringify(contract)), contract, retainedContentReads: 0 };
}

/** Keep every execution entry point closed until the separately scoped classifier and review are implemented. */
function assertExecutionReady() { throw Error('implementation_incomplete'); }

/** Do not serialize the old category reader as though it could classify lexical context. */
function containerInput() { assertExecutionReady(); }

/** Reject all claimed lexical results while no lexical schema or classifier exists. */
function validateReport() { assertExecutionReady(); }

/** Later metadata readiness may reuse the frozen checks, but step 1 never calls Docker. */
async function readiness() { assertExecutionReady(); }

/** Reuse exact read-only mount and exclusive-volume checks without altering the consumed implementation. */
const verifyMounts = previous.verifyMounts;

/** Release only this attempt's unchanged ordinary lock after confirmed teardown and durable persistence. */
function releaseLock(lock, expected) {
  const current = fs.lstatSync(lock);
  if (current.isSymbolicLink() || !prior.lib.same(expected, current)) throw Error('lock'); fs.unlinkSync(lock);
}

/** Adapt the established one-attempt lifecycle; the unconditional scaffold gate precedes every side effect. */
async function execute(envelope, dependencies = {}) {
  assertExecutionReady();
  if (!prior.lib.keys(envelope, ['approval', 'confirmation']) || envelope.confirmation !== CONFIRMATION) throw Error('approval');
  const prepared = (dependencies.prepare || prepare)(); if (prepared.approval !== envelope.approval) throw Error('approval');
  const registry = dependencies.registry || prior.REGISTRY, save = dependencies.persist || copy.persist;
  const docker = dependencies.docker || ((a, o) => q.supervise('docker', a, o));
  const run = d.budgetRunner(docker, LIMITS.operationMs, dependencies.now), lock = path.join(registry, 'active.lock');
  /** Address only this lexical version's immutable reservation and terminal registry report. */
  const receipt = name => path.join(registry, `${KEY}.${name}.json`);
  q.safePath(registry); if (['reservation', 'report'].some(n => fs.existsSync(receipt(n)))) throw Error('reservation');
  save(lock, { scope: SCOPE, approval: prepared.approval }); const lockStat = fs.lstatSync(lock);
  const result = { schemaVersion: 1, scope: SCOPE, approval: prepared.approval, result: 'stopped', failureStep: null,
    diagnostic: null, exitCode: null, oomKilled: null, teardownUnconfirmed: false, persistenceFailure: false,
    lockReleased: false, volumesRetained: true, artifactPrivacy: 'unqualified', gate1Status: 'open' };
  let step = 'reservation', id, uncertain = false, reserved = false;
  try {
    save(receipt('reservation'), { scope: SCOPE, approval: prepared.approval, consumed: true }); reserved = true;
    step = 'readiness'; await (dependencies.readiness || readiness)(run, false);
    step = 'create'; uncertain = true;
    const created = (await run(containerArgs(), { outputBytes: 128 })).toString().trim();
    if (!/^[a-f0-9]{64}$/.test(created)) throw Error('container'); id = created; uncertain = false;
    step = 'mounts'; await verifyMounts(run, id);
    step = 'process';
    /** Validate stdout before retaining it, including reports accompanying a nonzero child exit. */
    const validate = bytes => validateReport(bytes, prepared);
    try { result.diagnostic = validate(await run(['start', '-ai', id], { input: containerInput(prepared), outputBytes: LIMITS.reportBytes,
      stderrBytes: LIMITS.stderrBytes, parseFailureReport: validate })); }
    catch (error) { if (error.report) result.diagnostic = validate(Buffer.from(JSON.stringify(error.report))); throw Error('process'); }
    if (result.diagnostic.result !== 'diagnosed') throw Error('diagnostic');
    step = 'teardown'; const state = await d.teardown(run, id); id = undefined;
    result.exitCode = state.exitCode; result.oomKilled = state.oomKilled; if (!state.clean) throw Error('exit');
    result.result = 'diagnosed';
  } catch { result.failureStep = step; if (!reserved) result.persistenceFailure = true; }
  finally {
    if (id) {
      try { const state = await d.teardown(d.budgetRunner(docker, LIMITS.cleanupMs, dependencies.now), id);
        result.exitCode = state.exitCode; result.oomKilled = state.oomKilled; id = undefined;
      } catch { uncertain = true; }
    }
    result.teardownUnconfirmed = uncertain;
    if (uncertain) { result.result = 'stopped'; result.failureStep = 'cleanup'; }
    try { save(receipt('report'), result); } catch { result.persistenceFailure = true; result.result = 'stopped'; }
    if (!result.persistenceFailure && !uncertain) {
      try { releaseLock(lock, lockStat); result.lockReleased = true; }
      catch { result.persistenceFailure = true; result.result = 'stopped'; }
    }
  }
  return result;
}

/** Expose public draft preparation only; readiness and execution stop before Docker or registry access. */
async function main(args) {
  if (args.length === 1 && args[0] === '--prepare') return prepare();
  if (args.length === 1 && args[0] === '--readiness') return readiness();
  if (args.length === 3 && args[0] === '--execute') return execute({ approval: args[1], confirmation: args[2] });
  throw Error('input');
}
if (require.main === module) main(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
}).catch(() => { process.stderr.write('Lexical reader scaffold is not executable; no attempt started.\n'); process.exitCode = 1; });
module.exports = { ROOT, SCANNER, SCANNER_SHA, SCOPE, KEY, CONTAINER, CONFIRMATION, OLD_APPROVAL, MANIFEST, LIMITS, EXPECTED,
  PRIOR_MAP_COUNTS, BLOCKERS, previous, copy, q, d, prior, hash, diagnosticLibrary, validateReport, verifyEvidence,
  containerArgs, prepare, containerInput, readiness, verifyMounts, execute, main };
