# Routing, reads and retained data

[Documentation](README.md) | [Repository](../README.md)

Client routing does not grant access. Memory Router grants are authoritative.

| Integration | Identity | Version source |
| --- | --- | --- |
| OpenClaw | trusted `ctx.agentId` | `package.json` |
| Coding agents | harness entrypoint (for example, `codex`, `claude-code` and `opencode`) | `src/upstream/coding-agents/package.json` |

## Banks and access

Each principal has one optional `writeBank` and `additionalReadBanks`.
Readable banks are the union of these banks, without duplicates. Mutations target only `writeBank`.
The client rejects unassigned banks locally without a server request.
It does not support wildcards, dynamic banks, fallback identities or fallback credentials.

## Transport and reads

- Transport uses HTTPS only. It rejects redirects, resolves secrets at runtime and sanitizes errors.
- Recall and reflect share a deadline and token budget. They remove duplicate content and use a deterministic order.
- Any 401/403 discards the entire read result. Network failures and 408/429/5xx failures allow partial reads.

  Network failures include disconnects during reads of a successful response body. Malformed JSON and programming errors remain non-transient.
- The client treats reads of banks, configurations and pages as read operations. Scope checks still belong to Memory Router.

## Retain queues

### Bank checks and document order

OpenClaw retain queues check the current write bank again before expiration or replay.
If the bank does not match, local authorization fails. The queue quarantines the original bank and payload in place.
It sends no HTTP request and does not change the route. A permanent HTTP failure also quarantines its record in place.

Independent documents can progress past quarantines. Later append or replace writes for the exact same `(bankId, documentId)` must wait.
An empty document ID is a real identity. If a record omits the document ID, it has an independent identity.

### Authorization gates

A replay HTTP 401/403 stores an authorization gate for the whole principal on the original denied record.
New writes enter the queue without HTTP. Each next flush can probe only that record, with the same bank and operation ID.
An earlier ordering barrier prevents the probe.

Repeated denial or transient failure keeps the gate closed. Retry limits and expiration do not discard this protected backlog. After success, the queue durably removes the gate owner before other work proceeds. The entire gated backlog, including new queued work, keeps durable protection from age and retry abandonment.

This protection continues after recovery, across batch limits and across restarts. A permanent probe failure or a changed bank needs operator recovery.

Before each replay request, a durable `sending: true` marker protects the entire principal backlog from expiration and blocks new delivery. Storage of the HTTP outcome clears that marker. An ordinary transient failure keeps the ordinary retry and age policy. If outcome storage fails, the unresolved marker pauses replay across restarts until operator recovery.

The same pause applies if the process stops during HTTP. If the queue durably records success but cannot remove the row, replay can retry with the original operation ID.

### Replay and capacity

Replay inspects the full bounded backlog. Its 50-request budget counts only actual eligible attempts.
A successful acknowledgement removes one exact record before it releases dependent writes.
Duplicate stored record IDs stop delivery until the operator repairs them.

New delivery uses the same directory-wide delivery lock as replay. It inspects backlog gates and document dependencies, then queues behind them. Delivery lock contention causes explicit queueing. The mutation lock does not remain held during HTTP.

Admission reads the principal backlog. It no longer uses the path that skipped deserialization.

`retainQueueMaxItems` (1,000) and `retainQueueMaxBytes` (16 MiB) limit all principal queues in one `queueDir`.
Both must be positive integers. Byte accounting reserves 256 bytes per record for replay metadata.
A full queue rejects new outage writes with `RetainQueueCapacityError`.
Existing entries keep their on-disk order, including quarantines and corruption barriers.

### File locks and durable writes

Queue mutations use OS-owned file locks through `fs-native-extensions`. Paused writers keep ownership. The OS automatically releases locks from crashed writers. Writers that share `queueDir` must use the same limits and this package version.

They must use a local filesystem with OS file-lock support. While any writer runs, keep all `.retain-*.lock` files in place.

