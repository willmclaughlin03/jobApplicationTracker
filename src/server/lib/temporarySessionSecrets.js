import { z } from 'zod';
import {
  decodeTemporarySessionHmacKey,
  TEMPORARY_SESSION_KEY_ID_PATTERN,
  TEMPORARY_SESSION_MAX_GENERATION,
} from './temporarySessionIdentity.js';
import {
  TEMPORARY_SESSION_TELEMETRY_EVENTS,
  temporarySessionTelemetry,
} from './temporarySessionTelemetry.js';

export const TEMPORARY_SESSION_SECRET_MODES = Object.freeze({
  LOCAL: 'local',
  VERCEL: 'vercel',
});
export const TEMPORARY_SESSION_ALLOWED_GENERATIONS = Object.freeze([1, 2]);

const MAX_SECRET_PAYLOAD_BYTES = 8_192;
const MAX_REDIS_URL_LENGTH = 2_048;
const MAX_REDIS_TOKEN_LENGTH = 2_048;
const LOCAL_NODE_ENVIRONMENTS = new Set(['development', 'test']);

const hmacKeyEntrySchema = z.object({
  generation: z.number().int().min(1).max(TEMPORARY_SESSION_MAX_GENERATION),
  keyId: z.string().min(1).max(64).regex(TEMPORARY_SESSION_KEY_ID_PATTERN),
  key: z.string().length(43),
}).strict();

const hmacSecretSchema = z.object({
  schemaVersion: z.literal(1),
  active: hmacKeyEntrySchema,
  previous: hmacKeyEntrySchema.nullable(),
}).strict();

const redisSecretSchema = z.object({
  schemaVersion: z.literal(1),
  url: z.string().min(1).max(MAX_REDIS_URL_LENGTH),
  token: z.string().min(1).max(MAX_REDIS_TOKEN_LENGTH),
}).strict();

/**
 * Creates the only error exposed by the deployment configuration boundary.
 *
 * Why: environment values and validation details must not reach request logs,
 * responses, snapshots, or telemetry.
 *
 * @returns {Error} sanitized availability error
 */
function createUnavailableError() {
  const error = new Error('temporary session secrets are unavailable');
  error.name = 'TemporarySessionSecretsUnavailableError';
  return error;
}

/**
 * Invokes a fixed configuration event hook without affecting enforcement.
 *
 * @param {Function} onEvent fixed telemetry callback
 * @param {string} event approved configuration event
 * @returns {void}
 */
function emitConfigurationEvent(onEvent, event) {
  try {
    onEvent(event);
  } catch {
    // Telemetry remains observational.
  }
}

/**
 * Records one fixed loader event in the shared bounded telemetry accumulator.
 *
 * @param {string} event approved configuration event
 * @returns {void}
 */
function recordConfigurationEvent(event) {
  temporarySessionTelemetry.record(event);
}

/**
 * Parses one bounded JSON value without retaining its raw representation.
 *
 * Why: oversized, malformed, array, and primitive values fail at the external
 * boundary before schema-specific validation.
 *
 * @param {unknown} rawPayload environment string or injected fixture object
 * @returns {unknown} parsed JSON document
 * @throws {Error} sanitized availability error
 */
function parseSecretJson(rawPayload) {
  let serialized = rawPayload;
  if (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
    try {
      serialized = JSON.stringify(rawPayload);
    } catch {
      throw createUnavailableError();
    }
  }
  if (typeof serialized !== 'string'
    || serialized.length === 0
    || Buffer.byteLength(serialized, 'utf8') > MAX_SECRET_PAYLOAD_BYTES) {
    throw createUnavailableError();
  }
  try {
    return JSON.parse(serialized);
  } catch {
    throw createUnavailableError();
  }
}

/**
 * Copies and freezes one validated keyring entry.
 *
 * Why: consumers must observe one immutable generation/key tuple for the full
 * limiter operation and cannot mutate cached configuration.
 *
 * @param {object} entry parsed key entry
 * @returns {Readonly<object>} immutable entry
 */
function freezeKeyEntry(entry) {
  return Object.freeze({
    generation: entry.generation,
    keyId: entry.keyId,
    key: entry.key,
  });
}

/**
 * Validates and freezes the bounded HMAC keyring payload.
 *
 * @param {unknown} rawPayload raw JSON string or injected fixture
 * @param {readonly number[]} allowedGenerations code-owned generation allowlist
 * @returns {Readonly<{schemaVersion: 1, active: object, previous: object|null}>} keyring
 * @throws {Error} sanitized availability error
 */
