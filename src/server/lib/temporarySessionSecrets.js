import { performance } from 'node:perf_hooks';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
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
  AWS_SECRETS_MANAGER: 'aws-secrets-manager',
});
export const TEMPORARY_SESSION_SECRET_TTL_MS = 60_000;
export const TEMPORARY_SESSION_SECRET_DEADLINE_MS = 1_000;
export const TEMPORARY_SESSION_SECRET_COOLDOWN_MS = 5_000;
export const TEMPORARY_SESSION_ROTATION_DRAIN_MS = 62_000;
export const TEMPORARY_SESSION_ALLOWED_GENERATIONS = Object.freeze([1, 2]);

const MAX_SECRET_PAYLOAD_BYTES = 8_192;
const MAX_SECRET_IDENTIFIER_LENGTH = 2_048;
const MAX_REDIS_URL_LENGTH = 2_048;
const MAX_REDIS_TOKEN_LENGTH = 2_048;

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
 * Creates the only error exposed by the secret boundary.
 *
 * Why: provider errors, secret identifiers, payloads, and validation details
 * must not escape into request logging or response telemetry.
 *
 * @returns {Error} sanitized availability error
 */
function createUnavailableError() {
  const error = new Error('temporary session secrets are unavailable');
  error.name = 'TemporarySessionSecretsUnavailableError';
  return error;
}

/**
 * Reads the monotonic process clock used for TTL and cooldown decisions.
 *
 * Why: wall-clock corrections must not revive an expired credential snapshot.
 *
 * @returns {number} process-relative milliseconds
 */
function readMonotonicMilliseconds() {
  return performance.now();
}

/**
 * Invokes a fixed secret-refresh event hook without affecting enforcement.
 *
 * @param {Function} onEvent fixed telemetry callback
 * @param {string} event approved secret event
 * @returns {void}
 */
function emitSecretEvent(onEvent, event) {
  try {
    onEvent(event);
  } catch {
    // Telemetry remains observational.
  }
}

/**
 * Parses one bounded JSON secret payload without retaining raw provider data.
 *
 * Why: oversized, non-string, malformed, array, and primitive payloads fail at
 * the external boundary before schema-specific validation.
 *
 * @param {unknown} rawPayload secret string or injected fixture object
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
 * limiter operation and cannot be allowed to mutate cached configuration.
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
 * Why: only one active key and an optional immediately preceding bridge key are
 * accepted, and every generation must be selected by application code.
 *
 * @param {unknown} rawPayload raw secret string or injected fixture
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
 * Validates the deployed Upstash REST origin without exposing URL components.
 *
 * Why: credentials, non-HTTPS origins, alternate providers, paths, queries,
 * fragments, and explicit ports are not part of the approved runtime contract.
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
 * Why: deployed Redis must use one validated HTTPS Upstash origin/token pair
 * and may never consume a partially parsed provider payload.
 *
 * @param {unknown} rawPayload raw secret string or injected fixture
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
 * Resolves the strict runtime secret-source policy.
 *
 * Why: production must use Secrets Manager; local/test execution may use
 * explicit fixture or environment credentials without weakening production.
 *
 * @param {object} [options] explicit mode and environment seams
 * @param {unknown} [options.mode] explicitly injected mode
 * @param {NodeJS.ProcessEnv|Record<string, unknown>} [options.env] environment snapshot
 * @returns {'local'|'aws-secrets-manager'|null} validated mode
 */
export function resolveTemporarySessionSecretMode(options = {}) {
  const env = options.env ?? process.env;
  const nodeEnvironment = env?.NODE_ENV;
  const configured = options.mode ?? env?.TEMPORARY_SESSION_CEILING_SECRET_MODE
    ?? ((nodeEnvironment === 'test' || nodeEnvironment === 'development') ? 'local' : undefined);
  if (!Object.values(TEMPORARY_SESSION_SECRET_MODES).includes(configured)) return null;
  if (nodeEnvironment === 'production'
    && configured !== TEMPORARY_SESSION_SECRET_MODES.AWS_SECRETS_MANAGER) {
    return null;
  }
  return configured;
}

