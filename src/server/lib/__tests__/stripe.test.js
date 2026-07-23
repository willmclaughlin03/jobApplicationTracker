const STRIPE_ENV_VARS = [
  'NEXT_PUBLIC_APP_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_PRICE_PREMIUM_MONTHLY',
  'STRIPE_BILLING_PORTAL_CONFIGURATION_ID',
  'STRIPE_WEBHOOK_SECRET_TEST',
  'STRIPE_WEBHOOK_SECRET_LIVE',
];

const ORIGINAL_ENV = Object.fromEntries(
  STRIPE_ENV_VARS.map((envVarName) => [envVarName, process.env[envVarName]])
);

/**
 * Clear Stripe-related env vars so each config test starts from a known baseline.
 * Uses STRIPE_ENV_VARS and mutates process.env for isolated stripe.js loads.
 */
function resetStripeEnv() {
  for (const envVarName of STRIPE_ENV_VARS) {
    delete process.env[envVarName];
  }
}

/**
 * Restore the Stripe env snapshot captured before the tests changed process.env.
 * Uses ORIGINAL_ENV after resetStripeEnv so later tests inherit the original state.
 */
function restoreStripeEnv() {
  resetStripeEnv();

  for (const [envVarName, value] of Object.entries(ORIGINAL_ENV)) {
    if (value !== undefined) {
      process.env[envVarName] = value;
    }
  }
}

/**
 * Seed the minimal valid Stripe config needed by happy-path module tests.
 * Mutates process.env keys consumed by ../stripe.js and related runtime helpers.
 */
function setValidTestEnv() {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
  process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
  process.env.STRIPE_PRICE_PREMIUM_MONTHLY = 'price_premium_monthly';
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = 'bpc_test_chunk2';
  process.env.STRIPE_WEBHOOK_SECRET_TEST = 'whsec_test_chunk2';
}

/**
 * Load a fresh Stripe config module instance for isolated tests.
 * Calls jest.resetModules() before requiring ../stripe.js so env changes are observed.
 */
function loadStripeModule() {
  jest.resetModules();
  return require('../stripe.js');
}

/**
 * Load a fresh Stripe runtime module instance for isolated tests.
 *
 * Purpose: resets Jest's module registry before loading runtime-only Stripe
 * exports so each caller observes a clean module cache.
 * Params/returns: takes no params and returns the required module exports.
 * Side effects/connections: calls jest.resetModules() and requires
 * ../stripeRuntime.js, which affects Jest's module cache.
 *
 * @returns {typeof import('../stripeRuntime.js')}
 */
function loadStripeRuntimeModule() {
  jest.resetModules();
  return require('../stripeRuntime.js');
}

