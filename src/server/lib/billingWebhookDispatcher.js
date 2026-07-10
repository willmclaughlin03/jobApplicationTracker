import {
  assertStripeLivemode,
  BILLING_WRITE_OUTCOMES,
  STRIPE_EVENT_RECEIPT_RESULTS,
  claimStripeEventReceiptProcessing,
  formatStripeIdForLog,
  getStripeEventReceiptForEvent,
  hasMatchingStripeEventReceiptEnvelope,
  markMintedCheckoutSessionTerminalByStripeSessionId,
  markSubscriptionDeletedFromEvent,
  reconcileSubscriptionEventConflict,
  recordStripeEventReceipt,
  syncSubscriptionFromEvent,
} from './billingService.js';
import { reconcileStorageTransitionsForUser } from '../services/storageTransitionService.js';

const SUBSCRIPTION_CREATED = 'customer.subscription.created';
const SUBSCRIPTION_UPDATED = 'customer.subscription.updated';
const SUBSCRIPTION_DELETED = 'customer.subscription.deleted';
const INVOICE_PAID = 'invoice.paid';
const INVOICE_PAYMENT_FAILED = 'invoice.payment_failed';
const INVOICE_PAYMENT_ACTION_REQUIRED = 'invoice.payment_action_required';
const CHECKOUT_SESSION_COMPLETED = 'checkout.session.completed';
const CHECKOUT_SESSION_EXPIRED = 'checkout.session.expired';

const TERMINAL_SUCCESS_RECEIPT_RESULTS = new Set([
  STRIPE_EVENT_RECEIPT_RESULTS.PROCESSED,
  STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED,
]);

/**
 * Create a dispatcher error with a stable code for route and test assertions.
 *
 * Purpose: webhook failures need explicit operational meaning without exposing
 * raw Stripe event data or provider payload fragments in thrown messages.
 *
 * @param {string} message
 * @param {string} code
 * @returns {Error & { code: string }}
 */
function createBillingWebhookError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Reduce a verified Stripe event to the only fields safe for structured logs.
 *
 * Purpose: webhook logs should be useful for correlation without writing raw
 * event payloads, nested objects, customer emails, or invoice details.
 *
 * @param {object} event
 * @returns {{ id: string | null, type: string | null, livemode: boolean | null, created: unknown }}
 */
function getStripeEventEnvelope(event) {
  return {
    id: typeof event?.id === 'string' ? event.id : null,
    type: typeof event?.type === 'string' ? event.type : null,
    livemode: typeof event?.livemode === 'boolean' ? event.livemode : null,
    created: event?.created ?? null,
  };
}

/**
 * Normalize Stripe's event-created value for mismatch log comparisons.
 *
 * Purpose: Stripe events usually carry integer seconds while receipt rows carry
 * ISO strings, so envelope-mismatch logs should show comparable timestamps
 * without changing the raw event validation or receipt comparison contract.
 *
 * @param {unknown} created
 * @returns {string | unknown | null}
 */
function normalizeStripeEventCreatedForLog(created) {
  if (created === null || created === undefined) {
    return null;
  }

  const createdDate = typeof created === 'number'
    || (typeof created === 'string' && /^\d+$/.test(created))
    ? new Date(Number(created) * 1000)
    : new Date(created);

  return Number.isFinite(createdDate.getTime())
    ? createdDate.toISOString()
    : created;
}

/**
 * Build a Stripe event log envelope with a human-readable created timestamp.
 *
 * Purpose: receipt-envelope mismatch logs need the same safe fields as normal
 * webhook logs, plus a timestamp shape that operators can compare directly to
 * the stored receipt row.
 *
 * @param {object} event
 * @returns {{ id: string | null, type: string | null, livemode: boolean | null, created: string | unknown | null }}
 */
function getStripeEventEnvelopeForReceiptLog(event) {
  return {
    ...getStripeEventEnvelope(event),
    created: normalizeStripeEventCreatedForLog(event?.created),
  };
}

