# Authentication preparation: offline controls and qualification

The original seven-file addition implements the approved offline scope after anonymous
build attribution. The scoped controls described below are a subsequent implementation.
Gate 1 remains open; no native qualification or live execution has been performed for it.
The application, eleven previously reviewed files, original README, consumed
build attempt and accepted isolation receipts are unchanged.

The staging checkout converted only `hosted-csrf-build-attribution.cjs` and its
test from LF to CRLF. Source binding verifies the consumed eleven-file hash,
requires identical content after that specific two-file line-ending conversion,
and includes both raw dependency maps in the new source-set hash. It does not
rewrite either dependency or substitute new bytes into historical receipts.

## Coverage decision

The project owner approved the
[scoped pre-production measurement contract](../../docs/UIDesign/gate1-authentication-measurement-decision.md)
on 2026-11-04, limited to authentication preparation. It accepts incomplete
background measurement as an explicit limitation for future reviewed preparation;
it provides no whole-browser request ceiling, executed pass or live approval.
The companion defines the acceptance boundary. The owner subsequently approved
the eleven-file implementation described below, limited to source changes and
offline validation. The approved companion remains unchanged as the decision record.

The pinned Playwright protocol describes `Target.setAutoAttach` in terms of
related targets, including iframes and workers. Page `Network`/`Fetch` events do
not establish complete browser-background coverage. A CONNECT proxy can constrain
destinations, connection counts and encrypted bytes, but cannot count HTTP requests
inside TLS. A passing page-event comparison therefore retains
`browserTrafficMeasured: false`. No complete coverage mechanism is implemented.

`--execute-reviewed-manifest` fails with `coverage_unqualified` before reading a
manifest or performing any I/O. `finalizeAuthentication()` also always rejects.
There is no force flag or native live adapter in that original helper. Its plan validator records
the proposed contract without granting execution. Offline evidence cannot satisfy
the existing diagnostic's `validatePreparation` contract.

## Consumed local qualification

Operator: Codex agent. Operational/risk owner: project owner.
The historical approval permitted one attempt, at most 180 seconds including
cleanup and postflight, two launches,
one new synthetic profile. The first 150 seconds are available for work. Browser
closure uses the same overall clock, reserving the last 15 seconds for postflight.
No automatic repeat or extra case follows a stopped or inconclusive native run.
The single attempt has been consumed. Its pass covers its original source set
only; neither the merged review follow-up nor this documentation change inherits
native qualification. See the companion's preserved-evidence record.

The worker:

1. Verifies the original eleven-file source binding, all fifteen history hashes,
   build/manifest hashes, the seven added files and the pinned browser package.
2. Starts two loopback listeners. The proxy rejects CONNECT and all external
   destinations; no hosted application or OAuth request is forwarded.
3. Launches pinned Chrome with the synthetic profile and no proxy bypass.
4. Attaches CDP Fetch/Network before opening the forwarding gate or navigating.
5. Reserves the synthetic `/start` redirect and `/login` hop independently,
   establishes a persistent synthetic cookie, and verifies a synthetic identity.
6. Closes Chrome normally and independently checks executable/profile processes
   and its CDP listener through PowerShell and a loopback port probe.
7. Restarts the same profile behind the rejecting proxy and makes exactly one
   context-bound `/session` request to verify persistence. The request client
   bypass is explicit, separately reserved and restricted to the loopback origin.
8. Demonstrates a different-host synthetic navigation blocked before forwarding.
9. Closes normally, preserves the profile, closes local listeners and writes a
   preliminary attempt exclusively.

The supervising process requires the worker's exit code zero and finalized
completion with the exact attempt hash. It rechecks sources, process absence and
all listeners before exclusively writing a scoped offline postflight receipt.
Missing permissions, truncated output, nonzero exit, failed writes, extra evidence
fields, unmatched page events or uncertain closure cannot become a pass.

Artifacts are fixed and single-use:

```text
.tmp/gate1-authentication-preparation-offline-01/
  worker-started
  synthetic-profile/
  attempt.json
  postflight.json
```

No authenticated profile or `authentication-preparation.json` is created. No
browser storage is inspected; only `DevToolsActivePort` is read for attachment.
No screenshot, HAR, raw protocol data, request URL, header/body, cookie value,
account identifier or identity hash is retained in evidence. The fixed synthetic
fixture identity/cookie are non-secret test data. Browser-generated synthetic
profile files are preserved, not inspected or exported.

