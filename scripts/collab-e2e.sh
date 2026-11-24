#!/usr/bin/env bash
# Collaboration protocol 2 e2e against REAL processes: `vendor/bin/testbench serve`
# and the Hocuspocus hub (`packages/hub/src/cli.js serve`), running:
#   1. packages/hub/test/e2e/restore-epoch.e2e.js (standard profile)
#   2. packages/hub/test/e2e/command-crash.e2e.js (strict profile)
#   3. e2e/tests/collab.spec.ts (standard + strict 11 variants of live-write.json)
#
# Usage: bash scripts/collab-e2e.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
php_bin="${PHP_BIN:-php}"
port="${VAULTER_E2E_PORT:-8787}"
hub_port="${VAULTER_E2E_HUB_PORT:-18234}"
strict_hub_port="${VAULTER_E2E_STRICT_HUB_PORT:-18434}"
vite_port="${VAULTER_E2E_VITE_PORT:-5273}"
management_port="$((hub_port + 1))"
log="${VAULTER_E2E_LOG:-${TMPDIR:-/tmp}/vaulter-collab-e2e.log}"
work="$(mktemp -d "${TMPDIR:-/tmp}/vaulter-collab-e2e.XXXXXX")"
pids=()

kill_tree() {
    local p="$1"
    local child
    for child in $(pgrep -P "$p" 2>/dev/null || true); do
        kill_tree "$child"
    done
    kill "$p" 2>/dev/null || true
}

cleanup() {
    for pid in "${pids[@]}"; do
        kill_tree "$pid"
    done
    wait 2>/dev/null || true
    rm -rf -- "$work"
}
trap cleanup EXIT INT TERM

mkdir -p "$(dirname "$log")"
: > "$log"

jwt_key="e2e-collab-jwt-key-$(date +%s)-at-least-32-bytes"
webhook_secret="e2e-collab-webhook-secret-$(date +%s)"

ln -s "$root/vendor" "$work/vendor"
cp -R "$root/vendor/orchestra/testbench-core/laravel" "$work/laravel"
rm -f "$work/laravel/bootstrap/cache/"*.php "$work/laravel/bootstrap/cache/"testbench.yaml*
touch "$work/database.sqlite"

write_testbench_yaml() {
    local strict_flag="$1"
    local mode="$2"
    local ws_port="$3"
    cat > "$work/testbench.yaml" <<YAML
laravel: ${work}/laravel
providers:
  - Vaulter\\VaulterServiceProvider
  - Vaulter\\Media\\VaulterMediaServiceProvider
  - Vaulter\\Drive\\VaulterDriveServiceProvider
  - Vaulter\\Documents\\VaulterDocumentsServiceProvider
  - Vaulter\\Collaboration\\VaulterCollaborationServiceProvider
  - Vaulter\\Collaboration\\Tests\\E2E\\E2eServiceProvider
env:
  - APP_KEY="base64:lRknxO3IznrZODHVPvLNKylvYP19ch+EXZ8dM+i3OlY="
  - APP_ENV="local"
  - APP_URL="http://127.0.0.1:${port}"
  - DB_CONNECTION="sqlite"
  - DB_DATABASE="${work}/database.sqlite"
  - CACHE_STORE="file"
  - VAULTER_COLLAB_DRIVER="hocuspocus"
  - VAULTER_COLLAB_MODE="${mode}"
  - VAULTER_COLLAB_STRICT_PROFILE="${strict_flag}"
  - VAULTER_COLLAB_URL="ws://127.0.0.1:${ws_port}?protocol=2"
  - VAULTER_COLLAB_JWT_KEYS="e2e:${jwt_key}"
  - VAULTER_COLLAB_JWT_ACTIVE_KID="e2e"
  - VAULTER_COLLAB_WEBHOOK_SECRET="${webhook_secret}"
YAML
    cat > "$work/laravel/.env" <<ENV
APP_KEY=base64:lRknxO3IznrZODHVPvLNKylvYP19ch+EXZ8dM+i3OlY=
APP_ENV=local
APP_URL=http://127.0.0.1:${port}
DB_CONNECTION=sqlite
DB_DATABASE=${work}/database.sqlite
CACHE_STORE=file
VAULTER_COLLAB_DRIVER=hocuspocus
VAULTER_COLLAB_MODE=${mode}
VAULTER_COLLAB_STRICT_PROFILE=${strict_flag}
VAULTER_COLLAB_URL=ws://127.0.0.1:${ws_port}?protocol=2
VAULTER_COLLAB_JWT_KEYS=e2e:${jwt_key}
VAULTER_COLLAB_JWT_ACTIVE_KID=e2e
VAULTER_COLLAB_WEBHOOK_SECRET=${webhook_secret}
ENV
}

testbench() {
    (cd "$root" && TESTBENCH_WORKING_PATH="$work" "$php_bin" "$root/vendor/bin/testbench" "$@")
}

wait_for() {
    local url="$1" name="$2"
    for _ in $(seq 1 100); do
        if curl -fsS "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.2
    done
    echo "collab-e2e: $name did not become healthy at $url" | tee -a "$log" >&2
    exit 1
}

