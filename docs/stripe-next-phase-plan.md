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
- the canonical Stripe event ingress for this plan is a Stripe webhook
  endpoint, not Amazon EventBridge
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
- write `processed`, `stale_ignored`, or `failed` into
  `stripe_event_receipts`, and preserve an existing `processed` receipt instead
  of downgrading it on later duplicate deliveries

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
- minimal billing pages for Stripe redirects
- authenticated navigation entry to the billing surface

### What this chunk does not cover

- the public webhook route
- any direct grant of access from redirects

### Expected files

- `src/shared/validations/billingSchema.js`
- `src/shared/validations/__tests__/billingSchema.test.js`
- `src/server/lib/billingService.js`
- `src/pages/api/billing/checkout.js`
- `src/pages/api/billing/portal.js`
- `src/pages/api/billing/status.js`
- `src/pages/api/billing/checkout-status.js`
- `src/pages/billing/index.js`
- `src/pages/billing/success.js`
- `src/pages/billing/cancel.js`
- `src/client/components/ProfileDropdown.jsx`
- tests for each new route

### Implementation order

1. add `billingSchema.js` and its tests before any route work
2. add route-facing billing helpers in `billingService.js`
3. implement `GET /api/billing/status`
4. implement `POST /api/billing/portal`
5. implement `POST /api/billing/checkout`
6. implement `POST /api/billing/checkout-status`
7. implement `/billing`, `/billing/success`, and `/billing/cancel`
8. run route safety and billing route tests last

### Major decisions and implementation references

- Decision: keep the standard API envelope `{ data, error, message }` for all
  billing routes.
  - Reference in current code:
    - `src/shared/response.js`
    - existing API routes under `src/pages/api/`
  - Reasoning:
    - the repo already centralizes response formatting through
      `createSuccessResponse()` and `createErrorResponse()`
    - returning naked JSON for billing would create a second response contract
      and make client handling driftier over time
    - billing payloads should therefore be:
      - `data: { url }`
      - `data: { state }`
      - `data: { entitlement, status, currentPeriodEnd, cancelAtPeriodEnd }`

- Decision: validate `NEXT_PUBLIC_APP_URL` at module init and fail fast.
  - Reference in current code:
    - `src/server/lib/stripe.js`
    - `src/server/lib/csrf.js`
  - Reasoning:
    - this repo already treats critical Stripe and CSRF config as startup-time
      validation, not a best-effort runtime concern
    - checkout redirect targets are security- and integrity-sensitive, so a
      missing or malformed origin must stop startup instead of producing broken
      Stripe redirect URLs
    - require `https://` in production
    - allow `http://localhost`, `http://127.0.0.1`, and `http://[::1]` only in
      non-production
    - never derive the origin from request headers

- Decision: keep route logic thin by adding route-facing billing helpers instead
  of duplicating state logic in each API file.
  - Reference in current code:
    - `src/server/lib/billingService.js`
    - Chunk 3 in this plan
  - Reasoning:
    - the service layer already owns customer creation, canonical status reads,
      livemode checks, and authoritative reconciliation
    - billing routes should compose those helpers rather than branching on raw
      Stripe and Supabase details directly

- Decision: add `loadBillingStatusOrThrow(...)` beside
  `getLocalBillingStatus(...)`.
  - Reference in current code:
    - `src/server/lib/billingService.js`
  - Reasoning:
    - `getLocalBillingStatus(...)` intentionally fails closed to a synthetic
      free status on missing client or DB failure
    - that behavior is correct for entitlement gating, but unsafe for:
      - checkout eligibility, where a transient read failure could look like
        "no subscription"
      - checkout-status, where a transient read failure could look like `free`
        for a paid user
    - the new helper should reuse the same underlying reads but throw on route-
      blocking failures so the route can return `503`

- Decision: `POST /api/billing/checkout-status` must remain `POST`, not `GET`.
  - Reference in current code:
    - `src/server/middleware/withRateLimit.js`
  - Reasoning:
    - `withRateLimit(...)` only applies CSRF validation to state-changing
      methods: `POST`, `PUT`, `DELETE`, and `PATCH`
    - checkout-status can trigger authoritative reconcile work, so it is not a
      pure read route
    - turning it into `GET` would skip CSRF on a route that can write

- Decision: every new billing route must declare `allowedMethods`.
  - Reference in current code:
    - `src/server/middleware/withRateLimit.js`
  - Reasoning:
    - the middleware fails closed with `405` when `allowedMethods` is omitted
    - explicit method declarations also prevent quota drain on junk methods

- Decision: keep webhook concerns out of Chunk 4.
  - Reference in current code:
    - `src/server/lib/readRawBody.js`
    - `src/server/lib/webhookSignature.js`
    - `src/server/middleware/withWebhookAuth.js`
  - Reasoning:
    - the raw-body and webhook-signature foundations already exist and belong to
      Chunk 5
    - Chunk 4 should not duplicate webhook verification or public-route logic

