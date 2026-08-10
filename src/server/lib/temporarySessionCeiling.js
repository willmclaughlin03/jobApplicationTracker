import { isIP } from 'node:net';

export const TEMPORARY_SESSION_CEILING_LIMIT = 400;
export const TEMPORARY_SESSION_CEILING_WINDOW_SECONDS = 60;
export const TEMPORARY_SESSION_CEILING_MAX_ADDRESSES = 10_000;

const TELEMETRY_EVENT = 'temporary_session_ceiling_summary';
const REJECTION_EVENT = 'temporary_session_ceiling_rejection_sample';
const SOURCE_MODES = new Set(['local', 'deployed']);
const ROUTE_VERSIONS = new Set(['v1', 'v2']);

/**
 * Converts an IPv4-mapped IPv6 hexadecimal suffix into canonical IPv4.
 *
 * Why: Node canonicalizes mapped addresses to `::ffff:xxxx:xxxx`; converting
 * that form prevents one viewer from receiving separate IPv4 and IPv6 buckets.
 *
 * @param {string} address - Canonical IPv6 address.
 * @returns {string|null} Canonical IPv4 when mapped, otherwise null.
 */
function mappedIpv6ToIpv4(address) {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!match) return null;

  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/**
 * Validates and canonicalizes a source address for an in-memory bucket.
 *
 * Why: equivalent IPv6 spellings and IPv4-mapped IPv6 must share a bucket,
 * while zone ids, hostnames, whitespace, and other non-IP inputs fail closed.
 *
 * @param {unknown} value - Candidate address from an authoritative source.
 * @returns {string|null} Canonical IPv4/IPv6 address, or null when invalid.
 */
export function normalizeTemporarySessionAddress(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 45) {
    return null;
  }
  if (value !== value.trim()) return null;

  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;

  try {
    const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    return mappedIpv6ToIpv4(canonical) || canonical;
  } catch {
    return null;
  }
}

/**
 * Splits one CloudFront viewer-address value into address and source port.
 *
 * Why: CloudFront supplies the authoritative viewer address with its port.
 * Supporting strict bracketed and unbracketed IPv6 avoids serialization
 * ambiguity without accepting missing ports or forwarding-header lists.
 *
 * @param {string} value - Single CloudFront-Viewer-Address header value.
 * @returns {{address: string, port: number}|null} Parsed source or null.
 */
function parseCloudFrontViewerAddress(value) {
  if (value.length === 0 || value.length > 64 || value !== value.trim() || value.includes(',')) {
    return null;
  }

  let rawAddress;
  let rawPort;
  const bracketed = /^\[([^\]]+)\]:([1-9]\d{0,4})$/.exec(value);

  if (bracketed) {
    rawAddress = bracketed[1];
    rawPort = bracketed[2];
    if (isIP(rawAddress) !== 6) return null;
  } else {
    const lastColon = value.lastIndexOf(':');
    if (lastColon <= 0) return null;
    rawAddress = value.slice(0, lastColon);
    rawPort = value.slice(lastColon + 1);
    if (!/^[1-9]\d{0,4}$/.test(rawPort)) return null;
  }

  const port = Number(rawPort);
  const address = normalizeTemporarySessionAddress(rawAddress);
  if (!address || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  return { address, port };
}

/**
 * Resolves the only trusted source identity for the selected runtime mode.
 *
 * Why: local/test traffic terminates at the socket, while deployed traffic
 * must use exactly one CloudFront-generated viewer header. Forwarding headers
 * and the deployed origin socket are intentionally never consulted.
 *
 * @param {object} req - Next.js request-like object.
 * @param {'local'|'deployed'} mode - Explicit source trust mode.
 * @returns {{success: true, address: string}|{success: false, reason: string}}
 */
export function resolveTemporarySessionSource(req, mode) {
  if (!SOURCE_MODES.has(mode)) {
    return { success: false, reason: 'source_mode_invalid' };
  }

  if (mode === 'local') {
    const address = normalizeTemporarySessionAddress(req?.socket?.remoteAddress);
    return address
      ? { success: true, address }
      : { success: false, reason: 'source_missing_or_invalid' };
  }

  const header = req?.headers?.['cloudfront-viewer-address'];
  if (typeof header !== 'string') {
    return { success: false, reason: 'source_missing_or_repeated' };
  }

  const parsed = parseCloudFrontViewerAddress(header);
  return parsed
    ? { success: true, address: parsed.address }
    : { success: false, reason: 'source_missing_or_invalid' };
}

/**
 * Chooses the production singleton's source policy from the explicit runtime.
 *
 * Why: only development and tests may trust the direct socket. Every other
 * runtime fails into the deployed CloudFront-only policy.
 *
 * @returns {'local'|'deployed'} Runtime source mode.
 */
