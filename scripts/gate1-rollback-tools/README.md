# Gate 1 secret-redeployment identification

This operator package preserves the previously in-memory identification runner.
It identifies the canonical Production deployment following the owner's reported
`GATE1_RESTART_PROBE_SECRET` replacement. Preparation is read-only and offline.
Publishing the package does not execute or authorize hosted qualification.

The owner attested that canonical Production was redeployed, only the restart-probe
secret changed since the successful fixture test, the probe remains enabled, and
its matching secret is saved privately. These are configuration-history statements,
not provider observations. This package never requests the probe secret.

## Local prerequisites

The runner is intentionally bound to the existing Windows qualification workspace.
It requires the clean `f3c62a4d221fa39e920c0b5faecb61f1add7bab4` source worktree,
the preserved identification/fixture reports, the controlling local plan/amendments,
and the pinned Vercel CLI 62.2.0 installation. `LOCAL_PINS` and `PINS` enumerate
the required paths and SHA-256 values. Those local evidence artifacts and credentials
are not included in this PR. A fresh clone alone cannot satisfy preparation.

- `GATE1_REVIEW_WORKSPACE` optionally names the existing qualification workspace.
  Its default is this repository root. It also fixes the evidence and TEMP/TMP root.
- `GATE1_VERCEL_CLI_DIST` optionally names the existing CLI `dist` directory.
  Its default is the previously reviewed npm-cache location under the current
  Windows user's home. Every listed CLI hash must still match.
- Both paths are nonsecret configuration, included in the approval manifest and
  passed unchanged to hidden provider children.
- Use installed dependencies from the qualification workspace. `NODE_PATH` can
  point at that workspace's `node_modules` when running from a linked checkout.

Do not read `.env` or CLI credential storage directly. Only the CLI loads its own
saved authorization during an approved live run. Expired/missing authorization
stops the attempt without token refresh, login, retries, or an expanded query.

## Preparation and offline checks

From the checkout containing these scripts, with the optional nonsecret paths set:

```powershell
node --check scripts/gate1-rollback-tools/identify-redeployment.cjs
node --check scripts/gate1-rollback-tools/provider-read-child.cjs
node --test scripts/gate1-rollback-tools/__tests__/identify-redeployment.test.cjs scripts/gate1-rollback-tools/__tests__/provider-read-child.test.cjs
node scripts/gate1-rollback-tools/identify-redeployment.cjs --prepare
```

The tests use synthetic transports and an in-memory filesystem. They read the
preserved local dependencies to verify the actual helper integration and package
pins. They neither load CLI authorization nor create live evidence files.
The repository's standard CI does not automatically run these Node `.cjs` suites.

Preparation prints a manifest and digest, without creating evidence. The digest
covers the profile, both runners, both test files, dependency pins, workspace/CLI
locations, and local Node version. Review the exact result before requesting live
authorization. The original `.tmp` package's digest does not approve this PR copy.

## Separately authorized identification

After approval of the exact prepared package:

```powershell
node scripts/gate1-rollback-tools/identify-redeployment.cjs --execute <approved-package-digest>
```

The fixed sequence is canonical alias metadata, that deployment's metadata,
project metadata with `rollbackInfo=true`, anonymous canonical `/login`, then
canonical alias metadata again. The limits are four provider GETs, one application
GET, concurrency one, ten seconds per HTTP request, thirty seconds per provider
child, and 120 seconds overall. Bodies are capped at 1 MiB and retained reports at
32 KiB. Redirects, retries, token refresh, telemetry uploads and CLI update checks
are disabled. Normal CLI device/session metadata writes and ordinary application
request logging/limiter effects remain part of the proposed live scope.

Before dispatch, the runner exclusively reserves the following fresh paths beneath
the qualification workspace:

```text
.tmp/gate1-rollback/secret-redeploy-identification-attempt-1/profile.json
.tmp/gate1-rollback/secret-redeploy-identification-attempt-1/reservation.json
.tmp/gate1-rollback/secret-redeploy-identification-attempt-1/report.json
```

The directory must not already exist. Preserve consumed reservations and failed or
partial reports. A failure, timeout, alias drift, source change, uncertain child
outcome, or failed evidence checkpoint stops the exercise. It grants no replay.
Missing authorization or unavailable evidence requires a new decision.

Success establishes sampled canonical deployment/source/build correspondence only.
The project Node setting is not the function's observed exact runtime. Runtime
observation, authenticated fixture refresh, complete environment compatibility,
deployed manifests, and the immutable A/B/A rollback drill retain their separate
requirements and approvals. Gate 1 remains open and Gate 5A remains unpassed.
