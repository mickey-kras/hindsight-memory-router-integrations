# Upgrading vendored integrations

Upgrades are commit-pinned and reproducible. Never import from a mutable tag or edit a committed package directly.

## OpenClaw

1. Resolve the upstream tag to its peeled commit SHA and update `UPSTREAM_VERSION`.
2. Run `scripts/regen-upstream-hashes.sh` against that commit and review `src/upstream/SHA256SUMS`.
3. Run `scripts/import-upstream.sh`. It verifies the pristine download before copying and preserves the three reviewed local adaptations listed in `integrations/openclaw/LOCAL_CHANGES.json`.
4. Reconcile the adapted files, run `scripts/regen-openclaw-overlay.mjs`, and review every hash change.
5. Bump `router_revision`, update the root package version, rebuild, test, and replace the OpenClaw tarball.

## Coding agents

1. Update the commit and version in `integrations/coding-agents/UPSTREAM.json`.
2. Materialize that exact upstream commit in a temporary directory.
3. Apply `integrations/coding-agents/router.patch`; resolve rejected hunks explicitly.
4. Rebuild `LOCAL_CHANGES.json` only after reviewing the resulting diff.
5. Run `node scripts/verify-coding-upstream.mjs`, build and test the nested package, bump its router revision, and replace its tarball.

## Package verification

Run the root CI commands locally. CI rebuilds both tarballs, compares normalized contents with the committed artifacts, and verifies `PACKAGE_SHA256` and `PACKAGE_NIX_HASHES`.
