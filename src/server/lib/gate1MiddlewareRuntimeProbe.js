/**
 * Local Gate 1 candidate for observing execution inside Node.js middleware.
 *
 * Separately approved deployment configuration must set
 * GATE1_MIDDLEWARE_RUNTIME_PROBE_ENABLED=true and a dedicated
 * GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET of 64 lowercase hexadecimal characters.
 * Never reuse the restart, Deployment Protection or temporary-session secret.
 * Only an exact, query-free GET /login can supply the dedicated credential and
 * a fresh 32-character lowercase hexadecimal challenge in the headers below.
 *
 * Login continues through NextResponse.next; no auth, limiter or page is skipped.
 * Probe request headers are removed from the forwarded request. Observations
 * contain only a challenge, native version and Node 22 comparison, with all three
 * cache policies disabled. Nothing is logged, persisted or fetched here.
 * This does not qualify a deployment, historical metadata, manifests or Gate 1.
 * Web Headers cannot prove the original wire representation before normalization;
 * duplicate values joined with commas are rejected, not treated as singleton proof.
 */
import { timingSafeEqual } from 'node:crypto';
import nativeProcess from 'node:process';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PRIVATE_NO_STORE } from '../../shared/constants/authV2.js';

export const MIDDLEWARE_PROBE_KEY_HEADER = 'x-gate1-middleware-probe-key';
export const MIDDLEWARE_PROBE_CHALLENGE_HEADER = 'x-gate1-middleware-probe-challenge';
export const MIDDLEWARE_PROBE_RESPONSE_HEADER = 'x-gate1-middleware-runtime';

const secretSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const challengeSchema = z.string().length(32).regex(/^[a-f0-9]{32}$/);
const versionPattern = /^v(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/;
const runtimeSchema = z.object({
  version: z.string().max(13).regex(versionPattern),
  nodeVersion: z.string().max(11),
  releaseName: z.literal('node'),
}).strict().refine((runtime) => runtime.version.slice(1) === runtime.nodeVersion);
const RESERVED_HEADERS = [
  MIDDLEWARE_PROBE_KEY_HEADER,
  MIDDLEWARE_PROBE_CHALLENGE_HEADER,
  MIDDLEWARE_PROBE_RESPONSE_HEADER,
];

/**
 * Reads the native Node module during each authenticated request, not build config.
 * The version/release cross-check rejects unavailable or contradictory substitutes.
 * @returns {object} Bounded runtime inputs; validation precedes any disclosure.
 */
function readNativeRuntime() {
  return {
    version: nativeProcess.version,
    nodeVersion: nativeProcess.versions?.node,
    releaseName: nativeProcess.release?.name,
  };
}

/**
 * Restricts observation to the exact public login URL without query/data rewrites.
 * @param {object} req NextRequest whose raw URL and parsed path must agree.
 * @returns {boolean} False for malformed URLs, other methods and all other paths.
 */
function isProbeScope(req) {
  if (req?.method !== 'GET' || req.nextUrl?.pathname !== '/login'
      || req.nextUrl.search !== '') return false;
  const url = new URL(req.url);
  return url.pathname === '/login' && url.search === '' && url.hash === '';
}

/**
 * Creates an observer with synthetic seams for offline tests; default inputs are native.
 * @param {object} options Environment, runtime reader and NextResponse.next substitutes.
 * @returns {{handle: Function}} Login pass-through handler; no background work or I/O.
 */
export function createGate1MiddlewareRuntimeProbe(options = {}) {
  const env = options.env ?? nativeProcess.env;
  const readRuntime = options.readRuntime ?? readNativeRuntime;
  const next = options.next ?? NextResponse.next;

  /**
   * Returns a normal login continuation with sanitized request headers when marked.
   * Authentication failure or unavailable runtime emits no observation. A concrete
   * non-22 version is retained with node22=false, never converted into a pass.
   * @param {object} req Original NextRequest, never mutated or retained.
   * @returns {object|null} Pass-through response, or null for the ordinary caller path.
   */
  function handle(req) {
    let headers;
    try {
      if (!isProbeScope(req) || !RESERVED_HEADERS.some((name) => req.headers.has(name))) {
        return null;
      }
      headers = new Headers(req.headers);
    } catch {
      return null;
    }
    const credential = headers.get(MIDDLEWARE_PROBE_KEY_HEADER);
    const challenge = headers.get(MIDDLEWARE_PROBE_CHALLENGE_HEADER);
    RESERVED_HEADERS.forEach((name) => headers.delete(name));
    const response = next({ request: { headers } });
    // Set cache policy before the observation; missing evidence is never success.
    response.headers.set('Cache-Control', PRIVATE_NO_STORE);
    response.headers.set('CDN-Cache-Control', 'no-store');
    response.headers.set('Vercel-CDN-Cache-Control', 'no-store');
    response.headers.delete(MIDDLEWARE_PROBE_RESPONSE_HEADER);
    try {
      if (env.GATE1_MIDDLEWARE_RUNTIME_PROBE_ENABLED !== 'true'
          || env.NODE_ENV !== 'production' || env.VERCEL !== '1'
          || !['preview', 'production'].includes(env.VERCEL_ENV)
          || !secretSchema.safeParse(env.GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET).success
          || !secretSchema.safeParse(credential).success
          || !challengeSchema.safeParse(challenge).success) return response;
      if (!timingSafeEqual(Buffer.from(credential, 'hex'),
        Buffer.from(env.GATE1_MIDDLEWARE_RUNTIME_PROBE_SECRET, 'hex'))) return response;

      const runtime = runtimeSchema.safeParse(readRuntime());
      if (!runtime.success) return response;
      const nodeMajor = Number(runtime.data.version.slice(1).split('.')[0]);
      response.headers.set(MIDDLEWARE_PROBE_RESPONSE_HEADER, JSON.stringify({
        schemaVersion: 1,
        scope: 'middleware',
        challenge,
        nodeVersion: runtime.data.version,
        node22: nodeMajor === 22,
      }));
    } catch {
      // Never disclose runtime-reader errors, secrets or malformed observations.
      response.headers.delete(MIDDLEWARE_PROBE_RESPONSE_HEADER);
    }
    return response;
  }

  return { handle };
}

export const gate1MiddlewareRuntimeProbe = createGate1MiddlewareRuntimeProbe();