| Lock | Function |
| --- | --- |
| `.retain-queue.lock` | Serializes disk mutations. |
| `.retain-replay.lock` | Serializes replay and new delivery per directory. |
| `.retain-admission.lock` | Orders new senders until each delivers or queues its request. |

Accepted appends sync their file and directory. Atomic rewrites sync the temporary file before rename, then sync the directory. If a mutation reports a sync failure, its outcome is uncertain. Bytes can already exist.

During reconciliation or retry, preserve operation IDs. These checks confirm persistence order, not hardware power-loss qualification.

Backlogs above the byte limit stay on disk. To replay them, increase the limit.
Corruption barriers or replay metadata can make a queue exceed the limit during a rewrite.
In this case, the rewrite fails with `RETAIN_QUEUE_REWRITE_CAPACITY` before it replaces the active file.
Original active bytes and exact corrupt-byte recovery snapshots stay intact across retries and restarts.

Operations that need that oversized rewrite stay blocked until the operator sufficiently increases `retainQueueMaxBytes` or repairs the backlog.
Retries alone do not resolve the size constraint.
If snapshot preparation needs a corruption-barrier rewrite, that rewrite blocks replay and new admission for the principal.

A bulk operation-ID upgrade can fail to reserve space for replay outcomes.
In this case, it prepares identities per row as successful deliveries release space.
Before replay, preparation reserves space for transient retry metadata, quarantine and denial protection for the whole principal.
If a pre-send metadata rewrite or its outcome reservation cannot fit, that replay pass ends before HTTP.
If an outcome rewrite fails, the durable sending marker stays in place and pauses the principal until operator recovery.

### Storage failures

A queue-file failure keeps its remaining backlog available for retry. It does not stop replay of later principals. Diagnostics identify a configured agent or a bounded filename fingerprint. They omit queued content and raw filesystem errors.

Unknown principals stay queued without delivery. Bank authorization checks still apply independently to each principal.

A shared lock timeout stops the current flush after one failure. The same rule applies to failures that access shared locks, directories or orphan temporary files. The flush preserves undelivered records and retries on the next flush. Shared storage prevents delivery until the storage is available or the operator repairs it.

An unavailable mutation lock stops replay after its three-second retry budget. It does not repeat that budget for every principal.

### Corrupt records

The queue never replays malformed JSON, invalid UTF-8 or invalid record shapes.
Before a rewrite, it preserves their exact original bytes in a private snapshot under `<queue-file>.recovery/`.
The snapshot keeps duplicate corrupt records and their relative order. It omits valid payloads.

The active queue keeps an ordinal barrier for each contiguous corrupt range. Each barrier refers to its archive and byte range. Records before the barrier can progress. Every later record and new write must wait because the corrupt record's identity is unknown.

Barriers, quarantines and their dependent successors do not expire. This replaces the earlier behavior that let valid later records progress past corruption.

After a failed rewrite followed by appends, recovery verifies the existing corrupt-byte prefix and extends the same source-generation snapshot. Retries do not duplicate earlier corrupt records. Recovery flushes the committed file and directory entries before it changes the active queue. Queue and recovery access need Linux with enforced POSIX file permissions.

Other platforms prevent access. Failures preserve the active queue.

Snapshots need manual inspection and recovery. Preserve original operation IDs where available. The queue never replays snapshots automatically. Corrupt-byte recovery files stay until the operator removes them.

Active queue capacity and age limits do not apply to these files. Protect and manage them with the queue directory.

### Recovering quarantined work

New senders serialize admission until the preceding sender delivers or queues its request.
Contention waits at most about three seconds. It then rejects the request with `RETAIN_QUEUE_BUSY` without accepting the competing sender.
Replay keeps its separate nonblocking delivery lock.
New work can still queue behind a stored replay record without holding the mutation lock during HTTP.

