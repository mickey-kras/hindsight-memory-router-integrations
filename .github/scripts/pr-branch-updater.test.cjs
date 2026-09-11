const { test } = require("node:test");
const assert = require("node:assert/strict");
const { run } = require("./pr-branch-updater.cjs");

function fixture({ mergeable = true, ahead = 1, fail = false, fork = false, user } = {}) {
  const calls = { updates: [], sleeps: [], failures: [], comparisons: [] };
  let reads = 0;
  const pull = {
    number: 1,
    user,
    state: "open",
    base: { ref: "main" },
    head: { sha: "head", repo: { full_name: fork ? "other/repo" : "owner/repo" } },
  };
  const github = {
    paginate: async () => [pull],
    rest: {
      git: { getRef: async () => ({ data: { object: { sha: "current-main" } } }) },
      pulls: {
        list: () => {},
        get: async () => ({
          data: {
            ...pull,
            mergeable: Array.isArray(mergeable)
              ? mergeable[Math.min(reads++, mergeable.length - 1)]
              : mergeable,
          },
        }),
      },
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => {
          calls.comparisons.push(basehead);
          return { data: { ahead_by: ahead } };
        },
      },
    },
    request: async (_route, args) => {
      if (fail) throw new Error("API unavailable");
      calls.updates.push(args);
    },
  };
  const summary = { addHeading: () => summary, addTable: () => summary, write: async () => {} };
  return {
    calls,
    args: {
      github,
      context: { repo: { owner: "owner", repo: "repo" } },
      core: { info: () => {}, summary, setFailed: (value) => calls.failures.push(value) },
      sleep: async (ms) => calls.sleeps.push(ms),
    },
  };
}

test("updates a stale same-repository branch", async () => {
  const { args, calls } = fixture();
  await run(args);
  assert.deepEqual(calls.comparisons, ["head...current-main"]);
  assert.equal(calls.updates[0].expected_head_sha, "head");
});

test("retries unknown mergeability and then updates", async () => {
  const { args, calls } = fixture({ mergeable: [null, true] });
  await run(args);
  assert.equal(calls.sleeps.length, 1);
  assert.equal(calls.updates.length, 1);
});

test("persistent unknown fails after bounded retries", async () => {
  const { args, calls } = fixture({ mergeable: null });
  await run(args);
  assert.equal(calls.sleeps.length, 3);
  assert.equal(calls.failures.length, 1);
});

for (const [name, options] of Object.entries({
  current: { ahead: 0 },
  conflict: { mergeable: false },
  fork: { fork: true },
})) {
  test(`does not update ${name}`, async () => {
    const { args, calls } = fixture(options);
    await run(args);
    assert.equal(calls.updates.length, 0);
    assert.equal(calls.failures.length, 0);
  });
}

test("API failure is not reported as success", async () => {
  const { args, calls } = fixture({ fail: true });
  await run(args);
  assert.equal(calls.failures.length, 1);
});

test("leaves stale Dependabot branches to scheduled native rebasing", async () => {
  const { args, calls } = fixture({ user: { login: "dependabot[bot]", id: 49699333 } });
  await run(args);
  assert.deepEqual(calls.updates, []);
  assert.deepEqual(calls.failures, []);
});

test("does not involve Dependabot when its branch is current", async () => {
  const { args, calls } = fixture({ user: { login: "dependabot[bot]", id: 49699333 }, ahead: 0 });
  await run(args);
  assert.deepEqual(calls.updates, []);
  assert.deepEqual(calls.comparisons, ["head...current-main"]);
  assert.deepEqual(calls.failures, []);
});

test("a bot-like name alone does not bypass updates", async () => {
  const { args, calls } = fixture({ user: { login: "dependabot[bot]", id: 1 } });
  await run(args);
  assert.equal(calls.updates.length, 1);
});
