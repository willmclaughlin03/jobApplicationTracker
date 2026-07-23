#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const STRIPE_API_VERSION = '2026-04-22.dahlia';
const DEFAULT_WEBHOOK_PATH = '/api/billing/webhook';
const DEFAULT_EVENT_LOOKBACK_MINUTES = 240;
const DEFAULT_WEBHOOK_WAIT_SECONDS = 60;
const MAX_EVENT_LOOKBACK_MINUTES = 24 * 60;
const MAX_WEBHOOK_WAIT_SECONDS = 300;
const WEBHOOK_POLL_INTERVAL_MS = 2_000;
const STRIPE_EVENT_POLL_INTERVAL_MS = 10_000;
const LOCAL_REQUEST_TIMEOUT_MS = 10_000;
const FIXTURE_DB_WRITE_OPT_IN_ENV = 'STRIPE_LOCAL_E2E_ALLOW_FIXTURE_DB_WRITES';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const REQUIRED_EVENT_TYPES = Object.freeze([
  'checkout.session.completed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
]);
const RECEIPT_SUCCESS_RESULTS = new Set(['processed', 'stale_ignored']);

/**
 * Create a stable command error with a public-safe code.
 *
 * Purpose: operator failures should be actionable without printing secrets,
 * stack traces, or raw provider payloads to terminal logs.
 *
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 * @returns {Error & { code: string, details?: object }}
 */
function createCliError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details) {
    error.details = details;
  }
  return error;
}

/**
 * Write one newline-terminated line to a stream.
 *
 * Purpose: mirror existing operator scripts while avoiding console APIs in
 * command paths that may be copied into incident artifacts.
 *
 * @param {NodeJS.WritableStream} stream
 * @param {string} value
 * @returns {void}
 */
function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

/**
 * Write a JSON record to a stream.
 *
 * Purpose: keep integration output machine-readable for local evidence while
 * relying on explicit redaction before data reaches stdout or stderr.
 *
 * @param {NodeJS.WritableStream} stream
 * @param {object} payload
 * @returns {void}
 */
function writeJsonLine(stream, payload) {
  writeLine(stream, JSON.stringify(payload));
}

/**
 * Detect errors intentionally produced by this command.
 *
 * Purpose: third-party SDK errors can contain provider metadata, so only local
 * CLI errors should print their detailed messages to operator output.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isLocalCliError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('STRIPE_LOCAL_E2E_');
}

/**
 * Build a public-safe error record for command output.
 *
 * Purpose: never print raw Stripe/Supabase SDK error messages, stack traces, or
 * accidental secret-bearing provider metadata to stderr.
 *
 * @param {unknown} error
 * @returns {{ error: string, message: string, details: object | null }}
 */
function buildSafeErrorOutput(error) {
  if (isLocalCliError(error)) {
    return {
      error: error.code,
      message: error.message ?? 'Stripe local integration check failed',
      details: error.details ?? null,
    };
  }

  return {
    error: 'STRIPE_LOCAL_E2E_FAILED',
    message: 'Stripe local integration check failed',
    details: {
      causeCode: typeof error?.code === 'string' ? error.code : null,
      causeName: typeof error?.name === 'string' ? error.name : null,
      causeType: typeof error?.type === 'string' ? error.type : null,
    },
  };
}

/**
 * Normalize optional string input.
 *
 * Purpose: command flags and environment variables should treat whitespace-only
 * values as absent without leaking the original raw value.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Redact a Stripe-like id while preserving the resource family.
 *
 * Purpose: evidence should prove which class of object was checked without
 * turning terminal output into a durable store of provider identifiers.
 *
 * @param {unknown} id
 * @returns {string | null}
 */
function redactStripeId(id) {
  const normalizedId = normalizeString(id);

  if (!normalizedId) {
    return null;
  }

  const prefix = normalizedId.match(/^[A-Za-z]+_(?:test|live_)?/)?.[0]
    ?? normalizedId.match(/^[^_]+_/)?.[0]
    ?? '';
  const suffix = normalizedId.length > 4 ? normalizedId.slice(-4) : normalizedId;

  return `${prefix}***${suffix}`;
}

/**
 * Redact a local user id for output.
 *
 * Purpose: user ids are not secrets, but run evidence does not need to print
 * full account identifiers to prove ownership assertions passed.
 *
 * @param {unknown} userId
 * @returns {string | null}
 */
function redactUserId(userId) {
  const normalizedUserId = normalizeString(userId);

  if (!normalizedUserId) {
    return null;
  }

  return `user_***${normalizedUserId.slice(-6)}`;
}

/**
 * Convert a Stripe or database timestamp to ISO for comparison.
 *
 * Purpose: Stripe uses unix seconds while Supabase returns timestamptz strings;
 * the harness compares canonical milliseconds instead of raw text shape.
 *
 * @param {number | string | Date | null | undefined} value
 * @returns {string | null}
 */
function toIsoTimestamp(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  if (typeof value === 'string') {
    const trimmedValue = value.trim();

    if (!trimmedValue) {
      return null;
    }

    if (/^\d+(\.\d+)?$/.test(trimmedValue)) {
      const numericDate = new Date(Number(trimmedValue) * 1000);
      return Number.isFinite(numericDate.getTime()) ? numericDate.toISOString() : null;
    }

    const date = new Date(trimmedValue);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  return null;
}

/**
 * Compare timestamps by millisecond value.
 *
 * Purpose: database drivers may return equivalent timestamptz values with
 * different text precision, so the assertion should match semantic time.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function timestampsMatch(left, right) {
  const leftIso = toIsoTimestamp(left);
  const rightIso = toIsoTimestamp(right);

  if (!leftIso || !rightIso) {
    return false;
  }

  return new Date(leftIso).getTime() === new Date(rightIso).getTime();
}

/**
 * Parse a bounded positive integer argument.
 *
 * Purpose: lookback windows should stay finite so accidental command input does
 * not request an unbounded Stripe Events scan.
 *
 * @param {string} name
 * @param {unknown} value
 * @param {number} max
 * @returns {number}
 */
function parseBoundedPositiveInteger(name, value, max) {
  const normalizedValue = normalizeString(value);

  if (!/^\d+$/.test(normalizedValue)) {
    throw createCliError('STRIPE_LOCAL_E2E_INVALID_ARGS', `--${name} must be a positive integer`);
  }

  const parsedValue = Number(normalizedValue);

  if (!Number.isInteger(parsedValue) || parsedValue < 1 || parsedValue > max) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_INVALID_ARGS',
      `--${name} must be between 1 and ${max}`
    );
  }

  return parsedValue;
}

