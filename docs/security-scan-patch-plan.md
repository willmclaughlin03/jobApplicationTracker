# Security Scan - Verified Chunked Patch Plan

Audited against the current working tree on 2026-07-09.

This document converts the supplied security scan into implementation chunks
after checking each claim against the current code, migrations, and focused
tests. Each chunk owns one finding, but the chunks are ordered by shared
primitives and migration dependencies so separate implementers do not solve the
same problem in incompatible ways.

The repository is pre-production and currently has no paid users. The Stripe
findings are therefore production-readiness blockers rather than current live
paid-user regressions. They still require fixes before a production rollout
serves paid users.

## Verified Findings Summary

| Scan finding | Verdict | Verified scope or correction | Plan chunk |
| --- | --- | --- | --- |
| Same-second Stripe events can restore canceled Premium | Confirmed, High | Equal event timestamps are accepted, and distinct event receipts do not order conflicting snapshots. | Chunk 2 |
| Stale authoritative Stripe reads can overwrite newer webhooks | Confirmed, High | Checkout polling and the Checkout drain omit the existing local-snapshot compare-and-swap guard. | Chunk 1 |
| Completed checkout can lose duplicate protection before reconciliation succeeds | Confirmed, Medium | The problem also affects non-success webhook and drain reconciliation outcomes. | Chunk 3 |
| Logout can appear successful while the session remains valid | Confirmed, Medium-High | Protected API access remains valid immediately; UI session rediscovery may wait for the shared AUTH limiter or Redis to recover. | Chunk 6 |
| Shared AUTH quota can be poisoned cross-site and extended to 24 hours | Confirmed, Medium | Lockout lasts up to the remainder of the aligned daily window, not a new rolling 24 hours. Normal focus-driven session checks can also exhaust the shared quota. | Chunk 4 |
| Rate limiting occurs after Supabase authentication work | Confirmed, Medium | Failed-auth throttling happens only after the provider lookup, and invalid CSRF returns before any abuse-specific quota. | Chunk 5 |
| OAuth callback can drive unthrottled token exchanges | Confirmed in repository, Medium | External WAF rules cannot be inferred from this repository; no app-level callback throttle exists. | Chunk 7 |
| Billing rows can block admin deletion, with a partial-deletion race | Confirmed, Medium | Billing blocking is deliberate. The real bug is the non-atomic preflight followed by jobs deletion before Auth deletion. | Chunk 10 |
| Most request bodies are parsed before authentication or throttling | Confirmed, Low-Medium | Job routes are already capped at 16 KB, and the Stripe webhook already has a bounded raw-body path. Fourteen other route modules inherit 1 MB parsing. | Chunk 8 |
| Admin self-action protection is bypassable using UUID casing | Partly confirmed, Low | The pinned Supabase SDK currently rejects uppercase UUIDs before Auth mutation, but uppercase self-delete can erase the admin's jobs before that rejection. | Chunk 9 |

## Implementation Lanes And Order

Separate agents may work in different lanes concurrently. Chunks in the same
lane must be implemented sequentially and rebased onto the preceding chunk.

| Lane | Required order | Reason |
| --- | --- | --- |
| Billing concurrency | Chunk 1 -> Chunk 2 -> Chunk 3 | Equal-time recovery and checkout completion both depend on mandatory guarded authoritative reconciliation. |
| Auth and abuse controls | Chunk 4 -> Chunk 5 -> Chunk 6 -> Chunk 7 | Later chunks reuse the atomic limiter, split auth operations, browser-intent guard, and trusted IP extraction. |
| Independent route hardening | Chunk 8 and Chunk 9 | These are narrow changes and may run in parallel with either main lane, but not with each other if their admin-route tests overlap. |
| Account deletion | Chunk 10 after Chunks 1-3 and 8-9 | Deletion must share the final billing-write/checkout state machine and should not race edits to the admin route. |

Against the audited tree, reserve append-only migration numbers as follows:

- `026`: mandatory authoritative subscription snapshot guards.
- `027`: deterministic equal-timestamp event handling.
- `028`: Checkout Session reconciliation-pending state.
- `029`: account deletion lifecycle and billing serialization.

Before creating any migration, confirm that `025_jobs_retained_list_idx.sql` is
still the latest migration. If another migration lands, renumber this entire
reservation centrally; individual agents must not independently choose a new
number.

## Implementation Notes For All Chunks

- Work from the current dirty tree and preserve unrelated user changes.
- Follow existing route, service, migration, logger, response, and test patterns.
- Add a short comment block above every new function or helper, including
  internal helpers, matching the repository convention.
- Validate new inputs at their boundary with Zod or a comparably explicit
  schema. SQL functions must independently reject missing, partial, or
  contradictory security fields.
- Do not read `.env` files. Use `process.env` only through existing config
  boundaries, and never log secrets, cookies, tokens, Stripe payloads, PKCE
  verifiers, or raw request bodies.
- Never edit an already-applied migration to deliver a fix. Use the reserved
  forward migration and update integration setup to apply it.
- Keep the Stripe webhook's raw-body cap and signature-verification path
  separate from ordinary API route body-parser changes.
- Preserve fail-closed behavior when Redis, Supabase Auth, billing reads, or
  Stripe reconciliation is unavailable.
- Every chunk must update `docs/feature-memory.md` after implementation. After a
  future `git push`, update `docs/fixes.md` as required by the repository rules.
- Destructive database integration suites remain gated by their existing
  environment controls. Never weaken those gates to make a test run locally.

## Chunk 1 - Require Snapshot-Guarded Authoritative Stripe Sync

### Goal

Prevent a Stripe subscription snapshot fetched before a newer webhook commit
from overwriting the newer local billing row.

### Finding Validation

`syncSubscriptionFromStripe()` fetches Stripe before writing local state in
`src/server/lib/billingService.js`. Authoritative writes only include the local
compare-and-swap fields when a caller supplies them. The authoritative RPC in
`migrations/018_jobs_overflow_locking.sql` likewise checks local state only when
those optional fields are present.

The production callers differ today:

- `src/server/services/storageDowngradeService.js` supplies an exact local
  subscription id plus `updated_at` snapshot.
- `src/pages/api/billing/checkout-status.js` supplies only `expectedUserId`.
- `src/server/lib/billingCheckoutDrain.js` supplies only `expectedUserId`.

Ownership checks, advisory locks, and preservation of
`last_stripe_event_created` do not make an old provider response fresh.

### Why This Chunk Comes First

This compare-and-swap contract is the recovery primitive for the equal-time
event conflict in Chunk 2 and the reconciliation-pending state machine in Chunk
3. Implementing those first would create new authoritative paths that can still
restore stale entitlement.

### Agent Boundary

This agent owns migration `026`, the authoritative sync option contract, and all
production authoritative callers. It must not change equal-timestamp event
semantics or Checkout Session statuses; those belong to Chunks 2 and 3.

### Files To Inspect

- `migrations/018_jobs_overflow_locking.sql`
- `migrations/026_require_authoritative_billing_snapshot.sql` (new)
- `src/server/lib/billingService.js`
- `src/pages/api/billing/checkout-status.js`
- `src/server/lib/billingCheckoutDrain.js`
- `src/server/services/storageDowngradeService.js`
- `src/server/lib/__tests__/billingService.test.js`
- `src/server/api/__tests__/billing/checkout-status.test.js`
- `src/server/lib/__tests__/billingCheckoutDrain.test.js`
- `src/server/services/__tests__/storageDowngradeService.test.js`
- `src/server/db/__tests__/billingMigrations.integration.test.js`
- `src/server/db/__tests__/jobsOverflowLocking.integration.test.js`

### What To Change

Replace the optional pair of authoritative snapshot fields with one mandatory,
discriminated local snapshot contract backed by a monotonic database version:

```js
{ exists: true, subscriptionId, snapshotVersion }
```

or:

```js
{ exists: false }
```

Use an explicit SQL payload marker such as
`_expected_subscription_exists`. When it is true, both the subscription id and
positive integer `snapshot_version` are required. When it is false, both fields
must be absent and the RPC may insert only if no local subscription row exists.

Migration `026` must add `snapshot_version bigint NOT NULL` to
`billing_subscriptions`, initialize existing rows to version 1, and install a
trigger that assigns 1 on insert and increments the prior value on every update.
`updated_at` remains an audit timestamp, not a compare-and-swap token: PostgreSQL
transaction timestamps are not guaranteed to be unique or monotonic enough to
serve as a formal row version.

Authoritative options and the SQL payload must also carry one mandatory purpose:

- `reconcile_current` may only write the subscription id named by an existing
  snapshot. Storage repair and equal-time event recovery use this purpose.
- `checkout_completion` may insert against exact absence or replace a different
  existing subscription only when the locked current row is terminal-replaceable
  (`canceled` or `incomplete_expired`). Only callers that have verified a
  locally minted, owned, completed Checkout Session may use this purpose.

The database must enforce these purpose rules independently. A trusted caller
label is necessary but not sufficient: the locked current row still decides
whether replacement is permitted.

Migration `026` should replace
`upsert_billing_subscription_authoritative(jsonb)` so every authoritative call
must present exactly one valid snapshot form. It should reject unguarded,
partial, null-coerced, or contradictory payloads before mutation.

### How To Implement

1. Add a service helper that converts a strict local billing read into the
   discriminated snapshot without converting the database version through a
   timestamp or accepting a synthesized Free fallback.
2. Require authoritative options to contain that snapshot and a valid purpose.
   Keep event-mode options unchanged and reject snapshot/purpose options in
   event mode. Reject the legacy optional id/timestamp fields rather than
   silently ignoring them.
3. Build the SQL expectation and purpose fields from the validated contract.
4. In the RPC, acquire the existing per-user billing/storage advisory lock,
   load the current row, and compare either exact absence or exact
   `(stripe_subscription_id, snapshot_version)` equality before upserting.
