# Git Promotion Workflow

## Branch roles

- `staging` is the persistent integration branch and the base for ordinary
  feature, fix, chore, and agent pull requests.
- `main` is the production branch and remains the repository default branch.
- Short-lived branches isolate work and are deleted after merge when their
  worktrees are no longer needed.

The normal route is `feature/* -> staging -> main`. Short-lived `fix/*`,
`chore/*`, and `agent/*` branches follow the same route.

## Normal promotion

1. Start a short-lived branch from the latest `staging`.
2. Open a pull request from that branch into `staging`.
3. Resolve review conversations and pass all available required checks.
4. Merge the pull request and verify the resulting staging deployment when it
   exists.
5. Open the production pull request with `staging` as the head branch and
   `main` as the base branch.
6. Merge only after the required staging and CI evidence is complete.

Do not cherry-pick ordinary feature work directly into `main`, and do not use
`staging` as a long-term parking branch for unrelated incomplete work.

## Emergency hotfix

1. Branch from the current production `main`.
2. Prefer validating the change through `staging` and promoting normally.
3. If an incident requires a direct pull request to `main`, record why the
   normal route was bypassed and require all available CI and production
   approval.
4. Immediately open a follow-up pull request that synchronizes the released
   `main` commit back into `staging`.
5. Record the incident and synchronization result in `docs/fixes.md`.

## Ruleset and break-glass policy

The `staging-protection` and `main-production-protection` rulesets block branch
deletion and force pushes, require pull requests, and require review
conversations to be resolved. They initially require zero approving reviews so
the solo-owner repository remains usable.

Both active rulesets require exactly one stable, secret-free status check:
`CI / unit-lint-build`. The ruleset API context is `unit-lint-build`, produced
by the `github-actions` app with integration ID `15368`.

- `staging-protection` (ruleset `19072143`) targets only `staging` and sets
  `strict_required_status_checks_policy` to `false`.
- `main-production-protection` (ruleset `19072163`) targets only `main` and sets
  `strict_required_status_checks_policy` to `true`.

Main's strict setting means a production-promotion head must contain the
current `main` tip before it can merge. When `main` is ahead only because of a
prior production merge, synchronize that tip back through the staging route
and allow the required CI check to rerun before promotion.

No actor has a routine bypass. During an incident, the repository owner may
temporarily edit or disable the relevant ruleset only when the normal pull
request path cannot restore service quickly enough. Record the reason, scope,
time, and resulting changes in `docs/fixes.md`, restore the ruleset immediately
afterward, and verify its effective branch rules.

Trusted Integration remains a manual `workflow_dispatch` workflow. It is not a
pull-request trigger or a required ruleset check, so untrusted pull requests do
not receive secrets or depend on integration infrastructure. Repository policy
reserves ordinary `main` pull requests for `staging` promotions; emergency
hotfixes and explicitly documented, never-merge enforcement proofs are the only
exceptions.

## Sanitized settings evidence

The 2026-07-26 pre-change read-back contained these setting-bearing fields for
both rulesets; GitHub response metadata, links, and headers are omitted:

```text
{
  target: branch,
  enforcement: active,
  bypass_actors: [],
  conditions: {
    ref_name: {
      exclude: [],
      include: [refs/heads/<staging-or-main>]
    }
  },
  rules: [
    { type: deletion },
    { type: non_fast_forward },
    {
      type: pull_request,
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        required_reviewers: [],
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
        allowed_merge_methods: [merge, squash, rebase]
      }
    }
  ]
}
```

The post-change read-back preserved every field above and added only the
required status-check rule documented below.

- Rule type: `required_status_checks`.
- Required checks: one entry with context `unit-lint-build` and integration ID
  `15368`; no other context is present.
- `do_not_enforce_on_create`: `false` on both rulesets.
- `staging-protection`: ID `19072143`, exact ref `refs/heads/staging`, active
  enforcement, strict policy `false`.
- `main-production-protection`: ID `19072163`, exact ref `refs/heads/main`,
  active enforcement, strict policy `true`.

## Required-check enforcement proof

The temporary proof branch used one deterministic, infrastructure-free failing
Jest assertion. It was synchronized with the current `main` tip before the
definitive failure capture so main's strict-update rule did not mask the failed
required check. Both proof PRs were closed without merging, and the temporary
remote and local branches were deleted after repair evidence was captured.
Their commits remain recoverable through the closed pull requests.

- Staging proof: [PR #99](https://github.com/willmclaughlin03/jobApplicationTracker/pull/99)
  failed on head `62e7399a` in
  [run 30215195156](https://github.com/willmclaughlin03/jobApplicationTracker/actions/runs/30215195156).
  The `Run unit tests` step failed and GitHub reported the PR `BLOCKED`.
  After repair, head `79a88d9f` passed
  [run 30215287257](https://github.com/willmclaughlin03/jobApplicationTracker/actions/runs/30215287257),
  and GitHub reported the PR `CLEAN` and `MERGEABLE`.
- Main proof: [PR #100](https://github.com/willmclaughlin03/jobApplicationTracker/pull/100)
  failed on head `62e7399a` in
  [run 30215195637](https://github.com/willmclaughlin03/jobApplicationTracker/actions/runs/30215195637).
  The `Run unit tests` step failed and GitHub reported the PR `BLOCKED`.
  After repair, head `79a88d9f` passed
  [run 30215287316](https://github.com/willmclaughlin03/jobApplicationTracker/actions/runs/30215287316),
  and GitHub reported the PR `CLEAN` and `MERGEABLE`.

All four runs used the exact `unit-lint-build` job. The failure skipped the
build step after the deliberate unit-test assertion; the repaired runs passed
install, lint, unit tests, and build. No secrets, Trusted Integration run,
deployment, artifact upload, or Amplify setting participated in the proof.
