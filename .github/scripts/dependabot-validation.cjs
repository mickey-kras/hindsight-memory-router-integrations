const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, dirname } = require("node:path");
const { dependencyCommits } = require("./dependabot-preparation.cjs");
const { DOCKERFILE } = require("./docker-provenance.cjs");
const { CODING, INPUTS, generatedPaths } = require("./dependency-files.cjs");

const VALIDATION_JOBS = [
  "guard",
  "quality / checks",
  "quality / release combination",
  "aislop / aislop status",
  "codeql / analyze",
  "branch-policy / branch name",
  "dependabot-policy / policy-tests",
];

async function latestValidation(github, repo, pull) {
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...repo,
    workflow_id: "pr-validation.yml",
    branch: pull.head.ref,
    head_sha: pull.head.sha,
    per_page: 100,
  });
  const applicable = runs.filter(
    (run) =>
      run.head_sha === pull.head.sha &&
      run.head_branch === pull.head.ref &&
      ["pull_request", "workflow_dispatch"].includes(run.event),
  );
  if (applicable.some((run) => run.status !== "completed" || !Number.isFinite(Date.parse(run.run_started_at)))) {
    return undefined;
  }
  // Reruns retain their run ID; order attempts by start, not completion time.
  applicable.sort((a, b) => Date.parse(b.run_started_at) - Date.parse(a.run_started_at));
  if (applicable.length > 1 && Date.parse(applicable[0].run_started_at) === Date.parse(applicable[1].run_started_at)) {
    return { ambiguous: true };
  }
  return applicable[0];
}

async function validationEligibility(github, context, pull) {
  const run = await latestValidation(github, context.repo, pull);
  if (run?.ambiguous) {
    return "Latest PR validation executions have tied start timestamps; run validation again before auto-merge";
  }
  if (run?.status !== "completed" || run.conclusion !== "success") {
    return "Waiting for successful PR validation at the current head";
  }
  // A successful workflow can contain a failed advisory combination job.
  // GitHub's latest filter excludes jobs superseded by a rerun.
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo,
    run_id: run.id,
    filter: "latest",
    per_page: 100,
  });
  if (
    VALIDATION_JOBS.some((name) => jobs.filter((job) => job.name === name).length !== 1) ||
    jobs.some((job) => job.status !== "completed" || job.conclusion !== "success")
  ) {
    return "Every PR validation job must pass, including release combination and policy tests";
  }
  const current = await latestValidation(github, context.repo, pull);
  if (
    !current ||
    current.id !== run.id ||
    current.run_attempt !== run.run_attempt ||
    current.run_started_at !== run.run_started_at ||
    current.updated_at !== run.updated_at ||
    current.status !== "completed" ||
    current.conclusion !== "success"
  ) {
    return "PR validation changed during evaluation; retry on the next refresh";
  }
  return null;
}

async function readFile(github, repo, path, ref) {
  const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
  if (data?.type !== "file" || data.submodule_git_url !== undefined || data.target !== undefined) {
    throw new Error(`Not a regular file: ${path}`);
  }
  let content = data;
  // Contents omits bytes above 1 MiB. Resolve only the blob from this pinned
  // path/ref response, never a moving branch or a supplied download URL.
  if (data.encoding === "none") {
    if (!/^[0-9a-f]{40}$/.test(data.sha) || data.content !== "" || !Number.isSafeInteger(data.size) || data.size < 0) {
      throw new Error(`Invalid file metadata: ${path}`);
    }
    ({ data: content } = await github.rest.git.getBlob({ ...repo, file_sha: data.sha }));
    if (content?.sha !== data.sha || content.size !== data.size) throw new Error(`Invalid blob metadata: ${path}`);
  }
  if (content.encoding !== "base64" || typeof content.content !== "string") {
    throw new Error(`Invalid file encoding: ${path}`);
  }
  const encoded = content.content.replace(/[\r\n]/g, "");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) throw new Error(`Invalid file content: ${path}`);
  if (data.encoding === "none") {
    const sha = createHash("sha1").update(`blob ${decoded.length}\0`).update(decoded).digest("hex");
    if (decoded.length !== data.size || sha !== data.sha) throw new Error(`Invalid blob content: ${path}`);
  }
  return decoded.toString("utf8");
}

