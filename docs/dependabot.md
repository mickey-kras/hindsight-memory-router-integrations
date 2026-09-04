# Dependabot auto-merge

Matches `hindsight-memory-router`:

- Minor/patch PR events enable squash auto-merge.
- A 30-minute refresh enables it for every open, non-draft Dependabot PR,
  including major updates. Required merge gates still apply.
- Uses `GITHUB_TOKEN`; no additional app or secret.
- Weekly grouped updates retain the seven-day cooldown.

Apply the policy-guard prerequisite before adding the automation workflows.
From an authenticated repository checkout, apply the repository settings:

```sh
bash scripts/configure-github.sh --apply
```

This installs the router's four rulesets, enables squash-only auto-merge and
deletes merged branches. Required PR checks are `checks`, `aislop status`,
`analyze`, `guard`, and `branch name`. The router's `container` check is omitted
because this repository has no container job. SonarQube remains on main.

After both workflow files are on main, refresh existing PRs:

```sh
gh workflow run dependabot-auto-merge-refresh.yml --repo mickey-kras/hindsight-memory-router-integrations
```

The policy guard pins the automation workflow structure, allowing full action
SHA updates. Trigger, permission, script or condition changes require an
explicit update to the reviewed shape in `policy-guard.yml`.
