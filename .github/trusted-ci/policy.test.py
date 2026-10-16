"""Exercise trusted scanner activation against the policy guard."""
import importlib.util
import json
from pathlib import Path
import unittest

import yaml

ROOT = Path.cwd()
spec = importlib.util.spec_from_file_location("release_policy_tests", ROOT / ".github/scripts/release-policy.test.py")
release_policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_policy)
TRUSTED_FILES = sorted(str(path.relative_to(ROOT)) for path in (ROOT / ".github/trusted-ci").rglob("*")
                       if path.is_file() and "node_modules" not in path.parts)
release_policy.PATHS.extend(TRUSTED_FILES)
release_policy.PATHS.extend(f".github/workflows/trusted-{name}.yml" for name in ("ci", "aislop", "codeql"))
release_policy.PATHS.append(".github/scripts/trusted-ci-activation.json")


def policy(overrides=None):
    files = {path: (ROOT / path).read_text() for path in TRUSTED_FILES}
    files.update(overrides or {})
    return release_policy.policy(files)


class TrustedScannerBootstrapTests(unittest.TestCase):
    def activation(self):
        return json.loads((ROOT / ".github/scripts/trusted-ci-activation.json").read_text())

    def test_future_callers_are_admitted_only_at_the_reviewed_immutable_source(self):
        fixture = self.activation()
        self.assertRegex(fixture["source_sha"], r"^[a-f0-9]{40}$")
        self.assertEqual(policy({**fixture["workflows"], **fixture["files"]}), [])
        for path, content in fixture["workflows"].items():
            if fixture["source_sha"] not in content:
                continue
            with self.subTest(path=path):
                changed = content.replace(fixture["source_sha"], "f" * 40)
                self.assertTrue(policy({**fixture["workflows"], **fixture["files"], path: changed}))

    def test_activation_test_update_requires_exact_reviewed_bytes(self):
        fixture = self.activation()
        for path, content in fixture["files"].items():
            self.assertTrue(policy({**fixture["workflows"], **fixture["files"], path: content + "\nchanged"}))

    def test_immutable_closure_and_configs_cannot_be_changed_or_disabled(self):
        for path in [
            ".github/trusted-ci/identity.cjs", ".github/trusted-ci/scan-tree.cjs",
            ".github/trusted-ci/.aislop/config.yml", ".github/trusted-ci/package-lock.json",
            ".github/trusted-ci/gitleaksignore", ".github/trusted-ci/trivyignore",
        ]:
            with self.subTest(path=path):
                self.assertTrue(policy({path: (ROOT / path).read_text() + "\nchanged"}))
        path = ".github/workflows/trusted-ci.yml"
        doc = yaml.safe_load((ROOT / path).read_text())
        doc["jobs"]["build"]["permissions"]["security-events"] = "write"
        self.assertTrue(policy({path: yaml.safe_dump(doc)}))

    def test_activation_keeps_required_job_names_and_transitive_permissions(self):
        fixture = self.activation()
        for caller in ["main", "pr-validation"]:
            jobs = yaml.safe_load(fixture["workflows"][f".github/workflows/{caller}.yml"])["jobs"]
            for name, callee in [("quality", "ci"), ("aislop", "aislop"), ("codeql", "codeql")]:
                self.assertEqual(jobs[name]["uses"],
                    "mickey-kras/hindsight-memory-router-integrations/.github/workflows/"
                    f"trusted-{callee}.yml@{fixture['source_sha']}")
                self.assertEqual(jobs[name]["permissions"]["pull-requests"], "read")
        release = yaml.safe_load(fixture["workflows"][".github/workflows/release.yml"])
        for job in ["baseline", "release"]:
            self.assertEqual(release["jobs"][job]["permissions"]["pull-requests"], "read")



if __name__ == "__main__":
    unittest.main()
