const test = require("node:test");
const assert = require("node:assert/strict");
const cleanup = require("./release-cleanup.cjs");

const sha = "b".repeat(40);

function fakeContext(overrides = {}) {
  return {
    eventName: "push",
    workflow: "release",
    ref: "refs/heads/release/0.1.0",
    sha,
    actor: "mickey-kras",
    repo: { owner: "mickey-kras", repo: "hindsight-memory-router-integrations" },
    payload: { repository: { owner: { type: "User" } } },
    ...overrides,
  };
}

function fakeCore() {
  const state = { errors: [], warnings: [], summary: "" };
  const summary = {
    addHeading(text) {
      state.summary += `${text}\n`;
      return summary;
    },
    addRaw(text) {
      state.summary += text;
      return summary;
    },
    async write() {},
  };
  return {
    state,
    core: {
      summary: summary,
      error: (message) => state.errors.push(message),
      warning: (message) => state.warnings.push(message),
    },
  };
}

const notFound = () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));

function fakeGithub({ head = sha, tag = false, release = false, deleteFails = false } = {}) {
  const api = {
    deleted: false,
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref.startsWith("tags/")) {
            if (!tag) return notFound();
            return { data: { object: { sha } } };
          }
          if (head === null) return notFound();
          return { data: { object: { sha: head } } };
        },
        deleteRef: async () => {
          if (deleteFails) throw new Error("forbidden");
          api.deleted = true;
        },
      },
      repos: { getReleaseByTag: async () => (release ? { data: {} } : notFound()) },
    },
  };
  return api;
}

test("targets accepts only release workflow refs", () => {
  assert.deepEqual(cleanup.targets(fakeContext()), { version: "0.1.0", sha });
  for (const ref of ["refs/heads/main", "refs/heads/release/0.1", "refs/heads/release/1.0.0-latest"]) {
    assert.throws(() => cleanup.targets(fakeContext({ ref })), cleanup.CleanupError);
  }
  assert.throws(() => cleanup.targets(fakeContext({ workflow: "main" })), cleanup.CleanupError);
  assert.throws(() => cleanup.targets(fakeContext({ eventName: "workflow_dispatch" })), cleanup.CleanupError);
  assert.throws(() => cleanup.targets(fakeContext({ sha: "not-a-sha" })), cleanup.CleanupError);
});

test("published treats an existing tag or release as resumable state", async () => {
  assert.equal(await cleanup.published(fakeGithub({ tag: true }), fakeContext().repo, "0.1.0"), true);
  assert.equal(await cleanup.published(fakeGithub({ release: true }), fakeContext().repo, "0.1.0"), true);
  assert.equal(await cleanup.published(fakeGithub(), fakeContext().repo, "0.1.0"), false);
});

test("branch keeps the branch once a git tag or release exists", async () => {
  const { core, state } = fakeCore();
  for (const github of [fakeGithub({ tag: true }), fakeGithub({ release: true })]) {
    await cleanup.branch({ github, context: fakeContext(), core });
    assert.equal(github.deleted, false);
  }
  assert.match(state.summary, /already exists\. Re-run failed jobs/);
  assert.equal(state.errors.length, 0);
});

test("branch deletion skips advanced and absent branches", async () => {
  const { core, state } = fakeCore();
  const stale = fakeGithub({ head: "f".repeat(40) });
  await cleanup.branch({ github: stale, context: fakeContext(), core });
  assert.equal(stale.deleted, false);
  assert.match(state.summary, /branch advanced/);

  const absent = fakeGithub({ head: null });
  await cleanup.branch({ github: absent, context: fakeContext(), core });
  assert.equal(absent.deleted, false);
  assert.match(state.summary, /already absent/);
  assert.equal(state.errors.length, 0);
});

