#!/bin/sh
# Materialize the FULL pristine upstream integration tree into src/upstream/
# for audits and upgrades. The repo vendors only the imported modules; this
# script restores the rest and verifies every file against SHA256SUMS.
#
# Usage: scripts/import-upstream.sh [upstream-ref]
# Default ref comes from UPSTREAM_VERSION.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="$(grep '^upstream_ref=' "$ROOT/UPSTREAM_VERSION" | cut -d= -f2)"
COMMIT="$(grep '^upstream_commit=' "$ROOT/UPSTREAM_VERSION" | cut -d= -f2)"
REPO="$(grep '^upstream_repo=' "$ROOT/UPSTREAM_VERSION" | cut -d= -f2)"
SUBPATH="$(grep '^upstream_path=' "$ROOT/UPSTREAM_VERSION" | cut -d= -f2)"
REQUESTED="${1:-$COMMIT}"
[ "$REQUESTED" = "$COMMIT" ] || {
  echo "ref must match pinned upstream commit $COMMIT (tag: $REF)" >&2
  exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/${COMMIT}" -o "$TMP/upstream.tgz"
tar xzf "$TMP/upstream.tgz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 3 -type d -path "*/${SUBPATH}" | head -1)"
[ -d "$SRC" ] || { echo "integration path not found in tarball" >&2; exit 1; }

find "$SRC" -type f | sort | sed "s|^$SRC/|./|" > "$TMP/files.txt"
sed 's/^[0-9a-f][0-9a-f]*  //' "$ROOT/src/upstream/SHA256SUMS" | sort > "$TMP/manifest-files.txt"
cmp "$TMP/manifest-files.txt" "$TMP/files.txt" || {
  echo "upstream file set differs from SHA256SUMS; regenerate intentionally" >&2
  exit 1
}
(cd "$SRC" && sha256sum -c "$ROOT/src/upstream/SHA256SUMS")

while read -r rel; do
  rel="${rel#./}"
  case "$rel" in
    src/retain-queue.ts|src/session-patterns.ts|src/types.ts) continue ;;
  esac
  mkdir -p "$ROOT/src/upstream/$(dirname "$rel")"
  cp "$SRC/$rel" "$ROOT/src/upstream/$rel"
done < "$TMP/files.txt"

node "$ROOT/scripts/verify-openclaw-overlay.mjs"
echo "upstream tree materialized and verified ($COMMIT; tag $REF)"