/**
 * Resolve a Stripe object id from string or expanded-object shapes.
 *
 * Purpose: Stripe webhook payload fields may contain either plain ids or
 * expanded objects; dispatch only needs the stable object id.
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
 * Extract a subscription id from supported Stripe invoice webhook shapes.
 *
 * Purpose: current Stripe invoice events can nest subscription details under
 * `parent.subscription_details`, while older shapes used direct fields.
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
 * Convert a billing write outcome into the receipt result contract.
 *
 * Purpose: stale events are successful webhook deliveries but need a distinct
 * durable result so later duplicates can short-circuit without reprocessing.
 *
 * @param {object | null | undefined} dispatchResult
 * @returns {string}
 */
function getReceiptResultForDispatchResult(dispatchResult) {
  return dispatchResult?.outcome === BILLING_WRITE_OUTCOMES.STALE_IGNORED
    ? STRIPE_EVENT_RECEIPT_RESULTS.STALE_IGNORED
    : STRIPE_EVENT_RECEIPT_RESULTS.PROCESSED;
}

/**
 * Reconcile a database-declared equal-timestamp conflict before finalization.
 *
 * Purpose: event handlers retain the Stripe subscription id they validated,
 * while the billing service owns the strict reread and guarded authoritative
 * purpose. Different/absent local targets fail before a new Stripe retrieval.
 *
 * @param {string} subscriptionId subscription named by the verified event.
 * @param {object} dispatchResult initial event-mode billing result.
 * @param {object} log request-scoped logger.
 * @returns {Promise<object>} original safe result or reconciled result.
 */
async function reconcileEqualTimestampDispatchResult(
  subscriptionId,
  dispatchResult,
  log
) {
  if (dispatchResult?.outcome !== BILLING_WRITE_OUTCOMES.RECONCILE_REQUIRED) {
    return dispatchResult;
  }

  if (typeof dispatchResult?.userId !== 'string' || !dispatchResult.userId.trim()) {
    throw createBillingWebhookError(
      'Equal-timestamp billing reconciliation is missing its local owner',
      'BILLING_WEBHOOK_RECONCILIATION_INVALID'
    );
  }

  return reconcileSubscriptionEventConflict(
    subscriptionId,
    dispatchResult.userId,
    log
  );
}

/**
 * Fail closed if any dispatcher path forgets equal-timestamp reconciliation.
 *
 * Purpose: receipt mapping treats most non-stale outcomes as processed for
 * existing safe ignores, so this central boundary prevents a future event
 * handler from terminally acknowledging an unresolved conflict by omission.
 *
 * @param {object|null|undefined} dispatchResult
 * @returns {void}
 */
function assertNoUnresolvedBillingConflict(dispatchResult) {
  if (dispatchResult?.outcome === BILLING_WRITE_OUTCOMES.RECONCILE_REQUIRED) {
    throw createBillingWebhookError(
      'Stripe billing event still requires reconciliation',
      'BILLING_WEBHOOK_RECONCILIATION_REQUIRED'
    );
  }
}

/**
 * Record a failed receipt without hiding the original dispatch failure.
 *
 * Purpose: Stripe should retry the original processing error, while secondary
 * receipt-write failures remain visible as their own operational signal.
 *
 * @param {object} event
 * @param {unknown} originalError
 * @param {object} log
 * @returns {Promise<void>}
 */
async function recordFailedReceiptBestEffort(event, originalError, log) {
  try {
    await recordStripeEventReceipt(event, STRIPE_EVENT_RECEIPT_RESULTS.FAILED, log);
  } catch (receiptError) {
    log.error(
      {
        err: receiptError,
        originalErrorCode: originalError?.code,
        stripeEvent: getStripeEventEnvelope(event),
      },
      'Failed to record failed Stripe webhook receipt after dispatcher error'
    );
  }
}

/**
 * Resolve the local user id that is safe for post-billing storage repair.
 *
 * Purpose: only processed billing writes with a server-resolved local user id
 * should trigger storage transition repair; stale, malformed, customer-missing,
 * or unsupported outcomes must remain non-mutating.
 *
 * @param {object|null|undefined} dispatchResult
 * @returns {string|null}
 */
