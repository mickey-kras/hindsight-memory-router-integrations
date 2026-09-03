# hindsight-memory-router-openclaw

OpenClaw plugin for [hindsight-memory-router](https://github.com/mickey-kras/hindsight-memory-router).

`OpenClaw -> plugin -> Memory Router -> Hindsight`

Upstream: Vectorize OpenClaw integration `v0.11.1`. See `UPSTREAM_VERSION` and `docs/DEVIATIONS.md`.

## Rules

- Identity: trusted `ctx.agentId` only.
- Credentials: one Memory Router token per configured agent.
- Routing: optional write bank; zero or more recall banks.
- Authorization: Memory Router grants only.
- Unknown agent, missing token, unresolved SecretRef: fail closed.
- Transport: HTTPS, verified certificates, no URL credentials.
- Secrets: process memory only; never queues or logs.

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
    },
    "reader": {
      "token": { "source": "exec", "provider": "op", "id": "memory-router-reader" },
      "recallBanks": ["main"]
    }
  }
}
```

Plugin ID: `hindsight-memory-router`.

`agents.*.token` is an OpenClaw SecretRef. Omit `writeBank` for read-only agents.

Immutable npm-pack artifact: `packages/mickey-kras-hindsight-memory-router-openclaw-0.11.1-router.1.tgz`.
Nix hashes: `PACKAGE_NIX_HASHES`.

## Flows

| Flow | Banks |
| --- | --- |
| Auto-recall | All `recallBanks` |
| Auto-retain | `writeBank` |
| Recall tool | All `recallBanks` |
| Other knowledge tools | `writeBank` |

Knowledge tools are disabled by default. Enable with `enableKnowledgeTools: true`.

Multi-bank recall: one timeout, one token budget, content dedupe, deterministic ranking. Any `401/403` fails closed. Other bank failures return partial results and log failed bank IDs.

Transient retain failures (`408`, `429`, `5xx`, network) queue per agent. `4xx` validation failures do not queue. Default queue: `~/.openclaw/data/hindsight-retain-queue/`.

## Upgrade

1. Update `UPSTREAM_VERSION`.
2. Run `scripts/import-upstream.sh`.
3. Review `docs/DEVIATIONS.md`.
4. Run `npm ci && npm test && npm run build && npm pack --dry-run`.
5. Bump `<upstream>-router.<revision>`.