/**
 * Freezes one atomically replaceable runtime HMAC/Redis pair.
 *
 * Why: identity derivation and Redis client construction for one request must
 * reference exactly the same validated refresh result.
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
 * Validates a bounded secret resource identifier without returning its value.
 *
 * Why: identifiers are configuration, not evidence or telemetry fields.
 *
 * @param {unknown} value candidate resource identifier
 * @returns {boolean} whether the identifier is safe to pass to the AWS SDK
 */
function isValidSecretIdentifier(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SECRET_IDENTIFIER_LENGTH
    && value === value.trim();
}

/**
 * Extracts the only supported text payload from one AWS response.
 *
 * Why: binary or malformed responses are rejected, and version/resource fields
 * are deliberately ignored so they cannot enter application state.
 *
 * @param {unknown} response AWS GetSecretValue response
 * @returns {string} raw SecretString for immediate validation
 * @throws {Error} sanitized availability error
 */
function readAwsSecretString(response) {
  if (!response || typeof response.SecretString !== 'string') throw createUnavailableError();
  return response.SecretString;
}

/**
 * Waits for a promise only until an absolute monotonic deadline.
 *
 * Why: a follower joining a single-flight refresh may have a shorter enclosing
 * limiter deadline than the request that started the refresh.
 *
 * @param {Promise<unknown>} promise shared operation
 * @param {number} deadlineAt absolute monotonic deadline
 * @param {Function} now monotonic clock
 * @param {Function} setTimer timeout seam
 * @param {Function} clearTimer timeout cleanup seam
 * @returns {Promise<unknown>} operation result
 */
function waitUntilDeadline(promise, deadlineAt, now, setTimer, clearTimer) {
  if (!Number.isFinite(deadlineAt)) return promise;
  const remaining = deadlineAt - now();
  if (remaining <= 0) return Promise.reject(createUnavailableError());

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimer(() => reject(createUnavailableError()), remaining);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimer(timeoutId));
}

/**
 * Creates an isolated atomic secret-pair loader with deterministic test seams.
 *
 * Side effects: fetches two AWS secrets concurrently when configured, caches a
 * validated pair for 60 seconds, and applies a five-second refresh cooldown.
 *
 * @param {object} [options] runtime configuration and deterministic seams
 * @returns {{getRuntimePair: Function, reset: Function, getSnapshot: Function}} loader
 */
