const { test } = require("node:test");
const assert = require("node:assert/strict");
const { run } = require("./pr-branch-updater.cjs");

function fixture({ mergeable = true, ahead = 1, fail = false, fork = false, user } = {}) {
  const calls = { updates: [], sleeps: [], failures: [], comparisons: [], logs: [] };
  let reads = 0;
  const pull = {
    number: 1,
    user,
    state: "open",
    base: { ref: "main", sha: "base" },
    head: { sha: "head", repo: { full_name: fork ? "other/repo" : "owner/repo" } },
  };
  const github = {
    paginate: async () => [pull],
    rest: {
      git: {
        getRef: async (args) => {
          assert.equal(args.ref, "heads/main");
          return { data: { object: { sha: "current-main" } } };
        },
      },
      pulls: {
        list: () => {},
        get: async () => ({
          data: {
            ...pull,
            mergeable: Array.isArray(mergeable) ? mergeable[Math.min(reads++, mergeable.length - 1)] : mergeable,
            mergeable_state: "blocked",
          },
        }),
      },
      repos: {
        compareCommitsWithBasehead: async (args) => {
          calls.comparisons.push(args.basehead);
          return { data: { ahead_by: args.basehead.endsWith("...base") ? 0 : ahead } };
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
      context: {
        repo: { owner: "owner", repo: "repo" },
        eventName: "push",
        ref: "refs/heads/main",
      },
      core: { info: (s) => calls.logs.push(s), summary, setFailed: (s) => calls.failures.push(s) },
      sleep: async (ms) => calls.sleeps.push(ms),
    },
  };
}

test("updates against current main despite stale PR base metadata and blocked checks", async () => {
  const { args, calls } = fixture();
  await run(args);
  assert.deepEqual(calls.comparisons, ["head...current-main"]);
  assert.equal(calls.updates[0].expected_head_sha, "head");
});
test("a manual main dispatch updates branches through the same guarded API", async () => {
  const { args, calls } = fixture();
  args.context.eventName = "workflow_dispatch";
  await run(args);
  assert.equal(calls.updates.length, 1);
});
for (const [eventName, ref] of [
  ["pull_request", "refs/heads/main"],
  ["pull_request_target", "refs/heads/main"],
  ["workflow_run", "refs/heads/main"],
  ["push", undefined],
  ["push", "main"],
  ["push", "refs/pull/1/merge"],
  ["push", "refs/tags/v0.1.0"],
  ["workflow_dispatch", "refs/heads/fix/untrusted"],
  ["push", "refs/heads/release/01.2.3"],
  ["push", "refs/heads/release/1.2.3-rc.1"],
  ["push", "refs/heads/release/1.2.3/extra"],
]) {
  test(`rejects ${eventName} on ${ref} before accessing GitHub`, async () => {
    const { args } = fixture();
    args.context.eventName = eventName;
    args.context.ref = ref;
    args.github = new Proxy(
      {},
      {
        get() {
          assert.fail("GitHub accessed before context validation");
        },
      },
    );
    await assert.rejects(run(args), /PR updates require a push or dispatch/);
  });
}
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
test("an App authorization failure remains a failed update", async () => {
  const { args, calls } = fixture();
  args.github.request = async () => {
    throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
  };
  await run(args);
  assert.deepEqual(calls.failures, ["1 PR branch update(s) unresolved"]);
});
test("workflow-permission denial fails the job with the original diagnostic", async () => {
  const { args, calls } = fixture();
  const message =
    "refusing to allow a GitHub App to create or update workflow `.github/workflows/x.yml` without `workflows` permission";
  args.github.request = async () => {
    throw Object.assign(new Error(message), { status: 403 });
  };
  await run(args);
  assert.equal(calls.updates.length, 0);
  assert.deepEqual(calls.failures, ["1 PR branch update(s) unresolved"]);
  assert.deepEqual(calls.logs, [`#1: unresolved: ${message}`]);
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
});
test("a bot-like name alone does not bypass branch updates", async () => {
  const { args, calls } = fixture({ user: { login: "dependabot[bot]", id: 1 } });
  await run(args);
  assert.equal(calls.updates.length, 1);
});

test("updates PRs against the release branch that triggered validation", async () => {
  const { args, calls } = fixture();
  args.context.ref = "refs/heads/release/0.1.0";
  const get = args.github.rest.pulls.get;
  args.github.rest.pulls.get = async (options) => {
    const result = await get(options);
    result.data.base.ref = "release/0.1.0";
    return result;
  };
  args.github.rest.git.getRef = async ({ ref }) => {
    assert.equal(ref, "heads/release/0.1.0");
    return { data: { object: { sha: "release-head" } } };
  };
  const paginate = args.github.paginate;
  args.github.paginate = async (method, options) => {
    assert.equal(options.base, "release/0.1.0");
    return paginate(method, options);
  };
  await run(args);
  assert.equal(calls.updates.length, 1);
});
