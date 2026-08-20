import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

export const TEMPORARY_SESSION_CEILING_LIMIT = 400;
export const TEMPORARY_SESSION_CEILING_WINDOW_SECONDS = 60;
export const TEMPORARY_SESSION_CEILING_SLOT_COUNT = TEMPORARY_SESSION_CEILING_WINDOW_SECONDS + 1;
export const TEMPORARY_SESSION_CEILING_MAX_ADDRESSES = 10_000;

const EMPTY_SLOT_LABEL = -1;
const HMAC_DOMAIN = 'temporary-session-ceiling:v1';
const LOGICAL_ALLOWANCE = 'auth-session';
const TELEMETRY_EVENT = 'temporary_session_ceiling_summary';
const REJECTION_EVENT = 'temporary_session_ceiling_rejection_sample';
const INTERNAL_FAILURE_LATCH_EVENT = 'temporary_session_ceiling_internal_failure_latched';
const ROUTE_VERSIONS = new Set(['v1', 'v2']);
const SOURCE_MODES = new Set(['local', 'deployed']);
const OPAQUE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BOUNDED_COUNT = Number.MAX_SAFE_INTEGER;

/**
 * Reads the Node process monotonic clock for production decisions.
 *
 * Why: wall-clock corrections must not reopen an in-process request budget.
 *
 * @returns {number} Monotonic milliseconds since process-relative time origin.
 */
function readMonotonicMilliseconds() {
  return performance.now();
}

/**
 * Selects the production singleton's source policy once at construction.
 *
 * Why: direct sockets are trusted only in development/test; environment
 * provider markers are not proof of a deployed proxy trust boundary.
 *
 * @returns {'local'|'deployed'} Fixed source policy for this instance.
 */
function getDefaultSourceMode() {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
    ? 'local'
    : 'deployed';
}

/**
 * Converts a canonical IPv4-mapped IPv6 suffix to canonical IPv4.
 *
 * Why: mapped and native IPv4 representations must consume one allowance.
 *
 * @param {string} address - Canonical IPv6 text produced by URL parsing.
 * @returns {string|null} Canonical IPv4 text when mapped, otherwise null.
 */
function mappedIpv6ToIpv4(address) {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!match) return null;

  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/**
 * Validates and canonicalizes one transient source address.
 *
 * Why: equivalent address spellings must share a budget, while hostnames,
 * zones, whitespace, and malformed values fail closed before state lookup.
 *
 * @param {unknown} value - Candidate address from the selected trusted source.
 * @returns {{family: 'ipv4'|'ipv6', address: string}|null} Canonical source.
 */
function normalizeAddress(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 45) return null;
  if (value !== value.trim()) return null;

  const family = isIP(value);
  if (family === 4) return { family: 'ipv4', address: value };
  if (family !== 6) return null;

  try {
    const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const mapped = mappedIpv6ToIpv4(canonical);
    return mapped
      ? { family: 'ipv4', address: mapped }
      : { family: 'ipv6', address: canonical };
  } catch {
    return null;
  }
}

/**
 * Parses a strict non-zero decimal source port.
 *
 * Why: deployed source syntax must reject ambiguity such as leading zeroes.
 *
 * @param {unknown} value - Candidate decimal port text.
 * @returns {number|null} Valid port number, otherwise null.
 */
function parseSourcePort(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,4}$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port <= 65_535 ? port : null;
}

/**
 * Parses the approved CloudFront viewer-address serialization.
 *
 * Why: deployed IPv4 must be `IPv4:port` and IPv6 must be bracketed as
 * `[IPv6]:port`; all other forms are intentionally rejected.
 *
 * @param {unknown} value - Exact singleton raw-header value.
 * @returns {{family: 'ipv4'|'ipv6', address: string}|null} Canonical source.
 */
