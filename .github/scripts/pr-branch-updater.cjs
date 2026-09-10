const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { dependencyCommits, requestRecreate } = require("./dependabot-preparation.cjs");

async function updatePull({ github, context, core, owner, repo, number, sleep, verify, recreate }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: pull } = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: number,
    });
    if (pull.state !== "open" || pull.base.ref !== "main" || pull.head.repo?.full_name !== `${owner}/${repo}`)
      return "ineligible";
    // Keep Dependabot as the author by asking it to recreate the branch. This
    // preserves the signed-commit and generated-artifact checks used by auto-merge.
    if (pull.user?.login === "dependabot[bot]" && pull.user.id === 49699333) {
      const commits = await github.paginate(github.rest.pulls.listCommits, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });
      await verify(github, context.repo, pull, commits);
      return (await recreate(github, context, pull, core)) ? "recreate requested" : "current";
    }
    const { data: main } = await github.rest.git.getRef({
      owner,
      repo,
      ref: "heads/main",
    });
    const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${pull.head.sha}...${main.object.sha}`,
    });
    if (comparison.ahead_by === 0) return "current";
    if (!Number.isInteger(comparison.ahead_by) || comparison.ahead_by < 0) throw new Error("invalid commit comparison");
    if (pull.mergeable === false) return "conflicting";
    if (pull.mergeable === true) {
      await github.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch", {
        owner,
        repo,
        pull_number: number,
        expected_head_sha: pull.head.sha,
      });
      return "update requested";
    }
    if (attempt < 3) await sleep(5000);
  }
  throw new Error("mergeability remained unknown after 4 attempts");
}

async function run({ github, context, core, sleep = pause, verify = dependencyCommits, recreate = requestRecreate }) {
  const { owner, repo } = context.repo;
  const pulls = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    base: "main",
    per_page: 100,
  });
  const results = [];
  let unresolved = 0;
  for (const pull of pulls) {
    let status;
    try {
      status =
        pull.head.repo?.full_name === `${owner}/${repo}`
          ? await updatePull({
              github,
              owner,
              repo,
              number: pull.number,
              sleep,
              context,
              core,
              verify,
              recreate,
            })
          : "ineligible";
    } catch (error) {
      status = `unresolved: ${error.message}`;
      unresolved++;
    }
    core.info(`#${pull.number}: ${status}`);
    results.push([String(pull.number), status]);
  }
  await core.summary
    .addHeading("PR branch updates")
    .addTable([
      [
        { data: "PR", header: true },
        { data: "Result", header: true },
      ],
      ...results,
    ])
    .write();
  if (unresolved) core.setFailed(`${unresolved} PR branch update(s) unresolved`);
}

module.exports = { run };
