/**
 * Canonical CHUNK-0 fixtures for the future v2 authentication contracts.
 *
 * Purpose: Give every red regression suite one strict, test-only source of
 * truth without changing production behavior.
 * Connects to: the CHUNK-0 remediation review and the future v2 session and
 * sign-out endpoints.
 */

import { z } from 'zod';

export const AUTH_V2_VERSION = 2;
export const AUTH_COOKIE_STORAGE_KEY = 'sb-apxfjggdcybjticrnbpk-auth-token';
export const SUPABASE_ENCODED_CHUNK_SIZE = 3180;
export const MAX_AUTH_COOKIE_CHUNKS = null;
export const LOGOUT_INTENT_HEADER = 'X-Logout-Intent';
export const LOGOUT_INTENT_VALUE = '1';
export const TRUSTED_LOCAL_APP_ORIGIN = 'http://localhost:3000';

export const AUTH_STATUS = Object.freeze({
  LOADING: 'loading',
  AUTHENTICATED: 'authenticated',
  ANONYMOUS: 'anonymous',
  UNAVAILABLE: 'unavailable',
  SIGNED_OUT_LOCAL: 'signed_out_local',
  LOGOUT_UNCONFIRMED: 'logout_unconfirmed',
  TERMINAL_UNAUTHENTICATED: 'terminal_unauthenticated',
});

export const AUTH_STATE_TRANSITION_FIXTURES = Object.freeze([
  Object.freeze({ event: 'application_start', from: null, to: AUTH_STATUS.LOADING }),
  Object.freeze({ event: 'session_user', from: AUTH_STATUS.LOADING, to: AUTH_STATUS.AUTHENTICATED }),
  Object.freeze({ event: 'session_missing', from: AUTH_STATUS.LOADING, to: AUTH_STATUS.ANONYMOUS }),
  Object.freeze({ event: 'session_unavailable', from: AUTH_STATUS.LOADING, to: AUTH_STATUS.UNAVAILABLE }),
  Object.freeze({ event: 'user_banned', from: AUTH_STATUS.LOADING, to: AUTH_STATUS.TERMINAL_UNAUTHENTICATED }),
  Object.freeze({ event: 'same_subject_verified', from: AUTH_STATUS.AUTHENTICATED, to: AUTH_STATUS.AUTHENTICATED }),
  Object.freeze({ event: 'new_subject_verified', from: AUTH_STATUS.AUTHENTICATED, to: AUTH_STATUS.AUTHENTICATED, clearsOldSubjectFirst: true }),
  Object.freeze({ event: 'session_missing', from: AUTH_STATUS.AUTHENTICATED, to: AUTH_STATUS.ANONYMOUS, clearsOldSubjectFirst: true }),
  Object.freeze({ event: 'session_unavailable', from: AUTH_STATUS.AUTHENTICATED, to: AUTH_STATUS.UNAVAILABLE, stopsPrivateWork: true }),
  Object.freeze({ event: 'logout_selected', from: AUTH_STATUS.AUTHENTICATED, to: AUTH_STATUS.LOGOUT_UNCONFIRMED, requestPending: true }),
  Object.freeze({ event: 'logout_selected', from: AUTH_STATUS.UNAVAILABLE, to: AUTH_STATUS.LOGOUT_UNCONFIRMED, requestPending: true }),
  Object.freeze({ event: 'logout_complete', from: AUTH_STATUS.LOGOUT_UNCONFIRMED, to: AUTH_STATUS.SIGNED_OUT_LOCAL }),
  Object.freeze({ event: 'logout_ambiguous', from: AUTH_STATUS.LOGOUT_UNCONFIRMED, to: AUTH_STATUS.LOGOUT_UNCONFIRMED, requestPending: false }),
  Object.freeze({ event: 'session_missing', from: AUTH_STATUS.SIGNED_OUT_LOCAL, to: AUTH_STATUS.ANONYMOUS }),
  Object.freeze({ event: 'session_user', from: AUTH_STATUS.SIGNED_OUT_LOCAL, to: AUTH_STATUS.LOGOUT_UNCONFIRMED }),
  Object.freeze({ event: 'session_unavailable', from: AUTH_STATUS.SIGNED_OUT_LOCAL, to: AUTH_STATUS.UNAVAILABLE }),
]);

export const QUARANTINED_DRAFT_POLICY = Object.freeze({
  persistence: 'memory',
  scope: 'one_per_tab',
  maxUtf8Bytes: 4096,
  maxAgeMs: 30 * 60 * 1000,
  binding: Object.freeze(['subjectId', 'jobId', 'workEpoch']),
  autoReplay: false,
  fields: Object.freeze({
    companyMaxCharacters: 100,
    positionMaxCharacters: 100,
    notesMaxCharacters: 250,
    allowedStatuses: Object.freeze([
      'applied',
      'interviewing',
      'offered',
      'rejected',
      'accepted',
    ]),
    salaryNullable: true,
    salaryMax: 10_000_000,
  }),
});

