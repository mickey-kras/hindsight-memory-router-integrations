# @mickey-kras/hindsight-memory-router-mcp

[Documentation](../../docs/README.md) | [Repository](../../README.md)

Optional stdio MCP server for retaining and recalling memories through Memory Router with per-principal authorization. The router enforces grants; the server never calls Hindsight directly.

- Retain (`hindsight_retain`) writes only to the principal's configured `writeBank`;
  transient router failures are queued locally and replayed.
- Recall (`hindsight_recall`) fans out to `writeBank` + `additionalReadBanks` under one
  shared deadline and token budget.
- `hindsight_*` page/ingest tools route through the same guarded transport with the bank
  constrained to the principal's visible banks.
- Router 401/403 latches the credential for the rest of the session and fails closed; tool
  errors are bounded and never echo tokens, banks, or grants.
- Retain/recall provenance (`source`) is stamped by the router from its principal registry
  (hindsight-memory-router #279). Set `source` per principal only to record an explicit client-side
  marker in retain metadata.
- Every tool invocation writes one single-line JSON audit record to stderr (`at`, `principal`, `op`,
  `bankId`, `outcome`, bounded `errorClass` on failure, including invalid arguments). Memory content
  and query text are never logged.

## Configuration

Set the config path, principal ID and the environment variable holding that principal's token. Keep credentials out of the config file.

| Variable | Purpose |
| --- | --- |
| `HINDSIGHT_ROUTER_CONFIG` | Absolute path to the managed config JSON (required). |
| `HINDSIGHT_ROUTER_PRINCIPAL` | Principal id inside `principals` (required). |
| `<tokenEnv>` | The env var named by the principal's `tokenEnv`; holds the `mr_*` router token. |

Config file:

```json
{
  "routerUrl": "https://router.example.com",
  "recallTimeoutMs": 15000,
  "recallMaxTokens": 4096,
  "retainQueueFlushIntervalMs": 30000,
  "queueMaxAgeMs": -1,
  "queueMaxItems": 1000,
  "queueMaxBytes": 16777216,
  "queueDir": "/absolute/path/for/retain-queue",
  "principals": {
    "my-agent": {
      "tokenEnv": "MY_AGENT_ROUTER_TOKEN",
      "writeBank": "my-agent-bank",
      "additionalReadBanks": ["team-shared"],
      "source": "my-product"
    }
  }
}
```

Rules (all fail closed at startup):

- `routerUrl` must be HTTPS, no userinfo, no query/fragment.
- `tokenEnv` must match `[A-Z_][A-Z0-9_]*`; inline `token`/`apiToken` keys are rejected.
- Bank ids must be concrete names: wildcards, `.`/`..`, empty or oversized ids are rejected.
- `writeBank` may be omitted for a read-only principal (retain/write tools are then not exposed).
- `recallTimeoutMs`, `recallMaxTokens`, `retainQueueFlushIntervalMs` must be positive integers.
- `queueMaxAgeMs` must be -1 (default, keep queued retains forever) or a positive integer.
- `queueMaxItems` (1,000) and `queueMaxBytes` (16 MiB) are positive integer limits shared across every principal in `queueDir`. Each item reserves 128 additional bytes for replay metadata. Full queues reject new retains with `RetainQueueCapacityError`; no success/queued result is returned.
- Queue writes and replay mutations use OS-owned file locks through `fs-native-extensions`; paused writers keep ownership, and process termination releases it automatically. All writers sharing `queueDir` must use matching limits and this package version on a local filesystem with OS file-lock support. Do not remove the two `.retain-*.lock` files while writers are running. Replay is serialized per directory; enqueue uses a separate lock. Increase the byte limit to replay a legacy backlog larger than the configured limit.
- `queueDir` must be absolute; defaults to `~/.hindsight-memory-router/retain-queue`. Queued retains are
  plaintext JSONL (mode 0600) and expire only when `queueMaxAgeMs` is set; use full-disk encryption for
  at-rest confidentiality.
  An item whose replay fails 5 times is abandoned: dropped from the queue and logged loudly to stderr.

Upgrade: older queue entries may use `documentId: "conversation"` for requests that omitted an ID.
Existing IDs are replayed unchanged. Before restarting, remove that field only from entries confirmed
to have been submitted without an ID; preserve caller-supplied IDs.

## Run

```sh
npm install -g @mickey-kras/hindsight-memory-router-mcp
export MY_AGENT_ROUTER_TOKEN="mr_..."
export HINDSIGHT_ROUTER_CONFIG=/etc/memory-router/mcp.json
export HINDSIGHT_ROUTER_PRINCIPAL=my-agent
hindsight-memory-router-mcp
```

Or register it with any MCP host as a stdio server command
(`npx @mickey-kras/hindsight-memory-router-mcp` also works). The process speaks JSON-RPC on
stdio; logs go to stderr. A non-zero exit at startup means the configuration failed validation;
recheck the table above.


### Tool namespace and migration

Set `toolPrefix` once at the top level of the JSON file named by `HINDSIGHT_ROUTER_CONFIG`.
When omitted, tool names use `hindsight_`. A custom prefix must contain 2–32 lowercase ASCII
letters, digits or underscores, start with a letter, and end with an underscore (for example
`"toolPrefix": "team_"`). The same value controls registered MCP/native tools, installed companion
skills, hook guidance and survey tool permissions. Normal coding-agent configuration, per-bank
settings and environment overrides cannot select another tool namespace. Invalid prefixes,
duplicate tool names and inconsistent skill namespaces fail closed.

To migrate existing `memory_router_*` retain/recall names and `agent_knowledge_*` page/ingest names,
update client tool calls and allowlists to the selected prefix, reinstall each coding-agent harness
to regenerate its companion skill, and restart existing MCP/native sessions. Both old namespaces
converge on the single selected prefix; no aliases are silently registered. A consumer that needs
its existing namespace may explicitly select `memory_router_` or `agent_knowledge_`, then update
its other tool calls to that same prefix. A runtime session rejects a stale skill with another
prefix; explicit reinstall is the migration action. Bank assignments, router grants, token sources,
read/write authorization and each operation's arguments and behavior are unchanged.