5. Return the existing `billing_snapshot_changed` outcome when the comparison
   loses. Return the current row, including null for an absent row, without
   applying the fetched snapshot.
6. Checkout polling should use the strict billing row it already reads before
   the provider fetch. First checkout may legitimately pass `{ exists: false }`.
7. The drain must perform a strict privileged local billing read before asking
   Stripe for the subscription. Database failure must not be converted into an
   absent/Free snapshot.
8. On `SNAPSHOT_CHANGED`, allow at most one bounded retry only when a strict
   privileged reread still identifies the same target subscription id. Perform
   a new Stripe retrieval with the new version snapshot and never reuse the
   first Stripe object.
9. If the reread is absent or identifies any different subscription id,
   terminal or nonterminal, stop instead of retrying the old subscription over
   it. A verified Checkout replacement may occur on its initial exact CAS; it
   must not reinterpret a different row discovered after losing that CAS as
   proof that the original target is newer. Chunk 3 may retry the durable
   Checkout claim in a later invocation from a newly captured strict snapshot.
10. Map a database `subscription_replacement_blocked` result to a non-applied
    snapshot-change outcome. Never treat it as processed.

### Guardrails

- `expectedUserId` remains mandatory for authenticated or user-scoped
  authoritative callers; it proves ownership, while the snapshot proves
  freshness.
- Do not derive row absence from a catch, a failed read, or a helper that
  synthesizes Free state.
- Treat `snapshot_version` as an opaque positive safe integer at the JavaScript
  boundary and as `bigint` in SQL. Do not use `updated_at` for CAS decisions.
- Do not remove or weaken `last_stripe_event_created` behavior.
- Do not loop indefinitely on repeated snapshot changes.
- Keep replacement by a genuinely new subscription id possible only for the
  verified Checkout purpose and only when the locked exact snapshot is absent
  or terminal-replaceable.
- The local CAS cannot make Stripe and PostgreSQL one transaction. A provider
  change that occurs after retrieval but before its webhook commits can create
  a bounded stale interval; Chunks 2 and 3 must keep conflicts retryable and
  require canonical rereads before releasing durable claims.
- Roll out migration `026` before application instances that send the new
  absence marker. Old instances must fail closed during that interval. If a
  future production deployment requires zero reconciliation downtime, use a
  versioned guarded RPC, migrate all callers, drain old instances, and only then
  retire the old RPC; never deploy the new absence payload against migration
  `018`, which cannot guard absence.

### Tests

Add or update focused tests for:

- Existing-row authoritative sync sends the exact id and monotonic version.
- Row-absent authoritative sync sends an explicit absence marker.
- Missing, partial, contradictory, or malformed guards fail before Stripe or
  SQL mutation as appropriate.
- Every insert starts at version 1 and every update advances the version,
  including direct table writes and event-mode RPC writes.
- `reconcile_current` rejects absence and any different target id.
- `checkout_completion` rejects replacement of a different nonterminal row.
- Checkout polling cannot complete a fetch/cancel/resume race with local
  `active` restored.
- Checkout polling supports a legitimate first subscription when the local row
  was and remains absent.
- The drain uses a strict privileged read and does not treat read failure as
  absence.
- Snapshot change causes at most one fresh Stripe retrieval.
- Any different subscription, including a terminal one, prevents retry of the
  old subscription after a lost CAS.
- Existing storage-downgrade compare-and-swap behavior remains intact.

Suggested commands:

```powershell
node node_modules\jest\bin\jest.js --runTestsByPath src/server/lib/__tests__/billingService.test.js src/server/api/__tests__/billing/checkout-status.test.js src/server/lib/__tests__/billingCheckoutDrain.test.js src/server/services/__tests__/storageDowngradeService.test.js --runInBand --no-cache
node node_modules\jest\bin\jest.js --runTestsByPath src/server/db/__tests__/billingMigrations.integration.test.js src/server/db/__tests__/jobsOverflowLocking.integration.test.js --runInBand --no-cache
```

The integration command is expected to skip unless its destructive test target
is explicitly configured.

### Initial Context For Implementer

Begin with `parseSyncSubscriptionOptions()`,
`buildAuthoritativeSubscriptionPayload()`, and the authoritative branch of
`syncSubscriptionFromStripe()`. Then read the optional timestamp-snapshot block
in migration `018` and the existing guarded downgrade call. Replace that
timestamp token with the monotonic version contract rather than extending the
optional design. Treat checkout polling and the drain as missing callers of the
same compare-and-swap boundary.

## Chunk 2 - Resolve Same-Second Stripe Event Conflicts Safely

### Goal

Ensure two distinct Stripe events with the same integer-second `created` value
cannot restore a nonterminal Premium state after a terminal state for the same
subscription has committed.

### Finding Validation

Migration `015_fix_billing_subscription_event_rpc_ambiguity.sql` accepts an
incoming timestamp when it is greater than or equal to the stored timestamp.
`syncSubscriptionFromStripe()` separately rejects only strictly older events.
Stripe receipts are keyed by event id, so distinct same-second events are both
eligible for processing.

A verified race is:

1. Event A retrieves subscription `S` while it is active.
2. Distinct event B has the same `created` second and commits `S` as canceled.
3. A resumes with its cached active object.
4. The event RPC accepts equality and overwrites canceled with active.

The row/advisory locks serialize the commits but do not order equal timestamps.

### Depends On

Chunk 1 must land first. Any fresh reconciliation triggered by a tie must use
the mandatory snapshot guard instead of an unguarded authoritative write.

### Agent Boundary

This agent owns migration `027`, event-RPC tie outcomes, and webhook dispatcher
handling for those outcomes. It must not add Checkout Session statuses.

### Files To Inspect

- `migrations/015_fix_billing_subscription_event_rpc_ambiguity.sql`
- `migrations/027_resolve_equal_stripe_event_timestamps.sql` (new)
- `src/server/lib/billingService.js`
- `src/server/lib/billingWebhookDispatcher.js`
- `src/server/lib/__tests__/billingService.test.js`
- `src/server/lib/__tests__/billingWebhookDispatcher.test.js`
- `src/server/db/__tests__/billingMigrations.integration.test.js`
- `src/pages/api/billing/webhook.js`

### What To Change

Replace the event upsert function in a forward migration with explicit ordering
rules:

- Strictly newer timestamps continue through normal event application.
- Strictly older timestamps remain `stale_ignored`.
- Equal timestamp plus an identical canonical snapshot is idempotent and should
  not churn `updated_at` or `snapshot_version`.
- For the same subscription, an equal-time incoming terminal status may replace
  a nonterminal status.
- For the same subscription, an existing terminal status (`canceled` or
  `incomplete_expired`) is sticky against an equal-time nonterminal snapshot.
- Other equal-time conflicting business snapshots return a distinct
  `equal_timestamp_conflict`/`reconcile_required` reason without applying
  either as if it were known-newer.
- A genuinely different subscription may replace a terminal old subscription
  under the existing safe replacement rule; terminal stickiness must not bind
  unrelated subscription ids together.

Canonical equality should compare every entitlement-relevant field with null-
safe SQL equality: subscription id, customer id, price id, status, period end,
and `cancel_at_period_end`.

### How To Implement

1. Encode the ordering decision inside the database function while it owns the
   row lock. A JavaScript pre-read may optimize logs but cannot be the authority.
2. Return stable reasons for idempotent equality, terminal preservation, and an
   unresolved equal-time conflict.
3. Map identical equality and terminal preservation to safe processed webhook
   outcomes. They must not mutate local state back to nonterminal.
4. Map an unresolved conflict to a fresh authoritative reconciliation using the
   Chunk 1 `reconcile_current` contract. Capture the local id/version snapshot
   only after the conflict result, require that it still names the event's
   subscription, then retrieve Stripe again.
5. If that bounded reconcile fails or loses its compare-and-swap, throw through
   the dispatcher so the event receipt remains `failed`/retryable and Stripe's
   delivery retry remains the durable recovery boundary.
6. Do not introduce a standalone reconciliation queue unless the same chunk
   also provides a worker, retry policy, monitoring, and a deployment trigger.
   A queue with no consumer is weaker than the existing failed-receipt retry.
7. Preserve direct canceled handling for deletion events, including the
   future-timestamp and livemode checks already in place.

### Guardrails

- Never use event-id lexical order as Stripe event chronology.
- Never let arrival order alone decide two conflicting nonterminal snapshots
  that share a timestamp.
- Do not report an unresolved conflict as terminal `stale_ignored`; that would
  suppress recovery.
- Do not make canceled sticky across a different new subscription id.
- Keep event receipt envelope integrity and duplicate-id behavior unchanged.
- Do not acknowledge a webhook as processed before required reconciliation or
  an explicitly safe terminal-preservation outcome is durable.

### Tests

Add or update tests for:

- Identical equal-timestamp delivery is idempotent and does not update the row.
- Active followed by equal-time canceled ends canceled.
- Canceled followed by delayed equal-time active remains canceled.
- The two orders above are exercised through two independent database
  connections, not only serial mock calls.
- Equal-time `incomplete_expired` has the same terminal protection.
- A different new subscription may replace a terminal old subscription.
- Other equal-time conflicts return the new reconcile-required outcome.
- Dispatcher conflict handling performs a new guarded Stripe retrieval.
- Dispatcher recovery never uses the Checkout replacement purpose and stops if
  the strict row now names a different subscription.
- Failed reconciliation records a retryable failure rather than a terminal
  receipt.
- The existing test that currently expects conflicting equality to apply is
  replaced, not left contradicting the new contract.

Suggested commands:

```powershell
node node_modules\jest\bin\jest.js --runTestsByPath src/server/lib/__tests__/billingService.test.js src/server/lib/__tests__/billingWebhookDispatcher.test.js src/pages/api/billing/__tests__/webhook.dispatcher.test.js --runInBand --no-cache
node node_modules\jest\bin\jest.js --runTestsByPath src/server/db/__tests__/billingMigrations.integration.test.js --runInBand --no-cache
```

