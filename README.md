# Hindsight Memory Router integrations

[![PR validation](https://github.com/mickey-kras/hindsight-memory-router-integrations/actions/workflows/pr-validation.yml/badge.svg?event=pull_request)](https://github.com/mickey-kras/hindsight-memory-router-integrations/actions/workflows/pr-validation.yml?query=event%3Apull_request)
[![coverage](https://img.shields.io/badge/coverage-%E2%89%A590%25%20%28CI--gated%29-brightgreen)](vitest.config.ts)
[![codeql](https://github.com/mickey-kras/hindsight-memory-router-integrations/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/mickey-kras/hindsight-memory-router-integrations/actions/workflows/codeql.yml?query=branch%3Amain)
[![aislop](https://badges.scanaislop.com/score/mickey-kras/hindsight-memory-router-integrations.svg)](https://scanaislop.com/mickey-kras/hindsight-memory-router-integrations)
[![main + SonarQube](https://github.com/mickey-kras/hindsight-memory-router-integrations/actions/workflows/main.yml/badge.svg?branch=main)](https://github.com/mickey-kras/hindsight-memory-router-integrations/actions/workflows/main.yml?query=branch%3Amain)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

OpenClaw and the current upstream `coding-agents` package share `src/shared/`.

**client routing != authorization; Memory Router grants are authoritative**

| Integration | Identity | Version source |
| --- | --- | --- |
| OpenClaw | trusted `ctx.agentId` | `package.json` |
| Coding agents | harness entrypoint (`codex`, `claude-code`, `opencode`, etc.) | `src/upstream/coding-agents/package.json` |

Each principal has one optional `writeBank` and `additionalReadBanks`.
Readable banks are their deduplicated union. Mutations target only `writeBank`.
Unassigned banks are rejected locally without contacting the server.
No wildcard, dynamic bank, fallback identity, or credential fallback.

- HTTPS only; redirects rejected; runtime-resolved secrets; sanitized errors.
- Recall/reflect share a deadline and token budget; content dedupe and deterministic order.
- Any 401/403 discards the entire read result. Network/408/429/5xx failures permit partial reads.
- Bank/config/page reads are read operations. Scope checks still belong to Memory Router.
- OpenClaw retain queues recheck the current write bank before replay.

[OpenClaw configuration](docs/OPENCLAW.md) · [Coding agents](integrations/coding-agents/README.md)

## Verify

```sh
npm ci
npm ci --prefix src/upstream/coding-agents
npm run test:coverage
npm run build
npm run build:coding-agents
npm test --prefix src/upstream/coding-agents
npm audit --audit-level=moderate
npm audit --prefix src/upstream/coding-agents --audit-level=moderate
node scripts/verify-coding-upstream.mjs
```

Packages and SHA-256 hashes are committed under `packages/` and `PACKAGE_SHA256`.
OpenClaw provenance: `UPSTREAM_VERSION`; coding-agents provenance: `integrations/coding-agents/UPSTREAM.json`.
Local revisions are independent of upstream versions. Upgrade either integration separately.