### Route contracts

- `GET /api/billing/status`
  - Reference in current code:
    - `src/server/middleware/withRateLimit.js`
    - `src/server/lib/billingService.js`
  - Reasoning:
    - wrap with `withRateLimit(..., { requireAuth: true, operation:
      OPERATIONS.BILLING_READ, allowedMethods: ['GET'] })`
    - the route must stay local-state-only and must never reconcile
    - GET routes skip CSRF validation in the middleware, so no mutation can
      hide here later
    - return only canonical local fields in `data`
    - set `Cache-Control: no-store`, `Vary: Cookie`, `Pragma: no-cache`, and
      `CDN-Cache-Control: no-store`

- `POST /api/billing/portal`
  - Reference in current code:
    - `src/server/middleware/withRateLimit.js`
    - `src/server/lib/billingService.js`
  - Reasoning:
    - wrap with `withRateLimit(..., { requireAuth: true, operation:
      OPERATIONS.BILLING_WRITE, allowedMethods: ['POST'] })`
    - rely on the middleware's default auth then CSRF then rate-limit order
    - fail closed when no local customer mapping exists
    - return only `data.url`

- `POST /api/billing/checkout`
  - Reference in current code:
    - `src/server/lib/billingService.js`
    - `src/server/lib/stripe.js`
    - `src/server/middleware/withRateLimit.js`
  - Reasoning:
    - validate a strict `{ plan }` request body through `billingSchema.js`
    - reject client-provided checkout nonce or idempotency fields
    - call `loadBillingStatusOrThrow(...)` before
      `getOrCreateStripeCustomer(...)`
    - this order matters because `getOrCreateStripeCustomer(...)` can upsert a
      placeholder `billing_customers` row before any Stripe call
    - use `getPriceIdForPlan(...)` for the allowlisted Stripe price
    - create the Checkout Session with:
      - `mode: 'subscription'`
      - `client_reference_id: user.id`
      - validated `success_url`
      - validated `cancel_url`
      - no trial settings
    - return only `data.url`

- Decision: checkout eligibility must be explicit and fail closed on unknown
  states.
  - Reference in current code:
    - `src/server/lib/billingService.js`
    - `src/shared/constants/billing.js`
  - Reasoning:
    - local billing status preserves raw subscription status values instead of
      coercing them into a smaller UI enum
    - eligibility must therefore check canonical status membership, not just
      `entitled === false`
    - allow checkout only when:
      - there is no local subscription row
      - status is `canceled`
      - status is `incomplete_expired`
    - block checkout when status is:
      - `active`
      - `past_due`
      - `unpaid`
      - `paused`
      - `incomplete`
      - any unknown or corrupt value

- Decision: checkout session creation must use a time-bucketed idempotency key.
  - Reference in current code:
    - `src/server/lib/billingService.js`
    - `src/pages/api/billing/checkout.js`
    - `src/shared/validations/billingSchema.js`
  - Reasoning:
    - the existing customer-creation helper already uses a stable Stripe
      idempotency key per user
    - checkout session creation needs narrower dedupe semantics than customer
      creation
    - idempotency entropy must be server-owned and must not come from the
      request body, browser crypto, or any other client nonce
    - use a key shaped like:
      `billing_checkout_${userHash.slice(0, 24)}_${plan}_${hourBucketUtc}`
    - `hourBucketUtc` is `Math.floor(Date.now() / (60 * 60 * 1000))`
    - this suppresses duplicate submissions within the same UTC hour and
      intentionally replays the same Checkout Session URL for retries in that
      window
    - tradeoff: a user may be sent back to an abandoned session URL for up to
      one UTC hour; this is acceptable as the immediate minimal fix because
      Stripe Checkout Sessions are valid for 24 hours by default
    - follow-up: consider a Redis-backed short-TTL server nonce keyed by
      `userId + plan` to dedupe only active submit windows, such as 60 to 120
      seconds

- `POST /api/billing/checkout-status`
  - Reference in current code:
    - `src/server/lib/billingService.js`
    - `src/server/middleware/withRateLimit.js`
    - `src/client/lib/api.js`
  - Reasoning:
    - wrap with `withRateLimit(..., { requireAuth: true, operation:
      OPERATIONS.BILLING_WRITE, allowedMethods: ['POST'] })`
    - validate `{ sessionId }`
    - fetch the Checkout Session from Stripe
    - verify ownership with `client_reference_id` before any reconcile
    - assert Stripe livemode after ownership verification
    - then do strict local billing read
    - if Stripe shows completed checkout and local state is still non-entitled,
      trigger at most one authoritative reconcile
    - if a completed session had confirmed ownership, a usable subscription id,
      and an attempted authoritative reconcile, but the refreshed local status
      is still non-entitled, return terminal `data.state = 'error'` instead of
      quietly reporting `free`
    - return exactly one of these UI states in `data.state`:
      - `pending`
      - `active`
      - `free`
      - `error`

