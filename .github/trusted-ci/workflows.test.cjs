const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { resolve } = require("node:path");
const { readFileSync } = require("node:fs");
const root = resolve(__dirname, "..");
function workflow(name) {
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))",
        `${root}/workflows/${name}.yml`,
      ],
      { encoding: "utf8" },
    ),
  );
}
test("candidate execution has read-only permissions and fresh independent required scans", () => {
  const ci = workflow("trusted-ci");
  for (const name of ["build", "combination"]) {
    const job = ci.jobs[name];
    assert.deepEqual(job.permissions, { contents: "read" });
    assert.ok(!job.steps.some((s) => /upload-sarif|codeql-action\/analyze/.test(s.uses || "")));
  }
  assert.ok(
    ci.jobs.build.steps.some((step) => step.run === "python3 -m unittest discover -s scripts -p test_sync_upstream.py"),
  );
  assert.deepEqual(ci.jobs.checks.needs, ["build", "security"]);
  assert.deepEqual(ci.jobs.checks.permissions, {});
  assert.equal(ci.jobs.checks.if, "${{ always() }}");
  assert.match(ci.jobs.checks.steps[0].run, /test "\$BUILD" = success\ntest "\$SECURITY" = success/);
  assert.equal(ci.jobs.checks.outputs.coverage_artifact, "${{ needs.build.outputs.coverage_artifact }}");
  assert.equal(ci.jobs.combination.name, "release combination");
});
test("privileged scanners use immutable helper checkout, no candidate install/cache or artifact input", () => {
  for (const [file, jobName] of [
    ["trusted-ci", "security"],
    ["trusted-aislop", "status"],
    ["trusted-codeql", "analyze"],
  ]) {
    const job = workflow(file).jobs[jobName];
    const steps = job.steps;
    const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
    assert.equal(checkouts.length, 2);
    assert.equal(checkouts[0].with.ref, "${{ job.workflow_sha }}");
    assert.equal(checkouts[0].with.repository, "${{ job.workflow_repository }}");
    assert.equal(checkouts[0].with.path, "trusted");
    assert.equal(checkouts[1].with.path, "candidate");
    assert.equal(checkouts[1].with.ref, "${{ steps.identity.outputs.sha }}");
    for (const step of steps) {
      assert.doesNotMatch(step.uses || "", /actions\/(cache|download-artifact)@/);
      assert.doesNotMatch(step.run || "", /npm (?:run|test)|(?:node|bash) candidate\//);
      if (/npm ci/.test(step.run || "")) {
        assert.match(step.run, /--prefix trusted\/.github\/trusted-ci --ignore-scripts/);
      }
      if (step.uses?.startsWith("actions/setup-node@")) assert.equal(step.with["package-manager-cache"], false);
      if (step.uses?.startsWith("aquasecurity/trivy-action@")) assert.equal(step.with.cache, false);
      if (step.uses?.startsWith("github/codeql-action/upload-sarif@")) {
        assert.equal(step.with.ref, "${{ steps.revalidated.outputs.ref }}");
        assert.equal(step.with.sha, "${{ steps.revalidated.outputs.sha }}");
        assert.match(step.if, /revalidated.outputs.upload == 'true'/);
      }
    }
  }
});
test("scanner configuration and commands disable candidate tool execution and suppression", () => {
  const security = workflow("trusted-ci").jobs.security.steps;
  const gitleaks = security.find((s) => s.name === "Gitleaks").run;
  assert.match(gitleaks, /9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c/);
  assert.match(gitleaks, /--ignore-gitleaks-allow/);
  assert.match(gitleaks, /--gitleaks-ignore-path trusted\/\.github\/trusted-ci\/gitleaksignore/);
  const semgrep = security.find((s) => s.name === "Semgrep").run;
  assert.match(semgrep, /--config \/trusted\/\.semgrep.yml --no-git-ignore/);
  assert.match(semgrep, /scan:\/src:ro/);
  const wrapper = readFileSync(resolve(__dirname, "aislop.mjs"), "utf8");
  assert.match(wrapper, /process.env.PATH = safeTools.safePath/);
  assert.match(wrapper, /loadConfig\(trusted\)/);
  assert.match(wrapper, /process.env.AISLOP_NO_TELEMETRY = ['"]1['"]/);
});
