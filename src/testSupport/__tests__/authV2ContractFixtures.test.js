/**
 * Integrity tests for the CHUNK-0 v2 authentication contract fixtures.
 *
 * Purpose: Prove the approved public schemas are strict and that unresolved
 * deployment evidence is not silently promoted into an allowlist.
 * Connects to: src/testSupport/authV2ContractFixtures.js.
 */

import {
  AUTH_CAPABLE_CACHE_INVENTORY,
  AUTH_CONSUMER_STATE_MATRIX,
  AUTH_COOKIE_STORAGE_KEY,
  AUTH_STATE_TRANSITION_FIXTURES,
  AUTH_STATUS,
  INSTALLED_SUPABASE_EVIDENCE,
  LOGOUT_INTENT_HEADER,
  LOGOUT_INTENT_DECISION_FIXTURES,
  LOGOUT_INTENT_VALUE,
  LOGOUT_REQUEST_BODY_FIXTURES,
  LOGOUT_REJECTED_SIDE_EFFECTS,
  LOGOUT_SOURCE_DECISION_FIXTURES,
  MAX_AUTH_COOKIE_CHUNKS,
  PRIVATE_NO_STORE,
  QUARANTINED_DRAFT_CANONICAL_KEYS,
  QUARANTINED_DRAFT_POLICY,
  ROLE_NORMALIZATION_FIXTURES,
  ROUTABLE_PAGE_POLICY_FIXTURES,
  ROUTE_CLASSIFICATION_FIXTURES,
  SESSION_ERROR_EVIDENCE,
  SESSION_RESPONSE_FIXTURES,
  SIGNOUT_RESPONSE_FIXTURES,
  SUPABASE_ENCODED_CHUNK_SIZE,
  TERMINAL_USER_BANNED_APPROVAL,
  TERMINAL_USER_BANNED_UI,
  sessionResponseSchema,
  sessionHttpResponseSchema,
  signoutHttpResponseSchema,
  signoutResponseSchema,
} from '../authV2ContractFixtures.js';

