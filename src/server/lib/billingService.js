import crypto from 'crypto';
import { z } from 'zod';
import { logger as defaultLogger } from '../../shared/logger.js';
import { ERROR_MESSAGES } from '../../shared/errors.js';
import {
  BILLING_ENTITLEMENTS,
  BILLING_PLANS,
  BILLING_PLAN_PRICE_ENV_VARS,
  BILLING_SUBSCRIPTION_STATUSES,
  ENTITLED_BILLING_STATUSES,
  PAYMENT_RECOVERY_BILLING_STATUSES,
  STORAGE_CREATE_ACTIONS,
  STORAGE_CREATE_ERROR_CODES,
  STORAGE_STATUSES,
} from '../../shared/constants/billing.js';
import { TIERS } from '../../shared/constants/tiers.js';
import { getConfiguredStripeMode, getStripeClient } from './stripeRuntime.js';
import { supabaseAdmin } from './supabaseServer.js';

const BILLING_CUSTOMER_SELECT = 'user_id, stripe_customer_id, last_synced_stripe_email_fingerprint, created_at, updated_at';
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
const BILLING_CHECKOUT_SESSION_SELECT = [
  'id',
  'user_id',
  'plan',
  'stripe_checkout_session_id',
  'checkout_url',
  'status',
  'expires_at',
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
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  STALE_IGNORED: 'stale_ignored',
  FAILED: 'failed',
});

export const BILLING_SYNC_MODES = Object.freeze({
  EVENT: 'event',
  AUTHORITATIVE: 'authoritative',
});

export const BILLING_WRITE_OUTCOMES = Object.freeze({
  PROCESSED: 'processed',
  STALE_IGNORED: 'stale_ignored',
  CUSTOMER_NOT_FOUND: 'customer_not_found',
  UNSUPPORTED_STATUS_IGNORED: 'unsupported_status_ignored',
});

export const CHECKOUT_STATUS_STATES = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  FREE: 'free',
  ERROR: 'error',
});

export const PENDING_CHECKOUT_SESSION_STATUSES = Object.freeze({
  CREATING: 'creating',
  OPEN: 'open',
  COMPLETE: 'complete',
  EXPIRED: 'expired',
  FAILED: 'failed',
});

export const PENDING_CHECKOUT_SESSION_OUTCOMES = Object.freeze({
  CLAIMED: 'claimed',
  REUSED: 'reused',
  CREATING: 'creating',
});

const ALLOWED_BILLING_STATUSES = new Set(Object.values(BILLING_SUBSCRIPTION_STATUSES));
const BILLING_PLAN_VALUES = Object.values(BILLING_PLANS);
const CHECKOUT_ATTEMPT_NONCE_PATTERN = /^[A-Fa-f0-9]{32}$/;
const STRIPE_EVENT_RECEIPT_RESULT_VALUES = Object.values(STRIPE_EVENT_RECEIPT_RESULTS);
const BILLING_SYNC_MODE_VALUES = Object.values(BILLING_SYNC_MODES);
const PENDING_CHECKOUT_SESSION_STATUS_VALUES = Object.values(PENDING_CHECKOUT_SESSION_STATUSES);
const PENDING_CHECKOUT_SESSION_OUTCOME_VALUES = Object.values(PENDING_CHECKOUT_SESSION_OUTCOMES);
const CHECKOUT_START_ALLOWED_STATUSES = new Set([
  BILLING_SUBSCRIPTION_STATUSES.CANCELED,
  BILLING_SUBSCRIPTION_STATUSES.INCOMPLETE_EXPIRED,
]);
const TERMINAL_FREE_BILLING_STATUSES = new Set([
  BILLING_SUBSCRIPTION_STATUSES.CANCELED,
]);
const SYNC_PENDING_BILLING_STATUSES = new Set([
  BILLING_SUBSCRIPTION_STATUSES.INCOMPLETE,
]);
const STORAGE_RETRYABLE_STATUSES = new Set([
  STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING,
  STORAGE_STATUSES.BILLING_UNAVAILABLE,
]);
const TERMINAL_REPLACEABLE_SUBSCRIPTION_STATUSES = new Set([
  BILLING_SUBSCRIPTION_STATUSES.CANCELED,
  BILLING_SUBSCRIPTION_STATUSES.INCOMPLETE_EXPIRED,
]);
const FULL_BILLING_ID_LOG_LEVELS = new Set(['error', 'debug']);
const MAX_EVENT_CREATED_FUTURE_MS = 5 * 60 * 1000;
const PENDING_CHECKOUT_WAIT_ATTEMPTS = 9;
const PENDING_CHECKOUT_WAIT_DELAY_MS = 250;
const STRIPE_EVENT_RECEIPT_ENVELOPE_MISMATCH_PATTERN =
  /stripe_event_receipts envelope mismatch/i;

const nonEmptyStringSchema = z.string().trim().min(1);
const billingPlanSchema = z.enum(BILLING_PLAN_VALUES);
const checkoutAttemptNonceSchema = z.string()
  .trim()
  .regex(CHECKOUT_ATTEMPT_NONCE_PATTERN)
  .transform((nonce) => nonce.toLowerCase());
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
const stripeReceiptRowSchema = z.object({
  event_id: nonEmptyStringSchema,
  event_type: z.string().trim().min(1).max(255),
  livemode: z.boolean(),
  processed_at: nonEmptyStringSchema,
  stripe_event_created: nonEmptyStringSchema,
  result: stripeReceiptResultSchema,
}).passthrough();
const stripeDeleteEventMetaSchema = z.object({
  eventCreated: z.union([z.number().finite(), z.string().trim().min(1), z.date()]),
  livemode: z.boolean(),
});
const pendingCheckoutSessionIdSchema = z.union([
  z.number().int().positive(),
  nonEmptyStringSchema,
]);
const pendingCheckoutSessionRowSchema = z.object({
  id: pendingCheckoutSessionIdSchema,
  user_id: nonEmptyStringSchema,
  plan: billingPlanSchema,
  stripe_checkout_session_id: nonEmptyStringSchema.nullable().optional(),
  checkout_url: z.string().trim().url().nullable().optional(),
  status: z.enum(PENDING_CHECKOUT_SESSION_STATUS_VALUES),
  expires_at: nonEmptyStringSchema.nullable().optional(),
  created_at: nonEmptyStringSchema.optional(),
  updated_at: nonEmptyStringSchema.optional(),
}).passthrough();
const pendingCheckoutClaimInputSchema = z.object({
  userId: nonEmptyStringSchema,
  plan: billingPlanSchema,
  checkoutAttemptNonce: checkoutAttemptNonceSchema,
});
const pendingCheckoutFinalizeInputSchema = z.object({
  userId: nonEmptyStringSchema,
  id: pendingCheckoutSessionIdSchema,
  stripeCheckoutSessionId: nonEmptyStringSchema,
  checkoutUrl: z.string().trim().url(),
  expiresAt: nonEmptyStringSchema,
});
const pendingCheckoutFailInputSchema = z.object({
  userId: nonEmptyStringSchema,
  id: pendingCheckoutSessionIdSchema,
});
const pendingCheckoutLookupInputSchema = z.object({
  userId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
});
const pendingCheckoutTerminalInputSchema = z.object({
  userId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  status: z.enum([
    PENDING_CHECKOUT_SESSION_STATUSES.COMPLETE,
    PENDING_CHECKOUT_SESSION_STATUSES.EXPIRED,
  ]),
});
const pendingCheckoutTerminalBySessionIdInputSchema = z.object({
  sessionId: nonEmptyStringSchema,
  status: z.enum([
    PENDING_CHECKOUT_SESSION_STATUSES.COMPLETE,
    PENDING_CHECKOUT_SESSION_STATUSES.EXPIRED,
  ]),
});
const pendingCheckoutWaitInputSchema = z.object({
  userId: nonEmptyStringSchema,
  plan: billingPlanSchema,
});

/**
 * Create a typed billing error shared across the service layer.
 *
 * Purpose: keep route and webhook error-code checks stable, and let helpers
 * mark errors that already emitted their own structured log entry so callers do
 * not double-log the same failure.
 *
 * @param {string} message
 * @param {string} [code='BILLING_INVALID_INPUT']
 * @param {{ billingAlreadyLogged?: boolean }} [options]
 * @returns {Error & { code: string, billingAlreadyLogged?: boolean }}
 */
function createBillingError(message, code = 'BILLING_INVALID_INPUT', options = {}) {
  const error = new Error(message);
  error.code = code;
  if (options.billingAlreadyLogged) {
    error.billingAlreadyLogged = true;
  }
  return error;
}

/**
 * Specialize invalid-response errors from billing RPC boundaries.
 *
 * Purpose: distinguish malformed or unexpected database procedure payloads
 * from upstream Supabase transport failures so reconcile callers can treat
 * contract drift as a billing-logic problem.
 *
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function createBillingRpcError(message) {
  return createBillingError(message, 'BILLING_RPC_INVALID_RESPONSE');
}

/**
 * Specialize ownership mismatches detected during user-scoped billing syncs.
 *
 * Purpose: let authenticated routes distinguish cross-user reconcile attempts
 * from retryable provider failures and fail closed before any authoritative
 * billing write lands on the wrong local user.
 *
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function createBillingOwnershipError(message) {
  return createBillingError(message, 'BILLING_OWNERSHIP_MISMATCH', { billingAlreadyLogged: true });
}

/**
 * Detect the fixed database integrity error for mismatched receipt envelopes.
 *
 * Purpose: the RPC may return a database-native error object, so service
 * callers need a narrow check that can replace it before generic catch blocks
 * log raw SQL error metadata.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isStripeEventReceiptEnvelopeMismatchError(error) {
  return STRIPE_EVENT_RECEIPT_ENVELOPE_MISMATCH_PATTERN.test(error?.message ?? '');
}

/**
 * Log and replace a receipt envelope mismatch with a safe coded error.
 *
 * Purpose: keep the structured monitoring signal while preventing raw
 * database error details from flowing into route or dispatcher catch blocks.
 *
 * @param {object} log
 * @param {{ operation: string, stripeEventId: string, message: string }} params
 * @returns {Error & { code: string, billingAlreadyLogged?: boolean }}
 */
