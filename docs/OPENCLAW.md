# OpenClaw

[Documentation](README.md) | [Repository](../README.md)

Requires Node.js 22 or later and an HTTPS Memory Router endpoint. Install the OpenClaw `.tgz` from the [selected release](https://github.com/mickey-kras/hindsight-memory-router-integrations/releases), verifying its hash against that release's `PACKAGE_SHA256`.

Install the downloaded archive using the [OpenClaw plugin CLI](https://docs.openclaw.ai/cli/plugins/install):

```sh
openclaw plugins install /absolute/path/downloaded-openclaw.tgz
```

Replace the path with the verified release artifact. OpenClaw may require a newer Node.js version than this package's minimum.

## Configure an agent

Plugin ID: `hindsight-memory-router`. Put the following settings under `plugins.entries.hindsight-memory-router.config` in your OpenClaw configuration. Create matching [server-side principal grants](https://github.com/mickey-kras/hindsight-memory-router/blob/main/docs/security/authentication.md), then use an OpenClaw-resolved SecretRef per agent.

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

Enable the configured plugin with `openclaw plugins enable hindsight-memory-router`.

Migrate `recallBanks` to `additionalReadBanks`; the write bank is now always readable.
Omit `writeBank` for read-only principals. Knowledge tools require `enableKnowledgeTools: true`.
Read-only page tools require an explicit assigned `bankId`.

## Manage retained transcripts

See [queue limits and locking](BEHAVIOR.md) before sharing a queue directory.

Retain queues: `~/.openclaw/data/hindsight-retain-queue/`. Revoked/moved bank entries remain queued for operator review.
Queued transcripts are plaintext JSONL (mode 0600) and never expire by default (`retainQueueMaxAgeMs: -1`); the plugin warns loudly at startup while retention is unbounded.
Set `retainQueueMaxAgeMs` to bound retention, and use full-disk encryption for at-rest confidentiality - the plugin does not encrypt queue contents.
An item whose replay fails 5 times is abandoned: dropped from the queue and reported as a loud error log via the coordinator's `onAbandon` handler.

## Audit logs

Audit trail: every recall, retain, and knowledge-tool invocation logs one single-line JSON record
via the host logger (`info` level) with `at`, `principal`, `op`, `bankId`, `outcome`, and a bounded
`errorClass` on failure. Memory content, transcripts, and page titles are never logged.

Package versions vary by release. [Release instructions](RELEASING.md) describe source builds, SHA-256 pins and Nix hashes.
