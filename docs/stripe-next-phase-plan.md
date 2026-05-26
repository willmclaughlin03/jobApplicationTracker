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

The current branch has already landed Chunks 1 through 6 plus follow-up
hardening changes:

- billing SQL `005` through `013` is stored in the repo-root `migrations/`
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
- Stripe runtime, raw-body verification, billing service helpers, local
  entitlement reads, authenticated billing routes, billing pages, and
  server-owned pending Checkout Session dedupe already exist
- the public Stripe webhook route and dispatcher now exist

That means the remaining work is not a greenfield runtime build. Chunk 7 is a
release-gate runbook: validate production readiness, close operational gaps, and
do not introduce new entitlement behavior unless a gate fails and the plan is
explicitly revised.

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
5. Close the duplicate pending-checkout session race before production
6. Add the public webhook route
7. Validate rollout and operational readiness

The ordering keeps production blockers ahead of rollout validation and preserves
the invariants established by earlier chunks.

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
  `stripe_event_receipts`, and preserve existing terminal success receipts
  instead of downgrading them on later duplicate deliveries

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
      Chunk 6
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
    - `migrations/013_billing_checkout_sessions.sql`
  - Reasoning:
    - validate a strict `{ plan, checkoutAttemptNonce }` request body through
      `billingSchema.js`
    - reject any client-provided idempotency fields outside the validated
      checkout-attempt nonce contract
    - call `loadBillingStatusOrThrow(...)` before any pending-session claim
    - use `claimPendingCheckoutSession(...)` to claim or reuse one active local
      pending row for the authenticated `user_id + plan`
    - return an existing persisted `checkout_url` when an unexpired pending
      Checkout Session already exists
    - call `getOrCreateStripeCustomer(...)` only after this request owns a fresh
      pending-session claim
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

- Decision: checkout duplicate prevention must be server-owned through
  `billing_checkout_sessions`.
  - Reference in current code:
    - `src/server/lib/billingService.js`
    - `src/pages/api/billing/checkout.js`
    - `src/shared/validations/billingSchema.js`
    - `src/pages/billing/index.js`
    - `migrations/013_billing_checkout_sessions.sql`
  - Reasoning:
    - the existing customer-creation helper already uses a stable Stripe
      idempotency key per user
    - checkout session creation needs narrower dedupe semantics than customer
      creation, but duplicate prevention cannot depend only on client-controlled
      nonce material
    - the current request contract accepts only a 32-hex
      `checkoutAttemptNonce` generated for one browser submit attempt and
      normalized by schema validation
    - the database pending row, keyed by `user_id + plan`, is the authority for
      duplicate checkout prevention
    - the server may still build the Stripe idempotency key from the hashed user
      id, allowlisted plan, and validated nonce only as a secondary retry guard
      for the request that owns a fresh local claim
    - the current key remains shaped like:
      `billing_checkout_${userHash.slice(0, 24)}_${plan}_${checkoutAttemptNonce}`
    - duplicate submits with different valid nonces converge on the same
      persisted pending-session URL instead of minting separate Stripe Checkout
      Sessions
    - do not restore the older UTC-hour bucket model; it was superseded because
      it could send users back to stale abandoned sessions

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
- pending checkout claims happen only after strict local billing eligibility
  passes
- checkout session creation uses the exact required Stripe fields
- checkout session creation happens only for the request that owns a fresh local
  pending-session claim
- duplicate checkout submits from the same user and plan, including different
  checkout-attempt nonces, return the same persisted pending-session URL
- different users use different checkout idempotency keys
- different checkout-attempt nonces may still use different Stripe idempotency
  keys as a secondary retry guard, but those keys are not the duplicate-submit
  authority
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

## Chunk 5: Pending Checkout Session Dedupe

### Why this chunk exists

Before this chunk, the checkout route used a validated per-attempt
`checkoutAttemptNonce` in the server-built Stripe idempotency key. That avoided
replaying an old hour-bucket Checkout Session, but it left a production
readiness gap: an authenticated user could call `POST /api/billing/checkout`
multiple times with different valid nonces before local billing state changed,
and each nonce could mint a separate Stripe Checkout Session for the same user
and plan.

This is not a live paid-user regression in the current pre-production
environment. It is still a production blocker before serving paid users because
multiple live Checkout Sessions can become duplicate subscriptions or charges if
the user completes more than one of them.

### What this chunk covers

- server-owned pending Checkout Session dedupe keyed by `user_id + plan`
- a Supabase table and RPC/transaction boundary for race-sensitive checkout
  claims
- checkout route reuse of an existing live pending Checkout Session URL
- safe release or failure marking when Stripe session creation fails
- local-mint verification in `checkout-status` before calling Stripe
- focused route and service tests for duplicate-submit and failure behavior

### What this chunk does not cover

- public webhook dispatcher implementation from Chunk 6
- production cutover and CloudFront/webhook checks from Chunk 7
- replacing Stripe Checkout with a custom billing UI
- granting entitlement from a pending Checkout Session
- broad billing-service rewrites unrelated to checkout-session creation

### Implemented files

- `migrations/013_billing_checkout_sessions.sql`
- `src/server/lib/billingService.js`
- `src/server/lib/__tests__/billingService.test.js`
- `src/pages/api/billing/checkout.js`
- `src/server/api/__tests__/billing/checkout.test.js`
- `src/pages/api/billing/checkout-status.js`
- `src/server/api/__tests__/billing/checkout-status.test.js`
- `docs/stripe-next-phase-plan.md`
- `docs/feature-memory.md`

### Implemented data model

`billing_checkout_sessions` was added with:

- `id`
- `user_id`
- `plan`
- `stripe_checkout_session_id`
- `checkout_url`
- `status`
- `expires_at`
- `created_at`
- `updated_at`

Expected statuses:

- `creating`
- `open`
- `complete`
- `expired`
- `failed`

Important constraints:

- one active pending row per `user_id + plan`
- active means an unexpired `creating` or `open` row
- different users must not share rows
- different plans must not share rows, even while only one plan exists
- no client write access to the table

The active-row claim is handled by the service-role-only
`claim_billing_checkout_session(...)` RPC so the race-sensitive claim happens
inside Postgres. A plain route-level read-then-insert is not enough because two
serverless invocations can race each other.

### Implemented service helpers

Narrow billing-service helpers wrap the new table/RPC:

- `claimPendingCheckoutSession({ userId, plan, checkoutAttemptNonce }, log)`
- `finalizePendingCheckoutSession({ id, stripeCheckoutSessionId, checkoutUrl, expiresAt }, log)`
- `failPendingCheckoutSession({ id }, log)`
- `waitForPendingCheckoutSessionOpen({ userId, plan }, log)`
- `getMintedCheckoutSessionForUser({ userId, sessionId }, log)`

The helper contract should distinguish:

- `reused`: return the existing unexpired `open` row and URL
- `claimed`: this request owns a new `creating` row and should call Stripe
- `creating`: another request owns creation; the route may wait briefly and
  re-read, or return a retryable checkout failure
- `failed`: Stripe creation failed and the row was released or marked failed

Keep validation in JS before the RPC where it is clearer, and validate the RPC
response shape before the route trusts it. Use the existing
`BILLING_RPC_INVALID_RESPONSE` pattern for malformed database responses.

### Checkout route changes

`POST /api/billing/checkout` should:

1. validate the current strict `{ plan, checkoutAttemptNonce }` body unless the
   client contract is intentionally revised in the same patch
2. load local billing status with `loadBillingStatusOrThrow(...)`
3. block checkout when `canStartCheckout(...)` returns false
4. claim or reuse a pending row for the authenticated `user_id + plan`
5. return the existing `checkout_url` when an unexpired pending session exists
6. create the Stripe Checkout Session only when this request owns a new claim
7. persist `stripe_checkout_session_id`, `checkout_url`, and `expires_at`
8. return the persisted URL
9. mark the row `failed` or otherwise release the claim if Stripe creation
   throws or returns no URL

The Stripe idempotency key can still include the validated nonce as a secondary
Stripe retry guard for the request that owns a new claim, but it must not be the
server's only duplicate-submit boundary. The database pending row is the
authority for duplicate checkout prevention.

### Checkout-status hardening

Before calling `stripe.checkout.sessions.retrieve(...)`,
`POST /api/billing/checkout-status` checks that the submitted `sessionId` was
minted in `billing_checkout_sessions` for the authenticated user. Unknown or
cross-user session ids return the existing ownership failure without a Stripe
API call.

This is not the primary duplicate-session fix, but it reduces Stripe API
amplification from arbitrary valid-looking session ids and makes local ownership
intent explicit.

When checkout-status observes Stripe returning `complete` or `expired`, the
local `billing_checkout_sessions` row is marked terminal on a best-effort basis
so the checkout route will not reuse that URL. Nuance: this only closes rows
seen by the success-page polling path; if a user completes checkout and never
returns to `/api/billing/checkout-status`, a webhook or later cleanup job would
still be needed to terminalize the local row before its stored `expires_at`.

### Tradeoffs

- pro: prevents multiple live Checkout Sessions for the same user and plan
  without replaying stale hour-bucket sessions
- pro: keeps duplicate prevention inside the database boundary where concurrent
  serverless route invocations can be serialized
- pro: makes support/debugging easier because pending checkout attempts have a
  local audit row
- con: introduces one more billing table and RPC contract to migrate and test
- con: abandoned `open` Checkout Sessions remain reusable until `expires_at`
  unless checkout-status or a later cleanup process marks them terminal
- con: if two requests race while one is still creating the Stripe session, the
  loser needs a short wait/re-read path or a retryable failure response

### Must-have coding requirements

- no hour-bucket Stripe idempotency key restoration
- no client-controlled entropy as the only duplicate-submit defense
- checkout eligibility must still fail closed on unknown local billing status
- the pending-session claim must be atomic at the database/RPC level
- service-role writes only; authenticated clients must not insert or update
  pending checkout rows
- Stripe Checkout Session creation must still use allowlisted plan-to-price
  mapping
- Stripe failure must not permanently block future checkout for that user and
  plan
- all new functions need repo-style comment blocks before implementation
- no raw user ids, checkout URLs, or full Stripe payloads in logs

### Key security decisions

- local billing state remains canonical for entitlement
- a pending Checkout Session does not grant access
- duplicate checkout prevention is a server-side responsibility
- local pending-session ownership must be checked by `user_id`, not by trusting
  client-provided session ids
