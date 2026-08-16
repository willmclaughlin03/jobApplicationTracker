const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  EXPECTED_SUPABASE_PROJECT_REF,
  EXPECTED_SUPABASE_URL,
  GATE0_ENV_NAMES,
  Gate0CleanupError,
  GOOGLE_SESSION_FIXTURE_V1,
  SESSION_ERROR_CANDIDATES,
  assertSafeEvidence,
  buildBoundedGoogleUserMetadata,
  buildGoogleSessionFixtures,
  captureGoogleSessionFixtureEvidence,
  captureHostedAuthVersion,
  classifyGoogleSessionCredential,
  proveWrongProjectRefRefusal,
  sanitizeSdkObservation,
  utf8ByteLength,
  validateGate0Environment,
  withDisposableSession,
} = require('../../../scripts/gate0-auth-evidence.js');
const {
  runGate0EvidenceCli,
  withSuppressedDependencyConsole,
} = require('../../../scripts/capture-gate0-auth-evidence.js');

const DISPOSABLE_USER_ID = '00000000-0000-4000-8000-000000000099';

/**
 * Build a complete non-secret environment for offline preflight tests.
 *
 * Purpose: tests prove names, target matching, and fallback refusal without
 * reading local environment values or contacting Supabase.
 *
 * @returns {Record<string, string>} valid synthetic preflight environment
 */
function buildValidEnvironment() {
  return {
    [GATE0_ENV_NAMES.url]: EXPECTED_SUPABASE_URL,
    [GATE0_ENV_NAMES.anonKey]: 'test-only-anon-key',
    [GATE0_ENV_NAMES.serviceRoleKey]: 'test-only-service-role-key',
    [GATE0_ENV_NAMES.managementToken]: 'test-only-management-token',
    [GATE0_ENV_NAMES.projectRef]: EXPECTED_SUPABASE_PROJECT_REF,
    [GATE0_ENV_NAMES.destructiveOptIn]: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/staging',
  };
}

/**
 * Build a structurally complete safe evidence object for schema-guard tests.
 *
 * Purpose: sanitizer rejection cases need a valid baseline whose only changes
 * are the deliberately injected unsafe or unexpected fields.
 *
 * @returns {Record<string, unknown>} valid sanitized evidence document
 */
function buildSafeEvidence() {
  return {
    schemaVersion: 1,
    target: {
      projectRef: EXPECTED_SUPABASE_PROJECT_REF,
      authServerVersion: 'v2.194.0',
    },
    dependencies: {
      ssrVersion: '0.8.0',
      supabaseJsVersion: '2.90.1',
      authJsVersion: '2.90.1',
    },
    cookieEvidence: captureGoogleSessionFixtureEvidence(),
    sessionErrors: SESSION_ERROR_CANDIDATES.map((candidate) => ({
      candidate,
      operation: candidate === 'bad_jwt' || candidate === 'session_not_found'
        || candidate === 'user_not_found'
        ? 'getUser'
        : 'implicit_refresh',
      exportedClass: null,
      code: null,
      codeObserved: false,
      status: null,
      disposition: 'unavailable',
    })),
  };
}

/**
 * Build the target-scoped admin mock shared by disposable cleanup tests.
 *
 * Purpose: cleanup cases vary only the exact delete result while retaining one
 * deterministic created user ID for invocation assertions.
 *
 * @param {{ deleteError?: unknown }} options mocked final deletion result
 * @returns {Record<string, unknown>} Supabase admin client mock
 */
function buildAdminMock({ deleteError = null } = {}) {
  return {
    auth: {
      admin: {
        createUser: jest.fn().mockResolvedValue({
          data: { user: { id: DISPOSABLE_USER_ID } },
          error: null,
        }),
        deleteUser: jest.fn().mockResolvedValue({ error: deleteError }),
      },
    },
  };
}

/**
 * Build the isolated sign-in client mock shared by disposable cleanup tests.
 *
 * Purpose: each cleanup path starts from the same supported synthetic session
 * and never contacts the hosted provider.
 *
 * @returns {Record<string, unknown>} installed-client factory mock
 */
