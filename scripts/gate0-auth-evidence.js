const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');

const EXPECTED_SUPABASE_PROJECT_REF = 'apxfjggdcybjticrnbpk';
const EXPECTED_SUPABASE_URL = `https://${EXPECTED_SUPABASE_PROJECT_REF}.supabase.co`;
const AUTH_COOKIE_STORAGE_KEY = `sb-${EXPECTED_SUPABASE_PROJECT_REF}-auth-token`;
const BASE64_COOKIE_PREFIX = 'base64-';
const GOOGLE_SESSION_FIXTURE_V1_INITIAL_LOGIN_CHUNKS = 6;
const GOOGLE_SESSION_FIXTURE_V1_REFRESHED_SESSION_CHUNKS = 5;
const EXPECTED_MAX_AUTH_COOKIE_CHUNKS = 6;
const GATE0_EVIDENCE_SCHEMA_VERSION = 1;
const FIXTURE_TIMESTAMP = '2026-08-13T12:00:00.000Z';
const FIXTURE_UNIX_SECONDS = 1_786_622_400;
const FIXTURE_USER_ID = '00000000-0000-4000-8000-000000000001';
const FIXTURE_IDENTITY_ID = '00000000-0000-4000-8000-000000000002';
const FIXTURE_SESSION_ID = '00000000-0000-4000-8000-000000000003';
const PREFLIGHT_NONEXISTENT_USER_ID = '00000000-0000-0000-0000-000000000000';

const GATE0_ENV_NAMES = Object.freeze({
  url: 'GATE0_SUPABASE_URL',
  publishableKey: 'GATE0_SUPABASE_PUBLISHABLE_KEY',
  secretKey: 'GATE0_SUPABASE_SECRET_KEY',
  managementToken: 'GATE0_SUPABASE_MANAGEMENT_TOKEN',
  projectRef: 'GATE0_SUPABASE_PROJECT_REF',
  destructiveOptIn: 'GATE0_AUTH_EVIDENCE_ALLOWED',
});

const FORBIDDEN_APPLICATION_ENV_NAMES = Object.freeze([
  'GATE0_SUPABASE_ANON_KEY',
  'GATE0_SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
]);

const GATE0_HOSTED_FAILURE_STAGES = Object.freeze([
  'management_auth_config',
  'publishable_auth_settings',
  'secret_auth_admin',
  'admin_create_user',
  'password_sign_in',
  'session_token_envelope',
  'scenario_bad_jwt',
  'scenario_session_expired',
  'scenario_session_not_found',
  'scenario_refresh_token_not_found',
  'scenario_refresh_token_already_used',
  'scenario_user_not_found',
  'scenario_user_banned',
  'evidence_contract',
]);

const SESSION_ERROR_CANDIDATES = Object.freeze([
  'bad_jwt',
  'session_expired',
  'session_not_found',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'user_not_found',
  'user_banned',
]);

const ALLOWED_USER_METADATA_FIELDS = Object.freeze([
  'avatar_url',
  'email',
  'email_verified',
  'full_name',
  'iss',
  'name',
  'phone_verified',
  'picture',
  'provider_id',
  'sub',
]);

const ALLOWED_USER_FIELDS = Object.freeze([
  'app_metadata',
  'aud',
  'confirmed_at',
  'created_at',
  'email',
  'email_confirmed_at',
  'id',
  'identities',
  'is_anonymous',
  'last_sign_in_at',
  'phone',
  'role',
  'updated_at',
  'user_metadata',
]);

const GOOGLE_SESSION_FIXTURE_V1 = Object.freeze({
  id: 'GOOGLE_SESSION_FIXTURE_V1',
  provider: 'google',
  identityCount: 1,
  userMetadataMaxUtf8Bytes: 2560,
  fieldLimits: Object.freeze({
    nameUtf8Bytes: 512,
    emailUtf8Bytes: 254,
    pictureUrlUtf8Bytes: 512,
    googleSubjectAsciiCharacters: 255,
    providerTokenUtf8Bytes: 2048,
  }),
  allowedAppMetadataFields: Object.freeze([
    'billing',
    'provider',
    'providers',
    'role',
  ]),
  allowedBillingMetadataFields: Object.freeze([
    'subscribed',
    'subscription_status',
    'subscriptionStatus',
  ]),
  allowedUserMetadataFields: ALLOWED_USER_METADATA_FIELDS,
  allowedIdentityFields: Object.freeze([
    'created_at',
    'id',
    'identity_data',
    'identity_id',
    'last_sign_in_at',
    'provider',
    'updated_at',
    'user_id',
  ]),
  supabaseTokenEnvelope: Object.freeze({
    accessTokenAlgorithm: 'RS256',
    allowedAccessTokenAlgorithms: Object.freeze(['ES256', 'RS256']),
    keyIdAsciiCharacters: 36,
    signatureBase64urlCharacters: 342,
    refreshTokenAsciiCharacters: 64,
  }),
  providerRefreshToken: 'omitted',
  sessionVariants: Object.freeze(['initial_login', 'refreshed_session']),
  installedDependencies: Object.freeze({
    ssrVersion: '0.8.0',
    supabaseJsVersion: '2.90.1',
    authJsVersion: '2.90.1',
  }),
  serializer: Object.freeze({
    package: '@supabase/ssr',
    version: '0.8.0',
    cookieEncoding: 'base64url',
    encodedPrefix: BASE64_COOKIE_PREFIX,
    chunker: 'createChunks',
  }),
  expectedMaxAuthCookieChunks: EXPECTED_MAX_AUTH_COOKIE_CHUNKS,
  unsupportedDisposition: 'unavailable',
  reopensOn: Object.freeze([
    'metadata_shape_expansion',
    'identity_count_expansion',
    'oauth_provider_or_scope_expansion',
    'token_format_expansion',
    'cookie_configuration_change',
    'supabase_dependency_change',
  ]),
});

/**
 * Measure a string using the UTF-8 boundary used by the approved fixture.
 *
 * Purpose: every user-controlled string limit is byte-based rather than a
 * JavaScript code-unit approximation.
 *
 * @param {string} value string to measure
 * @returns {number} serialized UTF-8 byte count
 */
function utf8ByteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Construct an ASCII value at an exact approved byte boundary.
 *
 * Purpose: fixture maxima must be deterministic, non-sensitive, and immune to
 * locale or Unicode normalization differences.
 *
 * @param {string} character single ASCII character
 * @param {number} length exact number of characters and UTF-8 bytes
 * @returns {string} bounded deterministic value
 */
function repeatAscii(character, length) {
  if (!/^[\x21-\x7e]$/.test(character) || !Number.isInteger(length) || length < 0) {
    throw new Error('Fixture ASCII construction received an invalid boundary.');
  }

  return character.repeat(length);
}

/**
 * Construct a deterministic URL whose UTF-8 size exactly meets its cap.
 *
 * Purpose: Google exposes the same picture URL through two current metadata
 * keys, so both URL fields need an independently bounded maximum value.
 *
 * @param {string} marker safe path marker used to distinguish URL fields
 * @param {number} maxUtf8Bytes exact URL byte cap
 * @returns {string} syntactically valid HTTPS fixture URL
 */
function buildBoundedUrl(marker, maxUtf8Bytes) {
  const prefix = `https://images.example.invalid/${marker}/`;
  const remainingBytes = maxUtf8Bytes - utf8ByteLength(prefix);

  if (remainingBytes < 1) {
    throw new Error('Fixture URL boundary is smaller than its safe prefix.');
  }

  return `${prefix}${repeatAscii(marker, remainingBytes)}`;
}

/**
 * Construct the maximum approved synthetic email address.
 *
 * Purpose: the fixture needs a valid-looking, non-deliverable email that
 * reaches the 254-byte application boundary without identifying a person.
 *
 * @returns {string} 254-byte address under the reserved invalid TLD
 */
function buildBoundedEmail() {
  const domain = '@example.invalid';
  return `${repeatAscii('e', 254 - utf8ByteLength(domain))}${domain}`;
}

