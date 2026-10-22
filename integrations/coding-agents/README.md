# Coding-agent deployment

[Documentation](../../docs/README.md) | [Repository](../../README.md)

Requires Node.js 22 or later, an HTTPS Memory Router endpoint and matching server grants. For source maintenance, see [upstream upgrades](../../docs/UPGRADING.md) and [build instructions](../../docs/DEVELOPMENT.md).

## Configure the harness

Set `HINDSIGHT_ROUTER_CONFIG` to an absolute, operator-managed JSON file:

```json
{
  "routerUrl": "https://memory-router.example.internal",
  "principals": {
    "codex": {
      "tokenEnv": "MEMORY_ROUTER_CODEX_TOKEN",
      "writeBank": "A",
      "additionalReadBanks": ["B", "C"],
      "mapPathToBank": { "/work/project": "A" }
    },
    "claude-code": {
      "tokenEnv": "MEMORY_ROUTER_CLAUDE_TOKEN",
      "writeBank": "A",
      "additionalReadBanks": ["B", "C"],
      "mapPathToBank": { "/work/project": "A" }
    },
    "opencode": {
      "tokenEnv": "MEMORY_ROUTER_OPENCODE_TOKEN",
      "writeBank": "D",
      "additionalReadBanks": ["B", "E"],
      "mapPathToBank": { "/work/other": "D" }
    }
  }
}
```

Resolve each named environment variable through the deployment's secret manager before launching that harness.
Give each harness only its own token. Never put token values in JSON, arguments, or this repository.
Create matching per-principal + bank + scope grants in Memory Router first.

Client routing does not grant access. Memory Router grants are authoritative.

## Install

From an operator-provisioned project, ask your coding agent:

> Install Memory Router for this harness using the pinned coding-agent release below. Use my existing HINDSIGHT_ROUTER_CONFIG and provisioned environment credentials. Do not ask me for JSON, tokens, or a server command.

Run the pinned GitHub release artifact through npm (replace the release and package version placeholders with values from the same published release):

```sh
npm exec --yes --package=https://github.com/mickey-kras/hindsight-memory-router-integrations/releases/download/v<release>/mickey-kras-hindsight-memory-router-coding-agents-<package-version>.tgz -- hindsight-coding-agents install
```