/**
 * Parse supported integration command flags.
 *
 * Purpose: keep the harness explicit: runtime secrets come from process.env,
 * while flags only select which safe local checks to run.
 *
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const args = {
    appUrl: normalizeString(process.env.NEXT_PUBLIC_APP_URL),
    eventLookbackMinutes: DEFAULT_EVENT_LOOKBACK_MINUTES,
    help: false,
    requireZeroPrice: false,
    sessionId: null,
    skipAppHealth: false,
    userId: null,
    webhookFixtures: false,
    webhookWaitSeconds: DEFAULT_WEBHOOK_WAIT_SECONDS,
    webhookUrl: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      return { ...args, help: true };
    }

    if (arg === '--app-url') {
      index += 1;
      args.appUrl = normalizeString(argv[index]);
      continue;
    }

    if (arg.startsWith('--app-url=')) {
      args.appUrl = normalizeString(arg.slice('--app-url='.length));
      continue;
    }

    if (arg === '--webhook-url') {
      index += 1;
      args.webhookUrl = normalizeString(argv[index]);
      continue;
    }

    if (arg.startsWith('--webhook-url=')) {
      args.webhookUrl = normalizeString(arg.slice('--webhook-url='.length));
      continue;
    }

    if (arg === '--session-id') {
      index += 1;
      args.sessionId = normalizeString(argv[index]);
      continue;
    }

    if (arg.startsWith('--session-id=')) {
      args.sessionId = normalizeString(arg.slice('--session-id='.length));
      continue;
    }

    if (arg === '--user-id') {
      index += 1;
      args.userId = normalizeString(argv[index]);
      continue;
    }

    if (arg.startsWith('--user-id=')) {
      args.userId = normalizeString(arg.slice('--user-id='.length));
      continue;
    }

    if (arg === '--event-lookback-minutes') {
      index += 1;
      args.eventLookbackMinutes = parseBoundedPositiveInteger(
        'event-lookback-minutes',
        argv[index],
        MAX_EVENT_LOOKBACK_MINUTES
      );
      continue;
    }

    if (arg.startsWith('--event-lookback-minutes=')) {
      args.eventLookbackMinutes = parseBoundedPositiveInteger(
        'event-lookback-minutes',
        arg.slice('--event-lookback-minutes='.length),
        MAX_EVENT_LOOKBACK_MINUTES
      );
      continue;
    }

    if (arg === '--webhook-fixtures') {
      args.webhookFixtures = true;
      continue;
    }

    if (arg === '--webhook-wait-seconds') {
      index += 1;
      args.webhookWaitSeconds = parseBoundedPositiveInteger(
        'webhook-wait-seconds',
        argv[index],
        MAX_WEBHOOK_WAIT_SECONDS
      );
      continue;
    }

    if (arg.startsWith('--webhook-wait-seconds=')) {
      args.webhookWaitSeconds = parseBoundedPositiveInteger(
        'webhook-wait-seconds',
        arg.slice('--webhook-wait-seconds='.length),
        MAX_WEBHOOK_WAIT_SECONDS
      );
      continue;
    }

    if (arg === '--skip-app-health') {
      args.skipAppHealth = true;
      continue;
    }

    if (arg === '--require-zero-price') {
      args.requireZeroPrice = true;
      continue;
    }

    throw createCliError('STRIPE_LOCAL_E2E_INVALID_ARGS', `Unknown argument: ${arg}`);
  }

  return args;
}

/**
 * Build the command usage text.
 *
 * Purpose: document the safe execution contract without implying the command
 * reads `.env` files or can run against live Stripe keys.
 *
 * @returns {string}
 */
function getUsageText() {
  return [
    'Usage: npm run billing:test-stripe-local -- [options]',
    '',
    'Reads runtime configuration from process.env only. Does not read .env files.',
    'Refuses sk_live_ keys so no real money can be charged.',
    '',
    'Options:',
    '  --app-url <url>                 Local app origin. Defaults to NEXT_PUBLIC_APP_URL.',
    '  --webhook-url <url>             Webhook URL. Defaults to <app-url>/api/billing/webhook.',
    '  --webhook-fixtures              Send signed safe fixture deliveries to the local webhook.',
    '  --session-id <cs_test_...>      Assert DB/Stripe state after a real completed Checkout.',
    '  --user-id <uuid>                Expected local user id for --session-id assertions.',
    '  --event-lookback-minutes <n>    Stripe Event lookup window. Default 240, max 1440.',
    '  --webhook-wait-seconds <n>      Wait for async webhook DB state. Default 60, max 300.',
    '  --require-zero-price            Fail unless the configured test Price amount is zero.',
    '  --skip-app-health               Skip GET /api/health reachability check.',
    '  --help                          Show this help text.',
    '',
    'Common flow:',
    '  1. Start the app with test-mode env loaded in the shell.',
    '  2. Run stripe listen and export the printed whsec as STRIPE_WEBHOOK_SECRET_TEST.',
    '  3. npm run billing:test-stripe-local -- --webhook-fixtures',
    '  4. Complete hosted test Checkout.',
    '  5. npm run billing:test-stripe-local -- --session-id cs_test_...',
  ].join('\n');
}

/**
 * Return a required environment value.
 *
 * Purpose: fail fast on absent runtime configuration without printing the raw
 * value that was expected to be present.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {string}
 */
function requireEnv(env, name) {
  const value = normalizeString(env?.[name]);

  if (!value) {
    throw createCliError('STRIPE_LOCAL_E2E_ENV_MISSING', `Missing ${name}`);
  }

  return value;
}

/**
 * Validate that a local URL is actually local.
 *
 * Purpose: this harness is allowed to use real Stripe test credentials, but it
 * must not accidentally target production or preview deployments.
 *
 * @param {string} value
 * @param {string} name
 * @returns {URL}
 */
function parseLocalUrl(value, name) {
  let parsedUrl;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw createCliError('STRIPE_LOCAL_E2E_INVALID_URL', `${name} must be a valid URL`);
  }

  if (parsedUrl.protocol !== 'http:') {
    throw createCliError('STRIPE_LOCAL_E2E_NON_LOCAL_URL', `${name} must use http:// locally`);
  }

  if (!LOCAL_HOSTNAMES.has(parsedUrl.hostname)) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_NON_LOCAL_URL',
      `${name} must point at localhost, 127.0.0.1, or ::1`
    );
  }

  return parsedUrl;
}

/**
 * Build the default webhook URL from the local app origin.
 *
 * Purpose: keep the webhook target aligned with the route under test while
 * still allowing an explicit override for alternate local ports.
 *
 * @param {string} appUrl
 * @returns {string}
 */
function buildDefaultWebhookUrl(appUrl) {
  const parsedUrl = new URL(appUrl);
  parsedUrl.pathname = DEFAULT_WEBHOOK_PATH;
  parsedUrl.search = '';
  parsedUrl.hash = '';
  return parsedUrl.toString();
}

/**
 * Classify the Supabase target without printing its URL.
 *
 * Purpose: read-only assertions may point at any explicitly configured
 * pre-production database, but signed webhook fixtures temporarily write
 * receipt rows and need a stronger local-or-opt-in guard.
 *
 * @param {string} supabaseUrl
 * @returns {{ isLocal: boolean, label: 'local' | 'remote' }}
 */
