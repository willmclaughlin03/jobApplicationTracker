/**
 * Canonical CHUNK-0 fixtures for the future v2 authentication contracts.
 *
 * Purpose: Give every red regression suite one strict, test-only source of
 * truth without changing production behavior.
 * Connects to: the CHUNK-0 remediation review and the future v2 session and
 * sign-out endpoints.
 */

import { z } from 'zod';

const supabaseProjectRef = new URL(
  process.env.NEXT_PUBLIC_SUPABASE_URL
).hostname.split('.')[0];

export const AUTH_V2_VERSION = 2;
export const AUTH_COOKIE_STORAGE_KEY = `sb-${supabaseProjectRef}-auth-token`;
export const SUPABASE_ENCODED_CHUNK_SIZE = 3180;
export const MAX_AUTH_COOKIE_CHUNKS = null;
export const LOGOUT_INTENT_HEADER = 'X-Logout-Intent';
export const LOGOUT_INTENT_VALUE = '1';
export const TRUSTED_LOCAL_APP_ORIGIN = 'http://localhost:3000';
export const PRIVATE_NO_STORE = 'private, no-store';

export const LOGOUT_REJECTED_SIDE_EFFECTS = Object.freeze({
  supabaseCalls: 0,
  redisCalls: 0,
  authCookieMutations: 0,
  csrfMutations: 0,
});

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
  Object.freeze({ event: 'user_banned', from: AUTH_STATUS.LOADING, to: AUTH_STATUS.TERMINAL_UNAUTHENTICATED, exposesOrdinarySignIn: false }),
  Object.freeze({ event: 'same_subject_verified', from: AUTH_STATUS.AUTHENTICATED, to: AUTH_STATUS.AUTHENTICATED }),
  Object.freeze({ event: 'new_subject_verified', from: AUTH_STATUS.AUTHENTICATED, to: AUTH_STATUS.AUTHENTICATED, clearsOldSubjectFirst: true }),
  Object.freeze({ event: 'session_missing', from: AUTH_STATUS.AUTHENTICATED, to: AUTH_STATUS.ANONYMOUS, clearsOldSubjectFirst: true }),
  Object.freeze({ event: 'session_unavailable', from: AUTH_STATUS.AUTHENTICATED, to: AUTH_STATUS.UNAVAILABLE, stopsPrivateWork: true }),
  Object.freeze({ event: 'same_subject_role_demoted', from: AUTH_STATUS.AUTHENTICATED, to: AUTH_STATUS.AUTHENTICATED, clearsPrivilegedStateFirst: true }),
  Object.freeze({ event: 'user_banned', from: AUTH_STATUS.AUTHENTICATED, to: AUTH_STATUS.TERMINAL_UNAUTHENTICATED, clearsOldSubjectFirst: true, exposesOrdinarySignIn: false }),
  Object.freeze({ event: 'session_user', from: AUTH_STATUS.UNAVAILABLE, to: AUTH_STATUS.AUTHENTICATED }),
  Object.freeze({ event: 'session_missing', from: AUTH_STATUS.UNAVAILABLE, to: AUTH_STATUS.ANONYMOUS }),
  Object.freeze({ event: 'session_unavailable', from: AUTH_STATUS.UNAVAILABLE, to: AUTH_STATUS.UNAVAILABLE, stopsPrivateWork: true }),
  Object.freeze({ event: 'user_banned', from: AUTH_STATUS.UNAVAILABLE, to: AUTH_STATUS.TERMINAL_UNAUTHENTICATED, clearsOldSubjectFirst: true, exposesOrdinarySignIn: false }),
  Object.freeze({ event: 'logout_selected', from: AUTH_STATUS.AUTHENTICATED, to: AUTH_STATUS.LOGOUT_UNCONFIRMED, requestPending: true }),
  Object.freeze({ event: 'logout_selected', from: AUTH_STATUS.UNAVAILABLE, to: AUTH_STATUS.LOGOUT_UNCONFIRMED, requestPending: true }),
  Object.freeze({ event: 'logout_complete', from: AUTH_STATUS.LOGOUT_UNCONFIRMED, to: AUTH_STATUS.SIGNED_OUT_LOCAL, immediateVerificationRequired: true, exposesOrdinarySignIn: false }),
  Object.freeze({ event: 'logout_local_only', from: AUTH_STATUS.LOGOUT_UNCONFIRMED, to: AUTH_STATUS.SIGNED_OUT_LOCAL, immediateVerificationRequired: true, exposesOrdinarySignIn: false }),
  Object.freeze({ event: 'logout_ambiguous', from: AUTH_STATUS.LOGOUT_UNCONFIRMED, to: AUTH_STATUS.LOGOUT_UNCONFIRMED, requestPending: false }),
  Object.freeze({ event: 'logout_retry_selected', from: AUTH_STATUS.LOGOUT_UNCONFIRMED, to: AUTH_STATUS.LOGOUT_UNCONFIRMED, requestPending: true }),
  Object.freeze({ event: 'session_missing', from: AUTH_STATUS.SIGNED_OUT_LOCAL, to: AUTH_STATUS.ANONYMOUS }),
  Object.freeze({ event: 'session_user', from: AUTH_STATUS.SIGNED_OUT_LOCAL, to: AUTH_STATUS.LOGOUT_UNCONFIRMED }),
  Object.freeze({ event: 'session_unavailable', from: AUTH_STATUS.SIGNED_OUT_LOCAL, to: AUTH_STATUS.UNAVAILABLE }),
  Object.freeze({ event: 'user_banned', from: AUTH_STATUS.SIGNED_OUT_LOCAL, to: AUTH_STATUS.TERMINAL_UNAUTHENTICATED, clearsOldSubjectFirst: true, exposesOrdinarySignIn: false }),
]);

