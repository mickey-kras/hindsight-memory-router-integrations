# OpenClaw

[Documentation](README.md) | [Repository](../README.md)

Requires Node.js 22.12.0 or later and an HTTPS Memory Router endpoint. Install the OpenClaw `.tgz` from the [selected release](https://github.com/mickey-kras/hindsight-memory-router-integrations/releases), verifying its hash against that release's `PACKAGE_SHA256`.

Install the downloaded archive using the [OpenClaw plugin CLI](https://docs.openclaw.ai/cli/plugins/install):

```sh
openclaw plugins install /absolute/path/downloaded-openclaw.tgz
```

Replace the path with the verified release artifact. OpenClaw may require a newer Node.js version than this package's minimum. The root entrypoint supports ESM imports and CommonJS `require()` on Node.js 22.12.0 or later; `./hosted` supports ESM imports.

Windows is not currently supported for the OpenClaw retain queue: native lock ownership and crash recovery are verified on Linux, while the process-lock tests require POSIX signals. Use a local filesystem with OS file-lock support.

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

Use `agents`, not the former runtime-only `principals` alias, which is now rejected. Rename that map before upgrading; only `agents.*.token` participates in OpenClaw SecretRef resolution. Coding-agent managed JSON still uses `principals`.
Migrate `recallBanks` to `additionalReadBanks`; the write bank is now always readable.
Omit `writeBank` for read-only principals. Knowledge tools require `enableKnowledgeTools: true`.
Read-only page tools require an explicit assigned `bankId`.

## Manage retained transcripts

See [queue limits and locking](BEHAVIOR.md) before sharing a queue directory.

Retain queues: `~/.openclaw/data/hindsight-retain-queue/`. Revoked/moved bank entries remain queued for operator review.
The replay service starts without waiting for delivery and logs background failures before retrying on its interval. Repeated starts share one interval and one active replay. Stop disables scheduling and waits at most one second; active replay may finish afterward, while pending records stay on disk. Restart does not overlap an unfinished replay.
Queued transcripts are plaintext JSONL (mode 0600) and never expire by default (`retainQueueMaxAgeMs: -1`); the plugin warns loudly at startup while retention is unbounded.
Set a positive `retainQueueMaxAgeMs` to bound retention of valid queued records (`0` expires records older than the cleanup time; it does not disable enqueue). Malformed or invalid records are preserved separately as exact corrupt bytes for manual recovery and remain until manually removed; valid records are excluded from these recovery files. See [queue recovery behavior](BEHAVIOR.md). Use full-disk encryption for at-rest confidentiality - the plugin does not encrypt queue contents.
An item with 5 transient replay failures (network/408/429/5xx) is abandoned: dropped from the queue and reported through the coordinator's `onAbandon` handler. Authorization, changed-bank and other permanent failures do not increment this counter; they stop that queue's replay for operator review. Configured age cleanup can still remove expired valid records.

Replay runs at service startup and every `retainQueueFlushIntervalMs` (default 30,000), up to 50 items per principal per pass. Cleanup runs during replay, not on an independent expiration timer. Older configurations that omitted the age limit inherit the current `-1` default; choose a positive limit explicitly when migrating.

## Audit logs

Audit trail: every recall, retain, and knowledge-tool invocation logs one single-line JSON record
via the host logger (`info` level) with `at`, `principal`, `op`, `bankId`, `outcome`, and a bounded
`errorClass` on failure. Memory content, transcripts, and page titles are never logged.

Package versions vary by release. [Release instructions](RELEASING.md) describe source builds, SHA-256 pins and Nix hashes.

Durable retain queues require Linux with enforced POSIX file permissions. Queue directories must be owned by
this user, with trusted parent directories (root/user-owned and not writable by
other users, except sticky directories such as `/tmp`). Existing owned queue
directories and singly linked regular queue/lock files are tightened to `0700`
and `0600` before use. Symlinks, hardlinks, foreign-owned paths and unsupported
platforms fail explicitly. Rewrites use exclusive random temporary files and
atomic rename; lock files retain their OS-owned lock inodes. This protects
against other OS users planting paths, not arbitrary code running as this user.

The OpenClaw plugin fails initialization on macOS and other unsupported platforms
before accessing queue paths. macOS ACLs can
grant access independently of BSD mode bits; this implementation does not verify
or remove those ACLs. See Apple's [file system access-control policy](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemDetails/FileSystemDetails.html).
