# Dependabot auto-merge

[Documentation](README.md) | [Repository](../README.md)

- Auto-merge requires minor/patch updates and a compatibility score of at
  least 75% for every dependency in the PR.
- Missing scores, unknown versions and major updates require manual review.
  Security updates use the same merge policy. Node typings stay on Node 22.
- Required repository checks still apply. The score reflects other projects'
  CI results. It does not replace this repository's tests.
- Bot auto-merge uses the most recently started PR validation execution for the current head.
  Every job must finish successfully, including release combination and Dependabot policy tests. Pending executions block merging.
  Each refresh evaluates reruns and tied start times again.
- PR events and the 30-minute refresh use the same implementation. A failed
  lookup clears an earlier bot auto-merge decision. Manually enabled
  auto-merge still gets branch refresh and validation recovery.
- `GITHUB_TOKEN` handles merging and validation dispatch. A repository-scoped
  Release App token publishes generated files in a separate job.
- Node digest-only updates to the coding-agent E2E base image refresh only
  that file's provenance checksum. Tag, instruction and mixed npm/Docker
  changes require manual review. Preparation does not run Docker. Missing
  semver metadata does not block this checksum repair.
  Auto-merge still requires the normal update metadata and compatibility score.
- npm updates use npm 11.19.1, matching CI and release packaging. Preparation
  verifies the selected version before changing inputs or generating hashes.
  Updates regenerate provenance and package hash pins in a read-only build;
  tarballs are rebuilt from source by CI and byte-compared against the pins,
  never committed.
  A separate job commits only generated files and
  dispatches any missing PR validation, including guard. Each clean Dependabot update or
  rebase gets preparation for its exact head. Publication rejects stale head or base snapshots. It commits regenerated package and Nix pins on the same PR.
  Checks run at that generated commit before it can merge.
  Generated commits include `[dependabot skip]`, allowing Dependabot to replace
  them during native rebasing. Preparation rebuilds the pins for the new bot head.
  The marker does not skip CI. Existing signed preparation commits remain valid.
- Only signed Dependabot commits plus a GitHub-signed artifact commit from
  Actions, the Release App or the owner qualify. Source and workflow edits stay manual.
- Guard runs inside PR validation on PR events and recovery dispatches,
  using policy code from main with read-only permissions. Existing validation
  is reused. Failed checks still block merging.
- Stale dependency PRs wait for Dependabot's native rebasing.
  The 30-minute refresh remains a retry path. Missing validation starts after
  preparation. Failed checks still block merging. After you fix the cause, rerun the checks.
- The refresh also starts missing main validation for the current default
  branch tip when it is a Dependabot merge. Existing push/dispatch runs are
  reused. Failed runs stay visible. The refresh does not automatically retry them.
  The inputless **main** workflow button runs validation only, on `main`.
  Only **release** creates and publishes releases.

The pinned `dependabot/fetch-metadata` bundle supplies per-dependency scores.
Its single `compatibility-score` output covers only the first dependency, so
the policy reads `updated-dependencies-json` for grouped PRs. The pinned
implementation fetches public badges without authentication, despite its
README's PAT note.

Dependabot automation source edits require a trusted human author (OWNER,
MEMBER or COLLABORATOR). The guard checks selected source safety contracts.
These checks do not prove arbitrary JavaScript behavior or prevent hostile dead-code padding. Trusted workflow revisions, code review and behavioral
tests remain required. Workflow shape protections and artifact verification
remain enforced.

To re-evaluate open PRs, run **Actions -> dependabot auto-merge refresh -> Run
workflow** on the default branch. Change `MINIMUM_SCORE` in
`.github/scripts/dependabot-auto-merge.cjs` to adjust the threshold.

