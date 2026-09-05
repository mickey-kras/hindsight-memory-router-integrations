const test = require('node:test');
const assert = require('node:assert/strict');
const { run, eligibility, trustedPull, readDependencies, ensureMainRun } = require('./dependabot-auto-merge.cjs');

const bot = { login: 'dependabot[bot]', id: 49699333 };
const commits = [{ author: bot, commit: { verification: { verified: true } } }];
const dependency = { updateType: 'version-update:semver-patch', prevVersion: '1.0.0', newVersion: '1.0.1', compatScore: 75 };
const pull = {
  number: 1, user: bot, state: 'open', draft: false,
  head: { sha: 'a'.repeat(40), ref: 'dependabot/npm_and_yarn/example-1.0.1', repo: { full_name: 'owner/repo' } },
  base: { ref: 'main' },
};

for (const score of [75, 80, 100]) {
  test(`accepts known score ${score}`, () => assert.equal(eligibility(commits, [{ ...dependency, compatScore: score }]), null));
}
for (const score of [74, 0, undefined, null, '75', NaN, 101, 75.5]) {
  test(`rejects low or invalid score ${String(score)}`, () => assert.ok(eligibility(commits, [{ ...dependency, compatScore: score }])));
}
test('every grouped dependency must pass', () => {
  assert.ok(eligibility(commits, [{ ...dependency, compatScore: 100 }, { ...dependency, compatScore: 74 }]));
  assert.ok(eligibility(commits, [{ ...dependency, compatScore: 100 }, { ...dependency, compatScore: 0 }]));
});
test('major, empty metadata and missing version pairs stay manual', () => {
  assert.ok(eligibility(commits, [{ ...dependency, updateType: 'version-update:semver-major', compatScore: 100 }]));
  assert.ok(eligibility(commits, []));
  assert.ok(eligibility(commits, [{ ...dependency, prevVersion: '' }]));
});
test('all commits must have verified Dependabot authors', () => {
  assert.ok(eligibility([], [dependency]));
  assert.ok(eligibility([...commits, { author: { login: 'owner', id: 1 }, commit: { verification: { verified: true } } }], [dependency]));
  assert.ok(eligibility([{ author: bot, commit: { verification: { verified: false } } }], [dependency]));
});
test('requires exact bot identity, origin, base and non-draft state', () => {
  assert.ok(trustedPull(pull, 'owner/repo', 'main'));
  for (const change of [
    { user: { ...bot, id: 1 } }, { state: 'closed' }, { draft: true },
    { head: { ...pull.head, repo: { full_name: 'fork/repo' } } },
    { head: { ...pull.head, ref: 'feat/update' } }, { base: { ref: 'release' } },
  ]) assert.equal(trustedPull({ ...pull, ...change }, 'owner/repo', 'main'), false);
});
test('reads upstream multiline output and rejects missing/truncated data', () => {
  const output = `other=value\r\nupdated-dependencies-json<<ghadelimiter_example\r\n${JSON.stringify([dependency])}\r\nghadelimiter_example\r\n`;
  assert.deepEqual(readDependencies(output), [dependency]);
  assert.throws(() => readDependencies(''));
  assert.throws(() => readDependencies('updated-dependencies-json<<x\n[]\n'));
});

