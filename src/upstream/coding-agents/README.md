# Coding agents

Source: `vectorize-io/hindsight/hindsight-integrations/coding-agents`, v0.5.1.
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

Install the committed coding-agents tarball and run its `hindsight-coding-agents install` command.
The upstream harness hooks, plugin entrypoints, transcript readers, and background ingestion remain packaged.
Install from this artifact; do not run upstream's `npx` installer over it.

Only explicit managed path mappings opt a project in. Child directories inherit their mapping.
Use the principal's write bank in mappings for writable projects; map an assigned read bank for a read-only principal.
Unmapped paths, unknown harnesses, and missing secrets fail closed. No dynamic repository banks.
Upstream normal config may tune prompts and ingestion, but cannot change identity, credentials, endpoint, or grants.

Recall and reflect read the assigned union, with a 4,096-token shared budget.
Recall has a 15-second deadline; reflect uses the upstream caller's timeout.
Transient failures return partial results with a diagnostic. Any 401/403 discards all results.
Other bank/config/page reads use an explicit assigned bank; mutations cannot target additional read banks.

See `DEVIATIONS.md` for intentional differences and `UPSTREAM.json` for exact provenance.
