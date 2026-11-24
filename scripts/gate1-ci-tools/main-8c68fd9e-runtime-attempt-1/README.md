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
`CollectMode=inactive-or-failed` is explicitly set and its effective value is
verified before release. This permits failed transient units to be collected;
the default `inactive` policy retains failed-state metadata even after processes
exit. The setting alone does not prove that collection or cleanup has completed.
The runner contract does not provision `/run/user`; confirmed absence skips only
that path's checks. If present, it requires its own read-only mount. All other
protected paths and both write exceptions remain required.

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

## Fixed isolation diagnostics

The existing `failure` field additionally accepts 67 fixed isolation identifiers.
`runtime-probe.cjs` owns the frozen `SERVICE_CODES` map and `ISOLATION_CODES`
allowlist. Report fields and structural schema version remain unchanged; final
report verification and independent upload validation consume the same finite
vocabulary. No prefix wildcard is accepted. Generic `isolation` remains valid
for historical records and the existing unclassified pre-release fallback.

Every suffix in the following tables has the literal prefix `isolation_`.
For example, `memory_limit` means `isolation_memory_limit`. Implementation values
are fixed literals selected only by known guards, never assembled from observed
paths, property names/values, command output, exception messages or provider data.

| Service configuration / metadata check | Code suffix |
| --- | --- |
| `serviceArgs`: invalid unit, UID/GID, duration or configured path | `service_config` |
| `parseProperties`: byte cap exceeded | `service_metadata_size` |
| Disallowed control characters | `service_metadata_encoding` |
| Malformed property assignment | `service_metadata_format` |
| Duplicate or unexpected property | `service_metadata_keys` |
| Missing requested properties | `service_metadata_missing` |
| `validateService`: incorrect property-object shape | `service_metadata_shape` |

Each effective-property mismatch in `validateService` has its own identifier.
Malformed/out-of-range duration parsing receives the same fixed code as that
property's value mismatch. Standalone `duration` calls retain generic `isolation`
unless supplied a property code. Original comparison and short-circuit order,
accepted sets, numeric limits and duration representations are preserved.

| Effective service property | Code suffix |
| --- | --- |
| `PrivateNetwork` | `service_private_network` |
| `PrivateTmp` | `service_private_tmp` |
| `NoNewPrivileges` | `service_no_new_privileges` |
| `ProtectSystem` | `service_protect_system` |
| `ProtectHome` | `service_protect_home` |
| `ProtectControlGroups` | `service_protect_control_groups` |
| `CapabilityBoundingSet` | `service_capability_bounding_set` |
| `AmbientCapabilities` | `service_ambient_capabilities` |
| `RestrictAddressFamilies` | `service_restrict_address_families` |
| `RestrictNamespaces` | `service_restrict_namespaces` |
| `MemoryMax` | `service_memory_max` |
| `MemorySwapMax` | `service_memory_swap_max` |
| `TasksMax` | `service_tasks_max` |
| `KillMode` | `service_kill_mode` |
| `SendSIGKILL` | `service_send_sigkill` |
| `Restart` | `service_restart` |
| `LimitCORE` | `service_limit_core` |
| `CollectMode` | `service_collect_mode` |
| `User` | `service_user` |
| `Group` | `service_group` |
| `ActiveState` | `service_active_state` |
| `SubState` | `service_sub_state` |
| `LoadState` | `service_load_state` |
| `Type` | `service_type` |
| `ControlGroup` | `service_control_group` |
| `CPUQuotaPerSecUSec` | `service_cpu_quota` |
| `RuntimeMaxUSec` | `service_runtime_max` |
| `TimeoutStopUSec` | `service_timeout_stop` |
| `TimeoutStartUSec` | `service_timeout_start` |
| `WorkingDirectory` | `service_working_directory` |
| `ReadOnlyPaths` | `service_read_only_paths` |
| `ReadWritePaths` | `service_read_write_paths` |

| Child kernel check in `verifyKernel` | Code suffix |
| --- | --- |
| Oversized pseudo-file contents | `kernel_metadata_size` |
| Invalid network namespace identifier or namespace equals the parent's | `network_namespace` |
| Interface set differs from loopback only | `network_interfaces` |
| Incorrect cgroup membership | `cgroup_membership` |
| Invalid CPU quota representation or ratio | `cpu_limit` |
| Incorrect memory limit | `memory_limit` |
| Incorrect swap limit | `swap_limit` |
| Incorrect task limit | `tasks_limit` |
| Missing required `NoNewPrivs` state | `no_new_privileges` |
| Nonzero or malformed effective capabilities | `effective_capabilities` |
| Nonzero or malformed bounding capabilities | `bounding_capabilities` |
| Missing required seccomp state | `seccomp` |

| Path / mount check in `verifyMounts` | Code suffix |
| --- | --- |
| `/run/user` is not a directory or checking it fails other than confirmed absence | `path_run_user` |
| Configured path is nonabsolute or noncanonical | `path_canonical` |
| Mount-table input is invalid, empty or oversized | `mount_table_input` |
| Mount or superblock options lack one unambiguous access mode | `mount_options` |
| Malformed mount-table row | `mount_table_format` |
| No covering mount | `mount_missing` |
| Present `/run/user` lacks its own mount | `mount_run_user` |
| Duplicate deepest covering mount | `mount_ambiguous` |
| Effective access mode violates the existing requirement | `mount_mode` |
| Writable protected descendant outside permitted exceptions | `mount_descendant` |

The existing `/run/user` own-mount requirement is unchanged. A prior synthetic
parent-mount experiment did not establish a reachable defect under the complete
service configuration; it is not evidence of the cause of run 2.

