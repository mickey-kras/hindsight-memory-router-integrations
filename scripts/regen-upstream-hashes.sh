#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(sed -n 's/^upstream_repo=//p' "$ROOT/UPSTREAM_VERSION")"
COMMIT="$(sed -n 's/^upstream_commit=//p' "$ROOT/UPSTREAM_VERSION")"
SUBPATH="$(sed -n 's/^upstream_path=//p' "$ROOT/UPSTREAM_VERSION")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/${COMMIT}" -o "$TMP/upstream.tgz"
tar xzf "$TMP/upstream.tgz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 3 -type d -path "*/${SUBPATH}" | head -1)"
[ -d "$SRC" ] || { echo "integration path not found" >&2; exit 1; }
(cd "$SRC" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$ROOT/src/upstream/SHA256SUMS"
node "$ROOT/scripts/regen-openclaw-overlay.mjs"