export const QUARANTINED_DRAFT_POLICY = Object.freeze({
  persistence: 'memory',
  scope: 'one_per_tab',
  maxUtf8Bytes: 4096,
  maxAgeMs: 30 * 60 * 1000,
  sizeEncoding: 'utf-8',
  binding: Object.freeze(['subjectId', 'jobId', 'workEpoch']),
  autoReplay: false,
  restoreRequires: Object.freeze([
    'same_subject_verified',
    'same_job',
    'same_work_epoch',
    'fresh_server_data_loaded',
    'explicit_user_action',
  ]),
  purgeOn: Object.freeze([
    'expiry',
    'confirmed_anonymous',
    'logout',
    'terminal_unauthenticated',
    'subject_replacement',
    'authorization_epoch_change',
    'provider_teardown',
  ]),
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

export const QUARANTINED_DRAFT_CANONICAL_KEYS = Object.freeze([
  'company',
  'position',
  'status',
  'salary',
  'notes',
]);

const PRIVATE_RESPONSE_HEADERS = Object.freeze({
  'cache-control': PRIVATE_NO_STORE,
});

const RATE_LIMITED_RESPONSE_HEADERS = Object.freeze({
  'cache-control': PRIVATE_NO_STORE,
  'retry-after': '60',
});

const SESSION_METHOD_RESPONSE_HEADERS = Object.freeze({
  'cache-control': PRIVATE_NO_STORE,
  allow: 'GET',
});

export const SAFE_USER_FIXTURE = Object.freeze({
  id: '00000000-0000-4000-8000-000000000001',
  email: null,
  role: 'user',
});

export const SESSION_RESPONSE_FIXTURES = Object.freeze({
  authenticated: Object.freeze({
    httpStatus: 200,
    headers: PRIVATE_RESPONSE_HEADERS,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: AUTH_STATUS.AUTHENTICATED,
      user: SAFE_USER_FIXTURE,
    }),
  }),
  anonymous: Object.freeze({
    httpStatus: 200,
    headers: PRIVATE_RESPONSE_HEADERS,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: AUTH_STATUS.ANONYMOUS,
      user: null,
    }),
  }),
  unavailable: Object.freeze({
    httpStatus: 503,
    headers: PRIVATE_RESPONSE_HEADERS,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: AUTH_STATUS.UNAVAILABLE,
      error: Object.freeze({ code: 'SESSION_UNAVAILABLE' }),
    }),
  }),
  rateLimited: Object.freeze({
    httpStatus: 429,
    headers: RATE_LIMITED_RESPONSE_HEADERS,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: AUTH_STATUS.UNAVAILABLE,
      error: Object.freeze({ code: 'RATE_LIMITED' }),
    }),
  }),
  terminalUserBanned: Object.freeze({
    httpStatus: 403,
    headers: PRIVATE_RESPONSE_HEADERS,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: AUTH_STATUS.TERMINAL_UNAUTHENTICATED,
      error: Object.freeze({ code: 'ACCOUNT_ACCESS_RESTRICTED' }),
    }),
  }),
  rejectedMethod: Object.freeze({
    httpStatus: 405,
    headers: SESSION_METHOD_RESPONSE_HEADERS,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: AUTH_STATUS.UNAVAILABLE,
      error: Object.freeze({ code: 'SESSION_UNAVAILABLE' }),
    }),
  }),
});

