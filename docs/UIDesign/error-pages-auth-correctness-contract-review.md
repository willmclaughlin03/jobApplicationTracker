# Error Pages and Authentication Correctness Contract Review

## Status

- Review date: 2026-08-17
- Branch: `agent/gate0-close-hosted-evidence`
- Base: `origin/staging` at `f9b246ba69a44cfeb026ecc7e092fae0cbb17d9b`
- Scope: freeze the approved sanitized hosted evidence, cookie cap, fixture-integrity tests, and PR
  documentation without changing production behavior
- Merge state: draft and unmerged
- Gate state: `GATE-0` evidence and owner approval are complete; repository closure takes effect
  when this record is reviewed and merged

This completion record retains the green contract material from the reviewed successor and freezes
only sanitized evidence captured from the approved pre-production target. It changes no production
behavior and contains no intentionally failing tests.

## Approved public contract

The repository owner approved the following terminal `user_banned` presentation in the Phase 3
implementation authorization:

- HTTP `403`
- v2 state `terminal_unauthenticated`
- error code `ACCOUNT_ACCESS_RESTRICTED`
- title `Account access unavailable`
- copy: “This account can’t access Track The App. Contact support if you think this is a mistake.”
- only the existing public support-mailbox action
- no ordinary sign-in controls

This approval now has matching sanitized deployed `user_banned` tuple evidence. Production mapping
remains future implementation work and must use the exact operation/class/code/status tuple below.

## Frozen schema decisions

The strict fixture module freezes literal version `2` responses and rejects extra or mistyped
fields.

### Session

- authenticated: HTTP `200`, `status: authenticated`, and only safe `id`, nullable `email`,
  and normalized `role`
- anonymous: HTTP `200`, `status: anonymous`
- unavailable: HTTP `429` or `503` with the matching bounded code and required headers
- terminal account restriction: the approved HTTP `403` contract above
- rejected method: HTTP `405` with `Allow: GET`

### Sign-out

- complete: HTTP `200`, local cleanup issued, and a typed remote result of `confirmed`,
  `already_invalid`, or `not_needed`
- local-only: HTTP `200`, local cleanup issued, and typed remote result `unconfirmed`
- rejected/unavailable: exact HTTP `400`, `403`, or `405`
  response pairs with matching headers and codes
- legacy success/error envelopes and status/body mismatches are rejected

## State, identity, and request policy

- Seven mutually exclusive client states are frozen: `loading`, `authenticated`, `anonymous`,
  `unavailable`, `signed_out_local`, `logout_unconfirmed`, and
  `terminal_unauthenticated`.
- Old-subject state is disposed before an authenticated subject change, role demotion, confirmed
  anonymity, or terminal restriction can expose a new state.
- Drafts are bounded, keyed to the owning subject/work epoch, quarantined across uncertainty, and
  never replayed automatically.
- Role normalization accepts only exact `user` and `admin`; it performs no trimming or case
  folding.
- Logout requires `POST`, exact `X-Logout-Intent: 1`, an empty body or exact empty JSON object,
  and at least one valid same-origin browser-source proof. Every present source proof must agree.
- Rejected logout requests perform no Supabase, Redis, auth-cookie, or CSRF mutation.

## Cookie namespace and evidence boundary

- Exact pre-production storage key: `sb-apxfjggdcybjticrnbpk-auth-token`
- Installed SSR encoded chunk size: `3,180` characters
- Approved `GOOGLE_SESSION_FIXTURE_V1`: six initial-login chunks and five refreshed-session chunks
- `MAX_AUTH_COOKIE_CHUNKS`: exact positive integer `6`, with implementation owned by `CHUNK-2`

GitHub Actions run
[`31981135663`](https://github.com/willmclaughlin03/jobApplicationTracker/actions/runs/31981135663)
reproduced the approved largest application-supported Google session through the installed
`@supabase/ssr` `0.8.0` serializer and `createChunks()` implementation at staging commit
`f9b246ba69a44cfeb026ecc7e092fae0cbb17d9b`. The committed fixture is an application bound, not a
universal maximum Supabase can issue. No raw cookie, session, token, claim, provider response,
contact data, transient identifier, or environment value enters this record.

Any expansion of metadata, identity count, OAuth providers or scopes, token formats, cookie
configuration, or Supabase dependencies reopens this evidence decision. Enforcing the fixture's
metadata limits on every issued production session, or replacing full sessions with a compact
representation, remains a separate scope expansion.

## Supabase evidence

Sanitized installed-source evidence continues to support this ordinary-anonymous tuple:

| Endpoint scope | Exported class | Code | Status | Disposition |
| --- | --- | --- | --- | --- |
| v2 session lookup | `AuthSessionMissingError` | absent | `400` | `anonymous` |

The same hosted run captured these exact endpoint-scoped tuples:

| Operation | Exported class | Code | Status | Disposition |
| --- | --- | --- | --- | --- |
| `getUser` | `AuthApiError` | `bad_jwt` | `403` | `anonymous` |
| `getUser` | `AuthApiError` | `user_not_found` | `403` | `anonymous` |
| `implicit_refresh` | `AuthApiError` | `user_banned` | `400` | `terminal_unauthenticated` |

`session_expired`, remote `session_not_found`, `refresh_token_not_found`, and
`refresh_token_already_used` did not produce their named code at the installed application SDK
boundary. They remain unavailable and cannot be treated as anonymous. Documentation, messages,
status alone, or a tuple observed on another Supabase operation cannot activate a classifier.

Installed-source records also freeze:

- `@supabase/auth-js` `2.90.1`
- `@supabase/supabase-js` `2.90.1`
- `@supabase/ssr` `0.8.0`
- hosted Auth server `v2.195.0`
- sign-out default scope `global`
- SDK-suppressed sign-out statuses `401`, `403`, and `404`
- SSR chunking via `encodeURIComponent` at `3,180` encoded characters

The dependency versions are both installed-source and deployed-capture provenance. The sign-out and
chunker behavior remain installed-source observations.

## Route, cache, and renderer contracts

- Public, protected, unmatched, and raw-rejected route sets are disjoint.
- The two public-route fixture sources are required to remain equal so they cannot diverge
  silently.
- Every inventoried auth consumer has one seven-state policy row and one reset strategy.
- Every inventoried auth-capable response path has an owner, outcome set, dependencies, and
  `private, no-store` target behavior.
- CHUNK-6 owns production route discovery, middleware/provider bypass, and shared cache behavior.
- CHUNK-7 owns complete retry removal: no retry prop, callback, button, label, or automatic retry
  remains, while the public title must render as one child.

## GATE-0 closure

The two prior blockers are resolved by the owner-approved hosted record:

1. The endpoint-scoped deployed allowlist contains only the three exact observed tuples, including
   terminal `user_banned`; every unsupported candidate stays unavailable.
2. `MAX_AUTH_COOKIE_CHUNKS` is frozen at `6` from the committed largest-session fixture and installed
   chunker.

The successful workflow run, repository-owner approval, and this sanitized completion record close
`GATE-0` when merged. Future implementation must not broaden either evidence set without reopening
the decision.

## Validation

- hosted evidence workflow: passing on run `31981135663`
- focused Gate-0 suites: 58/58 passing
- changed-file ESLint: passing with zero warnings
- `git diff --check`: passing
