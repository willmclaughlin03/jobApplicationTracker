import { Redis } from '@upstash/redis';
import { logger } from '../../shared/logger.js';
import {
  getTemporarySessionRuntimePair,
  resolveTemporarySessionSecretMode,
  TEMPORARY_SESSION_SECRET_MODES,
} from './temporarySessionSecrets.js';

const REDIS_REQUEST_TIMEOUT_MS = 1_500;
const REDIS_CLIENT_CACHE_LIMIT = 2;

let redisClient = null;
const redisClientsByIdentity = new Map();
let initializationAttempted = false;
let redisDownLogged = false;
let lastCallSucceeded = null;
let lastCallTime = null;
let localCredentialSnapshot = null;

/**
 * Builds a fresh abort signal for every Upstash REST command.
 *
 * Why: all generic and shared Redis consumers retain the existing 1,500 ms
 * HTTP client timeout rather than relying on a fail-open library default.
 *
 * @returns {AbortSignal} request-scoped timeout signal
 */
function createRedisRequestSignal() {
  return AbortSignal.timeout(REDIS_REQUEST_TIMEOUT_MS);
}

/**
 * Validates an HTTPS Upstash origin without logging URL components.
 *
 * @param {unknown} value candidate Redis URL
 * @param {boolean} requireUpstash whether deployed credentials require Upstash
 * @returns {{valid: boolean, error?: string}} bounded validation result
 */
function validateRedisUrl(value, requireUpstash) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    return { valid: false, error: 'Invalid URL format' };
  }
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:') return { valid: false, error: 'Redis URL must be HTTPS' };
    const isUpstash = host.endsWith('.upstash.io') || host.endsWith('.upstash.com');
    if (requireUpstash && (!isUpstash
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.port !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== '')) {
      return { valid: false, error: 'Redis URL configuration is invalid' };
    }
    if (!requireUpstash && !isUpstash) {
      logger.warn({ hostname: host }, 'Redis URL domain not in allowed list');
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Creates a stable local/test credential snapshot from explicit environment values.
 *
 * Why: local generic integrations may retain explicit credentials while the
 * deployed path is forbidden from falling back after Secrets Manager failure.
 *
 * @returns {Readonly<object>|null} local credentials and private cache identity
 */
function getLocalCredentialSnapshot() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (typeof url !== 'string' || url.length === 0 || typeof token !== 'string' || token.length === 0) {
    logger.warn({ hasUrl: Boolean(url), hasToken: Boolean(token) }, 'Upstash Redis not configured - rate limiting unavailable');
    return null;
  }
  if (localCredentialSnapshot?.url === url && localCredentialSnapshot?.token === token) {
    return localCredentialSnapshot;
  }
  localCredentialSnapshot = Object.freeze({
    url,
    token,
    cacheIdentity: Object.freeze({}),
  });
  return localCredentialSnapshot;
}

/**
 * Resolves credentials for a generic Redis consumer.
 *
 * Why: AWS mode shares the validated atomic runtime pair; local/test mode may
 * use explicit environment credentials and production never falls back.
 *
 * @returns {Promise<{credentials: object, identity: object}|null>} credential snapshot
 */
async function resolveGenericCredentials() {
  const mode = resolveTemporarySessionSecretMode();
  if (mode === TEMPORARY_SESSION_SECRET_MODES.AWS_SECRETS_MANAGER) {
    try {
      const runtimePair = await getTemporarySessionRuntimePair();
      return { credentials: runtimePair.redis, identity: runtimePair.cacheIdentity, requireUpstash: true };
    } catch {
      return null;
    }
  }
  if (mode !== TEMPORARY_SESSION_SECRET_MODES.LOCAL) return null;
  const local = getLocalCredentialSnapshot();
  return local
    ? { credentials: local, identity: local.cacheIdentity, requireUpstash: false }
    : null;
}

/**
 * Validates a caller-supplied immutable runtime pair.
 *
 * @param {unknown} runtimePair candidate HMAC/Redis snapshot
 * @returns {{credentials: object, identity: object}|null} safe Redis view
 */