Offline budgets: application 12, session 4 (included), zero provider/static/
metadata requests, 128 proxy connections, 16 concurrent, two pages per browser,
1,024 page-observation events, 16 KiB evidence. The proxy bounds cumulative HTTP
request body bytes at 64 MiB, including denied requests; headers, HTTP framing and
rejected CONNECT traffic are excluded. Tiny fixed loopback responses are
separately bounded by fixture count.
Native launch/CIM/CDP operations are bounded. Browser-background attempts rejected
by the proxy are summarized as connections/denials, not fabricated HTTP counts.
This does not prove OS-wide egress isolation, UDP/WebRTC isolation, whole-process
memory bounds or complete background request measurement. Post-buffer response
checks are not streaming memory limits. Retain the Chrome EXE/DLL NotSigned
disclosure from the accepted package provenance.

## Commands

Use Node 22.18.0 and main-checkout dependencies through `NODE_PATH` in the isolated
worktree. Set `TEMP` and `TMP` to the main checkout's `.tmp`. Clear `DEBUG`,
`DEBUG_FILE`, `PWDEBUG`, `NODE_OPTIONS`, and `NODE_DEBUG` in the child environment.

```powershell
node --test scripts/gate1-browser-tabs/__tests__/authentication-preparation.test.cjs scripts/gate1-browser-tabs/__tests__/authentication-preparation-traffic.test.cjs scripts/gate1-browser-tabs/__tests__/authentication-preparation-postflight.test.cjs
node scripts/gate1-browser-tabs/authentication-preparation.cjs --source-hash
node scripts/gate1-browser-tabs/authentication-preparation.cjs --qualify-loopback <reviewed-source-set>
```

The last command describes the consumed native attempt; it is not a command to
rerun under the current approval. Any further native exercise requires a new
bounded proposal, fresh single-use paths and separate approval. Unit
tests use mocks, do not launch Chrome and do not create the attempt directory.
Syntax, scoped ESLint and whitespace checks precede the native run. After changing
code, do not describe an earlier source-bound native receipt as validation of the
changed source. Preserve the attempt and return to the owner if a repeat is needed.

## Frozen target policy for future execution

Historical frozen attribution: deployment `dpl_jbyKAs8vNoVbGQ4vSM5hKd7LSrTJ`, source
`62b4133d257b43529d93e62f98afc8ccb2faf15b`, build `YB6TC2dgLcUGcHUpFCAaM`.
Canonical `job-application-tracker-kappa-seven.vercel.app`. Future execution must
recheck exact project/alias/deployment metadata before and after; current Git refs
alone do not prove deployment identity. Preserve successful build invocation and
`receiptFinalized:true` observations as well as its on-disk receipt.

Draft destinations, HTTPS/443 only, no wildcards:

- Canonical GET `/`, `/login`, `/auth/callback`, `/api/auth/session`,
  `/api/auth/csrf`, `/api`; static `/_next/static/` and `/favicon.png`.
- Supabase `apxfjggdcybjticrnbpk.supabase.co`: GET `/auth/v1/authorize` and
  `/auth/v1/callback`, during OAuth only.
- Google `accounts.google.com`: GET/POST during owner-operated OAuth only.
- Candidate GET-only support hosts `www.gstatic.com`, `ssl.gstatic.com`,
  `fonts.gstatic.com`, `fonts.googleapis.com`, `lh3.googleusercontent.com`.
  This is a proposed allowance, not an observed complete provider inventory.
- Metadata uses only the existing guarded `api.vercel.com` project/alias/deployment
  commands. It is never an allowed browser destination.

Unknown destinations or provider refusal stop; no bypass, allowlist expansion,
automatic sign-in retry, refresh, profile migration or account-management action.
OAuth server-to-server exchanges are outside the browser measurement boundary.
Application retry/focus behavior must be blocked after the first failure.