/**
 * Build the exact 2,560-byte current Google user-metadata object.
 *
 * Purpose: the aggregate cap dominates individual field caps; this fills one
 * name field only after all other current fields are present and bounded.
 *
 * @returns {Record<string, string|boolean>} canonical bounded metadata
 */
function buildBoundedGoogleUserMetadata() {
  const metadata = {
    avatar_url: buildBoundedUrl('a', 512),
    email: buildBoundedEmail(),
    email_verified: true,
    full_name: '',
    iss: 'https://accounts.google.com',
    name: repeatAscii('n', 512),
    phone_verified: false,
    picture: buildBoundedUrl('p', 512),
    provider_id: repeatAscii('g', 255),
    sub: repeatAscii('s', 255),
  };
  const currentBytes = utf8ByteLength(JSON.stringify(metadata));
  const remainingBytes = GOOGLE_SESSION_FIXTURE_V1.userMetadataMaxUtf8Bytes - currentBytes;

  if (remainingBytes < 0 || remainingBytes > GOOGLE_SESSION_FIXTURE_V1.fieldLimits.nameUtf8Bytes) {
    throw new Error('Approved Google metadata caps cannot construct the aggregate fixture.');
  }

  metadata.full_name = repeatAscii('f', remainingBytes);

  if (utf8ByteLength(JSON.stringify(metadata)) !== GOOGLE_SESSION_FIXTURE_V1.userMetadataMaxUtf8Bytes) {
    throw new Error('Approved Google metadata fixture did not reach its exact byte boundary.');
  }

  return metadata;
}

/**
 * Build the exact application metadata shape currently supported by the app.
 *
 * Purpose: Supabase-managed provider fields and the app's role/billing hints
 * are included without admitting arbitrary app_metadata keys.
 *
 * @returns {Record<string, unknown>} canonical application metadata
 */
function buildBoundedAppMetadata() {
  return {
    billing: {
      subscribed: true,
      subscription_status: 'active',
      subscriptionStatus: 'active',
    },
    provider: 'google',
    providers: ['google'],
    role: 'admin',
  };
}

/**
 * Load the exact installed SSR package internals used for cookie persistence.
 *
 * Purpose: evidence must execute the installed serializer and createChunks(),
 * not a copied implementation that could drift from the dependency.
 *
 * @returns {{ createChunks: Function, stringToBase64URL: Function, ssrVersion: string }}
 */
function loadInstalledSsrSerializer() {
  const packagePath = require.resolve('@supabase/ssr/package.json');
  const packageMetadata = require(packagePath);

  if (packageMetadata.version !== GOOGLE_SESSION_FIXTURE_V1.serializer.version) {
    throw new Error('Installed @supabase/ssr version reopens GOOGLE_SESSION_FIXTURE_V1.');
  }

  const packageRoot = path.dirname(packagePath);
  const {
    createChunks,
    stringToBase64URL,
  } = require(path.join(packageRoot, 'dist', 'main', 'utils'));

  return {
    createChunks,
    stringToBase64URL,
    ssrVersion: packageMetadata.version,
  };
}

/**
 * Encode JSON with the installed SSR base64url primitive.
 *
 * Purpose: JWT fixture segments and persisted session cookies share the exact
 * dependency-owned UTF-8/base64url behavior used by the application.
 *
 * @param {unknown} value JSON-safe value to encode
 * @param {(value: string) => string} stringToBase64URL installed encoder
 * @returns {string} unpadded base64url data
 */
function encodeJsonSegment(value, stringToBase64URL) {
  return stringToBase64URL(JSON.stringify(value));
}

/**
 * Build the bounded synthetic Supabase access-token envelope.
 *
 * Purpose: the session maximum includes duplicated auth claims without using
 * or persisting a real access token; a token-format expansion reopens V1.
 *
 * @param {Record<string, unknown>} appMetadata bounded application metadata
 * @param {Record<string, unknown>} userMetadata bounded user metadata
 * @param {(value: string) => string} stringToBase64URL installed encoder
 * @returns {string} non-functional compact-JWS fixture
 */
function buildBoundedAccessToken(appMetadata, userMetadata, stringToBase64URL) {
  const envelope = GOOGLE_SESSION_FIXTURE_V1.supabaseTokenEnvelope;
  const header = {
    alg: envelope.accessTokenAlgorithm,
    kid: repeatAscii('k', envelope.keyIdAsciiCharacters),
    typ: 'JWT',
  };
  const payload = {
    aal: 'aal1',
    amr: [{ method: 'oauth', timestamp: FIXTURE_UNIX_SECONDS }],
    app_metadata: appMetadata,
    aud: 'authenticated',
    email: buildBoundedEmail(),
    exp: FIXTURE_UNIX_SECONDS + 3600,
    iat: FIXTURE_UNIX_SECONDS,
    is_anonymous: false,
    iss: `${EXPECTED_SUPABASE_URL}/auth/v1`,
    role: 'authenticated',
    session_id: FIXTURE_SESSION_ID,
    sub: FIXTURE_USER_ID,
    user_metadata: userMetadata,
  };

  return [
    encodeJsonSegment(header, stringToBase64URL),
    encodeJsonSegment(payload, stringToBase64URL),
    repeatAscii('s', envelope.signatureBase64urlCharacters),
  ].join('.');
}

/**
 * Build the single bounded Google identity stored in the Supabase user.
 *
 * Purpose: V1 supports exactly one identity and duplicates only the approved
 * current Google identity-data keys.
 *
 * @param {Record<string, unknown>} userMetadata canonical identity data
 * @returns {Record<string, unknown>} one synthetic Google identity
 */
function buildBoundedGoogleIdentity(userMetadata) {
  return {
    created_at: FIXTURE_TIMESTAMP,
    id: repeatAscii('s', 255),
    identity_data: { ...userMetadata },
    identity_id: FIXTURE_IDENTITY_ID,
    last_sign_in_at: FIXTURE_TIMESTAMP,
    provider: 'google',
    updated_at: FIXTURE_TIMESTAMP,
    user_id: FIXTURE_USER_ID,
  };
}

/**
 * Build the bounded Supabase user duplicated inside each session variant.
 *
 * Purpose: the cookie maximum must include the complete persisted user shape,
 * not only the access-token claims.
 *
 * @param {Record<string, unknown>} appMetadata canonical application metadata
 * @param {Record<string, unknown>} userMetadata canonical user metadata
 * @returns {Record<string, unknown>} synthetic maximum user
 */
function buildBoundedUser(appMetadata, userMetadata) {
  return {
    app_metadata: appMetadata,
    aud: 'authenticated',
    confirmed_at: FIXTURE_TIMESTAMP,
    created_at: FIXTURE_TIMESTAMP,
    email: buildBoundedEmail(),
    email_confirmed_at: FIXTURE_TIMESTAMP,
    id: FIXTURE_USER_ID,
    identities: [buildBoundedGoogleIdentity(userMetadata)],
    is_anonymous: false,
    last_sign_in_at: FIXTURE_TIMESTAMP,
    phone: '',
    role: 'authenticated',
    updated_at: FIXTURE_TIMESTAMP,
    user_metadata: userMetadata,
  };
}

/**
 * Construct maximum initial-login and refreshed-session fixture variants.
 *
 * Purpose: OAuth provider tokens are present only on the maximum initial-login
 * variant, while refresh persistence is measured independently without a
 * provider refresh token.
 *
 * @returns {{ initialLogin: Record<string, unknown>, refreshedSession: Record<string, unknown> }}
 */
