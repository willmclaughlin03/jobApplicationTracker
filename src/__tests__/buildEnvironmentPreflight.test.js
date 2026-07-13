const {
  REQUIRED_BUILD_ENV_NAMES,
  findMissingBuildEnvironmentNames,
  formatMissingBuildEnvironmentNames,
  runBuildEnvironmentPreflight,
} = require('../../scripts/validate-build-env.js');

/**
 * Build a complete environment snapshot with recognizable non-secret values.
 * Individual tests override selected names to exercise missing-value behavior.
 *
 * @param {Record<string, unknown>} overrides values to replace in the snapshot
 * @returns {Record<string, unknown>} complete build environment snapshot
 */
function buildCompleteEnvironment(overrides = {}) {
  return {
    NEXT_PUBLIC_SUPABASE_URL: 'https://ci-build.invalid',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'ci-build-only-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'ci-build-only-service-role-key',
    CSRF_SECRET: 'ci-build-only-secret-at-least-32-characters',
    ...overrides,
  };
}

describe('build environment preflight', () => {
  it('accepts a complete build environment without writing output', () => {
    const writeError = jest.fn();

    expect(runBuildEnvironmentPreflight(buildCompleteEnvironment(), writeError)).toBe(true);
    expect(writeError).not.toHaveBeenCalled();
  });

  it('treats absent, blank, and non-string values as missing', () => {
    const env = buildCompleteEnvironment({
      NEXT_PUBLIC_SUPABASE_URL: undefined,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: '   ',
      SUPABASE_SERVICE_ROLE_KEY: null,
    });

    expect(findMissingBuildEnvironmentNames(env)).toEqual([
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]);
  });

  it('reports every missing name in stable contract order', () => {
    const writeError = jest.fn();

    expect(runBuildEnvironmentPreflight({}, writeError)).toBe(false);
    expect(writeError).toHaveBeenCalledWith([
      'Missing required build environment variables:',
      ...REQUIRED_BUILD_ENV_NAMES.map((name) => `- ${name}`),
    ].join('\n'));
  });

  it('formats only supplied names and never includes environment values', () => {
    const sensitiveValue = 'must-never-appear-in-preflight-output';
    const message = formatMissingBuildEnvironmentNames(['CSRF_SECRET']);
    const writeError = jest.fn();

    runBuildEnvironmentPreflight(
      buildCompleteEnvironment({ CSRF_SECRET: '', UNRELATED_SECRET: sensitiveValue }),
      writeError
    );

    expect(message).toBe('Missing required build environment variables:\n- CSRF_SECRET');
    expect(writeError.mock.calls.flat().join('\n')).not.toContain(sensitiveValue);
  });
});