- production rollout must not proceed while multiple active pending sessions can
  be minted for the same user and plan

### Testing requirements

- two parallel checkout requests for the same user and plan with different
  nonces return the same URL
- an existing unexpired pending session is reused without calling Stripe again
- an expired pending session allows a new Stripe Checkout Session
- different users do not share pending sessions
- different plans do not share pending sessions
- Stripe create failure marks or releases the pending row and does not
  permanently block a later checkout attempt
- malformed RPC responses fail closed
- optional: `checkout-status` does not call Stripe for unknown or unminted
  session ids
- existing checkout validation tests keep proving strict request-body behavior
  until the client contract is intentionally revised

### Documentation updates

- replace nonce-backed duplicate checkout language with the pending-session
  model wherever it appears in this plan
- update `docs/feature-memory.md` after the implementation lands
- update `docs/fixes.md` only after a `git push`

## Chunk 6: Public Webhook Route And Event Processing

### Why this chunk exists

Chunk 6 is now the missing public webhook ingress, not new Stripe runtime
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
- `src/server/lib/__tests__/billingWebhookDispatcher.test.js`
- `src/pages/api/billing/__tests__/webhook.test.js`
- `src/pages/api/__tests__/routeSafety.test.js` if needed

### Expected edits

- create a public `POST /api/billing/webhook` route
- set `export const config = { api: { bodyParser: false } }`
- wrap the route with `withWebhookAuth`
- keep the route thin and move webhook dispatch logic into a focused server-side
  module instead of growing `billingService.js`
- add privileged receipt pre-read and processing-claim helpers in
  `billingService.js` for `stripe_event_receipts`
- use the receipt pre-read for common-case terminal duplicate suppression, then
  use an atomic receipt claim or merge RPC before dispatch so first-delivery
  concurrency has a durable `processing` state
- extract and log only the Stripe event envelope
  `{ id, type, livemode, created }`
- short-circuit duplicate deliveries only when the existing receipt has the same
  envelope and a terminal success result: `processed` or `stale_ignored`
- treat `processing` as transitional only: never return `200` for a
  same-envelope `processing` receipt in the synchronous design unless a durable
  background worker has been introduced and owns completion
- return `500` on any same-`event_id` envelope mismatch and treat it as an
  integrity signal that must be logged and monitored
- dispatch supported events through explicit mapping instead of inferred or
  generic handler lookup
- add a narrow event-sync wrapper, such as
  `syncSubscriptionFromEvent(subscriptionId, eventCreated, log)`, that
  hardcodes EVENT mode for webhook-triggered subscription syncs
- reuse `markSubscriptionDeletedFromEvent(...)` for
  `customer.subscription.deleted`
- record `processed` for successful reconcile or intentional safe-ignore
- record `stale_ignored` for stale event outcomes
- map receipt results explicitly:
  - a newly claimed event records `processing` before dispatch starts
  - successful sync, unknown event types, invoice or checkout-session events
    without subscription ids, `CUSTOMER_NOT_FOUND`, and unsupported statuses
    record `processed`
  - stale service outcomes record `stale_ignored`
  - malformed required subscription lifecycle events and unexpected dispatcher
    failures record `failed`
- best-effort record `failed` before returning `500` on unexpected errors
- preserve an existing terminal success receipt on later duplicate deliveries
  instead of writing a durable `duplicate_ignored` or `failed` downgrade row
- add Stripe-managed receipt email expectations: the app must ensure the
  Stripe Customer created for Checkout has the authenticated OAuth account email
  attached, while Stripe remains responsible for sending payment receipts and
  subscription invoice emails

### Current-branch gaps to fold into this chunk

- Migration `011_billing_concurrency_guards.sql` is still editable for these
  Chunk 6 fixes.
  - Reference in current code:
    - `migrations/011_billing_concurrency_guards.sql`
    - `src/server/db/__tests__/billingMigrations.integration.test.js`
  - Why:
    - migration `011` has not been run in the database yet
    - if an unrun migration is the best correctness boundary for a Chunk 6 fix,
      edit `011` in place before it is applied
    - if any target environment has already applied `011`, use a follow-up
      migration such as `014` to replace or adjust the affected function or
      constraint
  - Chunk 6 plan change:
    - choose the migration path based on actual application status rather than
      layering avoidable follow-up migrations into an unrun local schema
    - keep the implementation and integration tests consistent with whichever
      migration path is chosen

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
  - Chunk 6 plan change:
    - add a route-specific test that imports
      `src/pages/api/billing/webhook.js` and asserts
      `config.api.bodyParser === false`
    - assert the imported default export is callable and exercises
      `withWebhookAuth` behavior through method and signature rejection tests
    - if the generic safety net is upgraded, prefer an import-time mock or AST
      assertion that proves the real default export is wrapped, not just a
      handler that coincidentally returns `405`
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
  - Chunk 6 plan change:
    - document same-second ordering as an intentional residual risk
    - keep the DB regression test that proves current newer-or-equal behavior
    - do not add an invented tie-breaker such as lexical `event.id` ordering
      unless scope is widened into a deliberate ordering redesign

- `webhookSignature.test.js` must preserve the runtime split contract.
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
  - Chunk 6 plan change:
    - preserve the existing webhook-signature tests configured with Stripe
      secret and mode-specific webhook secret only
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
  - Chunk 6 plan change:
    - preserve the runtime split when adding the public webhook route
    - make webhook verification depend only on the secret key, derived mode, and
      active webhook secret
    - do not import checkout-only `stripe.js` from the webhook verifier
    - the new `billingWebhookDispatcher.js` must not import from `./stripe.js`;
      webhook-mode Stripe access must go through `getStripeClient()` from
      `./stripeRuntime.js`

- `maxBodyBytes` enforcement through the buffering path must be preserved.
  - Reference in current code:
    - `src/server/middleware/withWebhookAuth.js`
    - `src/server/lib/webhookSignature.js`
    - `src/server/lib/readRawBody.js`
  - Why:
    - the current middleware option feeds both the advisory `Content-Length`
      rejection path and the actual raw-body buffering path
    - the raw-body path must keep enforcing the same cap for both cached
      `req.rawBody` Buffers and streamed request bodies
    - custom `maxBodyBytes` must continue to flow from one route option into
      `verifyWebhookSignature(...)` and then `readRawBody(...)`
  - Chunk 6 plan change:
    - preserve the existing `maxBodyBytes` thread through the verifier path
      into `readRawBody(...)`
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
    - that makes the Chunk 6 expectation of alerting on unexpected
      `CUSTOMER_NOT_FOUND` outcomes hard to implement reliably
  - Chunk 6 plan change:
    - add `event: 'billing_customer_not_found_sync'` for sync-path
      `CUSTOMER_NOT_FOUND`
    - add `event: 'billing_customer_not_found_delete'` for delete-path
      `CUSTOMER_NOT_FOUND`
    - document the alert contract in `docs/monitoring.md`

- Duplicate receipt semantics must be aligned before the dispatcher lands.
  - Reference in current code:
    - `src/server/lib/billingService.js`
    - `migrations/011_billing_concurrency_guards.sql`
    - this Chunk 6 section
  - Why:
    - the current code still exports `DUPLICATE_IGNORED`
    - the Chunk 6 runtime contract should preserve terminal successful duplicate
      results instead of promising durable downgrade rows
    - stale events are also handled `200` outcomes, so a same-envelope
      `stale_ignored` receipt must not later be downgraded to `failed` by a
      duplicate delivery that hits a transient Stripe or database error
  - Chunk 6 plan change:
    - because `011` is not yet applied, prefer editing it in place to drop
      `duplicate_ignored` from the receipt result check constraint, add
      `processing`, and preserve terminal success results
    - if `011` has already been applied in a target environment, add a follow-up
      migration such as `014` for the constraint and RPC changes
    - align docs, migration comments, integration tests, service tests, and
      constants to the preserved-terminal model before landing the dispatcher
    - the receipt merge or claim RPC should insert `processing` for an absent
      event before handler dispatch begins, transition `failed` receipts back
      to `processing` for retries with the same envelope, and transition
      `processing` to exactly one terminal result after dispatch completes
    - treat same-envelope `processed` and `stale_ignored` as terminal duplicate
      suppression outcomes in the route pre-read
    - make the receipt merge RPC preserve existing `processed` and
      `stale_ignored` rows against later `failed` writes
    - same-envelope `processing` means another invocation may still be handling
      the event; with the current synchronous route design, return retryable
      `500` or `503` rather than acknowledging success
    - add a bounded stale-processing reclaim rule, for example reclaim or mark
      failed when `processing` is older than a short operational threshold, and
      emit a stable monitoring signal such as
      `billing_webhook_processing_reclaimed`
    - monitor long-lived `processing` receipts as
      `billing_webhook_processing_stuck`
    - do not promise durable `duplicate_ignored` rows for terminal successful
      duplicates

- Non-current Stripe subscription events must not replace the canonical local
  subscription.
  - Reference in current code:
    - `src/server/lib/billingService.js`
    - `migrations/011_billing_concurrency_guards.sql`
  - Why:
    - current event sync resolves `stripe_customer_id -> user_id`, then writes
      the single local subscription row by `user_id`
    - `customer.subscription.deleted`, `customer.subscription.updated`,
      `invoice.paid`, `invoice.payment_failed`, and
      `checkout.session.completed` can all carry a subscription id that belongs
      to the same Stripe customer but is not the user's current canonical local
      subscription
    - signature verification, livemode checks, and customer mapping all pass in
      that scenario, so timestamp ordering alone can let a duplicate or
      support-created subscription overwrite the current row
  - Chunk 6 plan change:
    - add a rollout invariant before production: one entitled subscription per
      Stripe customer, with duplicate/support-created subscriptions audited and
      resolved before local entitlement becomes production-critical
    - add a shared non-current-subscription guard before event-mode writes:
      when a local row already has a different `stripe_subscription_id`, ignore
      and monitor the incoming event unless replacement is an explicit
      terminal-row adoption path
    - delete handling must specifically ignore and log a delete event whose
      subscription id differs from the local canonical `stripe_subscription_id`
    - because `011` is not yet applied, prefer putting the atomic event-write
      guard in the `011` event RPC and mirroring it in JS for clear monitoring
      logs; if `011` has already been applied, add a follow-up `014` RPC
      replacement
    - record the handled ignore as `processed`, not `stale_ignored`, because the
      event is non-current rather than older than the local Stripe event cursor
  - Tests:
    - delete event for `sub_old` under the same customer does not cancel current
      active `sub_active`
    - update or invoice-backed sync for `sub_old` does not replace current
      active `sub_active`
    - a deliberate new subscription can replace a terminal local row only through
      the approved adoption path

