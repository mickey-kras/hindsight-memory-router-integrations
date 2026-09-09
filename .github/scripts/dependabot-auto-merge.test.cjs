const test = require('node:test');
const assert = require('node:assert/strict');
const { run, trustedPull, verifiedCommits, ensureMainRun } = require('./dependabot-auto-merge.cjs');

const bot = { login: 'dependabot[bot]', id: 49699333 };
const commits = [{ author: bot, commit: { verification: { verified: true } } }];
const pull = {
  number: 1, user: bot, state: 'open', draft: false,
  head: { sha: 'a'.repeat(40), ref: 'dependabot/npm_and_yarn/example-1.0.1', repo: { full_name: 'owner/repo' } },
  base: { ref: 'main' },
};

test('all commits must have verified Dependabot authors', () => {
  assert.equal(verifiedCommits(commits), true);
  assert.equal(verifiedCommits([]), false);
  assert.equal(verifiedCommits([
    ...commits,
    { author: { login: 'owner', id: 1 }, commit: { verification: { verified: true } } },
  ]), false);
  assert.equal(verifiedCommits([
    { author: bot, commit: { verification: { verified: false } } },
  ]), false);
});

test('requires exact bot identity, origin, base and non-draft state', () => {
  assert.ok(trustedPull(pull, 'owner/repo', 'main'));
  for (const change of [
    { user: { ...bot, id: 1 } }, { state: 'closed' }, { draft: true },
    { head: { ...pull.head, repo: { full_name: 'fork/repo' } } },
    { head: { ...pull.head, ref: 'feat/update' } }, { base: { ref: 'release' } },
  ]) assert.equal(trustedPull({ ...pull, ...change }, 'owner/repo', 'main'), false);
});

function harness({ pulls = [pull], afterLookup, commitErrorFor, runs = [], associated = [], event = 'schedule' } = {}) {
  const commands = [], dispatches = [], warnings = [], failures = [];
  let reads = 0;
  const endpoints = Object.fromEntries([
    'getRepo', 'getBranch', 'getPull', 'listPulls', 'listCommits', 'associated', 'runs', 'dispatch',
  ].map(key => [key, { name: key }]));
  const github = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        getBranch: async () => ({ data: { commit: { sha: 'b'.repeat(40) } } }),
        listPullRequestsAssociatedWithCommit: endpoints.associated,
      },
      pulls: {
        get: async ({ pull_number }) => ({
          data: (++reads > 1 && afterLookup) || pulls.find(candidate => candidate.number === pull_number),
        }),
        list: endpoints.listPulls,
        listCommits: endpoints.listCommits,
      },
      actions: {
        listWorkflowRuns: endpoints.runs,
        createWorkflowDispatch: async input => dispatches.push(input),
      },
    },
    paginate: async (endpoint, args) => {
      if (endpoint === endpoints.listPulls) return pulls;
      if (endpoint === endpoints.listCommits) {
        if (args.pull_number === commitErrorFor) throw new Error('unavailable');
        return commits;
      }
      if (endpoint === endpoints.associated) return associated;
      if (endpoint === endpoints.runs) return runs;
      throw new Error('Unexpected endpoint');
    },
  };
  const options = {
    github,
    context: {
      repo: { owner: 'owner', repo: 'repo' }, eventName: event, ref: 'refs/heads/main',
      payload: event === 'pull_request_target' ? { pull_request: pull } : {},
    },
    core: {
      info() {}, warning: text => warnings.push(text), setFailed: text => failures.push(text),
    },
    mainWorkflow: 'main.yml',
    merge: (...args) => commands.push(args),
  };
  return { options, commands, dispatches, warnings, failures };
}

for (const event of ['pull_request_target', 'schedule', 'workflow_dispatch']) {
  test(`${event} queues every verified update and matches the evaluated SHA`, async () => {
    const h = harness({ event });
    await run(h.options);
    assert.deepEqual(h.commands, [[
      'owner/repo', 1, ['--auto', '--squash', '--match-head-commit', pull.head.sha],
    ]]);
  });
}

test('a changed head cannot be queued', async () => {
  const h = harness({ afterLookup: { ...pull, head: { ...pull.head, sha: 'c'.repeat(40) } } });
  await run(h.options);
  assert.deepEqual(h.commands, []);
});

test('an existing auto-merge decision is preserved without redundant commands', async () => {
  const h = harness({
    pulls: [{ ...pull, auto_merge: { enabled_by: { login: 'github-actions[bot]' } } }],
  });
  await run(h.options);
  assert.deepEqual(h.commands, []);
});

test('a failed PR does not prevent evaluation of the next PR', async () => {
  const h = harness({ pulls: [pull, { ...pull, number: 2 }], commitErrorFor: 1 });
  await run(h.options);
  assert.equal(h.commands[0][1], 2);
  assert.equal(h.failures.length, 1);
});

test('dispatch from a work branch cannot merge', async () => {
  const h = harness({ event: 'workflow_dispatch' });
  h.options.context.ref = 'refs/heads/feat/test';
  await assert.rejects(run(h.options), /default branch/);
  assert.deepEqual(h.commands, []);
});

const associated = [{
  ...pull, merged_at: '2026-09-04T00:00:00Z', merge_commit_sha: 'b'.repeat(40),
}];

test('dispatches missing main validation only after a confirmed Dependabot merge', async () => {
  const h = harness({ associated });
  await ensureMainRun({ ...h.options, branch: 'main' });
  assert.deepEqual(h.dispatches, [
    { owner: 'owner', repo: 'repo', workflow_id: 'main.yml', ref: 'main' },
  ]);
  const noMerge = harness();
  await ensureMainRun({ ...noMerge.options, branch: 'main' });
  assert.deepEqual(noMerge.dispatches, []);
});

test('closed Dependabot merge dispatches missing main validation', async () => {
  const closed = { ...pull, state: 'closed' };
  const h = harness({
    event: 'pull_request_target',
    pulls: [closed],
    associated: [{
      ...closed, merged_at: '2026-09-08T00:00:00Z', merge_commit_sha: 'b'.repeat(40),
    }],
  });
  h.options.context.payload.pull_request = closed;
  await run(h.options);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.dispatches, [
    { owner: 'owner', repo: 'repo', workflow_id: 'main.yml', ref: 'main' },
  ]);
});

for (const conclusion of [null, 'success', 'failure']) {
  test(`does not duplicate existing main run (${conclusion})`, async () => {
    const h = harness({
      associated,
      runs: [{ head_sha: 'b'.repeat(40), event: 'workflow_dispatch', conclusion }],
    });
    await ensureMainRun({ ...h.options, branch: 'main' });
    assert.deepEqual(h.dispatches, []);
  });
}
