## Managed setup and updates

Use the existing operator-provisioned `HINDSIGHT_ROUTER_CONFIG` absolute path and named credential
environment variables. The operator supplies the HTTPS router URL, principal grants, project bank
mapping and optional tool namespace. `HINDSIGHT_MCP_HARNESS` selects the trusted harness identity
when needed. Launch the harness in the same provisioned environment from a mapped project.

Do not ask the user to paste JSON or credentials, edit the managed JSON, copy tokens into harness
settings, or start a memory server. Missing provisioning or ambiguous identity requires the
operator to repair the deployment. Unmapped projects and missing credentials fail closed.

Install or update only using the integration's pinned release tarball. Select the release and
package version from the same published release, verify the artifact against that release's
`PACKAGE_SHA256`, and run:

```sh
npm exec --yes --package=/absolute/path/verified-coding-agents.tgz -- hindsight-coding-agents install
```

The release download path is:
`https://github.com/mickey-kras/hindsight-memory-router-integrations/releases/download/v<release>/mickey-kras-hindsight-memory-router-coding-agents-<package-version>.tgz`.
Do not leave version placeholders unresolved. Explicit `install codex`, another supported harness,
or `install all` is available when the existing managed configuration supports it. The installer
checks the selected principals, credentials, project mapping and adapter prerequisites before
changing the host. For Codex, export `HINDSIGHT_ROUTER_CONFIG` before installation so the installer
can allowlist the required environment variable names without embedding their values.

After changing the operator's credential environment variable name or tool namespace, reinstall
from the verified artifact. Namespace changes require reinstalling the companion skill and tool
registration together. The managed tool prefix controls tool definitions and guidance; ordinary
per-bank settings cannot override it.

## Checking the integration

Check the session banner and available memory tools first. Use `hindsight_sync_status` for ingestion
progress and `hindsight_diagnose` for sanitized diagnostic information when these tools are available.
If memory seems stale, inspect progress before repeating ingestion or inventing another bank.
`hindsight_list_banks` shows only the principal's assigned visible banks; use an explicit assigned
bank for bank configuration and knowledge-page reads.

Missing hooks or tools usually require reinstalling the selected harness from the verified artifact
with its managed environment. Review the harness's plugin/hook registration and sanitized logs;
never print credential values. A 401/403 stops requests for that credential. Ask the operator to
resolve authorization and restart with the provisioned credential; do not try another principal,
URL or bank. Rate limits and quarantine decisions are enforced by the router and are not bypassed
by local settings. Continue coding without memory when the harness fails open, and state any
material lack of memory evidence.

Operational coding-agent settings such as `autoInject`, `retainSessions`, `disabled`, git survey
limits and logging may be configured by the operator in the supported coding-agent settings.
The managed routing boundary owns bank access and transport; do not create banks, rewrite bank
configuration, provision servers or substitute a provider client. Background ingestion and hooks
use the same router boundary as interactive tools.

### Optional branding

The operator may set `toolPrefix` in the same managed router JSON. The default `hindsight_`
keeps the upstream names. Tool, skill, registration and display names derive from that one
value. Package
names, `HINDSIGHT_*` environment variables, configuration paths, principals and bank grants
remain unchanged. Use the names registered in the current session; do not guess aliases.

A branding change requires the pinned installer (`install` or `update`) and a fresh session.
The installer migrates only managed entries and refuses unrelated name collisions. A stale
managed skill namespace fails closed until reinstall; never repair this by changing bank
assignments, credentials or the operational memory workflow above.
