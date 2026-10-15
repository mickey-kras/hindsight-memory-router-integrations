# Router deviations

- Managed harness identity, HTTPS endpoint, token environment references, and explicit path mappings replace upstream endpoint/token/dynamic-bank configuration.
- `optInOnly` is enforced from managed mappings. Normal config cannot rename banks or override identity/credentials.
- All HTTP requests use the shared bank/operation guard. Bank listing intersects router-visible banks with configured IDs.
- Recall/reflect fan out through the shared coordinator. Other reads remain explicitly bank-addressed.
- 401/403 are terminal; upstream credential retry is replaced by runtime environment resolution on each request.
- Optional human mode resolves a short-lived session from native OS secure storage on every request. Browser login uses the router's loopback OIDC/PKCE exchange; sign-out revokes and deletes the session. Persistent application credentials remain separate.
- Redirects and raw server error bodies are blocked. Automatic upstream replacement and installer token migration are disabled.
- Upstream transcript parsing, provenance tags, retain payloads, hooks and harness adapters remain the baseline, with deliberate routing, privacy, installer and reliability adaptations. This is not a claim of identical behavior; the changes and source hashes below define the maintained differences.
- Manual document ingestion uses the shared exact-title hash identity. Legacy IDs remain untouched; see the root README migration note.
- `src/core/inject.ts` rewords the reflect rendering rules to "commit, PR and issue ids": the upstream "commit/PR/issue" slash token trips the Memory Router encoded-payload request scan, which rejects the reflect query with 422 suspicious_content.

The source hashes in `UPSTREAM.json` describe the pristine snapshot. `LOCAL_CHANGES.json` pins adapted files.
The regression suite covers unchanged transcript/provenance code; root tests cover the changed security contracts.
Live harness and deployed Memory Router compatibility must be verified before rollout.

Bank configuration is operator-managed (`manageBankConfig: false`). Provision coding missions/strategies before ingestion. Read-only principals disable automatic ingestion and write-back. Local usage can read existing host transcripts, but journal-only hosts capture prompts and replies only when session retention is enabled and the principal can write the resolved bank.
Session state uses per-user private directories (0700 on POSIX), regular files (0600), and exclusive atomic temporary files. Owned legacy directories are secured and migrated; symlinks, hard links, and foreign-owned paths are rejected.
Memory content is not reused from session caches; lifecycle flags remain cached. A denied application-token value remains blocked until it changes; human credentials require explicit login after expiry or denial.

Reliability fixes use explicit sorting, global replacements, Node ANSI stripping, optional arguments, and non-empty installer regex matches. Transcript escape decoding retains UTF-16 surrogate behavior.

Dependencies are classified by their package declarations; bundling does not make declared runtime dependencies development-only. Direct runtime dependencies are `@modelcontextprotocol/sdk`, `@napi-rs/keyring`, `jsonc-parser`, `smol-toml` and `zod`. Development dependencies are `@opencode-ai/plugin`, `@opencode-ai/sdk`, `@opencode/plugin`, `@types/node`, `tsup`, `typescript` and `vitest`.

The complete override inventory is `@opencode/plugin > @opentelemetry/core` (`>=2.8.0 <3.0.0`), `esbuild` (`>=0.25.0 <1.0.0`), `fast-uri` (`>=3.1.6 <4.0.0`), `hono` (`>=4.13.7 <5.0.0`), `http-cache-semantics` (`4.3.0`), `ip-address` (`>=10.5.1 <11.0.0`), `postcss` (`>=8.5.23 <9.0.0`) and `vite` (`>=6.4.3 <7.0.0`). These ranges constrain the dependency graph; exact resolved versions are in `npm-shrinkwrap.json`. Reassess compatibility and advisories when updating, rather than assuming these overrides are permanently required or sufficient.

Survey admission is scoped to the managed router URL, principal and bank. Tokens never enter lease keys; credential rotation keeps the same lease. Normal config cannot override the managed principal. No CodeQL suppression is used.

Upstream baseline is coding-agents 0.8.1 at the shared v1.0.0 commit. Downstream package versions remain independent. The managed README, generated companion skill and disabled daemon implementation remain router-owned: upstream endpoint setup, dynamic banks, local daemon and update instructions are unsupported. The package uses npm-shrinkwrap.json; upstream package-lock.json stays intentionally absent.

New upstream append capability, retry budgets, query bounds, page scoping and document freshness reads use the existing guarded client. Version probing accepts GET /v1/version and falls back to /version; authorization failures remain terminal. Router error bodies are redacted, so a 404 cannot latch page support off based on its upstream body.

Grok tool-hook context is stored privately and delivered only after managed credentials and the current project mapping are validated. Its handoff key includes endpoint, primary bank, the canonical physical path of the recorded session root, session, a hash of the actual effective principal and the complete managed read-bank scope. Moving into a subdirectory preserves the handoff only while both the live directory and recorded root remain authorized for the same bank and the live directory remains physically inside that root. Every bank that could contribute to aggregated memory is freshly authorized in parallel under one shared 15-second deadline before delivery; scope/principal changes and server revocations reject the handoff. The effective endpoint, physical workspace and project mapping are resolved again after awaited reads and grant probes. Authorization failures discard it permanently. Tokens never enter identity keys. Pending context uses immutable blocks with atomic claims per publication; concurrent tools may deliver separate blocks, and waiting-block deduplication is best-effort. Delivery reads at most 64 blocks per event, leaving later blocks for subsequent events; terminal denial discards the bound scope's pending snapshot. Session caches retain attempt counters and lifecycle flags, never memory content.

New Kimi, WorkBuddy, CodeBuddy and TraeCode entries use managed identity and branded registration names. Trae workspace MCP files are written only by explicit transactional installation for operator-mapped projects; hooks only report the workspace-MCP gate. Global settings and workspace SQLite enable switches remain user-managed.

Managed settings are reapplied after every path/bank override, including paths without a bank section. Project prompt tuning stays available; read-only principals cannot restore ingestion, surveys or bank management. The shared transport composes over the current host dispatcher to disable Undici's header/body timeout caps while preserving the request's AbortSignal deadline and proxy setup.

SessionStart readiness probes propagate terminal authorization failures before launching further background work; transient failures retain their fallback behavior. Append capabilities and accepted-operation cursors belong to one bank, so a managed bank switch re-probes the destination and starts from a replacement transcript. Grok's native hooks file and generated backup, and Trae's generated JSON backups, are covered by installer transactions.

Multi-source conversation retention preserves rollout contributions in their original order and rereads their sources when rebuilding the shared document. Sources must remain readable, including replies previously retained before their transcript was flushed. Reconstruction supports up to 16 source references and refuses any decoded source or assembled document exceeding 32 MiB of serialized turns or 100,000 turns. Missing or ambiguous sources, unknown legacy continuation boundaries, moving copied prefixes and exceeded limits stop the write with a diagnostic instead of replacing the document with incomplete data. Single-source and persistent-runtime retention retain their existing size behavior.

SessionStart propagates failures to the shared lifecycle entrypoint. Hook lifecycle entrypoints observe rejected work, emit one fixed stderr diagnostic and exit 1 without adding protocol stdout. Authorization denial remains terminal. Seed launch waits only for the child spawn/error event; failure is reported without raw exception text, and manual success means launched, not extraction complete.

Sync requires a confirmed zero active-operation count. Unavailable or malformed operation probes remain unknown; background settlement retries for up to 15 minutes and reports unconfirmed settlement at timeout. Authorization denial remains terminal.
