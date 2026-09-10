const { isDeepStrictEqual } = require("node:util");
const {
  CODING,
  PROVENANCE,
  INPUTS,
  hash,
  generatedPaths,
  validateManifest,
  updateProvenance,
} = require("./dependency-files.cjs");

const WORKFLOW = "dependabot-preparation.yml";
const COMMIT_TITLE = "Regenerate dependency artifacts";

function signedDependabot(commit) {
  return (
    commit.author?.login === "dependabot[bot]" && commit.author.id === 49699333 && commit.commit.verification?.verified
  );
}

async function content(github, repo, path, ref) {
  const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
  if (data.type !== "file" || data.encoding !== "base64") throw new Error(`Not a regular file: ${path}`);
  return Buffer.from(data.content, "base64").toString("utf8");
}

async function pathsFor(github, repo, ref) {
  const [root, coding] = await Promise.all(
    ["package.json", `${CODING}/package.json`].map(async (path) => JSON.parse(await content(github, repo, path, ref))),
  );
  return generatedPaths(root, coding);
}

async function dependencyCommits(github, repo, pull, commits) {
  if (!commits.length) throw new Error("No Dependabot commits");
  if (commits.every(signedDependabot)) return commits;
  const original = commits.slice(0, -1);
  const generated = commits.at(-1);
  const parent = original.at(-1)?.sha;
  if (
    !original.length ||
    !original.every(signedDependabot) ||
    generated.sha !== pull.head.sha ||
    !(
      generated.author?.id === pull.base.repo.owner.id ||
      (generated.author?.login === "github-actions[bot]" && generated.author.id === 41898282)
    ) ||
    !generated.commit.verification?.verified ||
    generated.commit.message.trim() !== `${COMMIT_TITLE}\n\nDependabot-Head: ${parent}`
  ) {
    throw new Error("Unsigned or untrusted commits require manual review");
  }
  const { data } = await github.rest.repos.getCommit({ ...repo, ref: generated.sha, per_page: 100 });
  const allowed = await pathsFor(github, repo, parent);
  if (
    data.parents.length !== 1 ||
    data.parents[0].sha !== parent ||
    !data.files.length ||
    data.files.length > allowed.length ||
    data.files.some((file) => file.status !== "modified" || !allowed.includes(file.filename))
  ) {
    throw new Error("Preparation commit changed files outside generated artifacts");
  }
  const signature = await github.graphql(
    `query($owner: String!, $repo: String!, $sha: GitObjectID!) {
    repository(owner: $owner, name: $repo) { object(oid: $sha) { ... on Commit {
      signature { isValid wasSignedByGitHub }
    } } }
  }`,
    { ...repo, sha: generated.sha },
  );
  if (!signature.repository.object.signature?.isValid || !signature.repository.object.signature.wasSignedByGitHub) {
    throw new Error("Preparation commit must be signed by GitHub");
  }
  return original;
}

async function inspect(github, context, number, expectedHead) {
  if (!Number.isSafeInteger(number) || number <= 0 || !/^[0-9a-f]{40}$/.test(expectedHead)) {
    throw new Error("Invalid preparation request");
  }
  const params = { ...context.repo, pull_number: number };
  const { data: pull } = await github.rest.pulls.get(params);
  const { data: repository } = await github.rest.repos.get(context.repo);
  if (
    context.ref !== `refs/heads/${repository.default_branch}` ||
    pull.base.ref !== repository.default_branch ||
    pull.state !== "open" ||
    pull.draft ||
    pull.user.login !== "dependabot[bot]" ||
    pull.user.id !== 49699333 ||
    pull.head.repo.full_name !== repository.full_name ||
    !pull.head.ref.startsWith("dependabot/") ||
    pull.head.sha !== expectedHead
  )
    throw new Error("Preparation requires the current same-repository Dependabot head");
  const commits = await github.paginate(github.rest.pulls.listCommits, { ...params, per_page: 100 });
  if (!commits.length || !commits.every(signedDependabot))
    throw new Error("Preparation requires signed Dependabot commits");
  const files = await github.paginate(github.rest.pulls.listFiles, { ...params, per_page: 100 });
  if (!files.length || files.some((file) => file.status !== "modified" || !INPUTS.includes(file.filename))) {
    throw new Error("Preparation only accepts npm dependency files");
  }
  for (const path of ["package.json", `${CODING}/package.json`]) {
    const before = JSON.parse(await content(github, context.repo, path, pull.base.sha));
    const after = JSON.parse(await content(github, context.repo, path, expectedHead));
    validateManifest(before, after);
  }
  return { pull, commits, paths: await pathsFor(github, context.repo, expectedHead) };
}

