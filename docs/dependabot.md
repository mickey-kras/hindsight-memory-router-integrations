# Dependabot auto-merge

- Auto-merge requires minor/patch updates and a compatibility score of at
  least 75% for every dependency in the PR.
- Missing scores, unknown versions and major updates require manual review.
  Security updates use the same merge policy. Node typings stay on Node 22.
- Required repository checks still apply. The score reflects other projects'
  CI results; it does not replace this repository's tests.
- PR events and the 30-minute refresh use the same implementation. A failed
  lookup clears an earlier bot auto-merge decision. Manually enabled
  auto-merge still gets branch refresh and validation recovery.
- `GITHUB_TOKEN` handles merging and main-workflow dispatch. No App or PAT.
- npm updates regenerate provenance, packages and hashes in a read-only build.
  A separate job commits only generated files with `GITHUB_TOKEN` and
  dispatches any missing PR validation, including guard.
- Only signed Dependabot commits plus a GitHub-signed artifact commit from
  Actions or the owner qualify. Source and workflow edits stay manual.
- Guard runs inside PR validation on PR events and recovery dispatches,
  using policy code from main with read-only permissions. Existing validation
  is reused; failed checks remain blocking.
- Every main update asks Dependabot to recreate stale, verified dependency PRs;
  the 30-minute refresh remains a retry path. Missing validation starts after
  preparation. Failed checks remain blocking; rerun after fixing the cause.
- The refresh also starts missing main validation for the current default
  branch tip when it is a Dependabot merge. Existing push/dispatch runs are
  reused; failed runs remain visible rather than being retried automatically.

The pinned `dependabot/fetch-metadata` bundle supplies per-dependency scores.
Its single `compatibility-score` output covers only the first dependency, so
the policy reads `updated-dependencies-json` for grouped PRs. The pinned
implementation fetches public badges without authentication, despite its
README's PAT note.

To re-evaluate open PRs, run **Actions → dependabot auto-merge refresh → Run
workflow** on the default branch. Change `MINIMUM_SCORE` in
`.github/scripts/dependabot-auto-merge.cjs` to adjust the threshold.