function createSanitizedStripeEventReceiptEnvelopeMismatchError(log, {
  operation,
  stripeEventId,
  message,
}) {
  log.error(
    {
      event: 'billing_event_receipt_envelope_mismatch',
      operation,
      stripeEventId: formatStripeIdForLog(stripeEventId, 'error'),
    },
    message
  );

  return createBillingError(
    'Stripe event receipt envelope mismatch',
    'BILLING_EVENT_RECEIPT_ENVELOPE_MISMATCH',
    { billingAlreadyLogged: true }
  );
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

/**
 * Canonicalize an email only for fingerprint dedupe comparisons.
 *
 * Purpose: treat casing-only and incidental whitespace changes as the same
 * logical email for the optimization field, while leaving the actual email
 * sent to Stripe on the existing trim-only path.
 *
 * @param {string | null | undefined} email
 * @returns {string}
 */
function normalizeEmailForFingerprint(email) {
  return normalizeEmail(email).toLowerCase();
}

function normalizeLogLevel(level) {
  return typeof level === 'string' ? level.trim().toLowerCase() : 'info';
}

function isTruthyEnvFlag(value) {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

const BILLING_LOG_HASH_SECRET = normalizeString(process.env.BILLING_LOG_HASH_SECRET);
let hasLoggedMissingEmailFingerprintSecret = false;

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

/**
 * Read the optional billing email fingerprint secret without failing startup.
 *
 * Purpose: the email-sync dedupe is an optimization, so missing runtime
 * configuration should warn and fall back to the existing Stripe sync path
 * instead of blocking billing flows.
 *
 * @param {object} log
 * @returns {string | null}
 */
function getBillingEmailFingerprintSecret(log = defaultLogger) {
  const secret = normalizeString(process.env.BILLING_EMAIL_FINGERPRINT_SECRET);

  if (!secret && !hasLoggedMissingEmailFingerprintSecret) {
    hasLoggedMissingEmailFingerprintSecret = true;
    log.warn(
      { event: 'billing_email_fingerprint_secret_missing' },
      'BILLING_EMAIL_FINGERPRINT_SECRET is missing; skipping Stripe email fingerprint dedupe'
    );
  }

  return secret || null;
}

/**
 * Build the keyed email fingerprint stored after a confirmed Stripe sync.
 *
 * Purpose: avoid repeated no-op `stripe.customers.update(...)` calls while
 * keeping the optimization field non-reversible and independent from the raw
 * email value stored by Stripe.
 *
 * @param {string} normalizedEmail
 * @param {string} secret
 * @returns {string}
 */
function buildStripeEmailFingerprint(normalizedEmail, secret) {
  return crypto.createHmac('sha256', secret).update(normalizedEmail).digest('hex');
}

/**
 * Reduce provider and persistence failures to a safe structured log payload.
 *
 * Purpose: keep warning logs useful for debugging billing sync failures
 * without dumping large error objects or unexpected nested fields.
 *
 * @param {unknown} error
 * @returns {{ name: unknown, code: unknown, message: unknown }}
 */
function sanitizeStripeSyncErrorForLog(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message,
  };
}

/**
 * Detect whether a caller supplied a structured logger compatible with the
 * billing service's expected methods.
 *
 * Purpose: allow injected request loggers when present while still failing
 * back to the shared logger for background or test-driven entry points.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isLoggerCandidate(value) {
  return (
    !!value
    && typeof value === 'object'
    && ['info', 'warn', 'error', 'debug'].every((method) => typeof value[method] === 'function')
  );
}

/**
 * Guard the request-scoped Supabase read path before any local billing lookup.
 *
 * Purpose: getLocalBillingStatus() and loadBillingStatusOrThrow() intentionally
 * fail closed when a caller forgets to pass a usable client instead of
 * silently widening reads through supabaseAdmin.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isSupabaseReadClientCandidate(value) {
  return !!value && typeof value === 'object' && typeof value.from === 'function';
}

/**
 * Normalize mixed Stripe and webhook timestamp inputs into one ISO-8601 shape.
 *
 * Accepts unix seconds, ISO-ish strings, and Date instances because Stripe
 * event metadata, route inputs, and test fixtures do not all arrive in the
 * same type. Invalid or empty inputs collapse to null so validation stays
 * explicit at the call site.
 *
 * @param {number | string | Date | null | undefined} value
 * @returns {string | null}
 */
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

/**
 * Compare the last applied Stripe event timestamp with an incoming event.
 *
 * Purpose: stale event-driven writes must be ignored so out-of-order webhooks
 * do not roll canonical local state backward. Unparseable timestamps are
 * treated as non-stale here because entry-point validation happens elsewhere.
 *
 * @param {string | number | Date | null | undefined} localLastEventCreated
 * @param {string | number | Date | null | undefined} incomingEventCreated
 * @returns {boolean}
 */
function isOlderStripeEvent(localLastEventCreated, incomingEventCreated) {
  const localTimestamp = toIsoTimestamp(localLastEventCreated);
  const incomingTimestamp = toIsoTimestamp(incomingEventCreated);

  if (!localTimestamp || !incomingTimestamp) {
    return false;
  }

  return new Date(incomingTimestamp).getTime() < new Date(localTimestamp).getTime();
}

/**
 * Reject obviously future-dated Stripe event timestamps beyond small clock skew.
 *
 * Purpose: protect event-driven and receipt flows from malformed payloads or
 * replay mistakes that would otherwise poison stale-write ordering with a far
 * future `last_stripe_event_created` value.
 *
 * @param {string} isoTimestamp
 * @param {string} message
 * @returns {string}
 */
function assertTimestampNotTooFarInFuture(isoTimestamp, message) {
  const timestampMs = new Date(isoTimestamp).getTime();

  if (timestampMs > Date.now() + MAX_EVENT_CREATED_FUTURE_MS) {
    throw createBillingError(message, 'BILLING_EVENT_TIMESTAMP_IN_FUTURE');
  }

  return isoTimestamp;
}

/**
 * Resolve a Stripe customer id from the expanded shapes Stripe may return.
 *
 * The customer field may already be a string id, an expanded customer object,
 * or a deleted-object tombstone. Delete flows must treat deleted objects as no
 * customer mapping instead of persisting the tombstone.
 *
 * @param {unknown} customer
 * @returns {string | null}
 */
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

/**
 * Resolve the Stripe price id from a subscription's line items.
 *
 * Purpose: canonical entitlement and local subscription persistence are keyed
 * to the configured price id, not to mutable product metadata. The legacy
 * `plan.id` fallback remains for older Stripe response shapes and test data.
 *
 * @param {object | null | undefined} subscription
 * @param {string | null | undefined} preferredPriceId trusted local price id
 * to prefer when it still exists in the Stripe item snapshot.
 * @returns {string | null}
 */
function extractStripePriceId(subscription, preferredPriceId = null) {
  const items = Array.isArray(subscription?.items?.data) ? subscription.items.data : [];
  const preferred = normalizePriceId(preferredPriceId);

  if (
    preferred
    && items.some((item) => (
      normalizePriceId(item?.price?.id) === preferred
      || normalizePriceId(item?.plan?.id) === preferred
    ))
  ) {
    return preferred;
  }

  for (const item of items) {
    const priceId = normalizePriceId(item?.price?.id);

    if (priceId) {
      return priceId;
    }
  }

  return normalizePriceId(subscription?.items?.data?.[0]?.plan?.id) || null;
}

/**
 * Resolve a subscription's current period end across Stripe API shapes.
 *
 * Purpose: Stripe API versions from 2025-03-31.basil onward expose period
 * fields on subscription items instead of the parent subscription. Local
 * renewal sweeps and monitoring still need a populated timestamp, so prefer
 * the item that owns the persisted price id before falling back to legacy
 * top-level data.
 *
 * @param {object | null | undefined} subscription
 * @param {string | null | undefined} preferredPriceId trusted local price id
 * to prefer when matching the period-owning Stripe item.
 * @returns {string | null}
 */
function extractStripeCurrentPeriodEnd(subscription, preferredPriceId = null) {
  const items = Array.isArray(subscription?.items?.data) ? subscription.items.data : [];
  const priceId = extractStripePriceId(subscription, preferredPriceId);
  const matchingItem = priceId
    ? items.find((item) => (
      normalizePriceId(item?.price?.id) === priceId
      || normalizePriceId(item?.plan?.id) === priceId
    ))
    : null;
  const orderedItems = matchingItem
    ? [matchingItem, ...items.filter((item) => item !== matchingItem)]
    : items;

  for (const item of orderedItems) {
    const itemCurrentPeriodEnd = toIsoTimestamp(item?.current_period_end);

    if (itemCurrentPeriodEnd) {
      return itemCurrentPeriodEnd;
    }
  }

  return toIsoTimestamp(subscription?.current_period_end);
}

function normalizeStripeStatus(status) {
  return typeof status === 'string' ? status.trim() : '';
}

/**
 * Normalize Supabase RPC JSON fields into a plain JS object when possible.
 *
 * Depending on the driver and test harness, RPC results may already be parsed
 * objects or raw JSON strings. This helper keeps the downstream payload-shape
 * assertions consistent across both cases.
 *
 * @param {unknown} data
 * @returns {unknown}
 */
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
 * Convert a billing_checkout_sessions row into the camelCase service shape.
 *
 * Purpose: routes should not trust raw database/RPC payloads directly, so this
 * helper validates the row contract and gives callers one normalized shape for
 * claim, finalize, fail, and lookup paths.
 *
 * @param {unknown} row
 * @param {string} message
 * @returns {object}
 */
function normalizePendingCheckoutSessionRow(row, message) {
  const parsedRow = pendingCheckoutSessionRowSchema.safeParse(row);

  if (!parsedRow.success) {
    throw createBillingRpcError(message);
  }

  return {
    id: parsedRow.data.id,
    userId: parsedRow.data.user_id,
    plan: parsedRow.data.plan,
    stripeCheckoutSessionId: parsedRow.data.stripe_checkout_session_id ?? null,
    checkoutUrl: parsedRow.data.checkout_url ?? null,
    status: parsedRow.data.status,
    expiresAt: parsedRow.data.expires_at ?? null,
    createdAt: parsedRow.data.created_at ?? null,
    updatedAt: parsedRow.data.updated_at ?? null,
  };
}

/**
 * Convert a stripe_event_receipts row into the service's camelCase shape.
 *
 * Purpose: webhook duplicate checks should not trust raw database payloads
 * directly, especially because envelope comparison is an integrity boundary.
 *
 * @param {unknown} row
 * @param {string} message
 * @returns {object}
 */
function normalizeStripeEventReceiptRow(row, message) {
  const parsedRow = stripeReceiptRowSchema.safeParse(row);

  if (!parsedRow.success) {
    throw createBillingRpcError(message);
  }

  return {
    eventId: parsedRow.data.event_id,
    eventType: parsedRow.data.event_type,
    livemode: parsedRow.data.livemode,
    processedAt: parsedRow.data.processed_at,
    stripeEventCreated: parsedRow.data.stripe_event_created,
    result: parsedRow.data.result,
    row: parsedRow.data,
  };
}

/**
 * Validate the pending-checkout claim RPC payload before routes trust it.
 *
 * Purpose: the database owns the race-sensitive claim decision, while this JS
 * boundary keeps malformed RPC responses from becoming checkout redirects.
 *
 * @param {unknown} data
 * @returns {{ outcome: string, session: object }}
 */
function normalizePendingCheckoutClaimRpcData(data) {
  const normalizedData = normalizeRpcJsonData(data);

  if (
    !normalizedData
    || typeof normalizedData !== 'object'
    || !PENDING_CHECKOUT_SESSION_OUTCOME_VALUES.includes(normalizedData.action)
    || !normalizedData.session
  ) {
    throw createBillingRpcError('Pending checkout claim RPC returned an unexpected payload');
  }

  return {
    outcome: normalizedData.action,
    session: normalizePendingCheckoutSessionRow(
      normalizedData.session,
      'Pending checkout claim RPC returned an invalid session row'
    ),
  };
}

/**
 * Decide whether a normalized pending Checkout Session row can be reused now.
 *
 * Purpose: route-level duplicate prevention must reuse only open rows that have
 * a persisted Stripe Checkout URL and have not passed their Stripe expiry.
 *
 * @param {object | null | undefined} session
 * @returns {boolean}
 */
function isReusablePendingCheckoutSession(session) {
  if (
    session?.status !== PENDING_CHECKOUT_SESSION_STATUSES.OPEN
    || !session.checkoutUrl
    || !session.expiresAt
  ) {
    return false;
  }

  const expiresAtMs = new Date(session.expiresAt).getTime();

  return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
}

/**
 * Pause briefly between pending-checkout re-reads.
 *
 * Purpose: a second concurrent checkout request can wait for the request that
 * owns a creating claim to persist the Stripe URL without introducing route
 * code that knows about timers directly.
 *
 * @param {number} delayMs
 * @returns {Promise<void>}
 */
function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
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

/**
 * Redact Stripe resource ids for logs while preserving enough shape for
 * debugging and cross-log correlation.
 *
 * The resource prefix is kept because distinguishing customer, session, and
 * subscription ids is often operationally important, while the middle of the id
 * stays hidden outside explicitly allowed log paths.
 *
 * @param {string | null | undefined} id
 * @returns {string | null}
 */
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

/**
 * Emit the canonical structured log for unsupported Stripe subscription
 * statuses that are intentionally ignored by local billing writes.
 *
 * Purpose: unsupported statuses should be visible for follow-up without being
 * coerced into the repo's narrower local billing status model.
 *
 * @param {object} log
 * @param {{ operation: string, userId: string, status: string, stripeSubscriptionId: string | null | undefined }} params
 * @returns {void}
 */
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

    throw createBillingError(
      'Stripe livemode mismatch',
      'BILLING_LIVEMODE_MISMATCH',
      { billingAlreadyLogged: true }
    );
  }

  return livemode;
}

