import { z } from 'zod';

export const AUTH_RATE_LIMIT_OPERATIONS = Object.freeze([
  'AUTH_SESSION', 'AUTH_LOGOUT', 'AUTH_FAILURE', 'AUTH_CALLBACK', 'PRE_AUTH',
]);
export const AUTH_RATE_LIMIT_TIERS = Object.freeze(['free', 'paid', 'admin']);
export const authRateLimitOperationSchema = z.enum(AUTH_RATE_LIMIT_OPERATIONS);
export const authRateLimitTierSchema = z.enum(AUTH_RATE_LIMIT_TIERS);

const policies = Object.freeze({
  AUTH_SESSION: Object.freeze({ identity: 'user', hourly: 300, daily: 2500 }),
  AUTH_LOGOUT: Object.freeze({ identity: 'source', hourly: 30, daily: 100 }),
  AUTH_FAILURE: Object.freeze({ identity: 'source', hourly: 15, daily: 30 }),
  AUTH_CALLBACK: Object.freeze({ identity: 'source', hourly: 30, daily: 100 }),
  PRE_AUTH: Object.freeze({ identity: 'source', hourly: 3000, daily: 30000 }),
});

// Every supported tier explicitly receives the same provisional auth quotas.
export const AUTH_RATE_LIMIT_POLICIES = Object.freeze({
  free: policies,
  paid: policies,
  admin: policies,
});

/**
 * Selects an explicit bounded auth policy; unknown tier/operation never bypasses.
 * @param {unknown} operation canonical operation
 * @param {unknown} tier explicit application tier
 * @returns {Readonly<object>|null} immutable policy without side effects
 */
export function getAuthRateLimitPolicy(operation, tier) {
  if (!authRateLimitOperationSchema.safeParse(operation).success
    || !authRateLimitTierSchema.safeParse(tier).success) return null;
  return AUTH_RATE_LIMIT_POLICIES[tier][operation];
}
