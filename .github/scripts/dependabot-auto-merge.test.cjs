const test = require("node:test");
const assert = require("node:assert/strict");
const { run, eligibility, trustedPull, readDependencies, ensureMainRun } = require("./dependabot-auto-merge.cjs");

const bot = { login: "dependabot[bot]", id: 49699333 };
const commits = [{ author: bot, commit: { verification: { verified: true } } }];
const dependency = {
  updateType: "version-update:semver-patch",
  prevVersion: "1.0.0",
  newVersion: "1.0.1",
  compatScore: 75,
};
const pull = {
  number: 1,
  user: bot,
  state: "open",
  draft: false,
  head: {
    sha: "a".repeat(40),
    ref: "dependabot/npm_and_yarn/example-1.0.1",
    repo: { full_name: "owner/repo" },
  },
  base: { ref: "main", sha: "b".repeat(40) },
};

for (const score of [75, 80, 100]) {
  test(`accepts known score ${score}`, () =>
    assert.equal(eligibility(commits, [{ ...dependency, compatScore: score }]), null));
}
for (const score of [74, 0, undefined, null, "75", NaN, 101, 75.5]) {
  test(`rejects low or invalid score ${String(score)}`, () =>
    assert.ok(eligibility(commits, [{ ...dependency, compatScore: score }])));
}
test("every grouped dependency must pass", () => {
  assert.ok(
    eligibility(commits, [
      { ...dependency, compatScore: 100 },
      { ...dependency, compatScore: 74 },
    ]),
  );
  assert.ok(
    eligibility(commits, [
      { ...dependency, compatScore: 100 },
      { ...dependency, compatScore: 0 },
    ]),
  );
});
test("major, empty metadata and missing version pairs stay manual", () => {
  assert.ok(
    eligibility(commits, [
      {
        ...dependency,
        updateType: "version-update:semver-major",
        compatScore: 100,
      },
    ]),
  );
  assert.ok(eligibility(commits, []));
  assert.ok(eligibility(commits, [{ ...dependency, prevVersion: "" }]));
});
test("all commits must have verified Dependabot authors", () => {
  assert.ok(eligibility([], [dependency]));
  assert.ok(
    eligibility(
      [
        ...commits,
        {
          author: { login: "owner", id: 1 },
          commit: { verification: { verified: true } },
        },
      ],
      [dependency],
    ),
  );
  assert.ok(eligibility([{ author: bot, commit: { verification: { verified: false } } }], [dependency]));
});
test("requires exact bot identity, origin, base and non-draft state", () => {
  assert.ok(trustedPull(pull, "owner/repo", "main"));
  for (const change of [
    { user: { ...bot, id: 1 } },
    { state: "closed" },
    { draft: true },
    { head: { ...pull.head, repo: { full_name: "fork/repo" } } },
    { head: { ...pull.head, ref: "feat/update" } },
    { base: { ref: "release" } },
  ])
    assert.equal(trustedPull({ ...pull, ...change }, "owner/repo", "main"), false);
});
test("reads upstream multiline output and rejects missing/truncated data", () => {
  const output = `other=value\r\nupdated-dependencies-json<<ghadelimiter_example\r\n${JSON.stringify([dependency])}\r\nghadelimiter_example\r\n`;
  assert.deepEqual(readDependencies(output), [dependency]);
  assert.throws(() => readDependencies(""));
  assert.throws(() => readDependencies("updated-dependencies-json<<x\n[]\n"));
});

const validationRun = {
  id: 100,
  run_attempt: 1,
  updated_at: "2026-10-14T05:10:00Z",
  head_sha: pull.head.sha,
  head_branch: pull.head.ref,
  event: "pull_request",
  status: "completed",
  conclusion: "success",
};
const validationJobs = [
  "guard",
  "quality / checks",
  "quality / release combination",
  "aislop / aislop status",
  "codeql / analyze",
  "branch-policy / branch name",
  "dependabot-policy / policy-tests",
].map((name) => ({ name, status: "completed", conclusion: "success" }));

