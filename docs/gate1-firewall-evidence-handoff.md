# GATE-1 Firewall evidence handoff — 2026-09-24

Continue the Vercel evidence investigation without additional charges. The next
step is an operator-approved **read-only configuration check**, not another full
Log trial. GATE-1, independent WAF/application source agreement, request
correlation, and completeness remain open.

## Workspace and authorization

- Repository: `willmclaughlin03/jobApplicationTracker`.
- PR branch: `chore/gate1-firewall-evidence`, targeting `staging` under the repository PR template.
- Existing worktree: `C:\Users\willm\job-application-tracker\.tmp\worktrees\gate1-provider-access`.
- Main checkout: `C:\Users\willm\job-application-tracker`; it contains substantial unrelated dirty work. Preserve it.
- User approved the local implementations and subsequently requested this new PR. The new configuration-check mode has **not** been approved/executed live.
- The earlier full-trial `RUN LOG RECEIPT ONCE` approval was consumed by the stopped run below. Do not reuse it or rerun automatically.
- Read `AGENTS.md`. Do not read `.env`, saved authentication files, or environment values. Tokens belong only in the operator's hidden PowerShell prompt and the child's transient stdin.
- Do not authorize paid Support, Observability Plus, drains, upgrades, deployment, load, role changes, Redis/HMAC changes, or new WAF actions from this handoff.

## Problem and established evidence

The target is project `prj_b2nMrysMSJtpmqoeGx5g0WGgGuom`, team
`team_7o3efmwjZbMc2Bfy9qAzkc9q`, hostname
`job-application-tracker-kappa-seven.vercel.app`, and route `GET /api/auth/session`.

1. Repeated metrics `POST /metrics/v1` calls returned HTTP 403, including a minimal
   action-only control. The user reported that Vercel Support checked the actual
   team/request and attributed that denial to missing Observability Plus. Further
   support requires premium access. The user requires **no additional charges**.
   This is a user-reported diagnosis of those metrics failures, not a rule for
   classifying future errors.
2. Dashboard access offered aggregates and read-only query/filter controls, not
   usable individual receipts. Do not repeat the dashboard filter/menu route.
   Audited CLI 59.20.0 traffic/overview commands use `/metrics/v1` and its shared
   client can retry or make extra calls; the stock CLI is unsuitable for this
   bounded alternative. Do not extract CLI credentials or run new CLI queries.
3. A separately approved Events access run succeeded on September 24 at
   `18:41:32Z`: HTTP 200, compatible JSON, empty actions, one provider GET, zero
   application requests. It proves scoped endpoint access only, not Log-action
   coverage, write permission, source agreement, completeness, or absence of
   security activity generally.
4. The operator then approved and ran the ordinary Log trial. It stopped at its
   **first configuration GET**, before any mutation, application request, or
   Events lookup. HTTP 200 was received, but the reader reported
   `provider_schema`. Cleanup was `not_needed`, not an unresolved rollback.
   The raw response was deliberately discarded; the failing field is unknown.
5. A new isolated configuration-check mode and sanitized baseline diagnostics
   were implemented and mocked locally. No live result from this new mode exists.

Local evidence is retained under the worktree's ignored `.tmp` directory, not in this PR:

| Evidence | Local filename | SHA-256 |
| --- | --- | --- |
| Events access, 18:41:32Z | `gate1-provider-access-1790275292588-b7fed65fefa75f66.json` | `37DC35E102093BC6F3B8A0C570C0773562D871646D098D135DA4D24DF9FDDDC0` |
| Stopped receipt trial, 20:34:00Z | `gate1-log-receipt-b58bb709360a9311f1a26f3a795d06c99c63fb454cdc9b4ed3a3fc65ba455740.json` | `49DCFD8564402673D8D9AB971697771A03A66459D30A0FE6D5E390ACFD23F57A` |

The stopped trial used approval
`b58bb709360a9311f1a26f3a795d06c99c63fb454cdc9b4ed3a3fc65ba455740`
and trial ID `d127f2df46d0d54939fe6572ee65bcc5`. It retained no rule ID.
Its counts were one provider request and zero application requests, Events
queries, or cleanup requests; elapsed time was 420.087 ms.

## Implemented files and safeguards

- `scripts/gate1-provider-access.js`, `scripts/run-gate1-provider-access.ps1`,
  `src/testSupport/__tests__/gate1ProviderAccess.test.js`: metrics controls and
  Events access mode, one provider request, zero application requests, sanitized
  error/schema facts, no retries, and code/profile-bound approval.
- `scripts/gate1-log-receipt.js`, `scripts/run-gate1-log-receipt.ps1`,
  `src/testSupport/__tests__/gate1LogReceipt.test.js`: ordinary Log lifecycle and
  separately isolated `config_check` mode. Both exported sequencers reject the
  other mode's profile independently of CLI routing.