export const SAFE_USER_FIXTURE = Object.freeze({
  id: '00000000-0000-4000-8000-000000000001',
  email: null,
  role: 'user',
});

export const SESSION_RESPONSE_FIXTURES = Object.freeze({
  authenticated: Object.freeze({
    httpStatus: 200,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: AUTH_STATUS.AUTHENTICATED,
      user: SAFE_USER_FIXTURE,
    }),
  }),
  anonymous: Object.freeze({
    httpStatus: 200,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: AUTH_STATUS.ANONYMOUS,
      user: null,
    }),
  }),
  unavailable: Object.freeze({
    httpStatus: 503,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: AUTH_STATUS.UNAVAILABLE,
      error: Object.freeze({ code: 'SESSION_UNAVAILABLE' }),
    }),
  }),
  rateLimited: Object.freeze({
    httpStatus: 429,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: AUTH_STATUS.UNAVAILABLE,
      error: Object.freeze({ code: 'RATE_LIMITED' }),
    }),
  }),
  terminalUserBanned: Object.freeze({
    httpStatus: 403,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: AUTH_STATUS.TERMINAL_UNAUTHENTICATED,
      error: Object.freeze({ code: 'ACCOUNT_ACCESS_RESTRICTED' }),
    }),
  }),
});

export const TERMINAL_USER_BANNED_UI = Object.freeze({
  title: 'Account access unavailable',
  copy: 'This account can\u2019t access Track The App. Contact support if you think this is a mistake.',
  recoveryHref: 'mailto:tracktheapp.support@gmail.com',
  exposesOrdinarySignIn: false,
});

export const SIGNOUT_RESPONSE_FIXTURES = Object.freeze({
  completeConfirmed: Object.freeze({
    httpStatus: 200,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: 'complete',
      localCleanupIssued: true,
      remoteTermination: 'confirmed',
    }),
  }),
  completeAlreadyInvalid: Object.freeze({
    httpStatus: 200,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: 'complete',
      localCleanupIssued: true,
      remoteTermination: 'already_invalid',
    }),
  }),
  completeNotNeeded: Object.freeze({
    httpStatus: 200,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: 'complete',
      localCleanupIssued: true,
      remoteTermination: 'not_needed',
    }),
  }),
  localOnly: Object.freeze({
    httpStatus: 200,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: 'local_only',
      localCleanupIssued: true,
      remoteTermination: 'unconfirmed',
    }),
  }),
  rejectedBadRequest: Object.freeze({
    httpStatus: 400,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: 'rejected',
      error: Object.freeze({ code: 'LOGOUT_REQUEST_REJECTED' }),
    }),
  }),
  rejectedForbidden: Object.freeze({
    httpStatus: 403,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: 'rejected',
      error: Object.freeze({ code: 'LOGOUT_REQUEST_REJECTED' }),
    }),
  }),
  rejectedMethod: Object.freeze({
    httpStatus: 405,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: 'rejected',
      error: Object.freeze({ code: 'LOGOUT_REQUEST_REJECTED' }),
    }),
  }),
});

export const ROLE_NORMALIZATION_FIXTURES = Object.freeze([
  Object.freeze({ raw: undefined, result: 'user' }),
  Object.freeze({ raw: null, result: 'user' }),
  Object.freeze({ raw: 'user', result: 'user' }),
  Object.freeze({ raw: 'admin', result: 'admin' }),
  Object.freeze({ raw: 'Admin', result: 'unavailable' }),
  Object.freeze({ raw: '', result: 'unavailable' }),
  Object.freeze({ raw: 1, result: 'unavailable' }),
  Object.freeze({ raw: [], result: 'unavailable' }),
  Object.freeze({ raw: {}, result: 'unavailable' }),
]);

export const SESSION_ERROR_EVIDENCE = Object.freeze({
  locallyVerified: Object.freeze([
    Object.freeze({
      source: 'installed_sdk_source',
      exportedClass: 'AuthSessionMissingError',
      code: undefined,
      status: 400,
      disposition: AUTH_STATUS.ANONYMOUS,
    }),
  ]),
  deployedCandidates: Object.freeze([
    'bad_jwt',
    'session_expired',
    'session_not_found',
    'refresh_token_not_found',
    'refresh_token_already_used',
    'user_not_found',
    'user_banned',
  ]),
  deployedAllowlist: Object.freeze([]),
});

export const INSTALLED_SUPABASE_EVIDENCE = Object.freeze({
  authJsVersion: '2.90.1',
  ssrVersion: '0.8.0',
  missingSession: Object.freeze({
    exportedClass: 'AuthSessionMissingError',
    code: undefined,
    status: 400,
  }),
  signout: Object.freeze({
    defaultScope: 'global',
    suppressedRemoteStatuses: Object.freeze([401, 403, 404]),
  }),
  chunker: Object.freeze({
    encoding: 'encodeURIComponent',
    encodedCharacterLimit: 3180,
  }),
});

