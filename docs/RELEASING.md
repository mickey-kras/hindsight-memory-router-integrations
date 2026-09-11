# Releases

## Release

1. Merge the intended version changes into `main`.
2. Open **Actions → main → Run workflow**, select **main**, check **Create a pinned release branch and automatically release after checks**, and run.
3. Main checks, including Sonar, pass → automation creates `release/X.Y.Z` with frozen upstream inputs → release checks run without Sonar → artifacts publish → protected `vX.Y.Z` tag and immutable GitHub release → `latest` advances.

Checking the box authorizes publication after green gates. There is no second button.
Normal main runs never publish. Create release branches and tags only through this workflow.

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

Every preparation reserves its version, including failed attempts. Rerunning the same
preparation finds its branch. For a new attempt, bump the repository release version.
An upstream Hindsight upgrade does not dictate any component's version number.

## Tested inputs

Main resolves the latest stable Hindsight release to a concrete version, commit and
image digest. Router compatibility checks and smoke tests share that resolution.
Preparation resolves again and freezes the result in `compat/hindsight.json` and
`release.json`. Release runs never look up a newer upstream version.
Source-drift failures still require review; preparation does not accept new hashes.

Release the router first. Integrations preparation pins its latest immutable release,
including its commit and image digests, and requires the same Hindsight pin.
The integrations smoke gate runs packaged OpenClaw retain/recall and a packaged Codex
hook against that router and real Hindsight, with a deterministic test LLM.
On main and ordinary PRs, this gate builds router main at a resolved commit.

The integrations manifest records both package versions/checksums, the tested router,
upstream integration versions/commits, Hindsight, and the current `nix-openclaw` commit.
That flake reference is recorded for deployment; CI does not launch OpenClaw through Nix
or claim coverage of every coding harness. Use the manifest's exact versions/digests
for installation. Upstream bases remain in `UPSTREAM_VERSION` and the coding provenance files.

Router publishes the scanned image to Docker Hub and GHCR with version and commit tags,
signs/attests the digests, and attaches `image-digests.txt`. Integrations attaches its
committed tarballs, `PACKAGE_SHA256`, `PACKAGE_NIX_HASHES`, and provenance to GitHub.
There is no integrations Docker image or npm publication.
`latest` means the highest successfully released repository version; an older-line fix
cannot move it backwards. The compatibility combination is authoritative in the
integrations manifest, even when a newer router is available separately.

## One-time GitHub setup

1. Merge the reviewed PRs through existing gates. The integrations trusted-base policy
   guard may require an owner-reviewed bootstrap before it accepts the new workflow.
   Keep that guard enabled; do not fabricate statuses or bypass it with the release App.
2. Create a dedicated GitHub App, installed only on these repositories, with
   **Contents: read and write** and implicit Metadata read. No Administration permission.
3. In each repository, create environment **release-automation**, allowing branches
   `main` and `release/*`. Add environment secret `RELEASE_APP_PRIVATE_KEY` and repository
   variable `RELEASE_APP_ID`. Leave environment reviewers unset for automatic publication.
4. Generate import files:

   ```sh
   node .github/scripts/release-settings.cjs YOUR_NUMERIC_APP_ID /tmp/release-rulesets
   ```

5. In **Settings → Rules → Rulesets**, import **Release branch creation**, **Release tag
   creation**, and **Protect release branches**. Only the creation rules allow an App
   bypass. Branch protections have no bypass and require PRs, squash merges, resolved
   threads, existing scans/checks, and no force pushes/deletion. Allow initial creation
   before checks exist. Integrations also requires `quality / release combination`.
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

## Recovery

- **Checks failed:** create `fix/...` from the release branch, open a PR back to that
  branch, and squash merge after checks. Publication retries automatically. Keep all
  upstream pins and `.github/` unchanged. Forward-port code fixes separately to main.
- **Package fix:** bump only that package if needed, rebuild it, update checksums/Nix
  hashes and its `release.json` entry in the same fix PR. Preserve unchanged tarballs.
- **Different pins or automation needed:** prepare a new version from main.
- **Upload/signing failed:** use **Re-run failed jobs**. Router retains the tested image
  for 30 days and repeats smoke/scanning on retry. Existing tags and assets must match.
- **Different bytes needed after publication started, or retained image expired:** use
  a new version. Never replace a tag or asset. Avoid merging fixes during publication.
- **Only `latest` failed:** rerun the failed job; it verifies the release and retries promotion.
- **Released:** retain its branch/tag. Future work gets another version.

Publication across GitHub and two registries is not atomic; exact digest references
remain usable if a partial failure temporarily leaves aliases different.