- `docs/feature-memory.md` and `docs/fixes.md`: entries for this PR push only.
- This document tracks the scoped plan amendment and handoff without importing
  the unrelated, untracked full qualification plan into the PR.

The config check performs exactly one allowed operation:

```text
GET https://api.vercel.com/v1/security/firewall/config
    ?projectId=prj_b2nMrysMSJtpmqoeGx5g0WGgGuom
    &teamId=team_7o3efmwjZbMc2Bfy9qAzkc9q
```

Limits: zero application requests, one provider request, zero Events queries,
zero configuration mutations, concurrency one, 10-second request and 15-second
overall limits, 262144 response bytes, 16384 header/input bytes, 8192 report bytes,
and a 15-minute profile age limit. No redirects, retries, pagination, or automatic
transition into the full trial. Profiles require source-code review, credential-
logging review, and included-usage headroom attestations.

Use `--config-template` / PowerShell `-ConfigTemplate` for a fresh config profile.
`--config-prepare` / `-ConfigCheck` are offline preparation modes. `--review` /
`-ProfilePath` review either profile; `--live` / `-Live -Approval` select the strictly
validated profile mode. The config confirmation is **`RUN CONFIG CHECK ONCE`**.
The default `--template` / `-Template` still describe the full Log trial.

The unchanged full trial allows one anonymous application attempt and at most
eleven provider attempts: six for baseline/stage/readback/activate/readback/Events,
with five reserved for cleanup. It creates one ordinary Log rule matching host,
GET, raw path, and a fresh unpredictable user-agent marker. It verifies activation,
sends the single probe, waits 30 seconds, performs one Events lookup, and removes
only verified owned state. Provider `eq` is case-insensitive. The delay is not a
delivery guarantee. Empty or ambiguous summaries remain inconclusive.

Cleanup requires full policy comparisons, preserved unrelated rule order, and
no preexisting/foreign draft. No documented conditional-version guard was found;
a brief owner-held freeze on concurrent WAF edits is required for a future full
trial. Unacknowledged writes remain uncertain until their expected effect is
observed. An unchanged read cannot prove a timed-out write will not commit later.
Cleanup has an independent cancellation/deadline reserve and can remain
`cleanup_unresolved`. Restoration means baseline active policy and no draft;
provider history may retain the temporary rule. Hard termination can prevent
cleanup. Approvals are reserved exclusively before live dispatch; atomic,
sanitized recovery checkpoints remain local.

## Next agent: execute the smallest useful next step

1. Check the PR/branch state and read this handoff plus the local plan sections
   below. Preserve reports and unrelated edits. Review the actual current scripts;
   approval hashes bind their bytes, so prepare a fresh profile after code changes.
2. Give the operator a copy-paste PowerShell block using **config-check mode**.
   Set `NODE_PATH` to main-checkout `node_modules` when needed. Keep attestations
   false until the actual conditions have been confirmed. Show the offline review,
   stop on preparation errors, and invoke the launcher only once.
3. The displayed, exact `RUN CONFIG CHECK ONCE` prompt can serve as the separate
   operator live approval. It must clearly authorize only one configuration GET,
   zero application requests, and zero WAF changes. Enter the token only in the
   hidden prompt; never ask for it in chat. No WAF edit freeze is needed for this
   read-only check.
4. Ask for the sanitized JSON report. Do not ask for raw configuration, provider
   payloads, screenshots containing source identities, tokens, or raw errors.
5. Use the diagnostic facts to identify the actual reader rejection. Do not
   broadly loosen the mutation schema or copy the SDK's permissive defaulting.
   Validate any necessary compatibility change against official contract and
   observed facts, with focused tests and appropriate edit approval.
6. Only after resolving the reader contract should another full Log trial be
   proposed and separately approved. A config response does not approve writes.

## What the next response must show

Inspect these facts in the operator's **new live config-check report**:

| Field | Required interpretation |
| --- | --- |
| `scope`, `queryMode` | `provider_firewall_config_check_only`, `config_check` |
| Counts | `appRequests: 0`, `providerRequests: 1` if dispatched, `eventsQueries: 0`, `configMutations: 0` |
| `receipts` | At most one `configCheck` receipt; inspect its HTTP status |
| `configurationCheck.jsonContentType`, `jsonValid` | Distinguish content-type and JSON parsing failures |
| `validationStage` | `http_status`, `content_type`, `json`, `envelope`, `active_config`, `draft_config`, `duplicate_rule_ids`, or `compatible` |
| `rootType`, `envelope` | Fixed type/presence facts for active/draft/versions; `unexpectedFields` is a boolean, never raw unknown names |
| `active.fields`, `draft.fields` | Fixed field `type` and `valid` flags for id/version/updatedAt/ownerId/projectKey/firewallEnabled/changes/ips/rules |
| `active.rules`, `draft.rules` | Aggregate field-validity and unique-ID flags; no rule values or indices |
| `basis` | `current_trial_reader_contract`: validity means this reader's requirements, not a provider diagnosis |
| Gate/source fields | Gate open, source agreement not evaluated, correlation/completeness unqualified |