- Decision: transport failures in `checkout-status` must preserve the standard
  `503 SERVICE_UNAVAILABLE` code.
  - Reference in current code:
    - `src/client/lib/api.js`
    - `src/server/middleware/withRateLimit.js`
  - Reasoning:
    - the shared API client only retries when `data?.error` is exactly
      `SERVICE_UNAVAILABLE`
    - using a billing-specific retryable 503 code would silently disable the
      built-in retry loop on the success page
    - this applies to retryable Stripe, Redis, configuration, and strict-read
      transport failures

### Billing success-page contract

- Decision: the success page must use the shared authenticated API helper, not
  raw `fetch`.
  - Reference in current code:
    - `src/client/lib/api.js`
    - `src/server/lib/csrf.js`
    - `src/pages/api/auth/csrf.js`
  - Reasoning:
    - `apiRequest(...)` already handles:
      - retrying `503 SERVICE_UNAVAILABLE`
      - refreshing CSRF on `403 CSRF_VALIDATION_FAILED`
    - the CSRF cookie is a signed, user-bound token with a finite lifetime
    - using raw `fetch` would duplicate this logic and make long-lived billing
      flows more fragile

- Decision: use a bounded fixed poll schedule on `/billing/success`.
  - Reference in current code:
    - `src/client/lib/api.js`
    - `src/shared/constants/tiers.js`
    - `src/server/middleware/withRateLimit.js`
  - Reasoning:
    - billing write quota is intentionally limited
    - `apiRequest(...)` can retry `503` twice before surfacing failure
    - CSRF validation happens before rate limiting, so forged or stale CSRF
      requests do not consume billing quota
    - use this fixed schedule:
      - immediate
      - `+3s`
      - `+10s`
      - `+30s`
      - `+60s`
    - then stop polling

- Decision: define terminal and non-terminal success-page stop rules up front.
  - Reference in current code:
    - `src/client/lib/api.js`
    - `src/server/middleware/withRateLimit.js`
  - Reasoning:
    - the shared client returns `401` differently from `429` and `503`
    - without explicit stop rules, two implementations could produce different
      retry and cleanup behavior
    - stop rules are:
      - `active`: stop polling and move into entitled UI
      - `error`: stop polling and show terminal checkout failure UI
      - `401`: stop polling and require re-auth
      - `429`: stop polling and show manual refresh UI
      - `503` after client retries: stop polling and show temporary outage UI
      - `pending`: continue while poll budget remains
      - `free`: continue while poll budget remains, then stop after the final
        poll and show manual refresh UI

- Decision: another agent implementing the page must account for the shared
  client's dual-shape error contract.
  - Reference in current code:
    - `src/client/lib/api.js`
  - Reasoning:
    - `401` is surfaced through `result.error`
    - `429`, `503`, and other non-401 HTTP failures are surfaced through
      `result.data?.error`
    - success-page logic must check both paths explicitly

### Tradeoffs

- pro: routes stay thin and readable
- pro: local DB remains the app-facing truth
- pro: billing success-page behavior stays aligned with existing auth, CSRF, and
  retry conventions
- con: checkout-status introduces Stripe reads during the success-page flow
- con: strict route-facing reads add one more service helper because fail-closed
  entitlement reads and fail-hard route reads have different safety semantics

### Must-have coding requirements

- all request bodies must be schema-validated
- the route contracts above must be treated as part of the spec, not left as
  implementation-detail decisions
- new billing routes must use `withRateLimit(...)` with explicit
  `allowedMethods`
- `checkout-status` must not grant access directly from Stripe session
  completion
- `status` must return local state only
- `checkout-status` must verify session ownership before any reconcile
- status-like routes must send cache-hardening headers
- checkout eligibility must fail closed on unknown local subscription statuses
- retryable `checkout-status` transport failures must return
  `503 SERVICE_UNAVAILABLE`

### Key security decisions

- auth and CSRF are required for all mutable billing routes
- checkout completion is not itself proof of entitlement
- local billing state remains canonical even when Stripe says a checkout session
  completed
- ownership validation is required before revealing or reconciling a checkout
  session
- request-header-derived origins are not acceptable for Stripe redirect URLs
- GET billing routes must stay read-only because they do not receive CSRF
  protection in the current middleware

### Testing requirements