Draft live limits remain 900 seconds including 60 cleanup/postflight, 600 manual
sign-in seconds, two launches, one OAuth attempt, two pages, application 24,
session 8 included, canonical static 80, provider static 120, Supabase 4, Google
non-static 96, metadata 6 at 30 seconds each. Browser HTTP operations 30 seconds,
restart session 5 seconds; proxy request body bytes 64 MiB, connections 128 total/16
concurrent; receipt 16 KiB. Every redirect and uncertain dispatch stays charged.
The original helper validates these proposed values without implementing live coverage.
Under the scoped decision, HTTP allowances cover accounted page/request-client
attempts only. Proxy connection concurrency is not HTTP concurrency. The 64 MiB
body allowance does not bound encrypted tunnels or response bytes. A concrete
implementation freezes separate tunnel-byte accounting, observed HTTP concurrency
and pending-event bounds below. No complete browser or OS-wide containment claim follows.

Current application/static/session ledger (build already included): actual
150/150/52, conservative 151/150/52. Draft accounted-traffic maximum after
preparation: 174/350/60 and 175/350/60, respectively. These are ceilings for that
accounted scope, never executed totals or whole-browser upper bounds. Provider
non-static and metadata counters remain separate. Historical background traffic
is still unmeasured. Offline loopback counts do not increment hosted ledgers.

Expected UUID must be supplied privately as `GATE1_APPROVED_USER_ID` before a
future live attempt. Never request it in chat, read `.env`, or derive it from the
session under test. Comparison occurs in memory before/after restart. The final
scoped receipt would require exact target/build/profile, measured incremental
counts with explicit coverage, identity verification, normal closure and
independently established process exit. It must retain
`browserTrafficMeasured: false` and `hostedQualified: false`, and bind a distinct
schema/version to the reviewed owner decision and sources. The existing hosted
diagnostic still requires `browserTrafficMeasured: true` and must reject scoped
evidence until a separately reviewed consumer change. No synthetic receipt or
boolean waiver substitutes for either contract.

## Scoped implementation and offline validation

The five `authentication-preparation-scoped*.cjs` modules and their five matching
tests implement the approved local scope. The original helpers, strict hosted
consumer and consumed dependency/evidence copies remain unchanged.

| Module suffix | Responsibility |
| --- | --- |
| `scoped.cjs` | Source/tool binding, expiring execution-review validation, two-launch ownership, deadline/cancellation, worker supervision and native adapters. |
| `scoped-contract.cjs` | Strict version-2 plan, native evidence, successful/stopped attempt schemas; atomic request budgets and explicit coverage. |
| `scoped-proxy.cjs` | Exact CONNECT authorities, connection/byte admission, backpressure and owned socket closure. |
| `scoped-observer.cjs` | One raw bounded CDP controller, paused-target initialization and Fetch/Network redirect reconciliation. |
| `scoped-postflight.cjs` | Independent process/listener/profile verification and exclusive receipt finalization after successful worker exit. |

The source hash includes the exact sixteen scoped/native module/test files, both
public loopback TLS fixture files, the existing
preparation/dependency aggregate (which includes this document), and the companion
decision's digest. Working-byte and line-ending changes therefore invalidate
matching qualification. Tool binding additionally pins the Playwright utility
bundle used for WebSocket transport to
`580f571bf063e2256b51b3946a035bc452fc0e22808d5547b198baea39923a32`.
The previously accepted Chrome package and its EXE/DLL NotSigned disclosure remain.

The approved implementation limits add browser-to-upstream 8 MiB,
upstream-to-browser 56 MiB, combined tunnel payload 64 MiB, observed HTTP in-flight
32, attached target sessions including frames 16, retained hop records 1,024,
relevant events 4,096, pending CDP commands 64 and CONNECT headers 8 KiB. Existing
request, deadline, connection and 16 KiB receipt limits remain. A conservative
64 KiB protocol-message cap also bounds the raw CDP parser; an oversized message
stops observation. These are stopping limits, not measured OAuth requirements.

Tunnel payload is reserved atomically before forwarding; CONNECT head is charged
before starting its upstream connection. Read, rejected, admitted and locally
enqueued bytes are separate. Each direction is counted once. A local write or
continuation acknowledgement does not prove server receipt. Over-limit chunks
are rejected whole, failed reservations remain charged, and drain callbacks cannot
resume a stopped socket. The CONNECT response/header framing is outside tunnel
payload accounting. This is neither a whole-browser request count nor a
whole-process memory guarantee. Response/body checks after buffering are not
streaming memory bounds.

