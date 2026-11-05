# GATE-1: scoped authentication-preparation measurement decision

## Authority and disposition

On 2026-11-04 the project owner approved beginning the scoped pre-production
contract, limited to authentication preparation, after the two-file documentation
proposal and recommendation. This records that decision; implementation and
execution remain separately reviewable work.

Decision identifier: `authentication-preparation-scoped-v1`.
Operational/risk owner: project owner. Proposed execution operator: Codex agent,
with the owner performing any separately approved interactive sign-in.

Read this companion with the local planning documents
`docs/UIDesign/gate1-preproduction-continuation-amendment.md` (exit checklist and
execution review) and `docs/UIDesign/error-pages-auth-correctness-remediation-plan.md`
(canonical CHUNK-1/GATE-1 and formal stop conditions). Those local plans are not
bundled in the staging checkout; this decision neither replaces nor edits them.
The implementation entry point is
[Authentication preparation](../../scripts/gate1-browser-tabs/AUTHENTICATION-PREPARATION.md).

The owner accepts incomplete browser-background HTTP measurement as a named
limitation for developing and subsequently reviewing bounded authentication
preparation in the current pre-production environment, which has no paid users.
There is no guaranteed whole-browser request ceiling under this contract.
Whole-browser measurement remains unqualified and `browserTrafficMeasured` remains
`false`. This is risk acceptance, not an executed pass.

The exception applies only to authentication preparation. It does not qualify
hosted CSRF, load, cache/cross-profile isolation, WAF behavior, rollback, artifact
privacy or any other Gate 1 row. Gate 1 remains open. It grants no production
release, provider/configuration change, TLS interception or OS firewall change.
Reassess the decision before production use or a material change to the account
scope, authentication flow, toolchain or measurement boundary. Each execution
still needs its own expiring approval and frozen target, sources and budgets.

## Measurement boundary

The proposed mechanism combines page CDP Fetch/Network observation, explicitly
accounted request-client operations and a separately bounded proxy transport.
Only the synthetic page/request-client lifecycle exists today. There is no live
adapter or implemented HTTPS-forwarding proxy in the preparation helper.

| Surface | Required treatment in a future implementation | Evidence limit |
| --- | --- | --- |
| Observed page HTTP requests | Install observation/interception before navigation; classify method, destination and phase in memory; reserve each redirect hop before continuation; reconcile Fetch/Network events. | Page observations do not establish complete browser or wire-level request counts. Cache handling and uncertain dispatch must remain explicit. |
| Workers and new targets | Establish observation before permitting supported target activity; otherwise stop. Unexpected workers, targets, detachment or missing events prevent a scoped pass. | Discovery or a post-creation callback alone is not proof of pre-dispatch blocking. Unsupported pre-observation activity remains a capability gap. |
| Context-bound request client | Reserve separately before each exact approved operation; disable automatic redirects and retries; record its explicit browser-proxy bypass; preserve cookie access/write-back and restart checks. | Its requests are not page observations. No arbitrary second client, destination or fallback is admitted. |
| Browser traffic reaching the proxy | Enforce the reviewed CONNECT authority/port policy, connection limits and separately specified transport-byte limits; close forwarding after a stop. | CONNECT exposes the tunnel authority, not each encrypted request's method, path, redirect or HTTP authority. Connection/denial totals are not HTTP-request totals. |
| Other browser/background paths | Retain explicit unknown coverage, including startup/closure activity outside observed targets and possible proxy bypass paths. | Browser flags and proxy configuration do not prove OS-wide egress containment, UDP/WebRTC isolation or complete HTTP accounting. Unknown is not zero. |
| OAuth server-to-server exchanges | Exclude from browser counters and identify the separate server/provider boundary. | Browser evidence cannot establish their request totals or privacy. |

Unknown destinations observed by the page policy, or disallowed CONNECT
authorities observed by the proxy, must stop the live attempt. The policy cannot
be described as inspecting every destination/path inside encrypted tunnels.
Provider refusal stops rather than triggering allowlist expansion, automated
sign-in retries, profile migration or weakened browser checks.