describe('CHUNK-0 auth v2 contract fixtures', () => {
  it('accepts every exact session fixture and rejects each body on a wrong status', () => {
    Object.values(SESSION_RESPONSE_FIXTURES).forEach((response) => {
      const { body } = response;
      const wrongStatus = response.httpStatus === 200 ? 503 : 200;

      expect(sessionResponseSchema.safeParse(body).success).toBe(true);
      expect(sessionHttpResponseSchema.safeParse(response).success).toBe(true);
      expect(sessionHttpResponseSchema.safeParse({
        ...response,
        httpStatus: wrongStatus,
      }).success).toBe(false);
    });
  });

  it.each([
    ['authenticated body on terminal status', {
      ...SESSION_RESPONSE_FIXTURES.authenticated,
      httpStatus: 403,
    }],
    ['terminal body on success status', {
      ...SESSION_RESPONSE_FIXTURES.terminalUserBanned,
      httpStatus: 200,
    }],
    ['rate-limited body on unavailable status', {
      ...SESSION_RESPONSE_FIXTURES.rateLimited,
      httpStatus: 503,
    }],
    ['service-unavailable body on rate-limit status', {
      ...SESSION_RESPONSE_FIXTURES.unavailable,
      httpStatus: 429,
      headers: SESSION_RESPONSE_FIXTURES.rateLimited.headers,
    }],
    ['rate-limited response without Retry-After', {
      ...SESSION_RESPONSE_FIXTURES.rateLimited,
      headers: { 'cache-control': PRIVATE_NO_STORE },
    }],
    ['method rejection without Allow', {
      ...SESSION_RESPONSE_FIXTURES.rejectedMethod,
      headers: { 'cache-control': PRIVATE_NO_STORE },
    }],
  ])('rejects a mismatched %s session HTTP contract', (_name, response) => {
    expect(sessionHttpResponseSchema.safeParse(response).success).toBe(false);
  });

  it.each([
    ['legacy envelope', { data: SESSION_RESPONSE_FIXTURES.anonymous.body, error: null }],
    ['string version', { ...SESSION_RESPONSE_FIXTURES.anonymous.body, version: '2' }],
    ['missing field', { version: 2, status: AUTH_STATUS.ANONYMOUS }],
    ['extra field', { ...SESSION_RESPONSE_FIXTURES.anonymous.body, message: 'ok' }],
    ['mistyped user', { ...SESSION_RESPONSE_FIXTURES.anonymous.body, user: false }],
    ['unknown error code', {
      ...SESSION_RESPONSE_FIXTURES.unavailable.body,
      error: { code: 'UNKNOWN' },
    }],
  ])('rejects a %s session payload', (_name, body) => {
    expect(sessionResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects malformed or overexposed authenticated user fields', () => {
    const authenticatedBody = SESSION_RESPONSE_FIXTURES.authenticated.body;
    const user = authenticatedBody.user;
    const unsafeUsers = [
      { ...user, id: 'not-a-uuid' },
      { ...user, email: 'not-an-email' },
      { ...user, role: 'owner' },
      { ...user, app_metadata: {} },
    ];

    unsafeUsers.forEach((unsafeUser) => {
      expect(sessionResponseSchema.safeParse({
        ...authenticatedBody,
        user: unsafeUser,
      }).success).toBe(false);
    });
  });

  it('accepts every exact sign-out fixture and rejects each body on a wrong status', () => {
    Object.values(SIGNOUT_RESPONSE_FIXTURES).forEach((response) => {
      const { body } = response;
      const wrongStatus = response.httpStatus === 200 ? 403 : 200;

      expect(signoutResponseSchema.safeParse(body).success).toBe(true);
      expect(signoutHttpResponseSchema.safeParse(response).success).toBe(true);
      expect(signoutHttpResponseSchema.safeParse({
        ...response,
        httpStatus: wrongStatus,
      }).success).toBe(false);
    });
  });

  it.each([
    ['complete body on rejection status', {
      ...SIGNOUT_RESPONSE_FIXTURES.completeConfirmed,
      httpStatus: 403,
    }],
    ['rejected body on success status', {
      ...SIGNOUT_RESPONSE_FIXTURES.rejectedForbidden,
      httpStatus: 200,
    }],
    ['method rejection without Allow', {
      ...SIGNOUT_RESPONSE_FIXTURES.rejectedMethod,
      headers: { 'cache-control': PRIVATE_NO_STORE },
    }],
  ])('rejects a mismatched %s sign-out HTTP contract', (_name, response) => {
    expect(signoutHttpResponseSchema.safeParse(response).success).toBe(false);
  });

  it.each([
    ['legacy envelope', { data: null, error: null }],
    ['string version', { ...SIGNOUT_RESPONSE_FIXTURES.localOnly.body, version: '2' }],
    ['missing cleanup proof', {
      version: 2,
      status: 'complete',
      remoteTermination: 'confirmed',
    }],
    ['false cleanup proof', {
      ...SIGNOUT_RESPONSE_FIXTURES.completeConfirmed.body,
      localCleanupIssued: false,
    }],
    ['invalid remote result', {
      ...SIGNOUT_RESPONSE_FIXTURES.completeConfirmed.body,
      remoteTermination: 'global',
    }],
    ['extra field', { ...SIGNOUT_RESPONSE_FIXTURES.localOnly.body, message: 'ok' }],
  ])('rejects a %s sign-out payload', (_name, body) => {
    expect(signoutResponseSchema.safeParse(body).success).toBe(false);
  });

  it('freezes the approved terminal account contract and sole recovery action', () => {
    expect(SESSION_RESPONSE_FIXTURES.terminalUserBanned).toEqual({
      httpStatus: 403,
      headers: { 'cache-control': 'private, no-store' },
      body: {
        version: 2,
        status: 'terminal_unauthenticated',
        error: { code: 'ACCOUNT_ACCESS_RESTRICTED' },
      },
    });
    expect(TERMINAL_USER_BANNED_UI).toEqual({
      title: 'Account access unavailable',
      copy: 'This account can\u2019t access Track The App. Contact support if you think this is a mistake.',
      recoveryHref: 'mailto:tracktheapp.support@gmail.com',
      exposesOrdinarySignIn: false,
    });
    expect(TERMINAL_USER_BANNED_APPROVAL).toEqual({
      approved: true,
      approvedBy: 'repository_owner',
      approvedOn: '2026-08-12',
      approvalSource: 'phase_3_implementation_authorization',
      publicSupportMailboxApproved: true,
    });
  });

  it('enumerates all seven mutually exclusive client auth states', () => {
    expect(Object.values(AUTH_STATUS)).toEqual([
      'loading',
      'authenticated',
      'anonymous',
      'unavailable',
      'signed_out_local',
      'logout_unconfirmed',
      'terminal_unauthenticated',
    ]);
  });

  it('freezes the state transitions that dispose subjects and lock private work', () => {
    expect(AUTH_STATE_TRANSITION_FIXTURES).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'new_subject_verified',
        from: 'authenticated',
        to: 'authenticated',
        clearsOldSubjectFirst: true,
      }),
      expect.objectContaining({
        event: 'session_unavailable',
        from: 'authenticated',
        to: 'unavailable',
        stopsPrivateWork: true,
      }),
      expect.objectContaining({
        event: 'logout_ambiguous',
        to: 'logout_unconfirmed',
        requestPending: false,
      }),
      expect.objectContaining({
        event: 'same_subject_role_demoted',
        clearsPrivilegedStateFirst: true,
      }),
      expect.objectContaining({
        event: 'logout_local_only',
        to: 'signed_out_local',
        immediateVerificationRequired: true,
        exposesOrdinarySignIn: false,
      }),
      expect.objectContaining({
        event: 'session_user',
        from: 'signed_out_local',
        to: 'logout_unconfirmed',
      }),
      expect.objectContaining({
        event: 'user_banned',
        from: 'signed_out_local',
        to: 'terminal_unauthenticated',
        clearsOldSubjectFirst: true,
        exposesOrdinarySignIn: false,
      }),
    ]));

    const terminalTransitions = AUTH_STATE_TRANSITION_FIXTURES.filter(
      ({ to }) => to === 'terminal_unauthenticated'
    );
    const transitionKeys = AUTH_STATE_TRANSITION_FIXTURES.map(
      ({ event, from }) => `${event}|${from ?? '<missing>'}`
    );
    expect(new Set(transitionKeys).size).toBe(AUTH_STATE_TRANSITION_FIXTURES.length);
    expect(terminalTransitions).toHaveLength(4);
    terminalTransitions.forEach((transition) => {
      expect(transition.exposesOrdinarySignIn).toBe(false);
      if (transition.from !== 'loading') {
        expect(transition.clearsOldSubjectFirst).toBe(true);
      }
    });
  });

  it('freezes bounded subject/job/work-epoch draft quarantine without auto replay', () => {
    expect(QUARANTINED_DRAFT_POLICY).toEqual({
      persistence: 'memory',
      scope: 'one_per_tab',
      maxUtf8Bytes: 4096,
      maxAgeMs: 1_800_000,
      sizeEncoding: 'utf-8',
      binding: ['subjectId', 'jobId', 'workEpoch'],
      autoReplay: false,
      restoreRequires: [
        'same_subject_verified',
        'same_job',
        'same_work_epoch',
        'fresh_server_data_loaded',
        'explicit_user_action',
      ],
      purgeOn: [
        'expiry',
        'confirmed_anonymous',
        'logout',
        'terminal_unauthenticated',
        'subject_replacement',
        'authorization_epoch_change',
        'provider_teardown',
      ],
      fields: {
        companyMaxCharacters: 100,
        positionMaxCharacters: 100,
        notesMaxCharacters: 250,
        allowedStatuses: ['applied', 'interviewing', 'offered', 'rejected', 'accepted'],
        salaryNullable: true,
        salaryMax: 10_000_000,
      },
    });
  });

  it('measures canonical serialized draft JSON at the exact UTF-8 boundary', () => {
    const encoder = new TextEncoder();
    const emptyDraft = {
      company: '',
      position: '',
      status: 'applied',
      salary: null,
      notes: '',
    };
    const emptyBytes = encoder.encode(JSON.stringify(emptyDraft)).length;
    const exactBoundary = {
      ...emptyDraft,
      company: 'x'.repeat(QUARANTINED_DRAFT_POLICY.maxUtf8Bytes - emptyBytes),
    };
    const beyondBoundary = {
      ...exactBoundary,
      company: `${exactBoundary.company}é`,
    };

    expect(Object.keys(exactBoundary)).toEqual(QUARANTINED_DRAFT_CANONICAL_KEYS);
    expect(encoder.encode(JSON.stringify(exactBoundary))).toHaveLength(4096);
    expect(encoder.encode(JSON.stringify(beyondBoundary))).toHaveLength(4098);
  });

  it('freezes exact role normalization without trimming or case folding', () => {
    expect(ROLE_NORMALIZATION_FIXTURES).toStrictEqual([
      { raw: undefined, result: 'user' },
      { raw: null, result: 'user' },
      { raw: 'user', result: 'user' },
      { raw: 'admin', result: 'admin' },
      { raw: 'Admin', result: 'unavailable' },
      { raw: '', result: 'unavailable' },
      { raw: 1, result: 'unavailable' },
      { raw: [], result: 'unavailable' },
      { raw: {}, result: 'unavailable' },
    ]);
  });

  it('keeps remote Supabase candidates disabled until deployed evidence exists', () => {
    expect(SESSION_ERROR_EVIDENCE).not.toHaveProperty('deployedCapture');
    expect(SESSION_ERROR_EVIDENCE.locallyVerified).toStrictEqual([{
      source: 'installed_sdk_source',
      exportedClass: 'AuthSessionMissingError',
      code: undefined,
      status: 400,
      disposition: 'anonymous',
    }]);
    expect(SESSION_ERROR_EVIDENCE.deployedCandidates).toContain('session_not_found');
    expect(SESSION_ERROR_EVIDENCE.deployedCandidates).toContain('user_banned');
    expect(SESSION_ERROR_EVIDENCE.deployedAllowlist).toEqual([]);
  });

  it('records only sanitized behavior from the installed Supabase sources', () => {
    expect(INSTALLED_SUPABASE_EVIDENCE).toStrictEqual({
      authJsVersion: '2.90.1',
      ssrVersion: '0.8.0',
      missingSession: {
        exportedClass: 'AuthSessionMissingError',
        code: undefined,
        status: 400,
      },
      signout: {
        defaultScope: 'global',
        suppressedRemoteStatuses: [401, 403, 404],
      },
      chunker: {
        encoding: 'encodeURIComponent',
        encodedCharacterLimit: 3180,
      },
    });
  });

  it('freezes the exact cookie namespace while leaving its evidence-dependent cap unresolved', () => {
    expect(AUTH_COOKIE_STORAGE_KEY).toBe('sb-apxfjggdcybjticrnbpk-auth-token');
    expect(SUPABASE_ENCODED_CHUNK_SIZE).toBe(3180);
    expect(MAX_AUTH_COOKIE_CHUNKS).toEqual({
      status: 'unresolved',
      value: null,
      owner: 'CHUNK-2',
      evidenceRequired: 'installed_createChunks_largest_legitimate_deployed_session',
    });
    expect(Number.isInteger(MAX_AUTH_COOKIE_CHUNKS)).toBe(false);
  });

  it('freezes the non-simple logout intent and source-proof decision table', () => {
    expect([LOGOUT_INTENT_HEADER, LOGOUT_INTENT_VALUE]).toEqual(['X-Logout-Intent', '1']);
    expect(LOGOUT_INTENT_DECISION_FIXTURES.filter(({ accepted }) => accepted)).toHaveLength(1);
    expect(LOGOUT_INTENT_DECISION_FIXTURES.filter(({ accepted }) => !accepted)).toHaveLength(4);
    expect(LOGOUT_SOURCE_DECISION_FIXTURES.filter(({ accepted }) => accepted)).toHaveLength(4);
    expect(LOGOUT_SOURCE_DECISION_FIXTURES.filter(({ accepted }) => !accepted)).toHaveLength(11);
    expect(LOGOUT_REQUEST_BODY_FIXTURES.accepted).toEqual([
      { name: 'zero-byte body', contentType: null, body: undefined, byteLength: 0 },
      { name: 'empty JSON object', contentType: 'application/json', body: {}, byteLength: 2 },
    ]);
    expect(LOGOUT_REQUEST_BODY_FIXTURES.rejected).toHaveLength(3);
    expect(LOGOUT_REJECTED_SIDE_EFFECTS).toEqual({
      supabaseCalls: 0,
      redisCalls: 0,
      authCookieMutations: 0,
      csrfMutations: 0,
    });
  });

  it('keeps protected, public, and unmatched route sets disjoint', () => {
    const allRoutes = Object.values(ROUTE_CLASSIFICATION_FIXTURES).flat();

    expect(new Set(allRoutes).size).toBe(allRoutes.length);
    expect(ROUTABLE_PAGE_POLICY_FIXTURES.protected).toEqual(expect.arrayContaining([
      '/billing/cancel',
      '/billing/success',
      '/admin/users/[id]',
    ]));
    expect(ROUTE_CLASSIFICATION_FIXTURES.unmatched).toEqual(expect.arrayContaining([
      '/administrator',
      '/billing-example',
      '/%61dmin',
      '/%62illing',
      '/%34%30%33',
      '/403%2Fdetails',
    ]));
    expect(ROUTE_CLASSIFICATION_FIXTURES.rawRejected).toHaveLength(7);
  });

  /**
   * Prevents the independently maintained route fixtures from silently drifting.
   */
  it('keeps the two public route sources in agreement', () => {
    expect([...ROUTABLE_PAGE_POLICY_FIXTURES.public].sort()).toEqual(
      [...ROUTE_CLASSIFICATION_FIXTURES.public].sort()
    );
    expect(ROUTE_CLASSIFICATION_FIXTURES.protected).toEqual(
      expect.arrayContaining(ROUTABLE_PAGE_POLICY_FIXTURES.protected)
    );
  });

  it('freezes all seven states and one reset strategy for every auth consumer', () => {
    const expectedStates = Object.values(AUTH_STATUS).sort();

    expect(AUTH_CONSUMER_STATE_MATRIX).toHaveLength(7);
    AUTH_CONSUMER_STATE_MATRIX.forEach(({ resetStrategy, source, states }) => {
      expect(Object.keys(states).sort()).toEqual(expectedStates);
      expect(Object.values(states).every(Boolean)).toBe(true);
      expect(resetStrategy).toEqual(expect.any(String));
      expect(source).toMatch(/^src\//);
    });
  });

  it('records every approved auth-capable cache path exactly once', () => {
    const ids = AUTH_CAPABLE_CACHE_INVENTORY.map(({ id }) => id);

    expect(new Set(ids).size).toBe(AUTH_CAPABLE_CACHE_INVENTORY.length);
    expect(AUTH_CAPABLE_CACHE_INVENTORY).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'v2_session',
        source: 'future:/api/auth/v2/session',
        outcomes: ['200', '403', '405', '429', '503'],
      }),
      expect.objectContaining({
        id: 'v2_signout',
        source: 'future:/api/auth/v2/signout',
        outcomes: ['accepted', 'rejected', 'degraded'],
      }),
    ]));
    AUTH_CAPABLE_CACHE_INVENTORY.forEach(({
      dependencies,
      entryPoint,
      outcomes,
      owner,
      source,
    }) => {
      expect(entryPoint).toEqual(expect.any(String));
      expect(outcomes.length).toBeGreaterThan(0);
      expect(owner).toMatch(/^CHUNK-\d+$/);
      expect(dependencies).toEqual(expect.any(Array));
      dependencies.forEach((dependency) => expect(dependency).toMatch(/^CHUNK-\d+$/));
      expect(source).toEqual(expect.any(String));
    });
  });
});
