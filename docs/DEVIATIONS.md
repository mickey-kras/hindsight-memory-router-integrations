# Upstream deviations

Base: `vectorize-io/hindsight` OpenClaw integration `v0.11.1`.

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

Published dependencies:

- `@vectorize-io/hindsight-client@0.8.6`
- `@vectorize-io/hindsight-agent-sdk@0.1.0`

Not retained: dynamic bank derivation, per-user channel banks, setup/backfill CLIs, local daemon, embedded model configuration, sender-prefix parsing.

Router revision 2 shares transport and bank checks with coding-agents. Page reads are available to read-only principals; queue replay rechecks the current write bank.

Session patterns use global replacements and a literal sentinel lookup; wildcard matching is unchanged. `src/upstream/SHA256SUMS` remains the pristine upstream manifest.
