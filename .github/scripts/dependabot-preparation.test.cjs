const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CODING,
  PROVENANCE,
  INPUTS,
  hash,
  generatedPaths,
  validateManifest,
  updateProvenance,
} = require("./dependency-files.cjs");
const {
  dependencyCommits,
  inspect,
  requestPreparation,
  requestRecreate,
  publish,
} = require("./dependabot-preparation.cjs");
const { requestValidation } = require("./dependabot-validation.cjs");

const bot = { login: "dependabot[bot]", id: 49699333 };
const owner = { login: "owner", id: 100 };
const actions = { login: "github-actions[bot]", id: 41898282 };
const head = "a".repeat(40);
const base = "b".repeat(40);
const generated = "c".repeat(40);
const manifest = {
  name: "@owner/root",
  version: "1.0.0",
  scripts: { build: "tsc" },
  devDependencies: { example: "1.0.0", "@types/node": "22.20.0" },
};
const coding = { ...manifest, name: "@owner/coding" };
const provenance = { "package.json": "old", "npm-shrinkwrap.json": "old", "src/index.ts": "preserved" };
const commit = { sha: head, author: bot, commit: { verification: { verified: true } } };
const context = { repo: { owner: "owner", repo: "repo" }, ref: "refs/heads/main", sha: base };
const pull = {
  number: 1,
  user: bot,
  state: "open",
  draft: false,
  author_association: "NONE",
  head: { sha: head, ref: "dependabot/npm_and_yarn/example-1.0.1", repo: { full_name: "owner/repo" } },
  base: { ref: "main", sha: base, repo: { owner } },
};

function harness() {
  const state = {
    pull: structuredClone(pull),
    commits: [structuredClone(commit)],
    files: [{ filename: `${CODING}/package.json`, status: "modified" }],
    runs: [],
    dispatches: [],
    comments: [],
    messages: [],
    published: [],
    checks: [],
    reported: [],
    ahead: 0,
    generated: { parents: [{ sha: head }], files: [{ filename: PROVENANCE, status: "modified" }] },
  };
  const contents = {
    "package.json": JSON.stringify(manifest),
    [`${CODING}/package.json`]: JSON.stringify(coding),
    [`${CODING}/npm-shrinkwrap.json`]: "{}",
    [PROVENANCE]: JSON.stringify(provenance),
  };
  const github = {
    graphql: async (query, input) => {
      if (query.startsWith("mutation")) {
        state.published.push(input);
        return { createCommitOnBranch: { commit: { oid: generated } } };
      }
      return { repository: { object: { signature: { isValid: true, wasSignedByGitHub: true } } } };
    },
    rest: {
      git: { getRef: async () => ({ data: { object: { sha: base } } }) },
      repos: {
        get: async () => ({ data: { default_branch: "main", full_name: "owner/repo" } }),
        getContent: async ({ path }) => ({
          data: { type: "file", encoding: "base64", content: Buffer.from(contents[path]).toString("base64") },
        }),
        getCommit: async () => ({ data: state.generated }),
        compareCommitsWithBasehead: async () => ({ data: { ahead_by: state.ahead } }),
      },
      pulls: { get: async () => ({ data: state.pull }), listCommits: "commits", listFiles: "files" },
      actions: { listWorkflowRuns: "runs", createWorkflowDispatch: async (input) => state.dispatches.push(input) },
      checks: {
        listForRef: "checks",
        create: async (input) => {
          state.reported.push(input);
          return { data: { id: 10 } };
        },
        update: async (input) => state.reported.push(input),
      },
      issues: { listComments: "comments", createComment: async (input) => state.messages.push(input) },
    },
    paginate: async (endpoint) => state[endpoint],
  };
  const paths = generatedPaths(manifest, coding);
  const artifacts = {
    [PROVENANCE]: JSON.stringify(updateProvenance(provenance, contents[`${CODING}/package.json`], "{}")),
    [paths[3]]: "root archive",
    [paths[4]]: "coding archive",
  };
  artifacts.PACKAGE_SHA256 = paths
    .slice(3)
    .sort()
    .map((path) => `${hash(artifacts[path])}  ${path}\n`)
    .join("");
  artifacts.PACKAGE_NIX_HASHES = `source=sha256-${hash(artifacts[paths[3]], "base64")}\nnpm_deps=sha256-${hash("deps", "base64")}\n`;
  const payload = {
    number: 1,
    head,
    base,
    files: paths.map((path) => ({ path, contents: Buffer.from(artifacts[path]).toString("base64") })),
  };
  const metadata = () => [
    { updateType: "version-update:semver-patch", prevVersion: "1.0.0", newVersion: "1.0.1", compatScore: 75 },
  ];
  return { state, github, payload, metadata, contents };
}