function getProcessedBillingUserId(dispatchResult) {
  if (
    dispatchResult?.outcome !== BILLING_WRITE_OUTCOMES.PROCESSED
    || typeof dispatchResult?.userId !== 'string'
  ) {
    return null;
  }

  const userId = dispatchResult.userId.trim();
  return userId || null;
}

/**
 * Run storage transition repair after a successful billing reconcile.
 *
 * Purpose: webhook deliveries are the earliest authoritative signal that a
 * cancellation reached terminal Free or Premium entitlement returned, so
 * storage transitions run before the receipt is marked processed. Failures
 * then retry through Stripe safely.
 *
 * @param {object|null|undefined} dispatchResult
 * @param {object} log
 * @returns {Promise<void>}
 */
async function repairStorageTransitionsAfterBillingDispatch(dispatchResult, log) {
  const userId = getProcessedBillingUserId(dispatchResult);

  if (!userId) {
    return;
  }

  const repairResult = await reconcileStorageTransitionsForUser(userId, log);

  if (repairResult.error) {
    throw repairResult.error;
  }
}

/**
 * Terminalize a locally minted Checkout Session after safe webhook handling.
 *
 * Purpose: terminal Checkout webhooks can release a pending local checkout row
 * even when the browser never returns to the success polling route, but
 * entitlement still comes only from canonical billing subscription state.
 *
 * @param {string | null} sessionId
 * @param {'complete' | 'expired'} status
 * @param {object} log
 * @returns {Promise<void>}
 */
async function terminalizeCheckoutSessionQuietly(sessionId, status, log) {
  if (!sessionId) {
    return;
  }

  try {
    await markMintedCheckoutSessionTerminalByStripeSessionId(
      {
        sessionId,
        status,
      },
      log
    );
  } catch (error) {
    log.warn(
      {
        err: error,
        event: 'billing_checkout_session_terminalize_failed',
        stripeCheckoutSessionId: formatStripeIdForLog(sessionId, 'warn'),
        status,
      },
      'Failed to terminalize pending Checkout Session after webhook handling'
    );
  }
}

/**
 * Sync a subscription event that must include a subscription object id.
 *
 * Purpose: lifecycle events are malformed if the subscription id is absent;
 * guessing ownership from any other payload field would weaken webhook safety.
 *
 * @param {object} event
 * @param {object} log
 * @returns {Promise<object>}
 */
async function dispatchSubscriptionSyncEvent(event, log) {
  const subscriptionId = extractStripeId(event?.data?.object);

  if (!subscriptionId) {
    throw createBillingWebhookError(
      'Stripe subscription webhook is missing a subscription id',
      'BILLING_WEBHOOK_MALFORMED_EVENT'
    );
  }

  const syncResult = await syncSubscriptionFromEvent(
    subscriptionId,
    event.created,
    log
  );

  return reconcileEqualTimestampDispatchResult(subscriptionId, syncResult, log);
}

/**
 * Persist the local terminal snapshot for a subscription delete event.
 *
 * Purpose: delete webhooks use the event object itself for the canceled
 * snapshot and reuse the billing service's current-subscription guard.
 *
 * @param {object} event
 * @param {object} log
 * @returns {Promise<object>}
 */
async function dispatchSubscriptionDeletedEvent(event, log) {
  const subscription = event?.data?.object;

  if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)) {
    throw createBillingWebhookError(
      'Stripe subscription delete webhook is missing a subscription object',
      'BILLING_WEBHOOK_MALFORMED_EVENT'
    );
  }

  const subscriptionId = extractStripeId(subscription);

  if (!subscriptionId) {
    throw createBillingWebhookError(
      'Stripe subscription delete webhook is missing a subscription id',
      'BILLING_WEBHOOK_MALFORMED_EVENT'
    );
  }

  const deleteResult = await markSubscriptionDeletedFromEvent(
    subscription,
    {
      eventCreated: event?.created,
      livemode: event?.livemode,
    },
    log
  );

  return reconcileEqualTimestampDispatchResult(subscriptionId, deleteResult, log);
}

