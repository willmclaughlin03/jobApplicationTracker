# Gate 1 six-case runtime preparation

Gate 1 remains OPEN. Gate 5A remains UNPASSED.
This package prepares a separately authorized, one-run isolated CI qualification.
Preparing, testing or publishing it does not approve dispatch, application startup,
hosted configuration, deployment, gate approval or retry. Offline tests use mocks
and synthetic fixtures; they do not establish actual runner or middleware behavior.

## Identity and preserved evidence

Application commit: `8c68fd9e58f717ff766f39fe4c90325fc113e722`.
Tree: `20f38b86ff6e44ee38d504a8d899f33fc016134a`.
Lock SHA-256: `f6af332dffbbbcbd8aca4b816201fa5756e25d2e7249e1cd2c0cd9c3343b9f1a`.
Selected inventory: 362 files, SHA-256
`c97d1f5080c6674b97151e06d68f20a337cbe9b2c5014e00e9dd28a461a77c87`.
Node 22.23.3, npm 10.9.9, Next 16.3.3, React/React DOM 18.3.1,
Acorn 8.15.0 are exact guards; no fallback or major-version relaxation exists.

The adjacent static package is reused without edits and bound to digest
`caf0c83c17ed131cc080e7453e1fde961c62026462e95be25d6c639257c97784`.
Its corrected supervisor kills owned Linux process groups on direct-child exit
and permits only five seconds for stream closure, including late overflow.
The consumed static run
[44582070008](https://github.com/willmclaughlin03/jobApplicationTracker/actions/runs/44582070008)
passed `complete_static_only`, with zero application probes and no server startup.
It retained reports, not transferable build output or reader locations.
Its approval is consumed. The stopped local Docker attempt and inconclusive
artifact-privacy investigation stay closed; this package neither replays nor
inspects their state trees.

This package hashes twelve files: the manual workflow, this README, four runtime
modules, Jest config and five suites. The existing repository Jest configuration
already discovers the suites. `scripts/*` is ignored: a later approved publication
must force-add only the reviewed files. Do not change `.gitignore` for this package.
On Windows, read-only package preparation previews Git LF text bytes, including
the frozen static dependency, because linked checkouts use CRLF. It explicitly
reports `checkoutBytesQualified: false`. Linux execution hashes actual bytes and
requires the reviewed digest. A Linux checkout mismatch stops before installation.

## Execution contract for a future review

The manual-only workflow uses `ubuntu-24.04`, immutable action revisions, read-only
repository permission and no persisted checkout credentials. Tools are checked out
at the exact workflow SHA; the application uses the commit above. The controller
requires this repository, main, manual dispatch, the selected run number, first
attempt, package digest and execution digest. A fresh exclusive reservation consumes
the attempt before installation. Neither a failed run nor a workflow rerun grants
another attempt. Future approval must name the operator and operational owner.

After exact-source checks, one locked install and one fresh production build run
with an explicit synthetic environment. No hosted secret is forwarded. No `.env`
file or credential store is read by these tools. Setup/install/build/upload have
network access and are outside runtime isolation and runtime resource quotas.
The synthetic `.invalid` Supabase URL is not claimed as a network boundary.

The runtime child is an unprivileged transient systemd service with private
loopback networking, no new privileges, empty capability sets, restricted socket
families, read-only application/toolchain inputs and narrowly writable runtime
scratch and `.next/cache`. `PrivateTmp` also provides private temporary directories.
It has four cores' worth of CPU quota, 6 GiB memory, zero swap, 256 tasks, no restart
and control-group termination. No filesystem storage quota is claimed.

Before Next loads, the child verifies that its actual network namespace differs
from the parent's, its only interface is loopback, and cgroup/privilege/seccomp
facts match. The parent independently reads effective service settings, including
filesystem paths and limits, before publishing release. Unknown metadata, worker
layouts, platform behavior or unavailable instrumentation fail closed. Runner
support remains unqualified until separately approved execution; documentation
and mocked metadata are not enforcement evidence.

The child inspects its fresh build with the frozen static inspector, privately
recovers the exact compiled native-reader spans and confirms closure agreement.
It starts Next in that same process, observes native values unchanged and counts
only immediate callers within those spans. There is no readiness HTTP request:
the listen callback releases the six sequential attempts. Afterwards descriptors,
sockets, server and Next are cleaned up, then source/manifests/compiled hashes are
rechecked against the same build. Build ID and hashes are new evidence, never copied
from the prior static run. Unsupported execution in another worker is unavailable
attribution, not permission to broaden the reader match.

| Case | Request and required result | Attributed reads per property |
| --- | --- | --- |
| baseline | GET `/login`, no diagnostic headers; nonempty 200, no observation | 0 |
| authenticated_1 | Correct synthetic diagnostic key, fresh A; nonempty 200 and one matching Node 22.23.3 observation | 1 |
| authenticated_2 | Correct key, distinct fresh B; independent matching observation and nonempty 200 | 1 |
| wrong_credential | Different valid-format synthetic key; nonempty 200, no observation, marked-login cache policy | 0 |
| query_excluded | GET `/login?scope=1` with valid diagnostic inputs; nonempty 200, no observation | 0 |
| protected_redirect | Anonymous GET `/admin`; 307/308 to same-origin `/login`, no query/fragment or observation | 0 |

“Authenticated” refers only to the synthetic diagnostic credential, never a
Supabase session. No application cookies are supplied. Every response rejects
Set-Cookie. Positive/marked login and protected responses require private/no-store;
present CDN-specific cache directives must be `no-store`. No retry, redirect
following, browser script, subresource load or replacement challenge is allowed.
Each request intent is durably recorded before invoking transport; the sequence stops
on the first failure.

## Bounds, evidence and cleanup

| Boundary | Limit |
| --- | --- |
| Workflow / controller | 30 / 24 minutes; stage receives lesser remaining budget |
| Install / build | 8 / 12 minutes |
| Runtime child | 6 minutes total, also bounded by remaining controller time |
| Each inspection / shared startup | 2 minutes / 30 seconds |
| Six requests | Sequential, 10 seconds each; 60-second request phase |
| Response | 16 KiB headers; 1 MiB counted/discarded body |
| Shared application cleanup | 5 seconds for descriptors, sockets, server and Next |
| Supervisor stream closure | Fixed 5 seconds; never extended by late output |
| Owned-service stop/verification | Shared 20 seconds for commands, each at most 10 seconds; at most one final 5-second stream-closure overrun, then 5-second launcher settlement |
| Each child stdout/stderr | 8 MiB, discarded; manager metadata capture at most 16 KiB |
| Final report / retention | 256 KiB / seven days |

Input-bound, ordered phase starts let the external parent watch synchronous work.
The actual order is inspection, startup, requests, cleanup, reinspection, terminal.
Skipped/changed/missing records, backwards time, late phases or total deadline
expiry stop the attempt. Both completed-phase durations and the current phase are
checked, so an overlong operation cannot hide between polls. Startup uses one
deadline across Next preparation and listening. Application cleanup starts both
asynchronous closures against one deadline and attempts remaining actions even
when one fails.

Protocol JSON is capped and canonical, beneath a checked link-free scratch path.
An exclusive pending file is fully written, flushed and closed, then atomically
hard-linked to an exclusive final name. Readers never see a partial final file;
overwrite is forbidden. Interrupted pending files are preserved and never replayed.
The hard link commits publication even if removing its pending name fails. The
controller checks the fixed protocol names after producer shutdown and reports any
pending link beside a published record as `cleanup`, preserving the committed
phase journal and terminal evidence. A cleanup failure prevents qualification.
Only contiguous monotonic pre-request snapshots can recover accounting. Without a
validated terminal report, a request snapshot has `accounting: last_attempt_uncertain`:
`runtime.attempted` counts journaled intents; the actual transport count lies between
`runtime.attempted - 1` and `runtime.attempted`. Valid terminal reports retain exact
counts and `accounting: known`; validated snapshots before any intent confirm zero.
Absent or invalid progress remains unknown. Cleanup fields remain null when unobserved;
partial descriptor installation records whether restoration actually succeeded.

Cancellation aborts the owned launcher and separately stops/verifies the owned
systemd unit and cgroup. Launcher exit alone is not proof of service termination.
The service deadline remains a backstop if the controller is abruptly killed;
such loss does not manufacture a report or successful cleanup. Any failure or
unavailable evidence stops; cleanup failure takes precedence. No broad process
cleanup or host firewall mutation is used.

`systemd-run --pipe` sends runtime stdout/stderr to the bounded discarding supervisor,
not the workflow log or service stdout journal. Setup/build subprocess output is
also discarded. Manager commands capture only requested bounded metadata in memory;
their stderr is discarded. The tools print only fixed result/failure fields and
digests. No raw logs, source/AST/spans/stacks, challenges, headers, bodies or secret
values are uploaded. Ready/progress/phase records remain runner-local; only validated
`gate1-runtime-evidence/report.json` can be uploaded. Ordinary platform unit lifecycle
metadata is not a comprehensive platform logging/privacy qualification.

Primary platform references: [execution controls](https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html),
[systemd-run](https://www.freedesktop.org/software/systemd/man/255/systemd-run.html),
[resource controls](https://www.freedesktop.org/software/systemd/man/255/systemd.resource-control.html),
[termination](https://www.freedesktop.org/software/systemd/man/255/systemd.kill.html),
[duration display](https://www.freedesktop.org/software/systemd/man/255/systemd.time.html).
Metadata parsing accepts exact sets and the documented minute/second display forms
needed here, including `5min 59s`; unknown forms stop rather than weaken validation.

## Offline preparation and next stages

Run the package's Jest config in-band with no cache and the main checkout's existing
dependencies via NODE_PATH. All HTTP, Next, systemd, process launch and time-dependent
execution paths in these suites use mocks; synthetic reader attribution uses VM
fixtures only. Also run the frozen static helper suites, syntax checks, focused
repository ESLint, workflow contracts, Jest discovery and explicit ignored-file
scope/whitespace checks. No dependency install, application build or live service
is part of preparation. Set Windows TEMP/TMP to the repository's `.tmp` directory.

Read-only source/package preparation:

```text
node scripts/gate1-ci-tools/main-8c68fd9e-runtime-attempt-1/qualify-runtime.cjs --prepare <clean-pinned-application-worktree>
```

Only after publication review and workflow registration may a separate review use
`--approval <workflow-sha> <run-number>` to derive the one-run execution digest.
Review must bind immutable identities, operator/owner, exact commands, network
effects, limits, cleanup, report schema, pass/stop criteria and bounded retrieval.
The retrieval budget remains one archive of at most 512 KiB, one report of at most
256 KiB, with independent archive/report hash checks and `--verify-report` using
the approved workflow SHA, run number, run ID and execution digest. Do not dispatch
or retrieve merely because these CLI modes exist.

Publication is a separate approval including ordinary CI and automatic deployment
integrations. Only at an approved PR push update both `docs/feature-memory.md` and
`docs/fixes.md`; use terminal Git. Neither log is part of this preparation scope.
A future `complete_runtime_only` result establishes only bounded isolated CI
behavior. Hosted observer readiness, immutable deployment selection, attributable
hosted execution, manifest comparison and uncovered runtime cases still follow
separately. The controlling Gate 1 plan and its two amendments retain all
non-deferred environment/secret, cache/cookie, limiter/load, application-log,
protection/ingress, ownership/headroom/cost and immutable rollback obligations.
Gate 1 evidence review and separate approval precede remaining Gate 5A evidence
and approval, then Chunk 2/Gate 2; Chunk 3 follows only a passed Gate 2.
