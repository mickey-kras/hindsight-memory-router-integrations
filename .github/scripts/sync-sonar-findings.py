#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PAGE_SIZE = 500
ISSUE_MARKER_PREFIX = "sonar-finding"
AGGREGATE_METRICS = ("coverage", "duplicated")
HOTSPOT_METRICS = ("security_hotspots",)


@dataclass(frozen=True, slots=True)
class TrackedFinding:
    key: str
    title: str
    body: str


@dataclass(frozen=True, slots=True)
class PagedFindings:
    values: list[dict[str, Any]]
    forbidden: bool = False


class PartialPageError(Exception):
    def __init__(self, cause: urllib.error.HTTPError, values: list[dict[str, Any]]) -> None:
        super().__init__(str(cause))
        self.cause = cause
        self.values = values


class SonarClient:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        if urllib.parse.urlsplit(self.base_url).scheme not in {"http", "https"}:
            raise ValueError("SONAR_HOST_URL must use HTTP or HTTPS")
        self.token = token

    def get(self, path: str, **params: str | int | bool) -> dict[str, Any]:
        query = urllib.parse.urlencode(
            {
                key: str(value).lower() if isinstance(value, bool) else value
                for key, value in params.items()
            }
        )
        request = urllib.request.Request(  # noqa: S310 - validated HTTP(S) base URL
            f"{self.base_url}{path}?{query}",
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - configured server
            payload = json.load(response)
        if not isinstance(payload, dict):
            raise RuntimeError(f"SonarQube returned invalid JSON for {path}")
        return payload

    def paged(self, path: str, collection: str, **params: str | int | bool) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        page = 1
        while True:
            try:
                payload = self.get(path, p=page, ps=PAGE_SIZE, **params)
            except urllib.error.HTTPError as exc:
                raise PartialPageError(exc, results) from exc
            values = payload.get(collection, [])
            if not isinstance(values, list):
                raise RuntimeError(f"SonarQube returned invalid {collection} for {path}")
            results.extend(value for value in values if isinstance(value, dict))
            paging = payload.get("paging", {})
            total = int(paging.get("total", payload.get("total", len(results))))
            if len(results) >= total or not values:
                return results
            page += 1


class GitHubTracker:
    def __init__(
        self,
        repository_owner: str,
        run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    ) -> None:
        self.repository_owner = repository_owner
        self.run = run
        result = self._run(
            "gh",
            "issue",
            "list",
            "--state",
            "all",
            "--limit",
            "1000",
            "--json",
            "number,body,state",
        )
        payload = json.loads(result.stdout)
        if not isinstance(payload, list):
            raise RuntimeError("GitHub returned an invalid issue list")
        self.issues = [issue for issue in payload if isinstance(issue, dict)]

    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        return self.run(args, check=True, capture_output=True, text=True)

    def upsert(self, finding: TrackedFinding) -> str:
        marker = f"<!-- {ISSUE_MARKER_PREFIX}:{finding.key} -->"
        body = f"{marker}\n{finding.body.rstrip()}\n"
        matches = [
            issue
            for issue in self.issues
            if marker in str(issue.get("body") or "") and isinstance(issue.get("number"), int)
        ]
        existing = max(matches, key=lambda issue: int(issue["number"])) if matches else None
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as body_file:
            body_file.write(body)
            body_file.flush()
            if existing is None:
                result = self._run(
                    "gh",
                    "issue",
                    "create",
                    "--title",
                    finding.title,
                    "--body-file",
                    body_file.name,
                    "--assignee",
                    self.repository_owner,
                )
                return result.stdout.strip()
            number = str(existing["number"])
            if str(existing.get("state", "")).lower() == "closed":
                self._run("gh", "issue", "reopen", number)
                existing["state"] = "OPEN"
            self._run(
                "gh",
                "issue",
                "edit",
                number,
                "--title",
                finding.title,
                "--body-file",
                body_file.name,
            )
            return f"#{number}"


def optional_paged(
    client: SonarClient,
    path: str,
    collection: str,
    **params: str | int | bool,
) -> PagedFindings:
    try:
        return PagedFindings(client.paged(path, collection, **params))
    except (PartialPageError, urllib.error.HTTPError) as error:
        partial_values = error.values if isinstance(error, PartialPageError) else []
        exc = error.cause if isinstance(error, PartialPageError) else error
        if exc.code != 403:
            if isinstance(error, PartialPageError):
                raise exc from None
            raise
        print(
            f"SonarQube denied {path} with HTTP {exc.code} ({exc.reason or 'Forbidden'}); "
            "using quality-gate conditions.",
            file=sys.stderr,
        )
        return PagedFindings(partial_values, forbidden=True)


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _mapping(value: object, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError(f"SonarQube returned invalid {name}")
    return value


def _report_value(report: Path, key: str) -> str:
    prefix = f"{key}="
    for line in report.read_text(encoding="utf-8").splitlines():
        if line.startswith(prefix):
            return line.removeprefix(prefix).strip()
    raise RuntimeError(f"{key} is missing from {report}")


def _component_path(component: object, project_key: str) -> str:
    value = str(component or "unknown")
    return value.removeprefix(f"{project_key}:")


def _clean(value: object, fallback: str) -> str:
    text = " ".join(str(value or fallback).replace("`", "'").split())
    return text or fallback


def _title(prefix: str, path: str, line: object, message: str) -> str:
    location = f"{path}:{line}" if line is not None else path
    return f"[sonar] {prefix}: {location} — {message}"[:240]


def _run_context() -> tuple[str, str, str]:
    commit = _required_env("GITHUB_SHA")
    run_url = (
        f"{_required_env('GITHUB_SERVER_URL')}/{_required_env('GITHUB_REPOSITORY')}"
        f"/actions/runs/{_required_env('GITHUB_RUN_ID')}"
    )
    return commit, run_url, _required_env("SONAR_HOST_URL").rstrip("/")


def issue_finding(issue: dict[str, Any], project_key: str) -> TrackedFinding:
    commit, run_url, sonar_url = _run_context()
    key = _clean(issue.get("key"), "unknown")
    path = _clean(_component_path(issue.get("component"), project_key), "unknown")
    line = issue.get("line")
    message = _clean(issue.get("message"), "No message")
    issue_type = _clean(issue.get("type"), "Issue").replace("_", " ").title()
    severity = _clean(issue.get("severity") or _first_impact(issue, "severity"), "UNKNOWN")
    quality = _clean(_first_impact(issue, "softwareQuality"), issue_type).title()
    link = f"{sonar_url}/project/issues?id={urllib.parse.quote(project_key)}&issues={urllib.parse.quote(key)}&open={urllib.parse.quote(key)}"
    return TrackedFinding(
        key=f"issue-{key}",
        title=_title(issue_type, path, line, message),
        body=(
            "SonarQube finding requires remediation.\n\n"
            f"- Type: `{issue_type}`\n"
            f"- Quality: `{quality}`\n"
            f"- Severity: `{severity}`\n"
            f"- Rule: `{_clean(issue.get('rule'), 'unknown')}`\n"
            f"- Location: `{path}:{line if line is not None else '?'}`\n"
            f"- Message: {message}\n"
            f"- SonarQube: {link}\n"
            f"- Detected at commit: `{commit}`\n"
            f"- Workflow: {run_url}\n"
        ),
    )


def _first_impact(issue: dict[str, Any], field: str) -> object | None:
    impacts = issue.get("impacts")
    if isinstance(impacts, list) and impacts and isinstance(impacts[0], dict):
        return impacts[0].get(field)
    return None


def hotspot_finding(hotspot: dict[str, Any], project_key: str) -> TrackedFinding:
    commit, run_url, sonar_url = _run_context()
    key = _clean(hotspot.get("key"), "unknown")
    path = _clean(_component_path(hotspot.get("component"), project_key), "unknown")
    line = hotspot.get("line")
    message = _clean(hotspot.get("message") or hotspot.get("ruleName"), "Review security hotspot")
    probability = _clean(hotspot.get("vulnerabilityProbability"), "UNKNOWN")
    link = f"{sonar_url}/security_hotspots?id={urllib.parse.quote(project_key)}&hotspots={urllib.parse.quote(key)}"
    return TrackedFinding(
        key=f"hotspot-{key}",
        title=_title("Security hotspot", path, line, message),
        body=(
            "SonarQube security hotspot requires review.\n\n"
            f"- Probability: `{probability}`\n"
            f"- Category: `{_clean(hotspot.get('securityCategory'), 'unknown')}`\n"
            f"- Location: `{path}:{line if line is not None else '?'}`\n"
            f"- Message: {message}\n"
            f"- SonarQube: {link}\n"
            f"- Detected at commit: `{commit}`\n"
            f"- Workflow: {run_url}\n"
        ),
    )


def condition_finding(condition: dict[str, Any], project_key: str) -> TrackedFinding:
    commit, run_url, sonar_url = _run_context()
    metric = _clean(condition.get("metricKey"), "unknown")
    actual = _clean(condition.get("actualValue"), "n/a")
    comparator = _clean(condition.get("comparator"), "n/a")
    threshold = _clean(condition.get("errorThreshold"), "n/a")
    return TrackedFinding(
        key=f"condition-{metric}",
        title=f"[sonar] Quality gate: {metric} failed ({actual}; threshold {threshold})"[:240],
        body=(
            "SonarQube quality-gate metric requires improvement.\n\n"
            f"- Metric: `{metric}`\n"
            f"- Actual: `{actual}`\n"
            f"- Failure condition: actual `{comparator}` threshold `{threshold}`\n"
            f"- SonarQube: {sonar_url}/dashboard?id={urllib.parse.quote(project_key)}\n"
            f"- Detected at commit: `{commit}`\n"
            f"- Workflow: {run_url}\n"
        ),
    )


def tracked_findings(
    gate: dict[str, Any],
    issues: list[dict[str, Any]],
    hotspots: list[dict[str, Any]],
    project_key: str,
    *,
    issues_forbidden: bool = False,
    hotspots_forbidden: bool = False,
) -> list[TrackedFinding]:
    findings = [issue_finding(issue, project_key) for issue in issues]
    findings.extend(hotspot_finding(hotspot, project_key) for hotspot in hotspots)
    project_status = _mapping(gate.get("projectStatus"), "projectStatus")
    conditions = project_status.get("conditions")
    if not isinstance(conditions, list):
        raise RuntimeError("SonarQube returned invalid quality-gate conditions")
    failed = [
        condition
        for condition in conditions
        if isinstance(condition, dict) and condition.get("status") != "OK"
    ]
    had_findings = bool(findings)
    for condition in failed:
        metric = str(condition.get("metricKey", ""))
        aggregate = any(token in metric for token in AGGREGATE_METRICS)
        hotspot = any(token in metric for token in HOTSPOT_METRICS)
        inaccessible = hotspots_forbidden if hotspot else issues_forbidden
        if not had_findings or aggregate or inaccessible:
            findings.append(condition_finding(condition, project_key))
    return findings


def main() -> int:
    report = Path(sys.argv[1] if len(sys.argv) > 1 else ".scannerwork/report-task.txt")
    client = SonarClient(_required_env("SONAR_HOST_URL"), _required_env("SONAR_TOKEN"))
    task = client.get("/api/ce/task", id=_report_value(report, "ceTaskId"))
    task_details = _mapping(task.get("task"), "compute task")
    analysis_id = str(task_details.get("analysisId", ""))
    if not analysis_id:
        raise RuntimeError("SonarQube compute task has no analysisId")
    project_key = _report_value(report, "projectKey")
    gate = client.get("/api/qualitygates/project_status", analysisId=analysis_id)
    issues = optional_paged(
        client,
        "/api/issues/search",
        "issues",
        componentKeys=project_key,
        inNewCodePeriod=True,
        resolved=False,
    )
    hotspots = optional_paged(
        client,
        "/api/hotspots/search",
        "hotspots",
        projectKey=project_key,
        status="TO_REVIEW",
        sinceLeakPeriod=True,
    )
    findings = tracked_findings(
        gate,
        issues.values,
        hotspots.values,
        project_key,
        issues_forbidden=issues.forbidden,
        hotspots_forbidden=hotspots.forbidden,
    )
    if not findings:
        raise RuntimeError("quality gate failed but SonarQube returned no actionable findings")
    tracker = GitHubTracker(_required_env("GITHUB_REPOSITORY_OWNER"))
    references = [tracker.upsert(finding) for finding in findings]
    print(f"Synchronized {len(findings)} SonarQube finding(s): {', '.join(references)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"SonarQube finding sync failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from None

