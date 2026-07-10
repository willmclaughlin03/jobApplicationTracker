import { z } from 'zod';
import { logger as defaultLogger } from '../../shared/logger.js';
import { getStripeClient } from './stripeRuntime.js';
import { supabaseAdmin } from './supabaseServer.js';
import {
  BILLING_AUTHORITATIVE_SYNC_PURPOSES,
  BILLING_SYNC_MODES,
  buildAuthoritativeSubscriptionSnapshot,
  formatStripeIdForLog,
  loadBillingStatusOrThrow,
  markMintedCheckoutSessionTerminalByStripeSessionId,
  syncSubscriptionFromStripe,
} from './billingService.js';

const BILLING_CHECKOUT_DRAIN_SELECT = [
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
const CHECKOUT_SESSION_OPEN = 'open';
const CHECKOUT_SESSION_COMPLETE = 'complete';
const CHECKOUT_SESSION_EXPIRED = 'expired';
const DRAIN_DEFAULT_LIMIT = 100;
const DRAIN_MAX_LIMIT = 500;

const drainOptionsSchema = z.object({
  limit: z.number().int().positive().max(DRAIN_MAX_LIMIT).optional(),
}).optional();
const openCheckoutSessionRowSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().trim().min(1)]),
  user_id: z.string().trim().min(1),
  plan: z.string().trim().min(1),
  stripe_checkout_session_id: z.string().trim().min(1),
  status: z.literal(CHECKOUT_SESSION_OPEN),
}).passthrough();

/**
 * Create a stable error for emergency Checkout drain failures.
 *
 * Purpose: row-level drain failures should be visible to operators without
 * logging raw Stripe payloads or inventing local terminal state.
 *
 * @param {string} message
 * @param {string} [code='BILLING_CHECKOUT_DRAIN_FAILED']
 * @returns {Error & { code: string }}
 */
function createCheckoutDrainError(message, code = 'BILLING_CHECKOUT_DRAIN_FAILED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Normalize operator-supplied drain options.
 *
 * Purpose: the service command should bound each run so operators can run it
 * repeatedly during an incident without accidentally scanning unbounded rows.
 *
 * @param {{ limit?: number } | undefined} options
 * @returns {{ limit: number }}
 */
function normalizeDrainOptions(options) {
  const parsedOptions = drainOptionsSchema.safeParse(options);

  if (!parsedOptions.success) {
    throw createCheckoutDrainError('Invalid Checkout drain options', 'BILLING_INVALID_INPUT');
  }

  return {
    limit: parsedOptions.data?.limit ?? DRAIN_DEFAULT_LIMIT,
  };
}

/**
 * Normalize a local open Checkout Session row for drain processing.
 *
 * Purpose: the drain path should only act on rows that are locally open and
 * have a locally minted Stripe Checkout Session id.
 *
 * @param {unknown} row
 * @returns {{ id: string | number, userId: string, plan: string, stripeCheckoutSessionId: string }}
 */
function normalizeOpenCheckoutSessionRow(row) {
  const parsedRow = openCheckoutSessionRowSchema.safeParse(row);

  if (!parsedRow.success) {
    throw createCheckoutDrainError('Open Checkout Session query returned an invalid row');
  }

  return {
    id: parsedRow.data.id,
    userId: parsedRow.data.user_id,
    plan: parsedRow.data.plan,
    stripeCheckoutSessionId: parsedRow.data.stripe_checkout_session_id,
  };
}

/**
 * Resolve a Stripe id from string or expanded-object shapes.
 *
 * Purpose: Checkout Session subscription fields may be strings or expanded
 * objects; the drain command needs only the stable subscription id.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function extractStripeId(value) {
  if (typeof value === 'string') {
    return value.trim() || null;
  }

  if (value?.deleted === true) {
    return null;
  }

  if (value && typeof value === 'object' && typeof value.id === 'string') {
    return value.id.trim() || null;
  }

  return null;
}

/**
 * Read the current locally open Checkout Session rows.
 *
 * Purpose: emergency drains start from local state so only app-minted pending
 * sessions are considered, then Stripe is queried before any terminal write.
 *
 * @param {number} limit
 * @returns {Promise<Array<{ id: string | number, userId: string, plan: string, stripeCheckoutSessionId: string }>>}
 */
async function loadOpenCheckoutSessions(limit) {
  const { data, error } = await supabaseAdmin
    .from('billing_checkout_sessions')
    .select(BILLING_CHECKOUT_DRAIN_SELECT)
    .eq('status', CHECKOUT_SESSION_OPEN)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw error;
  }

  return Array.isArray(data)
    ? data.map((row) => normalizeOpenCheckoutSessionRow(row))
    : [];
}