function harness({
  pulls = [pull],
  afterLookup,
  metadataError = false,
  runs = [],
  associated = [],
  event = "schedule",
  validationRuns = [validationRun],
  jobs = validationJobs,
  afterValidationLookup,
} = {}) {
  const commands = [],
    dispatches = [],
    warnings = [],
    failures = [],
    requests = [];
  let reads = 0;
  let validationReads = 0;
  const endpoints = Object.fromEntries(
    ["getRepo", "getBranch", "getPull", "listPulls", "listCommits", "associated", "runs", "jobs", "dispatch"].map(
      (k) => [k, { name: k }],
    ),
  );
  const github = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getBranch: async () => ({ data: { commit: { sha: "b".repeat(40) } } }),
        listPullRequestsAssociatedWithCommit: endpoints.associated,
      },
      pulls: {
        get: async ({ pull_number }) => ({
          data: (++reads > 1 && afterLookup) || pulls.find((p) => p.number === pull_number),
        }),
        list: endpoints.listPulls,
        listCommits: endpoints.listCommits,
      },
      actions: {
        listWorkflowRuns: endpoints.runs,
        listJobsForWorkflowRun: endpoints.jobs,
        createWorkflowDispatch: async (input) => dispatches.push(input),
      },
    },
    paginate: async (endpoint, input) => {
      requests.push({ endpoint: endpoint.name, input });
      if (endpoint === endpoints.listPulls) return pulls;
      if (endpoint === endpoints.listCommits) return commits;
      if (endpoint === endpoints.associated) return associated;
      if (endpoint === endpoints.runs) {
        if (input.workflow_id === "pr-validation.yml") {
          return (++validationReads > 1 && afterValidationLookup) || validationRuns;
        }
        return runs;
      }
      if (endpoint === endpoints.jobs) return jobs;
      throw new Error("Unexpected endpoint");
    },
  };
  const options = {
    github,
    context: {
      repo: { owner: "owner", repo: "repo" },
      eventName: event,
      ref: "refs/heads/main",
      payload: event === "pull_request_target" ? { pull_request: pull } : {},
    },
    core: {
      info() {},
      warning: (text) => warnings.push(text),
      setFailed: (text) => failures.push(text),
    },
    metadataPath: "/unused",
    mainWorkflow: "publish.yml",
    metadata: () => {
      if (metadataError) throw new Error("unavailable");
      return [dependency];
    },
    merge: (...args) => commands.push(args),
    prepare: async () => false,
    prepareDocker: async () => false,
    isCurrent: async () => true,
  };
  return { options, commands, dispatches, warnings, failures, requests };
}
for (const event of ["pull_request_target", "schedule", "workflow_dispatch"]) {
  test(`${event} applies the same policy and matches the evaluated SHA`, async () => {
    const h = harness({ event });
    await run(h.options);
    assert.deepEqual(h.commands, [["owner/repo", 1, ["--auto", "--squash", "--match-head-commit", pull.head.sha]]]);
  });
}
test("a changed head cannot be queued", async () => {
  const h = harness({
    afterLookup: { ...pull, head: { ...pull.head, sha: "c".repeat(40) } },
  });
  await run(h.options);
  assert.deepEqual(h.commands, []);
});

test("a changed base cannot be queued", async () => {
  const h = harness({ afterLookup: { ...pull, base: { ...pull.base, sha: "c".repeat(40) } } });
  await run(h.options);
  assert.deepEqual(h.commands, []);
});
test("main ancestry is checked again after validation before queuing", async () => {
  const h = harness();
  let comparisons = 0;
  h.options.isCurrent = async () => ++comparisons === 1;
  await run(h.options);
  assert.equal(comparisons, 2);
  assert.deepEqual(h.commands, []);
});

for (const validationRuns of [
  [],
  [{ ...validationRun, head_sha: "c".repeat(40) }],
  [{ ...validationRun, head_branch: "feat/unrelated" }],
  [{ ...validationRun, event: "push" }],
  [{ ...validationRun, status: "queued", conclusion: null }],
  [{ ...validationRun, status: "in_progress", conclusion: null, run_attempt: 2 }],
  [{ ...validationRun, conclusion: "failure" }],
  [{ ...validationRun, conclusion: "cancelled" }],
]) {
  test(`incomplete or unrelated validation cannot queue (${JSON.stringify(validationRuns)})`, async () => {
    const h = harness({ validationRuns });
    await run(h.options);
    assert.deepEqual(h.commands, []);
    assert.deepEqual(h.failures, []);
  });
}