export const TERMINAL_USER_BANNED_UI = Object.freeze({
  title: 'Account access unavailable',
  copy: 'This account can\u2019t access Track The App. Contact support if you think this is a mistake.',
  recoveryHref: 'mailto:tracktheapp.support@gmail.com',
  exposesOrdinarySignIn: false,
});

export const TERMINAL_USER_BANNED_APPROVAL = Object.freeze({
  approved: true,
  approvedBy: 'repository_owner',
  approvedOn: '2026-08-09',
  publicSupportMailboxApproved: true,
});

export const SIGNOUT_RESPONSE_FIXTURES = Object.freeze({
  completeConfirmed: Object.freeze({
    httpStatus: 200,
    headers: PRIVATE_RESPONSE_HEADERS,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: 'complete',
      localCleanupIssued: true,
      remoteTermination: 'confirmed',
    }),
  }),
  completeAlreadyInvalid: Object.freeze({
    httpStatus: 200,
    headers: PRIVATE_RESPONSE_HEADERS,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: 'complete',
      localCleanupIssued: true,
      remoteTermination: 'already_invalid',
    }),
  }),
  completeNotNeeded: Object.freeze({
    httpStatus: 200,
    headers: PRIVATE_RESPONSE_HEADERS,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: 'complete',
      localCleanupIssued: true,
      remoteTermination: 'not_needed',
    }),
  }),
  localOnly: Object.freeze({
    httpStatus: 200,
    headers: PRIVATE_RESPONSE_HEADERS,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: 'local_only',
      localCleanupIssued: true,
      remoteTermination: 'unconfirmed',
    }),
  }),
  rejectedBadRequest: Object.freeze({
    httpStatus: 400,
    headers: PRIVATE_RESPONSE_HEADERS,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: 'rejected',
      error: Object.freeze({ code: 'LOGOUT_REQUEST_REJECTED' }),
    }),
  }),
  rejectedForbidden: Object.freeze({
    httpStatus: 403,
    headers: PRIVATE_RESPONSE_HEADERS,
    body: Object.freeze({
      version: AUTH_V2_VERSION,
      status: 'rejected',
      error: Object.freeze({ code: 'LOGOUT_REQUEST_REJECTED' }),
    }),
  }),
  rejectedMethod: Object.freeze({
    httpStatus: 405,
    headers: Object.freeze({
      'cache-control': PRIVATE_NO_STORE,
      allow: 'POST',
    }),
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
    name: 'all present source proofs agree',
    headers: Object.freeze({
      'sec-fetch-site': 'same-origin',
      origin: TRUSTED_LOCAL_APP_ORIGIN,
      referer: `${TRUSTED_LOCAL_APP_ORIGIN}/account`,
    }),
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
    name: 'valid fetch metadata with hostile referer',
    headers: Object.freeze({
      'sec-fetch-site': 'same-origin',
      referer: 'https://untrusted.invalid/account',
    }),
    accepted: false,
  }),
  Object.freeze({
    name: 'matching origin with hostile referer',
    headers: Object.freeze({
      origin: TRUSTED_LOCAL_APP_ORIGIN,
      referer: 'https://untrusted.invalid/account',
    }),
    accepted: false,
  }),
  Object.freeze({
    name: 'unexpected fetch metadata with matching origin',
    headers: Object.freeze({
      'sec-fetch-site': 'none',
      origin: TRUSTED_LOCAL_APP_ORIGIN,
    }),
    accepted: false,
  }),
  Object.freeze({
    name: 'array-valued fetch metadata',
    headers: Object.freeze({
      'sec-fetch-site': Object.freeze(['same-origin', 'same-origin']),
    }),
    accepted: false,
  }),
  Object.freeze({
    name: 'array-valued origin',
    headers: Object.freeze({
      origin: Object.freeze([TRUSTED_LOCAL_APP_ORIGIN, TRUSTED_LOCAL_APP_ORIGIN]),
    }),
    accepted: false,
  }),
  Object.freeze({
    name: 'array-valued referer',
    headers: Object.freeze({
      referer: Object.freeze([
        `${TRUSTED_LOCAL_APP_ORIGIN}/account`,
        `${TRUSTED_LOCAL_APP_ORIGIN}/account`,
      ]),
    }),
    accepted: false,
  }),
  Object.freeze({
    name: 'host without browser source proof',
    headers: Object.freeze({ host: 'localhost:3000' }),
    accepted: false,
  }),
]);