First launch uses only the raw CDP controller, including normal-close recovery.
It pauses related targets, installs interception recursively, then resumes supported
targets. Two owned blank pages must be ready before forwarding opens. Unexpected
workers, unpaused targets, detachments, mismatched Fetch/Network method/URL pairs,
missing events, provider HTTP refusal, repeated OAuth initiation or exceeded
bounds stop the attempt. Ephemeral correlation fingerprints remain in memory only.
Native qualification must prove this target ordering; passing mocks cannot.

The worker verifies the private expected identity through the observed page,
seals forwarding, closes normally and independently verifies process/listener
exit before restarting the same preserved profile. Only the restart attaches
Playwright, with the proxy still rejecting browser forwarding. Its single exact
context-bound session operation is separately reserved with retries/redirects
disabled and identity compared again. The context owns cookie access/write-back;
no browser storage is exported. Actual persistence, write-back, cancellation and
restored-worker blocking still require fresh native evidence.

Cancellation seals sockets, signals metadata children, disposes the active request
client and proceeds to normal browser closure on the shared deadline. Late results
cannot reopen dispatch or produce successful completion. Stopped attempts preserve
aggregate charged/uncertain counts and partial cleanup when their marker is owned;
failed/partial evidence writes never become finalized success. No forced browser
termination or automatic retry is implemented.

Use main-checkout dependencies and repo-local TEMP/TMP for these offline checks:

```powershell
node --test scripts/gate1-browser-tabs/__tests__/authentication-preparation-scoped*.test.cjs scripts/gate1-browser-tabs/__tests__/authentication-preparation.test.cjs scripts/gate1-browser-tabs/__tests__/authentication-preparation-traffic.test.cjs scripts/gate1-browser-tabs/__tests__/authentication-preparation-postflight.test.cjs scripts/gate1-browser-tabs/__tests__/hosted-csrf-diagnostic.test.cjs
node scripts/gate1-browser-tabs/authentication-preparation-scoped.cjs --source-hash
```

Also run `node --check` and scoped ESLint on the ten new JavaScript files, plus
`git diff --check` and whitespace/link checks including ignored new files.
These tests mock native/network boundaries and do not qualify Chrome or providers.

## Separate native and live reviews

No native qualification, execution review, real profile or scoped receipt was
created by this implementation. The next proposal is a fresh, bounded synthetic
qualification using new single-use paths, exact source/tool hashes, fixed cases,
budgets, deadline/cleanup and independent postflight. Preserve the consumed
`offline-01` artifacts. Qualification must cover target-before-resume ordering,
redirect reservations, persistent synthetic cookies, request-client access and
write-back, actual cancellation, restored-worker blocking, transport overflow and
normal/independently verified closure. Its harness and execution need their own
named-file review and approval.

The required `manualContextRecovery` case must use a synthetic loopback navigation
that replaces the execution context while the native `manualSignIn` location poll
is pending. Confirm a recognized context-loss protocol response is treated as
"not yet", followed by a successful poll without stopping the attempt. Include
repeated context loss through the unchanged manual/global deadline, plus an
unrecognized protocol failure and target detachment that still stop. Retain only
the categorical check result, never protocol payloads. Mocked transport coverage
does not establish this native qualification; missing or false coverage is rejected.

After independently reviewing that qualification, reconcile the actual deployment,
canonical alias and build under a separately bounded approval. Historical target
constants intentionally fail on drift; no automatic retargeting follows.

The prepared live entry is `--execute-scoped` with the exact digest of a separately
approved `execution-review.json`. There is no force flag or bundled execution
approval. The fixed candidate directory is
`.tmp/gate1-authentication-preparation-scoped-01/`; creating it and its input files
belongs to the later execution review, not this implementation. The strict review
binds operator/owner, expiry, source/decision/tool hashes, `reviewed-plan.json`,
`native-qualification.json` and separate `native-completion.json`. That completion
must match the reviewed native attempt hash, successful worker exit and finalized
receipt. Old schema-1 receipts and changed evidence digests are rejected. Inputs
contain no private expected identity; it remains `GATE1_APPROVED_USER_ID`.

The worker requires supervisor IPC, an exclusively created `worker-started`
marker and the new exact real profile. The attempt is `attempt.json`; the distinct
final output is `scoped-preparation.json`, never the old hosted authentication
receipt. Supervision requires actual zero worker exit and exactly one finalized
completion, then independently rechecks inputs, source/tool binding, process
absence, listeners and profile before exclusive finalization. A stopped or partial
file cannot substitute for that completion. The total 900-second clock begins
before the worker starts and reserves cleanup/postflight time.

