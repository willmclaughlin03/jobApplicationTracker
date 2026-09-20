/**
 * Read-only runtime observations for the GATE-1 hosted restart investigation.
 *
 * Enable on an approved Vercel preview or production deployment with
 * GATE1_RESTART_PROBE_ENABLED=true and a separate GATE1_RESTART_PROBE_SECRET
 * containing 64 lowercase hexadecimal characters. A diagnostic GET supplies
 * that secret as Authorization: Bearer.
 * Deployment Protection access is separate; neither credential bypasses the
 * session ceiling. Configuration and hosted requests require separate approval.
 *
 * The lazy module-context identifier is NOT a process/instance identifier or
 * proof of initialization time, termination, replacement, or Redis continuity.
 * Marked requests may emit one fixed outcome per kind per module through the
 * existing logger. No signal handlers, process controls, or background work.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { z } from 'zod';
import { PRIVATE_NO_STORE } from '../../shared/constants/authV2.js';
import { logger } from '../../shared/logger.js';

export const GATE1_RESTART_PROBE_HEADER = 'X-Gate1-Restart-Probe';
export const GATE1_RESTART_DIAGNOSTIC_HEADER = 'x-gate1-restart-diagnostic';

const secretSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const authorizationSchema = z.string().length(71).regex(/^Bearer [a-f0-9]{64}$/);
const runtimeSchema = z.object({
  processUptimeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  nodeVersion: z.string().max(16).regex(/^v\d{1,3}\.\d{1,3}\.\d{1,3}$/),
  isMainThread: z.boolean(),
}).strict();
const MAX_RAW_HEADER_ENTRIES = 256;
const DIAGNOSTIC_OUTCOMES = new Set([
  'environment_rejected', 'response_unavailable', 'secret_format_invalid',
  'authorization_missing', 'authorization_format_invalid', 'raw_headers_invalid',
  'raw_header_mismatch', 'raw_authorization_missing', 'raw_authorization_duplicate',
  'credential_mismatch', 'context_unavailable', 'runtime_invalid',
  'header_attached', 'observation_failed',
]);

/**
 * Reads only the runtime facts approved for diagnostic responses.
 *
 * Why: process age and worker status help design a later hosted experiment;
 * they do not identify a physical instance or establish a restart.
 *
 * @returns {object} process age in milliseconds, Node version, and thread kind
 */
function readProcessRuntime() {
  return {
    processUptimeMs: Math.floor(process.uptime() * 1_000),
    nodeVersion: process.version,
    isMainThread,
  };
}

/**
 * Authenticates one bounded, unambiguous diagnostic credential.
 *
 * Why: Node can discard duplicate Authorization headers during normalization;
 * raw/normalized agreement prevents those ambiguous requests exposing data.
 * Nothing is read from cookies, query strings, or request bodies.
 *
 * @param {object} req request with Node rawHeaders and normalized headers
 * @param {string} secret configured dedicated probe secret, never retained in output
 * @returns {string|null} fixed rejection reason, or null for one matching credential
 */
function probeAuthenticationFailure(req, secret) {
  const authorization = req.headers?.authorization;
  if (!secretSchema.safeParse(secret).success) return 'secret_format_invalid';
  if (authorization === undefined || authorization === null) return 'authorization_missing';
  if (!authorizationSchema.safeParse(authorization).success) return 'authorization_format_invalid';

  const raw = req.rawHeaders;
  if (!Array.isArray(raw) || raw.length % 2 !== 0
    || raw.length > MAX_RAW_HEADER_ENTRIES) return 'raw_headers_invalid';

  let occurrences = 0;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index];
    if (typeof name !== 'string' || name.length > 128) return 'raw_headers_invalid';
    if (name.toLowerCase() === 'authorization') {
      occurrences += 1;
      if (occurrences > 1) return 'raw_authorization_duplicate';
      if (raw[index + 1] !== authorization) return 'raw_header_mismatch';
    }
  }
  if (occurrences !== 1) return 'raw_authorization_missing';
  return timingSafeEqual(
    Buffer.from(authorization.slice(7), 'hex'),
    Buffer.from(secret, 'hex')
  ) ? null : 'credential_mismatch';
}

