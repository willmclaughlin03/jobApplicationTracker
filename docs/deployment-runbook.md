# Deployment Runbook

## Baseline Recorded 2026-07-12

- Authoritative starting commit: `c55f09dca3f55ccd3e6d54486c48fc083d05143b` from `origin/main`.
- Baseline branch: `chore/staging-cicd-foundation`.
- Baseline worktree: `.tmp/worktrees/staging-cicd-baseline`.
- Baseline verification resolved Node `v22.18.0` and npm `10.8.0`.
- The root checkout remains on `agent/chunk1-authoritative-stripe-sync-20260710` with user-owned changes and a gone upstream.
- `origin/main` contained no `.github/workflows` directory at capture time.
- No branch or worktree was deleted during baseline creation.

## Node Runtime Policy

The repository supports the latest available Node 22 release:

- `.nvmrc` contains `22`;
- `package.json` and `package-lock.json` declare `22.x`;
- Amplify runs `nvm install 22` and `nvm use 22` before `npm ci`;
- Amplify prints `node --version` and `npm --version` as build evidence;
- future GitHub Actions workflows must resolve Node from `.nvmrc` and print both versions.

This owner-approved rolling-major policy receives Node 22 patch updates automatically instead of pinning one exact minor. Minor versions can differ across machines or builds, so every CI and deployment record must retain the resolved versions. A future Node major upgrade remains a deliberate, tested pull request.

## DOMPurify Baseline Repair

The lockfile installs DOMPurify 3.3.3 through `isomorphic-dompurify`. That release contains the attribute-comment security guard previously carried in `patches/dompurify+3.3.1.patch`, including all tags from the patch plus `script`. The obsolete patch was removed so clean installs no longer report a patch-version conflict.

A direct sanitizer regression test and explicit `patch-package --error-on-fail` behavior are deferred follow-ups and are not part of this baseline.

## Worktree Inventory

Captured after `git fetch --prune origin`. “Merged” means the recorded worktree HEAD is an ancestor of the captured `origin/main`; it does not mean uncommitted files are safe to discard.

