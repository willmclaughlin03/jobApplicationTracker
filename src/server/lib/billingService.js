import crypto from 'crypto';
import { z } from 'zod';
import { logger as defaultLogger } from '../../shared/logger.js';
import { ERROR_MESSAGES } from '../../shared/errors.js';
import {
  BILLING_ENTITLEMENTS,
  BILLING_PLAN_PRICE_ENV_VARS,
  BILLING_SUBSCRIPTION_STATUSES,
  ENTITLED_BILLING_STATUSES,
  PAYMENT_RECOVERY_BILLING_STATUSES,
} from '../../shared/constants/billing.js';
import { TIERS } from '../../shared/constants/tiers.js';
import { getConfiguredStripeMode, stripe } from './stripe.js';
import { supabaseAdmin } from './supabaseServer.js';

const BILLING_CUSTOMER_SELECT = 'user_id, stripe_customer_id, created_at, updated_at';
const BILLING_SUBSCRIPTION_SELECT = [
  'user_id',
  'stripe_subscription_id',
  'stripe_customer_id',
  'price_id',
  'status',
  'current_period_end',
  'cancel_at_period_end',
  'last_stripe_event_created',
  'status_changed_at',
  'created_at',
  'updated_at',
].join(', ');

export const STRIPE_EVENT_RECEIPT_RESULTS = Object.freeze({
  PROCESSED: 'processed',
  DUPLICATE_IGNORED: 'duplicate_ignored',
  STALE_IGNORED: 'stale_ignored',
  FAILED: 'failed',
});

export const BILLING_SYNC_MODES = Object.freeze({
  EVENT: 'event',
  AUTHORITATIVE: 'authoritative',
});

export const BILLING_WRITE_OUTCOMES = Object.freeze({
  PROCESSED: 'processed',
  CUSTOMER_NOT_FOUND: 'customer_not_found',
  UNSUPPORTED_STATUS_IGNORED: 'unsupported_status_ignored',
});

const ALLOWED_BILLING_STATUSES = new Set(Object.values(BILLING_SUBSCRIPTION_STATUSES));
const STRIPE_EVENT_RECEIPT_RESULT_VALUES = Object.values(STRIPE_EVENT_RECEIPT_RESULTS);
const BILLING_SYNC_MODE_VALUES = Object.values(BILLING_SYNC_MODES);
const FULL_BILLING_ID_LOG_LEVELS = new Set(['error', 'debug']);

const nonEmptyStringSchema = z.string().trim().min(1);
const optionalEmailSchema = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue : undefined;
}, z.string().trim().email().max(320).optional().nullable());
const stripeReceiptEventSchema = z.object({
  id: nonEmptyStringSchema,
  type: z.string().trim().min(1).max(255),
  livemode: z.boolean(),
  created: z.union([z.number().finite(), z.string().trim().min(1), z.date()]),
});
const stripeReceiptResultSchema = z.enum(STRIPE_EVENT_RECEIPT_RESULT_VALUES);
const stripeDeleteEventMetaSchema = z.object({
  eventCreated: z.union([z.number().finite(), z.string().trim().min(1), z.date()]),
  livemode: z.boolean(),
});

function createBillingError(message, code = 'BILLING_INVALID_INPUT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createBillingRpcError(message) {
  return createBillingError(message, 'BILLING_RPC_INVALID_RESPONSE');
}

function normalizePriceId(priceId) {
  return typeof priceId === 'string' ? priceId.trim() : '';
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim() : '';
}

function normalizeLogLevel(level) {
  return typeof level === 'string' ? level.trim().toLowerCase() : 'info';
}