function classifySupabaseTarget(supabaseUrl) {
  let parsedUrl;

  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    throw createCliError(
      'STRIPE_LOCAL_E2E_SUPABASE_URL_INVALID',
      'TEST_SUPABASE_URL must be a valid URL'
    );
  }

  const isLocal = ['http:', 'https:'].includes(parsedUrl.protocol)
    && LOCAL_HOSTNAMES.has(parsedUrl.hostname);

  return {
    isLocal,
    label: isLocal ? 'local' : 'remote',
  };
}

/**
 * Decide whether signed fixture checks may write temporary receipt rows.
 *
 * Purpose: prevent accidental audit-row mutations in shared Supabase projects
 * unless the operator intentionally opts into remote fixture writes.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} supabaseUrl
 * @param {boolean} webhookFixtures
 * @returns {{ allowed: boolean, target: 'local' | 'remote' }}
 */
function resolveFixtureDbWriteSafety(env, supabaseUrl, webhookFixtures) {
  const target = classifySupabaseTarget(supabaseUrl);

  if (!webhookFixtures) {
    return {
      allowed: false,
      target: target.label,
    };
  }

  if (target.isLocal || normalizeString(env?.[FIXTURE_DB_WRITE_OPT_IN_ENV]) === 'true') {
    return {
      allowed: true,
      target: target.label,
    };
  }

  throw createCliError(
    'STRIPE_LOCAL_E2E_FIXTURE_DB_WRITES_FORBIDDEN',
    `--webhook-fixtures writes temporary receipt rows; use local Supabase or set ${FIXTURE_DB_WRITE_OPT_IN_ENV}=true`
  );
}

/**
 * Resolve and validate the local test configuration.
 *
 * Purpose: enforce the "no real money" contract before any Stripe, Supabase,
 * or app network calls can happen.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {object} args
 * @returns {object}
 */
function resolveLocalConfig(env, args) {
  const secretKey = requireEnv(env, 'STRIPE_SECRET_KEY');

  if (!secretKey.startsWith('sk_test_')) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_LIVE_KEY_FORBIDDEN',
      'STRIPE_SECRET_KEY must be a test-mode sk_test_ key for this local harness'
    );
  }

  if (normalizeString(env.NODE_ENV) === 'production') {
    throw createCliError(
      'STRIPE_LOCAL_E2E_PRODUCTION_FORBIDDEN',
      'NODE_ENV=production is not allowed for this local harness'
    );
  }

  const appUrl = args.appUrl || requireEnv(env, 'NEXT_PUBLIC_APP_URL');
  const parsedAppUrl = parseLocalUrl(appUrl, 'app URL');
  const webhookUrl = args.webhookUrl || buildDefaultWebhookUrl(parsedAppUrl.toString());
  parseLocalUrl(webhookUrl, 'webhook URL');

  const webhookSecret = normalizeString(env.STRIPE_WEBHOOK_SECRET_TEST);
  if (args.webhookFixtures && !webhookSecret.startsWith('whsec_')) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_WEBHOOK_SECRET_INVALID',
      'STRIPE_WEBHOOK_SECRET_TEST must be the current stripe listen whsec_ value'
    );
  }

  const priceId = requireEnv(env, 'STRIPE_PRICE_PREMIUM_MONTHLY');
  if (!priceId.startsWith('price_')) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_PRICE_INVALID',
      'STRIPE_PRICE_PREMIUM_MONTHLY must be shaped like price_...'
    );
  }

  const portalConfigurationId = requireEnv(env, 'STRIPE_BILLING_PORTAL_CONFIGURATION_ID');
  if (!portalConfigurationId.startsWith('bpc_')) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_PORTAL_CONFIG_INVALID',
      'STRIPE_BILLING_PORTAL_CONFIGURATION_ID must be shaped like bpc_...'
    );
  }

  const supabaseUrl = requireEnv(env, 'TEST_SUPABASE_URL');
  const serviceRoleKey = requireEnv(env, 'TEST_SUPABASE_SERVICE_KEY');
  const fixtureDbWrites = resolveFixtureDbWriteSafety(env, supabaseUrl, args.webhookFixtures);

  return {
    appUrl: parsedAppUrl.toString().replace(/\/$/, ''),
    eventLookbackMinutes: args.eventLookbackMinutes,
    fixtureDbWritesAllowed: fixtureDbWrites.allowed,
    portalConfigurationId,
    priceId,
    secretKey,
    serviceRoleKey,
    supabaseTarget: fixtureDbWrites.target,
    supabaseUrl,
    webhookSecret,
    webhookWaitMs: args.webhookWaitSeconds * 1000,
    webhookUrl,
  };
}

/**
 * Create a Stripe SDK client pinned to the app's API version.
 *
 * Purpose: local integration checks should inspect the same Stripe object shape
 * the application expects from its runtime client.
 *
 * @param {string} secretKey
 * @returns {Stripe}
 */
function createStripeClient(secretKey) {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    timeout: 10_000,
    maxNetworkRetries: 2,
  });
}

/**
 * Create a service-role Supabase client for local assertions.
 *
 * Purpose: the harness needs read-only evidence across billing tables without
 * depending on browser RLS sessions or reading credentials from files.
 *
 * @param {string} supabaseUrl
 * @param {string} serviceRoleKey
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function createSupabaseAdminClient(supabaseUrl, serviceRoleKey) {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Run one named check and record a sanitized pass result.
 *
 * Purpose: a failure should stop the drill, while passed checks should leave
 * structured evidence that can be attached to the rollout artifact.
 *
 * @param {Array<object>} results
 * @param {string} name
 * @param {() => Promise<object> | object} callback
 * @returns {Promise<void>}
 */
async function runCheck(results, name, callback) {
  const details = await callback();
  const result = {
    name,
    status: 'passed',
    details: details ?? {},
  };
  results.push(result);
  writeJsonLine(process.stdout, {
    event: 'stripe_local_integration_check_passed',
    ...result,
  });
}

/**
 * Validate the configured Stripe Price.
 *
 * Purpose: Checkout and entitlement must point at one active test-mode
 * recurring Price; optional zero-amount enforcement is available for drills
 * that want no test-mode payment amount at all.
 *
 * @param {Stripe} stripe
 * @param {string} priceId
 * @param {boolean} requireZeroPrice
 * @returns {Promise<object>}
 */
async function verifyStripePrice(stripe, priceId, requireZeroPrice) {
  const price = await stripe.prices.retrieve(priceId, {
    expand: ['product'],
  });

  if (price.livemode !== false) {
    throw createCliError('STRIPE_LOCAL_E2E_PRICE_LIVE_FORBIDDEN', 'Configured Price is not test-mode');
  }

  if (!price.active) {
    throw createCliError('STRIPE_LOCAL_E2E_PRICE_INACTIVE', 'Configured Price must be active');
  }

  if (price.type !== 'recurring' || !price.recurring?.interval) {
    throw createCliError('STRIPE_LOCAL_E2E_PRICE_NOT_RECURRING', 'Configured Price must be recurring');
  }

  const amount = typeof price.unit_amount === 'number' ? price.unit_amount : null;
  if (requireZeroPrice && amount !== 0) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_PRICE_NOT_ZERO',
      'Configured Price must be zero when --require-zero-price is set',
      { priceId: redactStripeId(priceId) }
    );
  }

  return {
    priceId: redactStripeId(price.id),
    livemode: price.livemode,
    active: price.active,
    currency: price.currency,
    interval: price.recurring.interval,
    amountIsZero: amount === 0,
    product: redactStripeId(typeof price.product === 'string' ? price.product : price.product?.id),
  };
}