function buildClientsMock() {
  const supportedSession = buildGoogleSessionFixtures().refreshedSession;

  return {
    createClient: jest.fn(() => ({
      auth: {
        signInWithPassword: jest.fn().mockResolvedValue({
          data: { session: supportedSession },
          error: null,
        }),
      },
    })),
  };
}

describe('Gate-0 auth evidence harness', () => {
  it('keeps the evidence workflow manual, staging-only, isolated, and artifact-free', () => {
    const workflow = readFileSync(
      path.resolve('.github/workflows/gate0-auth-evidence.yml'),
      'utf8'
    );

    expect(workflow).toMatch(/on:\s*\n {2}workflow_dispatch:/);
    expect(workflow).not.toMatch(/\n {2}(push|pull_request|schedule):/);
    expect(workflow).toContain('"${GITHUB_REF}" != "refs/heads/staging"');
    expect(workflow).toContain('name: gate0-preproduction-evidence');
    expect(workflow).toContain('group: gate0-preproduction-auth-evidence');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain("GATE0_AUTH_EVIDENCE_ALLOWED: 'true'");
    expect(workflow).toContain('secrets.GATE0_SUPABASE_MANAGEMENT_TOKEN');
    expect(workflow).not.toContain('actions/upload-artifact');
    expect(workflow.indexOf('npm ci')).toBeLessThan(
      workflow.indexOf('Capture sanitized Gate-0 auth evidence')
    );
  });

  it('reproduces the approved maximum fixture through installed SSR chunking', () => {
    expect(captureGoogleSessionFixtureEvidence()).toEqual({
      fixtureId: 'GOOGLE_SESSION_FIXTURE_V1',
      initialLoginChunks: 6,
      refreshedSessionChunks: 5,
      maximumChunks: 6,
      expectedMaximumChunks: 6,
      reproducedExpectedMaximum: true,
    });
  });

  it('treats unavailable or malformed hosted Auth health as absent version evidence', async () => {
    const config = {
      url: EXPECTED_SUPABASE_URL,
      anonKey: 'test-only-anon-key',
    };
    const fetchSpy = jest.spyOn(global, 'fetch');

    try {
      fetchSpy.mockRejectedValueOnce(new TypeError('synthetic transport failure'));
      await expect(captureHostedAuthVersion(config)).resolves.toBeNull();

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockRejectedValue(new SyntaxError('synthetic invalid JSON')),
      });
      await expect(captureHostedAuthVersion(config)).resolves.toBeNull();

      const nonOkJson = jest.fn();
      fetchSpy.mockResolvedValueOnce({ ok: false, json: nonOkJson });
      await expect(captureHostedAuthVersion(config)).resolves.toBeNull();
      expect(nonOkJson).not.toHaveBeenCalled();

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ version: 'latest' }),
      });
      await expect(captureHostedAuthVersion(config)).resolves.toBeNull();

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ version: 'v2.194.0' }),
      });
      await expect(captureHostedAuthVersion(config)).resolves.toBe('v2.194.0');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('checks the SSR version before loading its private serializer layout', () => {
    const supportedSession = buildGoogleSessionFixtures().refreshedSession;
    const packagePath = require.resolve('@supabase/ssr/package.json');
    const serializerPath = path.join(path.dirname(packagePath), 'dist', 'main', 'utils');
    const loadPrivateSerializer = jest.fn(() => {
      throw new Error('private-serializer-layout-loaded');
    });

    jest.doMock(packagePath, () => ({ version: '0.0.0-incompatible' }));
    jest.doMock(serializerPath, loadPrivateSerializer);

    try {
      jest.isolateModules(() => {
        const {
          buildGoogleSessionFixtures: buildIsolatedGoogleSessionFixtures,
          classifyGoogleSessionCredential: classifyIsolatedGoogleSessionCredential,
        } = require('../../../scripts/gate0-auth-evidence.js');

        expect(() => buildIsolatedGoogleSessionFixtures()).toThrow(
          'Installed @supabase/ssr version reopens GOOGLE_SESSION_FIXTURE_V1.'
        );
        expect(classifyIsolatedGoogleSessionCredential(supportedSession)).toEqual({
          supported: true,
          disposition: 'supported',
        });
      });
    } finally {
      jest.dontMock(packagePath);
      jest.dontMock(serializerPath);
      jest.resetModules();
    }

    expect(loadPrivateSerializer).not.toHaveBeenCalled();
  });

  it('enforces the exact versioned Google session shape and boundaries', () => {
    const metadata = buildBoundedGoogleUserMetadata();
    const { initialLogin, refreshedSession } = buildGoogleSessionFixtures();

    expect(GOOGLE_SESSION_FIXTURE_V1.identityCount).toBe(1);
    expect(Object.keys(metadata)).toEqual(GOOGLE_SESSION_FIXTURE_V1.allowedUserMetadataFields);
    expect(utf8ByteLength(JSON.stringify(metadata))).toBe(2560);
    expect(initialLogin.user.identities).toHaveLength(1);
    expect(initialLogin.user.identities[0].provider).toBe('google');
    expect(Object.keys(initialLogin.user.identities[0]).sort()).toEqual(
      [...GOOGLE_SESSION_FIXTURE_V1.allowedIdentityFields].sort()
    );
    expect(utf8ByteLength(initialLogin.provider_token)).toBe(2048);
    expect(initialLogin).not.toHaveProperty('provider_refresh_token');
    expect(refreshedSession).not.toHaveProperty('provider_token');
    expect(refreshedSession).not.toHaveProperty('provider_refresh_token');
  });

  it('classifies every oversized or structurally different credential as unavailable', () => {
    const { initialLogin, refreshedSession } = buildGoogleSessionFixtures();
    const accessTokenSegments = refreshedSession.access_token.split('.');
    const accessTokenHeader = JSON.parse(
      Buffer.from(accessTokenSegments[0], 'base64url').toString('utf8')
    );
    const es256Session = {
      ...structuredClone(refreshedSession),
      access_token: [
        Buffer.from(JSON.stringify({ ...accessTokenHeader, alg: 'ES256' }))
          .toString('base64url'),
        ...accessTokenSegments.slice(1),
      ].join('.'),
    };
    const unsupportedAlgorithmSession = {
      ...structuredClone(refreshedSession),
      access_token: [
        Buffer.from(JSON.stringify({ ...accessTokenHeader, alg: 'HS256' }))
          .toString('base64url'),
        ...accessTokenSegments.slice(1),
      ].join('.'),
    };
    const variants = [
      {
        ...structuredClone(initialLogin),
        provider_token: 'p'.repeat(2049),
      },
      {
        ...structuredClone(initialLogin),
        provider_refresh_token: 'forbidden',
      },
      {
        ...structuredClone(initialLogin),
        user: {
          ...structuredClone(initialLogin.user),
          identities: [
            ...structuredClone(initialLogin.user.identities),
            structuredClone(initialLogin.user.identities[0]),
          ],
        },
      },
      {
        ...structuredClone(initialLogin),
        user: {
          ...structuredClone(initialLogin.user),
          user_metadata: {
            ...structuredClone(initialLogin.user.user_metadata),
            unexpected: true,
          },
        },
      },
      {
        ...structuredClone(refreshedSession),
        access_token: 'not.a.supported-token-envelope',
      },
      unsupportedAlgorithmSession,
    ];

    expect(classifyGoogleSessionCredential(initialLogin)).toEqual({
      supported: true,
      disposition: 'supported',
    });
    expect(classifyGoogleSessionCredential(refreshedSession)).toEqual({
      supported: true,
      disposition: 'supported',
    });
    expect(classifyGoogleSessionCredential(es256Session)).toEqual({
      supported: true,
      disposition: 'supported',
    });
    variants.forEach((credential) => {
      expect(classifyGoogleSessionCredential(credential)).toEqual({
        supported: false,
        disposition: 'unavailable',
      });
      expect(classifyGoogleSessionCredential(credential).disposition).not.toBe('anonymous');
    });
  });

  it('accepts only the exact restored pre-production target and staging ref', () => {
    expect(validateGate0Environment({
      ...buildValidEnvironment(),
      [GATE0_ENV_NAMES.url]: `  ${EXPECTED_SUPABASE_URL}  `,
      [GATE0_ENV_NAMES.anonKey]: '  test-only-anon-key  ',
      [GATE0_ENV_NAMES.serviceRoleKey]: '  test-only-service-role-key  ',
      [GATE0_ENV_NAMES.managementToken]: '  test-only-management-token  ',
      [GATE0_ENV_NAMES.projectRef]: `  ${EXPECTED_SUPABASE_PROJECT_REF}  `,
    })).toEqual({
      url: EXPECTED_SUPABASE_URL,
      anonKey: 'test-only-anon-key',
      serviceRoleKey: 'test-only-service-role-key',
      managementToken: 'test-only-management-token',
    });

    expect(() => validateGate0Environment({
      ...buildValidEnvironment(),
      [GATE0_ENV_NAMES.projectRef]: '00000000000000000000',
    })).toThrow('approved pre-production project');
    expect(() => validateGate0Environment({
      ...buildValidEnvironment(),
      GITHUB_REF: 'refs/heads/main',
    })).toThrow('exact staging branch ref');
  });

  it('refuses fallback credential names and proves a wrong project is rejected', () => {
    expect(() => proveWrongProjectRefRefusal(buildValidEnvironment())).not.toThrow();
    expect(() => validateGate0Environment({
      ...buildValidEnvironment(),
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'must-not-be-used',
    })).toThrow('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  });

  it('keeps CLI diagnostics names-only and suppresses dependency console output', async () => {
    const output = jest.fn();
    const errorOutput = jest.fn();
    const status = await runGate0EvidenceCli(
      ['--preflight-only'],
      { [GATE0_ENV_NAMES.anonKey]: 'secret-sentinel' },
      output,
      errorOutput
    );
    const suppressedConsoleMethods = [
      'debug',
      'dir',
      'error',
      'info',
      'log',
      'table',
      'trace',
      'warn',
    ];
    const originalConsole = new Map(
      suppressedConsoleMethods.map((method) => [method, console[method]])
    );
    const dependencySink = jest.fn();

    suppressedConsoleMethods.forEach((method) => {
      console[method] = dependencySink;
    });
    try {
      await withSuppressedDependencyConsole(async () => {
        suppressedConsoleMethods.forEach((method) => {
          console[method](`raw-provider-${method}-sentinel`);
        });
      });

      expect(dependencySink).not.toHaveBeenCalled();
      suppressedConsoleMethods.forEach((method) => {
        expect(console[method]).toBe(dependencySink);
      });
    } finally {
      originalConsole.forEach((original, method) => {
        console[method] = original;
      });
    }

    expect(status).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(errorOutput).toHaveBeenCalledTimes(1);
    expect(errorOutput.mock.calls[0][0]).toContain('GATE0_SUPABASE_URL');
    expect(errorOutput.mock.calls[0][0]).not.toContain('secret-sentinel');
  });

  it('reports cleanup failures safely and keeps provider errors generic', async () => {
    const captureGate0AuthEvidence = jest.fn();
    const output = jest.fn();
    const errorOutput = jest.fn();
    let isolatedRunGate0EvidenceCli;

    jest.doMock('../../../scripts/gate0-auth-evidence.js', () => {
      const actualEvidence = jest.requireActual('../../../scripts/gate0-auth-evidence.js');
      captureGate0AuthEvidence
        .mockRejectedValueOnce(new actualEvidence.Gate0CleanupError('raw-cleanup-sentinel'))
        .mockRejectedValueOnce(new Error('raw-provider-sentinel'));

      return { ...actualEvidence, captureGate0AuthEvidence };
    });

    try {
      jest.isolateModules(() => {
        ({ runGate0EvidenceCli: isolatedRunGate0EvidenceCli } = require(
          '../../../scripts/capture-gate0-auth-evidence.js'
        ));
      });

      await expect(isolatedRunGate0EvidenceCli([], {}, output, errorOutput)).resolves.toBe(1);
      await expect(isolatedRunGate0EvidenceCli([], {}, output, errorOutput)).resolves.toBe(1);
    } finally {
      jest.dontMock('../../../scripts/gate0-auth-evidence.js');
      jest.resetModules();
    }

    expect(output).not.toHaveBeenCalled();
    expect(errorOutput.mock.calls).toEqual([
      ['Gate-0 disposable user cleanup failed; verify and remove synthetic users manually.'],
      ['Gate-0 auth evidence capture failed; inspect provider state without exposing errors.'],
    ]);
    expect(JSON.stringify(errorOutput.mock.calls)).not.toContain('raw-cleanup-sentinel');
    expect(JSON.stringify(errorOutput.mock.calls)).not.toContain('raw-provider-sentinel');
  });

  it('retains only safe installed-SDK tuple fields', () => {
    const unsafeError = {
      constructor: { name: 'AuthApiError' },
      message: 'raw-provider-message-with-token-sentinel',
      code: 'bad_jwt',
      status: 403,
      response: { access_token: 'token-sentinel' },
    };
    const observation = sanitizeSdkObservation('bad_jwt', 'getUser', unsafeError);
    const serialized = JSON.stringify(observation);

    expect(observation).toEqual({
      candidate: 'bad_jwt',
      operation: 'getUser',
      exportedClass: 'AuthApiError',
      code: 'bad_jwt',
      codeObserved: true,
      status: 403,
      disposition: 'allowlisted',
    });
    expect(serialized).not.toContain('raw-provider-message');
    expect(serialized).not.toContain('token-sentinel');
    expect(serialized).not.toContain('response');
  });

  it('rejects incomplete, overlapping, or unexpected evidence fields', () => {
    const safeEvidence = buildSafeEvidence();

    expect(() => assertSafeEvidence(safeEvidence)).not.toThrow();
    expect(() => assertSafeEvidence({
      ...safeEvidence,
      access_token: 'token-sentinel',
    })).toThrow('unexpected top-level field');
    expect(() => assertSafeEvidence({
      ...safeEvidence,
      sessionErrors: safeEvidence.sessionErrors.map((observation, index) => (
        index === 0 ? { ...observation, message: 'raw-provider-message' } : observation
      )),
    })).toThrow('unexpected field');
    expect(() => assertSafeEvidence({
      ...safeEvidence,
      sessionErrors: safeEvidence.sessionErrors.slice(1),
    })).toThrow('incomplete');
  });

  it('deletes exactly one disposable user when a scenario fails', async () => {
    const admin = buildAdminMock();

    await expect(withDisposableSession(
      { url: EXPECTED_SUPABASE_URL, anonKey: 'anon' },
      buildClientsMock(),
      admin,
      async () => {
        throw new Error('scenario failed');
      }
    )).rejects.toThrow('scenario failed');
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledTimes(1);
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith(DISPOSABLE_USER_ID);
  });

  it('fails closed when disposable cleanup does not succeed', async () => {
    const admin = buildAdminMock({ deleteError: { message: 'denied' } });
    const cleanup = withDisposableSession(
      { url: EXPECTED_SUPABASE_URL, anonKey: 'anon' },
      buildClientsMock(),
      admin,
      async () => ({ candidate: 'bad_jwt', disposition: 'unavailable' })
    );

    await expect(cleanup).rejects.toBeInstanceOf(Gate0CleanupError);
    await expect(cleanup).rejects.toThrow('Disposable Gate-0 user cleanup failed.');
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledTimes(1);
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith(DISPOSABLE_USER_ID);
  });

  it('skips final deletion after the scenario deletes its own user', async () => {
    const admin = buildAdminMock();
    const observation = { candidate: 'user_not_found' };

    await expect(withDisposableSession(
      { url: EXPECTED_SUPABASE_URL, anonKey: 'anon' },
      buildClientsMock(),
      admin,
      async ({ markDeleted }) => {
        markDeleted();
        return observation;
      }
    )).resolves.toBe(observation);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});
