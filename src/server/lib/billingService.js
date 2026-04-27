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
import { stripe } from './stripe.js';
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
const STRIPE_EVENT_RECEIPT_SELECT = [
  'event_id',
  'event_type',
  'livemode',
  'processed_at',
  'stripe_event_created',
  'result',
].join(', ');

export const STRIPE_EVENT_RECEIPT_RESULTS = Object.freeze({
  PROCESSED: 'processed',
  DUPLICATE_IGNORED: 'duplicate_ignored',
  STALE_IGNORED: 'stale_ignored',
  FAILED: 'failed',
});

const ALLOWED_BILLING_STATUSES = new Set(Object.values(BILLING_SUBSCRIPTION_STATUSES));
const STRIPE_EVENT_RECEIPT_RESULT_VALUES = Object.values(STRIPE_EVENT_RECEIPT_RESULTS);

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

function createBillingError(message, code = 'BILLING_INVALID_INPUT') {
  const error = new Error(message);
  error.code = code;
  return error;
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

function hashUserId(userId) {
  if (typeof userId !== 'string' || userId.length === 0) {
    return null;
  }

  return crypto.createHash('sha256').update(userId).digest('hex');
}

function isLoggerCandidate(value) {
  return (
    !!value
    && typeof value === 'object'
    && ['info', 'warn', 'error', 'debug'].every((method) => typeof value[method] === 'function')
  );
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

function assertSupportedStripeStatus(status) {
  const normalizedStatus = normalizeStripeStatus(status);

  if (!ALLOWED_BILLING_STATUSES.has(normalizedStatus)) {
    throw createBillingError(
      `Unsupported Stripe subscription status: ${normalizedStatus || '[empty]'}`,
      'BILLING_SUBSCRIPTION_STATUS_INVALID'
    );
  }

  return normalizedStatus;
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

async function loadBillingCustomerByUserId(userId, client = supabaseAdmin) {
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

async function loadBillingCustomerByStripeCustomerId(stripeCustomerId, client = supabaseAdmin) {
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

async function loadBillingSubscriptionByUserId(userId, client = supabaseAdmin) {
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

async function loadStripeEventReceiptById(eventId, client = supabaseAdmin) {
  const { data, error } = await client
    .from('stripe_event_receipts')
    .select(STRIPE_EVENT_RECEIPT_SELECT)
    .eq('event_id', eventId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

function buildSubscriptionUpsertPayload({
  userId,
  stripeSubscriptionId,
  stripeCustomerId,
  priceId,
  status,
  currentPeriodEnd,
  cancelAtPeriodEnd = false,
  eventCreated,
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

  const lastStripeEventCreated = toIsoTimestamp(eventCreated);

  if (lastStripeEventCreated) {
    payload.last_stripe_event_created = lastStripeEventCreated;
  }

  return payload;
}

async function upsertBillingSubscription(payload) {
  const { data, error } = await supabaseAdmin
    .from('billing_subscriptions')
    .upsert(payload, { onConflict: 'user_id' })
    .select(BILLING_SUBSCRIPTION_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

function parseSyncArgs(optionsOrLog, maybeLog) {
  if (isLoggerCandidate(optionsOrLog)) {
    return { options: {}, log: optionsOrLog };
  }

  return {
    options: optionsOrLog && typeof optionsOrLog === 'object' ? optionsOrLog : {},
    log: isLoggerCandidate(maybeLog) ? maybeLog : defaultLogger,
  };
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
 * Read the canonical local billing state for one user using the caller's
 * Supabase client where possible.
 *
 * @param {string} userId
 * @param {import('@supabase/supabase-js').SupabaseClient} clientOrAdmin
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function getLocalBillingStatus(
  userId,
  clientOrAdmin = supabaseAdmin,
  log = defaultLogger
) {
  if (!userId || !clientOrAdmin?.from) {
    log.error(
      {
        operation: 'getLocalBillingStatus',
        hasUserId: !!userId,
        hasSupabaseClient: !!clientOrAdmin,
      },
      'Billing status resolver is missing required inputs'
    );
    return createEmptyBillingStatus();
  }

  const userIdHash = hashUserId(userId);

  try {
    const [customer, subscription] = await Promise.all([
      loadBillingCustomerByUserId(userId, clientOrAdmin),
      loadBillingSubscriptionByUserId(userId, clientOrAdmin),
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
 * Resolve the canonical storage tier from local billing state for a user.
 *
 * This is intentionally server-side and database-backed. Auth metadata is not
 * authoritative for premium storage decisions.
 *
 * @param {string} userId
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {object} log
 * @returns {Promise<string>}
 */
export async function resolveStorageEntitlement(
  userId,
  supabaseClient = supabaseAdmin,
  log = defaultLogger
) {
  const billingStatus = await getLocalBillingStatus(userId, supabaseClient, log);
  return billingStatus.tier;
}

/**
 * Resolve access to the AI tailor feature from canonical local billing state.
 *
 * @param {string} userId
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function resolveTailorEntitlement(userId, log = defaultLogger) {
  const billingStatus = await getLocalBillingStatus(userId, supabaseAdmin, log);

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

  const userIdHash = hashUserId(parsedInput.data.userId);
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

    const stripeCustomer = await stripe.customers.create(
      {
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
      },
      {
        idempotencyKey: `billing_customer_${userIdHash?.slice(0, 24) ?? 'unknown'}`,
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
 * Fetch the current canonical Stripe subscription and reconcile it into the
 * local billing_subscriptions row for the mapped user.
 *
 * @param {string} subscriptionId
 * @param {object | undefined} optionsOrLog
 * @param {object | undefined} maybeLog
 * @returns {Promise<object>}
 */
export async function syncSubscriptionFromStripe(
  subscriptionId,
  optionsOrLog,
  maybeLog
) {
  const parsedSubscriptionId = nonEmptyStringSchema.safeParse(subscriptionId);

  if (!parsedSubscriptionId.success) {
    throw createBillingError('Invalid Stripe subscription id');
  }

  const { options, log } = parseSyncArgs(optionsOrLog, maybeLog);
  const eventCreated = toIsoTimestamp(options?.eventCreated);

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

    const localCustomer = await loadBillingCustomerByStripeCustomerId(stripeCustomerId, supabaseAdmin);

    if (!localCustomer?.user_id) {
      log.warn(
        {
          operation: 'syncSubscriptionFromStripe',
          stripeCustomerId,
          stripeSubscriptionId: parsedSubscriptionId.data,
        },
        'Skipping Stripe subscription sync because no local customer mapping exists'
      );
      return {
        outcome: 'customer_not_found',
        userId: null,
        subscription: stripeSubscription,
        localSubscription: null,
      };
    }

    const localSubscription = await loadBillingSubscriptionByUserId(localCustomer.user_id, supabaseAdmin);

    if (eventCreated && isOlderStripeEvent(localSubscription?.last_stripe_event_created, eventCreated)) {
      log.info(
        {
          operation: 'syncSubscriptionFromStripe',
          stripeSubscriptionId: parsedSubscriptionId.data,
          userIdHash: hashUserId(localCustomer.user_id),
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

    const syncedLocalSubscription = await upsertBillingSubscription(
      buildSubscriptionUpsertPayload({
        userId: localCustomer.user_id,
        stripeSubscriptionId: stripeSubscription.id,
        stripeCustomerId,
        priceId: extractStripePriceId(stripeSubscription),
        status: assertSupportedStripeStatus(stripeSubscription.status),
        currentPeriodEnd: toIsoTimestamp(stripeSubscription.current_period_end),
        cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
        eventCreated,
      })
    );

    return {
      outcome: 'processed',
      userId: localCustomer.user_id,
      subscription: stripeSubscription,
      localSubscription: syncedLocalSubscription,
    };
  } catch (error) {
    log.error(
      {
        err: error,
        operation: 'syncSubscriptionFromStripe',
        stripeSubscriptionId: parsedSubscriptionId.data,
      },
      'Failed to sync Stripe subscription into local billing state'
    );
    throw error;
  }
}

/**
 * Record a canonical receipt row for one Stripe event without downgrading an
 * already-processed receipt on later duplicate or failed attempts.
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
    const existingReceipt = await loadStripeEventReceiptById(parsedEvent.data.id, supabaseAdmin);

    if (existingReceipt?.result === STRIPE_EVENT_RECEIPT_RESULTS.PROCESSED) {
      return {
        outcome: 'preserved_existing',
        receipt: existingReceipt,
      };
    }

    if (!existingReceipt) {
      const { data, error } = await supabaseAdmin
        .from('stripe_event_receipts')
        .insert({
          event_id: parsedEvent.data.id,
          event_type: parsedEvent.data.type,
          livemode: parsedEvent.data.livemode,
          stripe_event_created: eventCreated,
          result: parsedResult.data,
        })
        .select(STRIPE_EVENT_RECEIPT_SELECT)
        .single();

      if (error) {
        if (error.code === '23505') {
          const racedReceipt = await loadStripeEventReceiptById(parsedEvent.data.id, supabaseAdmin);
          return {
            outcome: 'preserved_existing',
            receipt: racedReceipt,
          };
        }

        throw error;
      }

      return {
        outcome: 'recorded',
        receipt: data,
      };
    }

    if (existingReceipt.result === parsedResult.data) {
      return {
        outcome: 'already_recorded',
        receipt: existingReceipt,
      };
    }

    const { data, error } = await supabaseAdmin
      .from('stripe_event_receipts')
      .update({
        event_type: parsedEvent.data.type,
        livemode: parsedEvent.data.livemode,
        stripe_event_created: eventCreated,
        result: parsedResult.data,
      })
      .eq('event_id', parsedEvent.data.id)
      .select(STRIPE_EVENT_RECEIPT_SELECT)
      .single();

    if (error) {
      throw error;
    }

    return {
      outcome: 'updated',
      receipt: data,
    };
  } catch (error) {
    log.error(
      {
        err: error,
        operation: 'recordStripeEventReceipt',
        stripeEventId: parsedEvent.data.id,
      },
      'Failed to record Stripe event receipt'
    );
    throw error;
  }
}

/**
 * Preserve a terminal local snapshot for a Stripe subscription deletion event.
 *
 * @param {object} subscription
 * @param {number | string | Date} eventCreated
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function markSubscriptionDeletedFromEvent(
  subscription,
  eventCreated,
  log = defaultLogger
) {
  const subscriptionId = nonEmptyStringSchema.safeParse(subscription?.id);
  const eventCreatedIso = toIsoTimestamp(eventCreated);

  if (!subscriptionId.success || !eventCreatedIso) {
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
    const localCustomer = await loadBillingCustomerByStripeCustomerId(stripeCustomerId, supabaseAdmin);

    if (!localCustomer?.user_id) {
      log.warn(
        {
          operation: 'markSubscriptionDeletedFromEvent',
          stripeCustomerId,
          stripeSubscriptionId: subscriptionId.data,
        },
        'Skipping delete snapshot because no local customer mapping exists'
      );
      return {
        outcome: 'customer_not_found',
        userId: null,
        localSubscription: null,
      };
    }

    const localSubscription = await loadBillingSubscriptionByUserId(localCustomer.user_id, supabaseAdmin);

    if (isOlderStripeEvent(localSubscription?.last_stripe_event_created, eventCreatedIso)) {
      log.info(
        {
          operation: 'markSubscriptionDeletedFromEvent',
          stripeSubscriptionId: subscriptionId.data,
          userIdHash: hashUserId(localCustomer.user_id),
        },
        'Ignoring stale Stripe subscription delete event'
      );
      return {
        outcome: STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED,
        userId: localCustomer.user_id,
        localSubscription,
      };
    }

    const deletedSnapshot = await upsertBillingSubscription(
      buildSubscriptionUpsertPayload({
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
      outcome: 'processed',
      userId: localCustomer.user_id,
      localSubscription: deletedSnapshot,
    };
  } catch (error) {
    log.error(
      {
        err: error,
        operation: 'markSubscriptionDeletedFromEvent',
        stripeSubscriptionId: subscriptionId.data,
      },
      'Failed to persist local delete snapshot for Stripe subscription event'
    );
    throw error;
  }
}
