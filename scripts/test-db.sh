#!/usr/bin/env bash
# Run the collaboration suite on a database server that is already running (a CI service or a local server).
#
#   scripts/test-db.sh pgsql|mysql [pest arguments...]
#
#   DB_HOST DB_PORT DB_DATABASE DB_USERNAME DB_PASSWORD   the server (DB_DATABASE must end in _test)
#   DB_PARALLEL                                            workers of the parallel pass (default 4; 1 = one process)
#
# Everything outside the `serial` group runs in parallel, every worker on its own database `<base>_w<n>_test`
# (created when missing; SuiteDatabaseConnection picks it from TEST_TOKEN). On PostgreSQL the serial group (forked
# race scenarios that need committed fixtures) then runs in one process on DB_DATABASE. ForkRace supports only
# PostgreSQL, so MySQL runs no serial pass. A skipped test fails the run: on a server engine nothing may be skipped.
set -euo pipefail

engine="${1:-}"
case "$engine" in
    pgsql) default_port=5432 ;;
    mysql) default_port=3306 ;;
    *) echo "usage: scripts/test-db.sh pgsql|mysql [pest arguments...]" >&2; exit 2 ;;
esac
shift

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

export DB_CONNECTION="$engine"
export DB_HOST="${DB_HOST:-127.0.0.1}" DB_PORT="${DB_PORT:-$default_port}" DB_DATABASE="${DB_DATABASE:-vaulter_test}"
export DB_USERNAME="${DB_USERNAME:-vaulter}" DB_PASSWORD="${DB_PASSWORD:-}"
workers="${DB_PARALLEL:-4}"
[[ "$DB_DATABASE" == *_test ]] || { echo "test-db: DB_DATABASE must end in _test, got $DB_DATABASE" >&2; exit 2; }

# Creates the worker databases through PDO, so neither psql nor the mysql client has to be installed.
create_databases() {
    php -r '
        [$engine, $host, $port, $database, $user, $password] = array_slice($argv, 1, 6);
        $dsn = $engine === "pgsql" ? "pgsql:host=$host;port=$port;dbname=$database" : "mysql:host=$host;port=$port";
        $pdo = new PDO($dsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        foreach (array_slice($argv, 7) as $name) {
            if ($engine === "mysql") {
                $pdo->exec("CREATE DATABASE IF NOT EXISTS `$name`");
            } elseif ($pdo->query("SELECT 1 FROM pg_database WHERE datname = " . $pdo->quote($name))->fetchColumn() === false) {
                $pdo->exec("CREATE DATABASE \"$name\"");
            }
        }
    ' "$engine" "$DB_HOST" "$DB_PORT" "$DB_DATABASE" "$DB_USERNAME" "$DB_PASSWORD" "$@"
}

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
pest=(php vendor/bin/pest -c phpunit.xml.dist --test-directory=packages/collaboration/tests --colors=never)

if (( workers > 1 )); then
    base="${DB_DATABASE%_test}"
    names=()
    for n in $(seq 1 "$workers"); do
        names+=("${base}_w${n}_test")
    done
    [[ "$engine" == mysql ]] && names+=("$DB_DATABASE")
    create_databases "${names[@]}"
    VAULTER_TEST_DB_PER_PROCESS=1 "${pest[@]}" --parallel --processes="$workers" --exclude-group=serial "$@" | tee "$log"
    if [[ "$engine" == pgsql ]]; then
        "${pest[@]}" --group=serial "$@" | tee -a "$log"
    fi
elif [[ "$engine" == pgsql ]]; then
    "${pest[@]}" "$@" | tee "$log"
else
    create_databases "$DB_DATABASE"
    "${pest[@]}" --exclude-group=serial "$@" | tee "$log"
fi

if grep -qiE '\bskipped\b' "$log"; then
    echo "test-db: the $engine suite must not skip any test" >&2
    exit 1
fi
