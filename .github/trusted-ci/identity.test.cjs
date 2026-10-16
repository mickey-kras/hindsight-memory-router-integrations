const { test } = require("node:test");
const assert = require("node:assert/strict");
const { identify } = require("./identity.cjs");
const sha = "a".repeat(40);
const head = "b".repeat(40);
const base = "c".repeat(40);
const repository = "mickey-kras/hindsight-memory-router-integrations";
function fixture(eventName = "pull_request", fork = false) {
  const pr = {
    number: 7,
    state: "open",
    draft: false,
    user: { login: "dependabot[bot]", id: 49699333 },
    head: { sha: head, ref: "dependabot/npm/update", repo: { full_name: fork ? "contributor/fork" : repository } },
    base: { sha: base, ref: "main" },
  };
  const context = {
    repo: { owner: "mickey-kras", repo: "hindsight-memory-router-integrations" },
    eventName,
    sha,
    ref: "refs/pull/7/merge",
    payload: { pull_request: structuredClone(pr) },
  };
  const refs = { "pull/7/merge": sha, "heads/main": base, "heads/dependabot/npm/update": head };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pr }) },
      git: {
        getRef: async ({ ref }) => ({ data: { object: { sha: refs[ref] } } }),
        getCommit: async () => ({ data: { parents: [{ sha: base }] } }),
      },
    },
  };
  return { context, github, pr, refs };
}
test("PR scans retain merge identity for fork, Dependabot and same-repository inputs", async () => {
  for (const fork of [true, false]) {
    const f = fixture("pull_request", fork);
    assert.deepEqual(await identify(f), { sha, ref: "refs/pull/7/merge", upload: !fork });
  }
});
test("reject partial, substituted, stale and foreign candidate identities", async () => {
  for (const mutate of [
    (f) => {
      f.sha = head;
    },
    (f) => {
      f.sha = head;
      f.ref = "refs/heads/dependabot/npm/update";
    },
    (f) => {
      f.pr.head.sha = base;
    },
    (f) => {
      f.pr.base.sha = head;
    },
    (f) => {
      f.refs["pull/7/merge"] = head;
    },
    (f) => {
      f.context.repo.owner = "elsewhere";
    },
    (f) => {
      f.pr.state = "closed";
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(identify(f));
  }
});
function dispatch() {
  const f = fixture("workflow_dispatch");
  f.context.sha = head;
  f.context.ref = "refs/heads/dependabot/npm/update";
  f.context.payload = { inputs: { number: "7", expected_head: head } };
  return f;
}
test("prepared Dependabot dispatch is bound to current PR head and separately resolved main", async () => {
  assert.deepEqual(await identify(dispatch()), { sha: head, ref: "refs/heads/dependabot/npm/update", upload: true });
  for (const mutate of [
    (f) => {
      f.context.payload.inputs.expected_head = base;
    },
    (f) => {
      f.context.ref = "refs/heads/main";
    },
    (f) => {
      f.pr.user.id = 1;
    },
    (f) => {
      f.pr.head.repo.full_name = "contributor/fork";
    },
    (f) => {
      f.refs["heads/main"] = sha;
    },
    (f) => {
      f.pr.draft = true;
    },
  ]) {
    const f = dispatch();
    mutate(f);
    await assert.rejects(identify(f));
  }
});
test("main push/schedule/dispatch bind the current ref; unsupported events fail", async () => {
  for (const eventName of ["push", "schedule", "workflow_dispatch"]) {
    const f = fixture(eventName);
    f.context.sha = base;
    f.context.ref = "refs/heads/main";
    assert.deepEqual(await identify(f), { sha: base, ref: "refs/heads/main", upload: true });
    f.refs["heads/main"] = head;
    await assert.rejects(identify(f));
  }
  await assert.rejects(identify(fixture("pull_request_target")));
});
test("release candidate must be current prepared child of the main dispatch", async () => {
  function release() {
    const f = fixture("workflow_dispatch");
    f.context.workflow = "release";
    f.context.ref = "refs/heads/main";
    f.context.sha = base;
    f.sha = sha;
    f.ref = "refs/heads/release/1.2.3";
    f.refs["heads/release/1.2.3"] = sha;
    return f;
  }
  assert.deepEqual(await identify(release()), { sha, ref: "refs/heads/release/1.2.3", upload: true });
  for (const mutate of [
    (f) => {
      f.context.workflow = "PR validation";
    },
    (f) => {
      f.ref = "refs/heads/attacker";
    },
    (f) => {
      f.refs["heads/release/1.2.3"] = head;
    },
    (f) => {
      f.github.rest.git.getCommit = async () => ({ data: { parents: [{ sha: head }] } });
    },
  ]) {
    const f = release();
    mutate(f);
    await assert.rejects(identify(f));
  }
});