function buildGoogleSessionFixtures() {
  const { stringToBase64URL } = loadInstalledSsrSerializer();
  const appMetadata = buildBoundedAppMetadata();
  const userMetadata = buildBoundedGoogleUserMetadata();
  const user = buildBoundedUser(appMetadata, userMetadata);
  const accessToken = buildBoundedAccessToken(appMetadata, userMetadata, stringToBase64URL);
  const baseSession = {
    access_token: accessToken,
    expires_at: FIXTURE_UNIX_SECONDS + 3600,
    expires_in: 3600,
    refresh_token: repeatAscii(
      'r',
      GOOGLE_SESSION_FIXTURE_V1.supabaseTokenEnvelope.refreshTokenAsciiCharacters
    ),
    token_type: 'bearer',
    user,
  };

  return {
    initialLogin: {
      provider_token: repeatAscii(
        'p',
        GOOGLE_SESSION_FIXTURE_V1.fieldLimits.providerTokenUtf8Bytes
      ),
      ...baseSession,
    },
    refreshedSession: { ...baseSession },
  };
}

/**
 * Serialize one session through installed SSR encoding and createChunks().
 *
 * Purpose: the returned evidence retains only a count; serialized credentials
 * and cookie names/values remain transient in memory.
 *
 * @param {Record<string, unknown>} session synthetic session fixture
 * @returns {number} positive installed createChunks() result count
 */
function countSerializedSessionChunks(session) {
  const {
    createChunks,
    stringToBase64URL,
  } = loadInstalledSsrSerializer();
  const serializedSession = JSON.stringify(session);
  const encodedSession = `${BASE64_COOKIE_PREFIX}${stringToBase64URL(serializedSession)}`;
  const chunkCount = createChunks(AUTH_COOKIE_STORAGE_KEY, encodedSession).length;

  if (!Number.isInteger(chunkCount) || chunkCount < 1) {
    throw new Error('Installed createChunks() returned an invalid count.');
  }

  return chunkCount;
}

/**
 * Measure both approved fixture variants without retaining serialized values.
 *
 * Purpose: PR A proves the expected six-chunk result while leaving the formal
 * MAX_AUTH_COOKIE_CHUNKS contract unresolved until deployed evidence is frozen.
 *
 * @returns {{ fixtureId: string, initialLoginChunks: number, refreshedSessionChunks: number, maximumChunks: number, expectedMaximumChunks: number, reproducedExpectedMaximum: boolean }}
 */
function captureGoogleSessionFixtureEvidence() {
  const fixtures = buildGoogleSessionFixtures();
  const initialLoginChunks = countSerializedSessionChunks(fixtures.initialLogin);
  const refreshedSessionChunks = countSerializedSessionChunks(fixtures.refreshedSession);
  const maximumChunks = Math.max(initialLoginChunks, refreshedSessionChunks);

  return {
    fixtureId: GOOGLE_SESSION_FIXTURE_V1.id,
    initialLoginChunks,
    refreshedSessionChunks,
    maximumChunks,
    expectedMaximumChunks: GOOGLE_SESSION_FIXTURE_V1.expectedMaxAuthCookieChunks,
    reproducedExpectedMaximum:
      maximumChunks === GOOGLE_SESSION_FIXTURE_V1.expectedMaxAuthCookieChunks,
  };
}

/**
 * Check whether an object exposes exactly the approved own enumerable keys.
 *
 * Purpose: structural additions reopen the fixture instead of being ignored by
 * a permissive validator.
 *
 * @param {unknown} value candidate object
 * @param {readonly string[]} allowedKeys complete allowed key set
 * @returns {boolean} true only for an exact key match
 */
function hasExactKeys(value, allowedKeys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify([...allowedKeys].sort());
}

/**
 * Decode the bounded compact-JWT header without validating a signature.
 *
 * Purpose: fixture classification checks only the approved token envelope;
 * authentication remains the hosted provider's responsibility.
 *
 * @param {string} segment base64url header segment
 * @returns {Record<string, unknown>|null} decoded header or null
 */
function decodeTokenHeader(segment) {
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Check one value against the approved non-empty ASCII token boundary.
 *
 * Purpose: Google subject/provider IDs and compact-token segments cannot hide
 * multibyte or control characters inside character-count caps.
 *
 * @param {unknown} value candidate string
 * @param {number} maxCharacters inclusive ASCII cap
 * @returns {boolean} bounded printable/base64url-safe string result
 */
function isBoundedAscii(value, maxCharacters) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maxCharacters
    && /^[\x21-\x7e]+$/.test(value);
}

/**
 * Validate the exact bounded Supabase compact-token envelope.
 *
 * Purpose: any algorithm, header shape, signature size, or refresh-token
 * expansion is unavailable and reopens the evidence decision.
 *
 * @param {unknown} accessToken candidate compact JWT
 * @param {unknown} refreshToken candidate Supabase refresh token
 * @returns {boolean} exact V1 envelope result
 */
function isSupportedTokenEnvelope(accessToken, refreshToken) {
  if (typeof accessToken !== 'string') {
    return false;
  }

  const segments = accessToken.split('.');
  if (segments.length !== 3) {
    return false;
  }

  const envelope = GOOGLE_SESSION_FIXTURE_V1.supabaseTokenEnvelope;
  const header = decodeTokenHeader(segments[0]);

  return hasExactKeys(header, ['alg', 'kid', 'typ'])
    && envelope.allowedAccessTokenAlgorithms.includes(header.alg)
    && header.typ === 'JWT'
    && isBoundedAscii(header.kid, envelope.keyIdAsciiCharacters)
    && /^[A-Za-z0-9_-]+$/.test(segments[1])
    && segments[1].length >= 1
    && /^[A-Za-z0-9_-]+$/.test(segments[2])
    && segments[2].length >= 1
    && segments[2].length <= envelope.signatureBase64urlCharacters
    && isBoundedAscii(refreshToken, envelope.refreshTokenAsciiCharacters);
}

/**
 * Validate the exact current Google metadata shape and all byte boundaries.
 *
 * Purpose: the aggregate user_metadata limit dominates field maxima, while no
 * missing, extra, oversized, or non-ASCII provider identifier is accepted.
 *
 * @param {unknown} metadata candidate user or identity metadata
 * @returns {boolean} exact V1 metadata result
 */
function isSupportedGoogleMetadata(metadata) {
  if (!hasExactKeys(metadata, ALLOWED_USER_METADATA_FIELDS)) {
    return false;
  }

  const limits = GOOGLE_SESSION_FIXTURE_V1.fieldLimits;
  return utf8ByteLength(JSON.stringify(metadata))
      <= GOOGLE_SESSION_FIXTURE_V1.userMetadataMaxUtf8Bytes
    && typeof metadata.email_verified === 'boolean'
    && typeof metadata.phone_verified === 'boolean'
    && metadata.iss === 'https://accounts.google.com'
    && typeof metadata.name === 'string'
    && utf8ByteLength(metadata.name) <= limits.nameUtf8Bytes
    && typeof metadata.full_name === 'string'
    && utf8ByteLength(metadata.full_name) <= limits.nameUtf8Bytes
    && typeof metadata.email === 'string'
    && utf8ByteLength(metadata.email) <= limits.emailUtf8Bytes
    && typeof metadata.avatar_url === 'string'
    && utf8ByteLength(metadata.avatar_url) <= limits.pictureUrlUtf8Bytes
    && typeof metadata.picture === 'string'
    && utf8ByteLength(metadata.picture) <= limits.pictureUrlUtf8Bytes
    && isBoundedAscii(metadata.provider_id, limits.googleSubjectAsciiCharacters)
    && isBoundedAscii(metadata.sub, limits.googleSubjectAsciiCharacters);
}

/**
 * Classify a credential against GOOGLE_SESSION_FIXTURE_V1 without auth fallback.
 *
 * Purpose: oversized or structurally different credentials are explicitly
 * unavailable; this evidence helper never returns the anonymous auth state.
 *
 * @param {unknown} session candidate persisted Supabase session
 * @returns {{ supported: boolean, disposition: 'supported'|'unavailable' }} classification
 */
