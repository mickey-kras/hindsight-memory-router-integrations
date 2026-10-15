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

OpenClaw direct runtime dependencies: `@vectorize-io/hindsight-agent-sdk@0.1.1` and `fs-native-extensions@^1.5.1`. `@vectorize-io/hindsight-client@1.0.0` is a transitive SDK dependency and a direct development dependency, not a direct runtime dependency.

Dependency declarations and exact resolved versions are authoritative in each package's `package.json` and `npm-shrinkwrap.json`. See the [dependency inventory](DEVELOPMENT.md#dependency-inventory).

Not retained: dynamic bank derivation, per-user channel banks, setup/backfill CLIs, local daemon, embedded model configuration, sender-prefix parsing.

Router revision 4 shares transport and bank checks with coding-agents. Page reads are available to read-only principals; queue replay rechecks the current write bank.

Session patterns use global replacements and a literal sentinel lookup; wildcard matching is unchanged. `src/upstream/SHA256SUMS` remains the pristine upstream manifest.

The Agent SDK remains 0.1.1. Its client dependency is overridden to 1.0.0 after verifying its constructor and schema factory exports. The plugin uses only the SDK tool definitions; every executor is replaced by the guarded router transport.

OpenClaw's new native memory-provider registration remains outside the router-owned entrypoint; the explicit managed tools stay registered. Its ended-transcript context type is imported, while the hook retains only its supplied message payload.