/**
 * Sync invoice-backed subscription changes when the invoice exposes a sub id.
 *
 * Purpose: invoices without subscription ids are safe handled no-ops; retries
 * will not invent missing linkage for support-created or future invoice shapes.
 *
 * @param {object} event
 * @param {object} log
 * @returns {Promise<object>}
 */
async function dispatchInvoiceEvent(event, log) {
  const subscriptionId = extractSubscriptionIdFromInvoice(event?.data?.object);

  if (!subscriptionId) {
    return {
      outcome: BILLING_WRITE_OUTCOMES.PROCESSED,
      reason: 'invoice_subscription_missing',
    };
  }

  const syncResult = await syncSubscriptionFromEvent(
    subscriptionId,
    event.created,
    log
  );

  return reconcileEqualTimestampDispatchResult(subscriptionId, syncResult, log);
}

/**
 * Monitor and sync invoices that require customer payment authentication.
 *
 * Purpose: action-required invoices should be visible as a recovery signal and
 * should refresh local subscription state without granting entitlement directly
 * from the invoice payload.
 *
 * @param {object} event
 * @param {object} log
 * @returns {Promise<object>}
 */
async function dispatchInvoicePaymentActionRequiredEvent(event, log) {
  log.warn(
    {
      event: 'billing_invoice_payment_action_required',
      stripeEvent: getStripeEventEnvelope(event),
    },
    'Stripe invoice requires payment action'
  );

  return dispatchInvoiceEvent(event, log);
}

/**
 * Sync completed subscription Checkout Sessions and release pending rows.
 *
 * Purpose: the webhook can reconcile canonical billing state and then release
 * local pending checkout dedupe state without granting entitlement from the
 * Checkout Session row itself.
 *
 * @param {object} event
 * @param {object} log
 * @returns {Promise<object>}
 */
async function dispatchCheckoutSessionCompletedEvent(event, log) {
  const checkoutSession = event?.data?.object;
  const checkoutSessionId = extractStripeId(checkoutSession);

  if (!checkoutSessionId) {
    throw createBillingWebhookError(
      'Stripe checkout.session.completed webhook is missing a session id',
      'BILLING_WEBHOOK_MALFORMED_EVENT'
    );
  }

  const subscriptionId = extractStripeId(checkoutSession?.subscription);
  const syncResult = subscriptionId
    ? await reconcileEqualTimestampDispatchResult(
      subscriptionId,
      await syncSubscriptionFromEvent(subscriptionId, event.created, log),
      log
    )
    : {
      outcome: BILLING_WRITE_OUTCOMES.PROCESSED,
      reason: 'checkout_subscription_missing',
    };

  await terminalizeCheckoutSessionQuietly(checkoutSessionId, 'complete', log);

  return syncResult;
}

/**
 * Release a local pending Checkout Session after Stripe expires it.
 *
 * Purpose: expiration events make abandoned or emergency-expired Checkout URLs
 * terminal locally without granting entitlement from the pending-session row.
 *
 * @param {object} event
 * @param {object} log
 * @returns {Promise<object>}
 */
async function dispatchCheckoutSessionExpiredEvent(event, log) {
  const checkoutSession = event?.data?.object;
  const checkoutSessionId = extractStripeId(checkoutSession);

  if (!checkoutSessionId) {
    throw createBillingWebhookError(
      'Stripe checkout.session.expired webhook is missing a session id',
      'BILLING_WEBHOOK_MALFORMED_EVENT'
    );
  }

  await markMintedCheckoutSessionTerminalByStripeSessionId(
    {
      sessionId: checkoutSessionId,
      status: 'expired',
    },
    log
  );

  return {
    outcome: BILLING_WRITE_OUTCOMES.PROCESSED,
    reason: 'checkout_session_expired',
  };
}

/**
 * Dispatch a verified Stripe event through the explicit billing event map.
 *
 * Purpose: supported webhook behavior should stay obvious and auditable rather
 * than using inferred method names or generic object handlers.
 *
 * @param {object} event
 * @param {object} log
 * @returns {Promise<object>}
 */
