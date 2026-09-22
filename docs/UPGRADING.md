# Upgrading vendored integrations

Use a local checkout of `vectorize-io/hindsight` and resolve the intended upstream ref to a commit:

```sh
git -C ../hindsight fetch origin --tags
git -C ../hindsight rev-parse origin/main
python3 scripts/sync-upstream.py ../hindsight <40-character-commit>
```

The sync verifies both old pristine snapshots, merges local adaptations with Git's three-way merge,
and updates both pins. A content or add/delete conflict stops before writing any source or manifest;
reconcile that file against the old and new upstream commits before retrying. OpenClaw keeps only
its explicitly imported files. Its rewritten entrypoint, setup and manifest stay router-owned.

Review the diff, including upstream behavior and independent downstream package versions, then:

```sh
npm run upstream:accept
python3 scripts/sync-upstream.py ../hindsight --patch-only
npm ci
npm ci --prefix src/upstream/coding-agents
npm ci --prefix src/mcp
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run build:coding-agents
npm run build --prefix src/mcp
npm exec --prefix src/upstream/coding-agents -- tsc --noEmit -p src/upstream/coding-agents/tsconfig.json
npm test --prefix src/upstream/coding-agents
```

`upstream:accept` records reviewed adaptations; it is not a substitute for reviewing conflicts.
`--patch-only` regenerates the complete coding-agent patch, including local additions and deletions.
Repeat both after any further adapted-source edits.

Pack all three packages with the npm version pinned in `.github/workflows/ci.yml`. Refresh all entries
in `PACKAGE_SHA256` and the OpenClaw source hash in `PACKAGE_NIX_HASHES`. Recompute `npm_deps` with the
CI Nix command only if root `npm-shrinkwrap.json` changed. CI rebuilds and byte-compares the packages.

Merge after PR checks pass. Follow [Releasing](RELEASING.md) for the release checkbox and frozen inputs.
