# Gate 1: exact-source static CI qualification tooling

The owner approved this package's preparation and then its 11-file PR publication
scope against staging, including the workflow-location adaptation, test registration
and both PR logs. Ordinary PR CI/deployment integrations are included in that
publication; dispatch of this manual qualification is not approved. Its dependency
downloads, build and report upload still require separate execution approval.
Gate 1 is **open**; Gate 5A is **unpassed**. The operator and operational owner must
be named in the later execution approval. A passing report qualifies static
observations only.

## Reconciled source and historical outcome

Application commit: `8c68fd9e58f717ff766f39fe4c90325fc113e722`.
Tree: `20f38b86ff6e44ee38d504a8d899f33fc016134a`.
Committed lockfile SHA-256:
`f6af332dffbbbcbd8aca4b816201fa5756e25d2e7249e1cd2c0cd9c3343b9f1a`.
The 362 selected application blobs match historical source `24106d4e`; whole trees
and deployment identities differ. Main was rechecked unchanged during reconciliation.
CI [44389528901](https://github.com/willmclaughlin03/jobApplicationTracker/actions/runs/44389528901)
passed its recorded install/lint/tests/build/protected-page/Sharp checks. Its artifact
listing remains empty. Its Sharp step starts a server; this draft does not reuse that
job. No exact Node patch is inferred from that historical run.

The frozen local package `.tmp/gate1-build-tools/main-8c68fd9e-compiled-attempt-1/`
passed 105 tests plus a separate 23-test alternate-reader run, syntax, lint and
preservation checks. Its read-only archive check verified 362 files, 432 entries,
4,733,007 payload bytes and archive SHA-256
`fded34f21326496f31632c7dd86818c568e42e64e883310af67e8facf29d27ce`.
This established archive agreement, not successful container extraction or build.

The separately approved local execution consumed digest
`47f1cc9a185c70e407b01a9ab3784f17be9c9943bac49e93e41390cb33d4fa4d`.
Its exact terminal report was:

```json
{"schemaVersion":1,"source":"8c68fd9e58f717ff766f39fe4c90325fc113e722","digest":"47f1cc9a185c70e407b01a9ab3784f17be9c9943bac49e93e41390cb33d4fa4d","gate1":"open","result":"stopped","failure":"storage","containerStopped":true,"terminal":null}
```

The stage, request count and storage cause are unknown. The category also covers
filesystem-monitoring errors; it does not prove capacity exhaustion or an application
defect. `containerStopped` is the runner's cleanup report, not proof the container
was created. Controller exit zero did not qualify this stopped attempt. The local
harness is parked. No replay, state-tree inventory, raw-log inspection or deletion
is authorized. Docker Desktop was not shut down in that session.

Frozen local evidence directory: `.tmp/gate1-build/main-8c68fd9e-compiled-attempt-1/`.

| Evidence | SHA-256 |
| --- | --- |
| profile.json | `7d272066fe390767b4abc30bb7267b4739948fcac6e61da9ab5a62c3414fbd2f` |
| reservation.json | `e6dfde8296364d848c6b4119285969e275a12b7c054e6714550d8a4129f954a8` |
| report.json | `885c2d09c19379405675cc4a90654e2d6917e336b63586a2fab6f4648c1bb92b` |

Those gitignored records are not bundled with a clean clone. Their files, the
consumed package README and both historical `main-24106d4e` packages stay unchanged.
No source or WAF waiver is expanded. Read AGENTS.md and both Gate 1 amendments with
`docs/UIDesign/error-pages-auth-correctness-remediation-plan.md`, whose SHA-256 is
`4120e505e7d5c7c21c9b011a2b9b53665fdb7e249c96c884eaeeab0787eba64f`.
The previous artifact-privacy scanner stays closed as inconclusive.

## Package provenance and publication layout

The frozen local preparation directory is
`.tmp/gate1-ci-tools/main-8c68fd9e-static-attempt-1/`, with digest
`ba2c3a081abb307d355d0bc0961f10a29f7d3149adde3925fa7fdc4123ef0165`.
It stays unchanged. The publication has seven files under
`scripts/gate1-ci-tools/main-8c68fd9e-static-attempt-1/` and the manual workflow at
`.github/workflows/gate1-static.yml`. The runner and workflow tests resolve that
location in a clean clone. Publication wording and regression coverage also changed,
so the published package has a new digest; the local preparation digest cannot
authorize it. Preserve LF bytes when checking out the published tools for review.
The hash uses eight logical names, and the final Git revision is bound separately,
avoiding a circular commit hash. The registered Jest configuration and two PR logs
are outside this eight-file execution package but included in its publication commit.

Publication uses an isolated staging-based PR branch with both approved PR log edits.
The manual workflow has no push or PR trigger and no deployment step; existing
repository integrations may run on publication. GitHub requires a workflow on the default branch for
[manual dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
The final main/tool revision can differ from the fixed application commit; this
workflow checks them out independently. Reconcile later application changes before
reusing this evidence; never silently retarget this package.

## Future execution contract, not authorization

- One `workflow_dispatch` on main, for one approved workflow SHA and run number,
  with `run_attempt=1`. A rerun or a new dispatch under the same approval fails the
  run-number/attempt binding before installation. A missed number is a stop, not a
  reason to choose another number automatically. The execution digest binds all
  package bytes, target identity, limits, workflow revision and run number.
- Ubuntu 24.04 Linux x64, Node 22.23.3, npm 10.9.9, Next 16.3.3, React and React DOM
  18.3.1, Acorn 8.15.0. Node/React guards remain strict. Actual versions are reported.
  Conflicting bounded versions remain in a stopped report; arbitrary text is dropped.
- 30-minute job ceiling. Two checkout steps each have 2 minutes; Node setup has 3;
  the controller step has 25 and a shared internal 24-minute budget. Install has 8,
  build 12, inspection 2, individual Git/version commands 30 seconds. Child closure
  has at most 5 seconds after termination. Upload has 2 minutes. All steps share the
  job ceiling; cancellation may prevent a terminal report, which remains unqualified.
- The standard public-repository runner currently provides 4 CPUs, 16 GB RAM and
  14 GB SSD. These are [platform allocations](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
  not custom process quotas or guaranteed free disk. No recursive workspace monitor,
  Docker image, extra disk or larger runner is requested. Exhaustion stops the run.
- Source reads are capped at 128 MiB/4,096 selected files. The exact pinned target has
  362 selected files. CI verifies their committed Git blob IDs and exact LF lockfile
  bytes before and after installation/build/inspection. Host preparation reads the
  committed manifest/lock and clean identity, but does not claim CRLF checkout bytes
  are the Linux build inputs.
- The original inspector limits remain: 1,024 emitted server JS files, 16 MiB each,
  128 MiB total, 2,000,000 AST nodes, and 10,000 trace entries. An unsupported layout
  fails; no alternative layout is silently accepted. Source text, AST spans and
  arbitrary output names never enter the report.

Exact application commands, supervised with discarded raw stdout/stderr:

```text
npm --version
npm ci --no-audit --no-fund --include=dev
npm run build
node <reviewed-package>/qualify-static.cjs --inspect <exact-application-checkout>
```

The inspection child receives only the source route inventory on bounded stdin and
returns a bounded fixed-schema result. There is no `npm start`, Sharp request,
runtime getter instrumentation, readiness GET, browser or application probe.
`applicationProbeCount=0` means this path issues no application probes; it is not
a claim that installation/build made no network calls.

Unlike the offline Docker attempt, GitHub/Node setup, locked npm dependency downloads
and artifact service traffic require network access. Ordinary dependency lifecycle
scripts, including root patch-package, run during npm ci. Npm retries, audit, funding,
update notification, cache reuse and retained npm debug logs are disabled. The runner
does not enforce a network firewall. Use only the four existing synthetic CI build
values; no hosted credentials, Redis/HMAC configuration, probe key or probe enablement
is inherited. Next telemetry is disabled. No credentials are persisted by checkout.
Application child environments omit GitHub tokens and action command-file paths.
The build still executes application code at build time; this is static evidence,
not an assertion that no code ran.

## Evidence, retention and acceptance

The runner exclusively creates `gate1-static-evidence/` and `gate1-static-scratch/`
in the ephemeral workspace. The former contains a consumed reservation and final
report. The latter contains synthetic home/temp/npm cache/empty npmrc files.
Application-generated dependencies and .next remain on the ephemeral runner.
No broad cleanup deletion is performed; runner decommissioning is provider-owned,
not a verified secure-erasure claim. The report records child closure only.

Upload exactly `gate1-static-evidence/report.json`, a regular file no larger than
256 KiB, with 7-day retention and no overwrite/hidden files. Treat it as public
evidence. Never upload .next, source maps, generated code, caches, .env files, raw
logs, response data or credentials. Action/setup logs and fixed sanitized summaries
remain under ordinary repository log retention; this package does not change it.
Build/install child streams are discarded and individually capped at 8 MiB.

The report includes exact source/tree/lock, package and execution digests, workflow
revision, run ID/number/attempt, actual versions, stage/failure, fixed diagnostic
facts, build ID, five manifest hashes, trace/closure hashes, matcher/page/reader
facts, zero probe count and child-closure status. Known application route versus
unrecognized output is classified without retaining the route name. No string or
AST match is promoted to proof of a native runtime read.

The upload validator rejects unknown fields or mismatched identities. Later,
download only this selected artifact under a separately approved bounded retrieval.
Verify its service archive digest, exactly one regular member, byte cap, the report
SHA-256 printed by validation and its full target/run schema. The local
`--verify-report` command handles the final report hash/schema checks; it neither
downloads nor extracts an archive. GitHub's default digest mismatch is a warning,
so it must not be treated as acceptance. See [artifact documentation](https://docs.github.com/en/actions/tutorials/store-and-share-data).
Missing identity/hash/artifact access means unavailable evidence; no retry follows.

Success is `complete_static_only` with complete inspection, exact versions and child
closure. Failure is `stopped`, with fixed stage/category; no server-runtime or gate
pass follows either result. Setup failure/cancellation before a report is unavailable
evidence. One failed/inconclusive run returns for a correction or evidence-method
decision; no automatic replay, raw-log diagnosis, resource increase or relaxed guard.

After static success, separately propose the six runtime cases: ordinary login,
two authenticated fresh challenges, wrong credential, query-excluded login and
anonymous admin redirect. A new runtime build must qualify its own compiled outputs.
Then separately address hosted readiness, immutable deployment identification and
attributable execution. Environment isolation, cache/cookies, application limiter/load,
log privacy, resource headroom/ownership and immutable A/B/A rollback remain due.
The source/WAF deferrals and closed scanner do not waive these requirements.

## Local-only preparation commands

Set TEMP/TMP to the repository `.tmp`, NODE_PATH to its existing node_modules, and
NODE_DISABLE_COMPILE_CACHE=1. Use the existing Node 22 host and installed test tools.

```text
node <repo>/node_modules/jest/bin/jest.js --config <package>/jest.config.cjs --runInBand --no-cache
node <repo>/node_modules/jest/bin/jest.js --config jest.gate1-build-tools.config.cjs --runInBand --no-cache
node --check <each of the six CJS files>
node <package>/qualify-static.cjs --prepare <clean selected source worktree>
```

Run focused repository-config ESLint, YAML/workflow contract checks, whitespace and
preservation checks. Synthetic scratch fixtures stay inside `.tmp/gate1-ci-tests/`
and remove only their own verified directory. Tests mock process execution and use
synthetic manifests; they never install, build, contact Docker or send requests.
No broad application suite is repeated locally. Before publication adaptation, the
local preparation passed **106 tests
across three suites**, all six CJS syntax checks and focused repository-config ESLint
with zero warnings/errors. Workflow YAML and its trigger/approval/upload contract
are covered by the focused suite. Tests cover source drift, exact version guards,
partial failures, deadlines/stream limits/closure, report caps, duplicate-key
rejection, manifest/route/reader failures and absence of server/probe commands.
The test lockfile fixture uses the selected local worktree when present, or the
repository lockfile in a clean publication checkout; its committed digest must match.
Read-only preparation verified the clean selected commit/tree, committed lock and
362-file inventory. Its manifest SHA-256 is
`c97d1f5080c6674b97151e06d68f20a337cbe9b2c5014e00e9dd28a461a77c87`.
The final package digest is returned separately because it includes this README.
No dependency installation, application build, CI execution or live qualification
occurred during those local checks. Publication adds two workflow-location regressions
and registers the static suites alongside the existing build-tool suites; final
publication validation passed **294 tests across eight registered suites** (108
static-package tests and 186 existing build-tool tests). The new package digest is
recorded separately in the PR review because it includes this README.

After promotion to main and workflow registration, compute a separate review-only
execution digest with `--approval <final-workflow-SHA> <approved-next-run-number>`
using the reviewed published package, not the frozen local draft. Review that digest, run identity and external
effects before any dispatch. Reconcile the operator/owner, action availability,
artifact access/retention and current main at that time. Local preparation alone
never supplies execution approval.
