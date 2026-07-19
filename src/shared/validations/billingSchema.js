import { z } from 'zod';
import {
  BILLING_ENTITLEMENTS,
  BILLING_PLANS,
  BILLING_SUBSCRIPTION_STATUSES,
} from '../constants/billing.js';

const BILLING_ENTITLEMENT_VALUES = Object.values(BILLING_ENTITLEMENTS);
const BILLING_PLAN_VALUES = Object.values(BILLING_PLANS);
const BILLING_SUBSCRIPTION_STATUS_VALUES = Object.values(BILLING_SUBSCRIPTION_STATUSES);
const STRIPE_CHECKOUT_SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9_]+$/;
const CHECKOUT_ATTEMPT_NONCE_PATTERN = /^[A-Fa-f0-9]{32}$/;

/**
 * Require entitlement and subscription presence flags to match canonical data.
 *
 * @param {object} billingStatus - Parsed canonical billing fields.
 * @param {import('zod').RefinementCtx} context - Zod issue collector.
 * @returns {void}
 */
function validateBillingStatusSubscriptionConsistency(billingStatus, context) {
  const hasCanonicalEntitlement = billingStatus.entitlement !== null;
  const hasCanonicalSubscriptionStatus = billingStatus.status !== null;

  if (billingStatus.entitled !== hasCanonicalEntitlement) {
    context.addIssue({
      code: 'custom',
      path: ['entitlement'],
      message: 'Entitled access and entitlement must agree',
    });
  }

  if (billingStatus.hasSubscription !== hasCanonicalSubscriptionStatus) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'Subscription presence and status must agree',
    });
  }
}

export const billingStatusSchema = z.object({
  entitled: z.boolean(),
  entitlement: z.enum(BILLING_ENTITLEMENT_VALUES).nullable(),
  status: z.enum(BILLING_SUBSCRIPTION_STATUS_VALUES).nullable(),
  currentPeriodEnd: z.iso.datetime({ offset: true }).nullable(),
  cancelAtPeriodEnd: z.boolean(),
  hasCustomerMapping: z.boolean(),
  hasPortalCustomer: z.boolean(),
  hasSubscription: z.boolean(),
}).strict().superRefine(validateBillingStatusSubscriptionConsistency);

export const billingCheckoutSchema = z.object({
  plan: z.enum(BILLING_PLAN_VALUES, { error: 'Invalid billing plan' }),
  checkoutAttemptNonce: z.string()
    .trim()
    .regex(CHECKOUT_ATTEMPT_NONCE_PATTERN, 'Invalid checkout attempt nonce')
    .transform((nonce) => nonce.toLowerCase()),
}).strict();

export const billingCheckoutStatusSchema = z.object({
  sessionId: z.string()
    .trim()
    .min(1, 'Checkout session id is required')
    .max(255, 'Checkout session id is too long')
    .regex(STRIPE_CHECKOUT_SESSION_ID_PATTERN, 'Invalid checkout session id'),
});