- unauthenticated and CSRF-invalid requests fail correctly
- invalid plans are rejected
- checkout session creation uses the exact required Stripe fields
- checkout session creation uses the intended time-bucketed idempotency key
- duplicate checkout submits from the same user and plan within one UTC hour
  use the same Stripe idempotency key and return the same Checkout Session URL
- different users use different checkout idempotency keys
- requests across a UTC hour boundary use different checkout idempotency keys
- portal creation fails closed when no customer mapping exists
- status route returns only local billing state
- checkout-status returns only `pending`, `active`, `free`, or `error`
- checkout-status rejects session ownership mismatches
- checkout-status triggers reconcile only in the expected pending case
- completed checkout reconcile that still leaves local state non-entitled
  returns terminal `error`
- route-facing strict billing reads return `503` instead of synthetic free state
- unknown local billing statuses block checkout
- billing success-page polling stops according to the terminal vs non-terminal
  rules above

## Chunk 5: Public Webhook Route And Event Processing

### Why this chunk exists

Stage 5 is now the missing public webhook ingress, not new Stripe runtime
foundations or a new billing architecture.

The current branch already has:

- Stripe secret-derived runtime mode, memoized SDK client creation, and
  webhook-secret selection in `src/server/lib/stripeRuntime.js`
- checkout and portal app-origin plus price allowlist validation in
  `src/server/lib/stripe.js`
- raw-body buffering in `src/server/lib/readRawBody.js`
- signature verification in `src/server/lib/webhookSignature.js`
- centralized webhook middleware in `src/server/middleware/withWebhookAuth.js`
- canonical local billing reads plus reconcile helpers in
  `src/server/lib/billingService.js`
- authenticated checkout, portal, status, and checkout-status routes under
  `src/pages/api/billing/`

That means this chunk should add a thin public webhook route plus focused event
orchestration, while reusing the service and middleware boundaries that already
exist.

Small targeted decoupling is still in scope here when it narrows webhook or
local-billing blast radius without changing the overall billing architecture.
In particular, webhook verification and local entitlement reads should not
import unrelated checkout-only Stripe configuration if that causes fail-closed
integrity paths to die at module load.

### What this chunk covers

- public webhook route wiring
- receipt pre-read duplicate suppression
- canonical event dispatch and reconcile behavior
- monitoring and failure-path expectations for webhook processing

### What this chunk does not cover

- browser-initiated billing actions
- client-visible entitlement decisions
- WAF or infrastructure-only hardening layers that do not replace application
  correctness checks

### Expected files

- `src/pages/api/billing/webhook.js`
- `src/server/lib/billingWebhookDispatcher.js`
- `src/pages/api/billing/__tests__/webhook.test.js`
- `src/pages/api/__tests__/routeSafety.test.js` if needed

### Expected edits

- create a public `POST /api/billing/webhook` route
- set `export const config = { api: { bodyParser: false } }`
- wrap the route with `withWebhookAuth`
- keep the route thin and move webhook dispatch logic into a focused server-side
  module instead of growing `billingService.js`
- add a privileged receipt pre-read helper in `billingService.js` for
  `stripe_event_receipts`
- use that receipt helper only for common-case duplicate suppression, not as the
  correctness boundary
- extract and log only the Stripe event envelope
  `{ id, type, livemode, created }`
- short-circuit duplicate deliveries only when the existing receipt has the same
  envelope and `result = processed`
- return `500` on any same-`event_id` envelope mismatch and treat it as an
  integrity signal that must be logged and monitored
- dispatch supported events through explicit mapping instead of inferred or
  generic handler lookup
- use `syncSubscriptionFromStripe(..., { mode: 'event', eventCreated })` for
  all webhook-triggered subscription syncs
- reuse `markSubscriptionDeletedFromEvent(...)` for
  `customer.subscription.deleted`
- record `processed` for successful reconcile or intentional safe-ignore
- record `stale_ignored` for stale event outcomes
- best-effort record `failed` before returning `500` on unexpected errors
- preserve an existing `processed` receipt on later duplicate deliveries
  instead of writing a durable `duplicate_ignored` downgrade row

### Current-branch gaps to fold into this chunk

- `bodyParser: false` must become an enforceable route contract.
  - Reference in current code:
    - `src/server/middleware/withWebhookAuth.js`
    - `src/pages/api/__tests__/routeSafety.test.js`
  - Why:
    - `withWebhookAuth(...)` documents the raw-body requirement, but the current
      route-safety test only string-scans wrapper exports
    - if `src/pages/api/billing/webhook.js` forgets
      `export const config = { api: { bodyParser: false } }`, valid Stripe
      deliveries will fail signature verification and billing sync will stop
  - Stage 5 plan change:
    - add a route-specific test that imports
      `src/pages/api/billing/webhook.js` and asserts
      `config.api.bodyParser === false`
    - keep that contract test separate from the generic route-safety net so
      removing the export fails CI immediately

