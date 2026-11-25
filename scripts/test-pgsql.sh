#!/usr/bin/env bash
# Run the collaboration suite on a PostgreSQL server that is already running (a CI service or a local cluster).
#
#   DB_HOST DB_PORT DB_DATABASE DB_USERNAME DB_PASSWORD   the server (DB_DATABASE must end in _test)
#   DB_PARALLEL                                            workers of the parallel pass (default 4; 1 = one process)
#
# The suite runs in two passes: everything outside the `serial` group in parallel, every worker on its own
# database `<base>_w<n>_test` (created when missing; SuiteDatabaseConnection picks it from TEST_TOKEN), then the
# serial group (forked race scenarios that need committed fixtures) in one process on DB_DATABASE. A skipped test
# fails the run: on PostgreSQL nothing may be skipped, the engine-only scenarios included.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

export DB_CONNECTION=pgsql
export DB_HOST="${DB_HOST:-127.0.0.1}" DB_PORT="${DB_PORT:-5432}" DB_DATABASE="${DB_DATABASE:-vaulter_test}"
export DB_USERNAME="${DB_USERNAME:-vaulter}" DB_PASSWORD="${DB_PASSWORD:-}"
workers="${DB_PARALLEL:-4}"
[[ "$DB_DATABASE" == *_test ]] || { echo "test-pgsql: DB_DATABASE must end in _test, got $DB_DATABASE" >&2; exit 2; }

psql_admin() {
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME" -d "$DB_DATABASE" -XqAt -v ON_ERROR_STOP=1 "$@"
}

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
pest=(php vendor/bin/pest -c phpunit.xml.dist --test-directory=packages/collaboration/tests --colors=never)

if (( workers > 1 )); then
    base="${DB_DATABASE%_test}"
    for n in $(seq 1 "$workers"); do
        name="${base}_w${n}_test"
        if [[ "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$name'")" != 1 ]]; then
            psql_admin -c "CREATE DATABASE \"$name\""
        fi
    done
    VAULTER_TEST_DB_PER_PROCESS=1 "${pest[@]}" --parallel --processes="$workers" --exclude-group=serial "$@" | tee "$log"
    "${pest[@]}" --group=serial "$@" | tee -a "$log"
else
    "${pest[@]}" "$@" | tee "$log"
fi

if grep -qiE '\bskipped\b' "$log"; then
    echo 'test-pgsql: the PostgreSQL suite must not skip any test' >&2
    exit 1
fi