### Initial Context For Implementer

Start at the `>=` predicate and fallback reason in migration `015`, then inspect
the event branch around `callSubscriptionEventRpc()` in `billingService.js`.
Read the receipt claim/finalization flow before changing dispatcher outcomes;
different event ids intentionally bypass duplicate-id suppression.

## Chunk 3 - Keep Completed Checkout Claims Pending Until Reconciled

### Goal

Keep duplicate Checkout protection active after Stripe reports completion until
canonical subscription reconciliation has actually succeeded.

### Finding Validation

In `checkout-status.js`, a complete local Checkout row is marked terminal before
the subscription id is validated and before authoritative synchronization.
The partial unique index in migration `013` covers only `creating` and `open`, so
a later checkout can claim a new row when synchronization returns 503 or a
non-success outcome.

The same release condition exists beyond the cited route:

- The webhook dispatcher terminalizes after a non-throwing sync result,
  including missing-customer or unsupported-status outcomes.
- The emergency drain terminalizes after any non-throwing authoritative result.

### Depends On

Chunks 1 and 2 must land first so pending reconciliation knows how to handle
snapshot changes and equal-time conflict outcomes.

### Agent Boundary

This agent owns migration `028`, pending Checkout state transitions, Checkout
claim outcomes, checkout polling, completed-session webhook handling, and drain
selection. It must preserve the external Checkout creation and polling response
contracts unless a documented retryable state is deliberately added.

### Files To Inspect

- `migrations/013_billing_checkout_sessions.sql`
- `migrations/014_billing_checkout_premium_plan_rename.sql`
- `migrations/028_checkout_reconciliation_pending.sql` (new)
- `src/shared/constants/billing.js`
- `src/server/lib/billingService.js`
- `src/pages/api/billing/checkout.js`
- `src/pages/api/billing/checkout-status.js`
- `src/server/lib/billingWebhookDispatcher.js`
- `src/server/lib/billingCheckoutDrain.js`
- `src/server/api/__tests__/billing/checkout.test.js`
- `src/server/api/__tests__/billing/checkout-status.test.js`
- `src/server/lib/__tests__/billingWebhookDispatcher.test.js`
- `src/server/lib/__tests__/billingCheckoutDrain.test.js`
- `src/server/db/__tests__/billingMigrations.integration.test.js`

### What To Change

Add `reconciliation_pending` to the Checkout Session status constraint and to
the partial unique claim index for `(user_id, plan)`. A Stripe-complete Session
should transition:

```text
open -> reconciliation_pending -> complete
```

The first transition records that the hosted Session completed and prevents a
new Checkout. The second is allowed only after canonical local billing state is
successfully synchronized, or a safely superseded event outcome proves a newer
write already did so, and a strict reread confirms that the expected
subscription is now the canonical local row. Do not require that row to be
entitled: a completed Checkout may canonically reconcile to `incomplete`,
`canceled`, or `incomplete_expired`, and the existing billing status policy must
decide whether a later Checkout is allowed.

Update `claim_billing_checkout_session()` so a pending-reconciliation row
returns a distinct non-creation outcome. It must never create or reuse a hosted
Checkout URL from that row.

The claim RPC must also close the existing eligibility read/claim race. Before
inserting `creating`, acquire the same per-user billing-transition lock used by
subscription writes and re-evaluate canonical billing eligibility inside the
transaction. A request that read eligible before another flow reconciled a
blocking subscription must return a non-creation `billing_ineligible` outcome.

### How To Implement

1. Replace the status constraint and partial unique index in migration `028`.
2. Replace the claim RPC so `creating`, `open`, and
   `reconciliation_pending` all block a new claim, with a distinct action for
   the pending state.
3. Make the claim RPC acquire locks in one documented order: the per-user
   billing-transition lock first, then the user-plus-plan Checkout claim lock.
   Recheck the current canonical subscription under those locks immediately
   before insert and return `billing_ineligible` when `canStartCheckout()`'s SQL
   equivalent would reject it.
4. Add narrowly named service transitions for `open ->
   reconciliation_pending` and `reconciliation_pending -> complete`. Filter
   each update by the expected prior status and owner/session id.
   Recovery must be idempotent: an already-pending row continues reconciliation,
   an already-complete row never regresses, and an expired row stays terminal.
5. Checkout polling should mark pending when Stripe confirms completion, then
   validate the subscription id, run guarded reconciliation, and reread strict
   billing state. Release to `complete` when the canonical write succeeded, or
   when event sync returned a safe superseded/`STALE_IGNORED` outcome because a
   newer event already wrote state, provided the strict row identifies the
   expected subscription. Entitlement is not a release condition.
   The authoritative call uses Chunk 1's `checkout_completion` purpose. A lost
   CAS never retries across a different subscription id inside that call; the
   durable pending claim is the boundary for a later fresh attempt.
6. Missing subscription ids, provider/RPC failures, unsupported statuses,
   customer-not-found, exhausted snapshot changes, and a strict reread that
   does not prove the expected canonical subscription leave the row pending.
7. Completed-session webhook handling must use the same transition sequence.
   A malformed or retryable completion must leave both the receipt and Checkout
   claim recoverable.
8. The drain must select both `open` and `reconciliation_pending` rows. Open
   Stripe Sessions retain the current expire-or-payment-wins behavior; pending
   rows revisit canonical reconciliation and never mint another Session.
9. Checkout creation should map pending and `billing_ineligible` claims to
   stable non-creation responses without loading Checkout creation dependencies
   or calling Stripe.

### Guardrails

- A pending Checkout row never grants entitlement by itself.
- Do not leave a Stripe-complete Session labeled `open`; the explicit pending
  state distinguishes hosted-URL reuse from reconciliation work.
- Do not release the unique claim merely because a function did not throw.
- Do not leave a claim pending solely because its completion event was safely
  superseded. Stripe terminally records stale receipts, so strict canonical-row
  proof must complete the claim without depending on another delivery.
- Do not keep the claim pending solely because the canonical expected
  subscription is non-entitled. Complete the reconciliation state, then let
  canonical status decide future checkout eligibility.
- Do not rely on the route's pre-claim billing read for correctness; it is an
  early user-facing check, while the locked RPC recheck owns the insert decision.
- Expired Stripe Sessions may transition directly to `expired`; they did not
  complete payment.
- Keep Checkout Session ownership, livemode, customer, and local mint checks.
- Preserve provider idempotency keys and duplicate-submit behavior.

### Tests

Add or update tests for:

- Checkout polling changes complete Stripe Sessions to pending before sync.
- Retryable sync failure leaves the claim pending.
- A lost CAS that discovers a different terminal or nonterminal subscription
  leaves the claim pending and a later poll captures a new strict snapshot.
- Missing subscription and non-success outcomes without strict expected-row
  proof leave it pending.
- Successful sync plus a strict expected-subscription reread changes pending to
  complete for active, canceled, incomplete, and incomplete-expired canonical
  statuses; the status separately controls later checkout eligibility.
- An out-of-order completed-checkout webhook whose subscription sync is
  `STALE_IGNORED` completes the claim when a strict reread proves a newer event
  already installed that expected subscription; it does not wait for a retry
  Stripe will not send for the terminal stale receipt.
- A second checkout-status poll resumes a row left pending by the first poll,
  completes it on success, and does not require another `open -> pending`
  transition.
- Already-complete and expired rows never regress during repeated polling.
- A second checkout while pending never calls
  `checkout.sessions.create()`.
- A checkout request that read eligible before another transaction installed a
  blocking canonical subscription loses the locked eligibility recheck and
  never calls `checkout.sessions.create()`.
- The claim RPC returns the pending action under concurrent requests.
- Webhook completion follows the same pending-to-complete contract.
- Webhook retry can recover a previously pending row.
- Drain revisits pending rows and preserves them on failure.
- The partial unique index blocks another active claim while pending.

Suggested commands:

```powershell
node node_modules\jest\bin\jest.js --runTestsByPath src/server/api/__tests__/billing/checkout.test.js src/server/api/__tests__/billing/checkout-status.test.js src/server/lib/__tests__/billingWebhookDispatcher.test.js src/server/lib/__tests__/billingCheckoutDrain.test.js src/server/lib/__tests__/billingService.test.js --runInBand --no-cache
node node_modules\jest\bin\jest.js --runTestsByPath src/server/db/__tests__/billingMigrations.integration.test.js --runInBand --no-cache
```

### Initial Context For Implementer

Begin at `markMintedCheckoutSessionTerminal()` and the complete-session branch
of `checkout-status.js`. Then compare webhook and drain ordering. The core rule
is that Stripe completion and canonical entitlement reconciliation are separate
durable states.

## Chunk 4 - Separate Auth Buckets And Make Multi-Window Decisions Atomic

### Goal

Prevent public session traffic, logout traffic, and failed-auth traffic from
poisoning one another, reject browser cross-site quota spending, and ensure a
denied request cannot consume only one of two rate-limit windows.

### Finding Validation

`/api/auth/session` and `/api/auth/signout` both use the public IP identifier and
`OPERATIONS.AUTH`, whose Free limits are 15/hour and 30/day. Failed protected
auth uses the same operation and IP key. A hostile page can send simple
cross-site requests without reading responses because no Origin, Fetch
Metadata, or required custom-header gate runs before quota.

The problem also occurs in ordinary use: `AuthContext` checks the session on
mount and after visibility regain with only a 30-second throttle. Fifteen such
checks can exhaust the same bucket later needed for logout.

`checkRateLimit()` increments the daily fixed window first and then the hourly
window. After hourly exhaustion, hourly-denied requests continue consuming
daily tokens until the daily bucket is exhausted. Reversing the order merely
moves partial consumption to the other window.

### Why This Chunk Starts The Auth Lane

Chunks 5-7 need independent operation buckets, reusable trusted IP extraction,
and one atomic rate-limit primitive. Building those separately would duplicate
security-sensitive key and proxy-trust logic.

### Agent Boundary

