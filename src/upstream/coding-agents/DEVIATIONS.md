# Router deviations

- Managed harness identity, HTTPS endpoint, token environment references, and explicit path mappings replace upstream endpoint/token/dynamic-bank configuration.
- Managed mappings enforce `optInOnly`. Normal configuration cannot rename banks or override identity/credentials.
- All HTTP requests use the shared bank/operation guard. Bank listing intersects router-visible banks with configured IDs.
- Recall/reflect use the shared coordinator to read multiple banks. Other reads require an explicit bank address.
- A 401/403 response is terminal. Runtime environment resolution on each request replaces upstream credential retry.
- Optional human mode resolves a short-lived session from native OS secure storage on every request.
  Browser login uses the router's loopback OIDC/PKCE exchange. Sign-out revokes and deletes the session.
  Persistent application credentials remain separate.
- The client blocks redirects and raw server error bodies. Automatic upstream replacement and installer token migration are disabled.
- At every verbosity, diagnostic and ordinary log files permit only timing, counts, booleans and bounded classifications.
  They omit prompts, answers, failure text, identifiers, paths, URLs and arbitrary progress messages.
  There is no content-debug mode. An upgrade does not remove existing log files.
- Upstream transcript parsing, provenance tags, retain payloads, hooks and harness adapters remain the baseline.
  This fork changes routing, privacy, installation and reliability. It does not claim identical behavior.
  The changes and source hashes below define the maintained differences.
- Manual document ingestion uses the shared exact-title hash identity. Legacy IDs do not change. See the root README migration note.
- `src/core/inject.ts` changes the reflect rendering rules to "commit, PR and issue ids".
  The upstream "commit/PR/issue" slash token triggers the Memory Router encoded-payload request scan.
  That scan rejects the reflect query with 422 suspicious_content.

The source hashes in `UPSTREAM.json` describe the original snapshot. `LOCAL_CHANGES.json` pins adapted files.
The regression suite covers unchanged transcript/provenance code. Root tests cover the changed security contracts.
Before deployment, verify compatibility with live harnesses and the deployed Memory Router.

The operator manages bank configuration (`manageBankConfig: false`). Before ingestion, configure coding missions/strategies.
Read-only principals disable automatic ingestion and write-back. Local usage can read existing host transcripts.
Journal-only hosts capture prompts and replies only if session retention is enabled and the principal can write the resolved bank.

Session state uses per-user private directories (0700 on POSIX), regular files (0600), and exclusive atomic temporary files.
The integration secures and migrates owned legacy directories. It rejects symlinks, hard links, and foreign-owned paths.
It does not reuse memory content from session caches. Lifecycle flags remain cached.
A denied application-token value remains blocked until it changes. Human credentials require explicit login after expiry or denial.

Reliability fixes use explicit sorting, global replacements, Node ANSI stripping, optional arguments, and non-empty installer regex matches.
Transcript escape decoding retains UTF-16 surrogate behavior.

Package declarations classify dependencies. Bundling does not make declared runtime dependencies development-only.
Direct runtime dependencies are `@modelcontextprotocol/sdk`, `@napi-rs/keyring`, `jsonc-parser`, `smol-toml` and `zod`.
Development dependencies are `@opencode-ai/plugin`, `@opencode-ai/sdk`, `@opencode/plugin`, `@types/node`, `tsup`, `typescript` and `vitest`.

The complete override inventory is:

| Dependency | Range |
| --- | --- |
| `@opencode/plugin > @opentelemetry/core` | `>=2.8.0 <3.0.0` |
| `esbuild` | `>=0.25.0 <1.0.0` |
| `fast-uri` | `>=3.1.6 <4.0.0` |
| `hono` | `>=4.13.11 <5.0.0` |
| `http-cache-semantics` | `4.3.0` |
| `ip-address` | `>=10.5.1 <11.0.0` |
| `postcss` | `>=8.5.23 <9.0.0` |
| `vite` | `>=6.4.3 <7.0.0` |

These ranges constrain the dependency graph. `npm-shrinkwrap.json` contains exact resolved versions.
When you update dependencies, assess compatibility and advisories again.
Do not assume that these overrides remain necessary or sufficient.

Survey admission uses the managed router URL, principal and bank as its scope.
Tokens never enter lease keys. Credential rotation keeps the same lease.
Normal configuration cannot override the managed principal. The code uses no CodeQL suppression.

The upstream baseline is coding-agents 0.8.2 at the shared v1.1.0 release commit. Downstream package versions remain independent.
The router maintains the managed README, generated companion skill and disabled daemon implementation.
Upstream endpoint setup, dynamic banks, local daemon and update instructions are unsupported.
The package uses npm-shrinkwrap.json. Upstream package-lock.json remains intentionally absent.

