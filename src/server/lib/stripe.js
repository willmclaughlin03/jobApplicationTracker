import {
  BILLING_PLANS,
  BILLING_PLAN_PRICE_ENV_VARS,
} from '../../shared/constants/billing.js';
import {
  STRIPE_API_VERSION,
  STRIPE_WEBHOOK_SECRET_ENV_VARS,
  getActiveStripeWebhookSecret,
  getConfiguredStripeMode,
  getStripeClient,
  inferStripeMode,
} from './stripeRuntime.js';

const APP_ORIGIN_ENV_VAR = 'NEXT_PUBLIC_APP_URL';
const STRIPE_PRICE_ID_PREFIX = 'price_';
const MAX_PLAN_ERROR_LENGTH = 80;
const LOCAL_DEVELOPMENT_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

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

/**
 * Read and validate one required Stripe-related environment variable.
 *
 * Purpose: centralize startup-time config guarding so the module fails closed
 * before any route attempts checkout or portal work with partial
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

const appOrigin = validateAppOrigin(process.env[APP_ORIGIN_ENV_VAR]);

const priceIdByPlan = Object.freeze(
  Object.fromEntries(
    Object.entries(BILLING_PLAN_PRICE_ENV_VARS).map(([plan, envVarName]) => [
      plan,
      requireStripeEnv(envVarName, (value) => value.startsWith(STRIPE_PRICE_ID_PREFIX)),
    ])
  )
);

export const STRIPE_MODE = getConfiguredStripeMode();
export const stripe = getStripeClient();

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

export { BILLING_PLANS };
export {
  STRIPE_API_VERSION,
  STRIPE_WEBHOOK_SECRET_ENV_VARS,
  getActiveStripeWebhookSecret,
  getConfiguredStripeMode,
  inferStripeMode,
};