describe('stripe runtime foundation', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    resetStripeEnv();
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    restoreStripeEnv();
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
      return;
    }

    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns the allowlisted Stripe price id for the supported billing plan', () => {
    setValidTestEnv();

    const {
      BILLING_PLANS,
      STRIPE_API_VERSION,
      buildAppUrl,
      getBillingPortalConfigurationId,
      getAppOrigin,
      getConfiguredStripeMode,
      getPriceIdForPlan,
      getStripeClient,
    } = loadStripeModule();

    expect(STRIPE_API_VERSION).toBe('2026-04-22.dahlia');
    expect(getConfiguredStripeMode()).toBe('test');
    expect(getAppOrigin()).toBe('https://app.example.test');
    expect(buildAppUrl('/billing/success')).toBe('https://app.example.test/billing/success');
    expect(getPriceIdForPlan(BILLING_PLANS.PREMIUM_MONTHLY)).toBe('price_premium_monthly');
    expect(getBillingPortalConfigurationId()).toBe('bpc_test_chunk2');
    const stripe = getStripeClient();
    expect(stripe.getApiField('timeout')).toBe(10000);
    expect(stripe.getApiField('maxNetworkRetries')).toBe(2);
    expect(typeof stripe.webhooks.constructEvent).toBe('function');
  });

  it('rejects unknown billing plans', () => {
    setValidTestEnv();

    const { getPriceIdForPlan } = loadStripeModule();

    expect(() => getPriceIdForPlan('unknown_plan')).toThrow(/unsupported billing plan/i);
  });

  it('sanitizes unsupported billing plans before embedding them in an error message', () => {
    setValidTestEnv();

    const { getPriceIdForPlan } = loadStripeModule();
    const unsafePlan = `  unknown_plan\r\n\t${'x'.repeat(120)}  `;

    try {
      getPriceIdForPlan(unsafePlan);
      throw new Error('Expected getPriceIdForPlan to reject an unsupported plan');
    } catch (error) {
      expect(error.code).toBe('STRIPE_PLAN_INVALID');
      expect(error.message).toContain('Unsupported billing plan: unknown_plan');
      expect(error.message).not.toContain('\r');
      expect(error.message).not.toContain('\n');
      expect(error.message).not.toContain('\t');
      expect(error.message.length).toBeLessThanOrEqual(
        'Unsupported billing plan: '.length + 80
      );
    }
  });

  it('labels control-character-only unsupported billing plans as empty', () => {
    setValidTestEnv();

    const { getPriceIdForPlan } = loadStripeModule();

    expect(() => getPriceIdForPlan('\u0000\u007F\u009F'))
      .toThrow('Unsupported billing plan: [empty]');
  });

  it('does not validate runtime secrets when the Stripe barrel is only imported', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
    process.env.STRIPE_PRICE_PREMIUM_MONTHLY = 'price_premium_monthly';

    const { getConfiguredStripeMode } = loadStripeModule();

    expect(() => getConfiguredStripeMode()).toThrow(/missing STRIPE_SECRET_KEY/i);
  });

  it('fails closed when the allowlisted price id env var is missing at call time', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';

    const { BILLING_PLANS, getPriceIdForPlan } = loadStripeModule();

    expect(() => getPriceIdForPlan(BILLING_PLANS.PREMIUM_MONTHLY))
      .toThrow(/missing STRIPE_PRICE_PREMIUM_MONTHLY/i);
  });

  it('fails closed when STRIPE_SECRET_KEY is malformed at runtime call time', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
    process.env.STRIPE_SECRET_KEY = 'pk_test_not_a_secret';
    process.env.STRIPE_PRICE_PREMIUM_MONTHLY = 'price_premium_monthly';

    const { getConfiguredStripeMode } = loadStripeModule();

    expect(() => getConfiguredStripeMode()).toThrow(/invalid STRIPE_SECRET_KEY/i);
  });

  it('fails closed when NEXT_PUBLIC_APP_URL is missing at app-url call time', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
    process.env.STRIPE_PRICE_PREMIUM_MONTHLY = 'price_premium_monthly';

    const { getAppOrigin } = loadStripeModule();

    expect(() => getAppOrigin()).toThrow(/missing NEXT_PUBLIC_APP_URL/i);
  });

  it('rejects non-origin NEXT_PUBLIC_APP_URL values', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test/billing';
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
    process.env.STRIPE_PRICE_PREMIUM_MONTHLY = 'price_premium_monthly';

    const { getAppOrigin } = loadStripeModule();

    expect(() => getAppOrigin()).toThrow(/invalid NEXT_PUBLIC_APP_URL/i);
  });

  it('rejects NEXT_PUBLIC_APP_URL values with embedded credentials', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://user:pass@app.example.test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
    process.env.STRIPE_PRICE_PREMIUM_MONTHLY = 'price_premium_monthly';

    const { getAppOrigin } = loadStripeModule();

    expect(() => getAppOrigin()).toThrow(/invalid NEXT_PUBLIC_APP_URL/i);
  });

  it('rejects insecure non-local development origins outside production', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://staging.example.test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
    process.env.STRIPE_PRICE_PREMIUM_MONTHLY = 'price_premium_monthly';

    const { getAppOrigin } = loadStripeModule();

    expect(() => getAppOrigin()).toThrow(/invalid NEXT_PUBLIC_APP_URL/i);
  });

  it('allows localhost http origins outside production', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
    process.env.STRIPE_PRICE_PREMIUM_MONTHLY = 'price_premium_monthly';
    process.env.STRIPE_WEBHOOK_SECRET_TEST = 'whsec_test_chunk2';

    const { getAppOrigin } = loadStripeModule();

    expect(getAppOrigin()).toBe('http://localhost:3000');
  });

  it('rejects non-app-relative pathnames when building app URLs', () => {
    setValidTestEnv();

    const { buildAppUrl } = loadStripeModule();

    expect(() => buildAppUrl('billing')).toThrow(/invalid app pathname/i);
    expect(() => buildAppUrl('//evil.example/path')).toThrow(/invalid app pathname/i);
    expect(() => buildAppUrl('https://evil.example/path')).toThrow(/invalid app pathname/i);
  });

  it('requires https origins in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    process.env.STRIPE_SECRET_KEY = 'sk_live_chunk2';
    process.env.STRIPE_PRICE_PREMIUM_MONTHLY = 'price_premium_monthly';

    const { getAppOrigin } = loadStripeModule();

    expect(() => getAppOrigin()).toThrow(/invalid NEXT_PUBLIC_APP_URL/i);
  });

  it('fails closed when the pinned portal configuration id is missing', () => {
    setValidTestEnv();
    delete process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID;

    const { getBillingPortalConfigurationId } = loadStripeModule();

    expect(() => getBillingPortalConfigurationId())
      .toThrow(/missing STRIPE_BILLING_PORTAL_CONFIGURATION_ID/i);
  });

  it('fails closed when the pinned portal configuration id is malformed', () => {
    setValidTestEnv();
    process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = 'pc_bad';

    const { getBillingPortalConfigurationId } = loadStripeModule();

    expect(() => getBillingPortalConfigurationId())
      .toThrow(/invalid STRIPE_BILLING_PORTAL_CONFIGURATION_ID/i);
  });

  it('returns the active webhook secret for test mode', () => {
    setValidTestEnv();

    const { getActiveStripeWebhookSecret } = loadStripeModule();

    expect(getActiveStripeWebhookSecret()).toBe('whsec_test_chunk2');
  });

  it('returns the active webhook secret for live mode', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
    process.env.STRIPE_SECRET_KEY = 'sk_live_chunk2';
    process.env.STRIPE_PRICE_PREMIUM_MONTHLY = 'price_premium_monthly';
    process.env.STRIPE_WEBHOOK_SECRET_LIVE = 'whsec_live_chunk2';

    const { getConfiguredStripeMode, getActiveStripeWebhookSecret } = loadStripeModule();

    expect(getConfiguredStripeMode()).toBe('live');
    expect(getActiveStripeWebhookSecret()).toBe('whsec_live_chunk2');
  });

  it('fails closed when the active webhook secret is missing', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
    process.env.STRIPE_PRICE_PREMIUM_MONTHLY = 'price_premium_monthly';

    const { getActiveStripeWebhookSecret } = loadStripeModule();

    try {
      getActiveStripeWebhookSecret();
      throw new Error('Expected webhook secret lookup to fail closed');
    } catch (error) {
      expect(error.name).toBe('WebhookVerifierNotConfiguredError');
      expect(error.code).toBe('WEBHOOK_VERIFIER_NOT_CONFIGURED');
      expect(error.statusCode).toBe(503);
    }
  });
});