test("dependency versions can change without reauthorizing scripts or package identity", () => {
  const updated = { ...manifest, devDependencies: { ...manifest.devDependencies, example: "1.0.1" } };
  assert.doesNotThrow(() => validateManifest(manifest, updated));
  for (const invalid of [
    { ...updated, scripts: { build: "untrusted" } },
    { ...updated, version: "2.0.0" },
    { ...updated, devDependencies: { ...updated.devDependencies, extra: "1.0.0" } },
    { ...updated, devDependencies: { example: "1.0.1" } },
    { ...updated, devDependencies: { ...updated.devDependencies, "@types/node": "26.4.1" } },
  ])
    assert.throws(() => validateManifest(manifest, invalid));
});

test("provenance refresh preserves every non-dependency hash", () => {
  const updated = updateProvenance(provenance, "package", "lock");
  assert.equal(updated["src/index.ts"], "preserved");
  assert.equal(updated["package.json"], hash("package"));
  assert.equal(updated["npm-shrinkwrap.json"], hash("lock"));
  assert.throws(() => updateProvenance({}, "package", "lock"));
});

test("preparation inspects only a current signed same-repository npm update", async () => {
  const h = harness();
  assert.equal((await inspect(h.github, context, 1, head)).pull.head.sha, head);
  for (const change of [
    { user: owner },
    { draft: true },
    { state: "closed" },
    { head: { ...pull.head, sha: base } },
    { head: { ...pull.head, repo: { full_name: "fork/repo" } } },
  ]) {
    h.state.pull = { ...pull, ...change };
    await assert.rejects(inspect(h.github, context, 1, head));
  }
  h.state.pull = pull;
  await assert.rejects(inspect(h.github, { ...context, ref: "refs/heads/feature" }, 1, head));
  h.state.files.push({ filename: "src/plugin.ts", status: "modified" });
  await assert.rejects(inspect(h.github, context, 1, head), /only accepts/);
  h.state.files = [{ filename: INPUTS[0], status: "renamed" }];
  await assert.rejects(inspect(h.github, context, 1, head), /only accepts/);
  h.state.files = [{ filename: INPUTS[0], status: "modified" }];
  h.state.commits[0].commit.verification.verified = false;
  await assert.rejects(inspect(h.github, context, 1, head), /signed/);
});

test("a signed preparation commit may only follow signed Dependabot commits and modify generated files", async () => {
  const h = harness();
  const prepared = {
    sha: generated,
    author: actions,
    commit: {
      verification: { verified: true },
      message: `Regenerate dependency artifacts\n\nDependabot-Head: ${head}`,
    },
  };
  const updated = { ...pull, head: { ...pull.head, sha: generated } };
  assert.deepEqual(await dependencyCommits(h.github, context.repo, updated, [commit, prepared]), [commit]);
  assert.deepEqual(await dependencyCommits(h.github, context.repo, updated, [commit, { ...prepared, author: owner }]), [commit]);
  for (const invalid of [
    { ...prepared, author: { login: "stranger", id: 200 } },
    { ...prepared, author: { login: "github-actions[bot]", id: 200 } },
    { ...prepared, commit: { ...prepared.commit, verification: { verified: false } } },
    { ...prepared, commit: { ...prepared.commit, message: "unrelated commit" } },
  ])
    await assert.rejects(dependencyCommits(h.github, context.repo, updated, [commit, invalid]));
  h.state.generated.files = [{ filename: `${CODING}/package.json`, status: "modified" }];
  await assert.rejects(dependencyCommits(h.github, context.repo, updated, [commit, prepared]), /outside/);
  h.state.generated.files = [{ filename: PROVENANCE, status: "removed" }];
  await assert.rejects(dependencyCommits(h.github, context.repo, updated, [commit, prepared]), /outside/);
  h.state.generated.parents = [{ sha: base }];
  await assert.rejects(dependencyCommits(h.github, context.repo, updated, [commit, prepared]), /outside/);
  h.state.generated = { parents: [{ sha: head }], files: [{ filename: PROVENANCE, status: "modified" }] };
  h.github.graphql = async () => ({
    repository: { object: { signature: { isValid: true, wasSignedByGitHub: false } } },
  });
  await assert.rejects(dependencyCommits(h.github, context.repo, updated, [commit, prepared]), /signed by GitHub/);
});

