# OpenClaw

[Documentation](README.md) | [Repository](../README.md)

You need Node.js 22.12.0 or later and an HTTPS Memory Router endpoint.
Download the OpenClaw `.tgz` from the [selected release](https://github.com/mickey-kras/hindsight-memory-router-integrations/releases).
Before you install it, verify its hash against that release's `PACKAGE_SHA256`.

Install the downloaded archive using the [OpenClaw plugin CLI](https://docs.openclaw.ai/cli/plugins/install):

```sh
openclaw plugins install /absolute/path/downloaded-openclaw.tgz
```

Replace the path with the verified release artifact. OpenClaw may require a newer Node.js version than this package's minimum. The root entrypoint supports ESM imports and CommonJS `require()` on Node.js 22.12.0 or later. The `./hosted` entrypoint supports ESM imports.

The OpenClaw retain queue does not support Windows. Native lock ownership and crash recovery have verification on Linux. The process-lock tests require POSIX signals. Use a local filesystem with OS file-lock support.

## Configure an agent

Plugin ID: `hindsight-memory-router`. Put the following settings under `plugins.entries.hindsight-memory-router.config` in your OpenClaw configuration. Create matching [server-side principal grants](https://github.com/mickey-kras/hindsight-memory-router/blob/main/docs/security/authentication.md). Use an OpenClaw-resolved SecretRef for each agent.

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

Use `agents`. The plugin rejects the former runtime-only `principals` alias. Before you upgrade, rename that map. Only `agents.*.token` participates in OpenClaw SecretRef resolution. Coding-agent managed JSON still uses `principals`.
Migrate `recallBanks` to `additionalReadBanks`. The write bank is now always readable.
Omit `writeBank` for read-only principals. Knowledge tools require `enableKnowledgeTools: true`.
Read-only page tools require an explicit assigned `bankId`.

## Manage retained transcripts

See [queue limits and locking](BEHAVIOR.md) before sharing a queue directory.

Retain queues: `~/.openclaw/data/hindsight-retain-queue/`. Revoked/moved bank entries remain queued for operator review.
The replay service starts without waiting for delivery and logs background failures before retrying on its interval. Repeated starts share one interval and one active replay. Stop disables scheduling and waits at most one second. Active replay can finish afterward. Pending records stay on disk. Restart does not overlap an unfinished replay.
Queued transcripts use plaintext JSONL (mode 0600). By default, they never expire (`retainQueueMaxAgeMs: -1`).
The plugin gives a warning at startup while retention has no age limit.
To expire ordinary, unprotected queued records, set a positive `retainQueueMaxAgeMs`.
A value of `0` expires those older than the cleanup time. It does not disable enqueue. Quarantines, corrupt ordering barriers, their dependent successors and authorization-protected backlog are exempt. Authorization protection remains after credential recovery, including for fresh work accepted while gated, until delivery or explicit operator recovery. The queue preserves malformed or invalid records separately as exact corrupt bytes for manual recovery.
These bytes stay until the operator removes them. Recovery files exclude valid records. See [queue recovery behavior](BEHAVIOR.md). For at-rest confidentiality, use full-disk encryption. The plugin does not encrypt queue contents.
After 5 transient replay failures (network/408/429/5xx), the queue abandons an ordinary unprotected item.
It removes the item and reports it through the coordinator's `onAbandon` handler. Protected records are never abandoned by that retry limit. An unresolved pre-send `sending` marker protects the backlog and pauses the principal across restarts until its uncertain outcome is reconciled by an operator. Authorization denial gates the principal. Changed-bank and other permanent failures quarantine the affected row. Independent documents can progress.

Replay runs at service startup and every `retainQueueFlushIntervalMs` (default 30,000), up to 50 HTTP attempts per principal per pass, including authorization probes. Cleanup runs during replay, not on an independent expiration timer. Older configurations without an age limit inherit the current `-1` default. During migration, explicitly select a positive limit.

## Audit logs

Each recall, retain and knowledge-tool invocation logs one single-line JSON record through the host logger at `info` level.
The record contains `at`, `principal`, `op`, `bankId` and `outcome`. On failure, it includes a bounded `errorClass`. Memory content, transcripts, and page titles are never logged.

Package versions vary by release. [Release instructions](RELEASING.md) describe source builds, SHA-256 pins and Nix hashes.

Durable retain queues require Linux with enforced POSIX file permissions. Queue directories must be owned by
this user, with trusted parent directories (root/user-owned and not writable by
other users, except sticky directories such as `/tmp`). Existing owned queue
directories and singly linked regular queue/lock files are tightened to `0700`
and `0600` before use. Symlinks, hardlinks, foreign-owned paths and unsupported
platforms fail explicitly. Rewrites use exclusive random temporary files and atomic rename.
Lock files keep their OS-owned lock inodes. This protects
against other OS users planting paths, not arbitrary code running as this user.

The OpenClaw plugin fails initialization on macOS and other unsupported platforms
before accessing queue paths. macOS ACLs can
grant access independently of BSD mode bits; this implementation does not verify
or remove those ACLs. See Apple's [file system access-control policy](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemDetails/FileSystemDetails.html).