Successful scoped receipts still carry `browserTrafficMeasured:false`,
`hostedQualified:false`, `gate1Status:open` and unknown background coverage.
The strict hosted consumer rejects them. Any later consumer change and hosted
CSRF exercise remain separately reviewed work. No TLS interceptor, OS firewall
change, checkout, load, rollback, provider change or production release follows.

## Bounded synthetic native harness (implementation only)

The owner approved the fifteen-file implementation on 2026-11-05. Its three new
modules are [native orchestration](./authentication-preparation-scoped-native.cjs),
[native contract](./authentication-preparation-scoped-native-contract.cjs) and
[loopback fixtures](./authentication-preparation-scoped-native-fixtures.cjs), with
matching mocked tests. Implementation and offline tests grant no native execution
approval. Gate 1 remains open. The measurement decision, strict hosted consumer,
legacy refusals, historical receipts and hosted ledger are unchanged.

The only proposed attempt root is
`.tmp/gate1-authentication-preparation-scoped-native-01/` in the main workspace,
independent of the source worktree. It must remain absent during implementation
and mocked validation. A later, separate owner approval supplies exactly one
`execution-review.json` in that otherwise empty real directory. The worker checks
its hash, expiry and current source/tool/certificate bindings, independently checks
process/listener absence, then exclusively creates `worker-started`. Only after
that reservation does it create `profiles/` and these eight new directories:
`lifecycle`, `restored-worker`, `request-cancel`, `manual-deadline`, `protocol-error`,
`detach`, `unsupported-worker`, `missing-pair`. No alternate path, overwrite,
profile reuse from a previous attempt or automatic retry is accepted.

The worker writes `attempt.json` exclusively after cleanup. The supervisor requires
exactly one strict IPC completion and actual zero worker exit, re-reads the attempt,
matches its original start time and digests, independently inspects all eleven
launch records, preserved profiles and fixed listeners, and rechecks provenance.
It writes `native-completion.json` and then `native-qualification.json` exclusively.
An incomplete or inconclusive attempt cannot produce qualification. Partial writes
remain preserved. A successfully finished qualification write that crosses the
original deadline or completes after explicit operator cancellation is removed
before rejecting success. Cancellation remains latched between worker completion
and exit and throughout independent finalization. A started filesystem write
is awaited: this is a no-late-success guarantee, not forcible cancellation of OS I/O.

The native review binds the final working-byte source set, owner/operator,
decision/tool hashes, both certificate/key hashes, SPKI, exact command, cases,
profiles, ports, limits and an approval window of at most one hour. Certificate
material is public test data generated offline with bundled OpenSSL 3.2.1; it is
never regenerated by the harness. Its exact SANs are `127.0.0.1` and `127.0.0.2`.
The Chrome SPKI exception applies only to that owned synthetic invocation. Each
explicit request-client operation accepts the loopback test certificate only for
its exact route, with retries and redirects disabled. No system trust, global TLS
validation, network configuration or live target policy is changed.

| Listener | Fixed endpoint |
| --- | --- |
| Main HTTPS fixture | `127.0.0.1:18443` |
| Cross-site frame HTTPS fixture | `127.0.0.2:18444` |
| CONNECT proxy | `127.0.0.1:18445` |
| Raw transport sink | `127.0.0.1:18446` |

Occupied ports stop without fallback. CDP uses an owned ephemeral loopback port.
The synthetic proxy admits only the two HTTPS fixture authorities, or only the
raw sink during transport cases. It uses the existing no-loopback-bypass browser
arguments. Fixture GET routes are `/`, `/login`, `/start`, `/hop`, `/nav-a`,
`/nav-b`, `/ready`, `/worker-seed`, `/worker.js`, `/worker-probe`,
`/api/auth/session`, `/api/native/writeback`, `/api/native/hold`, `/favicon.ico`;
the frame listener accepts only `/frame` and `/favicon.ico`. Queries, fragments,
body framing, unexpected methods and unknown destinations stop the attempt.

