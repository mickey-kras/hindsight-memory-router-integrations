// Removes the orphaned state of a failed release run: the protected release
// branch. Integrations releases publish tarballs as immutable-release assets,
// so there are no registry tags to remove; the tag/draft-release state a
// half-finished finalize leaves behind is resumable and must be kept. Strictly
// scoped to the release branch of the failed run's version. Never touches tags,
// releases, assets, attestations, or any other branch. Every target is
// best-effort: failures are logged, never thrown, so cleanup can never mask the
// original release failure.

const releaseTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitSha = /^[a-f0-9]{40}$/;

class CleanupError extends Error {}

function requireValue(condition, message) {
  if (!condition) throw new CleanupError(message);
}

function targets(context) {
  requireValue(
    context.eventName === "push" && context.workflow === "release" && context.ref.startsWith("refs/heads/release/"),
    "Cleanup is allowed only through the release workflow",
  );
  const version = context.ref.slice("refs/heads/release/".length);
  requireValue(releaseTag.test(`v${version}`), "Invalid release branch version");
  requireValue(commitSha.test(context.sha), "Invalid release commit");
  return { version, sha: context.sha };
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

async function attempt(core, summary, name, action) {
  try {
    const removed = await action();
    const detail = removed.length
      ? `deleted ${removed.map((item) => `\`${item}\``).join(", ")}`
      : "nothing left to delete";
    await summary.addRaw(`- ${name}: ${detail}\n`);
  } catch (error) {
    core.error(`${name} cleanup failed: ${error.message}`);
    await summary.addRaw(`- ${name}: **failed** (${error.message}); remove the leftover manually\n`);
  }
}

async function branch({ github, context, core }) {
  const { version } = targets(context);
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
  if (current.object.sha !== context.sha) {
    await summary
      .addRaw(`Kept \`release/${version}\`: the branch advanced past the failed run; its newest attempt owns it.\n`)
      .write();
    return;
  }
  await attempt(core, summary, `Branch \`release/${version}\``, async () => {
    await github.rest.git.deleteRef({ ...context.repo, ref });
    return [ref];
  });
  await summary.write();
}

module.exports = {
  CleanupError,
  targets,
  published,
  branch,
};
