# Dependabot auto-merge

Matches `hindsight-memory-router`:

- Minor/patch PR events enable squash auto-merge.
- Every 30 minutes, the refresh enables auto-merge for all open, non-draft
  Dependabot PRs, including major updates.
- Required checks and repository rules still apply.
- Uses `GITHUB_TOKEN`; no additional app or secret.
- Weekly grouped updates retain the seven-day cooldown.

Required PR checks: `checks`, `aislop status`, `analyze`, `guard`, and
`branch name`. SonarQube runs on main.

To refresh existing PRs, run **Actions → dependabot auto-merge refresh →
Run workflow**.

The policy guard pins the automation structure while allowing full action SHA
updates. Trigger, permission, script or condition changes require updating the
reviewed shape in `policy-guard.yml`.
