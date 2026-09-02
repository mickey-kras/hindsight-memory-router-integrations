#!/bin/sh
# Materialize the FULL pristine upstream integration tree into src/upstream/
# for audits and upgrades. The repo vendors only the imported modules; this
# script restores the rest and verifies every file against SHA256SUMS.
#
# Usage: scripts/import-upstream.sh [upstream-ref]
# Default ref comes from UPSTREAM_VERSION.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${2:-$(grep '^upstream_ref=' "$ROOT/UPSTREAM_VERSION" | cut -d= -f2)}"
REPO="$(grep '^upstream_repo=' "$ROOT/UPSTREAM_VERSION" | cut -d= -f2)"
SUBPATH="$(grep '^upstream_path=' "$ROOT/UPSTREAM_VERSION" | cut -d= -f2)"
TAG="refs/tags/${1:-$REF}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/${TAG}" -o "$TMP/upstream.tgz"
tar xzf "$TMP/upstream.tgz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 3 -type d -path "*/${SUBPATH}" | head -1)"
[ -d "$SRC" ] || { echo "integration path not found in tarball" >&2; exit 1; }

find "$SRC" -type f | sort | sed "s|^$SRC/||" > "$TMP/files.txt"
while read -r rel; do
  mkdir -p "$ROOT/src/upstream/$(dirname "$rel")"
  cp "$SRC/$rel" "$ROOT/src/upstream/$rel"
done < "$TMP/files.txt"

cd "$ROOT/src/upstream"
sha256sum -c SHA256SUMS
echo "upstream tree materialized and verified (${TAG})"