| Ordered case | Launches | Required evidence |
| --- | ---: | --- |
| Lifecycle | 3 | Real paused-target setup acknowledgements before resume, including a cross-site frame; separately reserved redirect hops; persistent cookie; request-client cookie access and write-back; third-launch server witness; real manual context-loss recovery. |
| Restored worker | 2 | Separate explicitly unobserved setup lane with all three requests reserved before navigation; persistent worker registration; normal close and independent exit; restart behind the closed proxy; worker paused and Network enabled before resume; actual worker probe event plus denied fixture CONNECT and zero new origin probes. |
| Request cancellation | 1 | Held real context request, actual disposal, server-side socket closure, retained charge and uncertainty. |
| Manual deadline | 1 | At most sixteen real context replacements; fixed five-second deadline; no renewal or late pass. |
| Protocol error | 1 | Deliberately invalid native CDP parameters produce a real fatal response; labeled command fault injection. |
| Target detach | 1 | Actual detachment stops observation and dispatch. |
| Unsupported worker | 1 | Normal observer rejects the paused worker; no probe reaches the origin. |
| Missing pair | 1 | One real Fetch event deliberately withheld; Network-first slot and uncertainty retained; labeled event fault injection. |
| Transport | 0 | CONNECT head before upstream, directional/combined overflow, real socket backpressure, idle closure, pre-CONNECT timeout, pending activity closure and controlled late callback rejection. |

The first observed launch uses one raw CDP controller. Playwright is used only for
the explicitly context-bound request-client phases. Neither browser cookies nor
other authentication storage is inspected. Cookie values stay in fixture memory;
only categorical server witnesses are retained. Worker seeding does not relax the
normal observer's rejection policy. Real expected identity is stripped from both
the synthetic worker and Chrome environments.
The restored probe has a separate pre-resume reservation. Its blocked request and
the cancelled request retain uncertainty, separately from actual fixture counts;
normal process/socket closure releases concurrency, never those charges.
The restored worker is claimed synchronously before asynchronous Network setup;
duplicate attachments, detachment or cancellation cannot resume a late worker.

Manual recovery races actual navigation with the actual opted-in location poll.
Only a real incoming recognized `-32000` response can establish context loss.
Ordinary `false` evaluations, injected errors and mocks cannot establish it. If
the pinned Chrome does not emit that response within sixteen replacements, the
attempt is inconclusive. Worker restoration and socket backpressure are likewise
native capability questions; discovery/rejected promises alone cannot become a
pass. Expected negative cases have permanently stopped local budgets. Only their
predetermined outcome plus completed cleanup permits progression. Unexpected
results stop the whole attempt without retries or additional diagnostics.

| Cumulative constraint | Frozen maximum |
| --- | ---: |
| Attempts / total / new work / reserved cleanup | 1 / 480 s / 360 s / 120 s |
| Chrome launches / profiles / simultaneous browsers | 11 / 8 / 1 |
| Top-level pages / attached target sessions per browser | 2 / 16 |
| Application / session subset / static attempts | 128 / 16 included / 32 |
| Provider / hosted metadata | 0 / 0 |
| Explicit request-client operations / accounted HTTP in flight | 8 included / 8 |
| Proxy connections / concurrent | 256 / 8 |
| Admitted upstream / downstream / combined payload | 4 / 12 / 16 MiB |
| Parsed request-body bytes | 64 KiB |
| Retained records / relevant events / total CDP commands | 256 / 8,192 / 2,048 |
| Pending CDP commands / CONNECT headers / protocol message | 32 / 8 KiB / 64 KiB |
| Evidence per file | 16 KiB |
| Operation / attachment / manual polling / transport idle-stall | 5 / 10 / 15 / 2 s |

Transport overflow subcases use frozen 16-byte directional or combined limits;
all admitted payload still consumes the cumulative envelope. Backpressure uses at
most thirty-two 64-KiB writes. Fixture observations are counted separately (at most
160 total and sixteen session observations), never added again to admissions.
Reservations, actual observations and uncertainty retain their distinct meanings.
No failed charge is refunded. Proxy byte/connection accounting does not measure
encrypted HTTP requests, browser background traffic or OS-wide egress. The pinned
in-process Playwright transport is bounded before its first command, including
internal cookie operations, with the same CDP command/message/pending ceilings.
Missing pinned transport seams stop; package files are never modified. Unexpected
transport closure stops dispatch and releases pending command timers. A failed
Playwright attachment retires its transport before owned raw normal-close recovery.
Cleanup attempts every owned listener even if another close fails, retains the
first case failure and records incomplete cleanup separately. Background
HTTP remains unknown. Retained evidence has
`browserTrafficMeasured:false`, `hostedQualified:false`, `gate1Status:open` and only
allowlisted aggregates/provenance. No raw protocol, cookie values, identity values
or hashes, headers, payloads, screenshots, HAR, NetLog or traces are exported.

