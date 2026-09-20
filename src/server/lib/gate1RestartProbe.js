/**
 * Read-only runtime observations for the GATE-1 hosted restart investigation.
 *
 * Enable only on an approved preview with GATE1_RESTART_PROBE_ENABLED=true and
 * a separate GATE1_RESTART_PROBE_SECRET containing 64 lowercase hexadecimal
 * characters. A diagnostic GET supplies that secret as Authorization: Bearer.
 * Deployment Protection access is separate; neither credential bypasses the
 * session ceiling. Configuration and hosted requests require separate approval.
 *
 * The lazy module-context identifier is NOT a process/instance identifier or
 * proof of initialization time, termination, replacement, or Redis continuity.
 * No signal handlers, process controls, background work, or logging are added.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { z } from 'zod';
import { PRIVATE_NO_STORE } from '../../shared/constants/authV2.js';

export const GATE1_RESTART_PROBE_HEADER = 'X-Gate1-Restart-Probe';

const secretSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const authorizationSchema = z.string().length(71).regex(/^Bearer [a-f0-9]{64}$/);
const runtimeSchema = z.object({
  processUptimeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  nodeVersion: z.string().max(16).regex(/^v\d{1,3}\.\d{1,3}\.\d{1,3}$/),
  isMainThread: z.boolean(),
}).strict();
const MAX_RAW_HEADER_ENTRIES = 256;

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
 * @returns {boolean} whether exactly one valid credential matches in constant time
 */
function isAuthenticatedProbeRequest(req, secret) {
  const authorization = req.headers?.authorization;
  if (!secretSchema.safeParse(secret).success
    || !authorizationSchema.safeParse(authorization).success) return false;

  const raw = req.rawHeaders;
  if (!Array.isArray(raw) || raw.length % 2 !== 0
    || raw.length > MAX_RAW_HEADER_ENTRIES) return false;

  let occurrences = 0;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index];
    if (typeof name !== 'string' || name.length > 128) return false;
    if (name.toLowerCase() === 'authorization') {
      occurrences += 1;
      if (occurrences > 1 || raw[index + 1] !== authorization) return false;
    }
  }
  return occurrences === 1 && timingSafeEqual(
    Buffer.from(authorization.slice(7), 'hex'),
    Buffer.from(secret, 'hex')
  );
}

/**
 * Creates an isolated, lazy observational probe used by the v1 route wrapper.
 *
 * @param {object} [options] environment, randomness, and runtime reader test seams
 * @returns {{attach: Function}} best-effort header writer; never changes a decision
 */
export function createGate1RestartProbe(options = {}) {
  const env = options.env ?? process.env;
  const randomBytesFunction = options.randomBytesFunction ?? randomBytes;
  const readRuntime = options.readRuntime ?? readProcessRuntime;
  let contextInitialized = false;
  let contextId = null;

  /**
   * Adds bounded diagnostics only to authenticated GETs in an enabled preview.
   *
   * Why: observations must cover normal, rejected, and unavailable responses
   * without skipping the composed session route. Invalid credentials/config or
   * observation failures omit diagnostics and leave ordinary enforcement intact.
   *
   * @param {object} req original session request, never modified
   * @param {object} res response receiving private/no-store and one diagnostic header
   * @returns {void} no response body, logging, credentials, or limiter side effects
   */
  function attach(req, res) {
    try {
      if (env.VERCEL !== '1' || env.VERCEL_ENV !== 'preview'
        || env.NODE_ENV !== 'production' || env.GATE1_RESTART_PROBE_ENABLED !== 'true'
        || req.method !== 'GET' || res.headersSent === true
        || res.writableEnded === true || res.finished === true) return;
      if (!isAuthenticatedProbeRequest(req, env.GATE1_RESTART_PROBE_SECRET)) return;

      if (!contextInitialized) {
        contextInitialized = true;
        const bytes = randomBytesFunction(12);
        if (Buffer.isBuffer(bytes) && bytes.length === 12) contextId = bytes.toString('hex');
      }
      if (contextId === null) return;

      const runtime = runtimeSchema.safeParse(readRuntime());
      if (!runtime.success) return;
      const value = JSON.stringify({
        schemaVersion: 1,
        contextScope: 'module',
        contextId,
        ...runtime.data,
      });
      res.setHeader('Cache-Control', PRIVATE_NO_STORE);
      res.setHeader(GATE1_RESTART_PROBE_HEADER, value);
    } catch {
      // Probe failure never leaks diagnostic errors or changes session behavior.
    }
  }

  return { attach };
}

export const gate1RestartProbe = createGate1RestartProbe();