/**
 * Mirror a Stripe-confirmed terminal Checkout Session status locally.
 *
 * Purpose: all local terminal writes stay conditional inside the billing
 * service helper on `status = open` and the Stripe Checkout Session id.
 *
 * @param {{ stripeCheckoutSessionId: string }} localSession
 * @param {'complete' | 'expired'} status
 * @param {object} log
 * @returns {Promise<boolean>}
 */
async function mirrorTerminalCheckoutSession(localSession, status, log) {
  const terminalRow = await markMintedCheckoutSessionTerminalByStripeSessionId(
    {
      sessionId: localSession.stripeCheckoutSessionId,
      status,
    },
    log
  );

  return Boolean(terminalRow);
}

/**
 * Expire one Stripe-open Checkout Session and mirror confirmed expiration.
 *
 * Purpose: the emergency drain must never mark a local Session expired until
 * Stripe confirms the hosted Checkout Session can no longer complete payment.
 *
 * @param {object} localSession
 * @param {object} log
 * @returns {Promise<object>}
 */
async function expireOpenCheckoutSession(localSession, log) {
  const expiredSession = await getStripeClient().checkout.sessions.expire(
    localSession.stripeCheckoutSessionId
  );

  if (expiredSession?.status !== CHECKOUT_SESSION_EXPIRED) {
    throw createCheckoutDrainError(
      'Stripe Checkout Session expiration was not confirmed',
      'BILLING_CHECKOUT_DRAIN_EXPIRE_UNCONFIRMED'
    );
  }

  const localUpdated = await mirrorTerminalCheckoutSession(
    localSession,
    CHECKOUT_SESSION_EXPIRED,
    log
  );

  return {
    outcome: 'expired',
    localUpdated,
  };
}

/**
 * Reconcile a Stripe-complete Checkout Session as a real payment.
 *
 * Purpose: payment-wins races must flow through canonical subscription sync
 * instead of forcing a local expiration from the pending Checkout row.
 *
 * @param {object} localSession
 * @param {object} stripeSession
 * @param {object} log
 * @returns {Promise<object>}
 */
async function reconcileCompleteCheckoutSession(localSession, stripeSession, log) {
  const subscriptionId = extractStripeId(stripeSession?.subscription);

  if (!subscriptionId) {
    throw createCheckoutDrainError(
      'Completed Stripe Checkout Session did not include a subscription id',
      'BILLING_CHECKOUT_DRAIN_SUBSCRIPTION_MISSING'
    );
  }

  const billingStatus = await loadBillingStatusOrThrow(
    localSession.userId,
    supabaseAdmin,
    log
  );
  const expectedSubscriptionSnapshot =
    buildAuthoritativeSubscriptionSnapshot(billingStatus);

  const syncResult = await syncSubscriptionFromStripe(
    subscriptionId,
    {
      mode: BILLING_SYNC_MODES.AUTHORITATIVE,
      expectedUserId: localSession.userId,
      expectedSubscriptionSnapshot,
      authoritativeSyncPurpose:
        BILLING_AUTHORITATIVE_SYNC_PURPOSES.CHECKOUT_COMPLETION,
    },
    log
  );
  const localUpdated = await mirrorTerminalCheckoutSession(
    localSession,
    CHECKOUT_SESSION_COMPLETE,
    log
  );

  return {
    outcome: 'complete_reconciled',
    localUpdated,
    syncOutcome: syncResult?.outcome ?? null,
  };
}