This agent owns the atomic limiter, `AUTH_SESSION`, `AUTH_LOGOUT`, and
`AUTH_FAILURE` operations, the browser-intent primitive, and extraction of the
existing trusted IP logic into a reusable server helper. It does not change
logout cookie semantics, pre-auth order, or OAuth callback behavior.

### Files To Inspect

- `src/shared/constants/tiers.js`
- `src/server/lib/rateLimit.js`
- `src/server/lib/redis.js`
- `src/server/middleware/withRateLimit.js`
- `src/server/lib/userTier.js`
- `src/pages/api/auth/session.js`
- `src/pages/api/auth/signout.js`
- `src/client/contexts/AuthContext.js`
- `src/client/components/ErrorPage.jsx`
- `src/pages/_app.js`
- `src/pages/api/auth/__tests__/session.test.js`
- `src/client/contexts/__tests__/AuthContext.test.js` (new)
- `src/shared/constants/__tests__/tiers.test.js`
- `src/server/lib/__tests__/rateLimit.test.js`
- `src/server/lib/__tests__/rateLimit.integration.test.js`
- `src/server/middleware/__tests__/withRateLimit.test.js`

### What To Change

Add separate rate-limit operations and explicit policies for:

- successful authenticated session refresh/check traffic;
- logout/revocation attempts;
- missing or invalid protected-route authentication.

Use an explicit starting policy in every applicable tier, then tune from
pre-production evidence:

- `AUTH_SESSION`: approximately 300/hour and 2,500/day per authenticated user,
  including the CSRF-prime GETs triggered by session refresh. This leaves
  headroom above the client's maximum focus-driven request cadence.
- `AUTH_LOGOUT`: approximately 30/hour and 100/day per trusted IP for remote
  revocation attempts. Local cookie cleanup is handled separately in Chunk 6.
- `AUTH_FAILURE`: retain the current 15/hour and 30/day per trusted IP for
  missing or invalid sessions.

Convert `/api/auth/session` to the protected middleware path and return
`req._rateLimitUser`'s safe fields instead of calling Supabase Auth a second
time in its handler. Missing/invalid sessions should flow through the IP-keyed
failed-auth bucket. Update the client to treat the resulting 401 as no current
session, but do not map every failed session check to logout. Use a tri-state
result: authenticated user, authoritative unauthenticated (401), or temporarily
unavailable (429, 503, network, malformed response). A focus refresh must retain
the last known user on temporary unavailability; initial load must expose a safe
unavailable state rather than claim the cookies are unauthenticated.

Add a required, non-secret app-request header for session and signout browser
fetches. Cross-origin JavaScript cannot attach it with a simple/no-CORS request;
a normal cross-origin fetch triggers preflight, and this app serves neither a
successful OPTIONS route nor cross-origin allow headers.

Replace sequential multi-window mutation with one Redis-side atomic decision:
read all configured fixed windows, reject without incrementing any window if
one is exhausted, or increment all applicable windows and set their expiries as
one operation.

### How To Implement

1. Add the split operations and limits to every tier that can reach them.
2. Move `extractIpIdentifier()` and its normalization helpers into a server-only
   module used by middleware now and the OAuth callback later. Preserve the
   current CloudFront viewer-address, rightmost forwarded-for, and local socket
   trust order.
3. Add a browser-intent helper with one exact header name/value shared by the
   client and server. Validate it after the method allowlist but before auth or
   quota work.
4. Require intent on session and signout. Treat Origin and `Sec-Fetch-Site` as
   supplemental signals, not replacements for the required non-simple header.
5. Implement the fixed-window check in one Redis Lua/EVAL operation or an
   equivalent single atomic server-side primitive. Use stable namespaced keys,
   aligned windows, bounded TTLs, and the same response metadata contract.
6. If Redis times out or returns an unexpected payload, fail closed as
   unavailable.
7. Move authenticated session response shaping onto the middleware user so one
   request performs only one Supabase `getUser()` call.
8. Make `AuthProvider` the owning initial-unavailable UI boundary: while the
   first session check is 429/503/network-unavailable, do not render child pages
   whose `user === null` guards would redirect to login. Render the existing
   public-safe retryable 429/503 `ErrorPage` state (network/unknown maps to 503)
   and allow reload/retry. On later focus failure, keep rendering the last known
   user and children.
9. Map `/api/auth/csrf` onto the authenticated session-management policy (or a
   separately documented user-keyed CSRF-prime policy) instead of leaving a
   generic shared `AUTH` bucket.
10. Keep non-admin admin probes on a user-keyed failure/probe policy; do not mix
   them with the public victim IP's session/logout counter.

### Guardrails

- The app-request header is a browser-intent signal, not an authentication
  secret. Auth and rate limiting still apply.
- Reject missing intent before spending quota.
- Never trust the leftmost client-controlled forwarded-for value.
- A denial must leave every configured window's count unchanged.
- Preserve fail-closed Redis behavior and existing 429 response headers.
- Do not make logout remote revocation unmetered in this chunk.
- Do not let a public session endpoint reintroduce a second Supabase Auth call.

### Tests

Add or update tests for:

- Session, logout, and failed auth resolve to different operation buckets.
- Session handler reuses the authenticated middleware user.
- A 401 session response becomes authoritative unauthenticated client state.
- Session 429, 503, malformed JSON, and network failure are classified as
  unavailable rather than logout; focus refresh retains the last known user,
  while initial load surfaces safe unavailable state.
- Initial 429/503/unavailable renders the AuthProvider-owned retryable boundary
  and does not mount a child/page guard that can redirect to `/login`.
- Missing or wrong app-request intent is rejected before auth and Redis.
- Same-origin client fetches send the required header.
- Daily-pass/hourly-denied attempts do not decrement daily remaining.
- Hourly-pass/daily-denied attempts do not decrement hourly remaining.
- Concurrent requests at the boundary admit no more than the smallest limit and
  increment all windows only for admitted requests.
- Atomic limiter timeout/malformed response fails closed.
- Existing IP normalization and proxy-trust tests still pass after extraction.

Suggested commands:

```powershell
node node_modules\jest\bin\jest.js --runTestsByPath src/shared/constants/__tests__/tiers.test.js src/server/lib/__tests__/rateLimit.test.js src/server/middleware/__tests__/withRateLimit.test.js src/pages/api/auth/__tests__/session.test.js src/client/contexts/__tests__/AuthContext.test.js --runInBand --no-cache
node node_modules\jest\bin\jest.js --runTestsByPath src/server/lib/__tests__/rateLimit.integration.test.js --runInBand --no-cache
```

### Initial Context For Implementer

Start with `checkRateLimit()` and its current daily-first tests, then read the
public/protected branches of `withRateLimit()`. Finally inspect session checks in
`AuthContext`; the shared bucket is consumed by normal UI behavior as well as
hostile cross-site traffic.

## Chunk 5 - Add Pre-Auth And Invalid-CSRF Abuse Buckets

### Goal

Stop repeatedly abusive traffic before it can force unlimited Supabase Auth
lookups, and meter invalid-CSRF abuse without spending the legitimate business
operation quota.

### Finding Validation

Protected requests call `getUserFromRequest()` before the normal user operation
quota. Failed-session throttling occurs only after that call, while auth-backend
unavailable and thrown auth paths can return without a limiter result. Valid
sessions with invalid CSRF return 403 before Redis and produce a warning on
every attempt.

Method rejection already occurs before auth and should remain there, but it does
not protect valid-method abuse.

### Depends On

Chunk 4 must land first. This chunk must use the atomic limiter and reusable
trusted IP helper rather than create a second rate-limit implementation.

### Agent Boundary

This agent owns `PRE_AUTH` and `CSRF_FAILURE` operation policies and middleware
ordering. It does not change route-specific business limits or logout cleanup.

### Files To Inspect

- `src/shared/constants/tiers.js`
- `src/server/middleware/withRateLimit.js`
- `src/server/lib/supabaseServer.js`
- `src/server/lib/rateLimit.js`
- `src/server/middleware/__tests__/withRateLimit.test.js`
- `src/server/middleware/__tests__/withRateLimit.csrf.test.js`
- `src/server/middleware/__tests__/withRateLimit.fullPipeline.integration.test.js`
- `src/shared/constants/__tests__/tiers.test.js`

### What To Change

Add two dedicated policies:

- A generous IP-keyed `PRE_AUTH` bucket that runs on every protected request
  after method and required browser-intent checks but before
  `getUserFromRequest()`.
- A narrower `CSRF_FAILURE` bucket keyed as `user:<authenticated id>` and used
  only after a valid user is known and a state-changing request fails CSRF
  validation. The IP-keyed PRE_AUTH check remains the coarse overlay; the
  failure bucket must not let one account poison other users behind the same
  NAT.

Keep the existing stricter failed-auth bucket after provider auth. The pre-auth
bucket limits provider amplification; the failed-auth bucket still limits
credential/session probing. Keep the normal user operation bucket after auth
and successful CSRF.

Initial pre-auth limits should be deliberately generous for shared NATs and
documented against aggregate legitimate route volume. A starting policy around
3,000/hour and 30,000/day per trusted public IP is reasonable for
pre-production; confirm with observed request-duration logs before production.
The invalid-CSRF policy can be materially lower, for example 60/hour and
200/day, because legitimate clients should rarely enter it.

### How To Implement

The protected request order should become:

```text
method/operation validation
-> route browser-intent validation when required
-> trusted IP extraction
-> PRE_AUTH atomic check
-> Supabase getUser()
-> AUTH_FAILURE check when auth is invalid
-> CSRF validation
-> user-keyed CSRF_FAILURE check only when CSRF is invalid
-> user operation check
-> handler
```

On invalid CSRF, return the existing 403 while the failure bucket has capacity.
When that bucket is exhausted, return the normal 429 contract. Neither outcome
spends the business-operation quota.

`skipRateLimitWhen` may continue to skip a route's business operation bucket,
but it must not bypass pre-auth protection. In particular, disabled Checkout
traffic must not regain unbounded Supabase Auth work.