- Receipt integration tests must match the receipt-envelope mismatch contract.
  - Reference in current code:
    - `migrations/011_billing_concurrency_guards.sql`
    - `src/server/db/__tests__/billingMigrations.integration.test.js`
  - Why:
    - the receipt merge RPC raises when the same `event_id` is replayed with a
      different `event_type`, `livemode`, or `stripe_event_created`
    - the current B27 integration test source changes the envelope while
      expecting ordinary update and preserve behavior
  - Chunk 6 plan change:
    - keep the same event envelope for B27 update, upgrade, and preserve cases;
      vary only `p_result`
    - add a separate mismatch test that intentionally changes one envelope field
      and expects the RPC to fail

- Duplicate checkout idempotency has been handled in Chunk 5 before rollout
  validation.
  - Reference in current code:
    - `src/pages/api/billing/checkout.js`
    - `src/shared/validations/billingSchema.js`
    - `src/pages/billing/index.js`
    - `src/server/api/__tests__/billing/checkout.test.js`
  - Why:
    - the previous nonce-backed Stripe idempotency key deduped only one browser
      submit attempt
    - an authenticated user could send multiple valid nonces for the same plan
      before local billing state changed
    - different valid nonces created different Stripe idempotency keys and could
      mint multiple live Checkout Sessions
    - the older UTC-hour bucket model should not be restored because it could
      replay stale abandoned Checkout Sessions
  - Chunk 6 plan change:
    - keep webhook work out of this checkout-session claim problem
    - do not change the checkout route to an hour-bucket idempotency key as part
      of webhook implementation
    - preserve the pending-session model from Chunk 5 as the production-readiness
      fix for duplicate Checkout Session creation

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
  - Chunk 6 plan change:
    - do not reintroduce a `billingService.js` module-load import from
      checkout-facing `stripe.js`
    - keep `getLocalBillingStatus(...)` and `resolveStorageEntitlement(...)`
      importable without app URL or price env configuration
    - preserve the current strict `loadBillingStatusOrThrow(...)` use in
      route-facing billing status, checkout, and portal logic
    - decide before production whether the storage-write path in
      `src/pages/api/index.js` should keep its deliberate synthetic-free
      denial fallback or migrate to an explicit degraded/`503` response
      when billing state cannot be read

- Protected-route auth outages must preserve the existing `503` split.
  - Reference in current code:
    - `src/server/lib/supabaseServer.js`
    - `src/server/middleware/withRateLimit.js`
  - Why:
    - `getUserFromRequest(...)` now returns stable auth failure codes for
      invalid sessions versus auth backend unavailability
    - `withRateLimit(...)` maps auth backend unavailability to retryable `503`
      instead of hiding it as an ordinary `401`
  - Chunk 6 plan change:
    - preserve structured auth failure codes from `getUserFromRequest(...)`
    - preserve auth-backend-unavailable mapping to `503`
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
  - Chunk 6 plan change:
    - keep `/api/billing/status`, checkout, checkout-status, and portal on
      strict billing reads where failures return `503` or a terminal degraded
      state
    - keep synthetic free fallback only on callers where denial-by-free is a
      deliberate product decision
    - explicitly document or revise the `src/pages/api/index.js` storage-write
      behavior before serving paid users in production

- Completed checkout must continue to avoid quietly collapsing to `free` after
  reconcile.
  - Reference in current code:
    - `src/pages/api/billing/checkout-status.js`
    - `src/server/lib/billingService.js`
  - Why:
    - without the route-level guard, a completed session could reconcile,
      reload local billing, and still return `free` because
      `mapCheckoutStatus(...)` maps `complete + non-entitled` to `FREE`
    - that would hide allowlist drift or billing-sync integrity problems after
      an apparently successful purchase
  - Chunk 6 plan change:
    - preserve the route behavior where a completed-session reconcile with a
      usable subscription id that still leaves local state non-entitled returns
      terminal `data.state = 'error'` instead of `free`

- `checkout.session.completed` webhooks must terminalize the local pending
  Checkout Session row after safe handling.
  - Reference in current code:
    - `migrations/013_billing_checkout_sessions.sql`
    - `src/server/lib/billingService.js`
    - `src/pages/api/billing/checkout-status.js`
  - Why:
    - Chunk 5 terminalizes `billing_checkout_sessions` only when success-page
      polling observes Stripe returning `complete` or `expired`
    - if the user completes Checkout and never returns to success polling, the
      local row can remain `open` until `expires_at`
    - during that window, `claim_billing_checkout_session(...)` can reuse the
      completed Checkout URL even though the pending row must never be an
      entitlement source
  - Chunk 6 plan change:
    - add a service-role helper that terminalizes by
      `stripe_checkout_session_id` after the completed-session webhook path has
      been safely handled
    - use `syncResult.userId` when it is available, but prefer the session-id
      lookup/update as the release mechanism because it also covers safe-ignore
      shapes and avoids granting from the pending row
    - do not terminalize on a failed webhook path that should return `500` and
      be retried
    - keep entitlement derived only from canonical billing subscription state,
      never from `billing_checkout_sessions`
  - Tests:
    - completed-session webhook releases the pending row without granting
      entitlement from that row
    - completed-session webhook without a usable subscription id still safely
      terminalizes a locally minted pending row after the safe-ignore decision

- The route safety-net must become executable, not just string-based.
  - Reference in current code:
    - `src/pages/api/__tests__/routeSafety.test.js`
  - Why:
    - the current safety net uses `content.includes(...)`, so a comment or dead
      string literal can make CI pass even if a route exports an unwrapped raw
      handler
  - Chunk 6 plan change:
    - replace or supplement the generic string scan with import-based or
      AST-based contract checks
    - at minimum, assert the real webhook route export and `config` contract
      instead of trusting source substrings

### Stripe-Managed Receipt Email Contract

Receipt and paid-invoice emails should remain Stripe-managed for this phase.
The application should not send its own payment receipt email from the webhook
dispatcher because that would introduce a non-idempotent side effect into the
same path that is responsible for canonical billing reconciliation.

Implementation expectations:

- Stripe Customer creation and reuse must stay tied to the authenticated local
  user, not to webhook payload email fields
- the Customer email should come from the OAuth-backed account email already
  present on the authenticated user
- if the OAuth provider does not supply a usable email, checkout should fail
  closed or route the user through an explicit account-email collection path
  before creating Checkout, rather than letting a Checkout-entered email become
  the local ownership signal
- `getOrCreateStripeCustomer(...)` and the best-effort email-sync helper should
  keep the Stripe Customer email aligned with the authenticated account email so
  Stripe Checkout can prefill the email and Stripe can send receipts/invoices to
  the expected account
- webhook handling must never map a Stripe event to a user by
  `customer_details.email`, invoice email fields, or any other payload email;
  ownership still flows through `billing_customers.stripe_customer_id`
- Stripe Dashboard customer email settings must have successful-payment emails
  enabled in the relevant test and live modes before paid rollout
- manual staging validation should complete a subscription checkout using an
  OAuth-login account and confirm the receipt or invoice email arrives at that
  same account email

Application-generated billing emails are out of scope for Chunk 6. If future
work adds app-owned emails such as custom receipts, lifecycle notifications, or
credit grants, those side effects need object-level idempotency separate from
`stripe_event_receipts.event_id`; a reasonable key shape is
`{event.type}:{stripe_object_id}:{effect_name}`.

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
- assert the verified event's `livemode` immediately after verification and
  before any receipt pre-read, Stripe fetch, or database work
- pre-read any existing receipt by `event.id` before Stripe fetch or dispatch
- if an existing receipt has the same envelope and a terminal success result
  (`processed` or `stale_ignored`), return `200` early
- preserve the existing terminal success receipt on that duplicate
  short-circuit rather than rewriting it as `duplicate_ignored` or `failed`
- if the same `event_id` already exists with different `event_type`,
  `livemode`, or `stripe_event_created`, log
  `event: 'billing_event_receipt_envelope_mismatch'` and return `500`
- compare envelope timestamps by normalizing both values through the same
  ISO-timestamp path and comparing `Date.getTime()` results, so Stripe integer
  seconds and Postgres `timestamptz` values do not false-mismatch
- atomically claim a non-terminal event as `processing` before dispatcher work
  starts; this is the light durable processing state for the synchronous
  implementation
- if a prior receipt exists with a retryable result such as `failed`, continue
  and retry the handler path by transitioning it back to `processing` with the
  same envelope
- if a same-envelope receipt is already `processing`, return retryable `500` or
  `503` so Stripe retries instead of treating unfinished work as delivered
- if a `processing` receipt is older than the chosen stale-processing threshold,
  reclaim it or mark it failed before retrying, and emit
  `event: 'billing_webhook_processing_reclaimed'`
- after dispatch, persist the final receipt outcome using the existing receipt
  merge RPC
- if best-effort failed-receipt persistence throws, log the secondary error and
  rethrow the original webhook processing error
- terminal receipt pre-read is duplicate suppression; the atomic `processing`
  claim plus idempotent service helpers remain the correctness boundary for
  first-delivery races

Dispatcher mapping:

- `customer.subscription.created`
  - require a subscription id
  - call the narrow EVENT-mode sync wrapper
- `customer.subscription.updated`
  - require a subscription id
  - call the narrow EVENT-mode sync wrapper
- `customer.subscription.deleted`
  - call `markSubscriptionDeletedFromEvent(event.data.object, { eventCreated, livemode }, log)`
  - ignore and monitor when the deleted subscription is not the local canonical
    subscription for the resolved customer
- `invoice.paid`
  - extract a usable subscription id from current and legacy Stripe invoice
    shapes, including `invoice.parent.subscription_details.subscription`
  - if a usable subscription id exists, call the narrow EVENT-mode sync wrapper
  - otherwise safe-ignore with `200`
