# @mickey-kras/hindsight-memory-router-mcp

Optional MCP server (stdio transport) that lets any MCP-capable agent or harness retain and
recall memories **through Memory Router** with per-principal authorization. The server speaks to
the router only — never to Hindsight directly — so the router's principal grants stay authoritative.

- Retain (`memory_router_retain`) writes only to the principal's configured `writeBank`;
  transient router failures are queued locally and replayed.
- Recall (`memory_router_recall`) fans out to `writeBank` + `additionalReadBanks` under one
  shared deadline and token budget.
- `agent_knowledge_*` page/ingest tools route through the same guarded transport with the bank
  constrained to the principal's visible banks.
- Router 401/403 latches the credential for the rest of the session and fails closed; tool
  errors are bounded and never echo tokens, banks, or grants.
- Retain/recall provenance (`source`) is stamped by the router from its principal registry
  (hindsight-memory-router #279). Set `source` per principal only to record an explicit client-side
  marker in retain metadata.

## Configuration

Two environment variables start the server; credentials are never written into the config file.

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
- `queueDir` must be absolute; defaults to `~/.hindsight-memory-router/retain-queue`.

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
stdio; logs go to stderr. A non-zero exit at startup means the configuration failed validation —
recheck the table above.
