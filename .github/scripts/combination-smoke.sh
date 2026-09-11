#!/usr/bin/env bash
set -euo pipefail

root="$PWD"
state="$RUNNER_TEMP/release-combination"
mkdir -p "$state/openclaw" "$state/coding" "$state/quarantine"
chmod 777 "$state/quarantine"
export COMBINATION_STATE="$state"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext subjectAltName=DNS:localhost,IP:127.0.0.1 \
  -keyout "$state/key.pem" -out "$state/cert.pem" >/dev/null 2>&1
openssl pkey -in "$state/key.pem" -pubout -out "$state/public.pem" >/dev/null 2>&1
export QUARANTINE_PUBLIC_KEY="$(base64 -w0 "$state/public.pem")"
export QUARANTINE_STATE_DIR="$state/quarantine"
export MEMORY_ROUTER_TEST_DEPLOYMENT_MODE=single
export MEMORY_ROUTER_TEST_EXTERNAL_ADMIN_RATE_LIMIT=false
export MEMORY_ROUTER_TEST_QUARANTINE_DATABASE_URL=sqlite:/state/quarantine.db
node .github/scripts/combination-smoke.mjs prepare
openclaw="$(node -p 'const p=require("./package.json"); `packages/${p.name.slice(1).replace("/", "-")}-${p.version}.tgz`')"
coding="$(node -p 'const p=require("./src/upstream/coding-agents/package.json"); `packages/${p.name.slice(1).replace("/", "-")}-${p.version}.tgz`')"
tar -xzf "$openclaw" -C "$state/openclaw"
tar -xzf "$coding" -C "$state/coding"
npm ci --prefix "$state/openclaw/package" --omit=dev --ignore-scripts --no-audit --no-fund

if [[ -n "$ROUTER_TEST_IMAGE" ]]; then
  docker pull "$ROUTER_TEST_IMAGE"
  docker tag "$ROUTER_TEST_IMAGE" hindsight-memory-router:ci
else
  docker build -t hindsight-memory-router:ci "$root/.router"
fi
compose=(docker compose -p "combination-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" \
  -f "$root/.router/tests/integration/docker-compose.real.yml" -f "$state/override.json")
finish() {
  status=$?
  if [[ "$status" -ne 0 ]]; then "${compose[@]}" logs --no-color --tail=100; fi
  "${compose[@]}" down -v --remove-orphans
  exit "$status"
}
trap finish EXIT
"${compose[@]}" up --wait --wait-timeout 300
NODE_EXTRA_CA_CERTS="$state/cert.pem" node .github/scripts/combination-smoke.mjs test
