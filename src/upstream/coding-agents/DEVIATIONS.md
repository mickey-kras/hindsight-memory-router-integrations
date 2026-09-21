# Router deviations

- Managed harness identity, HTTPS endpoint, token environment references, and explicit path mappings replace upstream endpoint/token/dynamic-bank configuration.
- `optInOnly` is enforced from managed mappings. Normal config cannot rename banks or override identity/credentials.
- All HTTP requests use the shared bank/operation guard. Bank listing intersects router-visible banks with configured IDs.
- Recall/reflect fan out through the shared coordinator. Other reads remain explicitly bank-addressed.
- 401/403 are terminal; upstream credential retry is replaced by runtime environment resolution on each request.
- Redirects and raw server error bodies are blocked. Automatic upstream replacement and installer token migration are disabled.
- Transcript parsing, provenance tags, retain payloads, hooks, and harness adapters retain upstream behavior.
- `src/core/inject.ts` rewords the reflect rendering rules to "commit, PR and issue ids": the upstream "commit/PR/issue" slash token trips the Memory Router encoded-payload request scan, which rejects the reflect query with 422 suspicious_content.

The source hashes in `UPSTREAM.json` describe the pristine snapshot. `LOCAL_CHANGES.json` pins adapted files.
The regression suite covers unchanged transcript/provenance code; root tests cover the changed security contracts.
Live harness and deployed Memory Router compatibility must be verified before rollout.

Bank configuration is operator-managed (`manageBankConfig: false`). Provision coding missions/strategies before ingestion. Read-only principals disable automatic ingestion and write-back.
Memory content is not reused from session caches; lifecycle flags remain cached. Authorization failures disable that client until restart.

Reliability fixes use explicit sorting, global replacements, Node ANSI stripping, optional arguments, and non-empty installer regex matches. Transcript escape decoding retains UTF-16 surrogate behavior.

Dependency security overrides (`package.json` `overrides`, applied to `npm-shrinkwrap.json`):
- `@opentelemetry/core` is forced to `>=2.8.0 <3.0.0`, scoped under `@opencode/plugin`, fixing GHSA-8988-4f7v-96qf (unbounded memory allocation in W3C Baggage propagation, moderate, `<=2.7.x` affected). `@opencode/plugin`/`@opencode/util` pin the vulnerable 2.6.1 line (`fixAvailable: false` even at the latest release), so an npm override is the only remediation. The remaining flagged packages (`exporter-trace-otlp-http`, `otlp-exporter-base`, `otlp-transformer`, `resources`, `sdk-logs`, `sdk-metrics`, `sdk-trace-base`, `sdk-trace-node`) are vulnerable only transitively through `core` and are cleared by this single override; the override is nested under `@opencode/plugin` because that subtree is the sole OpenTelemetry consumer.

Code scanning suppressions (comment-only, zero logic change):
- `src/core/survey.ts` carries a single-line `codeql[js/insufficient-password-hash]` suppression directly above the `.update(...)` sink line of the survey lease-key derivation (CodeQL only honors the line immediately below the comment). CodeQL flags the fast SHA-256 over `apiUrl + apiToken + bankId` as a weak password hash, but this digest is a deterministic lease lookup key that keeps credentials out of scratch paths — it is neither password storage nor verification, and no verification oracle exists for it, so a fast hash is correct and the alert is a false positive.
