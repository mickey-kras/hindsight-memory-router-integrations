# Build and verify

[Documentation](README.md) | [Repository](../README.md)

Requires Node.js 22.12.0 or later. From the repository root:

```sh
npm ci
npm ci --prefix src/upstream/coding-agents
npm run test:coverage
npm test --prefix src/upstream/coding-agents
npm audit --audit-level=moderate
npm audit --prefix src/upstream/coding-agents --audit-level=moderate
node scripts/verify-coding-upstream.mjs
python3 -m unittest discover -s scripts -p test_sync_upstream.py
```

Every root Vitest invocation clean-builds both packages once before starting test workers, including targeted standalone tests. Existing `dist` directories never skip the build. CI reuses only the output of that successful test invocation for package verification; the test and upstream TypeScript checks remain separate.

## Test families and CI selection

`npm test` selects only the root Vitest suite. Python, `node:test`, coding-agent tests and packaged-runtime checks have separate commands. Run commands below from the repository root after the two `npm ci` commands above. CI uses Node.js 22.23.3 and npm 11.19.1 for tooling; the packed minimum-runtime check separately uses exactly Node.js 22.12.0.

| Family | Command | Selection and boundary |
| --- | --- | --- |
| Root unit, integration and contract tests | `npm test` or `npm run test:coverage` | [Root Vitest config](../vitest.config.ts) selects `tests/**/*.test.ts`. CI runs the coverage variant, including the root focused subsets below. |
| Composed production clients | `npm test -- tests/shared-client.test.ts tests/router-security.test.ts tests/hosted-client.test.ts tests/http-response-lifetime.test.ts` | Production client, credential, bank-guard and transport composition with synthetic HTTP responses; distinct from live service integration. |
| Environment and dependency contracts | `npm test -- tests/authenticated-client-factory.test.ts` | Factory unit tests plus real loopback HTTP probes of Node fetch redirect behavior and the published Hindsight client's Bearer/agent headers. |
| Native process ownership | `npm test -- tests/retain-queue-locking.test.ts` | Child processes exercise native lock contention, suspended owners, killed owners and rewrite recovery. Skipped on Windows; Linux CI runs the real 11-second suspension beyond the former stale lease. |
| Queue state, recovery and retry policy | `npm test -- tests/retain-coordinator.test.ts tests/retain-quarantine.test.ts tests/retain-queue-storage.test.ts tests/retain-queue-state.test.ts tests/retain-queue-recovery.test.ts tests/retain-queue-security.test.ts` | Mocked failure/retry classification and on-disk queue invariants complement process ownership checks. |
| Root coding-agent integration and package exports | `npm test -- tests/coding-agents-upstream.test.ts tests/coding-agents-prefix.test.ts tests/package-exports.test.ts` | Managed integration, naming and built package entry points. `npm run test:coding-agents` selects only `coding-agents-upstream.test.ts`, not the vendored suite. |
| Maintained coding-agent regressions | `npm test --prefix src/upstream/coding-agents` | The [coding-agent Vitest allowlist](../src/upstream/coding-agents/vitest.config.ts) selects runtime/lifecycle, first-turn hook, session-cache, status/seed, chat, retain cursor/stamp, usage/daemon, router, installer/branding, private state, turn journal/policy, transcript, mission, UUID/JSONL and harness regressions. Committed upstream tests outside this allowlist are not CI-selected. |

The loopback probes are real environment/dependency contracts, but they do not prove the production router's redirect policy: production requests use `RouterTransport` with `redirect: "error"`. The default `AuthenticatedClientFactory` composes that transport rather than constructing the published Hindsight client. The published client remains a direct production declaration dependency and an SDK compatibility boundary. Keep these probes separate from composed-client tests and from mocked retry classification; each observes a different boundary.

### Typechecking and coverage

`npm run typecheck` checks root source, [root tests](../tsconfig.test.json) and [integration tests](../tsconfig.integration.json). The integration config covers both root coding-agent integration files plus the maintained runtime, hook and session-cache tests using compatible module resolution. CI checks those two test configs explicitly, uses the root clean build for source typechecking, and separately runs:

```sh
npm exec --prefix src/upstream/coding-agents -- tsc --noEmit -p src/upstream/coding-agents/tsconfig.json
```

Root coverage includes `src/**/*.ts`, including maintained OpenClaw queue and session-pattern modules in `src/upstream/src`. Coverage excludes Vitest's default exclusions and `src/upstream/coding-agents/**`; selecting coding-agent tests does not add them to the root coverage gate. Lines, statements, functions and branches each retain a 90% threshold. The Sonar job consumes the successful CI coverage artifact after verifying its commit and content provenance; it does not rerun Vitest.

### Python and node:test automation tests

These run separately from Vitest. Install release-tool dependencies with `npm ci --prefix .github/scripts --ignore-scripts --no-audit --no-fund` before the automation tests. The Sonar Python suites use only the standard library. The release-policy and trusted scanner boundary suites additionally require Python 3 with PyYAML; install it in your active Python virtual environment with `python3 -m pip install PyYAML` before running those suites.

| Family | Command | CI workflow |
| --- | --- | --- |
| Sonar finding rendering and tracker behavior | `python3 -m unittest tests/test_sonar_finding_sync.py` | [trusted-ci.yml](../.github/workflows/trusted-ci.yml) |
| Sonar privacy, redaction, authenticated redirects and masking order | `python3 -m unittest discover -s tests -p test_sonar_privacy.py` | [trusted-ci.yml](../.github/workflows/trusted-ci.yml) |
| Release policy | `python3 .github/scripts/release-policy.test.py` | [trusted-ci.yml](../.github/workflows/trusted-ci.yml) |
| Vendored-file verification | `node --test scripts/verify-vendored-files.test.mjs` | [trusted-ci.yml](../.github/workflows/trusted-ci.yml) |
| Release, combination resolution, cleanup and coverage provenance | `node --test .github/scripts/release.test.cjs .github/scripts/combination.test.cjs .github/scripts/release-cleanup.test.cjs .github/scripts/coverage-artifact.test.cjs` | [trusted-ci.yml](../.github/workflows/trusted-ci.yml) |
| PR branch updater | `node --test .github/scripts/pr-branch-updater.test.cjs` | [trusted-ci.yml](../.github/workflows/trusted-ci.yml) |
| npm audit tooling | `node --test .github/scripts/npm-audit.test.cjs` | [trusted-ci.yml](../.github/workflows/trusted-ci.yml) |
| Trusted scanner boundaries | `node --test .github/trusted-ci/*.test.cjs` | [trusted-ci.yml](../.github/workflows/trusted-ci.yml) |
| Dependabot merge policy | `node --test .github/scripts/dependabot-auto-merge.test.cjs` | `dependabot-policy-tests.yml` |
| Dependabot preparation | `node --test .github/scripts/dependabot-preparation.test.cjs` | `dependabot-policy-tests.yml` |

Run the trusted scanner glob in a Unix-like environment with symlink support. It skips two Gitleaks binary cases unless `GITLEAKS_BINARY` points to the verified pinned Gitleaks 8.24.3 executable. Those cases also require Git and Bash. The security job downloads and verifies the pinned binary before explicitly running `gitleaks.test.cjs` with `GITLEAKS_BINARY` set.

Finding-body rendering assertions live in the finding-sync suite: all three finding kinds retain diagnostic fields and public commit/workflow links without Sonar links, including configured and absent server cases. The privacy suite separately exercises final create/edit redaction of configured and advertised endpoints, authenticated redirect rejection, mask escaping, endpoint discovery failures and workflow masking order.

### Packed artifacts and service integration

These require prepared artifacts or services in addition to installed dependencies:

| Check | Command | Prerequisites and CI boundary |
| --- | --- | --- |
| Packed coding-agent installation | `node --test .github/scripts/coding-installer-smoke.mjs` | Coding-agent package built and packed into `packages/`, with matching `PACKAGE_SHA256`; tests installation from a verified local tarball and loopback URL. Runs in [trusted-ci.yml](../.github/workflows/trusted-ci.yml) after package verification. |
| Minimum supported runtime and consumer types | `node scripts/verify-runtime-contract.mjs` | Run with exactly Node.js 22.12.0 and a freshly packed OpenClaw tarball. Installs into an isolated consumer and checks CommonJS/ESM exports, hosted entry point and production declaration dependencies. Requires npm registry access. |
| Packaged clients with router and Hindsight | `bash .github/scripts/combination-smoke.sh` | The `release combination` job in [trusted-ci.yml](../.github/workflows/trusted-ci.yml) prepares pinned packages, checks out the matching router harness in `.router`, and sets the resolved image/version and runner environment. Requires Docker Compose, OpenSSL and image/registry access; see [release verification](RELEASING.md). This is the live service boundary, separate from synthetic client tests and `combination.test.cjs`. |

CI also verifies provenance with `node scripts/verify-coding-upstream.mjs` and `node scripts/verify-openclaw-overlay.mjs`, checks package inventory with `node .github/scripts/verify-package-inventory.cjs`, byte-compares repeat packs, and checks SHA-256/Nix pins. The [trusted CI workflow](../.github/workflows/trusted-ci.yml) implements artifact preparation and security gates. [main.yml](../.github/workflows/main.yml) and [pr-validation.yml](../.github/workflows/pr-validation.yml) call it at a pinned commit; [ci.yml](../.github/workflows/ci.yml) is a pinned reusable-workflow wrapper. The [Dependabot workflow](../.github/workflows/dependabot-policy-tests.yml) also probes pinned upstream metadata with a repository token.

Packages are built from source by CI (`npm pack`) and attached to the GitHub release; their SHA-256 hashes are pinned in `PACKAGE_SHA256` and Nix hashes in `PACKAGE_NIX_HASHES`. Tarballs are never committed (`packages/` is gitignored).
OpenClaw provenance: `UPSTREAM_VERSION`; coding-agents provenance: `integrations/coding-agents/UPSTREAM.json`.
Local revisions are independent of upstream versions. Upgrade either integration separately.
Dependabot preparation increments the patch version of each package whose dependency files change and regenerates its shrinkwrap, provenance, and package hash pins before the existing PR checks run.



Coding-agent provenance and deviations live in [`UPSTREAM.json`](../integrations/coding-agents/UPSTREAM.json), [`LOCAL_CHANGES.json`](../integrations/coding-agents/LOCAL_CHANGES.json), [`router.patch`](../integrations/coding-agents/router.patch) and [vendored deviations](../src/upstream/coding-agents/DEVIATIONS.md). After intentional vendored edits, run `npm run upstream:accept`; CI rejects unrecorded drift. Vendored dependencies move with upstream's tested lockfile during re-vendoring and are excluded from Dependabot.

See [upstream upgrades](UPGRADING.md), [deviations](DEVIATIONS.md), [dependency updates](dependabot.md) and [releasing](RELEASING.md).

## Dependency inventory

| Package | Direct runtime declarations | Development declarations |
| --- | --- | --- |
| OpenClaw | `@vectorize-io/hindsight-agent-sdk`, `@vectorize-io/hindsight-client`, `fs-native-extensions` | `@biomejs/biome`, `@types/node`, `@vitest/coverage-v8`, `aislop`, `typescript`, `vitest` |
| Coding agents | `@modelcontextprotocol/sdk`, `@napi-rs/keyring`, `jsonc-parser`, `smol-toml`, `zod` | `@opencode-ai/plugin`, `@opencode-ai/sdk`, `@opencode/plugin`, `@types/node`, `tsup`, `typescript`, `vitest` |

OpenClaw declares `@vectorize-io/hindsight-client@1.0.0` as a direct production dependency because its exported TypeScript declarations import client types. The repository also overrides the SDK's transitive client to `1.0.0`. Coding-agent overrides cover `@opencode/plugin > @opentelemetry/core`, `esbuild`, `fast-uri`, `hono`, `http-cache-semantics`, `ip-address`, `postcss` and `vite`; their ranges are listed in [vendored deviations](../src/upstream/coding-agents/DEVIATIONS.md). Bundled JavaScript and platform-native secure-storage dependencies have different packaging requirements. Consult the manifests and shrinkwraps for current declared ranges and resolved transitive/platform packages.
