import Stripe from 'stripe';
import { z } from 'zod';

export const STRIPE_API_VERSION = '2026-02-25.clover';
export const STRIPE_WEBHOOK_SECRET_ENV_VARS = Object.freeze({
  test: 'STRIPE_WEBHOOK_SECRET_TEST',
  live: 'STRIPE_WEBHOOK_SECRET_LIVE',
});

const STRIPE_SECRET_KEY_ENV_VAR = 'STRIPE_SECRET_KEY';
const STRIPE_SECRET_KEY_PREFIXES = ['sk_test_', 'sk_live_'];
const STRIPE_SECRET_KEY_MIN_LENGTH = 9;
const STRIPE_SECRET_KEY_MAX_LENGTH = 255;
const STRIPE_SECRET_KEY_FORMAT_PATTERN = /^sk_(test|live)_[A-Za-z0-9_]+$/;
const STRIPE_WEBHOOK_SECRET_PREFIX = 'whsec_';
const STRIPE_TIMEOUT_MS = 10_000;
const STRIPE_MAX_NETWORK_RETRIES = 2;

let cachedStripeConfig = null;
let cachedStripeConfigError = null;
let cachedStripeClient = null;
let cachedStripeClientError = null;

const StripeConfigSchema = z.object({
  [STRIPE_SECRET_KEY_ENV_VAR]: z.preprocess(
    normalizeStripeConfigValue,
    z.string({ error: `Invalid ${STRIPE_SECRET_KEY_ENV_VAR} environment variable` })
      .min(1, `Missing ${STRIPE_SECRET_KEY_ENV_VAR} environment variable`)
      .min(STRIPE_SECRET_KEY_MIN_LENGTH, `Invalid ${STRIPE_SECRET_KEY_ENV_VAR} environment variable`)
      .max(STRIPE_SECRET_KEY_MAX_LENGTH, `Invalid ${STRIPE_SECRET_KEY_ENV_VAR} environment variable`)
      .refine(
        (value) => hasAnyPrefix(value, STRIPE_SECRET_KEY_PREFIXES),
        `Invalid ${STRIPE_SECRET_KEY_ENV_VAR} environment variable`
      )
      .regex(
        STRIPE_SECRET_KEY_FORMAT_PATTERN,
        `Invalid ${STRIPE_SECRET_KEY_ENV_VAR} environment variable`
      )
  ),
}).strict();

/**
 * Build the shared Stripe runtime configuration error type.
 *
 * Purpose: keep secret-key validation failures stable for checkout, webhook,
 * and reconcile callers without coupling them to checkout-only config.
 *
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function createStripeConfigError(message) {
  const error = new Error(message);
  error.code = 'STRIPE_CONFIG_INVALID';
  return error;
}

/**
 * Convert schema failures into the Stripe runtime config error type.
 *
 * Purpose: lets all Stripe secret-key callers share Zod boundary validation
 * while preserving the existing error code contract used by routes and tests.
 *
 * @param {{ issues?: Array<{ message?: string }> }} error
 * @returns {Error & { code: string }}
 */
function createStripeConfigSchemaError(error) {
  const issueMessage = error?.issues?.[0]?.message;

  return createStripeConfigError(
    typeof issueMessage === 'string' && issueMessage
      ? issueMessage
      : `Invalid ${STRIPE_SECRET_KEY_ENV_VAR} environment variable`
  );
}

/**
 * Build the error used when webhook verification cannot be configured safely.
 *
 * Purpose: lets webhook middleware distinguish missing mode-specific secrets
 * from invalid request signatures and respond with 503.
 *
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function createWebhookConfigError(message) {
  const error = new Error(message);
  error.code = 'WEBHOOK_VERIFIER_NOT_CONFIGURED';
  return error;
}

/**
 * Normalize environment values before runtime validation.
 *
 * Purpose: treat missing, non-string, and whitespace-only values consistently
 * at the boundary where process.env is read.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeEnvValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize env input before Stripe config schema validation.
 *
 * Purpose: trim real env strings and report absent values as missing while
 * leaving non-string custom snapshots for the schema's type guard to reject.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function normalizeStripeConfigValue(value) {
  if (value === undefined) {
    return '';
  }

  return typeof value === 'string' ? normalizeEnvValue(value) : value;
}

/**
 * Check whether a value starts with one of the allowed prefixes.
 *
 * Purpose: keep Stripe key validation explicit without duplicating prefix
 * loops across runtime helpers.
 *
 * @param {string} value
 * @param {string[]} prefixes
 * @returns {boolean}
 */