New upstream append capability, retry budgets, query bounds, page scoping and document freshness reads use the existing guarded client.
Version probing accepts GET /v1/version and falls back to /version. Authorization failures remain terminal.
The router removes error body content. Thus, a 404 cannot disable page support based on its upstream body.

Grok tool-hook context uses private storage. Delivery requires valid managed credentials and a valid current project mapping.
The handoff key contains these fields:

- Endpoint and primary bank.
- Canonical physical path of the recorded session root.
- Session.
- Hash of the actual effective principal.
- Complete managed read-bank scope.

A move into a subdirectory preserves the handoff only under both conditions:

- The live directory and recorded root remain authorized for the same bank.
- The live directory remains physically inside that root.

Before delivery, every bank that could contribute memory receives a new authorization check.
These checks run in parallel under one shared 15-second deadline.
Scope/principal changes and server revocations reject the handoff.
After awaited reads and grant probes, the integration resolves the effective endpoint, physical workspace and project mapping again.
Authorization failures discard the handoff permanently. Tokens never enter identity keys.

Pending context uses immutable blocks with atomic claims per publication.
Concurrent tools can deliver separate blocks. Waiting-block deduplication is best-effort.
Delivery reads at most 64 blocks per event. Later blocks remain for subsequent events.
Terminal denial discards the bound scope's pending snapshot.
Session caches retain attempt counters and lifecycle flags. They never retain memory content.

New Kimi, WorkBuddy, CodeBuddy and TraeCode entries use managed identity and branded registration names.
Only explicit transactional installation writes Trae workspace MCP files for operator-mapped projects.
Hooks only report the workspace-MCP gate. Users manage global settings and workspace SQLite enable switches.

The integration reapplies managed settings after every path/bank override, including paths without a bank section.
Project prompt adjustments remain available. Read-only principals cannot restore ingestion, surveys or bank management.
The shared transport uses the current host dispatcher to disable Undici's header/body timeout caps.
It preserves the request's AbortSignal deadline and proxy setup.

Before further background work starts, SessionStart readiness probes propagate terminal authorization failures.
Transient failures retain their fallback behavior. Append capabilities and accepted-operation cursors belong to one bank.
Thus, a managed bank switch probes the destination again and starts from a replacement transcript.
Installer transactions cover Grok's native hooks file and generated backup. They also cover Trae's generated JSON backups.

Multi-source conversation retention preserves rollout contributions in their original order.
It reads their sources again when it rebuilds the shared document.
Sources must remain readable, including replies retained before their transcript was flushed.
Reconstruction supports up to 16 source references.
It rejects any decoded source or assembled document that exceeds 32 MiB of serialized turns or 100,000 turns.
The following conditions stop the write with a diagnostic:

- Missing or ambiguous sources.
- Unknown legacy continuation boundaries.
- Moving copied prefixes.
- Exceeded limits.

The integration does not replace the document with incomplete data.
Single-source and persistent-runtime retention keep their existing size behavior.

SessionStart propagates failures to the shared lifecycle entrypoint.
Hook lifecycle entrypoints observe rejected work, emit one fixed stderr diagnostic and exit 1 without protocol stdout.
Authorization denial remains terminal. Seed launch waits only for the child spawn/error event.
Failure reports omit raw exception text. Manual success means that launch occurred. It does not mean that extraction is complete.

Sync requires a confirmed zero active-operation count. Unavailable or malformed operation probes remain unknown.
Background settlement retries for up to 15 minutes. At timeout, it reports unconfirmed settlement. Authorization denial remains terminal.

Persistent runtimes admit at most 256 sessions per workspace. Explicit host disposal releases completed state.
If end events are unavailable, admission evicts the least-recently-used idle session.
Active prompts, transcript fetches, retains and dirty or buffered cursors stay pinned.
If every slot is pinned, new sessions skip automatic recall/retention with a `session_capacity_reached` diagnostic. Existing work continues.
Evicted sessions resume with a full transcript replacement.

OpenCode2 global events require current scoped-prompt admission. Keyed injection never falls back to another session.
Cline keeps only the latest prompt ID for up to 256 sessions.
Usage counters restart after eviction. Thus, resumed transcripts can repeat local usage records.

Managed git-log synchronization retains bounded full replacement semantics. Upstream incremental appends lack an expected-base precondition.
Two asynchronous writes from the same persisted head can overlap after HEAD changes, despite distinct operation IDs.
This fork does not import the append implementation until that concurrency contract exists.
Authorization denials remain terminal. The maintained git-log tests cover pending writes across changed heads.
