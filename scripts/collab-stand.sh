#!/usr/bin/env bash
# The stand scenarios 2, 3 and 10 against REAL processes in docker:
# PostgreSQL 18.7/19.0, Redis, the Laravel host behind `testbench serve` and TWO hubs
# (packages/hub/stand/docker-compose.yml), then packages/hub/test/stand/*.stand.js.
#
# Usage: bash scripts/collab-stand.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$root/packages/hub/stand/docker-compose.yml"
port="${VAULTER_E2E_PORT:-8787}"
hub_a_port="${VAULTER_E2E_HUB_PORT:-18234}"
hub_b_port="${VAULTER_E2E_HUB_B_PORT:-18334}"
log="${VAULTER_STAND_LOG:-${TMPDIR:-/tmp}/vaulter-collab-stand.log}"

export VAULTER_E2E_PORT="$port"
export VAULTER_E2E_HUB_PORT="$hub_a_port"
export VAULTER_E2E_HUB_MANAGEMENT_PORT="$((hub_a_port + 1))"
export VAULTER_E2E_HUB_B_PORT="$hub_b_port"
export VAULTER_E2E_HUB_B_MANAGEMENT_PORT="$((hub_b_port + 1))"

compose() {
    docker compose -f "$compose_file" "$@"
}

cleanup() {
    compose --profile strict down -v --remove-orphans >>"$log" 2>&1 || true
}
trap cleanup EXIT INT TERM

mkdir -p "$(dirname "$log")"
: > "$log"

echo "== stand up (log: $log)" | tee -a "$log"
compose up -d --build --wait >>"$log" 2>&1 || {
    echo "collab-stand: the stand did not become healthy (see $log)" >&2
    compose ps -a >>"$log" 2>&1 || true
    compose logs --no-color >>"$log" 2>&1 || true
    exit 1
}

echo "== stand scenarios 2, 3, 10" | tee -a "$log"
status=0
(
    cd "$root/packages/hub"
    VAULTER_STAND_COMPOSE="$compose_file" \
    VAULTER_STAND_BACKEND="http://127.0.0.1:${port}" \
    VAULTER_STAND_HUB_A="ws://127.0.0.1:${hub_a_port}" \
    VAULTER_STAND_HUB_B="ws://127.0.0.1:${hub_b_port}" \
    VAULTER_STAND_MANAGEMENT_A="http://127.0.0.1:$((hub_a_port + 1))" \
    VAULTER_STAND_MANAGEMENT_B="http://127.0.0.1:$((hub_b_port + 1))" \
    node --test --test-concurrency=1 test/stand/*.stand.js
) 2>&1 | tee -a "$log" || status=$?

if [ "$status" -ne 0 ]; then
    compose logs --no-color >>"$log" 2>&1 || true
fi

echo "== exit $status (log: $log)" | tee -a "$log"
exit "$status"
