# Coding agents

Source: `vectorize-io/hindsight/hindsight-integrations/coding-agents`, v0.8.2.
The superseded per-agent integrations are not imported.

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

Resolve each named environment variable through the deployment's secret manager before launching that harness.
Give each harness only its own token. Never put token values in JSON, arguments, or this repository.
Create matching per-principal + bank + scope grants in Memory Router first.

**client routing != authorization; Memory Router grants are authoritative**

Install the verified release coding-agents tarball and run its `hindsight-coding-agents install` command.
The upstream harness hooks, plugin entrypoints, transcript readers, and background ingestion remain packaged.
Install from this artifact; do not run upstream's `npx` installer over it.

Only explicit managed path mappings opt a project in. Child directories inherit their mapping.
Use the principal's write bank in mappings for writable projects; map an assigned read bank for a read-only principal.
Unmapped paths, unknown harnesses, and missing secrets fail closed. No dynamic repository banks.
Upstream normal config may tune prompts and ingestion, but cannot change identity, credentials, endpoint, or grants. `banks.<id>.bank` and path-level bank renames are ignored; change the operator-managed `mapPathToBank` and matching server grants instead.

Legacy managed JSON keys `recallTimeoutMs`, `recallMaxTokens`, `retainQueueFlushIntervalMs`, `queueMaxAgeMs`, `queueMaxItems`, `queueMaxBytes` and `queueDir` are accepted and validated for compatibility but have no effect in coding agents. Remove them when migrating; tune retrieval in normal coding-agent config. There is no OpenClaw-style durable outage queue or replay timer here; ingestion uses the upstream retry/cursor mechanisms. Managed `queueMaxAgeMs` accepts `-1` or a positive integer and rejects `0`, unlike OpenClaw.

`pageRefreshEveryTurns` (and `HINDSIGHT_PAGE_REFRESH_EVERY_TURNS`) does not reduce hook page-list reads: memory-bearing page lists are deliberately omitted from session caches, so each prompt hook fetches freshly authorized pages. The setting still controls how often the roster/tool guide is injected, not how often it is fetched; omission or `0` means every turn (`1`). It does not configure persistent-plugin refresh behavior. Do not restore cached memory content to implement a cadence.

Recall and reflect read the assigned union, with a 4,096-token shared budget.
Recall/reflect use the caller's configured deadline: automatic retrieval uses `injectTimeoutMs` (7,000 ms), automatic reflect uses `reflectTimeoutMs` (20,000 ms), and the reflect tool uses `reflectToolTimeoutMs` (when omitted, the greater of 330,000 ms and the configured `reflectTimeoutMs`; an explicit positive tool timeout can be lower). Generic requests without a caller signal default to 15 seconds. Raising a hook deadline also requires enough time in the host hook configuration.
Transient failures return partial results with a diagnostic. Any 401/403 discards all results.
Other bank/config/page reads use an explicit assigned bank; mutations cannot target additional read banks.

See `DEVIATIONS.md` for intentional differences and `UPSTREAM.json` for exact provenance.
