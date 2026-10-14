---
name: hindsight-coding-agent
description: How this machine's Hindsight coding-agent memory works — the plugin behind the 🧠 banner. Use when the user says "store/remember this in hindsight", asks what the memory/knowledge pages are, needs managed project memory setup or troubleshooting, or something memory-related looks broken.
---

# Hindsight Coding-Agent Memory

This machine runs the managed Memory Router coding-agent integration. All memory requests go
through the operator-provisioned HTTPS router and its per-principal bank grants. The router
applies scanning, quarantine and quotas. A client setting cannot grant access.

## Automatic lifecycle

- The operator maps this project and harness to an explicit bank. Worktrees use their configured
  project mapping; no bank is created or selected from a repository name.
- For writable principals, session-start hooks can seed and update memory from recent commits
  and a read-only codebase survey, and refresh coding knowledge pages. There is no manual ingest
  command needed for this background work. The operator provisions bank configuration and the
  coding missions/strategies before ingestion.
- Session-start and prompt hooks inject memory according to `autoInject`: `reflect`, `pages`,
  `recall`, or `none`. Follow the injected retrieval guide when no memory is injected.
- Writable sessions retain their transcripts automatically at session end; persistent harnesses
  also retain during the session. Read-only principals skip ingestion and write-back, and their
  write tools are unavailable. Respect `disabled` and `retainSessions` settings.
- Use the tool names exposed by this harness. Examples below show the default `hindsight_`
  namespace; the installed skill and guidance use the operator's configured namespace.

## Storing things deliberately

When the user says "store this in hindsight" / "remember this":

- With writable access and session retention enabled, the **current conversation** is captured
  automatically at session end — say so; no tool needed.
- An **external document, notes, or durable findings** → `hindsight_ingest_document(title, content)`.
- A **new feature/initiative being started** → `hindsight_capture_initiative(title, summary)`,
  right after the plan is agreed and before code is written.
- A **plan that materially changed** (goal, scope, or rationale — including mid-implementation) →
  call `hindsight_capture_initiative` again with `relates_to_page_id` set to that initiative's page
  id, summarising the _current_ intent. Same page, updated plan — never a second page. Trivial
  course-corrections don't count.

## Retrieving

- `hindsight_search_knowledge_pages(query)` — FIRST STOP for project questions (components,
  conventions, past decisions, initiatives). Server-side hybrid search, fast.
- `hindsight_read_knowledge_page(page_id)` / `hindsight_list_knowledge_pages` — read pages fully.
- `hindsight_reflect(query)` — deep reasoning over the whole memory for WHY questions and exact
  decided values; slower (seconds), use deliberately.
- Credit visibly whenever memory informs an answer: start that part with
  `🧠 From Hindsight memory (<page>): …` — and never credit memory that didn't contribute.

## Correcting wrong or stale memory

If you verify that something Hindsight served is wrong or outdated (the code, git, or an external
source contradicts it), FIX THE RECORD — don't just ignore it. Call
`hindsight_ingest_document` with:

- **title**: `Correction: <topic>` (e.g. `Correction: retry policy 4xx set`)
- **content**: (1) what memory claimed, (2) what is verifiably true now, (3) the evidence you
  checked (file/commit/output). Quote exact values verbatim.

Include the evidence in the correction so future retrieval can resolve the conflict. With read-only
access, report the verified correction for an authorized writer; do not attempt a write or change
credentials.
