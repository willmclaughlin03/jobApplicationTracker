import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { safeUserSchema } from '../../shared/schemas/authV2.js';
import {
  authRateLimitOperationSchema, authRateLimitTierSchema, getAuthRateLimitPolicy,
} from './authRateLimitPolicy.js';
import { deriveAuthRateLimitIdentity } from './authRateLimitIdentity.js';
import {
  AUTH_RATE_LIMIT_TIMEOUT_MS, createAuthRateLimitRedisClient, withinAuthRateLimitDeadline,
} from './authRateLimitRedisClient.js';
import { executeAuthRateLimitRedisScript } from './authRateLimitRedisScript.js';
import { resolveTemporarySessionSource, resolveTemporarySessionSourceMode } from './temporarySessionSource.js';
import { getTemporarySessionRuntimePair, resolveTemporarySessionSecretMode } from './temporarySessionSecrets.js';

const inputSchema = z.object({
  operation: authRateLimitOperationSchema,
  tier: authRateLimitTierSchema,
  req: z.unknown().optional(),
  authenticatedUser: safeUserSchema.optional(),
  localCleanupAccepted: z.boolean().optional(),
}).strict();
const UNAVAILABLE = Object.freeze({ status: 'unavailable' });

/**
 * Creates an unused-by-routes evaluator with bounded, synthetic-test seams.
 * Callers must authenticate SafeUser themselves and accept logout cleanup first.
 * No response/cookie/provider mutation or logging occurs in this foundation.
 * @param {object} options environment/mode, dependency seams, monotonic clock and timeout
 * @returns {Function} evaluate(input, {signal}) returning only strict bounded results
 */
export function createAuthRateLimiter(options = {}) {
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? AUTH_RATE_LIMIT_TIMEOUT_MS;
  const getRuntimePair = options.getRuntimePair ?? getTemporarySessionRuntimePair;
  const createClient = options.createClient ?? createAuthRateLimitRedisClient;

  /**
   * Evaluates one operation under one total deadline, including configuration.
   * @param {unknown} input canonical operation/tier and trusted caller context
   * @param {object} execution optional caller AbortSignal, never its reason
   * @returns {Promise<object>} allowed, rate_limited, or unavailable
   */
  return async function evaluateAuthRateLimit(input, execution = {}) {
    let controller;
    let callerSignal;
    /** Propagates cancellation without carrying arbitrary caller reason data. */
    function cancel() { controller.abort(); }
    try {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AUTH_RATE_LIMIT_TIMEOUT_MS) {
        return UNAVAILABLE;
      }
      const deadlineAt = now() + timeoutMs;
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return UNAVAILABLE;
      const { operation, tier, req, authenticatedUser, localCleanupAccepted } = parsed.data;
      const policy = getAuthRateLimitPolicy(operation, tier);
      if (!policy || (operation === 'AUTH_LOGOUT' && localCleanupAccepted !== true)) return UNAVAILABLE;
      const sourceMode = resolveTemporarySessionSourceMode(options);
      const secretMode = resolveTemporarySessionSecretMode(options);
      if (!sourceMode || sourceMode !== secretMode) return UNAVAILABLE;
      const source = policy.identity === 'source' ? resolveTemporarySessionSource(req, sourceMode) : null;
      if ((policy.identity === 'source' && !source) || (policy.identity === 'user' && !authenticatedUser)) {
        return UNAVAILABLE;
      }
      const candidateSignal = execution.signal;
      if (candidateSignal !== undefined && !(candidateSignal instanceof AbortSignal)) return UNAVAILABLE;
      callerSignal = candidateSignal;
      controller = new AbortController();
      if (callerSignal?.aborted) return UNAVAILABLE;
      callerSignal?.addEventListener('abort', cancel, { once: true });
      const context = { signal: controller.signal, deadlineAt, now };
      const pair = await withinAuthRateLimitDeadline(getRuntimePair, context);
      const redisKey = deriveAuthRateLimitIdentity({ operation, source, authenticatedUser }, pair?.hmac);
      const redis = await withinAuthRateLimitDeadline(() => createClient(pair, context), context);
      return await executeAuthRateLimitRedisScript(redis, redisKey, operation, context);
    } catch {
      return UNAVAILABLE;
    } finally {
      callerSignal?.removeEventListener('abort', cancel);
      controller?.abort();
    }
  };
}

export const evaluateAuthRateLimit = createAuthRateLimiter();