for (const name of ["quality / release combination", "dependabot-policy / policy-tests"]) {
  for (const conclusion of ["failure", "skipped", null]) {
    test(`workflow success cannot hide ${name} ${conclusion}`, async () => {
      const h = harness({
        jobs: validationJobs.map((job) =>
          job.name === name ? { ...job, status: conclusion === null ? "in_progress" : "completed", conclusion } : job,
        ),
      });
      await run(h.options);
      assert.deepEqual(h.commands, []);
    });
  }
  test(`missing ${name} prevents auto-merge`, async () => {
    const h = harness({ jobs: validationJobs.filter((job) => job.name !== name) });
    await run(h.options);
    assert.deepEqual(h.commands, []);
  });
}

test("duplicate job names and additional failed jobs prevent auto-merge", async () => {
  for (const jobs of [
    [...validationJobs, validationJobs[0]],
    [...validationJobs, { name: "new gate", status: "completed", conclusion: "failure" }],
  ]) {
    const h = harness({ jobs });
    await run(h.options);
    assert.deepEqual(h.commands, []);
  }
});
test("the newest applicable run blocks an older passing run", async () => {
  const h = harness({
    validationRuns: [validationRun, { ...validationRun, id: 101, status: "in_progress", conclusion: null }],
  });
  await run(h.options);
  assert.deepEqual(h.commands, []);
});
for (const status of ["queued", "in_progress", "completed"]) {
  test(`an older run ID rerun after a passing run blocks auto-merge (${status})`, async () => {
    const h = harness({
      validationRuns: [
        { ...validationRun, id: 101 },
        {
          ...validationRun,
          run_attempt: 2,
          updated_at: "2026-10-14T06:05:00Z",
          status,
          conclusion: status === "completed" ? "failure" : null,
        },
      ],
    });
    await run(h.options);
    assert.deepEqual(h.commands, []);
  });
}
test("any applicable pending run blocks even when an older timestamp remains during rerun queuing", async () => {
  const h = harness({
    validationRuns: [
      { ...validationRun, id: 101, updated_at: "2026-10-14T06:05:00Z" },
      { ...validationRun, run_attempt: 2, status: "queued", conclusion: null },
    ],
  });
  await run(h.options);
  assert.deepEqual(h.commands, []);
});
test("a later successful execution supersedes an earlier failed execution regardless of run ID", async () => {
  const h = harness({
    validationRuns: [
      { ...validationRun, id: 101, conclusion: "failure" },
      { ...validationRun, run_attempt: 2, updated_at: "2026-10-14T06:05:00Z" },
    ],
  });
  await run(h.options);
  assert.equal(h.commands.length, 1);
  assert.equal(h.requests.find((r) => r.endpoint === "jobs").input.run_id, 100);
});
test("ambiguous timestamps cannot hide a failing execution", async () => {
  const h = harness({
    validationRuns: [
      { ...validationRun, id: 101 },
      { ...validationRun, conclusion: "failure" },
    ],
  });
  await run(h.options);
  assert.deepEqual(h.commands, []);
});
for (const advisoryConclusion of ["success", "failure"]) {
  test(`tied successful workflow timestamps block auto-merge even with advisory job ${advisoryConclusion}`, async () => {
    const h = harness({
      validationRuns: [
        { ...validationRun, id: 101 },
        { ...validationRun, run_attempt: 2 },
      ],
    });
    const paginate = h.options.github.paginate;
    h.options.github.paginate = async (endpoint, input) => {
      if (endpoint.name === "jobs" && input.run_id === 100) {
        return validationJobs.map((job) =>
          job.name === "quality / release combination" ? { ...job, conclusion: advisoryConclusion } : job,
        );
      }
      return paginate(endpoint, input);
    };
    await run(h.options);
    assert.deepEqual(h.commands, []);
    assert.equal(
      h.requests.some((request) => request.endpoint === "jobs"),
      false,
    );
  });
}
test("missing or invalid execution timestamps block auto-merge", async () => {
  for (const updated_at of [undefined, "invalid"]) {
    const h = harness({ validationRuns: [{ ...validationRun, updated_at }] });
    await run(h.options);
    assert.deepEqual(h.commands, []);
  }
});
test("successful recovery uses latest jobs and cannot reuse jobs from an older attempt", async () => {
  const h = harness({
    validationRuns: [
      { ...validationRun, id: 101, run_attempt: 2, event: "workflow_dispatch", updated_at: "2026-10-14T06:05:00Z" },
      validationRun,
    ],
  });
  await run(h.options);
  assert.equal(h.commands.length, 1);
  assert.deepEqual(h.requests.find((r) => r.endpoint === "jobs").input, {
    owner: "owner",
    repo: "repo",
    run_id: 101,
    filter: "latest",
    per_page: 100,
  });
  assert.ok(
    h.requests
      .filter((r) => r.endpoint === "runs" && r.input.workflow_id === "pr-validation.yml")
      .every((r) => r.input.branch === pull.head.ref && r.input.head_sha === pull.head.sha),
  );
});
for (const afterValidationLookup of [
  [{ ...validationRun, id: 101 }],
  [{ ...validationRun, run_attempt: 2 }],
  [{ ...validationRun, status: "in_progress", conclusion: null }],
  [{ ...validationRun, updated_at: "2026-10-14T06:05:00Z" }],
  [validationRun, { ...validationRun, id: 99, run_attempt: 2, status: "queued", conclusion: null }],
]) {
  test(`validation changing during job lookup prevents auto-merge (${JSON.stringify(afterValidationLookup)})`, async () => {
    const h = harness({ afterValidationLookup });
    await run(h.options);
    assert.deepEqual(h.commands, []);
  });
}
test("validation API failure revokes a prior bot queue decision", async () => {
  const h = harness({ pulls: [{ ...pull, auto_merge: { enabled_by: { login: "github-actions[bot]" } } }] });
  const paginate = h.options.github.paginate;
  h.options.github.paginate = async (endpoint, input) => {
    if (endpoint.name === "jobs") throw new Error("Actions unavailable");
    return paginate(endpoint, input);
  };
  await run(h.options);
  assert.deepEqual(h.commands, [["owner/repo", 1, ["--disable-auto"]]]);
  assert.equal(h.failures.length, 1);
});
test("artifact preparation runs before auto-merge", async () => {
  const h = harness();
  h.options.prepare = async () => true;
  await run(h.options);
  assert.deepEqual(h.commands, []);
});
test("stale updates wait for native rebasing before preparation", async () => {
  const h = harness({ metadataError: true });
  h.options.isCurrent = async () => false;
  h.options.prepare = async () => assert.fail("must not prepare a stale branch");
  await run(h.options);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.failures, []);
});
test("prepared updates recover validation before the compatibility-score decision", async () => {
  const h = harness();
  const paginate = h.options.github.paginate;
  h.options.github.paginate = async (endpoint) =>
    endpoint.name === "listCommits" ? [...commits, { author: { login: "github-actions[bot]" } }] : paginate(endpoint);
  h.options.verify = async () => commits;
  h.options.metadata = () => [{ ...dependency, compatScore: 0 }];
  let validated = false;
  h.options.validate = async () => {
    validated = true;
  };
  await run(h.options);
  assert.equal(validated, true);
  assert.deepEqual(h.commands, []);
});
test("an unknown score allows preparation but never queues auto-merge", async () => {
  const h = harness();
  h.options.metadata = () => [{ ...dependency, compatScore: 0 }];
  let prepared = false;
  h.options.prepare = async () => {
    prepared = true;
    return true;
  };
  await run(h.options);
  assert.equal(prepared, true);
  assert.deepEqual(h.commands, []);
  h.options.prepare = async () => false;
  await run(h.options);
  assert.deepEqual(h.commands, []);
});
test("a major update prepares artifacts but never queues auto-merge", async () => {
  const h = harness();
  h.options.metadata = () => [{ ...dependency, updateType: "version-update:semver-major", compatScore: 100 }];
  let prepared = false;
  h.options.prepare = async () => {
    prepared = true;
    return true;
  };
  await run(h.options);
  assert.equal(prepared, true);
  assert.deepEqual(h.commands, []);
  h.options.prepare = async () => false;
  await run(h.options);
  assert.deepEqual(h.commands, []);
});
test("an unknown npm update type skips preparation", async () => {
  const h = harness();
  h.options.metadata = () => [{ ...dependency, updateType: "version-update:semver-prerelease" }];
  h.options.prepare = async () => assert.fail("must not prepare an unknown update type");
  await run(h.options);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.failures, []);
});
test("lookup failure revokes an earlier bot queue decision", async () => {
  const h = harness({
    pulls: [{ ...pull, auto_merge: { enabled_by: { login: "github-actions[bot]" } } }],
    metadataError: true,
  });
  await run(h.options);
  assert.deepEqual(h.commands, [["owner/repo", 1, ["--disable-auto"]]]);
  assert.equal(h.failures.length, 1);
});
test("manual owner queue decisions are preserved after preparation", async () => {
  const h = harness({
    pulls: [{ ...pull, auto_merge: { enabled_by: { login: "owner" } } }],
    metadataError: true,
  });
  let prepared = false;
  h.options.prepare = async () => {
    prepared = true;
    return true;
  };
  await run(h.options);
  assert.equal(prepared, true);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.failures, []);
});