/**
 * Validate the configured Stripe Customer Portal configuration.
 *
 * Purpose: portal behavior is part of billing safety, so the local harness
 * checks the pinned config id exists in the same test mode.
 *
 * @param {Stripe} stripe
 * @param {string} portalConfigurationId
 * @returns {Promise<object>}
 */
async function verifyPortalConfiguration(stripe, portalConfigurationId) {
  const configuration = await stripe.billingPortal.configurations.retrieve(portalConfigurationId);

  if (configuration.livemode !== false) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_PORTAL_LIVE_FORBIDDEN',
      'Portal configuration is not test-mode'
    );
  }

  if (configuration.active !== true) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_PORTAL_INACTIVE',
      'Portal configuration must be active'
    );
  }

  return {
    portalConfigurationId: redactStripeId(configuration.id),
    livemode: configuration.livemode,
    active: configuration.active,
  };
}

/**
 * Verify local billing tables are reachable through the service-role client.
 *
 * Purpose: a real Checkout drill cannot prove local entitlement if migrations
 * or service-role access are missing.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<object>}
 */
async function verifyBillingTables(supabase) {
  const tableChecks = [
    ['billing_customers', 'user_id'],
    ['billing_subscriptions', 'user_id'],
    ['billing_checkout_sessions', 'id'],
    ['stripe_event_receipts', 'event_id'],
  ];

  for (const [table, column] of tableChecks) {
    const { error } = await supabase
      .from(table)
      .select(column)
      .limit(1);

    if (error) {
      throw createCliError(
        'STRIPE_LOCAL_E2E_DB_TABLE_UNAVAILABLE',
        `Could not read ${table}`,
        { table, code: error.code ?? null }
      );
    }
  }

  return {
    tables: tableChecks.map(([table]) => table),
  };
}

/**
 * Verify the local app health endpoint.
 *
 * Purpose: the harness should fail before webhook or Checkout checks when the
 * local app is not actually serving requests.
 *
 * @param {string} appUrl
 * @returns {Promise<object>}
 */
async function verifyAppHealth(appUrl) {
  const response = await fetch(`${appUrl}/api/health`, {
    method: 'GET',
    signal: AbortSignal.timeout(LOCAL_REQUEST_TIMEOUT_MS),
    headers: {
      accept: 'application/json',
    },
  });
  const payload = await readResponsePayload(response);

  if (response.status !== 200) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_APP_HEALTH_FAILED',
      'Local app health check did not return 200',
      { status: response.status, payload }
    );
  }

  return {
    status: response.status,
    checks: payload?.checks ?? payload?.data?.checks ?? null,
  };
}

/**
 * Parse a fetch response without assuming JSON success.
 *
 * Purpose: negative webhook checks intentionally return errors, so response
 * evidence should preserve safe body shape without throwing on non-JSON text.
 *
 * @param {Response} response
 * @returns {Promise<object | string | null>}
 */
async function readResponsePayload(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 300);
  }
}

/**
 * Wait for a bounded number of milliseconds.
 *
 * Purpose: local Stripe CLI delivery and webhook DB writes are asynchronous,
 * so post-Checkout assertions need short polling without unbounded sleeps.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll a condition until it returns a truthy value or times out.
 *
 * Purpose: keep eventual webhook-state checks deterministic while preserving
 * the original assertion-specific error once the wait budget is exhausted.
 *
 * @param {{ timeoutMs: number, intervalMs?: number, check: () => Promise<unknown>, onTimeout: () => Error }} input
 * @returns {Promise<unknown>}
 */
async function waitForCheck(input) {
  const timeoutMs = Math.max(0, input.timeoutMs);
  const intervalMs = Math.max(100, input.intervalMs ?? WEBHOOK_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const result = await input.check();

    if (result) {
      return result;
    }

    if (Date.now() >= deadline) {
      throw input.onTimeout();
    }

    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Send one signed webhook payload to the local app.
 *
 * Purpose: exercise the actual Next.js raw-body and Stripe signature path
 * without needing Stripe CLI to manufacture negative cases.
 *
 * @param {Stripe} stripe
 * @param {{ webhookUrl: string, secret: string, payload: string, wrongSecret?: boolean, omitSignature?: boolean }} input
 * @returns {Promise<{ status: number, payload: object | string | null }>}
 */
async function postWebhookFixture(stripe, input) {
  const headers = {
    'content-type': 'application/json',
  };

  if (!input.omitSignature) {
    headers['stripe-signature'] = stripe.webhooks.generateTestHeaderString({
      payload: input.payload,
      secret: input.wrongSecret ? 'whsec_local_wrong_signature_fixture' : input.secret,
    });
  }

  const response = await fetch(input.webhookUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(LOCAL_REQUEST_TIMEOUT_MS),
    headers,
    body: input.payload,
  });

  return {
    status: response.status,
    payload: await readResponsePayload(response),
  };
}

/**
 * Build a safe unsupported Stripe event fixture.
 *
 * Purpose: unknown event handling should acknowledge and record a receipt
 * without touching entitlement or requiring a real customer/subscription.
 *
 * @param {string} label
 * @param {number} [created]
 * @returns {object}
 */
function buildUnknownEventFixture(label, created = Math.floor(Date.now() / 1000)) {
  const fixtureId = randomUUID().replaceAll('-', '').slice(0, 16);

  return {
    id: `evt_local_${label}_${fixtureId}`,
    object: 'event',
    api_version: STRIPE_API_VERSION,
    created,
    data: {
      object: {
        id: `cus_local_fixture_${label}`,
        object: 'customer',
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: {
      id: null,
      idempotency_key: null,
    },
    type: 'customer.subscription.paused',
  };
}

/**
 * Load one Stripe event receipt row by event id.
 *
 * Purpose: receipt assertions and eventual waits should share the same
 * service-role read shape and sanitized database error handling.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} eventId
 * @returns {Promise<object | null>}
 */
async function loadReceiptRow(supabase, eventId) {
  const { data, error } = await supabase
    .from('stripe_event_receipts')
    .select('event_id,event_type,result,livemode,stripe_event_created')
    .eq('event_id', eventId)
    .maybeSingle();

  if (error) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_RECEIPT_READ_FAILED',
      'Could not read stripe_event_receipts',
      { code: error.code ?? null }
    );
  }

  return data;
}

/**
 * Assert that a receipt row exists with an expected terminal result.
 *
 * Purpose: webhook fixture checks need DB proof that only the valid signed
 * event wrote durable receipt state.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} eventId
 * @param {Set<string>} allowedResults
 * @returns {Promise<object>}
 */
async function assertReceiptResult(supabase, eventId, allowedResults) {
  const data = await loadReceiptRow(supabase, eventId);

  if (!data || !allowedResults.has(data.result)) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_RECEIPT_RESULT_INVALID',
      'Webhook receipt did not reach the expected result',
      {
        eventId: redactStripeId(eventId),
        result: data?.result ?? null,
      }
    );
  }

  return {
    eventId: redactStripeId(data.event_id),
    eventType: data.event_type,
    result: data.result,
    livemode: data.livemode,
  };
}

