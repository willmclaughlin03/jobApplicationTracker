/**
 * Authenticated secret-loader observations on the real session route.
 * Requires GATE1_SECRETS_PROBE_ENABLED=true and a dedicated 64-lowercase-hex
 * GATE1_SECRETS_PROBE_SECRET, supplied as Authorization: Bearer. The additional
 * marker header is x-gate1-secrets-diagnostic: 1 and User-Agent is
 * gate1-secrets-<32 lowercase hex>. Neither marker nor credential bypasses guards.
 * Production also requires GATE1_SECRETS_PROBE_PRODUCTION_ENABLED=true; the
 * existing enable flag alone continues to permit only Preview observations.
 * No secrets, source addresses, raw errors, resets or transport operations.
 * Optional private trace callbacks receive only fixed stage outcomes.
 * Deployment/configuration and live requests require separate authorization.
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PRIVATE_NO_STORE } from '../../shared/constants/authV2.js';
import { TEMPORARY_SESSION_FAILURE_REASONS } from './temporarySessionTelemetry.js';

export const GATE1_SECRETS_PROBE_HEADER = 'X-Gate1-Secrets-Probe';
export const GATE1_SECRETS_DIAGNOSTIC_HEADER = 'x-gate1-secrets-diagnostic';
const credentialSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const markerSchema = z.string().length(46).regex(/^gate1-secrets-[a-f0-9]{32}$/);
const stateSchema = z.object({ hasCachedPair: z.boolean(), permanentFailure: z.boolean() })
  .strict().refine((state) => !(state.hasCachedPair && state.permanentFailure));
const loaderFields = {
  loaderId: z.string().length(32).regex(/^[a-f0-9]{32}$/).nullable(),
  validationAttempts: z.number().int().min(0).max(2),
  effectiveMode: z.enum(['not_attempted', 'invalid', 'local', 'vercel']),
  validationStage: z.enum(['not_attempted', 'mode', 'payloads', 'hmac', 'redis', 'complete']),
  hmacInput: z.enum(['not_read', 'missing', 'present']),
  redisInput: z.enum(['not_read', 'missing', 'present']),
  hasCachedPair: z.boolean(), permanentFailure: z.boolean(),
};
/** Rejects contradictory cache outcomes in both legacy and recorded observations. */
function consistentLoader(state) {
  return !(state.hasCachedPair && state.permanentFailure)
    && (state.hasCachedPair === (state.validationStage === 'complete'));
}
const initializationSchema = z.object({
  schemaVersion: z.literal(1), priorHasCachedPair: z.literal(false), priorPermanentFailure: z.literal(false),
  validationAttemptsBefore: z.literal(0), validationAttempts: z.literal(1),
  effectiveMode: loaderFields.effectiveMode, validationStage: loaderFields.validationStage,
  hmacInput: loaderFields.hmacInput, redisInput: loaderFields.redisInput,
  hasCachedPair: z.boolean(), permanentFailure: z.boolean(),
}).strict().refine(consistentLoader);
const loaderSchema = z.object(loaderFields).strict().refine(consistentLoader);
const recordedLoaderSchema = z.object({ ...loaderFields, initialization: initializationSchema.nullable() })
  .strict().refine(consistentLoader);
const factsFields = {
  effectiveMode: z.enum(['not_observed', 'invalid', 'local', 'vercel']),
  sourceResolution: z.enum(['not_attempted', 'accepted', 'rejected']),
  canonicalFamily: z.union([z.literal(4), z.literal(6), z.null()]),
  loaderReached: z.boolean(), loaderStateBefore: stateSchema.nullable(),
  loader: loaderSchema.nullable(), identityAttempted: z.boolean(),
  redisAttempted: z.boolean(), scriptAttempted: z.boolean(),
  allowed: z.boolean(), reason: z.enum(Object.values(TEMPORARY_SESSION_FAILURE_REASONS)).nullable(),
};
const factsSchema = z.object(factsFields).strict().refine(consistentFacts);
const recordedFactsSchema = z.object({ ...factsFields, loader: recordedLoaderSchema.nullable() })
  .strict().refine(consistentFacts);

/** Rejects contradictory stage facts; params contain only fixed sanitized fields. */
function consistentFacts(facts) {
  return (facts.sourceResolution === 'accepted') === (facts.canonicalFamily !== null)
    && (['local', 'vercel'].includes(facts.effectiveMode) || facts.sourceResolution === 'not_attempted')
    && (!facts.loaderReached || facts.sourceResolution === 'accepted')
    && (facts.loaderReached || (facts.loader === null && facts.loaderStateBefore === null))
    && (!facts.identityAttempted || facts.loaderReached)
    && (!facts.redisAttempted || facts.identityAttempted)
    && (!facts.scriptAttempted || facts.redisAttempted)
    && (facts.allowed === (facts.reason === null))
    && (!facts.allowed || facts.scriptAttempted);
}