/**
 * Drain one locally open Checkout Session using Stripe as the authority.
 *
 * Purpose: each row is retrieved from Stripe before local state changes, so
 * complete payments win and provider failures leave the local row open for
 * retry/operator follow-up.
 *
 * @param {object} localSession
 * @param {object} log
 * @returns {Promise<object>}
 */
async function drainOpenCheckoutSession(localSession, log) {
  const stripeSession = await getStripeClient().checkout.sessions.retrieve(
    localSession.stripeCheckoutSessionId
  );

  if (stripeSession?.status === CHECKOUT_SESSION_OPEN) {
    return expireOpenCheckoutSession(localSession, log);
  }

  if (stripeSession?.status === CHECKOUT_SESSION_COMPLETE) {
    return reconcileCompleteCheckoutSession(localSession, stripeSession, log);
  }

  if (stripeSession?.status === CHECKOUT_SESSION_EXPIRED) {
    const localUpdated = await mirrorTerminalCheckoutSession(
      localSession,
      CHECKOUT_SESSION_EXPIRED,
      log
    );

    return {
      outcome: 'already_expired',
      localUpdated,
    };
  }

  log.warn(
    {
      event: 'billing_checkout_drain_unknown_session_status',
      localCheckoutSessionId: localSession.id,
      stripeCheckoutSessionId: formatStripeIdForLog(localSession.stripeCheckoutSessionId, 'warn'),
      stripeCheckoutSessionStatus: stripeSession?.status ?? null,
    },
    'Skipped Checkout Session drain because Stripe returned an unsupported Session status'
  );

  return {
    outcome: 'skipped_unknown_status',
    localUpdated: false,
  };
}

/**
 * Drain locally open Stripe Checkout Sessions during an emergency halt.
 *
 * Purpose: this operator-owned service command expires already-minted hosted
 * Checkout URLs without exposing a public/admin endpoint or deriving
 * entitlement from Checkout Session rows.
 *
 * @param {{ limit?: number }} [options]
 * @param {object} [log]
 * @returns {Promise<{ total: number, expired: number, complete: number, alreadyExpired: number, skipped: number, failed: number, results: object[] }>}
 */
export async function drainOpenCheckoutSessions(options = {}, log = defaultLogger) {
  const { limit } = normalizeDrainOptions(options);
  const localSessions = await loadOpenCheckoutSessions(limit);
  const summary = {
    total: localSessions.length,
    expired: 0,
    complete: 0,
    alreadyExpired: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  for (const localSession of localSessions) {
    try {
      const result = await drainOpenCheckoutSession(localSession, log);

      if (result.outcome === 'expired') {
        summary.expired += 1;
      } else if (result.outcome === 'complete_reconciled') {
        summary.complete += 1;
      } else if (result.outcome === 'already_expired') {
        summary.alreadyExpired += 1;
      } else {
        summary.skipped += 1;
      }

      summary.results.push({
        localCheckoutSessionId: localSession.id,
        stripeCheckoutSessionId: localSession.stripeCheckoutSessionId,
        ...result,
      });
    } catch (error) {
      summary.failed += 1;
      summary.results.push({
        localCheckoutSessionId: localSession.id,
        stripeCheckoutSessionId: localSession.stripeCheckoutSessionId,
        outcome: 'failed',
        errorCode: error?.code ?? null,
      });
      log.error(
        {
          err: error,
          event: 'billing_checkout_session_drain_failed',
          localCheckoutSessionId: localSession.id,
          stripeCheckoutSessionId: formatStripeIdForLog(
            localSession.stripeCheckoutSessionId,
            'error'
          ),
        },
        'Failed to drain open Checkout Session during emergency halt'
      );
    }
  }

  return summary;
}