- Equal-second event ordering must remain an explicit residual limitation.
  - Reference in current code:
    - `src/server/lib/billingService.js`
    - `migrations/011_billing_concurrency_guards.sql`
    - `src/server/db/__tests__/billingMigrations.integration.test.js`
  - Why:
    - the JS fast path only rejects strictly older `event.created` values
    - the DB event-upsert RPC accepts newer-or-equal timestamps, so two distinct
      Stripe events from the same second still race and the last arrival wins
  - Stage 5 plan change:
    - document same-second ordering as an intentional residual risk
    - keep the DB regression test that proves current newer-or-equal behavior
    - do not add an invented tie-breaker such as lexical `event.id` ordering
      unless scope is widened into a deliberate ordering redesign

- `webhookSignature.test.js` must enforce the runtime split contract.
  - Reference in current code:
    - `src/server/lib/__tests__/webhookSignature.test.js`
    - `src/server/lib/stripeRuntime.js`
    - `src/server/lib/stripe.js`
    - `src/server/lib/__tests__/stripe.test.js`
  - Why:
    - webhook verification is intentionally decoupled from checkout-only app URL
      and price-id validation
    - seeding `NEXT_PUBLIC_APP_URL` in webhook-signature tests would hide the
      coupling regression this split is meant to prevent
  - Stage 5 plan change:
    - keep webhook-signature tests configured with Stripe secret and
      mode-specific webhook secret only
    - assert that verification does not require `NEXT_PUBLIC_APP_URL` or
      allowlisted price env vars
    - keep checkout Stripe config tests in `stripe.test.js` proving checkout
      still fails fast when app URL or price ids are missing

- Webhook verification is split from unrelated checkout configuration.
  - Reference in current code:
    - `src/server/lib/webhookSignature.js`
    - `src/server/lib/stripeRuntime.js`
    - `src/server/lib/stripe.js`
    - `src/server/middleware/withWebhookAuth.js`
  - Why:
    - `stripeRuntime.js` owns only `STRIPE_SECRET_KEY`, derived mode, the
      memoized Stripe client, and dynamic mode-specific webhook secret lookup
    - `stripe.js` remains checkout/portal-facing and still validates
      `NEXT_PUBLIC_APP_URL` and allowlisted price ids at module initialization
    - checkout-only env breakage must not crash future webhook verification or
      local-only billing reads at import time
  - Stage 5 plan change:
    - preserve the runtime split when adding the public webhook route
    - make webhook verification depend only on the secret key, derived mode, and
      active webhook secret
    - do not import checkout-only `stripe.js` from the webhook verifier

- `maxBodyBytes` must be enforced by the buffering path, not just by
  `Content-Length`.
  - Reference in current code:
    - `src/server/middleware/withWebhookAuth.js`
    - `src/server/lib/webhookSignature.js`
    - `src/server/lib/readRawBody.js`
  - Why:
    - the middleware option currently changes only the advisory
      `Content-Length` rejection path
    - the actual raw-body path must enforce the same cap for both cached
      `req.rawBody` Buffers and streamed request bodies
    - custom `maxBodyBytes` must be threaded into
      `verifyWebhookSignature(...)` and then `readRawBody(...)`
  - Stage 5 plan change:
    - thread `maxBodyBytes` through the verifier path into `readRawBody(...)`
    - keep tests for advisory `Content-Length`, cached `req.rawBody` Buffers,
      streamed bodies, and custom `maxBodyBytes`

- `CUSTOMER_NOT_FOUND` needs a stable structured monitoring signal.
  - Reference in current code:
    - `src/server/lib/billingService.js`
    - `docs/monitoring.md`
  - Why:
    - the sync and delete helpers already return `CUSTOMER_NOT_FOUND`, but
      unlike livemode mismatch or unsupported status paths they do not emit a
      dedicated structured event key
    - that makes the Stage 5 expectation of alerting on unexpected
      `CUSTOMER_NOT_FOUND` outcomes hard to implement reliably
  - Stage 5 plan change:
    - add one stable structured log event for sync-path `CUSTOMER_NOT_FOUND`
    - add one stable structured log event for delete-path `CUSTOMER_NOT_FOUND`
    - document the alert contract in `docs/monitoring.md`

- Duplicate receipt semantics must be aligned before the dispatcher lands.
  - Reference in current code:
    - `src/server/lib/billingService.js`
    - `migrations/011_billing_concurrency_guards.sql`
    - this Stage 5 section
  - Why:
    - the current code still exports `DUPLICATE_IGNORED`
    - the Stage 5 runtime contract should preserve `processed` for an
      already-processed duplicate instead of promising a durable downgrade row
  - Stage 5 plan change:
    - align docs, migration comments, tests, and constants to the
      preserved-`processed` model before landing the dispatcher
    - do not promise durable `duplicate_ignored` rows for already-processed
      duplicates

