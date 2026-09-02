# Deviations from upstream (vectorize-io/hindsight OpenClaw integration v0.11.1)

Intentional replacements, all in `src/plugin.ts` + `src/router/`:

| Area | Upstream | This plugin |
| --- | --- | --- |
| API endpoint | local daemon or `hindsightApiUrl` direct to Hindsight | Memory Router only (`routerUrl`, HTTPS enforced) |
| Credentials | single `hindsightApiToken` | per-agent tokens via `agents.<id>.token` SecretRef; no global fallback |
| Agent identity | `ctx.agentId` OR parsed from session key | trusted `ctx.agentId` only; session keys never determine identity |
| Bank selection | dynamic per-channel bank IDs | per-agent configured `writeBank` / `recallBanks` |
| Recall | single bank | multi-bank fan-out: shared timeout/budget, dedupe, deterministic ranking, partial recall observable |
| Knowledge recall tool | single bank | multi-bank via RecallCoordinator (other tools unchanged) |
| Retain queue | one shared JSONL file | per-agent queue files; replay preserves agent identity and bank target |
| Bank defaults | plugin stamps missions/config on first use | not applied; banks provisioned out-of-band (Control Plane principal) |
| Daemon management | spawns hindsight-embed daemon | removed; router is always external |

Vendoring: `src/upstream/` carries only the files this package builds against (`src/retain-queue.ts`, `src/session-patterns.ts`, `src/types.ts`) plus upstream `package.json` for dependency-diff reference. `src/upstream/SHA256SUMS` pins every file of the full upstream tree at the tagged ref; `scripts/import-upstream.sh` materializes and verifies the complete tree for audits and upgrades. (Transport constraints made a full inline vendored copy impractical; the manifest keeps the fork byte-verifiable.)

Reused unmodified from `src/upstream/`: `retain-queue.ts`, `session-patterns.ts`, `types.ts`.

Reused as published packages (no fork): `@vectorize-io/hindsight-client@0.8.6`, `@vectorize-io/hindsight-agent-sdk@0.1.0`.

Not carried over: daemon/backfill/setup CLIs, LLM/embed configuration, dynamic bank derivation, sender-prefix stripping, per-user channel banks.