Before you edit the queue, stop every writer and replay worker that shares the directory. Keep private backups of the active queue and its recovery directory. Keep JSONL records at their original positions. Do not move poison records to the tail or copy them into another principal or bank.

Preserve `id`, `operationId`, `createdAt`, `replayAttempts`, bank, document and append or replace semantics. Keep the existing Linux owner-only directory and file permissions. Use an atomic file replacement in the same directory.

For an unresolved `sending: true` marker:

1. Reconcile the uncertain request outcome.

2. Restore authorization before you clear `sending`.

3. Preserve the bank and operation ID.

4. If authorization failure is possible or the outcome stays unknown, atomically replace `sending` with `gate: "probe"` and `protected: true` on that row. Include `protected: true` on every queued row in the same atomic change before you resume.

5. Preserve any quarantine and other existing state.

This change explicitly authorizes a retry of the original operation.
Its successful acknowledgement must precede dependent work.

To retry a quarantined row in place:

1. Repair the payload or restore the original authorized bank.

2. Remove the `replayState.quarantine` field only.

3. If a denied row has `gate: "operator"`, set it to `"probe"`.

4. Keep `protected: true`.

If the denied row had `gate: "operator"`, the original row must succeed before the principal resumes.
Never substitute a new bank for the original request.

To clear a credential gate without retrying its owner:

1. Confirm that you resolved the authorization problem.

2. Remove the `gate` field only.

3. Keep its quarantine, if present.

4. Keep `protected: true`.

The quarantine still blocks document-dependent successors.
This action needs an explicit operator decision. The retry and age policies do not do it automatically.

For a corrupt barrier:

1. Find `<queue-file>.recovery/<archive>.jsonl`.

2. Read the exact byte range from `offset` and `length`.

3. Replace the barrier with validated records in their original order.

4. Preserve original operation IDs where available.

5. If recovery of the bytes is not possible, explicitly acknowledge the loss before you remove the barrier.

6. Keep the archive for audit and recovery.

Removal of a barrier releases all later work. Do not remove it only to silence an error.

Repair the duplicate record IDs with unique, stable identities. Do not change operation IDs or record order. Restart only after the JSONL is valid and recovery work is complete. Quarantined payloads and recovery snapshots stay in plaintext and need the queue directory's protections.

They count toward active capacity where active records represent them. Archives still need separate manual retention management.

## Persistent coding-agent sessions

Each workspace runtime keeps at most 256 sessions. Host disposal releases completed sessions. Otherwise, new sessions evict clean idle sessions. Active work and failed-write buffers stay pinned.

If active work or failed-write buffers pin all slots, new sessions skip automatic memory until a slot becomes available. They report `session_capacity_reached`. Resumed evicted sessions replace their full transcript and must pass the host's ownership checks again. Local usage counters restart after eviction.

## Audit logs

Audit records for memory operations contain principal, operation, bank, outcome and a bounded error class. Coding-agent `diag.jsonl` and `plugin.log` retain event names, timing, counts and bounded classifications. They omit prompts, memory answers, raw failure messages, paths, URLs and session and bank identifiers,
including at `debug` verbosity. There is no content-debug mode.

Each file rotates at 10 MiB and keeps one previous generation. An upgrade does not remove older logs that can contain content.

This logging policy does not cover host transcripts, model-facing context, user-facing notices or
explicit foreground command output, which can contain memory content.
Persistent hosts with a notifier still receive notice payloads through that callback. Hosts without
a notifier retain only lifecycle metadata. They do not copy notice content to logs, stdout or stderr.

## Ingest document identity

Coding-agent, OpenClaw and MCP ingest tools use `ingest--<SHA-256 of JSON-encoded title>`.
The exact title, including case, whitespace and Unicode, identifies the document within its bank.
Reuse of that title replaces its content across these tools. A different title creates a separate document.

Legacy document IDs do not change. The first re-ingest after an upgrade creates a new document.
Before you manually remove the old document, check the new document's contents.
The tools do not automatically delete documents or migrate IDs.

