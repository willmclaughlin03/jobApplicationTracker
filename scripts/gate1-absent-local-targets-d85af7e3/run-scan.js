'use strict';

/** One reviewed scan of the existing independent copy. Import/preparation never read retained content. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
/** Hash public implementation and immutable receipts, never private comparison values. */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
const previousFile = path.join(ROOT, '.tmp/gate1-absent-source-maps-d85af7e3/run-scan.js');
if (hash(fs.readFileSync(previousFile)) !== '9be4054d2554a03e4040d484ac3f658039b28177a854038b044bef3fe86b61cd') throw Error('provenance');
const previous = require(previousFile), { q, d, prior, copy } = previous;
const diagnosticFile = path.join(ROOT, '.tmp/gate1-source-map-lexical-d85af7e3/diagnose.js');
if (hash(fs.readFileSync(diagnosticFile)) !== '5d7c98e16497b4bcd1ab78ea4546e8a3c7346b989d1b6c38978f5511dc6c6e1e') throw Error('provenance');
const diagnostic = require(diagnosticFile);
const CHECKOUT = path.join(ROOT, '.tmp/worktrees/gate1-absent-local-targets-staging-59383771-lf');
const PLAN = path.join(ROOT, 'docs/UIDesign/error-pages-auth-correctness-remediation-plan.md');
const COMPANION_CHECKOUT = previous.CHECKOUT;
const AMENDMENT = path.join(__dirname, 'policy-amendment.md');
const scanner = require(path.join(CHECKOUT, 'scripts/gate1-build-artifact-privacy'));
const SCOPE = 'gate1_verified_copy_absent_local_targets_v2';
const KEY = `${prior.lib.fixed.sourceSha}.verified-copy-absent-local-targets-v2`;
const CONTAINER = 'gate1-absent-local-targets-d85af7e3-v2';
const CONFIRMATION = 'SCAN VERIFIED COPY WITH INVENTORIED ABSENT LOCAL TARGETS ONCE';
const OLD_APPROVAL = '1a449d37c809863a3ea496988bcdd074e9dcae1bef7ee8a93de96c7aeb514a22';
const MANIFEST = previous.MANIFEST;
const BOOTSTRAP_FAILURES = Object.freeze(['scanner_stage', 'scanner_approval', 'comparison_read',
  'comparison_parse', 'scanner_execution', 'report_validation', 'report_privacy']);
const LIMITS = Object.freeze({ operationMs: 180000, cleanupMs: 20000, linuxSeconds: 150,
  verificationMs: 15000, verificationBytes: 134217728, reportBytes: 16384, inputBytes: 65536,
  stderrBytes: 8388608, cpus: 2, memoryBytes: 2147483648, pids: 32, tmpfsBytes: 33554432,
  hostFreeBytes: 268435456 });

/** Add strictly bounded mapping coverage to the frozen scanner summary, validating before projection.
 * Unknown fields still fail the original full schema; no per-file paths/hashes escape this boundary.
 */
