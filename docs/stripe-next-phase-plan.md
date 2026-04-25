# Stripe Next-Phase Implementation Plan

## Purpose

This document redefines the post-Phase-0 Stripe rollout around one core
decision:

- local billing data in `billing_customers` and `billing_subscriptions` is the
  canonical source of truth for premium entitlement

This plan is intended for multi-reviewer use. Each chunk explains what it
covers, why it exists, what it depends on, the tradeoffs involved, the
must-have implementation requirements, and the key security decisions that
cannot be relaxed during coding.

## Current Repository State

Phase 0 has already aligned the repo documentation with reality:

- billing SQL `005` through `010` is stored in the repo-root `migrations/`
  folder and tracked in repo state
- repo-only fresh-schema replay is not available because historical migrations
  `001` through `004` are not stored in repo state
- `billing_subscriptions.status_changed_at` is database-managed by migration
  `009`
- `billing_subscriptions.user_id` depends on an existing
  `billing_customers.user_id` row via migration `008`
- the shared billing constants file already exists and includes
  `BILLING_PLANS.RESUME_TAILOR_MONTHLY`,
  `BILLING_ENTITLEMENTS.AI_TAILOR`, and
  `BILLING_SUBSCRIPTION_STATUSES`
- shared billing errors already exist, including
  `SUBSCRIPTION_REQUIRED`, `BILLING_SYNC_PENDING`,
  `WEBHOOK_SIGNATURE_INVALID`, `CHECKOUT_SESSION_INVALID`,
  `CHECKOUT_SESSION_OWNERSHIP_INVALID`, `BILLING_MISCONFIGURED`,
  `CHECKOUT_SESSION_FAILED`, and `PORTAL_SESSION_FAILED`
- tier operations already include `TAILOR`, `BILLING_READ`, and
  `BILLING_WRITE`
- no Stripe runtime code, billing service layer, or billing API routes exist yet

That means the billing database shape is tracked in repo state, but the runtime
still does not exist.

## Product Direction Locked In By This Plan

These are the intentional product and architecture decisions this plan assumes:

- upgraded users should receive more storage
- premium storage must move from auth metadata checks to local billing data
- local billing state must become the canonical entitlement source for both
  billing features and premium storage
- there is no implicit admin billing bypass in production
- webhook processing must reconcile canonical state from Stripe and then update
  the local database
- checkout redirects must never grant access on their own
- webhook events must never grant access directly from partial payloads

## Canonical Entitlement Rule

Premium entitlement is granted only when all of the following are true:

- a local `billing_subscriptions` row exists for the user
- `price_id` is allowlisted for the intended plan
- `status` is `active`

Premium entitlement is denied when any of the following are true:

- no local subscription row exists
- `price_id` is missing or not allowlisted
- `status` is `past_due`, `unpaid`, `canceled`, `paused`, `incomplete`, or
  `incomplete_expired`
- local state is missing and only auth metadata suggests the user is paid

## Global Cross-Phase Rules

These rules apply in every chunk below:

- `billing_customers` is the canonical local owner mapping between `user_id` and
  `stripe_customer_id`
- `billing_subscriptions` is the canonical local subscription state table
- `stripe_event_receipts` is the canonical dedupe and replay audit table
- service-role writes belong only in server-controlled reconcile, checkout, and
  webhook paths
- authenticated user clients may read only their own billing rows and may not
  write billing rows directly
- local billing state, not auth payload metadata, decides premium storage
- local billing state, not redirect success pages, decides premium access
- stale Stripe events must be ignored using `last_stripe_event_created`
- test and live webhook traffic must be separated using livemode checks
- webhook routes must use raw-body verification and must never log raw bodies or
  webhook signatures

## Review Lanes For Multiple Reviewers

This plan is organized so different reviewers can focus on different concerns:

1. Data model and entitlement reviewers
2. API and middleware reviewers
3. Security reviewers
4. Operational and deployment reviewers
5. Testing and rollout reviewers

## Dependency Chain

The chunks below are ordered intentionally:

1. Move entitlement and storage checks to local billing data
2. Add Stripe runtime foundations
3. Build the billing service and reconciliation layer
4. Add authenticated billing routes
5. Add the public webhook route
6. Validate rollout and operational readiness

Each later chunk depends on the invariants established by the earlier ones.

## Chunk 1: Canonical Local Entitlement And Premium Storage

### Why this chunk exists