| Handshake check | Code suffix |
| --- | --- |
| Parent readiness deadline expires before checking the ready record | `ready_deadline` |
| Bound ready record lacks `kernelVerified: true` | `ready_record` |
| Parent readiness deadline expires during service verification | `release_deadline` |
| Launcher finishes before the parent releases the child | `release_race` |
| Child release deadline expires while waiting or validating a release | `child_release_deadline` |
| Child release fields, input binding, verification claim or timestamp are invalid | `child_release_record` |

A code identifies the rejected check, not necessarily its root cause, the observed
value or a complete execution history. Unobserved checks receive no invented code.
Canonical-byte/context failures still use their existing schema/digest codes;
unexpected I/O errors continue through existing sanitization, ordinarily `internal`.
Metadata parsing used during service cleanup does not bypass cleanup precedence.

Before release, only the existing canonical, input-bound, schema-valid, untouched
failed child record may refine a launcher failure. A specific code leaves
`runtime: null` and `accounting: unknown`; it does not attest to zero requests.
Missing, malformed, unbound, extra-field or unsupported-code records remain
untrusted. Cleanup failure still supersedes a specific isolation failure. No
additional primary/cleanup fields are introduced to recover that lost detail.

Service controls, acceptance/rejection conditions, deadlines, request budgets,
cancellation, failed-unit collection and evidence-publication rules are unchanged.
The consumed run-2 report remains `stopped` / `runtime` / `isolation`, with unknown
accounting and successful cleanup qualification. Its exact failed guard remains
unknown; these diagnostics do not reinterpret or amend that evidence.

Offline fixtures cover every code's guard, child sanitization, strict parent
recovery, report validation and independent upload staging. They use synthetic
metadata and mocked execution; they establish no actual systemd/runner behavior.
Any package-file edit changes the package digest. Preserved reports need their
original tooling/context, and consumed package/execution approvals cannot be reused.

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

A failed startup can journal its expired startup-to-cleanup transition and retain
observed descriptor restoration and close settlement in a validated stopped report.
This exception cannot qualify success or extend cleanup, other phase, or total
deadlines; the live watchdog retains its strict checks. `nextClosed` means only
that the returned `next.close()` promise settled within the cleanup budget.
The public Next API hides cleanup-listener outcomes, so this field does not attest
to listener success. A rejected close still fails cleanup; a late settlement
never upgrades the flag. Expired bounds still observe already-started rejections.

Protocol JSON is capped and canonical, beneath a checked link-free scratch path.
An exclusive pending file is fully written, flushed and closed, then atomically
hard-linked to an exclusive final name. Readers never see a partial final file;
overwrite is forbidden. Interrupted pending files are preserved and never replayed.
The hard link commits publication even if removing its pending name fails. The
controller checks the fixed protocol names after producer shutdown and reports any
pending link beside a published record as `cleanup`, preserving the committed
phase journal and terminal evidence. A cleanup failure prevents qualification.
Final report publication also commits at the hard link. A subsequent pending-file
unlink failure preserves `reportSha256`, returns `cleanupFailure: cleanup` separately
from the immutable report, and makes the CLI exit unsuccessfully.
Only contiguous monotonic pre-request snapshots can recover accounting. Without a
validated terminal report, a request snapshot has `accounting: last_attempt_uncertain`:
`runtime.attempted` counts journaled intents; the actual transport count lies between
`runtime.attempted - 1` and `runtime.attempted`. Valid terminal reports retain exact
counts and `accounting: known`; validated snapshots before any intent confirm zero.
Absent or invalid progress remains unknown. Cleanup fields remain null when unobserved;
partial descriptor installation records whether restoration actually succeeded.
Before release, only an input-bound, schema-validated failure record with an
allowlisted category can refine the launcher failure. Runtime/request accounting
stays unknown; pre-release success or malformed evidence cannot qualify the run.

The runtime adapter requires string build/hash fields and the exact manifest key
set before delegating inspection validation to the unchanged static package.
Native caller offsets recognize LF, CR, CRLF as one ending, U+2028 and U+2029.

Cancellation aborts the owned launcher and separately stops/verifies the owned
systemd unit and cgroup. Launcher exit alone is not proof of service termination.
After launcher settlement, an unloaded or inactive/dead unit still requires an
absent or empty cgroup and no owned jobs. A loaded failed/failed unit with those
same resource checks is pending collection, never a successful final result.
The parent polls it at the existing 50 ms cadence, sharing the original five-second
deadline with launcher settlement and all final metadata reads/waits. Collection
must be observed within that bound; it grants no extra time or runtime attempt.
Other failed final checks retain one owned stop-and-recheck attempt within that
same deadline. Active units, persistent failed units, queued jobs, populated
cgroups or unavailable metadata cannot qualify cleanup. Successful cleanup
preserves the original allowlisted failure; cleanup failure still takes precedence.
Collection discards unit failure-state metadata; it does not establish the cause
of a historical failed run or prove a live-process leak. These offline contracts
and mocked regressions do not establish a real runner or gate pass.
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
report bytes can be uploaded. Qualification emits the committed `reportSha256`
through Actions output even for stopped runs and post-commit pending cleanup
failures. Validation runs from an independent `validation-tooling` checkout of the
approved workflow revision, checks its head and package against the approved
context, and receives that output as its expected digest. This also permits a
stopped `tool_identity` report when the original tooling checkout drifted.
The verified snapshot is written exclusively to `gate1-runtime-upload/report.json`;
the upload step reads that snapshot, without rereading the original report.
Ordinary platform unit lifecycle
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
fixtures only. For this diagnostic change, run all five runtime-package suites,
including the existing workflow contracts, plus changed-JavaScript syntax checks,
focused repository ESLint and exact changed-file scope/whitespace checks. Verify
the frozen static dependency through read-only package preparation. No dependency install, application build or live service
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
