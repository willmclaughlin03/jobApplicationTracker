const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  FORBIDDEN_APPLICATION_ENV_NAMES,
  INTEGRATION_TEST_RUN_ID_ENV_NAME,
  NPM_INTEGRATION_ARGUMENTS,
  runTrustedIntegrationCli,
  runTrustedIntegrationTests,
} = require('../../../scripts/run-trusted-integration.js');

const REPO_ROOT = join(__dirname, '..', '..', '..');
const RUNNER_PATH = join(REPO_ROOT, 'scripts', 'run-trusted-integration.js');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'integration.yml');
const SECRET_SENTINEL = 'must-not-appear-in-diagnostics';

const VALID_TRUSTED_ENV = Object.freeze({
  TEST_SUPABASE_URL: 'https://expectedref.supabase.co',
  TEST_SUPABASE_ANON_KEY: SECRET_SENTINEL,
  TEST_SUPABASE_SERVICE_KEY: SECRET_SENTINEL,
  SUPABASE_TEST_USER_A_EMAIL: 'user-a@example.invalid',
  SUPABASE_TEST_USER_B_EMAIL: 'user-b@example.invalid',
  SUPABASE_TEST_USER_ID: '00000000-0000-4000-8000-000000000001',
  TEST_CSRF: 'test-csrf-secret-that-is-at-least-32-characters',
  UPSTASH_REDIS_REST_URL: 'https://example.invalid',
  UPSTASH_REDIS_REST_TOKEN: SECRET_SENTINEL,
  SUPABASE_TEST_PROJECT_REF: 'expectedref',
  GITHUB_RUN_ID: '123456789',
  GITHUB_RUN_ATTEMPT: '2',
});

/**
 * Execute only the real runner preflight in an isolated Node subprocess.
 *
 * Purpose: failure-path tests prove the CLI exits before npm or Jest can start
 * and capture only its audited stdout/stderr diagnostics.
 *
 * @param {Record<string, string>} env complete fake subprocess environment
 * @returns {import('node:child_process').SpawnSyncReturns<string>} process result
 */
function runPreflightSubprocess(env) {
  return spawnSync(process.execPath, [RUNNER_PATH, '--preflight-only'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    shell: false,
    windowsHide: true,
  });
}

