# One bounded build-conflict diagnostic

This offline-default package targets only deployment
`dpl_49owz1V7RHb16gkjdqFhnwJrzzDS`, reviewed source
`50c4a957f6a8d025b8e492ad2833c896b3d6b711`, immutable host
`job-application-tracker-4ermbh0vw-track-the-app.vercel.app`, and recorded Next
build `NkVOoraS7zEuaGAABtan4`. The canonical host and alias timestamp are historical
pins, not fresh observations by this package. Gate 1 remains open, Gate 5A unpassed,
actual runtime unobserved, exact manifests unqualified, and immutable rollback not run.

This is the tracked review copy of the completed diagnostic. Its path, README and
publication tests differ from the frozen local copy, so it has a different digest.
The original execution approval does not transfer. Both copies share the consumed
evidence destination: never execute or replay this attempt from either copy.
Publication grants no deployment change, runtime exercise, qualification decision
or gate pass.

## Purpose and provenance

The consumed identification package has digest
`34482f3c9c006a4b7e3b5563d5087d63d5828abc7794323e8885163402c129bc`.
It sampled the target, source and login build, configured Node 22.x in both settings,
repository root, and matching before/after alias observations. This is configuration
and identity evidence, not proof of runtime execution or secret compatibility.

The subsequent consumed build-attribution package has digest
`f5ca16f68d6d6620524dfb37d59d52693fcb06c546cb6f168328c7b4e2aac714`.
Its report ended at `2026-11-15T23:12:08.200Z`, stopped in `builds` with
`attribution_conflict`, after three provider dispatches and one login GET. Initial
alias, login and deployment observations matched; later events/login/alias phases
did not run. The exact conflicting field was discarded. This does not prove that
the older HqjFQpAa deployment's Node 24 metadata conflict recurred.

The implementation adapts the preserved HqjFQpAa diagnostic, digest
`9df854c94a82f95f4165638c905f22bf35468f582623a4bbd592c0a6741b0342`.
That package/evidence is consumed and unchanged. The new child pins and calls the
current 49owz1V7 attribution projector as authority, classifying only its existing
`attribution_conflict`. All other failures retain their stop behavior. Preparation
pins the current attribution package and its three evidence files; its complete
transitive manifest binds identification, source, dependencies and historical evidence.

## Completed local observation

The owner separately approved and consumed the frozen local package digest
`abf74f5a5a02a155d43ae559ea1ea5065c4138b0d6d32c44e6a116012153215c`.
The single builds GET finished at `2026-11-15T23:47:58.994Z` after 2,769 ms,
with one provider dispatch and zero application requests. The retained diagnosis was:

```text
classification: conflict_identified
reason: output_node_runtime_mismatch
nodeMajors: [null, 24]
nodeMajorSlotOrder: output_runtime_then_lambda_runtime
outputClassification: middleware
qualification: unqualified_metadata_only
historicalCause: not_proven_same_response
```

This identifies Node 24 in a middleware output's lambda-runtime metadata slot,
not actual execution. The other slot has no safely retained concrete major.
No identity-mismatch guard fired before the runtime conflict; no fresh alias or
deployment observation was performed. The new sample cannot establish the exact
cause of the earlier discarded response. Gate 1 remains open.

Postflight verified the approved manifest, all five component hashes, the exclusive
three-file consumed reservation, and preservation of 23 earlier frozen files.
The local evidence files are not included in this PR. Their SHA-256 values are:

- `profile.json`: `fbc63dd7466d2ec54c4d9df7a754d053ded36e462ed9742b330ee737f065059a`
- `reservation.json`: `39cd6ab40342ecc249ab973e0f814b7e04f7857f9c730acf1cee49747ade2321`
- `report.json`: `1d13130c4c187d35612dda27cb58b34dfeaa71dc714e0afb10bd10ed5ecae1fa`

Read AGENTS.md, both Gate 1 amendments and the historical remediation plan together.
The plan remains at SHA-256
`4120e505e7d5c7c21c9b011a2b9b53665fdb7e249c96c884eaeeab0787eba64f`.
The source/WAF deferrals do not waive Node 22, application load, cache/cookies,
secret-snapshot compatibility or immutable application rollback. Preserve the
closed artifact investigation, parked diagnostics and existing approval boundaries.

## Retained diagnosis

The Node 22 guard and original guard order are preserved, including runtime checks
on unrecognized output paths. The first observed conflict has one fixed reason:

| Reason | `nodeMajorSlotOrder` | `nodeMajors` |
| --- | --- | --- |
| `response_deployment_mismatch` | `not_applicable` | Empty |
| `response_project_mismatch` | `not_applicable` | Empty |
| `build_deployment_mismatch` | `not_applicable` | Empty |
| `output_runtime_fields_disagree` | `output_runtime_then_lambda_runtime` | Two nullable majors |
| `output_node_runtime_mismatch` | `output_runtime_then_lambda_runtime` | Two nullable majors |
| `duplicate_route_runtime_disagrees` | `previous_then_current_projected_runtime` | Two nullable majors |

Each retained major is an integer from 0 through 999 parsed from a complete canonical
Node token. Null means no safely retained concrete major; it does not prove an absent
runtime field or Edge execution. The original guard's broader Node grammar is unchanged.
Duplicate slots describe projected declarations, not raw strings or executed runtimes.

`outputClassification` is exactly one of:

- `known_application_route`: a bounded path matches the pinned source-route allowlist,
  with only the existing optional leading-slash normalization.
- `middleware`: the path is exactly `_middleware` or `/_middleware`.
- `unrecognized_output`: neither allowlisted case applies, including missing, non-string,
  oversized, encoded, URL-shaped or otherwise unrecognized paths.
- `not_applicable`: an identity conflict or a fresh sample without a reproduced conflict.

