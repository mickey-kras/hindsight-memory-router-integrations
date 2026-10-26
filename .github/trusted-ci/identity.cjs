const assert = require("node:assert/strict");

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = "mickey-kras/hindsight-memory-router-integrations";

// Called before checkout and again before publication. Inputs can select a prepared
// release, but never authorize a different repository, PR revision, or arbitrary ref.
async function identify({ github, context, sha = "", ref = "" }) {
  assert.equal(`${context.repo.owner}/${context.repo.repo}`, REPOSITORY, "Unexpected repository");
  assert.equal(Boolean(sha), Boolean(ref), "Candidate SHA and ref must be supplied together");
  const selected = { sha: sha || context.sha, ref: ref || context.ref };
  assert.match(selected.sha, SHA);
  assert.match(selected.ref, /^refs\/(heads\/[A-Za-z0-9._/-]+|pull\/[1-9][0-9]*\/merge)$/);
  const getRef = async (name) =>
    (await github.rest.git.getRef({ ...context.repo, ref: name.replace(/^refs\//, "") })).data.object.sha;
  let upload = true;
  if (context.eventName === "pull_request") {
    const expected = context.payload.pull_request;
    assert.ok(expected && Number.isSafeInteger(expected.number));
    assert.deepEqual(selected, { sha: context.sha, ref: `refs/pull/${expected.number}/merge` });
    const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: expected.number });
    assert.equal(current.state, "open");
    assert.equal(current.head.sha, expected.head.sha, "PR head changed");
    assert.equal(current.base.sha, expected.base.sha, "PR base changed");
    assert.equal(current.head.repo.full_name, expected.head.repo.full_name);
    upload = current.head.repo.full_name === REPOSITORY;
  } else if (context.eventName === "workflow_dispatch" && context.payload.inputs?.number) {
    const inputs = context.payload.inputs;
    assert.match(inputs.number, /^[1-9][0-9]*$/);
    assert.equal(inputs.expected_head, context.sha);
    assert.deepEqual(selected, { sha: context.sha, ref: context.ref });
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(inputs.number) });
    assert.equal(pr.state, "open");
    assert.equal(pr.draft, false);
    assert.equal(pr.user.login, "dependabot[bot]");
    assert.equal(pr.user.id, 49699333);
    assert.equal(pr.head.repo.full_name, REPOSITORY);
    assert.equal(pr.head.sha, selected.sha);
    assert.equal(`refs/heads/${pr.head.ref}`, selected.ref);
    assert.equal(pr.base.ref, "main");
    assert.equal(pr.base.sha, await getRef("refs/heads/main"), "Prepared base changed");
  } else if (sha) {
    assert.equal(context.eventName, "workflow_dispatch");
    assert.equal(context.workflow, "release");
    assert.equal(context.ref, "refs/heads/main");
    assert.match(ref, /^refs\/heads\/release\/\d+\.\d+\.\d+$/);
    assert.equal(context.sha, await getRef("refs/heads/main"), "Release base changed");
    const { data: commit } = await github.rest.git.getCommit({ ...context.repo, commit_sha: sha });
    assert.equal(commit.parents.length, 1);
    assert.equal(commit.parents[0].sha, context.sha, "Candidate was not prepared from this main revision");
  } else {
    assert.ok(["push", "schedule", "workflow_dispatch"].includes(context.eventName));
    assert.equal(context.ref, "refs/heads/main");
  }
  const currentSha = await getRef(selected.ref);
  if (context.eventName === "pull_request" && currentSha !== selected.sha) {
    // GitHub can regenerate synthetic merge metadata. Retain the event identity
    // only when the complete tree and ordered PR parents prove equivalent content.
    assert.match(currentSha, SHA);
    const expected = context.payload.pull_request;
    const commits = await Promise.all(
      [selected.sha, currentSha].map(
        async (commit_sha) => (await github.rest.git.getCommit({ ...context.repo, commit_sha })).data,
      ),
    );
    for (const commit of commits) {
      assert.deepEqual(
        commit.parents.map((parent) => parent.sha),
        [expected.base.sha, expected.head.sha],
        "Candidate merge parents changed",
      );
      assert.match(commit.tree.sha, SHA);
    }
    assert.equal(commits[0].tree.sha, commits[1].tree.sha, "Candidate merge tree changed");
  } else {
    assert.equal(currentSha, selected.sha, "Candidate ref changed");
  }
  return { ...selected, upload };
}

module.exports = { identify };
