# Coding-agent deployment

[Documentation](../../docs/README.md) | [Repository](../../README.md)

Use Node.js 22 or later, an HTTPS Memory Router endpoint and matching server grants. For source maintenance, see [upstream upgrades](../../docs/UPGRADING.md) and [build instructions](../../docs/DEVELOPMENT.md).

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

Before you start a harness, resolve each named environment variable through the deployment's secret manager.
Give each harness only its own token. Never put token values in JSON, arguments, or this repository.
First, create matching grants for each principal, bank and scope in Memory Router.

Client routing does not grant access. Memory Router grants control access.

## Install

From an operator-provisioned project, ask your coding agent:

> Install Memory Router for this harness using the pinned coding-agent release below. Use my existing HINDSIGHT_ROUTER_CONFIG and provisioned environment credentials. Do not ask me for JSON, tokens, or a server command.

Replace the release and package version placeholders with values from the same published release.
Run the pinned GitHub release artifact through npm:

```sh
npm exec --yes --package=https://github.com/mickey-kras/hindsight-memory-router-integrations/releases/download/v<release>/mickey-kras-hindsight-memory-router-coding-agents-<package-version>.tgz -- hindsight-coding-agents install
```

Use GitHub release tarballs until [npm activation](../../docs/RELEASING.md#one-time-npm-setup) is verified.

For a local download, check the coding-agent tarball against the release's `PACKAGE_SHA256`.
Then run this command:

```sh
npm exec --yes --package=/absolute/path/verified-coding-agents.tgz -- hindsight-coding-agents install
```

Before installation, the operator sets `HINDSIGHT_ROUTER_CONFIG` to an absolute managed JSON path. The operator supplies each principal's named token environment variable.
Run from a mapped project directory.
If supplied, bare `install` selects `HINDSIGHT_MCP_HARNESS`. Otherwise, it selects one unambiguous configured and detected harness.
Before first setup, it can select the only configured harness. Ambiguous identity stops installation.
Explicit `install codex`, another supported harness, or `install all` remains available.

Before runtime staging or host changes, the installer checks every selected principal, credential, path mapping, current project and adapter prerequisite.
Missing or invalid configuration causes one failure line with sensitive data removed and a nonzero exit.
The installer does not request a secret or write one to a harness configuration.
It rejects `--api-url`, `--api-token` and `--server` in separate and inline forms. Optional [human login](#human-login) uses Memory Router's managed OIDC authorization and OS secure storage.

Installation copies the runtime to a stable path. It preserves native hooks, plugins, companion skills and background ingestion.
If a change fails, installation restores the previous runtime, host files and native plugin registries.
The transaction snapshots only affected configuration, skills and plugin storage. It excludes session history.
The installer rejects symlinked mutation paths before changes. Reinstallation replaces this integration's entries and preserves other settings.
After installation commits, `--import-conversations` explicitly imports the current project's local history.

For Codex, export `HINDSIGHT_ROUTER_CONFIG` before installing. The installer adds that variable,
the `codex` principal's `tokenEnv` name, and optional coding-agent settings to MCP `env_vars`.
Export the token when launching Codex; its value is never written to TOML.
After a `tokenEnv` change, reinstall. The installer removes known prior managed token bindings when it replaces them.
It preserves other allowlist entries, timeouts, and environment overrides.
Remove any literal managed token from the MCP `env` table before reinstalling.

## Project and bank rules

Only explicit managed path mappings opt a project in. Child directories inherit their mapping.
For writable projects, use the principal's write bank in mappings. For a read-only principal, map an assigned read bank.
Unmapped paths, unknown harnesses, and missing secrets stop access. The integration does not create dynamic repository banks.
Normal upstream configuration can adjust prompts and ingestion. It cannot change identity, credentials, endpoint, or grants.
The integration ignores `banks.<id>.bank` and path-level bank renames.
To change banks, change the operator-managed `mapPathToBank` and matching server grants.

## Reads and ingestion

Coding agents accept and validate legacy managed JSON keys for compatibility. These keys have no effect:
`recallTimeoutMs`, `recallMaxTokens`, `retainQueueFlushIntervalMs`, `queueMaxAgeMs`, `queueMaxItems`, `queueMaxBytes` and `queueDir`.
During migration, remove them. Adjust retrieval in normal coding-agent configuration.
Coding agents have no OpenClaw-style durable outage queue or replay timer. Ingestion uses the upstream retry/cursor mechanisms.
Managed `queueMaxAgeMs` accepts `-1` or a positive integer. Unlike OpenClaw, it rejects `0`.

`pageRefreshEveryTurns` and `HINDSIGHT_PAGE_REFRESH_EVERY_TURNS` do not reduce hook page-list reads.
Session caches omit page lists that contain memory. Each prompt hook fetches newly authorized pages.
The setting controls how often the roster/tool guide is injected. It does not control how often the guide is fetched.
An omitted value or `0` means every turn (`1`). The setting does not configure persistent-plugin refresh behavior.
Do not restore cached memory content to control refresh frequency.

Recall and reflect read the assigned union, with a 4,096-token shared budget.
Recall/reflect use the caller's configured deadline:

- Automatic retrieval uses `injectTimeoutMs` (7,000 ms).
- Automatic reflect uses `reflectTimeoutMs` (20,000 ms).
- The reflect tool uses `reflectToolTimeoutMs`. If omitted, this is the greater of 330,000 ms and the configured `reflectTimeoutMs`. An explicit positive tool timeout can be lower.

Generic requests without a caller signal default to 15 seconds.
If you increase a hook deadline, also allow sufficient time in the host hook configuration.
Transient failures return partial results with a diagnostic. Any 401/403 discards all results.
Other bank/config/page reads use an explicit assigned bank. Mutations cannot target additional read banks.

The operator manages bank configuration (`manageBankConfig: false`). Before ingestion, configure coding missions/strategies.
Read-only principals disable automatic ingestion and write-back.
The integration does not reuse memory content from session caches. Lifecycle flags remain cached. A denied token remains blocked until its value changes.


### Optional branding and migration

Set `toolPrefix` once at the top level of the operator-managed JSON named by
`HINDSIGHT_ROUTER_CONFIG`. The default `hindsight_` retains the upstream names. For example,
`"toolPrefix": "abc_"` produces `abc_reflect`, the `abc-coding-agent` companion skill, and an
MCP registration/server identity named `abc`. `chatgpt_` and `memory_` work the same way.
Prefixes contain 2-32 lowercase ASCII letters, digits or underscores. They begin with a letter and end with an underscore. Internal underscores become hyphens in the skill and registration name.
There is no second brand/display-name setting.

Branding covers the existing upstream eight-tool suite, native MCP and plugin registration,
companion skill frontmatter/path/content, generated hooks and survey guidance, and visible
memory banners. Package identities, configuration keys, credential environment variables,
router principals, assigned banks and upstream attribution remain stable. The original upstream
operations are `sync_status`, `diagnose`, `search_knowledge_pages`, `list_knowledge_pages`,
`read_knowledge_page`, `reflect`, `capture_initiative` and `ingest_document` under the selected
prefix. Custom standalone `memory_router_*` / `agent_knowledge_*` tools are retired.
Migrate callers and allowlists to these upstream operations and schemas.
Do not assume that aliases or arguments are compatible.

Bare `update` refreshes only the staged runtime.
It needs no managed configuration, harness selection, or live credentials.
It preserves the installed namespace and available native dependencies. Host registrations and skills do not change. With no prior staged namespace it uses the default brand.
It does not import conversations.

After a `toolPrefix` change, run the pinned installer again, or explicit `update <harness>` for the selected harness.
Then restart existing sessions. The installer migrates only registrations whose command proves
managed ownership and companion skills with the integration's prefix/provenance marker. It
snapshots both old and new paths and rolls back the migration if any adapter fails. Unrelated
skills and registrations remain. A collision at the desired name stops migration. Runtime sessions
reject stale managed skill namespaces until explicit reinstall. Uninstall removes owned prior
namespaces even if the operator has since changed the prefix. This never changes bank mapping,
router authorization or credential sources. Retained operations remain subject to the managed routing and privacy adaptations described above.

## Human login

Human login requires Memory Router's optional human OIDC flow. It also requires an operator mapping from the authenticated identity to banks/scopes. Use a public native OIDC client with a registered loopback redirect. Router authentication stays authoritative; local project mappings cannot expand access.

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

Set `HINDSIGHT_ROUTER_CONFIG` to that operator-managed file.
Run the verified package's installer interactively:

```sh
hindsight-coding-agents login codex
hindsight-coding-agents install codex
```

Login opens the browser and receives the authorization code on `127.0.0.1` at a temporary port.
The code, PKCE verifier and OIDC tokens never enter configuration.
The router-issued credential is bound to the exact HTTPS router base URL, including any path prefix.
It is also bound to the server-selected principal. Harness identity still selects its fixed local project mapping.

Supported secure stores are macOS Keychain, Windows Credential Manager and Linux Secret Service.
Linux requires an unlocked session keyring. Headless systems without it cannot use human login.
There is no plaintext file, environment token or Linux kernel-keyring fallback.
The installer stages native dependencies with the runtime. These dependencies do not require package lifecycle scripts.

New installations preserve an available native secure-storage dependency, including in application mode.
Later human login can then use the staged installer after removal of the source package cache.
If the platform has no native dependency, application mode remains available.
Older staged runtimes without native support cannot repair themselves.
In application mode, reinstall from a new verified package. Then configure human mode. Log in.
The installer does not download dependencies or replace secure storage with a file.
Missing human credentials or native support stops installation before host changes.

Sessions last at most one hour. Expired, revoked, missing or locked credentials stop requests.
Run `login` again explicitly. There is no automatic refresh or fallback to `mr_*` application credentials. Do not combine `human` and `tokenEnv`. Restart a harness if it has disabled its client after an authorization failure.

New Codex registrations record their authentication mode and managed token variable name as ownership metadata. This metadata contains no secrets.
A change from a marked application registration to human mode removes that exact token allowlist entry and any matching literal override.
It preserves other settings.
Older unmarked registrations cannot distinguish former token variables from optional settings, including standard names such as `HINDSIGHT_LOG_FILE`.
Human mode automatically allows only `HINDSIGHT_ROUTER_CONFIG`. Its harness identity is fixed.
If other unmarked environment entries exist, human installation stops before changes.
Review those entries in the owned MCP `env_vars` and `env` tables. Remove them. Reinstall. Restore only settings without credentials.
The installer never guesses which user entries to delete.

```sh
hindsight-coding-agents sign-out codex
```

Sign-out deletes the local credential, including when it cannot confirm router revocation. It reports that limitation.
Such a session remains valid until expiry or operator revocation. Router sign-out does not sign out of the identity provider.
Harnesses configured with the same router and credential reference share a session. Sign-out affects all of them.