function getDefaultSourceMode() {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return 'deployed';
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
    ? 'local'
    : 'deployed';
}

/**
 * Creates the fixed-size per-address ring used by the rolling window.
 *
 * @param {number} windowSeconds - Number of one-second buckets.
 * @param {number} currentSecond - Current wall-clock second.
 * @returns {object} Mutable bounded counter entry.
 */
function createCounterEntry(windowSeconds, currentSecond) {
  return {
    counts: new Uint16Array(windowSeconds),
    epochs: new Float64Array(windowSeconds),
    lastSeenSecond: currentSecond,
  };
}

/**
 * Counts requests still inside the configured rolling window.
 *
 * @param {object} entry - Address ring entry.
 * @param {number} currentSecond - Current wall-clock second.
 * @param {number} windowSeconds - Rolling-window width.
 * @returns {{total: number, oldestSecond: number|null}} Current usage details.
 */
function countRecentRequests(entry, currentSecond, windowSeconds) {
  const cutoffSecond = currentSecond - windowSeconds;
  let total = 0;
  let oldestSecond = null;

  for (let index = 0; index < windowSeconds; index += 1) {
    const count = entry.counts[index];
    if (count === 0) continue;

    const epoch = entry.epochs[index];
    if (!Number.isSafeInteger(epoch) || epoch > currentSecond) {
      throw new Error('temporary session ceiling counter state is invalid');
    }
    if (epoch < cutoffSecond) continue;

    total += count;
    if (oldestSecond === null || epoch < oldestSecond) oldestSecond = epoch;
  }

  return { total, oldestSecond };
}

/**
 * Increments the ring slot for the current second.
 *
 * @param {object} entry - Address ring entry.
 * @param {number} currentSecond - Current wall-clock second.
 * @param {number} windowSeconds - Rolling-window width.
 * @returns {void}
 */
function incrementCurrentSecond(entry, currentSecond, windowSeconds) {
  const index = currentSecond % windowSeconds;
  if (entry.epochs[index] !== currentSecond) {
    entry.epochs[index] = currentSecond;
    entry.counts[index] = 0;
  }
  entry.counts[index] += 1;
}

/**
 * Builds a fresh bounded telemetry accumulator.
 *
 * @param {number} windowStartSecond - Reporting-window start.
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
 * Invokes a structured logger without allowing telemetry failure to affect auth.
 *
 * @param {object|undefined} requestLogger - Request-scoped logger.
 * @param {'info'|'warn'} level - Structured log level.
 * @param {object} fields - Count-only event fields.
 * @param {string} message - Stable event message.
 * @returns {void}
 */
function emitBoundedLog(requestLogger, level, fields, message) {
  if (typeof requestLogger?.[level] !== 'function') return;
  try {
    requestLogger[level](fields, message);
  } catch {
    // Logging is observational and must not alter fail-closed enforcement.
  }
}

/**
 * Validates factory bounds used by production constants and focused tests.
 *
 * @param {object} options - Candidate numeric settings.
 * @returns {void}
 * @throws {TypeError} When a bound would make state unsafe or unbounded.
 */
function validateFactoryOptions({ limit, windowSeconds, maxAddresses, telemetryWindowSeconds }) {
  for (const value of [limit, windowSeconds, maxAddresses, telemetryWindowSeconds]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('temporary session ceiling options must be positive safe integers');
    }
  }
  if (limit > 65_535) {
    throw new TypeError('temporary session ceiling limit exceeds counter capacity');
  }
}

/**
 * Creates one bounded, per-instance session ceiling.
 *
 * Why: the factory isolates deterministic tests while the exported singleton
 * shares one v1/v2 counter map inside each running server instance.
 *
 * @param {object} [options] - Testable clock, source, and fixed-size bounds.
 * @param {number} [options.limit=400] - Allowed requests per rolling window.
 * @param {number} [options.windowSeconds=60] - One-second ring size.
 * @param {number} [options.maxAddresses=10000] - Maximum live address entries.
 * @param {number} [options.telemetryWindowSeconds=60] - Aggregate log cadence.
 * @param {() => number} [options.now] - Millisecond wall clock.
 * @param {'local'|'deployed'|(() => 'local'|'deployed')} [options.sourceMode]
 * @returns {{evaluate: Function, getSnapshot: Function}} Ceiling instance.
 */
