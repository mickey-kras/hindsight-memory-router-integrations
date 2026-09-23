const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const {
  releaseTag,
  commitSha,
  requireValue,
  json,
  optional,
  releaseTarget,
  tagCommit,
  publishedTag,
} = require("./release.cjs");

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

module.exports = { bumpReleasedVersion, deletePublishedBranch };