/**
 * Wait for a receipt row to reach an expected terminal result.
 *
 * Purpose: real Stripe CLI deliveries can lag behind the completed Checkout
 * assertion command, so receipt evidence should wait briefly before failing.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} eventId
 * @param {Set<string>} allowedResults
 * @param {{ timeoutMs: number, intervalMs?: number }} waitOptions
 * @returns {Promise<object>}
 */
async function waitForReceiptResult(supabase, eventId, allowedResults, waitOptions) {
  let lastReceipt = null;

  const receipt = await waitForCheck({
    timeoutMs: waitOptions.timeoutMs,
    intervalMs: waitOptions.intervalMs,
    check: async () => {
      lastReceipt = await loadReceiptRow(supabase, eventId);
      return lastReceipt && allowedResults.has(lastReceipt.result) ? lastReceipt : null;
    },
    onTimeout: () => createCliError(
      'STRIPE_LOCAL_E2E_RECEIPT_RESULT_INVALID',
      'Webhook receipt did not reach the expected result',
      {
        eventId: redactStripeId(eventId),
        result: lastReceipt?.result ?? null,
      }
    ),
  });

  return {
    eventId: redactStripeId(receipt.event_id),
    eventType: receipt.event_type,
    result: receipt.result,
    livemode: receipt.livemode,
  };
}

/**
 * Assert that no receipt row exists for a rejected fixture.
 *
 * Purpose: signature and raw-body failures must stop before durable billing
 * receipt writes.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} eventId
 * @returns {Promise<void>}
 */
async function assertReceiptAbsent(supabase, eventId) {
  const { data, error } = await supabase
    .from('stripe_event_receipts')
    .select('event_id')
    .eq('event_id', eventId)
    .maybeSingle();

  if (error) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_RECEIPT_READ_FAILED',
      'Could not read stripe_event_receipts',
      { code: error.code ?? null }
    );
  }

  if (data) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_REJECTED_EVENT_WROTE_RECEIPT',
      'Rejected webhook fixture wrote a receipt row',
      { eventId: redactStripeId(eventId) }
    );
  }
}

/**
 * Remove temporary receipt rows created by signed local fixtures.
 *
 * Purpose: fixture checks should prove receipt behavior without leaving durable
 * `evt_local_...` audit rows that can collide with future local drills.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Set<string>} eventIds
 * @returns {Promise<{ requested: number, deleted: number | null }>}
 */
async function cleanupFixtureReceipts(supabase, eventIds) {
  const safeEventIds = [...eventIds].filter((eventId) => (
    typeof eventId === 'string' && eventId.startsWith('evt_local_')
  ));

  if (safeEventIds.length !== eventIds.size) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_FIXTURE_CLEANUP_REFUSED',
      'Refused to clean up a non-local fixture receipt id'
    );
  }

  if (safeEventIds.length === 0) {
    return {
      requested: 0,
      deleted: 0,
    };
  }

  const { count, error } = await supabase
    .from('stripe_event_receipts')
    .delete({ count: 'exact' })
    .in('event_id', safeEventIds);

  if (error) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_FIXTURE_CLEANUP_FAILED',
      'Could not clean up temporary webhook fixture receipts',
      { code: error.code ?? null }
    );
  }

  return {
    requested: safeEventIds.length,
    deleted: count ?? null,
  };
}

/**
 * Exercise local webhook ingress with signed fixtures.
 *
 * Purpose: Stripe CLI proves real delivery shape, while signed fixtures let the
 * runbook prove wrong-secret, duplicate, future-timestamp, and envelope guards.
 *
 * @param {Stripe} stripe
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ webhookUrl: string, webhookSecret: string }} config
 * @returns {Promise<object>}
 */
