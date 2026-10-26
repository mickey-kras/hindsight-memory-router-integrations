# Releases

[Documentation](README.md) | [Repository](../README.md)

## Release

Complete [npm setup](#one-time-npm-setup) before the first release using npm publishing.

1. Merge the intended version changes into `main`.

2. Open **Actions > release > Run workflow**.

3. Select **main**.

4. Run the workflow.

The run validates main, including Sonar. It prepares a frozen candidate, then validates and publishes its packages.
It queues the next-version PR and removes the completed candidate branch.

The workflow accepts dispatch only from `main`. It checks this before credentials or release work begin.
There is no branch or version input or second publication run. Main pushes and PRs run
CI only. Candidate validation repeats all release gates, including the packaged
combination of router and Hindsight, without repeating main-only Sonar.

A release dispatch pauses Dependabot auto-merge. If main advances before preparation
freezes a candidate, dispatch again from current main. Native retries keep the
original candidate even if main later advances.

## Versions

| Item | Version source | Initial version |
| --- | --- | --- |
| Router image and Python package | `release-version.json` and `pyproject.toml`, kept equal | `0.1.0` |
| OpenClaw package | root `package.json` | `0.12.0` |
| Coding-agents package | `src/upstream/coding-agents/package.json` | `0.6.0` |
| Integrations release manifest | integrations `release-version.json` | `0.1.0` |

These versions advance independently. The integrations Git tag identifies its manifest.
It does not replace either package version. Matching numbers do not imply compatibility.
The initial integration versions move forward from the old `-router.N` versions.

Use plain `X.Y.Z`. Review version increases in a main PR. The button never guesses whether a change breaks compatibility. For versions below 1.0, increase minor for breaking changes and patch for compatible fixes.

After 1.0, use normal SemVer rules for major, minor and patch versions. Update package locks. Rebuild changed packages. Refresh checksums and Nix hashes.

You can reuse published package versions only with the same bytes.

Every preparation reserves its version while its branch or tag exists. Failed and
canceled runs retain their candidate for exact retries. Changes to code, automation,
or frozen pins need a reviewed main change and a new release version.
An upstream Hindsight upgrade does not dictate any part's version number.

## Tested inputs

Main resolves the latest stable Hindsight release to a concrete version, commit and
image digest. Router compatibility checks and smoke tests share that resolution. Preparation resolves again and freezes the result in `compat/hindsight.json` and
`release.json`. The release runs never look up a newer upstream version.

Source-drift failures still need review. Preparation does not accept new hashes.

Release the router first. Integrations preparation pins its latest immutable release,
including its commit and image digests, and needs the same Hindsight pin. The integrations smoke gate tests packaged OpenClaw retain and recall, a packaged Codex hook and the coding-agent package's MCP knowledge tools. It uses that router, real Hindsight and a deterministic test LLM.

On main and ordinary PRs, this gate builds router main at a resolved commit. For both built and released images, it verifies the running router's installed
`hindsight-memory-router` distribution against that checkout's `release-version.json`. The gate separately checks the liveness response for HTTP 200 and `status: alive`.

The integrations manifest records both package versions and checksums, the tested
router, upstream integration versions and commits, Hindsight, and the current
`nix-openclaw` commit.
The manifest records that flake reference for deployment. CI does not launch OpenClaw through Nix or cover every coding harness. Use the manifest's exact versions and digests
for installation. Upstream bases remain in `UPSTREAM_VERSION` and the coding provenance files.

Router publishes the scanned image to Docker Hub and GHCR with version and commit tags,
signs and attests the digests, and attaches `image-digests.txt`. Integrations builds its
tarballs from the release commit, verifies them against `PACKAGE_SHA256`, and
attaches the tarballs, `PACKAGE_SHA256`, and `PACKAGE_NIX_HASHES` to GitHub. Package attestations retain the authenticated workflow's main ref and SHA and record
the validated candidate ref and SHA as another source dependency. The publisher sends the same verified archives to public npm with OIDC and npm provenance.

This precedes next-version preparation and candidate cleanup. There is no integrations Docker image. The publisher accepts an existing npm version with the same bytes only when its SHA-512 integrity and provenance metadata match. Mismatches fail.

Older package releases use a
`release-X.Y.Z` npm tag without moving `latest` backwards.
`latest` means the highest successfully released repository version. An older-line fix cannot move it backwards. The compatibility combination is authoritative in the
integrations manifest, even when a newer router is available separately.

## Tag trust basis

After every gate passes, the Release App creates annotated tag objects for release tags `vX.Y.Z` through the GitHub API. These tags do not have GPG signatures. The repository has no signing key, and the automation adds none.
Tag trust depends on these controls:

- Tag rulesets restrict `v*` creation to the Release App. They block updates, deletion and force pushes.
  A tag thus always names the commit that passed the gates.
- The GitHub release is immutable. It records exact package checksums in `release.json`.
- CI builds the attached tarballs from the tagged commit. `PACKAGE_SHA256` pins their bytes.
  They have Sigstore build-provenance attestations that you can check through the public Rekor log.

## One-time GitHub setup

1. Merge the reviewed PRs through existing gates. The policy guard for integrations uses a trusted base. It can need an owner-reviewed bootstrap before it accepts the new workflow.

   Keep that guard enabled. Do not create false statuses or bypass it with the release App.

2. Create a dedicated GitHub App with **Contents: read and write**, **Pull requests: read and write**, and implicit Metadata read. Install it only on these repositories.

   Do not grant Administration permission. Approve changed installation permissions before releasing.

3. In each repository, create environment **release-automation**, allowing branches
   `main` and `release/*`. Add environment secret `RELEASE_APP_PRIVATE_KEY` and repository
   variable `RELEASE_APP_ID`.

   Leave environment reviewers unset for automatic publication.

4. Generate import files:

   ```sh
   node .github/scripts/release-settings.cjs YOUR_NUMERIC_APP_ID /tmp/release-rulesets
   ```

5. In **Settings > Rules > Rulesets**, import **Release branch creation**, **Release tag creation**, the deletion-only **Release branch deletion**, and **Protect release branches**. Only the creation rules and the deletion rule allow an App bypass. Branch protections have no bypass and need PRs, squash merges, resolved
   threads, existing scans and checks, and no force pushes.

   Allow initial creation
   before checks exist. Integrations also needs `quality / release combination`. Before you use this runbook, confirm each imported template rule in Settings.

6. Keep **Protect release tags** active: block updates, deletion and force pushes,
   with **no bypass**, including the App.

   Compare it with the generated template. Keep **Enforce release tag names**. Make sure it accepts plain `vX.Y.Z`.

7. Once those rules are active, exclude `refs/heads/release/*` from **Enforce work branch names**.

   Preserve main's protections. Preflight checks these rules. GitHub can redact bypass lists. Review the actors in Settings.

   Do not grant App admin access for this check.

8. Enable **immutable releases** in both repositories. This setting needs an admin check. API preflight alone does not prove that you enabled it.

9. Router: confirm `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` and Actions access to GHCR. Where the registry supports immutability for version and SHA tags, configure it. Leave `latest` mutable. Git tag protection does not protect registry tags.

10. Run main normally.

11. Release the router.

12. Release the integrations.

13. Check the published manifest.

14. Check that both registries' `latest` aliases resolve to the router release digest.

## One-time npm setup

Complete these steps for both `@mickey-kras/hindsight-memory-router-openclaw`
and `@mickey-kras/hindsight-memory-router-coding-agents` before dispatching release:

1. Create each package on npm before configuring its trusted publisher. Download
   its tarball from an older verified GitHub release and check `PACKAGE_SHA256`. The bootstrap version must be older than the first automated package version.

   Do not use the planned automated version for bootstrap.

2. As the npm owner, publish those exact archives locally:

   ```sh
   npm login --registry=https://registry.npmjs.org
   npm publish /absolute/path/verified-openclaw.tgz --registry=https://registry.npmjs.org --access=public --ignore-scripts --tag=bootstrap
   npm publish /absolute/path/verified-coding-agents.tgz --registry=https://registry.npmjs.org --access=public --ignore-scripts --tag=bootstrap
   npm logout --registry=https://registry.npmjs.org
   ```

   Local publication does not generate npm provenance. The automated publisher
   rejects existing versions without it, even when their bytes match. Use newer package versions for the first automated release. Update locks and hash pins.

   Revoke any temporary bootstrap token. Remove the local configuration for that token.

3. In each npm package's **Settings > Trusted publishing**, add GitHub Actions:

   | Field | Value |
   | --- | --- |
   | Organization or user | `mickey-kras` |
   | Repository | `hindsight-memory-router-integrations` |
   | Workflow filename | `release.yml` |
   | Environment | `release-automation` |
   | Allowed action | `npm publish` |

   npm validates the calling workflow (`release.yml`), not reusable `main.yml`. Both grant `id-token: write`. The publishing job uses `release-automation`. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

4. Run the release with the newer package versions.

   Complete its first OIDC publish within two days of creating the trusted publisher.
   Recreate expired configurations. GitHub stores no npm token.

5. Check that both exact versions install from npm.

   Check that their registry integrity matches the GitHub tarballs. Check that npm displays provenance.
   Then change installation docs from GitHub tarballs to pinned npm versions.

For OpenClaw, use
   `openclaw plugins install npm:@mickey-kras/hindsight-memory-router-openclaw@<package-version>`. The [current CLI](https://docs.openclaw.ai/cli/plugins/install) defaults
   unprefixed package specs to ClawHub.

## Recovery

- **Checks, upload, attestation, or follow-up failed:** use **Re-run failed jobs** on the original release run. The run keeps the frozen candidate and tested tarballs for 30 days. Existing tags and release assets must match the original bytes.
- **npm visibility delay:** after npm accepts each package, the publisher checks its metadata for up to 20 minutes. Checks start 10 seconds apart and increase to a maximum of 60 seconds. Temporary registry failures do not stop these checks. Integrity or provenance mismatches stop publication.
- **npm publication failed:** the GitHub release can already be public. Rerun failed jobs on the original run.

  The publisher verifies and skips npm versions with the same bytes. It publishes missing versions. Candidate cleanup and next-version preparation wait for both packages. Never replace an existing mismatched version.
- **Canceled:** use **Re-run all jobs** on that run.

  Cancellation does not delete the candidate or open failure issues.
- **Missing preparation response:** rerun the original run. It finds the candidate by its manifest and resumes without reserving another version or refreshing pins.
- **Repeated dispatch, including after main advances:** automation checks the retained candidate and its original run. It requests a native retry or links to an active or successful run. The original run keeps its source snapshot and package artifacts. The new dispatch does not publish the candidate.
- **Candidate branch already removed:** a retry verifies the immutable annotated tag and release. It then resumes follow-up at the same commit.
- **Code, pins, package bytes, or automation need changes:** merge the fix to main and prepare a new repository version.

  If earlier published package bytes change, increase the package version. Refresh its checksums and Nix hashes. The workflow rejects candidate branch edits.
- **Retained tarballs expired or publication bytes are missing:** use a new version. The workflow never replaces tags or published assets.
- **Released:** automation queues a squash-only next-version PR that changes only `release-version.json`.

  Required PR checks still apply. Only after this succeeds does it delete the completed candidate and prune older immutable releases' matching branches. A failed follow-up fails the run and remains retryable.

If a run fails before any job starts, fix the startup cause. Then rerun it.
Failed candidates, draft releases and content-addressed attestations are resumable state.
The release automation does not delete them on failure or cancellation.

Preparation retains verified tarballs only after the candidate SHA exists. Publication restores the immutable artifact ID from the same release run and main snapshot. It rejects expired or ambiguous artifacts. Before the existing release preflight and attestations, it verifies candidate package inventory and SHA-256 pins.

A preparation rerun reuses the retained artifact. It never overwrites it. Full candidate checks still run.

Sonar restores coverage by the artifact ID returned by successful quality checks in the same workflow run. It installs both packages' locked dependencies on its own runner for TypeScript analysis without rebuilding packages or rerunning tests. Before scanning, source SHA, run ID and report digest must match. The Sonar quality gate remains required. Failed checks do not publish coverage.



CI dependency and policy changes follow [CI policy and independent review](CI_POLICY.md). Lockfiles use semantic validation. Do not bootstrap dependency updates with more hash admissions.

