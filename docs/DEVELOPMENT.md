# Build and verify

[Documentation](README.md) | [Repository](../README.md)

Requires Node.js 22 or later. From the repository root:

```sh
npm ci
npm ci --prefix src/upstream/coding-agents
npm ci --prefix src/mcp
npm run test:coverage
npm run build
npm run build:coding-agents
npm test --prefix src/upstream/coding-agents
npm audit --audit-level=moderate
npm audit --prefix src/upstream/coding-agents --audit-level=moderate
node scripts/verify-coding-upstream.mjs
```

Packages are built from source by CI (`npm pack`) and attached to the GitHub release; their SHA-256 hashes are pinned in `PACKAGE_SHA256` and Nix hashes in `PACKAGE_NIX_HASHES`. Tarballs are never committed (`packages/` is gitignored).
OpenClaw provenance: `UPSTREAM_VERSION`; coding-agents provenance: `integrations/coding-agents/UPSTREAM.json`.
Local revisions are independent of upstream versions. Upgrade either integration separately.
Dependabot preparation increments the patch version of each package whose dependency files change and regenerates its shrinkwrap, provenance, and package hash pins before the existing PR checks run.



Coding-agent provenance and deviations live in [`UPSTREAM.json`](../integrations/coding-agents/UPSTREAM.json), [`LOCAL_CHANGES.json`](../integrations/coding-agents/LOCAL_CHANGES.json), [`router.patch`](../integrations/coding-agents/router.patch) and [vendored deviations](../src/upstream/coding-agents/DEVIATIONS.md). After intentional vendored edits, run `npm run upstream:accept`; CI rejects unrecorded drift. Vendored dependencies move with upstream's tested lockfile during re-vendoring and are excluded from Dependabot.

See [upstream upgrades](UPGRADING.md), [deviations](DEVIATIONS.md), [dependency updates](dependabot.md) and [releasing](RELEASING.md).
