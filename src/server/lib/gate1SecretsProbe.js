/**
 * Authenticated, Preview-only secret-loader observations on the real session route.
 * Requires GATE1_SECRETS_PROBE_ENABLED=true and a dedicated 64-lowercase-hex
 * GATE1_SECRETS_PROBE_SECRET, supplied as Authorization: Bearer. The additional
 * marker header is x-gate1-secrets-diagnostic: 1 and User-Agent is
 * gate1-secrets-<32 lowercase hex>. Neither marker nor credential bypasses guards.
 * No secrets, source addresses, raw errors, logs, resets or transport operations.
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
const loaderSchema = z.object({
  loaderId: z.string().length(32).regex(/^[a-f0-9]{32}$/).nullable(),
  validationAttempts: z.number().int().min(0).max(2),
  effectiveMode: z.enum(['not_attempted', 'invalid', 'local', 'vercel']),
  validationStage: z.enum(['not_attempted', 'mode', 'payloads', 'hmac', 'redis', 'complete']),
  hmacInput: z.enum(['not_read', 'missing', 'present']),
  redisInput: z.enum(['not_read', 'missing', 'present']),
  hasCachedPair: z.boolean(), permanentFailure: z.boolean(),
}).strict().refine((state) => !(state.hasCachedPair && state.permanentFailure)
  && (state.hasCachedPair === (state.validationStage === 'complete')));
const factsSchema = z.object({
  effectiveMode: z.enum(['not_observed', 'invalid', 'local', 'vercel']),
  sourceResolution: z.enum(['not_attempted', 'accepted', 'rejected']),
  canonicalFamily: z.union([z.literal(4), z.literal(6), z.null()]),
  loaderReached: z.boolean(), loaderStateBefore: stateSchema.nullable(),
  loader: loaderSchema.nullable(), identityAttempted: z.boolean(),
  redisAttempted: z.boolean(), scriptAttempted: z.boolean(),
  allowed: z.boolean(), reason: z.enum(Object.values(TEMPORARY_SESSION_FAILURE_REASONS)).nullable(),
}).strict().refine(consistentFacts);

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

/**
 * Creates a response-only adapter using an isolated env seam for fixture tests.
 * @param {object} [options] env is read at authentication, never retained in output
 * @returns {{createObserver: Function}} best-effort authenticated callback factory
 */
export function createGate1SecretsProbe(options = {}) {
  const env = options.env ?? process.env;

  /**
   * Authenticates bounded Preview GET metadata before requesting observations.
   * @param {object} req original Node request, read only
   * @param {object} res existing route response; receives only no-store metadata
   * @returns {Function|undefined} one-shot synchronous observer; failures omit it
   */
  function createObserver(req, res) {
    try {
      if (env.GATE1_SECRETS_PROBE_ENABLED !== 'true' || req.method !== 'GET'
        || env.NODE_ENV !== 'production' || env.VERCEL !== '1'
        || env.VERCEL_ENV !== 'preview') return undefined;
      const secret = env.GATE1_SECRETS_PROBE_SECRET;
      if (!credentialSchema.safeParse(secret).success || !validRawMetadata(req.rawHeaders)) return undefined;
      if (singleton(req, GATE1_SECRETS_DIAGNOSTIC_HEADER) !== '1') return undefined;
      const authorization = singleton(req, 'authorization');
      if (typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(authorization)) return undefined;
      if (!timingSafeEqual(Buffer.from(authorization.slice(7), 'hex'), Buffer.from(secret, 'hex'))) return undefined;
      const marker = singleton(req, 'user-agent');
      if (!markerSchema.safeParse(marker).success) return undefined;
      let used = false;

      /**
       * Emits strictly validated post-decision facts once, with no secret values.
       * @param {object} facts detached limiter/loader state, never a runtime pair
       * @returns {void} failures never replace the normal status/body or decision
       */
      function observe(facts) {
        if (used) return;
        used = true;
        try {
          if (res.headersSent || res.writableEnded || res.finished) return;
          const parsed = factsSchema.safeParse(facts);
          if (!parsed.success) return;
          const value = JSON.stringify({
            schemaVersion: 1, scope: 'secret_loader_observation_only',
            contextScope: 'loader', marker, ...parsed.data,
          });
          if (Buffer.byteLength(value) > 1_536) return;
          res.setHeader('Cache-Control', PRIVATE_NO_STORE);
          res.setHeader(GATE1_SECRETS_PROBE_HEADER, value);
        } catch {
          // Omit evidence without retaining request, response, errors or credentials.
        }
      }
      return observe;
    } catch {
      return undefined;
    }
  }
  return { createObserver };
}

export const gate1SecretsProbe = createGate1SecretsProbe();
