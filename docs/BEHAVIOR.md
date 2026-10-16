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

- OpenClaw retain queues recheck the current write bank before expiration or replay. A mismatch is a local authorization denial: the original bank and payload stay quarantined in place, with no HTTP request or rerouting. A permanent HTTP failure also quarantines its record in place. Independent documents may progress past quarantines; later append/replace writes for the exact same `(bankId, documentId)` wait. The empty document ID is a real identity; omitted document IDs are independent per record.
- A replay HTTP 401/403 persists a principal-wide authorization gate on the original denied record. Fresh writes queue without HTTP. Each subsequent flush may probe only that record, with the same bank and operation ID and only if no earlier ordering barrier prevents it. Repeated denial or transient failure keeps the gate closed; neither retry limits nor expiration discard this protected backlog. Success durably removes the gate owner before other work proceeds. The entire gated backlog, including newly queued work, keeps durable protection from age/retry abandonment after recovery and across batch limits or restarts. A permanent probe failure or changed bank requires operator recovery. Before each replay request, a durable `sending: true` marker protects the entire principal backlog from expiration and blocks fresh delivery. Persisting the HTTP outcome clears that marker; an ordinary transient retains the ordinary retry and age policy. If outcome persistence fails or the process stops during HTTP, the unresolved marker pauses replay across restarts until operator recovery. If success is durably classified but removing the row fails, replay may retry with the original operation ID.
- Replay inspects the full bounded backlog and spends its 50-request budget only on actual eligible attempts. Successful acknowledgements remove one exact record before releasing dependent writes. Duplicate persisted record IDs stop delivery for operator repair. Fresh delivery takes the same directory-wide delivery lock as replay, inspects backlog gates and document dependencies, and queues behind them. Lock contention queues explicitly; no mutation lock is held across HTTP. Admission therefore reads the principal backlog rather than retaining the former no-deserialization fast path.
- `retainQueueMaxItems` (1,000) and `retainQueueMaxBytes` (16 MiB) cap all principal queues in one `queueDir`. Both must be positive integers. Byte accounting includes 256 bytes per record reserved for replay metadata. A full queue rejects new outage writes with `RetainQueueCapacityError`; existing entries retain their on-disk order, including quarantines and corruption barriers.
- Queue mutations use OS-owned file locks through `fs-native-extensions`; paused writers retain ownership and crashed writers release it automatically. Writers sharing `queueDir` must use the same limits and this package version on a local filesystem with OS file-lock support. Keep all `.retain-*.lock` files in place while any writer is running. The queue-mutation lock (`.retain-queue.lock`) serializes disk changes; the replay/delivery lock (`.retain-replay.lock`) serializes replay and fresh delivery per directory; the admission lock (`.retain-admission.lock`) orders fresh senders until each has delivered or queued. Accepted appends sync their file and directory; atomic rewrites sync the temporary file before rename and the directory afterward. A mutation that reports a sync failure has an uncertain outcome: bytes may already exist, so preserve operation IDs when reconciling or retrying. This is persistence ordering, not a hardware power-loss qualification. Backlogs already above the byte limit remain on disk; increase the limit to replay them. If corruption barriers or replay metadata would expand an in-limit queue beyond that limit, the rewrite fails with `RETAIN_QUEUE_REWRITE_CAPACITY` before replacing the active file. Original active bytes and exact corrupt-byte recovery snapshots remain intact across retries and restarts. Operations requiring that oversized rewrite remain blocked until the operator increases `retainQueueMaxBytes` enough or repairs the backlog; retries alone do not resolve the size constraint. A corruption-barrier rewrite required by snapshot preparation blocks replay and fresh admission for that principal. A pre-send metadata rewrite failure ends that replay pass before HTTP. An outcome rewrite failure leaves the durable sending marker in place and pauses the principal until operator recovery.
- A queue-file failure leaves its remaining backlog available for retry and does not stop replay of later principals. Diagnostics identify a configured agent or a bounded filename fingerprint without including queued content or raw filesystem errors. Unknown principals remain queued without delivery, and bank authorization checks still apply independently to each principal. A shared lock timeout or failure accessing shared locks, directories or orphan temporary files stops the current flush after one failure, preserves undelivered records and retries on the next flush. Shared storage remains fail-closed until available or repaired; an unavailable mutation lock stops replay after its three-second retry budget instead of repeating that budget for every principal.

