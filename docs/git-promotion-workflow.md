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

No actor has a routine bypass. During an incident, the repository owner may
temporarily edit or disable the relevant ruleset only when the normal pull
request path cannot restore service quickly enough. Record the reason, scope,
time, and resulting changes in `docs/fixes.md`, restore the ruleset immediately
afterward, and verify its effective branch rules.

Required status checks are intentionally deferred until the Step 07 workflows
have completed successfully and their stable check names are known. The
production workflow must then reject pull requests into `main` whose head is
not `staging`, except for the documented emergency hotfix path.
