# CI policy and independent review

The guard runs from the protected base through `pull_request_target`. It reads candidate files as data through GitHub's API and never checks out or executes candidate policy code. It resolves the live PR before listing files and rejects a head or base change during evaluation. Required CI checks, dependency audits, immutable trusted scanner callers, and release provenance remain enforced.

## Dependency updates

`.github/scripts/package-lock.json` and `.github/trusted-ci/package-lock.json` have semantic gates, not admitted hashes. A lock update must use npm lockfile version 3, registry HTTPS tarball URLs on exactly `registry.npmjs.org`, canonical SHA-512 integrity for every installed dependency, and a root package matching the gated manifest. Workspace links, bundled packages, nested shrinkwraps, alternate sources, duplicate JSON keys, and new install-script flags are rejected. Existing aliases retain their base identity; newly introduced aliases require a deliberate validator change. Tarball names and versions must match their package entries. Changes to effective `.npmrc` files and shadowing CI `npm-shrinkwrap.json` files are forbidden, even with approval, so npm cannot redirect the validated registry URLs. The root record represents the local project and has no tarball or integrity; every dependency record must have both.

The manifest retains its code gate because scripts and dependency declarations affect execution. A lockfile cannot admit a manifest change. Registry origin and integrity establish provenance and byte consistency, not that package code is safe: audits, scanners, owner review, and `--ignore-scripts` remain necessary. Do not add lockfile hashes or suppress an advisory to unblock a release. Change the dependency or override, regenerate with repository tooling, and verify the final result.

Security-sensitive data such as scanner suppression lists and release activation configuration still controls behavior. It retains its existing gate; treating every JSON or YAML file as harmless data would weaken security.

## Code changes in one PR

Executable files keep one current admission each. Replace a pin when updating it; never append historical admissions. An unknown code hash or automation shape can instead be admitted by independent owner review of that exact PR head, while mandatory structural and permission checks still run. Changes to the guard itself or review configuration require that same approval. Admission never executes candidate code.

The review route is deliberately closed unless all of these hold:

- The PR author is a GitHub bot, separate from `mickey-kras` (owner ID `24433677`). An owner-authored PR cannot self-admit.
- The base branch's CODEOWNERS assigns `/.github/` to `@mickey-kras`.
- GitHub's effective base-branch rules require code-owner review, dismiss stale approvals, and require approval of the latest push by someone other than its pusher.
- The owner's latest decisive review is `APPROVED` and identifies the exact current head SHA. A later dismissal or request for changes revokes admission.

Re-run the guard after approval. A new commit needs new approval and new verification. Native rules must remain active: they prevent merging after dismissal or an unapproved push even if an earlier guard check is green. API errors fail closed. Do not add a candidate-executing `pull_request_review` workflow to automate this rerun.

## Rollout and administration

The checked-in `.github/rulesets/require-ci-owner-review.json` is an additive ruleset template, not proof that the rule is installed. Import it in repository Settings → Rules → Rulesets without replacing the existing required-check, scan, branch, or release rules. Confirm it applies to `main` and `release/*`, is active, and has no bypass actors. The required approval and last-push requirements also affect PRs outside `.github`; this is deliberate identity separation. GitHub can omit bypass details from read-only API responses, so the administrator must verify no bypass grants during rollout and preserve that configuration; the guard does not receive administration credentials.

Provision a dedicated implementation GitHub App with only repository contents and pull-request write access and workflow write access when needed. Keep administration, owner review, release credentials, and bypass permission out of that identity. Install it only on the intended repositories and configure the implementation connection to use it. Commit authorship text is not identity separation. The human owner's credentials must not be available to the implementer. Existing release automation is not an implementation identity.

Before activation, test a bot-authored PR with an unknown code hash: it must fail before review, pass only after exact-head owner approval, and fail again after a new commit, dismissal, or a missing native control. Also test a registry-only lock patch without editing policy pins. Read back effective rules and check the real workflow results; local fixtures alone do not qualify the rollout.

Bootstrap is a one-time owner-admin operation because the old base guard cannot accept its replacement. Review the final policy diff and checks, record the exact head and reason for any explicitly authorized exception in the PR, and merge with the existing owner's authorized administrative process. Do not disable required checks, forge status, add permanent bypass actors, or use the release App. The connected implementation API cannot install rulesets, create the App, or bypass the current rules. Until those administrative prerequisites are completed and verified, the review route remains unavailable; do not describe it as deployed.

## Regression protection

Run `python3 .github/scripts/ci-admission.test.py`, `python3 .github/scripts/release-policy.test.py`, and `python3 .github/trusted-ci/policy.test.py`. Tests cover registry confusion, weak integrity, script introduction, malformed locks, manifest drift, stale or revoked reviews, self approval, missing native controls, and API failure. Lockfiles must never reappear in `RELEASE_SOURCE_HASHES`; each retained source admission is a single hash.