export function createTemporarySessionCeiling(options = {}) {
  const limit = options.limit ?? TEMPORARY_SESSION_CEILING_LIMIT;
  const windowSeconds = options.windowSeconds ?? TEMPORARY_SESSION_CEILING_WINDOW_SECONDS;
  const maxAddresses = options.maxAddresses ?? TEMPORARY_SESSION_CEILING_MAX_ADDRESSES;
  const telemetryWindowSeconds = options.telemetryWindowSeconds ?? windowSeconds;
  const now = options.now ?? Date.now;
  const sourceMode = options.sourceMode ?? getDefaultSourceMode;

  validateFactoryOptions({ limit, windowSeconds, maxAddresses, telemetryWindowSeconds });
  if (typeof now !== 'function') throw new TypeError('temporary session ceiling clock must be callable');

  const entries = new Map();
  let lastObservedSecond = null;
  let lastPruneSecond = null;
  let telemetry = null;
  let clockFailureSampled = false;

  /**
   * Resolves the configured source mode for one request.
   *
   * @returns {'local'|'deployed'|null} Valid mode or null for fail-closed use.
   */
  function resolveSourceMode() {
    const mode = typeof sourceMode === 'function' ? sourceMode() : sourceMode;
    return SOURCE_MODES.has(mode) ? mode : null;
  }

  /**
   * Emits the completed active reporting window and starts the current one.
   *
   * @param {number} currentSecond - Current wall-clock second.
   * @param {object|undefined} requestLogger - Request-scoped logger.
   * @returns {void}
   */
  function rotateTelemetry(currentSecond, requestLogger) {
    const windowStartSecond = Math.floor(currentSecond / telemetryWindowSeconds)
      * telemetryWindowSeconds;

    if (!telemetry) {
      telemetry = createTelemetry(windowStartSecond);
      telemetry.rejectionSampled = clockFailureSampled;
      return;
    }
    if (windowStartSecond === telemetry.windowStartSecond) return;

    if (telemetry.totalChecks > 0) {
      emitBoundedLog(requestLogger, 'info', {
        event: TELEMETRY_EVENT,
        totalChecks: telemetry.totalChecks,
        allowedChecks: telemetry.allowedChecks,
        rejectedChecks: telemetry.rejectedChecks,
        sourceResolutionFailures: telemetry.sourceResolutionFailures,
        stateCapacityFailures: telemetry.stateCapacityFailures,
        internalFailures: telemetry.internalFailures,
        activeEntryCount: entries.size,
        expiredEntryCleanupCount: telemetry.expiredEntryCleanupCount,
        routeVersionTotals: telemetry.routeVersionTotals,
      }, 'Temporary session ceiling summary');
    }

    telemetry = createTelemetry(windowStartSecond);
    clockFailureSampled = false;
  }

  /**
   * Removes inactive address entries at most once per observed second.
   *
   * @param {number} currentSecond - Current wall-clock second.
   * @returns {number} Number of expired entries removed.
   */
  function pruneExpiredEntries(currentSecond) {
    if (lastPruneSecond !== null && currentSecond <= lastPruneSecond) return 0;

    let removed = 0;
    for (const [address, entry] of entries) {
      if (!Number.isSafeInteger(entry?.lastSeenSecond) || entry.lastSeenSecond > currentSecond) {
        throw new Error('temporary session ceiling entry state is invalid');
      }
      if (currentSecond - entry.lastSeenSecond > windowSeconds) {
        entries.delete(address);
        removed += 1;
      }
    }
    lastPruneSecond = currentSecond;
    return removed;
  }

  /**
   * Emits at most one rejection sample in the active reporting window.
   *
   * @param {object|undefined} requestLogger - Request-scoped logger.
   * @param {object} details - Non-identifying rejection fields.
   * @returns {void}
   */
  function sampleRejection(requestLogger, details) {
    if (!telemetry || telemetry.rejectionSampled) return;
    telemetry.rejectionSampled = true;
    emitBoundedLog(requestLogger, 'warn', {
      event: REJECTION_EVENT,
      outcome: details.outcome,
      reason: details.reason,
      routeVersion: details.routeVersion,
      retryAfterSeconds: details.retryAfterSeconds ?? null,
    }, 'Temporary session ceiling rejection sample');
  }

  /**
   * Returns a fail-closed clock result without attacker-amplified logging.
   *
   * @param {object|undefined} requestLogger - Request-scoped logger.
   * @param {string} routeVersion - Bounded route-version label.
   * @returns {object} Unavailable evaluator result.
   */
  function rejectClockFailure(requestLogger, routeVersion) {
    if (telemetry) {
      telemetry.totalChecks += 1;
      telemetry.rejectedChecks += 1;
      telemetry.internalFailures += 1;
      telemetry.routeVersionTotals[routeVersion] += 1;
      sampleRejection(requestLogger, {
        outcome: 'unavailable',
        reason: 'clock_unavailable',
        routeVersion,
      });
      return { allowed: false, statusCode: 503, reason: 'clock_unavailable' };
    }

    if (!clockFailureSampled) {
      clockFailureSampled = true;
      emitBoundedLog(requestLogger, 'warn', {
        event: REJECTION_EVENT,
        outcome: 'unavailable',
        reason: 'clock_unavailable',
        routeVersion,
        retryAfterSeconds: null,
      }, 'Temporary session ceiling rejection sample');
    }
    return { allowed: false, statusCode: 503, reason: 'clock_unavailable' };
  }

  /**
   * Evaluates and consumes one combined v1/v2 session request.
   *
   * Side effects: updates only bounded in-memory counters and bounded telemetry;
   * it never calls Redis, Supabase, timers, or response-formatting helpers.
   *
   * @param {object} req - Next.js request-like object.
   * @param {object} [context] - Route and logger context.
   * @param {'v1'|'v2'} [context.routeVersion] - Session route version.
   * @param {object} [context.logger] - Request-scoped structured logger.
   * @returns {object} Allow, 429, or fail-closed 503 decision.
   */
  function evaluate(req, context = {}) {
    const routeVersion = ROUTE_VERSIONS.has(context.routeVersion)
      ? context.routeVersion
      : 'unknown';
    const requestLogger = context.logger ?? req?.log;

    let currentSecond;
    try {
      const nowMs = now();
      if (!Number.isFinite(nowMs) || nowMs < 0) {
        return rejectClockFailure(requestLogger, routeVersion);
      }
      currentSecond = Math.floor(nowMs / 1000);
      if (!Number.isSafeInteger(currentSecond)
        || (lastObservedSecond !== null && currentSecond < lastObservedSecond)) {
        return rejectClockFailure(requestLogger, routeVersion);
      }
    } catch {
      return rejectClockFailure(requestLogger, routeVersion);
    }

    lastObservedSecond = currentSecond;
    let checkRecorded = false;

    try {
      const expiredEntryCleanupCount = pruneExpiredEntries(currentSecond);
      if (telemetry) {
        telemetry.expiredEntryCleanupCount += expiredEntryCleanupCount;
      }
      rotateTelemetry(currentSecond, requestLogger);
      telemetry.totalChecks += 1;
      telemetry.routeVersionTotals[routeVersion] += 1;
      checkRecorded = true;

      const mode = resolveSourceMode();
      const source = resolveTemporarySessionSource(req, mode);
      if (!source.success) {
        telemetry.rejectedChecks += 1;
        telemetry.sourceResolutionFailures += 1;
        sampleRejection(requestLogger, {
          outcome: 'unavailable',
          reason: source.reason,
          routeVersion,
        });
        return { allowed: false, statusCode: 503, reason: source.reason };
      }

      let entry = entries.get(source.address);
      if (!entry) {
        if (entries.size >= maxAddresses) {
          telemetry.rejectedChecks += 1;
          telemetry.stateCapacityFailures += 1;
          sampleRejection(requestLogger, {
            outcome: 'unavailable',
            reason: 'state_capacity',
            routeVersion,
          });
          return { allowed: false, statusCode: 503, reason: 'state_capacity' };
        }
        entry = createCounterEntry(windowSeconds, currentSecond);
        entries.set(source.address, entry);
      }

      entry.lastSeenSecond = currentSecond;
      const usage = countRecentRequests(entry, currentSecond, windowSeconds);
      if (usage.total >= limit) {
        const retryAfterSeconds = Math.max(
          1,
          (usage.oldestSecond ?? currentSecond) + windowSeconds - currentSecond
        );
        telemetry.rejectedChecks += 1;
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

      incrementCurrentSecond(entry, currentSecond, windowSeconds);
      telemetry.allowedChecks += 1;
      return { allowed: true };
    } catch {
      if (!telemetry) rotateTelemetry(currentSecond, requestLogger);
      if (!checkRecorded) {
        telemetry.totalChecks += 1;
        telemetry.routeVersionTotals[routeVersion] += 1;
      }
      telemetry.rejectedChecks += 1;
      telemetry.internalFailures += 1;
      sampleRejection(requestLogger, {
        outcome: 'unavailable',
        reason: 'internal_failure',
        routeVersion,
      });
      return { allowed: false, statusCode: 503, reason: 'internal_failure' };
    }
  }

  /**
   * Exposes count-only state for invariant tests and operational evidence.
   *
   * @returns {object} Bounded state counters with no source identifiers.
   */
  function getSnapshot() {
    return {
      activeEntryCount: entries.size,
      lastObservedSecond,
      telemetry: telemetry
        ? {
          totalChecks: telemetry.totalChecks,
          allowedChecks: telemetry.allowedChecks,
          rejectedChecks: telemetry.rejectedChecks,
          sourceResolutionFailures: telemetry.sourceResolutionFailures,
          stateCapacityFailures: telemetry.stateCapacityFailures,
          internalFailures: telemetry.internalFailures,
          expiredEntryCleanupCount: telemetry.expiredEntryCleanupCount,
          routeVersionTotals: { ...telemetry.routeVersionTotals },
        }
        : null,
    };
  }

  return { evaluate, getSnapshot };
}

export const temporarySessionCeiling = createTemporarySessionCeiling();
