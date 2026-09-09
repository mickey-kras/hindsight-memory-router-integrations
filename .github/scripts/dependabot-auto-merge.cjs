const { execFileSync } = require('node:child_process');

const BOT = { login: 'dependabot[bot]', id: 49699333 };

function isDependabot(user) {
  return user?.login === BOT.login && user?.id === BOT.id;
}

function verifiedCommits(commits) {
  return commits.length > 0 && commits.every(c => isDependabot(c.author) && c.commit.verification?.verified);
}

function trustedPull(pull, repository, branch) {
  return isDependabot(pull.user) && pull.state === 'open' && !pull.draft &&
    pull.head.repo?.full_name === repository && pull.head.ref.startsWith('dependabot/') &&
    pull.base.ref === branch;
}

function mergeCommand(repository, number, options) {
  execFileSync('gh', ['pr', 'merge', String(number), '--repo', repository, ...options], {
    timeout: 30000,
    stdio: 'pipe',
  });
}

async function ensureMainRun({ github, context, core, branch, mainWorkflow }) {
  const repo = context.repo;
  const { data: tip } = await github.rest.repos.getBranch({ ...repo, branch });
  const sha = tip.commit.sha;
  const pulls = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
    ...repo, commit_sha: sha, per_page: 100,
  });
  if (!pulls.some(p => isDependabot(p.user) && p.merged_at && p.merge_commit_sha === sha && p.base.ref === branch)) return;
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...repo, workflow_id: mainWorkflow, branch, head_sha: sha, per_page: 100,
  });
  if (runs.some(r => r.head_sha === sha && ['push', 'workflow_dispatch'].includes(r.event) &&
      !['cancelled', 'skipped'].includes(r.conclusion))) return;
  await github.rest.actions.createWorkflowDispatch({ ...repo, workflow_id: mainWorkflow, ref: branch });
  core.info(`Requested ${mainWorkflow} for the Dependabot merge at ${sha}`);
}

async function run({ github, context, core, mainWorkflow, merge = mergeCommand }) {
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const { data: repo } = await github.rest.repos.get(context.repo);
  const branch = repo.default_branch;
  // Dispatches from a work branch must never run merge automation.
  if (!['pull_request_target', 'workflow_call'].includes(context.eventName) &&
      context.ref !== `refs/heads/${branch}`) throw new Error('Automation requires the default branch');
  const number = context.payload.pull_request?.number;
  const pulls = number ? [{ number }] : await github.paginate(github.rest.pulls.list, {
    ...context.repo, state: 'open', base: branch, per_page: 100,
  });
  let failed = false;
  for (const candidate of pulls) {
    try {
      const params = { ...context.repo, pull_number: candidate.number };
      const { data: pull } = await github.rest.pulls.get(params);
      if (!trustedPull(pull, repository, branch)) continue;
      if (pull.auto_merge) {
        core.info(`#${pull.number}: auto-merge is already enabled`);
        continue;
      }
      const commits = await github.paginate(github.rest.pulls.listCommits, { ...params, per_page: 100 });
      if (!verifiedCommits(commits)) {
        core.info(`#${pull.number}: unsigned or non-Dependabot commits require manual review`);
        continue;
      }
      const { data: current } = await github.rest.pulls.get(params);
      if (!trustedPull(current, repository, branch) || current.head.sha !== pull.head.sha) {
        core.info(`#${pull.number}: changed during evaluation; retry on the next event or refresh`);
        continue;
      }
      merge(repository, pull.number, ['--auto', '--squash', '--match-head-commit', pull.head.sha]);
      core.info(`#${pull.number}: verified Dependabot update queued for squash merge`);
    } catch (error) {
      failed = true;
      core.warning(`#${candidate.number}: auto-merge evaluation failed (${error.name}); left for retry`);
    }
  }
  await ensureMainRun({ github, context, core, branch, mainWorkflow });
  if (failed) core.setFailed('Some Dependabot PRs could not be evaluated; see warnings');
}

module.exports = { run, trustedPull, verifiedCommits, ensureMainRun };
