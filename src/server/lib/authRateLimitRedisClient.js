import { Redis, errors } from '@upstash/redis';
import { parseTemporarySessionRedisSecret } from './temporarySessionSecrets.js';

// Only this private transport classification authorizes an EVAL fallback.
export const AUTH_RATE_LIMIT_NOSCRIPT = Symbol('auth_rate_limit_noscript');
export const AUTH_RATE_LIMIT_TIMEOUT_MS = 1500;

/**
 * Creates a fixed uncertainty error without retaining a provider message/cause.
 * @returns {Error} safe internal failure, with no input-derived fields
 */
export function authRateLimitUnavailableError() {
  return new Error('auth rate limit unavailable');
}

/**
 * Runs one lazy stage within the shared monotonic deadline and abort signal.
 * Checks before invocation and after resolution prevent late work from advancing.
 * @param {Function} start lazy operation, invoked at most once
 * @param {object} context signal, deadlineAt, and monotonic now function
 * @returns {Promise<unknown>} stage result; cleans its timer/listener on every exit
 */
export function withinAuthRateLimitDeadline(start, { signal, deadlineAt, now }) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    /** Completes this stage once and releases its timer/abort listener. */
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    }
    /** Rejects cancellation using a fixed error rather than a caller abort reason. */
    function abort() { finish(authRateLimitUnavailableError()); }
    /** Checks the shared deadline at every transition without starting late work. */
    function active() {
      const remaining = deadlineAt - now();
      return !signal.aborted && Number.isFinite(remaining) && remaining > 0
        && remaining <= AUTH_RATE_LIMIT_TIMEOUT_MS;
    }
    if (!active()) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, Math.ceil(deadlineAt - now()));
    Promise.resolve().then(() => {
      if (settled || !active()) throw authRateLimitUnavailableError();
      return start();
    }).then(
      (value) => finish(active() ? null : authRateLimitUnavailableError(), value),
      (error) => finish(active() ? error : authRateLimitUnavailableError())
    );
  });
}

/**
 * Builds a request-scoped client from the same validated pair used for HMAC.
 * SDK retry:false performs two fetches in the locked version; retries:0 does one.
 * No auto-pipeline/cache or generic-client configuration is inherited.
 * @param {object} runtimePair immutable configuration snapshot
 * @param {object} options request-owned AbortSignal
 * @returns {object} frozen sanitized evalsha/eval transport
 */
export function createAuthRateLimitRedisClient(runtimePair, { signal }) {
  try {
    const credentials = parseTemporarySessionRedisSecret(runtimePair?.redis);
    if (!(signal instanceof AbortSignal) || signal.aborted) throw new Error();
    const redis = new Redis({
      url: credentials.url,
      token: credentials.token,
      retry: { retries: 0 },
      enableAutoPipelining: false,
      automaticDeserialization: false,
      enableTelemetry: false,
      signal,
    });
    /** Executes one SDK command and strips all provider details at this boundary. */
    async function invoke(method, script, keys, args) {
      if (signal.aborted) throw authRateLimitUnavailableError();
      try {
        const result = await redis[method](script, keys, args);
        if (signal.aborted) throw authRateLimitUnavailableError();
        return result;
      } catch (error) {
        if (!signal.aborted && method === 'evalsha' && error instanceof errors.UpstashError
          && /^NOSCRIPT(?: |$)/.test(error.message)) throw AUTH_RATE_LIMIT_NOSCRIPT;
        throw authRateLimitUnavailableError();
      }
    }
    return Object.freeze({
      /** Invokes the cached script once; keys and args are internal only. */
      evalsha(script, keys, args) { return invoke('evalsha', script, keys, args); },
      /** Invokes the static fallback once after a definitely absent script. */
      eval(script, keys, args) { return invoke('eval', script, keys, args); },
    });
  } catch {
    throw authRateLimitUnavailableError();
  }
}