test("preparation dispatches once per head and does not intercept action updates", async () => {
  const h = harness();
  const core = { info() {} };
  assert.equal(await requestPreparation(h.github, context, pull, core), true);
  assert.equal(h.state.dispatches[0].inputs.expected_head, head);
  h.state.runs.push({ display_title: `Prepare dependencies #1 at ${head}`, conclusion: "failure" });
  await requestPreparation(h.github, context, pull, core);
  assert.equal(h.state.dispatches.length, 1);
  h.state.files = [{ filename: ".github/workflows/ci.yml" }];
  assert.equal(await requestPreparation(h.github, context, pull, core), false);
});

test("stale updates request one Dependabot recreation per head", async () => {
  const h = harness();
  const core = { info() {} };
  assert.equal(await requestRecreate(h.github, context, pull, core), false);
  h.state.ahead = 1;
  assert.equal(await requestRecreate(h.github, context, pull, core), true);
  h.state.comments.push({ body: h.state.messages[0].body, user: { id: 41898282 } });
  await requestRecreate(h.github, context, pull, core);
  assert.equal(h.state.messages.length, 1);
});

test("a changed head is not recreated", async () => {
  const h = harness();
  h.state.ahead = 1;
  h.state.pull.head.sha = generated;
  await requestRecreate(h.github, context, pull, { info() {} });
  assert.deepEqual(h.state.messages, []);
});

test("publication limits files and uses expectedHeadOid for an atomic update", async () => {
  const h = harness();
  assert.equal(await publish(h.github, context, h.payload, "unused", h.metadata), generated);
  assert.equal(h.state.published[0].input.expectedHeadOid, head);
  assert.deepEqual(h.state.published[0].input.fileChanges.additions, h.payload.files);
});

function preparedHarness() {
  const h = harness();
  h.state.pull.head.sha = generated;
  h.state.commits.push({
    sha: generated, author: actions,
    commit: { verification: { verified: true }, message: `Regenerate dependency artifacts\n\nDependabot-Head: ${head}` },
  });
  return h;
}

test("prepared updates report the actual policy result on the new SHA and dispatch PR validation", async () => {
  const h = preparedHarness();
  let evaluated;
  await requestValidation(h.github, context, h.state.pull, { info() {} }, async (_github, _repo, current) => {
    evaluated = current.head.sha;
  });
  assert.equal(evaluated, generated);
  assert.equal(h.state.reported[0].head_sha, generated);
  assert.equal(h.state.reported[0].name, "guard");
  assert.equal(h.state.reported[1].conclusion, "success");
  assert.deepEqual(h.state.dispatches, [{
    ...context.repo, workflow_id: "pr-validation.yml", ref: pull.head.ref,
    inputs: { number: "1", expected_head: generated },
  }]);
});

test("a failed policy is reported as failure and never starts validation", async () => {
  const h = preparedHarness();
  await assert.rejects(requestValidation(h.github, context, h.state.pull, { info() {} }, async () => {
    throw new Error("Policy guard failed");
  }), /Policy guard failed/);
  assert.equal(h.state.reported.at(-1).conclusion, "failure");
  assert.deepEqual(h.state.dispatches, []);
});

test("a head change during policy evaluation cannot get a successful guard", async () => {
  const h = preparedHarness();
  const snapshot = structuredClone(h.state.pull);
  await assert.rejects(requestValidation(h.github, context, snapshot, { info() {} }, async () => {
    h.state.pull = { ...h.state.pull, head: { ...h.state.pull.head, sha: head } };
  }), /changed during/);
  assert.equal(h.state.reported.at(-1).conclusion, "failure");
  assert.deepEqual(h.state.dispatches, []);
});

test("refresh recovers a missing dispatch without repeating successful checks", async () => {
  const h = preparedHarness();
  h.state.checks = [{
    name: "guard", external_id: `prepared-policy:${generated}:${base}`, status: "completed", conclusion: "success",
  }];
  const noPolicy = async () => { throw new Error("Must reuse the successful guard"); };
  await requestValidation(h.github, context, h.state.pull, { info() {} }, noPolicy);
  assert.equal(h.state.dispatches.length, 1);
  h.state.runs = [{ head_sha: generated, conclusion: "success" }];
  await requestValidation(h.github, context, h.state.pull, { info() {} }, noPolicy);
  assert.equal(h.state.dispatches.length, 1);
  assert.deepEqual(h.state.reported, []);
});