async function verifyWebhookFixtures(stripe, supabase, config) {
  const fixtureEventIds = new Set();
  let fixtureResult = null;
  let primaryError = null;
  let cleanupResult = null;

  try {
    const acceptedEvent = buildUnknownEventFixture('accepted');
    fixtureEventIds.add(acceptedEvent.id);
    const acceptedPayload = JSON.stringify(acceptedEvent);
    const firstDelivery = await postWebhookFixture(stripe, {
      webhookUrl: config.webhookUrl,
      secret: config.webhookSecret,
      payload: acceptedPayload,
    });

    if (firstDelivery.status !== 200 || firstDelivery.payload?.data?.received !== true) {
      throw createCliError(
        'STRIPE_LOCAL_E2E_WEBHOOK_FIXTURE_FAILED',
        'Signed unknown-event fixture did not return 200',
        { status: firstDelivery.status, payload: firstDelivery.payload }
      );
    }

    const firstReceipt = await assertReceiptResult(
      supabase,
      acceptedEvent.id,
      RECEIPT_SUCCESS_RESULTS
    );

    const duplicateDelivery = await postWebhookFixture(stripe, {
      webhookUrl: config.webhookUrl,
      secret: config.webhookSecret,
      payload: acceptedPayload,
    });

    if (
      duplicateDelivery.status !== 200
      || duplicateDelivery.payload?.data?.duplicate !== true
    ) {
      throw createCliError(
        'STRIPE_LOCAL_E2E_WEBHOOK_DUPLICATE_FAILED',
        'Duplicate signed fixture was not acknowledged as duplicate',
        { status: duplicateDelivery.status, payload: duplicateDelivery.payload }
      );
    }

    const wrongSecretEvent = buildUnknownEventFixture('wrong_secret');
    fixtureEventIds.add(wrongSecretEvent.id);
    const wrongSecretDelivery = await postWebhookFixture(stripe, {
      webhookUrl: config.webhookUrl,
      secret: config.webhookSecret,
      payload: JSON.stringify(wrongSecretEvent),
      wrongSecret: true,
    });

    if (wrongSecretDelivery.status !== 400) {
      throw createCliError(
        'STRIPE_LOCAL_E2E_WEBHOOK_WRONG_SECRET_FAILED',
        'Wrong-secret fixture did not return 400',
        { status: wrongSecretDelivery.status, payload: wrongSecretDelivery.payload }
      );
    }
    await assertReceiptAbsent(supabase, wrongSecretEvent.id);

    const missingSignatureEvent = buildUnknownEventFixture('missing_signature');
    fixtureEventIds.add(missingSignatureEvent.id);
    const missingSignatureDelivery = await postWebhookFixture(stripe, {
      webhookUrl: config.webhookUrl,
      secret: config.webhookSecret,
      payload: JSON.stringify(missingSignatureEvent),
      omitSignature: true,
    });

    if (missingSignatureDelivery.status !== 400) {
      throw createCliError(
        'STRIPE_LOCAL_E2E_WEBHOOK_MISSING_SIGNATURE_FAILED',
        'Missing-signature fixture did not return 400',
        { status: missingSignatureDelivery.status, payload: missingSignatureDelivery.payload }
      );
    }
    await assertReceiptAbsent(supabase, missingSignatureEvent.id);

    const futureEvent = buildUnknownEventFixture(
      'future',
      Math.floor(Date.now() / 1000) + 60 * 60
    );
    fixtureEventIds.add(futureEvent.id);
    const futureDelivery = await postWebhookFixture(stripe, {
      webhookUrl: config.webhookUrl,
      secret: config.webhookSecret,
      payload: JSON.stringify(futureEvent),
    });

    if (futureDelivery.status !== 500) {
      throw createCliError(
        'STRIPE_LOCAL_E2E_WEBHOOK_FUTURE_TIMESTAMP_FAILED',
        'Future timestamp fixture did not fail closed with 500',
        { status: futureDelivery.status, payload: futureDelivery.payload }
      );
    }
    await assertReceiptAbsent(supabase, futureEvent.id);

    const mismatchCreated = Math.floor(Date.now() / 1000);
    const mismatchEvent = buildUnknownEventFixture('mismatch', mismatchCreated);
    fixtureEventIds.add(mismatchEvent.id);
    const { error: insertError } = await supabase
      .from('stripe_event_receipts')
      .insert({
        event_id: mismatchEvent.id,
        event_type: 'customer.created',
        livemode: false,
        stripe_event_created: toIsoTimestamp(mismatchCreated),
        result: 'processed',
      });

    if (insertError) {
      throw createCliError(
        'STRIPE_LOCAL_E2E_MISMATCH_FIXTURE_INSERT_FAILED',
        'Could not insert receipt envelope mismatch fixture',
        { code: insertError.code ?? null }
      );
    }

    const mismatchDelivery = await postWebhookFixture(stripe, {
      webhookUrl: config.webhookUrl,
      secret: config.webhookSecret,
      payload: JSON.stringify(mismatchEvent),
    });

    if (mismatchDelivery.status !== 500) {
      throw createCliError(
        'STRIPE_LOCAL_E2E_WEBHOOK_MISMATCH_FAILED',
        'Envelope mismatch fixture did not fail closed with 500',
        { status: mismatchDelivery.status, payload: mismatchDelivery.payload }
      );
    }

    const oversizedEvent = buildUnknownEventFixture('oversized');
    fixtureEventIds.add(oversizedEvent.id);
    oversizedEvent.data.object.metadata = {
      padding: 'x'.repeat(260 * 1024),
    };
    const oversizedDelivery = await postWebhookFixture(stripe, {
      webhookUrl: config.webhookUrl,
      secret: config.webhookSecret,
      payload: JSON.stringify(oversizedEvent),
    });

    if (oversizedDelivery.status !== 413) {
      throw createCliError(
        'STRIPE_LOCAL_E2E_WEBHOOK_OVERSIZED_FAILED',
        'Oversized fixture did not return 413',
        { status: oversizedDelivery.status, payload: oversizedDelivery.payload }
      );
    }
    await assertReceiptAbsent(supabase, oversizedEvent.id);

    fixtureResult = {
      acceptedReceipt: firstReceipt,
      duplicate: duplicateDelivery.payload?.data?.duplicate === true,
      wrongSecretStatus: wrongSecretDelivery.status,
      missingSignatureStatus: missingSignatureDelivery.status,
      futureTimestampStatus: futureDelivery.status,
      envelopeMismatchStatus: mismatchDelivery.status,
      oversizedStatus: oversizedDelivery.status,
    };
  } catch (error) {
    primaryError = error;
  }

  try {
    cleanupResult = await cleanupFixtureReceipts(supabase, fixtureEventIds);
  } catch (cleanupError) {
    if (!primaryError) {
      throw cleanupError;
    }

    primaryError.details = {
      ...(primaryError.details ?? {}),
      fixtureCleanupError: cleanupError?.code ?? 'STRIPE_LOCAL_E2E_FIXTURE_CLEANUP_FAILED',
    };
  }

  if (primaryError) {
    throw primaryError;
  }

  return {
    ...fixtureResult,
    fixtureCleanup: cleanupResult,
  };
}

/**
 * Extract a Stripe id from string or expanded-object shapes.
 *
 * Purpose: Checkout Sessions, Customers, and Subscriptions may be returned as
 * ids or expanded objects depending on the API call.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function extractStripeId(value) {
  if (typeof value === 'string') {
    return value.trim() || null;
  }

  if (value && typeof value === 'object' && typeof value.id === 'string') {
    return value.id.trim() || null;
  }

  return null;
}

/**
 * Extract a subscription id from invoice event data.
 *
 * Purpose: mirror the dispatcher candidates so event receipt assertions can
 * find invoice events tied to the tested subscription.
 *
 * @param {object | null | undefined} invoice
 * @returns {string | null}
 */
function extractSubscriptionIdFromInvoice(invoice) {
  const candidates = [
    invoice?.subscription,
    invoice?.subscription_details?.subscription,
    invoice?.parent?.subscription_details?.subscription,
    invoice?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription,
  ];

  for (const candidate of candidates) {
    const subscriptionId = extractStripeId(candidate);

    if (subscriptionId) {
      return subscriptionId;
    }
  }

  return null;
}

/**
 * Find the subscription item that owns the configured Price.
 *
 * Purpose: Dahlia-shaped Stripe subscriptions expose current period fields on
 * items, so the local DB assertion must compare against the matching item.
 *
 * @param {object} subscription
 * @param {string} priceId
 * @returns {object | null}
 */
function findSubscriptionItemByPrice(subscription, priceId) {
  const items = Array.isArray(subscription?.items?.data) ? subscription.items.data : [];

  return items.find((item) => (
    extractStripeId(item?.price) === priceId
    || extractStripeId(item?.plan) === priceId
    || item?.price?.id === priceId
    || item?.plan?.id === priceId
  )) ?? null;
}

/**
 * Load one row by equality filters.
 *
 * Purpose: keep Supabase assertion reads consistent and surface table/error
 * metadata without printing raw row contents on failure.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} table
 * @param {string} select
 * @param {Record<string, string | number>} filters
 * @returns {Promise<object | null>}
 */
async function loadMaybeSingleRow(supabase, table, select, filters) {
  let query = supabase.from(table).select(select);

  for (const [column, value] of Object.entries(filters)) {
    query = query.eq(column, value);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_DB_READ_FAILED',
      `Could not read ${table}`,
      { table, code: error.code ?? null }
    );
  }

  return data;
}

/**
 * List recent Stripe events that relate to the tested Checkout/subscription.
 *
 * Purpose: webhook receipt assertions should use real Stripe event ids rather
 * than broad table scans by event type.
 *
 * @param {Stripe} stripe
 * @param {{ sessionId: string, subscriptionId: string, lookbackMinutes: number }} input
 * @returns {Promise<Array<object>>}
 */
