# OpenClaw

[Documentation](README.md) | [Repository](../README.md)

You need Node.js 22.12.0 or later and an HTTPS endpoint for Memory Router.
Download the OpenClaw `.tgz` from the [selected release](https://github.com/mickey-kras/hindsight-memory-router-integrations/releases).
Before you install it, check its hash against that release's `PACKAGE_SHA256`.

Install the downloaded archive using the [OpenClaw plugin CLI](https://docs.openclaw.ai/cli/plugins/install):

```sh
openclaw plugins install /absolute/path/downloaded-openclaw.tgz
```

Replace the path with the verified release artifact. OpenClaw can need a newer Node.js version than this package's minimum. At the root entrypoint, the package supports ESM imports and CommonJS `require()` on Node.js 22.12.0 or later. Use `./hosted` for ESM imports.

The OpenClaw retain queue does not support Windows. Native lock ownership and crash recovery have verification on Linux. The process-lock tests need POSIX signals. Use a local filesystem with OS file-lock support.

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

Use `agents`. The plugin rejects the former runtime-only `principals` alias. Before you upgrade, rename that map. Only `agents.*.token` participates in OpenClaw SecretRef resolution.

Coding-agent managed JSON still uses `principals`. Migrate `recallBanks` to `additionalReadBanks`. The write bank is now always readable. Omit `writeBank` for read-only principals.

Knowledge tools need `enableKnowledgeTools: true`. Read-only page tools need an explicit assigned `bankId`.

## Manage retained transcripts

See [queue limits and locking](BEHAVIOR.md) before sharing a queue directory.

Retain queues: `~/.openclaw/data/hindsight-retain-queue/`. Entries for revoked or moved banks remain queued for operator review. The replay service starts without waiting for delivery and logs background failures before retrying on its interval. Repeated starts share one interval and one active replay.

A stop request disables scheduling and waits at most one second. Active replay can finish afterward. Pending records stay on disk. Restart does not overlap an unfinished replay.

Queued transcripts use plaintext JSONL (mode 0600). By default, they never expire (`retainQueueMaxAgeMs: -1`). The plugin gives a warning at startup while retention has no age limit. To expire ordinary, unprotected queued records, set a positive `retainQueueMaxAgeMs`.

A value of `0` expires those older than the cleanup time. It does not disable enqueue. Quarantines, corrupt ordering barriers, their dependent successors and authorization-protected backlog are exempt. Authorization protection remains after credential recovery, including for fresh work accepted while gated, until delivery or explicit operator recovery.

The queue preserves malformed or invalid records separately as exact corrupt bytes for manual recovery. These bytes stay until the operator removes them. Recovery files exclude valid records. See [queue recovery behavior](BEHAVIOR.md).

For at-rest confidentiality, use full-disk encryption. The plugin does not encrypt queue contents. After 5 transient replay failures (network/408/429/5xx), the queue abandons an ordinary unprotected item. It removes the item and reports it through the coordinator's `onAbandon` handler.

That retry limit never abandons protected records. An unresolved pre-send `sending` marker protects the backlog and pauses the principal across restarts until an operator reconciles its uncertain outcome. Authorization denial gates the principal. Changed-bank and other permanent failures quarantine the affected row.

Independent documents can progress.

Replay runs at service startup and every `retainQueueFlushIntervalMs` (default 30,000), up to 50 HTTP attempts per principal per pass, including authorization probes. Cleanup runs during replay, not on an independent expiration timer. Older configurations without an age limit inherit the current `-1` default. During migration, explicitly select a positive limit.

## Audit logs

Each recall, retain and knowledge-tool invocation logs one single-line JSON record through the host logger at `info` level.
The record contains `at`, `principal`, `op`, `bankId` and `outcome`. On failure, it includes a bounded `errorClass`. The logger never records memory content, transcripts or page titles.

Package versions vary by release. [Instructions for releases](RELEASING.md) describe source builds, SHA-256 pins and Nix hashes.

Durable retain queues need Linux with enforced POSIX file permissions. This user must own queue directories. Their parent directories must belong to root or this user. Other users must not have write access to the parent directories, except sticky directories such as `/tmp`.

Before use, the queue sets owned queue directories to `0700`. It sets singly linked regular queue and lock files to `0600`. Symlinks, hardlinks, foreign-owned paths and unsupported
platforms fail explicitly. Rewrites use exclusive random temporary files and atomic rename.

Lock files keep their OS-owned lock inodes. This protects
against other OS users planting paths, not arbitrary code running as this user.

The OpenClaw plugin fails initialization on macOS and other unsupported platforms
before accessing queue paths. MacOS ACLs can
grant access independently of BSD mode bits. This implementation does not check
or remove those ACLs. See Apple's [file system access-control policy](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemDetails/FileSystemDetails.html).