test("branch deletion removes the failed run's branch", async () => {
  const { core, state } = fakeCore();
  const github = fakeGithub();
  await cleanup.branch({ github, context: fakeContext(), core });
  assert.equal(github.deleted, true);
  assert.match(state.summary, /deleted `heads\/release\/0\.1\.0`/);
  assert.equal(state.errors.length, 0);
});

test("branch deletion failures are logged, never thrown", async () => {
  const { core, state } = fakeCore();
  const github = fakeGithub({ deleteFails: true });
  await cleanup.branch({ github, context: fakeContext(), core });
  assert.equal(github.deleted, false);
  assert.equal(state.errors.length, 1);
  assert.match(state.summary, /\*\*failed\*\* \(forbidden\)/);
});

function fakeDispatchContext(overrides = {}) {
  return fakeContext({
    eventName: "workflow_dispatch",
    workflow: "main",
    ref: "refs/heads/main",
    runId: 42,
    ...overrides,
  });
}

function fakePreparationGithub({ manifests = {}, deleteFails = false } = {}) {
  const api = {
    deleted: [],
    paginate: async (method, args) => (await method(args)).data,
    rest: {
      repos: {
        listBranches: async () => ({ data: Object.keys(manifests).map((name) => ({ name })) }),
        getContent: async ({ path, ref }) => {
          const manifest = manifests[ref];
          if (path !== "release.json" || !manifest) return notFound();
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(JSON.stringify(manifest)).toString("base64"),
            },
          };
        },
        getReleaseByTag: async () => notFound(),
      },
      git: {
        getRef: async () => notFound(),
        deleteRef: async ({ ref }) => {
          if (deleteFails) throw new Error("forbidden");
          api.deleted.push(ref);
        },
      },
    },
  };
  return api;
}

test("preparationTargets accepts only main workflow dispatches with a run id", () => {
  assert.equal(cleanup.preparationTargets(fakeDispatchContext()), 42);
  assert.throws(() => cleanup.preparationTargets(fakeContext()), cleanup.CleanupError);
  assert.throws(
    () => cleanup.preparationTargets(fakeDispatchContext({ ref: "refs/heads/release/0.2.0" })),
    cleanup.CleanupError,
  );
  assert.throws(() => cleanup.preparationTargets(fakeDispatchContext({ runId: 0 })), cleanup.CleanupError);
  assert.throws(() => cleanup.preparationTargets(fakeDispatchContext({ runId: "42" })), cleanup.CleanupError);
});

test("preparation deletes only branches frozen by the failed run", async () => {
  const { core, state } = fakeCore();
  const github = fakePreparationGithub({
    manifests: {
      "release/0.2.0": { preparation_run: 42 },
      "release/0.3.0": { preparation_run: 41 },
      "release/0.4.0": null,
      "release/0.1": { preparation_run: 42 },
    },
  });
  await cleanup.preparation({ github, context: fakeDispatchContext(), core });
  assert.deepEqual(github.deleted, ["heads/release/0.2.0"]);
  assert.match(state.summary, /deleted `heads\/release\/0\.2\.0`/);
  assert.equal(state.errors.length, 0);
});

test("preparation cleanup without a matching branch is a quiet no-op", async () => {
  const { core, state } = fakeCore();
  const github = fakePreparationGithub({ manifests: { "release/0.2.0": { preparation_run: 41 } } });
  await cleanup.preparation({ github, context: fakeDispatchContext(), core });
  assert.deepEqual(github.deleted, []);
  assert.match(state.summary, /nothing to delete/);
  assert.equal(state.errors.length, 0);
});

test("preparation deletion failures are logged, never thrown", async () => {
  const { core, state } = fakeCore();
  const github = fakePreparationGithub({ manifests: { "release/0.2.0": { preparation_run: 42 } }, deleteFails: true });
  await cleanup.preparation({ github, context: fakeDispatchContext(), core });
  assert.deepEqual(github.deleted, []);
  assert.equal(state.errors.length, 1);
  assert.match(state.summary, /\*\*failed\*\* \(forbidden\)/);
});
