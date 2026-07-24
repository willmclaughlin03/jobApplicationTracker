const { spawnSync } = require('node:child_process');

const {
  RUN_DESTRUCTIVE_DB_INTEGRATION_ENV_NAME,
  SUPABASE_TEST_PROJECT_REF_ENV_NAME,
  TEST_CSRF_ENV_NAME,
  TEST_SUPABASE_ENV_NAMES,
  findMissingTestEnvironmentNames,
  matchesSupabaseTestProject,
  resolveTestCsrfSecret,
} = require('../src/testSupport/integrationEnvironment.js');

const REQUIRED_TRUSTED_INTEGRATION_ENV_NAMES = Object.freeze([
  TEST_SUPABASE_ENV_NAMES.url,
  TEST_SUPABASE_ENV_NAMES.anonKey,
  TEST_SUPABASE_ENV_NAMES.serviceKey,
  'SUPABASE_TEST_USER_A_EMAIL',
  'SUPABASE_TEST_USER_B_EMAIL',
  'SUPABASE_TEST_USER_ID',
  TEST_CSRF_ENV_NAME,
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  SUPABASE_TEST_PROJECT_REF_ENV_NAME,
]);

const REQUIRED_GITHUB_RUN_ENV_NAMES = Object.freeze([
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
]);

const FORBIDDEN_APPLICATION_ENV_NAMES = Object.freeze([
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CSRF_SECRET',
]);

const INTEGRATION_TEST_RUN_ID_ENV_NAME = 'INTEGRATION_TEST_RUN_ID';
const SUPABASE_PROJECT_REF_MISMATCH_MESSAGE =
  'TEST_SUPABASE_URL must match SUPABASE_TEST_PROJECT_REF before trusted integration tests run.';
const NPM_INTEGRATION_ARGUMENTS = Object.freeze([
  'run',
  'test:integration',
  '--',
  '--no-cache',
]);

/**
 * Find forbidden application or deployment names that contain usable values.
 *
 * Purpose: the trusted runner accepts only the canonical TEST_* contract and
 * refuses inherited deployment credentials before Jest can import any suite.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @param {readonly string[]} names forbidden names to inspect
 * @returns {string[]} configured names in stable contract order
 */
