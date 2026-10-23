## Managed setup and updates

Use the existing operator-provisioned `HINDSIGHT_ROUTER_CONFIG` absolute path and named credential environment variables.
The operator supplies the HTTPS router URL, principal grants, project bank mapping and optional tool namespace.
When necessary, `HINDSIGHT_MCP_HARNESS` selects the trusted harness identity.
Start the harness in the same configured environment from a mapped project.

Do not ask the user to paste JSON or credentials.
Do not edit the managed JSON, copy tokens into harness settings, or start a memory server.
If configuration is missing or identity is ambiguous, the operator must repair the deployment.
Unmapped projects and missing credentials stop access.

Use only the integration's pinned release tarball to install or update the integration.
Select the release and package version from the same published release.
Verify the artifact against that release's `PACKAGE_SHA256`.
Run this command:

```sh
npm exec --yes --package=/absolute/path/verified-coding-agents.tgz -- hindsight-coding-agents install
```

The release download path is:
`https://github.com/mickey-kras/hindsight-memory-router-integrations/releases/download/v<release>/mickey-kras-hindsight-memory-router-coding-agents-<package-version>.tgz`.
Replace all version placeholders.
If the existing managed configuration supports it, use explicit `install codex`, another supported harness, or `install all`.
Before host changes, the installer checks the selected principals, credentials, project mapping and adapter prerequisites.
For Codex, export `HINDSIGHT_ROUTER_CONFIG` before installation.
The installer can then allow the required environment variable names without storing their values.

If the operator's credential environment variable name or tool namespace changes, reinstall from the verified artifact.
Namespace changes require reinstallation of the companion skill and tool registration together.
The managed tool prefix controls tool definitions and guidance. Ordinary per-bank settings cannot override it.

## Check the integration

First, check the session banner and available memory tools.
If available, use `hindsight_sync_status` for ingestion progress.
If available, use `hindsight_diagnose` for diagnostics with sensitive data removed.
If memory seems stale, inspect progress before another ingestion attempt or selection of another bank.
Use the diagnostics to confirm the current project bank.
If access or bank selection is unclear, ask the operator to verify assigned bank grants and managed project mappings.

Missing hooks or tools usually require reinstallation of the selected harness from the verified artifact with its managed environment.
Review the harness's plugin/hook registration and logs with sensitive data removed. Never print credential values.
A 401/403 response stops requests for that credential.
Ask the operator to resolve authorization and restart with the configured credential.
Do not try another principal, URL or bank.
The router enforces rate limits and quarantine decisions. Local settings cannot bypass them.
If the harness permits work without memory, continue coding. State any material lack of memory evidence.

The operator can configure supported coding-agent settings such as `autoInject`, `retainSessions`, `disabled`, git survey limits and logging.
The managed routing boundary controls bank access and transport.
Do not create banks, change bank configuration, configure servers, or substitute a provider client.
Background ingestion and hooks use the same router boundary as interactive tools.

### Optional branding

The operator can set `toolPrefix` in the same managed router JSON.
The default `hindsight_` keeps the upstream names.
Tool, skill, registration and display names derive from that one value.
Package names, `HINDSIGHT_*` environment variables, configuration paths, principals and bank grants do not change.
Use the names registered in the current session. Do not guess aliases.

A branding change requires the pinned installer (`install` or `update`) and a new session.
The installer migrates only managed entries and rejects unrelated name collisions.
A stale managed skill namespace stops access until reinstallation.
Do not repair this condition through changes to bank assignments, credentials or the operational memory workflow above.
