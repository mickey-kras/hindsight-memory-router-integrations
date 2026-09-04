#!/usr/bin/env bash
set -euo pipefail

repo=mickey-kras/hindsight-memory-router-integrations
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" != --apply || $# != 1 ]]; then
  echo 'Usage: bash scripts/configure-github.sh --apply'
  echo 'Requires gh authenticated as a repository administrator.'
  exit 1
fi

gh auth status
existing="$(gh api "repos/$repo/rulesets?per_page=100")"

# Install merge requirements before enabling auto-merge.
for file in "$root"/config/github/*.json; do
  name="$(jq -r .name "$file")"
  ids="$(jq -r --arg name "$name" '.[] | select(.name == $name) | .id' <<< "$existing")"
  if [[ "$ids" == *$'\n'* ]]; then
    echo "Multiple rulesets named $name; resolve them before retrying." >&2
    exit 1
  fi
  if [[ -n "$ids" ]]; then
    gh api --method PUT "repos/$repo/rulesets/$ids" --input "$file" --silent
  else
    gh api --method POST "repos/$repo/rulesets" --input "$file" --silent
  fi
done

gh api --method PATCH "repos/$repo" \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -F allow_auto_merge=true --silent

gh api "repos/$repo" --jq '{allow_auto_merge, allow_squash_merge, allow_merge_commit, allow_rebase_merge, delete_branch_on_merge}'
gh api "repos/$repo/rulesets" --jq '.[] | {name, enforcement}'