Use GitHub release tarballs until [npm activation](../../docs/RELEASING.md#one-time-npm-setup) is verified.

For a locally verified download, check the coding-agent tarball against the release's `PACKAGE_SHA256`, then run:

```sh
npm exec --yes --package=/absolute/path/verified-coding-agents.tgz -- hindsight-coding-agents install
```

The operator sets `HINDSIGHT_ROUTER_CONFIG` to an absolute managed JSON path and provisions each principal's named token environment variable before installation. Run from a mapped project directory. Bare `install` selects `HINDSIGHT_MCP_HARNESS` when supplied, otherwise one unambiguous configured and detected harness (or the sole configured harness before first setup). Ambiguous identity fails closed; explicit `install codex`, another supported harness, or `install all` remains available.

Every selected principal, credential, path mapping, current project and adapter prerequisite is checked before runtime staging or host changes. Missing or invalid provisioning prints one sanitized failure line and exits nonzero. No secret is prompted for or written to a harness configuration. `--api-url`, `--api-token` and `--server` are refused in both separate and inline forms. Optional [human login](#human-login) uses Memory Router's managed OIDC authorization and OS secure storage.

Installation copies the runtime to a stable path, preserves the native hooks, plugins, companion skills and background ingestion, and restores the previous runtime, host files and native plugin registries if a mutation fails. The transaction snapshots only affected configuration, skills and plugin storage, excluding session history. Symlinked mutation paths are refused before changes. Reinstalling replaces this integration's entries and preserves other settings. `--import-conversations` is an explicit opt-in backfill of the current project's local history after installation commits.

For Codex, export `HINDSIGHT_ROUTER_CONFIG` before installing. The installer adds that variable,
the `codex` principal's `tokenEnv` name, and optional coding-agent settings to MCP `env_vars`.
Export the token when launching Codex; its value is never written to TOML.
Reinstall after changing `tokenEnv`. Known prior managed token bindings are removed when replaced; other allowlist entries, timeouts, and environment overrides are preserved.
Remove any literal managed token from the MCP `env` table before reinstalling.

## Project and bank rules

Only explicit managed path mappings opt a project in. Child directories inherit their mapping.
Use the principal's write bank in mappings for writable projects; map an assigned read bank for a read-only principal.
Unmapped paths, unknown harnesses, and missing secrets fail closed. No dynamic repository banks.
Upstream normal config may tune prompts and ingestion, but cannot change identity, credentials, endpoint, or grants. `banks.<id>.bank` and path-level bank renames are ignored; change the operator-managed `mapPathToBank` and matching server grants instead.

## Reads and ingestion

Legacy managed JSON keys `recallTimeoutMs`, `recallMaxTokens`, `retainQueueFlushIntervalMs`, `queueMaxAgeMs`, `queueMaxItems`, `queueMaxBytes` and `queueDir` are accepted and validated for compatibility but have no effect in coding agents. Remove them when migrating; tune retrieval in normal coding-agent config. There is no OpenClaw-style durable outage queue or replay timer here; ingestion uses the upstream retry/cursor mechanisms. Managed `queueMaxAgeMs` accepts `-1` or a positive integer and rejects `0`, unlike OpenClaw.

`pageRefreshEveryTurns` (and `HINDSIGHT_PAGE_REFRESH_EVERY_TURNS`) does not reduce hook page-list reads: memory-bearing page lists are deliberately omitted from session caches, so each prompt hook fetches freshly authorized pages. The setting still controls how often the roster/tool guide is injected, not how often it is fetched; omission or `0` means every turn (`1`). It does not configure persistent-plugin refresh behavior. Do not restore cached memory content to implement a cadence.

Recall and reflect read the assigned union, with a 4,096-token shared budget.
Recall/reflect use the caller's configured deadline: automatic retrieval uses `injectTimeoutMs` (7,000 ms), automatic reflect uses `reflectTimeoutMs` (20,000 ms), and the reflect tool uses `reflectToolTimeoutMs` (when omitted, the greater of 330,000 ms and the configured `reflectTimeoutMs`; an explicit positive tool timeout can be lower). Generic requests without a caller signal default to 15 seconds. Raising a hook deadline also requires enough time in the host hook configuration.
Transient failures return partial results with a diagnostic. Any 401/403 discards all results.
Other bank/config/page reads use an explicit assigned bank; mutations cannot target additional read banks.

Bank configuration is operator-managed (`manageBankConfig: false`). Provision coding missions/strategies before ingestion. Read-only principals disable automatic ingestion and write-back.
Memory content is not reused from session caches; lifecycle flags remain cached. A denied token remains blocked until its value changes.


### Optional branding and migration

Set `toolPrefix` once at the top level of the operator-managed JSON named by
`HINDSIGHT_ROUTER_CONFIG`. The default `hindsight_` retains the upstream names. For example,
`"toolPrefix": "abc_"` produces `abc_reflect`, the `abc-coding-agent` companion skill, and an
MCP registration/server identity named `abc`. `chatgpt_` and `memory_` work the same way.
Prefixes are 2–32 lowercase ASCII letters, digits or underscores, begin with a letter and end
with an underscore. Internal underscores become hyphens in the skill and registration name.
There is no second brand/display-name setting.

Branding covers the existing upstream eight-tool suite, native MCP and plugin registration,
companion skill frontmatter/path/content, generated hooks and survey guidance, and visible
memory banners. Package identities, configuration keys, credential environment variables,
router principals, assigned banks and upstream attribution remain stable. The original upstream
operations are `sync_status`, `diagnose`, `search_knowledge_pages`, `list_knowledge_pages`,
`read_knowledge_page`, `reflect`, `capture_initiative` and `ingest_document` under the selected
prefix. Custom standalone `memory_router_*` / `agent_knowledge_*` tools are retired; migrate
callers and allowlists to these upstream operations and schemas rather than assuming aliases or
argument compatibility.

Bare `update` refreshes only the staged runtime. It needs no managed configuration, harness selection,
or live credentials, preserves the installed namespace and available native dependencies, and leaves
host registrations and skills unchanged. With no prior staged namespace it uses the default brand.
It does not import conversations.

After changing `toolPrefix`, run the pinned installer again (or explicit `update <harness>` for the selected harness)
and restart existing sessions. The installer migrates only registrations whose command proves
managed ownership and companion skills with the integration's prefix/provenance marker. It
snapshots both old and new paths and rolls back the migration if any adapter fails. Unrelated
skills and registrations survive; a collision at the desired name fails closed. Runtime sessions
reject stale managed skill namespaces until explicit reinstall. Uninstall removes owned prior
namespaces even if the operator has since changed the prefix. This never changes bank mapping,
router authorization or credential sources. Retained operations remain subject to the managed routing and privacy adaptations described above.

## Human login

Requires Memory Router's optional human OIDC flow and an operator mapping from the authenticated identity to banks/scopes. Use a public native OIDC client with a registered loopback redirect. Router authentication stays authoritative; local project mappings cannot expand access.

Replace a coding principal's `tokenEnv` with an opaque secure-storage reference:

```json
{
  "routerUrl": "https://router.example.test",
  "principals": {
    "codex": {
      "human": { "credentialRef": "interactive" },
      "writeBank": "project-example",
      "additionalReadBanks": [],
      "mapPathToBank": { "/absolute/path/project": "project-example" }
    }
  }
}
```

Set `HINDSIGHT_ROUTER_CONFIG` to that operator-managed file, then run the verified package's installer interactively:

```sh
hindsight-coding-agents login codex
hindsight-coding-agents install codex
```

Login opens the browser and receives the authorization code on `127.0.0.1` at a temporary port. The code, PKCE verifier and OIDC tokens never enter configuration. The router-issued credential is bound to the exact HTTPS router base URL, including any path prefix, and the server-selected principal. Harness identity still selects its fixed local project mapping.

Supported secure stores are macOS Keychain, Windows Credential Manager and Linux Secret Service. Linux requires an unlocked session keyring; headless systems without it cannot use human login. No plaintext file, environment token or Linux kernel-keyring fallback is provided. Native dependencies are staged with the installed runtime and do not require package lifecycle scripts.

New installations preserve an available native secure-storage dependency even in application mode, so a later human login can run from the staged installer after the source package cache disappears. Application mode remains available when the platform has no native dependency. Older staged runtimes that lack native support cannot repair themselves: reinstall from a fresh verified package while still in application mode, then configure human mode and log in. The installer does not download dependencies or replace secure storage with a file. Missing human credentials or native support stops installation before host changes.

Sessions last at most one hour. Expired, revoked, missing or locked credentials stop requests; run `login` again explicitly. There is no automatic refresh or fallback to `mr_*` application credentials. Do not combine `human` and `tokenEnv`. Restart a harness if it has disabled its client after an authorization failure.

New Codex registrations record their authentication mode and managed token variable name as non-secret ownership metadata. Switching a marked application registration to human mode removes that exact token allowlist entry and any matching literal override, while preserving other settings. Older unmarked registrations cannot distinguish former token variables from optional settings, including standard names such as `HINDSIGHT_LOG_FILE`. Human mode automatically allows only `HINDSIGHT_ROUTER_CONFIG`; its harness identity is fixed. Human installation stops before changes when other unmarked environment entries exist: review and remove them from the owned MCP `env_vars` and `env` tables, reinstall, then restore only noncredential settings. The installer never guesses which user entries to delete.

```sh
hindsight-coding-agents sign-out codex
```

Sign-out deletes the local credential even when router revocation cannot be confirmed and reports that limitation. Such a session remains valid until expiry or operator revocation. Router sign-out does not sign out of the identity provider. Harnesses deliberately configured with the same router and credential reference share a session; sign-out affects all of them.