function reportSchemas(contract, baseFactory) {
  const { z } = require('zod'), base = baseFactory(contract);
  /** Bound each aggregate to its approval-bound scanner limit without coercion. */
  const count = max => z.number().int().min(0).max(max).refine(v => !Object.is(v, -0));
  const mapping = z.object({ filePathMapPolicy: z.literal('inventoried_output_targets_v1'),
    filePathMaps: count(contract.scannerLimits.mappingReferences), mappingReferences: count(contract.scannerLimits.mappingReferences),
    mappedEntries: count(contract.scannerLimits.mappedEntries), mappedPathBytes: count(contract.scannerLimits.mappedPathBytes), mappingsVerified: count(contract.scannerLimits.mappingReferences),
    inspectedCopyManifestSha256: z.literal(contract.copyManifestSha256).nullable() }).strict();
  const sourceMaps = z.object({ sourceMapPolicy: z.literal('emitted_inventory_v2'),
    sourceMapReferences: count(contract.scannerLimits.totalBytes), sourceMapContexts: count(contract.scannerLimits.totalBytes),
    missingLocalMapReferences: count(contract.scannerLimits.totalBytes), missingLocalMapContexts: count(contract.scannerLimits.totalBytes),
    sourceMapAvailability: z.enum(['unqualified', 'absent_local_targets', 'all_matched_targets_present']),
    limitations: z.tuple([z.literal('absent_local_source_maps_not_inspected'),
      z.literal('source_mapping_url_matches_are_syntactic_not_lexical')]) }).strict();
  const summary = z.object({ summary: base.summary, mapping, sourceMaps }).strict().superRefine((v, ctx) => {
    const m = v.mapping, s = v.summary;
    if (m.mappedPathBytes > s.counters.decodedBytes || m.filePathMaps > m.mappingReferences || m.mappingsVerified > m.mappingReferences ||
        (s.coverage !== 'unqualified' && (m.mappingsVerified !== m.mappingReferences || m.mappedEntries < m.mappingReferences)) ||
        (s.coverage === 'unqualified' && (m.mappingsVerified !== 0 || m.inspectedCopyManifestSha256 !== null)) ||
        (s.coverage !== 'unqualified' && m.inspectedCopyManifestSha256 === null)) ctx.addIssue({ code: 'custom' });
    const maps = v.sourceMaps, full = s.coverage !== 'unqualified';
    if (maps.missingLocalMapReferences > maps.sourceMapReferences || maps.missingLocalMapContexts > maps.sourceMapContexts ||
        maps.missingLocalMapReferences > maps.missingLocalMapContexts ||
        (maps.missingLocalMapReferences === 0) !== (maps.missingLocalMapContexts === 0) ||
        (maps.sourceMapReferences === 0 && maps.sourceMapContexts !== 0) ||
        maps.sourceMapContexts > s.counters.decodedBytes || maps.sourceMapReferences > s.counters.bytesRead ||
        (full && maps.sourceMapContexts < maps.sourceMapReferences) || maps.sourceMapAvailability !==
          (full ? maps.missingLocalMapContexts ? 'absent_local_targets' : 'all_matched_targets_present' : 'unqualified')) ctx.addIssue({ code: 'custom' });
  });
  /** Separate only known new fields, leaving all other fields subject to the existing strict schema. */
  function project(report) {
    const { filePathMapPolicy, filePathMaps, mappingReferences, mappedEntries, mappedPathBytes, mappingsVerified, inspectedCopyManifestSha256,
      sourceMapPolicy, sourceMapReferences, sourceMapContexts, missingLocalMapReferences, missingLocalMapContexts, sourceMapAvailability, ...original } = report;
    return summary.parse({ summary: base.project(original), mapping: { filePathMapPolicy, filePathMaps,
      mappingReferences, mappedEntries, mappedPathBytes, mappingsVerified, inspectedCopyManifestSha256 },
    sourceMaps: { sourceMapPolicy, sourceMapReferences, sourceMapContexts, missingLocalMapReferences, missingLocalMapContexts,
      sourceMapAvailability, limitations: ['absent_local_source_maps_not_inspected', 'source_mapping_url_matches_are_syntactic_not_lexical'] } });
  }
  return { summary, project };
}

/** Keep the consumed adapter's exact historical snapshot resolver; never rewrite its evidence. */
function verifyRecord(item) { return previous.verifyRecord(item); }

/** Reverify all predecessor chains and the consumed lexical conclusion using only sanitized receipts.
 * Its final observation justifies V2's bounded absence amendment, not a privacy pass or blanket exemption.
 */
function verifyEvidence() {
  const preservation = diagnostic.verifyEvidence(), base = path.dirname(diagnosticFile);
  for (const [name, digest, count] of [
    ['review-index.json', 'c8c04fddf37b1e1cfce138c27db43f0672adf1b168728b12a2d4aecec8a6a649', 12],
    ['execution-evidence-index.json', '2cd181527981209674852e9794aa482fddaae3bbf38241beede92b04244da1dc', 6]]) {
    const file = path.join(base, name);
    if (q.fileHash(file) !== digest) throw Error('provenance');
    const index = prior.lib.parse(q.publicFile(file));
    if (index.files?.length !== count || index.approval !== OLD_APPROVAL) throw Error('provenance');
    for (const item of index.files) {
      if (!path.resolve(item.file).startsWith(ROOT + path.sep) || q.fileHash(item.file) !== item.sha256) throw Error('provenance');
    }
  }
  const p = prior.lib.parse(q.publicFile(path.join(base, 'prepared.json')));
  const terminal = prior.lib.parse(q.publicFile(path.join(base, 'execution-terminal.json')));
  const report = diagnostic.validateReport(Buffer.from(JSON.stringify(terminal.diagnostic)), p);
  if (p.approval !== OLD_APPROVAL || terminal.approval !== OLD_APPROVAL || terminal.result !== 'diagnosed' ||
      terminal.failureStep !== null || terminal.exitCode !== 0 || terminal.oomKilled || terminal.persistenceFailure ||
      terminal.teardownUnconfirmed || !terminal.lockReleased || !terminal.volumesRetained ||
      report.diagnostic.observation.guard !== 'target_not_map_suffix' || report.diagnostic.observation.target !== 'absent' ||
      report.diagnostic.observation.mapSuffix !== false || report.lexical.category !== 'line_comment_directive') throw Error('provenance');
  return { ...preservation, lexicalReviewRecords: 12, lexicalExecutionRecords: 6 };
}

