# CI policy and independent review

The guard runs from the protected base through `pull_request_target`.
It reads candidate files as data through GitHub's API. It never creates a checkout of candidate policy code or executes that code.
Before it lists files, it resolves the live PR. It rejects a head or base change during evaluation.

The guard continues to enforce required CI checks, dependency audits, immutable trusted scanner callers and release provenance.

## Dependency updates

`.github/scripts/package-lock.json` and `.github/trusted-ci/package-lock.json` use semantic gates instead of admitted hashes.
A lock update must use npm lockfile version 3.
It must use HTTPS URLs for registry tarballs on exactly `registry.npmjs.org`.
Every installed dependency must have canonical SHA-512 integrity. The root package must match the gated manifest.

The validator rejects these inputs:

- Workspace links.
- Bundled packages.
- Nested shrinkwraps.
- Alternate sources.
- Duplicate JSON keys.
- New install-script flags.

Existing aliases keep their base identity. New aliases need a deliberate validator change.
Tarball names and versions must match their package entries.
The validator forbids changes to effective `.npmrc` files and shadowing CI `npm-shrinkwrap.json` files, even with approval.
Thus, npm cannot redirect the validated registry URLs.

The root record represents the local project. It has no tarball or integrity.
Every dependency record must have both.

The manifest keeps its code gate because scripts and dependency declarations affect execution.
A lockfile cannot admit a manifest change.
Registry origin and integrity prove provenance and byte consistency. They do not prove that package code is safe.
Audits, scanners, owner review and `--ignore-scripts` remain necessary.

Do not add lockfile hashes or suppress an advisory to unblock a release.
Change the dependency or override. Regenerate it with repository tooling. Check the final result.

Security-sensitive data still controls behavior. Examples include scanner suppression lists and release activation configuration.
This data keeps its existing gate. A rule that treats every JSON or YAML file as harmless data would weaken security.

## Code changes in one PR

Each executable file keeps one current admission. When you update a pin, replace it.
Never append historical admissions.
Independent owner review of the exact PR head can instead admit an unknown code hash or automation shape.
Mandatory structural and permission checks still run.

Changes to the guard itself or review configuration need that same approval.
Admission never executes candidate code.

The review route stays closed unless all these conditions hold:

- The PR author is a GitHub bot, separate from `mickey-kras` (owner ID `24433677`). An owner-authored PR cannot admit itself.
- The base branch's CODEOWNERS assigns `/.github/` to `@mickey-kras`.
- GitHub's effective base-branch rules enforce code-owner review and dismiss stale approvals. They also enforce approval of the latest push by someone other than its pusher.
- Their applicable repository source stays active with the same review parameters and no bypass actors. If the API does not show bypass actors, a trusted administrator readback must match its exact repository, ruleset ID and revision.
- The owner's latest decisive review is `APPROVED` and identifies the exact current head SHA. A later dismissal or request for changes revokes admission.

After approval, rerun the guard. A new commit needs new approval and new verification.
Native rules must stay active. They prevent merging after dismissal or an unapproved push, even if an earlier guard check is green.
API errors prevent admission.

Do not add a `pull_request_review` workflow that executes candidate code to automate this rerun.

## Rollout and administration

The checked-in `.github/rulesets/require-ci-owner-review.json` is an additive ruleset template.
It does not prove that an administrator installed the rule.
Import it in repository **Settings > Rules > Rulesets**.
Do not replace the existing required-check, scan, branch or release rules.
Confirm that it applies to `main` and `release/*`, is active and has no bypass actors.

The required approval and last-push requirements also affect PRs outside `.github`.
This deliberately separates identities.
GitHub can omit bypass details from read-only API responses.
During rollout, the administrator must check that no bypass grants exist and preserve that configuration.
The guard does not receive administration credentials.

Create a dedicated implementation GitHub App with only repository contents and pull-request write access.
When necessary, also give it workflow write access.
Do not give that identity administration access, owner review, release credentials or bypass permission.
Install it only on the intended repositories. Configure the implementation connection to use it.

Commit authorship text does not separate identities.
The implementer must not have access to the human owner's credentials.
Existing release automation is not an implementation identity.

Find the applicable `ruleset_id` through `GET /repos/{owner}/{repo}/rules/branches/{branch}`.
With an administrator's local `gh` login, read the full source:

```sh
gh api repos/mickey-kras/hindsight-memory-router-integrations/rulesets/RULESET_ID --jq 'if has("bypass_actors") and .bypass_actors == [] then {repository: .source, ruleset_id: .id, updated_at: .updated_at, bypass_actors: []} else error("Administrator readback must show no bypass actors") end'
```

Replace `RULESET_ID` with its numeric ID.
Store the output JSON in the repository Actions variable `CI_POLICY_SETTINGS_REVIEW`.
Only an administrator can configure this trusted variable.
If the read-only API does not show bypass actors, the guard needs this readback.

The guard rejects missing, malformed or stale readbacks and any visible nonempty bypass list.
After any ruleset change, repeat the administrator readback.
Never give the guard an administrator credential.

Before activation, test a bot-authored PR with an unknown code hash.
It must fail before review. It must pass only after owner approval of the exact head.
It must fail again after a new commit, dismissal or a missing native control.
Also test a registry-only lock patch without policy pin edits.

Read back effective rules. Check the real workflow results.
Local fixtures alone do not qualify the rollout.

Bootstrap is a one-time owner-admin operation because the old base guard cannot accept its replacement.
Review the final policy diff and checks.
For any explicitly authorized exception, record the exact head and reason in the PR.
Merge with the existing owner's authorized administrative process.

Do not disable required checks, forge status, add permanent bypass actors or use the release App.
Through the connected API, the implementer cannot install rulesets, create the App or bypass the current rules.
Until the administrative prerequisites are complete and verified, the review route stays unavailable.
Do not describe it as deployed.

## Regression protection

Run these tests:

```sh
python3 .github/scripts/ci-admission.test.py
python3 .github/scripts/release-policy.test.py
python3 .github/trusted-ci/policy.test.py
```

Tests cover registry confusion, weak integrity, script introduction, malformed locks and manifest drift.
They also cover stale or revoked reviews, self approval, missing native controls and API failure.
Lockfiles must never reappear in `RELEASE_SOURCE_HASHES`. Each retained source admission is a single hash.
