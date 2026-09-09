const { readFileSync, existsSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

class ReleaseError extends Error {}

const upstream = { owner: "vectorize-io", repo: "hindsight" };
const coreTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const releaseTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-router\.([1-9]\d*)$/;
const commitSha = /^[a-f0-9]{40}$/;
const imageDigest = /^sha256:[a-f0-9]{64}$/;

function requireValue(condition, message) {
  if (!condition) throw new ReleaseError(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function checksum(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function optional(request) {
  try {
    return (await request()).data;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function validatePin(pin) {
  requireValue(pin && coreTag.test(`v${pin.version}`), "Invalid Hindsight version");
  requireValue(commitSha.test(pin.sha), "Invalid Hindsight commit");
  const prefix = `ghcr.io/vectorize-io/hindsight:${pin.version}@`;
  requireValue(
    typeof pin.image === "string" && pin.image.startsWith(prefix) && imageDigest.test(pin.image.slice(prefix.length)),
    "Hindsight image must match its version and digest",
  );
  return pin;
}

async function latestHindsight(
  github,
  inspect = (image) =>
    JSON.parse(
      execFileSync("docker", ["buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest.Digest}}"], {
        encoding: "utf8",
      }),
    ),
) {
  const { data: release } = await github.rest.repos.getLatestRelease(upstream);
  requireValue(
    !release.draft && !release.prerelease && coreTag.test(release.tag_name),
    "Latest upstream release is not a stable Hindsight server release",
  );
  let { data: ref } = await github.rest.git.getRef({ ...upstream, ref: `tags/${release.tag_name}` });
  for (let depth = 0; ref.object.type === "tag" && depth < 5; depth++) {
    ({ data: ref } = await github.rest.git.getTag({ ...upstream, tag_sha: ref.object.sha }));
  }
  requireValue(ref.object.type === "commit", "Hindsight tag does not resolve to a commit");
  const version = release.tag_name.slice(1);
  const image = `ghcr.io/vectorize-io/hindsight:${version}`;
  return validatePin({ version, sha: ref.object.sha, image: `${image}@${inspect(image)}` });
}

async function resolve({ github, context, core, inspect }) {
  const config = readJson("compat/hindsight.json");
  const branch = context.payload.pull_request?.base.ref || context.ref.replace("refs/heads/", "");
  let pin;
  if (branch.startsWith("release/")) {
    requireValue(config.channel === "release", "Release branch must use frozen Hindsight inputs");
    pin = validatePin(config);
  } else {
    requireValue(config.channel === "latest", "Main must track the latest stable Hindsight release");
    pin = await latestHindsight(github, inspect);
  }
  for (const key of ["version", "sha", "image"]) core.setOutput(key, pin[key]);
  return pin;
}

function checkRule(rule, target, include, types, appId) {
  requireValue(rule.enforcement === "active" && rule.target === target, `${rule.name}: wrong target or disabled`);
  requireValue(
    isDeepStrictEqual(rule.conditions?.ref_name, { exclude: [], include: [include] }),
    `${rule.name}: unexpected ref targets`,
  );
  const bypass = appId ? [{ actor_id: appId, actor_type: "Integration", bypass_mode: "always" }] : [];
  // GitHub may redact bypass actors unless the caller can administer the ruleset.
  // Never interpret an omitted list as proof that no bypass exists. Native rules
  // enforce creation; the administrator must review actors during setup.
  if (Object.hasOwn(rule, "bypass_actors")) {
    requireValue(isDeepStrictEqual(rule.bypass_actors, bypass), `${rule.name}: unexpected bypass actors`);
  } else {
    console.info(`${rule.name}: GitHub redacted bypass actors; verify them in repository settings as documented.`);
  }
  const actual = new Set(rule.rules.map((item) => item.type));
  requireValue(
    types.every((type) => actual.has(type)),
    `${rule.name}: missing protection`,
  );
  if (appId) requireValue(actual.size === 1, `${rule.name}: creation bypass must not bypass other protections`);
}

async function checkRules(github, repository, appId) {
  requireValue(Number.isSafeInteger(appId) && appId > 0, "Set RELEASE_APP_ID to the dedicated App ID");
  const rules = await github.paginate(github.rest.repos.getRepoRulesets, { ...repository, per_page: 100 });
  const naming = rules.find((rule) => rule.name === "Enforce work branch names");
  requireValue(naming, "Work branch naming protection is missing");
  const { data: names } = await github.rest.repos.getRepoRuleset({ ...repository, ruleset_id: naming.id });
  requireValue(
    names.enforcement === "active" && names.conditions?.ref_name?.exclude?.includes("refs/heads/release/*"),
    "Exclude release/* from work branch creation restrictions; protect it with the dedicated release rulesets",
  );
  const specifications = [
    ["Release branch creation", "branch", "refs/heads/release/*", ["creation"], appId],
    [
      "Protect release branches",
      "branch",
      "refs/heads/release/*",
      ["deletion", "non_fast_forward", "pull_request", "required_status_checks"],
      null,
    ],
    ["Release tag creation", "tag", "refs/tags/v*", ["creation"], appId],
    ["Protect release tags", "tag", "refs/tags/v*", ["update", "deletion", "non_fast_forward"], null],
  ];
  for (const [name, target, include, types, bypass] of specifications) {
    const found = rules.find((rule) => rule.name === name);
    requireValue(found, `Configure the ${name} ruleset before releasing`);
    const { data } = await github.rest.repos.getRepoRuleset({ ...repository, ruleset_id: found.id });
    checkRule(data, target, include, types, bypass);
    if (name === "Protect release branches") {
      const template = readJson(".github/rulesets/protect-release-branches.json");
      requireValue(
        template.rules.every((expected) => data.rules.some((actual) => isDeepStrictEqual(actual, expected))),
        "Release branch protections must retain the reviewed checks, reviews, and scanning rules",
      );
    }
    if (target === "branch" && !bypass) {
      const pr = data.rules.find((rule) => rule.type === "pull_request").parameters;
      requireValue(
        pr.required_review_thread_resolution && JSON.stringify(pr.allowed_merge_methods) === '["squash"]',
        "Release branches require resolved reviews and squash merges",
      );
      const checks = data.rules.find((rule) => rule.type === "required_status_checks").parameters;
      const required = ["quality / checks", "aislop / aislop status", "codeql / analyze"];
      required.push(repository.repo === "hindsight-memory-router" ? "guard / guard" : "guard");
      if (repository.repo === "hindsight-memory-router") required.push("quality / container");
      else required.push("branch-policy / branch name");
      requireValue(
        checks.strict_required_status_checks_policy &&
          checks.do_not_enforce_on_create &&
          required.every((name) =>
            checks.required_status_checks.some((check) => check.context === name && check.integration_id === 15368),
          ),
        "Release branches must require the existing GitHub Actions gates and allow initial creation",
      );
    }
  }
}

function nextRevision(version, tags, branches) {
  let revision = 0;
  for (const name of [
    ...tags.map((tag) => tag.name),
    ...branches.map((branch) => `v${branch.name.replace(/^release\//, "")}`),
  ]) {
    const match = name.match(releaseTag);
    if (match && match.slice(1, 4).join(".") === version) revision = Math.max(revision, Number(match[4]));
  }
  requireValue(Number.isSafeInteger(revision + 1), "Release revision exceeds the supported range");
  return revision + 1;
}

function packageAssets() {
  if (!existsSync("UPSTREAM_VERSION")) return [];
  return ["package.json", "src/upstream/coding-agents/package.json"].map((path) => {
    const pkg = readJson(path);
    requireValue(releaseTag.test(`v${pkg.version}`), `Invalid downstream version: ${path}`);
    const filename = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`;
    requireValue(/^[a-z0-9.-]+\.tgz$/.test(filename), "Invalid package filename");
    const asset = `packages/${filename}`;
    return { path: asset, version: pkg.version, sha256: checksum(asset) };
  });
}

async function prepare({ github, context, core, inspect }) {
  requireValue(
    context.eventName === "workflow_dispatch" && context.ref === "refs/heads/main",
    "Release preparation is allowed only from the main workflow button",
  );
  const repository = context.repo;
  await checkRules(github, repository, Number(process.env.RELEASE_APP_ID));
  const { data: main } = await github.rest.git.getRef({ ...repository, ref: "heads/main" });
  requireValue(main.object.sha === context.sha, "Main advanced during validation; run preparation again");
  const branches = await github.paginate(github.rest.repos.listBranches, { ...repository, per_page: 100 });
  for (const branch of branches.filter((item) => item.name.startsWith("release/"))) {
    const existing = await optional(() =>
      github.rest.repos.getContent({ ...repository, path: "release.json", ref: branch.name }),
    );
    if (existing?.encoding === "base64") {
      const previous = JSON.parse(Buffer.from(existing.content, "base64").toString("utf8"));
      if (previous.preparation_run === context.runId && previous.base === context.sha) {
        await core.summary.addRaw(`Already prepared: ${branch.name}. Rerun its release workflow if needed.\n`).write();
        return;
      }
    }
  }
  const pin = await latestHindsight(github, inspect);
  const tags = await github.paginate(github.rest.repos.listTags, { ...repository, per_page: 100 });
  const revision = nextRevision(pin.version, tags, branches);
  const version = `${pin.version}-router.${revision}`;
  const packages = packageAssets();
  const manifest = { schema: 1, version, base: context.sha, preparation_run: context.runId, hindsight: pin, packages };
  if (packages.length) {
    const { data: nix } = await github.rest.repos.getCommit({ owner: "openclaw", repo: "nix-openclaw", ref: "main" });
    requireValue(commitSha.test(nix.sha), "Invalid nix-openclaw commit");
    manifest.nix_openclaw = nix.sha;
  }
  const tree = [
    { path: "release.json", mode: "100644", type: "blob", content: json(manifest) },
    { path: "compat/hindsight.json", mode: "100644", type: "blob", content: json({ channel: "release", ...pin }) },
  ];
  if (!packages.length) {
    const project = readFileSync("pyproject.toml", "utf8");
    requireValue(/^version = "[^"]+"$/m.test(project), "Python distribution version is missing");
    tree.push({
      path: "pyproject.toml",
      mode: "100644",
      type: "blob",
      content: project.replace(/^version = "[^"]+"$/m, `version = "${pin.version}+router.${revision}"`),
    });
  }
  const { data: base } = await github.rest.git.getCommit({ ...repository, commit_sha: context.sha });
  const { data: createdTree } = await github.rest.git.createTree({ ...repository, base_tree: base.tree.sha, tree });
  const { data: commit } = await github.rest.git.createCommit({
    ...repository,
    message: `Prepare v${version}`,
    tree: createdTree.sha,
    parents: [context.sha],
  });
  await github.rest.git.createRef({ ...repository, ref: `refs/heads/release/${version}`, sha: commit.sha });
  await core.summary
    .addRaw(`Release branch: release/${version}\nHindsight: ${pin.version}\nCommit: ${commit.sha}\n`)
    .write();
}

async function validate({ github, context, core }) {
  requireValue(
    context.eventName === "push" && context.workflow === "release",
    "Publication is allowed only through the release workflow",
  );
  const manifest = readJson("release.json");
  requireValue(manifest.schema === 1 && releaseTag.test(`v${manifest.version}`), "Invalid release manifest");
  requireValue(context.ref === `refs/heads/release/${manifest.version}`, "Release branch does not match the manifest");
  requireValue(commitSha.test(manifest.base), "Invalid preparation base");
  requireValue(
    manifest.version.startsWith(`${manifest.hindsight?.version}-router.`),
    "Release version must match its Hindsight base",
  );
  requireValue(
    Array.isArray(manifest.packages) &&
      manifest.packages.length === (context.repo.repo === "hindsight-memory-router-integrations" ? 2 : 0),
    "Invalid release package inventory",
  );
  validatePin(manifest.hindsight);
  requireValue(
    isDeepStrictEqual(readJson("compat/hindsight.json"), { channel: "release", ...manifest.hindsight }),
    "Release Hindsight inputs changed",
  );
  await checkRules(github, context.repo, Number(process.env.RELEASE_APP_ID));
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${manifest.base}...${context.sha}`,
  });
  requireValue(
    comparison.status === "ahead" &&
      comparison.total_commits <= 250 &&
      comparison.commits.length === comparison.total_commits,
    "Release must descend from its prepared main commit",
  );
  requireValue(
    comparison.files && comparison.files.length < 300,
    "Release diff is missing or too large to validate safely",
  );
  requireValue(
    !comparison.files.some((file) =>
      [file.filename, file.previous_filename || ""].some((path) => path.startsWith(".github/")),
    ),
    "Release automation must remain identical to its main baseline",
  );
  const { data: original } = await github.rest.repos.getContent({
    ...context.repo,
    path: "release.json",
    ref: comparison.commits[0].sha,
  });
  requireValue(original.type === "file" && original.encoding === "base64", "Preparation manifest is missing");
  const prepared = JSON.parse(Buffer.from(original.content, "base64").toString("utf8"));
  const frozen = ({ packages: _packages, ...fields }) => fields;
  requireValue(isDeepStrictEqual(frozen(prepared), frozen(manifest)), "Prepared release inputs are immutable");
  const { data: main } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${manifest.base}...main`,
  });
  requireValue(["ahead", "identical"].includes(main.status), "Preparation base is not on main");
  const { data: branch } = await github.rest.git.getRef({ ...context.repo, ref: `heads/release/${manifest.version}` });
  requireValue(branch.object.sha === context.sha, "Release branch advanced; wait for its new validation run");
  requireValue(
    JSON.stringify(packageAssets()) === JSON.stringify(manifest.packages),
    "Refresh release.json package hashes and versions with the tested package changes",
  );
  if (!manifest.packages.length) {
    const revision = `v${manifest.version}`.match(releaseTag)[4];
    requireValue(
      readFileSync("pyproject.toml", "utf8").includes(`version = "${manifest.hindsight.version}+router.${revision}"`),
      "Python distribution version differs from the release",
    );
  }
  const tag = await optional(() => github.rest.git.getRef({ ...context.repo, ref: `tags/v${manifest.version}` }));
  requireValue(
    !tag || (tag.object.type === "commit" && tag.object.sha === context.sha),
    "Release tag already belongs to another commit",
  );
  core.setOutput("version", manifest.version);
  return manifest;
}

function shouldPromote(version, releases) {
  const current = `v${version}`.match(releaseTag).slice(1).map(Number);
  return !releases.some((release) => {
    const match = release.tag_name.match(releaseTag);
    if (!match || release.draft || release.prerelease) return false;
    const other = match.slice(1).map(Number);
    const differing = current.findIndex((value, index) => value !== other[index]);
    return differing >= 0 && other[differing] > current[differing];
  });
}

async function finalize({ github, context, core }) {
  const manifest = await validate({ github, context, core });
  const tag = `v${manifest.version}`;
  const existing = await optional(() => github.rest.git.getRef({ ...context.repo, ref: `tags/${tag}` }));
  if (!existing) await github.rest.git.createRef({ ...context.repo, ref: `refs/tags/${tag}`, sha: context.sha });
  let release = await optional(() => github.rest.repos.getReleaseByTag({ ...context.repo, tag }));
  if (!release) {
    ({ data: release } = await github.rest.repos.createRelease({
      ...context.repo,
      tag_name: tag,
      target_commitish: context.sha,
      name: tag,
      draft: true,
      prerelease: false,
      body: `Hindsight ${manifest.hindsight.version}.\n\nCommit: ${context.sha}.\n\nSee release.json for pinned inputs and assets.`,
    }));
  }
  const paths = [
    "release.json",
    ...manifest.packages.map((pkg) => pkg.path),
    ...(manifest.packages.length ? ["PACKAGE_SHA256", "PACKAGE_NIX_HASHES"] : ["image-digests.txt"]),
  ];
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...context.repo,
    release_id: release.id,
    per_page: 100,
  });
  for (const path of paths) {
    const name = path.split("/").pop();
    const asset = assets.find((item) => item.name === name);
    if (asset) {
      requireValue(asset.digest === `sha256:${checksum(path)}`, `Existing release asset differs: ${name}`);
    } else {
      requireValue(release.draft, `Published release is missing ${name}`);
      await github.rest.repos.uploadReleaseAsset({
        ...context.repo,
        release_id: release.id,
        name,
        data: readFileSync(path),
        headers: { "content-type": "application/octet-stream" },
      });
    }
  }
  const releases = await github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 });
  const latest = shouldPromote(manifest.version, releases);
  if (release.draft || latest) {
    await github.rest.repos.updateRelease({
      ...context.repo,
      release_id: release.id,
      draft: false,
      prerelease: false,
      make_latest: latest ? "true" : "false",
    });
  }
  core.setOutput("latest", String(latest));
}

module.exports = {
  ReleaseError,
  validatePin,
  latestHindsight,
  resolve,
  checkRule,
  nextRevision,
  shouldPromote,
  prepare,
  validate,
  finalize,
  checkRules,
  packageAssets,
};