- `invoice.payment_failed`
  - extract a usable subscription id from current and legacy Stripe invoice
    shapes, including `invoice.parent.subscription_details.subscription`
  - if a usable subscription id exists, call the narrow EVENT-mode sync wrapper
  - otherwise safe-ignore with `200`
- `checkout.session.completed`
  - if a usable subscription id exists, call the narrow EVENT-mode sync wrapper
  - otherwise safe-ignore with `200`
  - after safe handling, terminalize the locally minted pending Checkout
    Session row by `stripe_checkout_session_id` on a best-effort basis without
    deriving entitlement from that row

Safe-ignore rules:

- `checkout.session.completed` without a subscription id is defensive-only
  today because checkout sessions are created with `mode: 'subscription'`, but
  the route must still no-op safely for support-created sessions or future
  non-subscription products
- unknown event types should emit `event: 'billing_unknown_event_type'`, be
  treated as handled ignores, be recorded as `processed`, and return `200`
- `CUSTOMER_NOT_FOUND` should return `200`, but it is unexpected in this
  environment and must be logged with a stable monitoring signal
- non-current subscription events under a known Stripe customer should return
  `200`, record `processed`, and emit a stable monitoring signal because
  retries will not make the event become canonical
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
- pro: a light `processing` receipt state makes in-flight webhook work visible
  and gives retries a concrete recovery boundary without introducing a queue yet
- pro: Stripe-managed receipts avoid a custom email side effect in the webhook
  and keep receipt delivery aligned with Stripe invoice/payment records
- con: this route depends on correct CloudFront header forwarding for
  `Stripe-Signature`
- con: the route still performs synchronous reconciliation before responding,
  which is acceptable for expected low volume but should be revisited before
  high webhook volume or paid-user scale
- con: the current newer-or-equal ordering contract does not break ties inside
  one Stripe-created second, so same-second distinct events still remain
  last-write-wins
- con: if WAF is delayed, the route still needs application-layer cheap
  rejection and body caps
- future scale note: before meaningful webhook volume, replace the synchronous
  route body with verify-and-claim-then-enqueue behavior, or add a durable
  worker loop that owns `processing` receipts independently of the request
  lifecycle

### Must-have coding requirements

- method gate before any expensive work
- the webhook route must export `config.api.bodyParser = false`
- never parse JSON before signature verification
- never use `AUTHORITATIVE` sync mode from the webhook route
- hide EVENT-mode subscription sync behind a narrow wrapper so the dispatcher
  does not choose sync modes directly
- webhook verification must not import checkout-only Stripe config that can
  bypass the middleware's fail-closed `503` path at module load
- `billingWebhookDispatcher.js` must not import checkout-only `./stripe.js`;
  webhook-mode Stripe access must go through `getStripeClient()` from
  `./stripeRuntime.js`
- never log raw body buffers
- never log full Stripe event payloads or nested `event.data.object`
- any exposed `maxBodyBytes` option must be enforced by raw-body buffering, not
  just advisory header checks
- never grant entitlement directly from webhook payload fragments
- never map webhook ownership from Stripe payload email fields; use
  `billing_customers.stripe_customer_id`
- do not send custom receipt emails from the webhook dispatcher in Chunk 6;
  rely on Stripe automatic receipt and subscription invoice email delivery
- existing terminal success receipts with the same envelope must short-circuit
  before any Stripe fetch
- first delivery and retry attempts must atomically claim `processing` before
  dispatch, then terminalize to `processed`, `stale_ignored`, or `failed`
- a same-envelope `processing` duplicate must not return `200` unless the
  architecture has been revised to a durable background worker that owns
  completion after acknowledgement
- invoice and checkout-session events without subscription ids must no-op with
  `200`
- subscription lifecycle events without subscription ids should be treated as
  malformed failures, not guessed ownership
- always return `2xx` for safely ignored duplicates, non-current subscription
  events, and stale events so Stripe does not retry forever
- unknown event types must log `billing_unknown_event_type` before returning a
  processed `200`
- failed-receipt-write secondary errors must not mask the original webhook
  processing error

### Key security decisions

- webhook signature verification is mandatory
- public access does not mean unauthenticated trust
- livemode mismatch must fail closed
- receipt envelope mismatch is a release-blocking integrity signal logged as
  `billing_event_receipt_envelope_mismatch`
- local ownership must not be inferred from untrusted webhook payloads when no
  canonical customer mapping exists
- receipt delivery uses the OAuth-backed account email on the Stripe Customer;
  Checkout-entered or webhook-payload emails are not ownership identifiers

### Testing requirements

- rejects non-POST methods
- rejects missing signature headers
- rejects oversized payloads
- rejects invalid signatures
- imports `src/pages/api/billing/webhook.js` and asserts
  `config.api.bodyParser === false`
- proves the real webhook route default export is wrapped with
  `withWebhookAuth` behavior rather than passing because of a comment or a
  coincidental manual `405`
- keeps the webhook-signature unit suite proving checkout-only app URL and
  price env vars are not required
- verifies webhook verifier misconfiguration still surfaces as the intended
  middleware-controlled `503`, not as an import-time route crash
- verifies any custom `maxBodyBytes` option is enforced by stream buffering, not
  just by `Content-Length`
- rejects livemode mismatches
- verifies livemode mismatches are rejected before receipt pre-read or any other
  database work
- short-circuits already-terminal duplicate receipts before Stripe fetch,
  including same-envelope `processed` and `stale_ignored`
- preserves `processed` and `stale_ignored` on already-terminal duplicates
  instead of writing a downgrade row
- claims first-delivery receipts as `processing` before dispatcher work starts
- transitions same-envelope `failed` receipts back to `processing` before retry
  work starts
- returns retryable `500` or `503` for same-envelope `processing` duplicates in
  the synchronous route design
- reclaims or marks stale `processing` receipts after the configured threshold
  and emits `billing_webhook_processing_reclaimed`
- verifies the receipt merge RPC preserves an existing `stale_ignored` receipt
  against a later same-envelope `failed` write
- returns `500` for receipt envelope mismatch
- verifies receipt envelope mismatch emits
  `billing_event_receipt_envelope_mismatch`
- verifies envelope timestamp comparison normalizes Stripe integer seconds and
  Postgres `timestamptz` values before comparing millisecond time
- updates the B27 receipt RPC integration test so update/preserve cases keep the
  same envelope, and adds a separate envelope-mismatch failure test
- handles invoice events without subscription ids as safe `200` no-ops
- handles invoice events with subscription ids in current Stripe shapes,
  including `invoice.parent.subscription_details.subscription`
- handles checkout-session events without subscription ids as safe `200` no-ops
- terminalizes locally minted pending Checkout Session rows after safely handled
  `checkout.session.completed` webhooks without granting entitlement from those
  rows
- verifies `checkout.session.completed` without a usable subscription id can
  still release a locally minted pending row after safe-ignore handling
- handles unknown event types as safe `200` ignores and emits
  `billing_unknown_event_type`
- handles `CUSTOMER_NOT_FOUND` as safe `200` plus monitoring
- verifies sync-path `CUSTOMER_NOT_FOUND` emits
  `billing_customer_not_found_sync`
- verifies delete-path `CUSTOMER_NOT_FOUND` emits
  `billing_customer_not_found_delete`
- handles unsupported Stripe statuses as safe `200` plus monitoring
- handles stale events as `200` plus `stale_ignored`
- handles non-current subscription events as monitored `200` safe-ignores plus
  `processed` receipts
- verifies a delete event for a non-current subscription under the same customer
  does not cancel the current active local subscription
- verifies update and invoice-backed sync for a non-current subscription under
  the same customer do not replace the current active local subscription
- keeps the equal-timestamp DB regression that proves current
  newer-or-equal ordering semantics
- verifies protected-route auth backend outages return `503`, while invalid
  sessions still return `401`
- verifies paid-user-sensitive billing routes fail explicitly instead of
  silently degrading to `FREE`, and that any remaining synthetic-free storage
  fallback is documented as deliberate before production
- verifies completed-session reconcile that still leaves local billing
  non-entitled returns a terminal error or degraded-sync state instead of
  `free`
- verifies the route safety-net cannot pass on comments or dead strings alone
- preserves the main webhook failure when best-effort receipt-write-on-failure
  also fails
- triggers sync on the supported event types
- covers dispatcher event-type mapping in
  `src/server/lib/__tests__/billingWebhookDispatcher.test.js` separately from
  route signature, body-cap, and method tests
- verifies dispatcher sync paths never invoke `syncSubscriptionFromStripe` with
  `mode: 'authoritative'`
- verifies webhook paths never resolve local users from payload email fields
- verifies Checkout/Stripe Customer email sync uses the authenticated
  OAuth-backed account email as the receipt target
- manual staging validation confirms Stripe sends the receipt or invoice email
  to the OAuth account email after a successful subscription checkout

## Chunk 7: Production Readiness Gate And Rollout Runbook

### Why this chunk exists

The code alone is not enough. Because premium storage and AI tailoring now rely
on canonical local billing data, rollout safety depends on environment wiring,
data availability, Stripe configuration, and operational checks that are proven
before serving paid users.

Chunk 7 should be treated as a go/no-go gate. It should not add new billing
behavior unless validation exposes a release-blocking gap and the plan is
updated with the smallest safe fix.

### What this chunk covers

- production environment validation
- billing data and Stripe customer backfill expectations
- CloudFront, TLS, WAF, and webhook destination checks
- Stripe Dashboard/API checks for webhook, Price, subscription, and receipt
  configuration
- monitoring and alert expectations for webhook outcomes and billing integrity
- rollback, replay, backup, and local-state rebuild procedures
- Stripe Customer Portal, trial, dispute, deletion, and downgrade policy checks
- live cutover order-of-operations and incident escalation expectations
- manual staging drills before live paid rollout
- accepted residual risks that remain deliberate after validation

### Current implementation baseline

- Chunks 1 through 6 are implemented in repo state.
- Migration `013_billing_checkout_sessions.sql` exists and adds server-owned
  pending Checkout Session dedupe.
- `POST /api/billing/webhook` exists, disables the Next.js body parser, and is
  wrapped by `withWebhookAuth`.
- The webhook dispatcher verifies livemode before database work, claims
  `processing` receipts, suppresses terminal duplicate receipts, and reconciles
  supported subscription events through EVENT-mode sync.
- The current environment is pre-production and has no paid-user population
  beyond the operator. This is not a current live paid-user regression, but it
  remains a production blocker before serving paid users.