The current app still derives "paid" behavior from auth payload metadata in
`src/server/lib/userTier.js`. That is no longer sufficient because the Stripe
rollout is designed around the local billing tables becoming canonical.

This chunk moves premium storage decisions to local billing data while
preserving the product requirement that upgraded users get more storage.

### What this chunk covers

- replace auth-metadata-driven storage checks with local billing checks
- preserve the storage increase for upgraded users
- centralize the entitlement rule so later billing routes reuse it
- keep the app behavior stable for free users

### What this chunk does not cover

- Stripe SDK setup
- webhook signature verification
- Checkout Session creation
- portal creation
- webhook route handling

### Expected files

- `src/server/lib/userTier.js`
- `src/server/lib/billingEntitlement.js` or `src/server/lib/billingService.js`
- `src/pages/api/index.js`
- `src/server/services/jobService.js`
- `src/shared/constants/tiers.js`
- `src/shared/constants/billing.js`
- `src/shared/constants/__tests__/tiers.test.js`
- `src/server/lib/__tests__/billingEntitlement.test.js` or
  `src/server/lib/__tests__/billingService.test.js`
- route tests for `POST /api`

### Expected edits

- add a server-side helper that resolves premium entitlement from local billing
  rows by `user_id`
- make job creation call that helper before deciding which storage tier to use
- keep `FREE.storage.maxJobs = 300`
- keep `PAID.storage.maxJobs = 3000`
- document that premium storage is intentional and tied to canonical local
  billing state
- stop using auth metadata as the authority for storage tier resolution

### Why this must come first

If later billing routes write canonical local state but the app still reads
auth metadata for storage, the system will have two competing truths. That
creates drift, support confusion, and hard-to-debug rollout behavior.

### Tradeoffs

- pro: one canonical source of truth for premium storage
- pro: future billing bugs are easier to reason about because the entitlement
  rule is centralized
- con: existing paid users need local billing rows before they continue to get
  premium storage
- con: this introduces a database read into a path that was previously based on
  request auth data only

### Must-have coding requirements

- entitlement logic must live in one reusable helper, not be duplicated across
  routes
- the helper must fail closed to `FREE` on missing rows or invalid states
- the helper must use the allowlisted `price_id` rule, not just `status`
- no admin bypass may be introduced
- comments must explain that premium storage is a deliberate product behavior,
  not a side effect of a generic paid tier

### Key security decisions

- auth metadata is not sufficient for premium storage authorization
- storage entitlement is an authorization decision and must be based on trusted
  server-side data
- missing or unresolved billing state must not silently grant premium storage

### Testing requirements

- allowlisted `active` subscription returns `PAID`
- missing subscription row returns `FREE`
- non-allowlisted `price_id` returns `FREE`
- `trialing`, `past_due`, `unpaid`, `canceled`, `paused`, `incomplete`, and
  `incomplete_expired` return `FREE`
- `POST /api` uses the locally resolved storage tier when enforcing job limits

## Chunk 2: Stripe Runtime Foundation

### Why this chunk exists

The repo currently has no Stripe runtime implementation. Before any billing
route or webhook can be added, the app needs a pinned Stripe client, price
allowlisting, environment validation, and a shared raw-body helper for webhook
verification.

### What this chunk covers

- add the Stripe SDK
- centralize Stripe client setup
- centralize plan-to-price allowlisting
- implement safe raw-body reading for webhook routes
- replace the current webhook verifier stub

### What this chunk does not cover

- subscription reconciliation logic
- billing row writes
- billing API routes

### Expected files

- `package.json`
- `package-lock.json`
- `src/server/lib/stripe.js`
- `src/server/lib/readRawBody.js`
- `src/server/lib/webhookSignature.js`
- `src/server/middleware/withWebhookAuth.js`
- `src/server/lib/__tests__/stripe.test.js`
- `src/server/lib/__tests__/readRawBody.test.js`
- `src/server/lib/__tests__/webhookSignature.test.js`
- `src/server/middleware/__tests__/withWebhookAuth.test.js`

### Expected edits

- add the `stripe` dependency
- create `stripe.js` with a pinned API version
- create `getPriceIdForPlan(BILLING_PLANS.RESUME_TAILOR_MONTHLY)`
- load and validate Stripe env vars at module init
- add a reusable raw-body helper with a hard size cap such as `256 KB`
- implement Stripe signature verification using
  `stripe.webhooks.constructEvent`
