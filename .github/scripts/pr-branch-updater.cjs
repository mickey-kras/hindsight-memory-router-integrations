const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function updatePull({ github, owner, repo, number, sleep }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: pull } = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: number,
    });
    if (pull.state !== "open" || pull.base.ref !== "main" || pull.head.repo?.full_name !== `${owner}/${repo}`)
      return "ineligible";
    // PR base metadata can lag behind the branch tip after a merge.
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
    // With the PR head as the comparison base, ahead_by counts missing main commits.
    if (comparison.ahead_by === 0) return "current";
    if (!Number.isInteger(comparison.ahead_by) || comparison.ahead_by < 0) throw new Error("invalid commit comparison");
    // Scheduled Dependabot runs rebase with Dependabot's own identity. Bot-posted
    // recreate commands are rejected, so stale Dependabot branches are left to them.
    if (pull.user?.login === "dependabot[bot]" && pull.user.id === 49699333)
      return "managed by scheduled Dependabot rebasing";
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

async function run({ github, context, core, sleep = pause }) {
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
          ? await updatePull({ github, owner, repo, number: pull.number, sleep })
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