function classifyGoogleSessionCredential(session) {
  const unavailable = { supported: false, disposition: 'unavailable' };
  const initialKeys = [
    'access_token',
    'expires_at',
    'expires_in',
    'provider_token',
    'refresh_token',
    'token_type',
    'user',
  ];
  const refreshedKeys = initialKeys.filter((key) => key !== 'provider_token');

  if (!hasExactKeys(session, initialKeys) && !hasExactKeys(session, refreshedKeys)) {
    return unavailable;
  }

  if (
    session.token_type !== 'bearer'
    || !Number.isInteger(session.expires_at)
    || !Number.isInteger(session.expires_in)
    || !isSupportedTokenEnvelope(session.access_token, session.refresh_token)
  ) {
    return unavailable;
  }

  if (
    Object.prototype.hasOwnProperty.call(session, 'provider_token')
    && (
      typeof session.provider_token !== 'string'
      || utf8ByteLength(session.provider_token)
        > GOOGLE_SESSION_FIXTURE_V1.fieldLimits.providerTokenUtf8Bytes
    )
  ) {
    return unavailable;
  }

  const user = session.user;
  if (!hasExactKeys(user, ALLOWED_USER_FIELDS) || !Array.isArray(user.identities)) {
    return unavailable;
  }

  if (
    !hasExactKeys(user.app_metadata, GOOGLE_SESSION_FIXTURE_V1.allowedAppMetadataFields)
    || !hasExactKeys(
      user.app_metadata.billing,
      GOOGLE_SESSION_FIXTURE_V1.allowedBillingMetadataFields
    )
    || !isSupportedGoogleMetadata(user.user_metadata)
    || user.identities.length !== GOOGLE_SESSION_FIXTURE_V1.identityCount
  ) {
    return unavailable;
  }

  const [identity] = user.identities;
  if (
    !hasExactKeys(identity, GOOGLE_SESSION_FIXTURE_V1.allowedIdentityFields)
    || identity.provider !== 'google'
    || !isBoundedAscii(
      identity.id,
      GOOGLE_SESSION_FIXTURE_V1.fieldLimits.googleSubjectAsciiCharacters
    )
    || !isSupportedGoogleMetadata(identity.identity_data)
    || JSON.stringify(identity.identity_data) !== JSON.stringify(user.user_metadata)
  ) {
    return unavailable;
  }

  return { supported: true, disposition: 'supported' };
}

/**
 * Generate a synthetic credential that is unique to one evidence scenario.
 *
 * Purpose: disposable users must not collide across retries while identifiers
 * remain transient and excluded from output.
 *
 * @returns {{ email: string, password: string }} disposable credentials
 */
function createDisposableCredentials() {
  const runFragment = randomUUID().replaceAll('-', '');
  return {
    email: `gate0-${runFragment}@example.invalid`,
    password: `${randomBytes(24).toString('base64url')}Aa1!`,
  };
}

/**
 * Represents a preflight failure whose static, names-only message is safe.
 *
 * Purpose: the CLI can distinguish audited configuration diagnostics from
 * provider errors that must never reach workflow output.
 */
class Gate0ConfigurationError extends Error {}

/**
 * Represents a failed cleanup of one target-scoped disposable identity.
 *
 * Purpose: cleanup failures abort the capture instead of being mislabeled as
 * unavailable evidence and silently leaving synthetic state behind.
 */
class Gate0CleanupError extends Error {}

/**
 * Represents one finite, sanitized hosted-capture failure stage.
 *
 * Purpose: operators can locate a failed provider boundary without retaining
 * or printing provider messages, responses, identifiers, or credentials.
 */
class Gate0StageError extends Error {
  /**
   * Create an error from the audited stage allowlist.
   *
   * @param {string} stage safe hosted operation identifier
   */
  constructor(stage) {
    super('Gate-0 hosted evidence stage failed.');

    if (!GATE0_HOSTED_FAILURE_STAGES.includes(stage)) {
      throw new Error('Gate-0 hosted evidence received an unknown failure stage.');
    }

    this.name = 'Gate0StageError';
    this.stage = stage;
  }
}

/**
 * Execute one hosted operation behind the finite stage-error boundary.
 *
 * Purpose: raw provider exceptions never cross into the CLI, while cleanup
 * failures and already-sanitized nested stages retain their stronger meaning.
 *
 * @param {string} stage safe hosted operation identifier
 * @param {() => Promise<unknown>} callback hosted operation
 * @returns {Promise<unknown>} callback result
 */
async function runHostedStage(stage, callback) {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof Gate0CleanupError || error instanceof Gate0StageError) {
      throw error;
    }

    throw new Gate0StageError(stage);
  }
}

/**
 * Find required environment names that do not contain usable strings.
 *
 * Purpose: preflight reports names only and never prints configured values.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @param {readonly string[]} names required canonical names
 * @returns {string[]} missing names in stable input order
 */
function findMissingEnvironmentNames(env, names) {
  return names.filter((name) => (
    typeof env?.[name] !== 'string' || env[name].trim() === ''
  ));
}

/**
 * Format a names-only environment diagnostic for trusted workflow output.
 *
 * Purpose: operators receive actionable configuration failures without any
 * credential material or environment snapshots.
 *
 * @param {string} heading static diagnostic heading
 * @param {readonly string[]} names safe environment names
 * @returns {string} stable multiline diagnostic
 */
function formatEnvironmentNameDiagnostic(heading, names) {
  return [heading, ...names.map((name) => `- ${name}`)].join('\n');
}

/**
 * Assert that one URL targets only the approved pre-production project.
 *
 * Purpose: a valid credential for any other project must fail before a client
 * or network request can be created.
 *
 * @param {unknown} candidateUrl configured Supabase URL
 * @param {unknown} candidateProjectRef independently configured project ref
 * @returns {void}
 * @throws {Gate0ConfigurationError} when either target proof differs
 */
function assertGate0SupabaseTarget(candidateUrl, candidateProjectRef) {
  let normalizedUrl;

  try {
    const parsedUrl = new URL(candidateUrl);
    normalizedUrl = parsedUrl.origin;
    if (parsedUrl.pathname !== '/' || parsedUrl.search || parsedUrl.hash) {
      throw new Error('unexpected URL components');
    }
  } catch {
    throw new Gate0ConfigurationError(
      'GATE0_SUPABASE_URL must be the exact approved pre-production project origin.'
    );
  }

  if (
    normalizedUrl !== EXPECTED_SUPABASE_URL
    || candidateProjectRef !== EXPECTED_SUPABASE_PROJECT_REF
  ) {
    throw new Gate0ConfigurationError(
      'Gate-0 evidence credentials do not target the approved pre-production project.'
    );
  }
}

/**
 * Validate the complete credential and workflow boundary before mutations.
 *
 * Purpose: capture accepts only dedicated GATE0_* names, refuses deployment
 * fallbacks, verifies staging dispatch, and requires an explicit destructive
 * opt-in before creating a disposable user.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @param {{ requireDestructiveOptIn?: boolean }} options preflight mode
 * @returns {{ url: string, publishableKey: string, secretKey: string, managementToken: string }} trusted config
 */