- make `withWebhookAuth` the central place for signature header gating and
  early webhook request validation

### Tradeoffs

- pro: later routes and services use one Stripe client and one verification path
- pro: safer than reimplementing raw-body logic in each webhook route
- con: module-init env validation will fail fast when Stripe configuration is
  missing
- con: this makes local development stricter, which is good for production
  safety but can surface config issues earlier

### Must-have coding requirements

- pin the Stripe API version explicitly
- never derive price authorization from Stripe product names at runtime
- never use Stripe Search as the source of truth for customer lookup
- raw-body helper must enforce an actual byte cap, not just trust
  `Content-Length`
- webhook verifier must return parsed events and must fail closed

### Key security decisions

- allowlisted price ids are the authorization boundary, not arbitrary Stripe
  catalog data
- webhook requests must be verified against the raw request body
- signature verification belongs in server middleware, not in client-visible
  flows
- test and live webhook secrets must remain separate

### Testing requirements

- `stripe.js` rejects unknown plans
- Stripe env validation fails when required values are missing
- raw-body helper rejects oversized payloads
- webhook verifier rejects missing or invalid signatures
- webhook middleware returns `503` when the verifier is misconfigured and `400`
  when the signature is invalid

## Chunk 3: Billing Service And Reconciliation Layer

### Why this chunk exists

Billing routes should stay thin. The hard parts of billing are customer
creation, canonical local state reads, stale-event protection, Stripe fetch
reconciliation, and receipt tracking. Those belong in a dedicated service
layer.

### What this chunk covers

- local customer creation and lookup
- local billing status reads
- premium entitlement resolution for billing-aware features
- canonical subscription sync from Stripe
- dedupe and stale-event receipt recording
- delete-event snapshot handling

### What this chunk does not cover

- user-facing route request validation
- response formatting for checkout and portal endpoints
- public webhook route wiring

### Expected files

- `src/server/lib/billingService.js`
- `src/server/lib/__tests__/billingService.test.js`

### Expected exported functions

- `getOrCreateStripeCustomer(userId, email, log)`
- `getLocalBillingStatus(userId, clientOrAdmin, log)`
- `resolveTailorEntitlement(userId, log)`
- `resolveStorageEntitlement(userId, log)` if this is not already introduced in
  Chunk 1
- `syncSubscriptionFromStripe(subscriptionId, log)`
- `recordStripeEventReceipt(event, result, log)`
- `markSubscriptionDeletedFromEvent(subscription, eventCreated, log)`

### Expected edits

- use `billing_customers` as the first lookup for customer mapping
- create placeholder `billing_customers` rows before creating Stripe
  subscriptions
- read canonical local subscription state from `billing_subscriptions`
- fetch current Stripe subscription data during reconcile and upsert local state
  by `user_id`
- compare incoming event ordering against
  `billing_subscriptions.last_stripe_event_created`
- write `processed`, `duplicate_ignored`, `stale_ignored`, or `failed` into
  `stripe_event_receipts`

### Why this must exist before routes

Without a shared service layer, checkout, portal, status, checkout-status, and
webhook routes would all duplicate entitlement and reconciliation logic. That
would make later bug fixes both risky and slow.

### Tradeoffs

- pro: one canonical place for billing logic
- pro: easier testing of edge cases like stale events and deleted subscriptions
- con: this introduces a larger service module before routes exist
- con: the service must be careful about which calls use the per-request client
  versus the service-role client

### Must-have coding requirements

- normal authenticated reads should use the per-request Supabase client where
  possible
- privileged writes must stay in server-controlled service code
- upserts must respect the `008` customer-first foreign key requirement
- stale-event handling must be explicit and testable
- delete-event handling must not erase forensic information needed for support
  or replay analysis

### Key security decisions

- local entitlement resolution must never trust client-provided session payloads
- local billing writes must never happen from authenticated client permissions
- older Stripe events must not overwrite newer local state
- billing ownership must resolve through local customer mappings, not directly
  from arbitrary webhook payload fields

### Testing requirements

- customer lookup uses local tables before any Stripe call
- missing customer row is created before local subscription insert
- allowlisted `active` subscriptions resolve entitlement
- non-allowlisted or inactive states do not resolve entitlement
- older `event.created` values are marked `stale_ignored`
- delete snapshots preserve a safe local terminal state