The capability assessment is supported by the pinned protocol's related-target
description and the [CDP Target documentation](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setAutoAttach).
Chromium's [proxy documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)
describes CONNECT preserving end-to-end TLS. Its
[NetLog design](https://www.chromium.org/developers/design-documents/network-stack/netlog/)
treats NetLog as diagnostics rather than a reliable network-control interface.
These references explain the gap; they do not qualify the pinned binary or
authorize a NetLog capture. No broader instrumentation investigation is scheduled.

## Accounting and proposed limits

Separate observed events, admitted reservations, confirmed dispatches and
uncertain dispatches in the future schema. Reserve before continuation and retain
failed/uncertain dispatch charges; never refund them to permit a retry. Session
reservations consume application allowance atomically. Redirect hops each require
their own reservation. Reconcile page and request-client categories without
counting one dispatch twice. Metadata uses its own guarded client and ledger.

The existing draft limits are retained for their stated scope; they are not an
approved live manifest or a whole-browser operating envelope:

| Category | Draft limit and meaning |
| --- | --- |
| Observed application / session subset | 24 / 8 admitted attempts; session is included in application. |
| Observed canonical static / provider static | 80 / 120 admitted attempts; both enter the static ledger. |
| Observed Supabase / Google non-static | 4 / 96 admitted attempts, separate from application/static. |
| Metadata | 6 guarded requests, 30 seconds per operation. |
| Lifecycle | 900 seconds total including 60 seconds cleanup/postflight; 600 seconds manual sign-in; two launches, one OAuth attempt and at most two pages per browser. |
| HTTP operation deadlines | 30 seconds for observed browser operations; 5 seconds for the restart session operation. |
| Proxy connections | 128 admitted proxy connections, including those whose HTTP/CONNECT request is denied; at most 16 simultaneously admitted connections. Connection reservations are not refunded. Over-limit attempts are rejected and recorded separately. |
| Existing proxy body allowance | 64 MiB (67,108,864 bytes) of parsed HTTP request bodies, including denied HTTP requests, in the current loopback helper. |
| Evidence | At most 16 KiB per receipt, strict aggregate/categorical fields only. |

The current body allowance excludes headers, framing, CONNECT traffic, TLS bytes
and response bodies. It is not a live encrypted-transport or process-memory bound.
A future transport proposal must separately freeze numeric client-to-upstream,
upstream-to-client and combined byte limits, their accounting points and overflow
behavior before forwarding. Count each direction once at the selected boundary;
do not count both reads and writes of the same payload. Include CONNECT head bytes
in the applicable tunnel allowance and account for rejected/overflow data
separately. Observed/read bytes and bytes admitted for forwarding are different
quantities. No whole-process memory guarantee follows from a socket counter or a
post-buffer response-size check.

The same proposal must freeze an observed HTTP in-flight limit, bounded event and
pending-operation storage, and cancellation behavior. Sixteen proxy connections
does not imply sixteen HTTP requests, particularly with multiplexing. No new
numeric tunnel-byte or HTTP-concurrency allowance is granted by this document;
those are required inputs to the concrete implementation/execution reviews.

Preserve the historical application/static/session ledger: actual `150/150/52`,
conservative `151/150/52`, including build attribution once. These legacy labels
do not establish complete historical background coverage. The proposed additions
produce accounted-traffic ceilings `174/350/60` and `175/350/60` only. They are
neither executed totals nor whole-browser upper bounds. Carry unknown background
traffic separately, never as zero or as a fabricated conservative allowance.
Synthetic loopback requests do not increment hosted ledgers.

## Identity, privacy and closure

Before a live review, establish availability of the independent expected identity
privately through `GATE1_APPROVED_USER_ID`; do not read `.env`, request its value in
chat or derive it from the session under test. Compare it in memory before and
after restart. A synthetic identity cannot establish real-account verification.

Retain only allowlisted counters, timings, hashes of reviewed non-secret inputs
and categorical results. Do not retain raw URLs/queries, headers/bodies, account
identifiers or identity hashes, OAuth codes, cookies, tokens, protocol dumps,
NetLog, HAR, traces or screenshots. Do not echo raw errors or debug output. The
owned browser profile is itself sensitive authentication storage; preserve it at
the separately approved location without inspecting, exporting or publishing it.
Do not substitute a personal or synthetic profile.

Normal browser closure, profile preservation and independent process/listener
exit verification remain required, including between launches. Missing process
visibility, failed closure, surviving listeners or an unreadable/missing profile
cannot become a pass. Preserve the first failure, stop further dispatch and use
the reserved cleanup time. Retain an incomplete result rather than retrying or
reusing the single-use paths.

## Receipt compatibility and preserved evidence

The current `--execute-reviewed-manifest`, `requireLiveCoverage()` and
`finalizeAuthentication()` refusals remain unchanged. The hosted diagnostic's
`validatePreparation` still requires complete browser measurement and must reject
scoped evidence. This decision alone is not a compatibility change.

A future implementation proposal must define a distinct versioned receipt and
plan schema bound to this decision identifier, its document digest and the exact
reviewed source/target/build/profile. It must retain `browserTrafficMeasured:
false`, explicit unknown coverage and `hostedQualified: false`, while recording
identity and closure only if actually verified. It must separate the measured
counts from their acceptance under the owner's scoped decision. A boolean waiver
or force flag is not an adequate replacement for schema/version/provenance checks.

Changing the later hosted consumer requires its own named-file proposal and
review, including source-binding compatibility. Keep the consumed eleven-file
dependency copy and existing strict consumer contract intact. Do not edit an old
receipt, relabel it as scoped success, or set its coverage boolean to true.

The consumed loopback attempt remains bound to source set
`75238831419e9a1bea531b73467bdd4822aa61118cb5bde6cd5a349b35ad56e1`.
The merged review follow-up recorded 78 mocked tests but no new native run;
publication-worktree source set
`78e4abc2c53a4714a52369c6cf6cdccf907b73c14278ea2ae8d61fa51453808e`
did not inherit that native pass. Preserve both receipts and their original
meaning. Working-byte hashes can also change through checkout line endings.

`AUTHENTICATION-PREPARATION.md` is already a source-hash input, so this
documentation change creates another source set; it grants no native
qualification. The new companion decision is not currently a runtime input.
Future implementation must bind it explicitly. Do not write a self-referential
current source hash into either bound document.

## Next implementation and execution reviews

1. Prepare a concrete named-file implementation proposal. Reuse the existing
   budgets, first-failure handling and lifecycle controls where compatible.
   Specify the versioned scoped schema, source/decision binding, proxy transport
   policy, missing numeric byte/concurrency bounds and target-readiness behavior.
   Define mocked regressions for accounting, redirect races, unsupported targets,
   request-client bypass, overflows, privacy, closure and strict/scoped receipt
   separation. This document does not authorize those source edits.
2. After implementation approval, make the reviewed changes and run their focused
   offline tests, syntax/lint and whitespace checks. Passing mocks cannot prove
   native pre-dispatch target control or browser-background completeness.
3. If native qualification is necessary, separately propose a finite synthetic
   exercise with fresh single-use paths, exact source/tool hashes, request/resource
   limits, deadline/cleanup and independent postflight. Do not rerun or overwrite
   `.tmp/gate1-authentication-preparation-offline-01`.
4. Review exact deployed/canonical-alias/build identity, private-input readiness,
   measured/native capability limits, cumulative accounting and the final
   execution manifest. Historical attribution for deployment
   `dpl_jbyKAs8vNoVbGQ4vSM5hKd7LSrTJ` and build `YB6TC2dgLcUGcHUpFCAaM` is not
   current identity proof. Metadata reconciliation and any replacement attribution
   require their bounded approvals; do not automatically follow deployment drift.
5. Separately approve one live authentication-preparation attempt. Success means
   only the reviewed scoped contract passed: required identity, target, observed
   accounting, proxy bounds, normal closure and independent exit checks all hold,
   with unknown background measurement still explicit. Failure, missing evidence,
   cancellation, budget/deadline exhaustion, unexpected observed destinations,
   provider refusal or source/target drift ends the attempt and returns to the
   owner. No automatic new helper, retry or expanded investigation follows.
6. Independently review completion and preserved evidence. Only then consider a
   separate hosted-CSRF consumer proposal and execution approval. No hosted
   diagnostic or broader Gate 1 pass follows from preparation alone.

This approved documentation scope changes only this companion and the linked
authentication-preparation document. It does not update the feature/fix logs,
publish a branch or execute authentication. Documentation verification consists
of diff/whitespace and link/content review plus read-only source-hash recomputation.