function findConfiguredEnvironmentNames(env, names) {
  return names.filter((name) => {
    const value = env?.[name];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/**
 * Format a names-only environment diagnostic for safe workflow output.
 *
 * Purpose: operators need actionable missing or forbidden names without any
 * credential value reaching the GitHub Actions log.
 *
 * @param {string} heading safe diagnostic heading
 * @param {readonly string[]} names environment names to report
 * @returns {string} stable multiline names-only diagnostic
 */
function formatEnvironmentNameDiagnostic(heading, names) {
  return [
    heading,
    ...names.map((name) => `- ${name}`),
  ].join('\n');
}

/**
 * Derive a bounded non-secret identifier from GitHub's run metadata.
 *
 * Purpose: child suites receive one reconciliation-friendly workflow identity
 * without incorporating secret values or caller-controlled free-form input.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @returns {string} identifier in github-<run-id>-<attempt> form
 * @throws {Error} when either GitHub value is not a positive decimal integer
 */
function deriveIntegrationTestRunId(env) {
  const runId = env?.GITHUB_RUN_ID?.trim();
  const runAttempt = env?.GITHUB_RUN_ATTEMPT?.trim();
  const positiveIntegerPattern = /^[1-9]\d*$/;

  if (!positiveIntegerPattern.test(runId) || !positiveIntegerPattern.test(runAttempt)) {
    throw new Error(
      'GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must contain positive decimal integers.'
    );
  }

  return `github-${runId}-${runAttempt}`;
}

/**
 * Enforce the exact independently configured Supabase project reference.
 *
 * Purpose: both the offline refusal proof and the normal trusted preflight
 * exercise this single target validator before any service client is imported.
 *
 * @param {unknown} testUrl candidate TEST_SUPABASE_URL value
 * @param {unknown} projectRef independently configured expected project ref
 * @returns {void}
 * @throws {Error} with one static message when the target does not match
 */
function assertSupabaseTestProject(testUrl, projectRef) {
  if (!matchesSupabaseTestProject(testUrl, projectRef)) {
    throw new Error(SUPABASE_PROJECT_REF_MISMATCH_MESSAGE);
  }
}

/**
 * Build a guaranteed-different in-memory project reference for refusal proof.
 *
 * Purpose: the workflow must demonstrate wrong-target refusal without changing
 * the configured GitHub Environment value or contacting Supabase.
 *
 * @param {unknown} configuredProjectRef expected project ref from the environment
 * @returns {string} bounded lowercase proof ref that differs from the configured ref
 */
function buildWrongProjectRef(configuredProjectRef) {
  const primaryProofRef = '00000000000000000000';
  return typeof configuredProjectRef === 'string'
    && configuredProjectRef.trim() === primaryProofRef
    ? '11111111111111111111'
    : primaryProofRef;
}

/**
 * Prove the real target validator rejects an intentionally wrong project ref.
 *
 * Purpose: this dependency-free proof runs before normal preflight and npm
 * install, succeeds only on the exact mismatch diagnostic, and never creates a
 * Supabase or Redis client.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @param {(testUrl: unknown, projectRef: unknown) => void} validateProject target validator
 * @returns {void}
 * @throws {Error} for missing names, unrelated refusal, or unexpected acceptance
 */
function proveProjectRefRefusal(
  env,
  validateProject = assertSupabaseTestProject
) {
  const missingNames = findMissingTestEnvironmentNames(env, [
    ...REQUIRED_TRUSTED_INTEGRATION_ENV_NAMES,
    ...REQUIRED_GITHUB_RUN_ENV_NAMES,
  ]);

  if (missingNames.length > 0) {
    throw new Error(formatEnvironmentNameDiagnostic(
      'Missing required trusted integration environment variables:',
      missingNames
    ));
  }

  const wrongProjectRef = buildWrongProjectRef(
    env[SUPABASE_TEST_PROJECT_REF_ENV_NAME]
  );

  try {
    validateProject(env[TEST_SUPABASE_ENV_NAMES.url], wrongProjectRef);
  } catch (error) {
    if (
      error instanceof Error
      && error.message === SUPABASE_PROJECT_REF_MISMATCH_MESSAGE
    ) {
      return;
    }

    throw new Error(
      'Supabase project-ref refusal proof failed for an unrelated reason.'
    );
  }

  throw new Error(
    'Supabase project-ref refusal proof unexpectedly accepted the wrong project.'
  );
}

/**
 * Validate the complete trusted-integration boundary before remote test imports.
 *
 * Purpose: GitHub Environment names alone do not prove target safety, so this
 * preflight checks canonical names, refuses deployment fallbacks, validates the
 * CSRF contract, and confirms the independently configured Supabase project.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @returns {{ runId: string }} validated non-secret child-process metadata
 * @throws {Error} with names-only diagnostics when any safety check fails
 */
function validateTrustedIntegrationEnvironment(env) {
  if (Object.prototype.hasOwnProperty.call(
    env,
    RUN_DESTRUCTIVE_DB_INTEGRATION_ENV_NAME
  )) {
    throw new Error(
      `${RUN_DESTRUCTIVE_DB_INTEGRATION_ENV_NAME} must be absent before the trusted preflight.`
    );
  }

  const missingNames = findMissingTestEnvironmentNames(env, [
    ...REQUIRED_TRUSTED_INTEGRATION_ENV_NAMES,
    ...REQUIRED_GITHUB_RUN_ENV_NAMES,
  ]);

  if (missingNames.length > 0) {
    throw new Error(formatEnvironmentNameDiagnostic(
      'Missing required trusted integration environment variables:',
      missingNames
    ));
  }

  const configuredFallbackNames = findConfiguredEnvironmentNames(
    env,
    FORBIDDEN_APPLICATION_ENV_NAMES
  );

  if (configuredFallbackNames.length > 0) {
    throw new Error(formatEnvironmentNameDiagnostic(
      'Refusing application or deployment credential fallbacks:',
      configuredFallbackNames
    ));
  }

  resolveTestCsrfSecret(env, '');

  assertSupabaseTestProject(
    env[TEST_SUPABASE_ENV_NAMES.url],
    env[SUPABASE_TEST_PROJECT_REF_ENV_NAME]
  );

  return {
    runId: deriveIntegrationTestRunId(env),
  };
}

/**
 * Build the isolated environment passed to the destructive Jest child process.
 *
 * Purpose: the parent process must remain untrusted and unmodified; only the
 * exact test child receives the destructive opt-in and derived run identifier.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env validated parent snapshot
 * @param {string} runId derived non-secret GitHub workflow identifier
 * @returns {NodeJS.ProcessEnv|Record<string, unknown>} copied trusted child environment
 */
function buildTrustedIntegrationChildEnvironment(env, runId) {
  return {
    ...env,
    [RUN_DESTRUCTIVE_DB_INTEGRATION_ENV_NAME]: 'true',
    [INTEGRATION_TEST_RUN_ID_ENV_NAME]: runId,
  };
}

/**
 * Execute the exact serial integration-test command after trusted preflight.
 *
 * Purpose: centralizing process creation prevents shell interpolation and keeps
 * the destructive opt-in scoped to the intended npm/Jest child process.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env parent environment snapshot
 * @param {typeof spawnSync} spawnProcess injectable synchronous process boundary
 * @returns {number} child exit status for direct CLI propagation
 * @throws {Error} when the child cannot start or does not report an exit status
 */
function runTrustedIntegrationTests(env = process.env, spawnProcess = spawnSync) {
  const { runId } = validateTrustedIntegrationEnvironment(env);
  const childEnvironment = buildTrustedIntegrationChildEnvironment(env, runId);
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnProcess(npmCommand, NPM_INTEGRATION_ARGUMENTS, {
    env: childEnvironment,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.error || typeof result.status !== 'number') {
    throw new Error('Unable to complete the trusted integration test process.');
  }

  return result.status;
}

/**
 * Write one preflight-safe failure message for command-line execution.
 *
 * Purpose: the CLI has one audited stderr boundary and never dumps environment
 * snapshots, child options, or secret-bearing error objects.
 *
 * @param {string} message names-only trusted-runner diagnostic
 * @returns {void}
 */
function writeTrustedIntegrationError(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * Run the trusted integration CLI in proof, preflight, or child-execution mode.
 *
 * Purpose: the workflow can validate configuration before dependency install,
 * then repeat the same preflight immediately before the destructive test child.
 *
 * @param {string[]} argv command-line arguments after the script path
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @param {(message: string) => void} writeError audited error writer
 * @returns {number} process exit code
 */
function runTrustedIntegrationCli(
  argv = process.argv.slice(2),
  env = process.env,
  writeError = writeTrustedIntegrationError
) {
  try {
    if (argv.length === 1 && argv[0] === '--prove-project-ref-refusal') {
      proveProjectRefRefusal(env);
      return 0;
    }

    if (argv.length === 1 && argv[0] === '--preflight-only') {
      validateTrustedIntegrationEnvironment(env);
      return 0;
    }

    if (argv.length !== 0) {
      throw new Error(
        'Trusted integration runner accepts only --prove-project-ref-refusal or --preflight-only.'
      );
    }

    return runTrustedIntegrationTests(env);
  } catch (error) {
    writeError(error instanceof Error
      ? error.message
      : 'Trusted integration preflight failed.');
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runTrustedIntegrationCli();
}

module.exports = {
  FORBIDDEN_APPLICATION_ENV_NAMES,
  INTEGRATION_TEST_RUN_ID_ENV_NAME,
  NPM_INTEGRATION_ARGUMENTS,
  REQUIRED_GITHUB_RUN_ENV_NAMES,
  REQUIRED_TRUSTED_INTEGRATION_ENV_NAMES,
  SUPABASE_PROJECT_REF_MISMATCH_MESSAGE,
  assertSupabaseTestProject,
  buildTrustedIntegrationChildEnvironment,
  buildWrongProjectRef,
  deriveIntegrationTestRunId,
  findConfiguredEnvironmentNames,
  formatEnvironmentNameDiagnostic,
  proveProjectRefRefusal,
  runTrustedIntegrationCli,
  runTrustedIntegrationTests,
  validateTrustedIntegrationEnvironment,
};