### Guardrails

- Tune pre-auth for NAT/shared-IP tolerance; it is coarse protection, not the
  user's product quota.
- Redis unavailable before auth remains fail-closed. Ordinary protected routes
  already require Redis later in the current pipeline.
- Do not treat an unidentifiable IP as an absent check. Fail closed and log only
  safe header-presence metadata.
- Invalid CSRF must not consume insert/update/delete/admin/billing quotas.
- Throttle repeated failure logs so the abuse bucket does not merely move the
  denial-of-service pressure to logging.
- Add deployment/WAF coarse throttling for protection before Lambda execution;
  app middleware can protect Supabase but still consumes one invocation.

### Tests

Add or update ordering and behavior tests for:

- PRE_AUTH is invoked before `getUserFromRequest()`.
- Pre-auth 429, unavailable, or unidentifiable IP prevents Supabase Auth work.
- Successful protected requests consume pre-auth, then user operation quota.
- Invalid session consumes pre-auth, then the stricter failed-auth bucket.
- Auth unavailable still proves pre-auth was checked first.
- Invalid CSRF consumes pre-auth and CSRF-failure quota, but not business quota.
- Two users behind one IP have independent CSRF-failure counters while sharing
  only the deliberately generous PRE_AUTH overlay.
- Exhausted CSRF-failure quota returns 429 without invoking the handler.
- `skipRateLimitWhen` does not skip pre-auth.
- Repeated invalid-CSRF, unidentifiable-IP, and pre-auth-denied requests produce
  bounded/sampled warning volume rather than one warning or error per attempt.
- Full-pipeline Redis tests preserve response headers and fail-closed behavior.

Suggested command:

```powershell
node node_modules\jest\bin\jest.js --runTestsByPath src/server/middleware/__tests__/withRateLimit.test.js src/server/middleware/__tests__/withRateLimit.csrf.test.js src/server/middleware/__tests__/withRateLimit.fullPipeline.integration.test.js src/shared/constants/__tests__/tiers.test.js --runInBand --no-cache
```

### Initial Context For Implementer

Read the main returned function in `withRateLimit.js` from method validation
through handler invocation. The placement is the fix: a new bucket after
`getUserFromRequest()` would leave the reported amplification intact.

## Chunk 6 - Make Local Logout Independent And Client-Verified

### Goal

Guarantee that an accepted same-origin logout request expires local HttpOnly
auth and CSRF cookies even when Redis or Supabase revocation is unavailable,
while preventing the client from reporting success when the request never
reached that local cleanup boundary.

### Finding Validation

`signout.js` currently places its only cookie-clearing logic inside the public
rate-limit wrapper. Unidentified IP, Redis unavailable, and exhausted quota
responses return before the handler. `AuthContext.signOut()` ignores the HTTP
status, swallows network failures, clears React state, and returns success;
callers then redirect to login.

The provider-error fallback works once the handler runs. It does not cover
middleware short-circuits.

The route documents current-device logout, but its unscoped
`ssrClient.auth.signOut()` call uses the installed Auth client's default global
scope. The patch must make the intended current-device behavior explicit rather
than silently preserving a dependency default.

### Depends On

Chunks 4 and 5 must land first. Local cleanup must run after the required
browser-intent check from Chunk 4, but before the dedicated logout limiter and
provider revocation. Running cleanup before intent validation would introduce a
logout-CSRF path.

### Agent Boundary

This agent owns the signout route's local/remote split, AuthContext response
handling, and logout callers. It does not change the shared limiter internals.

### Files To Inspect

- `src/pages/api/auth/signout.js`
- `src/shared/logger.js`
- `src/client/contexts/AuthContext.js`
- `src/pages/index.js`
- `src/pages/billing/index.js`
- `src/pages/admin/users.js`
- `src/pages/admin/users/[id].js`
- `src/server/lib/csrf.js`
- `src/pages/api/auth/__tests__/signout.test.js` (new)
- `src/client/contexts/__tests__/AuthContext.test.js` (new)
- `src/pages/__tests__/index.test.js` (new)
- `src/pages/billing/__tests__/index.test.js`
- `src/pages/admin/__tests__/users.test.js` (new)
- `src/pages/admin/users/__tests__/id.test.js` (new)

### What To Change

Split logout into a local security action and a remote best-effort action.

Required order:

```text
POST method + browser-intent validation
-> expire every matching Supabase auth cookie chunk and the CSRF cookie
-> dedicated AUTH_LOGOUT limiter
-> bounded Supabase current-device revocation with explicit local scope when allowed
-> response
```

The local cleanup boundary must sit structurally outside any Redis/provider path
that can return early. Once cleanup headers are attached, remote limiter denial
or provider failure should be safely logged and treated as local logout success;
do not return a non-2xx that tells the client to keep authenticated UI state
after its cookies were actually removed.

The exported route must no longer place this sequence behind the existing
response-owning `withRateLimit()` wrapper. The outer route owns method and
browser-intent validation plus local expiry. It then calls the dedicated limiter
as a decision that only gates provider revocation; after local cleanup, limiter
403/429/503-style outcomes must not short-circuit or own the HTTP response.

The client must still require an `ok` response before clearing React state and
redirecting. This catches a method/intent rejection, upstream WAF/CDN response,
network failure, or any failure that occurs before the app's local cleanup
boundary.

### How To Implement

1. Replace the response-owning wrapper with an outer route that first calls
   `attachRequestLogger(req)`, sets `x-request-id`, and guarantees `req.log`
   exists for every later provider/limiter failure. Then keep the cheap
   POST/method and shared browser-intent guards before cookie mutation. Reuse
   shared low-level helpers; do not fork proxy trust or error-envelope logic.
2. Move auth-cookie and CSRF expiration into a route-local prelude that always
   runs after those guards. Preserve existing `Set-Cookie` values instead of
   overwriting them.
3. Match all `sb-*-auth-token*` chunks, including chunked tokens and stale PKCE
   verifier variants, without logging cookie names or values.
4. Call the dedicated limiter directly as a provider-revocation decision; do
   not pass control to middleware that can send its own response after cleanup.
5. Run Supabase `auth.signOut({ scope: 'local' })` only when that decision
   permits. This pins the documented current-device contract. Remote
   limiter/provider failure must not undo or delay local expiry.
6. Return 200 only after local expiry headers have been attached. Include no
   token/provider detail in the response.
7. Update `AuthContext.signOut()` to send browser intent, check `response.ok`,
   parse only safe error information, and return/reject a real error on
   non-2xx or network failure.
8. Clear client state only on confirmed local success.
9. Update all logout callers to redirect only when signout succeeds and to
   expose or retain a safe retry path otherwise.

### Guardrails

- Do not require a valid session or CSRF token to clear stale local auth
  cookies; browser intent is the cross-site guard.
- Do not clear cookies on wrong-method or missing-intent requests.
- Do not make provider revocation an unbounded public Supabase call.
- Do not rely on the Auth client's default logout scope. Assert explicit local
  scope in code and tests; do not claim provider-wide revocation.
- Keep HttpOnly, Secure-in-production, SameSite, path, and Max-Age expiration
  attributes correct for every cookie chunk.
- Never log cookie names, values, refresh tokens, or provider response bodies.

### Tests

Add route tests for:

- Successful provider signout expires all auth chunks and CSRF.
- Provider signout receives exactly `{ scope: 'local' }`.
- Provider error and thrown provider exception still expire local cookies.
- Provider error logging works when the test request did not pre-seed `req.log`,
  and the response includes the request id without exposing the error.
- Logout limiter exhausted/unavailable still expires cookies and returns local
  success without calling the provider when disallowed.
- Unidentifiable IP after local cleanup cannot preserve browser cookies.
- Missing browser intent and wrong method do not clear cookies.
- Existing `Set-Cookie` headers are preserved.
- Applying the returned cookie expirations makes a subsequent protected request
  unauthorized.

Add client/page tests for:

- 2xx logout clears React state and redirects.
- Non-2xx and network failure are surfaced and do not report success.
- Each page waits for success before redirecting.
- Dashboard, billing manual logout, billing automatic-401 logout, admin list,
  and admin detail branches all honor the error contract.
- The required browser-intent header is sent.

Suggested command:

```powershell
node node_modules\jest\bin\jest.js --runTestsByPath src/pages/api/auth/__tests__/signout.test.js src/client/contexts/__tests__/AuthContext.test.js src/pages/__tests__/index.test.js src/pages/billing/__tests__/index.test.js src/pages/admin/__tests__/users.test.js src/pages/admin/users/__tests__/id.test.js --runInBand --no-cache
```

### Initial Context For Implementer

Start with the early returns in `withRateLimit()` and draw the response order for
`signout.js`. Then inspect all callers of `signOut()`; fixing AuthContext alone
is incomplete if pages ignore its new error contract.

## Chunk 7 - Throttle OAuth Callback Exchanges Before Supabase

### Goal

Reject malformed and excessive OAuth callback attempts before they can consume
Supabase token-exchange quota and unbounded error-log volume. The in-page check
cannot prevent the origin serverless invocation itself; production needs a
separate edge/WAF throttle for pre-invocation concurrency protection.

### Finding Validation

`src/pages/auth/callback.js` validates only that `code` is a nonempty string no
longer than 2048 characters before calling
`exchangeCodeForSession()`. It has no app-level rate limiter. The public callback
also passes through `src/middleware.js`, whose session refresh performs an
unthrottled Supabase `getUser()` before the callback's server-side props run.

Supabase short-circuits exchange when no PKCE verifier exists, but a direct
client can send the predictable project-scoped verifier cookie name and an
arbitrary nonempty value. PKCE still prevents authentication bypass; the impact
is provider quota and log pressure. A `getServerSideProps` limiter runs after
the origin invocation has started, so repository-only page code does not bound
Lambda invocation count.

### Depends On

