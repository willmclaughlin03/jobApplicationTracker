import { performance } from 'node:perf_hooks';
import {
  resolveTemporarySessionSource,
  resolveTemporarySessionSourceMode,
} from './temporarySessionSource.js';
import { deriveTemporarySessionIdentity } from './temporarySessionIdentity.js';
import { temporarySessionSecrets } from './temporarySessionSecrets.js';
import { getRedisClient } from './redis.js';
import {
  executeTemporarySessionRedisScript,
  TEMPORARY_SESSION_REDIS_LIMIT,
  TEMPORARY_SESSION_REDIS_SLOT_COUNT,
  TEMPORARY_SESSION_REDIS_WINDOW_SECONDS,
} from './temporarySessionRedisScript.js';
import {
  createTemporarySessionTelemetry,
  TEMPORARY_SESSION_FAILURE_REASONS,
  TEMPORARY_SESSION_TELEMETRY_EVENTS,
  temporarySessionTelemetry,
} from './temporarySessionTelemetry.js';

export const TEMPORARY_SESSION_CEILING_LIMIT = TEMPORARY_SESSION_REDIS_LIMIT;
export const TEMPORARY_SESSION_CEILING_WINDOW_SECONDS = TEMPORARY_SESSION_REDIS_WINDOW_SECONDS;
export const TEMPORARY_SESSION_CEILING_SLOT_COUNT = TEMPORARY_SESSION_REDIS_SLOT_COUNT;
export const TEMPORARY_SESSION_CEILING_DEADLINE_MS = 3_000;

const ROUTE_VERSIONS = new Set(['v1', 'v2']);

/**
 * Invokes one telemetry operation without allowing observability to alter enforcement.
 *
 * @param {Function} operation telemetry callback with bounded arguments
 * @returns {void}
 */
function invokeTelemetrySafely(operation) {
  try {
    operation();
  } catch {
    // Observability cannot alter a safe limiter decision.
  }
}

/**
 * Reads the monotonic clock used by the complete limiter deadline.
 *
 * @returns {number} process-relative milliseconds
 */
function readMonotonicMilliseconds() {
  return performance.now();
}

/**
 * Safely invokes a fixed telemetry event without changing enforcement.
 *
 * @param {object} telemetry fixed telemetry surface
 * @param {string} event approved event enum value
 * @param {string|undefined} reason approved reason enum value
 * @returns {void}
 */
function recordTelemetry(telemetry, event, reason) {
  invokeTelemetrySafely(() => telemetry.record(event, reason));
}

/**
 * Creates one asynchronous shared temporary session ceiling facade.
 *
 * Order: establish the absolute deadline, resolve the trusted source, obtain
 * one immutable secret pair, derive the active-generation key, construct Redis
 * from that same pair, execute the atomic Lua script, and validate its result.
 *
 * @param {object} [options] deterministic dependency seams
 * @returns {{evaluate: Function, getSnapshot: Function}} isolated facade
 */