function parseDeployedViewerAddress(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 64
    || value !== value.trim()
    || value.includes(',')) {
    return null;
  }

  const ipv4Match = /^((?:\d{1,3}\.){3}\d{1,3}):([1-9]\d{0,4})$/.exec(value);
  if (ipv4Match) {
    const source = normalizeAddress(ipv4Match[1]);
    return source?.family === 'ipv4' && parseSourcePort(ipv4Match[2]) !== null
      ? source
      : null;
  }

  const ipv6Match = /^\[([^\]]+)\]:([1-9]\d{0,4})$/.exec(value);
  if (!ipv6Match || parseSourcePort(ipv6Match[2]) === null || isIP(ipv6Match[1]) !== 6) {
    return null;
  }

  return normalizeAddress(ipv6Match[1]);
}

/**
 * Finds one exact raw-header occurrence and rejects malformed raw metadata.
 *
 * Why: Node may coalesce repeated headers, so normalized headers alone cannot
 * prove that CloudFront-Viewer-Address occurred exactly once.
 *
 * @param {object} req - Next.js request-like object.
 * @param {string} expectedName - Lowercase trusted header name.
 * @returns {string|null} Exact raw value when one occurrence exists.
 */
function findSingleRawHeader(req, expectedName) {
  const rawHeaders = req?.rawHeaders;
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return null;

  let matchCount = 0;
  let matchedValue = null;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== 'string' || typeof value !== 'string') return null;
    if (name.toLowerCase() !== expectedName) continue;
    matchCount += 1;
    matchedValue = value;
  }

  return matchCount === 1 ? matchedValue : null;
}

/**
 * Resolves a source using only the selected explicit trust policy.
 *
 * Why: forwarding headers and deployed origin sockets are never acceptable
 * fallbacks for the temporary ceiling's source identity.
 *
 * @param {object} req - Next.js request-like object.
 * @param {'local'|'deployed'} mode - Fixed or test-injected source policy.
 * @returns {{family: 'ipv4'|'ipv6', address: string}|null} Canonical source.
 */
function resolveSource(req, mode) {
  if (mode === 'local') return normalizeAddress(req?.socket?.remoteAddress);
  if (mode !== 'deployed') return null;

  const rawValue = findSingleRawHeader(req, 'cloudfront-viewer-address');
  const normalizedValue = req?.headers?.['cloudfront-viewer-address'];
  if (rawValue === null || typeof normalizedValue !== 'string' || normalizedValue !== rawValue) {
    return null;
  }

  return parseDeployedViewerAddress(rawValue);
}

/**
 * Validates bounded factory options before allocating counter state.
 *
 * Why: the public factory may reduce production limits for tests, but cannot
 * silently construct a less bounded or weaker limiter than the approved one.
 *
 * @param {object} options - Numeric enforcement and telemetry settings.
 * @returns {void}
 * @throws {TypeError} When an option is unsafe or exceeds approved bounds.
 */
function validateFactoryOptions({ limit, windowSeconds, maxAddresses, telemetryWindowSeconds }) {
  for (const value of [limit, windowSeconds, maxAddresses, telemetryWindowSeconds]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('temporary session ceiling options must be positive safe integers');
    }
  }
  if (limit > TEMPORARY_SESSION_CEILING_LIMIT
    || windowSeconds > TEMPORARY_SESSION_CEILING_WINDOW_SECONDS
    || maxAddresses > TEMPORARY_SESSION_CEILING_MAX_ADDRESSES) {
    throw new TypeError('temporary session ceiling options exceed approved bounds');
  }
}

/**
 * Creates one empty conservative ring entry.
 *
 * Why: counters and exact second labels have fixed per-source memory bounds.
 *
 * @param {number} slotCount - Physical ring length (`window + 1`).
 * @returns {{counts: Uint16Array, labels: Float64Array, lastSeenSecond: number}}
 */
function createCounterEntry(slotCount) {
  const labels = new Float64Array(slotCount);
  labels.fill(EMPTY_SLOT_LABEL);
  return {
    counts: new Uint16Array(slotCount),
    labels,
    lastSeenSecond: EMPTY_SLOT_LABEL,
  };
}