Chunk 4 must provide the atomic limiter and trusted IP helper. Chunk 5 should
land first so callback and API abuse policies follow the same fail-closed
posture.

### Agent Boundary

This agent owns `AUTH_CALLBACK`, callback query/verifier validation, callback
status responses, and the middleware bypass for duplicate callback auth work.
It does not change the OAuth provider initiation flow.

### Files To Inspect

- `src/pages/auth/callback.js`
- `src/middleware.js`
- `src/server/lib/supabaseApiRoute.js`
- `src/server/lib/rateLimit.js`
- The trusted IP helper created in Chunk 4
- `src/shared/constants/tiers.js`
- `src/pages/auth/__tests__/callback.test.js` (new)
- `src/__tests__/middlewarePublicPaths.test.js`
- Installed `@supabase/ssr` cookie chunk/encoding behavior

### What To Change

Add a callback-only IP operation and apply it after cheap code and PKCE cookie
validation but before creating the Supabase client or exchanging the code. A
starting policy around 30/hour and 100/day per trusted public IP is sufficient
for ordinary OAuth retry behavior; confirm it against shared-NAT expectations
before production.

Validate the decoded verifier against the PKCE contract:

- exactly one project-scoped `*-code-verifier` cookie family;
- well-formed contiguous chunks when chunking is present;
- compatible decoding for the installed `@supabase/ssr` `base64-` encoding;
- decoded length from 43 through 128 characters;
- only RFC 7636 unreserved verifier characters: letters, digits, `-._~`.

Shape validation is a cheap rejection filter, not a security boundary. An
attacker can generate a valid-looking random verifier, so rate limiting remains
mandatory.

### How To Implement

1. Add `AUTH_CALLBACK` limits and use the Chunk 4 atomic limiter with the shared
   trusted IP identifier.
2. Add a narrowly scoped PKCE cookie reader that reconstructs the exact cookie
   family using the installed SSR library's encoding/chunk rules. Do not use a
   loose suffix scan that accepts multiple ambiguous verifier families.
3. Run code and verifier validation before quota so drive-by callback requests
   without a target-domain verifier cannot poison a victim IP's callback bucket.
4. Run the callback quota before `createApiRouteClient()` and
   `exchangeCodeForSession()`.
5. Return a real safe 429 or 503 page/status when throttled or unavailable; do
   not exchange and do not redirect in a way that hides the response status.
6. Keep the existing validated `next` path behavior and CSRF-cookie issue on
   successful exchange.
7. In edge middleware, bypass the generic Supabase session refresh for
   `/auth/callback` so each callback does not perform an extra unthrottled Auth
   request before its own guard. Scope this bypass narrowly; do not silently
   change all public-page refresh behavior.
8. Rate-limit repetitive callback error logs and never log the code or verifier.
9. Add a production deployment requirement for callback-specific
   CloudFront/WAF/edge throttling before origin invocation. The server-only
   trusted IP helper uses Node APIs and must not simply be imported into Edge
   middleware; use a deployment-compatible edge rule or a separately designed
   edge-safe primitive.

### Guardrails

- Do not treat verifier shape as proof that the request came from the app.
- Do not log OAuth codes, verifier values, cookies, or token endpoint bodies.
- Do not reuse session/logout/failed-auth counters for callback exchanges.
- Fail closed on missing trusted IP or Redis unavailability.
- Preserve open-redirect protections and CSRF issuance on success.
- Keep the callback reachable as a public page; throttling is not authentication.
- Do not claim the page-level limiter protects origin Lambda concurrency. Mark
  the pre-invocation edge/WAF rule as production rollout evidence.

### Tests

Add tests for:

- Missing, blank, oversized, or repeated code values do not call limiter or
  exchange.
- Missing, malformed, overlong, underlength, ambiguously chunked, or invalid-
  character verifiers do not call limiter or exchange.
- Current SSR encoded/chunked verifier format is accepted and not logged.
- A plausible callback invokes the limiter before the exchange.
- 429, unavailable, and unidentifiable IP paths never create the Supabase
  client or exchange a code.
- Provider error returns safe failure behavior without secret logs.
- Success sets the CSRF cookie and redirects only to a validated local path.
- Edge middleware skips its generic `getUser()` call for the callback but not
  for protected pages.
- Repeated malformed code/verifier, unidentifiable-IP, and throttled attempts
  produce bounded/sampled warning volume rather than one log per request.

Suggested command:

```powershell
node node_modules\jest\bin\jest.js --runTestsByPath src/pages/auth/__tests__/callback.test.js src/__tests__/middlewarePublicPaths.test.js src/server/lib/__tests__/rateLimit.test.js --runInBand --no-cache
```

### Initial Context For Implementer

Read callback validation through `exchangeCodeForSession()`, then inspect how
the installed `@supabase/ssr` storage adapter combines and decodes code-verifier
cookies. Finally trace `/auth/callback` through edge middleware; protecting only
`getServerSideProps` leaves the earlier generic Auth call unbounded.

## Chunk 8 - Declare A Body-Parser Policy For Every API Route

### Goal

Stop bodyless and tiny-payload API routes from buffering and parsing up to 1 MB
before authentication, CSRF, method checks inside the wrapper, or Redis quota.

### Finding Validation

Next 14.2.35's API resolver parses the body before invoking the exported route
handler and uses a default `1mb` limit when the route has no explicit config.

Current safe exceptions are:

- `src/pages/api/index.js`: 16 KB JSON.
- `src/pages/api/[id].js`: 16 KB JSON.
- `src/pages/api/billing/webhook.js`: body parser disabled plus the existing
  bounded raw-body signature path.

Fourteen other API route modules inherit the default. Four accept tiny JSON;
ten have no body contract.

### Why This Chunk Is Independent

This is route-boundary configuration, not a change to auth or billing business
logic. It may run alongside either main lane, but it should land before Chunk 10
to avoid simultaneous edits to the admin deletion route.

### Agent Boundary

This agent owns API route configs and route-safety coverage only. It must not
change validation schemas, webhook raw-body behavior, auth order, or response
formatting.

### Files To Inspect

Tiny JSON routes to cap at `1kb` after confirming valid encoded size:

- `src/pages/api/admin/users/[id]/role.js`
- `src/pages/api/billing/checkout.js`
- `src/pages/api/billing/checkout-status.js`
- `src/pages/api/storage/locked-jobs.js`

Bodyless routes on which to set `bodyParser: false`:

- `src/pages/api/admin/users/index.js`
- `src/pages/api/admin/users/[id].js`
- `src/pages/api/auth/csrf.js`
- `src/pages/api/auth/session.js`
- `src/pages/api/auth/signout.js`
- `src/pages/api/billing/portal.js`
- `src/pages/api/billing/status.js`
- `src/pages/api/health.js`
- `src/pages/api/storage/export.js`
- `src/pages/api/storage/status.js`

Coverage and exceptions:

- `src/pages/api/__tests__/routeSafety.test.js`
- `src/pages/api/__tests__/index.test.js`
- `src/pages/api/__tests__/[id].test.js`
- `src/pages/api/billing/__tests__/webhook.test.js`
- `src/server/lib/readRawBody.js`

### What To Change

Add a literal file-scoped Next.js API `config` export to each route. Use
`bodyParser: false` for bodyless contracts and a small explicit `sizeLimit` for
the four tiny JSON contracts.

Extend the route-safety suite so every Pages API route must declare exactly one
approved policy:

- bounded JSON;
- parser disabled for a bodyless route; or
- parser disabled plus an approved bounded raw-body implementation for Stripe.

Add a separate deployment requirement for an upstream CloudFront/WAF/Amplify
request-size ceiling. Route config protects application parsing; it cannot
prevent bandwidth or platform work before Next.js receives the request. Any
upstream ceiling must preserve the Stripe webhook's current 256 KB raw-body
contract or use a route-specific exception.

### How To Implement

Use explicit literal exports such as:

```js
export const config = {
  api: {
    bodyParser: false,
  },
};
```

or:

```js
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1kb',
    },
  },
};
```

Keep configs file-scoped so Next can statically discover them. Do not hide the
values behind a runtime helper.

### Guardrails

- Do not change the two existing 16 KB job limits.
- Do not change the webhook parser-disabled/raw-signature path or its cap.
- Confirm the largest valid JSON payload is comfortably under 1 KB before
  choosing that limit. Do not assume every current schema is `.strict()`;
  `setRoleSchema` and `billingCheckoutStatusSchema` are not.
- Disabling parsing does not itself reject a streamed body; upstream limits
  remain a separate deployment control.
- Do not access `req.body` in a newly bodyless route.
- Do not claim WAF coverage from a repository-only config change.

### Tests

Add or update tests for:

- Every API route appears in the route-safety policy inventory.
- The four tiny JSON routes export the expected explicit limit.
- The ten bodyless routes disable parsing.
- Job routes remain 16 KB.
- Stripe webhook remains parser-disabled and its raw-body cap tests pass.
- Framework-level oversized tiny JSON returns 413 where the local harness can
  exercise Next's resolver.
- Valid route suites remain unchanged.

Suggested commands:

```powershell
node node_modules\jest\bin\jest.js --runTestsByPath src/pages/api/__tests__/routeSafety.test.js src/pages/api/__tests__/index.test.js src/pages/api/__tests__/[id].test.js src/pages/api/billing/__tests__/webhook.test.js --runInBand --no-cache
npm run build
```

If build-time configuration is unavailable, report that explicitly rather than
weakening config validation.

### Initial Context For Implementer

Start with `routeSafety.test.js`, then inventory every non-test file under
`src/pages/api`. Use `req.body` references to distinguish the four tiny JSON
contracts from bodyless routes, and confirm the webhook exception last.

## Chunk 9 - Canonicalize Admin UUIDs Before Self-Action Checks

### Goal

Make admin self-action checks independent of textual UUID casing and stop an
uppercase self-delete before any billing query, jobs deletion, or Auth call.

### Finding Validation

