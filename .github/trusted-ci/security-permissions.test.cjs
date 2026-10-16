const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

function policy(scenario) {
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `import importlib.util, json, sys
from pathlib import Path
import yaml
spec = importlib.util.spec_from_file_location("release_policy", ".github/scripts/release-policy.test.py")
release_policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_policy)
release_policy.PATHS.extend(str(path) for path in Path(".github/workflows").glob("*.yml"))
scenario = json.load(sys.stdin)
path = scenario.get("path")
overrides = {}
if path:
    release_policy.PATHS.append(path)
    if "workflow" in scenario:
        overrides[path] = scenario["workflow"]
    else:
        doc = yaml.safe_load(Path(path).read_text())
        doc["jobs"]["candidate-upload"] = {
            "runs-on": "ubuntu-latest",
            "permissions": {"security-events": "write"},
            "steps": [{"run": "echo candidate-controlled-upload"}],
        }
        overrides[path] = yaml.safe_dump(doc)
print(json.dumps(release_policy.policy(overrides)))`,
      ],
      { input: JSON.stringify(scenario), encoding: "utf8" },
    ),
  );
}

function candidateWorkflow(event, scope) {
  return `name: candidate upload
'on': ${event}
permissions:
  contents: read
${scope === "top-level" ? "  security-events: write\n" : ""}jobs:
  upload:
    runs-on: ubuntu-latest
${scope === "job" ? "    permissions:\n      security-events: write\n" : ""}    steps:
      - run: echo candidate-controlled-upload
`;
}

const candidatePath = ".github/workflows/candidate-upload.yml";

test("read-only candidate workflows and all reviewed workflows remain admitted", () => {
  assert.deepEqual(policy({}), []);
  assert.deepEqual(policy({ path: candidatePath, workflow: candidateWorkflow("push", "read-only") }), []);
});

for (const event of ["push", "pull_request", "workflow_call"]) {
  for (const scope of ["top-level", "job"]) {
    test(`${event} candidate execution cannot grant ${scope} SARIF write permission`, () => {
      const failures = policy({ path: candidatePath, workflow: candidateWorkflow(event, scope) });
      assert.match(
        failures.join("\n"),
        new RegExp(
          `${scope === "job" ? "job upload" : scope} permission security-events: write is not in the allowlist`,
        ),
      );
    });
  }
}

for (const name of [
  "aislop",
  "codeql",
  "ci",
  "trusted-ci",
  "trusted-aislop",
  "trusted-codeql",
  "main",
  "pr-validation",
  "release",
]) {
  test(`${name} reviewed workflow cannot add a candidate SARIF writer`, () => {
    const path = `.github/workflows/${name}.yml`;
    const failures = policy({ path });
    assert.ok(failures.length > 0, `${path} admitted candidate execution with security-events: write`);
  });
}
