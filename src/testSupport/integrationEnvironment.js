const TEST_SUPABASE_ENV_NAMES = Object.freeze({
  url: 'TEST_SUPABASE_URL',
  anonKey: 'TEST_SUPABASE_ANON_KEY',
  serviceKey: 'TEST_SUPABASE_SERVICE_KEY',
});

const SUPABASE_TEST_PROJECT_REF_ENV_NAME = 'SUPABASE_TEST_PROJECT_REF';
const RUN_DESTRUCTIVE_DB_INTEGRATION_ENV_NAME = 'RUN_DESTRUCTIVE_DB_INTEGRATION';
const TEST_CSRF_ENV_NAME = 'TEST_CSRF';
const MINIMUM_CSRF_SECRET_LENGTH = 32;

/**
 * Find required test environment names whose values are absent or blank.
 *
 * Purpose: integration preflights report names only, so secret values cannot
 * reach logs while callers can still show every missing prerequisite at once.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @param {readonly string[]} requiredNames names required by the test surface
 * @returns {string[]} missing names in the caller-supplied contract order
 */
function findMissingTestEnvironmentNames(env, requiredNames) {
  return requiredNames.filter((name) => {
    const value = env?.[name];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/**
 * Check that a Supabase test URL belongs to the independently named project.
 *
 * Purpose: TEST_* credential names do not prove target safety; destructive
 * suites must also verify the HTTPS project hostname before making changes.
 *
 * @param {unknown} testUrl candidate TEST_SUPABASE_URL value
 * @param {unknown} projectRef expected Supabase project reference
 * @returns {boolean} true only for the expected Supabase project origin
 */
function matchesSupabaseTestProject(testUrl, projectRef) {
  if (typeof testUrl !== 'string' || typeof projectRef !== 'string') {
    return false;
  }

  const normalizedProjectRef = projectRef.trim();
  if (!normalizedProjectRef) {
    return false;
  }

  try {
    const parsedUrl = new URL(testUrl);
    return parsedUrl.protocol === 'https:'
      && parsedUrl.hostname === normalizedProjectRef + '.supabase.co'
      && parsedUrl.port === ''
      && parsedUrl.username === ''
      && parsedUrl.password === '';
  } catch {
    return false;
  }
}

/**
 * Resolve whether a destructive integration suite may run.
 *
 * Purpose: disabled suites skip cleanly, while an explicitly enabled suite
 * fails before imports or network calls when credentials or target proof are
 * missing. Error text contains environment names but never their values.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @param {{ suiteName: string, requiredNames: readonly string[] }} options suite contract
 * @returns {boolean} true when the destructive suite is explicitly safe to run
 * @throws {Error} when an enabled suite has missing prerequisites or a wrong target
 */
function resolveDestructiveIntegrationEnvironment(env, options) {
  const enabled = env?.[RUN_DESTRUCTIVE_DB_INTEGRATION_ENV_NAME] === 'true';
  if (!enabled) {
    return false;
  }

  const requiredNames = [
    ...options.requiredNames,
    SUPABASE_TEST_PROJECT_REF_ENV_NAME,
  ];
  const missingNames = findMissingTestEnvironmentNames(env, requiredNames);

  if (missingNames.length > 0) {
    throw new Error(
      'Cannot run ' + options.suiteName + ': missing required test environment variables: '
      + missingNames.join(', ') + '.'
    );
  }

  if (!matchesSupabaseTestProject(
    env[TEST_SUPABASE_ENV_NAMES.url],
    env[SUPABASE_TEST_PROJECT_REF_ENV_NAME]
  )) {
    throw new Error(
      'Refusing to run ' + options.suiteName + ': TEST_SUPABASE_URL must match '
      + 'SUPABASE_TEST_PROJECT_REF.'
    );
  }

  return true;
}

/**
 * Resolve the HMAC secret that an isolated test process will install.
 *
 * Purpose: externally supplied TEST_CSRF values must satisfy the production
 * minimum and must never silently fall back when present but invalid.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @param {string} fallback deterministic secret for infrastructure-free tests
 * @returns {string} validated supplied value or the deterministic fallback
 * @throws {Error} when TEST_CSRF or the fallback is too short
 */
function resolveTestCsrfSecret(env, fallback) {
  const suppliedValue = env?.[TEST_CSRF_ENV_NAME];
  if (suppliedValue !== undefined) {
    if (typeof suppliedValue !== 'string' || suppliedValue.length < MINIMUM_CSRF_SECRET_LENGTH) {
      throw new Error('TEST_CSRF must contain at least 32 characters.');
    }
    return suppliedValue;
  }

  if (typeof fallback !== 'string' || fallback.length < MINIMUM_CSRF_SECRET_LENGTH) {
    throw new Error('The deterministic test CSRF fallback must contain at least 32 characters.');
  }

  return fallback;
}

/**
 * Restore one process environment name after an isolated test mutation.
 *
 * Purpose: test bootstrap must not leak fake application configuration or a
 * mapped CSRF secret into later suites running in the same Jest process.
 *
 * @param {NodeJS.ProcessEnv} env mutable process environment
 * @param {string} name environment variable name to restore
 * @param {string|undefined} originalValue value captured before test mutation
 * @returns {void}
 */
function restoreEnvironmentVariable(env, name, originalValue) {
  if (originalValue === undefined) {
    delete env[name];
    return;
  }

  env[name] = originalValue;
}

module.exports = {
  MINIMUM_CSRF_SECRET_LENGTH,
  RUN_DESTRUCTIVE_DB_INTEGRATION_ENV_NAME,
  SUPABASE_TEST_PROJECT_REF_ENV_NAME,
  TEST_CSRF_ENV_NAME,
  TEST_SUPABASE_ENV_NAMES,
  findMissingTestEnvironmentNames,
  matchesSupabaseTestProject,
  resolveDestructiveIntegrationEnvironment,
  resolveTestCsrfSecret,
  restoreEnvironmentVariable,
};
