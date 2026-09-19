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
Queued transcripts are plaintext JSONL (mode 0600) and never expire by default (`retainQueueMaxAgeMs: -1`); the plugin warns loudly at startup while retention is unbounded.
Set `retainQueueMaxAgeMs` to bound retention, and use full-disk encryption for at-rest confidentiality - the plugin does not encrypt queue contents.
An item whose replay fails 5 times is abandoned: dropped from the queue and reported as a loud error log via the coordinator's `onAbandon` handler.

Artifact: `packages/mickey-kras-hindsight-memory-router-openclaw-0.12.0.tgz`.
Nix hashes: `PACKAGE_NIX_HASHES`.
