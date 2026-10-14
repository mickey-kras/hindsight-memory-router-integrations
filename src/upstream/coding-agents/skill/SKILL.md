---
name: hindsight-coding-agent
description: How this machine's Hindsight coding-agent memory works — the plugin behind the 🧠 banner. Use when the user says "store/remember this in hindsight", asks what the memory/knowledge pages are, needs managed project memory setup or troubleshooting, or something memory-related looks broken.
---

<!-- GENERATED from skill-src/preamble.md + skill-src/managed-router.md.
     Edit those, then run: node scripts/build-skill.mjs -->

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

## Managed setup and updates

Use the existing operator-provisioned `HINDSIGHT_ROUTER_CONFIG` absolute path and named credential
environment variables. The operator supplies the HTTPS router URL, principal grants, project bank
mapping and optional tool namespace. `HINDSIGHT_MCP_HARNESS` selects the trusted harness identity
when needed. Launch the harness in the same provisioned environment from a mapped project.

Do not ask the user to paste JSON or credentials, edit the managed JSON, copy tokens into harness
settings, or start a memory server. Missing provisioning or ambiguous identity requires the
operator to repair the deployment. Unmapped projects and missing credentials fail closed.

Install or update only using the integration's pinned release tarball. Select the release and
package version from the same published release, verify the artifact against that release's
`PACKAGE_SHA256`, and run:

```sh
npm exec --yes --package=/absolute/path/verified-coding-agents.tgz -- hindsight-coding-agents install
```

The release download path is:
`https://github.com/mickey-kras/hindsight-memory-router-integrations/releases/download/v<release>/mickey-kras-hindsight-memory-router-coding-agents-<package-version>.tgz`.
Do not leave version placeholders unresolved. Explicit `install codex`, another supported harness,
or `install all` is available when the existing managed configuration supports it. The installer
checks the selected principals, credentials, project mapping and adapter prerequisites before
changing the host. For Codex, export `HINDSIGHT_ROUTER_CONFIG` before installation so the installer
can allowlist the required environment variable names without embedding their values.

After changing the operator's credential environment variable name or tool namespace, reinstall
from the verified artifact. Namespace changes require reinstalling the companion skill and tool
registration together. The managed tool prefix controls tool definitions and guidance; ordinary
per-bank settings cannot override it.

## Checking the integration

Check the session banner and available memory tools first. Use `hindsight_sync_status` for ingestion
progress and `hindsight_diagnose` for sanitized diagnostic information when these tools are available.
If memory seems stale, inspect progress before repeating ingestion or inventing another bank.
`hindsight_list_banks` shows only the principal's assigned visible banks; use an explicit assigned
bank for bank configuration and knowledge-page reads.

Missing hooks or tools usually require reinstalling the selected harness from the verified artifact
with its managed environment. Review the harness's plugin/hook registration and sanitized logs;
never print credential values. A 401/403 stops requests for that credential. Ask the operator to
resolve authorization and restart with the provisioned credential; do not try another principal,
URL or bank. Rate limits and quarantine decisions are enforced by the router and are not bypassed
by local settings. Continue coding without memory when the harness fails open, and state any
material lack of memory evidence.

Operational coding-agent settings such as `autoInject`, `retainSessions`, `disabled`, git survey
limits and logging may be configured by the operator in the supported coding-agent settings.
The managed routing boundary owns bank access and transport; do not create banks, rewrite bank
configuration, provision servers or substitute a provider client. Background ingestion and hooks
use the same router boundary as interactive tools.

### Optional branding

The operator may set `toolPrefix` in the same managed router JSON. The default `hindsight_`
keeps the upstream names. Tool, skill, registration and display names derive from that one
value. Package
names, `HINDSIGHT_*` environment variables, configuration paths, principals and bank grants
remain unchanged. Use the names registered in the current session; do not guess aliases.

A branding change requires the pinned installer (`install` or `update`) and a fresh session.
The installer migrates only managed entries and refuses unrelated name collisions. A stale
managed skill namespace fails closed until reinstall; never repair this by changing bank
assignments, credentials or the operational memory workflow above.
