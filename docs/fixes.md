# Fixes

Use this file to briefly record fixes after every `git push`.

## What to record
- Briefly describe the issue that was addressed.
- Note the approach taken to fix it.
- Summarize how the fix was implemented.
- Add the date so the fix history stays readable.

## Entry Template
- `YYYY-MM-DD` - `Issue name`: issue summary. Approach: short note on the strategy used. Fix: short note on how it was resolved.

## Entries
- `2026-04-30` - `Fix log created`: Established the shared post-push fix log. Approach: created a lightweight markdown tracker. Fix: added a standard place to record issues, approaches, and resolutions after each push.
- `2026-04-30` - `Billing hardening narrowed follow-up`: Stripe customer creation could deadlock on retries when the idempotent create payload changed with email input, and delete-event billing writes could overwrite newer local state by merging stale fields. Approach: keep the Stripe customer create call byte-stable, move email sync into a separate best-effort update, and treat delete snapshots as event-derived writes guarded by small future-timestamp validation. Fix: `billingService.js` now creates customers with a stable empty payload and syncs email separately, delete events no longer merge local subscription fields into the RPC payload, future event timestamps beyond five minutes are rejected, stale outcomes use the write enum consistently, and the billing unit suite covers the new behavior.