`userIdParamSchema` accepts and preserves upper- or mixed-case UUID text, while
`preventSelfAction()` uses case-sensitive string equality. The pinned
`@supabase/auth-js` version currently applies a lowercase-only UUID regex before
admin get/update/delete calls, so the scan's claimed self-demotion and Auth
self-deletion are not currently reachable.

The guard bypass still has a concrete failure path: PostgreSQL accepts the
uppercase UUID as the same value, so an admin with no billing blockers can
delete their own jobs. The later Auth deletion throws on uppercase input, the
route returns an error, and the account remains with jobs already gone. Relying
on a downstream dependency's casing restriction is also brittle.

### Why This Chunk Is Narrow

Canonicalizing at validation plus a defensive comparison fixes the current data
loss path without changing authorization, role, or deletion semantics. It may
land independently before Chunk 10.

### Agent Boundary

This agent owns UUID normalization and focused helper/route tests. It should not
rewrite admin deletion or role workflows.

### Files To Inspect

- `src/shared/validations/adminSchemas.js`
- `src/server/lib/requireAdmin.js`
- `src/pages/api/admin/users/[id].js`
- `src/pages/api/admin/users/[id]/role.js`
- `src/shared/validations/__tests__/adminSchemas.test.js` (new if absent)
- `src/server/lib/__tests__/requireAdmin.test.js` (new if absent)
- `src/server/api/__tests__/adminUsers.test.js`
- `src/server/api/__tests__/adminUserRole.test.js` (new)

### What To Change

Transform a successfully validated admin path UUID to lowercase in
`userIdParamSchema`. Also make `preventSelfAction()` compare canonical lowercase
forms as defense in depth. Invalid/missing identifiers should fail closed at the
existing schema/auth boundaries rather than being coerced into a usable id.

Forward only the canonical lowercase target to Supabase and PostgREST. This
also makes valid uppercase non-self admin URLs work consistently with the
pinned Auth SDK.

### How To Implement

1. Add `.transform((id) => id.toLowerCase())` after UUID validation.
2. Normalize both valid string operands inside `preventSelfAction()` before
   equality.
3. Preserve the existing 403 response code and public error contract.
4. Ensure both delete and role routes call the guard before any target-specific
   database or Auth work.
5. Do not add a second ad hoc normalization in each route; keep the boundary and
   shared guard authoritative.

### Guardrails

- Do not loosen UUID validation.
- Do not trust the Auth SDK's current lowercase-only regex as the self-action
  control.
- Do not change which roles may perform admin actions.
- Do not include raw target ids in new logs beyond existing safe audit policy.
- Keep non-self UUID identity unchanged apart from canonical text casing.

### Tests

Required cases:

- Lowercase actor and lowercase self target are blocked.
- Lowercase actor and uppercase self target are blocked.
- Lowercase actor and mixed-case self target are blocked.
- Uppercase non-self target is normalized and forwarded lowercase.
- DELETE self-action returns 403 before billing preflight, jobs deletion, or
  Auth deletion.
- Role self-action returns 403 before Auth fetch or update.
- Invalid UUIDs remain validation failures.

Suggested command:

```powershell
node node_modules\jest\bin\jest.js --runTestsByPath src/shared/validations/__tests__/adminSchemas.test.js src/server/lib/__tests__/requireAdmin.test.js src/server/api/__tests__/adminUsers.test.js src/server/api/__tests__/adminUserRole.test.js --runInBand --no-cache
```

### Initial Context For Implementer

Read `userIdParamSchema`, `preventSelfAction()`, and the order of operations in
admin DELETE. The important correction is that the current impact is partial
jobs loss, not successful last-admin Auth deletion under the pinned dependency.

## Chunk 10 - Add A Disabled, Serialized, Resumable Account Deletion Lifecycle

### Goal

Make account deletion fail safe under concurrent checkout/billing activity and
provider failures: disable access first, serialize new billing creation, and
resume cleanup without deleting jobs from an account that remains active.

### Finding Validation

The admin route deliberately blocks deletion when it sees rows in
`billing_customers`, `billing_subscriptions`, or
`billing_checkout_sessions`. All three use restrictive Auth-user foreign keys.
This fail-closed policy is correct but has no application teardown workflow.

The preflight is not atomic with checkout creation. A checkout can insert a
retained row after all three counts return zero. The admin route then deletes
jobs, Auth deletion hits the new restrictive foreign key and fails, and the
still-active account is left without its jobs.

Checkout's current advisory lock is scoped to user plus plan and is not shared
with admin deletion. No server-enforced disabled/deletion-pending state exists.

### Depends On

Implement after Chunks 1-3 so deletion can participate in the final guarded
subscription and reconciliation-pending contracts. Implement after Chunk 8 to
avoid route-config conflicts and after Chunk 9 so self-action is canonical.

### Owner Decision And Completion Gate

Before implementing provider cleanup, record an explicit policy for:

- immediate versus period-end subscription cancellation;
- refund handling, if any;
- whether the Stripe Customer is retained, deleted, or anonymized;
- required local billing/audit retention after Auth-user deletion.

This repository is pre-production with no paid users, but those choices become
customer-impacting once paid rollout begins. Treat the work as two sequential
subchunks:

- **Subchunk 10A - containment:** lifecycle state, access disablement, billing,
  checkout, and job-create fences. This may land separately and materially
  reduces the race, but it does not resolve billed-account teardown.
- **Subchunk 10B - complete teardown:** provider cleanup, local cleanup,
  resumable API/UI behavior, Auth deletion, and retention handling. This must
  not begin until the owner policy above is recorded.

Chunk 10 and the scan finding remain open after 10A. Do not mark the chunk
complete or remove the paid-rollout blocker until 10B and its production-like
evidence are finished. If an agent is assigned the full chunk before the policy
exists, the correct action is to stop at the documented decision gate rather
than invent refund or retention behavior.

### Agent Boundary

This agent owns migration `029`, the account lifecycle service, admin deletion
orchestration, billing/checkout deletion fencing, central disabled-account
enforcement, and admin UI/API progress behavior. It must reuse the final billing
RPCs rather than fork them.

### Files To Inspect

- `migrations/005_billing_customers.sql`
- `migrations/006_billing_subscriptions.sql`
- `migrations/008_billing_subscriptions_customer_fk.sql`
- `migrations/013_billing_checkout_sessions.sql`
- `migrations/018_jobs_overflow_locking.sql`
- Migrations `026` through `028`
- `migrations/029_account_deletion_lifecycle.sql` (new)
- `src/pages/api/admin/users/[id].js`
- `src/pages/api/billing/checkout.js`
- `src/server/lib/billingService.js`
- `src/server/lib/billingCheckoutDrain.js`
- `src/server/services/jobService.js`
- `src/server/lib/supabaseServer.js`
- `src/server/middleware/withRateLimit.js`
- `src/server/lib/accountDeletionService.js` (new)
- `src/shared/errors.js`
- `src/client/hooks/useAdminUser.js`
- `src/client/hooks/useAdminUsers.js`
- `src/client/hooks/__tests__/useAdminUser.test.js` (new)
- `src/client/hooks/__tests__/useAdminUsers.test.js` (new)
- `src/server/api/__tests__/adminUsers.test.js`
- `src/server/db/__tests__/billingMigrations.integration.test.js`
- Billing checkout/service tests affected by deletion fencing

### What To Change

Add a service-role-only account deletion lifecycle record that survives long
enough to resume Auth deletion and contains no unnecessary personal data. A raw
user UUID is a pseudonymous personal identifier, not non-PII; retain it only
while operationally required and make completed-record deletion, nulling, or
approved keyed-hash retention an explicit owner decision. Track a bounded state
machine such as:

```text
requested
-> access_disabled
-> provider_cleanup
-> local_billing_cleanup
-> jobs_cleanup
-> auth_cleanup
-> completed
```

Persist retry count, safe error code, and timestamps so a repeated admin request
resumes the current phase instead of repeating external side effects.

Introduce one shared per-user account-lifecycle advisory lock/fence used by:

- deletion initiation and local cleanup;
- Checkout Session claim/finalization;
- billing customer placeholder creation;
- every ordinary subscription event/authoritative write;
- `create_job_with_storage_quota` and final jobs cleanup, coordinated with the
  existing `jobs_create_quota` lock.

Use one global nested-lock order everywhere:

```text
account_lifecycle -> billing_storage_transition -> jobs_create_quota
```

Checkout claim uses `account_lifecycle -> billing_storage_transition ->
user-plus-plan checkout claim`. A function that does not need a later lock may
stop earlier, but no path may acquire these locks in reverse order.

Once deletion is pending, block all ordinary billing upserts, including terminal
webhook/reconciliation writes. A terminal UPSERT can recreate a locally deleted
subscription and restore an Auth foreign-key blocker. Only a narrowly scoped
teardown operation may update an existing row without insert, expire Checkout
Sessions, cancel subscriptions, or delete local billing state.

### How To Implement

#### Phase A - Immediate Containment

1. Add migration `029` with the lifecycle table, check constraints, timestamps,
   forced RLS, no browser policies, and service-role-only access. Do not make the
   lifecycle row depend on an Auth FK that would delete or block active
   recovery. Document that its raw UUID remains pseudonymous personal data and
   apply the approved completion-retention policy later.
2. Add an idempotent begin-deletion RPC that acquires the shared per-user lock,
   creates/returns the lifecycle record, and fences new checkout/billing work.
3. Make Checkout claim acquire the same account lock and reject when deletion
   is pending.
4. Add a lifecycle generation/fence check to post-claim customer creation and
   Checkout finalization. If deletion begins during a provider call, do not
   return the new hosted URL; expire/compensate the Stripe Session and leave a
   recoverable local record.
5. Make every ordinary event and authoritative subscription RPC acquire the
   lifecycle lock and return `account_deletion_pending` without insert or update
   when deletion is pending, regardless of incoming status. Give teardown a
   separate update-existing-only/delete boundary; it must never UPSERT a missing
   row.
   This fence applies to both Chunk 1 authoritative purposes and must run before
   interpreting exact absence as permission to insert. Deletion generation
   changes also prevent retrying a previously captured absence snapshot.
