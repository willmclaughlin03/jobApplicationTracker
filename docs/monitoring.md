# Monitoring & Observability

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AXIOM_DATASET` | For production logging | Axiom dataset name to send logs to |
| `AXIOM_TOKEN` | For production logging | Axiom API token with ingest permission |
| `BILLING_LOG_HASH_SECRET` | For billing log hashing | HMAC secret used to hash user ids in billing logs without exposing a reusable plain digest |
| `LOG_FULL_BILLING_IDS` | Production-forbidden unless a dated exception is active | When `true` in live mode, only `error` and `debug` billing logs may emit full Stripe ids instead of redacted ids |
| `BILLING_CHECKOUT_DISABLED` | Emergency Checkout halt | When set to literal `true` after trimming and case normalization, new Checkout starts fail with `BILLING_CHECKOUT_DISABLED` |

Set these in **AWS Amplify Console → Environment Variables** for the Production (and optionally Preview) environments.

When both variables are present, the Pino logger ships structured JSON logs to Axiom via the `@axiomhq/pino` transport. When either is missing, logs go to JSON stdout (picked up by CloudWatch in Amplify SSR).

## Temporary Session Ceiling Operations

The CHUNK-1 application ceiling is pre-production protection for the combined
`GET /api/auth/session` and future `GET /api/auth/v2/session` traffic. It allows
400 requests per source IP in a rolling 60-second window on each server
instance. The separate future WAF Block ceiling remains provisionally 1,000 per
60 seconds/IP.

- Operational and rollback owner: Will
- Pre-production alert destination: `tracktheapp.support@gmail.com`
- Remote gate status: open until CloudFront header overwrite, origin isolation,
  WAF/application source agreement, and active enforcement are executed
- Production limitation: state resets on restart and effective allowance can
  reach `400 x active instance count`
- Version-overlap limitation: v1/v2 share a map only inside one process. If
  Amplify splits route bundles across compute processes, each process has its
  own allowance until combined edge enforcement replaces this control.

### Aggregate queries

Use count-only `temporary_session_ceiling_summary` events. Do not add IP,
cookie, token, session, digest, email, user, or raw configuration fields to a
query or derived event.

- **Traffic and rejection ratio:** filter
  `event == "temporary_session_ceiling_summary"`; sum `totalChecks`,
  `allowedChecks`, and `rejectedChecks`; calculate
  `rejectedChecks / totalChecks` over the alert window.
- **Source trust failures:** use the same event and sum
  `sourceResolutionFailures`. Any post-deployment increase requires checking
  the CloudFront origin request policy and direct-origin boundary.
- **Capacity pressure:** sum `stateCapacityFailures` and track the maximum
  `activeEntryCount`. Capacity failures mean 10,000 live address entries blocked
  a new source.
- **Internal failure:** sum `internalFailures`; any non-zero value requires
  investigation.
- **Version split:** sum `routeVersionTotals.v1`, `.v2`, and `.unknown`.
  `unknown > 0` indicates an integration error.
- **Sample context:** filter
  `event == "temporary_session_ceiling_rejection_sample"`. This stream is
  intentionally capped at one event per instance/reporting window and must not
  be used as an exact rejection count.

The aggregate for an active window is emitted when the next request arrives in
a later window. Because cleanup and logging use no timers, an instance that
stops before another request does not emit its final partial-window aggregate.
Use platform/API status metrics for the exact session failure ratio when
available; the sampled event is not a substitute.

### Alert thresholds

- Page when exact session-route failures are at least 1% for 10 minutes with at
  least 100 requests, or after 10 consecutive session failures.
- Roll back when exact session-route failures reach 5% for 5 minutes.
- Investigate legitimate temporary-ceiling rejection above 0.1% for 15
  minutes.
- Fail controlled testing on any legitimate `429` or `503`.
- Do not page or warn once per hostile request. Aggregate counts are the
  authoritative ceiling signal.

### Rollback order

Before the CHUNK-2 no-cookie bypass exists, restore the previous application
build. After the bypass exists, disable or roll back that bypass first, verify
the Redis-backed session path is active again, and only then remove, revert, or
retune the temporary ceiling. WAF Count mode does not satisfy the replacement
gate; the application ceiling remains until WAF Block evidence passes.

## Billing Alert Destinations

Before paid rollout, billing alerts must have two verified destinations:

- **High-urgency billing channel:** pager, SMS, or an actively watched Slack
  channel for release-blocking billing signals.
- **Support mailbox:** `tracktheapp.support@gmail.com` for lower-urgency
  follow-up, audit trails, and customer-support context.

Email alone is acceptable for pre-production drills, but it is not sufficient
for paid-user incidents involving receipt integrity, stuck processing, webhook
5xx bursts, or sustained webhook latency.

## Billing Incident Classes

- **SEV1:** overgranting entitlement, receipt envelope mismatch, wrong-mode
  live/test traffic accepted, or confirmed local/Stripe mapping corruption.
  Target response: acknowledge within 5 minutes and halt new Checkout starts.
- **SEV2:** webhook processing stuck, webhook 5xx bursts, missed supported
  events, rebuild/reconcile drift that can deny paid access, or portal config
  drift. Target response: acknowledge within 15 minutes.
- **SEV3:** unsupported status, unknown event type, customer email sync failure,
  non-current subscription safe-ignore, or downgrade policy follow-up. Target
  response: review within one business day unless counts spike during rollout.

## Axiom Setup

### 1. Create a Dataset

1. Go to [app.axiom.co](https://app.axiom.co) → **Datasets**
2. Click **New Dataset**, name it (e.g., `job-tracker-prod`)
3. Note the dataset name — this is your `AXIOM_DATASET` value

### 2. Generate an API Token

1. Go to **Settings → API Tokens**
2. Click **New Token**
3. Name it (e.g., `amplify-ingest`)
4. Grant **Ingest** permission scoped to your dataset
5. Copy the token — this is your `AXIOM_TOKEN` value

### 3. Verify Logs Are Flowing

1. Deploy with both env vars set
2. Hit any API endpoint (e.g., `GET /api/health`)
3. In Axiom, go to your dataset → **Stream** tab
4. You should see structured log entries with `level`, `msg`, `requestId` fields

## Health Endpoint

`GET /api/health` returns the status of Redis and Supabase dependencies.

**Response (200 — healthy):**
```json
{
  "status": "ok",
  "checks": { "redis": "ok", "supabase": "ok" },
  "timestamp": "2026-03-27T12:00:00.000Z"
}
```

**Response (503 — degraded):**
```json
{
  "status": "degraded",
  "checks": { "redis": "fail", "supabase": "ok" },
  "timestamp": "2026-03-27T12:00:00.000Z"
}
```

This endpoint is rate-limited at **60 requests/hour per IP** (`OPERATIONS.HEALTH`). This assumes uptime monitors poll every 60 seconds — more aggressive polling may receive `429 Too Many Requests`. When Redis is unavailable, the `withRateLimit` middleware returns a generic `503` before the health handler runs (different response body shape, same HTTP status).

## Axiom Alerts

### Error Rate Spike

1. Go to **Monitors → New Monitor**
2. **Query:** filter by `level == "error"`, count over 5-minute window
3. **Threshold:** alert when count > 10 (adjust based on baseline)
4. **Notify:** Slack channel or email

### Health Degradation

1. **Query:** filter by `msg == "Health check degraded"`, count over 5-minute window
2. **Threshold:** alert when count > 0
3. **Notify:** Slack channel or email

### Rate Limit Exhaustion

1. **Query:** filter by `msg` containing `"rate limit"` and `level == "warn"`, count over 5-minute window
2. **Threshold:** alert when count > 50 (adjust based on traffic)
3. **Notify:** Slack channel or email
4. **Note:** `/api/health` 429s are logged at `debug`, not `warn`, to avoid noisy ingest from aggressive uptime polling. This alert is for non-health rate-limit exhaustion.

### Billing Unsupported Status

1. **Query:** filter by `event == "billing_unsupported_status"`
2. **Threshold:** alert when count > 0 over 5 minutes
3. **Notify:** support mailbox; high-urgency billing channel during rollout
4. **Why:** this is a deliberate fail-closed path. The write is skipped, which can temporarily preserve stale entitlement until a later supported sync or manual intervention.

### Billing Livemode Mismatch

1. **Query:** filter by `event == "billing_livemode_mismatch"`
2. **Threshold:** alert when count > 0 over 5 minutes
3. **Notify:** high-urgency billing channel and support mailbox
4. **Why:** test/live Stripe traffic must stay separated. A mismatch is an operational integrity problem, not just a noisy warning.

### Billing Webhook Integrity And Safe-Ignores

1. **Query:** filter by `event` in `["billing_event_receipt_envelope_mismatch", "billing_unknown_event_type", "billing_customer_not_found_sync", "billing_customer_not_found_delete", "billing_non_current_subscription_event_ignored", "billing_webhook_processing_reclaimed", "billing_customer_email_sync_failed"]`
2. **Threshold:** alert when `billing_event_receipt_envelope_mismatch` count > 0 over 5 minutes; review other signals when count > 0 over 15 minutes during rollout
3. **Notify:** high-urgency billing channel for envelope mismatch and processing reclaimed during rollout; support mailbox for all listed signals
4. **Why:** these are handled or fail-closed webhook paths, but they point to Stripe delivery integrity issues, missing customer mappings, duplicate subscriptions, stuck processing recovery, or receipt-email drift.

### Billing Webhook Processing Stuck

1. **Query:** run a scheduled database check for `stripe_event_receipts` rows where `result = 'processing'` and `processed_at < now() - interval '5 minutes'`
2. **Threshold:** alert when count > 0; during rollout, inspect immediately rather than waiting for the reclaim path to hide the symptom
3. **Notify:** high-urgency billing channel and support mailbox
4. **Why:** a long-lived `processing` row means Stripe delivery may be stuck between verified ingress and terminal reconciliation. Treat this as `billing_webhook_processing_stuck` for rollout reporting.

### Billing Webhook Transport Health

1. **Query:** filter route or edge logs for `/api/billing/webhook` responses with status `413` or `5xx`; separately review Stripe Workbench Event Deliveries for failed or pending attempts
2. **Threshold:** alert on any `5xx` in 5 minutes during rollout, any burst of `413`, or any Stripe delivery that remains failed/pending after the expected retry window begins
3. **Notify:** high-urgency billing channel for `5xx` bursts; support mailbox for `413` review
4. **Why:** `413` bursts can mean payload-size abuse or an unexpectedly large Stripe payload shape, and `5xx` delivery failures can delay billing reconciliation and trigger Stripe retries.

### Billing Webhook Latency

1. **Query:** track `/api/billing/webhook` request duration by status and event type when available
2. **Threshold:** investigate p95 latency above 2 seconds during rollout; treat sustained latency approaching Stripe timeout behavior as a release blocker
3. **Notify:** high-urgency billing channel when sustained or paired with failed Stripe deliveries; support mailbox for rollout review
4. **Why:** the current webhook route performs synchronous reconciliation before returning `200`. This is acceptable at low volume only while response latency stays comfortably below provider timeout risk.

### Billing Checkout Terminalization Failures

1. **Query:** filter by `event == "billing_checkout_session_terminalize_failed"`
2. **Threshold:** alert when count > 0 over 5 minutes during rollout; after rollout, review any occurrence the same business day unless paired with Checkout retries or stuck pending rows
3. **Notify:** high-urgency billing channel during rollout or active incident; support mailbox for all occurrences
4. **Why:** completed or expired Checkout webhooks can release local pending Checkout rows. A terminalization failure does not grant entitlement, but it can leave a user blocked from a clean retry.

### Billing Checkout Emergency Drain Failures

1. **Query:** filter by `event == "billing_checkout_session_drain_failed"` and review `billing_checkout_session_drain_command_completed` command output from the operator run
2. **Threshold:** alert when `failed > 0` in command output or when any drain failure log appears during an emergency halt
3. **Notify:** high-urgency billing channel and support mailbox while Checkout is halted
4. **Why:** provider failures or unconfirmed expirations intentionally leave local rows open. Operators must retry or investigate these rows instead of assuming all already-minted Checkout URLs are dead.

### Billing Payment Action Required

1. **Query:** filter by `event == "billing_invoice_payment_action_required"`
2. **Threshold:** alert when count > 0 during rollout; after rollout, route to the documented recovery owner unless counts spike
3. **Notify:** support mailbox and high-urgency billing channel during rollout
4. **Why:** these invoices require customer action or Stripe-managed recovery. The webhook refreshes local subscription state and logs the recovery signal, but it does not directly grant entitlement from the invoice payload.

### Billing Signature Failures And Clock Skew

1. **Query:** filter webhook responses for `WEBHOOK_SIGNATURE_INVALID` and logs where `errorCode == "WEBHOOK_SIGNATURE_INVALID"` or `errorName == "StripeSignatureVerificationError"`
2. **Threshold:** alert on sustained bursts over 5 minutes, or any sudden spike after deploy, endpoint-secret rotation, or infrastructure change
3. **Notify:** high-urgency billing channel during cutover; support mailbox after triage
4. **Why:** bursts can indicate the wrong endpoint secret, replay attempts, raw-body mutation, endpoint drift, or host clock skew against Stripe's signature timestamp tolerance.

### Billing Full ID Logging

1. **Query:** detect production env/config where `LOG_FULL_BILLING_IDS` is truthy (`1`, `true`, `yes`, or `on`), or add a deploy-time config check that emits a monitorable event
2. **Threshold:** alert when truthy in live mode unless a dated exception is active
3. **Notify:** high-urgency billing channel and support mailbox
4. **Why:** full Stripe ids in live logs are useful only during tightly scoped incident windows and should not remain enabled accidentally.

### Billing Checkout Disabled Deploy Gate

1. **Query:** detect deploy/runtime config where `BILLING_CHECKOUT_DISABLED` is exactly `true` after trimming and case normalization, or emit a deploy-time monitorable event for the flag value
2. **Threshold:** alert when true outside an active emergency halt, staged drill, or documented dark-launch window
3. **Notify:** high-urgency billing channel during rollout; support mailbox for the rollout artifact
4. **Why:** the flag is the intended new-Checkout halt. It should be obvious when public Checkout is intentionally closed, and operators must not assume values such as `1`, `yes`, or `on` activate the halt.

### Billing Drift Reconciliation

1. **Query:** scheduled Stripe-to-local reconciliation output for missing local rows, duplicate current subscriptions, unsupported statuses, local/Stripe customer mismatches, stale entitlement mismatches, or paid users downgraded by local read failures
2. **Threshold:** alert when any drift is found during rollout; after rollout, route low-risk known-safe drift to daily review and entitlement-affecting drift to the high-urgency billing channel
3. **Notify:** high-urgency billing channel for entitlement-affecting drift; support mailbox for the full report
4. **Why:** webhook retries and receipt dedupe reduce drift risk, but a scheduled Stripe-backed audit is the safety net for missed events, manual Dashboard edits, or local database restoration.

## Uptime Monitoring

Configure an external uptime monitor to poll the health endpoint:

- **URL:** `https://your-domain.amplifyapp.com/api/health`
- **Method:** `GET`
- **Interval:** 60 seconds (must not exceed 60 req/hour to avoid 429)
- **Alert on:** HTTP status ≠ 200 or no response within 10 seconds
- **Note:** 429 responses indicate the monitor is polling too aggressively

Options for uptime monitoring:
- **Axiom Monitors** — built-in, no extra service needed
- **Better Uptime** — free tier available
- **UptimeRobot** — free tier with 5-minute intervals

## Local Development

Without `AXIOM_DATASET` and `AXIOM_TOKEN` set, logs are pretty-printed to the terminal via `pino-pretty` with colors and timestamps. No Axiom calls are made locally.
