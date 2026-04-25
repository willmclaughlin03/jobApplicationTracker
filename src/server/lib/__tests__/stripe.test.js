const STRIPE_ENV_VARS = [
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
  process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
  process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';
  process.env.STRIPE_WEBHOOK_SECRET_TEST = 'whsec_test_chunk2';
}

function loadStripeModule() {
  jest.resetModules();
  return require('../stripe.js');
}

describe('stripe runtime foundation', () => {
  beforeEach(() => {
    resetStripeEnv();
  });

  afterAll(() => {
    restoreStripeEnv();
  });

  it('returns the allowlisted Stripe price id for the supported billing plan', () => {
    setValidTestEnv();

    const {
      BILLING_PLANS,
      STRIPE_API_VERSION,
      STRIPE_MODE,
      getPriceIdForPlan,
      stripe,
    } = loadStripeModule();

    expect(STRIPE_API_VERSION).toBe('2026-02-25.clover');
    expect(STRIPE_MODE).toBe('test');
    expect(getPriceIdForPlan(BILLING_PLANS.RESUME_TAILOR_MONTHLY)).toBe('price_tailor_monthly');
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
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';

    expect(() => loadStripeModule()).toThrow(/missing STRIPE_SECRET_KEY/i);
  });

  it('fails fast when the allowlisted price id env var is missing', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';

    expect(() => loadStripeModule()).toThrow(/missing STRIPE_PRICE_RESUME_TAILOR_MONTHLY/i);
  });

  it('fails fast when STRIPE_SECRET_KEY is malformed', () => {
    process.env.STRIPE_SECRET_KEY = 'pk_test_not_a_secret';
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';

    expect(() => loadStripeModule()).toThrow(/invalid STRIPE_SECRET_KEY/i);
  });

  it('returns the active webhook secret for test mode', () => {
    setValidTestEnv();

    const { getActiveStripeWebhookSecret } = loadStripeModule();

    expect(getActiveStripeWebhookSecret()).toBe('whsec_test_chunk2');
  });

  it('returns the active webhook secret for live mode', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_chunk2';
    process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY = 'price_tailor_monthly';
    process.env.STRIPE_WEBHOOK_SECRET_LIVE = 'whsec_live_chunk2';

    const { STRIPE_MODE, getActiveStripeWebhookSecret } = loadStripeModule();

    expect(STRIPE_MODE).toBe('live');
    expect(getActiveStripeWebhookSecret()).toBe('whsec_live_chunk2');
  });

  it('fails closed when the active webhook secret is missing', () => {
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
