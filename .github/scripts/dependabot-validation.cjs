const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, dirname } = require("node:path");
const { dependencyCommits } = require("./dependabot-preparation.cjs");
const { CODING, INPUTS, generatedPaths } = require("./dependency-files.cjs");

async function readFile(github, repo, path, ref) {
  const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
  if (data.type !== "file" || data.encoding !== "base64") throw new Error(`Not a regular file: ${path}`);
  return Buffer.from(data.content, "base64").toString("utf8");
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
    for (const file of files.filter((file) => !file.filename.endsWith(".tgz"))) {
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

async function requestValidation(github, context, pull, core, policy = runPolicy) {
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
  const allowed = [...INPUTS, ...generatedPaths(...manifests)];
  const files = await github.paginate(github.rest.pulls.listFiles, { ...params, per_page: 100 });
  if (!files.length || files.some((file) => file.status !== "modified" || !allowed.includes(file.filename))) {
    throw new Error("Prepared PR contains changes outside dependencies and generated artifacts");
  }
  const checks = await github.paginate(github.rest.checks.listForRef, {
    ...context.repo,
    ref: current.head.sha,
    per_page: 100,
  });
  const externalId = `prepared-policy:${current.head.sha}:${current.base.sha}`;
  const existing = checks.find((check) => check.name === "guard" && check.external_id === externalId);
  if (!existing || existing.status !== "completed") {
    if (existing) {
      const runId = existing.details_url?.match(/\/actions\/runs\/([0-9]+)$/)?.[1];
      if (!runId) throw new Error("Cannot resolve the policy check's workflow run");
      const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: Number(runId) });
      if (run.status !== "completed") {
        core.info(`#${current.number}: policy validation is still running`);
        return;
      }
    }
    const check =
      existing ??
      (
        await github.rest.checks.create({
          ...context.repo,
          name: "guard",
          head_sha: current.head.sha,
          external_id: externalId,
          status: "in_progress",
          details_url: `${context.serverUrl}/${repository.full_name}/actions/runs/${context.runId}`,
        })
      ).data;
    try {
      await policy(github, context.repo, current, files);
      const { data: latest } = await github.rest.pulls.get(params);
      if (latest.state !== "open" || latest.head.sha !== current.head.sha || latest.base.sha !== current.base.sha) {
        throw new Error("PR changed during policy validation");
      }
      await github.rest.checks.update({
        ...context.repo,
        check_run_id: check.id,
        status: "completed",
        conclusion: "success",
        output: {
          title: "Policy guard passed",
          summary: "Validated the prepared commit with the trusted main policy.",
        },
      });
    } catch (error) {
      await github.rest.checks.update({
        ...context.repo,
        check_run_id: check.id,
        status: "completed",
        conclusion: "failure",
        output: { title: "Policy guard failed", summary: error.message.slice(0, 6000) },
      });
      throw error;
    }
  } else if (existing.conclusion !== "success") {
    throw new Error("Prepared policy validation has not passed");
  }
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...context.repo,
    workflow_id: "pr-validation.yml",
    branch: current.head.ref,
    head_sha: current.head.sha,
    event: "workflow_dispatch",
    per_page: 100,
  });
  if (!runs.some((run) => run.head_sha === current.head.sha && !["cancelled", "skipped"].includes(run.conclusion))) {
    await github.rest.actions.createWorkflowDispatch({
      ...context.repo,
      workflow_id: "pr-validation.yml",
      ref: current.head.ref,
      inputs: { number: String(current.number), expected_head: current.head.sha },
    });
  }
  core.info(`#${current.number}: policy passed; requested PR validation at ${current.head.sha}`);
}

module.exports = { requestValidation, runPolicy };