If a transport/approval failure occurs before body review, `configurationCheck`
may be null; diagnose that boundary without assuming a schema cause. A compatible
HTTP 200 config check still does not prove ordinary Log coverage or write access.

The earlier generic `provider_schema` could cover media type, JSON, root shape,
field types/equalities, or duplicate rule IDs. Public SDK differences are leads,
not diagnoses: it allows nullable active configs and permissive primitive parsing;
ownerId/projectKey are typed as strings without an established equality guarantee
to request IDs. The current trial intentionally keeps stricter requirements until
the actual response mismatch is understood.

## GATE-1 plan references and scoped amendment

The authoritative local document is
`C:\Users\willm\job-application-tracker\docs\UIDesign\error-pages-auth-correctness-remediation-plan.md`.
It is untracked in the dirty main checkout and absent from the diagnostic worktree
and current upstream tree. Do not copy its unrelated contents into this PR or
assume a clean clone contains it. Its reviewed SHA-256 is
`38E2AA533DC64ACA8A4B74A2DDE6CFE6E8D5BB9D795E7D556F7A80A2B79DDB3E`.
Line numbers below are the September 24 snapshot; search the headings if they move.

| Line | Reference |
| --- | --- |
| 76 | Gate index: deployed GATE-1 open |
| 263 | Canonical CHUNK-1 and deployed GATE-1 |
| 302 | GATE-1 temporary v1 WAF contract |
| 313 | Approved local ordinary Log receipt-trial exception |
| 642 | Qualification item 9, Temporary v1 WAF, cross-reference to the exception |
| 654 | Item 11, Security logging and receiving-surface/privacy obligations |
| 1273 | September 23 read-only WAF capability evidence |
| 1335 | Independent WAF agreement: same qualified request and actual canonical source |
| 1343 | Proposal before execution: separate implementation and live approvals |
| 1687 | Approved future-v2 sequencing amendment |
| 1929 | Canonical dependency and merge order |

The local amendment permits only this bounded ordinary Log diagnostic in addition
to the existing temporary 1000/source-IP/60-second rate rule. It preserves Redis,
HMAC, the exact 400-request application ceiling, no additional charges, separate
live approval, owner freeze for mutations, and verified targeted rollback. It
records the empty successful Events GET as access-only evidence. It explicitly
does not substitute for rate-rule behavior, privacy, receiving-surface, source-
agreement, or other GATE-1 qualification. The qualification item 9 cross-reference
prevents its prior "execute only" wording from contradicting this narrow exception.

The existing rate-limit rule's Log action fires at the rate threshold; do not
lower its threshold or send high-volume traffic to manufacture a receipt. Even
a successful ordinary Log summary remains different from a per-request trace.
A later independent WAF/application source comparison still needs a separately
designed and approved mechanism; no comparator is implemented here.

Preserve the sequence: **GATE-1 -> CHUNK-5A/GATE-5A -> CHUNK-2 dark v2/GATE-2 -> CHUNK-3**.

## Validation and primary references

The focused local suites are `gate1ProviderAccess.test.js`,
`gate1SourceDiscovery.test.js`, and `gate1LogReceipt.test.js` (650 current cases:
437 provider/discovery and 213 receipt/config-check). All 650 passed together on
the PR branch, with focused lint, JavaScript/PowerShell syntax, and whitespace
checks passing. Network access is mocked or blocked. Windows sandbox subprocess
`EPERM`/null-status failures require the
normal approved escalation; do not weaken tests to hide them. Run focused lint,
JavaScript/PowerShell syntax, and whitespace checks. Check the PR's actual CI
status separately; a local pass is not a hosted CI or live-evidence pass.

- [Events API](https://vercel.com/docs/rest-api/security/read-firewall-actions-by-project)
- [Config envelope model](https://raw.githubusercontent.com/vercel/sdk/main/src/models/getsecurityfirewallconfigresponsebody.ts)
- [SDK primitive parsing](https://raw.githubusercontent.com/vercel/sdk/main/src/types/primitives.ts)
- [Custom rules](https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules)
- [Rule conditions](https://vercel.com/docs/vercel-firewall/vercel-waf/rule-configuration)

The installed CLI source used to verify staging operations was
`C:\Users\willm\AppData\Local\npm-cache\_npx\67eb4586ca667318\node_modules\vercel\dist\commands-bulk.js`:
GET `/config`, PATCH `/config/draft`, POST `/config/draft/activate` with `{}`,
and DELETE `/config/draft`. Do not execute that CLI as a bounded-query substitute.