/**
 * Validates the fixed-size entry shape and its last-seen timestamp.
 *
 * Why: pruning can safely classify expired entries without scanning every ring
 * slot, while malformed shapes and impossible timestamps still fail closed.
 *
 * @param {object} entry - Candidate ring entry.
 * @param {number} currentSecond - Current monotonic second.
 * @param {number} slotCount - Expected physical ring length.
 * @returns {void}
 * @throws {Error} When the entry metadata is malformed.
 */
function validateCounterEntryShape(entry, currentSecond, slotCount) {
  if (!entry
    || !(entry.counts instanceof Uint16Array)
    || !(entry.labels instanceof Float64Array)
    || entry.counts.length !== slotCount
    || entry.labels.length !== slotCount
    || !Number.isSafeInteger(entry.lastSeenSecond)
    || entry.lastSeenSecond < 0
    || entry.lastSeenSecond > currentSecond) {
    throw new Error('temporary session ceiling state is invalid');
  }
}

/**
 * Validates one stored entry and all of its ring-slot relationships.
 *
 * Why: active state must be fully validated before an enforcement decision.
 *
 * @param {object} entry - Candidate ring entry.
 * @param {number} currentSecond - Current monotonic second.
 * @param {number} slotCount - Expected physical ring length.
 * @param {number} limit - Maximum valid total stored count.
 * @returns {void}
 * @throws {Error} When any state invariant is malformed.
 */
function validateCounterEntry(entry, currentSecond, slotCount, limit) {
  validateCounterEntryShape(entry, currentSecond, slotCount);

  const cutoffSecond = currentSecond - (slotCount - 1);
  let liveTotal = 0;
  let newestLabel = EMPTY_SLOT_LABEL;
  for (let index = 0; index < slotCount; index += 1) {
    const count = entry.counts[index];
    const label = entry.labels[index];

    if (count === 0) {
      if (label !== EMPTY_SLOT_LABEL) {
        throw new Error('temporary session ceiling state is invalid');
      }
      continue;
    }

    if (count > limit
      || !Number.isSafeInteger(label)
      || label < 0
      || label > entry.lastSeenSecond
      || label % slotCount !== index) {
      throw new Error('temporary session ceiling state is invalid');
    }

    if (label >= cutoffSecond) {
      liveTotal += count;
      if (liveTotal > limit) throw new Error('temporary session ceiling state is invalid');
    }
    if (label > newestLabel) newestLabel = label;
  }

  if (newestLabel !== entry.lastSeenSecond) {
    throw new Error('temporary session ceiling state is invalid');
  }
}

/**
 * Sums counts in the conservative inclusive interval.
 *
 * Why: labels, rather than array position alone, prevent second-0/second-60
 * aliasing and permit deterministic retry calculations.
 *
 * @param {object} entry - Previously validated ring entry.
 * @param {number} currentSecond - Current monotonic second.
 * @param {number} windowSeconds - Inclusive oldest-label distance.
 * @returns {{total: number, oldestSecond: number|null}} Live usage details.
 */
function countRecentRequests(entry, currentSecond, windowSeconds) {
  const cutoffSecond = currentSecond - windowSeconds;
  let total = 0;
  let oldestSecond = null;

  for (let index = 0; index < entry.counts.length; index += 1) {
    const count = entry.counts[index];
    const label = entry.labels[index];
    if (count === 0 || label < cutoffSecond) continue;
    total += count;
    if (oldestSecond === null || label < oldestSecond) oldestSecond = label;
  }

  return { total, oldestSecond };
}

/**
 * Consumes one request in the current physical ring slot.
 *
 * Why: this mutation follows the synchronous count check with no async or I/O
 * boundary, preserving one-process event-loop serialization.
 *
 * @param {object} entry - Validated mutable ring entry.
 * @param {number} currentSecond - Current monotonic second.
 * @param {number} slotCount - Physical ring length.
 * @returns {void}
 */