export const LOGOUT_INTENT_DECISION_FIXTURES = Object.freeze([
  Object.freeze({ name: 'exact intent', value: LOGOUT_INTENT_VALUE, accepted: true }),
  Object.freeze({ name: 'missing intent', value: undefined, accepted: false }),
  Object.freeze({ name: 'empty intent', value: '', accepted: false }),
  Object.freeze({ name: 'wrong intent', value: '2', accepted: false }),
  Object.freeze({
    name: 'array-valued intent',
    value: Object.freeze([LOGOUT_INTENT_VALUE, LOGOUT_INTENT_VALUE]),
    accepted: false,
  }),
]);

export const LOGOUT_REQUEST_BODY_FIXTURES = Object.freeze({
  accepted: Object.freeze([
    Object.freeze({ name: 'zero-byte body', contentType: null, body: undefined, byteLength: 0 }),
    Object.freeze({ name: 'empty JSON object', contentType: 'application/json', body: Object.freeze({}), byteLength: 2 }),
  ]),
  rejected: Object.freeze([
    Object.freeze({ name: 'unexpected JSON field', contentType: 'application/json', body: Object.freeze({ unexpected: true }), byteLength: 19 }),
    Object.freeze({ name: 'text body', contentType: 'text/plain', body: '', byteLength: 0 }),
    Object.freeze({ name: 'JSON null', contentType: 'application/json', body: null, byteLength: 4 }),
  ]),
});

export const ROUTE_CLASSIFICATION_FIXTURES = Object.freeze({
  protected: Object.freeze([
    '/',
    '/billing',
    '/billing/cancel',
    '/billing/success',
    '/billing/history',
    '/admin',
    '/admin/users',
    '/admin/users/[id]',
    '/admin/users/example',
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
    '/administrator',
    '/billing-example',
    '/%61dmin',
    '/%62illing',
    '/403/details',
    '/404/details',
    '/429/details',
    '/500/details',
    '/502/details',
    '/503/details',
    '/504/details',
    '/%34%30%33',
    '/%34%30%34',
    '/%34%32%39',
    '/%35%30%30',
    '/%35%30%32',
    '/%35%30%33',
    '/%35%30%34',
    '/403%2Fdetails',
    '/auth/callback-extra',
  ]),
  rawRejected: Object.freeze([
    '/403?source=test',
    '/404?source=test',
    '/429?source=test',
    '/500?source=test',
    '/502?source=test',
    '/503?source=test',
    '/504?source=test',
  ]),
});

export const ROUTABLE_PAGE_POLICY_FIXTURES = Object.freeze({
  protected: Object.freeze([
    '/',
    '/admin',
    '/admin/users',
    '/admin/users/[id]',
    '/billing',
    '/billing/cancel',
    '/billing/success',
  ]),
  public: Object.freeze([
    '/403',
    '/404',
    '/429',
    '/500',
    '/502',
    '/503',
    '/504',
    '/auth/callback',
    '/login',
  ]),
});