- Malformed JSON, invalid UTF-8 and invalid record shapes are never replayed. Before a queue rewrite, only their exact original bytes are preserved in a private snapshot under `<queue-file>.recovery/`, retaining duplicate corrupt records and their relative order. Valid payloads are omitted from the archive. The active queue instead keeps an ordinal barrier for each contiguous corrupt range, referencing its archive and byte range. Records before that barrier may progress; every later record and fresh write waits because the corrupt record's identity is unknown. Barriers, quarantines and their dependent successors are exempt from expiration. This deliberately replaces the earlier behavior that allowed valid later records past corruption. A failed rewrite followed by appends extends the same source-generation snapshot after verifying the existing corrupt-byte prefix; retries do not duplicate prior corrupt records. Recovery flushes the committed file and directory entries before changing the active queue. Queue and recovery access require Linux with enforced POSIX file permissions; other platforms fail closed. Failures preserve the active queue. Snapshots require manual inspection and recovery, with original operation IDs preserved where available; they are never replayed automatically. Corrupt-byte recovery files intentionally remain until manually removed, outside active queue capacity/age limits, and must be protected and managed with the queue directory.

### Recovering quarantined work

Fresh senders serialize admission until the preceding sender has delivered or queued its request. Contention waits at most about three seconds, then rejects with `RETAIN_QUEUE_BUSY` without accepting the contender. Replay keeps its separate nonblocking delivery lock; fresh work can still queue behind a persisted replay record without holding the mutation lock over HTTP.

Stop every writer and replay worker sharing the queue directory before editing, and retain private backups of the active queue and its recovery directory. Keep JSONL records at their original positions; do not move poison records to the tail or copy them into another principal/bank. Preserve `id`, `operationId`, `createdAt`, `replayAttempts`, bank, document and append/replace semantics. Keep the existing Linux owner-only directory/file permissions and use a same-directory atomic file replacement.

- For an unresolved `sending: true` marker, reconcile the uncertain request outcome and restore authorization before clearing `sending`. Preserve the bank and operation ID. If authorization may have failed or the outcome remains unknown, atomically replace `sending` with `gate: "probe"` and `protected: true` on that row and set `protected: true` on every queued row before resuming. Preserve any quarantine and other existing state. This explicitly authorizes a retry of the original operation; its successful acknowledgement must precede dependent work.
- After repairing the payload or restoring the original authorized bank, remove only `replayState.quarantine` to retry that row in place. If a denied row has `gate: "operator"`, set it to `"probe"` and keep `protected: true`; the original row must succeed before the principal resumes. Never substitute a new bank for the original request.
- To clear a credential gate without retrying its owner, remove only `gate` after confirming the authorization problem is resolved. Keep its quarantine, if present, and `protected: true`; document-dependent successors remain blocked by the quarantine. This is an explicit operator decision, not an automatic retry or age policy.
- For a corrupt barrier, locate `<queue-file>.recovery/<archive>.jsonl` and read the exact `offset`/`length` byte range. Restore validated records in place of that barrier, keeping their original order and operation IDs where available. If the bytes cannot be recovered, explicitly acknowledge the loss before removing that barrier; retain the archive for audit/recovery. Removing a barrier releases all later work, so do not do it merely to silence an error.
- Repair duplicate record IDs to unique, stable identities without changing operation IDs or record order. Restart only after the JSONL is valid and recovery work is complete. Quarantined payloads and recovery snapshots remain plaintext, require the queue directory's protections, and count toward active capacity where represented by active records; archives still require separate manual retention management.

## Persistent coding-agent sessions

Each workspace runtime keeps at most 256 sessions. Completed sessions are released on host disposal; otherwise clean idle sessions are evicted as new sessions arrive. Active work and failed-write buffers stay pinned. If all slots are pinned, new sessions skip automatic memory with a `session_capacity_reached` diagnostic until a slot becomes available. Resumed evicted sessions replace their full transcript and must pass the host's ownership checks again. Local usage counters restart after eviction.

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
