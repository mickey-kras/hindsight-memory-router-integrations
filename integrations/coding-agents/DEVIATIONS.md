# Router deviations

- Managed harness identity, HTTPS endpoint, token environment references, and explicit path mappings replace upstream endpoint/token/dynamic-bank configuration.
- `optInOnly` is enforced from managed mappings. Normal config cannot rename banks or override identity/credentials.
- All HTTP requests use the shared bank/operation guard. Global listing returns configured IDs without probing existence.
- Recall/reflect fan out through the shared coordinator. Other reads remain explicitly bank-addressed.
- 401/403 are terminal; upstream credential retry is replaced by runtime environment resolution on each request.
- Redirects and raw server error bodies are blocked. Automatic upstream replacement and installer token migration are disabled.
- Transcript parsing, provenance tags, retain payloads, hooks, and harness adapters retain upstream behavior.

The source hashes in `UPSTREAM.json` describe the pristine snapshot. `LOCAL_CHANGES.json` pins adapted files.
The regression suite covers unchanged transcript/provenance code; root tests cover the changed security contracts.
Live harness and deployed Memory Router compatibility must be verified before rollout.

Bank configuration is operator-managed (`manageBankConfig: false`). Provision coding missions/strategies before ingestion. Read-only principals disable automatic ingestion and write-back.
Memory content is not reused from session caches; lifecycle flags remain cached. Authorization failures disable that client until restart.
