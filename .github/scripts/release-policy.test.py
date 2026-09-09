"""Exercise release policy against meaningful workflow and source mutations."""

import json
import os
import sys
import tempfile
import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path.cwd()
GUARD = ROOT / ".github/workflows/policy-guard.yml"
ROUTER = (ROOT / ".github/workflows/publish.yml").exists()
MAIN = ".github/workflows/publish.yml" if ROUTER else ".github/workflows/main.yml"
PATHS = [
    ".github/workflows/policy-guard.yml",
    MAIN,
    ".github/workflows/release.yml",
    ".github/workflows/ci.yml",
    ".github/scripts/release.cjs",
    ".github/scripts/release-settings.cjs",
    ".github/rulesets/protect-release-branches.json",
]
if ROUTER:
    PATHS.append(".github/scripts/publish-image.sh")


def policy(overrides=None):
    files = {
        str(path.relative_to(ROOT)): path.read_text()
        for path in (ROOT / ".github").rglob("*")
        if path.is_file() and path.suffix in {".yml", ".yaml", ".cjs", ".py", ".sh", ".json"}
    }
    files["package.json"] = (ROOT / "package.json").read_text()
    files.update(overrides or {})
    guard = yaml.safe_load(GUARD.read_text())
    steps = guard["jobs"]["guard"]["steps"]
    if ROUTER:
        script = next(step["with"]["script"] for step in steps if "with" in step)
        driver = r"""
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const failures = [];
const github = { paginate: async () => input.paths.map(filename => ({filename, status: 'modified'})),
  rest: { pulls: {listFiles() {}}, repos: {getContent: async ({path}) => ({data: {
    content: Buffer.from(input.files[path]).toString('base64'), encoding: 'base64'
  }})}}};
const context = {repo: {owner: 'test', repo: 'test'}, payload: {pull_request: {number: 1, head: {sha: 'test'}}}};
const core = {setFailed: text => failures.push(text), info() {}};
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
new AsyncFunction('github', 'context', 'core', 'require', input.script)(github, context, core, require)
  .then(() => process.stdout.write(JSON.stringify(failures))).catch(error => {console.error(error); process.exit(1);});
"""
        result = subprocess.run(
            ["node", "-e", driver],
            input=json.dumps({"script": script, "files": files, "paths": PATHS}),
            text=True,
            capture_output=True,
            check=True,
        )
        return json.loads(result.stdout)
    source = ""
    for step in steps:
        run = step.get("run", "")
        if "cat <<'POLICY_SOURCE'" in run:
            source += run.split("\n", 2)[2].rsplit("\nPOLICY_SOURCE", 1)[0] + "\n"
    # Exercise the guard's existing fixture mode in its own process, including
    # its real author checks and main entry point. Do not evaluate source in the
    # test runner or disable the repository's dynamic-execution security rule.
    with tempfile.TemporaryDirectory(prefix="release-policy-") as temporary:
        directory = Path(temporary)
        program = directory / "policy_guard.py"
        program.write_text(source)
        fixtures = directory / "fixtures"
        fixtures.mkdir()
        for path, content in files.items():
            target = fixtures / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        for name, value in {
            "head_sha": "a" * 40,
            "author_association": "OWNER",
            "author_login": "test-owner",
        }.items():
            (fixtures / name).write_text(value)
        changed = directory / "files.json"
        changed.write_text(json.dumps([{"filename": path, "status": "modified"} for path in PATHS]))
        result = subprocess.run(
            [sys.executable, str(program)],
            env={**os.environ, "GUARD_FIXTURE_DIR": str(fixtures), "FILES_JSON": str(changed)},
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        return [] if result.returncode == 0 else [result.stdout + result.stderr]


class ReleasePolicyTests(unittest.TestCase):
    def test_workflow_release_contract(self):
        main = yaml.safe_load((ROOT / MAIN).read_text())
        events = main.get("on", main.get(True))
        self.assertEqual(events["push"], {"branches": ["main"]})
        self.assertEqual(events["workflow_dispatch"]["inputs"]["create_release"]["default"], False)
        prepare = main["jobs"]["prepare-release"]
        for condition in ["workflow_dispatch", "refs/heads/main", "inputs.create_release"]:
            self.assertIn(condition, prepare["if"])
        self.assertEqual(prepare["environment"], "release-automation")
        self.assertTrue({"quality", "aislop", "codeql"} <= set(prepare["needs"]))
        release = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text())
        self.assertEqual(
            release.get("on", release.get(True)), {"push": {"branches": ["release/*"]}}
        )
        self.assertNotEqual(main["concurrency"]["group"], release["concurrency"]["group"])
        publish = main["jobs"]["publish"]
        self.assertTrue({"quality", "aislop", "codeql"} <= set(publish["needs"]))
        self.assertNotIn("sonar", publish["needs"])
        steps = {step.get("name"): step for step in publish["steps"]}
        if ROUTER:
            self.assertIn("publish", prepare["needs"])
            for name in [
                "Log in to GHCR",
                "Log in to Docker Hub",
                "Push the scanned image",
                "Release App token",
            ]:
                self.assertEqual(steps[name]["if"], "startsWith(github.ref, 'refs/heads/release/')")
            for name in ["SonarQube analysis", "SonarQube quality gate"]:
                self.assertIn("github.ref == 'refs/heads/main'", steps[name]["if"])
            self.assertEqual(
                steps["Publish immutable release"]["if"], "steps.push.outputs.published == 'true'"
            )
            self.assertEqual(
                steps["Promote latest released image"]["if"],
                "steps.finalized.outputs.latest == 'true'",
            )
            self.assertIn("Default Compose smoke", steps)
            self.assertIn("Real Hindsight router-storage parity", steps)
            self.assertIn("--exit-code 1", steps["Trivy critical gate"]["run"])
            self.assertEqual(
                publish["env"]["HINDSIGHT_TEST_IMAGE"],
                "${{ needs.quality.outputs.hindsight_image }}",
            )
        else:
            self.assertIn("sonar", prepare["needs"])
            self.assertEqual(publish["if"], "startsWith(github.ref, 'refs/heads/release/')")
            self.assertEqual(main["jobs"]["sonar"]["if"], "github.ref == 'refs/heads/main'")

    def test_reviewed_release_workflows_pass(self):
        self.assertEqual(policy(), [])

    def test_main_publishing_and_release_gate_bypass_fail(self):
        original = (ROOT / MAIN).read_text()
        mutations = [
            original.replace(
                "startsWith(github.ref, 'refs/heads/release/')", "github.ref == 'refs/heads/main'"
            ),
            original.replace(
                "      - name: Release preflight",
                "      - if: false\n        name: Release preflight",
            ),
            original.replace("needs: [quality, aislop, codeql", "needs: [quality, codeql"),
        ]
        for content in mutations:
            with self.subTest(content=content[:30]):
                self.assertNotEqual(content, original)
                self.assertTrue(policy({MAIN: content}))

    def test_new_manual_release_trigger_fails(self):
        path = ".github/workflows/release.yml"
        self.assertTrue(
            policy(
                {path: (ROOT / path).read_text().replace("on:\n", "on:\n  workflow_dispatch:\n")}
            )
        )

    def test_release_script_mutation_fails(self):
        path = ".github/scripts/release.cjs"
        self.assertTrue(
            policy({path: (ROOT / path).read_text().replace("if (!condition)", "if (false)")})
        )

    def test_scan_neutralization_fails(self):
        path = ".github/workflows/ci.yml"
        name = "Trivy PR gate" if ROUTER else "Trivy dependency gate"
        changed = (
            (ROOT / path)
            .read_text()
            .replace(
                f"      - name: {name}", f"      - continue-on-error: true\n        name: {name}"
            )
        )
        self.assertTrue(policy({path: changed}))

    def test_full_action_pin_refresh_is_allowed(self):
        doc = yaml.safe_load((ROOT / MAIN).read_text())
        action = next(
            step["uses"]
            for job in doc["jobs"].values()
            for step in job.get("steps", [])
            if "uses" in step
        )
        changed = (ROOT / MAIN).read_text().replace(action, action.split("@")[0] + "@" + "f" * 40)
        self.assertEqual(policy({MAIN: changed}), [])


if __name__ == "__main__":
    unittest.main()