Classification does not trust `output.type` and never retains the path. Duplicate
runtime conflicts can only classify as known application route or middleware because
the authority compares recognized outputs only. A known route does not prove execution;
an unrecognized output is not presumed harmless or platform-owned. Identity fields
that are absent are not positive attribution evidence.

Both child and parent validate the strict receipt. Raw IDs, arbitrary paths, runtime
strings, provider payloads, headers, cookies, secrets and error text are discarded.
Every result retains `unqualified_metadata_only` and `not_proven_same_response`.

## Consumed live scope

One provider GET only:
`/v11/deployments/dpl_49owz1V7RHb16gkjdqFhnwJrzzDS/builds?teamId=team_7o3efmwjZbMc2Bfy9qAzkc9q`

Zero application requests; concurrency one; 45 seconds overall; 30 seconds per child;
10 seconds per HTTP exchange including the body. Caps: 1 MiB response, 16 KiB headers,
128 KiB each for IPC messages and discarded child output, 256 KiB sanitized report,
64 builds and 2,048 outputs total (also enforced per output list). These preserve the
reviewed diagnostic limits. No events or streaming feed, retries, redirects, pagination,
authentication refresh, telemetry upload or private input is permitted.

The CLI may use its existing managed authorization and make normal device/session
metadata writes only during the separately approved live attempt. Missing authorization
stops. Never read credential storage or `.env` files directly or request a secret in chat.

An exclusive reservation creates only `profile.json`, `reservation.json` and `report.json`
under `.tmp/gate1-rollback/replacement-49owz1V7-build-conflict-attempt-1/`.
Partial creation, failure or cancellation consumes the attempt. Never modify or reuse
old evidence, replay this destination or erase a reservation. There are no alias/project
reads, event reads, logins, runtime probes, fixture refreshes, deployments, routing or
secret changes, restarts, rollback actions, installs or builds in this scope.

## Local checks and publication

Use the existing dependencies and clean reviewed source worktree, running from the
checkout containing this tracked package. This operator package requires the preserved
qualification workspace: the current attribution and identification helpers under
`.tmp/gate1-rollback-tools/`, their evidence, transitive historical dependencies, and
the pinned installed Vercel CLI. A fresh clone alone cannot run preparation or these
operator integration tests. `GATE1_REVIEW_WORKSPACE` selects that nonsecret workspace;
`GATE1_VERCEL_CLI_DIST` can select the already installed CLI, whose pins must still match.
No credentials or raw provider payloads are included here. The following is read-only:

```powershell
$repo = 'C:\Users\willm\job-application-tracker'
$env:TEMP = Join-Path $repo '.tmp'
$env:TMP = $env:TEMP
$env:NODE_PATH = Join-Path $repo 'node_modules'
$env:GATE1_REVIEW_WORKSPACE = $repo
$env:NODE_DISABLE_COMPILE_CACHE = '1'
$package = 'scripts/gate1-rollback-tools/build-conflict-49owz1V7-attempt-1'
node (Join-Path $package 'diagnose-builds.cjs') --prepare
```

Preparation hashes all five files including this README. Run isolated offline Jest
with the package as rootDir, Node environment, `**/__tests__/*.test.cjs`, no transforms,
`js/cjs/json` extensions, runInBand and cache disabled; keep any cache under repo `.tmp`.
Run four `node --check` checks, focused ESLint, whitespace and source/dependency/frozen
evidence preservation checks. Tests mock all transport, CLI imports, authorization,
child processes and evidence writes; preparation integration checks Git read-only.
Use normal sandbox escalation for blocked read-only Git/Node subprocesses. Never
consume a live reservation to test permissions. The original local tests and package
remain frozen. The tracked tests locate their own components and verify read-only
preparation leaves an unused or consumed evidence destination unchanged; explicit
no-replay and partial-reservation tests still reject every reuse. A separate test
rejects the original consumed digest on this tracked copy before side effects.
The ordinary CI unit configuration does not run these dedicated operator suites.

Do not invoke `--execute` for this consumed attempt. Any future diagnostic would
require a specific owner decision, new scope, fresh destination, reviewed package
and separate exact-digest approval; publication schedules none.

## Firm stopping point and Gate 1

An identity mismatch stops affected qualification pending attribution correction.
A runtime metadata conflict is reported with its exact fixed category, nullable
majors and safe output class; it is not called actual execution. A non-conflicting
fresh response is `not_reproduced` and inconclusive, including missing metadata.
It cannot explain or erase the discarded historical failure. Both outcomes exit
without a qualification pass. Authentication, transport, schema, cap, deadline,
dependency/source drift or checkpoint failure ends this attempt without retry.

If this focused round still cannot distinguish an application issue from an
evidence-method limitation, return the specific gap, its Gate 1 consequence and
the required owner correction or qualification decision. Do not automatically
create another diagnostic, rerun attribution, redeploy or weaken the Node guard.

If identity remains sound, propose separately approved target-bound runtime
verification with current probe-readiness confirmation and private masked input.
It must not silently override conflicting metadata, qualify all functions or
substitute for exact manifests. Given the observed middleware classification,
session-route-only runtime evidence would leave the middleware conflict unresolved.
Any middleware execution method needs its own bounded proposal and approval.
No current alias or deployment bracket is collected
here; their prior samples remain historical. Dispatch receipts are not an independent
physical HTTP audit.

Remaining non-deferred Gate 1 evidence and immutable A/B/A prerequisites still apply.
This package does not freeze deployment A, qualify secret-snapshot/HMAC continuity,
perform rollback or approve either gate. Preserve the sequence: Gate 1 approval,
remaining non-deferred Gate 5A evidence and separate approval, Chunk 2/Gate 2, then
Chunk 3 cutover only after Gate 2.