/**
 * Validate and normalize sync options for subscription reconciliation flows.
 *
 * Event-driven sync requires an event timestamp because the write RPC uses it
 * for stale-event protection. Authoritative sync may omit that timestamp
 * because it overwrites canonical state from a direct Stripe fetch instead.
 *
 * `expectedUserId` is optional and is used by authenticated routes to require
 * that the resolved local customer mapping still belongs to the caller before
 * any authoritative write runs.
 *
 * @param {{ mode?: string, eventCreated?: string | number | Date, expectedUserId?: string }} options
 * @returns {{ mode: string, eventCreated: string | undefined, expectedUserId: string | undefined }}
 */
function parseSyncSubscriptionOptions(options) {
  const parsedMode = nonEmptyStringSchema.safeParse(options?.mode);

  if (!parsedMode.success || !BILLING_SYNC_MODE_VALUES.includes(parsedMode.data)) {
    throw createBillingError('Invalid Stripe subscription sync mode');
  }

  const hasEventCreated = options?.eventCreated !== undefined;
  const eventCreated = hasEventCreated ? toIsoTimestamp(options.eventCreated) : undefined;

  if (hasEventCreated && !eventCreated) {
    throw createBillingError('Invalid eventCreated timestamp');
  }

  if (eventCreated) {
    assertTimestampNotTooFarInFuture(
      eventCreated,
      'eventCreated timestamp is too far in the future'
    );
  }

  if (parsedMode.data === BILLING_SYNC_MODES.EVENT && !eventCreated) {
    throw createBillingError('Event-driven subscription sync requires eventCreated');
  }

  const hasExpectedUserId = options?.expectedUserId !== undefined;
  const expectedUserId = hasExpectedUserId ? normalizeString(options.expectedUserId) : undefined;

  if (hasExpectedUserId && !expectedUserId) {
    throw createBillingError('Invalid expectedUserId for subscription sync');
  }

  return {
    mode: parsedMode.data,
    eventCreated,
    expectedUserId,
  };
}

/**
 * Assert that a user-scoped billing sync still resolves to the caller's user id
 * before an authoritative write occurs.
 *
 * Purpose: authenticated reconcile flows should stop if Stripe customer
 * ownership drifts between the route's local read and the service's privileged
 * customer lookup instead of letting the authoritative RPC write another
 * user's billing row.
 *
 * @param {{ expectedUserId?: string, resolvedUserId?: string, stripeCustomerId?: string | null, stripeSubscriptionId?: string | null, log?: object }} input
 * @returns {void}
 */
function assertExpectedSyncUserMatch(input = {}) {
  const expectedUserId = normalizeString(input.expectedUserId);

  if (!expectedUserId) {
    return;
  }

  const resolvedUserId = normalizeString(input.resolvedUserId);

  if (resolvedUserId && resolvedUserId === expectedUserId) {
    return;
  }

  const log = isLoggerCandidate(input.log) ? input.log : defaultLogger;

  log.error(
    {
      event: 'billing_sync_ownership_mismatch',
      operation: 'syncSubscriptionFromStripe',
      expectedUserIdHash: hashUserIdForLog(expectedUserId),
      resolvedUserIdHash: hashUserIdForLog(resolvedUserId),
      stripeCustomerId: formatStripeIdForLog(input.stripeCustomerId, 'error'),
      stripeSubscriptionId: formatStripeIdForLog(input.stripeSubscriptionId, 'error'),
    },
    'Rejected Stripe subscription sync because the resolved local user did not match the caller'
  );

  throw createBillingOwnershipError('Stripe subscription resolved to a different local user');
}

/**
 * Decide whether an event-mode write targets a non-current subscription.
 *
 * Purpose: Stripe can deliver events for old or support-created subscriptions
 * under the same customer. Those events must not replace an active canonical
 * local subscription unless the local row is already terminal and replaceable.
 *
 * @param {object | null | undefined} localSubscription
 * @param {string | null | undefined} incomingSubscriptionId
 * @returns {boolean}
 */
function shouldIgnoreNonCurrentSubscriptionEvent(localSubscription, incomingSubscriptionId) {
  const localSubscriptionId = normalizeString(localSubscription?.stripe_subscription_id);
  const normalizedIncomingSubscriptionId = normalizeString(incomingSubscriptionId);

  if (!localSubscriptionId || !normalizedIncomingSubscriptionId) {
    return false;
  }

  if (localSubscriptionId === normalizedIncomingSubscriptionId) {
    return false;
  }

  return !TERMINAL_REPLACEABLE_SUBSCRIPTION_STATUSES.has(
    normalizeString(localSubscription?.status)
  );
}

/**
 * Emit the structured monitoring signal for ignored non-current events.
 *
 * Purpose: a safe ignore should be visible because it often means duplicate
 * Stripe subscriptions exist for one customer and need operational cleanup.
 *
 * @param {object} log
 * @param {{ operation: string, userId: string, localSubscriptionId?: string | null, incomingSubscriptionId?: string | null }} params
 * @returns {void}
 */
function logNonCurrentSubscriptionEvent(log, {
  operation,
  userId,
  localSubscriptionId,
  incomingSubscriptionId,
}) {
  log.warn(
    {
      event: 'billing_non_current_subscription_event_ignored',
      operation,
      userIdHash: hashUserIdForLog(userId),
      localSubscriptionId: formatStripeIdForLog(localSubscriptionId, 'warn'),
      incomingSubscriptionId: formatStripeIdForLog(incomingSubscriptionId, 'warn'),
    },
    'Ignored Stripe event for a non-current local subscription'
  );
}