export const AUTH_CONSUMER_STATE_MATRIX = Object.freeze([
  Object.freeze({
    id: 'dashboard',
    source: 'src/pages/index.js',
    resetStrategy: 'work_epoch_remount_and_subject_cache_clear',
    states: Object.freeze({
      loading: 'loading_shell',
      authenticated: 'authorized_private_work',
      anonymous: 'login_redirect',
      unavailable: 'unavailable_shell',
      signed_out_local: 'signed_out_local_shell',
      logout_unconfirmed: 'locked_logout_shell',
      terminal_unauthenticated: 'terminal_account_shell',
    }),
  }),
  Object.freeze({
    id: 'login',
    source: 'src/pages/login.js',
    resetStrategy: 'provider_state_replaces_login_surface',
    states: Object.freeze({
      loading: 'loading_shell',
      authenticated: 'authenticated_redirect',
      anonymous: 'ordinary_sign_in_controls',
      unavailable: 'unavailable_shell',
      signed_out_local: 'signed_out_local_shell',
      logout_unconfirmed: 'locked_logout_shell',
      terminal_unauthenticated: 'terminal_account_shell',
    }),
  }),
  Object.freeze({
    id: 'billing_index',
    source: 'src/pages/billing/index.js',
    resetStrategy: 'work_epoch_remount_and_action_latch_reset',
    states: Object.freeze({
      loading: 'loading_shell',
      authenticated: 'authorized_private_work',
      anonymous: 'login_redirect',
      unavailable: 'unavailable_shell',
      signed_out_local: 'signed_out_local_shell',
      logout_unconfirmed: 'locked_logout_shell',
      terminal_unauthenticated: 'terminal_account_shell',
    }),
  }),
  Object.freeze({
    id: 'billing_success',
    source: 'src/pages/billing/success.js',
    resetStrategy: 'work_epoch_remount_and_polling_cancel',
    states: Object.freeze({
      loading: 'loading_shell',
      authenticated: 'authorized_private_work',
      anonymous: 'login_redirect',
      unavailable: 'unavailable_shell',
      signed_out_local: 'signed_out_local_shell',
      logout_unconfirmed: 'locked_logout_shell',
      terminal_unauthenticated: 'terminal_account_shell',
    }),
  }),
  Object.freeze({
    id: 'admin_index',
    source: 'src/pages/admin/index.js',
    resetStrategy: 'route_gate_recomputed_from_discriminant',
    states: Object.freeze({
      loading: 'loading_shell',
      authenticated: 'role_checked_redirect',
      anonymous: 'login_redirect',
      unavailable: 'unavailable_shell',
      signed_out_local: 'signed_out_local_shell',
      logout_unconfirmed: 'locked_logout_shell',
      terminal_unauthenticated: 'terminal_account_shell',
    }),
  }),
  Object.freeze({
    id: 'admin_users',
    source: 'src/pages/admin/users.js',
    resetStrategy: 'work_epoch_remount_and_admin_cache_clear',
    states: Object.freeze({
      loading: 'loading_shell',
      authenticated: 'role_checked_private_work',
      anonymous: 'login_redirect',
      unavailable: 'unavailable_shell',
      signed_out_local: 'signed_out_local_shell',
      logout_unconfirmed: 'locked_logout_shell',
      terminal_unauthenticated: 'terminal_account_shell',
    }),
  }),
  Object.freeze({
    id: 'admin_user_detail',
    source: 'src/pages/admin/users/[id].js',
    resetStrategy: 'work_epoch_remount_and_selected_user_clear',
    states: Object.freeze({
      loading: 'loading_shell',
      authenticated: 'role_checked_private_work',
      anonymous: 'login_redirect',
      unavailable: 'unavailable_shell',
      signed_out_local: 'signed_out_local_shell',
      logout_unconfirmed: 'locked_logout_shell',
      terminal_unauthenticated: 'terminal_account_shell',
    }),
  }),
]);

