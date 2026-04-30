# Feature Memory

Use this file as a quick-running log of implemented changes.

## What to record
- Briefly note the feature, enhancement, or addition that was completed.
- Keep entries short and easy to scan.
- Add the date so the history is easy to follow.

## Entry Template
- `YYYY-MM-DD` - `Feature or change name`: short note on what was added or updated.

## Entries
- `2026-04-30` - `Mapped-customer upsert race email sync`: Added the missing best-effort Stripe email sync on the post-upsert mapped-customer return path and covered it with a focused regression test.
- `2026-04-30` - `Stripe email sync helper docs`: Added repo-style JSDoc for the Stripe customer email sync helper, including flow context, side effects, parameter types, and return behavior.
- `2026-04-30` - `Stripe warning log sanitization`: Replaced the raw provider error object in the Stripe customer email-sync warning with a safe `{ name, code, message }` shape and tightened the related Jest coverage.
- `2026-04-30` - `Feature memory log created`: Added the shared quick-reference file for briefly tracking completed features and changes.
- `2026-04-30` - `Billing hardening scope narrowed`: Logged the targeted follow-up for stable Stripe customer creation, delete-event race removal, future-timestamp validation, and small billing cleanup work before branch edits.
- `2026-04-30` - `Billing hardening follow-up implemented`: Reworked Stripe customer creation to keep the idempotent `customers.create` body stable and move email sync into a separate best-effort `customers.update`, removed delete-event fallback merging so canceled snapshots come from the Stripe event itself, added a 5-minute future-timestamp guard across event-driven billing entry points, normalized stale write outcomes onto `BILLING_WRITE_OUTCOMES.STALE_IGNORED`, and added focused Jest coverage for email-sync retries, partial delete events, future timestamp rejection, and duplicate-log suppression.
