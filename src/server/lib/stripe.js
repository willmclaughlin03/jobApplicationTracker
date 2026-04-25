import Stripe from 'stripe';
import {
  BILLING_PLANS,
  BILLING_PLAN_PRICE_ENV_VARS,
} from '../../shared/constants/billing.js';

export const STRIPE_API_VERSION = '2026-02-25.clover';
export const STRIPE_WEBHOOK_SECRET_ENV_VARS = Object.freeze({
  test: 'STRIPE_WEBHOOK_SECRET_TEST',
  live: 'STRIPE_WEBHOOK_SECRET_LIVE',
});

const STRIPE_SECRET_KEY_ENV_VAR = 'STRIPE_SECRET_KEY';
const STRIPE_SECRET_KEY_PREFIXES = ['sk_test_', 'sk_live_'];
const STRIPE_PRICE_ID_PREFIX = 'price_';
const STRIPE_WEBHOOK_SECRET_PREFIX = 'whsec_';

function createStripeConfigError(message) {
  const error = new Error(message);
  error.code = 'STRIPE_CONFIG_INVALID';
  return error;
}

function createWebhookConfigError(message) {
  const error = new Error(message);
  error.code = 'WEBHOOK_VERIFIER_NOT_CONFIGURED';
  return error;
}

function normalizeEnvValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasAnyPrefix(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function requireStripeEnv(envVarName, validateValue, env = process.env) {
  const value = normalizeEnvValue(env?.[envVarName]);

  if (!value) {
    throw createStripeConfigError(`Missing ${envVarName} environment variable`);
  }

  if (typeof validateValue === 'function' && !validateValue(value)) {
    throw createStripeConfigError(`Invalid ${envVarName} environment variable`);
  }

  return value;
}

export function inferStripeMode(secretKey) {
  if (typeof secretKey !== 'string') {
    throw createStripeConfigError('Invalid STRIPE_SECRET_KEY environment variable');
  }

  if (secretKey.startsWith('sk_live_')) {
    return 'live';
  }

  if (secretKey.startsWith('sk_test_')) {
    return 'test';
  }

  throw createStripeConfigError('Invalid STRIPE_SECRET_KEY environment variable');
}

const stripeSecretKey = requireStripeEnv(
  STRIPE_SECRET_KEY_ENV_VAR,
  (value) => hasAnyPrefix(value, STRIPE_SECRET_KEY_PREFIXES)
);

const priceIdByPlan = Object.freeze(
  Object.fromEntries(
    Object.entries(BILLING_PLAN_PRICE_ENV_VARS).map(([plan, envVarName]) => [
      plan,
      requireStripeEnv(envVarName, (value) => value.startsWith(STRIPE_PRICE_ID_PREFIX)),
    ])
  )
);

export const STRIPE_MODE = inferStripeMode(stripeSecretKey);

export const stripe = new Stripe(stripeSecretKey, {
  apiVersion: STRIPE_API_VERSION,
});

/**
 * Resolve the single allowlisted Stripe price id for a known billing plan.
 *
 * Authorization stays on server-configured price ids rather than mutable
 * Stripe catalog metadata such as product names.
 *
 * @param {string} plan
 * @returns {string}
 */
export function getPriceIdForPlan(plan) {
  const priceId = priceIdByPlan[plan];

  if (priceId) {
    return priceId;
  }

  const error = new Error(`Unsupported billing plan: ${plan}`);
  error.code = 'STRIPE_PLAN_INVALID';
  throw error;
}

export function getConfiguredStripeMode() {
  return STRIPE_MODE;
}

export function getActiveStripeWebhookSecret(env = process.env) {
  const envVarName = STRIPE_WEBHOOK_SECRET_ENV_VARS[STRIPE_MODE];
  const secret = normalizeEnvValue(env?.[envVarName]);

  if (!secret) {
    throw createWebhookConfigError(`Missing ${envVarName} environment variable`);
  }

  if (!secret.startsWith(STRIPE_WEBHOOK_SECRET_PREFIX)) {
    throw createWebhookConfigError(`Invalid ${envVarName} environment variable`);
  }

  return secret;
}

export { BILLING_PLANS };
