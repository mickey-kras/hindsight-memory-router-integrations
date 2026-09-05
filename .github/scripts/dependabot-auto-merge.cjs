const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const MINIMUM_SCORE = 75;
const BOT = { login: 'dependabot[bot]', id: 49699333 };
const UPDATE_TYPES = new Set(['version-update:semver-patch', 'version-update:semver-minor']);

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

function eligibility(commits, dependencies) {
  if (!verifiedCommits(commits)) {
    return 'Unsigned or non-Dependabot commits require manual review';
  }
  if (!Array.isArray(dependencies) || !dependencies.length) return 'No dependency metadata';
  for (const dependency of dependencies) {
    if (!UPDATE_TYPES.has(dependency.updateType)) return 'Major or unknown update type requires manual review';
    if (!dependency.prevVersion || !dependency.newVersion) return 'Missing version pair';
    const score = dependency.compatScore;
    if (!Number.isInteger(score) || score < MINIMUM_SCORE || score > 100) {
      return `Every dependency needs a known compatibility score of at least ${MINIMUM_SCORE}%`;
    }
  }
  return null;
}

function readDependencies(output) {
  const lines = output.split(/\r?\n/);
  const marker = 'updated-dependencies-json<<';
  const start = lines.findIndex(line => line.startsWith(marker));
  if (start < 0) throw new Error('Metadata action did not return dependency details');
  const delimiter = lines[start].slice(marker.length);
  const end = lines.indexOf(delimiter, start + 1);
  if (!delimiter || end < 0) throw new Error('Incomplete metadata output');
  return JSON.parse(lines.slice(start + 1, end).join('\n'));
}

// Run the pinned upstream action bundle with the authenticated PR payload.
// This also supports scheduled refreshes without reimplementing its parser.
function fetchMetadata(pull, repository, metadataPath) {
  const directory = mkdtempSync(join(tmpdir(), 'dependabot-metadata-'));
  try {
    const event = join(directory, 'event.json');
    const output = join(directory, 'output');
    writeFileSync(event, JSON.stringify({ pull_request: pull }));
    writeFileSync(output, '');
    execFileSync(process.execPath, [join(metadataPath, 'dist/index.js')], {
      timeout: 90000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: repository,
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output,
        'INPUT_GITHUB-TOKEN': process.env.GH_TOKEN,
        'INPUT_COMPAT-LOOKUP': 'true',
        'INPUT_ALERT-LOOKUP': '',
        'INPUT_SKIP-VERIFICATION': 'false',
        'INPUT_SKIP-COMMIT-VERIFICATION': 'false',
      },
    });
    return readDependencies(readFileSync(output, 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

async function run({ github, context, core, metadataPath, mainWorkflow,
  metadata = fetchMetadata, merge = mergeCommand }) {
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
      // A previous bot decision must not survive a failed or lower-score lookup.
      if (pull.auto_merge?.enabled_by.login === 'github-actions[bot]') {
        merge(repository, pull.number, ['--disable-auto']);
      } else if (pull.auto_merge) {
        core.info(`#${pull.number}: preserving the owner's manual auto-merge decision`);
        continue;
      }
      const commits = await github.paginate(github.rest.pulls.listCommits, { ...params, per_page: 100 });
      if (!verifiedCommits(commits)) {
        core.info(`#${pull.number}: unsigned or non-Dependabot commits require manual review`);
        continue;
      }
      const dependencies = metadata(pull, repository, metadataPath);
      const reason = eligibility(commits, dependencies);
      if (reason) {
        core.info(`#${pull.number}: ${reason}`);
        continue;
      }
      const { data: current } = await github.rest.pulls.get(params);
      if (!trustedPull(current, repository, branch) || current.head.sha !== pull.head.sha) {
        core.info(`#${pull.number}: changed during evaluation; retry on the next event or refresh`);
        continue;
      }
      merge(repository, pull.number, ['--auto', '--squash', '--match-head-commit', pull.head.sha]);
      core.info(`#${pull.number}: eligible, minimum score ${Math.min(...dependencies.map(d => d.compatScore))}%`);
    } catch (error) {
      failed = true;
      core.warning(`#${candidate.number}: auto-merge evaluation failed (${error.name}); left for retry`);
    }
  }
  await ensureMainRun({ github, context, core, branch, mainWorkflow });
  if (failed) core.setFailed('Some Dependabot PRs could not be evaluated; see warnings');
}

module.exports = { run, eligibility, trustedPull, readDependencies, ensureMainRun, fetchMetadata };