describe('trusted integration runner', () => {
  it('accepts the canonical fake test contract without starting Jest', () => {
    const result = runPreflightSubprocess({ ...VALID_TRUSTED_ENV });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('reports all missing names in stable order without secret values', () => {
    const env = { ...VALID_TRUSTED_ENV };
    delete env.TEST_SUPABASE_ANON_KEY;
    delete env.UPSTASH_REDIS_REST_TOKEN;

    const result = runPreflightSubprocess(env);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'Missing required trusted integration environment variables:\n'
      + '- TEST_SUPABASE_ANON_KEY\n'
      + '- UPSTASH_REDIS_REST_TOKEN\n'
    );
    expect(result.stderr).not.toContain(SECRET_SENTINEL);
  });

  it('rejects a mismatched Supabase project before process creation', () => {
    const wrongUrl = 'https://wrongref.supabase.co';
    const result = runPreflightSubprocess({
      ...VALID_TRUSTED_ENV,
      TEST_SUPABASE_URL: wrongUrl,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'TEST_SUPABASE_URL must match SUPABASE_TEST_PROJECT_REF'
    );
    expect(result.stderr).not.toContain(wrongUrl);
    expect(result.stderr).not.toContain(SECRET_SENTINEL);
  });

  it.each(FORBIDDEN_APPLICATION_ENV_NAMES)(
    'refuses a configured %s fallback by name only',
    (forbiddenName) => {
      const result = runPreflightSubprocess({
        ...VALID_TRUSTED_ENV,
        [forbiddenName]: SECRET_SENTINEL,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Refusing application or deployment credential fallbacks:');
      expect(result.stderr).toContain(`- ${forbiddenName}`);
      expect(result.stderr).not.toContain(SECRET_SENTINEL);
    }
  );

  it('refuses a destructive opt-in inherited by the parent process', () => {
    const result = runPreflightSubprocess({
      ...VALID_TRUSTED_ENV,
      RUN_DESTRUCTIVE_DB_INTEGRATION: 'true',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'RUN_DESTRUCTIVE_DB_INTEGRATION must be absent before the trusted preflight.\n'
    );
  });

  it('rejects an invalid TEST_CSRF without reporting its value', () => {
    const invalidCsrf = 'too-short';
    const result = runPreflightSubprocess({
      ...VALID_TRUSTED_ENV,
      TEST_CSRF: invalidCsrf,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('TEST_CSRF must contain at least 32 characters.\n');
    expect(result.stderr).not.toContain(invalidCsrf);
  });

  it('requires positive numeric GitHub run metadata', () => {
    const result = runPreflightSubprocess({
      ...VALID_TRUSTED_ENV,
      GITHUB_RUN_ATTEMPT: 'attempt-two',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must contain positive decimal integers.\n'
    );
  });

  it('adds the opt-in only to the exact npm child environment', () => {
    const parentEnvironment = { ...VALID_TRUSTED_ENV };
    const spawnProcess = jest.fn().mockReturnValue({ status: 0 });

    expect(runTrustedIntegrationTests(parentEnvironment, spawnProcess)).toBe(0);

    expect(parentEnvironment).not.toHaveProperty('RUN_DESTRUCTIVE_DB_INTEGRATION');
    expect(parentEnvironment).not.toHaveProperty(INTEGRATION_TEST_RUN_ID_ENV_NAME);
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    const [command, args, options] = spawnProcess.mock.calls[0];
    expect(command).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm');
    expect(args).toEqual(NPM_INTEGRATION_ARGUMENTS);
    expect(options).toMatchObject({
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    expect(options.env).toEqual({
      ...parentEnvironment,
      RUN_DESTRUCTIVE_DB_INTEGRATION: 'true',
      INTEGRATION_TEST_RUN_ID: 'github-123456789-2',
    });
  });

  it('propagates a child test failure without exposing spawn errors', () => {
    expect(runTrustedIntegrationTests(
      { ...VALID_TRUSTED_ENV },
      jest.fn().mockReturnValue({ status: 7 })
    )).toBe(7);

    expect(() => runTrustedIntegrationTests(
      { ...VALID_TRUSTED_ENV },
      jest.fn().mockReturnValue({
        status: null,
        error: new Error(SECRET_SENTINEL),
      })
    )).toThrow('Unable to complete the trusted integration test process.');
  });

  it('returns names-only CLI failures through the injected writer', () => {
    const writeError = jest.fn();

    expect(runTrustedIntegrationCli(
      ['--unknown'],
      { ...VALID_TRUSTED_ENV },
      writeError
    )).toBe(1);
    expect(writeError).toHaveBeenCalledWith(
      'Trusted integration runner accepts only --preflight-only.'
    );
  });
});

describe('trusted integration workflow contract', () => {
  it('keeps the guard secret-free and the integration job staging-only', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
    const guardStart = workflow.indexOf('  guard-staging-ref:');
    const integrationStart = workflow.indexOf('  integration:');
    const guardBlock = workflow.slice(guardStart, integrationStart);

    expect(workflow).toMatch(/^on:\r?\n {2}workflow_dispatch:\s*$/m);
    expect(workflow).not.toMatch(/^\s+pull_request(?:_target)?:/m);
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(guardStart).toBeGreaterThan(-1);
    expect(integrationStart).toBeGreaterThan(guardStart);
    expect(guardBlock).toContain('refs/heads/staging');
    expect(guardBlock).toContain('permissions: {}');
    expect(guardBlock).not.toContain('environment:');
    expect(guardBlock).not.toContain('secrets.');
    expect(workflow).toContain('needs: guard-staging-ref');
  });

  it('serializes Environment-bound runs without cancellation or deployment records', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

    expect(workflow).toContain('name: integration-test');
    expect(workflow).toContain('deployment: false');
    expect(workflow).toContain('group: integration-test-infrastructure');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('timeout-minutes: 30');
    expect(workflow).toMatch(/permissions:\r?\n {6}contents: read/);
  });

  it('maps only canonical secrets and delegates the exact test command to the runner', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

    expect(workflow).toContain(
      'SUPABASE_TEST_PROJECT_REF: ${{ secrets.SUPABASE_TEST_PROJECT_REF }}'
    );
    expect(workflow).not.toContain('vars.SUPABASE_TEST_PROJECT_REF');
    expect(workflow).not.toContain('RUN_DESTRUCTIVE_DB_INTEGRATION');
    expect(workflow).not.toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(workflow).not.toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY');
    expect(workflow).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(workflow).not.toContain('CSRF_SECRET');
    expect(workflow).not.toMatch(/(?:printenv|\benv\b\s*$)/m);
    expect(workflow).toContain('run: node scripts/run-trusted-integration.js --preflight-only');
    expect(workflow).toContain('run: node scripts/run-trusted-integration.js');
  });
});