function isTruthyEnvFlag(value) {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

const BILLING_LOG_HASH_SECRET = normalizeString(process.env.BILLING_LOG_HASH_SECRET);

if (!BILLING_LOG_HASH_SECRET) {
  defaultLogger.warn(
    { event: 'billing_log_hash_secret_missing' },
    'BILLING_LOG_HASH_SECRET is missing; billing user-id log hashes are disabled'
  );
}

/**
 * Hash user ids for logs with HMAC-SHA256 so log correlation does not depend on
 * a plain reusable digest.
 *
 * @param {string} userId
 * @returns {string | null}
 */
export function hashUserIdForLog(userId) {
  if (!BILLING_LOG_HASH_SECRET || typeof userId !== 'string' || userId.length === 0) {
    return null;
  }

  return crypto
    .createHmac('sha256', BILLING_LOG_HASH_SECRET)
    .update(userId)
    .digest('hex');
}

/**
 * Hash user ids for Stripe idempotency keys with plain SHA-256. This is
 * intentionally separate from log hashing so secret rotation does not perturb
 * Stripe-visible idempotency behavior.
 *
 * @param {unknown} userId
 * @returns {string}
 */
export function hashUserIdForIdempotency(userId) {
  const normalizedUserId =
    typeof userId === 'string' && userId.length > 0 ? userId : '[missing-user-id]';

  return crypto.createHash('sha256').update(normalizedUserId).digest('hex');
}

function isLoggerCandidate(value) {
  return (
    !!value
    && typeof value === 'object'
    && ['info', 'warn', 'error', 'debug'].every((method) => typeof value[method] === 'function')
  );
}

function isSupabaseReadClientCandidate(value) {
  return !!value && typeof value === 'object' && typeof value.from === 'function';
}

function toIsoTimestamp(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isNaN(timestamp) ? null : value.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const asDate = new Date(value * 1000);
    return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
  }

  if (typeof value === 'string') {
    const trimmedValue = value.trim();

    if (!trimmedValue) {
      return null;
    }

    if (/^\d+(\.\d+)?$/.test(trimmedValue)) {
      const numericDate = new Date(Number(trimmedValue) * 1000);
      return Number.isNaN(numericDate.getTime()) ? null : numericDate.toISOString();
    }

    const asDate = new Date(trimmedValue);
    return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
  }

  return null;
}

function isOlderStripeEvent(localLastEventCreated, incomingEventCreated) {
  const localTimestamp = toIsoTimestamp(localLastEventCreated);
  const incomingTimestamp = toIsoTimestamp(incomingEventCreated);

  if (!localTimestamp || !incomingTimestamp) {
    return false;
  }

  return new Date(incomingTimestamp).getTime() < new Date(localTimestamp).getTime();
}

function extractStripeCustomerId(customer) {
  if (typeof customer === 'string') {
    return customer.trim() || null;
  }

  if (customer?.deleted === true) {
    return null;
  }

  if (customer && typeof customer === 'object' && typeof customer.id === 'string') {
    return customer.id.trim() || null;
  }

  return null;
}

function extractStripePriceId(subscription) {
  const items = Array.isArray(subscription?.items?.data) ? subscription.items.data : [];

  for (const item of items) {
    const priceId = normalizePriceId(item?.price?.id);

    if (priceId) {
      return priceId;
    }
  }

  return normalizePriceId(subscription?.items?.data?.[0]?.plan?.id) || null;
}

function normalizeStripeStatus(status) {
  return typeof status === 'string' ? status.trim() : '';
}

function normalizeRpcJsonData(data) {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }

  return data;
}

/**
 * Normalize and classify a Stripe subscription status without widening the
 * local allowlist. Unexpected statuses are rejected and monitored instead of
 * being coerced into local state.
 *
 * @param {unknown} status
 * @returns {{ normalizedStatus: string, isSupported: boolean }}
 */
export function classifyStripeStatus(status) {
  const normalizedStatus = normalizeStripeStatus(status);

  return {
    normalizedStatus,
    isSupported: ALLOWED_BILLING_STATUSES.has(normalizedStatus),
  };
}

export function redactStripeId(id) {
  const normalizedId = normalizeString(id);

  if (!normalizedId) {
    return null;
  }

  const prefixMatch = normalizedId.match(/^[^_]+_/);
  const prefix = prefixMatch?.[0] ?? '';
  const suffix = normalizedId.length > 4 ? normalizedId.slice(-4) : normalizedId;

  return `${prefix}***${suffix}`;
}

/**
 * Apply the billing log redaction policy for Stripe ids.
 *
 * Live mode stays redacted at every log level by default. Test mode exposes
 * full ids only at `error` and `debug`. Live mode may opt into the same
 * `error`/`debug` behavior with LOG_FULL_BILLING_IDS=true.
 *
 * @param {string | null | undefined} id
 * @param {'error' | 'warn' | 'info' | 'debug' | string} level
 * @returns {string | null}
 */
export function formatStripeIdForLog(id, level) {
  const normalizedId = normalizeString(id);

  if (!normalizedId) {
    return null;
  }

  const normalizedLevel = normalizeLogLevel(level);
  const stripeMode = getConfiguredStripeMode();
  const allowFullIds =
    stripeMode === 'test'
      ? FULL_BILLING_ID_LOG_LEVELS.has(normalizedLevel)
      : isTruthyEnvFlag(process.env.LOG_FULL_BILLING_IDS)
        && FULL_BILLING_ID_LOG_LEVELS.has(normalizedLevel);

  return allowFullIds ? normalizedId : redactStripeId(normalizedId);
}

function logUnsupportedStripeStatus(log, {
  operation,
  userId,
  status,
  stripeSubscriptionId,
}) {
  log.error(
    {
      event: 'billing_unsupported_status',
      operation,
      userIdHash: hashUserIdForLog(userId),
      status,
      stripeSubscriptionId: formatStripeIdForLog(stripeSubscriptionId, 'error'),
    },
    'Skipped billing write for unsupported Stripe subscription status'
  );
}

