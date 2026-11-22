#!/bin/sh
set -eu

# Give each container its own generated Testbench app and bootstrap cache.
testbench_app=/tmp/vaulter-testbench-app
mkdir -p "$testbench_app"
cp -R /app/vendor/orchestra/testbench-core/laravel/. "$testbench_app/"
rm -f "$testbench_app/vendor" "$testbench_app/.env" "$testbench_app/bootstrap/cache/"*.php "$testbench_app/bootstrap/cache/"testbench.yaml*
ln -sfn /app/vendor "$TESTBENCH_WORKING_PATH/vendor"
ln -sfn /app/composer.json "$TESTBENCH_WORKING_PATH/composer.json"

exec "$@"