/**
 * Build the fail-closed free-state shape returned when local billing cannot be
 * read or has not been established yet.
 *
 * Purpose: keep route and entitlement callers on one canonical response shape
 * even when the underlying billing tables are empty or temporarily unreadable.
 *
 * @returns {object}
 */
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

/**
 * Combine local customer and subscription rows into the canonical billing
 * status object consumed by routes, entitlement checks, and checkout helpers.
 *
 * Purpose: centralize the mapping from raw table rows to derived fields such as
 * `entitled`, `tier`, and the effective Stripe ids so downstream callers do not
 * re-encode billing truth in multiple places.
 *
 * @param {object | null} customer
 * @param {object | null} subscription
 * @returns {object}
 */
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
    entitlement: entitled ? BILLING_ENTITLEMENTS.PREMIUM : null,
    tier: entitled ? TIERS.PAID : TIERS.FREE,
    stripeCustomerId,
    stripeSubscriptionId,
    priceId: subscription?.price_id ?? null,
    status: subscription?.status ?? null,
    currentPeriodEnd: subscription?.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
  };
}

/**
 * Load both local billing tables through the caller's Supabase client and
 * synthesize the canonical billing status in one place.
 *
 * Purpose: keep customer and subscription reads parallel while preserving the
 * caller's auth/RLS context instead of silently escalating privileges.
 *
 * @param {string} userId
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @returns {Promise<object>}
 */
async function loadBillingStatusWithClient(userId, supabaseClient) {
  const [customer, subscription] = await Promise.all([
    loadBillingCustomerByUserId(userId, supabaseClient),
    loadBillingSubscriptionByUserId(userId, supabaseClient),
  ]);

  return buildBillingStatus(customer, subscription);
}

/**
 * Read the canonical local Stripe-customer mapping for one user.
 *
 * Connects to the `billing_customers` table and intentionally throws raw
 * Supabase errors so the higher-level status helpers can choose whether to fail
 * closed or fail hard for the current route.
 *
 * @param {string} userId
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @returns {Promise<object | null>}
 */
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

/**
 * Resolve the local billing customer row from a Stripe customer id.
 *
 * Purpose: webhook and authoritative sync flows start from Stripe-owned ids and
 * must map them back to the canonical local `user_id` before touching
 * `billing_subscriptions`.
 *
 * @param {string} stripeCustomerId
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @returns {Promise<object | null>}
 */
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

/**
 * Read the canonical local subscription snapshot for one user.
 *
 * Connects to `billing_subscriptions`, which is the local source of truth for
 * entitlement checks and checkout-state reads once Stripe reconciliation has
 * completed.
 *
 * @param {string} userId
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @returns {Promise<object | null>}
 */
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

/**
 * Build the RPC payload for stale-aware event-driven subscription writes.
 *
 * The event path always includes `last_stripe_event_created` because the
 * database RPC uses it to ignore out-of-order webhook updates.
 *
 * @param {object} params
 * @returns {object}
 */
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

/**
 * Build the RPC payload for authoritative subscription reconciliation.
 *
 * Purpose: direct Stripe fetches can refresh the canonical local snapshot even
 * when no webhook event timestamp is available. `last_stripe_event_created`
 * stays optional so callers do not accidentally invent event ordering data.
 *
 * @param {object} params
 * @returns {object}
 */
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

/**
 * Claim or reuse the active pending Checkout Session row through Postgres.
 *
 * Purpose: duplicate checkout prevention is race-sensitive in serverless route
 * handlers, so the claim decision must happen inside the database boundary
 * rather than as a route-level read-then-insert sequence.
 *
 * @param {{ userId: string, plan: string }} params
 * @returns {Promise<{ outcome: string, session: object }>}
 */
async function callPendingCheckoutSessionClaimRpc({ userId, plan }) {
  const { data, error } = await supabaseAdmin.rpc(
    'claim_billing_checkout_session',
    {
      p_user_id: userId,
      p_plan: plan,
    }
  );

  if (error) {
    throw error;
  }

  return normalizePendingCheckoutClaimRpcData(data);
}

/**
 * Read an open pending Checkout Session row for one user and plan.
 *
 * Purpose: concurrent checkout requests that did not own the creating claim can
 * re-read this local row briefly instead of creating another Stripe Session or
 * trusting client-provided state.
 *
 * @param {{ userId: string, plan: string }} params
 * @returns {Promise<object | null>}
 */
async function loadOpenPendingCheckoutSession({ userId, plan }) {
  const { data, error } = await supabaseAdmin
    .from('billing_checkout_sessions')
    .select(BILLING_CHECKOUT_SESSION_SELECT)
    .eq('user_id', userId)
    .eq('plan', plan)
    .eq('status', PENDING_CHECKOUT_SESSION_STATUSES.OPEN)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  return normalizePendingCheckoutSessionRow(
    data,
    'Open pending checkout query returned an invalid session row'
  );
}

/**
 * Read one Stripe event receipt through the privileged service client.
 *
 * Purpose: webhook duplicate suppression is server-owned and must not depend
 * on request-scoped RLS clients or browser-visible billing state.
 *
 * @param {string} eventId
 * @returns {Promise<object | null>}
 */
async function loadStripeEventReceiptById(eventId) {
  const { data, error } = await supabaseAdmin
    .from('stripe_event_receipts')
    .select(STRIPE_EVENT_RECEIPT_SELECT)
    .eq('event_id', eventId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data
    ? normalizeStripeEventReceiptRow(data, 'Stripe event receipt query returned an invalid row')
    : null;
}

/**
 * Call the stale-aware subscription upsert RPC through supabaseAdmin.
 *
 * Purpose: event-driven writes are server-controlled and intentionally bypass
 * RLS. The response is validated here so unexpected RPC payload drift fails
 * loudly before any caller trusts the result.
 *
 * @param {object} payload
 * @returns {Promise<object>}
 */
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

/**
 * Call the authoritative subscription upsert RPC through supabaseAdmin.
 *
 * This path is used when the server fetched the subscription directly from
 * Stripe and wants the database to treat that snapshot as canonical rather
 * than stale-checking it like a webhook event.
 *
 * @param {object} payload
 * @returns {Promise<object>}
 */
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

/**
 * Merge one Stripe event receipt row through the receipt-dedupe RPC.
 *
 * Purpose: webhook processing records a canonical audit trail and duplicate
 * detection state separate from the subscription snapshot itself. The RPC
 * contract is validated here before routes rely on its outcome.
 *
 * @param {{ eventId: string, eventType: string, livemode: boolean, stripeEventCreated: string, result: string }} params
 * @returns {Promise<object>}
 */
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
 * Persist the last successfully synced Stripe email fingerprint locally.
 *
 * Purpose: the billing customer row stores a best-effort optimization marker
 * so future mapped-customer requests can skip no-op Stripe email updates.
 *
 * @param {{ userId: string | null, stripeCustomerId: string, emailFingerprint: string }} params
 * @returns {Promise<void>}
 */
async function persistStripeCustomerEmailFingerprint({
  userId,
  stripeCustomerId,
  emailFingerprint,
}) {
  if (!userId || !stripeCustomerId || !emailFingerprint) {
    return;
  }

  const { error } = await supabaseAdmin
    .from('billing_customers')
    .update({ last_synced_stripe_email_fingerprint: emailFingerprint })
    .eq('user_id', userId)
    .eq('stripe_customer_id', stripeCustomerId)
    .select(BILLING_CUSTOMER_SELECT)
    .maybeSingle();

  if (error) {
    throw error;
  }
}

/**
 * Best-effort sync the resolved billing customer's email to the linked Stripe
 * customer record.
 *
 * Called from the Stripe customer resolution flow after the local
 * `billing_customers` mapping has been resolved. Side effects: may issue a
 * Stripe customer update request, may persist the last successful email
 * fingerprint locally, and emits warnings when provider sync or optimization
 * persistence fails after local billing state has already been established.
 *
 * @param {object} params
 * @param {object | null | undefined} params.billingCustomer
 * @param {string | null | undefined} params.normalizedEmail
 * @param {object} params.log
 * @param {string | null} params.userIdHash
 * @returns {Promise<void>} Resolves when the sync is skipped or attempted;
 * Stripe update failures are logged and swallowed instead of being rethrown.
 */
async function syncStripeCustomerEmail({
  billingCustomer,
  normalizedEmail,
  log,
  userIdHash,
}) {
  const stripeCustomerId = normalizeString(billingCustomer?.stripe_customer_id);

  if (!stripeCustomerId || !normalizedEmail) {
    return;
  }

  const fingerprintSecret = getBillingEmailFingerprintSecret(log);
  const emailFingerprint = fingerprintSecret
    ? buildStripeEmailFingerprint(normalizeEmailForFingerprint(normalizedEmail), fingerprintSecret)
    : null;

  if (
    emailFingerprint
    && normalizeString(billingCustomer?.last_synced_stripe_email_fingerprint) === emailFingerprint
  ) {
    return;
  }

  try {
    await getStripeClient().customers.update(stripeCustomerId, { email: normalizedEmail });
  } catch (error) {
    log.warn(
      {
        err: sanitizeStripeSyncErrorForLog(error),
        event: 'billing_customer_email_sync_failed',
        operation: 'getOrCreateStripeCustomer',
        userIdHash,
        stripeCustomerId: formatStripeIdForLog(stripeCustomerId, 'warn'),
      },
      'Failed to sync Stripe customer email after resolving the local mapping'
    );

    return;
  }

  if (!emailFingerprint) {
    return;
  }

  try {
    await persistStripeCustomerEmailFingerprint({
      userId: normalizeString(billingCustomer?.user_id) || null,
      stripeCustomerId,
      emailFingerprint,
    });
  } catch (error) {
    log.warn(
      {
        err: sanitizeStripeSyncErrorForLog(error),
        event: 'billing_customer_email_fingerprint_persist_failed',
        operation: 'getOrCreateStripeCustomer',
        userIdHash,
        stripeCustomerId: formatStripeIdForLog(stripeCustomerId, 'warn'),
      },
      'Failed to persist Stripe email fingerprint after syncing Stripe customer email'
    );
  }
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
    return await loadBillingStatusWithClient(userId, supabaseClient);
  } catch (error) {
    log.error(
      { err: error, operation: 'getLocalBillingStatus', userIdHash },
      'Failed to load local billing status'
    );
    return createEmptyBillingStatus();
  }
}