/** Reuse the exact read-only two-volume scan constraints, with a new name and bounded timeout. */
function containerArgs() {
  return copy.containerArgs('scan').map(value => value === copy.CONTAINERS.scan ? CONTAINER :
    value === `${copy.LIMITS.scanSeconds}s` ? `${LIMITS.linuxSeconds}s` : value);
}

/** Normalize the fixed Linux copy profile through the scanner schema before hashing it on Windows.
 * Parsing uses a canonical host root; restoring the fixed Linux root preserves schema property order.
 */
function normalizeProfile(value) {
  if (value.outputRoot !== copy.OUTPUT) throw Error('profile');
  const profile = scanner.parseProfile({ ...value, outputRoot: path.join(CHECKOUT, '.vercel/output') });
  profile.outputRoot = copy.OUTPUT;
  return profile;
}

/** Bind revised scanner bytes, unchanged companions, fixed original comparisons and complete coverage policy. */
function prepare() {
  const preservation = verifyEvidence(), old = prior.lib.parse(q.publicFile(path.join(path.dirname(previousFile), 'prepared.json'))).contract;
  const integrity = old.files.map((name, index) => q.fileHash(path.join(index === 0 ? CHECKOUT : COMPANION_CHECKOUT, 'scripts', name)));
  if (integrity.slice(1).some((digest, i) => digest !== old.integrity[i + 1])) throw Error('companions');
  const profile = normalizeProfile({ ...old.profile, runId: hash(KEY).slice(0, 32), filePathMapPolicy: scanner.FILE_PATH_MAP_POLICY,
    sourceMapPolicy: scanner.SOURCE_MAP_POLICY_V2 });
  const scannerApproval = hash(JSON.stringify({ profile, limits: scanner.LIMITS, integrity }));
  const contract = { schemaVersion: 1, scope: SCOPE, ...prior.lib.fixed, context: q.CONTEXT,
    originalBuildProvenance: old.originalBuildProvenance, profile, scannerApproval, scannerLimits: scanner.LIMITS,
    integrity, files: old.files, limitations: [...new Set([...old.limitations, ...scanner.SOURCE_MAP_LIMITATIONS])], comparisonSource: old.comparisonSource,
    originalVolume: q.VOLUME, volume: copy.VOLUME, volumeApproval: old.volumeApproval,
    outputRoot: copy.OUTPUT, copyManifestSha256: MANIFEST, limits: LIMITS,
    destinationVerificationLimits: { overallMs: LIMITS.verificationMs, entryVisits: 100000, metadataCalls: 500000,
      destinationVerifyBytes: LIMITS.verificationBytes },
    helperSha256: q.fileHash(__filename), testsSha256: q.fileHash(path.join(__dirname, '__tests__/run-scan.test.js')),
    scannerTestsSha256: q.fileHash(path.join(CHECKOUT, 'src/testSupport/__tests__/gate1BuildArtifactPrivacy.test.js')),
    previousSha256: q.fileHash(previousFile), scannerBaseCommit: '59383771fb1a63c7caf5c890134f4c9f82ace99a',
    scannerSourceBranch: 'staging', scannerCheckout: CHECKOUT,
    preservation, diagnosticSha256: q.fileHash(diagnosticFile),
    policyPlanSha256: q.fileHash(PLAN), policyAmendmentSha256: q.fileHash(AMENDMENT),
    companionCheckout: COMPANION_CHECKOUT, companionSource: 'verified_pinned_image_bytes',
    qualificationTestsSha256: q.fileHash(path.join(CHECKOUT, 'src/testSupport/__tests__/gate1BuildQualification.test.js')),
    filePathMapSemantics: old.filePathMapSemantics,
    reservationKey: KEY, confirmation: CONFIRMATION, container: CONTAINER, containerArgs: containerArgs(),
    policy: { originalAndCopyReadOnly: true, originalArtifactTreeRead: false, originalSyntheticComparisonReadBytes: 65536,
      originalPinnedZodDependencyRead: true, pinnedImageCompanionCodeRead: true, followReferenceTargetsOnDisk: false,
      mappingPolicy: scanner.FILE_PATH_MAP_POLICY, emptyDirectories: 'inventory_name_and_mutation_coverage',
      mappedSourceMapContextsChecked: true, scannedBytesMustMatchCopyFingerprint: true,
      changedExtensionsAndMappedConfigurationFilesRejected: true,
      perFilePathsAndHashesRetained: false, rawStreamsRetained: false, finiteCategoriesAndCountsOnly: true,
      bootstrapFailureStages: BOOTSTRAP_FAILURES, profileHashUsesScannerSchemaOrder: true, pendingMappingExpansionBounded: true,
      projectedPathBytesChargedBeforeQueueing: true, distinctSourceMapContextsPreserved: true,
      sourceMapPolicy: scanner.SOURCE_MAP_POLICY_V2, absentLocalSuffixRequired: false, presentNonMapTargetsRejected: true, absentMapsNotInspected: true, referenceCompletenessNotRequired: true,
      nonFileAndImplicitDirectoryTargetsRejected: true, resolvedReferenceBytesChargedAndCompared: true,
      referenceCountsBoundedByExistingByteBudget: true, emittedInventoryCoverageRequired: true,
      preserveBothVolumes: true, exclusiveDaemonAndBothVolumeControlRequired: true, retainLockOnUncertainTeardown: true,
      downloads: 0, installs: 0, newCopies: 0, builds: 0, deployments: 0, artifactCodeExecution: false, retries: 0 },
    approvalIncludes: ['scanner_profile_attestations', 'exclusive_daemon_and_both_volume_control',
      'read_only_copy_content_and_original_fixed_synthetic_comparisons', 'original_pinned_zod_code_access',
      'mapping_policy_and_binary_representation_coverage_limits', 'explicit_absent_local_source_map_amendment',
      'regex_matches_not_lexical_comments', 'sanitized_evidence_and_private_volume_retention',
      'monitored_host_storage_threshold_not_quota', 'one_attempt_consumed_before_readiness'], gate1Status: 'open' };
  const prepared = { schemaVersion: 1, authorized: false, approval: hash(JSON.stringify(contract)), contract,
    retainedOutputReads: 0, privateComparisonReads: 0, dockerOperations: 0 };
  containerInput(prepared); return prepared;
}