function validateGate0Environment(env, { requireDestructiveOptIn = true } = {}) {
  const requiredNames = [
    GATE0_ENV_NAMES.url,
    GATE0_ENV_NAMES.publishableKey,
    GATE0_ENV_NAMES.secretKey,
    GATE0_ENV_NAMES.managementToken,
    GATE0_ENV_NAMES.projectRef,
  ];
  const missingNames = findMissingEnvironmentNames(env, requiredNames);

  if (missingNames.length > 0) {
    throw new Gate0ConfigurationError(formatEnvironmentNameDiagnostic(
      'Missing required Gate-0 evidence environment variables:',
      missingNames
    ));
  }

  const forbiddenNames = FORBIDDEN_APPLICATION_ENV_NAMES.filter((name) => (
    typeof env?.[name] === 'string' && env[name].trim() !== ''
  ));

  if (forbiddenNames.length > 0) {
    throw new Gate0ConfigurationError(formatEnvironmentNameDiagnostic(
      'Refusing application or deployment credential fallbacks:',
      forbiddenNames
    ));
  }

  if (env?.GITHUB_ACTIONS === 'true' && env?.GITHUB_REF !== 'refs/heads/staging') {
    throw new Gate0ConfigurationError(
      'Gate-0 auth evidence requires the exact staging branch ref.'
    );
  }

  if (requireDestructiveOptIn && env?.[GATE0_ENV_NAMES.destructiveOptIn] !== 'true') {
    throw new Gate0ConfigurationError(
      'GATE0_AUTH_EVIDENCE_ALLOWED must equal true before disposable mutations.'
    );
  }

  assertGate0SupabaseTarget(
    env[GATE0_ENV_NAMES.url].trim(),
    env[GATE0_ENV_NAMES.projectRef].trim()
  );

  const publishableKey = env[GATE0_ENV_NAMES.publishableKey].trim();
  const secretKey = env[GATE0_ENV_NAMES.secretKey].trim();
  const invalidKeyNames = [
    !/^sb_publishable_\S+$/.test(publishableKey)
      ? GATE0_ENV_NAMES.publishableKey
      : null,
    !/^sb_secret_\S+$/.test(secretKey)
      ? GATE0_ENV_NAMES.secretKey
      : null,
  ].filter(Boolean);

  if (invalidKeyNames.length > 0) {
    throw new Gate0ConfigurationError(formatEnvironmentNameDiagnostic(
      'Gate-0 evidence requires the deployed Supabase publishable/secret key family:',
      invalidKeyNames
    ));
  }

  return {
    url: EXPECTED_SUPABASE_URL,
    publishableKey,
    secretKey,
    managementToken: env[GATE0_ENV_NAMES.managementToken].trim(),
  };
}

/**
 * Prove the production target validator refuses a guaranteed-wrong ref.
 *
 * Purpose: the manual workflow exercises its real fail-closed boundary before
 * the normal credentialed preflight or any provider request.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @returns {void}
 */
function proveWrongProjectRefRefusal(env) {
  const config = validateGate0Environment(env, { requireDestructiveOptIn: false });
  const wrongRef = env[GATE0_ENV_NAMES.projectRef] === '00000000000000000000'
    ? '11111111111111111111'
    : '00000000000000000000';

  try {
    assertGate0SupabaseTarget(config.url, wrongRef);
  } catch (error) {
    if (
      error instanceof Gate0ConfigurationError
      && error.message
        === 'Gate-0 evidence credentials do not target the approved pre-production project.'
    ) {
      return;
    }

    throw new Gate0ConfigurationError(
      'Gate-0 wrong-project refusal failed for an unrelated reason.'
    );
  }

  throw new Gate0ConfigurationError(
    'Gate-0 wrong-project refusal unexpectedly accepted the wrong target.'
  );
}

/**
 * Load exact installed Supabase clients and their package versions.
 *
 * Purpose: runtime imports are delayed until target preflight has passed, and
 * sanitized output records the dependency surface that produced the evidence.
 *
 * @returns {{ createClient: Function, createServerClient: Function, versions: Record<string, string> }}
 */
function loadInstalledSupabaseClients() {
  const { createClient } = require('@supabase/supabase-js');
  const { createServerClient } = require('@supabase/ssr');
  const supabaseJs = require('@supabase/supabase-js/package.json');
  const authJs = require('@supabase/auth-js/package.json');
  const ssr = require('@supabase/ssr/package.json');
  const versions = {
    ssrVersion: ssr.version,
    supabaseJsVersion: supabaseJs.version,
    authJsVersion: authJs.version,
  };

  if (
    JSON.stringify(versions)
    !== JSON.stringify(GOOGLE_SESSION_FIXTURE_V1.installedDependencies)
  ) {
    throw new Error('Installed Supabase dependencies reopen GOOGLE_SESSION_FIXTURE_V1.');
  }

  return {
    createClient,
    createServerClient,
    versions,
  };
}

/**
 * Create a non-persistent Supabase client for setup or exact admin cleanup.
 *
 * Purpose: evidence credentials and synthetic sessions remain in memory and
 * are never written to disk, browser storage, or workflow artifacts.
 *
 * @param {Function} createClient installed Supabase client factory
 * @param {string} url exact pre-production origin
 * @param {string} key publishable or secret key
 * @returns {ReturnType<Function>} isolated Supabase client
 */
function createEphemeralClient(createClient, url, key) {
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

/**
 * Convert one session to the exact installed SSR cookie chunks in memory.
 *
 * Purpose: createServerClient receives the same encoded storage shape as the
 * application without exposing any cookie name or value outside this scope.
 *
 * @param {Record<string, unknown>} session transient synthetic or disposable session
 * @returns {{ name: string, value: string }[]} transient cookie chunks
 */
function serializeSessionForSsr(session) {
  const {
    createChunks,
    stringToBase64URL,
  } = loadInstalledSsrSerializer();
  const encoded = `${BASE64_COOKIE_PREFIX}${stringToBase64URL(JSON.stringify(session))}`;

  return createChunks(AUTH_COOKIE_STORAGE_KEY, encoded);
}

/**
 * Invoke the application's exact SSR getUser boundary for one session.
 *
 * Purpose: raw provider responses are intentionally inaccessible; only the
 * installed SDK's exported error surface can become deployed evidence.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @param {Function} createServerClient installed SSR factory
 * @param {Record<string, unknown>} session transient session input
 * @returns {Promise<{ data: unknown, error: unknown }>} installed SDK result
 */
async function getUserThroughSsr(config, createServerClient, session) {
  let cookieJar = serializeSessionForSsr(session);
  const supabase = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: async () => cookieJar,
      setAll: async (cookies) => {
        cookieJar = cookies
          .filter(({ value }) => value !== '')
          .map(({ name, value }) => ({ name, value }));
      },
    },
  });

  try {
    return await supabase.auth.getUser();
  } finally {
    cookieJar = [];
  }
}

/**
 * Convert an installed SDK error to the only allowed evidence tuple.
 *
 * Purpose: messages, bodies, stacks, tokens, identifiers, and unexpected codes
 * are discarded before any caller can serialize or print the result.
 *
 * @param {string} candidate candidate provider code under test
 * @param {'getUser'|'implicit_refresh'} operation installed SDK operation
 * @param {unknown} error installed SDK error
 * @returns {Record<string, unknown>} sanitized allowlisted/unavailable tuple
 */
function sanitizeSdkObservation(candidate, operation, error) {
  const rawClass = error?.constructor?.name;
  const exportedClass = typeof rawClass === 'string' && /^Auth[A-Za-z]+Error$/.test(rawClass)
    ? rawClass
    : null;
  const codeObserved = typeof error?.code === 'string'
    && SESSION_ERROR_CANDIDATES.includes(error.code);
  const code = codeObserved ? error.code : null;
  const status = Number.isInteger(error?.status)
    && error.status >= 100
    && error.status <= 599
    ? error.status
    : null;

  return {
    candidate,
    operation,
    exportedClass,
    code,
    codeObserved,
    status,
    disposition: code === candidate ? 'allowlisted' : 'unavailable',
  };
}

/**
 * Return an unavailable tuple without attaching a provider error object.
 *
 * Purpose: policy-infeasible scenarios remain explicit and complete while no
 * speculative code, class, or status is promoted into deployed evidence.
 *
 * @param {string} candidate candidate provider code
 * @param {'getUser'|'implicit_refresh'} operation intended SDK path
 * @returns {Record<string, unknown>} empty sanitized evidence tuple
 */
function unavailableObservation(candidate, operation) {
  return sanitizeSdkObservation(candidate, operation, null);
}

/**
 * Create and authenticate one disposable, email-confirmed synthetic user.
 *
 * Purpose: every mutable scenario owns an isolated identity and session; no
 * existing application user is selected or modified.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @param {{ createClient: Function }} clients installed client factories
 * @param {ReturnType<Function>} admin secret-key client
 * @returns {Promise<{ userId: string, session: Record<string, unknown> }>} transient identity state
 */
