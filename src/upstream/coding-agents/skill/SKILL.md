---
name: hindsight-coding-agent
description: Use this skill for the managed Hindsight coding-agent memory behind the 🧠 banner. Use it to store memories, explain knowledge pages, configure project memory, or investigate memory failures.
---

<!-- GENERATED from skill-src/preamble.md + skill-src/managed-router.md.
     Edit those, then run: node scripts/build-skill.mjs -->

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

## Managed setup and updates

Use the existing operator-provisioned `HINDSIGHT_ROUTER_CONFIG` absolute path and named credential environment variables.
The operator supplies the HTTPS router URL, principal grants, project bank mapping and optional tool namespace.
When necessary, `HINDSIGHT_MCP_HARNESS` selects the trusted harness identity.
Start the harness in the same configured environment from a mapped project.

Do not ask the user to paste JSON or credentials.
Do not edit the managed JSON, copy tokens into harness settings, or start a memory server.
If configuration is missing or identity is ambiguous, the operator must repair the deployment.
Unmapped projects and missing credentials stop access.

Use only the integration's pinned release tarball to install or update the integration.
Select the release and package version from the same published release.
Check the artifact against that release's `PACKAGE_SHA256`.
Run this command:

```sh
npm exec --yes --package=/absolute/path/verified-coding-agents.tgz -- hindsight-coding-agents install
```

The release download path is:
`https://github.com/mickey-kras/hindsight-memory-router-integrations/releases/download/v<release>/mickey-kras-hindsight-memory-router-coding-agents-<package-version>.tgz`.
Replace all version placeholders.
If the existing managed configuration supports it, use explicit `install codex`, another supported harness, or `install all`.
Before host changes, the installer checks the selected principals, credentials, project mapping and adapter prerequisites.

For Codex, export `HINDSIGHT_ROUTER_CONFIG` before installation.
The installer can then allow the required environment variable names without storing their values.

If the operator's credential environment variable name or tool namespace changes, reinstall from the verified artifact.
Namespace changes need reinstallation of the companion skill and tool registration together.
The managed tool prefix controls tool definitions and guidance. Ordinary per-bank settings cannot override it.

## Check the integration

First, check the session banner and available memory tools.
If available, use `hindsight_sync_status` for ingestion progress.
If available, use `hindsight_diagnose` for diagnostics with sensitive data removed.
If memory seems stale, inspect progress before another ingestion try or selection of another bank.

Use the diagnostics to confirm the current project bank.
If access or bank selection is unclear, ask the operator to check assigned bank grants and managed project mappings.

Missing hooks or tools usually need reinstallation of the selected harness from the verified artifact with its managed environment.
Review the harness's registration of plugins and hooks and logs with sensitive data removed. Never print credential values.
A 401/403 response stops requests for that credential.

Ask the operator to resolve authorization and restart with the configured credential.
Do not try another principal, URL or bank.
The router enforces rate limits and quarantine decisions. Local settings cannot bypass them.

If the harness permits work without memory, continue coding. State any material lack of memory evidence.

The operator can configure supported coding-agent settings such as `autoInject`, `retainSessions`, `disabled`, git survey limits and logging.
Through managed routing, the integration controls transport and access to banks.
Do not create banks, change bank configuration, configure servers, or substitute a provider client.
Background ingestion and hooks use the same router boundary as interactive tools.

### Optional branding

The operator can set `toolPrefix` in the same managed router JSON.
The default `hindsight_` keeps the upstream names.
Tool, skill, registration and display names derive from that one value.
Package names, `HINDSIGHT_*` environment variables, configuration paths, principals and bank grants do not change.

Use the names registered in the current session. Do not guess aliases.

A branding change requires the pinned installer (`install` or `update`) and a new session.
The installer migrates only managed entries and rejects unrelated name collisions.
A stale managed skill namespace stops access until reinstallation.
Do not repair this condition through changes to bank assignments, credentials or the operational memory workflow above.