## Chunk 4: Authenticated Billing Routes

### Why this chunk exists

Once the entitlement and service foundations exist, the app can expose
user-facing billing endpoints without embedding Stripe business logic directly
into the route handlers.

### What this chunk covers

- checkout session creation
- billing portal session creation
- canonical local billing status reads
- checkout completion polling and reconciliation
- the exact request and response contract for billing success-page polling

### What this chunk does not cover

- the public webhook route
- any direct grant of access from redirects

### Expected files

- `src/shared/validations/billingSchema.js`
- `src/shared/validations/__tests__/billingSchema.test.js`
- `src/pages/api/billing/checkout.js`
- `src/pages/api/billing/portal.js`
- `src/pages/api/billing/status.js`
- `src/pages/api/billing/checkout-status.js`
- tests for each new route

### Expected edits

- `POST /api/billing/checkout`
- require auth and CSRF
- validate `{ plan }`
- resolve or create the local Stripe customer mapping
- reject users who already have active or unresolved local billing state
- create a subscription Checkout Session
- create the Checkout Session with:
- `mode: 'subscription'`
- `client_reference_id: user.id`
- `success_url: ${NEXT_PUBLIC_APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`
- `cancel_url: ${NEXT_PUBLIC_APP_URL}/billing/cancel`
- return only the hosted checkout URL

- `POST /api/billing/portal`
- require auth and CSRF
- load the Stripe customer from `billing_customers`
- create the hosted portal session

- `GET /api/billing/status`
- require auth
- read local canonical billing state only
- return entitlement, subscription status, current period end, and
  cancel-at-period-end
- set `Cache-Control: no-store`
- set `Vary: Cookie`

- `POST /api/billing/checkout-status`
- require auth and CSRF
- validate `{ sessionId }`
- fetch the Checkout Session from Stripe
- verify ownership through `client_reference_id` or server-controlled metadata
- read local billing state
- if Stripe reports completed checkout but local state is still free, trigger a
  server-side reconcile
- return one of these exact UI states:
- `pending`
- `active`
- `free`
- `error`

### Tradeoffs

- pro: routes stay thin and readable
- pro: local DB remains the app-facing truth
- con: checkout-status introduces Stripe reads during the success-page flow
- con: this path needs debounce or rate protection to avoid excessive polling

### Must-have coding requirements

- all request bodies must be schema-validated
- the route contracts above must be treated as part of the spec, not left as
  implementation-detail decisions
- `checkout-status` must not grant access directly from Stripe session
  completion
- `status` must return local state only
- `checkout-status` must verify session ownership before any reconcile
- status-like routes must send cache-hardening headers

### Key security decisions

- auth and CSRF are required for all mutable billing routes
- checkout completion is not itself proof of entitlement
- local billing state remains canonical even when Stripe says a checkout session
  completed
- ownership validation is required before revealing or reconciling a checkout
  session

### Testing requirements

- unauthenticated and CSRF-invalid requests fail correctly
- invalid plans are rejected
- checkout session creation uses the exact required Stripe fields
- portal creation fails closed when no customer mapping exists
- status route returns only local billing state
- checkout-status returns only `pending`, `active`, `free`, or `error`
- checkout-status rejects session ownership mismatches
- checkout-status triggers reconcile only in the expected pending case

## Chunk 5: Public Webhook Route And Event Processing

### Why this chunk exists

The webhook route is what keeps the local billing tables fresh after Stripe-side
events occur. It must be public, but it cannot be permissive.

### What this chunk covers

- public webhook route wiring
- raw-body verification
- dedupe behavior
- stale-event behavior
- canonical subscription sync triggers

### What this chunk does not cover

- browser-initiated billing actions
- client-visible entitlement decisions

### Expected files

- `src/pages/api/billing/webhook.js`
- `src/pages/api/billing/__tests__/webhook.test.js`
- `src/pages/api/__tests__/routeSafety.test.js` if needed

### Expected edits

- create a public `POST /api/billing/webhook` route
- set `export const config = { api: { bodyParser: false } }`
- wrap the route with `withWebhookAuth`
- require the Stripe signature header before raw-body buffering
- optionally require `Content-Type: application/json`
- reject obviously oversized `Content-Length` values
- read the raw body with a hard cap
- verify the event using the Stripe webhook secret
- enforce livemode compatibility
- dedupe through `stripe_event_receipts`
- handle these events as sync triggers:
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