stop_pids() {
    for pid in "${pids[@]}"; do
        kill_tree "$pid"
    done
    wait 2>/dev/null || true
    pids=()
}

# ── Phase 1: Standard profile (restore-epoch.e2e.js + standard Playwright) ─────────────
write_testbench_yaml "false" "buffered" "$hub_port"
echo "== phase 1 migrate ($work/database.sqlite)" | tee -a "$log"
testbench migrate:fresh --force >>"$log" 2>&1

echo "== phase 1 testbench serve :$port" | tee -a "$log"
PHP_CLI_SERVER_WORKERS=4 testbench serve --no-reload --host=127.0.0.1 --port="$port" >>"$log" 2>&1 &
pids+=("$!")
wait_for "http://127.0.0.1:${port}/e2e/health" "testbench serve"

echo "== phase 1 hub :$hub_port" | tee -a "$log"
(
    cd "$root/packages/hub"
    NODE_ENV=test \
    VAULTER_LARAVEL_WEBHOOK_URL="http://127.0.0.1:${port}/api/vaulter/v1" \
    VAULTER_COLLAB_WEBHOOK_SECRET="$webhook_secret" \
    VAULTER_COLLAB_PORT="$hub_port" \
    VAULTER_COLLAB_MANAGEMENT_PORT="$management_port" \
    VAULTER_COLLAB_DEBOUNCE_MS=200 \
    VAULTER_COLLAB_MAX_DEBOUNCE_MS=1000 \
    VAULTER_COLLAB_THROTTLE=1000 \
    VAULTER_COLLAB_FLUSH_INTERVAL_MS=200 \
    VAULTER_COLLAB_COMPACTION_INTERVAL_MS=500 \
    exec node src/cli.js serve
) >>"$log" 2>&1 &
pids+=("$!")
wait_for "http://127.0.0.1:${management_port}/livez" "hub"

echo "== restore-epoch e2e" | tee -a "$log"
(
    cd "$root/packages/hub"
    VAULTER_E2E_BACKEND="http://127.0.0.1:${port}" \
    VAULTER_E2E_HUB="ws://127.0.0.1:${hub_port}" \
    node --test test/e2e/restore-epoch.e2e.js
) 2>&1 | tee -a "$log"

# Stop standard hub so Playwright can manage hub restarts cleanly on the same port.
kill "${pids[1]}" 2>/dev/null || true
wait "${pids[1]}" 2>/dev/null || true
pids=("${pids[0]}")

echo "== playwright standard suite" | tee -a "$log"
(
    cd "$root/e2e"
    VAULTER_BACKEND_URL="http://127.0.0.1:${port}" \
    VAULTER_E2E_VITE_PORT="$vite_port" \
    E2E_BASE_URL="http://127.0.0.1:${vite_port}" \
    VAULTER_E2E_SPAWN_HUB=1 \
    VAULTER_E2E_HUB_PORT="$hub_port" \
    VAULTER_COLLAB_WEBHOOK_SECRET="$webhook_secret" \
    VAULTER_E2E_STRICT=0 \
    npx playwright test
) 2>&1 | tee -a "$log"

stop_pids

# ── Phase 2: Strict profile (command-crash.e2e.js + strict 11 variants) ───────────────
rm -f "$work/laravel/.env" "$work/laravel/bootstrap/cache/"*.php "$work/laravel/bootstrap/cache/"testbench.yaml*
write_testbench_yaml "true" "durable" "$strict_hub_port"
echo "== phase 2 migrate ($work/database.sqlite)" | tee -a "$log"
testbench migrate:fresh --force >>"$log" 2>&1

echo "== phase 2 strict testbench serve :$port" | tee -a "$log"
PHP_CLI_SERVER_WORKERS=4 testbench serve --no-reload --host=127.0.0.1 --port="$port" >>"$log" 2>&1 &
pids+=("$!")
wait_for "http://127.0.0.1:${port}/e2e/health" "testbench serve (strict)"

echo "== command-crash e2e" | tee -a "$log"
(
    cd "$root/packages/hub"
    VAULTER_E2E_BACKEND="http://127.0.0.1:${port}" \
    VAULTER_E2E_STRICT_HUB_PORT="$strict_hub_port" \
    VAULTER_COLLAB_WEBHOOK_SECRET="$webhook_secret" \
    node --test test/e2e/command-crash.e2e.js
) 2>&1 | tee -a "$log"

echo "== playwright strict 11-variant suite" | tee -a "$log"
(
    cd "$root/e2e"
    VAULTER_BACKEND_URL="http://127.0.0.1:${port}" \
    VAULTER_E2E_VITE_PORT="$vite_port" \
    E2E_BASE_URL="http://127.0.0.1:${vite_port}" \
    VAULTER_E2E_HUB_PORT="$strict_hub_port" \
    VAULTER_COLLAB_WEBHOOK_SECRET="$webhook_secret" \
    VAULTER_E2E_STRICT=1 \
    npx playwright test --grep "A42|strict 11 variants"
) 2>&1 | tee -a "$log"

echo "== collab-e2e exit 0 (log: $log)" | tee -a "$log"
