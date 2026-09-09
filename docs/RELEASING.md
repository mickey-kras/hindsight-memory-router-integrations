# Releases

Use **Actions → main → Run workflow**, select **main**, and enable
**Create a pinned release branch and automatically release after checks**.
This is the release intent: after main validation succeeds, preparation creates
the branch and its release run publishes automatically if all gates pass.
Leaving the checkbox off runs main validation without publishing a release.

## Version policy

| Item | Format | Example |
| --- | --- | --- |
| Release branch, one per release attempt | `release/<Hindsight version>-router.<revision>` | `release/0.9.2-router.1` |
| Immutable Git tag | `v<Hindsight version>-router.<revision>` | `v0.9.2-router.1` |
| Router container version | `<Hindsight version>-router.<revision>` | `0.9.2-router.1` |
| Router Python metadata (PEP 440) | `<Hindsight version>+router.<revision>` | `0.9.2+router.1` |
| Integration package | `<component upstream version>-router.<revision>` | `0.11.1-router.4` |

The shared concept is upstream base plus a downstream revision. The integrations
repository release identifies a Hindsight compatibility bundle; its individual
packages retain their own upstream bases and independent revisions. Do not change
an OpenClaw package's base version to a Hindsight server version. Existing package
versions are not bumped just because a bundle is released.

`-router.N` is a SemVer prerelease identifier. We retain it for continuity and
readability, use exact dependency versions, and explicitly publish the GitHub
release as stable. Do not rely on generic SemVer ranges to select these builds.
Python uses the equivalent local-version syntax because the hyphen form is not
valid PEP 440 metadata.

Preparation allocates the next revision from both tags and release branches.
Failed attempts reserve their revision; it is never reused. A rerun of the same
preparation run finds its existing branch instead of creating another one.

## Inputs and gates

On main, `compat/hindsight.json` selects the latest **stable server release**.
Router CI resolves it once per run to a version, peeled upstream Git commit, and
versioned container digest. The compatibility source checkout and real smoke
containers consume that same resolution. A resolution or image lookup failure
fails CI; there is no fallback to upstream main or a floating container tag.

At branch creation, preparation resolves the latest stable release again and
commits `release.json` and frozen `compat/hindsight.json` together. Release CI uses
those committed pins even if a newer upstream release appears. The compatibility
inventory remains a review gate: preparation does not silently accept new source
hashes. Source-drift failures require compatibility review and a fix PR.

The App's branch push triggers `release.yml`, which calls the unified workflow at
that commit. Release runs retain quality, coverage, Aislop, CodeQL, dependency and
security scans, and the repository's build/package checks. Router releases also
retain architecture validation, default Compose smoke, fake and real Hindsight
smoke with SQLite and PostgreSQL, and the image vulnerability gate. Sonar runs
only on main. Main never logs in to the image registries or pushes images.

The integrations release attaches its already-tested, committed package tarballs,
checksums, Nix hashes, and provenance. Its manifest also records the current
`openclaw/nix-openclaw` commit, whose lock file identifies its OpenClaw input.
This is an environment reference, not a claim that the package tests launch
OpenClaw or run a Nix integration smoke test. Keep the existing package and Nix
hash checks; do not substitute a standalone OpenClaw release for that flake.

Router publication pushes the **same image that passed smoke tests and scanning**
to Docker Hub and GHCR under the version and full commit SHA. It signs and attests
the published digests, then creates the Git tag, uploads release metadata to a
draft, and publishes the immutable GitHub release. Finally it advances both
registries' `latest` aliases. Both versioned images must have the same digest.
Older compatibility-line fixes cannot move `latest` backwards; prereleases and
failed/draft releases cannot claim it. Release publication is serialized per repo.

The integrations repository ships packages, not a Docker image. Its release
assets and GitHub Latest marker follow the same finalization policy; this workflow
does not introduce a container or publish packages to npm.

## One-time setup before the first release

1. Merge the reviewed automation PR through the repository's existing gates.
   Do not run preparation from a work branch. See the policy transition note below.
2. Create a dedicated **GitHub App** installed only on these two repositories.
   Give it repository **Contents: read and write**, plus the automatically granted
   Metadata read permission. It needs no administration or workflow-write access.
   Do not substitute a personal access token or grant a human creation bypass.
3. In each repository, create an environment named `release-automation`, allowed
   only on selected branches `main` and `release/*`. Store the private key as
   environment secret `RELEASE_APP_PRIVATE_KEY`; set repository variable
   `RELEASE_APP_ID` to the numeric App ID. Keep this key exclusive to release
   automation. An environment reviewer would add an approval pause; leave that
   unset for the requested automatic publication after green gates.
