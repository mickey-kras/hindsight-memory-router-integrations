# Hindsight Memory Router integrations

[![PR validation](https://github.com/mickey-kras/hindsight-memory-router-integrations/actions/workflows/pr-validation.yml/badge.svg?event=pull_request)](https://github.com/mickey-kras/hindsight-memory-router-integrations/actions/workflows/pr-validation.yml?query=event%3Apull_request)
[![coverage](https://img.shields.io/badge/coverage-%E2%89%A590%25%20%28CI--gated%29-brightgreen)](vitest.config.ts)
[![codeql](https://github.com/mickey-kras/hindsight-memory-router-integrations/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/mickey-kras/hindsight-memory-router-integrations/actions/workflows/codeql.yml?query=branch%3Amain)
[![aislop](https://badges.scanaislop.com/score/mickey-kras/hindsight-memory-router-integrations.svg)](https://scanaislop.com/mickey-kras/hindsight-memory-router-integrations)
[![main + SonarQube](https://github.com/mickey-kras/hindsight-memory-router-integrations/actions/workflows/main.yml/badge.svg?branch=main)](https://github.com/mickey-kras/hindsight-memory-router-integrations/actions/workflows/main.yml?query=branch%3Amain)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Connect OpenClaw and coding agents to [Memory Router](https://github.com/mickey-kras/hindsight-memory-router). Give each agent a credential, one optional write bank and additional read banks, so agents can share selected memories without sharing every bank. Memory Router enforces access; client routing does not grant it.

## How it fits together

<a href="https://mickey-kras.github.io/hindsight-memory-router/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mickey-kras/hindsight-memory-router-integrations/main/docs/architecture/overview-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/mickey-kras/hindsight-memory-router-integrations/main/docs/architecture/overview-light.svg">
    <img alt="Agents use Integrations, Memory Router, and Hindsight; Integrations are highlighted; access rules and quarantine belong to the router." src="https://raw.githubusercontent.com/mickey-kras/hindsight-memory-router-integrations/main/docs/architecture/overview-light.svg">
  </picture>
</a>

[Explore the architecture and request flows](https://mickey-kras.github.io/hindsight-memory-router/) · [Memory Router repository](https://github.com/mickey-kras/hindsight-memory-router)

## Install

Requires Node.js 22 or later, an HTTPS Memory Router endpoint and server-side principal/bank/scope grants.

Download the integration's `.tgz` from [Releases](https://github.com/mickey-kras/hindsight-memory-router-integrations/releases) and verify its SHA-256 against `PACKAGE_SHA256` from the same release source. Packages are built by CI; tarballs are not kept in this repository.

| Client | Setup |
| --- | --- |
| OpenClaw | Install the OpenClaw release artifact, then configure the [`hindsight-memory-router` plugin](docs/OPENCLAW.md). |
| Codex, Claude Code, OpenCode and other coding agents | Install the coding-agents artifact and follow [coding-agent setup](integrations/coding-agents/README.md). |

## Quick start: coding agents

1. Create the principal's grants in Memory Router. Keep each harness's token in your secret manager.
2. Create an operator-managed JSON file using the [configuration example](integrations/coding-agents/README.md). Set its HTTPS router URL, principal, token environment variable and explicit project-to-bank mapping.
3. Replace the paths below with your config and downloaded artifact:

```sh
export HINDSIGHT_ROUTER_CONFIG=/absolute/path/router.json
npm install --global /absolute/path/downloaded-coding-agents.tgz
hindsight-coding-agents install
```

Export the principal's token from your secret manager when launching the harness.

For Codex, export `HINDSIGHT_ROUTER_CONFIG` before running the installer so it can allowlist the required environment variables. Unmapped projects, unknown harnesses and missing secrets fail closed. Do not overwrite this installation with upstream's `npx` installer.

## Documentation

- [OpenClaw configuration and queue storage](docs/OPENCLAW.md)
- [Coding-agent configuration](integrations/coding-agents/README.md)
- [Routing, failure handling and ingest identity](docs/BEHAVIOR.md)
- [All documentation](docs/README.md), including builds, upgrades and releases

[MIT license](LICENSE).