export const AUTH_CAPABLE_CACHE_INVENTORY = Object.freeze([
  Object.freeze({ id: 'api_route_adapter', source: 'src/server/lib/supabaseApiRoute.js', entryPoint: 'createApiRouteClient', outcomes: Object.freeze(['construction']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'server_auth_adapter', source: 'src/server/lib/supabaseServer.js', entryPoint: 'getUserFromRequest', outcomes: Object.freeze(['authenticated', 'anonymous', 'provider_error', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'protected_api_wrapper', source: 'src/server/middleware/withRateLimit.js', entryPoint: 'withRateLimit', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'jobs_collection_api', source: 'src/pages/api/index.js', entryPoint: 'default', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'job_item_api', source: 'src/pages/api/[id].js', entryPoint: 'default', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'admin_users_api', source: 'src/pages/api/admin/users/index.js', entryPoint: 'default', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'admin_user_api', source: 'src/pages/api/admin/users/[id].js', entryPoint: 'default', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'admin_user_role_api', source: 'src/pages/api/admin/users/[id]/role.js', entryPoint: 'default', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'csrf_api', source: 'src/pages/api/auth/csrf.js', entryPoint: 'default', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'billing_checkout_status_api', source: 'src/pages/api/billing/checkout-status.js', entryPoint: 'default', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'billing_checkout_api', source: 'src/pages/api/billing/checkout.js', entryPoint: 'default', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'billing_portal_api', source: 'src/pages/api/billing/portal.js', entryPoint: 'default', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'billing_status_api', source: 'src/pages/api/billing/status.js', entryPoint: 'default', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'storage_export_api', source: 'src/pages/api/storage/export.js', entryPoint: 'default', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'storage_locked_jobs_api', source: 'src/pages/api/storage/locked-jobs.js', entryPoint: 'default', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'storage_status_api', source: 'src/pages/api/storage/status.js', entryPoint: 'default', outcomes: Object.freeze(['method', 'limiter', 'auth', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'v1_session', source: 'src/pages/api/auth/session.js', entryPoint: 'default', outcomes: Object.freeze(['success', 'provider_error', 'exception']), owner: 'CHUNK-2', dependencies: Object.freeze(['CHUNK-6']) }),
  Object.freeze({ id: 'v1_signout', source: 'src/pages/api/auth/signout.js', entryPoint: 'default', outcomes: Object.freeze(['success', 'limiter', 'provider_error', 'exception']), owner: 'CHUNK-4', dependencies: Object.freeze(['CHUNK-6']) }),
  Object.freeze({ id: 'oauth_callback', source: 'src/pages/auth/callback.js', entryPoint: 'getServerSideProps', outcomes: Object.freeze(['validation_redirect', 'success_redirect', 'provider_error', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'admin_users_ssr', source: 'src/pages/admin/users.js', entryPoint: 'getServerSideProps', outcomes: Object.freeze(['anonymous_redirect', 'forbidden', 'success', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'edge_middleware', source: 'src/middleware.js', entryPoint: 'middleware', outcomes: Object.freeze(['next', 'redirect', 'exception']), owner: 'CHUNK-6', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'v2_session', source: 'future:/api/auth/v2/session', entryPoint: 'default', outcomes: Object.freeze(['200', '403', '405', '429', '503']), owner: 'CHUNK-2', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'v2_signout', source: 'future:/api/auth/v2/signout', entryPoint: 'default', outcomes: Object.freeze(['accepted', 'rejected', 'degraded']), owner: 'CHUNK-4', dependencies: Object.freeze(['CHUNK-2', 'CHUNK-3']) }),
]);

export const safeUserSchema = z.object({
  id: z.uuid(),
  email: z.email().nullable(),
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

const serviceUnavailableSessionSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_STATUS.UNAVAILABLE),
  error: z.object({
    code: z.literal('SESSION_UNAVAILABLE'),
  }).strict(),
}).strict();

const rateLimitedSessionSchema = z.object({
  version: z.literal(AUTH_V2_VERSION),
  status: z.literal(AUTH_STATUS.UNAVAILABLE),
  error: z.object({
    code: z.literal('RATE_LIMITED'),
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
  serviceUnavailableSessionSchema,
  rateLimitedSessionSchema,
  terminalSessionSchema,
]);

const privateResponseHeadersSchema = z.object({
  'cache-control': z.literal(PRIVATE_NO_STORE),
}).strict();

const rateLimitedResponseHeadersSchema = z.object({
  'cache-control': z.literal(PRIVATE_NO_STORE),
  'retry-after': z.string().regex(/^\d+$/),
}).strict();

const sessionMethodResponseHeadersSchema = z.object({
  'cache-control': z.literal(PRIVATE_NO_STORE),
  allow: z.literal('GET'),
}).strict();

export const sessionHttpResponseSchema = z.union([
  z.object({
    httpStatus: z.literal(200),
    headers: privateResponseHeadersSchema,
    body: authenticatedSessionSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(200),
    headers: privateResponseHeadersSchema,
    body: anonymousSessionSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(503),
    headers: privateResponseHeadersSchema,
    body: serviceUnavailableSessionSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(429),
    headers: rateLimitedResponseHeadersSchema,
    body: rateLimitedSessionSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(403),
    headers: privateResponseHeadersSchema,
    body: terminalSessionSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(405),
    headers: sessionMethodResponseHeadersSchema,
    body: serviceUnavailableSessionSchema,
  }).strict(),
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

const methodRejectedResponseHeadersSchema = z.object({
  'cache-control': z.literal(PRIVATE_NO_STORE),
  allow: z.literal('POST'),
}).strict();

export const signoutHttpResponseSchema = z.union([
  z.object({
    httpStatus: z.literal(200),
    headers: privateResponseHeadersSchema,
    body: completeSignoutSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(200),
    headers: privateResponseHeadersSchema,
    body: localOnlySignoutSchema,
  }).strict(),
  z.object({
    httpStatus: z.union([z.literal(400), z.literal(403)]),
    headers: privateResponseHeadersSchema,
    body: rejectedSignoutSchema,
  }).strict(),
  z.object({
    httpStatus: z.literal(405),
    headers: methodRejectedResponseHeadersSchema,
    body: rejectedSignoutSchema,
  }).strict(),
]);
