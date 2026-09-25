# GATE-1 Firewall evidence handoff — 2026-09-24

Continue the Vercel evidence investigation without additional charges. **WAF
cleanup is unresolved after an acknowledged diagnostic insertion. Keep the
owner-held WAF edit freeze.** Do not rerun the full trial, publish pending changes,
discard a draft, or delete a candidate based only on its name.

The next step is a separately approved **read-only recovery inspection** tied to
failed trial `447e9964d04241e92885614852a7bf3f`. This supersedes the earlier generic
configuration-check recommendation. The corrected projectKey reader passed the
latest live baseline; the subsequent draft comparison failed for an unknown reason.
GATE-1, independent source agreement, request correlation, and completeness remain open.

## Workspace and authorization

- Repository: `willmclaughlin03/jobApplicationTracker`.
- Follow-up PR branch: `chore/gate1-recovery-inspection`, created directly from `origin/staging` at `d45e402d`, targeting `staging` under the repository PR template.
- Preceding diagnostic PR [#227](https://github.com/willmclaughlin03/jobApplicationTracker/pull/227) merged on September 24 at `21:51:49Z`. Its `32e835ae` and `b1a07a74` changes, including timestamp and repeated-signal fixes, are already on staging. This follow-up contains the projectKey fix, recovery inspection, tests and updated handoff/logs. Check the new branch's PR and CI separately from #227.
- Existing worktree: `C:\Users\willm\job-application-tracker\.tmp\worktrees\gate1-provider-access`.
- Main checkout: `C:\Users\willm\job-application-tracker`; it contains substantial unrelated dirty work. Preserve it.
- User approved the earlier implementations and PR, the projectKey fix, the four-file local recovery-inspection implementation, and then publication in a new PR off staging. Publication includes the two required PR logs. Recovery inspection and any eventual mutation still need separate live authorization.
- The three full-trial approvals below were consumed. Their unused request budgets do not authorize new runs. The corrected reader was exercised live in the third full trial; the dedicated recovery mode has not been executed live.
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
   The raw response was deliberately discarded; that report did not identify the
   failing field.
5. A new isolated configuration-check mode and sanitized baseline diagnostics
   were implemented and mocked locally. The operator's next supplied report was
   another approved **full-trial** run at `20:50:23Z`, not config-check mode. It
   again stopped after one configuration GET with HTTP 200, no mutations, zero
   application requests, zero Events lookups, and cleanup `not_needed`.
   Its new `baselineCheck` identified `validationStage: active_config` and only
   `projectKey: { type: string, valid: false }`; all other listed active fields
   and rule checks passed, and the draft was null.
6. Code inspection establishes the exact failing condition: the old reader used
   `z.literal(TARGET.projectId)` for projectKey. The received string did not equal
   that ID. The published contract types projectKey as a string without promising
   that equality. Its actual value/format remains private and unknown; this is
   not evidence of a wrong project, an entitlement failure, or write permission.
   The approved local fix accepts a nonempty string up to 512 characters without
   coercion and preserves its exact value through existing policy comparisons.
   The next live full trial passed every baseline check, including projectKey.
   That establishes live compatibility at that baseline, without independently
   attesting project identity through the opaque field.
7. At `21:32:28.579Z`, trial `447e9964d04241e92885614852a7bf3f` made four provider
   requests: baseline GET 200, insertion PATCH 200, draft-verification GET 200,
   and cleanup-inspection GET 200. It stopped with `configuration_drift` at
   `verifyDraft`, recovery phase `inspectCleanup`, zero application requests,
   and zero Events queries. No activation, removal or draft discard was sent.
   Cleanup is `cleanup_unresolved`, with `restorationVerified: false`.
   `ruleId: null` means ownership was never verified. `pendingMutation: null`
   means the insert acknowledgment arrived; it does not mean rollback succeeded.
   The exact failed comparison remains unknown. Do not infer concurrent editing,
   normalization, or current provider state from this report alone.

Local evidence is retained under the worktree's ignored `.tmp` directory, not in this PR:

| Evidence | Local filename | SHA-256 |
| --- | --- | --- |
| Events access, 18:41:32Z | `gate1-provider-access-1790275292588-b7fed65fefa75f66.json` | `37DC35E102093BC6F3B8A0C570C0773562D871646D098D135DA4D24DF9FDDDC0` |
| Stopped receipt trial, 20:34:00Z | `gate1-log-receipt-b58bb709360a9311f1a26f3a795d06c99c63fb454cdc9b4ed3a3fc65ba455740.json` | `49DCFD8564402673D8D9AB971697771A03A66459D30A0FE6D5E390ACFD23F57A` |
| Field-diagnostic receipt trial, 20:50:23Z | `gate1-log-receipt-e6e46ad7b896b173f8dfd053892daec20deac4b8063229de9ede90eda4582f94.json` | `2D986B32A03AA2CCBFC65FEA28229F1C2E6423E345A76B1F7559DBB47F8FC3D4` |
| Unresolved insertion, 21:32:28Z | `gate1-log-receipt-fb23d577e8dc029b2857e06cc248aceadf1c0961b5a85f6dfbb89714b098c5f2.json` | `E25BB69333AEA81E805053630BEFBF45FCCCE4469749E91BD4B2769A552EEAF2` |

The stopped trial used approval
`b58bb709360a9311f1a26f3a795d06c99c63fb454cdc9b4ed3a3fc65ba455740`
and trial ID `d127f2df46d0d54939fe6572ee65bcc5`. It retained no rule ID.
Its counts were one provider request and zero application requests, Events
queries, or cleanup requests; elapsed time was 420.087 ms.

The later trial used approval
`e6e46ad7b896b173f8dfd053892daec20deac4b8063229de9ede90eda4582f94`
and trial ID `fe956605b84efc804e31593248c7cb1a`. It also retained no rule ID,
with one provider request and zero application, Events, or cleanup requests;
elapsed time was 425.304 ms. An earlier confirmation typo (`RUN LOG RECEIPT`
without `ONCE`) stopped before token entry and live dispatch. These first two
trials needed no cleanup. The third trial supersedes that operational status:
keep the WAF edit freeze because its cleanup is unresolved.

The third trial consumed approval
`fb23d577e8dc029b2857e06cc248aceadf1c0961b5a85f6dfbb89714b098c5f2`,
used three main provider requests and one cleanup request, and lasted 1433.754 ms.
The original baseline and unpredictable marker were deliberately not retained.
Their absence limits retrospective ownership and restoration claims.

## Implemented files and safeguards

- `scripts/gate1-provider-access.js`, `scripts/run-gate1-provider-access.ps1`,
  `src/testSupport/__tests__/gate1ProviderAccess.test.js`: metrics controls and
  Events access mode, one provider request, zero application requests, sanitized
  error/schema facts, no retries, and code/profile-bound approval.
- `scripts/gate1-log-receipt.js`, `scripts/run-gate1-log-receipt.ps1`,
  `src/testSupport/__tests__/gate1LogReceipt.test.js`: ordinary Log lifecycle and
  separately isolated `config_check` and `recovery_inspection` modes. All three
  exported sequencers reject other modes' profiles independently of CLI routing.
  The two read-only wrappers share bounded GET transport, with no lifecycle branch.
- `docs/feature-memory.md` and `docs/fixes.md`: entries for this PR push only.
- This document tracks the scoped plan amendment and handoff without importing
  the unrelated, untracked full qualification plan into the PR.

Both read-only modes permit exactly one provider operation:

```text
GET https://api.vercel.com/v1/security/firewall/config
    ?projectId=prj_b2nMrysMSJtpmqoeGx5g0WGgGuom
    &teamId=team_7o3efmwjZbMc2Bfy9qAzkc9q
```

Limits: zero application requests, one provider request, zero Events queries,
zero configuration mutations, concurrency one, 10-second request and 15-second
overall limits, 262144 response bytes, 16384 header/input bytes, 8192 report bytes,
and a 15-minute profile age limit. No redirects, retries, pagination, or automatic
transition into the full trial. Both profiles require source-code review,
credential-logging review, and included-usage headroom attestations. Recovery
also requires recovery-procedure review and confirmation that the existing WAF
edit freeze is held. These attestations begin false and must reflect real checks.

Use `--config-template` / PowerShell `-ConfigTemplate` for a fresh config profile.
`--config-prepare` / `-ConfigCheck` are offline preparation modes. `--review` /
`-ProfilePath` review either profile; `--live` / `-Live -Approval` select the strictly
validated profile mode. The config confirmation is **`RUN CONFIG CHECK ONCE`**.
The default `--template` / `-Template` still describe the full Log trial.

Recovery uses `--recovery-template` / `-RecoveryTemplate`, or the offline scope
preview `--recovery-prepare` / `-RecoveryInspection`. Its profile requires
`queryMode: recovery_inspection` and the fixed `failedTrialId` above. The scope is
`provider_firewall_recovery_inspection_only`; exact terminal confirmation is
**`RUN RECOVERY INSPECTION ONCE`**. The approval binds the failed trial, fixed
target, mode, GET path, budgets, profile and executable bytes. No old approval or
other mode's profile is accepted. The token goes only through the hidden prompt
and transient child stdin.

The report contains existing sanitized schema facts and fixed candidate/delta
booleans, enums and counts. Exact candidate name is
`gate1-log-receipt-447e9964d04241e92885614852a7bf3f`. Structural checks use the
runner's exact shape, including condition order; they do not assert provider
semantic equivalence. Raw configurations, rule IDs/names, IPs, marker values,
provider-selected keys and validation errors are never returned or retained.
Unknown policy fields still participate in current policy comparisons.

A name or structural match remains a candidate, even if unique. Inspection cannot
compare against the lost original baseline or marker. A successful report means
the read/inspection completed; cleanup remains `cleanup_unresolved`, ownership
remains `unverified`, and restoration is never asserted by this mode.

The full trial's budgets still allow one anonymous application attempt and at most
eleven provider attempts: six for baseline/stage/readback/activate/readback/Events,
with five reserved for cleanup. It creates one ordinary Log rule matching host,
GET, raw path, and a fresh unpredictable user-agent marker. It verifies activation,
sends the single probe, waits 30 seconds, performs one Events lookup, and removes
only verified owned state. Provider `eq` is case-insensitive. The delay is not a
delivery guarantee. Empty or ambiguous summaries remain inconclusive.

Cleanup requires full policy comparisons, preserved unrelated rule order, and
no preexisting/foreign draft. `projectKey` remains part of these comparisons:
case changes or any other value change block activation/continued work or leave
cleanup explicitly unresolved. It is never normalized, substituted into request
URLs, or retained in reports. All provider requests still use the fixed projectId
and teamId, and ownerId must still equal the approved team. This relies on the
provider's project-scoped endpoint; projectKey itself is not an independent
project identity attestation. No documented conditional-version guard was found;
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
2. Review the four-file local recovery implementation and its validation. Prepare
   a fresh **recovery-inspection** profile, not a full-trial or generic config
   profile. Set `NODE_PATH` to main-checkout `node_modules` when needed. Keep
   attestations false until their conditions have actually been confirmed.
3. Present the offline review before separate live authorization. The exact
   `RUN RECOVERY INSPECTION ONCE` terminal prompt approves only one configuration
   GET, zero application requests, zero Events queries, and zero mutations.
   Enter the token only in the hidden prompt. Preserve the existing WAF edit freeze
   because the earlier insertion remains unresolved, even though this check only reads.
4. Ask for the sanitized JSON report. Do not ask for raw configuration, provider
   payloads, screenshots containing source identities, tokens, or raw errors.
5. Review candidate counts, action/condition checks, validation metadata, and
   current draft-vs-active differences. Schema failures leave candidate/delta
   comparisons unevaluated. Empty/ambiguous candidates and unrelated differences
   require further review, not an automatic retry or mutation.
6. Propose a narrowly targeted recovery action only if sufficient ownership and
   current-state evidence can be established; obtain separate approval. The report
   alone never authorizes deletion, publishing or draft discard. If ownership
   remains uncertain, leave cleanup explicitly unresolved. Do not start another
   application probe until the earlier state has been resolved and a new trial reviewed.

## What the next response must show

Inspect these facts in the operator's **new live recovery-inspection report**:

| Field | Required interpretation |
| --- | --- |
| `scope`, `queryMode` | `provider_firewall_recovery_inspection_only`, `recovery_inspection` |
| `failedTrialId` | Exactly `447e9964d04241e92885614852a7bf3f` |
| Counts | `appRequests: 0`, `providerRequests: 1` if dispatched, `eventsQueries: 0`, `configMutations: 0` |
| `receipts` | At most one `recoveryInspection` receipt; inspect its HTTP status |
| `configurationCheck.jsonContentType`, `jsonValid` | Distinguish content-type and JSON parsing failures |
| `validationStage` | `http_status`, `content_type`, `json`, `envelope`, `active_config`, `draft_config`, `duplicate_rule_ids`, or `compatible` |
| `rootType`, `envelope` | Fixed type/presence facts for active/draft/versions; `unexpectedFields` is a boolean, never raw unknown names |
| `active.fields`, `draft.fields` | Fixed field `type` and `valid` flags for id/version/updatedAt/ownerId/projectKey/firewallEnabled/changes/ips/rules |
| `active.fields.projectKey` | Expect `type: string`, `valid: true` under the corrected length/type check; it no longer asserts equality with projectId |
| `active.rules`, `draft.rules` | Aggregate field-validity and unique-ID flags; no rule values or indices |
| `basis` | `current_trial_reader_contract`: validity means this reader's requirements, not a provider diagnosis |
| `recoveryInspection.active`, `.draft` | Fixed candidate counts: valid ID format, enabled, ordinary Log action, host/method/path, marker format, exact conditions, validation metadata, additional rule fields, exact structure |
| `draftVsActive.policyEqual` | Equality of current policies, excluding root ID/version/update time/change history |
| `draftVsActive.nonCandidatePolicyEqual` | Whether the current policies match after removing exact-name candidates from both; unknown fields and unrelated rule order still participate |
| Other `draftVsActive` facts | Candidate equality/shared-ID count; configuration ID/version/update-time equality; change-list equality, count and fixed classification |
| `originalBaselineComparison`, `originalMarkerComparison` | Always `unavailable`; the original values were not retained |
| `ownership`, `restorationVerified`, `cleanup.status` | `unverified`, `false`, `cleanup_unresolved`, even when the inspection result is `completed` |
| Gate/source fields | Gate open, source agreement not evaluated, correlation/completeness unqualified |

If a transport/approval failure occurs before body review, `configurationCheck`
may be null; diagnose that boundary without assuming a schema cause. A compatible
HTTP 200 inspection does not establish ordinary Log visibility or cleanup success.
Candidate checks are available only after compatible schema validation. A null
draft in `configurationCheck.envelope` means no current draft was observed; a
null candidate projection after schema failure means it was not evaluated.

The second full-trial report identified the old projectKey equality assumption;
the third full trial passed that corrected baseline and then failed a separate
draft comparison. Do not carry the old schema diagnosis into the current failure.
Owner equality, enabled-firewall requirement, nullable-active refusal, strict
scalar types, unique rule IDs, request limits, and cleanup guards remain intact.
The recovery inspection reports structural similarity and current differences;
it does not verify ownership or authorize mutation. Full trials still refuse
every existing draft and retain their strict staging/cleanup comparisons.

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
| 344 | Remaining WAF behavior, source agreement, receiving surfaces/privacy and independent rollback evidence |
| 642 | Qualification item 9, Temporary v1 WAF, cross-reference to the exception |
| 654 | Item 11, Security logging and receiving-surface/privacy obligations |
| 1236 | Trusted-source/WAF evidence reconciliation |
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
Preserve the earlier scoped passes for cross-deployment shared allowance,
controlled application restart continuity, and selected-host login access.
They do not close the outstanding WAF/source obligations.

## Validation and primary references

The combined local implementation passed **759 tests across all three suites**
on September 24 (145.692 seconds): 322 receipt/config/recovery tests and 437
provider-access/source-discovery tests. Focused ESLint, JavaScript syntax,
PowerShell parser and diff whitespace checks passed. The sandbox initially denied
Node/PowerShell subprocess creation; the complete suites then passed with approved
test escalation. No live Vercel or application requests, WAF changes, deployment,
commit or push were performed for this local recovery implementation.

The focused local suites are `gate1ProviderAccess.test.js`,
`gate1SourceDiscovery.test.js`, and `gate1LogReceipt.test.js`. The historical
projectKey validation passed 666 cases (437 provider/discovery and 229 receipt),
plus focused lint, JavaScript/PowerShell syntax and whitespace checks. That count
predates the repeated-signal fix and recovery additions. Before the reader change, the new regression
reproduced rejection of distinct bounded string keys; the project-ID string still
passed. The lifecycle fixtures now use a distinct opaque key throughout. Added
coverage rejects missing/null/non-string/empty/oversized keys, catches exact-value
drift across staging, activation, cleanup and draft discard, and verifies report
privacy and fixed request targets/budgets. Network access is mocked or blocked.
Recovery coverage adds ambiguous/absent/currently active candidates, unrelated
policy changes, provider-added metadata, malformed schemas, private fields,
single-GET limits, cancellation/timeouts, cross-mode approval rejection, exact
PowerShell confirmation, and durable approval consumption. It requires ownership
and cleanup to remain unresolved for every outcome, including successful reads.
Windows sandbox subprocess `EPERM`/null-status failures require the normal
approved escalation; do not weaken tests to hide them.

The [published revision's CI](https://github.com/willmclaughlin03/jobApplicationTracker/actions/runs/36059188154)
passed lint, unit tests, build and smoke checks. Its automatic Vercel preview
reported failure without a cause in GitHub's status; no retry or deployment
repair was attempted. CodeRabbit skipped review for the staging base branch.
These hosted results belong to `32e835ae`, not the subsequent local fix. Check
the PR's actual revision and status separately; local tests do not establish
hosted CI success or live evidence for a later revision.

- [Events API](https://vercel.com/docs/rest-api/security/read-firewall-actions-by-project)
- [Config envelope model](https://raw.githubusercontent.com/vercel/sdk/main/src/models/getsecurityfirewallconfigresponsebody.ts)
- [Configuration field contract](https://vercel.com/docs/rest-api/security/read-firewall-configuration)
- [SDK primitive parsing](https://raw.githubusercontent.com/vercel/sdk/main/src/types/primitives.ts)
- [Custom rules](https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules)
- [Rule conditions](https://vercel.com/docs/vercel-firewall/vercel-waf/rule-configuration)

The installed CLI source used to verify staging operations was
`C:\Users\willm\AppData\Local\npm-cache\_npx\67eb4586ca667318\node_modules\vercel\dist\commands-bulk.js`:
GET `/config`, PATCH `/config/draft`, POST `/config/draft/activate` with `{}`,
and DELETE `/config/draft`. Do not execute that CLI as a bounded-query substitute.
