# Upgrading vendored integrations

For release preparation, protected branches/tags and publication, see [Releasing](RELEASING.md).

Upgrades are commit-pinned and reproducible. Never import from a mutable tag or edit a committed package directly.

## OpenClaw

1. Resolve the upstream tag to its peeled commit SHA and update `UPSTREAM_VERSION`.
2. Run `scripts/regen-upstream-hashes.sh` against that commit and review `src/upstream/SHA256SUMS`.
3. Run `scripts/import-upstream.sh`. It verifies the pristine download before copying and preserves the reviewed adaptations listed in `integrations/openclaw/LOCAL_CHANGES.json`; update `VENDORED_PRISTINE_FILES.json` if another pristine file is intentionally retained.
4. Reconcile the adapted files, run `scripts/regen-openclaw-overlay.mjs`, and review every hash change.
5. Bump the independent root package version, rebuild, test, and replace the OpenClaw tarball.
6. Run `node scripts/verify-openclaw-overlay.mjs`; it verifies every vendored OpenClaw file against the reviewed overlay manifest.

## Coding agents

1. Update the commit and version in `integrations/coding-agents/UPSTREAM.json`.
2. Materialize that exact upstream commit in a temporary directory.
3. Apply `integrations/coding-agents/router.patch`; resolve rejected hunks explicitly.
4. Rebuild `LOCAL_CHANGES.json` only after reviewing the resulting diff.
5. Run `node scripts/verify-coding-upstream.mjs`, build and test the nested package, bump its independent package version, and replace its tarball.
6. Regenerate `integrations/coding-agents/router.patch` from the pinned pristine tree and the reviewed adapted tree.

## Package verification

From the repository root, install and validate with:

```sh
npm ci
npm ci --prefix src/upstream/coding-agents
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run build:coding-agents
npm exec --prefix src/upstream/coding-agents -- tsc --noEmit -p src/upstream/coding-agents/tsconfig.json
npm test --prefix src/upstream/coding-agents
node scripts/verify-coding-upstream.mjs
node scripts/verify-openclaw-overlay.mjs
```

Then rebuild both tarballs, regenerate `PACKAGE_SHA256` and `PACKAGE_NIX_HASHES`, and run the normalized package comparisons from `.github/workflows/ci.yml`.

Release from `main` only after the PR validation workflow is green. Work branches must use one of the prefixes accepted by `.github/workflows/branch-policy.yml`; Dependabot branches are validated separately.
