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

The repository currently publishes GitHub release tarballs; it does not claim that the scoped package is available from the npm registry. If registry publication is enabled later, the equivalent pinned command is `npx @mickey-kras/hindsight-memory-router-coding-agents@<package-version> install`.

For a locally verified download, check the coding-agent tarball against the release's `PACKAGE_SHA256`, then run:

```sh
npm exec --yes --package=/absolute/path/verified-coding-agents.tgz -- hindsight-coding-agents install
```

The operator sets `HINDSIGHT_ROUTER_CONFIG` to an absolute managed JSON path and provisions each principal's named token environment variable before installation. Run from a mapped project directory. Bare `install` selects `HINDSIGHT_MCP_HARNESS` when supplied, otherwise one unambiguous configured and detected harness (or the sole configured harness before first setup). Ambiguous identity fails closed; explicit `install codex`, another supported harness, or `install all` remains available.

Every selected principal, credential, path mapping, current project and adapter prerequisite is checked before runtime staging or host changes. Missing or invalid provisioning prints one sanitized failure line and exits nonzero. No secret is prompted for or written to a harness configuration. `--api-url`, `--api-token` and `--server` are refused in both separate and inline forms. Human sign-in is unsupported pending Memory Router's managed authorization support (#477).

Installation copies the runtime to a stable path, preserves the native hooks, plugins, companion skills and background ingestion, and restores the previous runtime, host files and native plugin registries if a mutation fails. The transaction snapshots only affected configuration, skills and plugin storage, excluding session history. Symlinked mutation paths are refused before changes. Reinstalling replaces this integration's entries and preserves other settings. `--import-conversations` is an explicit opt-in backfill of the current project's local history after installation commits.

For Codex, export `HINDSIGHT_ROUTER_CONFIG` before installing. The installer adds that variable,
the `codex` principal's `tokenEnv` name, and optional coding-agent settings to MCP `env_vars`.
Export the token when launching Codex; its value is never written to TOML.
Reinstall after changing `tokenEnv`. Existing allowlist entries, timeouts, and environment overrides are preserved.
Remove any literal managed token from the MCP `env` table before reinstalling.

## Project and bank rules

Only explicit managed path mappings opt a project in. Child directories inherit their mapping.
Use the principal's write bank in mappings for writable projects; map an assigned read bank for a read-only principal.
Unmapped paths, unknown harnesses, and missing secrets fail closed. No dynamic repository banks.
Upstream normal config may tune prompts and ingestion, but cannot change identity, credentials, endpoint, or grants.

## Reads and ingestion

Recall and reflect read the assigned union, with a 4,096-token shared budget.
Recall has a 15-second deadline; reflect uses the upstream caller's timeout.
Transient failures return partial results with a diagnostic. Any 401/403 discards all results.
Other bank/config/page reads use an explicit assigned bank; mutations cannot target additional read banks.

Bank configuration is operator-managed (`manageBankConfig: false`). Provision coding missions/strategies before ingestion. Read-only principals disable automatic ingestion and write-back.
Memory content is not reused from session caches; lifecycle flags remain cached. A denied token remains blocked until its value changes.


### Tool namespace and migration

Set `toolPrefix` once at the top level of the JSON file named by `HINDSIGHT_ROUTER_CONFIG`.
When omitted, tool names use `hindsight_`. A custom prefix must contain 2–32 lowercase ASCII
letters, digits or underscores, start with a letter, and end with an underscore (for example
`"toolPrefix": "team_"`). The same value controls registered MCP/native tools, installed companion
skills, hook guidance and survey tool permissions. Normal coding-agent configuration, per-bank
settings and environment overrides cannot select another tool namespace. Invalid prefixes,
duplicate tool names and inconsistent skill namespaces fail closed.

To migrate existing `memory_router_*` retain/recall names and `agent_knowledge_*` page/ingest names,
update client tool calls and allowlists to the selected prefix, reinstall each coding-agent harness
to regenerate its companion skill, and restart existing MCP/native sessions. Both old namespaces
converge on the single selected prefix; no aliases are silently registered. A consumer that needs
its existing namespace may explicitly select `memory_router_` or `agent_knowledge_`, then update
its other tool calls to that same prefix. A runtime session rejects a stale skill with another
prefix; explicit reinstall is the migration action. Bank assignments, router grants, token sources,
read/write authorization and each operation's arguments and behavior are unchanged.
