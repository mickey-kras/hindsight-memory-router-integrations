---
name: hindsight-coding-agent
description: Use this skill for the managed Hindsight coding-agent memory behind the 🧠 banner. Use it to store memories, explain knowledge pages, configure project memory, or investigate memory failures.
---

# Hindsight Coding-Agent Memory

This machine uses the managed Memory Router coding-agent integration.
All memory requests use the operator-provisioned HTTPS router and its per-principal bank grants.
The router applies scanning, quarantine and quotas. A client setting cannot grant access.

## Automatic lifecycle

- The operator maps this project and harness to an explicit bank.
  Worktrees use their configured project mapping. The integration does not create or select a bank from a repository name.
- For writable principals, session-start hooks can seed and update memory from recent commits and a read-only codebase survey.
  These hooks can also refresh coding knowledge pages. This background work does not need a manual ingest command.
  The operator configures banks and coding missions and strategies before ingestion.
- Session-start and prompt hooks inject memory according to `autoInject`: `reflect`, `pages`, `recall`, or `none`.
  If hooks inject no memory, follow the injected retrieval guide.
- Writable sessions retain their transcripts automatically at session end.
  Persistent harnesses also retain transcripts during the session.
  Read-only principals skip ingestion and write-back. Their write tools are unavailable.
  Obey the `disabled` and `retainSessions` settings.
- Use the tool names that this harness exposes.
  The examples below use the default `hindsight_` namespace.
  The installed skill and guidance use the operator's configured namespace.

## Store information

When the user says "store this in hindsight" or "remember this", use these rules:

- With writable access and session retention, the integration captures the current conversation automatically at session end.
  Tell the user. No tool call is necessary.
- For external documents, notes, or durable findings, use `hindsight_ingest_document(title, content)`.
- For a new feature or initiative, use `hindsight_capture_initiative(title, summary)` after agreement on the plan and before code changes.
- If the goal, scope, or rationale changes materially, call `hindsight_capture_initiative` again.
  This includes changes during implementation.
  Set `relates_to_page_id` to the initiative's page ID. Describe the current intent.
  Update the same page. Do not create a second page for the changed plan.
  Small corrections do not need this update.

## Retrieve information

- For project questions, first use `hindsight_search_knowledge_pages(query)`.
  Questions can concern components, conventions, past decisions, or initiatives.
  This tool uses fast hybrid search on the server.
- To read complete pages, use `hindsight_read_knowledge_page(page_id)` or `hindsight_list_knowledge_pages`.
- For reasons and exact agreed values, use `hindsight_reflect(query)`.
  This tool reasons over the complete memory. It is slower and takes seconds. Use it when necessary.
- If memory contributes to an answer, start that part with `🧠 From Hindsight memory (<page>): …`.
  Do not credit memory that did not contribute.

## Correct incorrect or stale memory

If code, git, or an external source disproves retrieved memory or shows that it needs an update, correct the record.
Do not only ignore it. Call `hindsight_ingest_document` with these fields:

- **title**: `Correction: <topic>` (for example, `Correction: retry policy 4xx set`).
- **content**: State the memory's claim, the verified current fact, and the evidence from a file, commit, or output.
  Quote exact values without changes.

Include the evidence so that future retrieval can resolve the conflict.
With read-only access, report the verified correction to an authorized writer.
Do not try to write or change credentials.