4. Generate the ruleset import files locally (this command only writes JSON):

   ```sh
   node .github/scripts/release-settings.cjs YOUR_NUMERIC_APP_ID /tmp/release-rulesets
   ```

   Import the two **creation** rulesets and **Protect release branches** in
   Settings → Rules → Rulesets. Creation rules allow only the release App to
   bypass; branch protection has **no bypass actors**. It requires PRs, squash
   merges, resolved review threads, the existing required checks and scanning
   policies, blocks force pushes and deletion, and allows initial creation before
   checks exist. The template mirrors the reviewed main protections; preserve
   main's existing ruleset unchanged.
5. Compare the generated **Protect release tags** with the existing ruleset of
   that name and update that existing rule if needed. It must prevent updates,
   deletion and force pushes, with **no bypass actors**, including the App.
   Keep **Enforce release tag names**. In **Enforce work branch names**, add
   `refs/heads/release/*` to the exclusions only after the dedicated release
   creation and protection rulesets are active. Do not add an App bypass to all
   branch protections. Preparation checks these rulesets and refuses to proceed
   if their readable required protections or the naming exception are missing.
   GitHub can omit bypass-actor details for a token without ruleset administration
   access. When visible, they are checked exactly; when redacted, the workflow
   reports that limitation. Review those actors in Settings during setup. Do not
   grant the release App administration write access just to inspect its own rules.
6. Enable **immutable releases** in repository release settings before publishing
   the first release. Git rulesets protect the tag; GitHub release immutability
   additionally locks published assets. The API preflight verifies the rulesets;
   enabling release immutability is a separate administrator setup check.
7. For the router, confirm `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`, and Actions
   write access to its GHCR package. Restrict version/SHA tag mutation in the
   registry where supported, excluding the deliberately movable `latest` alias.
   Git tag rules do not protect container tags against out-of-band registry writes.
8. Run main normally and review the green checks. Then use the release checkbox.
   Release the router first, then the integrations bundle, and verify the manifest,
   package versions, signatures/provenance and image digests in the release assets.
   Confirm `latest` in both registries resolves to the released router digest.

Repository administrators can change rules/settings; workflow-only creation is
enforced for normal writers, not against an administrator deliberately removing
those protections. Never use the App key manually to create refs.

## Fixes and recovery

- **Validation failed before publication:** create an ordinary `fix/...` branch
  from the prepared release branch and open a PR targeting that release branch.
  Review compatibility changes and run all required PR checks. Merge by squash;
  the branch push automatically starts a new release run. Do not merge the release
  branch into main, as that would put frozen release pins on main. Forward-port
  code fixes separately.
- **Pins need changing:** prepare a new release from main. The Hindsight version,
  commit, digest, base commit, bundle version and Nix reference are frozen. Keep
  `.github/` identical to the preparation baseline; automation changes require a
  new preparation from updated main. For integrations package fixes, rebuild the
  tarballs, update their downstream revisions/checksums/Nix hashes and the
  `release.json` package entries in the same PR.
- **Publication, signing or upload failed:** use **Re-run failed jobs** on the
  existing release run. The router retains its tested image for 30 days and
  reloads it on retry, then repeats smoke/scanning before publishing. Existing
  version/SHA tags must identify that same image; existing Git tags and release
  assets must match exactly. The workflow never deletes or replaces a release tag
  or an uploaded asset to make a retry succeed.
- **Code changed after any versioned image was pushed, or the retained image
  expired:** prepare a new revision if an exact retry cannot succeed. Do not push
  different bytes over the reserved version. Avoid merging release fixes while a
  publication job is running; there is no atomic transaction across GitHub and
  both registries.
- **Release succeeded but `latest` promotion failed:** rerun the failed job. The
  existing immutable release is verified and promotion retried. A partial registry
  promotion can temporarily leave aliases different; the version/digest assets
  remain the authoritative installation references.
- **Already released:** leave its branch and tag in place. Start a new preparation
  for subsequent changes. The current button deliberately targets the latest
  stable Hindsight release; it does not offer an arbitrary old-version override.

## Policy transition

The new release workflows are explicitly recognized by the policy guard; the
existing checks remain protected. The integrations guard executes from the trusted
PR base (`pull_request_target`), so the old guard cannot authorize these new
workflow shapes in the same PR that updates it. If it rejects this transition,
leave the PR blocked and have the repository owner choose a reviewed policy
bootstrap using the established administrative process. Do not disable the guard,
fabricate a successful check, or use the release App to bypass main protection.

References: [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository),
[immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases),
[sharing a tested Docker image](https://docs.docker.com/build/ci/github-actions/share-image-jobs/).
