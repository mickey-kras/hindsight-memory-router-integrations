# Releases

[Documentation](README.md) | [Repository](../README.md)

## Release

Complete [npm setup](#one-time-npm-setup) before the first release using npm publishing.

1. Merge the intended version changes into `main`.
2. Open **Actions > release > Run workflow**, select **main**, and run.
3. The same run validates main (including Sonar), prepares a frozen candidate, validates and publishes its packages, queues the next-version PR, and removes the completed candidate branch.

Dispatch is accepted only from `main`, before credentials or release work begin.
There is no branch/version input or second publication run. Main pushes and PRs run
CI only. Candidate validation repeats all release gates, including the packaged
router/Hindsight combination, without repeating main-only Sonar.

Release dispatch pauses Dependabot auto-merge. If main advances before preparation
freezes a candidate, dispatch again from current main. Native retries keep the
original candidate even if main subsequently advances.

## Versions

| Item | Version source | Initial version |
| --- | --- | --- |
| Router image and Python package | `release-version.json` and `pyproject.toml`, kept equal | `0.1.0` |
| OpenClaw package | root `package.json` | `0.12.0` |
| Coding-agents package | `src/upstream/coding-agents/package.json` | `0.6.0` |
| Integrations release manifest | integrations `release-version.json` | `0.1.0` |

These versions advance independently. The integrations Git tag identifies its manifest;
it does not replace either package version. Matching numbers do not imply compatibility.
The initial integration versions move forward from the old `-router.N` versions.

Use plain `X.Y.Z`. Review version bumps in a main PR; the button never guesses whether
a change is breaking. While below 1.0, bump minor for breaking changes and patch for
compatible fixes; after 1.0, use normal SemVer major/minor/patch rules.
Update package locks, rebuild changed packages, and refresh checksums/Nix hashes.
Already-published package versions can be reused only with identical bytes.

Every preparation reserves its version while its branch or tag exists. Failed and
cancelled runs retain their candidate for exact retries. Changes to code, automation,
or frozen pins require a reviewed main change and a new release version.
An upstream Hindsight upgrade does not dictate any component's version number.

## Tested inputs

Main resolves the latest stable Hindsight release to a concrete version, commit and
image digest. Router compatibility checks and smoke tests share that resolution.
Preparation resolves again and freezes the result in `compat/hindsight.json` and
`release.json`. Release runs never look up a newer upstream version.
Source-drift failures still require review; preparation does not accept new hashes.

Release the router first. Integrations preparation pins its latest immutable release,
including its commit and image digests, and requires the same Hindsight pin.
The integrations smoke gate runs packaged OpenClaw retain/recall, a packaged Codex
hook and the coding-agent package's MCP knowledge tools against that router and real Hindsight,
with a deterministic test LLM.
On main and ordinary PRs, this gate builds router main at a resolved commit.
For both built and released images, it verifies the running router's installed
`hindsight-memory-router` distribution against that checkout's `release-version.json`.
The liveness response is checked separately for HTTP 200 and `status: alive`.

The integrations manifest records both package versions/checksums, the tested
router, upstream integration versions/commits, Hindsight, and the current
`nix-openclaw` commit.
That flake reference is recorded for deployment; CI does not launch OpenClaw through Nix
or claim coverage of every coding harness. Use the manifest's exact versions/digests
for installation. Upstream bases remain in `UPSTREAM_VERSION` and the coding provenance files.

Router publishes the scanned image to Docker Hub and GHCR with version and commit tags,
signs/attests the digests, and attaches `image-digests.txt`. Integrations builds its
tarballs from the release commit, verifies them against `PACKAGE_SHA256`, and
attaches the tarballs, `PACKAGE_SHA256`, and `PACKAGE_NIX_HASHES` to GitHub.
Package attestations retain the authenticated workflow's main ref/SHA and record
the validated candidate ref/SHA as an additional source dependency.
The same verified archives are published to public npm with OIDC and npm provenance
before next-version preparation and candidate cleanup. There is no integrations Docker image.
An identical existing npm version is accepted only when its SHA-512 integrity and
provenance metadata match; mismatches fail. Older package releases use a
`release-X.Y.Z` npm tag without moving `latest` backwards.
`latest` means the highest successfully released repository version; an older-line fix
cannot move it backwards. The compatibility combination is authoritative in the
integrations manifest, even when a newer router is available separately.

## Tag trust basis

Release tags `vX.Y.Z` are annotated tag objects created by the Release App through
the GitHub API only after every gate passes. They are not GPG-signed: no signing
key is provisioned for this repository, and the automation adds none. The trust
basis instead:

- tag rulesets restrict `v*` creation to the Release App and block updates,
  deletion and force pushes, so a tag always names the commit the gates ran on;
- the GitHub release is immutable and records exact package checksums in
  `release.json`;
- the attached tarballs are CI-built from the tagged commit, byte-pinned by
  `PACKAGE_SHA256`, and carry Sigstore build-provenance attestations verifiable
  through the public Rekor log.

## One-time GitHub setup

1. Merge the reviewed PRs through existing gates. The integrations trusted-base policy
   guard may require an owner-reviewed bootstrap before it accepts the new workflow.
   Keep that guard enabled; do not fabricate statuses or bypass it with the release App.
2. Create a dedicated GitHub App, installed only on these repositories, with
   **Contents: read and write**, **Pull requests: read and write**, and implicit Metadata read.
   No Administration permission. Approve changed installation permissions before releasing.
3. In each repository, create environment **release-automation**, allowing branches
   `main` and `release/*`. Add environment secret `RELEASE_APP_PRIVATE_KEY` and repository
   variable `RELEASE_APP_ID`. Leave environment reviewers unset for automatic publication.
4. Generate import files:

   ```sh
   node .github/scripts/release-settings.cjs YOUR_NUMERIC_APP_ID /tmp/release-rulesets
   ```

5. In **Settings > Rules > Rulesets**, import **Release branch creation**, **Release tag
   creation**, the deletion-only **Release branch deletion**, and **Protect release
   branches**. Only the creation rules and the deletion rule allow an App bypass.
   Branch protections have no bypass and require PRs, squash merges, resolved
   threads, existing scans/checks, and no force pushes. Allow initial creation
   before checks exist. Integrations also requires `quality / release combination`.
   Confirm every rule in the templates actually imported in Settings before relying on this runbook.
6. Keep **Protect release tags** active: block updates, deletion and force pushes,
   with **no bypass**, including the App. Compare it with the generated template.
   Keep **Enforce release tag names**; ensure it accepts plain `vX.Y.Z`.
7. Once those rules are active, exclude `refs/heads/release/*` from **Enforce work branch
   names**. Preserve main's protections. Preflight checks these rules; GitHub may redact
   bypass lists, so review the actors in Settings rather than granting App admin access.
8. Enable **immutable releases** in both repositories. This setting requires an admin
   check; API preflight alone does not prove it is enabled.
9. Router: confirm `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` and Actions access to GHCR.
   Configure registry version/SHA immutability where supported, leaving `latest` mutable.
   Git tag protection does not protect registry tags.
10. Run main normally, release router, then release integrations. Verify the published
    manifest and that both registries' `latest` aliases resolve to the router release digest.

## One-time npm setup

Complete these steps for both `@mickey-kras/hindsight-memory-router-openclaw`
and `@mickey-kras/hindsight-memory-router-coding-agents` before dispatching release:

1. Create each package on npm before configuring its trusted publisher. Download
   its tarball from an older verified GitHub release and check `PACKAGE_SHA256`.
   The bootstrap version must be older than the first automated package version;
   do not consume the planned automated version.
2. As the npm owner, publish those exact archives locally:

   ```sh
   npm login --registry=https://registry.npmjs.org
   npm publish /absolute/path/verified-openclaw.tgz --registry=https://registry.npmjs.org --access=public --ignore-scripts --tag=bootstrap
   npm publish /absolute/path/verified-coding-agents.tgz --registry=https://registry.npmjs.org --access=public --ignore-scripts --tag=bootstrap
   npm logout --registry=https://registry.npmjs.org
   ```

   Local publication does not generate npm provenance. The automated publisher
   rejects existing versions without it, even when their bytes match. Use newer
   package versions for the first automated release; update locks and hash pins.
   Revoke any temporary token used for bootstrap and remove its local configuration.
3. In each npm package's **Settings > Trusted publishing**, add GitHub Actions:

   | Field | Value |
   | --- | --- |
   | Organization or user | `mickey-kras` |
   | Repository | `hindsight-memory-router-integrations` |
   | Workflow filename | `release.yml` |
   | Environment | `release-automation` |
   | Allowed action | `npm publish` |

   npm validates the calling workflow (`release.yml`), not reusable `main.yml`.
   Both grant `id-token: write`; the publishing job uses `release-automation`.
   See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
4. Run the release with the newer package versions. Complete its first OIDC publish
   within two days of creating the trusted publisher; recreate expired configurations.
   No npm token is stored in GitHub.
5. Verify both exact versions install from npm, their registry integrity matches
   the GitHub tarballs, and npm displays provenance. Then switch installation docs
   from GitHub tarballs to pinned npm versions. For OpenClaw, use
   `openclaw plugins install npm:@mickey-kras/hindsight-memory-router-openclaw@<package-version>`;
   the [current CLI](https://docs.openclaw.ai/cli/plugins/install) defaults
   unprefixed package specs to ClawHub.

## Recovery

- **Checks, upload, attestation, or follow-up failed:** use **Re-run failed jobs** on the original release run. The frozen candidate and tested tarballs are retained for 30 days. Existing tags and release assets must match the original bytes.
- **npm publication failed:** the GitHub release may already be public. Rerun failed jobs on the original run; identical npm versions are verified and skipped, missing versions are published. Candidate cleanup and next-version preparation wait for both packages. Never replace an existing mismatched version.
- **Cancelled:** use **Re-run all jobs** on that run. Cancellation does not delete the candidate or open failure issues.
- **Preparation response was lost:** rerun the original run. It finds the candidate by its manifest and resumes without reserving another version or refreshing pins.
- **Repeated dispatch from the same main snapshot:** automation requests a native retry of the original failed run or links to an active/successful run. It does not create a second publisher.
- **Candidate branch already removed:** a retry verifies the immutable annotated tag and release, then resumes follow-up at the same commit.
- **Code, pins, package bytes, or automation need changes:** merge the fix to main and prepare a new repository version. Bump a package version if its previously published bytes change; refresh its checksums and Nix hashes. Candidate branch edits are rejected.
- **Retained tarballs expired or publication bytes are missing:** use a new version. Tags and published assets are never replaced.
- **Released:** automation queues a squash-only next-version PR that changes only `release-version.json`. Required PR checks still apply. Only after this succeeds does it delete the completed candidate and prune older immutable releases' matching branches. A failed follow-up fails the run and remains retryable.

If a run fails before any job starts, fix the startup cause and rerun it. Failed
candidates, draft releases, and content-addressed attestations are resumable state;
release automation does not delete them on failure or cancellation.

Preparation retains verified tarballs only after the candidate SHA exists. Publication restores the immutable artifact ID from the same release run and main snapshot, rejects expired or ambiguous artifacts, then verifies the candidate package inventory and SHA-256 pins before the existing release preflight and attestations. Rerunning preparation reuses the retained artifact; it never overwrites it. Full candidate checks still run.

Sonar restores coverage by the artifact ID returned by successful quality checks in the same workflow run. It installs both packages' locked dependencies on its own runner for TypeScript analysis without rebuilding packages or rerunning tests. Source SHA, run ID and report digest must match before scanning; the Sonar quality gate remains required. Failed checks do not publish coverage.


CI dependency and policy changes follow [CI policy and independent review](CI_POLICY.md). Lockfiles use semantic validation; do not bootstrap dependency updates by appending hash admissions.
