# Integration documentation

[Repository](../README.md)

Choose your client guide: [OpenClaw](OPENCLAW.md), [coding agents](../integrations/coding-agents/README.md), or the [hosted HTTP client](hosted-client.md). The two release packages require an HTTPS router endpoint and matching server grants. Coding-agent MCP is included in the coding-agents package.

## Install and use

- [OpenClaw](OPENCLAW.md): plugin configuration, queue retention and audit logs
- [Hosted HTTP client](hosted-client.md): typed router access for hosted agents and apps
- [Coding agents](../integrations/coding-agents/README.md): harness identity, credentials and project mappings
- [Routing and data behavior](BEHAVIOR.md): bank rules, partial reads, queue limits and ingest identity

## Architecture

- [Shared architecture and request flows](https://mickey-kras.github.io/hindsight-memory-router/)
- [Memory Router documentation](https://github.com/mickey-kras/hindsight-memory-router/blob/main/docs/README.md): server deployment, credentials and bank grants

## Maintain

- [Build and verify](DEVELOPMENT.md)
- [Upgrade vendored integrations](UPGRADING.md) and [local deviations](DEVIATIONS.md)
- [Release packages](RELEASING.md) and [dependency updates](dependabot.md)

## Retained upstream references

Use the setup guides above for this fork. Vendored files describe upstream behavior. Provenance hashes track these files: [upstream README](../src/upstream/coding-agents/README.md), [deviations](../src/upstream/coding-agents/DEVIATIONS.md), [skill instructions](../src/upstream/coding-agents/skill/SKILL.md) and [skill preamble](../src/upstream/coding-agents/skill-src/preamble.md).

[License](../LICENSE).