function harness({ pulls = [pull], afterLookup, metadataError = false, runs = [], associated = [], event = 'schedule' } = {}) {
  const commands = [], dispatches = [], warnings = [], failures = [];
  let reads = 0;
  const endpoints = Object.fromEntries(['getRepo', 'getBranch', 'getPull', 'listPulls', 'listCommits', 'associated', 'runs', 'dispatch'].map(k => [k, { name: k }]));
  const github = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        getBranch: async () => ({ data: { commit: { sha: 'b'.repeat(40) } } }),
        listPullRequestsAssociatedWithCommit: endpoints.associated,
      },
      pulls: {
        get: async ({ pull_number }) => ({ data: (++reads > 1 && afterLookup) || pulls.find(p => p.number === pull_number) }),
        list: endpoints.listPulls, listCommits: endpoints.listCommits,
      },
      actions: {
        listWorkflowRuns: endpoints.runs,
        createWorkflowDispatch: async input => dispatches.push(input),
      },
    },
    paginate: async endpoint => {
      if (endpoint === endpoints.listPulls) return pulls;
      if (endpoint === endpoints.listCommits) return commits;
      if (endpoint === endpoints.associated) return associated;
      if (endpoint === endpoints.runs) return runs;
      throw new Error('Unexpected endpoint');
    },
  };
  const options = {
    github,
    context: { repo: { owner: 'owner', repo: 'repo' }, eventName: event, ref: 'refs/heads/main', payload: event === 'pull_request_target' ? { pull_request: pull } : {} },
    core: { info() {}, warning: text => warnings.push(text), setFailed: text => failures.push(text) },
    metadataPath: '/unused', mainWorkflow: 'publish.yml',
    metadata: () => { if (metadataError) throw new Error('unavailable'); return [dependency]; },
    merge: (...args) => commands.push(args),
  };
  return { options, commands, dispatches, warnings, failures };
}
for (const event of ['pull_request_target', 'schedule', 'workflow_dispatch']) {
  test(`${event} applies the same policy and matches the evaluated SHA`, async () => {
    const h = harness({ event }); await run(h.options);
    assert.deepEqual(h.commands, [['owner/repo', 1, ['--auto', '--squash', '--match-head-commit', pull.head.sha]]]);
  });
}
test('a changed head cannot be queued', async () => {
  const h = harness({ afterLookup: { ...pull, head: { ...pull.head, sha: 'c'.repeat(40) } } });
  await run(h.options); assert.deepEqual(h.commands, []);
});
test('lookup failure revokes an earlier bot queue decision', async () => {
  const h = harness({ pulls: [{ ...pull, auto_merge: { enabled_by: { login: 'github-actions[bot]' } } }], metadataError: true });
  await run(h.options);
  assert.deepEqual(h.commands, [['owner/repo', 1, ['--disable-auto']]]);
  assert.equal(h.failures.length, 1);
});
test('manual owner queue decisions are preserved', async () => {
  const h = harness({ pulls: [{ ...pull, auto_merge: { enabled_by: { login: 'owner' } } }] });
  await run(h.options); assert.deepEqual(h.commands, []);
});
test('a failed PR does not prevent evaluation of the next PR', async () => {
  const h = harness({ pulls: [pull, { ...pull, number: 2 }] });
  h.options.metadata = p => { if (p.number === 1) throw new Error('unavailable'); return [dependency]; };
  await run(h.options); assert.equal(h.commands[0][1], 2); assert.equal(h.failures.length, 1);
});
test('dispatch from a work branch cannot merge', async () => {
  const h = harness({ event: 'workflow_dispatch' }); h.options.context.ref = 'refs/heads/feat/test';
  await assert.rejects(run(h.options), /default branch/); assert.deepEqual(h.commands, []);
});
const associated = [{ ...pull, merged_at: '2026-09-04T00:00:00Z', merge_commit_sha: 'b'.repeat(40) }];
test('dispatches missing main validation only after a confirmed Dependabot merge', async () => {
  const h = harness({ associated });
  await ensureMainRun({ ...h.options, branch: 'main' });
  assert.deepEqual(h.dispatches, [{ owner: 'owner', repo: 'repo', workflow_id: 'publish.yml', ref: 'main' }]);
  const noMerge = harness(); await ensureMainRun({ ...noMerge.options, branch: 'main' });
  assert.deepEqual(noMerge.dispatches, []);
});
for (const conclusion of [null, 'success', 'failure']) {
  test(`does not duplicate existing main run (${conclusion})`, async () => {
    const h = harness({ associated, runs: [{ head_sha: 'b'.repeat(40), event: 'workflow_dispatch', conclusion }] });
    await ensureMainRun({ ...h.options, branch: 'main' }); assert.deepEqual(h.dispatches, []);
  });
}
