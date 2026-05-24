const STRIPE_BILLING_PORTAL_CONFIGURATION_ENV_VAR = 'STRIPE_BILLING_PORTAL_CONFIGURATION_ID';
const STRIPE_BILLING_PORTAL_CONFIGURATION_PREFIX = 'bpc_';

/**
 * Create the shared configuration error type for Customer Portal guards.
 *
 * Purpose: portal creation should fail closed when the audited configuration id
 * is missing without coupling portal imports to Checkout price config.
 *
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function createPortalConfigError(message) {
  const error = new Error(message);
  error.code = 'STRIPE_CONFIG_INVALID';
  return error;
}

/**
 * Normalize Customer Portal configuration values read from env snapshots.
 *
 * Purpose: missing, whitespace-only, and non-string config values should share
 * one fail-closed path before Stripe portal sessions are created.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizePortalConfigValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve the audited Stripe Customer Portal configuration id.
 *
 * Purpose: portal behavior must be pinned in code through a reviewed
 * configuration id instead of drifting with Stripe's default portal settings.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function getBillingPortalConfigurationId(env = process.env) {
  const configurationId = normalizePortalConfigValue(
    env?.[STRIPE_BILLING_PORTAL_CONFIGURATION_ENV_VAR]
  );

  if (!configurationId) {
    throw createPortalConfigError(
      `Missing ${STRIPE_BILLING_PORTAL_CONFIGURATION_ENV_VAR} environment variable`
    );
  }

  if (!configurationId.startsWith(STRIPE_BILLING_PORTAL_CONFIGURATION_PREFIX)) {
    throw createPortalConfigError(
      `Invalid ${STRIPE_BILLING_PORTAL_CONFIGURATION_ENV_VAR} environment variable`
    );
  }

  return configurationId;
}