async function createDisposableSession(config, clients, admin) {
  const credentials = createDisposableCredentials();
  const created = await runHostedStage('admin_create_user', async () => {
    const result = await admin.auth.admin.createUser({
      email: credentials.email,
      password: credentials.password,
      email_confirm: true,
    });

    if (result.error || typeof result.data?.user?.id !== 'string') {
      throw new Error('Disposable Gate-0 user setup failed.');
    }

    return result;
  });

  const userId = created.data.user.id;

  try {
    const signedIn = await runHostedStage('password_sign_in', async () => {
      const signInClient = createEphemeralClient(
        clients.createClient,
        config.url,
        config.publishableKey
      );
      const result = await signInClient.auth.signInWithPassword(credentials);

      if (result.error || !result.data?.session) {
        throw new Error('Disposable Gate-0 session setup failed.');
      }

      return result;
    });

    if (!isSupportedTokenEnvelope(
      signedIn.data.session.access_token,
      signedIn.data.session.refresh_token
    )) {
      throw new Gate0StageError('session_token_envelope');
    }

    return { userId, session: signedIn.data.session };
  } catch (error) {
    const cleanup = await admin.auth.admin.deleteUser(userId);
    if (cleanup.error) {
      throw new Gate0CleanupError('Disposable Gate-0 user cleanup failed.');
    }

    throw error;
  }
}

/**
 * Delete exactly one known disposable user and fail on uncertain cleanup.
 *
 * Purpose: broad deletion is impossible and a cleanup failure cannot be hidden
 * behind a successful or unavailable evidence record.
 *
 * @param {ReturnType<Function>} admin secret-key client
 * @param {string|null} userId exact disposable user ID or null after deletion
 * @returns {Promise<void>}
 */
async function cleanupDisposableUser(admin, userId) {
  if (userId === null) {
    return;
  }

  const cleanup = await admin.auth.admin.deleteUser(userId);
  if (cleanup.error) {
    throw new Gate0CleanupError('Disposable Gate-0 user cleanup failed.');
  }
}

/**
 * Execute one scenario with target-scoped try/finally user cleanup.
 *
 * Purpose: scenario callbacks may revoke, ban, or delete only their own user;
 * the wrapper guarantees idempotent final deletion for every other path.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @param {ReturnType<typeof loadInstalledSupabaseClients>} clients installed clients
 * @param {ReturnType<Function>} admin secret-key client
 * @param {(state: { userId: string, session: Record<string, unknown>, markDeleted: Function }) => Promise<Record<string, unknown>>} callback scenario body
 * @returns {Promise<Record<string, unknown>>} sanitized observation
 */
async function withDisposableSession(config, clients, admin, callback) {
  const state = await createDisposableSession(config, clients, admin);
  let cleanupUserId = state.userId;

  try {
    return await callback({
      ...state,
      markDeleted: () => {
        cleanupUserId = null;
      },
    });
  } finally {
    await cleanupDisposableUser(admin, cleanupUserId);
  }
}

/**
 * Corrupt only the signature segment of a valid disposable access token.
 *
 * Purpose: the access token stays structurally JWT-like and locally unexpired,
 * ensuring getUser reaches the hosted /user validation boundary.
 *
 * @param {string} accessToken valid disposable compact JWT
 * @returns {string} invalid-signature token with no retained original value
 */
function corruptAccessTokenSignature(accessToken) {
  const segments = accessToken.split('.');
  if (segments.length !== 3 || segments[2].length < 1) {
    throw new Error('Disposable access token format cannot reproduce bad_jwt safely.');
  }

  const firstCharacter = segments[2][0];
  segments[2] = `${firstCharacter === 'A' ? 'B' : 'A'}${segments[2].slice(1)}`;
  return segments.join('.');
}

/**
 * Force an otherwise valid session through the installed implicit-refresh path.
 *
 * Purpose: refresh candidates must be observed through normal no-argument
 * getUser(), not a lower-level provider endpoint bypass.
 *
 * @param {Record<string, unknown>} session disposable session
 * @returns {Record<string, unknown>} expired in-memory session copy
 */
function expireSessionLocally(session) {
  return {
    ...session,
    expires_at: Math.floor(Date.now() / 1000) - 60,
  };
}

/**
 * Reproduce bad_jwt through SSR getUser with isolated cleanup.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @param {ReturnType<typeof loadInstalledSupabaseClients>} clients installed clients
 * @param {ReturnType<Function>} admin secret-key client
 * @returns {Promise<Record<string, unknown>>} sanitized deployed tuple
 */
async function captureBadJwt(config, clients, admin) {
  return withDisposableSession(config, clients, admin, async ({ session }) => {
    const result = await getUserThroughSsr(config, clients.createServerClient, {
      ...session,
      access_token: corruptAccessTokenSignature(session.access_token),
    });
    return sanitizeSdkObservation('bad_jwt', 'getUser', result.error);
  });
}

/**
 * Reproduce user_not_found after deleting only the scenario-owned identity.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @param {ReturnType<typeof loadInstalledSupabaseClients>} clients installed clients
 * @param {ReturnType<Function>} admin secret-key client
 * @returns {Promise<Record<string, unknown>>} sanitized deployed tuple
 */
async function captureUserNotFound(config, clients, admin) {
  return withDisposableSession(
    config,
    clients,
    admin,
    async ({ userId, session, markDeleted }) => {
      const deleted = await admin.auth.admin.deleteUser(userId);
      if (deleted.error) {
        throw new Error('Disposable user_not_found setup failed.');
      }
      markDeleted();

      const result = await getUserThroughSsr(config, clients.createServerClient, session);
      return sanitizeSdkObservation('user_not_found', 'getUser', result.error);
    }
  );
}

/**
 * Reproduce session_not_found after revoking one exact disposable session.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @param {ReturnType<typeof loadInstalledSupabaseClients>} clients installed clients
 * @param {ReturnType<Function>} admin secret-key client
 * @returns {Promise<Record<string, unknown>>} sanitized deployed tuple
 */
async function captureSessionNotFound(config, clients, admin) {
  return withDisposableSession(config, clients, admin, async ({ session }) => {
    const revoked = await admin.auth.admin.signOut(session.access_token, 'local');
    if (revoked.error) {
      throw new Error('Disposable session_not_found setup failed.');
    }

    const result = await getUserThroughSsr(config, clients.createServerClient, session);
    return sanitizeSdkObservation('session_not_found', 'getUser', result.error);
  });
}

/**
 * Reproduce refresh_token_not_found with a same-length nonexistent token.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @param {ReturnType<typeof loadInstalledSupabaseClients>} clients installed clients
 * @param {ReturnType<Function>} admin secret-key client
 * @returns {Promise<Record<string, unknown>>} sanitized deployed tuple
 */
async function captureRefreshTokenNotFound(config, clients, admin) {
  return withDisposableSession(config, clients, admin, async ({ session }) => {
    const tokenLength = session.refresh_token.length;
    const nonexistentToken = randomBytes(Math.max(tokenLength, 32))
      .toString('base64url')
      .slice(0, tokenLength);
    const result = await getUserThroughSsr(
      config,
      clients.createServerClient,
      expireSessionLocally({ ...session, refresh_token: nonexistentToken })
    );
    return sanitizeSdkObservation(
      'refresh_token_not_found',
      'implicit_refresh',
      result.error
    );
  });
}

/**
 * Read only the hosted session policy needed for safe error reproduction.
 *
 * Purpose: a fine-grained auth_config_read token verifies reuse/timebox policy
 * through the Management API; all other returned configuration is discarded.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @returns {Promise<{ reuseIntervalSeconds: number|null, sessionExpirySeconds: number|null }>} sanitized policy
 */
