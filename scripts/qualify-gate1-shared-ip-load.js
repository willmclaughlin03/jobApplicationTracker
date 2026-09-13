/**
 * Explicit preparation/dry-run/live entry point for the GATE-1 shared-IP runner.
 * No mode runs the Gate-0 suite or changes application/provider configuration.
 * Live account creation, traffic, and owned-account cleanup require separate approval.
 */
const {
  TARGET, PROPOSED_PROFILE, ENV_NAMES, Gate1Error, failureCode,
  validateProfile, validateLiveEnvironment, createLiveServices, createOfflineServices, runProfile,
} = require('./gate1-shared-ip-load.js');
const { withSuppressedDependencyConsole } = require('./capture-gate0-auth-evidence.js');

const NUMBER_FLAGS = Object.freeze({
  '--sessions': 'sessions', '--cycles': 'cycles', '--interval-ms': 'intervalMs',
  '--concurrency': 'concurrency', '--timeout-ms': 'timeoutMs',
  '--setup-timeout-ms': 'setupTimeoutMs', '--duration-ms': 'durationMs',
  '--max-app-requests': 'maxAppRequests',
});
const TARGET_FLAGS = Object.freeze({ '--target': 'origin', '--deployment-id': 'deploymentId',
  '--git-sha': 'gitSha', '--next-build-id': 'nextBuildId' });
const ACK_FLAG = '--authorize-provision-traffic-cleanup';
const HELP = `GATE-1 shared-IP runner (temporary v1; GATE-1 remains open)
  --help       Show help; no network or credential access.
  --prepare    Print the proposed procedure and environment-name presence only (default).
  --dry-run    Run all stages with mocked services and synthetic time; no network.
  --live       Requires separately approved account creation, traffic, and cleanup.

Live requires ${ACK_FLAG}, GATE1_LIVE_ALLOWED=true,
all numeric flags, and all target identity flags explicitly:
  ${Object.keys(NUMBER_FLAGS).join(' ')}
  ${Object.keys(TARGET_FLAGS).join(' ')}
Numeric values are separate positive decimal arguments. No credentials in arguments.
Use --prepare for the exact proposed settings, credential names, and evidence limits.
No .env loading, auto-refresh, retry, deployment bypass, or redirect following.
Exit codes: 0 completed/prepared, 1 stopped/refused, 2 completed with recorded CSRF exceptions.
`;
let liveRunning = false;

/** Parse a strict CLI vocabulary; raw argument values never appear in error output. */
function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw new Gate1Error('configuration');
  if (argv.length === 1 && argv[0] === '--help') return { mode: 'help' };
  let mode = 'prepare';
  let modeSeen = false;
  const seen = new Set();
  const profile = { ...PROPOSED_PROFILE };
  const target = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Gate1Error('configuration');
    seen.add(flag);
    if (['--prepare', '--dry-run', '--live'].includes(flag)) {
      if (modeSeen) throw new Gate1Error('configuration');
      mode = flag.slice(2); modeSeen = true;
    } else if (Object.hasOwn(NUMBER_FLAGS, flag)) {
      const value = argv[++index];
      if (!/^\d+$/.test(value || '')) throw new Gate1Error('configuration');
      profile[NUMBER_FLAGS[flag]] = Number(value);
    } else if (Object.hasOwn(TARGET_FLAGS, flag)) {
      const value = argv[++index];
      if (value !== TARGET[TARGET_FLAGS[flag]]) throw new Gate1Error('wrong_target');
      target[TARGET_FLAGS[flag]] = value;
    } else if (flag !== ACK_FLAG) throw new Gate1Error('configuration');
  }
  if (mode === 'live') {
    if (!seen.has(ACK_FLAG) || profile.sessions !== 50
      || [...Object.keys(NUMBER_FLAGS), ...Object.keys(TARGET_FLAGS)].some(flag => !seen.has(flag))) {
      throw new Gate1Error('configuration');
    }
  } else if (seen.has(ACK_FLAG)) throw new Gate1Error('configuration');
  return { mode, profile: validateProfile(profile), target };
}

