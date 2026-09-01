import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const TEMPORARY_SESSION_TELEMETRY_EVENTS = Object.freeze({
  CONFIGURATION_SUCCEEDED: 'configurationSucceeded',
  CONFIGURATION_FAILED: 'configurationFailed',
  REDIS_CLIENT_ACQUIRED: 'redisClientAcquired',
  REDIS_UNAVAILABLE: 'redisUnavailable',
  REDIS_EVALSHA: 'redisEvalsha',
  REDIS_NOSCRIPT_FALLBACK: 'redisNoscriptFallback',
  SCRIPT_ALLOWED: 'scriptAllowed',
  SCRIPT_RATE_LIMITED: 'scriptRateLimited',
  SCRIPT_INVALID_STATE: 'scriptInvalidState',
  SCRIPT_RESULT_INVALID: 'scriptResultInvalid',
  ALLOWED: 'allowed',
  RATE_LIMITED: 'rateLimited',
  UNAVAILABLE: 'unavailable',
  DEADLINE_EXCEEDED: 'deadlineExceeded',
});

export const TEMPORARY_SESSION_FAILURE_REASONS = Object.freeze({
  SOURCE_MODE_INVALID: 'source_mode_invalid',
  SOURCE_UNAVAILABLE: 'source_unavailable',
  SECRET_UNAVAILABLE: 'secret_unavailable',
  IDENTITY_UNAVAILABLE: 'identity_unavailable',
  REDIS_UNAVAILABLE: 'redis_unavailable',
  REDIS_UNCERTAIN: 'redis_uncertain',
  SCRIPT_STATE_INVALID: 'script_state_invalid',
  SCRIPT_RESULT_INVALID: 'script_result_invalid',
  DEADLINE_EXCEEDED: 'deadline_exceeded',
  LIMIT_EXCEEDED: 'limit_exceeded',
  INTERNAL_FAILURE: 'internal_failure',
});

const TELEMETRY_EVENT_NAME = 'temporary_session_ceiling_summary';
const DEFAULT_REPORTING_WINDOW_MS = 60_000;
const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const BUILD_ATTRIBUTION_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const EVENT_NAMES = new Set(Object.values(TEMPORARY_SESSION_TELEMETRY_EVENTS));
const REASON_NAMES = new Set(Object.values(TEMPORARY_SESSION_FAILURE_REASONS));
const DURATION_BUCKETS = Object.freeze(['lt50', 'lt100', 'lt250', 'lt500', 'lt1000', 'lt2000', 'lt3000', 'gte3000']);

/**
 * Reads the monotonic process clock used for reporting windows.
 *
 * @returns {number} process-relative milliseconds
 */
function readMonotonicMilliseconds() {
  return performance.now();
}

/**
 * Adds one to a counter without overflowing the safe-integer bound.
 *
 * @param {number} value current non-negative counter
 * @returns {number} saturated counter
 */
function incrementBounded(value) {
  return Math.min(MAX_COUNT, value + 1);
}

/**
 * Selects a fixed request-duration bucket.
 *
 * Why: aggregate latency evidence remains bounded and never records arbitrary
 * request or provider values.
 *
 * @param {number} durationMs completed limiter duration
 * @returns {string} fixed bucket label
 */
function selectDurationBucket(durationMs) {
  if (durationMs < 50) return 'lt50';
  if (durationMs < 100) return 'lt100';
  if (durationMs < 250) return 'lt250';
  if (durationMs < 500) return 'lt500';
  if (durationMs < 1_000) return 'lt1000';
  if (durationMs < 2_000) return 'lt2000';
  if (durationMs < 3_000) return 'lt3000';
  return 'gte3000';
}

/**
 * Retains only explicitly bounded build attribution.
 *
 * Why: raw environment payloads and unbounded provider identifiers must never
 * be emitted through telemetry.
 *
 * @param {unknown} value candidate build identifier
 * @returns {string} bounded attribution or `unknown`
 */
function normalizeBuildAttribution(value) {
  return typeof value === 'string' && BUILD_ATTRIBUTION_PATTERN.test(value)
    ? value
    : 'unknown';
}

/**
 * Creates a random bounded module-boot attribution value.
 *
 * Why: boot observations help rollout evidence without entering limiter keys.
 *
 * @param {Function} randomBytesFunction cryptographic randomness seam
 * @returns {string} bounded opaque boot identifier
 */
function createModuleBootId(randomBytesFunction) {
  try {
    const value = randomBytesFunction(12);
    if (Buffer.isBuffer(value) && value.length === 12) return value.toString('base64url');
  } catch {
    // Attribution failure is observational and never changes enforcement.
  }
  return 'unavailable';
}

/**
 * Creates a fresh fixed-shape telemetry accumulator.
 *
 * @param {number} startedAt monotonic reporting-window start
 * @returns {object} mutable bounded counter state
 */