describe('stripe runtime narrow module', () => {
  beforeEach(() => {
    resetStripeEnv();
  });

  afterAll(() => {
    restoreStripeEnv();
  });

  it('memoizes the configured Stripe mode after the first successful resolution', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_runtime_mode';

    const { getConfiguredStripeMode } = loadStripeRuntimeModule();

    expect(getConfiguredStripeMode()).toBe('test');

    process.env.STRIPE_SECRET_KEY = 'sk_live_runtime_mode';

    expect(getConfiguredStripeMode()).toBe('test');
  });

  it('does not cache successful custom env snapshot resolutions', () => {
    const runtime = loadStripeRuntimeModule();

    expect(runtime.resolveStripeConfig({
      STRIPE_SECRET_KEY: '  sk_live_custom_snapshot  ',
    })).toEqual({
      secretKey: 'sk_live_custom_snapshot',
      mode: 'live',
    });

    process.env.STRIPE_SECRET_KEY = 'sk_test_process_snapshot';

    expect(runtime.getConfiguredStripeMode()).toBe('test');
  });

  it('rejects schema-invalid custom env snapshots without caching them', () => {
    const runtime = loadStripeRuntimeModule();
    const tooLongSecretKey = `sk_test_${'a'.repeat(248)}`;
    const invalidSecretKeys = [
      123,
      'sk_test_',
      'sk_test_bad-key',
      tooLongSecretKey,
    ];

    for (const secretKey of invalidSecretKeys) {
      expect(() => runtime.resolveStripeConfig({
        STRIPE_SECRET_KEY: secretKey,
      })).toThrow(/invalid STRIPE_SECRET_KEY/i);
    }

    process.env.STRIPE_SECRET_KEY = 'sk_test_process_after_schema_errors';

    expect(runtime.getConfiguredStripeMode()).toBe('test');
  });

  it('does not cache custom env snapshot validation errors', () => {
    const runtime = loadStripeRuntimeModule();

    expect(() => runtime.resolveStripeConfig({})).toThrow(/missing STRIPE_SECRET_KEY/i);

    process.env.STRIPE_SECRET_KEY = 'sk_live_process_after_custom_error';

    expect(runtime.getConfiguredStripeMode()).toBe('live');
  });

  it('rethrows the same missing-key error reference until reset', () => {
    const runtime = loadStripeRuntimeModule();
    let firstError;
    let secondError;

    try {
      runtime.getConfiguredStripeMode();
    } catch (error) {
      firstError = error;
    }

    try {
      runtime.getConfiguredStripeMode();
    } catch (error) {
      secondError = error;
    }

    expect(firstError).toBeDefined();
    expect(secondError).toBe(firstError);
    expect(firstError.name).toBe('StripeConfigError');
    expect(firstError.code).toBe('STRIPE_CONFIG_INVALID');
    expect(firstError.statusCode).toBe(400);
    expect(firstError.message).toMatch(/missing STRIPE_SECRET_KEY/i);

    process.env.STRIPE_SECRET_KEY = 'sk_live_runtime_after_reset';
    runtime.__resetForTests();

    expect(runtime.getConfiguredStripeMode()).toBe('live');
  });

  it('clears cached clients and errors when reset for tests', () => {
    process.env.STRIPE_SECRET_KEY = 'pk_test_not_a_secret';

    const runtime = loadStripeRuntimeModule();

    expect(() => runtime.getStripeClient()).toThrow(/invalid STRIPE_SECRET_KEY/i);

    process.env.STRIPE_SECRET_KEY = 'sk_test_runtime_client';
    expect(() => runtime.getStripeClient()).toThrow(/invalid STRIPE_SECRET_KEY/i);

    runtime.__resetForTests();

    const firstClient = runtime.getStripeClient();

    expect(firstClient.getApiField('timeout')).toBe(10000);

    process.env.STRIPE_SECRET_KEY = 'sk_live_runtime_client';

    expect(runtime.getStripeClient()).toBe(firstClient);

    runtime.__resetForTests();

    const secondClient = runtime.getStripeClient();

    expect(secondClient).not.toBe(firstClient);
    expect(runtime.getConfiguredStripeMode()).toBe('live');
  });

  it('refuses to reset runtime caches outside the test environment', () => {
    const runtime = loadStripeRuntimeModule();
    const previousNodeEnv = process.env.NODE_ENV;

    try {
      process.env.NODE_ENV = 'production';

      expect(() => runtime.__resetForTests()).toThrow(
        '__resetForTests() is only available in test environment'
      );
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it('reads the active webhook secret dynamically for the cached mode', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_runtime_webhook';
    process.env.STRIPE_WEBHOOK_SECRET_TEST = 'whsec_runtime_first';

    const { getActiveStripeWebhookSecret, getConfiguredStripeMode } = loadStripeRuntimeModule();

    expect(getConfiguredStripeMode()).toBe('test');
    expect(getActiveStripeWebhookSecret()).toBe('whsec_runtime_first');

    process.env.STRIPE_WEBHOOK_SECRET_TEST = 'whsec_runtime_second';

    expect(getActiveStripeWebhookSecret()).toBe('whsec_runtime_second');
  });

  it('selects the webhook secret from the provided env secret key before cached mode', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_runtime_webhook';

    const { getActiveStripeWebhookSecret, getConfiguredStripeMode } = loadStripeRuntimeModule();

    expect(getConfiguredStripeMode()).toBe('test');
    expect(getActiveStripeWebhookSecret({
      STRIPE_SECRET_KEY: 'sk_live_runtime_webhook',
      STRIPE_WEBHOOK_SECRET_TEST: 'whsec_runtime_test',
      STRIPE_WEBHOOK_SECRET_LIVE: 'whsec_runtime_live',
    })).toBe('whsec_runtime_live');
  });

  it('validates provided webhook env secret keys through the shared schema', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_runtime_webhook';

    const { getActiveStripeWebhookSecret, getConfiguredStripeMode } = loadStripeRuntimeModule();

    expect(getConfiguredStripeMode()).toBe('test');

    for (const secretKey of [123, 'sk_live_bad-key']) {
      try {
        getActiveStripeWebhookSecret({
          STRIPE_SECRET_KEY: secretKey,
          STRIPE_WEBHOOK_SECRET_LIVE: 'whsec_runtime_live',
        });
        throw new Error('Expected webhook secret lookup to reject a malformed secret key');
      } catch (error) {
        expect(error.name).toBe('StripeConfigError');
        expect(error.code).toBe('STRIPE_CONFIG_INVALID');
        expect(error.statusCode).toBe(400);
        expect(error.message).toMatch(/invalid STRIPE_SECRET_KEY/i);
      }
    }
  });
});
