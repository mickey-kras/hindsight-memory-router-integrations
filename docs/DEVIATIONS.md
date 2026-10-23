# Upstream deviations

[Documentation](README.md) | [Repository](../README.md)

Base: `vectorize-io/hindsight` OpenClaw integration `v1.0.0`.

| Area | Upstream | Router plugin |
| --- | --- | --- |
| Endpoint | Local daemon or direct Hindsight | Memory Router only |
| Token | One plugin token | One token per agent |
| Identity | Context or session-key parsing | `ctx.agentId` only |
| Banks | Dynamic channel/user banks | Declared write/read banks |
| Recall | One bank | Multi-bank merge |
| Queue | Shared JSONL | Per-agent JSONL |
| Bank defaults | Applied on first use | Deployment runbook |
| Daemon/setup/backfill | Included | Removed |

Reused source: `src/upstream/src/{retain-queue,session-patterns,types}.ts`.

OpenClaw direct production dependencies: `@vectorize-io/hindsight-agent-sdk@0.1.1`, `@vectorize-io/hindsight-client@1.1.0` and `fs-native-extensions@^1.5.1`. The client package supplies types required by the exported TypeScript declarations, including `MinScores`.

Each package's `package.json` and `npm-shrinkwrap.json` define its dependencies and exact resolved versions. See the [dependency inventory](DEVELOPMENT.md#dependency-inventory).

Not retained: dynamic bank derivation, per-user channel banks, setup/backfill CLIs, local daemon, embedded model configuration, sender-prefix parsing.

Router revision 4 shares transport and bank checks with coding-agents. Read-only principals can read pages. Queue replay checks the current write bank again.

Session patterns use global replacements and a literal sentinel lookup. Wildcard matching does not change. `src/upstream/SHA256SUMS` remains the pristine upstream manifest.

The Agent SDK remains 0.1.1. The repository overrides its client dependency to 1.1.0 after verifying its constructor and schema factory exports. The plugin uses only the SDK tool definitions. The guarded router transport replaces every executor.

OpenClaw's new native memory-provider registration stays outside the router-owned entrypoint. The explicit managed tools stay registered.
The plugin imports its ended-transcript context type. The hook retains only the supplied message payload.

