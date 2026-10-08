from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import ModuleType
from unittest.mock import patch


def load_module(filename: str) -> ModuleType:
    path = Path(__file__).parents[1] / ".github/scripts" / filename
    spec = importlib.util.spec_from_file_location(filename.replace("-", "_"), path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load test module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


masking = load_module("mask-sonar-context.py")
sync = load_module("sync-sonar-findings.py")


class SonarPrivacyTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        environment = patch.dict(
            os.environ, {"GITHUB_ENV": str(Path(temporary.name) / "environment")}
        )
        environment.start()
        self.addCleanup(environment.stop)

    def test_authenticated_settings_request_never_follows_redirect(self) -> None:
        received: list[str | None] = []
        destination_requests: list[str | None] = []

        class Destination(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                destination_requests.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Destination) as destination:
            destination_thread = threading.Thread(target=destination.serve_forever, daemon=True)
            destination_thread.start()
            target = f"http://127.0.0.1:{destination.server_port}/settings"

            class Redirect(BaseHTTPRequestHandler):
                def do_GET(self) -> None:
                    received.append(self.headers.get("Authorization"))
                    self.send_response(302)
                    self.send_header("Location", target)
                    self.end_headers()

                def log_message(self, format: str, *args: object) -> None:
                    pass

            with ThreadingHTTPServer(("127.0.0.1", 0), Redirect) as source:
                source_thread = threading.Thread(target=source.serve_forever, daemon=True)
                source_thread.start()
                try:
                    with self.assertRaisesRegex(ValueError, "redirects are not permitted"):
                        masking.advertised_endpoint(
                            f"http://127.0.0.1:{source.server_port}", "test-token"
                        )
                finally:
                    source.shutdown()
                    source_thread.join()
            destination.shutdown()
            destination_thread.join()
        self.assertEqual(received, ["Bearer test-token"])
        self.assertEqual(destination_requests, [])
        request = urllib.request.Request(
            "https://configured.example", headers={"Authorization": "Bearer test-token"}
        )
        with self.assertRaisesRegex(ValueError, "redirects are not permitted"):
            masking.RejectRedirects().redirect_request(
                request, None, 302, "Found", {}, "http://advertised.example"
            )
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")

    def test_final_create_and_edit_boundary_redacts_both_server_contexts(self) -> None:
        contexts = {
            "GITHUB_SHA": "abc123",
            "GITHUB_SERVER_URL": "https://github.com",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_RUN_ID": "42",
            "SONAR_HOST_URL": "https://configured.example/base",
            "SONAR_ADVERTISED_HOST_URL": "https://advertised.example/sonar",
        }
        fields = "https://configured.example/base CONFIGURED.EXAMPLE https://advertised.example/sonar ADVERTISED.EXAMPLE useful diagnostic"
        with patch.dict(os.environ, contexts):
            findings = (
                sync.issue_finding(
                    {
                        "key": "opaque-issue",
                        "component": "project:" + fields,
                        "line": 7,
                        "message": fields,
                        "rule": fields,
                        "type": fields,
                        "severity": fields,
                    },
                    "project",
                ),
                sync.hotspot_finding(
                    {
                        "key": "opaque-hotspot",
                        "component": "project:" + fields,
                        "line": 8,
                        "message": fields,
                        "securityCategory": fields,
                        "vulnerabilityProbability": fields,
                    },
                    "project",
                ),
                sync.condition_finding(
                    {
                        "metricKey": fields,
                        "actualValue": fields,
                        "comparator": fields,
                        "errorThreshold": fields,
                    },
                    "project",
                ),
            )
            for finding in findings:
                for editing in (False, True):
                    with self.subTest(kind=finding.key, editing=editing):
                        published: list[tuple[str, str]] = []

                        def run(
                            args: tuple[str, ...],
                            key: str = finding.key,
                            existing: bool = editing,
                            result: list[tuple[str, str]] = published,
                            **kwargs: object,
                        ) -> subprocess.CompletedProcess[str]:

                            if args[:3] == ("gh", "issue", "list"):
                                issues = (
                                    [
                                        {
                                            "number": 1,
                                            "body": "<!-- sonar-finding:" + key + " -->",
                                            "state": "OPEN",
                                        }
                                    ]
                                    if existing
                                    else []
                                )
                                return subprocess.CompletedProcess(
                                    args, 0, stdout=json.dumps(issues)
                                )
                            title = args[args.index("--title") + 1]
                            body = Path(args[args.index("--body-file") + 1]).read_text()
                            result.append((title, body))
                            return subprocess.CompletedProcess(args, 0, stdout="#1")

                        sync.GitHubTracker("owner", run=run).upsert(finding)
                        self.assertEqual(len(published), 1)
                        title, body = published[0]
                        for endpoint in ("configured.example", "advertised.example"):
                            self.assertNotIn(endpoint, title.lower())
                            self.assertNotIn(endpoint, body.lower())
                        self.assertIn("useful diagnostic", body)
                        self.assertIn(
                            "Workflow: https://github.com/owner/repo/actions/runs/42", body
                        )
                        if finding.key.startswith(("issue-", "hotspot-")):
                            self.assertEqual(body.count("- Finding ID:"), 1)
        with patch.dict(os.environ, contexts):
            os.environ.pop("SONAR_ADVERTISED_HOST_URL")
            with self.assertRaises(RuntimeError):
                sync.GitHubTracker("owner")

    def test_mask_command_escapes_workflow_data(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            masking.mask("value%\r\n::warning::text")
        self.assertEqual(output.getvalue(), "::add-mask::value%25%0D%0A::warning::text\n")

    def test_url_and_host_masks_cover_dns_ipv4_ipv6(self) -> None:
        cases = (
            ("https://sonar.example:9000/base/", "sonar.example"),
            ("http://192.0.2.8:9000", "192.0.2.8"),
            ("https://[2001:db8::8]:9000/base", "2001:db8::8"),
        )
        for url, host in cases:
            with self.subTest(url=url), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(masking.mask_endpoint(url), url.rstrip("/"))
            lines = output.getvalue().splitlines()
            self.assertIn(f"::add-mask::{url}", lines)
            self.assertIn(f"::add-mask::{host}", lines)
            self.assertIn(f"::add-mask::{url.rstrip('/')}", lines)

    def test_advertised_settings_request_uses_authenticated_configured_server(self) -> None:
        payload = {
            "settings": [
                {"key": "sonar.core.serverBaseURL", "value": "https://advertised.example/base"}
            ]
        }
        with patch.object(
            masking.urllib.request.OpenerDirector,
            "open",
            return_value=io.StringIO(json.dumps(payload)),
        ) as open_url:
            value = masking.advertised_endpoint("https://configured.example/base", "test-token")
        self.assertEqual(value, "https://advertised.example/base")
        request = open_url.call_args.args[0]
        self.assertEqual(
            request.full_url,
            "https://configured.example/base/api/settings/values?keys=sonar.core.serverBaseURL",
        )
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")
        self.assertEqual(open_url.call_args.kwargs["timeout"], 30)

    def test_advertised_settings_fail_closed_without_public_error_details(self) -> None:
        failures = (
            io.StringIO("invalid json"),
            io.StringIO(json.dumps({"settings": []})),
            io.StringIO(
                json.dumps(
                    {
                        "settings": [
                            {"key": "sonar.core.serverBaseURL", "value": "ftp://advertised.example"}
                        ]
                    }
                )
            ),
            OSError("https://advertised.example/private test-token"),
        )
        for failure in failures:
            with (
                self.subTest(failure=type(failure).__name__),
                patch.dict(
                    os.environ,
                    {"SONAR_HOST_URL": "https://configured.example", "SONAR_TOKEN": "test-token"},
                ),
                patch.object(sys, "argv", ["mask", "advertised"]),
                contextlib.redirect_stdout(io.StringIO()),
                contextlib.redirect_stderr(io.StringIO()) as error,
            ):
                options = (
                    {"side_effect": failure}
                    if isinstance(failure, Exception)
                    else {"return_value": failure}
                )
                with patch("urllib.request.OpenerDirector.open", **options):
                    self.assertEqual(masking.main(), 1)
            self.assertEqual(
                error.getvalue(), "Unable to establish masked SonarQube server context.\n"
            )

    def test_advertised_endpoint_masks_both_configured_and_distinct_advertised_host(self) -> None:
        payload = {
            "settings": [
                {"key": "sonar.core.serverBaseURL", "value": "https://advertised.example/base"}
            ]
        }
        with (
            patch.dict(
                os.environ,
                {"SONAR_HOST_URL": "https://configured.example", "SONAR_TOKEN": "test-token"},
            ),
            patch.object(sys, "argv", ["mask", "advertised"]),
            patch.object(
                masking.urllib.request.OpenerDirector,
                "open",
                return_value=io.StringIO(json.dumps(payload)),
            ),
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            self.assertEqual(masking.main(), 0)
        for value in (
            "https://configured.example",
            "configured.example",
            "https://advertised.example/base",
            "advertised.example",
        ):
            self.assertIn(f"::add-mask::{value}\n", output.getvalue())

    def test_invalid_configured_url_is_not_printed(self) -> None:
        for value in (
            "",
            "file:///private",
            "https://user:password@sonar.example",
            "https://sonar.example\n::warning::private",
            "https://sonar.example:invalid",
        ):
            with (
                self.subTest(value=value),
                patch.dict(os.environ, {"SONAR_HOST_URL": value}),
                patch.object(sys, "argv", ["mask", "configured"]),
                contextlib.redirect_stdout(io.StringIO()) as output,
                contextlib.redirect_stderr(io.StringIO()) as error,
            ):
                self.assertEqual(masking.main(), 1)
            self.assertEqual(output.getvalue(), "")
            self.assertEqual(
                error.getvalue(), "Unable to establish masked SonarQube server context.\n"
            )

    def test_workflow_masks_before_network_and_analysis(self) -> None:
        workflows = Path(__file__).parents[1] / ".github/workflows"
        matches = [
            path
            for path in workflows.glob("*.yml")
            if "SonarSource/sonarqube-scan-action@" in path.read_text()
        ]
        self.assertTrue(matches)
        for path in matches:
            with self.subTest(workflow=path.name):
                text = path.read_text()
                self.assertLess(
                    text.index("mask-sonar-context.py configured"),
                    text.index("tailscale/github-action@"),
                )
                self.assertLess(
                    text.index("tailscale/github-action@"),
                    text.index("mask-sonar-context.py advertised"),
                )
                self.assertLess(
                    text.index("mask-sonar-context.py advertised"),
                    text.index("SonarSource/sonarqube-scan-action@"),
                )
                self.assertLess(
                    text.index("SonarSource/sonarqube-scan-action@"),
                    text.index("SonarSource/sonarqube-quality-gate-action@"),
                )

    def test_all_public_finding_kinds_keep_diagnostics_without_server_links(self) -> None:
        public_context = {
            "GITHUB_SHA": "abc123",
            "GITHUB_SERVER_URL": "https://github.com",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_RUN_ID": "42",
        }
        for configured in (True, False):
            with self.subTest(configured=configured), patch.dict(os.environ, public_context):
                if configured:
                    os.environ["SONAR_HOST_URL"] = "https://sonar.example/private"
                else:
                    os.environ.pop("SONAR_HOST_URL", None)
                findings = (
                    sync.issue_finding(
                        {
                            "key": "issue-1",
                            "component": "project:src/app.py",
                            "line": 7,
                            "message": "Refactor this function",
                            "rule": "python:S3776",
                        },
                        "project",
                    ),
                    sync.hotspot_finding(
                        {
                            "key": "hotspot-1",
                            "component": "project:src/app.py",
                            "line": 8,
                            "message": "Review expression",
                            "securityCategory": "dos",
                            "vulnerabilityProbability": "HIGH",
                        },
                        "project",
                    ),
                    sync.condition_finding(
                        {
                            "metricKey": "new_coverage",
                            "actualValue": "79",
                            "comparator": "LT",
                            "errorThreshold": "80",
                        },
                        "project",
                    ),
                )
                for finding in findings:
                    self.assertNotIn("sonar.example", finding.body)
                    self.assertNotIn("- SonarQube:", finding.body)
                    self.assertIn("Detected at commit: `abc123`", finding.body)
                    self.assertIn(
                        "Workflow: https://github.com/owner/repo/actions/runs/42", finding.body
                    )
                self.assertEqual(findings[0].body.count("- Finding ID:"), 1)
                self.assertEqual(findings[1].body.count("- Finding ID:"), 1)
                for text in (
                    "Finding ID: `issue-1`",
                    "Rule: `python:S3776`",
                    "Location: `src/app.py:7`",
                    "Refactor this function",
                ):
                    self.assertIn(text, findings[0].body)
                for text in (
                    "Finding ID: `hotspot-1`",
                    "Location: `src/app.py:8`",
                    "Review expression",
                    "Category: `dos`",
                    "Probability: `HIGH`",
                ):
                    self.assertIn(text, findings[1].body)
                for text in (
                    "Metric: `new_coverage`",
                    "Actual: `79`",
                    "actual `LT` threshold `80`",
                ):
                    self.assertIn(text, findings[2].body)


if __name__ == "__main__":
    unittest.main()