test("manual auto-merge still recovers prepared validation without a metadata lookup", async () => {
  const h = harness({ pulls: [{ ...pull, auto_merge: { enabled_by: { login: "owner" } } }], metadataError: true });
  h.options.verify = async () => commits.slice(0, -1);
  let validated = false;
  h.options.validate = async () => {
    validated = true;
  };
  await run(h.options);
  assert.equal(validated, true);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.failures, []);
});

test("manual auto-merge cannot hide a validation recovery failure", async () => {
  const h = harness({ pulls: [{ ...pull, auto_merge: { enabled_by: { login: "owner" } } }] });
  h.options.verify = async () => commits.slice(0, -1);
  h.options.validate = async () => {
    throw new Error("Validation failed");
  };
  await run(h.options);
  assert.deepEqual(h.commands, []);
  assert.equal(h.failures.length, 1);
});

test("a failed PR does not prevent evaluation of the next PR", async () => {
  const h = harness({ pulls: [pull, { ...pull, number: 2 }] });
  h.options.metadata = (p) => {
    if (p.number === 1) throw new Error("unavailable");
    return [dependency];
  };
  await run(h.options);
  assert.equal(h.commands[0][1], 2);
  assert.equal(h.failures.length, 1);
});
test("dispatch from a work branch cannot merge", async () => {
  const h = harness({ event: "workflow_dispatch" });
  h.options.context.ref = "refs/heads/feat/test";
  await assert.rejects(run(h.options), /default branch/);
  assert.deepEqual(h.commands, []);
});
const associated = [
  {
    ...pull,
    merged_at: "2026-09-04T00:00:00Z",
    merge_commit_sha: "b".repeat(40),
  },
];
test("dispatches missing main validation only after a confirmed Dependabot merge", async () => {
  const h = harness({ associated });
  await ensureMainRun({ ...h.options, branch: "main" });
  assert.deepEqual(h.dispatches, [{ owner: "owner", repo: "repo", workflow_id: "publish.yml", ref: "main" }]);
  const noMerge = harness();
  await ensureMainRun({ ...noMerge.options, branch: "main" });
  assert.deepEqual(noMerge.dispatches, []);
});
test("closed Dependabot merge dispatches missing main validation", async () => {
  const closed = { ...pull, state: "closed" };
  const h = harness({
    event: "pull_request_target",
    pulls: [closed],
    associated: [
      {
        ...closed,
        merged_at: "2026-09-08T00:00:00Z",
        merge_commit_sha: "b".repeat(40),
      },
    ],
  });
  h.options.context.payload.pull_request = closed;
  h.options.mainWorkflow = "main.yml";
  await run(h.options);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.dispatches, [{ owner: "owner", repo: "repo", workflow_id: "main.yml", ref: "main" }]);
});
for (const conclusion of [null, "success", "failure"]) {
  test(`does not duplicate existing main run (${conclusion})`, async () => {
    const h = harness({
      associated,
      runs: [{ head_sha: "b".repeat(40), event: "workflow_dispatch", conclusion }],
    });
    await ensureMainRun({ ...h.options, branch: "main" });
    assert.deepEqual(h.dispatches, []);
  });
}
