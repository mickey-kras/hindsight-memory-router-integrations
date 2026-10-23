# Coding agents

Source: `vectorize-io/hindsight/hindsight-integrations/coding-agents`, v0.8.2.
This fork does not import the superseded per-agent integrations.

Set `HINDSIGHT_ROUTER_CONFIG` to an absolute, operator-managed JSON file:

```json
{
  "routerUrl": "https://memory-router.example.internal",
  "principals": {
    "codex": {
      "tokenEnv": "MEMORY_ROUTER_CODEX_TOKEN",
      "writeBank": "A",
      "additionalReadBanks": ["B", "C"],
      "mapPathToBank": { "/work/project": "A" }
    },
    "claude-code": {
      "tokenEnv": "MEMORY_ROUTER_CLAUDE_TOKEN",
      "writeBank": "A",
      "additionalReadBanks": ["B", "C"],
      "mapPathToBank": { "/work/project": "A" }
    },
    "opencode": {
      "tokenEnv": "MEMORY_ROUTER_OPENCODE_TOKEN",
      "writeBank": "D",
      "additionalReadBanks": ["B", "E"],
      "mapPathToBank": { "/work/other": "D" }
    }
  }
}
```

Before you start a harness, resolve each named environment variable through the deployment's secret manager.
Give each harness only its own token. Never put token values in JSON, arguments, or this repository.
First, create matching grants for each principal, bank and scope in Memory Router.

Client routing does not grant access. Memory Router grants control access.

Install the verified release coding-agents tarball.
Run its `hindsight-coding-agents install` command.
The upstream harness hooks, plugin entrypoints, transcript readers, and background ingestion remain packaged.
Install from this artifact. Do not replace it with upstream's `npx` installer.

Only explicit managed path mappings opt a project in. Child directories inherit their mapping.
For writable projects, use the principal's write bank in mappings. For a read-only principal, map an assigned read bank.
Unmapped paths, unknown harnesses, and missing secrets stop access. The integration does not create dynamic repository banks.
Normal upstream configuration can adjust prompts and ingestion. It cannot change identity, credentials, endpoint, or grants.
The integration ignores `banks.<id>.bank` and path-level bank renames.
To change banks, change the operator-managed `mapPathToBank` and matching server grants.

Coding agents accept and validate legacy managed JSON keys for compatibility. These keys have no effect:
`recallTimeoutMs`, `recallMaxTokens`, `retainQueueFlushIntervalMs`, `queueMaxAgeMs`, `queueMaxItems`, `queueMaxBytes` and `queueDir`.
During migration, remove them. Adjust retrieval in normal coding-agent configuration.
Coding agents have no OpenClaw-style durable outage queue or replay timer. Ingestion uses the upstream retry/cursor mechanisms.
Managed `queueMaxAgeMs` accepts `-1` or a positive integer. Unlike OpenClaw, it rejects `0`.

`pageRefreshEveryTurns` and `HINDSIGHT_PAGE_REFRESH_EVERY_TURNS` do not reduce hook page-list reads.
Session caches omit page lists that contain memory. Each prompt hook fetches newly authorized pages.
The setting controls how often the roster/tool guide is injected. It does not control how often the guide is fetched.
An omitted value or `0` means every turn (`1`). The setting does not configure persistent-plugin refresh behavior.
Do not restore cached memory content to control refresh frequency.

Recall and reflect read the assigned union, with a 4,096-token shared budget.
Recall/reflect use the caller's configured deadline:

- Automatic retrieval uses `injectTimeoutMs` (7,000 ms).
- Automatic reflect uses `reflectTimeoutMs` (20,000 ms).
- The reflect tool uses `reflectToolTimeoutMs`. If omitted, this is the greater of 330,000 ms and the configured `reflectTimeoutMs`. An explicit positive tool timeout can be lower.

Generic requests without a caller signal default to 15 seconds.
If you increase a hook deadline, also allow sufficient time in the host hook configuration.
Transient failures return partial results with a diagnostic. Any 401/403 discards all results.
Other bank/config/page reads use an explicit assigned bank. Mutations cannot target additional read banks.

See `DEVIATIONS.md` for intentional differences and `UPSTREAM.json` for exact provenance.

