const STRIPE_ENV_VARS = [
  'NEXT_PUBLIC_APP_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_PRICE_RESUME_TAILOR_MONTHLY',
  'STRIPE_WEBHOOK_SECRET_TEST',
  'STRIPE_WEBHOOK_SECRET_LIVE',
];

const ORIGINAL_ENV = Object.fromEntries(
  STRIPE_ENV_VARS.map((envVarName) => [envVarName, process.env[envVarName]])
);

function resetStripeEnv() {
  for (const envVarName of STRIPE_ENV_VARS) {
    delete process.env[envVarName];
  }
}

function restoreStripeEnv() {
  resetStripeEnv();

  for (const [envVarName, value] of Object.entries(ORIGINAL_ENV)) {
    if (value !== undefined) {
      process.env[envVarName] = value;
    }
  }
}

function setValidTestEnv() {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
  process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
  process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';
  process.env.STRIPE_WEBHOOK_SECRET_TEST = 'whsec_test_chunk2';
}

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
      STRIPE_MODE,
      buildAppUrl,
      getAppOrigin,
      getPriceIdForPlan,
      stripe,
    } = loadStripeModule();

    expect(STRIPE_API_VERSION).toBe('2026-02-25.clover');
    expect(STRIPE_MODE).toBe('test');
    expect(getAppOrigin()).toBe('https://app.example.test');
    expect(buildAppUrl('/billing/success')).toBe('https://app.example.test/billing/success');
    expect(getPriceIdForPlan(BILLING_PLANS.RESUME_TAILOR_MONTHLY)).toBe('price_tailor_monthly');
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

  it('fails fast when STRIPE_SECRET_KEY is missing', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';

    expect(() => loadStripeModule()).toThrow(/missing STRIPE_SECRET_KEY/i);
  });

  it('fails fast when the allowlisted price id env var is missing', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';

    expect(() => loadStripeModule()).toThrow(/missing STRIPE_PRICE_RESUME_TAILOR_MONTHLY/i);
  });

  it('fails fast when STRIPE_SECRET_KEY is malformed', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
    process.env.STRIPE_SECRET_KEY = 'pk_test_not_a_secret';
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';

    expect(() => loadStripeModule()).toThrow(/invalid STRIPE_SECRET_KEY/i);
  });

  it('fails fast when NEXT_PUBLIC_APP_URL is missing', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';

    expect(() => loadStripeModule()).toThrow(/missing NEXT_PUBLIC_APP_URL/i);
  });

  it('rejects non-origin NEXT_PUBLIC_APP_URL values', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test/billing';
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';

    expect(() => loadStripeModule()).toThrow(/invalid NEXT_PUBLIC_APP_URL/i);
  });

  it('rejects NEXT_PUBLIC_APP_URL values with embedded credentials', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://user:pass@app.example.test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';

    expect(() => loadStripeModule()).toThrow(/invalid NEXT_PUBLIC_APP_URL/i);
  });

  it('rejects insecure non-local development origins outside production', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://staging.example.test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';

    expect(() => loadStripeModule()).toThrow(/invalid NEXT_PUBLIC_APP_URL/i);
  });

  it('allows localhost http origins outside production', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';
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
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';

    expect(() => loadStripeModule()).toThrow(/invalid NEXT_PUBLIC_APP_URL/i);
  });

  it('returns the active webhook secret for test mode', () => {
    setValidTestEnv();

    const { getActiveStripeWebhookSecret } = loadStripeModule();

    expect(getActiveStripeWebhookSecret()).toBe('whsec_test_chunk2');
  });

  it('returns the active webhook secret for live mode', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
    process.env.STRIPE_SECRET_KEY = 'sk_live_chunk2';
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';
    process.env.STRIPE_WEBHOOK_SECRET_LIVE = 'whsec_live_chunk2';

    const { STRIPE_MODE, getActiveStripeWebhookSecret } = loadStripeModule();

    expect(STRIPE_MODE).toBe('live');
    expect(getActiveStripeWebhookSecret()).toBe('whsec_live_chunk2');
  });

  it('fails closed when the active webhook secret is missing', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';

    const { getActiveStripeWebhookSecret } = loadStripeModule();

    try {
      getActiveStripeWebhookSecret();
      throw new Error('Expected webhook secret lookup to fail closed');
    } catch (error) {
      expect(error.code).toBe('WEBHOOK_VERIFIER_NOT_CONFIGURED');
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
    expect(firstError.code).toBe('STRIPE_CONFIG_INVALID');
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
        expect(error.code).toBe('STRIPE_CONFIG_INVALID');
        expect(error.message).toMatch(/invalid STRIPE_SECRET_KEY/i);
      }
    }
  });
});