function createCounterState(startedAt) {
  return {
    startedAt,
    total: 0,
    events: Object.fromEntries([...EVENT_NAMES].map((name) => [name, 0])),
    reasons: Object.fromEntries([...REASON_NAMES].map((name) => [name, 0])),
    durations: Object.fromEntries(DURATION_BUCKETS.map((name) => [name, 0])),
  };
}

/**
 * Emits one summary without allowing logger failure to alter enforcement.
 *
 * @param {object|undefined} requestLogger request-scoped logger
 * @param {object} fields fixed telemetry fields
 * @returns {void}
 */
function emitSummary(requestLogger, fields) {
  try {
    if (typeof requestLogger?.info === 'function') {
      requestLogger.info(fields, 'Temporary session ceiling summary');
    }
  } catch {
    // Telemetry remains observational.
  }
}

/**
 * Creates isolated fixed-cardinality telemetry for the shared ceiling.
 *
 * @param {object} [options] clocks, randomness, environment, and cadence seams
 * @returns {{record: Function, finish: Function, maybeRotate: Function, getSnapshot: Function}} telemetry
 */
export function createTemporarySessionTelemetry(options = {}) {
  const now = options.now ?? readMonotonicMilliseconds;
  const randomBytesFunction = options.randomBytesFunction ?? randomBytes;
  const reportingWindowMs = options.reportingWindowMs ?? DEFAULT_REPORTING_WINDOW_MS;
  const env = options.env ?? process.env;
  if (typeof now !== 'function'
    || typeof randomBytesFunction !== 'function'
    || !Number.isSafeInteger(reportingWindowMs)
    || reportingWindowMs <= 0) {
    throw new TypeError('temporary session telemetry dependencies are invalid');
  }

  const attribution = Object.freeze({
    moduleBootId: createModuleBootId(randomBytesFunction),
    buildId: normalizeBuildAttribution(env.NEXT_BUILD_ID ?? env.VERCEL_GIT_COMMIT_SHA),
    deploymentId: normalizeBuildAttribution(env.VERCEL_DEPLOYMENT_ID),
  });
  let counters = createCounterState(now());

  /**
   * Records one approved event and optional approved reason.
   *
   * @param {string} event fixed event enum value
   * @param {string|undefined} reason fixed reason enum value
   * @returns {void}
   */
  function record(event, reason) {
    if (!EVENT_NAMES.has(event) || (reason !== undefined && !REASON_NAMES.has(reason))) return;
    counters.events[event] = incrementBounded(counters.events[event]);
    if (reason !== undefined) counters.reasons[reason] = incrementBounded(counters.reasons[reason]);
  }

  /**
   * Records one completed limiter decision and bounded duration bucket.
   *
   * @param {'allowed'|'rate_limited'|'unavailable'} outcome fixed decision label
   * @param {string|undefined} reason fixed reason enum value
   * @param {number} durationMs monotonic completed duration
   * @returns {void}
   */
  function finish(outcome, reason, durationMs) {
    counters.total = incrementBounded(counters.total);
    if (outcome === 'allowed') record(TEMPORARY_SESSION_TELEMETRY_EVENTS.ALLOWED);
    if (outcome === 'rate_limited') record(TEMPORARY_SESSION_TELEMETRY_EVENTS.RATE_LIMITED, reason);
    if (outcome === 'unavailable') record(TEMPORARY_SESSION_TELEMETRY_EVENTS.UNAVAILABLE, reason);
    const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 3_000;
    const bucket = selectDurationBucket(safeDuration);
    counters.durations[bucket] = incrementBounded(counters.durations[bucket]);
  }

  /**
   * Rotates and emits a non-empty completed reporting window.
   *
   * @param {object|undefined} requestLogger request-scoped logger
   * @returns {void}
   */
  function maybeRotate(requestLogger) {
    const observedAt = now();
    if (!Number.isFinite(observedAt) || observedAt - counters.startedAt < reportingWindowMs) return;
    if (counters.total > 0 || Object.values(counters.events).some((count) => count > 0)) {
      emitSummary(requestLogger, {
        event: TELEMETRY_EVENT_NAME,
        reportingWindowMs,
        attribution,
        total: counters.total,
        events: { ...counters.events },
        reasons: { ...counters.reasons },
        durations: { ...counters.durations },
      });
    }
    counters = createCounterState(observedAt);
  }

  /**
   * Returns a copy of bounded aggregate state without limiter identifiers.
   *
   * @returns {object} attribution and fixed counter maps
   */
  function getSnapshot() {
    return {
      attribution: { ...attribution },
      total: counters.total,
      events: { ...counters.events },
      reasons: { ...counters.reasons },
      durations: { ...counters.durations },
    };
  }

  return { record, finish, maybeRotate, getSnapshot };
}

export const temporarySessionTelemetry = createTemporarySessionTelemetry();
