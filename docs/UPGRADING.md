# Upgrading vendored integrations

[Documentation](README.md) | [Repository](../README.md)

The sync script needs Git with `--no-lazy-fetch` support and all required commit, tree and blob
objects already present locally. It disables implicit downloads in every mode.
Before you run it, explicitly fetch missing objects. Older Git versions without this option stop with an unknown-option error.

Use a local checkout of `vectorize-io/hindsight` and resolve the intended upstream ref to a commit:

```sh
git -C ../hindsight fetch origin --tags
git -C ../hindsight rev-parse origin/main
python3 scripts/sync-upstream.py ../hindsight <40-character-commit>
```

The sync verifies both old pristine snapshots, merges local adaptations with Git's three-way merge,
and updates both pins. A content, addition or deletion conflict stops the sync before it writes any source or manifest.
Before you retry, reconcile that file against the old and new upstream commits. OpenClaw keeps only
its explicitly imported files. Its rewritten entrypoint, setup and manifest stay router-owned.

Review the diff, including upstream behavior and independent downstream package versions.
Run:

```sh
npm run upstream:accept
python3 scripts/sync-upstream.py ../hindsight --patch-only
python3 scripts/sync-upstream.py ../hindsight --check
npm ci
npm ci --prefix src/upstream/coding-agents
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run build:coding-agents
npm exec --prefix src/upstream/coding-agents -- tsc --noEmit -p src/upstream/coding-agents/tsconfig.json
npm test --prefix src/upstream/coding-agents
```

`upstream:accept` records reviewed adaptations. You must still review conflicts.
`--patch-only` regenerates the complete coding-agent patch, including local additions and deletions. The patch uses one line of unified context and preserves exact reconstruction with standard
`git apply`. It omits no adapted content.

After further adapted-source edits, repeat both commands. Then run `--check` again.

`--check` is read-only. It validates both pristine inventories and versions against their exact commits in the supplied upstream Git checkout. It needs matching packaged and canonical coding-agent `UPSTREAM.json` manifests. It also compares the bytes of the reconstructed patch with `router.patch`.

It never refreshes hashes or accepts a changed patch. The checkout must contain both pinned commits. Changes to pins or recorded hashes alone cannot satisfy verification. Run this check during upstream review.

The normal inventory checks in CI do not download upstream or replace this provenance check.

Pack both packages with the npm version pinned in `.github/workflows/ci.yml`. Refresh all entries
in `PACKAGE_SHA256` and the OpenClaw source hash in `PACKAGE_NIX_HASHES`. Recompute `npm_deps` with the
CI Nix command only if root `npm-shrinkwrap.json` changed. CI rebuilds and byte-compares the packages.

Merge after PR checks pass. Follow [Releasing](RELEASING.md) for the release checkbox and frozen inputs.

## Retiring the standalone MCP package

New releases contain two packages: OpenClaw (including the hosted HTTP client) and coding agents
(including the upstream coding-agent MCP server). New releases no longer include the separate `@mickey-kras/hindsight-memory-router-mcp` package. Earlier release artifacts and stored memories stay available. Migration does not delete or rewrite user data.

Before you remove its registration, drain pending standalone retain queues with the earlier installed version. Keep its queue directory until you check replay. The coding-agent installer does not import those queues.

Remove the old standalone server registration. Install the verified coding-agents artifact from
an explicitly mapped project using the [coding-agent setup](../integrations/coding-agents/README.md).
Its installer registers MCP with the selected harness identity. Keep that harness's named token
and `HINDSIGHT_ROUTER_CONFIG` in the managed launch environment. Direct registrations must set
`HINDSIGHT_MCP_HARNESS` and use the mapped project as cwd (or `HINDSIGHT_MCP_PROJECT_CWD`).

Update tool calls and allowlists to the coding-agent tools: `hindsight_ingest_document`,
`hindsight_search_knowledge_pages`, `hindsight_list_knowledge_pages`,
`hindsight_read_knowledge_page`, `hindsight_reflect`, `hindsight_capture_initiative`,
`hindsight_sync_status` and `hindsight_diagnose` (or the selected `toolPrefix`). Their upstream schemas apply.
Old retain and recall and raw page CRUD names and arguments have no compatibility wrappers. Generic non-coding MCP hosts are outside this integration's supported scope.