export function createTemporarySessionCeiling(options = {}) {
  const now = options.now ?? readMonotonicMilliseconds;
  const env = options.env ?? process.env;
  const sourceModeOption = options.sourceMode;
  const resolveSource = options.resolveSource ?? resolveTemporarySessionSource;
  const secrets = options.secrets ?? temporarySessionSecrets;
  const deriveIdentity = options.deriveIdentity ?? deriveTemporarySessionIdentity;
  const acquireRedis = options.getRedisClientFunction ?? getRedisClient;
  const executeScript = options.executeScript ?? executeTemporarySessionRedisScript;
  const telemetry = options.telemetry ?? createTemporarySessionTelemetry({ now, env });
  const setTimer = options.setTimeoutFunction ?? setTimeout;
  const clearTimer = options.clearTimeoutFunction ?? clearTimeout;

  if (typeof now !== 'function'
    || typeof resolveSource !== 'function'
    || typeof secrets?.getRuntimePair !== 'function'
    || typeof deriveIdentity !== 'function'
    || typeof acquireRedis !== 'function'
    || typeof executeScript !== 'function'
    || typeof telemetry?.record !== 'function'
    || typeof telemetry?.finish !== 'function'
    || typeof telemetry?.maybeRotate !== 'function') {
    throw new TypeError('temporary session ceiling dependencies are invalid');
  }

  /**
   * Resolves a fixed or injected source policy for this evaluation.
   *
   * @returns {'local'|'deployed'|null} validated mode
   */
  function readSourceMode() {
    try {
      const mode = typeof sourceModeOption === 'function' ? sourceModeOption() : sourceModeOption;
      return resolveTemporarySessionSourceMode({ mode, env });
    } catch {
      return null;
    }
  }

  /**
   * Completes one unavailable decision with bounded telemetry.
   *
   * @param {string} reason approved failure reason
   * @param {number} startedAt evaluation start time
   * @returns {{allowed: false, statusCode: 503, reason: string}} sanitized decision
   */
  function unavailable(reason, startedAt) {
    const duration = Math.max(0, now() - startedAt);
    invokeTelemetrySafely(() => telemetry.finish('unavailable', reason, duration));
    return { allowed: false, statusCode: 503, reason };
  }

  /**
   * Tests the complete limiter deadline without exposing timing details.
   *
   * @param {number} deadlineAt absolute monotonic deadline
   * @returns {boolean} whether no trusted work may continue
   */
  function deadlineExpired(deadlineAt) {
    const observedAt = now();
    return !Number.isFinite(observedAt) || observedAt >= deadlineAt;
  }

  /**
   * Maps fixed script execution hooks to fixed aggregate telemetry counters.
   *
   * @param {string} event internal script event
   * @returns {void}
   */
  function recordScriptEvent(event) {
    if (event === 'evalsha') {
      recordTelemetry(telemetry, TEMPORARY_SESSION_TELEMETRY_EVENTS.REDIS_EVALSHA);
    } else if (event === 'noscript_fallback') {
      recordTelemetry(telemetry, TEMPORARY_SESSION_TELEMETRY_EVENTS.REDIS_NOSCRIPT_FALLBACK);
    }
  }

  /**
   * Evaluates and consumes one shared v1/future-v2 allowance.
   *
   * Side effects: may refresh two secrets, atomically swap the shared Redis
   * client, and execute exactly one trusted Lua decision (plus safe NOSCRIPT
   * loading). Rejected decisions invoke no downstream route work.
   *
   * @param {object} req Next.js request-like object
   * @param {object} [context] bounded route/logger context
   * @returns {Promise<object>} allow, bounded 429, or sanitized 503
   */
  async function evaluate(req, context = {}) {
    const startedAt = now();
    if (!Number.isFinite(startedAt) || startedAt < 0) {
      return { allowed: false, statusCode: 503, reason: TEMPORARY_SESSION_FAILURE_REASONS.INTERNAL_FAILURE };
    }
    const deadlineAt = startedAt + TEMPORARY_SESSION_CEILING_DEADLINE_MS;
    let requestLogger;
    let routeVersion;
    try {
      requestLogger = context?.logger ?? req?.log;
      routeVersion = context?.routeVersion;
    } catch {
      requestLogger = undefined;
      routeVersion = undefined;
    }
    invokeTelemetrySafely(() => telemetry.maybeRotate(requestLogger));

    if (!ROUTE_VERSIONS.has(routeVersion)) {
      return unavailable(TEMPORARY_SESSION_FAILURE_REASONS.INTERNAL_FAILURE, startedAt);
    }

    const sourceMode = readSourceMode();
    if (!sourceMode) {
      return unavailable(TEMPORARY_SESSION_FAILURE_REASONS.SOURCE_MODE_INVALID, startedAt);
    }

    let source;
    try {
      source = resolveSource(req, sourceMode);
    } catch {
      source = null;
    }
    if (!source) {
      return unavailable(TEMPORARY_SESSION_FAILURE_REASONS.SOURCE_UNAVAILABLE, startedAt);
    }

    let runtimePair;
    try {
      runtimePair = await secrets.getRuntimePair({ deadlineAt });
    } catch {
      const reason = deadlineExpired(deadlineAt)
        ? TEMPORARY_SESSION_FAILURE_REASONS.DEADLINE_EXCEEDED
        : TEMPORARY_SESSION_FAILURE_REASONS.SECRET_UNAVAILABLE;
      if (reason === TEMPORARY_SESSION_FAILURE_REASONS.DEADLINE_EXCEEDED) {
        recordTelemetry(telemetry, TEMPORARY_SESSION_TELEMETRY_EVENTS.DEADLINE_EXCEEDED, reason);
      }
      return unavailable(reason, startedAt);
    }
    if (deadlineExpired(deadlineAt)) {
      recordTelemetry(
        telemetry,
        TEMPORARY_SESSION_TELEMETRY_EVENTS.DEADLINE_EXCEEDED,
        TEMPORARY_SESSION_FAILURE_REASONS.DEADLINE_EXCEEDED
      );
      return unavailable(TEMPORARY_SESSION_FAILURE_REASONS.DEADLINE_EXCEEDED, startedAt);
    }

    let identity;
    try {
      identity = deriveIdentity(source, runtimePair.hmac.active);
    } catch {
      return unavailable(TEMPORARY_SESSION_FAILURE_REASONS.IDENTITY_UNAVAILABLE, startedAt);
    }

    let redis;
    try {
      redis = await acquireRedis(runtimePair);
    } catch {
      redis = null;
    }
    const redisDeadlineExpired = deadlineExpired(deadlineAt);
    if (!redis || redisDeadlineExpired) {
      const reason = redisDeadlineExpired
        ? TEMPORARY_SESSION_FAILURE_REASONS.DEADLINE_EXCEEDED
        : TEMPORARY_SESSION_FAILURE_REASONS.REDIS_UNAVAILABLE;
      recordTelemetry(
        telemetry,
        redisDeadlineExpired
          ? TEMPORARY_SESSION_TELEMETRY_EVENTS.DEADLINE_EXCEEDED
          : TEMPORARY_SESSION_TELEMETRY_EVENTS.REDIS_UNAVAILABLE,
        reason
      );
      return unavailable(reason, startedAt);
    }
    recordTelemetry(telemetry, TEMPORARY_SESSION_TELEMETRY_EVENTS.REDIS_CLIENT_ACQUIRED);

    let result;
    try {
      result = await executeScript(redis, identity.redisKey, {
        deadlineAt,
        now,
        setTimeoutFunction: setTimer,
        clearTimeoutFunction: clearTimer,
        onEvent: recordScriptEvent,
      });
    } catch {
      const reason = deadlineExpired(deadlineAt)
        ? TEMPORARY_SESSION_FAILURE_REASONS.DEADLINE_EXCEEDED
        : TEMPORARY_SESSION_FAILURE_REASONS.REDIS_UNCERTAIN;
      if (reason === TEMPORARY_SESSION_FAILURE_REASONS.DEADLINE_EXCEEDED) {
        recordTelemetry(telemetry, TEMPORARY_SESSION_TELEMETRY_EVENTS.DEADLINE_EXCEEDED, reason);
      }
      return unavailable(reason, startedAt);
    }

    if (result?.status === 'allowed') {
      recordTelemetry(telemetry, TEMPORARY_SESSION_TELEMETRY_EVENTS.SCRIPT_ALLOWED);
      invokeTelemetrySafely(
        () => telemetry.finish('allowed', undefined, Math.max(0, now() - startedAt))
      );
      return { allowed: true };
    }
    if (result?.status === 'rate_limited'
      && Number.isSafeInteger(result.retryAfterSeconds)
      && result.retryAfterSeconds >= 1
      && result.retryAfterSeconds <= TEMPORARY_SESSION_CEILING_WINDOW_SECONDS) {
      recordTelemetry(telemetry, TEMPORARY_SESSION_TELEMETRY_EVENTS.SCRIPT_RATE_LIMITED);
      invokeTelemetrySafely(
        () => telemetry.finish(
          'rate_limited',
          TEMPORARY_SESSION_FAILURE_REASONS.LIMIT_EXCEEDED,
          Math.max(0, now() - startedAt)
        )
      );
      return {
        allowed: false,
        statusCode: 429,
        reason: TEMPORARY_SESSION_FAILURE_REASONS.LIMIT_EXCEEDED,
        retryAfterSeconds: result.retryAfterSeconds,
      };
    }
    if (result?.status === 'invalid_state') {
      recordTelemetry(
        telemetry,
        TEMPORARY_SESSION_TELEMETRY_EVENTS.SCRIPT_INVALID_STATE,
        TEMPORARY_SESSION_FAILURE_REASONS.SCRIPT_STATE_INVALID
      );
      return unavailable(TEMPORARY_SESSION_FAILURE_REASONS.SCRIPT_STATE_INVALID, startedAt);
    }
    recordTelemetry(
      telemetry,
      TEMPORARY_SESSION_TELEMETRY_EVENTS.SCRIPT_RESULT_INVALID,
      TEMPORARY_SESSION_FAILURE_REASONS.SCRIPT_RESULT_INVALID
    );
    return unavailable(TEMPORARY_SESSION_FAILURE_REASONS.SCRIPT_RESULT_INVALID, startedAt);
  }

  /**
   * Returns identifier-free aggregate state for tests and local audit.
   *
   * @returns {object} bounded telemetry snapshot
   */
  function getSnapshot() {
    return { telemetry: telemetry.getSnapshot?.() ?? null };
  }

  return { evaluate, getSnapshot };
}

export const temporarySessionCeiling = createTemporarySessionCeiling({
  telemetry: temporarySessionTelemetry,
});
