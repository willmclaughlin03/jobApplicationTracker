# Stripe Phase 2 Handoff

## Scope

Phase 2 covers the database layer only:

- `billing_customers`
- `billing_subscriptions`
- `stripe_event_receipts`

Repository baseline note:

- the Phase 2 billing SQL lives in the repo-root tracked `migrations/` folder
- this repo currently includes the billing migrations `005` through `011`
- this covers `005` through `011`, not a full replayable project migration chain
- earlier migrations `001` through `004` were applied outside repo history, so repo-only fresh-schema replay remains unavailable

No API routes, Stripe SDK client code, webhook handling, or entitlement logic were added in this phase.

## What Landed

### Billing Schema

- Added `billing_customers` keyed by `user_id`
- Added `billing_subscriptions` keyed by `user_id`
- Added `stripe_event_receipts` for webhook dedupe / receipt tracking

### Constraints and Timestamps

- `billing_customers.stripe_customer_id` remains nullable to support placeholder rows
- non-null `stripe_customer_id` values are unique
- `billing_subscriptions.status` is constrained to the approved Stripe-facing status set
- Stripe id format checks exist on customer, subscription, and event ids
- `stripe_event_receipts.result` is allowlisted
- `stripe_event_receipts.event_type` is capped at `255`
- `billing_customers.updated_at` and `billing_subscriptions.updated_at` are maintained by a trigger
- `billing_subscriptions.status_changed_at` is database-managed by the additive `009` trigger
- subscription rows now depend on a pre-existing `billing_customers.user_id` row via the additive `008` foreign key

### RLS and ACL Hardening

- all three billing tables use `ENABLE ROW LEVEL SECURITY`
- all three billing tables use `FORCE ROW LEVEL SECURITY`
- `billing_customers` and `billing_subscriptions` allow authenticated users to `SELECT` only their own rows
- authenticated users cannot `INSERT`, `UPDATE`, or `DELETE` billing rows
- `stripe_event_receipts` has no user-facing policies and is service-only from normal clients
- explicit `REVOKE` / `GRANT` statements are part of the table setup

### Trigger Hardening

- `public.touch_billing_updated_at()` is billing-scoped
- the function pins `search_path` to `pg_catalog, public`
- the function uses `SECURITY INVOKER`

## Additive Billing Hardening Follow-up

An additive follow-up migration, `011_billing_concurrency_guards.sql`, now
extends the billing schema with service-role-only RPCs:

- `upsert_billing_subscription_if_newer_or_equal(payload jsonb)`
- `upsert_billing_subscription_authoritative(payload jsonb)`
- `merge_stripe_event_receipt(...)`

Why these RPCs exist:

- stale-event protection and receipt merging are race-sensitive write paths
- moving those decisions into Postgres removes the JS read-check-write window
- the RPCs return explicit JSON outcomes plus the final/current row so JS does
  not need race-sensitive follow-up `SELECT`s

Current service-layer conventions built around those RPCs:

- request-scoped billing reads require an explicit Supabase client
- intentional RLS bypasses go through explicitly named `*Privileged` wrappers
- `trialing` remains forbidden everywhere and must not be reintroduced to local
  constants, DB status checks, or checkout configuration
- unsupported Stripe statuses intentionally log and skip the write as
  `unsupported_status_ignored`

Operational rollout note:

- rollback is the JS/application deploy only; migration `011` is additive and
  may remain in place when no app code calls the functions
- deploy ordering must ensure migration `011` exists before any app code that
  calls the billing RPCs becomes live

## Key Decisions

### `stripe_event_receipts` stays in `public`

This table remains in `public`, but it is locked down with ACLs and no client-facing policies.

Reasoning:

- simpler Phase 3 implementation path with Supabase service-role access
- acceptable surface area because normal clients cannot read or write it
- stronger isolation through a private schema was considered, but deferred to avoid unnecessary access-path complexity in the next phase

### `user_id` is the primary key on `billing_subscriptions`

This schema encodes "at most one subscription row per user" as a hard
database invariant.

Reasoning:

- current product model is a single premium tier with one active
  subscription per user
- makes upsert-by-`user_id` the natural webhook path
- avoids the complexity of resolving "which subscription is current"
  at entitlement-check time

Implications and future-revisit triggers:

- Stripe itself allows multiple concurrent subscriptions per customer;
  this schema does not
- plan-switch races (cancellation of an old subscription and creation
  of a new one arriving out of order) will clobber on `user_id` —
  Phase 3 webhook handlers must guard on `last_stripe_event_created`
  before writing
