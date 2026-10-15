# Routing, reads and retained data

[Documentation](README.md) | [Repository](../README.md)

Client routing does not grant access. Memory Router grants are authoritative.

| Integration | Identity | Version source |
| --- | --- | --- |
| OpenClaw | trusted `ctx.agentId` | `package.json` |
| Coding agents | harness entrypoint (`codex`, `claude-code`, `opencode`, etc.) | `src/upstream/coding-agents/package.json` |

## Banks and access

Each principal has one optional `writeBank` and `additionalReadBanks`.
Readable banks are their deduplicated union. Mutations target only `writeBank`.
Unassigned banks are rejected locally without contacting the server.
No wildcard, dynamic bank, fallback identity, or credential fallback.

## Transport and reads

- HTTPS only; redirects rejected; runtime-resolved secrets; sanitized errors.
- Recall/reflect share a deadline and token budget; content dedupe and deterministic order.
- Any 401/403 discards the entire read result. Network/408/429/5xx failures permit partial reads.
- Bank/config/page reads are read operations. Scope checks still belong to Memory Router.

## Retain queues

- OpenClaw retain queues recheck the current write bank before replay.
- `retainQueueMaxItems` (1,000) and `retainQueueMaxBytes` (16 MiB) cap all principal queues in one `queueDir`. Both must be positive integers. Byte accounting includes 128 bytes per record reserved for replay metadata. A full queue rejects new outage writes with `RetainQueueCapacityError`; existing entries stay in FIFO order.
- Queue mutations use OS-owned file locks through `fs-native-extensions`; paused writers retain ownership and crashed writers release it automatically. Writers sharing `queueDir` must use the same limits and this package version on a local filesystem with OS file-lock support. Keep the two `.retain-*.lock` files in place while any writer is running. Replay is serialized per directory; enqueue uses a separate lock. Backlogs already above the byte limit remain on disk; increase the limit to replay them.

- Malformed JSON, invalid UTF-8 and invalid record shapes are never replayed. Before a queue rewrite, only their exact original bytes are preserved in a private snapshot under `<queue-file>.recovery/`, retaining duplicate corrupt records and their relative order. Valid records and the gaps they occupied are omitted; their FIFO order and configured age limit remain enforced in the active queue. A failed rewrite followed by appends extends the same source-generation snapshot after verifying the existing corrupt-byte prefix; retries do not duplicate prior corrupt records. Recovery flushes the committed file and directory entries before changing the active queue. Queue and recovery access require Linux with enforced POSIX file permissions; other platforms fail closed. Failures preserve the active queue. Snapshots require manual inspection and recovery, with original operation IDs preserved where available; they are never replayed automatically. Corrupt-byte recovery files intentionally remain until manually removed, outside active queue capacity/age limits, and must be protected and managed with the queue directory.

## Audit logs

Memory-operation audit records contain principal, operation, bank, outcome and a bounded error class.
Coding-agent `diag.jsonl` and `plugin.log` retain event names, timing, counts and bounded classifications.
They omit prompts, memory answers, raw failure messages, paths, URLs and session/bank identifiers,
including at `debug` verbosity. There is no content-debug mode. Each file rotates at 10 MiB with one
previous generation retained; upgrading does not remove older logs that may contain content.

This logging policy does not cover host transcripts, model-facing context, user-facing notices or
explicit foreground command output, which can contain memory content.
Persistent hosts with a notifier still receive notice payloads through that callback. Hosts without
a notifier retain only lifecycle metadata; notice content is not copied to logs or stdout/stderr.

## Ingest document identity

Coding-agent, OpenClaw and MCP ingest tools use `ingest--<SHA-256 of JSON-encoded title>`.
The exact title, including case, whitespace and Unicode, identifies the document within its bank.
Reusing that title replaces its content across these tools; changing the title creates a separate document.

Legacy document IDs remain untouched. The first re-ingest after upgrading creates a new document;
verify its contents before manually removing the old document. No automatic deletion or ID migration runs.