6. Replace the current `create_job_with_storage_quota` definition from migration
   `018`. It must acquire `account_lifecycle` before calling
   `resolve_canonical_storage_status_for_user()` (which participates in
   `billing_storage_transition`), then acquire `jobs_create_quota`. Reject
   deletion-pending users and document the global order. Final deletion must use
   the same order before removing jobs; adding the lifecycle lock only after
   canonical status resolution would invert the order and can deadlock.
7. Disable server access before deleting jobs. Use a central app-enforced
   deletion state returned by authenticated user resolution, plus the validated
   Supabase account disable/ban/session-revocation mechanism. If disabling fails,
   stop before destructive work.

#### Phase B - Resumable Teardown

1. Do not trust local Checkout rows as a complete provider inventory. Page
   through relevant Stripe Checkout Sessions for the mapped customer and verify
   ownership, including open Sessions whose local claim is `failed` or has no
   persisted provider id after Stripe creation succeeded but finalization
   failed. Reconcile that inventory with local creating/open/pending rows.
2. Expire every owned live Stripe Checkout Session and record each confirmed
   provider outcome. A local row with no provider id may be failed only after
   authoritative provider enumeration proves no corresponding live Session
   exists; otherwise persist/recover and expire it.
3. Retrieve and cancel/resolve Stripe subscriptions according to the approved
   cancellation/refund policy. Use provider idempotency and safe retries.
4. Confirm no provider state can create a new entitlement before deleting local
   billing rows.
5. Delete local rows in dependency order under the account lock:
   `billing_checkout_sessions`, `billing_subscriptions`, then
   `billing_customers`.
6. Immediately before jobs cleanup, reacquire the lifecycle lock, recheck all
   three billing tables, and prove no late ordinary webhook/reconcile write
   recreated a blocker. If any row exists, return to provider/local cleanup.
7. Delete jobs only after provider and local billing cleanup are durable. Hold
   the lifecycle fence and coordinate with `jobs_create_quota` in the documented
   lock order so an already-authenticated create cannot insert after cleanup.
8. Delete the Auth user last. If that external call fails, the account remains
   disabled and the lifecycle stays resumable instead of active-with-jobs-gone.
9. Apply the approved completed-record retention policy after Auth deletion:
   delete/null the raw UUID or replace it only with an approved keyed subject
   hash and bounded retention. Do not label a durable raw UUID tombstone non-PII.
10. Use a request-driven durable execution model: each DELETE idempotently
    initiates or advances at most one bounded phase/provider page within the
    serverless request budget, persists the result, then returns. Do not launch
    fire-and-forget cleanup after sending a response.
11. Return 202 with a stable body such as
    `{ completed: false, deletion: { state, retryable, nextAction } }` while
    incomplete and 200 with `{ completed: true }` only after completion. A GET
    status read may poll progress; only an explicit idempotent DELETE/resume
    action advances work.
12. Update both admin hooks to inspect HTTP `meta.status` and the explicit
    `completed` flag. On 202, retain the user in list/detail state, show progress
    or a Resume action, and do not report success or redirect. Remove/redirect
    only after the 200 completed contract.

### Guardrails

- Do not "fix" the finding by removing restrictive billing foreign keys or
  changing them to cascade.
- Do not delete jobs while the target can still authenticate and use APIs.
- Do not hold a database transaction open across Stripe or Supabase network
  calls; use durable phase state, fences, and compensating actions.
- Do not let checkout finalization race past a newer deletion generation.
- Do not let an already-authenticated job create race past the lifecycle fence.
- Do not grant entitlement from a deletion cleanup request.
- Do not allow an ordinary terminal event UPSERT to recreate a missing
  subscription during deletion.
- Do not assume a missing local Checkout Session id proves no provider Session
  exists.
- Do not store email, raw Stripe objects, tokens, or provider errors in the
  lifecycle row.
- Preserve admin self-action, authorization, CSRF, and rate-limit checks.
- Keep every provider operation idempotent and retryable.
- Do not run provider cleanup in an unawaited promise after returning 202 from a
  serverless handler.
- Treat production paid-account behavior as blocked until the owner decision is
  recorded and exercised in staging.
- Do not mark Chunk 10 complete after containment-only Subchunk 10A.

### Tests

Add unit/service/route tests for:

- Deletion marks and enforces disabled state before jobs deletion.
- Failure to disable leaves jobs and billing state untouched.
- Existing billing blockers start/resume teardown instead of producing a
  permanent dead end.
- Repeated delete requests resume the same lifecycle phase.
- Provider cleanup failure leaves the account disabled and retryable.
- Local billing cleanup occurs in dependency order before jobs.
- Auth deletion failure after jobs leaves a disabled resumable account.
- Stripe Session creation success followed by local finalization failure is
  found by provider enumeration and expired before cleanup completes.
- A late canceled webhook after local billing deletion cannot reinsert a
  subscription or recreate an Auth FK blocker.
- Completed deletion returns success and applies the approved pseudonymous
  subject retention/deletion policy.
- A 202 response leaves the user in admin list/detail state and returns
  pending/resumable UI state; only completed 200 removes or redirects.
- Each request advances only its bounded durable phase; no test depends on
  fire-and-forget work continuing after response.

Add concurrency/integration tests for:

- Checkout claim wins the lock first: deletion observes/fences it and does not
  delete jobs prematurely.
- Deletion wins first: checkout/customer/subscription creation is rejected.
- Deletion begins during Stripe Session creation: finalization is fenced and
  the provider Session is expired/compensated.
- A webhook racing deletion cannot restore nonterminal entitlement.
- An authoritative Checkout absence snapshot captured before deletion cannot
  insert after the deletion lifecycle fence is established.
- Job create wins first: deletion observes it before final cleanup.
- Deletion wins first: `create_job_with_storage_quota` rejects and cannot
  recreate jobs after cleanup.
- Restrictive foreign keys remain present and no longer cause post-jobs partial
  deletion.

Suggested commands:

```powershell
node node_modules\jest\bin\jest.js --runTestsByPath src/server/api/__tests__/adminUsers.test.js src/server/lib/__tests__/billingService.test.js src/server/api/__tests__/billing/checkout.test.js src/server/lib/__tests__/billingCheckoutDrain.test.js src/server/services/__tests__/jobService.test.js src/client/hooks/__tests__/useAdminUser.test.js src/client/hooks/__tests__/useAdminUsers.test.js --runInBand --no-cache
node node_modules\jest\bin\jest.js --runTestsByPath src/server/db/__tests__/billingMigrations.integration.test.js --runInBand --no-cache
```

Run the destructive integration suite only against its explicitly approved test
project. Add account-access integration coverage after identifying the existing
Supabase Auth test harness.

### Initial Context For Implementer

Start with the order in `handleDelete()` and the documented teardown comments in
migration `005`. Then trace checkout from the database claim through customer
creation, provider Session creation, and local finalization. The central design
problem is fencing work across external calls without holding a database
transaction open.

## Cross-Chunk Verification Matrix

Use this checklist when each lane converges and again before production rollout.

| Area | Expected proof |
| --- | --- |
| Authoritative sync | Every authoritative caller supplies exact-existing id/version or exact-absent local state plus an allowed purpose; unguarded or unsafe-replacement SQL calls fail. |
| Stripe event ties | Same-subscription terminal state cannot be restored by a delayed equal-time nonterminal snapshot. |
| Checkout dedupe | `reconciliation_pending` blocks another Checkout until strict canonical reconciliation; the claim RPC also rechecks billing eligibility under the billing-transition lock before insert. |
| Receipt recovery | Unresolved billing conflicts remain retryable and are never terminally acknowledged as stale without proof. |
| Auth bucket isolation | Session, logout, callback, failed-auth, and CSRF-failure terminal policies are separate; protected traffic intentionally also consumes the generous shared PRE_AUTH IP overlay. |
| Atomic windows | Denied multi-window requests increment no window, including under concurrency. |
| Browser intent | Cross-site simple requests to intent-protected session/signout endpoints fail before their terminal quota and before logout mutation; other protected routes may intentionally consume PRE_AUTH first. |
| Pre-auth protection | Exhausted coarse IP quota prevents Supabase `getUser()` work. |
| Logout | Accepted local logout always expires auth/CSRF cookies; the client redirects only after that success. |
| OAuth callback | Invalid or page-throttled callbacks never call generic middleware Auth refresh or token exchange; deployment evidence proves edge/WAF throttling before origin invocation. |
| Body parsing | Every API route declares bounded JSON, bodyless disabled parsing, or approved bounded raw body. |
| Admin UUID | Lower-, upper-, and mixed-case self targets are blocked before side effects. |
| Account deletion | Full 10B is complete: access is disabled first; checkout and job creation are fenced; provider enumeration finds unpersisted Sessions; ordinary billing upserts cannot recreate rows; 202 retains admin UI state; cleanup precedes jobs/Auth deletion and resumes durably. |
| Pre-production scope | Paid rollout remains blocked until Stripe concurrency fixes, deletion policy, and production-like integration evidence exist. |

## Baseline Evidence From Verification

The read-only verification pass ran the existing focused billing and admin
suites without modifying files:

- Billing: 4 suites, 178 tests passed.
- Admin/request hardening: 5 suites, 73 tests passed.

These baseline passes show the current expected behavior is stable; several
tests intentionally encode the unsafe behavior and must be updated by the
owning chunk rather than preserved blindly.

## Bottom Line

The safest execution model is two sequential lanes plus two independent
hardening chunks. Build mandatory billing compare-and-swap before resolving
event ties or Checkout completion. Build one atomic, separated auth limiter
before moving checks earlier or adding callback/logout behavior. Land the
account deletion lifecycle last because it must coordinate the final billing
state machine and requires an explicit paid-account cancellation/retention
policy before production use.