function incrementCurrentSecond(entry, currentSecond, slotCount) {
  const index = currentSecond % slotCount;
  if (entry.labels[index] !== currentSecond) {
    entry.labels[index] = currentSecond;
    entry.counts[index] = 0;
  }
  entry.counts[index] += 1;
  entry.lastSeenSecond = currentSecond;
}

/**
 * Calculates the advisory bounded retry delay for a full conservative window.
 *
 * @param {number|null} oldestSecond - Oldest live slot label.
 * @param {number} currentSecond - Current monotonic second.
 * @param {number} windowSeconds - Nominal rolling-window size.
 * @returns {number} Integer delay bounded to one through the window size.
 */
function calculateRetryAfter(oldestSecond, currentSecond, windowSeconds) {
  const boundaryDelay = (oldestSecond ?? currentSecond) + windowSeconds + 1 - currentSecond;
  return Math.min(windowSeconds, Math.max(1, boundaryDelay));
}

/**
 * Adds to a telemetry counter without numeric overflow.
 *
 * Why: even process-lifetime failure traffic must leave snapshots bounded.
 *
 * @param {number} current - Existing non-negative count.
 * @param {number} [amount=1] - Non-negative increment.
 * @returns {number} Saturated safe-integer count.
 */
function addBoundedCount(current, amount = 1) {
  return Math.min(MAX_BOUNDED_COUNT, current + amount);
}

/**
 * Creates a fresh identifier-free telemetry accumulator.
 *
 * @param {number|null} windowStartSecond - Internal reporting-window boundary.
 * @returns {object} Mutable count-only telemetry state.
 */
function createTelemetry(windowStartSecond) {
  return {
    windowStartSecond,
    totalChecks: 0,
    allowedChecks: 0,
    rejectedChecks: 0,
    sourceResolutionFailures: 0,
    stateCapacityFailures: 0,
    internalFailures: 0,
    expiredEntryCleanupCount: 0,
    routeVersionTotals: { v1: 0, v2: 0, unknown: 0 },
    rejectionSampled: false,
  };
}

/**
 * Invokes a structured logger without changing enforcement on failure.
 *
 * @param {object|undefined} requestLogger - Request-scoped logger surface.
 * @param {'info'|'warn'} level - Bounded log level.
 * @param {object} fields - Identifier-free structured fields.
 * @param {string} message - Stable human-readable event message.
 * @returns {boolean} Whether the configured log method completed successfully.
 */
function emitBoundedLog(requestLogger, level, fields, message) {
  try {
    const logMethod = requestLogger?.[level];
    if (typeof logMethod !== 'function') return false;
    logMethod.call(requestLogger, fields, message);
    return true;
  } catch {
    // Telemetry is observational and cannot change a completed safe decision.
    return false;
  }
}

/**
 * Feeds one UTF-8 value into an HMAC with an unsigned length prefix.
 *
 * Why: explicit framing prevents different field boundaries from colliding.
 *
 * @param {object} hmac - Node-compatible synchronous HMAC object.
 * @param {string} value - Fixed-domain or transient canonical input.
 * @returns {void}
 */
function updateLengthFramed(hmac, value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  hmac.update(length);
  hmac.update(bytes);
}

/**
 * Derives the only source identifier retained in limiter state.
 *
 * Why: a process-random, domain-separated HMAC prevents raw or canonical
 * addresses from becoming Map keys while preserving stable in-process lookup.
 *
 * @param {object} source - Transient canonical family/address pair.
 * @param {Buffer} hmacKey - Private per-factory 32-byte key.
 * @param {Function} createHmacFunction - Synchronous Node-compatible seam.
 * @returns {string} Base64url HMAC-SHA-256 digest.
 */