function hasAnyPrefix(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

/**
 * Validate the Stripe runtime config read from an env snapshot.
 *
 * Purpose: keep runtime config resolution and webhook mode selection on the
 * same schema-backed boundary, returning only normalized validated values.
 *
 * @param {unknown} secretKeyValue
 * @returns {{ secretKey: string }}
 */
function parseStripeConfig(secretKeyValue) {
  const parsedConfig = StripeConfigSchema.safeParse({
    [STRIPE_SECRET_KEY_ENV_VAR]: secretKeyValue,
  });

  if (!parsedConfig.success) {
    throw createStripeConfigSchemaError(parsedConfig.error);
  }

  return {
    secretKey: parsedConfig.data[STRIPE_SECRET_KEY_ENV_VAR],
  };
}

/**
 * Infer whether the configured Stripe key targets test or live mode.
 *
 * Purpose: the billing service uses this single derived mode to separate live
 * and test webhook traffic, control logging policy, and choose the matching
 * webhook secret.
 *
 * @param {string} secretKey
 * @returns {'test' | 'live'}
 */
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

/**
 * Read and validate the server Stripe secret only when runtime code needs it.
 *
 * Purpose: local billing read imports must not crash because checkout-only
 * configuration is absent, while Stripe-touching paths still fail closed.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ secretKey: string, mode: 'test' | 'live' }}
 */
export function resolveStripeConfig(env = process.env) {
  const shouldUseCache = env === process.env;

  if (shouldUseCache && cachedStripeConfig) {
    return cachedStripeConfig;
  }

  if (shouldUseCache && cachedStripeConfigError) {
    throw cachedStripeConfigError;
  }

  try {
    const { secretKey } = parseStripeConfig(env?.[STRIPE_SECRET_KEY_ENV_VAR]);

    const stripeConfig = Object.freeze({
      secretKey,
      mode: inferStripeMode(secretKey),
    });

    if (shouldUseCache) {
      cachedStripeConfig = stripeConfig;
    }

    return stripeConfig;
  } catch (error) {
    if (shouldUseCache) {
      cachedStripeConfigError = error;
    }

    throw error;
  }
}

/**
 * Return the memoized server-wide Stripe mode derived from STRIPE_SECRET_KEY.
 *
 * Purpose: callers that only need mode separation should not instantiate a
 * Stripe client, and repeated calls should not re-read mutable process.env.
 *
 * @returns {'test' | 'live'}
 */
export function getConfiguredStripeMode() {
  return resolveStripeConfig().mode;
}

/**
 * Return the memoized Stripe SDK client for runtime Stripe API calls.
 *
 * Purpose: checkout, webhook verification, and reconcile flows share one
 * pinned client without forcing local-only billing reads to validate checkout
 * app URL or price configuration at import time.
 *
 * @returns {Stripe}
 */
export function getStripeClient() {
  if (cachedStripeClient) {
    return cachedStripeClient;
  }

  if (cachedStripeClientError) {
    throw cachedStripeClientError;
  }

  try {
    const { secretKey } = resolveStripeConfig();
    cachedStripeClient = new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION,
      timeout: STRIPE_TIMEOUT_MS,
      maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
    });
    return cachedStripeClient;
  } catch (error) {
    cachedStripeClientError = error;
    throw error;
  }
}

/**
 * Resolve the active Stripe webhook secret for the configured mode.
 *
 * Purpose: read webhook secrets dynamically on every call so operational secret
 * rotation can take effect without resetting the runtime module cache.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function getActiveStripeWebhookSecret(env = process.env) {
  const rawEnvSecretKey = env?.[STRIPE_SECRET_KEY_ENV_VAR];
  const shouldValidateEnvSecretKey = typeof rawEnvSecretKey === 'string'
    ? normalizeEnvValue(rawEnvSecretKey) !== ''
    : rawEnvSecretKey !== undefined;
  const mode = shouldValidateEnvSecretKey
    ? inferStripeMode(parseStripeConfig(rawEnvSecretKey).secretKey)
    : cachedStripeConfig?.mode ?? getConfiguredStripeMode();
  const envVarName = STRIPE_WEBHOOK_SECRET_ENV_VARS[mode];
  const secret = normalizeEnvValue(env?.[envVarName]);

  if (!secret) {
    throw createWebhookConfigError(`Missing ${envVarName} environment variable`);
  }

  if (!secret.startsWith(STRIPE_WEBHOOK_SECRET_PREFIX)) {
    throw createWebhookConfigError(`Invalid ${envVarName} environment variable`);
  }

  return secret;
}

/**
 * Reset memoized Stripe runtime state for isolated tests only.
 *
 * Purpose: tests mutate process.env heavily, so they need an explicit way to
 * clear cached successful config, cached clients, and cached error objects.
 * Security: this helper is exported only for Jest/runtime isolation and must
 * never be used by production code; the NODE_ENV guard below is intentional.
 *
 * @returns {void}
 */
export function __resetForTests() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__resetForTests() is only available in test environment');
  }

  cachedStripeConfig = null;
  cachedStripeConfigError = null;
  cachedStripeClient = null;
  cachedStripeClientError = null;
}
