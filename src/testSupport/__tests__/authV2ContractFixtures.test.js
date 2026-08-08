/**
 * Integrity tests for the CHUNK-0 v2 authentication contract fixtures.
 *
 * Purpose: Prove the approved public schemas are strict and that unresolved
 * deployment evidence is not silently promoted into an allowlist.
 * Connects to: src/testSupport/authV2ContractFixtures.js.
 */

import {
  AUTH_CAPABLE_CACHE_INVENTORY,
  AUTH_COOKIE_STORAGE_KEY,
  AUTH_STATE_TRANSITION_FIXTURES,
  AUTH_STATUS,
  INSTALLED_SUPABASE_EVIDENCE,
  LOGOUT_INTENT_HEADER,
  LOGOUT_INTENT_VALUE,
  LOGOUT_REQUEST_BODY_FIXTURES,
  LOGOUT_SOURCE_DECISION_FIXTURES,
  MAX_AUTH_COOKIE_CHUNKS,
  QUARANTINED_DRAFT_POLICY,
  ROLE_NORMALIZATION_FIXTURES,
  ROUTE_CLASSIFICATION_FIXTURES,
  SESSION_ERROR_EVIDENCE,
  SESSION_RESPONSE_FIXTURES,
  SIGNOUT_RESPONSE_FIXTURES,
  SUPABASE_ENCODED_CHUNK_SIZE,
  TERMINAL_USER_BANNED_UI,
  sessionResponseSchema,
  signoutResponseSchema,
} from '../authV2ContractFixtures.js';

describe('CHUNK-0 auth v2 contract fixtures', () => {
  it('accepts every exact session fixture', () => {
    Object.values(SESSION_RESPONSE_FIXTURES).forEach(({ body }) => {
      expect(sessionResponseSchema.safeParse(body).success).toBe(true);
    });
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

  it('accepts every exact sign-out fixture', () => {
    Object.values(SIGNOUT_RESPONSE_FIXTURES).forEach(({ body }) => {
      expect(signoutResponseSchema.safeParse(body).success).toBe(true);
    });
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
    ]));
  });

  it('freezes bounded subject/job/work-epoch draft quarantine without auto replay', () => {
    expect(QUARANTINED_DRAFT_POLICY).toEqual({
      persistence: 'memory',
      scope: 'one_per_tab',
      maxUtf8Bytes: 4096,
      maxAgeMs: 1_800_000,
      binding: ['subjectId', 'jobId', 'workEpoch'],
      autoReplay: false,
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

  it('freezes exact role normalization without trimming or case folding', () => {
    expect(ROLE_NORMALIZATION_FIXTURES).toEqual([
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
    expect(SESSION_ERROR_EVIDENCE.locallyVerified).toEqual([{
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
    expect(INSTALLED_SUPABASE_EVIDENCE).toEqual({
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
    expect(MAX_AUTH_COOKIE_CHUNKS).toBeNull();
  });

  it('freezes the non-simple logout intent and source-proof decision table', () => {
    expect([LOGOUT_INTENT_HEADER, LOGOUT_INTENT_VALUE]).toEqual(['X-Logout-Intent', '1']);
    expect(LOGOUT_SOURCE_DECISION_FIXTURES.filter(({ accepted }) => accepted)).toHaveLength(3);
    expect(LOGOUT_SOURCE_DECISION_FIXTURES.filter(({ accepted }) => !accepted)).toHaveLength(5);
    expect(LOGOUT_REQUEST_BODY_FIXTURES.accepted).toHaveLength(2);
    expect(LOGOUT_REQUEST_BODY_FIXTURES.rejected).toHaveLength(3);
  });

  it('keeps protected, public, and unmatched route sets disjoint', () => {
    const allRoutes = Object.values(ROUTE_CLASSIFICATION_FIXTURES).flat();

    expect(new Set(allRoutes).size).toBe(allRoutes.length);
  });

  it('records every approved auth-capable cache path exactly once', () => {
    expect(new Set(AUTH_CAPABLE_CACHE_INVENTORY).size).toBe(AUTH_CAPABLE_CACHE_INVENTORY.length);
    expect(AUTH_CAPABLE_CACHE_INVENTORY).toContain('future:/api/auth/v2/session');
    expect(AUTH_CAPABLE_CACHE_INVENTORY).toContain('future:/api/auth/v2/signout');
  });
});