| Worktree | Branch | HEAD | Files | Main relation | Upstream |
| --- | --- | --- | --- | --- | --- |
| <repo-root> | agent/chunk1-authoritative-stripe-sync-20260710 | c369d0bc | dirty (62 entries) | unmerged | origin/agent/chunk1-authoritative-stripe-sync-20260710 (gone) |
| <legacy-temp>/jat-review-delete-race | review/job-delete-response-race-hardening | 8ecc5f04 | clean | merged | origin/review/job-delete-response-race-hardening |
| <legacy-temp>/job-application-tracker-4b | review/job-data-performance-chunk-4b | 967dae26 | clean | merged | origin/review/job-data-performance-chunk-4b |
| <legacy-temp>/job-application-tracker-chunk1 | chunk-1-premium-to-free-storage | 8f6d60ca | clean | merged | origin/chunk-1-premium-to-free-storage |
| <legacy-temp>/job-application-tracker-chunk3Latency | chunk3Latency | fa0bfffc | clean | merged | origin/chunk3Latency |
| <legacy-temp>/job-application-tracker-chunk7-pr | review/premium-storage-chunk-7 | a3c715d4 | clean | merged | origin/review/premium-storage-chunk-7 |
| <legacy-temp>/job-application-tracker-chunk8 | review/premium-storage-chunk-8 | c038cfa0 | clean | merged | origin/review/premium-storage-chunk-8 |
| <legacy-temp>/job-application-tracker-latency-audit | latency-audit | cade4f85 | clean | merged | origin/latency-audit |
| <legacy-temp>/job-application-tracker-stripe-audit-pr | codex/stripe-audit-followups | 97e5e216 | dirty (2 entries) | merged | origin/codex/stripe-audit-followups |
| <legacy-temp>/job-data-integration-harness-pr | review/job-data-integration-harness | a3413dc1 | clean | merged | origin/review/job-data-integration-harness |
| <legacy-temp>/job-tracker-chunk2-pr | premium-to-free-storage-degradation-plan-chunk-2 | 17aa7153 | clean | merged | origin/premium-to-free-storage-degradation-plan-chunk-2 |
| <legacy-temp>/job-tracker-chunk3-pr | codex/chunk-3-storage-summary | f79efa21 | clean | merged | origin/codex/chunk-3-storage-summary |
| <legacy-temp>/premium-storage-chunk-10 | (detached) | e7286b18 | clean | merged | n/a |
| <legacy-temp>/premium-storage-chunk-9 | premium-storage-chunk-9 | 8662c31a | clean | merged | origin/premium-storage-chunk-9 |
| <legacy-temp>/security-review-fixes-main | review/security-review-fixes-main | edd7508f | clean | merged | origin/review/security-review-fixes-main |
| <repo-root>/.codex-pr-health-rate-limit | fix/health-rate-limit-hardening | eec1de8e | dirty (2 entries) | merged | origin/fix/health-rate-limit-hardening |
| <repo-root>/.tmp/worktrees/agent-custom-error-pages | agent/custom-error-pages | e7286b18 | dirty (13 entries) | merged | none |
| <repo-root>/.tmp/worktrees/agent-custom-error-pages-main | agent/custom-error-pages-main | e82e4031 | clean | merged | origin/agent/custom-error-pages-main |
| <repo-root>/.tmp/worktrees/chunk1-stripe-snapshot-guard | agent/chunk1-stripe-snapshot-guard | f4585d6e | clean | merged | origin/agent/chunk1-stripe-snapshot-guard |
| <repo-root>/.tmp/worktrees/chunk2-equal-stripe-events | agent/chunk2-equal-stripe-events | 13a11e5c | clean | merged | origin/agent/chunk2-equal-stripe-events |
| <repo-root>/.tmp/worktrees/chunk4-Latency | chunk4-Latency | ed32d792 | clean | merged | origin/chunk4-Latency |
| <repo-root>/.tmp/worktrees/chunk5-latency | chunk5-latency | 6889e15f | clean | merged | origin/chunk5-latency |
| <repo-root>/.tmp/worktrees/chunk6-Latency | chunk6-Latency | 187f7abc | clean | merged | origin/chunk6-Latency |
| <repo-root>/.tmp/worktrees/codex-pr-workflow-docs | docs/codex-pr-workflow | 4a593996 | clean | merged | origin/docs/codex-pr-workflow |
| <repo-root>/.tmp/worktrees/fix-chunk5-parallel-get | fix/chunk5-parallel-get | f5b53b81 | clean | merged | origin/fix/chunk5-parallel-get |
| <repo-root>/.tmp/worktrees/job-data-performance-chunk3-1000 | agent/job-data-performance-chunk3-1000 | 53bb78ab | clean | merged | origin/agent/job-data-performance-chunk3-1000 |
| <repo-root>/.tmp/worktrees/retry-after-additive-jitter | agent/retry-after-additive-jitter | a91f0128 | clean | merged | origin/agent/retry-after-additive-jitter |
| <repo-root>/.tmp/worktrees/staging-cicd-baseline | chore/staging-cicd-foundation | c55f09dc | implementation changes | merged | origin/main |

## Branches Requiring Owner Or Purpose Confirmation

These local branch tips were not merged into the captured `origin/main`:

- `agent/chunk1-authoritative-stripe-sync-20260710` (active dirty root; upstream gone);
- `backup/job-data-performance-chunk3-1000-pre-rebase`;
- `backup/root-before-main-20260625`;
- `chore/logging-cleanup`;
- `fix/auth-session-ip-cooldown`;
- `review/security-review-fixes`.

These remote branch tips were not merged into the captured `origin/main`:

- `origin/billing-premium-plan-migration`;
- `origin/chore/logging-cleanup`;
- `origin/feat/ai-tailor-phase0`;
- `origin/fix/auth-session-ip-cooldown`;
- `origin/fix/redis-rate-limit-timeout-fail-closed`.

All other local and remote branches reported by `git branch --merged origin/main` were classified as merged at capture time. Merge status alone does not authorize deletion. Confirm the owner or purpose and preserve any dirty files before proposing cleanup.

## Inventory Refresh Commands

```powershell
git fetch --prune origin
git branch --all --verbose --no-abbrev
git worktree list --porcelain
git branch --merged origin/main
git branch --no-merged origin/main
git branch -r --merged origin/main
git branch -r --no-merged origin/main
```