function deriveOpaqueStateKey(source, hmacKey, createHmacFunction) {
  const hmac = createHmacFunction('sha256', hmacKey);
  if (!hmac || typeof hmac.update !== 'function' || typeof hmac.digest !== 'function') {
    throw new Error('temporary session ceiling crypto is unavailable');
  }

  updateLengthFramed(hmac, HMAC_DOMAIN);
  updateLengthFramed(hmac, LOGICAL_ALLOWANCE);
  updateLengthFramed(hmac, source.family);
  updateLengthFramed(hmac, source.address);

  const digest = hmac.digest();
  if (!Buffer.isBuffer(digest) || digest.length !== 32) {
    throw new Error('temporary session ceiling crypto is unavailable');
  }

  const stateKey = digest.toString('base64url');
  if (!OPAQUE_KEY_PATTERN.test(stateKey)) {
    throw new Error('temporary session ceiling crypto is unavailable');
  }
  return stateKey;
}

/**
 * Creates one isolated, bounded temporary session ceiling.
 *
 * Why: the factory supplies deterministic test seams while the exported
 * singleton shares one v1/future-v2 allowance in each Node module instance.
 *
 * @param {object} [options] - Bounded enforcement and deterministic test seams.
 * @param {number} [options.limit=400] - Maximum accepted live requests.
 * @param {number} [options.windowSeconds=60] - Conservative label distance.
 * @param {number} [options.maxAddresses=10000] - Maximum source entries.
 * @param {number} [options.telemetryWindowSeconds=60] - Reporting cadence.
 * @param {() => number} [options.now] - Synchronous monotonic millisecond clock.
 * @param {'local'|'deployed'|Function} [options.sourceMode] - Source policy.
 * @param {object} [options.crypto] - Narrow synchronous crypto failure seam.
 * @param {Function} [options.testEntryObserver] - Test-only new-entry observer.
 * @returns {{evaluate: Function, getSnapshot: Function}} Isolated limiter.
 */