- There is not currently an implemented route-level emergency Checkout disable
  flag, scheduled Stripe-to-local reconciliation job, or account-deletion billing
  teardown path. Those are production-readiness gates for Chunk 7, not current
  live paid-user regressions in this pre-production environment.

### Chunk 7 review findings to incorporate

The latest Chunk 7 review compared the rollout gate to the implemented Chunks 1
through 6 code and Stripe's current operational contracts. These are not current
paid-user regressions in the pre-production environment, but each item must be
closed or deliberately accepted with evidence before production Checkout is
enabled:

- `POST /api/billing/checkout` has no implemented `BILLING_CHECKOUT_DISABLED`
  halt, and the route currently imports checkout-facing Stripe config at module
  load. A handler-only halt is insufficient if bad price, app URL, or Stripe
  config prevents the route module from loading before the flag can be checked.
- The disabled Checkout response also needs a defined route contract and should
  avoid depending on Redis-backed rate-limit success during an emergency halt,
  while still preserving authenticated access control where practical.
- `POST /api/billing/portal` also imports checkout-facing `stripe.js`, so portal
  access can currently depend on unrelated Checkout price config even though the
  emergency halt policy says portal access should remain available.
- The admin user-delete route deletes `jobs` before any billing-row preflight.
  Because billing tables use `ON DELETE RESTRICT`, that can partially delete a
  billing user before the auth delete fails.
- The deletion preflight must include `billing_checkout_sessions` in addition to
  `billing_customers` and `billing_subscriptions`. Pending Checkout rows can
  exist before customer or subscription rows and also restrict auth deletion.
- Checkout Session creation currently relies on Stripe/dashboard payment-method
  configuration. For the first paid rollout, delayed or asynchronous payment
  methods must be code-pinned off in Checkout creation; dashboard/API diffing can
  be added as extra evidence, but it is not the launch authority.
- Billing portal session creation currently omits the `configuration` id. That
  means default Customer Portal configuration drift can change customer actions
  without a code review.
- Even after a route-level Checkout halt is implemented, it only blocks new
  app-created Sessions. Already minted Stripe-hosted Checkout URLs can still be
  completed until Stripe marks the Session `expired` or `complete`, so the
  emergency runbook must also drain and expire open Sessions.
- Checkout Session creation currently has no explicit tax/invoice compliance
  posture. The first paid rollout must either enable and verify Stripe Tax
  inputs or record a dated legal/product exception before live sales.
- The current dispatcher excludes `invoice.payment_action_required`, so
  authentication-required renewal recovery is not yet an explicit monitored
  launch path until the Chunk 7 task adds it or records a dated exception.
- Refund and credit handling is not a launch policy yet. The first rollout
  policy is no automatic refunds: ordinary customer cancellation stops renewal
  at period end and preserves access through the already-paid month, while
  refunds remain manual exceptions.

### Chunk 7 implementation tasks

These implementation tasks close verified production-readiness gaps in the
current repo. They are blockers before paid rollout, not current live
paid-user regressions in the pre-production environment.

- **P0: route-level emergency Checkout halt**
  - Add `BILLING_CHECKOUT_DISABLED=true` handling at the top of
    `POST /api/billing/checkout`, before request-body validation, local billing
    reads, pending-session claims, customer creation, or Stripe Checkout calls.
  - Return the stable fail-closed contract `503 SERVICE_UNAVAILABLE` with a
    dedicated billing error code such as `BILLING_CHECKOUT_DISABLED` for new
    Checkout starts while preserving billing status, portal session creation,
    and webhook processing.
  - Keep authentication on the Checkout route where practical, but make the
    disabled response independent of Redis-backed rate-limit availability. If
    `withRateLimit` still executes before the halt can respond, revise the
    wrapper or route composition so the emergency halt remains reliable during a
    broader billing incident.
  - Ensure the disabled path can return even when checkout-only configuration is
    broken. If the route still imports checkout-facing Stripe config before the
    handler runs, the halt is not production-ready.
  - Refactor Stripe config so disabling new Checkout does not require validating
    `STRIPE_PRICE_RESUME_TAILOR_MONTHLY`, `NEXT_PUBLIC_APP_URL`, or Stripe
    Checkout helpers before the disabled response is sent. Best option:
    keep Stripe secret/client runtime separate, move app-origin URL building
    into a narrow module, load Checkout price allowlists lazily from
    checkout-only code, and keep portal configuration in a portal-only path.
  - Cover with a checkout route test proving the disabled route does not call
    `loadBillingStatusOrThrow`, pending-checkout RPC helpers, customer creation,
    or `stripe.checkout.sessions.create`.
  - Cover with a checkout route test proving `BILLING_CHECKOUT_DISABLED=true`
    still returns the stable disabled response when checkout-only price or app
    URL configuration is missing or invalid.
  - Cover with a route or middleware test proving the disabled response is not
    hidden behind Redis/rate-limit failure for this emergency path.
- **P0: expire already-minted Checkout Sessions during an emergency halt**
  - Treat the route halt as the front-door stop for new app-created Sessions,
    not as revocation for already-returned Stripe-hosted Checkout URLs.
  - Add an operator-owned script or internal service-role command for launch,
    rather than a public/admin endpoint, that enumerates local
    `billing_checkout_sessions` rows with `status = 'open'`.
  - For each locally open row, retrieve the Stripe Checkout Session before
    writing local terminal state. Stripe is authoritative for whether the
    Session is still `open`, already `complete`, or already `expired`.
  - If Stripe still reports `open`, call `stripe.checkout.sessions.expire(...)`
    and mark the local row `expired` only after Stripe confirms expiration.
  - If Stripe reports `complete`, do not force local expiration. Reconcile it as
    a real payment and route any business reversal through the cancellation or
    manual refund-exception policy.
  - If Stripe reports `expired`, mirror `expired` locally. If Stripe retrieval or
    expiration fails, leave the local row open, emit a high-urgency operator
    signal, and retry rather than hiding the failure with a local-only update.
  - Make local terminal updates conditional on `status = 'open'` and
    `stripe_checkout_session_id = ?` so the expire drain cannot overwrite rows
    already completed by webhook delivery or checkout-status polling.
  - Run the drain once immediately after enabling the halt and once again after a
    short delay to catch Checkout Sessions minted by requests already in flight
    during the transition window.
  - Add `checkout.session.expired` webhook support to terminalize local pending
    rows faster when Stripe expires Sessions outside the browser polling path.
  - Consider a DB-backed or remote-config billing-control flag in addition to
    the env flag so warm-process or deploy lag does not leave a long window
    where in-flight checkout requests can still mint Sessions.
- **P0: portal independence during Checkout halt**
  - Preserve billing portal access during a Checkout halt, but do not let portal
    session creation depend on the Checkout price allowlist.
  - Portal may still require authenticated billing state, a Stripe customer id,
    a valid Stripe secret key, a valid app return URL, and the configured
    Customer Portal configuration id.
  - Refactor portal imports so the route uses only Stripe runtime, app return
    URL, local billing status, and portal-specific configuration. It must not
    import a module that validates `STRIPE_PRICE_RESUME_TAILOR_MONTHLY`.
  - Cover with a portal route or runtime-config test proving portal session
    creation does not import or validate `STRIPE_PRICE_RESUME_TAILOR_MONTHLY`.
- **P0: tax and invoice compliance decision**
  - Before live Checkout is enabled, record a dated tax/invoice posture approved
    by the product/legal owner: either enable Stripe Tax for launch or document
    why tax collection is out of scope for the first paid rollout.
  - If Stripe Tax is enabled, update Checkout creation with explicit tax inputs
    such as `automatic_tax`, the chosen `billing_address_collection` policy, and
    `customer_update[address]` when Checkout-collected addresses should be saved
    back to existing Stripe Customers.
  - Verify the intended Product tax code, Price tax behavior, active tax
    registrations, customer-location collection behavior, and test-mode invoice
    and receipt output before live paid rollout.
  - Decide whether `tax_id_collection` is required for this product and launch
    market. If enabled, document the Customer name/address overwrite behavior
    accepted for Checkout-collected tax identity data.
- **P0: payment-action-required recovery decision**
  - Decide whether `invoice.payment_action_required` is enabled on the webhook
    endpoint for launch. Best launch path: enable it as a monitored signal and
    sync the related subscription without granting entitlement directly from the
    event.
  - If enabled, add dispatcher support, logging, alert coverage, and tests while
    preserving the canonical entitlement rule that only local allowlisted
    `active` subscriptions grant premium access.
  - If intentionally Dashboard/email-only for launch, record the Stripe Billing
    email settings, operator review cadence, and staging evidence that customers
    can recover through Stripe-hosted payment confirmation or the portal.
- **P0: cancellation, refund, and credit policy**
  - First paid rollout policy: no automatic refunds from the app or webhook
    layer. Normal customer cancellation stops renewal at period end and preserves
    access through the already-paid month.
  - Configure the Customer Portal cancellation behavior to cancel at period end
    for the launch configuration unless a dated policy exception approves
    immediate cancellation.
  - Refunds, prorated credits, duplicate-charge reversals, legal exceptions,
    fraud, and incident remediation remain manual support exceptions for launch.
  - A support operator must not issue a full refund without also recording the
    paired entitlement decision: preserve access through period end, cancel
    immediately, or cancel at period end.
  - If refund or credit-note events stay manual at launch, name the owner,
    review cadence, and escalation path. If they become webhook-managed, revise
    the event list and dispatcher before live rollout.
- **P0: admin user delete billing preflight**
  - Before deleting `jobs`, preflight `billing_customers`,
    `billing_subscriptions`, and `billing_checkout_sessions` for the target user
    with service-role reads.
  - If billing rows exist, block admin deletion with a billing-specific failure
    until an approved billing teardown or cancellation path has completed.
  - Cover with a delete route test proving jobs are untouched, auth deletion is
    not called, and the response clearly says billing teardown is required.
  - Cover all three blocking row classes: customer mapping, subscription, and
    pending Checkout Session. The pending-session case matters because checkout
    claims can exist before customer creation.
