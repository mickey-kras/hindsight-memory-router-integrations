#!/usr/bin/env python3
"""Mask configured and advertised SonarQube endpoints before analysis."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from email.message import Message
from http.client import HTTPResponse
from pathlib import Path


class ContextError(ValueError):
    """Failure whose message is a fixed reason without endpoint or credential data."""


def mask(value: str) -> None:
    escaped = value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::add-mask::{escaped}", flush=True)


def endpoint(value: str) -> tuple[str, str]:
    if not value or any(char.isspace() for char in value):
        raise ContextError("invalid endpoint")
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ContextError("invalid endpoint")
    _ = parsed.port
    return value.rstrip("/"), parsed.hostname


def mask_endpoint(value: str) -> str:
    base, hostname = endpoint(value)
    mask(value)
    if base != value:
        mask(base)
    mask(hostname)
    return base


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: HTTPResponse | None,
        code: int,
        msg: str,
        headers: Message,
        newurl: str,
    ) -> urllib.request.Request | None:
        if fp is not None:
            fp.close()
        raise ContextError("redirects are not permitted")


def advertised_endpoint(base: str, token: str) -> str:
    if not token:
        raise ContextError("missing authentication")
    request = urllib.request.Request(  # noqa: S310 - validated HTTP(S) base URL
        f"{base}/api/settings/values?keys=sonar.core.serverBaseURL",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    with urllib.request.build_opener(RejectRedirects()).open(request, timeout=30) as response:
        payload = json.load(response)
    if not isinstance(payload, dict) or not isinstance(payload.get("settings"), list):
        raise ContextError("invalid settings")
    values = [
        setting.get("value")
        for setting in payload["settings"]
        if isinstance(setting, dict) and setting.get("key") == "sonar.core.serverBaseURL"
    ]
    if len(values) != 1 or not isinstance(values[0], str):
        raise ContextError("missing advertised endpoint")
    endpoint(values[0])
    return values[0]


def failure_reason(exc: Exception) -> str:
    # Only fixed strings, status codes and class names: messages can carry endpoints.
    if isinstance(exc, ContextError):
        return str(exc)
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP status {exc.code}"
    return type(exc).__name__


def main() -> int:
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in {"configured", "advertised"}:
            raise ContextError("invalid mode")
        base = mask_endpoint(os.environ.get("SONAR_HOST_URL", ""))
        if sys.argv[1] == "advertised":
            advertised = advertised_endpoint(base, os.environ.get("SONAR_TOKEN", ""))
            mask_endpoint(advertised)
            with Path(os.environ["GITHUB_ENV"]).open("a", encoding="utf-8") as environment:
                environment.write(f"SONAR_ADVERTISED_HOST_URL={advertised}\n")
    except Exception as exc:  # endpoint-bearing exceptions must never reach public logs
        print("Unable to establish masked SonarQube server context.", file=sys.stderr)
        print(f"Reason: {failure_reason(exc)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
