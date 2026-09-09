# Dependabot auto-merge

- All verified Dependabot updates can auto-merge, including major updates.
- Required repository checks must pass. Merges use squash.
- Unsigned or non-Dependabot commits require manual review.
- PR events and the 30-minute refresh use the same implementation.
- Dependabot handles its own branch updates with `rebase-strategy: auto`.
  Each ecosystem runs daily on a staggered cron schedule, so stale PRs are
  rebased by Dependabot and trigger normal PR checks.
- `GITHUB_TOKEN` handles auto-merge and main-workflow dispatch. No App or PAT.
- The refresh starts missing main validation for the current Dependabot merge.
  Existing runs are reused; failed runs remain visible.

To re-evaluate open PRs, run **Actions → dependabot auto-merge refresh → Run
workflow** on the default branch.

For an existing stuck PR, use Dependabot's `@dependabot rebase` command.
Dependabot may stop updating PRs with extra commits or after 30 days;
review any manual changes before requesting recreation.