export function parseTemporarySessionHmacSecret(
  rawPayload,
  allowedGenerations = TEMPORARY_SESSION_ALLOWED_GENERATIONS
) {
  const parsed = hmacSecretSchema.safeParse(parseSecretJson(rawPayload));
  if (!parsed.success) throw createUnavailableError();

  const allowed = new Set(allowedGenerations);
  const { active, previous } = parsed.data;
  try {
    decodeTemporarySessionHmacKey(active.key);
    if (previous) decodeTemporarySessionHmacKey(previous.key);
  } catch {
    throw createUnavailableError();
  }

  if (!allowed.has(active.generation)
    || (previous && !allowed.has(previous.generation))
    || (previous && previous.generation !== active.generation - 1)
    || (previous && previous.keyId === active.keyId)
    || (previous && previous.key === active.key)) {
    throw createUnavailableError();
  }

  return Object.freeze({
    schemaVersion: 1,
    active: freezeKeyEntry(active),
    previous: previous ? freezeKeyEntry(previous) : null,
  });
}

/**
 * Validates a deployed Upstash REST origin without exposing URL components.
 *
 * @param {string} value candidate Redis REST URL
 * @returns {boolean} whether the origin matches the approved Upstash shape
 */
function isApprovedRedisUrl(value) {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    const approvedHost = hostname.endsWith('.upstash.io') || hostname.endsWith('.upstash.com');
    return parsed.protocol === 'https:'
      && approvedHost
      && parsed.username === ''
      && parsed.password === ''
      && parsed.port === ''
      && parsed.pathname === '/'
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

/**
 * Validates and freezes the bounded Redis credential payload.
 *
 * @param {unknown} rawPayload raw JSON string or injected fixture
 * @returns {Readonly<{schemaVersion: 1, url: string, token: string}>} credentials
 * @throws {Error} sanitized availability error
 */
export function parseTemporarySessionRedisSecret(rawPayload) {
  const parsed = redisSecretSchema.safeParse(parseSecretJson(rawPayload));
  if (!parsed.success || !isApprovedRedisUrl(parsed.data.url)) {
    throw createUnavailableError();
  }
  return Object.freeze({
    schemaVersion: 1,
    url: parsed.data.url,
    token: parsed.data.token,
  });
}

/**
 * Resolves the strict runtime configuration-source policy.
 *
 * Why: deployed execution must explicitly select Vercel and agree with its
 * runtime marker; only local/test execution may consume local fixtures.
 *
 * @param {object} [options] explicit mode and environment seams
 * @param {unknown} [options.mode] explicitly injected mode
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} [options.env] environment snapshot
 * @returns {'local'|'vercel'|null} validated mode
 */
export function resolveTemporarySessionSecretMode(options = {}) {
  const env = options.env ?? process.env;
  const nodeEnvironment = env?.NODE_ENV;
  const isVercelRuntime = env?.VERCEL === '1';
  const configured = options.mode ?? env?.TEMPORARY_SESSION_CEILING_SECRET_MODE
    ?? (LOCAL_NODE_ENVIRONMENTS.has(nodeEnvironment) && !isVercelRuntime ? 'local' : undefined);
  if (!Object.values(TEMPORARY_SESSION_SECRET_MODES).includes(configured)) return null;
  if (configured === TEMPORARY_SESSION_SECRET_MODES.LOCAL) {
    return LOCAL_NODE_ENVIRONMENTS.has(nodeEnvironment) && !isVercelRuntime ? configured : null;
  }
  return nodeEnvironment === 'production' && isVercelRuntime ? configured : null;
}

/**
 * Freezes one atomically installed runtime HMAC/Redis pair.
 *
 * @param {object} hmac validated HMAC keyring
 * @param {object} redis validated Redis credentials
 * @returns {Readonly<object>} immutable runtime pair with private cache identity
 */
function createRuntimePair(hmac, redis) {
  return Object.freeze({
    hmac,
    redis,
    cacheIdentity: Object.freeze({}),
  });
}

/**
 * Creates an isolated deployment-bound configuration loader.
 *
 * Side effects: reads two environment-backed values once, installs one frozen
 * pair on complete success, or retains one sanitized permanent-failure sentinel
 * for the instance. The reset seam exists only for isolated tests.
 *
 * @param {object} [options] runtime configuration and deterministic seams
 * @returns {{getRuntimePair: Function, reset: Function, getSnapshot: Function}} loader
 */
export function createTemporarySessionSecrets(options = {}) {
  const env = options.env ?? process.env;
  const modeOption = options.mode;
  const allowedGenerations = options.allowedGenerations ?? TEMPORARY_SESSION_ALLOWED_GENERATIONS;
  const localHmacSecret = options.localHmacSecret;
  const localRedisSecret = options.localRedisSecret;
  const localSecretProvider = options.localSecretProvider;
  const onEvent = options.onEvent ?? recordConfigurationEvent;

  if (typeof onEvent !== 'function'
    || (localSecretProvider !== undefined && typeof localSecretProvider !== 'function')
    || !Array.isArray(allowedGenerations)
    || allowedGenerations.length < 1
    || allowedGenerations.length > 2) {
    throw new TypeError('temporary session secret dependencies are invalid');
  }

  let cachedPair = null;
  let permanentFailure = false;

  /**
   * Reads explicit local/test fixtures or local Redis credentials.
   *
   * @returns {{hmacPayload: unknown, redisPayload: unknown}} local payloads
   */
  function readLocalPayloads() {
    if (localSecretProvider) {
      const provided = localSecretProvider();
      return {
        hmacPayload: provided?.hmacSecret,
        redisPayload: provided?.redisSecret,
      };
    }
    const hmacPayload = localHmacSecret ?? env.TEMPORARY_SESSION_CEILING_LOCAL_HMAC_SECRET;
    const redisPayload = localRedisSecret
      ?? env.TEMPORARY_SESSION_CEILING_LOCAL_REDIS_SECRET
      ?? {
        schemaVersion: 1,
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
      };
    return { hmacPayload, redisPayload };
  }

  /**
   * Reads the two approved Vercel Sensitive Environment Variable values.
   *
   * Why: deployed mode has no standalone Redis fallback and does not read any
   * value until the explicit mode/runtime contract has passed.
   *
   * @returns {{hmacPayload: unknown, redisPayload: unknown}} deployed payloads
   */
  function readVercelPayloads() {
    return {
      hmacPayload: env.TEMPORARY_SESSION_CEILING_HMAC_KEYRING_JSON,
      redisPayload: env.TEMPORARY_SESSION_CEILING_UPSTASH_JSON,
    };
  }

  /**
   * Validates both configured values before atomically installing a pair.
   *
   * @returns {Readonly<object>} immutable runtime pair
   * @throws {Error} sanitized availability error
   */
  function loadRuntimePair() {
    const mode = resolveTemporarySessionSecretMode({ mode: modeOption, env });
    if (!mode) throw createUnavailableError();
    const payloads = mode === TEMPORARY_SESSION_SECRET_MODES.LOCAL
      ? readLocalPayloads()
      : readVercelPayloads();
    const hmac = parseTemporarySessionHmacSecret(payloads.hmacPayload, allowedGenerations);
    const redis = parseTemporarySessionRedisSecret(payloads.redisPayload);
    return createRuntimePair(hmac, redis);
  }

  /**
   * Returns the instance-lifetime pair or the memoized configuration failure.
   *
   * @returns {Promise<Readonly<object>>} immutable HMAC/Redis snapshot
   */
  async function getRuntimePair() {
    if (cachedPair) return cachedPair;
    if (permanentFailure) throw createUnavailableError();
    try {
      cachedPair = loadRuntimePair();
      emitConfigurationEvent(
        onEvent,
        TEMPORARY_SESSION_TELEMETRY_EVENTS.CONFIGURATION_SUCCEEDED
      );
      return cachedPair;
    } catch {
      permanentFailure = true;
      emitConfigurationEvent(
        onEvent,
        TEMPORARY_SESSION_TELEMETRY_EVENTS.CONFIGURATION_FAILED
      );
      throw createUnavailableError();
    }
  }

  /**
   * Clears memoized success or failure for isolated tests.
   *
   * @returns {void}
   */
  function reset() {
    cachedPair = null;
    permanentFailure = false;
  }

  /**
   * Returns value-free loader state for isolated assertions.
   *
   * @returns {{hasCachedPair: boolean, permanentFailure: boolean}} safe state
   */
  function getSnapshot() {
    return {
      hasCachedPair: cachedPair !== null,
      permanentFailure,
    };
  }

  return { getRuntimePair, reset, getSnapshot };
}

export const temporarySessionSecrets = createTemporarySessionSecrets();

/**
 * Acquires the singleton runtime pair for shared Redis consumers.
 *
 * @returns {Promise<Readonly<object>>} immutable HMAC/Redis snapshot
 */
export function getTemporarySessionRuntimePair() {
  return temporarySessionSecrets.getRuntimePair();
}
