#!/usr/bin/env python3
"""Mask configured and advertised SonarQube endpoints before analysis."""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from email.message import Message
from http.client import HTTPResponse
from pathlib import Path


def mask(value: str) -> None:
    escaped = value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::add-mask::{escaped}", flush=True)


def endpoint(value: str) -> tuple[str, str]:
    if not value or any(char.isspace() for char in value):
        raise ValueError("invalid endpoint")
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("invalid endpoint")
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
        raise ValueError("redirects are not permitted")


def advertised_endpoint(base: str, token: str) -> str:
    if not token:
        raise ValueError("missing authentication")
    request = urllib.request.Request(  # noqa: S310 - validated HTTP(S) base URL
        f"{base}/api/settings/values?keys=sonar.core.serverBaseURL",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    with urllib.request.build_opener(RejectRedirects()).open(request, timeout=30) as response:
        payload = json.load(response)
    if not isinstance(payload, dict) or not isinstance(payload.get("settings"), list):
        raise ValueError("invalid settings")
    values = [
        setting.get("value")
        for setting in payload["settings"]
        if isinstance(setting, dict) and setting.get("key") == "sonar.core.serverBaseURL"
    ]
    if len(values) != 1 or not isinstance(values[0], str):
        raise ValueError("missing advertised endpoint")
    endpoint(values[0])
    return values[0]


def main() -> int:
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in {"configured", "advertised"}:
            raise ValueError("invalid mode")
        base = mask_endpoint(os.environ.get("SONAR_HOST_URL", ""))
        if sys.argv[1] == "advertised":
            advertised = advertised_endpoint(base, os.environ.get("SONAR_TOKEN", ""))
            mask_endpoint(advertised)
            with Path(os.environ["GITHUB_ENV"]).open("a", encoding="utf-8") as environment:
                environment.write(f"SONAR_ADVERTISED_HOST_URL={advertised}\n")
    except Exception:  # endpoint-bearing exceptions must never reach public logs
        print("Unable to establish masked SonarQube server context.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