/** Verify the whole copy, stage the new reviewed scanner, then privately load the fixed synthetic comparisons.
 * Only schema-validated summaries leave tmpfs. Neither artifact code nor application modules are imported.
 */
async function scanMain(contract, source, library, stage, schemas, baseSchemas) {
  const verification = library().operation(null, contract.profile.outputRoot, contract.approval, contract.copyManifestSha256,
    { limits: contract.destinationVerificationLimits });
  const result = { verification, scan: null, bootstrapFailure: null };
  if (verification.result === 'completed') {
    let step = 'scanner_stage';
    try {
      const base = '/tmp/gate1-mapping-scan', scanner = stage(contract, source, base);
      step = 'scanner_approval';
      if (scanner.approvalId(contract.profile) !== contract.scannerApproval) throw Error('approval');
      step = 'comparison_read';
      const q = require(`${base}/scripts/gate1-build-qualification`);
      const bytes = q.publicFile(contract.comparisonSource, 65536); let comparisons;
      step = 'comparison_parse';
      try { comparisons = q.strictJson(bytes); } finally { bytes.fill(0); }
      step = 'scanner_execution';
      const report = await scanner.runInspection({ profile: contract.profile, approval: contract.scannerApproval, inspectionApproved: true, comparisons });
      step = 'report_validation';
      result.scan = schemas(contract, baseSchemas).project(report);
      step = 'report_privacy';
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > 16384 || comparisons.some(ref => scanner.representations(ref.value).some(v => text.includes(v)))) {
        throw Error('report');
      }
    } catch { result.scan = null; result.bootstrapFailure = step; }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.scan?.summary.scannerResult !== 'completed') process.exitCode = 1;
}