async function requestPreparation(github, context, pull, core) {
  const params = { ...context.repo, pull_number: pull.number };
  const files = await github.paginate(github.rest.pulls.listFiles, { ...params, per_page: 100 });
  if (!files.some((file) => INPUTS.includes(file.filename))) return false;
  if (files.some((file) => !INPUTS.includes(file.filename))) throw new Error("Dependency PR has unexpected changes");
  const title = `Prepare dependencies #${pull.number} at ${pull.head.sha}`;
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...context.repo,
    workflow_id: WORKFLOW,
    branch: pull.base.ref,
    event: "workflow_dispatch",
    per_page: 100,
  });
  if (!runs.some((run) => run.display_title === title && !["cancelled", "skipped"].includes(run.conclusion))) {
    await github.rest.actions.createWorkflowDispatch({
      ...context.repo,
      workflow_id: WORKFLOW,
      ref: pull.base.ref,
      inputs: { number: String(pull.number), expected_head: pull.head.sha },
    });
  }
  core.info(`#${pull.number}: waiting for dependency artifact preparation`);
  return true;
}

async function requestRecreate(github, context, pull, core) {
  const { data: main } = await github.rest.git.getRef({ ...context.repo, ref: `heads/${pull.base.ref}` });
  const { data } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${pull.head.sha}...${main.object.sha}`,
  });
  if (data.ahead_by === 0) return false;
  if (!Number.isInteger(data.ahead_by) || data.ahead_by < 0) throw new Error("Invalid branch comparison");
  const params = { ...context.repo, issue_number: pull.number };
  const body = `@dependabot recreate\n\n<!-- dependency-refresh:${pull.head.sha} -->`;
  const comments = await github.paginate(github.rest.issues.listComments, { ...params, per_page: 100 });
  if (!comments.some((comment) => comment.body === body && comment.user.id === 41898282)) {
    const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: pull.number });
    if (current.state !== "open" || current.head.sha !== pull.head.sha) return true;
    await github.rest.issues.createComment({ ...params, body });
  }
  core.info(`#${pull.number}: waiting for Dependabot to recreate on current main`);
  return true;
}

async function publish(github, context, payload, metadataPath, metadata) {
  const { pull, paths } = await inspect(github, context, payload.number, payload.head);
  const { fetchMetadata, updateEligibility } = require("./dependabot-auto-merge.cjs");
  const reason = updateEligibility(
    (metadata ?? fetchMetadata)(pull, `${context.repo.owner}/${context.repo.repo}`, metadataPath),
  );
  if (reason) throw new Error(reason);
  if (payload.base !== pull.base.sha) throw new Error("Base changed during preparation");
  if (
    !Array.isArray(payload.files) ||
    payload.files.length !== paths.length ||
    new Set(payload.files.map((file) => file.path)).size !== paths.length ||
    payload.files.some(
      (file) =>
        !paths.includes(file.path) || typeof file.contents !== "string" || file.contents.length > 24 * 1024 * 1024,
    )
  ) {
    throw new Error("Invalid generated artifact set");
  }
  const files = new Map(payload.files.map((file) => [file.path, Buffer.from(file.contents, "base64")]));
  if (payload.files.some((file) => files.get(file.path).toString("base64") !== file.contents))
    throw new Error("Invalid artifact encoding");
  const expectedProvenance = updateProvenance(
    JSON.parse(await content(github, context.repo, PROVENANCE, payload.head)),
    await content(github, context.repo, `${CODING}/package.json`, payload.head),
    await content(github, context.repo, `${CODING}/npm-shrinkwrap.json`, payload.head),
  );
  if (!isDeepStrictEqual(JSON.parse(files.get(PROVENANCE).toString()), expectedProvenance)) {
    throw new Error("Generated provenance changes non-dependency entries");
  }
  const checksums = paths
    .filter((path) => path.endsWith(".tgz"))
    .sort()
    .map((path) => `${hash(files.get(path))}  ${path}\n`)
    .join("");
  if (files.get("PACKAGE_SHA256").toString() !== checksums) throw new Error("Package checksum mismatch");
  const nixHashes = files.get("PACKAGE_NIX_HASHES").toString();
  const sourceHash = `source=sha256-${hash(files.get(paths[3]), "base64")}\n`;
  if (
    !nixHashes.startsWith(sourceHash) ||
    !/^npm_deps=sha256-[A-Za-z0-9+/]{43}=\n$/.test(nixHashes.slice(sourceHash.length))
  ) {
    throw new Error("Invalid package Nix hashes");
  }
  const result = await github.graphql(
    `mutation($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) { commit { oid } }
  }`,
    {
      input: {
        branch: { repositoryNameWithOwner: pull.head.repo.full_name, branchName: pull.head.ref },
        expectedHeadOid: payload.head,
        message: { headline: COMMIT_TITLE, body: `Dependabot-Head: ${payload.head}` },
        fileChanges: { additions: payload.files },
      },
    },
  );
  return result.createCommitOnBranch.commit.oid;
}

module.exports = { dependencyCommits, inspect, requestPreparation, requestRecreate, publish };
