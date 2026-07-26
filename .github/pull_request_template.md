# Pull Request

## Change

Describe what changed and why.

## Validation

List the checks or manual verification completed.

## Branch route

Confirm the one route that applies:

- [ ] Ordinary feature, fix, or chore PR: this PR targets `staging`.
- [ ] Production promotion PR: this PR uses `staging` as the head branch and
      `main` as the base branch.
- [ ] Emergency hotfix PR: this PR targets `main`, explains why the normal
      promotion route was bypassed, and has a follow-up PR planned to sync the
      released commit back into `staging`.

## Checklist

- [ ] No secrets or environment values are included.
- [ ] Relevant documentation is updated.
- [ ] All review conversations are resolved before merge.
- [ ] The required `CI / unit-lint-build` check passes.
