# Router deviations

- Managed harness identity, HTTPS endpoint, token environment references, and explicit path mappings replace upstream endpoint/token/dynamic-bank configuration.
- `optInOnly` is enforced from managed mappings. Normal config cannot rename banks or override identity/credentials.
- All HTTP requests use the shared bank/operation guard. Bank listing intersects router-visible banks with configured IDs.
- Recall/reflect fan out through the shared coordinator. Other reads remain explicitly bank-addressed.
- 401/403 are terminal; upstream credential retry is replaced by runtime environment resolution on each request.
- Optional human mode resolves a short-lived session from native OS secure storage on every request. Browser login uses the router's loopback OIDC/PKCE exchange; sign-out revokes and deletes the session. Persistent application credentials remain separate.
- Redirects and raw server error bodies are blocked. Automatic upstream replacement and installer token migration are disabled.
- Transcript parsing, provenance tags, retain payloads, hooks, and harness adapters retain upstream behavior.
- Manual document ingestion uses the shared exact-title hash identity. Legacy IDs remain untouched; see the root README migration note.
- `src/core/inject.ts` rewords the reflect rendering rules to "commit, PR and issue ids": the upstream "commit/PR/issue" slash token trips the Memory Router encoded-payload request scan, which rejects the reflect query with 422 suspicious_content.

The source hashes in `UPSTREAM.json` describe the pristine snapshot. `LOCAL_CHANGES.json` pins adapted files.
The regression suite covers unchanged transcript/provenance code; root tests cover the changed security contracts.
Live harness and deployed Memory Router compatibility must be verified before rollout.

Bank configuration is operator-managed (`manageBankConfig: false`). Provision coding missions/strategies before ingestion. Read-only principals disable automatic ingestion and write-back.
Session state uses per-user private directories (0700 on POSIX), regular files (0600), and exclusive atomic temporary files. Owned legacy directories are secured and migrated; symlinks, hard links, and foreign-owned paths are rejected.
Memory content is not reused from session caches; lifecycle flags remain cached. Authorization failures disable that client until restart.

Reliability fixes use explicit sorting, global replacements, Node ANSI stripping, optional arguments, and non-empty installer regex matches. Transcript escape decoding retains UTF-16 surrogate behavior.

Dependency security overrides (`package.json` `overrides`, applied to `npm-shrinkwrap.json`):
- `@opentelemetry/core` is forced to `>=2.8.0 <3.0.0`, scoped under `@opencode/plugin`, fixing GHSA-8988-4f7v-96qf (unbounded memory allocation in W3C Baggage propagation, moderate, `<=2.7.x` affected). `@opencode/plugin`/`@opencode/util` pin the vulnerable 2.6.1 line (`fixAvailable: false` even at the latest release), so an npm override is the only remediation. The remaining flagged packages (`exporter-trace-otlp-http`, `otlp-exporter-base`, `otlp-transformer`, `resources`, `sdk-logs`, `sdk-metrics`, `sdk-trace-base`, `sdk-trace-node`) are vulnerable only transitively through `core` and are cleared by this single override; the override is nested under `@opencode/plugin` because that subtree is the sole OpenTelemetry consumer.

Survey admission is scoped to the managed router URL, principal and bank. Tokens never enter lease keys; credential rotation keeps the same lease. Normal config cannot override the managed principal. No CodeQL suppression is used.

Upstream baseline is coding-agents 0.8.1 at the shared v1.0.0 commit. Downstream package versions remain independent. The managed README, generated companion skill and disabled daemon implementation remain router-owned: upstream endpoint setup, dynamic banks, local daemon and update instructions are unsupported. The package uses npm-shrinkwrap.json; upstream package-lock.json stays intentionally absent.

New upstream append capability, retry budgets, query bounds, page scoping and document freshness reads use the existing guarded client. Version probing accepts GET /v1/version and falls back to /version; authorization failures remain terminal. Router error bodies are redacted, so a 404 cannot latch page support off based on its upstream body.

Grok tool-hook context is stored privately and delivered only after managed credentials and the current project mapping are validated. Its handoff key includes endpoint, primary bank, workspace, session, a hash of the actual effective principal and the complete managed read-bank scope. Every bank that could contribute to aggregated memory is freshly authorized before delivery; scope/principal changes and server revocations reject the handoff. The effective endpoint and project mapping are resolved again after awaited reads and grant probes. Authorization failures discard it permanently. Tokens never enter identity keys; memory is consumed once. Session caches retain attempt counters and lifecycle flags, never memory content.

New Kimi, WorkBuddy, CodeBuddy and TraeCode entries use managed identity and branded registration names. Trae workspace MCP files are written only by explicit transactional installation for operator-mapped projects; hooks only report the workspace-MCP gate. Global settings and workspace SQLite enable switches remain user-managed.

Managed settings are reapplied after every path/bank override, including paths without a bank section. Project prompt tuning stays available; read-only principals cannot restore ingestion, surveys or bank management. The shared transport composes over the current host dispatcher to disable Undici's header/body timeout caps while preserving the request's AbortSignal deadline and proxy setup.

SessionStart readiness probes propagate terminal authorization failures before launching further background work; transient failures retain their fallback behavior. Append capabilities and accepted-operation cursors belong to one bank, so a managed bank switch re-probes the destination and starts from a replacement transcript. Grok's native hooks file and generated backup, and Trae's generated JSON backups, are covered by installer transactions.
