# hindsight-memory-router-openclaw

Per-agent OpenClaw memory plugin for [hindsight-memory-router](https://github.com/mickey-kras/hindsight-memory-router).

```text
OpenClaw (this plugin) -> Memory Router -> Hindsight
```

Forks the Vectorize OpenClaw integration v0.11.1 (`src/upstream/`, see `UPSTREAM_VERSION`; full tree restorable and byte-verified via `scripts/import-upstream.sh` + `src/upstream/SHA256SUMS`). The routing layer in `src/router/` is independent of upstream.

## Model

- Every OpenClaw agent has its own Memory Router token, one default write bank, zero or more recall banks.
- The trusted OpenClaw `ctx.agentId` selects credentials. Identity is never taken from prompts, model output, tool arguments, tags, session keys, or user content.
- Unknown/missing agent mapping fails closed. No global fallback token.
- Authorization is server-side (Memory Router principal grants); the plugin never decides permissions.

## Config

```json
{
  "routerUrl": "https://memory-router.example.internal",
  "agents": {
    "main": {
      "token": { "source": "exec", "provider": "op", "id": "memory-router-main" },
      "writeBank": "main",
      "recallBanks": ["main", "dev", "creative"]
    },
    "backend": {
      "token": { "source": "exec", "provider": "op", "id": "memory-router-backend" },
      "writeBank": "dev",
      "recallBanks": ["dev", "dev-best-practices"]
    }
  }
}
```

- Tokens are declared as SecretRefs in the manifest (`agents.*.token`) and resolved by OpenClaw; an unresolved SecretRef object fails closed.
- `routerUrl` must be HTTPS. Certificate verification is never disabled. Credentials in the URL are rejected. Redirects never forward Authorization to another origin.
- Plugin config id: `hindsight-memory-router`.

## Behavior

| Flow | Routing |
| --- | --- |
| auto-recall (`before_prompt_build`) | all configured recall banks, merged |
| auto-retain (`agent_end`, `session_end`) | default write bank; transient failures queue per agent |
| `agent_knowledge_*` tools | writes/ingest -> write bank; recall -> recall banks |

Multi-bank recall: shared timeout, shared context token budget, dedupe by content, deterministic ranking (score desc, bank asc, content asc). Authorization denial on any bank fails the whole recall closed. Other bank failures return partial recall and log a warning naming the failed banks.

Retain queue: `queueDir/hindsight-retain-queue.<agent>.jsonl`; replay re-resolves that agent's credentials and preserves the bank target. Tokens are never written to the queue.

## Upgrade workflow

1. Import next upstream integration into `src/upstream/`.
2. Keep `src/router/` unchanged; resolve only composition-point conflicts in `src/plugin.ts`.
3. Run upstream-derived tests and router identity/multi-bank tests (`npm test`).
4. Bump `-router.<revision>`, publish, pin immutably.

## Versioning

`<upstream-version>-router.<revision>`, e.g. `0.11.1-router.1`. Reproducible contents via `npm-shrinkwrap.json`.

Deviations from upstream: [docs/DEVIATIONS.md](docs/DEVIATIONS.md).
