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
const APP_ORIGIN_ENV_VAR = 'NEXT_PUBLIC_APP_URL';
const STRIPE_SECRET_KEY_PREFIXES = ['sk_test_', 'sk_live_'];
const STRIPE_PRICE_ID_PREFIX = 'price_';
const STRIPE_WEBHOOK_SECRET_PREFIX = 'whsec_';
const MAX_PLAN_ERROR_LENGTH = 80;
const LOCAL_DEVELOPMENT_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const STRIPE_TIMEOUT_MS = 10_000;
const STRIPE_MAX_NETWORK_RETRIES = 2;

/**
 * Create the shared configuration error type for startup-time Stripe guards.
 *
 * Purpose: keep environment and origin validation failures distinguishable from
 * runtime provider errors so routes can fail early and clearly when billing is
 * misconfigured.
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
 * Create the error used when webhook verification cannot be configured safely.
 *
 * Purpose: let webhook middleware distinguish missing secrets from invalid
 * request signatures and respond with 503 instead of 400 in that case.
 *
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function createWebhookConfigError(message) {
  const error = new Error(message);
  error.code = 'WEBHOOK_VERIFIER_NOT_CONFIGURED';
  return error;
}

function normalizeEnvValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizePlanForError(plan) {
  let rawPlan;

  try {
    rawPlan = typeof plan === 'string' ? plan : String(plan);
  } catch {
    return '[unprintable]';
  }

  const sanitizedPlan = rawPlan
    .trim()
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_PLAN_ERROR_LENGTH);

  return sanitizedPlan || '[empty]';
}

function hasAnyPrefix(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

/**
 * Read and validate one required Stripe-related environment variable.
 *
 * Purpose: centralize startup-time config guarding so the module fails closed
 * before any route attempts checkout, portal, or webhook work with partial
 * configuration.
 *
 * @param {string} envVarName
 * @param {(value: string) => boolean} [validateValue]
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
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

/**
 * Validate the server-configured app origin used to build Stripe redirect URLs.
 *
 * Purpose: Keep checkout and billing-portal return URLs pinned to one trusted
 * deployment origin that is validated at startup instead of being inferred per
 * request from proxy or host headers.
 *
 * Tradeoff: This intentionally accepts origins only, not subpath-based app
 * bases such as `https://example.com/app`. If the product later deploys under
 * a subpath, this validator must be redesigned deliberately rather than
 * silently widening redirect behavior.
 *
 * @param {unknown} rawOrigin
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function validateAppOrigin(rawOrigin, env = process.env) {
  const normalizedOrigin = normalizeEnvValue(rawOrigin);

  if (!normalizedOrigin) {
    throw createStripeConfigError(`Missing ${APP_ORIGIN_ENV_VAR} environment variable`);
  }

  let parsedOrigin;

  try {
    parsedOrigin = new URL(normalizedOrigin);
  } catch {
    throw createStripeConfigError(`Invalid ${APP_ORIGIN_ENV_VAR} environment variable`);
  }

  if (
    parsedOrigin.pathname !== '/'
    || parsedOrigin.search
    || parsedOrigin.hash
    || parsedOrigin.username
    || parsedOrigin.password
    || !parsedOrigin.hostname
  ) {
    throw createStripeConfigError(`Invalid ${APP_ORIGIN_ENV_VAR} environment variable`);
  }

  const isProduction = env?.NODE_ENV === 'production';
  const protocol = parsedOrigin.protocol;
  const isLocalDevelopmentOrigin = LOCAL_DEVELOPMENT_HOSTNAMES.has(parsedOrigin.hostname);

  if (protocol === 'https:') {
    return parsedOrigin.origin;
  }

  if (!isProduction && protocol === 'http:' && isLocalDevelopmentOrigin) {
    return parsedOrigin.origin;
  }

  throw createStripeConfigError(`Invalid ${APP_ORIGIN_ENV_VAR} environment variable`);
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

const stripeSecretKey = requireStripeEnv(
  STRIPE_SECRET_KEY_ENV_VAR,
  (value) => hasAnyPrefix(value, STRIPE_SECRET_KEY_PREFIXES)
);
const appOrigin = validateAppOrigin(process.env[APP_ORIGIN_ENV_VAR]);

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
  timeout: STRIPE_TIMEOUT_MS,
  maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
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

  const sanitizedPlan = sanitizePlanForError(plan);
  const error = new Error(`Unsupported billing plan: ${sanitizedPlan}`);
  error.code = 'STRIPE_PLAN_INVALID';
  throw error;
}

/**
 * Return the server-wide Stripe mode derived at module initialization.
 *
 * Purpose: downstream billing helpers should rely on the same validated mode
 * rather than re-inferring it from request data or environment variables.
 *
 * @returns {'test' | 'live'}
 */
export function getConfiguredStripeMode() {
  return STRIPE_MODE;
}

/**
 * Return the validated app origin used for Stripe redirect URLs.
 *
 * @returns {string}
 */
export function getAppOrigin() {
  return appOrigin;
}

/**
 * Build an absolute app URL rooted at the validated deployment origin.
 *
 * Purpose: checkout and portal flows must never trust request host headers when
 * constructing return URLs, so this helper pins all redirect construction to
 * the startup-validated app origin.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function buildAppUrl(pathname) {
  const normalizedPathname = normalizeEnvValue(pathname);

  if (
    !normalizedPathname
    || !normalizedPathname.startsWith('/')
    || normalizedPathname.startsWith('//')
  ) {
    throw createStripeConfigError('Invalid app pathname');
  }

  const url = new URL(normalizedPathname, `${appOrigin}/`);

  if (url.origin !== appOrigin) {
    throw createStripeConfigError('Invalid app pathname');
  }

  return url.toString();
}

/**
 * Resolve the active Stripe webhook secret for the configured mode.
 *
 * Purpose: webhook verification must fail closed if the mode-specific secret is
 * missing or malformed rather than accidentally verifying test traffic against
 * live configuration or vice versa.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
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