export function createTemporarySessionCeiling(options = {}) {
  const limit = options.limit ?? TEMPORARY_SESSION_CEILING_LIMIT;
  const windowSeconds = options.windowSeconds ?? TEMPORARY_SESSION_CEILING_WINDOW_SECONDS;
  const slotCount = windowSeconds + 1;
  const maxAddresses = options.maxAddresses ?? TEMPORARY_SESSION_CEILING_MAX_ADDRESSES;
  const telemetryWindowSeconds = options.telemetryWindowSeconds ?? windowSeconds;
  const now = options.now ?? readMonotonicMilliseconds;
  const sourceMode = options.sourceMode ?? getDefaultSourceMode();
  const randomBytesFunction = options.crypto?.randomBytes ?? randomBytes;
  const createHmacFunction = options.crypto?.createHmac ?? createHmac;
  const testEntryObserver = options.testEntryObserver;

  validateFactoryOptions({ limit, windowSeconds, maxAddresses, telemetryWindowSeconds });
  if (testEntryObserver !== undefined && typeof testEntryObserver !== 'function') {
    throw new TypeError('temporary session ceiling test observer must be callable');
  }

  const entries = new Map();
  let hmacKey = null;
  let unhealthy = false;
  let constructionFailureReason = null;
  let lastObservedMilliseconds = null;
  let lastPruneSecond = null;
  let pruneScanCount = 0;
  let telemetry = createTelemetry(null);

  try {
    if (typeof now !== 'function'
      || typeof randomBytesFunction !== 'function'
      || typeof createHmacFunction !== 'function') {
      throw new Error('temporary session ceiling dependency is unavailable');
    }
    const generatedKey = randomBytesFunction(32);
    if (!Buffer.isBuffer(generatedKey) || generatedKey.length !== 32) {
      throw new Error('temporary session ceiling crypto is unavailable');
    }
    hmacKey = Buffer.from(generatedKey);
  } catch {
    unhealthy = true;
    constructionFailureReason = 'hmac_key_initialization_failed';
  }

  /**
   * Resolves a fixed or test-provided source mode without exposing exceptions.
   *
   * @returns {'local'|'deployed'|null} Valid mode or null for fail-closed use.
   */
  function resolveSourceMode() {
    try {
      const mode = typeof sourceMode === 'function' ? sourceMode() : sourceMode;
      return SOURCE_MODES.has(mode) ? mode : null;
    } catch {
      return null;
    }
  }

  /**
   * Rotates aggregate telemetry on a request-driven reporting boundary.
   *
   * @param {number} currentSecond - Current monotonic second.
   * @param {object|undefined} requestLogger - Request-scoped logger.
   * @returns {void}
   */
  function rotateTelemetry(currentSecond, requestLogger) {
    const windowStartSecond = Math.floor(currentSecond / telemetryWindowSeconds)
      * telemetryWindowSeconds;
    if (!telemetry) {
      telemetry = createTelemetry(windowStartSecond);
      return;
    }
    if (telemetry.windowStartSecond === windowStartSecond) return;

    if (telemetry.totalChecks > 0) {
      emitBoundedLog(requestLogger, 'info', {
        event: TELEMETRY_EVENT,
        reportingWindowSeconds: telemetryWindowSeconds,
        totalChecks: telemetry.totalChecks,
        allowedChecks: telemetry.allowedChecks,
        rejectedChecks: telemetry.rejectedChecks,
        sourceResolutionFailures: telemetry.sourceResolutionFailures,
        stateCapacityFailures: telemetry.stateCapacityFailures,
        internalFailures: telemetry.internalFailures,
        expiredEntryCleanupCount: telemetry.expiredEntryCleanupCount,
        activeEntryCount: entries.size,
        routeVersionTotals: { ...telemetry.routeVersionTotals },
      }, 'Temporary session ceiling summary');
    }

    telemetry = createTelemetry(windowStartSecond);
  }

  /**
   * Records one bounded route-labelled evaluation attempt.
   *
   * @param {'v1'|'v2'|'unknown'} routeVersion - Bounded telemetry label.
   * @returns {void}
   */
  function recordCheck(routeVersion) {
    if (!telemetry) telemetry = createTelemetry(null);
    telemetry.totalChecks = addBoundedCount(telemetry.totalChecks);
    telemetry.routeVersionTotals[routeVersion] = addBoundedCount(
      telemetry.routeVersionTotals[routeVersion]
    );
  }

  /**
   * Emits at most one identifier-free rejection sample per reporting window.
   *
   * @param {object|undefined} requestLogger - Request-scoped logger.
   * @param {object} details - Fixed labels and optional bounded retry delay.
   * @returns {void}
   */
  function sampleRejection(requestLogger, details) {
    if (!telemetry || telemetry.rejectionSampled) return;
    const emitted = emitBoundedLog(requestLogger, 'warn', {
      event: REJECTION_EVENT,
      outcome: details.outcome,
      reason: details.reason,
      routeVersion: details.routeVersion,
      retryAfterSeconds: details.retryAfterSeconds ?? null,
    }, 'Temporary session ceiling rejection sample');
    if (emitted) telemetry.rejectionSampled = true;
  }

  /**
   * Records one unavailable decision in bounded aggregate telemetry.
   *
   * @param {object|undefined} requestLogger - Request-scoped logger.
   * @param {'v1'|'v2'|'unknown'} routeVersion - Bounded telemetry label.
   * @param {string} reason - Fixed non-identifying failure category.
   * @param {'source'|'capacity'|'internal'} category - Aggregate counter.
   * @returns {{allowed: false, statusCode: 503, reason: string}} Decision.
   */
  function rejectUnavailable(requestLogger, routeVersion, reason, category) {
    telemetry.rejectedChecks = addBoundedCount(telemetry.rejectedChecks);
    if (category === 'source') {
      telemetry.sourceResolutionFailures = addBoundedCount(
        telemetry.sourceResolutionFailures
      );
    } else if (category === 'capacity') {
      telemetry.stateCapacityFailures = addBoundedCount(telemetry.stateCapacityFailures);
    } else {
      telemetry.internalFailures = addBoundedCount(telemetry.internalFailures);
    }
    sampleRejection(requestLogger, {
      outcome: 'unavailable',
      reason,
      routeVersion,
    });
    return { allowed: false, statusCode: 503, reason };
  }

  /**
   * Latches permanent process-instance failure and returns a safe decision.
   *
   * @param {object|undefined} requestLogger - Request-scoped logger.
   * @param {'v1'|'v2'|'unknown'} routeVersion - Bounded telemetry label.
   * @returns {{allowed: false, statusCode: 503, reason: string}} Decision.
   */
  function latchInternalFailure(requestLogger, routeVersion) {
    if (!unhealthy) {
      unhealthy = true;
      emitBoundedLog(requestLogger, 'warn', {
        event: INTERNAL_FAILURE_LATCH_EVENT,
        outcome: 'unavailable',
        reason: 'internal_failure',
        routeVersion,
      }, 'Temporary session ceiling internal failure latched');
    }
    return rejectUnavailable(requestLogger, routeVersion, 'internal_failure', 'internal');
  }

  /**
   * Validates entry shapes and classifies expiry before deleting keys.
   *
   * Why: cleanup remains a bounded metadata scan, and a malformed later shape
   * must not permit partial cleanup mutation.
   *
   * @param {number} currentSecond - Current monotonic second.
   * @returns {number} Number of expired entries deleted.
   */
  function pruneExpiredEntries(currentSecond) {
    if (lastPruneSecond !== null && currentSecond <= lastPruneSecond) return 0;
    if (entries.size > maxAddresses) {
      throw new Error('temporary session ceiling state is invalid');
    }

    const expiredKeys = [];
    for (const [stateKey, entry] of entries) {
      if (typeof stateKey !== 'string' || !OPAQUE_KEY_PATTERN.test(stateKey)) {
        throw new Error('temporary session ceiling state is invalid');
      }
      validateCounterEntryShape(entry, currentSecond, slotCount);
      if (currentSecond - entry.lastSeenSecond > windowSeconds) {
        expiredKeys.push(stateKey);
      }
    }

    for (const stateKey of expiredKeys) entries.delete(stateKey);
    lastPruneSecond = currentSecond;
    pruneScanCount = addBoundedCount(pruneScanCount);
    return expiredKeys.length;
  }

  /**
   * Evaluates and synchronously consumes one combined v1/future-v2 request.
   *
   * Side effects: mutates only bounded process-local counters and aggregate
   * telemetry; it performs no Redis, Supabase, timer, or background work.
   *
   * @param {object} req - Next.js request-like object.
   * @param {object} [context] - Bounded route and request logger context.
   * @param {'v1'|'v2'} [context.routeVersion] - Session contract label.
   * @param {object} [context.logger] - Request-scoped structured logger.
   * @returns {object} Allow, bounded 429, or fail-closed 503 decision.
   */
  function evaluate(req, context = {}) {
    let requestedRouteVersion;
    try {
      requestedRouteVersion = context?.routeVersion;
    } catch {
      requestedRouteVersion = undefined;
    }
    const routeIsValid = ROUTE_VERSIONS.has(requestedRouteVersion);
    const routeVersion = routeIsValid ? requestedRouteVersion : 'unknown';

    let requestLogger;
    try {
      requestLogger = context?.logger ?? req?.log;
    } catch {
      requestLogger = undefined;
    }

    if (unhealthy) {
      recordCheck(routeVersion);
      if (constructionFailureReason !== null) {
        emitBoundedLog(requestLogger, 'warn', {
          event: INTERNAL_FAILURE_LATCH_EVENT,
          outcome: 'unavailable',
          reason: 'internal_failure',
          routeVersion,
          constructionFailureReason,
        }, 'Temporary session ceiling internal failure latched');
        constructionFailureReason = null;
      }
      return rejectUnavailable(requestLogger, routeVersion, 'internal_failure', 'internal');
    }

    let nowMilliseconds;
    let currentSecond;
    try {
      nowMilliseconds = now();
      currentSecond = Math.floor(nowMilliseconds / 1000);
      if (!Number.isFinite(nowMilliseconds)
        || nowMilliseconds < 0
        || nowMilliseconds > Number.MAX_SAFE_INTEGER
        || !Number.isSafeInteger(currentSecond)
        || (lastObservedMilliseconds !== null
          && nowMilliseconds < lastObservedMilliseconds)) {
        throw new Error('temporary session ceiling clock is unavailable');
      }
    } catch {
      recordCheck(routeVersion);
      return latchInternalFailure(requestLogger, routeVersion);
    }

    lastObservedMilliseconds = nowMilliseconds;
    rotateTelemetry(currentSecond, requestLogger);
    recordCheck(routeVersion);

    if (!routeIsValid) {
      return rejectUnavailable(requestLogger, routeVersion, 'route_version_invalid', 'internal');
    }

    try {
      const expiredCount = pruneExpiredEntries(currentSecond);
      telemetry.expiredEntryCleanupCount = addBoundedCount(
        telemetry.expiredEntryCleanupCount,
        expiredCount
      );
    } catch {
      return latchInternalFailure(requestLogger, routeVersion);
    }

    const mode = resolveSourceMode();
    let source = null;
    try {
      source = resolveSource(req, mode);
    } catch {
      source = null;
    }
    if (!source) {
      return rejectUnavailable(requestLogger, routeVersion, 'source_unavailable', 'source');
    }

    let stateKey;
    try {
      stateKey = deriveOpaqueStateKey(source, hmacKey, createHmacFunction);
    } catch {
      return latchInternalFailure(requestLogger, routeVersion);
    }

    let entry = entries.get(stateKey);
    const isNewEntry = entry === undefined;
    if (isNewEntry && entries.size >= maxAddresses) {
      return rejectUnavailable(requestLogger, routeVersion, 'state_capacity', 'capacity');
    }
    if (isNewEntry) entry = createCounterEntry(slotCount);

    try {
      if (!isNewEntry) validateCounterEntry(entry, currentSecond, slotCount, limit);
      const usage = isNewEntry
        ? { total: 0, oldestSecond: null }
        : countRecentRequests(entry, currentSecond, windowSeconds);

      if (usage.total >= limit) {
        const retryAfterSeconds = calculateRetryAfter(
          usage.oldestSecond,
          currentSecond,
          windowSeconds
        );
        telemetry.rejectedChecks = addBoundedCount(telemetry.rejectedChecks);
        sampleRejection(requestLogger, {
          outcome: 'rate_limited',
          reason: 'limit_exceeded',
          routeVersion,
          retryAfterSeconds,
        });
        return {
          allowed: false,
          statusCode: 429,
          reason: 'limit_exceeded',
          retryAfterSeconds,
        };
      }

      incrementCurrentSecond(entry, currentSecond, slotCount);
      if (isNewEntry) {
        entries.set(stateKey, entry);
        if (testEntryObserver) testEntryObserver(entry);
      }
      telemetry.allowedChecks = addBoundedCount(telemetry.allowedChecks);
      return { allowed: true };
    } catch {
      return latchInternalFailure(requestLogger, routeVersion);
    }
  }

  /**
   * Returns an identifier-free copy of bounded process-local state.
   *
   * Why: tests and later evidence need cardinality and aggregate behavior but
   * must never receive addresses, HMAC material, slot timestamps, or Map keys.
   *
   * @returns {object} Identifier-free enforcement state and telemetry counts.
   */
  function getSnapshot() {
    return {
      activeEntryCount: entries.size,
      pruneScanCount,
      unhealthy,
      telemetry: {
        totalChecks: telemetry.totalChecks,
        allowedChecks: telemetry.allowedChecks,
        rejectedChecks: telemetry.rejectedChecks,
        sourceResolutionFailures: telemetry.sourceResolutionFailures,
        stateCapacityFailures: telemetry.stateCapacityFailures,
        internalFailures: telemetry.internalFailures,
        expiredEntryCleanupCount: telemetry.expiredEntryCleanupCount,
        routeVersionTotals: { ...telemetry.routeVersionTotals },
      },
    };
  }

  return { evaluate, getSnapshot };
}

export const temporarySessionCeiling = createTemporarySessionCeiling();