- **P0: delayed/asynchronous payment method policy**
  - First paid rollout policy is immediate-only subscription Checkout payment
    methods unless this plan is revised.
  - Code-pin the initial Checkout flow to card-only subscription Checkout by
    passing explicit `payment_method_types: ['card']` in
    `stripe.checkout.sessions.create(...)`.
  - Cover the exact Checkout Session create payload in route tests, including
    `payment_method_types: ['card']`.
  - Optional defense-in-depth: add an automated Stripe API configuration diff to
    report delayed-method drift, but do not treat that diff as a substitute for
    route-level payment-method pinning during first paid rollout.
  - If delayed methods are deliberately enabled later, revise entitlement to
    account for invoice or PaymentIntent collection state and handle
    `checkout.session.async_payment_succeeded` and
    `checkout.session.async_payment_failed` before granting access from an
    `active` subscription.
  - Cover with entitlement or service tests proving a delayed-payment failure
    does not leave paid access unless a revised policy explicitly accepts it.
  - Cover config-diff tooling only as an additional monitoring/release-audit
    signal if it is implemented.
- **P0: test/live webhook deployment mapping**
  - Map Stripe test-mode endpoints only to a staging/test deployment running
    `sk_test_*` and `STRIPE_WEBHOOK_SECRET_TEST`.
  - Map Stripe live-mode endpoints only to the production/live deployment running
    `sk_live_*` and `STRIPE_WEBHOOK_SECRET_LIVE`.
  - Do not point both modes at the same live production runtime. If production is
    temporarily switched into test mode for a controlled drill, public Checkout
    must stay disabled and the dated exception must be recorded.
  - Preserve tests proving mismatched endpoint signatures are rejected, then add
    rollout evidence for a real test delivery to staging and a controlled live
    delivery to production.
- **P0: pinned Customer Portal configuration**
  - Pass an audited `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` to
    `stripe.billingPortal.sessions.create`; missing config must fail closed in
    environments where portal access is enabled.
  - Keep separate recorded configuration ids for test and live modes and verify
    each id belongs to the intended Stripe mode before rollout.
  - The audited configuration must disable product switching, quantity changes,
    promotion-code entry, retention coupons, and customer email edits unless the
    plan deliberately accepts and monitors each behavior.
  - Cover with a portal route test proving the configured portal id is passed.
  - Optional defense-in-depth: add an automated Stripe API config diff to verify
    the portal feature settings on every release, but do not rely on the default
    portal configuration for launch.
- **P0: scheduled Stripe-to-local drift and rebuild guard**
  - Add a scheduled Stripe-backed drift audit, or a runbook-driven script with a
    scheduled operator cadence, before public Checkout is enabled. Best option
    for launch is a scheduled report that checks missing local rows, duplicate
    current subscriptions, unsupported statuses, customer/subscription mapping
    mismatches, and stale entitlement mismatches.
  - Rehearse the local-state rebuild procedure in test mode before live rollout.
    Rebuilds must walk Stripe Customers and Subscriptions for the intended mode,
    use service-role tooling, and surface ambiguous ownership instead of
    guessing from emails.
  - Record the first test-mode rebuild result in the rollout artifact, even when
    the result is "no mismatches."
- **P0: rollback, replay, and logging enforcement**
  - Write operator-ready runbooks for Checkout halt, webhook pause/re-enable,
    Stripe Workbench or Stripe CLI resend, failed receipt recovery, signing
    secret rotation, and local-state rebuild before public Checkout is exposed.
  - Add deploy-time or monitoring detection for `LOG_FULL_BILLING_IDS=true` in
    live mode; a truthy value is allowed only with a dated exception naming the
    owner, reason, expiration, and alert coverage.
  - Prove billing-integrity alerts reach the documented high-urgency channel for
    receipt envelope mismatch, stuck processing, webhook `5xx` bursts, and
    sustained webhook latency.

### P0 release blockers

Production cutover must not proceed until every P0 item below has a dated
verification artifact: test output, SQL result, Stripe Dashboard/API check,
CloudFront/WAF setting, or monitoring screenshot.

- The Stripe webhook endpoint is a publicly accessible HTTPS URL on the
  CloudFront-fronted app domain: `/api/billing/webhook`.
- Stripe is not pointed at a Lambda Function URL, private origin URL, preview
  URL, or URL that returns a redirect.
- TLS is valid for the public webhook hostname and supports Stripe's required
  TLS versions.
- CloudFront forwards `Stripe-Signature` to the origin and does not mutate the
  raw request body used for signature verification.
- Test and live webhook signing secrets are separate, mode-specific, and
  verified with real test-mode and live-mode delivery attempts before live
  cutover.
- The Stripe event destination uses the expected webhook endpoint API version,
  and that version is recorded with the rollout artifact.
- The webhook destination listens only to the event types this integration
  handles unless the plan is explicitly revised:
  `checkout.session.completed`, `checkout.session.expired`,
  `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`,
  and `invoice.payment_action_required`.
- WAF/IP allowlisting for Stripe webhook IP ranges is enabled before live
  cutover, or a written exception documents the accepted risk, owner, and date.
  WAF is defense-in-depth only and does not replace signature verification,
  raw-body caps, livemode checks, receipt integrity handling, or event-id
  dedupe.
- Stripe API key handling follows least-privilege and rotation expectations:
  keys are stored only in the hosting secret manager or protected environment
  variables, no keys are committed, live keys are not used in sandbox checks, and
  any decision to use unrestricted rather than restricted keys is documented.
- A route-level emergency Checkout halt is implemented and documented before
  serving paid users. The expected smallest code-facing switch is
  `BILLING_CHECKOUT_DISABLED=true`, which must fail new Checkout starts with a
  stable `503 SERVICE_UNAVAILABLE` / `BILLING_CHECKOUT_DISABLED` response while
  leaving billing status, portal access, and webhook processing available.
- The Checkout halt is proven at the route/module boundary, not only at the
  happy-path handler boundary. The disabled response must still work when
  checkout-only price or app URL configuration is missing or invalid, and it
  must not be hidden behind Redis/rate-limit failure during the emergency halt.
- Already-minted open Checkout Sessions have an emergency expiration path before
  public Checkout is enabled. The runbook must expire Stripe-open Sessions
  through Stripe, mirror terminal local state only after Stripe confirmation,
  retry/report Stripe failures, and treat payment-wins races as real payments
  handled through cancellation or manual refund-exception policy.
- Tax and invoice compliance has a dated launch decision. Either Stripe Tax and
  related Checkout payload fields are enabled and verified, or a product/legal
  owner records why tax collection is not part of the first paid rollout.
- Payment-action-required recovery has a dated launch decision. Either
  `invoice.payment_action_required` is handled and monitored by this integration,
  or Stripe Billing emails/Dashboard review are proven as the launch recovery
  path.
- Cancellation and refund policy is documented before paid users exist. Launch
  policy is no automatic refunds: ordinary cancellations stop renewal at period
  end and preserve access through the paid month; refunds and credits are manual
  exceptions with an explicit entitlement decision.
- Billing portal session creation remains independent of the Checkout price
  allowlist, so an emergency Checkout halt or bad Checkout price env does not
  prevent existing customers from opening the portal.
- A rollback runbook exists and has an owner. It must cover disabling new
  Checkout starts, disabling or pausing the Stripe webhook endpoint only when
  needed, reviewing Stripe Event Deliveries, draining or replaying verified
  deliveries, deploying a fix, and re-enabling in the correct order.
- Billing table durability is documented with dated evidence for the Postgres
  host: point-in-time recovery expectations, backup retention, and the operator
  path to restore `billing_customers`, `billing_subscriptions`,
  `stripe_event_receipts`, and `billing_checkout_sessions`.
- A scheduled Stripe-backed drift audit exists before public Checkout is
  enabled. It must report missing local rows, duplicate current subscriptions,
  unsupported statuses, local/Stripe customer mismatches, and stale entitlement
  mismatches. A rebuild-from-Stripe procedure is rehearsed at least once in test
  mode, walks Stripe Customers and Subscriptions, rebuilds local
  `billing_customers` and `billing_subscriptions` rows only through service-role
  tooling, and surfaces unmapped or duplicate subscriptions instead of guessing
  ownership from emails.
- Account deletion has a billing teardown policy before paid users exist. The
  policy must say whether active subscriptions are canceled, whether the Stripe
  Customer is deleted or anonymized, and which local billing rows are preserved
  or removed for audit.
- Admin user deletion preflights billing rows before deleting jobs or auth
  users. Users with `billing_customers`, `billing_subscriptions`, or
  `billing_checkout_sessions` rows are blocked until the billing teardown policy
  has been completed.
- Stripe Customer Portal live and test configurations are pinned in code through
  audited mode-specific configuration ids supplied by
  `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`. Product switching, quantity changes,
  promotion-code entry, retention coupons, and customer email edits are disabled
  unless the plan explicitly accepts and monitors the behavior. Cancellation and
  payment-method updates must be the only enabled customer actions unless the
  dispatcher and entitlement policy are revised.
- Trial behavior is decided before cutover. Either the allowlisted Price has no
  trial configured, with dated Stripe evidence, or the canonical entitlement
  rule is revised to deliberately admit or deny `trialing` subscriptions.
- Subscription Checkout accepts only immediate supported payment methods for the
  first paid rollout. This is code-pinned in Checkout creation with
  `payment_method_types: ['card']`; automated Stripe API config diffing may be
  added as extra evidence, but it is not a substitute for the route-level pin.
  If delayed or asynchronous payment methods are enabled later, entitlement and
  webhook handling are revised before any paid user can rely on access from
  `subscription.status === active`.
- Dispute handling is documented. If `charge.dispute.created` is intentionally
  Dashboard/email-only, the plan must state the owner, response timeline, and
  entitlement revocation policy. If disputes become webhook-managed, the event
  list and dispatcher must be revised before cutover.
- Paid-to-free downgrade behavior is documented for users already above FREE
  storage limits, including what actions remain allowed and what user-facing
  recovery path exists after cancellation.
- `LOG_FULL_BILLING_IDS=true` is production-forbidden unless a dated exception
  names the owner, reason, expiration, and alert coverage. A deploy-time check or
  monitoring signal detects the truthy value in live mode.
- Webhook runtime capacity has a dated cold-start and latency probe. The launch
  gate must record expected p95/p99 webhook latency, the Lambda concurrency
  floor or accepted exception, and evidence that synchronous dispatch stays well
  below Stripe timeout behavior for launch volume.
