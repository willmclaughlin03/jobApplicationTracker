const REQUIRED_BUILD_ENV_NAMES = Object.freeze([
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CSRF_SECRET',
]);

/**
 * Find build-required environment names whose values are absent or blank.
 * This accepts an environment snapshot so tests and CI checks never need to
 * mutate process.env, and it returns names only so values cannot reach output.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @param {readonly string[]} requiredNames names required by the Next.js build
 * @returns {string[]} missing environment variable names in contract order
 */
function findMissingBuildEnvironmentNames(env, requiredNames = REQUIRED_BUILD_ENV_NAMES) {
  return requiredNames.filter((name) => {
    const value = env?.[name];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/**
 * Format a names-only build preflight error without accepting secret values.
 * The stable multiline shape keeps local and CI failures easy to compare.
 *
 * @param {readonly string[]} missingNames missing environment variable names
 * @returns {string} safe diagnostic containing names only
 */
function formatMissingBuildEnvironmentNames(missingNames) {
  return [
    'Missing required build environment variables:',
    ...missingNames.map((name) => `- ${name}`),
  ].join('\n');
}

/**
 * Write a build preflight diagnostic to stderr for command-line callers.
 * Keeping output behind this small boundary lets unit tests capture it without
 * replacing global console behavior.
 *
 * @param {string} message names-only diagnostic message
 * @returns {void}
 */
function writePreflightError(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * Validate the build environment and report all missing names in one pass.
 * This is used by npm's build command before Next.js compilation and has no
 * side effects beyond invoking the supplied names-only error writer.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @param {(message: string) => void} writeError safe diagnostic writer
 * @returns {boolean} true when every required name has a nonblank value
 */
function runBuildEnvironmentPreflight(env = process.env, writeError = writePreflightError) {
  const missingNames = findMissingBuildEnvironmentNames(env);

  if (missingNames.length === 0) {
    return true;
  }

  writeError(formatMissingBuildEnvironmentNames(missingNames));
  return false;
}

if (require.main === module) {
  process.exitCode = runBuildEnvironmentPreflight() ? 0 : 1;
}

module.exports = {
  REQUIRED_BUILD_ENV_NAMES,
  findMissingBuildEnvironmentNames,
  formatMissingBuildEnvironmentNames,
  runBuildEnvironmentPreflight,
};
