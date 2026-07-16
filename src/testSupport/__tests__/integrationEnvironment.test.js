const {
  TEST_SUPABASE_ENV_NAMES,
  findMissingTestEnvironmentNames,
  matchesSupabaseTestProject,
  resolveDestructiveIntegrationEnvironment,
  resolveDescribeOrSkip,
  resolveTestCsrfSecret,
  restoreEnvironmentVariable,
} = require('../integrationEnvironment.js');

const VALID_TEST_ENV = Object.freeze({
  TEST_SUPABASE_URL: 'https://expectedref.supabase.co',
  TEST_SUPABASE_ANON_KEY: 'test-anon-key',
  TEST_SUPABASE_SERVICE_KEY: 'test-service-key',
  SUPABASE_TEST_PROJECT_REF: 'expectedref',
  RUN_DESTRUCTIVE_DB_INTEGRATION: 'true',
});

describe('integration test environment contract', () => {
  it('reports only missing canonical names in stable order', () => {
    const sensitiveValue = 'must-not-appear-in-errors';
    const names = findMissingTestEnvironmentNames(
      {
        TEST_SUPABASE_URL: '',
        TEST_SUPABASE_SERVICE_KEY: sensitiveValue,
      },
      [
        TEST_SUPABASE_ENV_NAMES.url,
        TEST_SUPABASE_ENV_NAMES.anonKey,
        TEST_SUPABASE_ENV_NAMES.serviceKey,
      ]
    );

    expect(names).toEqual([
      'TEST_SUPABASE_URL',
      'TEST_SUPABASE_ANON_KEY',
    ]);
    expect(names.join(' ')).not.toContain(sensitiveValue);
  });

  it('skips cleanly when destructive integration is not explicitly enabled', () => {
    expect(resolveDestructiveIntegrationEnvironment({}, {
      suiteName: 'Test suite',
      requiredNames: [
        TEST_SUPABASE_ENV_NAMES.url,
        TEST_SUPABASE_ENV_NAMES.serviceKey,
      ],
    })).toBe(false);
  });

  it('fails an enabled suite with names-only missing-variable diagnostics', () => {
    const sensitiveValue = 'must-not-appear-in-errors';

    expect(() => resolveDestructiveIntegrationEnvironment({
      RUN_DESTRUCTIVE_DB_INTEGRATION: 'true',
      TEST_SUPABASE_SERVICE_KEY: sensitiveValue,
    }, {
      suiteName: 'Test suite',
      requiredNames: [
        TEST_SUPABASE_ENV_NAMES.url,
        TEST_SUPABASE_ENV_NAMES.serviceKey,
      ],
    })).toThrow(
      'Cannot run Test suite: missing required test environment variables: '
      + 'TEST_SUPABASE_URL, SUPABASE_TEST_PROJECT_REF.'
    );

    try {
      resolveDestructiveIntegrationEnvironment({
        RUN_DESTRUCTIVE_DB_INTEGRATION: 'true',
        TEST_SUPABASE_SERVICE_KEY: sensitiveValue,
      }, {
        suiteName: 'Test suite',
        requiredNames: [
          TEST_SUPABASE_ENV_NAMES.url,
          TEST_SUPABASE_ENV_NAMES.serviceKey,
        ],
      });
    } catch (error) {
      expect(error.message).not.toContain(sensitiveValue);
    }
  });

  it('rejects a Supabase URL whose project reference does not match', () => {
    expect(matchesSupabaseTestProject(
      'https://wrongref.supabase.co',
      'expectedref'
    )).toBe(false);

    expect(() => resolveDestructiveIntegrationEnvironment({
      ...VALID_TEST_ENV,
      TEST_SUPABASE_URL: 'https://wrongref.supabase.co',
    }, {
      suiteName: 'Test suite',
      requiredNames: [
        TEST_SUPABASE_ENV_NAMES.url,
        TEST_SUPABASE_ENV_NAMES.serviceKey,
      ],
    })).toThrow(
      'Refusing to run Test suite: TEST_SUPABASE_URL must match SUPABASE_TEST_PROJECT_REF.'
    );
  });

  it('accepts the expected project URL and required credentials', () => {
    expect(resolveDestructiveIntegrationEnvironment(VALID_TEST_ENV, {
      suiteName: 'Test suite',
      requiredNames: [
        TEST_SUPABASE_ENV_NAMES.url,
        TEST_SUPABASE_ENV_NAMES.serviceKey,
      ],
    })).toBe(true);
  });

  it('derives Jest suite registration from destructive integration readiness', () => {
    const describeFn = jest.fn();
    describeFn.skip = jest.fn();
    const options = {
      suiteName: 'Test suite',
      requiredNames: [
        TEST_SUPABASE_ENV_NAMES.url,
        TEST_SUPABASE_ENV_NAMES.serviceKey,
      ],
    };

    expect(resolveDescribeOrSkip({}, options, describeFn)).toEqual({
      hasInfra: false,
      describeOrSkip: describeFn.skip,
    });
    expect(resolveDescribeOrSkip(VALID_TEST_ENV, options, describeFn)).toEqual({
      hasInfra: true,
      describeOrSkip: describeFn,
    });
  });

  it('uses a deterministic CSRF fallback only when TEST_CSRF is absent', () => {
    const fallback = 'deterministic-test-secret-at-least-32-characters';

    expect(resolveTestCsrfSecret({}, fallback)).toBe(fallback);
    expect(resolveTestCsrfSecret({
      TEST_CSRF: 'supplied-test-secret-at-least-32-characters',
    }, fallback)).toBe('supplied-test-secret-at-least-32-characters');
    expect(() => resolveTestCsrfSecret({ TEST_CSRF: 'too-short' }, fallback))
      .toThrow('TEST_CSRF must contain at least 32 characters.');
    expect(() => resolveTestCsrfSecret({ TEST_CSRF: '' }, fallback))
      .toThrow('TEST_CSRF must contain at least 32 characters.');
    expect(() => resolveTestCsrfSecret({}, 'too-short-fallback'))
      .toThrow('The deterministic test CSRF fallback must contain at least 32 characters.');
  });

  it('restores or deletes isolated environment mutations', () => {
    const env = {
      EXISTING: 'original',
      NEW_VALUE: 'temporary',
    };

    env.EXISTING = 'temporary';
    restoreEnvironmentVariable(env, 'EXISTING', 'original');
    restoreEnvironmentVariable(env, 'NEW_VALUE', undefined);

    expect(env).toEqual({ EXISTING: 'original' });
  });
});