async function readHostedSessionPolicy(config) {
  return runHostedStage('management_auth_config', async () => {
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${EXPECTED_SUPABASE_PROJECT_REF}/config/auth`,
      {
        headers: {
          authorization: `Bearer ${config.managementToken}`,
        },
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!response.ok) {
      throw new Error('Hosted Auth configuration inspection failed.');
    }

    const settings = await response.json();
    const reuseInterval = settings?.refresh_token_rotation_enabled === true
      ? settings?.security_refresh_token_reuse_interval
      : null;
    const expiryCandidates = [
      settings?.sessions_inactivity_timeout,
      settings?.sessions_timebox,
    ].filter((value) => Number.isInteger(value) && value > 0);
    const sessionExpirySeconds = expiryCandidates.length > 0
      ? Math.min(...expiryCandidates)
      : null;

    return {
      reuseIntervalSeconds:
        Number.isInteger(reuseInterval) && reuseInterval >= 0 && reuseInterval <= 30
          ? reuseInterval
          : null,
      sessionExpirySeconds:
        Number.isInteger(sessionExpirySeconds) && sessionExpirySeconds <= 30
          ? sessionExpirySeconds
          : null,
    };
  });
}

/**
 * Verify the deployed publishable key at a read-only Auth endpoint.
 *
 * Purpose: a project/key mismatch fails before any disposable user mutation,
 * while the response body remains unparsed and excluded from diagnostics.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @returns {Promise<void>}
 */
async function validateHostedPublishableKey(config) {
  await runHostedStage('publishable_auth_settings', async () => {
    const response = await fetch(`${config.url}/auth/v1/settings`, {
      headers: {
        apikey: config.publishableKey,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error('Hosted Auth publishable-key inspection failed.');
    }

    return undefined;
  });
}

/**
 * Verify all hosted credentials without mutating Auth or database state.
 *
 * Purpose: Management API access, publishable Auth access, and installed-SDK
 * secret-key administration fail as distinct sanitized stages before capture.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @param {ReturnType<typeof loadInstalledSupabaseClients>} clients installed clients
 * @returns {Promise<{ reuseIntervalSeconds: number|null, sessionExpirySeconds: number|null }>} hosted policy reused by capture
 */
async function inspectHostedGate0Credentials(config, clients) {
  const sessionPolicy = await readHostedSessionPolicy(config);
  await validateHostedPublishableKey(config);

  const admin = createEphemeralClient(
    clients.createClient,
    config.url,
    config.secretKey
  );
  await runHostedStage('secret_auth_admin', async () => {
    const inspected = await admin.auth.admin.getUserById(PREFLIGHT_NONEXISTENT_USER_ID);
    const expectedNotFound = inspected.error?.code === 'user_not_found'
      && inspected.error?.status === 404;

    if (inspected.error && !expectedNotFound) {
      throw new Error('Hosted Auth secret-key inspection failed.');
    }

    return undefined;
  });

  return sessionPolicy;
}

/**
 * Run the read-only hosted credential preflight from a process environment.
 *
 * Purpose: the workflow can validate exact new-key compatibility separately
 * from its explicitly authorized disposable-user mutation step.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @returns {Promise<void>}
 */
async function preflightHostedGate0Credentials(env = process.env) {
  const config = validateGate0Environment(env, { requireDestructiveOptIn: false });
  const clients = loadInstalledSupabaseClients();
  await inspectHostedGate0Credentials(config, clients);
}

/**
 * Wait just beyond a safely verified hosted reuse interval.
 *
 * Purpose: the wait is bounded below 60 seconds and used only for one isolated
 * disposable token family.
 *
 * @param {number} intervalSeconds hosted reuse interval
 * @returns {Promise<void>}
 */
async function waitBeyondReuseInterval(intervalSeconds) {
  await new Promise((resolve) => {
    setTimeout(resolve, (intervalSeconds + 2) * 1000);
  });
}

/**
 * Reproduce session_expired only when normal hosted policy is safely short.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @param {ReturnType<typeof loadInstalledSupabaseClients>} clients installed clients
 * @param {ReturnType<Function>} admin secret-key client
 * @param {number|null} sessionExpirySeconds verified hosted expiry boundary
 * @returns {Promise<Record<string, unknown>>} sanitized deployed tuple
 */
async function captureSessionExpired(config, clients, admin, sessionExpirySeconds) {
  if (sessionExpirySeconds === null) {
    return unavailableObservation('session_expired', 'getUser');
  }

  return withDisposableSession(config, clients, admin, async ({ session }) => {
    await waitBeyondReuseInterval(sessionExpirySeconds);
    const result = await getUserThroughSsr(config, clients.createServerClient, session);
    return sanitizeSdkObservation('session_expired', 'getUser', result.error);
  });
}

/**
 * Reproduce refresh_token_already_used only after hosted config verification.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @param {ReturnType<typeof loadInstalledSupabaseClients>} clients installed clients
 * @param {ReturnType<Function>} admin secret-key client
 * @param {number|null} reuseIntervalSeconds verified hosted interval
 * @returns {Promise<Record<string, unknown>>} sanitized deployed tuple
 */
async function captureRefreshTokenAlreadyUsed(
  config,
  clients,
  admin,
  reuseIntervalSeconds
) {
  if (reuseIntervalSeconds === null) {
    return unavailableObservation('refresh_token_already_used', 'implicit_refresh');
  }

  return withDisposableSession(config, clients, admin, async ({ session }) => {
    const oldRefreshToken = session.refresh_token;
    const refreshClient = createEphemeralClient(
      clients.createClient,
      config.url,
      config.publishableKey
    );
    const rotated = await refreshClient.auth.refreshSession({
      refresh_token: oldRefreshToken,
    });

    if (rotated.error || !rotated.data?.session) {
      throw new Error('Disposable refresh-token rotation failed.');
    }

    await waitBeyondReuseInterval(reuseIntervalSeconds);
    const result = await getUserThroughSsr(
      config,
      clients.createServerClient,
      expireSessionLocally({ ...session, refresh_token: oldRefreshToken })
    );
    return sanitizeSdkObservation(
      'refresh_token_already_used',
      'implicit_refresh',
      result.error
    );
  });
}

/**
 * Reproduce user_banned by banning only the scenario-owned disposable user.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @param {ReturnType<typeof loadInstalledSupabaseClients>} clients installed clients
 * @param {ReturnType<Function>} admin service-role client
 * @returns {Promise<Record<string, unknown>>} sanitized deployed tuple
 */
async function captureUserBanned(config, clients, admin) {
  return withDisposableSession(config, clients, admin, async ({ userId, session }) => {
    const banned = await admin.auth.admin.updateUserById(userId, { ban_duration: '1h' });
    if (banned.error) {
      throw new Error('Disposable user_banned setup failed.');
    }

    const result = await getUserThroughSsr(
      config,
      clients.createServerClient,
      expireSessionLocally(session)
    );
    return sanitizeSdkObservation('user_banned', 'implicit_refresh', result.error);
  });
}

/**
 * Capture a safely formatted hosted Auth server version when exposed.
 *
 * Purpose: the response body is never retained; only a strict semantic version
 * string can enter evidence, and absence is represented as null.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @returns {Promise<string|null>} sanitized hosted Auth version
 */
async function captureHostedAuthVersion(config) {
  let version;

  try {
    const response = await fetch(`${config.url}/auth/v1/health`, {
      headers: {
        apikey: config.publishableKey,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return null;
    }

    ({ version } = await response.json());
  } catch {
    return null;
  }

  return typeof version === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    ? version
    : null;
}

/**
 * Capture all seven candidates at the exact installed application SDK surface.
 *
 * Purpose: scenarios run serially to isolate provider mutations and guarantee
 * cleanup before the next disposable identity is created.
 *
 * @param {Record<string, string>} config trusted target configuration
 * @param {ReturnType<typeof loadInstalledSupabaseClients>} clients installed clients
 * @param {{ reuseIntervalSeconds: number|null, sessionExpirySeconds: number|null }} sessionPolicy verified hosted policy
 * @returns {Promise<Record<string, unknown>[]>} complete ordered evidence partition
 */
async function captureSessionErrorEvidence(config, clients, sessionPolicy) {
  const admin = createEphemeralClient(
    clients.createClient,
    config.url,
    config.secretKey
  );
  const {
    reuseIntervalSeconds,
    sessionExpirySeconds,
  } = sessionPolicy;

  return [
    await runHostedStage(
      'scenario_bad_jwt',
      () => captureBadJwt(config, clients, admin)
    ),
    await runHostedStage(
      'scenario_session_expired',
      () => captureSessionExpired(config, clients, admin, sessionExpirySeconds)
    ),
    await runHostedStage(
      'scenario_session_not_found',
      () => captureSessionNotFound(config, clients, admin)
    ),
    await runHostedStage(
      'scenario_refresh_token_not_found',
      () => captureRefreshTokenNotFound(config, clients, admin)
    ),
    await runHostedStage(
      'scenario_refresh_token_already_used',
      () => captureRefreshTokenAlreadyUsed(
        config,
        clients,
        admin,
        reuseIntervalSeconds
      )
    ),
    await runHostedStage(
      'scenario_user_not_found',
      () => captureUserNotFound(config, clients, admin)
    ),
    await runHostedStage(
      'scenario_user_banned',
      () => captureUserBanned(config, clients, admin)
    ),
  ];
}

/**
 * Assert the complete evidence object contains only approved sanitized fields.
 *
 * Purpose: this is the final fail-closed boundary before JSON can reach stdout;
 * unexpected fields or incomplete candidate partitions abort the run.
 *
 * @param {Record<string, unknown>} evidence candidate sanitized output
 * @returns {void}
 */
function assertSafeEvidence(evidence) {
  if (!hasExactKeys(evidence, [
    'schemaVersion',
    'target',
    'dependencies',
    'cookieEvidence',
    'sessionErrors',
  ])) {
    throw new Error('Gate-0 evidence contains an unexpected top-level field.');
  }

  if (!hasExactKeys(evidence.target, ['projectRef', 'authServerVersion'])) {
    throw new Error('Gate-0 target evidence contains an unexpected field.');
  }

  if (!hasExactKeys(evidence.dependencies, [
    'ssrVersion',
    'supabaseJsVersion',
    'authJsVersion',
  ])) {
    throw new Error('Gate-0 dependency evidence contains an unexpected field.');
  }

  if (!hasExactKeys(evidence.cookieEvidence, [
    'fixtureId',
    'initialLoginChunks',
    'refreshedSessionChunks',
    'maximumChunks',
    'expectedMaximumChunks',
    'reproducedExpectedMaximum',
  ])) {
    throw new Error('Gate-0 cookie evidence contains an unexpected field.');
  }

  if (
    evidence.schemaVersion !== GATE0_EVIDENCE_SCHEMA_VERSION
    || evidence.target.projectRef !== EXPECTED_SUPABASE_PROJECT_REF
    || (evidence.target.authServerVersion !== null
      && (
        typeof evidence.target.authServerVersion !== 'string'
        || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
          .test(evidence.target.authServerVersion)
      ))
    || JSON.stringify(evidence.dependencies)
      !== JSON.stringify(GOOGLE_SESSION_FIXTURE_V1.installedDependencies)
    || evidence.cookieEvidence.fixtureId !== GOOGLE_SESSION_FIXTURE_V1.id
    || evidence.cookieEvidence.initialLoginChunks
      !== GOOGLE_SESSION_FIXTURE_V1_INITIAL_LOGIN_CHUNKS
    || evidence.cookieEvidence.refreshedSessionChunks
      !== GOOGLE_SESSION_FIXTURE_V1_REFRESHED_SESSION_CHUNKS
    || evidence.cookieEvidence.maximumChunks !== EXPECTED_MAX_AUTH_COOKIE_CHUNKS
    || evidence.cookieEvidence.expectedMaximumChunks !== EXPECTED_MAX_AUTH_COOKIE_CHUNKS
    || evidence.cookieEvidence.reproducedExpectedMaximum !== true
  ) {
    throw new Error('Gate-0 evidence does not satisfy its fixed target or fixture contract.');
  }

  if (
    !Array.isArray(evidence.sessionErrors)
    || evidence.sessionErrors.length !== SESSION_ERROR_CANDIDATES.length
  ) {
    throw new Error('Gate-0 session evidence is incomplete.');
  }

  evidence.sessionErrors.forEach((observation, index) => {
    if (!hasExactKeys(observation, [
      'candidate',
      'operation',
      'exportedClass',
      'code',
      'codeObserved',
      'status',
      'disposition',
    ])) {
      throw new Error('Gate-0 session evidence contains an unexpected field.');
    }

    if (
      observation.candidate !== SESSION_ERROR_CANDIDATES[index]
      || !['getUser', 'implicit_refresh'].includes(observation.operation)
      || !['allowlisted', 'unavailable'].includes(observation.disposition)
      || (observation.exportedClass !== null
        && (
          typeof observation.exportedClass !== 'string'
          || !/^Auth[A-Za-z]+Error$/.test(observation.exportedClass)
        ))
      || (observation.status !== null
        && (
          !Number.isInteger(observation.status)
          || observation.status < 100
          || observation.status > 599
        ))
      || observation.codeObserved !== (observation.code !== null)
      || (observation.disposition === 'allowlisted'
        && observation.code !== observation.candidate)
    ) {
      throw new Error('Gate-0 session evidence violates its sanitized partition.');
    }
  });
}

/**
 * Run the complete credentialed Gate-0 capture after strict preflight.
 *
 * Purpose: this single orchestration boundary retains only versions, chunk
 * counts, target ref, and sanitized SDK error tuples.
 *
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} env environment snapshot
 * @returns {Promise<Record<string, unknown>>} safe evidence document
 */
async function captureGate0AuthEvidence(env = process.env) {
  const config = validateGate0Environment(env);
  const clients = loadInstalledSupabaseClients();
  const sessionPolicy = await inspectHostedGate0Credentials(config, clients);
  const evidence = {
    schemaVersion: GATE0_EVIDENCE_SCHEMA_VERSION,
    target: {
      projectRef: EXPECTED_SUPABASE_PROJECT_REF,
      authServerVersion: await captureHostedAuthVersion(config),
    },
    dependencies: clients.versions,
    cookieEvidence: captureGoogleSessionFixtureEvidence(),
    sessionErrors: await captureSessionErrorEvidence(config, clients, sessionPolicy),
  };

  await runHostedStage('evidence_contract', async () => {
    assertSafeEvidence(evidence);
  });
  return evidence;
}

module.exports = {
  AUTH_COOKIE_STORAGE_KEY,
  EXPECTED_MAX_AUTH_COOKIE_CHUNKS,
  EXPECTED_SUPABASE_PROJECT_REF,
  EXPECTED_SUPABASE_URL,
  FORBIDDEN_APPLICATION_ENV_NAMES,
  GATE0_ENV_NAMES,
  GATE0_EVIDENCE_SCHEMA_VERSION,
  GATE0_HOSTED_FAILURE_STAGES,
  Gate0CleanupError,
  Gate0ConfigurationError,
  Gate0StageError,
  GOOGLE_SESSION_FIXTURE_V1,
  GOOGLE_SESSION_FIXTURE_V1_INITIAL_LOGIN_CHUNKS,
  GOOGLE_SESSION_FIXTURE_V1_REFRESHED_SESSION_CHUNKS,
  SESSION_ERROR_CANDIDATES,
  buildBoundedGoogleUserMetadata,
  buildGoogleSessionFixtures,
  captureGate0AuthEvidence,
  captureGoogleSessionFixtureEvidence,
  captureHostedAuthVersion,
  classifyGoogleSessionCredential,
  countSerializedSessionChunks,
  createDisposableCredentials,
  findMissingEnvironmentNames,
  formatEnvironmentNameDiagnostic,
  inspectHostedGate0Credentials,
  preflightHostedGate0Credentials,
  proveWrongProjectRefRefusal,
  runHostedStage,
  sanitizeSdkObservation,
  assertGate0SupabaseTarget,
  assertSafeEvidence,
  utf8ByteLength,
  unavailableObservation,
  validateGate0Environment,
  withDisposableSession,
};