function readRuntimePairCredentials(runtimePair) {
  if (!runtimePair
    || !runtimePair.redis
    || typeof runtimePair.cacheIdentity !== 'object'
    || runtimePair.cacheIdentity === null) {
    return null;
  }
  return { credentials: runtimePair.redis, identity: runtimePair.cacheIdentity, requireUpstash: true };
}

/**
 * Constructs one Upstash client from a validated credential snapshot.
 *
 * @param {object} credentials URL/token pair
 * @param {boolean} requireUpstash whether deployed origin rules apply
 * @returns {Redis|null} configured client
 */
function createRedisClient(credentials, requireUpstash) {
  const urlValidation = validateRedisUrl(credentials?.url, requireUpstash);
  if (!urlValidation.valid
    || typeof credentials?.token !== 'string'
    || credentials.token.length === 0
    || credentials.token.length > 2_048) {
    if (!urlValidation.valid) {
      logger.error({ validationError: urlValidation.error }, 'Invalid Redis URL configuration');
    }
    return null;
  }
  try {
    return new Redis({
      url: credentials.url,
      token: credentials.token,
      signal: createRedisRequestSignal,
    });
  } catch {
    logger.error(
      { reason: 'client_initialization_failed' },
      'Failed to initialize Redis client'
    );
    return null;
  }
}

/**
 * Gets or creates a Redis client retained by credential identity.
 *
 * Purpose: a caller may pin client construction to the exact runtime pair used
 * for HMAC identity. Generic consumers acquire the same pair in deployed mode.
 * A bounded LRU cache prevents alternating credential paths from reconstructing
 * clients while limiting retention after credential refreshes.
 *
 * @param {Readonly<object>|undefined} runtimePair optional validated runtime pair
 * @returns {Promise<Redis|null>} Redis client or null when unavailable
 */
export async function getRedisClient(runtimePair) {
  initializationAttempted = true;
  const resolved = runtimePair === undefined
    ? await resolveGenericCredentials()
    : readRuntimePairCredentials(runtimePair);
  if (!resolved) return null;
  const cachedClient = redisClientsByIdentity.get(resolved.identity);
  if (cachedClient) {
    redisClientsByIdentity.delete(resolved.identity);
    redisClientsByIdentity.set(resolved.identity, cachedClient);
    redisClient = cachedClient;
    return cachedClient;
  }

  const nextClient = createRedisClient(resolved.credentials, resolved.requireUpstash);
  if (!nextClient) return null;
  redisClientsByIdentity.set(resolved.identity, nextClient);
  if (redisClientsByIdentity.size > REDIS_CLIENT_CACHE_LIMIT) {
    const oldestIdentity = redisClientsByIdentity.keys().next().value;
    redisClientsByIdentity.delete(oldestIdentity);
  }
  redisClient = nextClient;
  logger.debug('Upstash Redis client initialized');
  return redisClient;
}

/**
 * Logs Redis unavailability exactly once per outage window.
 *
 * @param {object} context bounded structured context
 * @returns {void}
 */
export function logRedisDownOnce(context = {}) {
  if (redisDownLogged) return;
  redisDownLogged = true;
  logger.error(context, 'Redis is unavailable — requests will be denied (fail-closed)');
}

/**
 * Records the most recent generic rate-limit call outcome.
 *
 * @param {boolean} success whether Redis produced a trusted limiter result
 * @returns {void}
 */
export function setLastCallStatus(success) {
  lastCallSucceeded = success;
  lastCallTime = new Date().toISOString();
  if (success && redisDownLogged) {
    redisDownLogged = false;
    logger.info('Redis connectivity restored');
  }
}

/**
 * Returns bounded Redis status without credential or provider details.
 *
 * @returns {object} current client and last-call status
 */
export function getRedisStatus() {
  return {
    initialized: initializationAttempted,
    connected: redisClient !== null,
    lastCallSucceeded,
    lastCallTime,
  };
}

/**
 * Clears Redis client and health state for isolated tests.
 *
 * @returns {void}
 */
export function resetRedisClient() {
  redisClient = null;
  redisClientsByIdentity.clear();
  initializationAttempted = false;
  redisDownLogged = false;
  lastCallSucceeded = null;
  lastCallTime = null;
  localCredentialSnapshot = null;
}