/**
 * Read the canonical local billing state for one user and fail hard instead of
 * synthesizing a free-state fallback.
 *
 * Route handlers should prefer this helper when a transient billing read
 * failure must block checkout or checkout completion handling.
 *
 * @param {string} userId
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function loadBillingStatusOrThrow(
  userId,
  supabaseClient,
  log = defaultLogger
) {
  if (!userId || !isSupabaseReadClientCandidate(supabaseClient)) {
    log.error(
      {
        operation: 'loadBillingStatusOrThrow',
        hasUserId: !!userId,
        hasSupabaseClient: isSupabaseReadClientCandidate(supabaseClient),
      },
      'Billing status resolver is missing a request-scoped Supabase client'
    );

    throw createBillingError(
      'Billing status resolver is missing a request-scoped Supabase client',
      'BILLING_STATUS_UNAVAILABLE'
    );
  }

  const userIdHash = hashUserIdForLog(userId);

  try {
    return await loadBillingStatusWithClient(userId, supabaseClient);
  } catch (error) {
    log.error(
      { err: error, operation: 'loadBillingStatusOrThrow', userIdHash },
      'Failed to load local billing status'
    );

    const billingError = createBillingError(
      'Failed to load local billing status',
      'BILLING_STATUS_UNAVAILABLE'
    );
    billingError.cause = error;
    throw billingError;
  }
}

/**
 * Determine whether a canceling subscription still has paid storage time left.
 *
 * Purpose: premium_canceling users stay Premium until the paid period actually
 * ends; missing or invalid period-end data cannot prove that entitlement.
 *
 * @param {string | null | undefined} currentPeriodEnd
 * @param {Date} now
 * @returns {boolean}
 */
function hasFutureCurrentPeriodEnd(currentPeriodEnd, now) {
  const periodEnd = new Date(currentPeriodEnd ?? '');
  const comparisonTime = now instanceof Date ? now.getTime() : Date.now();

  if (Number.isNaN(periodEnd.getTime()) || Number.isNaN(comparisonTime)) {
    return false;
  }

  return periodEnd.getTime() > comparisonTime;
}

/**
 * Classify a trusted local billing status into the storage-policy vocabulary.
 *
 * Purpose: keep storage decisions from relying on `tier === "free"` by naming
 * confirmed Free, retryable billing ambiguity, dunning, sync, and Premium
 * cancellation states separately. Callers should pass a status loaded by
 * loadBillingStatusOrThrow() or an equivalent strict billing read.
 *
 * @param {object | null | undefined} billingStatus
 * @param {{ now?: Date }} [options]
 * @returns {string}
 */