### Canonical route behavior

- if the event is older than local `last_stripe_event_created`, record
  `stale_ignored` and return `200`
- if the event is already fully processed, record or preserve
  `duplicate_ignored` and return `200`
- when canonical Stripe subscription fetch is possible, fetch and upsert from
  Stripe rather than trusting partial payloads
- if no local `billing_customers` mapping exists, do not invent ownership from
  webhook payloads alone

### Tradeoffs

- pro: webhook route stays narrow and pushes complex logic into the service layer
- pro: stale-event guards reduce race-condition damage
- con: this route depends on correct CloudFront header forwarding for
  `Stripe-Signature`
- con: if WAF is delayed, the route still needs application-layer cheap
  rejection and body caps

### Must-have coding requirements

- method gate before any expensive work
- never parse JSON before signature verification
- never log raw body buffers
- never grant entitlement directly from webhook payload fragments
- always return `2xx` for safely ignored duplicates and stale events so Stripe
  does not retry forever

### Key security decisions

- webhook signature verification is mandatory
- public access does not mean unauthenticated trust
- livemode mismatch must fail closed
- local ownership must not be inferred from untrusted webhook payloads when no
  canonical customer mapping exists

### Testing requirements

- rejects non-POST methods
- rejects missing signature headers
- rejects oversized payloads
- rejects livemode mismatches
- records duplicate and stale receipt outcomes correctly
- triggers sync on the supported event types

## Chunk 6: Rollout, Backfill, And Operational Readiness

### Why this chunk exists

The code alone is not enough. Because premium storage is moving to canonical
local billing data, rollout safety depends on environment wiring, data
availability, and operational checks.

### What this chunk covers

- environment validation
- billing data backfill expectations
- CloudFront and deployment checks
- final test and rollout checklist

### Required operational checks

- confirm `Stripe-Signature` is forwarded by CloudFront to the origin
- confirm webhook secrets are configured separately for test and live traffic
- confirm price id environment variables match the allowlist in `stripe.js`
- confirm `NEXT_PUBLIC_APP_URL` is correct for checkout and portal return URLs
- decide whether WAF IP allowlisting ships in v1 or immediately after

### Backfill requirement

Because premium storage is moving to local billing data, existing upgraded users
must have correct local billing rows before the entitlement switch becomes
authoritative in production.

Acceptable rollout paths:

- backfill local billing rows before enabling canonical local entitlement
- ship the entitlement switch only after webhook and reconcile flows are live

### Tradeoffs

- pro: rollout is safer when local data is complete before it becomes
  authoritative
- con: this may require staging or operational coordination before production
  enablement

### Must-have coding and rollout requirements

- no production cutover without verifying local entitlement coverage for paid
  users
- no production cutover without webhook secret and CloudFront forwarding checks
- no production cutover without route tests, service tests, and webhook tests

### Key security decisions

- operational misconfiguration is treated as a security and integrity risk, not
  just an availability issue
- Stripe signature forwarding and secret separation are release blockers

### Final validation checklist

- unit tests for entitlement, Stripe client, raw-body helper, and webhook
  verification pass
- route tests for checkout, portal, status, checkout-status, and webhook pass
- billing integration tests pass in the configured integration environment
- CloudFront header forwarding is verified
- existing paid users have local billing state before the canonical entitlement
  switch is relied upon

## Non-Negotiable Security Decisions

These decisions apply across the entire project and should be treated as
review-blocking if violated:

- no implicit admin bypass for billing entitlement
- no entitlement grants from redirect success pages
- no entitlement grants from partial webhook payloads
- no use of auth metadata as the canonical paid entitlement source
- no client write access to billing tables
- no webhook signature verification against parsed JSON instead of raw body
- no acceptance of test-mode events in live-mode environments or vice versa
- no storage upgrade unless canonical local billing data says the user is
  entitled

## Suggested Review Questions

Each reviewer should be able to answer these before approval:

1. Does the plan preserve premium storage while moving entitlement authority to
   local billing data?
2. Is there exactly one canonical entitlement rule?
3. Are customer ownership and subscription ownership always resolved through the
   local billing tables?
4. Can stale Stripe events overwrite newer local state anywhere in the plan?
5. Is there any place where redirects or partial webhook payloads could grant
   access directly?
6. Are all mutable billing routes protected by auth and CSRF?
7. Are operational dependencies clearly called out as release blockers?
