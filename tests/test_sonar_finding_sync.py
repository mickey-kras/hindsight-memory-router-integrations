from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import unittest
import urllib.error
from pathlib import Path
from types import ModuleType
from unittest.mock import patch


def load_sync_module() -> ModuleType:
    path = Path(__file__).parents[1] / ".github/scripts/sync-sonar-findings.py"
    spec = importlib.util.spec_from_file_location("sync_sonar_findings", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


sync = load_sync_module()


class SonarFindingSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = patch.dict(
            os.environ,
            {
                "GITHUB_SHA": "abc123",
                "GITHUB_SERVER_URL": "https://github.com",
                "GITHUB_REPOSITORY": "owner/repo",
                "GITHUB_RUN_ID": "42",
                "SONAR_HOST_URL": "https://sonar.example",
            },
        )
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()

    def test_individual_finding_and_aggregate_condition_are_tracked(self) -> None:
        gate = {
            "projectStatus": {
                "conditions": [
                    {
                        "status": "ERROR",
                        "metricKey": "new_coverage",
                        "actualValue": "79.0",
                        "comparator": "LT",
                        "errorThreshold": "80",
                    }
                ]
            }
        }
        issues = [
            {
                "key": "issue-1",
                "component": "project:src/plugin.ts",
                "line": 30,
                "message": "Refactor this function",
                "type": "CODE_SMELL",
                "severity": "MAJOR",
                "rule": "typescript:S3776",
            }
        ]

        findings = sync.tracked_findings(gate, issues, [], "project")

        self.assertEqual(
            [finding.key for finding in findings],
            ["issue-issue-1", "condition-new_coverage"],
        )
        self.assertIn("Rule: `typescript:S3776`", findings[0].body)
        self.assertIn("Actual: `79.0`", findings[1].body)

    def test_failed_conditions_are_fallback_when_no_findings_exist(self) -> None:
        gate = {
            "projectStatus": {
                "conditions": [
                    {"status": "ERROR", "metricKey": "new_reliability_rating"},
                    {"status": "ERROR", "metricKey": "new_security_rating"},
                ]
            }
        }

        findings = sync.tracked_findings(gate, [], [], "project")

        self.assertEqual(
            [finding.key for finding in findings],
            ["condition-new_reliability_rating", "condition-new_security_rating"],
        )

    def test_hotspots_create_stable_finding_keys(self) -> None:
        gate = {
            "projectStatus": {
                "conditions": [
                    {"status": "ERROR", "metricKey": "new_security_hotspots_reviewed"}
                ]
            }
        }
        hotspots = [
            {"key": "hotspot-1", "component": "project:src/plugin.ts", "line": 10},
            {"key": "hotspot-2", "component": "project:src/runtime.ts", "line": 20},
        ]

        findings = sync.tracked_findings(gate, [], hotspots, "project")

        self.assertEqual(
            [finding.key for finding in findings],
            ["hotspot-hotspot-1", "hotspot-hotspot-2"],
        )

    def test_forbidden_issue_api_preserves_failed_category(self) -> None:
        gate = {
            "projectStatus": {
                "conditions": [{"status": "ERROR", "metricKey": "new_reliability_rating"}]
            }
        }

        findings = sync.tracked_findings(
            gate,
            [],
            [],
            "project",
            issues_forbidden=True,
        )

        self.assertEqual([finding.key for finding in findings], ["condition-new_reliability_rating"])

    def test_optional_page_falls_back_only_for_forbidden(self) -> None:
        class Client:
            @staticmethod
            def paged(*_: object, **__: object) -> list[dict[str, object]]:
                raise urllib.error.HTTPError("https://sonar.example", 403, "Forbidden", {}, None)

        result = sync.optional_paged(Client(), "/api/issues/search", "issues")

        self.assertEqual(result.values, [])
        self.assertTrue(result.forbidden)

    def test_optional_page_preserves_other_http_errors(self) -> None:
        class Client:
            @staticmethod
            def paged(*_: object, **__: object) -> list[dict[str, object]]:
                raise urllib.error.HTTPError("https://sonar.example", 500, "Failure", {}, None)

        with self.assertRaises(urllib.error.HTTPError):
            sync.optional_paged(Client(), "/api/issues/search", "issues")

    def test_closed_finding_is_reopened_and_updated(self) -> None:
        calls: list[tuple[str, ...]] = []

        def run(args: tuple[str, ...], **_: object) -> subprocess.CompletedProcess[str]:
            calls.append(args)
            stdout = ""
            if args[:3] == ("gh", "issue", "list"):
                stdout = json.dumps(
                    [
                        {
                            "number": 180,
                            "state": "CLOSED",
                            "body": "<!-- sonar-finding:hotspot-stable-key -->",
                        }
                    ]
                )
            return subprocess.CompletedProcess(args, 0, stdout=stdout, stderr="")

        tracker = sync.GitHubTracker("owner", run=run)
        reference = tracker.upsert(
            sync.TrackedFinding("hotspot-stable-key", "title", "updated body")
        )

        self.assertEqual(reference, "#180")
        self.assertIn(("gh", "issue", "reopen", "180"), calls)
        self.assertTrue(any(call[:4] == ("gh", "issue", "edit", "180") for call in calls))
        self.assertFalse(any(call[:3] == ("gh", "issue", "create") for call in calls))


if __name__ == "__main__":
    unittest.main()