export const LOGOUT_SOURCE_DECISION_FIXTURES = Object.freeze([
  Object.freeze({
    name: 'same-origin fetch metadata',
    headers: Object.freeze({ 'sec-fetch-site': 'same-origin' }),
    accepted: true,
  }),
  Object.freeze({
    name: 'matching origin',
    headers: Object.freeze({ origin: TRUSTED_LOCAL_APP_ORIGIN }),
    accepted: true,
  }),
  Object.freeze({
    name: 'matching referer fallback',
    headers: Object.freeze({ referer: `${TRUSTED_LOCAL_APP_ORIGIN}/account` }),
    accepted: true,
  }),
  Object.freeze({
    name: 'no browser source proof',
    headers: Object.freeze({}),
    accepted: false,
  }),
  Object.freeze({
    name: 'cross-site fetch metadata',
    headers: Object.freeze({ 'sec-fetch-site': 'cross-site' }),
    accepted: false,
  }),
  Object.freeze({
    name: 'same-site fetch metadata',
    headers: Object.freeze({ 'sec-fetch-site': 'same-site' }),
    accepted: false,
  }),
  Object.freeze({
    name: 'contradictory origin and fetch metadata',
    headers: Object.freeze({
      'sec-fetch-site': 'same-origin',
      origin: 'https://untrusted.invalid',
    }),
    accepted: false,
  }),
  Object.freeze({
    name: 'host without browser source proof',
    headers: Object.freeze({ host: 'localhost:3000' }),
    accepted: false,
  }),
]);

export const LOGOUT_REQUEST_BODY_FIXTURES = Object.freeze({
  accepted: Object.freeze([
    Object.freeze({ contentType: null, body: undefined }),
    Object.freeze({ contentType: 'application/json', body: Object.freeze({}) }),
  ]),
  rejected: Object.freeze([
    Object.freeze({ contentType: 'application/json', body: Object.freeze({ unexpected: true }) }),
    Object.freeze({ contentType: 'text/plain', body: Object.freeze({}) }),
    Object.freeze({ contentType: 'application/json', body: null }),
  ]),
});

export const ROUTE_CLASSIFICATION_FIXTURES = Object.freeze({
  protected: Object.freeze([
    '/',
    '/billing',
    '/billing/history',
    '/admin',
    '/admin/users',
  ]),
  public: Object.freeze([
    '/login',
    '/auth/callback',
    '/403',
    '/404',
    '/429',
    '/500',
    '/502',
    '/503',
    '/504',
  ]),
  unmatched: Object.freeze([
    '/missing',
    '/account',
    '/403/details',
    '/auth/callback-extra',
  ]),
});

export const AUTH_CAPABLE_CACHE_INVENTORY = Object.freeze([
  'src/server/lib/supabaseApiRoute.js',
  'src/server/middleware/withRateLimit.js',
  'src/pages/api/auth/session.js',
  'src/pages/api/auth/signout.js',
  'src/pages/auth/callback.js#getServerSideProps',
  'src/pages/admin/users.js#getServerSideProps',
  'src/middleware.js',
  'future:/api/auth/v2/session',
  'future:/api/auth/v2/signout',
]);

export const safeUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email().nullable(),
  role: z.enum(['user', 'admin']),
}).strict();

const authenticatedSessionSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_STATUS.AUTHENTICATED),
  user: safeUserSchema,
}).strict();

const anonymousSessionSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_STATUS.ANONYMOUS),
  user: z.null(),
}).strict();

const unavailableSessionSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_STATUS.UNAVAILABLE),
  error: z.object({
    code: z.enum(['SESSION_UNAVAILABLE', 'RATE_LIMITED']),
  }).strict(),
}).strict();

const terminalSessionSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_STATUS.TERMINAL_UNAUTHENTICATED),
  error: z.object({
    code: z.literal('ACCOUNT_ACCESS_RESTRICTED'),
  }).strict(),
}).strict();

export const sessionResponseSchema = z.union([
  authenticatedSessionSchema,
  anonymousSessionSchema,
  unavailableSessionSchema,
  terminalSessionSchema,
]);

const completeSignoutSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal('complete'),
  localCleanupIssued: z.literal(true),
  remoteTermination: z.enum(['confirmed', 'already_invalid', 'not_needed']),
}).strict();

const localOnlySignoutSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal('local_only'),
  localCleanupIssued: z.literal(true),
  remoteTermination: z.literal('unconfirmed'),
}).strict();

const rejectedSignoutSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal('rejected'),
  error: z.object({
    code: z.literal('LOGOUT_REQUEST_REJECTED'),
  }).strict(),
}).strict();

export const signoutResponseSchema = z.union([
  completeSignoutSchema,
  localOnlySignoutSchema,
  rejectedSignoutSchema,
]);
