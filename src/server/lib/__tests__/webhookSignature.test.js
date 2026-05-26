const { EventEmitter } = require('events');
const { Readable } = require('stream');

const STRIPE_ENV_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PRICE_RESUME_TAILOR_MONTHLY',
  'STRIPE_WEBHOOK_SECRET_TEST',
  'STRIPE_WEBHOOK_SECRET_LIVE',
  'NEXT_PUBLIC_APP_URL',
];

const ORIGINAL_ENV = Object.fromEntries(
  STRIPE_ENV_VARS.map((envVarName) => [envVarName, process.env[envVarName]])
);

/**
 * Clear Stripe-related env vars so webhook signature tests start from a known baseline.
 * Uses STRIPE_ENV_VARS and mutates process.env before isolated module loads.
 */
function resetStripeEnv() {
  for (const envVarName of STRIPE_ENV_VARS) {
    delete process.env[envVarName];
  }
}

/**
 * Restore the Stripe env snapshot captured before webhook signature tests changed it.
 * Uses ORIGINAL_ENV after resetStripeEnv and mutates process.env for later test files.
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
 * Seed the Stripe secrets required by webhook signature happy-path tests.
 * Mutates process.env keys read by stripeRuntime and webhookSignature modules.
 */
function setValidTestEnv() {
  process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';
  process.env.STRIPE_WEBHOOK_SECRET_TEST = 'whsec_test_chunk2';
}

/**
 * Build a JSON Stripe event fixture for signature verification tests.
 * overrides are merged into the event payload before it is stringified.
 */
function createEventPayload(overrides = {}) {
  return JSON.stringify({
    id: 'evt_chunk2',
    object: 'event',
    type: 'invoice.paid',
    livemode: false,
    created: 1713456000,
    data: {
      object: {
        id: 'in_chunk2',
        object: 'invoice',
      },
    },
    ...overrides,
  });
}

/**
 * Build a buffered request-like EventEmitter for raw-body signature tests.
 * payload becomes rawBody and headers is set to an empty object.
 */
function createBufferedRequest(payload) {
  return Object.assign(new EventEmitter(), {
    headers: {},
    rawBody: Buffer.from(payload),
  });
}

/**
 * Build a streaming request-like Readable for raw-body signature tests.
 * payload is emitted as bytes; side effect: mutates req.headers to {}.
 */
function createStreamRequest(payload) {
  const req = Readable.from([Buffer.from(payload)]);
  req.headers = {};
  return req;
}

/**
 * Load fresh Stripe runtime and webhook signature modules for env-isolated tests.
 * Calls jest.resetModules() before requiring stripeRuntime and webhookSignature.
 */
function loadModules() {
  jest.resetModules();

  const stripeRuntimeModule = require('../stripeRuntime.js');
  const webhookSignatureModule = require('../webhookSignature.js');

  return {
    ...stripeRuntimeModule,
    ...webhookSignatureModule,
  };
}

describe('verifyWebhookSignature', () => {
  beforeEach(() => {
    resetStripeEnv();
  });

  afterAll(() => {
    restoreStripeEnv();
  });

  it('verifies a valid Stripe signature using an existing raw body buffer', async () => {
    setValidTestEnv();

    const payload = createEventPayload();
    const { getStripeClient, verifyWebhookSignature } = loadModules();
    const signature = getStripeClient().webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET_TEST,
    });

    const event = await verifyWebhookSignature(createBufferedRequest(payload), { signature });

    expect(event.id).toBe('evt_chunk2');
    expect(event.type).toBe('invoice.paid');
  });

  it('verifies a valid Stripe signature after reading the raw body stream', async () => {
    setValidTestEnv();

    const payload = createEventPayload({ id: 'evt_stream' });
    const { getStripeClient, verifyWebhookSignature } = loadModules();
    const signature = getStripeClient().webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET_TEST,
    });

    const req = createStreamRequest(payload);
    const event = await verifyWebhookSignature(req, { signature });

    expect(event.id).toBe('evt_stream');
    expect(Buffer.isBuffer(req.rawBody)).toBe(true);
    expect(req.rawBody.toString('utf8')).toBe(payload);
  });

  it('rejects missing webhook signatures', async () => {
    setValidTestEnv();

    const payload = createEventPayload();
    const { verifyWebhookSignature } = loadModules();

    await expect(
      verifyWebhookSignature(createBufferedRequest(payload), { signature: '' })
    ).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
      statusCode: 400,
    });
  });

  it('rejects invalid Stripe signatures', async () => {
    setValidTestEnv();

    const payload = createEventPayload();
    const { verifyWebhookSignature } = loadModules();

    await expect(
      verifyWebhookSignature(createBufferedRequest(payload), { signature: 't=1,v1=invalid' })
    ).rejects.toThrow(/no signatures found matching/i);
  });

  it('enforces custom maxBodyBytes while reading stream payloads', async () => {
    setValidTestEnv();

    const payload = createEventPayload({ id: 'evt_oversized_stream' });
    const { verifyWebhookSignature } = loadModules();

    await expect(
      verifyWebhookSignature(createStreamRequest(payload), {
        signature: 't=1,v1=invalid',
        maxBodyBytes: 5,
      })
    ).rejects.toMatchObject({
      code: 'RAW_BODY_TOO_LARGE',
      maxBytes: 5,
      statusCode: 413,
    });
  });

  it('fails closed when the active webhook secret is not configured', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_chunk2';

    const payload = createEventPayload();
    const { verifyWebhookSignature } = loadModules();

    await expect(
      verifyWebhookSignature(createBufferedRequest(payload), { signature: 't=1,v1=invalid' })
    ).rejects.toMatchObject({
      name: 'WebhookVerifierNotConfiguredError',
      code: 'WEBHOOK_VERIFIER_NOT_CONFIGURED',
      statusCode: 503,
    });
  });

  it('does not require checkout-only app URL or price env vars', async () => {
    setValidTestEnv();
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.STRIPE_PRICE_RESUME_TAILOR_MONTHLY;

    const payload = createEventPayload({ id: 'evt_runtime_only' });
    const { getStripeClient, verifyWebhookSignature } = loadModules();
    const signature = getStripeClient().webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET_TEST,
    });

    const event = await verifyWebhookSignature(createBufferedRequest(payload), { signature });

    expect(event.id).toBe('evt_runtime_only');
  });
});