async function listRelatedStripeEvents(stripe, input) {
  const createdGte = Math.floor(Date.now() / 1000) - (input.lookbackMinutes * 60);
  const events = [];
  let startingAfter = null;

  while (true) {
    const pageParams = {
      created: {
        gte: createdGte,
      },
      limit: 100,
    };

    if (startingAfter) {
      pageParams.starting_after = startingAfter;
    }

    const page = await stripe.events.list(pageParams);

    for (const event of page.data) {
      if (!REQUIRED_EVENT_TYPES.includes(event.type)) {
        continue;
      }

      const object = event?.data?.object;
      const objectId = extractStripeId(object);
      const invoiceSubscriptionId = event.type.startsWith('invoice.')
        ? extractSubscriptionIdFromInvoice(object)
        : null;

      if (
        objectId === input.sessionId
        || objectId === input.subscriptionId
        || invoiceSubscriptionId === input.subscriptionId
      ) {
        events.push(event);
      }
    }

    if (!page.has_more || page.data.length === 0) {
      break;
    }

    startingAfter = page.data[page.data.length - 1].id;
  }

  return events;
}

/**
 * Assert receipt rows exist for real Stripe events.
 *
 * Purpose: completed Checkout proof should include durable local processing
 * receipts for the actual provider event ids delivered by Stripe.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Array<object>} events
 * @param {{ intervalMs?: number }} waitOptions
 * @param {number} deadlineMs shared post-Checkout wait deadline
 * @returns {Promise<Array<object>>}
 */
async function assertRealEventReceipts(supabase, events, waitOptions, deadlineMs) {
  const receipts = [];

  for (const event of events) {
    receipts.push(await waitForReceiptResult(
      supabase,
      event.id,
      RECEIPT_SUCCESS_RESULTS,
      {
        ...waitOptions,
        timeoutMs: Math.max(0, deadlineMs - Date.now()),
      }
    ));
  }

  return receipts;
}

/**
 * Verify local DB rows after a real hosted Checkout completes.
 *
 * Purpose: this is the executable version of the runbook's canonical
 * entitlement proof, including the Dahlia Subscription Item period field.
 *
 * @param {Stripe} stripe
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} config
 * @param {{ sessionId: string, userId?: string | null }} args
 * @returns {Promise<object>}
 */
async function verifyCompletedCheckoutSession(stripe, supabase, config, args) {
  if (!args.sessionId?.startsWith('cs_test_')) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_SESSION_INVALID',
      '--session-id must be shaped like cs_test_...'
    );
  }

  const session = await stripe.checkout.sessions.retrieve(args.sessionId, {
    expand: ['customer', 'subscription'],
  });

  if (session.livemode !== false) {
    throw createCliError('STRIPE_LOCAL_E2E_SESSION_LIVE_FORBIDDEN', 'Checkout Session is live-mode');
  }

  if (session.status !== 'complete') {
    throw createCliError(
      'STRIPE_LOCAL_E2E_SESSION_NOT_COMPLETE',
      'Checkout Session must be complete before DB assertions run',
      { status: session.status }
    );
  }

  const userId = args.userId || normalizeString(session.client_reference_id);
  if (!userId) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_USER_ID_MISSING',
      'Pass --user-id or complete Checkout through the app so client_reference_id is set'
    );
  }

  if (args.userId && session.client_reference_id !== args.userId) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_CLIENT_REFERENCE_MISMATCH',
      'Checkout Session client_reference_id does not match --user-id',
      {
        expectedUserId: redactUserId(args.userId),
        actualUserId: redactUserId(session.client_reference_id),
      }
    );
  }

  const subscriptionId = extractStripeId(session.subscription);
  const customerId = extractStripeId(session.customer);

  if (!subscriptionId || !customerId) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_SESSION_LINKAGE_MISSING',
      'Completed Checkout Session is missing customer or subscription id'
    );
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['customer', 'items.data.price'],
  });
  const subscriptionCustomerId = extractStripeId(subscription.customer);

  if (subscription.livemode !== false) {
    throw createCliError('STRIPE_LOCAL_E2E_SUBSCRIPTION_LIVE_FORBIDDEN', 'Subscription is live-mode');
  }

  if (subscriptionCustomerId !== customerId) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_CUSTOMER_MISMATCH',
      'Checkout Session customer does not match Subscription customer',
      {
        sessionCustomerId: redactStripeId(customerId),
        subscriptionCustomerId: redactStripeId(subscriptionCustomerId),
      }
    );
  }

  const matchingItem = findSubscriptionItemByPrice(subscription, config.priceId);
  if (!matchingItem) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_SUBSCRIPTION_PRICE_MISSING',
      'Subscription does not include the configured allowlisted Price',
      {
        subscriptionId: redactStripeId(subscriptionId),
        priceId: redactStripeId(config.priceId),
      }
    );
  }

  const itemPeriodEnd = toIsoTimestamp(matchingItem.current_period_end);
  if (!itemPeriodEnd) {
    throw createCliError(
      'STRIPE_LOCAL_E2E_ITEM_PERIOD_END_MISSING',
      'Stripe Subscription Item current_period_end is missing'
    );
  }

  const postCheckoutDeadlineMs = Date.now() + config.webhookWaitMs;
  const waitOptions = {
    intervalMs: WEBHOOK_POLL_INTERVAL_MS,
  };
  let latestCustomerRow = null;

  await waitForCheck({
    ...waitOptions,
    timeoutMs: Math.max(0, postCheckoutDeadlineMs - Date.now()),
    check: async () => {
      latestCustomerRow = await loadMaybeSingleRow(
        supabase,
        'billing_customers',
        'user_id,stripe_customer_id,last_synced_stripe_email_fingerprint',
        { user_id: userId }
      );

      return latestCustomerRow?.stripe_customer_id === customerId ? latestCustomerRow : null;
    },
    onTimeout: () => createCliError(
      'STRIPE_LOCAL_E2E_CUSTOMER_ROW_INVALID',
      'billing_customers does not map the user to the Checkout customer',
      {
        userId: redactUserId(userId),
        expectedCustomerId: redactStripeId(customerId),
        actualCustomerId: redactStripeId(latestCustomerRow?.stripe_customer_id),
      }
    ),
  });

  let latestSubscriptionRow = null;
  const subscriptionSelect = [
    'user_id',
    'stripe_subscription_id',
    'stripe_customer_id',
    'price_id',
    'status',
    'current_period_end',
    'cancel_at_period_end',
    'last_stripe_event_created',
  ].join(',');
  const subscriptionRow = await waitForCheck({
    ...waitOptions,
    timeoutMs: Math.max(0, postCheckoutDeadlineMs - Date.now()),
    check: async () => {
      latestSubscriptionRow = await loadMaybeSingleRow(
        supabase,
        'billing_subscriptions',
        subscriptionSelect,
        { user_id: userId }
      );

      return (
        latestSubscriptionRow?.stripe_subscription_id === subscriptionId
        && latestSubscriptionRow?.stripe_customer_id === customerId
        && latestSubscriptionRow?.price_id === config.priceId
        && latestSubscriptionRow?.status === 'active'
        && latestSubscriptionRow?.cancel_at_period_end === Boolean(subscription.cancel_at_period_end)
        && Boolean(latestSubscriptionRow?.last_stripe_event_created)
        && Boolean(latestSubscriptionRow?.current_period_end)
        && timestampsMatch(latestSubscriptionRow.current_period_end, itemPeriodEnd)
      ) ? latestSubscriptionRow : null;
    },
    onTimeout: () => {
      if (!latestSubscriptionRow) {
        return createCliError(
          'STRIPE_LOCAL_E2E_SUBSCRIPTION_ROW_MISSING',
          'billing_subscriptions row is missing for completed Checkout user',
          { userId: redactUserId(userId) }
        );
      }

      if (!latestSubscriptionRow.current_period_end) {
        return createCliError(
          'STRIPE_LOCAL_E2E_CURRENT_PERIOD_END_NULL',
          'billing_subscriptions.current_period_end is null after completed Checkout'
        );
      }

      if (!timestampsMatch(latestSubscriptionRow.current_period_end, itemPeriodEnd)) {
        return createCliError(
          'STRIPE_LOCAL_E2E_CURRENT_PERIOD_END_MISMATCH',
          'Local current_period_end does not match Stripe Subscription Item current_period_end',
          {
            localCurrentPeriodEnd: toIsoTimestamp(latestSubscriptionRow.current_period_end),
            stripeItemCurrentPeriodEnd: itemPeriodEnd,
          }
        );
      }

      return createCliError(
        'STRIPE_LOCAL_E2E_SUBSCRIPTION_ROW_INVALID',
        'billing_subscriptions row does not match canonical Stripe state',
        {
          userId: redactUserId(userId),
          subscriptionId: redactStripeId(latestSubscriptionRow.stripe_subscription_id),
          customerId: redactStripeId(latestSubscriptionRow.stripe_customer_id),
          priceId: redactStripeId(latestSubscriptionRow.price_id),
          status: latestSubscriptionRow.status,
          hasLastStripeEventCreated: Boolean(latestSubscriptionRow.last_stripe_event_created),
        }
      );
    },
  });

  let latestCheckoutRow = null;
  const checkoutRow = await waitForCheck({
    ...waitOptions,
    timeoutMs: Math.max(0, postCheckoutDeadlineMs - Date.now()),
    check: async () => {
      latestCheckoutRow = await loadMaybeSingleRow(
        supabase,
        'billing_checkout_sessions',
        'id,user_id,plan,stripe_checkout_session_id,status,expires_at',
        {
          user_id: userId,
          stripe_checkout_session_id: args.sessionId,
        }
      );

      return latestCheckoutRow?.status === 'complete' ? latestCheckoutRow : null;
    },
    onTimeout: () => createCliError(
      'STRIPE_LOCAL_E2E_CHECKOUT_ROW_INVALID',
      'billing_checkout_sessions row is missing or not terminal complete',
      {
        userId: redactUserId(userId),
        sessionId: redactStripeId(args.sessionId),
        status: latestCheckoutRow?.status ?? null,
      }
    ),
  });

  let latestRelatedEvents = [];
  const relatedEvents = await waitForCheck({
    ...waitOptions,
    timeoutMs: Math.max(0, postCheckoutDeadlineMs - Date.now()),
    intervalMs: STRIPE_EVENT_POLL_INTERVAL_MS,
    check: async () => {
      latestRelatedEvents = await listRelatedStripeEvents(stripe, {
        sessionId: args.sessionId,
        subscriptionId,
        lookbackMinutes: config.eventLookbackMinutes,
      });

      return latestRelatedEvents.some((event) => event.type === 'checkout.session.completed')
        ? latestRelatedEvents
        : null;
    },
    onTimeout: () => createCliError(
      'STRIPE_LOCAL_E2E_CHECKOUT_EVENT_NOT_FOUND',
      'Could not find recent checkout.session.completed event for the tested session',
      { relatedEventsFound: latestRelatedEvents.length }
    ),
  });

  const receipts = await assertRealEventReceipts(
    supabase,
    relatedEvents,
    waitOptions,
    postCheckoutDeadlineMs
  );

  return {
    userId: redactUserId(userId),
    checkoutSessionId: redactStripeId(args.sessionId),
    customerId: redactStripeId(customerId),
    subscriptionId: redactStripeId(subscriptionId),
    priceId: redactStripeId(config.priceId),
    status: subscriptionRow.status,
    currentPeriodEndMatchesItem: true,
    checkoutRowStatus: checkoutRow.status,
    relatedEvents: relatedEvents.map((event) => ({
      id: redactStripeId(event.id),
      type: event.type,
    })),
    receipts,
  };
}

