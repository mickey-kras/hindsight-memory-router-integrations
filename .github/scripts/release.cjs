const { readFileSync, existsSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { join } = require("node:path");

class ReleaseError extends Error {}

const upstream = { owner: "vectorize-io", repo: "hindsight" };
const coreTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const releaseTag = coreTag;
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

async function retry(request, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (attempt === 2 || (error.status && error.status < 500 && error.status !== 429)) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
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
  const { data: release } = await retry(() => github.rest.repos.getLatestRelease(upstream));
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
  return validatePin({ version, sha: ref.object.sha, image: `${image}@${await retry(() => inspect(image))}` });
}

async function resolve({ github, context, core, inspect, target }) {
  const config = readJson("compat/hindsight.json");
  const ref = target ? releaseTarget(context, target).ref : context.ref;
  const branch = context.payload.pull_request?.base.ref || ref.replace("refs/heads/", "");
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
  if (Object.hasOwn(rule, "bypass_actors")) {
    requireValue(isDeepStrictEqual(rule.bypass_actors, bypass), `${rule.name}: unexpected bypass actors`);
  } else {
    let review;
    try {
      review = JSON.parse(process.env.RELEASE_SETTINGS_REVIEW || "null");
    } catch {
      throw new ReleaseError("Invalid RELEASE_SETTINGS_REVIEW");
    }
    const reviewedAt = review?.rulesets?.[rule.id];
    requireValue(
      review?.app_id === Number(process.env.RELEASE_APP_ID) &&
        review.immutable_releases === true &&
        typeof rule.updated_at === "string" &&
        typeof reviewedAt === "string" &&
        Date.parse(reviewedAt) === Date.parse(rule.updated_at),
      `${rule.name}: bypass actors are redacted; record the current owner-reviewed settings in RELEASE_SETTINGS_REVIEW`,
    );
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
      ["non_fast_forward", "pull_request", "required_status_checks"],
      null,
    ],
    ["Release branch deletion", "branch", "refs/heads/release/*", ["deletion"], appId],
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

function releaseVersion(tags, branches) {
  const version = readJson("release-version.json").version;
  requireValue(releaseTag.test(`v${version}`), "Set a plain X.Y.Z in release-version.json");
  requireValue(
    !tags.some((tag) => tag.name === `v${version}`) && !branches.some((branch) => branch.name === `release/${version}`),
    "Version already reserved; resume that release or bump release-version.json through a main PR",
  );
  return version;
}

function integrationUpstreams() {
  if (!existsSync("UPSTREAM_VERSION")) return null;
  const fields = Object.fromEntries(
    readFileSync("UPSTREAM_VERSION", "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  const coding = readJson("integrations/coding-agents/UPSTREAM.json");
  const pins = {
    openclaw: { version: fields.upstream_version, sha: fields.upstream_commit, path: fields.upstream_path },
    coding_agents: { version: coding.version, sha: coding.commit, path: coding.path },
  };
  for (const pin of Object.values(pins)) {
    requireValue(coreTag.test(`v${pin.version}`) && commitSha.test(pin.sha), "Invalid integration upstream provenance");
  }
  requireValue(
    fields.upstream_repo === "vectorize-io/hindsight" && coding.source === "https://github.com/vectorize-io/hindsight",
    "Unexpected integration upstream repository",
  );
  return pins;
}

async function releasedRouter(github, hindsight) {
  const repository = { owner: "mickey-kras", repo: "hindsight-memory-router" };
  const { data: release } = await github.rest.repos.getLatestRelease(repository);
  requireValue(
    release.immutable && !release.draft && !release.prerelease && releaseTag.test(release.tag_name),
    "Publish an immutable router release before releasing integrations",
  );
  const { data: tag } = await github.rest.git.getRef({ ...repository, ref: `tags/${release.tag_name}` });
  requireValue(tag.object.type === "commit" && commitSha.test(tag.object.sha), "Invalid router release commit");
  const { data: file } = await github.rest.repos.getContent({
    ...repository,
    path: "release.json",
    ref: tag.object.sha,
  });
  requireValue(file.type === "file" && file.encoding === "base64", "Router release manifest is missing");
  const manifest = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  requireValue(
    manifest.schema === 2 && `v${manifest.version}` === release.tag_name && !manifest.packages.length,
    "Invalid router release manifest",
  );
  requireValue(
    isDeepStrictEqual(manifest.hindsight, hindsight),
    "Release the router for the current Hindsight pin before releasing integrations",
  );
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...repository,
    release_id: release.id,
    per_page: 100,
  });
  const asset = assets.find((item) => item.name === "image-digests.txt");
  requireValue(asset && imageDigest.test(asset.digest), "Router image digest asset is missing or unverifiable");
  const { data } = await github.rest.repos.getReleaseAsset({
    ...repository,
    asset_id: asset.id,
    headers: { accept: "application/octet-stream" },
  });
  const bytes = Buffer.from(data);
  requireValue(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` === asset.digest,
    "Router release asset checksum differs",
  );
  const images = Object.fromEntries(
    bytes
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  requireValue(
    images.commit === tag.object.sha && images.version === manifest.version,
    "Router image does not match its release",
  );
  const pin = { version: manifest.version, sha: tag.object.sha, image: images.ghcr, dockerhub_image: images.dockerhub };
  validateRouter(pin);
  return pin;
}

function validateRouter(pin) {
  requireValue(pin && releaseTag.test(`v${pin.version}`) && commitSha.test(pin.sha), "Invalid router release pin");
  const prefix = "ghcr.io/mickey-kras/hindsight-memory-router@";
  const dockerhub = "docker.io/mickeykrasilnikov/hindsight-memory-router@";
  requireValue(
    typeof pin.image === "string" && pin.image.startsWith(prefix) && imageDigest.test(pin.image.slice(prefix.length)),
    "Router must use the released GHCR digest",
  );
  requireValue(
    pin.dockerhub_image === `${dockerhub}${pin.image.slice(prefix.length)}`,
    "Router registry digests differ",
  );
}

async function checkPackageReuse(github, repository, packages) {
  if (!packages.length) return;
  const releases = await github.paginate(github.rest.repos.listReleases, { ...repository, per_page: 100 });
  for (const release of releases.filter((item) => !item.draft && !item.prerelease)) {
    const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
      ...repository,
      release_id: release.id,
      per_page: 100,
    });
    for (const pkg of packages) {
      const asset = assets.find((item) => item.name === pkg.path.split("/").pop());
      requireValue(
        !asset || asset.digest === `sha256:${pkg.sha256}`,
        "Package version already published with different bytes; bump that package version",
      );
    }
  }
}

function packageAssets() {
  if (!existsSync("UPSTREAM_VERSION")) return [];
  return ["package.json", "src/upstream/coding-agents/package.json", "src/mcp/package.json"].map((path) => {
    const pkg = readJson(path);
    requireValue(releaseTag.test(`v${pkg.version}`), `Invalid downstream version: ${path}`);
    const filename = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`;
    requireValue(/^[a-z0-9.-]+\.tgz$/.test(filename), "Invalid package filename");
    const asset = `packages/${filename}`;
    return { name: pkg.name, path: asset, version: pkg.version, sha256: checksum(asset) };
  });
}

function dispatchContext(context) {
  requireValue(
    context.eventName === "workflow_dispatch" &&
      context.workflow === "release" &&
      context.ref === "refs/heads/main" &&
      commitSha.test(context.sha),
    "Release dispatch is allowed only from main",
  );
}

function releaseTarget(context, target) {
  const selected = target || { ref: context.ref, sha: context.sha };
  if (context.eventName === "workflow_dispatch") {
    dispatchContext(context);
  } else {
    requireValue(
      context.eventName === "push" &&
        context.workflow === "release" &&
        selected.ref === context.ref &&
        selected.sha === context.sha,
      "Publication is allowed only through the release workflow",
    );
  }
  requireValue(
    typeof selected.ref === "string" && selected.ref.startsWith("refs/heads/release/"),
    "Release candidate must be a release branch",
  );
  const version = selected.ref.slice("refs/heads/release/".length);
  requireValue(releaseTag.test(`v${version}`) && commitSha.test(selected.sha), "Invalid release candidate");
  return { ref: selected.ref, sha: selected.sha, version };
}

function candidateOutputs(core, target) {
  core.setOutput("sha", target.sha);
  core.setOutput("ref", target.ref);
}

async function prepare({ github, context, core, inspect }) {
  dispatchContext(context);
  const repository = context.repo;
  await checkRules(github, repository, Number(process.env.RELEASE_APP_ID));
  const { data: main } = await github.rest.git.getRef({ ...repository, ref: "heads/main" });
  const branches = await github.paginate(github.rest.repos.listBranches, { ...repository, per_page: 100 });
  const version = releaseVersion([], []);
  const branch = `release/${version}`;
  const existing = branches.find((item) => item.name === branch);
  if (existing) {
    const { data: head } = await github.rest.git.getRef({ ...repository, ref: `heads/${branch}` });
    requireValue(head.object.type === "commit" && commitSha.test(head.object.sha), "Invalid prepared release commit");
    const read = async (path) => {
      const { data: file } = await github.rest.repos.getContent({ ...repository, path, ref: head.object.sha });
      requireValue(file.type === "file" && file.encoding === "base64", `Cannot read prepared ${path}`);
      return Buffer.from(file.content, "base64").toString("utf8");
    };
    const manifest = await validate({
      github,
      core,
      context,
      read,
      target: { ref: `refs/heads/${branch}`, sha: head.object.sha },
    });
    requireValue(
      manifest.base === context.sha,
      "Prepared version belongs to another main snapshot; resume its release run or prepare a new version",
    );
    if (manifest.publication_run === context.runId) {
      candidateOutputs(core, { ref: `refs/heads/${branch}`, sha: head.object.sha });
      await core.summary.addRaw(`Continuing this run with retained candidate ${head.object.sha}.\n`).write();
      return;
    }
    core.setOutput("resume_run", manifest.publication_run || "");
    core.setOutput("resume_sha", head.object.sha);
    core.setOutput("version", version);
    await core.summary
      .addRaw(`Retained candidate: ${branch} at ${head.object.sha}. Resuming its release workflow.\n`)
      .write();
    return;
  }
  const tags = await github.paginate(github.rest.repos.listTags, { ...repository, per_page: 100 });
  if (tags.some((tag) => tag.name === `v${version}`)) {
    const tag = await tagCommit(github, repository, version);
    const published = await optional(() => github.rest.repos.getReleaseByTag({ ...repository, tag: `v${version}` }));
    requireValue(
      tag && commitSha.test(tag.sha) && published?.immutable && !published.draft && !published.prerelease,
      "Version is reserved by an incomplete release; resume its existing release workflow",
    );
    const { data: file } = await github.rest.repos.getContent({ ...repository, path: "release.json", ref: tag.sha });
    requireValue(file.type === "file" && file.encoding === "base64", "Published release manifest is missing");
    const manifest = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    requireValue(
      manifest.schema === 2 && manifest.version === version && manifest.base === context.sha,
      "Published version belongs to another main snapshot; prepare a new version",
    );
    if (manifest.publication_run === context.runId) {
      candidateOutputs(core, { ref: `refs/heads/${branch}`, sha: tag.sha });
      await core.summary.addRaw(`Resuming this run after cleanup at published candidate ${tag.sha}.\n`).write();
      return;
    }
    await core.summary
      .addRaw(`v${version} is already published at ${tag.sha}; no duplicate release was started.\n`)
      .write();
    return;
  }
  requireValue(main.object.sha === context.sha, "Main advanced during validation; run preparation again");
  releaseVersion(tags, branches);
  const pin = await latestHindsight(github, inspect);
  const packages = packageAssets();
  const manifest = { schema: 2, version, base: context.sha, preparation_run: context.runId, hindsight: pin, packages };
  manifest.publication_run = context.runId;
  if (packages.length) {
    await checkPackageReuse(github, repository, packages);
    manifest.router = await releasedRouter(github, pin);
    manifest.integration_upstreams = integrationUpstreams();
    const { data: nix } = await github.rest.repos.getCommit({ owner: "openclaw", repo: "nix-openclaw", ref: "main" });
    requireValue(commitSha.test(nix.sha), "Invalid nix-openclaw commit");
    manifest.nix_openclaw = nix.sha;
  }
  const tree = [
    { path: "release.json", mode: "100644", type: "blob", content: json(manifest) },
    { path: "compat/hindsight.json", mode: "100644", type: "blob", content: json({ channel: "release", ...pin }) },
  ];
  if (!packages.length) {
    requireValue(
      readFileSync("pyproject.toml", "utf8").includes(`version = "${version}"`),
      "Align pyproject.toml with release-version.json before preparing",
    );
  }
  const { data: base } = await github.rest.git.getCommit({ ...repository, commit_sha: context.sha });
  const { data: createdTree } = await github.rest.git.createTree({ ...repository, base_tree: base.tree.sha, tree });
  const { data: commit } = await github.rest.git.createCommit({
    ...repository,
    message: `Prepare v${version}`,
    tree: createdTree.sha,
    parents: [context.sha],
  });
  const { data: currentMain } = await github.rest.git.getRef({ ...repository, ref: "heads/main" });
  requireValue(currentMain.object.sha === context.sha, "Main advanced while freezing inputs; run preparation again");
  await github.rest.git.createRef({ ...repository, ref: `refs/heads/release/${version}`, sha: commit.sha });
  candidateOutputs(core, { ref: `refs/heads/release/${version}`, sha: commit.sha });
  await core.summary
    .addRaw(
      `Release branch: release/${version}\nMain snapshot: ${context.sha}\nHindsight: ${pin.version}\nCommit: ${commit.sha}\nCandidate validation and publication are pending.\n`,
    )
    .write();
}

async function validate({ github, context, core, target, read = (path) => readFileSync(path, "utf8") }) {
  const candidate = releaseTarget(context, target);
  const manifest = JSON.parse(await read("release.json"));
  requireValue(manifest.schema === 2 && releaseTag.test(`v${manifest.version}`), "Invalid release manifest");
  requireValue(
    candidate.ref === `refs/heads/release/${manifest.version}`,
    "Release branch does not match the manifest",
  );
  requireValue(commitSha.test(manifest.base), "Invalid preparation base");
  if (context.eventName === "workflow_dispatch" && context.ref === "refs/heads/main") {
    requireValue(manifest.base === context.sha, "Candidate belongs to another main snapshot");
  }
  requireValue(
    manifest.publication_run === undefined ||
      (Number.isSafeInteger(manifest.publication_run) &&
        manifest.publication_run > 0 &&
        manifest.publication_run === manifest.preparation_run),
    "Invalid originating publication run",
  );
  requireValue(
    JSON.parse(await read("release-version.json")).version === manifest.version,
    "Repository version differs from the release",
  );
  requireValue(
    Array.isArray(manifest.packages) &&
      manifest.packages.length === (context.repo.repo === "hindsight-memory-router-integrations" ? 3 : 0),
    "Invalid release package inventory",
  );
  validatePin(manifest.hindsight);
  requireValue(
    isDeepStrictEqual(JSON.parse(await read("compat/hindsight.json")), { channel: "release", ...manifest.hindsight }),
    "Release Hindsight inputs changed",
  );
  await checkRules(github, context.repo, Number(process.env.RELEASE_APP_ID));
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${manifest.base}...${candidate.sha}`,
  });
  requireValue(
    comparison.status === "ahead" &&
      comparison.total_commits <= 250 &&
      comparison.commits.length === comparison.total_commits,
    "Release must descend from its prepared main commit",
  );
  if (
    context.eventName === "workflow_dispatch" &&
    context.ref === "refs/heads/main" &&
    manifest.publication_run !== undefined
  ) {
    requireValue(
      comparison.total_commits === 1,
      "Candidate changed after preparation; forward-port its fix and prepare a new version from main",
    );
  }
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
  const branch = await optional(() =>
    github.rest.git.getRef({ ...context.repo, ref: `heads/release/${manifest.version}` }),
  );
  if (branch) {
    requireValue(branch.object.sha === candidate.sha, "Release branch advanced; wait for its new validation run");
  } else {
    const published = await optional(() =>
      github.rest.repos.getReleaseByTag({ ...context.repo, tag: `v${manifest.version}` }),
    );
    requireValue(
      published?.immutable && !published.draft && !published.prerelease,
      "Prepared release branch is missing and no immutable release exists",
    );
    await publishedTag(github, context.repo, manifest.version, candidate.sha);
  }
  requireValue(
    JSON.stringify(packageAssets()) === JSON.stringify(manifest.packages),
    "Refresh release.json package hashes and versions with the tested package changes",
  );
  if (manifest.packages.length) {
    validateRouter(manifest.router);
    requireValue(commitSha.test(manifest.nix_openclaw), "Invalid nix-openclaw pin");
    requireValue(
      isDeepStrictEqual(integrationUpstreams(), manifest.integration_upstreams),
      "Integration upstream provenance changed",
    );
    await checkPackageReuse(github, context.repo, manifest.packages);
  } else {
    requireValue(
      (await read("pyproject.toml")).includes(`version = "${manifest.version}"`),
      "Python distribution version differs from the release",
    );
  }
  const tag = await optional(() => github.rest.git.getRef({ ...context.repo, ref: `tags/v${manifest.version}` }));
  if (tag) {
    let target = tag.object;
    if (target.type === "tag") {
      ({
        data: { object: target },
      } = await github.rest.git.getTag({ ...context.repo, tag_sha: target.sha }));
    }
    requireValue(
      target.type === "commit" && commitSha.test(target.sha) && target.sha === candidate.sha,
      "Release tag already belongs to another commit",
    );
  }
  core.setOutput("version", manifest.version);
  return manifest;
}

async function resumePreparedRelease({ github, context, core, version, sha, runId }) {
  dispatchContext(context);
  requireValue(releaseTag.test(`v${version}`) && commitSha.test(sha), "Invalid release recovery target");
  const branch = `release/${version}`;
  const current = await optional(() => github.rest.git.getRef({ ...context.repo, ref: `heads/${branch}` }));
  requireValue(
    current?.object.type === "commit" && current.object.sha === sha,
    "Prepared branch changed before recovery; refusing to rerun a stale candidate",
  );
  let run;
  if (runId !== undefined) {
    requireValue(
      Number.isSafeInteger(runId) && runId > 0 && runId !== context.runId,
      "Invalid originating release run",
    );
    ({ data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: runId }));
    requireValue(
      run.id === runId &&
        run.path === ".github/workflows/release.yml" &&
        run.event === "workflow_dispatch" &&
        run.head_branch === "main" &&
        run.head_sha === context.sha,
      "Originating release run does not match its selected source snapshot",
    );
  } else {
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
      ...context.repo,
      workflow_id: "release.yml",
      branch,
      event: "push",
      head_sha: sha,
      per_page: 100,
    });
    run = runs
      .filter(
        (item) =>
          item.head_sha === sha &&
          item.head_branch === branch &&
          item.event === "push" &&
          item.path === ".github/workflows/release.yml",
      )
      .sort((left, right) => right.id - left.id)[0];
  }
  requireValue(run, "The prepared branch has no release workflow run; inspect its Actions startup failure");
  const link = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${run.id}`;
  if (run.status !== "completed") {
    await core.summary.addRaw(`Publication is ${run.status}: ${link}. No duplicate release was started.\n`).write();
    return;
  }
  if (run.conclusion === "success") {
    await core.summary.addRaw(`Release workflow already succeeded: ${link}.\n`).write();
    return;
  }
  requireValue(
    ["failure", "cancelled", "timed_out", "startup_failure", "action_required"].includes(run.conclusion),
    `Release workflow cannot be resumed from ${run.conclusion}`,
  );
  const { data: head } = await github.rest.git.getRef({ ...context.repo, ref: `heads/${branch}` });
  requireValue(head.object.sha === sha, "Prepared branch advanced before retry; refusing to rerun a stale candidate");
  const rerun =
    run.conclusion === "failure" ? github.rest.actions.reRunWorkflowFailedJobs : github.rest.actions.reRunWorkflow;
  await rerun({ ...context.repo, run_id: run.id });
  await core.summary
    .addRaw(`Release retry requested: ${link}. Publication is pending. Frozen commit: ${sha}.\n`)
    .write();
}

async function candidateProvenance({
  github,
  context,
  core,
  target,
  build = async () => (await import("@actions/attest")).buildSLSAProvenancePredicate(),
}) {
  const candidate = releaseTarget(context, target);
  await validate({ github, context, core, target });
  const predicate = await build();
  const repository = `https://github.com/${context.repo.owner}/${context.repo.repo}`;
  requireValue(
    predicate.type === "https://slsa.dev/provenance/v1" &&
      predicate.params.buildDefinition.resolvedDependencies.some(
        (dependency) =>
          dependency.uri === `git+${repository}@${context.ref}` && dependency.digest?.gitCommit === context.sha,
      ),
    "Provenance workflow claims differ from the executing source",
  );
  predicate.params.buildDefinition.resolvedDependencies.push({
    name: "release-candidate",
    uri: `git+${repository}@${candidate.ref}`,
    digest: { gitCommit: candidate.sha },
  });
  const path = join(process.env.RUNNER_TEMP, "release-provenance.json");
  writeFileSync(path, json(predicate.params));
  core.setOutput("path", path);
  core.setOutput("type", predicate.type);
  return predicate;
}

function shouldPromote(version, releases) {
  const semver = require("semver");
  requireValue(releaseTag.test(`v${version}`), "Invalid release version");
  return !releases.some(
    (release) =>
      releaseTag.test(release.tag_name) &&
      !release.draft &&
      !release.prerelease &&
      semver.gt(release.tag_name.slice(1), version),
  );
}

function releaseNotes(manifest, sha) {
  const rows = manifest.packages.length
    ? [`| Router | ${manifest.router.version} |`, ...manifest.packages.map((pkg) => `| ${pkg.name} | ${pkg.version} |`)]
    : [`| Router | ${manifest.version} |`];
  return `| Component | Version |\n| --- | --- |\n${rows.join("\n")}\n\nHindsight: ${manifest.hindsight.version}.\nCommit: ${sha}.\n\nSee release.json for exact upstream commits, package checksums and${manifest.packages.length ? " the tested router image digest" : " image-digests.txt for published images"}.`;
}

async function finalize({ github, context, core, target }) {
  const candidate = releaseTarget(context, target);
  const manifest = await validate({ github, context, core, target });
  const tag = `v${manifest.version}`;
  const existing = await optional(() => github.rest.git.getRef({ ...context.repo, ref: `tags/${tag}` }));
  if (!existing) {
    // Annotated tag object (no signing key is provisioned for this repository;
    // see docs/RELEASING.md for the tag trust basis). The tag rulesets restrict
    // creation to the Release App and block updates, deletion and force pushes.
    const { data: annotated } = await github.rest.git.createTag({
      ...context.repo,
      tag,
      message: `Release ${tag}\n\nSee release.json for frozen inputs and package checksums.`,
      object: candidate.sha,
      type: "commit",
    });
    requireValue(annotated.object?.sha === candidate.sha, "Annotated tag does not point at the release commit");
    await github.rest.git.createRef({ ...context.repo, ref: `refs/tags/${tag}`, sha: annotated.sha });
  }
  let release = await optional(() => github.rest.repos.getReleaseByTag({ ...context.repo, tag }));
  if (!release) {
    ({ data: release } = await github.rest.repos.createRelease({
      ...context.repo,
      tag_name: tag,
      target_commitish: candidate.sha,
      name: tag,
      draft: true,
      prerelease: false,
      body: releaseNotes(manifest, candidate.sha),
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

function nextPatch(version) {
  requireValue(releaseTag.test(`v${version}`), "Invalid released version");
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function mergeVersionBump({ repository, number, sha }) {
  execFileSync(
    "gh",
    ["pr", "merge", String(number), "--repo", repository, "--auto", "--squash", "--match-head-commit", sha],
    { timeout: 30000, stdio: "pipe" },
  );
}

async function queueVersionBump({ github, repository, number, branch, version, next, merge }) {
  const params = { ...repository, pull_number: number };
  const { data: pull } = await github.rest.pulls.get(params);
  const fullName = `${repository.owner}/${repository.repo}`;
  requireValue(
    pull.state === "open" &&
      !pull.draft &&
      pull.base.ref === "main" &&
      pull.head.repo?.full_name === fullName &&
      pull.head.ref === branch &&
      commitSha.test(pull.head.sha),
    `Refusing auto-merge: #${number} is not the expected bump PR`,
  );
  const expected = {
    "release-version.json": [`-  "version": "${version}"`, `+  "version": "${next}"`],
  };
  const files = await github.paginate(github.rest.pulls.listFiles, { ...params, per_page: 100 });
  requireValue(
    files.length === 1 &&
      new Set(files.map((file) => file.filename)).size === 1 &&
      files.every(
        (file) =>
          file.status === "modified" &&
          file.additions === 1 &&
          file.deletions === 1 &&
          expected[file.filename] &&
          isDeepStrictEqual(
            (file.patch || "").split("\n").filter((line) => /^[+-]/.test(line)),
            expected[file.filename],
          ),
      ),
    `Refusing auto-merge: #${number} contains changes beyond the next patch version`,
  );
  if (pull.auto_merge) {
    requireValue(pull.auto_merge.merge_method === "squash", `#${number} must use squash auto-merge`);
    return;
  }
  await merge({ repository: fullName, number, sha: pull.head.sha });
}

async function bumpReleasedVersion({ github, context, core, target, merge = mergeVersionBump }) {
  const candidate = releaseTarget(context, target);
  const version = candidate.version;
  await publishedTag(github, context.repo, version, candidate.sha);
  const next = nextPatch(version);
  const repository = context.repo;
  const branch = `ci/bump-release-version-${next.replaceAll(".", "-")}`;
  const summary = core.summary.addHeading("Release follow-up: version bump", 3);
  const open = await github.paginate(github.rest.pulls.list, {
    ...repository,
    state: "open",
    head: `${repository.owner}:${branch}`,
    per_page: 100,
  });
  if (open.length) {
    await queueVersionBump({ github, repository, number: open[0].number, branch, version, next, merge });
    await summary.addRaw(`Reused #${open[0].number}; squash auto-merge enabled.\n`).write();
    return;
  }
  const { data: main } = await github.rest.git.getRef({ ...repository, ref: "heads/main" });
  const read = async (path) => {
    const { data: file } = await github.rest.repos.getContent({ ...repository, path, ref: main.object.sha });
    requireValue(file.type === "file" && file.encoding === "base64", `Cannot read ${path} on main`);
    return Buffer.from(file.content, "base64").toString("utf8");
  };
  const current = JSON.parse(await read("release-version.json")).version;
  if (current !== version) {
    requireValue(
      releaseTag.test(`v${current}`) && require("semver").gt(current, version),
      "Main release version must advance beyond the published version",
    );
    await summary.addRaw(`Main already targets ${current}; no bump needed.\n`).write();
    return;
  }
  const { data: base } = await github.rest.git.getCommit({ ...repository, commit_sha: main.object.sha });
  const { data: tree } = await github.rest.git.createTree({
    ...repository,
    base_tree: base.tree.sha,
    tree: [{ path: "release-version.json", mode: "100644", type: "blob", content: json({ version: next }) }],
  });
  const { data: commit } = await github.rest.git.createCommit({
    ...repository,
    message: `Bump release version to ${next}`,
    tree: tree.sha,
    parents: [main.object.sha],
  });
  const ref = `heads/${branch}`;
  if (await optional(() => github.rest.git.getRef({ ...repository, ref }))) {
    await github.rest.git.deleteRef({ ...repository, ref });
  }
  await github.rest.git.createRef({ ...repository, ref: `refs/${ref}`, sha: commit.sha });
  const { data: pr } = await github.rest.pulls.create({
    ...repository,
    title: `Bump release version to ${next}`,
    head: branch,
    base: "main",
    body: `Release v${version} is published; reserve the next version on main.\n\n- Bump release-version.json to ${next}\n- Squash-merges automatically after required checks pass\n`,
    maintainer_can_modify: false,
  });
  await queueVersionBump({ github, repository, number: pr.number, branch, version, next, merge });
  await summary.addRaw(`Opened #${pr.number}: bump ${version} to ${next}; squash auto-merge enabled.\n`).write();
}

async function deletePublishedBranch({ github, context, core, target }) {
  const candidate = releaseTarget(context, target);
  const semver = require("semver");
  const version = candidate.version;
  await publishedTag(github, context.repo, version, candidate.sha);
  const summary = core.summary.addHeading("Release follow-up: release branch", 3);
  const ref = `heads/release/${version}`;
  const current = await optional(() => github.rest.git.getRef({ ...context.repo, ref }));
  if (!current) {
    await summary.addRaw(`Branch \`release/${version}\` is already absent.\n`);
  } else {
    requireValue(
      current.object.sha === candidate.sha,
      `Refusing to delete release/${version}: the branch advanced past the published commit`,
    );
    await github.rest.git.deleteRef({ ...context.repo, ref });
    await summary.addRaw(`Deleted \`release/${version}\`.\n`);
  }
  const branches = await github.paginate(github.rest.repos.listBranches, { ...context.repo, per_page: 100 });
  for (const item of branches) {
    if (!item.name.startsWith("release/") || item.name === `release/${version}`) continue;
    const stale = item.name.slice("release/".length);
    if (!releaseTag.test(`v${stale}`) || !semver.lt(stale, version)) continue;
    try {
      const tag = await tagCommit(github, context.repo, stale);
      if (!tag) continue;
      const published = await optional(() => github.rest.repos.getReleaseByTag({ ...context.repo, tag: `v${stale}` }));
      if (!published?.immutable || published.draft || published.prerelease) continue;
      const head = await optional(() => github.rest.git.getRef({ ...context.repo, ref: `heads/${item.name}` }));
      if (!head) continue;
      if (head.object.sha !== tag.sha) {
        core.warning(`Kept ${item.name}: the branch advanced past its published tag`);
        await summary.addRaw(`Kept \`${item.name}\`: the branch advanced past its published tag.\n`);
        continue;
      }
      await github.rest.git.deleteRef({ ...context.repo, ref: `heads/${item.name}` });
      await summary.addRaw(`Pruned \`${item.name}\`: v${stale} is published at the same commit.\n`);
    } catch (error) {
      if (error.status === 404) continue;
      await summary.addRaw(`Pruning \`${item.name}\` failed (${error.message}); retry the release workflow.\n`).write();
      throw error;
    }
  }
  await summary.write();
}

async function tagCommit(github, repository, version) {
  const tag = await optional(() => github.rest.git.getRef({ ...repository, ref: `tags/v${version}` }));
  if (!tag) return null;
  let target = tag.object;
  for (let depth = 0; target.type === "tag" && depth < 5; depth++) {
    ({
      data: { object: target },
    } = await github.rest.git.getTag({ ...repository, tag_sha: target.sha }));
  }
  requireValue(target.type === "commit" && commitSha.test(target.sha), "Invalid release tag target");
  return target;
}

async function publishedTag(github, repository, version, sha) {
  const tag = await tagCommit(github, repository, version);
  const published = await optional(() => github.rest.repos.getReleaseByTag({ ...repository, tag: `v${version}` }));
  requireValue(
    tag?.sha === sha && published?.immutable && !published.draft && !published.prerelease,
    `Refusing follow-up: v${version} is not immutable and published at this commit`,
  );
}

async function retryPackages({ github, context, core, target }) {
  const candidate = releaseTarget(context, target);
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    ...context.repo,
    run_id: context.runId,
    per_page: 100,
  });
  const retained = artifacts.find((item) => item.name === `packages-${candidate.sha}`);
  requireValue(!retained?.expired, "Retained release packages expired; prepare a new version");
  const tag = await tagCommit(github, context.repo, candidate.version);
  requireValue(
    !tag || (tag.sha === candidate.sha && retained),
    "Publication already began but retained release packages are missing or belong to another commit",
  );
  core.setOutput("artifact", retained ? String(retained.id) : "");
}

module.exports = {
  ReleaseError,
  retry,
  validatePin,
  latestHindsight,
  resolve,
  checkRule,
  releaseVersion,
  integrationUpstreams,
  releasedRouter,
  validateRouter,
  checkPackageReuse,
  shouldPromote,
  dispatchContext,
  releaseTarget,
  resumePreparedRelease,
  candidateProvenance,
  retryPackages,
  nextPatch,
  bumpReleasedVersion,
  deletePublishedBranch,
  prepare,
  validate,
  finalize,
  checkRules,
  packageAssets,
};
