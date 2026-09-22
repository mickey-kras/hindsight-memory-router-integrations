const releaseTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

class CleanupError extends Error {}

function requireValue(condition, message) {
  if (!condition) throw new CleanupError(message);
}

function targets(context, target) {
  const { releaseTarget, ReleaseError } = require("./release.cjs");
  try {
    const { version, sha } = releaseTarget(context, target);
    return { version, sha };
  } catch (error) {
    if (error instanceof ReleaseError) throw new CleanupError(error.message, { cause: error });
    throw error;
  }
}

async function published(github, repository, version) {
  const absent = (error) => {
    if (error.status === 404) return false;
    throw error;
  };
  const tag = await github.rest.git.getRef({ ...repository, ref: `tags/v${version}` }).then(() => true, absent);
  const release = await github.rest.repos
    .getReleaseByTag({ ...repository, tag: `v${version}` })
    .then(() => true, absent);
  return tag || release;
}

async function branch({ github, context, core, target }) {
  const { version, sha } = targets(context, target);
  const summary = core.summary.addHeading("Failed release cleanup: branch", 3);
  if (await published(github, context.repo, version)) {
    await summary
      .addRaw(
        `Kept \`release/${version}\`: \`v${version}\` already exists. Re-run failed jobs to finish the release.\n`,
      )
      .write();
    return;
  }
  const ref = `heads/release/${version}`;
  const current = await github.rest.git.getRef({ ...context.repo, ref }).then(
    ({ data }) => data,
    (error) => {
      if (error.status === 404) return null;
      throw error;
    },
  );
  if (!current) {
    await summary.addRaw(`Branch \`release/${version}\` is already absent.\n`).write();
    return;
  }
  if (current.object.sha !== sha) {
    await summary
      .addRaw(`Kept \`release/${version}\`: the branch advanced past the failed run; its newest attempt owns it.\n`)
      .write();
    return;
  }
  await summary
    .addRaw(
      `Kept \`release/${version}\` at ${sha} for recovery. Re-run failed jobs or dispatch release from the same main snapshot.\n`,
    )
    .write();
}

function preparationTargets(context) {
  requireValue(
    context.eventName === "workflow_dispatch" && context.workflow === "release" && context.ref === "refs/heads/main",
    "Preparation cleanup is allowed only from the main release dispatch",
  );
  requireValue(Number.isSafeInteger(context.runId) && context.runId > 0, "Invalid preparation run");
  return context.runId;
}

async function preparation({ github, context, core }) {
  const runId = preparationTargets(context);
  const summary = core.summary.addHeading("Failed release cleanup: preparation", 3);
  const branches = await github.paginate(github.rest.repos.listBranches, { ...context.repo, per_page: 100 });
  const orphans = [];
  for (const branch of branches.filter((item) => item.name.startsWith("release/"))) {
    const version = branch.name.slice("release/".length);
    if (!releaseTag.test(`v${version}`)) continue;
    const manifest = await github.rest.repos
      .getContent({ ...context.repo, path: "release.json", ref: branch.name })
      .then(
        ({ data }) => data,
        (error) => {
          if (error.status === 404) return null;
          throw error;
        },
      );
    if (manifest?.encoding !== "base64") continue;
    const prepared = JSON.parse(Buffer.from(manifest.content, "base64").toString("utf8"));
    if (prepared.preparation_run === runId) orphans.push(version);
  }
  if (!orphans.length) {
    await summary.addRaw(`No release branch from preparation run ${runId}; nothing to retain.\n`).write();
    return;
  }
  for (const version of orphans) {
    if (await published(github, context.repo, version)) {
      await summary.addRaw(`Kept \`release/${version}\`: \`v${version}\` already exists.\n`);
      continue;
    }
    await summary.addRaw(`Kept \`release/${version}\` for recovery; preparation retries reuse its frozen commit.\n`);
  }
  await summary.write();
}

module.exports = {
  CleanupError,
  targets,
  preparationTargets,
  published,
  branch,
  preparation,
};