test("refresh recovers a guard left pending by a terminated workflow", async () => {
  const h = preparedHarness();
  h.state.checks = [{
    id: 10, name: "guard", external_id: `prepared-policy:${generated}:${base}`, status: "in_progress",
    details_url: "https://github.com/owner/repo/actions/runs/123",
  }];
  h.github.rest.actions.getWorkflowRun = async () => ({ data: { status: "completed" } });
  await requestValidation(h.github, context, h.state.pull, { info() {} }, async () => {});
  assert.equal(h.state.reported.length, 1);
  assert.equal(h.state.reported[0].check_run_id, 10);
  assert.equal(h.state.reported[0].conclusion, "success");
  assert.equal(h.state.dispatches.length, 1);
});

test("refresh leaves an active guard running and keeps a failed guard blocking", async () => {
  for (const status of ["in_progress", "completed"]) {
    const h = preparedHarness();
    h.state.checks = [{
      id: 10, name: "guard", external_id: `prepared-policy:${generated}:${base}`, status, conclusion: "failure",
      details_url: "https://github.com/owner/repo/actions/runs/123",
    }];
    h.github.rest.actions.getWorkflowRun = async () => ({ data: { status: "in_progress" } });
    const call = requestValidation(h.github, context, h.state.pull, { info() {} }, async () => {
      throw new Error("Must not rerun policy");
    });
    if (status === "completed") await assert.rejects(call, /not passed/);
    else await call;
    assert.deepEqual(h.state.reported, []);
    assert.deepEqual(h.state.dispatches, []);
  }
});

test("dispatch refuses workflow changes, forged artifact commits and stale heads", async () => {
  for (const mutate of [
    h => h.state.files.push({ filename: ".github/workflows/pr-validation.yml", status: "modified" }),
    h => { h.state.commits[1].author = bot; },
    h => { h.state.pull.head.sha = head; },
  ]) {
    const h = preparedHarness();
    const snapshot = structuredClone(h.state.pull);
    mutate(h);
    await assert.rejects(requestValidation(h.github, context, snapshot, { info() {} }, async () => {}));
    assert.deepEqual(h.state.reported, []);
    assert.deepEqual(h.state.dispatches, []);
  }
});

test("dispatch outside main is rejected before any check is reported", async () => {
  const h = preparedHarness();
  await assert.rejects(requestValidation(h.github, { ...context, ref: "refs/heads/feature" }, h.state.pull, { info() {} }));
  assert.deepEqual(h.state.reported, []);
});

for (const [name, mutate] of [
  [
    "head race",
    (h) => {
      h.state.pull.head.sha = generated;
    },
  ],
  [
    "base race",
    (h) => {
      h.state.pull.base.sha = generated;
    },
  ],
  [
    "extra file",
    (h) => {
      h.payload.files.push({ path: ".github/workflows/main.yml", contents: "" });
    },
  ],
  [
    "duplicate file",
    (h) => {
      h.payload.files[0] = h.payload.files[1];
    },
  ],
  [
    "source provenance rewrite",
    (h) => {
      h.payload.files[0].contents = Buffer.from(JSON.stringify({ ...provenance, "src/index.ts": "changed" })).toString(
        "base64",
      );
    },
  ],
  [
    "incorrect checksum",
    (h) => {
      h.payload.files[1].contents = Buffer.from("wrong").toString("base64");
    },
  ],
  ["incorrect Nix source hash", (h) => {
    h.payload.files[2].contents = Buffer.from(`source=sha256-${hash("other", "base64")}\nnpm_deps=sha256-${hash("deps", "base64")}\n`).toString("base64");
  }],
  ["extra Nix hash field", (h) => {
    h.payload.files[2].contents = Buffer.from(`${Buffer.from(h.payload.files[2].contents, "base64")}extra=value\n`).toString("base64");
  }],
  [
    "ineligible metadata",
    (h) => {
      h.metadata = () => [];
    },
  ],
]) {
  test(`publication rejects ${name}`, async () => {
    const h = harness();
    mutate(h);
    await assert.rejects(publish(h.github, context, h.payload, "unused", h.metadata));
    assert.equal(h.state.published.length, 0);
  });
}