/** Serialize only the fixed public execution code; compressed and inflated payloads have explicit caps. */
function containerInput(prepared) {
  const source = q.publicFile(path.join(CHECKOUT, 'scripts/gate1-build-artifact-privacy.js'), 65536).toString();
  if (hash(source) !== prepared.contract.integrity[0]) throw Error('scanner');
  const contract = { ...prepared.contract, approval: prepared.approval };
  const code = `(${scanMain.toString()})(${JSON.stringify(contract)},${JSON.stringify(source)},${copy.copyLibrary.toString()},` +
    `${copy.stageScanner.toString()},${reportSchemas.toString()},${copy.scanAdapter.reportSchemas.toString()})` +
    `.catch(()=>{process.stderr.write('Mapping scan stopped.\\n');process.exitCode=1;});`;
  if (Buffer.byteLength(code) > 196608) throw Error('input');
  const input = Buffer.from(`eval(require('node:zlib').inflateSync(Buffer.from(${JSON.stringify(copy.packed(code))},'base64'),{maxOutputLength:196608}).toString());`);
  if (input.length > LIMITS.inputBytes) throw Error('input'); return input;
}

/** Independently validate verification and scanner summaries; partial/failed evidence cannot qualify privacy. */
function validateReport(bytes, prepared) {
  const value = prior.lib.parse(bytes, LIMITS.reportBytes), c = prepared.contract;
  if (!prior.lib.keys(value, ['verification', 'scan', 'bootstrapFailure']) || ![null, ...BOOTSTRAP_FAILURES].includes(value.bootstrapFailure)) throw Error('report');
  value.verification = copy.validateCopy(Buffer.from(JSON.stringify(value.verification)), prepared.approval, 'verify');
  const counters = value.verification.counters;
  if (counters.destinationVerifyBytes > LIMITS.verificationBytes || counters.entryVisits > 100000 || counters.metadataCalls > 500000) throw Error('report');
  if (value.verification.result === 'completed' && value.verification.manifestSha256 !== c.copyManifestSha256) throw Error('report');
  if (value.verification.result !== 'completed' && value.bootstrapFailure !== null) throw Error('report');
  if (value.scan !== null) {
    if (value.verification.result !== 'completed' || value.bootstrapFailure !== null) throw Error('report');
    value.scan = reportSchemas({ ...c, approval: prepared.approval }, copy.scanAdapter.reportSchemas).summary.parse(value.scan);
    if (value.scan.summary.coverage !== 'unqualified' && (value.scan.summary.counters.filesRecorded !== counters.files ||
        value.scan.summary.counters.aliasesVerified !== counters.aliases)) throw Error('report');
  } else if (value.verification.result === 'completed' && value.bootstrapFailure === null) throw Error('report');
  return value;
}

/** Metadata-only checks include all preserved identities and an unused new reservation/container. */
async function readiness(run, registryCheck = true) {
  const old = await diagnostic.readiness(run, false);
  if ((await run(['ps', '-aq', '--filter', `name=^/${CONTAINER}$`], { outputBytes: 4096 })).toString().trim()) throw Error('container');
  if (registryCheck && ['active.lock', `${KEY}.reservation.json`, `${KEY}.report.json`].some(name => fs.existsSync(path.join(prior.REGISTRY, name)))) throw Error('reservation');
  return { ...old, absentLocalScanContainerAbsent: true, newReservationAbsent: registryCheck ? true : null, activeLockAbsent: registryCheck ? true : null };
}

/** Require exactly the two reviewed read-only mounts and exclusive attachment before any content read. */
async function verifyMounts(run, id) {
  const mounts = prior.lib.parse(await run(['inspect', '--format', '{{json .Mounts}}', id]), 8192);
  if (mounts.filter(m => m.Type !== 'tmpfs').length !== 2) throw Error('mount');
  await copy.verifyMounts(run, id, 'scan');
}

/** Release only the original ordinary lock after confirmed teardown and durable terminal persistence. */
function releaseLock(lock, expected) {
  const current = fs.lstatSync(lock);
  if (current.isSymbolicLink() || !prior.lib.same(expected, current)) throw Error('lock'); fs.unlinkSync(lock);
}

