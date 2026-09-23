/**
 * Opt-in, authenticated GATE-1 source observations on the real session route.
 * Enable only on an approved deployment with GATE1_SOURCE_PROBE_ENABLED=true
 * and a separate 64-lowercase-hex GATE1_SOURCE_PROBE_SECRET. Authorization is
 * Bearer <secret>; x-gate1-source-diagnostic is 1; User-Agent is a unique
 * gate1-source-<32 lowercase hex> marker. No credential bypasses the ceiling.
 * This reports origin facts, never independent WAF agreement. Missing/malformed
 * raw metadata cannot authenticate and remains a fixture/canary obligation.
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PRIVATE_NO_STORE } from '../../shared/constants/authV2.js';

export const GATE1_SOURCE_PROBE_HEADER = 'X-Gate1-Source-Probe';
export const GATE1_SOURCE_DIAGNOSTIC_HEADER = 'x-gate1-source-diagnostic';
const TRUSTED_HEADER = 'x-vercel-forwarded-for';
const MAX_RAW_ENTRIES = 256;
const MAX_RAW_CHARACTERS = 32_768;
const secretSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const markerSchema = z.string().length(45).regex(/^gate1-source-[a-f0-9]{32}$/);
const factsSchema = z.object({
  effectiveMode: z.enum(['not_observed', 'invalid', 'local', 'vercel']),
  sourceResolution: z.enum(['not_attempted', 'accepted', 'rejected']),
  canonicalFamily: z.union([z.literal(4), z.literal(6), z.null()]),
}).strict().refine((facts) => (
  (facts.sourceResolution === 'accepted') === (facts.canonicalFamily !== null)
  && (['local', 'vercel'].includes(facts.effectiveMode)
    || facts.sourceResolution === 'not_attempted')
));

/**
 * Bounds raw metadata before authentication/observation; never changes req.
 * @param {unknown} raw alternating header names and values
 * @returns {boolean} safe bounded string pairs, including duplicate names
 */
function validRawMetadata(raw) {
  if (!Array.isArray(raw) || raw.length % 2 || raw.length > MAX_RAW_ENTRIES) return false;
  let characters = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (typeof raw[index] !== 'string') return false;
    if (index % 2 === 0 && (raw[index].length === 0 || raw[index].length > 128)) return false;
    characters += raw[index].length;
    if (characters > MAX_RAW_CHARACTERS) return false;
  }
  return true;
}

/**
 * Requires one raw occurrence exactly equal to the normalized scalar.
 * @param {object} req bounded request metadata
 * @param {string} name lowercase authentication/marker header name
 * @returns {string|null} transient scalar; never logged or returned to clients
 */
function singleton(req, name) {
  const normalized = req.headers?.[name];
  if (typeof normalized !== 'string') return null;
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() !== name) continue;
    count += 1;
    if (req.rawHeaders[index + 1] !== normalized) return null;
  }
  return count === 1 ? normalized : null;
}

/**
 * Describes raw/normalized shape without parsing or retaining address values.
 * @param {object} req authenticated request with bounded raw metadata
 * @returns {object} counts, enums and equality only, detached from the request
 */
function describeHeaders(req) {
  let trustedHeaderCount = 0;
  let rawValue;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === TRUSTED_HEADER) {
      trustedHeaderCount += 1;
      rawValue = req.rawHeaders[index + 1];
    }
  }
  const normalized = req.headers?.[TRUSTED_HEADER];
  const normalizedShape = typeof normalized === 'string' ? 'scalar'
    : normalized === undefined ? 'missing' : Array.isArray(normalized) ? 'array' : 'other';
  return Object.freeze({
    rawMetadataValid: true,
    trustedHeaderCount,
    normalizedShape,
    rawNormalizedEqual: trustedHeaderCount === 1 && normalizedShape === 'scalar'
      ? rawValue === normalized : null,
  });
}

/**
 * Creates the route's best-effort observer; no logs, timers, or network work.
 * @param {object} [options] environment seam for isolated fixture tests
 * @returns {{createObserver: Function}} authenticated response-header adapter
 */
export function createGate1SourceProbe(options = {}) {
  const env = options.env ?? process.env;

  /**
   * Authenticates before returning a one-shot observer of actual limiter facts.
   * @param {object} req original session request, read only
   * @param {object} res response receiving a bounded private/no-store header
   * @returns {Function|undefined} synchronous callback; failures omit evidence
   */
  function createObserver(req, res) {
    try {
      if (env.GATE1_SOURCE_PROBE_ENABLED !== 'true' || req.method !== 'GET'
        || env.NODE_ENV !== 'production' || env.VERCEL !== '1'
        || !['production', 'preview'].includes(env.VERCEL_ENV)) return undefined;
      const secret = env.GATE1_SOURCE_PROBE_SECRET;
      if (!secretSchema.safeParse(secret).success || !validRawMetadata(req.rawHeaders)) return undefined;
      if (singleton(req, GATE1_SOURCE_DIAGNOSTIC_HEADER) !== '1') return undefined;
      const authorization = singleton(req, 'authorization');
      if (typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(authorization)) {
        return undefined;
      }
      if (!timingSafeEqual(Buffer.from(authorization.slice(7), 'hex'), Buffer.from(secret, 'hex'))) {
        return undefined;
      }
      const marker = singleton(req, 'user-agent');
      if (!markerSchema.safeParse(marker).success) return undefined;
      const shape = describeHeaders(req);
      let used = false;

      /**
       * Emits sanitized post-decision facts once; never receives source bytes.
       * @param {object} facts frozen, primitive-only limiter snapshot
       * @returns {void} header failures are contained; ordinary response continues
       */
      function observe(facts) {
        if (used) return;
        used = true;
        try {
          const parsed = factsSchema.safeParse(facts);
          if (!parsed.success || res.headersSent || res.writableEnded || res.finished) return;
          const candidateId = res.getHeader?.('X-Request-Id');
          const applicationRequestId = typeof candidateId === 'string'
            && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(candidateId) ? candidateId : null;
          const value = JSON.stringify({
            schemaVersion: 1,
            scope: 'server_header_observation_only',
            marker,
            applicationRequestId,
            ...shape,
            ...parsed.data,
            sourceAgreement: 'not_evaluated',
          });
          if (Buffer.byteLength(value) > 1_024) return;
          res.setHeader('Cache-Control', PRIVATE_NO_STORE);
          res.setHeader(GATE1_SOURCE_PROBE_HEADER, value);
        } catch {
          // Never log request/response values, credentials, source or exceptions.
        }
      }
      return observe;
    } catch {
      return undefined;
    }
  }
  return { createObserver };
}

export const gate1SourceProbe = createGate1SourceProbe();