- Duplicate checkout idempotency must remain server-owned.
  - Reference in current code:
    - `src/pages/api/billing/checkout.js`
    - `src/shared/validations/billingSchema.js`
    - `src/pages/billing/index.js`
  - Why:
    - client-provided checkout nonces allowed parallel requests with different
      bodies to create multiple Checkout Sessions before local subscription
      state existed
    - the corrected request body is strict `{ plan }`, and the Stripe
      idempotency key uses the server-owned UTC hour bucket
  - Stage 5 plan change:
    - preserve strict checkout body validation when adding webhook work
    - do not reintroduce request-body entropy for Stripe idempotency
    - if the one-hour replay tradeoff becomes too broad, replace it with a
      server-owned short-TTL dedupe key rather than a client nonce

- Local-only billing read paths must keep using the narrow Stripe runtime split.
  - Reference in current code:
    - `src/server/lib/billingService.js`
    - `src/server/lib/stripeRuntime.js`
    - `src/pages/api/index.js`
    - `src/pages/api/billing/status.js`
  - Why:
    - local entitlement reads must not require `NEXT_PUBLIC_APP_URL` or price-id
      checkout configuration at import time
    - Stripe API work in billing helpers should call `getStripeClient()` only
      inside functions that actually call Stripe
  - Stage 5 plan change:
    - do not reintroduce a `billingService.js` module-load import from
      checkout-facing `stripe.js`
    - keep `getLocalBillingStatus(...)` and `resolveStorageEntitlement(...)`
      importable without app URL or price env configuration
    - keep route-facing billing status, checkout, and portal logic on strict
      `loadBillingStatusOrThrow(...)` where paid-user-sensitive reads must fail
      explicitly

- Protected-route auth outages must not be flattened into `401`.
  - Reference in current code:
    - `src/server/lib/supabaseServer.js`
    - `src/server/middleware/withRateLimit.js`
  - Why:
    - `getUserFromRequest(...)` distinguishes invalid-token behavior from auth
      backend unavailability in its returned error text
    - `withRateLimit(...)` currently returns `401` whenever no user is present,
      which hides real auth outages as ordinary unauthorized requests
  - Stage 5 plan change:
    - return structured auth failure codes from `getUserFromRequest(...)`
    - map auth-backend-unavailable cases to `503`
    - keep `401` only for real unauthenticated or expired-session outcomes

- Paid-user-sensitive entitlement reads must not silently degrade to `FREE`.
  - Reference in current code:
    - `src/server/lib/billingService.js`
    - `src/pages/api/index.js`
  - Why:
    - `getLocalBillingStatus(...)` intentionally collapses missing clients and
      read failures to a synthetic free-state object
    - that fail-closed behavior is acceptable only where a silent denial is an
      intentional product decision, not where a paid entitlement read should
      block on billing-state unavailability
  - Stage 5 plan change:
    - add or use strict entitlement resolvers for paid-user-sensitive paths that
      must return `503` or another explicit degraded state instead of silently
      mapping failures to `FREE`
    - keep the synthetic free fallback only on callers where that behavior is
      deliberate

- Completed checkout must not quietly collapse to `free` after reconcile.
  - Reference in current code:
    - `src/pages/api/billing/checkout-status.js`
    - `src/server/lib/billingService.js`
  - Why:
    - a completed session can reconcile, reload local billing, and still return
      `free` because `mapCheckoutStatus(...)` maps `complete + non-entitled` to
      `FREE`
    - that can hide allowlist drift or billing-sync integrity problems after an
      apparently successful purchase
  - Stage 5 plan change:
    - when a completed-session reconcile had a usable subscription id but local
      state remains non-entitled, return a terminal billing-sync or
      configuration error state instead of `free`

- The route safety-net must become executable, not just string-based.
  - Reference in current code:
    - `src/pages/api/__tests__/routeSafety.test.js`
  - Why:
    - the current safety net uses `content.includes(...)`, so a comment or dead
      string literal can make CI pass even if a route exports an unwrapped raw
      handler
  - Stage 5 plan change:
    - replace or supplement the generic string scan with import-based or
      AST-based contract checks
    - at minimum, assert the real webhook route export and `config` contract
      instead of trusting source substrings

### Stripe Dashboard Destination For This Plan

This rollout assumes Stripe sends billing events to a webhook endpoint, not to
Amazon EventBridge, for the canonical billing path.

For the planned OpenNext + SST deployment on AWS Lambda:

- Stripe should send events to the app's public site domain behind CloudFront
- the production endpoint shape is
  `https://<public-site-domain>/api/billing/webhook`
