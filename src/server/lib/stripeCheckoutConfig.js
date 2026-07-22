import {
  BILLING_PLANS,
  BILLING_PLAN_PRICE_ENV_VARS,
} from '../../shared/constants/billing.js';

const STRIPE_PRICE_ID_PREFIX = 'price_';
const MAX_PLAN_ERROR_LENGTH = 80;

/**
 * Create the shared configuration error type for Checkout price guards.
 *
 * Purpose: Checkout price resolution must fail closed at the point of use
 * without making unrelated route imports validate Checkout-only env vars.
 *
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function createCheckoutConfigError(message) {
  const error = new Error(message);
  error.code = 'STRIPE_CONFIG_INVALID';
  return error;
}

/**
 * Normalize Checkout configuration values read from env snapshots.
 *
 * Purpose: price id validation should treat whitespace-only and non-string
 * values consistently before checking Stripe id prefixes.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeCheckoutConfigValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Sanitize unsupported plan values before embedding them in error messages.
 *
 * Purpose: request-adjacent plan strings should never write control characters
 * or oversized values into operational errors.
 *
 * @param {unknown} plan
 * @returns {string}
 */
function sanitizePlanForError(plan) {
  let rawPlan;

  try {
    rawPlan = typeof plan === 'string' ? plan : String(plan);
  } catch {
    return '[unprintable]';
  }

  const sanitizedPlan = rawPlan
    .trim()
    // Control characters are deliberately stripped from log-adjacent error text.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_PLAN_ERROR_LENGTH);

  return sanitizedPlan || '[empty]';
}

/**
 * Read and validate the configured Stripe price id for one billing plan.
 *
 * Purpose: authorization stays on server-configured price ids rather than
 * mutable Stripe catalog metadata, and resolution happens only when Checkout is
 * actually being created.
 *
 * @param {string} plan
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function getPriceIdForPlan(plan, env = process.env) {
  const envVarName = BILLING_PLAN_PRICE_ENV_VARS[plan];

  if (!envVarName) {
    const sanitizedPlan = sanitizePlanForError(plan);
    const error = new Error(`Unsupported billing plan: ${sanitizedPlan}`);
    error.code = 'STRIPE_PLAN_INVALID';
    throw error;
  }

  const priceId = normalizeCheckoutConfigValue(env?.[envVarName]);

  if (!priceId) {
    throw createCheckoutConfigError(`Missing ${envVarName} environment variable`);
  }

  if (!priceId.startsWith(STRIPE_PRICE_ID_PREFIX)) {
    throw createCheckoutConfigError(`Invalid ${envVarName} environment variable`);
  }

  return priceId;
}

export { BILLING_PLANS };