- If WAF/IP allowlisting is deferred, the exception must include an
  application-layer fallback such as cheap per-IP rejection or rate limiting
  ahead of expensive Stripe verification work, plus a follow-up date.
- Billing alerts for receipt envelope mismatch, stuck processing, webhook 5xx
  bursts, and sustained webhook latency route to a high-urgency channel such as
  pager, SMS, or an actively watched Slack channel. Email-only delivery is not
  sufficient for these signals after paid rollout.
- A billing incident classification exists before cutover, including severity
  examples, response-time expectations, owner, escalation path, and customer
  communication threshold.
- Route tests, service tests, webhook tests, and billing migration integration
  tests pass in the configured test environment.

### Stripe Dashboard webhook setup

These Stripe Dashboard steps are required before paid rollout. They have not
been completed yet.

- Create a test-mode webhook endpoint that points at the staging/test
  deployment URL:
  `https://<staging-domain>/api/billing/webhook`.
- Create a live-mode webhook endpoint that points at the production/live
  deployment URL:
  `https://<production-domain>/api/billing/webhook`.
- Do not point both modes at the same live production runtime. The running app
  chooses one active webhook secret from `STRIPE_SECRET_KEY`, so a live runtime
  must not be used as proof that test-mode endpoint signatures work.
- Do not point Stripe at a Lambda Function URL, private origin URL, local tunnel,
  preview deployment URL, or URL that redirects.
- In each endpoint, enable only these events unless the plan is explicitly
  revised:
  - `checkout.session.completed`
  - `checkout.session.expired`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
  - `invoice.payment_failed`
  - `invoice.payment_action_required`
- Do not enable "all events"; extra event volume should be treated as avoidable
  webhook load and operational noise.
- Record each endpoint's API version in the rollout artifact and verify the
  dispatcher still supports the delivered event shapes.
- Verify the endpoint API version matches the code-pinned
  `STRIPE_API_VERSION` unless a dated exception explains the mismatch and the
  delivered event shapes have been tested. Do not treat the npm `stripe`
  package version as the event-shape contract; the endpoint API version and the
  code pin are the relevant comparison.
- During the cutover audit, diff the dashboard `enabled_events` list against the
  dispatcher-supported event constants. Any extra event is either removed or
  handled through an explicit plan revision; do not enable `['*']`.
- Store the test endpoint signing secret in `STRIPE_WEBHOOK_SECRET_TEST`.
- Store the live endpoint signing secret in `STRIPE_WEBHOOK_SECRET_LIVE`.
- Document webhook signing-secret rotation cadence and the emergency rotation
  path. Stripe's delayed-expiration window can keep multiple endpoint secrets
  active temporarily, so the drill must prove the deployed verification path
  works during that overlap before the old secret expires.
- Verify the test endpoint with a real test-mode delivery before live rollout.
- Verify the live endpoint with a controlled live-mode delivery before serving
  paid users.
- Review Stripe Workbench Event Deliveries and confirm successful `200`
  responses for the expected events.

### Stripe Dashboard/API verification

Before live cutover, verify the following against Stripe itself, not only local
environment variable shape checks:

- `STRIPE_PRICE_RESUME_TAILOR_MONTHLY` points to the intended Price object in
  the intended test/live mode.
- The configured Price has the expected product, currency, amount, recurring
  interval, active state, and livemode.
- The configured Price has no trial configured unless the canonical entitlement
  rule has been revised for `trialing` and covered by tests.
- If Stripe Tax is enabled, the configured Product and Price have the intended
  tax code and tax behavior, active registrations exist for collected
  jurisdictions, and test-mode Checkout proves taxes, invoices, and receipts
  render as expected.
- If Stripe Tax is not enabled, the rollout artifact includes the dated
  product/legal exception and the support owner for tax questions after launch.
- Checkout payment methods for subscription mode are immediate-only for the
  first paid rollout and are code-pinned by passing
  `payment_method_types: ['card']` to Checkout Session creation. Automated
  Stripe API diff evidence may be recorded as defense-in-depth, but manual
  Dashboard evidence and config diffing do not replace the route-level pin.
- `NEXT_PUBLIC_APP_URL` matches the production app origin used for Checkout and
  billing portal return URLs.
- The Stripe Customer Portal configuration id for live mode and test mode is
  recorded with the rollout artifact and passed by the route through
  `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`. Product switching, quantity changes,
  promotion-code entry, retention coupons, and customer email edits are disabled
  unless deliberately accepted and monitored. Automated Stripe API config diffing
  should verify these settings when available, but the route must not rely on the
  default portal configuration for launch.
- Stripe Customer emails for successful payments are enabled in Customer emails
  settings for the intended mode.
- Stripe Billing payment-recovery emails, including any payment-confirmation or
  authentication-required emails used for launch recovery, are enabled and tested
  if `invoice.payment_action_required` is not fully app-managed.
- A manual staging checkout proves that Stripe sends the receipt or paid-invoice
  email to the authenticated OAuth account email attached to the Stripe Customer.
- If Stripe Customer email sync remains best-effort, monitor
  `billing_customer_email_sync_failed` as a release-blocking rollout signal.
  If the product requires guaranteed receipt delivery to the account email,
  revise checkout to fail when the Stripe Customer email update fails before
  starting Checkout.
- For every mapped customer in the target mode, Stripe has at most one active or
  otherwise current intended subscription for this product. Duplicate,
  support-created, or abandoned live subscriptions must be audited and resolved
  before local entitlement becomes production-critical.
- Stripe dispute handling is documented for the first paid rollout. If disputes
  remain Dashboard/email-only, the rollout artifact names the operator who
  reviews them, the target response window, and the entitlement action for lost
  or accepted disputes.
- Stripe refund and credit-note handling is documented for the first paid
  rollout. The default is cancel-at-period-end with no automatic refund; any
  manual refund exception names the support owner and paired entitlement action.

### Local database verification

Because canonical local billing state grants premium storage and AI-tailor
access, local data must be complete before paid rollout:

- Existing paid users, if any, have local `billing_customers` and
  `billing_subscriptions` rows before relying on canonical local entitlement.
- The operator account has correct local billing rows before manual staging
  validation depends on premium entitlement.
- Every active, allowlisted local subscription has a non-null
  `billing_customers.stripe_customer_id`.
- `billing_customers.stripe_customer_id` matches
  `billing_subscriptions.stripe_customer_id` for every locally entitled user.
- Each locally entitled subscription matches the Stripe subscription customer
  and the configured allowlisted Price.
- Authenticated clients still cannot insert, update, or delete billing tables,
  pending checkout rows, or Stripe event receipts.
- Pending-checkout dedupe proves one user and plan cannot mint multiple active
  Checkout Sessions, including parallel requests with different nonces.
- The emergency open-Session expiration path proves local terminal writes are
  conditional on `status = 'open'` and cannot overwrite a row already completed
  by webhook delivery or checkout-status polling.
- Admin deletion preflight checks `billing_customers`, `billing_subscriptions`,
  and `billing_checkout_sessions` before deleting jobs or auth users.
- A backup/PITR restore path and a Stripe-to-local rebuild drill have dated
  evidence before local billing state becomes production-critical.
- A scheduled Stripe-backed drift audit is configured before public Checkout and
  produces a dated "no mismatches" or mismatch report for the rollout artifact.
- The account-deletion path is blocked, revised, or operationally documented so
  deleting a user cannot orphan an active Stripe subscription or remove local
  billing audit state without the intended Stripe-side action.
- The admin account-deletion route proves billing-row preflight happens before
  deleting jobs, so a restrict-protected billing user cannot be partially deleted
  by removing their jobs first, including the case where only a pending Checkout
  Session row exists.
- The paid-to-free downgrade policy is documented and manually checked against
  a user above the FREE storage quota.

### Monitoring and alert gates

Production cutover must not proceed until alert destinations are verified and
the following signals are covered in `docs/monitoring.md` or the deployed
monitoring system:

- `billing_livemode_mismatch`
- `billing_unsupported_status`
- `billing_event_receipt_envelope_mismatch`
- `billing_unknown_event_type`
- `billing_customer_not_found_sync`
- `billing_customer_not_found_delete`
- `billing_non_current_subscription_event_ignored`
- `billing_webhook_processing_reclaimed`
- long-lived `stripe_event_receipts.result = 'processing'` rows older than the
  reclaim threshold, tracked as `billing_webhook_processing_stuck`
- webhook `413` bursts
- webhook `5xx` bursts and Stripe Event Deliveries failures
- webhook latency, especially `checkout.session.completed` delivery latency
- `checkout.session.expired` terminalization failures for local pending rows
- Stripe Checkout Session expire failures during an emergency halt
- `invoice.payment_action_required` events or the documented Dashboard/email
  review signal used for action-required recovery
- tax calculation, customer-location, or invoice-finalization failures if Stripe
  Tax is enabled
- refund or credit-note manual-review signals if those events stay outside the
  dispatcher at launch
- `billing_customer_email_sync_failed`
- local/Stripe customer or subscription mapping mismatches discovered by the
  cutover audit
- `LOG_FULL_BILLING_IDS=true` in live mode, unless a dated exception is active
  and a deploy-time or monitoring signal confirms the exception window
- bursts of `WEBHOOK_SIGNATURE_INVALID` that could indicate wrong secret,
  replay attempts, endpoint drift, or host clock skew
- scheduled Stripe-to-local drift reconciliation results, including missing
  local rows, duplicate current subscriptions, unsupported statuses, and
  stale entitlement mismatches
- billing incident alerts routed to the documented high-urgency channel for the
  top severity signals

### Manual staging drill

Run this drill in test mode before live cutover:

1. Confirm Stripe CLI or Dashboard delivery uses the staging/test deployment
   endpoint, the same endpoint path, and the same enabled event list expected for
   production.
2. Start a subscription checkout from an OAuth account with a usable email.
3. Confirm duplicate checkout clicks converge on one pending Checkout Session
   URL.
4. Complete Checkout and confirm the webhook delivery is `200` in Stripe Event
   Deliveries.
5. Confirm local `billing_customers`, `billing_subscriptions`, and
   `stripe_event_receipts` rows are created or updated as expected.
6. Confirm the success-page polling flow reaches the correct terminal state.
7. Confirm the receipt or paid-invoice email reaches the OAuth account email on
   the Stripe Customer.