/**
 * Reject Stripe traffic from the wrong mode before billing tables are touched.
 *
 * @param {unknown} livemode
 * @param {{ operation?: string, stripeEventId?: string | null, stripeSubscriptionId?: string | null, log?: object }} context
 * @returns {boolean}
 */
export function assertStripeLivemode(livemode, context = {}) {
  if (typeof livemode !== 'boolean') {
    throw createBillingError('Stripe billing input is missing a livemode flag', 'BILLING_LIVEMODE_INVALID');
  }

  const expectedLivemode = getConfiguredStripeMode() === 'live';

  if (livemode !== expectedLivemode) {
    const log = isLoggerCandidate(context.log) ? context.log : defaultLogger;

    log.error(
      {
        event: 'billing_livemode_mismatch',
        operation: context.operation ?? null,
        expectedLivemode,
        receivedLivemode: livemode,
        stripeEventId: formatStripeIdForLog(context.stripeEventId, 'error'),
        stripeSubscriptionId: formatStripeIdForLog(context.stripeSubscriptionId, 'error'),
      },
      'Rejected Stripe billing work for the wrong livemode'
    );

    throw createBillingError('Stripe livemode mismatch', 'BILLING_LIVEMODE_MISMATCH');
  }

  return livemode;
}

function parseSyncSubscriptionOptions(options) {
  const parsedMode = nonEmptyStringSchema.safeParse(options?.mode);

  if (!parsedMode.success || !BILLING_SYNC_MODE_VALUES.includes(parsedMode.data)) {
    throw createBillingError('Invalid Stripe subscription sync mode');
  }

  const eventCreated =
    options?.eventCreated === undefined ? undefined : toIsoTimestamp(options.eventCreated);

  if (parsedMode.data === BILLING_SYNC_MODES.EVENT && !eventCreated) {
    throw createBillingError('Event-driven subscription sync requires eventCreated');
  }

  return {
    mode: parsedMode.data,
    eventCreated,
  };
}

function createEmptyBillingStatus() {
  return {
    customer: null,
    subscription: null,
    hasCustomerMapping: false,
    hasSubscription: false,
    entitled: false,
    entitlement: null,
    tier: TIERS.FREE,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    priceId: null,
    status: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  };
}

function buildBillingStatus(customer, subscription) {
  const entitled = hasCanonicalBillingEntitlement(subscription);
  const stripeCustomerId =
    normalizeString(customer?.stripe_customer_id) || normalizeString(subscription?.stripe_customer_id) || null;
  const stripeSubscriptionId =
    typeof subscription?.stripe_subscription_id === 'string'
      ? subscription.stripe_subscription_id
      : null;

  return {
    customer: customer ?? null,
    subscription: subscription ?? null,
    hasCustomerMapping: !!customer,
    hasSubscription: !!subscription,
    entitled,
    entitlement: entitled ? BILLING_ENTITLEMENTS.AI_TAILOR : null,
    tier: entitled ? TIERS.PAID : TIERS.FREE,
    stripeCustomerId,
    stripeSubscriptionId,
    priceId: subscription?.price_id ?? null,
    status: subscription?.status ?? null,
    currentPeriodEnd: subscription?.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
  };
}