/**
 * Run the local Stripe integration harness.
 *
 * Purpose: coordinate safety gates, preflight checks, optional webhook
 * fixtures, and optional post-Checkout DB assertions in one operator command.
 *
 * @returns {Promise<void>}
 */
async function run() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    writeLine(process.stdout, getUsageText());
    return;
  }

  const config = resolveLocalConfig(process.env, args);
  const stripe = createStripeClient(config.secretKey);
  const supabase = createSupabaseAdminClient(config.supabaseUrl, config.serviceRoleKey);
  const results = [];

  await runCheck(results, 'local_safety_gate', () => ({
    stripeMode: 'test',
    nodeEnv: normalizeString(process.env.NODE_ENV) || null,
    appUrl: config.appUrl,
    webhookUrl: config.webhookUrl,
    supabaseTarget: config.supabaseTarget,
    fixtureDbWritesAllowed: config.fixtureDbWritesAllowed,
    webhookWaitSeconds: config.webhookWaitMs / 1000,
    stripeApiVersion: STRIPE_API_VERSION,
  }));

  await runCheck(results, 'stripe_price', () => (
    verifyStripePrice(stripe, config.priceId, args.requireZeroPrice)
  ));

  await runCheck(results, 'stripe_portal_configuration', () => (
    verifyPortalConfiguration(stripe, config.portalConfigurationId)
  ));

  await runCheck(results, 'billing_database_tables', () => verifyBillingTables(supabase));

  if (!args.skipAppHealth) {
    await runCheck(results, 'local_app_health', () => verifyAppHealth(config.appUrl));
  }

  if (args.webhookFixtures) {
    await runCheck(results, 'webhook_signed_fixtures', () => (
      verifyWebhookFixtures(stripe, supabase, config)
    ));
  }

  if (args.sessionId) {
    await runCheck(results, 'completed_checkout_session', () => (
      verifyCompletedCheckoutSession(stripe, supabase, config, args)
    ));
  }

  writeJsonLine(process.stdout, {
    event: 'stripe_local_integration_check_completed',
    status: 'passed',
    checks: results.length,
  });
}

run().catch((error) => {
  const safeError = buildSafeErrorOutput(error);

  writeJsonLine(process.stderr, {
    event: 'stripe_local_integration_check_failed',
    status: 'failed',
    ...safeError,
  });
  process.exitCode = 1;
});
