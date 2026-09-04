# Hindsight Memory Router integrations

OpenClaw and the current upstream `coding-agents` package share `src/shared/`.

**client routing != authorization; Memory Router grants are authoritative**

| Integration | Identity | Package version |
| --- | --- | --- |
| OpenClaw | trusted `ctx.agentId` | `0.11.1-router.2` |
| Coding agents | harness entrypoint (`codex`, `claude-code`, `opencode`, etc.) | `0.5.1-router.1` |

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