/** Build a reviewable proposal using only validated numbers, pinned identifiers, and environment-name presence. */
function preparation(profile, env) {
  return {
    mode: 'preparation', hostedEvidence: 'not_executed', gate1Status: 'open', target: TARGET, profile,
    authorization: 'separate_live_provisioning_traffic_and_cleanup_approval_required',
    environment: ENV_NAMES.map(name => ({ name, present: typeof env[name] === 'string' && env[name].length > 0 })),
    credentials: 'dedicated GATE1 names supplied securely to the process; never chat, CLI arguments, or .env files',
    targetAttribution: 'operator rechecks deployment and Git SHA before approval; runner checks actual Next build before and after',
    provider: { existingPreproductionProjectOnly: true, newDependencies: false,
      sessionsPerDisposableAccount: 1, provisioningConcurrency: 1, cleanupConcurrency: 5,
      maxCreateRequests: profile.sessions, maxSignInRequests: profile.sessions,
      maxDeleteRequests: profile.sessions, maxDirectRequests: profile.sessions * 3,
      cancelledCreateSettlementMaxMs: profile.timeoutMs,
      cleanupWorstCaseMs: Math.ceil(profile.sessions / 5) * profile.timeoutMs },
    application: { buildChecks: 2, sessionRequests: profile.sessions * profile.cycles,
      csrfRequests: profile.sessions * profile.cycles, maxDirectRequests: profile.maxAppRequests,
      requestsPerSession: profile.cycles * 2, preparationIdentityCheck: 'first_session_GET_is_mount_cycle',
      schedule: 'mount then visibility cycles; per-session interval, bounded workers, no catch-up or background polling',
      source: 'one machine/network; no source headers or external IP-discovery calls' },
    retryPolicy: 'zero retries for HTTP, SDK provisioning, sign-in, or deletion',
    stopConditions: ['cancellation', 'setup/load deadline', 'request budget', 'target/build/redirect mismatch',
      'identity mismatch or duplicate session', 'invalid cookie/cache/response', 'transport failure',
      'any rejection except the documented CSRF 503 signature', 'uncertain provisioning or cleanup'],
    csrfExceptions: 'record 503 + SERVICE_UNAVAILABLE + Retry-After 5 with private/no-store; continue, do not infer upstream 504 or count as success',
    cleanup: 'finally deletes only confirmed owned create receipts, including partial setup; graceful interruption keeps cleanup active',
    interruptedCleanup: 'hard termination or lost create response can leave accounts; report uncertainty where possible, inspect gate1_qualification metadata in provider administration, separately approve exact-account recovery',
    measurement: 'automated monotonic HTTP durations and sanitized counts; prior browser measurements remain unmeasured',
    evidenceLimits: ['HTTP clients do not establish browser/UI or OAuth behavior',
      'shared-egress/WAF source agreement, topology, Redis cardinality, provider work, and cost require separate evidence',
      'direct request budget excludes downstream application-to-provider requests',
      'temporary v1 result cannot approve CHUNK-5A or final GATE-5B paths/thresholds'],
  };
}

/**
 * Execute only the explicitly selected mode; help/import/preparation never instantiate live clients.
 * Injected output and transport seams keep CLI refusal and dry-run tests fully offline.
 */
async function runCli(argv = process.argv.slice(2), env = process.env, {
  writeOutput = text => process.stdout.write(`${text}\n`),
  writeError = text => process.stderr.write(`${text}\n`), fetchImpl,
} = {}) {
  let ownsLiveRun = false;
  let controller;
  /** Stop setup/load on graceful process signals; owned-account cleanup deliberately remains active. */
  function cancel() { controller?.abort(new Gate1Error('cancelled')); }
  try {
    const options = parseArguments(argv);
    if (options.mode === 'help') { writeOutput(HELP); return 0; }
    if (options.mode === 'prepare') {
      writeOutput(JSON.stringify(preparation(options.profile, env), null, 2));
      return 0;
    }
    let report;
    if (options.mode === 'dry-run') {
      const offline = createOfflineServices(options.profile);
      report = await runProfile(options.profile, offline.services, { dryRun: true, clock: offline.clock });
    } else {
      validateLiveEnvironment(env);
      if (liveRunning) throw new Gate1Error('configuration');
      liveRunning = true; ownsLiveRun = true;
      controller = new AbortController();
      process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
      report = await withSuppressedDependencyConsole(async () => {
        const services = createLiveServices(options.profile, env, fetchImpl);
        return runProfile(options.profile, services, { signal: controller.signal });
      });
      report.attribution.deploymentAndGit = 'operator_attested';
    }
    writeOutput(JSON.stringify(report, null, 2));
    return report.result === 'stopped' ? 1 : report.result === 'completed_with_exceptions' ? 2 : 0;
  } catch (error) {
    writeError(JSON.stringify({ mode: 'refused_or_failed', code: failureCode(error),
      guidance: 'Use --prepare; configuration diagnostics disclose environment names and presence only.' }));
    return 1;
  } finally {
    if (ownsLiveRun) {
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      liveRunning = false;
    }
  }
}

if (require.main === module) {
  // A safe top-level rejection boundary also covers failures of the output stream itself.
  runCli().then(code => { process.exitCode = code; }).catch(() => {
    process.exitCode = 1;
    process.stderr.write('GATE-1 runner failed before producing a safe report.\n');
  });
}

module.exports = { parseArguments, preparation, runCli };