/** Execute one distinct consent, preserve validated failure output, and stop without retry or volume deletion. */
async function execute(envelope, dependencies = {}) {
  if (!prior.lib.keys(envelope, ['approval', 'confirmation']) || envelope.confirmation !== CONFIRMATION) throw Error('approval');
  const prepared = (dependencies.prepare || prepare)(); if (prepared.approval !== envelope.approval) throw Error('approval');
  const registry = dependencies.registry || prior.REGISTRY, save = dependencies.persist || copy.persist;
  const docker = dependencies.docker || ((args, options) => q.supervise('docker', args, options));
  const run = d.budgetRunner(docker, LIMITS.operationMs, dependencies.now), lock = path.join(registry, 'active.lock');
  /** Keep receipts exclusively inside the fixed registry and reservation identity. */
  const receipt = name => path.join(registry, `${KEY}.${name}.json`);
  q.safePath(registry); if (['reservation', 'report'].some(name => fs.existsSync(receipt(name)))) throw Error('reservation');
  save(lock, { scope: SCOPE, approval: prepared.approval }); const lockStat = fs.lstatSync(lock);
  const result = { schemaVersion: 1, scope: SCOPE, approval: prepared.approval, result: 'stopped', failureStep: null,
    scan: null, exitCode: null, oomKilled: null, teardownUnconfirmed: false, persistenceFailure: false,
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
    /** Parse both success and nonzero child output before any record is retained. */
    const validate = bytes => validateReport(bytes, prepared);
    try { result.scan = validate(await run(['start', '-ai', id], { input: containerInput(prepared), outputBytes: LIMITS.reportBytes, parseFailureReport: validate })); }
    catch (error) { if (error.report) result.scan = validate(Buffer.from(JSON.stringify(error.report))); throw Error('process'); }
    if (result.scan.scan?.summary.scannerResult !== 'completed') throw Error('scan');
    step = 'teardown'; const state = await d.teardown(run, id); id = undefined;
    result.exitCode = state.exitCode; result.oomKilled = state.oomKilled; if (!state.clean) throw Error('exit');
    result.result = 'completed';
  } catch { result.failureStep = step; if (!reserved) result.persistenceFailure = true; }
  finally {
    if (id) {
      try { const state = await d.teardown(d.budgetRunner(docker, LIMITS.cleanupMs, dependencies.now), id);
        result.exitCode = state.exitCode; result.oomKilled = state.oomKilled; id = undefined;
      } catch { uncertain = true; }
    }
    result.teardownUnconfirmed = uncertain;
    if (uncertain) { result.result = 'stopped'; result.failureStep = 'cleanup'; }
    // The durable pre-release report qualifies only if teardown succeeded; final return also requires lock release.
    if (result.result === 'completed') result.artifactPrivacy = 'no_matches_in_checked_representations';
    try { save(receipt('report'), result); } catch { result.persistenceFailure = true; result.result = 'stopped'; }
    if (!result.persistenceFailure && !uncertain) {
      try { releaseLock(lock, lockStat); result.lockReleased = true; }
      catch { result.persistenceFailure = true; result.result = 'stopped'; }
    }
    if (result.result !== 'completed') result.artifactPrivacy = 'unqualified';
  }
  return result;
}

/** Keep public preparation/readiness separate from the explicitly approved one-time content command. */
async function main(args) {
  if (args.length === 1 && args[0] === '--prepare') return prepare();
  if (args.length === 1 && args[0] === '--readiness') { prepare(); return readiness(d.budgetRunner((a, o) => q.supervise('docker', a, o), 60000)); }
  if (args.length === 3 && args[0] === '--execute') return execute({ approval: args[1], confirmation: args[2] });
  throw Error('input');
}
if (require.main === module) main(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result) + '\n'); if (result.result === 'stopped') process.exitCode = 1;
}).catch(() => { process.stderr.write('Mapping scan stopped. Preserve evidence; no automatic retry.\n'); process.exitCode = 1; });
module.exports = { ROOT, CHECKOUT, COMPANION_CHECKOUT, AMENDMENT, SCOPE, KEY, CONTAINER, CONFIRMATION, OLD_APPROVAL, MANIFEST, LIMITS, BOOTSTRAP_FAILURES, previous, diagnostic, copy, q, d, prior,
  scanner, hash, reportSchemas, verifyRecord, verifyEvidence, containerArgs, normalizeProfile, prepare, scanMain, containerInput, validateReport, readiness, verifyMounts, execute, main };