async function dispatchStripeBillingEvent(event, log) {
  switch (event?.type) {
    case SUBSCRIPTION_CREATED:
    case SUBSCRIPTION_UPDATED:
      return dispatchSubscriptionSyncEvent(event, log);

    case SUBSCRIPTION_DELETED:
      return dispatchSubscriptionDeletedEvent(event, log);

    case INVOICE_PAID:
    case INVOICE_PAYMENT_FAILED:
      return dispatchInvoiceEvent(event, log);

    case INVOICE_PAYMENT_ACTION_REQUIRED:
      return dispatchInvoicePaymentActionRequiredEvent(event, log);

    case CHECKOUT_SESSION_COMPLETED:
      return dispatchCheckoutSessionCompletedEvent(event, log);

    case CHECKOUT_SESSION_EXPIRED:
      return dispatchCheckoutSessionExpiredEvent(event, log);

    default:
      log.warn(
        {
          event: 'billing_unknown_event_type',
          stripeEvent: getStripeEventEnvelope(event),
        },
        'Ignored unsupported Stripe billing webhook event type'
      );
      return {
        outcome: BILLING_WRITE_OUTCOMES.PROCESSED,
        reason: 'unknown_event_type',
      };
  }
}

/**
 * Process one verified Stripe billing webhook event.
 *
 * Purpose: this is the public webhook route's orchestration boundary: it
 * handles duplicate receipts, claims in-flight processing, dispatches supported
 * events, and records the final durable receipt result.
 *
 * @param {object} event
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function processBillingWebhookEvent(event, log) {
  const stripeEvent = getStripeEventEnvelope(event);

  assertStripeLivemode(stripeEvent.livemode, {
    operation: 'processBillingWebhookEvent',
    stripeEventId: stripeEvent.id,
    log,
  });

  let existingReceipt;

  try {
    existingReceipt = await getStripeEventReceiptForEvent(event, log);
  } catch (error) {
    if (error?.code === 'BILLING_EVENT_TIMESTAMP_IN_FUTURE') {
      log.error(
        {
          err: error,
          event: 'billing_webhook_future_timestamp_rejected',
          stripeEvent,
        },
        'Rejected Stripe webhook because the event timestamp is too far in the future'
      );
    }

    throw error;
  }

  if (existingReceipt) {
    if (!hasMatchingStripeEventReceiptEnvelope(event, existingReceipt)) {
      log.error(
        {
          event: 'billing_event_receipt_envelope_mismatch',
          stripeEvent: getStripeEventEnvelopeForReceiptLog(event),
          receipt: {
            eventId: formatStripeIdForLog(existingReceipt.eventId, 'error'),
            eventType: existingReceipt.eventType,
            livemode: existingReceipt.livemode,
            stripeEventCreated: existingReceipt.stripeEventCreated,
          },
        },
        'Rejected Stripe webhook because the event receipt envelope mismatched'
      );

      throw createBillingWebhookError(
        'Stripe event receipt envelope mismatch',
        'BILLING_EVENT_RECEIPT_ENVELOPE_MISMATCH'
      );
    }

    if (TERMINAL_SUCCESS_RECEIPT_RESULTS.has(existingReceipt.result)) {
      return {
        outcome: 'duplicate_suppressed',
        receiptResult: existingReceipt.result,
        duplicate: true,
      };
    }
  }

  const claimResult = await claimStripeEventReceiptProcessing(event, log);

  if (TERMINAL_SUCCESS_RECEIPT_RESULTS.has(claimResult?.receipt?.result)) {
    return {
      outcome: 'duplicate_suppressed',
      receiptResult: claimResult.receipt.result,
      duplicate: true,
    };
  }

  try {
    const dispatchResult = await dispatchStripeBillingEvent(event, log);
    assertNoUnresolvedBillingConflict(dispatchResult);
    await repairStorageTransitionsAfterBillingDispatch(dispatchResult, log);
    const receiptResult = getReceiptResultForDispatchResult(dispatchResult);

    await recordStripeEventReceipt(event, receiptResult, log);

    return {
      outcome: dispatchResult?.outcome ?? BILLING_WRITE_OUTCOMES.PROCESSED,
      receiptResult,
      duplicate: false,
    };
  } catch (error) {
    await recordFailedReceiptBestEffort(event, error, log);
    throw error;
  }
}