export function classifyConfirmedBillingStatusForStorage(billingStatus, options = {}) {
  if (!billingStatus || typeof billingStatus !== 'object') {
    return STORAGE_STATUSES.BILLING_UNAVAILABLE;
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const subscriptionStatus = normalizeString(billingStatus.status);
  const hasSubscription = Boolean(billingStatus.hasSubscription);
  const hasCustomerMapping = Boolean(billingStatus.hasCustomerMapping);

  if (
    billingStatus.entitled
    && subscriptionStatus === BILLING_SUBSCRIPTION_STATUSES.ACTIVE
  ) {
    if (billingStatus.cancelAtPeriodEnd) {
      return hasFutureCurrentPeriodEnd(billingStatus.currentPeriodEnd, now)
        ? STORAGE_STATUSES.PREMIUM_CANCELING
        : STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING;
    }

    return STORAGE_STATUSES.PREMIUM_ACTIVE;
  }

  if (PAYMENT_RECOVERY_BILLING_STATUSES.includes(subscriptionStatus)) {
    return STORAGE_STATUSES.PAYMENT_RECOVERY;
  }

  if (!hasSubscription) {
    return hasCustomerMapping
      ? STORAGE_STATUSES.SYNC_PENDING
      : STORAGE_STATUSES.TERMINAL_FREE;
  }

  if (SYNC_PENDING_BILLING_STATUSES.has(subscriptionStatus)) {
    return STORAGE_STATUSES.SYNC_PENDING;
  }

  if (TERMINAL_FREE_BILLING_STATUSES.has(subscriptionStatus)) {
    return STORAGE_STATUSES.TERMINAL_FREE;
  }

  return STORAGE_STATUSES.NON_ENTITLED_NON_TERMINAL;
}

/**
 * Identify storage statuses whose storage-gated actions should be retried.
 *
 * Purpose: centralize the contract that billing_unavailable and stale
 * period-end reconciliation are service-state problems, not confirmed Free
 * downgrade evidence.
 *
 * @param {string} storageStatus
 * @returns {boolean}
 */
export function isStorageStatusRetryable(storageStatus) {
  return STORAGE_RETRYABLE_STATUSES.has(storageStatus);
}

/**
 * Decide whether automatic overflow locking may run for a storage status.
 *
 * Purpose: make the v1 lock allowlist explicit so fail-closed Free fallbacks,
 * payment recovery, sync pending, and reconciliation states cannot lock rows.
 *
 * @param {string | { status?: string }} storageStatus
 * @returns {boolean}
 */
export function isAutomaticOverflowLockEligible(storageStatus) {
  const status = typeof storageStatus === 'object'
    ? storageStatus?.status
    : storageStatus;

  return status === STORAGE_STATUSES.TERMINAL_FREE;
}

/**
 * Map a storage status into the create-flow policy later API chunks consume.
 *
 * Purpose: separate Premium limits, confirmed-Free limits, retryable billing
 * outages, dunning, sync pending, and billing-review states before create-time
 * quota enforcement is made atomic in a later chunk.
 *
 * @param {string | { status?: string }} storageStatus
 * @returns {object}
 */
export function classifyStorageCreateFlow(storageStatus) {
  const status = typeof storageStatus === 'object'
    ? storageStatus?.status
    : storageStatus;

  switch (status) {
    case STORAGE_STATUSES.PREMIUM_ACTIVE:
    case STORAGE_STATUSES.PREMIUM_CANCELING:
      return {
        action: STORAGE_CREATE_ACTIONS.APPLY_PREMIUM_LIMIT,
        limitTier: TIERS.PAID,
        code: null,
        retryable: false,
        mayUseFreeQuotaCopy: false,
      };

    case STORAGE_STATUSES.TERMINAL_FREE:
      return {
        action: STORAGE_CREATE_ACTIONS.APPLY_FREE_LIMIT,
        limitTier: TIERS.FREE,
        code: STORAGE_CREATE_ERROR_CODES.STORAGE_LIMIT_EXCEEDED,
        retryable: false,
        mayUseFreeQuotaCopy: true,
      };

    case STORAGE_STATUSES.BILLING_RECONCILIATION_PENDING:
      return {
        action: STORAGE_CREATE_ACTIONS.BLOCK_RETRYABLE,
        limitTier: null,
        code: STORAGE_CREATE_ERROR_CODES.BILLING_RECONCILIATION_PENDING,
        retryable: true,
        mayUseFreeQuotaCopy: false,
      };

    case STORAGE_STATUSES.PAYMENT_RECOVERY:
      return {
        action: STORAGE_CREATE_ACTIONS.BLOCK_PAYMENT_RECOVERY,
        limitTier: null,
        code: STORAGE_CREATE_ERROR_CODES.PAYMENT_METHOD_UPDATE_REQUIRED,
        retryable: false,
        mayUseFreeQuotaCopy: false,
      };

    case STORAGE_STATUSES.SYNC_PENDING:
      return {
        action: STORAGE_CREATE_ACTIONS.BLOCK_SYNC_PENDING,
        limitTier: null,
        code: STORAGE_CREATE_ERROR_CODES.BILLING_SYNC_PENDING,
        retryable: false,
        mayUseFreeQuotaCopy: false,
      };

    case STORAGE_STATUSES.NON_ENTITLED_NON_TERMINAL:
      return {
        action: STORAGE_CREATE_ACTIONS.BLOCK_BILLING_STATE_REVIEW,
        limitTier: null,
        code: STORAGE_CREATE_ERROR_CODES.BILLING_STATE_REVIEW_REQUIRED,
        retryable: false,
        mayUseFreeQuotaCopy: false,
      };

    case STORAGE_STATUSES.BILLING_UNAVAILABLE:
    default:
      return {
        action: STORAGE_CREATE_ACTIONS.BLOCK_RETRYABLE,
        limitTier: null,
        code: STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE,
        retryable: true,
        mayUseFreeQuotaCopy: false,
      };
  }
}

/**
 * Build the storage-status result returned by request-scoped resolvers.
 *
 * Purpose: keep later route and service chunks on one result shape with the
 * status, lock eligibility, retryability, and create-flow policy precomputed.
 *
 * @param {string} status
 * @param {object | null} billingStatus
 * @param {string | null} unavailableCode
 * @returns {object}
 */
function buildStorageStatusResult(status, billingStatus = null, unavailableCode = null) {
  return {
    status,
    billingStatus,
    retryable: isStorageStatusRetryable(status),
    lockEligible: isAutomaticOverflowLockEligible(status),
    unavailableCode,
    createFlow: classifyStorageCreateFlow(status),
  };
}

/**
 * Resolve storage policy status from canonical local billing state.
 *
 * Purpose: use the strict billing reader so billing read failures become
 * billing_unavailable instead of a Free-shaped fallback that could deny paid
 * storage headroom or trigger downgrade behavior.
 *
 * @param {string} userId
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {object} log
 * @param {{ now?: Date }} [options]
 * @returns {Promise<object>}
 */
export async function resolveStorageStatus(
  userId,
  supabaseClient,
  log = defaultLogger,
  options = {}
) {
  let billingStatus;

  try {
    billingStatus = await loadBillingStatusOrThrow(userId, supabaseClient, log);
  } catch (error) {
    return buildStorageStatusResult(
      STORAGE_STATUSES.BILLING_UNAVAILABLE,
      null,
      error?.code ?? STORAGE_CREATE_ERROR_CODES.BILLING_STATUS_UNAVAILABLE
    );
  }

  const status = classifyConfirmedBillingStatusForStorage(billingStatus, options);
  return buildStorageStatusResult(status, billingStatus);
}

/**
 * Resolve storage policy status through the server-controlled billing client.
 *
 * Purpose: provide a deliberate privileged counterpart for background jobs and
 * future storage repair flows while keeping the same strict-unavailable result
 * contract as request-scoped resolution.
 *
 * @param {string} userId
 * @param {object} log
 * @param {{ now?: Date }} [options]
 * @returns {Promise<object>}
 */
export async function resolveStorageStatusPrivileged(
  userId,
  log = defaultLogger,
  options = {}
) {
  return resolveStorageStatus(userId, supabaseAdmin, log, options);
}

/**
 * Decide whether the current canonical local billing state may start a new
 * Checkout Session.
 *
 * Unknown or corrupt subscription statuses fail closed.
 *
 * @param {object} billingStatus
 * @returns {boolean}
 */
export function canStartCheckout(billingStatus) {
  if (!billingStatus || typeof billingStatus !== 'object') {
    return false;
  }

  if (!billingStatus.hasSubscription) {
    return true;
  }

  const status = normalizeString(billingStatus.status);

  if (!status || !ALLOWED_BILLING_STATUSES.has(status)) {
    return false;
  }

  return CHECKOUT_START_ALLOWED_STATUSES.has(status);
}

/**
 * Claim or reuse the server-owned pending Checkout Session row for a user.
 *
 * Purpose: this is the route-facing boundary for duplicate checkout prevention;
 * it validates request-derived values before asking the database RPC to make
 * the atomic `user_id + plan` claim decision.
 *
 * @param {{ userId: string, plan: string, checkoutAttemptNonce: string }} input
 * @param {object} log
 * @returns {Promise<{ outcome: string, session: object }>}
 */
export async function claimPendingCheckoutSession(input, log = defaultLogger) {
  const parsedInput = pendingCheckoutClaimInputSchema.safeParse(input);

  if (!parsedInput.success) {
    throw createBillingError('Invalid pending checkout session claim input');
  }

  const userIdHash = hashUserIdForLog(parsedInput.data.userId);

  try {
    return await callPendingCheckoutSessionClaimRpc({
      userId: parsedInput.data.userId,
      plan: parsedInput.data.plan,
    });
  } catch (error) {
    log.error(
      {
        err: error,
        operation: 'claimPendingCheckoutSession',
        userIdHash,
        plan: parsedInput.data.plan,
      },
      'Failed to claim pending checkout session'
    );
    throw error;
  }
}

/**
 * Persist the Stripe Checkout Session fields after a claim owner creates it.
 *
 * Purpose: checkout routes should redirect only to a Stripe URL that has been
 * durably associated with the local pending-session claim.
 *
 * @param {{ userId: string, id: string | number, stripeCheckoutSessionId: string, checkoutUrl: string, expiresAt: string }} input
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function finalizePendingCheckoutSession(input, log = defaultLogger) {
  const parsedInput = pendingCheckoutFinalizeInputSchema.safeParse(input);

  if (!parsedInput.success) {
    throw createBillingError('Invalid pending checkout session finalize input');
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('billing_checkout_sessions')
      .update({
        stripe_checkout_session_id: parsedInput.data.stripeCheckoutSessionId,
        checkout_url: parsedInput.data.checkoutUrl,
        expires_at: parsedInput.data.expiresAt,
        status: PENDING_CHECKOUT_SESSION_STATUSES.OPEN,
      })
      .eq('user_id', parsedInput.data.userId)
      .eq('id', parsedInput.data.id)
      .eq('status', PENDING_CHECKOUT_SESSION_STATUSES.CREATING)
      .select(BILLING_CHECKOUT_SESSION_SELECT)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      throw createBillingError(
        'Pending checkout session claim could not be finalized',
        'BILLING_PENDING_CHECKOUT_FINALIZE_FAILED'
      );
    }

    return normalizePendingCheckoutSessionRow(
      data,
      'Pending checkout finalize returned an invalid session row'
    );
  } catch (error) {
    log.error(
      {
        err: error,
        operation: 'finalizePendingCheckoutSession',
        stripeCheckoutSessionId: formatStripeIdForLog(parsedInput.data.stripeCheckoutSessionId, 'error'),
      },
      'Failed to finalize pending checkout session'
    );
    throw error;
  }
}

/**
 * Mark a creating pending Checkout Session row as failed.
 *
 * Purpose: Stripe or persistence failures must release the active user-plan
 * claim so a later checkout attempt is not permanently blocked.
 *
 * @param {{ userId: string, id: string | number }} input
 * @param {object} log
 * @returns {Promise<object | null>}
 */
export async function failPendingCheckoutSession(input, log = defaultLogger) {
  const parsedInput = pendingCheckoutFailInputSchema.safeParse(input);

  if (!parsedInput.success) {
    throw createBillingError('Invalid pending checkout session fail input');
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('billing_checkout_sessions')
      .update({ status: PENDING_CHECKOUT_SESSION_STATUSES.FAILED })
      .eq('user_id', parsedInput.data.userId)
      .eq('id', parsedInput.data.id)
      .eq('status', PENDING_CHECKOUT_SESSION_STATUSES.CREATING)
      .select(BILLING_CHECKOUT_SESSION_SELECT)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data
      ? normalizePendingCheckoutSessionRow(data, 'Pending checkout fail returned an invalid session row')
      : null;
  } catch (error) {
    log.warn(
      {
        err: error,
        operation: 'failPendingCheckoutSession',
      },
      'Failed to mark pending checkout session as failed'
    );
    throw error;
  }
}

/**
 * Wait briefly for another request's creating claim to become reusable.
 *
 * Purpose: parallel checkout submissions with different nonces should converge
 * on the first persisted Stripe URL instead of minting another session.
 *
 * @param {{ userId: string, plan: string }} input
 * @param {object} log
 * @returns {Promise<object | null>}
 */
export async function waitForPendingCheckoutSessionOpen(input, log = defaultLogger) {
  const parsedInput = pendingCheckoutWaitInputSchema.safeParse(input);

  if (!parsedInput.success) {
    throw createBillingError('Invalid pending checkout session wait input');
  }

  const userIdHash = hashUserIdForLog(parsedInput.data.userId);

  try {
    for (let attempt = 0; attempt < PENDING_CHECKOUT_WAIT_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await sleep(PENDING_CHECKOUT_WAIT_DELAY_MS);
      }

      const pendingSession = await loadOpenPendingCheckoutSession({
        userId: parsedInput.data.userId,
        plan: parsedInput.data.plan,
      });

      if (isReusablePendingCheckoutSession(pendingSession)) {
        return pendingSession;
      }
    }

    return null;
  } catch (error) {
    log.error(
      {
        err: error,
        operation: 'waitForPendingCheckoutSessionOpen',
        userIdHash,
        plan: parsedInput.data.plan,
      },
      'Failed while waiting for pending checkout session'
    );
    throw error;
  }
}

/**
 * Look up a locally minted Checkout Session id for one authenticated user.
 *
 * Purpose: checkout-status can reject unknown or cross-user session ids before
 * making a Stripe API call, reducing API amplification and making ownership
 * intent explicit in local state.
 *
 * @param {{ userId: string, sessionId: string }} input
 * @param {object} log
 * @returns {Promise<object | null>}
 */