- the staging endpoint shape is
  `https://<staging-site-domain>/api/billing/webhook`
- Stripe must not target a Lambda Function URL, private origin URL, or any
  internal AWS endpoint directly
- local development may use Stripe CLI forwarding to
  `http://localhost:3000/api/billing/webhook`, but that is a development-only
  convenience and not a deployment destination

Stripe dashboard registration requirements:

- create separate test and live webhook endpoints or secrets
- register this exact event set for the canonical billing sync path:
  `checkout.session.completed`
  `customer.subscription.created`
  `customer.subscription.updated`
  `customer.subscription.deleted`
  `invoice.paid`
  `invoice.payment_failed`
- use the endpoint signing secret associated with that webhook endpoint
- if EventBridge is introduced later for analytics or side effects, it must not
  replace the canonical webhook path for this plan unless the plan is revised
  intentionally

### Canonical route behavior

Route flow:

- verify the request through `withWebhookAuth(...)`
- never read `req.body`; use only `req.webhookEvent`
- pre-read any existing receipt by `event.id` before Stripe fetch or dispatch
- if an existing receipt has the same envelope and `result = processed`, return
  `200` early
- preserve the existing `processed` receipt on that duplicate short-circuit
  rather than rewriting it as `duplicate_ignored`
- if the same `event_id` already exists with different `event_type`,
  `livemode`, or `stripe_event_created`, log an integrity error and return
  `500`
- if a prior receipt exists with a non-processed result, continue and retry the
  handler path
- after dispatch, persist the final receipt outcome using the existing receipt
  merge RPC

Dispatcher mapping:

- `customer.subscription.created`
  - require a subscription id
  - call `syncSubscriptionFromStripe(subscriptionId, { mode: 'event', eventCreated }, log)`
- `customer.subscription.updated`
  - require a subscription id
  - call `syncSubscriptionFromStripe(subscriptionId, { mode: 'event', eventCreated }, log)`
- `customer.subscription.deleted`
  - call `markSubscriptionDeletedFromEvent(event.data.object, { eventCreated, livemode }, log)`
- `invoice.paid`
  - if a usable subscription id exists, call the same EVENT-mode sync helper
  - otherwise safe-ignore with `200`
- `invoice.payment_failed`
  - if a usable subscription id exists, call the same EVENT-mode sync helper
  - otherwise safe-ignore with `200`
- `checkout.session.completed`
  - if a usable subscription id exists, call the same EVENT-mode sync helper
  - otherwise safe-ignore with `200`

Safe-ignore rules:

- `checkout.session.completed` without a subscription id is defensive-only
  today because checkout sessions are created with `mode: 'subscription'`, but
  the route must still no-op safely for support-created sessions or future
  non-subscription products
- unknown event types should be treated as handled ignores, recorded as
  `processed`, and returned as `200`
- `CUSTOMER_NOT_FOUND` should return `200`, but it is unexpected in this
  environment and must be logged with a stable monitoring signal
- unsupported Stripe statuses should return `200` because retries will not fix
  a stable unsupported status
- stale events should return `200` and record `stale_ignored`
- same-second but distinct Stripe events remain newer-or-equal last-write-wins
  today; treat that as an explicit residual limitation and test it rather than
  guessing a tie-breaker

### Tradeoffs

- pro: webhook route stays narrow and pushes complex logic into the service layer
- pro: stale-event guards reduce race-condition damage
- pro: receipt pre-read removes common-case duplicate work before Stripe fetch
- con: this route depends on correct CloudFront header forwarding for
  `Stripe-Signature`
- con: the receipt pre-read is only duplicate suppression, not an atomic claim
  primitive for first delivery races
- con: the current newer-or-equal ordering contract does not break ties inside
  one Stripe-created second, so same-second distinct events still remain
  last-write-wins
- con: if WAF is delayed, the route still needs application-layer cheap
  rejection and body caps

### Must-have coding requirements

- method gate before any expensive work
- the webhook route must export `config.api.bodyParser = false`
- never parse JSON before signature verification
- never use `AUTHORITATIVE` sync mode from the webhook route
- webhook verification must not import checkout-only Stripe config that can
  bypass the middleware's fail-closed `503` path at module load
- never log raw body buffers
- never log full Stripe event payloads or nested `event.data.object`
- any exposed `maxBodyBytes` option must be enforced by raw-body buffering, not
  just advisory header checks
- never grant entitlement directly from webhook payload fragments
- existing processed receipts with the same envelope must short-circuit before
  any Stripe fetch
- invoice and checkout-session events without subscription ids must no-op with
  `200`
- subscription lifecycle events without subscription ids should be treated as
  malformed failures, not guessed ownership
- always return `2xx` for safely ignored duplicates and stale events so Stripe
  does not retry forever