async function loadBillingCustomerByUserId(userId, client) {
  const { data, error } = await client
    .from('billing_customers')
    .select(BILLING_CUSTOMER_SELECT)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function loadBillingCustomerByStripeCustomerId(stripeCustomerId, client) {
  const { data, error } = await client
    .from('billing_customers')
    .select(BILLING_CUSTOMER_SELECT)
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function loadBillingSubscriptionByUserId(userId, client) {
  const { data, error } = await client
    .from('billing_subscriptions')
    .select(BILLING_SUBSCRIPTION_SELECT)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

function buildEventDrivenSubscriptionPayload({
  userId,
  stripeSubscriptionId,
  stripeCustomerId,
  priceId,
  status,
  currentPeriodEnd,
  cancelAtPeriodEnd = false,
  eventCreated,
}) {
  return {
    user_id: userId,
    stripe_subscription_id: stripeSubscriptionId,
    stripe_customer_id: stripeCustomerId,
    price_id: priceId,
    status,
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: Boolean(cancelAtPeriodEnd),
    last_stripe_event_created: eventCreated,
  };
}

function buildAuthoritativeSubscriptionPayload({
  userId,
  stripeSubscriptionId,
  stripeCustomerId,
  priceId,
  status,
  currentPeriodEnd,
  cancelAtPeriodEnd = false,
  lastStripeEventCreated,
}) {
  const payload = {
    user_id: userId,
    stripe_subscription_id: stripeSubscriptionId,
    stripe_customer_id: stripeCustomerId,
    price_id: priceId,
    status,
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: Boolean(cancelAtPeriodEnd),
  };

  if (lastStripeEventCreated !== undefined) {
    payload.last_stripe_event_created = lastStripeEventCreated;
  }

  return payload;
}

async function callSubscriptionEventRpc(payload) {
  const { data, error } = await supabaseAdmin.rpc(
    'upsert_billing_subscription_if_newer_or_equal',
    { payload }
  );

  if (error) {
    throw error;
  }

  const normalizedData = normalizeRpcJsonData(data);

  if (
    !normalizedData
    || typeof normalizedData !== 'object'
    || typeof normalizedData.applied !== 'boolean'
    || !normalizedData.subscription
  ) {
    throw createBillingRpcError('Billing event subscription RPC returned an unexpected payload');
  }

  return normalizedData;
}

async function callSubscriptionAuthoritativeRpc(payload) {
  const { data, error } = await supabaseAdmin.rpc(
    'upsert_billing_subscription_authoritative',
    { payload }
  );

  if (error) {
    throw error;
  }

  const normalizedData = normalizeRpcJsonData(data);

  if (!normalizedData || typeof normalizedData !== 'object' || !normalizedData.subscription) {
    throw createBillingRpcError('Billing authoritative subscription RPC returned an unexpected payload');
  }

  return normalizedData;
}

async function callStripeEventReceiptMergeRpc({ eventId, eventType, livemode, stripeEventCreated, result }) {
  const { data, error } = await supabaseAdmin.rpc('merge_stripe_event_receipt', {
    p_event_id: eventId,
    p_event_type: eventType,
    p_livemode: livemode,
    p_stripe_event_created: stripeEventCreated,
    p_result: result,
  });

  if (error) {
    throw error;
  }

  const normalizedData = normalizeRpcJsonData(data);

  if (
    !normalizedData
    || typeof normalizedData !== 'object'
    || typeof normalizedData.outcome !== 'string'
    || !normalizedData.receipt
  ) {
    throw createBillingRpcError('Stripe event receipt RPC returned an unexpected payload');
  }

  return normalizedData;
}

/**
 * Resolve the configured Stripe price-id allowlist for premium entitlements.
 *
 * Missing env vars are ignored here so entitlement checks fail closed to FREE.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Set<string>}
 */
export function getEntitledPriceIdAllowlist(env = process.env) {
  return new Set(
    Object.values(BILLING_PLAN_PRICE_ENV_VARS)
      .map((envVarName) => normalizePriceId(env?.[envVarName]))
      .filter(Boolean)
  );
}

/**
 * Canonical local billing entitlement rule for premium features.
 *
 * Premium storage is an intentional product behavior, not a generic auth-tier
 * side effect. Authorization must come from trusted local billing state.
 *
 * @param {{ price_id?: string | null, status?: string | null } | null | undefined} subscription
 * @param {Set<string>} entitledPriceIds
 * @returns {boolean}
 */
export function hasCanonicalBillingEntitlement(
  subscription,
  entitledPriceIds = getEntitledPriceIdAllowlist()
) {
  const normalizedPriceId = normalizePriceId(subscription?.price_id);
  const subscriptionStatus =
    typeof subscription?.status === 'string' ? subscription.status : null;

  if (!normalizedPriceId || !ENTITLED_BILLING_STATUSES.includes(subscriptionStatus)) {
    return false;
  }

  return entitledPriceIds.has(normalizedPriceId);
}

/**
 * Read the canonical local billing state for one user through the caller's
 * request-scoped Supabase client only.
 *
 * This helper never silently escalates to supabaseAdmin. Missing/invalid
 * clients fail closed so future call sites cannot bypass RLS by accident.
 *
 * @param {string} userId
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function getLocalBillingStatus(
  userId,
  supabaseClient,
  log = defaultLogger
) {
  if (!userId || !isSupabaseReadClientCandidate(supabaseClient)) {
    log.error(
      {
        operation: 'getLocalBillingStatus',
        hasUserId: !!userId,
        hasSupabaseClient: isSupabaseReadClientCandidate(supabaseClient),
      },
      'Billing status resolver is missing a request-scoped Supabase client'
    );
    return createEmptyBillingStatus();
  }

  const userIdHash = hashUserIdForLog(userId);

  try {
    const [customer, subscription] = await Promise.all([
      loadBillingCustomerByUserId(userId, supabaseClient),
      loadBillingSubscriptionByUserId(userId, supabaseClient),
    ]);

    return buildBillingStatus(customer, subscription);
  } catch (error) {
    log.error(
      { err: error, operation: 'getLocalBillingStatus', userIdHash },
      'Failed to load local billing status'
    );
    return createEmptyBillingStatus();
  }
}

/**
 * Intentionally bypass RLS for server-controlled billing reads by routing the
 * request-scoped helper through supabaseAdmin.
 *
 * @param {string} userId
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function getLocalBillingStatusPrivileged(userId, log = defaultLogger) {
  return getLocalBillingStatus(userId, supabaseAdmin, log);
}

/**
 * Resolve the canonical storage tier from local billing state for a user via a
 * request-scoped Supabase client.
 *
 * @param {string} userId
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {object} log
 * @returns {Promise<string>}
 */
export async function resolveStorageEntitlement(
  userId,
  supabaseClient,
  log = defaultLogger
) {
  const billingStatus = await getLocalBillingStatus(userId, supabaseClient, log);
  return billingStatus.tier;
}

/**
 * Intentionally bypass RLS for server-controlled storage entitlement checks by
 * routing through supabaseAdmin.
 *
 * @param {string} userId
 * @param {object} log
 * @returns {Promise<string>}
 */
export async function resolveStorageEntitlementPrivileged(userId, log = defaultLogger) {
  return resolveStorageEntitlement(userId, supabaseAdmin, log);
}

/**
 * Resolve access to the AI tailor feature from canonical local billing state
 * using a request-scoped Supabase client.
 *
 * Missing/invalid clients or read failures fail closed to a non-entitled
 * response instead of silently widening access.
 *
 * @param {string} userId
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function resolveTailorEntitlement(
  userId,
  supabaseClient,
  log = defaultLogger
) {
  const billingStatus = await getLocalBillingStatus(userId, supabaseClient, log);

  if (billingStatus.entitled) {
    return {
      entitled: true,
      entitlement: BILLING_ENTITLEMENTS.AI_TAILOR,
      code: null,
      message: null,
      billingStatus,
    };
  }

  if (PAYMENT_RECOVERY_BILLING_STATUSES.includes(billingStatus.status)) {
    return {
      entitled: false,
      entitlement: null,
      code: 'PAYMENT_METHOD_UPDATE_REQUIRED',
      message: ERROR_MESSAGES.PAYMENT_METHOD_UPDATE_REQUIRED,
      billingStatus,
    };
  }

  if (billingStatus.hasCustomerMapping && !billingStatus.hasSubscription) {
    return {
      entitled: false,
      entitlement: null,
      code: 'BILLING_SYNC_PENDING',
      message: ERROR_MESSAGES.BILLING_SYNC_PENDING,
      billingStatus,
    };
  }

  if (billingStatus.status === BILLING_SUBSCRIPTION_STATUSES.INCOMPLETE) {
    return {
      entitled: false,
      entitlement: null,
      code: 'BILLING_SYNC_PENDING',
      message: ERROR_MESSAGES.BILLING_SYNC_PENDING,
      billingStatus,
    };
  }

  return {
    entitled: false,
    entitlement: null,
    code: 'SUBSCRIPTION_REQUIRED',
    message: ERROR_MESSAGES.SUBSCRIPTION_REQUIRED,
    billingStatus,
  };
}

/**
 * Intentionally bypass RLS for server-controlled AI tailor entitlement checks
 * by routing through supabaseAdmin.
 *
 * @param {string} userId
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function resolveTailorEntitlementPrivileged(userId, log = defaultLogger) {
  return resolveTailorEntitlement(userId, supabaseAdmin, log);
}

/**
 * Resolve or create the canonical Stripe customer mapping for a user.
 *
 * A placeholder local billing_customers row is created before the Stripe
 * customer so subscription writes always satisfy the customer-first FK.
 *
 * @param {string} userId
 * @param {string | null | undefined} email
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function getOrCreateStripeCustomer(userId, email, log = defaultLogger) {
  const parsedInput = z.object({
    userId: nonEmptyStringSchema,
    email: optionalEmailSchema,
  }).safeParse({ userId, email });

  if (!parsedInput.success) {
    throw createBillingError('Invalid billing customer input');
  }

  const userIdHash = hashUserIdForLog(parsedInput.data.userId);
  const normalizedEmail = normalizeEmail(parsedInput.data.email);
  let createdPlaceholder = false;

  try {
    let localCustomer = await loadBillingCustomerByUserId(parsedInput.data.userId, supabaseAdmin);

    if (localCustomer?.stripe_customer_id) {
      return {
        userId: parsedInput.data.userId,
        stripeCustomerId: localCustomer.stripe_customer_id,
        customer: localCustomer,
        createdInStripe: false,
        createdPlaceholder: false,
      };
    }

    if (!localCustomer) {
      const { data, error } = await supabaseAdmin
        .from('billing_customers')
        .upsert({ user_id: parsedInput.data.userId }, { onConflict: 'user_id' })
        .select(BILLING_CUSTOMER_SELECT)
        .maybeSingle();

      if (error) {
        throw error;
      }

      localCustomer = data;
      createdPlaceholder = true;
    }

    if (localCustomer?.stripe_customer_id) {
      return {
        userId: parsedInput.data.userId,
        stripeCustomerId: localCustomer.stripe_customer_id,
        customer: localCustomer,
        createdInStripe: false,
        createdPlaceholder,
      };
    }

    const idempotencyHash = hashUserIdForIdempotency(parsedInput.data.userId);
    const stripeCustomer = await stripe.customers.create(
      {
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
      },
      {
        idempotencyKey: `billing_customer_${idempotencyHash.slice(0, 24)}`,
      }
    );

    const { data: updatedCustomer, error: updateError } = await supabaseAdmin
      .from('billing_customers')
      .update({ stripe_customer_id: stripeCustomer.id })
      .eq('user_id', parsedInput.data.userId)
      .is('stripe_customer_id', null)
      .select(BILLING_CUSTOMER_SELECT)
      .maybeSingle();

    if (updateError) {
      throw updateError;
    }

    if (updatedCustomer?.stripe_customer_id) {
      return {
        userId: parsedInput.data.userId,
        stripeCustomerId: updatedCustomer.stripe_customer_id,
        customer: updatedCustomer,
        createdInStripe: true,
        createdPlaceholder,
      };
    }

    const racedCustomer = await loadBillingCustomerByUserId(parsedInput.data.userId, supabaseAdmin);

    if (racedCustomer?.stripe_customer_id) {
      return {
        userId: parsedInput.data.userId,
        stripeCustomerId: racedCustomer.stripe_customer_id,
        customer: racedCustomer,
        createdInStripe: false,
        createdPlaceholder,
      };
    }

    throw createBillingError(
      'Stripe customer mapping could not be persisted',
      'BILLING_CUSTOMER_PERSIST_FAILED'
    );
  } catch (error) {
    log.error(
      {
        err: error,
        operation: 'getOrCreateStripeCustomer',
        userIdHash,
        hasEmail: !!normalizedEmail,
      },
      'Failed to resolve Stripe customer mapping'
    );
    throw error;
  }
}

/**
 * Fetch the canonical Stripe subscription and reconcile it into local billing
 * state.
 *
 * Use `mode: "event"` for webhook-driven syncs that must honor the
 * last_stripe_event_created ordering gate. Use `mode: "authoritative"` for
 * server-controlled reconciles that should overwrite business fields without
 * erasing the existing staleness key when no new event timestamp is present.
 *
 * This helper rejects invalid ids, invalid sync modes, missing eventCreated for
 * event mode, missing/deleted customer objects, unsupported statuses, and
 * livemode mismatches before any billing-table write occurs.
 *
 * `unsupported_status_ignored` means the Stripe subscription was fetched but no
 * local write occurred; the prior local entitlement can remain in place until a
 * later supported sync or manual intervention.
 *
 * @param {string} subscriptionId
 * @param {{ mode: 'event' | 'authoritative', eventCreated?: number | string | Date }} options
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function syncSubscriptionFromStripe(
  subscriptionId,
  options,
  log = defaultLogger
) {
  const parsedSubscriptionId = nonEmptyStringSchema.safeParse(subscriptionId);

  if (!parsedSubscriptionId.success) {
    throw createBillingError('Invalid Stripe subscription id');
  }

  const parsedOptions = parseSyncSubscriptionOptions(options);

  try {
    const stripeSubscription = await stripe.subscriptions.retrieve(parsedSubscriptionId.data, {
      expand: ['customer', 'items.data.price'],
    });
    const stripeCustomerId = extractStripeCustomerId(stripeSubscription?.customer);

    if (!stripeCustomerId) {
      throw createBillingError(
        'Stripe subscription is missing a customer id',
        'BILLING_CUSTOMER_ID_MISSING'
      );
    }

    assertStripeLivemode(stripeSubscription?.livemode, {
      operation: 'syncSubscriptionFromStripe',
      stripeSubscriptionId: parsedSubscriptionId.data,
      log,
    });

    const localCustomer = await loadBillingCustomerByStripeCustomerId(stripeCustomerId, supabaseAdmin);

    if (!localCustomer?.user_id) {
      log.warn(
        {
          operation: 'syncSubscriptionFromStripe',
          stripeCustomerId: formatStripeIdForLog(stripeCustomerId, 'warn'),
          stripeSubscriptionId: formatStripeIdForLog(parsedSubscriptionId.data, 'warn'),
        },
        'Skipping Stripe subscription sync because no local customer mapping exists'
      );
      return {
        outcome: BILLING_WRITE_OUTCOMES.CUSTOMER_NOT_FOUND,
        userId: null,
        subscription: stripeSubscription,
        localSubscription: null,
      };
    }

    const classifiedStatus = classifyStripeStatus(stripeSubscription.status);

    if (!classifiedStatus.isSupported) {
      logUnsupportedStripeStatus(log, {
        operation: 'syncSubscriptionFromStripe',
        userId: localCustomer.user_id,
        status: classifiedStatus.normalizedStatus || '[empty]',
        stripeSubscriptionId: parsedSubscriptionId.data,
      });

      return {
        outcome: BILLING_WRITE_OUTCOMES.UNSUPPORTED_STATUS_IGNORED,
        userId: localCustomer.user_id,
        subscription: stripeSubscription,
        localSubscription: null,
      };
    }

    if (parsedOptions.mode === BILLING_SYNC_MODES.EVENT) {
      const localSubscription = await loadBillingSubscriptionByUserId(localCustomer.user_id, supabaseAdmin);

      if (isOlderStripeEvent(localSubscription?.last_stripe_event_created, parsedOptions.eventCreated)) {
        log.info(
          {
            operation: 'syncSubscriptionFromStripe',
            stripeSubscriptionId: formatStripeIdForLog(parsedSubscriptionId.data, 'info'),
            userIdHash: hashUserIdForLog(localCustomer.user_id),
          },
          'Ignoring stale Stripe subscription event during sync'
        );
        return {
          outcome: STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED,
          userId: localCustomer.user_id,
          subscription: stripeSubscription,
          localSubscription,
        };
      }

      const rpcResult = await callSubscriptionEventRpc(
        buildEventDrivenSubscriptionPayload({
          userId: localCustomer.user_id,
          stripeSubscriptionId: stripeSubscription.id,
          stripeCustomerId,
          priceId: extractStripePriceId(stripeSubscription),
          status: classifiedStatus.normalizedStatus,
          currentPeriodEnd: toIsoTimestamp(stripeSubscription.current_period_end),
          cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
          eventCreated: parsedOptions.eventCreated,
        })
      );

      return {
        outcome: rpcResult.applied
          ? BILLING_WRITE_OUTCOMES.PROCESSED
          : STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED,
        userId: localCustomer.user_id,
        subscription: stripeSubscription,
        localSubscription: rpcResult.subscription,
      };
    }

    const rpcResult = await callSubscriptionAuthoritativeRpc(
      buildAuthoritativeSubscriptionPayload({
        userId: localCustomer.user_id,
        stripeSubscriptionId: stripeSubscription.id,
        stripeCustomerId,
        priceId: extractStripePriceId(stripeSubscription),
        status: classifiedStatus.normalizedStatus,
        currentPeriodEnd: toIsoTimestamp(stripeSubscription.current_period_end),
        cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
        lastStripeEventCreated: parsedOptions.eventCreated,
      })
    );

    return {
      outcome: BILLING_WRITE_OUTCOMES.PROCESSED,
      userId: localCustomer.user_id,
      subscription: stripeSubscription,
      localSubscription: rpcResult.subscription,
    };
  } catch (error) {
    log.error(
      {
        err: error,
        operation: 'syncSubscriptionFromStripe',
        stripeSubscriptionId: formatStripeIdForLog(parsedSubscriptionId.data, 'error'),
      },
      'Failed to sync Stripe subscription into local billing state'
    );
    throw error;
  }
}

/**
 * Record a canonical receipt row for one Stripe event after JS validation has
 * succeeded.
 *
 * Validation remains in JS so malformed event payloads never reach the RPC.
 * The database function handles only the race-sensitive merge semantics and
 * returns an explicit outcome plus the final/current receipt row.
 *
 * @param {object} event
 * @param {string} result
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function recordStripeEventReceipt(event, result, log = defaultLogger) {
  const parsedEvent = stripeReceiptEventSchema.safeParse(event);
  const parsedResult = stripeReceiptResultSchema.safeParse(result);

  if (!parsedEvent.success || !parsedResult.success) {
    throw createBillingError('Invalid Stripe event receipt input');
  }

  const eventCreated = toIsoTimestamp(parsedEvent.data.created);

  if (!eventCreated) {
    throw createBillingError('Stripe event receipt is missing a valid created timestamp');
  }

  try {
    assertStripeLivemode(parsedEvent.data.livemode, {
      operation: 'recordStripeEventReceipt',
      stripeEventId: parsedEvent.data.id,
      log,
    });

    const rpcResult = await callStripeEventReceiptMergeRpc({
      eventId: parsedEvent.data.id,
      eventType: parsedEvent.data.type,
      livemode: parsedEvent.data.livemode,
      stripeEventCreated: eventCreated,
      result: parsedResult.data,
    });

    return rpcResult;
  } catch (error) {
    log.error(
      {
        err: error,
        operation: 'recordStripeEventReceipt',
        stripeEventId: formatStripeIdForLog(parsedEvent.data.id, 'error'),
      },
      'Failed to record Stripe event receipt'
    );
    throw error;
  }
}

/**
 * Preserve a terminal local snapshot for a Stripe subscription deletion event.
 *
 * `eventMeta` is required so livemode and eventCreated remain coupled to the
 * event envelope. The helper validates those fields, rejects livemode
 * mismatches before any billing-table access, keeps the JS stale-event check as
 * a fast path, and relies on the event RPC as the atomic correctness boundary.
 *
 * @param {object} subscription
 * @param {{ eventCreated: number | string | Date, livemode: boolean }} eventMeta
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function markSubscriptionDeletedFromEvent(
  subscription,
  eventMeta,
  log = defaultLogger
) {
  const subscriptionId = nonEmptyStringSchema.safeParse(subscription?.id);
  const parsedEventMeta = stripeDeleteEventMetaSchema.safeParse(eventMeta);
  const eventCreatedIso = parsedEventMeta.success
    ? toIsoTimestamp(parsedEventMeta.data.eventCreated)
    : null;

  if (!subscriptionId.success || !parsedEventMeta.success || !eventCreatedIso) {
    throw createBillingError('Invalid Stripe subscription delete event input');
  }

  const stripeCustomerId = extractStripeCustomerId(subscription?.customer);

  if (!stripeCustomerId) {
    throw createBillingError(
      'Stripe subscription delete event is missing a customer id',
      'BILLING_CUSTOMER_ID_MISSING'
    );
  }

  try {
    assertStripeLivemode(parsedEventMeta.data.livemode, {
      operation: 'markSubscriptionDeletedFromEvent',
      stripeSubscriptionId: subscriptionId.data,
      log,
    });

    const localCustomer = await loadBillingCustomerByStripeCustomerId(stripeCustomerId, supabaseAdmin);

    if (!localCustomer?.user_id) {
      log.warn(
        {
          operation: 'markSubscriptionDeletedFromEvent',
          stripeCustomerId: formatStripeIdForLog(stripeCustomerId, 'warn'),
          stripeSubscriptionId: formatStripeIdForLog(subscriptionId.data, 'warn'),
        },
        'Skipping delete snapshot because no local customer mapping exists'
      );
      return {
        outcome: BILLING_WRITE_OUTCOMES.CUSTOMER_NOT_FOUND,
        userId: null,
        localSubscription: null,
      };
    }

    const localSubscription = await loadBillingSubscriptionByUserId(localCustomer.user_id, supabaseAdmin);

    if (isOlderStripeEvent(localSubscription?.last_stripe_event_created, eventCreatedIso)) {
      log.info(
        {
          operation: 'markSubscriptionDeletedFromEvent',
          stripeSubscriptionId: formatStripeIdForLog(subscriptionId.data, 'info'),
          userIdHash: hashUserIdForLog(localCustomer.user_id),
        },
        'Ignoring stale Stripe subscription delete event'
      );
      return {
        outcome: STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED,
        userId: localCustomer.user_id,
        localSubscription,
      };
    }

    // Delete payloads can be partial, so JS merges the event snapshot with the
    // existing row before the atomic event RPC enforces ordering.
    const rpcResult = await callSubscriptionEventRpc(
      buildEventDrivenSubscriptionPayload({
        userId: localCustomer.user_id,
        stripeSubscriptionId: subscriptionId.data,
        stripeCustomerId,
        priceId: extractStripePriceId(subscription) || localSubscription?.price_id || null,
        status: BILLING_SUBSCRIPTION_STATUSES.CANCELED,
        currentPeriodEnd:
          toIsoTimestamp(subscription?.current_period_end) || localSubscription?.current_period_end || null,
        cancelAtPeriodEnd:
          subscription?.cancel_at_period_end ?? localSubscription?.cancel_at_period_end ?? false,
        eventCreated: eventCreatedIso,
      })
    );

    return {
      outcome: rpcResult.applied
        ? BILLING_WRITE_OUTCOMES.PROCESSED
        : STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED,
      userId: localCustomer.user_id,
      localSubscription: rpcResult.subscription,
    };
  } catch (error) {
    log.error(
      {
        err: error,
        operation: 'markSubscriptionDeletedFromEvent',
        stripeSubscriptionId: formatStripeIdForLog(subscriptionId.data, 'error'),
      },
      'Failed to persist local delete snapshot for Stripe subscription event'
    );
    throw error;
  }
}