export function createTemporarySessionSecrets(options = {}) {
  const now = options.now ?? readMonotonicMilliseconds;
  const setTimer = options.setTimeoutFunction ?? setTimeout;
  const clearTimer = options.clearTimeoutFunction ?? clearTimeout;
  const env = options.env ?? process.env;
  const modeOption = options.mode;
  const allowedGenerations = options.allowedGenerations ?? TEMPORARY_SESSION_ALLOWED_GENERATIONS;
  const localHmacSecret = options.localHmacSecret;
  const localRedisSecret = options.localRedisSecret;
  const localSecretProvider = options.localSecretProvider;
  const awsClientOption = options.awsClient;
  const onEvent = options.onEvent
    ?? ((event) => temporarySessionTelemetry.record(event));
  const awsClientFactory = options.awsClientFactory
    ?? (() => new SecretsManagerClient({ maxAttempts: 2 }));

  if (typeof now !== 'function'
    || typeof setTimer !== 'function'
    || typeof clearTimer !== 'function'
    || typeof awsClientFactory !== 'function'
    || typeof onEvent !== 'function'
    || (localSecretProvider !== undefined && typeof localSecretProvider !== 'function')
    || !Array.isArray(allowedGenerations)
    || allowedGenerations.length < 1
    || allowedGenerations.length > 2) {
    throw new TypeError('temporary session secret dependencies are invalid');
  }

  let cachedPair = null;
  let cachedAt = null;
  let refreshPromise = null;
  let cooldownUntil = 0;
  let awsClient = awsClientOption ?? null;
  let activeGenerationFirstSeenAt = null;

  /**
   * Reads explicit local/test secret fixtures or credentials.
   *
   * Why: local integration remains possible without permitting environment
   * fallback after deployed Secrets Manager failure.
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
   * Fetches both AWS secret payloads under one abort deadline.
   *
   * Why: HMAC and Redis configuration form one atomic unit and retries for both
   * SDK calls must remain inside the same one-second budget.
   *
   * @param {number} overallDeadlineAt enclosing limiter deadline
   * @returns {Promise<{hmacPayload: string, redisPayload: string}>} raw payloads
   */
  async function readAwsPayloads(overallDeadlineAt) {
    const hmacSecretId = env.TEMPORARY_SESSION_CEILING_HMAC_SECRET_ID;
    const redisSecretId = env.TEMPORARY_SESSION_CEILING_REDIS_SECRET_ID;
    if (!isValidSecretIdentifier(hmacSecretId) || !isValidSecretIdentifier(redisSecretId)) {
      throw createUnavailableError();
    }

    if (!awsClient) awsClient = awsClientFactory();
    if (!awsClient || typeof awsClient.send !== 'function') throw createUnavailableError();

    const controller = new AbortController();
    const deadlineAt = Math.min(overallDeadlineAt, now() + TEMPORARY_SESSION_SECRET_DEADLINE_MS);
    const remaining = deadlineAt - now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw createUnavailableError();
    const timeoutId = setTimer(() => controller.abort(), remaining);

    const send = async (secretId) => {
      try {
        return await awsClient.send(
          new GetSecretValueCommand({ SecretId: secretId }),
          { abortSignal: controller.signal }
        );
      } catch {
        controller.abort();
        throw createUnavailableError();
      }
    };

    try {
      const [hmacResponse, redisResponse] = await Promise.all([
        send(hmacSecretId),
        send(redisSecretId),
      ]);
      return {
        hmacPayload: readAwsSecretString(hmacResponse),
        redisPayload: readAwsSecretString(redisResponse),
      };
    } finally {
      clearTimer(timeoutId);
    }
  }

  /**
   * Enforces monotonic adjacent-generation rotation across cached snapshots.
   *
   * Why: rollback, same-generation key changes, third keyspaces, and premature
   * bridge removal can silently reset or split the global allowance.
   *
   * @param {object} nextHmac next validated keyring
   * @param {number} observedAt monotonic refresh completion time
   * @returns {void}
   * @throws {Error} sanitized availability error
   */
  function validateRotation(nextHmac, observedAt) {
    if (!cachedPair) {
      activeGenerationFirstSeenAt = observedAt;
      return;
    }

    const current = cachedPair.hmac;
    if (nextHmac.active.generation < current.active.generation
      || nextHmac.active.generation > current.active.generation + 1) {
      throw createUnavailableError();
    }

    if (nextHmac.active.generation === current.active.generation) {
      if (nextHmac.active.keyId !== current.active.keyId
        || nextHmac.active.key !== current.active.key) {
        throw createUnavailableError();
      }
      if (current.previous && !nextHmac.previous) {
        if (activeGenerationFirstSeenAt === null
          || observedAt - activeGenerationFirstSeenAt < TEMPORARY_SESSION_ROTATION_DRAIN_MS) {
          throw createUnavailableError();
        }
      } else if (Boolean(current.previous) !== Boolean(nextHmac.previous)
        || (current.previous && (current.previous.generation !== nextHmac.previous.generation
          || current.previous.keyId !== nextHmac.previous.keyId
          || current.previous.key !== nextHmac.previous.key))) {
        throw createUnavailableError();
      }
      return;
    }

    if (!nextHmac.previous
      || nextHmac.previous.generation !== current.active.generation
      || nextHmac.previous.keyId !== current.active.keyId
      || nextHmac.previous.key !== current.active.key) {
      throw createUnavailableError();
    }
    activeGenerationFirstSeenAt = observedAt;
  }

  /**
   * Fetches, validates, and atomically installs one runtime pair.
   *
   * @param {number} overallDeadlineAt enclosing limiter deadline
   * @returns {Promise<Readonly<object>>} immutable runtime pair
   */
  async function refresh(overallDeadlineAt) {
    const mode = resolveTemporarySessionSecretMode({ mode: modeOption, env });
    if (!mode) throw createUnavailableError();
    const payloads = mode === TEMPORARY_SESSION_SECRET_MODES.LOCAL
      ? readLocalPayloads()
      : await readAwsPayloads(overallDeadlineAt);

    const hmac = parseTemporarySessionHmacSecret(payloads.hmacPayload, allowedGenerations);
    const redis = parseTemporarySessionRedisSecret(payloads.redisPayload);
    const observedAt = now();
    validateRotation(hmac, observedAt);
    const pair = createRuntimePair(hmac, redis);
    cachedPair = pair;
    cachedAt = observedAt;
    cooldownUntil = 0;
    return pair;
  }

  /**
   * Returns the current pair or joins/starts the per-instance refresh.
   *
   * Side effects: stale snapshots are never returned; refresh failure starts a
   * five-second cooldown and all concurrent waiters share the same outcome.
   *
   * @param {object} [requestOptions] enclosing absolute deadline
   * @param {number} [requestOptions.deadlineAt=Infinity] monotonic deadline
   * @returns {Promise<Readonly<object>>} immutable runtime pair
   */
  async function getRuntimePair(requestOptions = {}) {
    const deadlineAt = requestOptions.deadlineAt ?? Number.POSITIVE_INFINITY;
    const observedAt = now();
    if (!Number.isFinite(observedAt) || observedAt < 0) throw createUnavailableError();
    if (cachedPair && cachedAt !== null && observedAt - cachedAt < TEMPORARY_SESSION_SECRET_TTL_MS) {
      return cachedPair;
    }
    if (observedAt < cooldownUntil) {
      emitSecretEvent(onEvent, TEMPORARY_SESSION_TELEMETRY_EVENTS.SECRET_COOLDOWN_REJECTED);
      throw createUnavailableError();
    }

    if (!refreshPromise) {
      emitSecretEvent(onEvent, TEMPORARY_SESSION_TELEMETRY_EVENTS.SECRET_REFRESH_STARTED);
      const refreshDeadlineAt = Math.min(
        deadlineAt,
        observedAt + TEMPORARY_SESSION_SECRET_DEADLINE_MS
      );
      refreshPromise = refresh(refreshDeadlineAt)
        .then((pair) => {
          emitSecretEvent(onEvent, TEMPORARY_SESSION_TELEMETRY_EVENTS.SECRET_REFRESH_SUCCEEDED);
          return pair;
        })
        .catch(() => {
          cooldownUntil = now() + TEMPORARY_SESSION_SECRET_COOLDOWN_MS;
          emitSecretEvent(onEvent, TEMPORARY_SESSION_TELEMETRY_EVENTS.SECRET_REFRESH_FAILED);
          throw createUnavailableError();
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    return waitUntilDeadline(refreshPromise, deadlineAt, now, setTimer, clearTimer);
  }

  /**
   * Clears cached runtime state for isolated tests.
   *
   * Why: tests must exercise cold start and refresh without exposing secret data
   * through a debug snapshot.
   *
   * @returns {void}
   */
  function reset() {
    cachedPair = null;
    cachedAt = null;
    refreshPromise = null;
    cooldownUntil = 0;
    activeGenerationFirstSeenAt = null;
    awsClient = awsClientOption ?? null;
  }

  /**
   * Returns identifier-free cache state for tests and bounded diagnostics.
   *
   * @returns {object} boolean/count-only loader state
   */
  function getSnapshot() {
    return {
      hasCachedPair: cachedPair !== null,
      refreshInFlight: refreshPromise !== null,
      cooldownActive: now() < cooldownUntil,
    };
  }

  return { getRuntimePair, reset, getSnapshot };
}

export const temporarySessionSecrets = createTemporarySessionSecrets();

/**
 * Acquires the singleton runtime pair for shared Redis consumers.
 *
 * @param {object} [options] enclosing deadline options
 * @returns {Promise<Readonly<object>>} immutable HMAC/Redis snapshot
 */
export function getTemporarySessionRuntimePair(options) {
  return temporarySessionSecrets.getRuntimePair(options);
}