8. Trigger or simulate safe-ignore paths for unsupported event type,
   customer-mapping miss, and duplicate delivery, and confirm monitoring receives
   the expected signals.
9. Review webhook response latency and verify synchronous processing remains
   comfortably below Stripe timeout risk for expected launch volume.
10. Exercise the emergency Checkout halt in test mode and confirm new Checkout
    starts fail before billing reads, pending-session claims, or Stripe calls,
    while existing billing status, portal session creation, and webhook
    processing still work. Confirm the disabled response is the documented
    `BILLING_CHECKOUT_DISABLED` contract and is not hidden by rate-limit
    dependency failure.
11. Mint a test Checkout URL, enable the emergency halt, expire the already-open
    Stripe Checkout Session, prove the hosted URL can no longer complete
    payment, and prove the local pending row does not block a later retry.
12. Exercise the payment-wins race policy by documenting how a Session that
    completes before expiration is reconciled as a real payment and routed to
    the cancel-at-period-end or manual refund-exception policy.
13. Disable or pause the test webhook endpoint, create a supported event, then
    re-enable and replay or resend using Stripe Workbench/CLI to prove the
    recovery runbook.
14. Run the Stripe-to-local rebuild drill against test-mode data and record the
    mismatches found, even if the result is "none."
15. Confirm test-mode Checkout Sessions are created with
    `payment_method_types: ['card']` and that the Customer Portal session uses
    the configured `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`.
16. Confirm tax/invoice evidence, payment-action-required recovery, account
    deletion, cancel-at-period-end no-refund behavior, manual refund-exception
    handling, and paid-to-free downgrade policies with test data before any live
    paid-user account can depend on them.

### Live cutover order of operations

The live rollout should follow this sequence unless a dated rollout artifact
documents a safer project-specific order:

1. Confirm production env vars, `LOG_FULL_BILLING_IDS`, backup/PITR evidence,
   monitoring destinations, and high-urgency escalation.
2. Create or verify the live Stripe webhook endpoint, enabled event list,
   endpoint API version, signing secret, WAF/IP allowlisting, TLS, and proof
   that the separate test endpoint points only at staging/test.
3. Keep public Checkout entry disabled while sending a controlled live-mode
   delivery to `/api/billing/webhook` and confirming a `200`.
4. Run one operator-owned live Checkout from an OAuth account, verify Stripe
   receipt delivery, local billing rows, event receipts, and premium access.
5. Review latency, alert delivery, Event Deliveries, and local/Stripe mapping
   audit output.
6. Enable the public Checkout UI only after the above evidence is attached to
   the rollout artifact.
7. Keep the operator on-call window active through the first renewal and first
   cancellation test, or document why that timeline is not applicable.

### Rollback and recovery runbooks

Before paid rollout, the rollout artifact must include operator-ready
procedures for these cases:

- Emergency halt: set `BILLING_CHECKOUT_DISABLED=true` or use the equivalent
  deployed control. The env flag intentionally accepts only literal `true`
  after trimming and case normalization; values such as `1`, `yes`, or `on` do
  not activate the halt. Confirm new authenticated Checkout starts fail closed
  with the documented response contract, confirm billing status and portal
  access still work, and leave webhook processing enabled unless the incident is
  caused by webhook writes. Auth backend outages and stale/invalid CSRF tokens
  may still return `SERVICE_UNAVAILABLE` or `CSRF_VALIDATION_FAILED` ahead of
  the disabled response because the halt preserves auth and CSRF checks while
  bypassing Redis-backed rate-limit dependency failures. Then drain
  already-minted open Checkout Sessions with
  `npm run billing:drain-checkout -- --limit 100`: retrieve each locally open
  Stripe Session, expire it only when Stripe still reports `open`, mirror
  `expired` locally only after Stripe confirms, retry/report provider failures,
  and treat already-completed Sessions as real payments handled by the
  cancellation or manual refund-exception policy. The command runs two passes by
  default to catch requests already in flight when the halt began and redacts
  Stripe Checkout Session ids in its printed summary.
- Webhook rollback: disable or pause the Stripe endpoint only when continued
  delivery is harmful, record the timestamp and endpoint id, inspect Event
  Deliveries, deploy the fix, then re-enable and use Stripe Workbench or Stripe
  CLI resend for the original events.
- Failed receipt recovery: prefer Stripe Workbench "Resend" or Stripe CLI
  resend for the original delivery. Do not invent local event payloads or mutate
  receipt rows by hand unless a separate incident runbook names the SQL, owner,
  and rollback path.
- Missed events: query Stripe events for undelivered supported event types,
  process them through the same verified webhook or replay path, and rely on
  receipt dedupe to suppress already-processed events.
- Local-state rebuild: walk Stripe Customers and Subscriptions for the intended
  mode, rebuild local customer and subscription rows only through service-role
  tooling, and report unmapped customers, duplicate current subscriptions, and
  unsupported statuses.
- Drift audit: run the scheduled Stripe-to-local audit on demand after restore,
  webhook replay, or manual Dashboard intervention, and attach the report to the
  incident or rollout artifact.
- Secret rotation: roll the endpoint signing secret on a cadence or after any
  suspected leak, use Stripe's delayed-expiration window, verify deliveries
  during the overlap, then expire the old secret.

### Billing policy decisions

These product and compliance decisions must be answered before live paid users:

- Account deletion: whether to cancel active subscriptions, delete the Stripe
  Customer, anonymize Stripe metadata, preserve local receipts, and block admin
  deletion until Stripe-side cleanup succeeds.
- Trials: whether `trialing` grants access. If not, live Prices must have no
  trial configured. If yes, update the canonical entitlement rule and tests.
- Tax and invoices: whether Stripe Tax is enabled at launch, which locations and
  customer fields Checkout collects, whether tax IDs are collected, and what
  legal/product exception applies if tax collection is deferred.
- Disputes: whether Dashboard/email monitoring is enough for launch, and when a
  disputed or lost payment revokes entitlement.
- Refunds and credits: first rollout uses no automatic refunds. Ordinary
  cancellation is cancel-at-period-end with access through the paid month;
  refund, credit, fraud, duplicate-charge, legal, or incident exceptions require
  manual support review and an explicit paired entitlement decision.
- Downgrades: whether users above the FREE storage quota can read existing data,
  create new jobs, delete down to quota, or re-upgrade to restore writes.
- Portal changes: which Customer Portal actions are deliberately enabled and
  which webhook or manual controls keep local entitlement aligned.

### Operator vocabulary

Use these terms consistently in logs, alerts, and incident notes:

- Dispatcher `outcome`: in-memory result from webhook dispatch or billing sync,
  such as `processed`, `stale_ignored`, `customer_not_found`,
  `unsupported_status_ignored`, or `duplicate_suppressed`.
- Receipt `result`: durable `stripe_event_receipts.result`, currently
  `processing`, `processed`, `stale_ignored`, or `failed`.
- Webhook API `receiptResult`: the route response field exposing the final or
  current receipt `result` to Stripe delivery logs.
- `duplicate: true`: the delivery matched an already-terminal successful
  receipt and was intentionally acknowledged without reprocessing.

### Accepted residual risks

These are deliberate current tradeoffs, not accidental omissions:

- Webhook dispatch is synchronous. This is acceptable for low expected launch
  volume, but before meaningful webhook volume the route should move toward
  verify-and-claim-then-enqueue behavior or a durable worker that owns
  `processing` receipts independently of the request lifecycle.
- Same-second but distinct Stripe events remain newer-or-equal last-write-wins
  today. Keep the equal-timestamp DB regression and document any incident that
  depends on this limitation.
- Auth metadata can still affect billing route rate-limit tier hints, but it is
  not a premium entitlement source.
- Storage entitlement can fail closed to `FREE` when local billing reads fail;
  this does not overgrant access, but it can temporarily deny premium storage.
- Stripe test receipts may not send to arbitrary email addresses unless the
  address belongs to a verified user with access to the testing environment.
- Email-only billing alerts are acceptable only during pre-production drills.
  Paid rollout requires the high-urgency billing alert path documented above.

### Go/no-go checklist

- All P0 release blockers have dated evidence.
- Stripe webhook endpoint URL, enabled events, endpoint API version, and signing
  secrets are verified in the intended mode.
- Stripe Price, subscription, and customer audits match local billing state.
- Local paid-user and operator billing rows are complete.
- Emergency Checkout halt works before request validation, billing reads,
  pending-session claims, customer creation, Stripe Checkout calls, and
  checkout-only config validation, and returns the documented
  `BILLING_CHECKOUT_DISABLED` response without relying on Redis/rate-limit
  availability.
- Already-minted open Checkout URLs can be expired through the emergency drain,
  local rows mirror only Stripe-confirmed terminal states, and payment-wins races
  are covered by cancellation or manual refund-exception policy.
- Tax/invoice compliance, payment-action-required recovery, and refund/credit
  policy have dated evidence from the required owner.
- Billing portal access is not coupled to Checkout price configuration and still
  has evidence for the intended behavior during a Checkout halt.
- Admin deletion preflight blocks `billing_customers`, `billing_subscriptions`,
  and `billing_checkout_sessions` rows before deleting jobs or auth users.
- Checkout payment methods are immediate-only through route code pinning with
  `payment_method_types: ['card']`; delayed-payment support has not silently
  drifted on.
- Portal configuration is pinned through
  `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`, and the route passes the configured
  id to Stripe instead of relying on the default portal configuration.
- Monitoring alerts are configured, delivered to the expected destination, and
  tested with at least one synthetic or staging signal.
- Manual staging drill passes end to end.
- The live cutover order, rollback runbook, failed-event replay path,
  scheduled drift audit, rebuild-from-Stripe drill, and account-deletion billing
  policy have dated rollout evidence.
- Portal configuration, trial policy, tax posture, payment-action recovery,
  dispute handling, cancel-at-period-end refund policy, downgrade behavior,
  `LOG_FULL_BILLING_IDS` deploy-time or monitoring detection, and
  cold-start/latency evidence have been verified.
- The rollout artifact is logged in `docs/feature-memory.md`; `docs/fixes.md`
  is updated only after a `git push` that actually fixes an issue.
- Any WAF/restricted-key/email-sync exception has a named owner, accepted risk,
  and follow-up date.
- No production cutover proceeds while a release blocker remains open.

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
- no billing ownership decisions from Checkout-entered or webhook-payload email
  fields

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