/** Bounds original raw metadata before authentication; req is never rewritten. */
function validRawMetadata(raw) {
  if (!Array.isArray(raw) || raw.length % 2 || raw.length > 256) return false;
  let bytes = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (typeof raw[i] !== 'string') return false;
    if (i % 2 === 0 && (raw[i].length === 0 || raw[i].length > 128)) return false;
    bytes += Buffer.byteLength(raw[i]);
    if (bytes > 32_768) return false;
  }
  return true;
}

/** Reads one raw/normalized agreeing scalar header; returned values stay transient. */
function singleton(req, name) {
  const value = req.headers?.[name];
  if (typeof value !== 'string') return null;
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() !== name) continue;
    count += 1;
    if (req.rawHeaders[i + 1] !== value) return null;
  }
  return count === 1 ? value : null;
}

/** Records an optional private stage without letting diagnostic failures affect eligibility. */
function traceStage(trace, kind, value) {
  try { trace?.record(kind, value); } catch { /* Observational only. */ }
}

/**
 * Creates a response-only adapter using an isolated env seam for fixture tests.
 * @param {object} [options] env is read at authentication, never retained in output
 * @returns {{createObserver: Function}} best-effort authenticated callback factory
 */
export function createGate1SecretsProbe(options = {}) {
  const env = options.env ?? process.env;

  /**
   * Authenticates bounded, explicitly enabled deployment GET metadata.
   * @param {object} req original Node request, read only
   * @param {object} res existing route response; receives only no-store metadata
   * @param {object} [trace] independently selected private stage sink; never authorizes observation
   * @returns {Function|undefined} one-shot synchronous observer; failures omit it
   */
  function createObserver(req, res, trace) {
    /** Preserves the first actual rejection without evaluating any later checks. */
    function reject(reason) { traceStage(trace, 'authentication', reason); return undefined; }
    try {
      const environment = env.VERCEL_ENV;
      if (env.GATE1_SECRETS_PROBE_ENABLED !== 'true') return reject('probe_disabled');
      if (req.method !== 'GET' || env.NODE_ENV !== 'production' || env.VERCEL !== '1'
        || (environment !== 'preview' && environment !== 'production')) return reject('runtime_ineligible');
      if (environment === 'production' && env.GATE1_SECRETS_PROBE_PRODUCTION_ENABLED !== 'true') return reject('production_opt_in_missing');
      const secret = env.GATE1_SECRETS_PROBE_SECRET;
      if (!credentialSchema.safeParse(secret).success) return reject('configured_credential_invalid');
      if (!validRawMetadata(req.rawHeaders)) return reject('raw_metadata_invalid');
      const version = singleton(req, GATE1_SECRETS_DIAGNOSTIC_HEADER);
      if (version !== '1' && version !== '2') return reject('diagnostic_marker_invalid');
      if (version === '2' && environment !== 'preview') return reject('runtime_ineligible');
      const authorization = singleton(req, 'authorization');
      if (typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(authorization)) return reject('authorization_invalid');
      if (!timingSafeEqual(Buffer.from(authorization.slice(7), 'hex'), Buffer.from(secret, 'hex'))) return reject('credential_mismatch');
      const marker = singleton(req, 'user-agent');
      if (!markerSchema.safeParse(marker).success) return reject('user_agent_invalid');
      let used = false;

      /**
       * Emits strictly validated post-decision facts once, with no secret values.
       * @param {object} facts detached limiter/loader state, never a runtime pair
       * @returns {void} failures never replace the normal status/body or decision
       */
      function observe(facts) {
        traceStage(trace, 'invocation');
        if (used) return;
        used = true;
        try {
          if (res.headersSent || res.writableEnded || res.finished) { traceStage(trace, 'emission', 'response_closed'); return; }
          // Legacy responses omit only the new internal record; other unknown fields still reject.
          let projected = facts;
          if (version === '1' && facts?.loader && Object.hasOwn(facts.loader, 'initialization')) {
            const legacyLoader = { ...facts.loader };
            delete legacyLoader.initialization;
            projected = { ...facts, loader: legacyLoader };
          }
          const parsed = (version === '2' ? recordedFactsSchema : factsSchema).safeParse(projected);
          if (!parsed.success) { traceStage(trace, 'emission', 'facts_rejected'); return; }
          const value = JSON.stringify({
            schemaVersion: version === '2' ? 3 : 2, scope: 'secret_loader_observation_only',
            environment, contextScope: 'loader', marker, ...parsed.data,
          });
          if (Buffer.byteLength(value) > 1_536) { traceStage(trace, 'emission', 'payload_oversized'); return; }
          try {
            res.setHeader('Cache-Control', PRIVATE_NO_STORE);
            res.setHeader(GATE1_SECRETS_PROBE_HEADER, value);
          } catch { traceStage(trace, 'emission', 'header_write_failed'); return; }
          traceStage(trace, 'emission', 'header_set_returned');
        } catch {
          traceStage(trace, 'emission', 'internal_error');
          // Omit evidence without retaining request, response, errors or credentials.
        }
      }
      traceStage(trace, 'authentication', 'accepted');
      return observe;
    } catch {
      return reject('internal_error');
    }
  }
  return { createObserver };
}

export const gate1SecretsProbe = createGate1SecretsProbe();