### Key security decisions

- webhook signature verification is mandatory
- public access does not mean unauthenticated trust
- livemode mismatch must fail closed
- receipt envelope mismatch is a release-blocking integrity signal
- local ownership must not be inferred from untrusted webhook payloads when no
  canonical customer mapping exists

### Testing requirements

- rejects non-POST methods
- rejects missing signature headers
- rejects oversized payloads
- rejects invalid signatures
- imports `src/pages/api/billing/webhook.js` and asserts
  `config.api.bodyParser === false`
- keeps the webhook-signature unit suite proving checkout-only app URL and
  price env vars are not required
- verifies webhook verifier misconfiguration still surfaces as the intended
  middleware-controlled `503`, not as an import-time route crash
- verifies any custom `maxBodyBytes` option is enforced by stream buffering, not
  just by `Content-Length`
- rejects livemode mismatches
- short-circuits already-processed duplicate receipts before Stripe fetch
- preserves `processed` on already-processed duplicates instead of writing a
  downgrade row
- returns `500` for receipt envelope mismatch
- handles invoice events without subscription ids as safe `200` no-ops
- handles checkout-session events without subscription ids as safe `200` no-ops
- handles unknown event types as safe `200` ignores
- handles `CUSTOMER_NOT_FOUND` as safe `200` plus monitoring
- handles unsupported Stripe statuses as safe `200` plus monitoring
- handles stale events as `200` plus `stale_ignored`
- keeps the equal-timestamp DB regression that proves current
  newer-or-equal ordering semantics
- verifies `CUSTOMER_NOT_FOUND` emits its dedicated structured monitoring event
- verifies protected-route auth backend outages return `503`, while invalid
  sessions still return `401`
- verifies paid-user-sensitive entitlement reads fail explicitly instead of
  silently degrading to `FREE`
- verifies completed-session reconcile that still leaves local billing
  non-entitled returns a terminal error or degraded-sync state instead of
  `free`
- verifies the route safety-net cannot pass on comments or dead strings alone
- preserves the main webhook failure when best-effort receipt-write-on-failure
  also fails
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
- monitoring and alert expectations for webhook outcomes
- final test and rollout checklist

### Required operational checks

- confirm `Stripe-Signature` is forwarded by CloudFront to the origin
- confirm Stripe is configured to call the public site webhook endpoint
  (`/api/billing/webhook`) on the CloudFront-fronted app domain
- confirm Stripe is not pointed at a Lambda Function URL or private origin URL
- confirm webhook secrets are configured separately for test and live traffic
- confirm price id environment variables match the allowlist in `stripe.js`
- confirm `NEXT_PUBLIC_APP_URL` is correct for checkout and portal return URLs
- confirm the canonical billing destination remains a Stripe webhook endpoint
  unless the plan is explicitly revised for EventBridge
- confirm monitoring exists for `billing_livemode_mismatch`,
  `billing_unsupported_status`, receipt envelope mismatch, webhook `413`
  bursts, and unexpected `CUSTOMER_NOT_FOUND`

### Backfill requirement

Because premium storage is moving to local billing data, existing upgraded users
must have correct local billing rows before the entitlement switch becomes
authoritative in production.

Current pre-production context:

- this environment currently has no paid-user population beyond the operator
- Phase 6 should still explicitly verify that the operator account has correct
  local billing rows before relying on canonical local entitlement during
  manual staging validation

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
- no production cutover without webhook monitoring coverage for integrity and
  unexpected safe-ignore outcomes
- no production cutover without route tests, service tests, and webhook tests

### Key security decisions

- operational misconfiguration is treated as a security and integrity risk, not
  just an availability issue
- unexpected `CUSTOMER_NOT_FOUND` outcomes are treated as integrity signals, not
  normal background noise
- Stripe signature forwarding and secret separation are release blockers

### Final validation checklist

- unit tests for entitlement, Stripe client, raw-body helper, and webhook
  verification pass
- route tests for checkout, portal, status, checkout-status, and webhook pass
- billing integration tests pass in the configured integration environment
- deferred follow-up: add a billing-success round-trip client integration test
  that exercises `apiRequest(...)` response metadata and the shared response
  wrapper together instead of relying only on hand-built helper result shapes
- CloudFront header forwarding is verified
- webhook monitoring and alert destinations are verified
- existing paid users have local billing state before the canonical entitlement
  switch is relied upon

### Explicit End-Of-Phase Add

- after webhook rollout validation is complete, add WAF IP allowlisting in
  front of the CloudFront distribution for the webhook endpoint as an additive
  hardening layer
- WAF does not replace signature verification, raw-body caps, livemode checks,
  or receipt integrity handling; the application path must remain correct even
  when WAF rules are absent or delayed

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