async function runPolicy(github, repo, pull, files) {
  const fixture = mkdtempSync(join(tmpdir(), "prepared-policy-"));
  try {
    for (const [name, value] of Object.entries({
      head_sha: pull.head.sha,
      author_association: pull.author_association,
      author_login: pull.user.login,
      "files.json": JSON.stringify(files),
    }))
      writeFileSync(join(fixture, name), value);
    for (const file of files.filter((file) => file.status !== "removed" && !file.filename.endsWith(".tgz"))) {
      const destination = join(fixture, file.filename);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, await readFile(github, repo, file.filename, pull.head.sha));
    }
    execFileSync("python3", [join(__dirname, "verify-prepared-policy.py"), fixture], {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

async function preparedValidation(github, context, pull) {
  const { data: repository } = await github.rest.repos.get(context.repo);
  const { trustedPull } = require("./dependabot-auto-merge.cjs");
  const params = { ...context.repo, pull_number: pull.number };
  const { data: current } = await github.rest.pulls.get(params);
  if (
    context.ref !== `refs/heads/${repository.default_branch}` ||
    context.sha !== current.base.sha ||
    !trustedPull(current, repository.full_name, repository.default_branch) ||
    current.head.sha !== pull.head.sha
  ) {
    throw new Error("Validation requires the current same-repository Dependabot head on main");
  }
  const commits = await github.paginate(github.rest.pulls.listCommits, { ...params, per_page: 100 });
  const original = await dependencyCommits(github, context.repo, current, commits);
  if (original.length === commits.length) throw new Error("Dependency artifacts have not been prepared");
  const manifests = await Promise.all(
    ["package.json", `${CODING}/package.json`].map(async (path) =>
      JSON.parse(await readFile(github, context.repo, path, current.head.sha)),
    ),
  );
  const allowed = [DOCKERFILE, ...INPUTS, ...generatedPaths(...manifests)];
  const files = await github.paginate(github.rest.pulls.listFiles, { ...params, per_page: 100 });
  if (!files.length || files.some((file) => file.status !== "modified" || !allowed.includes(file.filename))) {
    throw new Error("Prepared PR contains changes outside dependencies and generated artifacts");
  }
  return { current, files };
}

async function runDispatchedPolicy(github, context, core, trustedMainSha, policy = runPolicy) {
  const { number, expected_head: expectedHead } = context.payload?.inputs ?? {};
  if (context.eventName !== "workflow_dispatch" || !/^[1-9][0-9]*$/.test(number) || context.sha !== expectedHead) {
    throw new Error("Policy job requires the dispatched Dependabot commit");
  }
  const params = { ...context.repo, pull_number: Number(number) };
  const { data: pull } = await github.rest.pulls.get(params);
  if (pull.head.sha !== expectedHead || context.ref !== `refs/heads/${pull.head.ref}`) {
    throw new Error("Dispatched PR head or branch changed");
  }
  const { current, files } = await preparedValidation(
    github,
    {
      repo: context.repo,
      ref: "refs/heads/main",
      sha: trustedMainSha,
    },
    pull,
  );
  await policy(github, context.repo, current, files);
  const { data: latest } = await github.rest.pulls.get(params);
  if (latest.state !== "open" || latest.head.sha !== current.head.sha || latest.base.sha !== current.base.sha) {
    throw new Error("PR changed during policy validation");
  }
  core.info(`#${current.number}: trusted policy passed at ${current.head.sha}`);
}

async function requestValidation(github, context, pull, core) {
  const { current } = await preparedValidation(github, context, pull);
  for (const workflow of ["pr-validation.yml"]) {
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
      ...context.repo,
      workflow_id: workflow,
      branch: current.head.ref,
      head_sha: current.head.sha,
      per_page: 100,
    });
    const existing = runs.some(
      (run) =>
        run.head_sha === current.head.sha &&
        (run.event === "workflow_dispatch" || (workflow === "pr-validation.yml" && run.event === "pull_request")) &&
        !["cancelled", "skipped", "action_required", "stale"].includes(run.conclusion),
    );
    if (!existing) {
      await github.rest.actions.createWorkflowDispatch({
        ...context.repo,
        workflow_id: workflow,
        ref: current.head.ref,
        inputs: { number: String(current.number), expected_head: current.head.sha },
      });
    }
  }
  core.info(`#${current.number}: requested PR validation including guard at ${current.head.sha}`);
}

module.exports = { requestValidation, runPolicy, runDispatchedPolicy, validationEligibility };