/**
 * Creates an isolated, lazy observational probe used by the v1 route wrapper.
 *
 * @param {object} [options] environment, randomness, runtime reader, and logger seams
 * @returns {{attach: Function}} best-effort header writer; never changes a decision
 */
export function createGate1RestartProbe(options = {}) {
  const env = options.env ?? process.env;
  const randomBytesFunction = options.randomBytesFunction ?? randomBytes;
  const readRuntime = options.readRuntime ?? readProcessRuntime;
  const outcomeLogger = options.logger ?? logger;
  const reportedOutcomes = new Set();
  let contextInitialized = false;
  let contextId = null;

  /**
   * Emits only a fixed event/outcome for marked, explicitly enabled GETs.
   * The nonsecret marker is not authentication and never grants probe access.
   * At most 14 log attempts per factory/module lifetime, including logger failures;
   * no request, credential, response, runtime facts, or exception is passed along.
   * @param {boolean} marked whether this request opted into bounded diagnostic logs
   * @param {string} outcome locally defined result, never external error text
   * @returns {void} logging failure cannot affect the ordinary session response
   */
  function recordOutcome(marked, outcome) {
    if (!marked || !DIAGNOSTIC_OUTCOMES.has(outcome) || reportedOutcomes.has(outcome)) return;
    reportedOutcomes.add(outcome);
    try {
      outcomeLogger.info({ event: 'gate1_restart_probe_outcome', outcome },
        'GATE-1 restart probe diagnostic');
    } catch {
      // A failed log attempt stays latched and never becomes a response failure.
    }
  }

  /**
   * Adds bounded diagnostics to authenticated GETs on an enabled Vercel target.
   *
   * Why: observations must cover normal, rejected, and unavailable responses
   * without skipping the composed session route. Invalid credentials/config or
   * observation failures omit diagnostics and leave ordinary enforcement intact.
   *
   * @param {object} req original session request, never modified
   * @param {object} res response receiving private/no-store and one diagnostic header
   * @returns {void} bounded marked-request logging; no body or limiter changes
   */
  function attach(req, res) {
    let marked = false;
    try {
      if (env.GATE1_RESTART_PROBE_ENABLED !== 'true' || req.method !== 'GET') return;
      marked = req.headers?.[GATE1_RESTART_DIAGNOSTIC_HEADER] === '1';
      if (env.VERCEL !== '1'
        || (env.VERCEL_ENV !== 'preview' && env.VERCEL_ENV !== 'production')
        || env.NODE_ENV !== 'production') {
        recordOutcome(marked, 'environment_rejected');
        return;
      }
      if (res.headersSent === true || res.writableEnded === true || res.finished === true) {
        recordOutcome(marked, 'response_unavailable');
        return;
      }
      const authenticationFailure = probeAuthenticationFailure(req, env.GATE1_RESTART_PROBE_SECRET);
      if (authenticationFailure !== null) {
        recordOutcome(marked, authenticationFailure);
        return;
      }

      if (!contextInitialized) {
        contextInitialized = true;
        const bytes = randomBytesFunction(12);
        if (Buffer.isBuffer(bytes) && bytes.length === 12) contextId = bytes.toString('hex');
      }
      if (contextId === null) {
        recordOutcome(marked, 'context_unavailable');
        return;
      }

      const runtime = runtimeSchema.safeParse(readRuntime());
      if (!runtime.success) {
        recordOutcome(marked, 'runtime_invalid');
        return;
      }
      const value = JSON.stringify({
        schemaVersion: 1,
        contextScope: 'module',
        contextId,
        ...runtime.data,
      });
      res.setHeader('Cache-Control', PRIVATE_NO_STORE);
      res.setHeader(GATE1_RESTART_PROBE_HEADER, value);
      recordOutcome(marked, 'header_attached');
    } catch {
      // Probe failure never leaks diagnostic errors or changes session behavior.
      recordOutcome(marked, 'observation_failed');
    }
  }

  return { attach };
}

export const gate1RestartProbe = createGate1RestartProbe();