Offline commands, using the main checkout dependencies and repo-local TEMP/TMP:

```powershell
node --test --experimental-test-isolation=none scripts/gate1-browser-tabs/__tests__/authentication-preparation-scoped*.test.cjs scripts/gate1-browser-tabs/__tests__/authentication-preparation.test.cjs scripts/gate1-browser-tabs/__tests__/authentication-preparation-traffic.test.cjs scripts/gate1-browser-tabs/__tests__/authentication-preparation-postflight.test.cjs scripts/gate1-browser-tabs/__tests__/hosted-csrf-diagnostic.test.cjs
node scripts/gate1-browser-tabs/authentication-preparation-scoped-native.cjs --source-hash
node scripts/gate1-browser-tabs/authentication-preparation-scoped-native.cjs --review-template
```

The template is printed only and has zero approval/expiry timestamps, so it cannot
authorize execution. Native execution later uses exactly
`node scripts/gate1-browser-tabs/authentication-preparation-scoped-native.cjs --execute-native <execution-review-sha256>`
after a separately approved concrete review. No execution input is bundled here.
After one separately approved attempt, independently review its evidence before
proposing deployment/canonical-alias/build reconciliation, real authentication
preparation or any hosted-consumer change. Synthetic qualification closes none of
the remaining Gate 1 rows and adds nothing to the historical hosted request ledger.

## Destination rejection attribution

The one approved `scoped-native-01` attempt is consumed. Its retained receipt
reports `firstFailure:destination`, one launch, three proxy connections and zero
completed cases. Cleanup was reported successful and independently reviewed.
The exact rejecting guard was not retained. Preserve its marker, review, receipt
and eight profiles; no completion or qualification was produced. Merged cleanup
and stopped-worker reporting fixes did not repeat that native execution.

New source-only attribution retains a nullable fixed-enum `destinationReason`
in stopped native attempt receipts. Absence in historical schema-1 receipts and
`null` in new receipts mean the reason is unavailable (or inapplicable when the
first failure is not `destination`); neither can be filled from later callbacks.
Successful receipts and worker IPC retain their existing strict shapes. The
supervisor still reports the original `firstFailure`, while the additional reason
is available only in the stopped attempt receipt. A non-null reason requires
`firstFailure:destination` and cannot establish qualification.

| Boundary | Fixed reasons |
| --- | --- |
| Proxy request/parser | `proxy_http_request`, `proxy_parser_error` |
| CONNECT guards, in existing evaluation order | `proxy_owner_missing`, `proxy_owner_reused`, `proxy_method`, `proxy_authority` |
| HTTPS fixture | `fixture_closing`, `fixture_host`, `fixture_transfer_encoding`, `fixture_content_length`, `fixture_body` |
| Synthetic classifier | `route_url`, `route_method`, `route_credentials`, `route_query_fragment`, `route_normalization`, `route_origin_path` |
| Synthetic request client | `request_client_owner`, `request_client_route` |

The active native budget or root captures its first reason synchronously before
abort handlers seal transports. Propagation to the root preserves that reason;
prior failures, retired budgets and cleanup callbacks cannot replace it or supply
missing attribution. The synthetic observer binds classification to its native
budget before generic callback error handling discards exception details. These
reasons describe guards, not actual destination strings or protocol data. Nothing
retains raw URLs, destination hashes, parser exceptions, headers, cookies or bodies.

Destination policy, readiness denials, admission/byte counters, deadlines,
single-use paths, evidence limits and qualification requirements are unchanged.
The live proxy keeps its existing destination-only stop. The fixed native path
remains consumed, and this implementation supplies no replacement execution mode.
Mocks cover every reason, first-failure races, late callbacks, strict receipt
validation, historical compatibility and blocked dispatch/qualification. They do
not identify the historical rejection or establish native capabilities.

Any further native observation requires a separate finite startup-diagnostic
decision, an explicitly reviewed fresh single-use mechanism and execution
approval. Do not rerun `native-01`, expand destinations or infer zero background
traffic. Gate 1 remains open; `browserTrafficMeasured` and `hostedQualified` remain
false, and background HTTP remains unknown. Publication logs are updated only
when a separate PR push is authorized.