export async function getMintedCheckoutSessionForUser(input, log = defaultLogger) {
  const parsedInput = pendingCheckoutLookupInputSchema.safeParse(input);

  if (!parsedInput.success) {
    throw createBillingError('Invalid pending checkout session lookup input');
  }

  const userIdHash = hashUserIdForLog(parsedInput.data.userId);

  try {
    const { data, error } = await supabaseAdmin
      .from('billing_checkout_sessions')
      .select(BILLING_CHECKOUT_SESSION_SELECT)
      .eq('user_id', parsedInput.data.userId)
      .eq('stripe_checkout_session_id', parsedInput.data.sessionId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data
      ? normalizePendingCheckoutSessionRow(data, 'Pending checkout lookup returned an invalid session row')
      : null;
  } catch (error) {
    log.error(
      {
        err: error,
        operation: 'getMintedCheckoutSessionForUser',
        userIdHash,
        stripeCheckoutSessionId: formatStripeIdForLog(parsedInput.data.sessionId, 'error'),
      },
      'Failed to look up locally minted checkout session'
    );
    throw error;
  }
}

/**
 * Mark a locally minted Checkout Session as terminal after Stripe confirms it.
 *
 * Purpose: a reused checkout URL must remain available only while Stripe still
 * considers that Checkout Session open, so terminal Stripe statuses release the
 * active local user-plan claim without granting entitlement from this row.
 *
 * @param {{ userId: string, sessionId: string, status: 'complete' | 'expired' }} input
 * @param {object} log
 * @returns {Promise<object | null>}
 */
export async function markMintedCheckoutSessionTerminal(input, log = defaultLogger) {
  const parsedInput = pendingCheckoutTerminalInputSchema.safeParse(input);

  if (!parsedInput.success) {
    throw createBillingError('Invalid pending checkout session terminal input');
  }

  const userIdHash = hashUserIdForLog(parsedInput.data.userId);

  try {
    const { data, error } = await supabaseAdmin
      .from('billing_checkout_sessions')
      .update({ status: parsedInput.data.status })
      .eq('user_id', parsedInput.data.userId)
      .eq('stripe_checkout_session_id', parsedInput.data.sessionId)
      .eq('status', PENDING_CHECKOUT_SESSION_STATUSES.OPEN)
      .select(BILLING_CHECKOUT_SESSION_SELECT)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data
      ? normalizePendingCheckoutSessionRow(data, 'Pending checkout terminal mark returned an invalid session row')
      : null;
  } catch (error) {
    log.warn(
      {
        err: error,
        operation: 'markMintedCheckoutSessionTerminal',
        userIdHash,
        stripeCheckoutSessionId: formatStripeIdForLog(parsedInput.data.sessionId, 'warn'),
        status: parsedInput.data.status,
      },
      'Failed to mark minted checkout session terminal'
    );
    throw error;
  }
}

/**
 * Mark a locally minted Checkout Session terminal by Stripe Session id only.
 *
 * Purpose: webhook delivery may be the only observer of a completed Checkout
 * Session, so it needs a service-role release path that does not derive
 * entitlement from the pending-session row or require an authenticated user.
 *
 * @param {{ sessionId: string, status: 'complete' | 'expired' }} input
 * @param {object} log
 * @returns {Promise<object | null>}
 */
export async function markMintedCheckoutSessionTerminalByStripeSessionId(
  input,
  log = defaultLogger
) {
  const parsedInput = pendingCheckoutTerminalBySessionIdInputSchema.safeParse(input);

  if (!parsedInput.success) {
    throw createBillingError('Invalid pending checkout session terminal input');
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('billing_checkout_sessions')
      .update({ status: parsedInput.data.status })
      .eq('stripe_checkout_session_id', parsedInput.data.sessionId)
      .eq('status', PENDING_CHECKOUT_SESSION_STATUSES.OPEN)
      .select(BILLING_CHECKOUT_SESSION_SELECT)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data
      ? normalizePendingCheckoutSessionRow(
        data,
        'Pending checkout terminal mark returned an invalid session row'
      )
      : null;
  } catch (error) {
    log.warn(
      {
        err: error,
        operation: 'markMintedCheckoutSessionTerminalByStripeSessionId',
        stripeCheckoutSessionId: formatStripeIdForLog(parsedInput.data.sessionId, 'warn'),
        status: parsedInput.data.status,
      },
      'Failed to mark minted checkout session terminal from webhook'
    );
    throw error;
  }
}

/**
 * Map canonical local billing state plus Stripe Checkout Session status into
 * the UI state consumed by the success-page polling flow.
 *
 * @param {{ billingStatus?: object | null, checkoutSessionStatus?: string | null }} input
 * @returns {'pending' | 'active' | 'free' | 'error'}
 */
export function mapCheckoutStatus(input = {}) {
  if (input?.billingStatus?.entitled) {
    return CHECKOUT_STATUS_STATES.ACTIVE;
  }

  const checkoutSessionStatus = normalizeString(input?.checkoutSessionStatus).toLowerCase();

  if (checkoutSessionStatus === 'open') {
    return CHECKOUT_STATUS_STATES.PENDING;
  }

  if (checkoutSessionStatus === 'complete') {
    return CHECKOUT_STATUS_STATES.FREE;
  }

  if (checkoutSessionStatus === 'expired') {
    return CHECKOUT_STATUS_STATES.ERROR;
  }

  return CHECKOUT_STATUS_STATES.ERROR;
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
 * Resolve premium access from canonical local billing state
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
export async function resolvePremiumEntitlement(
  userId,
  supabaseClient,
  log = defaultLogger
) {
  const billingStatus = await getLocalBillingStatus(userId, supabaseClient, log);

  if (billingStatus.entitled) {
    return {
      entitled: true,
      entitlement: BILLING_ENTITLEMENTS.PREMIUM,
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
 * Intentionally bypass RLS for server-controlled premium entitlement checks
 * by routing through supabaseAdmin.
 *
 * @param {string} userId
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function resolvePremiumEntitlementPrivileged(userId, log = defaultLogger) {
  return resolvePremiumEntitlement(userId, supabaseAdmin, log);
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
      await syncStripeCustomerEmail({
        billingCustomer: localCustomer,
        normalizedEmail,
        log,
        userIdHash,
      });

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
      await syncStripeCustomerEmail({
        billingCustomer: localCustomer,
        normalizedEmail,
        log,
        userIdHash,
      });

      return {
        userId: parsedInput.data.userId,
        stripeCustomerId: localCustomer.stripe_customer_id,
        customer: localCustomer,
        createdInStripe: false,
        createdPlaceholder,
      };
    }

    const idempotencyHash = hashUserIdForIdempotency(parsedInput.data.userId);
    const stripeCustomer = await getStripeClient().customers.create(
      {},
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
      await syncStripeCustomerEmail({
        billingCustomer: updatedCustomer,
        normalizedEmail,
        log,
        userIdHash,
      });

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
      await syncStripeCustomerEmail({
        billingCustomer: racedCustomer,
        normalizedEmail,
        log,
        userIdHash,
      });

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
 * `expectedUserId` may be supplied by authenticated routes that want the
 * service to fail closed unless the resolved Stripe customer mapping still
 * belongs to that same user before any authoritative write is attempted.
 *
 * @param {{ mode: 'event' | 'authoritative', eventCreated?: number | string | Date, expectedUserId?: string }} options
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
    const stripeSubscription = await getStripeClient().subscriptions.retrieve(parsedSubscriptionId.data, {
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
          event: 'billing_customer_not_found_sync',
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

    assertExpectedSyncUserMatch({
      expectedUserId: parsedOptions.expectedUserId,
      resolvedUserId: localCustomer.user_id,
      stripeCustomerId,
      stripeSubscriptionId: parsedSubscriptionId.data,
      log,
    });

    let localSubscriptionForEvent = null;

    if (parsedOptions.mode === BILLING_SYNC_MODES.EVENT) {
      localSubscriptionForEvent = await loadBillingSubscriptionByUserId(
        localCustomer.user_id,
        supabaseAdmin
      );

      if (shouldIgnoreNonCurrentSubscriptionEvent(
        localSubscriptionForEvent,
        parsedSubscriptionId.data
      )) {
        logNonCurrentSubscriptionEvent(log, {
          operation: 'syncSubscriptionFromStripe',
          userId: localCustomer.user_id,
          localSubscriptionId: localSubscriptionForEvent?.stripe_subscription_id,
          incomingSubscriptionId: parsedSubscriptionId.data,
        });

        return {
          outcome: BILLING_WRITE_OUTCOMES.PROCESSED,
          userId: localCustomer.user_id,
          subscription: stripeSubscription,
          localSubscription: localSubscriptionForEvent,
        };
      }
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
      if (isOlderStripeEvent(localSubscriptionForEvent?.last_stripe_event_created, parsedOptions.eventCreated)) {
        log.info(
          {
            operation: 'syncSubscriptionFromStripe',
            stripeSubscriptionId: formatStripeIdForLog(parsedSubscriptionId.data, 'info'),
            userIdHash: hashUserIdForLog(localCustomer.user_id),
          },
          'Ignoring stale Stripe subscription event during sync'
        );
        return {
          outcome: BILLING_WRITE_OUTCOMES.STALE_IGNORED,
          userId: localCustomer.user_id,
          subscription: stripeSubscription,
          localSubscription: localSubscriptionForEvent,
        };
      }

      const rpcResult = await callSubscriptionEventRpc(
        buildEventDrivenSubscriptionPayload({
          userId: localCustomer.user_id,
          stripeSubscriptionId: stripeSubscription.id,
          stripeCustomerId,
          priceId: extractStripePriceId(stripeSubscription, localSubscriptionForEvent?.price_id),
          status: classifiedStatus.normalizedStatus,
          currentPeriodEnd: extractStripeCurrentPeriodEnd(
            stripeSubscription,
            localSubscriptionForEvent?.price_id
          ),
          cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
          eventCreated: parsedOptions.eventCreated,
        })
      );

      if (!rpcResult.applied && rpcResult.reason === 'non_current_ignored') {
        logNonCurrentSubscriptionEvent(log, {
          operation: 'syncSubscriptionFromStripe',
          userId: localCustomer.user_id,
          localSubscriptionId: rpcResult.subscription?.stripe_subscription_id,
          incomingSubscriptionId: stripeSubscription.id,
        });
      }

      return {
        outcome: rpcResult.applied || rpcResult.reason === 'non_current_ignored'
          ? BILLING_WRITE_OUTCOMES.PROCESSED
          : BILLING_WRITE_OUTCOMES.STALE_IGNORED,
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
        currentPeriodEnd: extractStripeCurrentPeriodEnd(stripeSubscription),
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
    if (!error?.billingAlreadyLogged) {
      log.error(
        {
          err: error,
          operation: 'syncSubscriptionFromStripe',
          stripeSubscriptionId: formatStripeIdForLog(parsedSubscriptionId.data, 'error'),
        },
        'Failed to sync Stripe subscription into local billing state'
      );
    }

    throw error;
  }
}

/**
 * Reconcile a subscription from a verified Stripe event.
 *
 * Purpose: webhook dispatchers should not choose billing sync modes directly;
 * this wrapper hardcodes EVENT mode and keeps authoritative reconciliation on
 * authenticated route paths only.
 *
 * @param {string} subscriptionId
 * @param {string | number | Date} eventCreated
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function syncSubscriptionFromEvent(
  subscriptionId,
  eventCreated,
  log = defaultLogger
) {
  return syncSubscriptionFromStripe(
    subscriptionId,
    {
      mode: BILLING_SYNC_MODES.EVENT,
      eventCreated,
    },
    log
  );
}

/**
 * Validate and normalize a Stripe event envelope for receipt writes.
 *
 * Purpose: receipt helpers share one boundary for event id/type/livemode and
 * timestamp handling so duplicate checks and terminal writes compare the same
 * canonical created timestamp.
 *
 * @param {object} event
 * @returns {{ id: string, type: string, livemode: boolean, created: string }}
 */
function normalizeStripeReceiptEvent(event) {
  const parsedEvent = stripeReceiptEventSchema.safeParse(event);

  if (!parsedEvent.success) {
    throw createBillingError('Invalid Stripe event receipt input');
  }

  const eventCreated = toIsoTimestamp(parsedEvent.data.created);

  if (!eventCreated) {
    throw createBillingError('Stripe event receipt is missing a valid created timestamp');
  }

  assertTimestampNotTooFarInFuture(
    eventCreated,
    'Stripe event receipt timestamp is too far in the future'
  );

  return {
    id: parsedEvent.data.id,
    type: parsedEvent.data.type,
    livemode: parsedEvent.data.livemode,
    created: eventCreated,
  };
}

/**
 * Compare a stored receipt row with a verified Stripe event envelope.
 *
 * Purpose: duplicate suppression is safe only when the event id maps to the
 * exact same type, livemode, and Stripe-created timestamp.
 *
 * @param {object} event
 * @param {object | null | undefined} receipt
 * @returns {boolean}
 */
export function hasMatchingStripeEventReceiptEnvelope(event, receipt) {
  const normalizedEvent = normalizeStripeReceiptEvent(event);
  const normalizedReceiptEventCreated = toIsoTimestamp(
    receipt?.stripeEventCreated ?? receipt?.stripe_event_created
  );

  if (!normalizedReceiptEventCreated) {
    return false;
  }

  return (
    normalizedEvent.id === (receipt?.eventId ?? receipt?.event_id)
    && normalizedEvent.type === (receipt?.eventType ?? receipt?.event_type)
    && normalizedEvent.livemode === (receipt?.livemode)
    && new Date(normalizedEvent.created).getTime()
      === new Date(normalizedReceiptEventCreated).getTime()
  );
}

/**
 * Pre-read a Stripe event receipt before webhook dispatch.
 *
 * Purpose: common duplicate deliveries can short-circuit before Stripe fetches
 * or local billing writes, while first-delivery races still rely on the atomic
 * processing claim RPC.
 *
 * @security Caller must verify the Stripe signature first and must not pass
 * untrusted request bodies directly.
 *
 * @param {object} event
 * @param {object} log
 * @returns {Promise<object | null>}
 */
export async function getStripeEventReceiptForEvent(event, log = defaultLogger) {
  const normalizedEvent = normalizeStripeReceiptEvent(event);

  try {
    return await loadStripeEventReceiptById(normalizedEvent.id);
  } catch (error) {
    log.error(
      {
        err: error,
        operation: 'getStripeEventReceiptForEvent',
        stripeEventId: formatStripeIdForLog(normalizedEvent.id, 'error'),
      },
      'Failed to pre-read Stripe event receipt'
    );
    throw error;
  }
}

/**
 * Atomically claim a Stripe event receipt for synchronous webhook processing.
 *
 * Purpose: first deliveries and retry attempts must mark the event as
 * `processing` before dispatch starts so concurrent invocations do not both
 * reconcile the same event as if it were unclaimed.
 *
 * @security Caller must verify the Stripe signature first.
 *
 * @param {object} event
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function claimStripeEventReceiptProcessing(event, log = defaultLogger) {
  const normalizedEvent = normalizeStripeReceiptEvent(event);

  try {
    assertStripeLivemode(normalizedEvent.livemode, {
      operation: 'claimStripeEventReceiptProcessing',
      stripeEventId: normalizedEvent.id,
      log,
    });

    const rpcResult = await callStripeEventReceiptMergeRpc({
      eventId: normalizedEvent.id,
      eventType: normalizedEvent.type,
      livemode: normalizedEvent.livemode,
      stripeEventCreated: normalizedEvent.created,
      result: STRIPE_EVENT_RECEIPT_RESULTS.PROCESSING,
    });

    if (rpcResult.outcome === 'processing_active') {
      throw createBillingError(
        'Stripe event receipt is already processing',
        'BILLING_WEBHOOK_PROCESSING_ACTIVE'
      );
    }

    if (rpcResult.outcome === 'reclaimed_processing') {
      log.warn(
        {
          event: 'billing_webhook_processing_reclaimed',
          operation: 'claimStripeEventReceiptProcessing',
          stripeEventId: formatStripeIdForLog(normalizedEvent.id, 'warn'),
        },
        'Reclaimed a stale Stripe webhook processing receipt'
      );
    }

    return rpcResult;
  } catch (error) {
    if (isStripeEventReceiptEnvelopeMismatchError(error)) {
      throw createSanitizedStripeEventReceiptEnvelopeMismatchError(
        log,
        {
          operation: 'claimStripeEventReceiptProcessing',
          stripeEventId: normalizedEvent.id,
          message: 'Rejected Stripe event receipt claim because the envelope mismatched',
        }
      );
    }

    if (error?.code !== 'BILLING_WEBHOOK_PROCESSING_ACTIVE' && !error?.billingAlreadyLogged) {
      log.error(
        {
          err: error,
          operation: 'claimStripeEventReceiptProcessing',
          stripeEventId: formatStripeIdForLog(normalizedEvent.id, 'error'),
        },
        'Failed to claim Stripe event receipt for processing'
      );
    }

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
 * @security Caller MUST verify the Stripe webhook signature before invoking
 * this helper. The current safe path is `withWebhookAuth`; do not call this
 * from any route or script that has not already validated the Stripe event.
 *
 * @param {object} event
 * @param {string} result
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function recordStripeEventReceipt(event, result, log = defaultLogger) {
  const normalizedEvent = normalizeStripeReceiptEvent(event);
  const parsedResult = stripeReceiptResultSchema.safeParse(result);

  if (!parsedResult.success) {
    throw createBillingError('Invalid Stripe event receipt input');
  }

  try {
    assertStripeLivemode(normalizedEvent.livemode, {
      operation: 'recordStripeEventReceipt',
      stripeEventId: normalizedEvent.id,
      log,
    });

    const rpcResult = await callStripeEventReceiptMergeRpc({
      eventId: normalizedEvent.id,
      eventType: normalizedEvent.type,
      livemode: normalizedEvent.livemode,
      stripeEventCreated: normalizedEvent.created,
      result: parsedResult.data,
    });

    return rpcResult;
  } catch (error) {
    if (isStripeEventReceiptEnvelopeMismatchError(error)) {
      throw createSanitizedStripeEventReceiptEnvelopeMismatchError(
        log,
        {
          operation: 'recordStripeEventReceipt',
          stripeEventId: normalizedEvent.id,
          message: 'Rejected Stripe event receipt write because the envelope mismatched',
        }
      );
    }

    if (!error?.billingAlreadyLogged) {
      log.error(
        {
          err: error,
          operation: 'recordStripeEventReceipt',
          stripeEventId: formatStripeIdForLog(normalizedEvent.id, 'error'),
        },
        'Failed to record Stripe event receipt'
      );
    }

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
 * @security Caller MUST verify the Stripe webhook signature before invoking
 * this helper. The current safe path is `withWebhookAuth`; do not call this
 * from any route or script that has not already validated the Stripe event.
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

  assertTimestampNotTooFarInFuture(
    eventCreatedIso,
    'Stripe subscription delete event timestamp is too far in the future'
  );

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
          event: 'billing_customer_not_found_delete',
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

    if (shouldIgnoreNonCurrentSubscriptionEvent(localSubscription, subscriptionId.data)) {
      logNonCurrentSubscriptionEvent(log, {
        operation: 'markSubscriptionDeletedFromEvent',
        userId: localCustomer.user_id,
        localSubscriptionId: localSubscription?.stripe_subscription_id,
        incomingSubscriptionId: subscriptionId.data,
      });

      return {
        outcome: BILLING_WRITE_OUTCOMES.PROCESSED,
        userId: localCustomer.user_id,
        localSubscription,
      };
    }

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
        outcome: BILLING_WRITE_OUTCOMES.STALE_IGNORED,
        userId: localCustomer.user_id,
        localSubscription,
      };
    }

    const currentPeriodEnd = extractStripeCurrentPeriodEnd(subscription, localSubscription?.price_id);
    const hasCancelAtPeriodEnd = typeof subscription?.cancel_at_period_end === 'boolean';

    if (!currentPeriodEnd || !hasCancelAtPeriodEnd) {
      log.warn(
        {
          event: 'billing_delete_event_partial',
          operation: 'markSubscriptionDeletedFromEvent',
          stripeSubscriptionId: formatStripeIdForLog(subscriptionId.data, 'warn'),
          userIdHash: hashUserIdForLog(localCustomer.user_id),
          hasCurrentPeriodEnd: !!currentPeriodEnd,
          hasCancelAtPeriodEnd,
        },
        'Stripe subscription delete event omitted one or more snapshot fields'
      );
    }

    const rpcResult = await callSubscriptionEventRpc(
      buildEventDrivenSubscriptionPayload({
        userId: localCustomer.user_id,
        stripeSubscriptionId: subscriptionId.data,
        stripeCustomerId,
        priceId: extractStripePriceId(subscription, localSubscription?.price_id) ?? null,
        status: BILLING_SUBSCRIPTION_STATUSES.CANCELED,
        currentPeriodEnd,
        cancelAtPeriodEnd: hasCancelAtPeriodEnd ? subscription.cancel_at_period_end : false,
        eventCreated: eventCreatedIso,
      })
    );

    return {
      outcome: rpcResult.applied
        ? BILLING_WRITE_OUTCOMES.PROCESSED
        : BILLING_WRITE_OUTCOMES.STALE_IGNORED,
      userId: localCustomer.user_id,
      localSubscription: rpcResult.subscription,
    };
  } catch (error) {
    if (!error?.billingAlreadyLogged) {
      log.error(
        {
          err: error,
          operation: 'markSubscriptionDeletedFromEvent',
          stripeSubscriptionId: formatStripeIdForLog(subscriptionId.data, 'error'),
        },
        'Failed to persist local delete snapshot for Stripe subscription event'
      );
    }

    throw error;
  }
}
