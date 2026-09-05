# OpenClaw

Plugin ID: `hindsight-memory-router`. Use an OpenClaw-resolved SecretRef per agent.

```json
{
  "routerUrl": "https://memory-router.example.internal",
  "agents": {
    "main": {
      "token": { "source": "exec", "provider": "op", "id": "memory-router-main" },
      "writeBank": "main",
      "additionalReadBanks": ["dev", "creative"]
    }
  }
}
```

Migrate `recallBanks` to `additionalReadBanks`; the write bank is now always readable.
Omit `writeBank` for read-only principals. Knowledge tools require `enableKnowledgeTools: true`.
Read-only page tools require an explicit assigned `bankId`.

Retain queues: `~/.openclaw/data/hindsight-retain-queue/`. Revoked/moved bank entries remain queued for operator review.

Artifact: `packages/mickey-kras-hindsight-memory-router-openclaw-0.11.1-router.2.tgz`.
Nix hashes: `PACKAGE_NIX_HASHES`.