- if the product later introduces add-ons, seat-based billing, or
  multiple concurrently active plans per user, this PK must be widened
  to `(user_id, stripe_subscription_id)` or moved to
  `stripe_subscription_id` with a lookup index on `user_id`

### `billing_subscriptions` depends on `billing_customers`

Migration `008_billing_subscriptions_customer_fk.sql` adds a foreign key from
`billing_subscriptions.user_id` to `billing_customers.user_id`.

Reasoning:

- keeps user ownership anchored to the local customer mapping table
- prevents orphaned subscription rows that cannot be reconciled back to a known local customer
- makes customer-first creation order an explicit schema invariant rather than a webhook-side convention only

Operational implication:

- service code must ensure a `billing_customers` row exists before inserting or upserting `billing_subscriptions`

### `event_type` cap is `255`

The `255` cap is an operational sanity guardrail, not a primary security boundary.

Reasoning:

- current Stripe event names are far shorter than `255`
- the event catalog evolves over time
- `255` gives headroom while still catching accidental misuse such as writing the wrong data into the column

If Stripe later introduces longer valid event names, widen the constraint rather than treating that as suspicious by default.

### `ON DELETE RESTRICT`

Both billing tables reference `auth.users(id)` with `ON DELETE RESTRICT`.

Reasoning:

- prevents silent deletion of local billing state
- forces deliberate service-side teardown before auth-user deletion
- preserves a stronger operational boundary than `CASCADE`

Required teardown order before deleting an auth user:

1. delete related `billing_subscriptions`
2. delete related `billing_customers`
3. delete the auth user
4. ensure Stripe-side cleanup/archive is handled by service code

## Test Coverage Added

The billing integration suite now verifies:

- local/session migration files `005` through `010` exist in the repo-root `migrations/` folder
- placeholder customer rows with `NULL stripe_customer_id` are accepted
- duplicate non-null customer ids are rejected
- allowed subscription statuses are accepted
- invalid statuses are rejected
- malformed Stripe ids are rejected
- `updated_at` increases on both billing tables
- `status_changed_at` remains stable on non-status updates
- authenticated users can read only their own billing rows
- authenticated users cannot write billing rows
- authenticated users cannot `SELECT`, `INSERT`, `UPDATE`, or `DELETE` `stripe_event_receipts`
- anon clients cannot access billing tables and cannot write `stripe_event_receipts`
- all three tables have `FORCE ROW LEVEL SECURITY`
- `stripe_event_receipts` has no user-facing policies
- the billing trigger function has the expected pinned `search_path`
- the `stripe_event_receipts(processed_at)` index exists
- customer-first insert / teardown ordering is enforced by the `008` foreign key
- `ON DELETE RESTRICT` is enforced
- service-role DML works on the intended billing-table operations
- installed schema shape matches the expected Phase 2 objects

## Validation Result

This section records the original Phase 2 schema-only validation baseline. The
current billing hardening follow-up adds additional RPC integration coverage on
top of that baseline.

Command run:

```powershell
npm test -- --runInBand src/server/db/__tests__/billingMigrations.integration.test.js
```

Final result:

- `1` suite passed
- `26` tests passed
- `0` failed

This validates the live integration database behavior for the local/session
billing migrations, not a full fresh-schema replay from repo state.

## Temporary Test Helper Note

During validation, the integration environment required a temporary `public.exec_sql(text)` RPC so the migration/RLS suites could run catalog queries and replay SQL.

If it is no longer needed, remove it with:

```sql
drop function if exists public.exec_sql(text);
notify pgrst, 'reload schema';
```

This helper should remain test-only infrastructure and should not live in production.

## Known Boundary Of Phase 2

Phase 2 does not prove:

- webhook signature verification
- Stripe event processing logic
- subscription reconciliation logic
- entitlement resolution
- route-level authorization around billing actions
- full project migration replay from repo state (`001` through `011`)

Those belong to later phases.

## Phase 3 Starting Point

In environments where local/session migrations `005` through `011` have already
been applied, Phase 3 can assume:

- billing tables exist and are hardened
- service code can safely treat the database as the local billing state store
- placeholder customer creation flow is supported
- webhook receipt storage has a service-only landing table
- `last_stripe_event_created` and `stripe_event_created` are available for ordering / stale-event guards

Phase 3 should not assume a repo-only fresh-schema replay path exists yet.

Phase 3 should focus on:

- Stripe customer creation / lookup flow
- webhook signature verification
- idempotent webhook handlers
- subscription upsert logic
- stale-event protection using stored timestamps
- app-facing entitlement resolution based on local billing state
